package swamp

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"

	"github.com/coder/websocket"
)

// Client is a minimal swamp serve WebSocket client. It implements the envelope
// from src/serve/protocol.ts: requests are {type,id,payload}; responses echo the
// id and carry the same `type`, failures arrive as {type:"error"}.
type Client struct {
	conn *websocket.Conn

	mu      sync.Mutex
	pending map[string]*pendingReq
	readErr error
	closed  bool

	// Version is populated by Handshake.
	Version string
	GitSHA  string
}

type pendingReq struct {
	frames chan *wireFrame
}

func newID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// Dial connects to a swamp serve instance. baseURL may be a ws://, wss://,
// http:// or https:// URL. If token is non-empty it is sent as a bearer token
// on the WebSocket handshake.
func Dial(ctx context.Context, baseURL, token string) (*Client, error) {
	wsURL, err := toWSURL(baseURL)
	if err != nil {
		return nil, err
	}
	opts := &websocket.DialOptions{}
	if token != "" {
		opts.HTTPHeader = http.Header{}
		opts.HTTPHeader.Set("Authorization", "Bearer "+token)
	}
	conn, _, err := websocket.Dial(ctx, wsURL, opts)
	if err != nil {
		return nil, fmt.Errorf("dial %s: %w", wsURL, err)
	}
	conn.SetReadLimit(64 << 20)

	c := &Client{conn: conn, pending: map[string]*pendingReq{}}
	go c.readLoop()
	return c, nil
}

func toWSURL(baseURL string) (string, error) {
	u, err := url.Parse(baseURL)
	if err != nil {
		return "", fmt.Errorf("parse url %q: %w", baseURL, err)
	}
	switch u.Scheme {
	case "ws", "wss":
	case "http":
		u.Scheme = "ws"
	case "https":
		u.Scheme = "wss"
	default:
		u.Scheme = "ws"
	}
	if u.Host == "" {
		u.Host = "127.0.0.1:9090"
	}
	if u.Path == "" || u.Path == "/" {
		u.Path = "/"
	}
	return u.String(), nil
}

// Close tears down the socket; any in-flight requests fail.
func (c *Client) Close() error {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil
	}
	c.closed = true
	err := c.conn.Close(websocket.StatusNormalClosure, "client closing")
	c.mu.Unlock()
	return err
}

func (c *Client) readLoop() {
	for {
		_, data, err := c.conn.Read(context.Background())
		if err != nil {
			c.mu.Lock()
			c.readErr = err
			for _, p := range c.pending {
				close(p.frames)
			}
			c.pending = map[string]*pendingReq{}
			c.mu.Unlock()
			return
		}
		var frame wireFrame
		if json.Unmarshal(data, &frame) != nil {
			continue
		}
		c.mu.Lock()
		p := c.pending[frame.ID]
		c.mu.Unlock()
		if p == nil {
			continue
		}
		p.frames <- &frame
	}
}

// send registers a pending slot and writes the request frame.
func (c *Client) send(ctx context.Context, reqType string, payload any) (*pendingReq, string, error) {
	id := newID()
	p := &pendingReq{frames: make(chan *wireFrame, 4096)}
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil, id, fmt.Errorf("client closed")
	}
	if c.readErr != nil {
		err := c.readErr
		c.mu.Unlock()
		return nil, id, err
	}
	c.pending[id] = p
	c.mu.Unlock()

	body, err := json.Marshal(wireRequest{Type: reqType, ID: id, Payload: payload})
	if err != nil {
		c.forget(id)
		return nil, id, err
	}
	if err := c.conn.Write(ctx, websocket.MessageText, body); err != nil {
		c.forget(id)
		return nil, id, fmt.Errorf("write %s: %w", reqType, err)
	}
	return p, id, nil
}

func (c *Client) forget(id string) {
	c.mu.Lock()
	delete(c.pending, id)
	c.mu.Unlock()
}

// Request performs a unary request and returns the raw response payload.
func (c *Client) Request(ctx context.Context, reqType string, payload any) (json.RawMessage, error) {
	p, id, err := c.send(ctx, reqType, payload)
	if err != nil {
		return nil, err
	}
	defer c.forget(id)
	for {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case frame, ok := <-p.frames:
			if !ok {
				return nil, fmt.Errorf("%s: connection closed", reqType)
			}
			switch frame.Type {
			case "event":
				continue // keep draining until the terminal frame
			case "error":
				return nil, frame.Error
			case "done":
				return nil, nil
			default:
				if frame.Type == reqType {
					return frame.Payload, nil
				}
				// Unexpected but harmless frame; keep waiting.
			}
		}
	}
}

// Event is a decoded streaming run event.
type Event struct {
	Kind string
	Seq  int64
	Raw  map[string]any
}

// Str returns a string field from an event payload.
func (e Event) Str(key string) string {
	s, _ := e.Raw[key].(string)
	return s
}

// RunHandle is a live reference to a streaming request (a workflow or method
// run). The server owns the run; closing the socket does not stop it, and
// Cancel explicitly aborts it.
type RunHandle struct {
	client *Client
	id     string
	Events <-chan Event
	Errc   <-chan error
}

// Cancel aborts the run keyed by this request id.
func (h *RunHandle) Cancel(ctx context.Context) error {
	body, err := json.Marshal(wireRequest{Type: "cancel", ID: h.id})
	if err != nil {
		return err
	}
	return h.client.conn.Write(ctx, websocket.MessageText, body)
}

// StartRun issues a streaming request and returns a handle. It supersedes
// Stream for callers that need to cancel.
func (c *Client) StartRun(ctx context.Context, reqType string, payload any) (*RunHandle, error) {
	p, id, err := c.send(ctx, reqType, payload)
	if err != nil {
		return nil, err
	}
	events := make(chan Event, 256)
	errc := make(chan error, 1)
	go func() {
		defer c.forget(id)
		defer close(events)
		defer close(errc)
		for {
			select {
			case <-ctx.Done():
				errc <- ctx.Err()
				return
			case frame, ok := <-p.frames:
				if !ok {
					errc <- fmt.Errorf("%s: connection closed", reqType)
					return
				}
				switch frame.Type {
				case "event":
					var ev map[string]any
					_ = json.Unmarshal(frame.Event, &ev)
					e := Event{Raw: ev}
					if k, ok := ev["kind"].(string); ok {
						e.Kind = k
					}
					if s, ok := ev["seq"].(float64); ok {
						e.Seq = int64(s)
					}
					select {
					case events <- e:
					case <-ctx.Done():
						errc <- ctx.Err()
						return
					}
				case "error":
					errc <- frame.Error
					return
				case "done":
					errc <- nil
					return
				}
			}
		}
	}()
	return &RunHandle{client: c, id: id, Events: events, Errc: errc}, nil
}

// Stream is the older two-channel form of StartRun, kept for probes.
func (c *Client) Stream(ctx context.Context, reqType string, payload any) (<-chan Event, <-chan error, error) {
	h, err := c.StartRun(ctx, reqType, payload)
	if err != nil {
		return nil, nil, err
	}
	return h.Events, h.Errc, nil
}

// WorkflowRunEntry is one row of workflow.run.search.
type WorkflowRunEntry struct {
	RunID          string
	WorkflowName   string
	Status         string
	StartedAt      string
	DurationMS     int64
	FailedStep     string
	FailureReason  string
	StepsCompleted int
	StepsTotal     int
}

// SearchWorkflowRuns lists recent runs, optionally scoped to a workflow.
func (c *Client) SearchWorkflowRuns(ctx context.Context, workflow string, limit int) ([]WorkflowRunEntry, error) {
	p := map[string]any{}
	if workflow != "" {
		p["workflow"] = workflow
	}
	if limit > 0 {
		p["limit"] = limit
	}
	res, err := c.dataRequest(ctx, ReqWorkflowRunSearch, p)
	if err != nil {
		return nil, err
	}
	rows := asAnyList(res["results"])
	out := make([]WorkflowRunEntry, 0, len(rows))
	for _, r := range rows {
		m, ok := r.(map[string]any)
		if !ok {
			continue
		}
		prog, _ := m["stepProgress"].(map[string]any)
		out = append(out, WorkflowRunEntry{
			RunID:          jsonStr(m["runId"]),
			WorkflowName:   jsonStr(m["workflowName"]),
			Status:         jsonStr(m["status"]),
			StartedAt:      jsonStr(m["startedAt"]),
			DurationMS:     int64(num(m["duration"])),
			FailedStep:     jsonStr(m["failedStep"]),
			FailureReason:  jsonStr(m["failureReason"]),
			StepsCompleted: int(num(prog["completed"])),
			StepsTotal:     int(num(prog["total"])),
		})
	}
	return out, nil
}

func asAnyList(v any) []any {
	if l, ok := v.([]any); ok {
		return l
	}
	return nil
}

// num coerces a JSON number to float64 (0 if absent).
func num(v any) float64 {
	f, _ := v.(float64)
	return f
}

// Handshake fetches the server version, populating c.Version and c.GitSHA.
func (c *Client) Handshake(ctx context.Context) error {
	raw, err := c.Request(ctx, ReqServerVersion, nil)
	if err != nil {
		return err
	}
	var v struct {
		Version string `json:"version"`
		GitSHA  string `json:"gitSha"`
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		return err
	}
	c.Version = v.Version
	c.GitSHA = v.GitSHA
	return nil
}

// --- Typed helpers over the request types we use in the TUI ---

// dataPayload unwraps the common {"data": ...} envelope and returns the inner
// object as a decoded map.
func (c *Client) dataRequest(ctx context.Context, reqType string, payload any) (map[string]any, error) {
	raw, err := c.Request(ctx, reqType, payload)
	if err != nil {
		return nil, err
	}
	var env dataEnvelope
	if err := json.Unmarshal(raw, &env); err == nil && len(env.Data) > 0 {
		var m map[string]any
		if err := json.Unmarshal(env.Data, &m); err != nil {
			var arr []any
			if err2 := json.Unmarshal(env.Data, &arr); err2 == nil {
				return map[string]any{"items": arr}, nil
			}
			return nil, err
		}
		return m, nil
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, err
	}
	return m, nil
}

// SearchModels returns the raw model.search data object.
func (c *Client) SearchModels(ctx context.Context, query string) (map[string]any, error) {
	p := map[string]any{}
	if query != "" {
		p["query"] = query
	}
	return c.dataRequest(ctx, ReqModelSearch, p)
}

// GetModel returns a single model's detail.
func (c *Client) GetModel(ctx context.Context, name string) (map[string]any, error) {
	return c.dataRequest(ctx, ReqModelGet, map[string]any{"modelIdOrName": name})
}

// SearchTypes lists model types.
func (c *Client) SearchTypes(ctx context.Context, query string) (map[string]any, error) {
	p := map[string]any{}
	if query != "" {
		p["query"] = query
	}
	return c.dataRequest(ctx, ReqModelTypeSearch, p)
}

// DescribeType returns a model type's surface (methods, data specs).
func (c *Client) DescribeType(ctx context.Context, typeArg string) (map[string]any, error) {
	return c.dataRequest(ctx, ReqModelTypeDescribe, map[string]any{"typeArg": typeArg})
}

// SearchWorkflows lists workflows.
func (c *Client) SearchWorkflows(ctx context.Context, query string) (map[string]any, error) {
	p := map[string]any{}
	if query != "" {
		p["query"] = query
	}
	return c.dataRequest(ctx, ReqWorkflowSearch, p)
}

// GetWorkflow returns a workflow's detail.
func (c *Client) GetWorkflow(ctx context.Context, name string) (map[string]any, error) {
	return c.dataRequest(ctx, ReqWorkflowGet, map[string]any{"workflowIdOrName": name})
}

// RunStep is one executed step of a run, with the artifacts it produced.
type RunStep struct {
	Name      string
	Status    string
	Artifacts []RunArtifact
}

// RunArtifact is one data artifact produced by a run step. Kind is the artifact
// tag type ("resource", "report", or "file"); ReportName/ReportScope are set for
// reports. ModelName is the owning model (used to fetch content).
type RunArtifact struct {
	DataID      string
	Name        string
	Version     int
	Kind        string
	ModelName   string
	ReportName  string
	ReportScope string
	ContentType string
	Size        int64
}

// RunDetail is a single workflow run's recorded history, including the data and
// report artifacts each step produced.
type RunDetail struct {
	RunID        string
	WorkflowName string
	Status       string
	Steps        []RunStep
}

// Artifacts returns every artifact across all steps, in step order.
func (r *RunDetail) Artifacts() []RunArtifact {
	var out []RunArtifact
	for _, s := range r.Steps {
		out = append(out, s.Artifacts...)
	}
	return out
}

// GetWorkflowRun fetches one run's history by run id (workflow.history.get
// accepts the run id as its idOrName argument). Unlike workflow.run.search,
// this includes each step's dataArtifacts — the link between a run and the
// model data, files, and reports it produced.
func (c *Client) GetWorkflowRun(ctx context.Context, runID string) (*RunDetail, error) {
	res, err := c.dataRequest(ctx, ReqWorkflowHistGet, map[string]any{"workflowIdOrName": runID})
	if err != nil {
		return nil, err
	}
	d := &RunDetail{
		RunID:        jsonStr(res["id"]),
		WorkflowName: jsonStr(res["workflowName"]),
		Status:       jsonStr(res["status"]),
	}
	for _, j := range asAnyList(res["jobs"]) {
		jm, ok := j.(map[string]any)
		if !ok {
			continue
		}
		for _, s := range asAnyList(jm["steps"]) {
			sm, ok := s.(map[string]any)
			if !ok {
				continue
			}
			step := RunStep{Name: jsonStr(sm["name"]), Status: jsonStr(sm["status"])}
			for _, a := range asAnyList(sm["dataArtifacts"]) {
				am, ok := a.(map[string]any)
				if !ok {
					continue
				}
				tags, _ := am["tags"].(map[string]any)
				step.Artifacts = append(step.Artifacts, RunArtifact{
					DataID:      jsonStr(am["dataId"]),
					Name:        jsonStr(am["name"]),
					Version:     int(num(am["version"])),
					Kind:        jsonStr(tags["type"]),
					ModelName:   jsonStr(tags["modelName"]),
					ReportName:  jsonStr(tags["reportName"]),
					ReportScope: jsonStr(tags["reportScope"]),
				})
			}
			d.Steps = append(d.Steps, step)
		}
	}
	return d, nil
}

// ListData lists data for a model.
func (c *Client) ListData(ctx context.Context, model string) (map[string]any, error) {
	p := map[string]any{}
	if model != "" {
		p["modelIdOrName"] = model
	}
	return c.dataRequest(ctx, ReqDataList, p)
}

// ListWorkflowData lists data produced by a workflow.
func (c *Client) ListWorkflowData(ctx context.Context, workflow string) (map[string]any, error) {
	return c.dataRequest(ctx, ReqDataList, map[string]any{"workflowName": workflow})
}

// GetData fetches one model data item (optionally a version), with content.
func (c *Client) GetData(ctx context.Context, model, name string, version int) (map[string]any, error) {
	return c.GetDataScoped(ctx, false, model, name, version)
}

// GetDataScoped fetches one data item with content. When byWorkflow is true the
// lookup is scoped by workflowName instead of modelIdOrName.
func (c *Client) GetDataScoped(ctx context.Context, byWorkflow bool, root, name string, version int) (map[string]any, error) {
	p := map[string]any{"dataName": name, "includeContent": true}
	if byWorkflow {
		p["workflowName"] = root
	} else {
		p["modelIdOrName"] = root
	}
	if version > 0 {
		p["version"] = version
	}
	return c.dataRequest(ctx, ReqDataGet, p)
}

// DataQuery runs a CEL predicate over the data catalog. selectExpr is optional.
// Returns the projected rows (list or map per the select expression).
func (c *Client) DataQuery(ctx context.Context, predicate, selectExpr string, limit int) ([]any, error) {
	res, err := c.QueryData(ctx, predicate, selectExpr, limit)
	if err != nil {
		return nil, err
	}
	// With a --select projection the rows live under projected.rows; without
	// one they are the raw records under results.
	if res.Projected != nil && res.Projected.Rows != nil {
		return res.Projected.Rows, nil
	}
	rows := make([]any, 0, len(res.Records))
	for _, r := range res.Records {
		rows = append(rows, r)
	}
	return rows, nil
}

// QueryResult is the full, shape-preserving result of a data.query. Exactly one
// of Records (no select), or Projected (with select) is populated.
type QueryResult struct {
	Predicate string
	Select    string
	Total     int
	Limited   bool

	// Records are the raw DataRecords returned when no select is given.
	Records []map[string]any

	// Projected is set when the query used a select expression.
	Projected *Projection
}

// Projection is a --select projection. Shape is "list", "map", or "scalar".
//
//	list:   Rows is []any, each a []any of positional columns
//	map:    Columns names the keys, Rows is []any of map[string]any
//	scalar: Values holds the per-record scalar values
type Projection struct {
	Shape   string
	Columns []string
	Rows    []any
	Values  []any
}

// QueryData runs a predicate (and optional select) and returns the complete
// structured result, preserving whether the query projected a list, map, or
// scalar. This is the primitive the Playground uses.
func (c *Client) QueryData(ctx context.Context, predicate, selectExpr string, limit int) (*QueryResult, error) {
	p := map[string]any{"predicate": predicate}
	if selectExpr != "" {
		p["select"] = selectExpr
	}
	if limit > 0 {
		p["limit"] = limit
	}
	res, err := c.dataRequest(ctx, ReqDataQuery, p)
	if err != nil {
		return nil, err
	}
	out := &QueryResult{
		Predicate: jsonStr(res["predicate"]),
		Select:    jsonStr(res["select"]),
		Total:     int(num(res["total"])),
		Limited:   boolVal(res["limited"]),
	}
	for _, r := range asAnyList(res["results"]) {
		if m, ok := r.(map[string]any); ok {
			out.Records = append(out.Records, m)
		}
	}
	if proj, ok := res["projected"].(map[string]any); ok {
		pj := &Projection{Shape: jsonStr(proj["shape"])}
		for _, cn := range asAnyList(proj["columns"]) {
			pj.Columns = append(pj.Columns, jsonStr(cn))
		}
		if rows, ok := proj["rows"].([]any); ok {
			pj.Rows = rows
		}
		if vals, ok := proj["values"].([]any); ok {
			pj.Values = vals
		}
		out.Projected = pj
	}
	return out, nil
}

// boolVal coerces a JSON value to bool.
func boolVal(v any) bool {
	b, _ := v.(bool)
	return b
}

// RunHistory lists recent runs.
func (c *Client) RunHistory(ctx context.Context, active bool) ([]RunHistoryEntry, error) {
	raw, err := c.Request(ctx, ReqRunHistory, map[string]any{"active": active})
	if err != nil {
		return nil, err
	}
	var resp RunHistoryResponse
	if err := json.Unmarshal(raw, &resp); err != nil {
		return nil, err
	}
	return resp.Runs, nil
}

// AuthInfo fetches GET /auth/info from an http base URL (unauthenticated).
func FetchAuthInfo(ctx context.Context, baseURL string) (*AuthInfo, error) {
	httpURL := strings.TrimSuffix(baseURL, "/")
	if strings.HasPrefix(httpURL, "ws://") {
		httpURL = "http://" + strings.TrimPrefix(httpURL, "ws://")
	} else if strings.HasPrefix(httpURL, "wss://") {
		httpURL = "https://" + strings.TrimPrefix(httpURL, "wss://")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, httpURL+"/auth/info", nil)
	if err != nil {
		return nil, err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("auth/info: status %d", resp.StatusCode)
	}
	var info AuthInfo
	if err := json.NewDecoder(resp.Body).Decode(&info); err != nil {
		return nil, err
	}
	return &info, nil
}

// jsonStr renders a JSON scalar as a string ("" when absent).
func jsonStr(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	default:
		return fmt.Sprintf("%v", t)
	}
}
