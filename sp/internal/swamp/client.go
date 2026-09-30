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

// Stream starts a streaming request (workflow.run, model.method.run). It returns
// a channel of events; the channel is closed on done/error, and the terminal
// error is delivered on the returned error channel (which may deliver nil).
func (c *Client) Stream(ctx context.Context, reqType string, payload any) (<-chan Event, <-chan error, error) {
	p, id, err := c.send(ctx, reqType, payload)
	if err != nil {
		return nil, nil, err
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
	return events, errc, nil
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

// ListData lists data for a model or workflow.
func (c *Client) ListData(ctx context.Context, model string) (map[string]any, error) {
	p := map[string]any{}
	if model != "" {
		p["modelIdOrName"] = model
	}
	return c.dataRequest(ctx, ReqDataList, p)
}

// GetData fetches one data item (optionally a version), including content.
func (c *Client) GetData(ctx context.Context, model, name string, version int) (map[string]any, error) {
	p := map[string]any{"modelIdOrName": model, "dataName": name, "includeContent": true}
	if version > 0 {
		p["version"] = version
	}
	return c.dataRequest(ctx, ReqDataGet, p)
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
