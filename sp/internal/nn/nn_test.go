package nn

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
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
	data      map[string]map[string]any // "model/resource" -> payload
	workflows []map[string]any
	models    []map[string]any
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
