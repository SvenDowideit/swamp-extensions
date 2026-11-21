package nn

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/svendowideit/swamp-project/sp/internal/swamp"
)

// --- helpers ---------------------------------------------------------------

func key(s string) tea.KeyPressMsg {
	switch s {
	case "space":
		return tea.KeyPressMsg{Code: tea.KeySpace, Text: " "}
	case "enter":
		return tea.KeyPressMsg{Code: tea.KeyEnter}
	case "up":
		return tea.KeyPressMsg{Code: tea.KeyUp}
	case "down":
		return tea.KeyPressMsg{Code: tea.KeyDown}
	case "backspace":
		return tea.KeyPressMsg{Code: tea.KeyBackspace}
	case "esc":
		return tea.KeyPressMsg{Code: tea.KeyEscape}
	case "pgdown":
		return tea.KeyPressMsg{Code: tea.KeyPgDown}
	case "pgup":
		return tea.KeyPressMsg{Code: tea.KeyPgUp}
	default:
		r := []rune(s)[0]
		return tea.KeyPressMsg{Code: r, Text: s}
	}
}

// fakeAPI serves canned swamp payloads.
type fakeAPI struct {
	data           map[string]map[string]any // "model/resource" -> payload
	workflows      []map[string]any
	models         []map[string]any
	runs           map[string][]swamp.WorkflowRunEntry
	methodRuns     []swamp.ModelRunEntry
	lastModelQuery string
	lastModelLimit int
	workflowDefs   map[string]map[string]any
}

func (f *fakeAPI) GetData(_ context.Context, model, name string, _ int) (map[string]any, error) {
	return f.data[model+"/"+name], nil
}

func (f *fakeAPI) SearchWorkflows(_ context.Context, _ string) (map[string]any, error) {
	return map[string]any{"results": toAny(f.workflows)}, nil
}

func (f *fakeAPI) SearchModels(_ context.Context, _ string) (map[string]any, error) {
	return map[string]any{"results": toAny(f.models)}, nil
}

func (f *fakeAPI) SearchWorkflowRuns(_ context.Context, workflow string, _ int) ([]swamp.WorkflowRunEntry, error) {
	return f.runs[workflow], nil
}

func (f *fakeAPI) GetModel(_ context.Context, name string) (map[string]any, error) {
	for _, m := range f.models {
		if scalar(m["name"]) == name {
			return m, nil
		}
	}
	return nil, errors.New("no such model: " + name)
}

func (f *fakeAPI) SearchModelOutputs(_ context.Context, model string, limit int) ([]swamp.ModelRunEntry, error) {
	f.lastModelQuery, f.lastModelLimit = model, limit
	return f.methodRuns, nil
}

func (f *fakeAPI) GetWorkflow(_ context.Context, name string) (map[string]any, error) {
	w, ok := f.workflowDefs[name]
	if !ok {
		return nil, errors.New("no such workflow: " + name)
	}
	return w, nil
}

func toAny(in []map[string]any) []any {
	out := make([]any, 0, len(in))
	for _, m := range in {
		out = append(out, m)
	}
	return out
}

// --- fields ----------------------------------------------------------------

func TestParseTimeOrdersRFC1123Chronologically(t *testing.T) {
	// news-reader emits RFC1123 with a weekday prefix, so lexical comparison
	// would order "Thu, 12" before "Wed, 3". Verify we compare real times.
	a := sortTime("Wed, 3 Dec 2026 10:00:00 +0000")
	b := sortTime("Thu, 12 Nov 2026 10:00:00 +0000")
	if a.IsZero() || b.IsZero() {
		t.Fatalf("expected both to parse, got %v %v", a, b)
	}
	if !a.After(b) {
		t.Fatalf("3 Dec should be after 12 Nov")
	}
	if got := timestampFor("Thu, 12 Nov 2026 10:00:00 +0000"); got != "2026-11-12T10:00:00Z" {
		t.Fatalf("timestampFor normalisation: %q", got)
	}
}

func TestLookupPaths(t *testing.T) {
	root := map[string]any{
		"articles": []any{
			map[string]any{"title": "one"},
			map[string]any{"title": "two"},
		},
		"count": 3.0,
	}
	if got := scalar(lookup(root, "articles.1.title")); got != "two" {
		t.Fatalf("indexed path: %q", got)
	}
	if got := scalar(lookup(root, "count")); got != "3" {
		t.Fatalf("number formatting: %q", got)
	}
	if got := lookup(root, "missing.deep"); got != nil {
		t.Fatalf("missing path should be nil, got %v", got)
	}
}

func TestMenuLineNeverWraps(t *testing.T) {
	cols := []string{"arXiv cs.AI", strings.Repeat("long subject ", 20)}
	for _, w := range []int{20, 40, 80, 120} {
		line := menuLine("a", AttrUnread, "SEC", cols, w)
		if strings.Contains(line, "\n") {
			t.Fatalf("width %d: menu line contains a newline", w)
		}
		if got := width(line); got > w {
			t.Fatalf("width %d: line is %d cells: %q", w, got, line)
		}
	}
}

func width(s string) int {
	n := 0
	for range s {
		n++
	}
	return n
}

func TestIDCharRoundTrip(t *testing.T) {
	for i := 0; i < 36; i++ {
		idx, ok := idIndex(idChar(i))
		if !ok || idx != i {
			t.Fatalf("id %d -> %q -> %d ok=%v", i, idChar(i), idx, ok)
		}
	}
	if idChar(0) != "a" || idChar(26) != "0" {
		t.Fatalf("id alphabet: %q %q", idChar(0), idChar(26))
	}
}

// --- config ----------------------------------------------------------------

func TestLoadConfigFallsBackToBuiltIn(t *testing.T) {
	cfg, src, err := LoadConfig(filepath.Join(t.TempDir(), "absent.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	if src != "built-in" {
		t.Fatalf("source: %q", src)
	}
	if len(cfg.Groups) == 0 {
		t.Fatal("expected default groups")
	}
	for _, g := range cfg.Groups {
		if g.PageSize == 0 || g.Format == "" || g.IDField == "" {
			t.Fatalf("group %s missing defaults: %+v", g.ID, g)
		}
	}
}

func TestLoadConfigRejectsEmptyGroupList(t *testing.T) {
	p := filepath.Join(t.TempDir(), "nn.groups.yaml")
	if err := os.WriteFile(p, []byte("version: 1\ngroups: []\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := LoadConfig(p); err == nil {
		t.Fatal("an empty group list must be an error: it looks like " +
			"\"no news today\", the one failure mode this reader must not have")
	}
}

// --- state -----------------------------------------------------------------

func TestAttributesAreExplicitAndSpaceMarksSeen(t *testing.T) {
	s, err := OpenStore("")
	if err != nil {
		t.Fatal(err)
	}
	items := []*Item{
		{ID: "a", Group: "g", NewSince: "2026-01-01T00:00:00Z", SortKey: sortTime("2026-01-01T00:00:00Z")},
		{ID: "b", Group: "g", NewSince: "2026-01-02T00:00:00Z", SortKey: sortTime("2026-01-02T00:00:00Z")},
	}
	for _, it := range items {
		if got := s.EffectiveAttr(it); got != AttrUnread {
			t.Fatalf("%s should start unread, got %q", it.ID, got)
		}
	}
	s.MarkSeen(items[:1])
	if got := s.EffectiveAttr(items[0]); got != AttrSeen {
		t.Fatalf("paged item should be seen, got %q", got)
	}
	if got := s.EffectiveAttr(items[1]); got != AttrUnread {
		t.Fatalf("unpaged item must stay unread, got %q", got)
	}
	s.SetAttrs("g", items[1:], AttrRead)
	if got := s.EffectiveAttr(items[1]); got != AttrRead {
		t.Fatalf("read item, got %q", got)
	}
}

func TestWatermarkAdvancesOnlyOverSeenItems(t *testing.T) {
	s, _ := OpenStore("")
	items := []*Item{
		{ID: "old", Group: "g", NewSince: "2026-01-01T00:00:00Z", SortKey: sortTime("2026-01-01T00:00:00Z")},
		{ID: "mid", Group: "g", NewSince: "2026-02-01T00:00:00Z", SortKey: sortTime("2026-02-01T00:00:00Z")},
		{ID: "new", Group: "g", NewSince: "2026-03-01T00:00:00Z", SortKey: sortTime("2026-03-01T00:00:00Z")},
	}
	s.MarkSeen(items[1:2]) // saw only "mid"
	s.AdvanceWatermark("g", items)
	if got := s.Watermark("g"); got != "2026-02-01T00:00:00Z" {
		t.Fatalf("watermark should stop at the newest seen item, got %q", got)
	}
}

func TestStatePersistsAcrossReopen(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "state.json")
	s, err := OpenStore(path)
	if err != nil {
		t.Fatal(err)
	}
	s.SetAttr("news", "id-1", AttrRead)
	s.SetPosition("news", 2, 7)
	s.SetLastInputs("wf", map[string]any{"cidr": "10.0.0.0/24"})
	if err := s.Save(); err != nil {
		t.Fatal(err)
	}

	re, err := OpenStore(path)
	if err != nil {
		t.Fatal(err)
	}
	if a, ok := re.Attr("news", "id-1"); !ok || a != AttrRead {
		t.Fatalf("attr not persisted: %q ok=%v", a, ok)
	}
	if page, cursor := re.Position("news"); page != 2 || cursor != 7 {
		t.Fatalf("position not persisted: %d %d", page, cursor)
	}
	if got := re.LastInputs("wf")["cidr"]; got != "10.0.0.0/24" {
		t.Fatalf("last inputs not persisted: %v", got)
	}
}

func TestCorruptStateIsQuarantinedNotFatal(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	if err := os.WriteFile(path, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	s, err := OpenStore(path)
	if err != nil {
		t.Fatalf("corrupt state must not be fatal: %v", err)
	}
	if _, err := os.Stat(path + ".corrupt"); err != nil {
		t.Fatalf("expected a .corrupt backup: %v", err)
	}
	if a, ok := s.Attr("g", "x"); ok || a != AttrUnread {
		t.Fatalf("expected empty store, got %q ok=%v", a, ok)
	}
}

// --- pager -----------------------------------------------------------------

func TestPagerAdvanceReadsItemsInOrder(t *testing.T) {
	items := []*Item{
		{ID: "a", Group: "g", Format: "text", Body: "short"},
		{ID: "b", Group: "g", Format: "text", Body: "also short"},
	}
	p := newPager(items, 0)
	read, done := p.advance(40, 10)
	if done || len(read) != 1 || read[0].ID != "a" {
		t.Fatalf("first advance should finish and read a: %v %v", read, done)
	}
	read, done = p.advance(40, 10)
	if !done || len(read) != 1 || read[0].ID != "b" {
		t.Fatalf("second advance should finish b: %v %v", read, done)
	}
}

func TestBodyLinesByFormat(t *testing.T) {
	md := &Item{Format: "markdown", Body: "# Title\n\nbody text"}
	lines := bodyLines(md, 40)
	if len(lines) == 0 || !strings.Contains(strings.Join(lines, " "), "Title") {
		t.Fatalf("markdown not rendered: %q", lines)
	}
	row := &Item{Format: "row", Raw: map[string]any{"tier": "T1", "os": "linux"}}
	joined := strings.Join(bodyLines(row, 40), "\n")
	if !strings.Contains(joined, "tier") || !strings.Contains(joined, "T1") {
		t.Fatalf("row fields not rendered: %q", joined)
	}
}

// --- shell -----------------------------------------------------------------

func newTestModel(t *testing.T, cfg *Config, api *fakeAPI) *Model {
	t.Helper()
	loader := &Loader{API: api}
	store, err := OpenStore("")
	if err != nil {
		t.Fatal(err)
	}
	m := New(cfg, "test", loader, store, "repo", "serve :0")
	m.width, m.height = 100, 24
	return m
}

func TestShellRendersOverviewAndMenu(t *testing.T) {
	cfg := &Config{
		Defaults: Defaults{PageSize: 5},
		Groups: []GroupSpec{{
			ID: "news", Title: "news", Kind: "data",
			Model: "m", Resource: "r", Path: "articles",
			IDField: "id", Format: "article", Menu: []string{"source", "title"},
			NewSince: "publishedAt", Sort: "publishedAt desc",
		}},
	}
	api := &fakeAPI{data: map[string]map[string]any{
		"m/r": {"content": map[string]any{"articles": []any{
			map[string]any{"id": "1", "title": "First", "source": "HN", "publishedAt": "2026-11-15T10:00:00Z"},
			map[string]any{"id": "2", "title": "Second", "source": "LWN", "publishedAt": "2026-11-15T11:00:00Z"},
		}}},
	}}
	m := newTestModel(t, cfg, api)
	g := m.groups[0]
	if err := m.loader.Load(context.Background(), g); err != nil {
		t.Fatal(err)
	}
	m.recount()
	view := m.render()
	if !strings.Contains(view, "news") || !strings.Contains(view, "2 unread") {
		t.Fatalf("overview missing counts:\n%s", view)
	}

	if _, _ = m.handleKey(key("space")); m.mode != modeMenu {
		t.Fatalf("space in the overview should enter the group, mode=%v", m.mode)
	}
	if !strings.Contains(m.render(), "Second") {
		// sorted by publishedAt desc, so Second is row a
		t.Fatalf("menu did not render items:\n%s", m.render())
	}
}

func TestShellSelectAndRead(t *testing.T) {
	cfg := &Config{
		Defaults: Defaults{PageSize: 10},
		Groups: []GroupSpec{{
			ID: "news", Title: "news", Kind: "data",
			Model: "m", Resource: "r", Path: "articles",
			IDField: "id", Format: "text", Menu: []string{"title"}, Body: "body",
		}},
	}
	api := &fakeAPI{data: map[string]map[string]any{
		"m/r": {"content": map[string]any{"articles": []any{
			map[string]any{"id": "1", "title": "First", "body": "body one"},
			map[string]any{"id": "2", "title": "Second", "body": "body two"},
		}}},
	}}
	m := newTestModel(t, cfg, api)
	g := m.groups[0]
	if err := m.loader.Load(context.Background(), g); err != nil {
		t.Fatal(err)
	}
	m.enterGroup(g)

	m.handleKey(key("a")) // select the first row
	if got := m.store.EffectiveAttr(g.Items[0]); got != AttrSelected {
		t.Fatalf("a should select row a, got %q", got)
	}
	if m.cursor != 1 {
		t.Fatalf("cursor should advance past the selected row, got %d", m.cursor)
	}
	m.handleKey(key("space"))
	if m.mode != modePager {
		t.Fatalf("space with a selection should open the pager, mode=%v", m.mode)
	}
	if !strings.Contains(m.render(), "body one") {
		t.Fatalf("pager did not show the body:\n%s", m.render())
	}
	m.handleKey(key("space")) // past the end of the only selected item
	if m.mode != modeMenu {
		t.Fatalf("pager should return to the menu when finished, mode=%v", m.mode)
	}
	if got := m.store.EffectiveAttr(g.Items[0]); got != AttrRead {
		t.Fatalf("read item should be marked read, got %q", got)
	}
}

func TestShellResumesPositionAcrossProcesses(t *testing.T) {
	cfg := &Config{Defaults: Defaults{PageSize: 2}, Groups: []GroupSpec{{
		ID: "g", Kind: "data", Model: "m", Resource: "r", Path: "items",
		IDField: "id", Format: "text", Menu: []string{"title"},
	}}}
	rows := []any{}
	for i := 0; i < 6; i++ {
		rows = append(rows, map[string]any{"id": string(rune('a' + i)), "title": "item"})
	}
	api := &fakeAPI{data: map[string]map[string]any{
		"m/r": {"content": map[string]any{"items": rows}},
	}}
	statePath := filepath.Join(t.TempDir(), "state.json")

	// First session: page down, select a row, then quit.
	storeA, err := OpenStore(statePath)
	if err != nil {
		t.Fatal(err)
	}
	m := New(cfg, "test", &Loader{API: api}, storeA, "repo", "serve :0")
	m.width, m.height = 100, 24
	g := m.groups[0]
	if err := m.loader.Load(context.Background(), g); err != nil {
		t.Fatal(err)
	}
	m.enterGroup(g)
	m.handleKey(key("pgdown")) // page 2 of 3
	m.handleKey(key("a"))      // select the first row on this page
	m.Shutdown()

	// Second session: a fresh store read from disk, same config.
	storeB, err := OpenStore(statePath)
	if err != nil {
		t.Fatal(err)
	}
	m2 := New(cfg, "test", &Loader{API: api}, storeB, "repo", "serve :0")
	m2.width, m2.height = 100, 24
	g2 := m2.groups[0]
	if err := m2.loader.Load(context.Background(), g2); err != nil {
		t.Fatal(err)
	}
	if m2.mode != modeMenu || m2.cur == nil || m2.cur.ID() != "g" {
		t.Fatalf("expected to resume in group g, mode=%v cur=%v", m2.mode, m2.cur)
	}
	m2.page, m2.cursor = m2.store.Position("g")
	if m2.page != 1 {
		t.Fatalf("expected to resume on page 2, got page %d", m2.page)
	}
	selected := 0
	for _, it := range g2.Items {
		if m2.store.EffectiveAttr(it) == AttrSelected {
			selected++
		}
	}
	if selected != 1 {
		t.Fatalf("expected the selection to survive the restart, got %d", selected)
	}
}

// --- runs, forms, live -----------------------------------------------------

func TestRunHistoryPutsTheFormFirst(t *testing.T) {
	cfg := &Config{Defaults: Defaults{PageSize: 10}, Groups: []GroupSpec{{
		ID: "runs", Kind: "runs", Collection: "workflows",
		IDField: "name", Format: "runnable", Menu: []string{"name"},
	}}}
	api := &fakeAPI{
		workflows: []map[string]any{{"name": "sweep", "description": "daily sweep"}},
		workflowDefs: map[string]map[string]any{"sweep": {"inputs": map[string]any{
			"required": []any{"cidr"},
			"properties": map[string]any{
				"cidr":  map[string]any{"type": "string", "description": "CIDR to scan"},
				"ports": map[string]any{"type": "array", "default": []any{22, 443}},
			},
		}}},
		runs: map[string][]swamp.WorkflowRunEntry{"sweep": {{
			RunID: "run-1", WorkflowName: "sweep", Status: "failed",
			StartedAt: "2026-11-15T03:00:00Z", DurationMS: 72000,
			FailedStep: "probe", FailureReason: "probe timeout on 10.10.12.30",
			StepsCompleted: 1, StepsTotal: 2,
		}}},
	}
	m := newTestModel(t, cfg, api)
	g := m.groups[0]
	if err := m.loader.Load(context.Background(), g); err != nil {
		t.Fatal(err)
	}
	if len(g.Children) != 1 {
		t.Fatalf("expected one child group per runnable, got %d", len(g.Children))
	}
	child := g.Children[0]
	if err := m.loader.Load(context.Background(), child); err != nil {
		t.Fatal(err)
	}
	if len(child.Items) != 2 {
		t.Fatalf("expected '+ run' plus one run, got %d", len(child.Items))
	}
	if child.Items[0].ID != "+" || child.Items[0].Format != "form" {
		t.Fatalf("first item must be the run form: %+v", child.Items[0])
	}
	if child.Items[1].Status != "failed" || child.Items[1].Body == "" {
		t.Fatalf("failed run should carry its reason: %+v", child.Items[1])
	}
}

func TestFormFieldsComeFromTheSchema(t *testing.T) {
	schema := map[string]any{
		"required": []any{"cidr"},
		"properties": map[string]any{
			"cidr":    map[string]any{"type": "string", "description": "CIDR to scan"},
			"ports":   map[string]any{"type": "array", "default": []any{22, 80}},
			"probeMs": map[string]any{"type": "integer", "default": 3000.0, "minimum": 1.0, "maximum": 60000.0},
			"fp":      map[string]any{"type": "boolean", "default": true},
			"mode":    map[string]any{"type": "string", "enum": []any{"fast", "full"}},
		},
	}
	fields := inputFields(schema)
	if len(fields) != 5 {
		t.Fatalf("expected 5 fields, got %d", len(fields))
	}
	if !fields[0].Required || fields[0].Name != "cidr" {
		t.Fatalf("required fields come first: %+v", fields[0])
	}
	byName := map[string]*Field{}
	for _, f := range fields {
		byName[f.Name] = f
	}
	if byName["fp"].IsBool() != true || byName["fp"].Bool != true {
		t.Fatalf("boolean default: %+v", byName["fp"])
	}
	if byName["probeMs"].Text != "3000" {
		t.Fatalf("integer default: %q", byName["probeMs"].Text)
	}
	if len(byName["mode"].Enum) != 2 {
		t.Fatalf("enum not captured: %+v", byName["mode"].Enum)
	}
}

func TestFormSubmitValidates(t *testing.T) {
	schema := map[string]any{
		"required": []any{"cidr", "probeMs"},
		"properties": map[string]any{
			"cidr":    map[string]any{"type": "string"},
			"probeMs": map[string]any{"type": "integer", "minimum": 1.0, "maximum": 60000.0},
			"mode":    map[string]any{"type": "string", "enum": []any{"fast", "full"}},
		},
	}
	f := newForm(runTarget{Kind: "workflow", Workflow: "sweep"}, schema, nil)
	if _, err := f.submitValues(); err == nil {
		t.Fatal("missing required fields must fail validation")
	}
	byName := map[string]*Field{}
	for _, fld := range f.fields {
		byName[fld.Name] = fld
	}
	byName["cidr"].Text = "10.0.0.0/24"
	byName["probeMs"].Text = "99999"
	if _, err := f.submitValues(); err == nil {
		t.Fatal("out-of-range integer must fail validation")
	}
	byName["probeMs"].Text = "1500"
	byName["mode"].Text = "nonsense"
	if _, err := f.submitValues(); err == nil {
		t.Fatal("value outside the enum must fail validation")
	}
	byName["mode"].Text = "fast"
	got, err := f.submitValues()
	if err != nil {
		t.Fatal(err)
	}
	if got["cidr"] != "10.0.0.0/24" || got["mode"] != "fast" {
		t.Fatalf("unexpected inputs: %v", got)
	}
	if _, ok := got["probeMs"].(int64); !ok {
		t.Fatalf("integer should stay an integer: %T", got["probeMs"])
	}
}

func TestFormRestorePrefillsFromLastRun(t *testing.T) {
	schema := map[string]any{"properties": map[string]any{
		"cidr": map[string]any{"type": "string"},
		"fp":   map[string]any{"type": "boolean"},
	}}
	f := newForm(runTarget{Kind: "workflow", Workflow: "sweep"}, schema, map[string]any{"cidr": "10.1.0.0/16", "fp": false})
	if f.fields[0].Text != "10.1.0.0/16" || f.fields[1].Bool != false {
		t.Fatalf("prefill failed: %+v", f.fields)
	}
}

// fakeRuns implements RunAPI with a preloaded event stream, and records what it
// was asked to run.
type fakeRuns struct {
	handle  *swamp.RunHandle
	reqType string
	payload map[string]any
}

func (f *fakeRuns) StartRun(_ context.Context, reqType string, p any) (*swamp.RunHandle, error) {
	f.reqType = reqType
	b, _ := json.Marshal(p)
	_ = json.Unmarshal(b, &f.payload)
	return f.handle, nil
}

func TestShellRunsAWorkflowFromTheForm(t *testing.T) {
	cfg := &Config{Defaults: Defaults{PageSize: 10}, Groups: []GroupSpec{{
		ID: "runs", Kind: "runs", Collection: "workflows",
		IDField: "name", Format: "runnable", Menu: []string{"name"},
	}}}
	api := &fakeAPI{
		workflows: []map[string]any{{"name": "sweep"}},
		workflowDefs: map[string]map[string]any{"sweep": {"inputs": map[string]any{
			"properties": map[string]any{
				"cidr": map[string]any{"type": "string", "default": "10.0.0.0/24"},
			},
		}}},
		runs: map[string][]swamp.WorkflowRunEntry{},
	}

	events := make(chan swamp.Event, 8)
	errc := make(chan error, 1)
	errc <- nil
	handle := &swamp.RunHandle{Events: events, Errc: errc}

	m := newTestModel(t, cfg, api)
	m.SetRunAPI(&fakeRuns{handle: handle})
	g := m.groups[0]
	if err := m.loader.Load(context.Background(), g); err != nil {
		t.Fatal(err)
	}
	m.enterGroup(g)

	// space on a runnable pushes its history (the loader adds the child).
	if _, _ = m.handleKey(key("space")); m.cur == nil || m.cur.ID() != "runs/sweep" {
		t.Fatalf("space on a runnable should push its history, cur=%v", m.cur)
	}
	child := m.cur
	if !child.Loaded {
		if err := m.loader.Load(context.Background(), child); err != nil {
			t.Fatal(err)
		}
	}

	// space on "+ run" opens the generated form.
	if _, _ = m.handleKey(key("space")); m.mode != modeForm {
		t.Fatalf("space on '+ run' should open the form, mode=%v", m.mode)
	}
	if !strings.Contains(m.render(), "cidr") {
		t.Fatalf("form should show the schema fields:\n%s", m.render())
	}

	// ctrl+s starts the run and switches to the live view.
	cmd := m.startRun(runTarget{Kind: "workflow", Workflow: "sweep"}, map[string]any{"cidr": "10.0.0.0/24"})
	if cmd == nil || m.mode != modeLive {
		t.Fatalf("expected a live view after starting, mode=%v", m.mode)
	}
	if got := m.store.LastInputs("workflow:sweep")["cidr"]; got != nil && got != "10.0.0.0/24" {
		t.Fatalf("inputs not remembered: %v", got)
	}
	// Deliver the start message and one event, then the terminal frame.
	m.Update(runStartedMsg{handle: handle})
	events <- swamp.Event{Kind: "step_started", Raw: map[string]any{"stepId": "probe"}}
	m.Update(runEventMsg{ev: swamp.Event{Kind: "step_started", Raw: map[string]any{"stepId": "probe"}}})
	if !strings.Contains(m.render(), "probe") {
		t.Fatalf("live view should show the step:\n%s", m.render())
	}
	m.Update(runDoneMsg{err: nil})
	if m.live == nil || !m.live.done {
		t.Fatal("live view should be done after the terminal frame")
	}
}

// --- peek (%) --------------------------------------------------------------

func TestPeekShowsBodyAndMarksNothing(t *testing.T) {
	cfg := &Config{Defaults: Defaults{PageSize: 10}, Groups: []GroupSpec{{
		ID: "news", Kind: "data", Model: "m", Resource: "r", Path: "articles",
		IDField: "id", Format: "text", Menu: []string{"title"}, Body: "body",
	}}}
	api := &fakeAPI{data: map[string]map[string]any{"m/r": {"content": map[string]any{"articles": []any{
		map[string]any{"id": "1", "title": "First", "body": "the body of the first item"},
		map[string]any{"id": "2", "title": "Second", "body": "second body"},
	}}}}}
	m := newTestModel(t, cfg, api)
	g := m.groups[0]
	if err := m.loader.Load(context.Background(), g); err != nil {
		t.Fatal(err)
	}
	m.enterGroup(g)

	if _, _ = m.handleKey(key("%")); m.preview == nil {
		t.Fatal("% should open a peek on the row under the cursor")
	}
	view := m.render()
	if !strings.Contains(view, "the body of the first item") {
		t.Fatalf("peek should show the row's body:\n%s", view)
	}
	if !strings.Contains(view, "preview") {
		t.Fatalf("peek should label itself:\n%s", view)
	}
	// A peek is not reading: nothing is marked.
	for _, it := range g.Items {
		if got := m.store.EffectiveAttr(it); got != AttrUnread {
			t.Fatalf("peeking must not mark %s (%q)", it.ID, got)
		}
	}
	// The menu is still there above the peek.
	if !strings.Contains(view, "Second") {
		t.Fatalf("peek must not replace the menu:\n%s", view)
	}
	// % closes it.
	m.handleKey(key("%"))
	if m.preview != nil {
		t.Fatal("% should close the peek")
	}
	// esc closes it too.
	m.handleKey(key("%"))
	m.handleKey(key("esc"))
	if m.preview != nil {
		t.Fatal("esc should close the peek")
	}
}

func TestFooterPutsKeysFirst(t *testing.T) {
	m := &Model{width: 120, height: 20, mode: modeMenu}
	bar := m.renderFooter()
	for _, want := range []string{"a-z0-9", "select", "%", "peek", "space", "continue"} {
		if !strings.Contains(bar, want) {
			t.Fatalf("footer missing %q: %q", want, bar)
		}
	}
}

func TestMethodGroupsFlattenAndFilterRuns(t *testing.T) {
	cfg := &Config{Defaults: Defaults{PageSize: 10}, Groups: []GroupSpec{{
		ID: "runs:methods", Kind: "methods", IDField: "name",
		Format: "runnable", Menu: []string{"name", "description"},
	}}}
	api := &fakeAPI{
		models: []map[string]any{{
			"name": "gtd", "type": "@svendowideit/gtd",
			"methods": []any{
				map[string]any{
					"name": "capture", "description": "Capture a thought",
					"arguments": map[string]any{"properties": map[string]any{
						"raw":    map[string]any{"type": "string"},
						"source": map[string]any{"type": "string"},
					}},
				},
				map[string]any{"name": "engage", "description": "What can I do now"},
			},
		}},
		methodRuns: []swamp.ModelRunEntry{
			{OutputID: "out-1", ModelName: "gtd", MethodName: "capture", Status: "succeeded",
				StartedAt: "2026-11-21T10:00:00Z", DurationMS: 1200},
			{OutputID: "out-9", ModelName: "gtd", MethodName: "engage", Status: "failed",
				StartedAt: "2026-11-21T11:00:00Z"},
		},
	}
	m := newTestModel(t, cfg, api)
	g := m.groups[0]
	if err := m.loader.Load(context.Background(), g); err != nil {
		t.Fatal(err)
	}
	if len(g.Items) != 2 {
		t.Fatalf("expected one row per model.method, got %d", len(g.Items))
	}
	if g.Items[0].ID != "gtd.capture" || g.Items[0].Child != "runs:methods/gtd.capture" {
		t.Fatalf("unexpected method row: %+v", g.Items[0])
	}
	if len(g.Children) != 2 {
		t.Fatalf("expected a history group per row, got %d", len(g.Children))
	}

	child := g.Children[0]
	if err := m.loader.Load(context.Background(), child); err != nil {
		t.Fatal(err)
	}
	if len(child.Items) != 2 || child.Items[0].ID != "+" || !child.Items[0].Pinned {
		t.Fatalf("history should be '+ run' plus this method's runs: %+v", child.Items)
	}
	if got := scalar(child.Items[1].ID); got != "out-1" {
		t.Fatalf("history must be filtered to this model.method, got %q", got)
	}
	if child.Items[0].Raw["inputs"] == nil {
		t.Fatal("the '+ run' row must carry the method's argument schema")
	}
}

func TestMethodRunUsesTheMethodPayload(t *testing.T) {
	cfg := &Config{Defaults: Defaults{PageSize: 10}, Groups: []GroupSpec{{
		ID: "runs:methods", Kind: "methods", IDField: "name",
		Format: "runnable", Menu: []string{"name"},
	}}}
	api := &fakeAPI{models: []map[string]any{{
		"name": "gtd", "type": "@svendowideit/gtd",
		"methods": []any{map[string]any{
			"name": "capture",
			"arguments": map[string]any{"properties": map[string]any{
				"raw": map[string]any{"type": "string"},
			}},
		}},
	}}}
	events := make(chan swamp.Event, 4)
	errc := make(chan error, 1)
	errc <- nil
	runs := &fakeRuns{handle: &swamp.RunHandle{Events: events, Errc: errc}}

	m := newTestModel(t, cfg, api)
	m.SetRunAPI(runs)
	g := m.groups[0]
	if err := m.loader.Load(context.Background(), g); err != nil {
		t.Fatal(err)
	}
	m.enterGroup(g)
	m.handleKey(key("space")) // push gtd.capture history
	if m.cur == nil || m.cur.ID() != "runs:methods/gtd.capture" {
		t.Fatalf("space on a method row should open its history, cur=%v", m.cur)
	}
	if !m.cur.Loaded {
		if err := m.loader.Load(context.Background(), m.cur); err != nil {
			t.Fatal(err)
		}
	}
	m.handleKey(key("space")) // open the form
	if m.mode != modeForm {
		t.Fatalf("space on '+ run' should open the form, mode=%v", m.mode)
	}
	byName := map[string]*Field{}
	for _, f := range m.form.fields {
		byName[f.Name] = f
	}
	byName["raw"].Text = "buy milk"
	cmd := m.startRun(m.form.target, map[string]any{"raw": "buy milk"})
	if cmd == nil {
		t.Fatal("expected a run command")
	}
	if msg := cmd(); msg == nil {
		t.Fatal("run command produced no message")
	}
	if runs.reqType != "model.method.run" {
		t.Fatalf("method runs must use model.method.run, got %q", runs.reqType)
	}
	if runs.payload["modelIdOrName"] != "gtd" || runs.payload["methodName"] != "capture" {
		t.Fatalf("method payload must name the model and method: %v", runs.payload)
	}
	inputs, _ := runs.payload["inputs"].(map[string]any)
	if inputs["raw"] != "buy milk" {
		t.Fatalf("inputs not carried: %v", runs.payload)
	}
}

func TestMethodHistoryIsScopedAndBounded(t *testing.T) {
	// model.method.history.search ignores its query server-side and returns every
	// run ever (~97 MB), so history must come from model.output.search, scoped by
	// model and bounded by limit. See §19.3 of the plan.
	api := &fakeAPI{
		models: []map[string]any{{"name": "gtd", "methods": []any{
			map[string]any{"name": "capture", "arguments": map[string]any{}},
		}}},
	}
	g := &Group{Spec: GroupSpec{
		ID: "h", Kind: "methodhistory", Model: "gtd", Method: "capture", PageSize: 10,
	}}
	loader := &Loader{API: api}
	if err := loader.Load(context.Background(), g); err != nil {
		t.Fatal(err)
	}
	if api.lastModelQuery != "gtd" {
		t.Fatalf("history must be scoped to the model, got %q", api.lastModelQuery)
	}
	if api.lastModelLimit <= 0 || api.lastModelLimit > 500 {
		t.Fatalf("history must be bounded by a sane limit, got %d", api.lastModelLimit)
	}
}

func TestFooterSaysSpaceOpensOnADoorwayRow(t *testing.T) {
	m := &Model{width: 160, height: 20, mode: modeMenu, cur: &Group{Spec: GroupSpec{ID: "r"}}}
	m.cur.Items = []*Item{{ID: "wf@1.0.0", Cols: []string{"wf"}, Child: "r/wf"}}
	if bar := m.renderFooter(); !strings.Contains(bar, "open") {
		t.Fatalf("a runnable row should advertise that space opens it: %q", bar)
	}
	m.cur.Items = []*Item{{ID: "a", Cols: []string{"article"}}}
	if bar := m.renderFooter(); !strings.Contains(bar, "continue") || strings.Contains(bar, " open") {
		t.Fatalf("a plain row should advertise continue: %q", bar)
	}
}
