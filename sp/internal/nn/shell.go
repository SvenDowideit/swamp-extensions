package nn

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"unicode/utf8"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
	"github.com/svendowideit/swamp-project/sp/internal/swamp"
)

// mode is the shell's current level. nn had exactly two (selection, reading);
// the overview is the third, and it is the "Y" screen promoted to a place.
type mode int

const (
	modeOverview mode = iota
	modeMenu
	modePager
	modeForm
	modeLive
)

// RunAPI is the streaming half of the serve client: starting and cancelling
// runs. swamp.Client satisfies it.
type RunAPI interface {
	StartRun(ctx context.Context, reqType string, payload any) (*swamp.RunHandle, error)
}

// runStartedMsg hands a live run handle to the shell.
type runStartedMsg struct{ handle *swamp.RunHandle }

// runEventMsg delivers one streamed event.
type runEventMsg struct{ ev swamp.Event }

// runDoneMsg signals the terminal frame of a run.
type runDoneMsg struct{ err error }

// groupsMsg delivers the top-level group set (from config) at startup.
type groupsMsg struct{ groups []*Group }

// groupLoadedMsg reports one group's load result.
type groupLoadedMsg struct {
	group *Group
	err   error
}

// Model is the nn shell.
type Model struct {
	cfg       *Config
	cfgSource string
	loader    *Loader
	store     *Store
	repo      string
	serveNote string

	groups []*Group
	byID   map[string]*Group
	stack  []string
	cur    *Group

	mode   mode
	cursor int
	page   int
	status string
	err    error

	filter    string
	filtering bool

	width, height int
	pager         *pagerState
	form          *formState
	live          *liveState
	preview       *previewState
	runAPI        RunAPI
	runHandle     *swamp.RunHandle
	quit          bool
	loading       map[string]bool
}

// New builds the shell. cfg supplies the groups; store supplies attributes.
func New(cfg *Config, cfgSource string, loader *Loader, store *Store, repo, serveNote string) *Model {
	m := &Model{
		cfg:       cfg,
		cfgSource: cfgSource,
		loader:    loader,
		store:     store,
		repo:      repo,
		serveNote: serveNote,
		byID:      map[string]*Group{},
		loading:   map[string]bool{},
	}
	for i := range cfg.Groups {
		applyDefaults(&cfg.Groups[i], cfg.Defaults)
	}
	for _, spec := range cfg.Groups {
		g := &Group{Spec: spec}
		m.groups = append(m.groups, g)
		m.byID[g.ID()] = g
	}
	if last := store.LastGroup(); last != "" {
		if g, ok := m.byID[last]; ok {
			m.cur = g
			m.mode = modeMenu
		}
	}
	return m
}

// SetRunAPI supplies the streaming client used by the run form.
func (m *Model) SetRunAPI(api RunAPI) { m.runAPI = api }

// SetSequence reorders the top-level group list (and drops ignored groups).
// Groups the sequence does not mention are kept.
func (m *Model) SetSequence(order, ignored []string) {
	if len(order) == 0 && len(ignored) == 0 {
		return
	}
	m.groups = ApplySequence(m.groups, order, ignored)
}

// SetStartGroup makes the shell open a group instead of the overview.
func (m *Model) SetStartGroup(id string) {
	if g, ok := m.byID[id]; ok {
		m.cur = g
		m.mode = modeMenu
		m.status = ""
	}
}

// Shutdown persists the position and any pending state. It is safe to call
// after the program has exited.
func (m *Model) Shutdown() {
	if m.cur != nil {
		m.store.SetPosition(m.cur.ID(), m.page, m.cursor)
	}
	_ = m.store.Save()
}

// Init loads every group in the background.
func (m *Model) Init() tea.Cmd {
	if m.cur != nil {
		m.page, m.cursor = m.store.Position(m.cur.ID())
		m.store.SetLastGroup(m.cur.ID())
		if m.page > 0 {
			m.status = "resumed " + m.cur.Title() + " at page " + itoa(m.page+1)
		}
	}
	cmds := make([]tea.Cmd, 0, len(m.groups))
	for _, g := range m.groups {
		cmds = append(cmds, m.loadCmd(g))
	}
	return tea.Batch(cmds...)
}

// loadCmd loads one group.
func (m *Model) loadCmd(g *Group) tea.Cmd {
	loader := m.loader
	m.loading[g.ID()] = true
	return func() tea.Msg {
		err := loader.Load(context.Background(), g)
		return groupLoadedMsg{group: g, err: err}
	}
}

// Update dispatches messages.
func (m *Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
		return m, nil

	case groupLoadedMsg:
		delete(m.loading, msg.group.ID())
		// Register any real sub-sources the loader discovered (runs).
		for _, child := range msg.group.Children {
			if _, ok := m.byID[child.ID()]; !ok {
				m.byID[child.ID()] = child
			}
		}
		m.recount()
		if msg.err != nil {
			m.status = "error: " + msg.err.Error()
		}
		return m, nil

	case runStartedMsg:
		m.runHandle = msg.handle
		if m.live == nil {
			m.live = newLive("")
		}
		return m, waitForRunEvent(msg.handle)

	case runEventMsg:
		if m.live != nil {
			m.live.appendEvent(msg.ev)
		}
		return m, waitForRunEvent(m.runHandle)

	case runDoneMsg:
		m.runHandle = nil
		if m.live != nil {
			m.live.finish(msg.err)
		}
		return m, nil

	case tea.KeyPressMsg:
		return m.handleKey(msg)
	}
	return m, nil
}

// waitForRunEvent reads exactly one event; the shell re-issues it after each.
func waitForRunEvent(h *swamp.RunHandle) tea.Cmd {
	if h == nil {
		return nil
	}
	return func() tea.Msg {
		ev, ok := <-h.Events
		if !ok {
			return runDoneMsg{err: <-h.Errc}
		}
		return runEventMsg{ev: ev}
	}
}

// recount recomputes unread/total per group.
func (m *Model) recount() {
	for _, g := range m.groups {
		g.Total = len(g.Items)
		n := 0
		for _, it := range g.Items {
			if m.store.EffectiveAttr(it) == AttrUnread {
				n++
			}
		}
		g.Unread = n
	}
	if m.cur != nil {
		m.cur.Total = len(m.cur.Items)
		n := 0
		for _, it := range m.cur.Items {
			if m.store.EffectiveAttr(it) == AttrUnread {
				n++
			}
		}
		m.cur.Unread = n
	}
}

// handleKey routes a key to the active mode.
func (m *Model) handleKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	key := msg.String()

	if m.filtering && m.mode == modeMenu {
		return m.handleFilterKey(key)
	}

	switch key {
	case "ctrl+c":
		m.quit = true
		return m, tea.Quit
	case "?":
		m.status = helpFor(m.mode)
		return m, nil
	case "ctrl+l":
		m.status = ""
		return m, nil
	}

	switch m.mode {
	case modeOverview:
		return m.handleOverviewKey(key)
	case modeMenu:
		return m.handleMenuKey(key)
	case modePager:
		return m.handlePagerKey(key)
	case modeForm:
		return m.handleFormKey(key)
	case modeLive:
		return m.handleLiveKey(key)
	}
	return m, nil
}

// handleOverviewKey drives the group list.
func (m *Model) handleOverviewKey(key string) (tea.Model, tea.Cmd) {
	switch key {
	case "q", "Q":
		m.quit = true
		return m, tea.Quit
	case "up", "k":
		m.cursor--
	case "down", "j":
		m.cursor++
	case "home", "g":
		m.cursor = 0
	case "end", "G":
		m.cursor = len(m.groups) - 1
	case "R":
		cmds := make([]tea.Cmd, 0, len(m.groups))
		for _, g := range m.groups {
			g.Loaded = false
			cmds = append(cmds, m.loadCmd(g))
		}
		return m, tea.Batch(cmds...)
	case "enter", "space":
		if m.cursor >= 0 && m.cursor < len(m.groups) {
			return m.enterGroup(m.groups[m.cursor])
		}
	}
	m.clampCursor(len(m.groups))
	return m, nil
}

// handleMenuKey drives selection mode.
func (m *Model) handleMenuKey(key string) (tea.Model, tea.Cmd) {
	visible := m.visibleItems()

	// A peek is frozen on the row it opened on. Scrolling keys move inside it;
	// any other key closes it and then means what it always means.
	if m.preview != nil {
		h := m.previewRows()
		switch key {
		case "%", "esc", "=", "space", "return":
			m.preview = nil
			if key == "=" {
				m.store.SetPosition(m.cur.ID(), m.page, m.cursor)
			}
			return m, nil
		case "down", "j":
			m.preview.scroll(1, h)
			return m, nil
		case "up", "k":
			m.preview.scroll(-1, h)
			return m, nil
		case "pgdown":
			m.preview.scroll(h, h)
			return m, nil
		case "pgup":
			m.preview.scroll(-h, h)
			return m, nil
		}
		m.preview = nil
	}

	switch key {
	case "q", "Q":
		m.leaveGroup()
		m.quit = true
		return m, tea.Quit
	case "Y":
		m.mode = modeOverview
		m.cursor = m.groupIndex(m.cur)
		return m, nil
	case "up", "k":
		m.cursor--
	case "down", "j":
		m.cursor++
	case "pgup":
		m.page--
		m.cursor = 0
	case "pgdown":
		m.page++
		m.cursor = 0
	case "N":
		return m.nextGroup(1)
	case "P":
		return m.nextGroup(-1)
	case "%":
		if it := m.cursorItem(); it != nil {
			m.preview = newPreview(it, m.bodyWidth())
		}
		return m, nil
	case "/":
		m.filtering = true
		m.filter = ""
		return m, nil
	case "R":
		if m.cur != nil {
			return m, m.loadCmd(m.cur)
		}
	case "=":
		m.popGroup()
		return m, nil
	case "space":
		return m.continueGroup()
	case "return":
		// continue-no-mark: same as space, but the page stays unread.
		return m.continueGroupNoMark()
	case ".":
		if m.cursor < len(visible) {
			m.toggleSelected(visible[m.cursor])
			m.cursor++
		}
		m.clampCursor(len(visible))
		return m, nil
	}

	if idx, ok := idIndex(key); ok {
		// nn's point-and-shoot: the id selects without moving the cursor
		// first, and the cursor then advances past it.
		if idx < len(visible) {
			m.cursor = idx
			m.toggleSelected(visible[idx])
			m.cursor++
			m.clampCursor(len(visible))
		}
		return m, nil
	}
	m.clampCursor(len(visible))
	return m, nil
}

// handlePagerKey drives reading mode.
func (m *Model) handlePagerKey(key string) (tea.Model, tea.Cmd) {
	p := m.pager
	if p == nil {
		m.mode = modeMenu
		return m, nil
	}
	bodyH := m.bodyHeight()
	switch key {
	case "Q":
		m.leaveGroup()
		m.quit = true
		return m, tea.Quit
	case "q":
		m.mode = modeMenu
		m.savePosition()
		return m, nil
	case "space":
		read, done := p.advance(m.bodyWidth(), bodyH)
		if len(read) > 0 {
			m.store.SetAttrs(read[0].Group, read, AttrRead)
		}
		if done {
			m.mode = modeMenu
			m.recount()
			m.savePosition()
		}
		return m, nil
	case "b":
		p.back()
	case "down", "j":
		p.scroll(1, m.bodyWidth(), bodyH)
	case "up", "k":
		p.scroll(-1, m.bodyWidth(), bodyH)
	case "pgdown":
		p.scroll(bodyH, m.bodyWidth(), bodyH)
	case "pgup":
		p.scroll(-bodyH, m.bodyWidth(), bodyH)
	case "=":
		m.mode = modeMenu
		m.savePosition()
	case "N":
		m.leaveGroup()
		return m.nextGroup(1)
	}
	return m, nil
}

// handleFilterKey collects a live menu filter.
func (m *Model) handleFilterKey(key string) (tea.Model, tea.Cmd) {
	switch key {
	case "esc":
		m.filtering = false
		m.filter = ""
		m.page, m.cursor = 0, 0
		return m, nil
	case "enter":
		m.filtering = false
		m.page, m.cursor = 0, 0
		return m, nil
	case "backspace":
		if m.filter != "" {
			_, size := utf8.DecodeLastRuneInString(m.filter)
			m.filter = m.filter[:len(m.filter)-size]
		}
		m.page, m.cursor = 0, 0
		return m, nil
	}
	if utf8.RuneCountInString(key) == 1 {
		m.filter += key
		m.page, m.cursor = 0, 0
	}
	return m, nil
}

// enterGroup pushes a group and shows its menu.
func (m *Model) enterGroup(g *Group) (tea.Model, tea.Cmd) {
	if g == nil {
		return m, nil
	}
	// Register the group's real sub-sources so a pushed Child id resolves even
	// when the group arrived without going through a load message.
	for _, child := range g.Children {
		if _, ok := m.byID[child.ID()]; !ok {
			m.byID[child.ID()] = child
		}
	}
	m.cur = g
	m.mode = modeMenu
	m.page, m.cursor = m.store.Position(g.ID())
	m.filter = ""
	m.store.SetLastGroup(g.ID())
	if len(m.stack) == 0 || m.stack[len(m.stack)-1] != g.ID() {
		m.stack = append(m.stack, g.ID())
	}
	m.recount()
	if !g.Loaded {
		return m, m.loadCmd(g)
	}
	return m, nil
}

// pushGroup enters a group reached from an item (a runnable's history).
func (m *Model) pushGroup(id string) (tea.Model, tea.Cmd) {
	g, ok := m.byID[id]
	if !ok {
		m.status = "no such group: " + id
		return m, nil
	}
	return m.enterGroup(g)
}

// popGroup returns to the parent group, or the overview.
func (m *Model) popGroup() {
	if len(m.stack) > 1 {
		m.stack = m.stack[:len(m.stack)-1]
		if g, ok := m.byID[m.stack[len(m.stack)-1]]; ok {
			m.enterGroup(g)
			return
		}
	}
	m.mode = modeOverview
	m.cursor = m.groupIndex(m.cur)
}

// leaveGroup advances the watermark for the pages that were paged through, and
// records the position so re-entry lands in the same place.
func (m *Model) leaveGroup() {
	if m.cur == nil {
		return
	}
	m.store.SetPosition(m.cur.ID(), m.page, m.cursor)
	m.advanceWatermark(m.cur)
}

// advanceWatermark moves the group's watermark to the newest item on the pages
// the person actually paged through.
func (m *Model) advanceWatermark(g *Group) {
	if g == nil {
		return
	}
	seen := make([]*Item, 0)
	for _, it := range g.Items {
		switch m.store.EffectiveAttr(it) {
		case AttrSeen, AttrRead, AttrSelected, AttrLeave:
			seen = append(seen, it)
		}
	}
	if len(seen) > 0 {
		m.store.AdvanceWatermark(g.ID(), seen)
	}
}

// continueGroup is `space`: mark this page seen, then read selections, else
// turn the page, else move on to the next group.
func (m *Model) continueGroup() (tea.Model, tea.Cmd) {
	visible := m.pageItems()
	m.store.MarkSeen(visible)
	selected := m.selectedItems()
	if len(selected) > 0 {
		m.openPager(selected)
		return m, nil
	}
	// A row that opens something (a runnable's history, a run form) is
	// activated rather than turned past: that is what the row is for.
	if it := m.cursorItem(); it != nil {
		if it.Child != "" {
			return m.pushGroup(it.Child)
		}
		if it.Format == "form" {
			return m.openForm(it)
		}
	}
	if m.page+1 < m.pageCount() {
		m.page++
		m.cursor = 0
		m.recount()
		return m, nil
	}
	m.leaveGroup()
	return m.nextGroup(1)
}

// continueGroupNoMark is `return`: turn the page without marking anything seen.
func (m *Model) continueGroupNoMark() (tea.Model, tea.Cmd) {
	selected := m.selectedItems()
	if len(selected) > 0 {
		m.openPager(selected)
		return m, nil
	}
	if m.page+1 < m.pageCount() {
		m.page++
		m.cursor = 0
		return m, nil
	}
	m.leaveGroup()
	return m.nextGroup(1)
}

// openPager reads the given items.
func (m *Model) openPager(items []*Item) {
	if len(items) == 0 {
		return
	}
	m.pager = newPager(items, 0)
	m.mode = modePager
}

// nextGroup moves delta groups through the top-level sequence, skipping the
// current group's children. It quits when the sequence is exhausted: finishing
// is the point.
func (m *Model) nextGroup(delta int) (tea.Model, tea.Cmd) {
	if len(m.groups) == 0 {
		m.quit = true
		return m, tea.Quit
	}
	idx := m.groupIndex(m.cur)
	if idx < 0 {
		idx = 0
	}
	next := idx + delta
	for next >= 0 && next < len(m.groups) {
		g := m.groups[next]
		m.page, m.cursor = 0, 0
		return m.enterGroup(g)
	}
	if delta > 0 {
		m.leaveGroup()
		m.quit = true
		return m, tea.Quit
	}
	return m.enterGroup(m.groups[0])
}

// groupIndex returns the top-level index of g, or -1.
func (m *Model) groupIndex(g *Group) int {
	for i, cand := range m.groups {
		if cand == g {
			return i
		}
	}
	return -1
}

// visibleItems applies the live filter to the current group.
func (m *Model) visibleItems() []*Item {
	if m.cur == nil {
		return nil
	}
	if m.filter == "" {
		return m.cur.Items
	}
	q := strings.ToLower(m.filter)
	out := make([]*Item, 0, len(m.cur.Items))
	for _, it := range m.cur.Items {
		hay := strings.ToLower(strings.Join(it.Cols, " ") + " " + it.ID)
		if strings.Contains(hay, q) {
			out = append(out, it)
		}
	}
	return out
}

// pageSize is the number of rows on a menu page.
func (m *Model) pageSize() int {
	n := m.height - 2
	if n < 3 {
		n = 3
	}
	if m.cur != nil && m.cur.Spec.PageSize > 0 && m.cur.Spec.PageSize < n {
		n = m.cur.Spec.PageSize
	}
	return n
}

// pageCount is the number of menu pages.
func (m *Model) pageCount() int {
	n := len(m.visibleItems())
	size := m.pageSize()
	if n == 0 {
		return 1
	}
	return (n + size - 1) / size
}

// previewRows is how many rows the peek pane gets: a third of the body, but
// never fewer than 4 and never more than half.
func (m *Model) previewRows() int {
	h := m.bodyHeight()
	n := h / 3
	if n < 4 {
		n = 4
	}
	if n > h/2 {
		n = h / 2
	}
	if n < 2 {
		n = 2
	}
	return n
}

// previewLines is how many lines the peek adds to the body (rule + title + rows).
func (m *Model) previewLines() []string {
	if m.preview == nil {
		return nil
	}
	return m.preview.render(m.bodyWidth(), m.previewRows())
}

// repeat returns s repeated n times.
func repeat(s string, n int) string {
	if n <= 0 {
		return ""
	}
	return strings.Repeat(s, n)
}

// pageStart is the index of the first item on the current page.
func (m *Model) pageStart() int { return m.page * m.pageSize() }

// pageItems is the slice of items on the current page.
func (m *Model) pageItems() []*Item {
	visible := m.visibleItems()
	start := m.pageStart()
	if start >= len(visible) {
		return nil
	}
	end := start + m.pageSize()
	if end > len(visible) {
		end = len(visible)
	}
	return visible[start:end]
}

// selectedItems returns selected items in group order.
func (m *Model) selectedItems() []*Item {
	if m.cur == nil {
		return nil
	}
	var out []*Item
	for _, it := range m.cur.Items {
		if m.store.EffectiveAttr(it) == AttrSelected {
			out = append(out, it)
		}
	}
	return out
}

// toggleSelected flips an item between selected and unread.
func (m *Model) toggleSelected(it *Item) {
	if it == nil {
		return
	}
	if m.store.EffectiveAttr(it) == AttrSelected {
		m.store.SetAttr(it.Group, it.ID, AttrUnread)
		return
	}
	m.store.SetAttr(it.Group, it.ID, AttrSelected)
}

// clampCursor keeps the cursor inside the visible rows.
func (m *Model) clampCursor(n int) {
	if m.cursor >= n {
		m.cursor = n - 1
	}
	if m.cursor < 0 {
		m.cursor = 0
	}
	if m.page >= m.pageCount() {
		m.page = m.pageCount() - 1
	}
	if m.page < 0 {
		m.page = 0
	}
}

// savePosition persists the menu position.
func (m *Model) savePosition() {
	if m.cur != nil {
		m.store.SetPosition(m.cur.ID(), m.page, m.cursor)
	}
}

// bodyWidth is the usable width for item bodies.
func (m *Model) bodyWidth() int {
	w := m.width - 2
	if w < 20 {
		w = 20
	}
	return w
}

// bodyHeight is the number of body rows an item UI may use.
func (m *Model) bodyHeight() int {
	h := m.height - 4
	if h < 3 {
		h = 3
	}
	return h
}

// View renders the shell.
func (m *Model) View() tea.View {
	var v tea.View
	v.AltScreen = true
	if m.width == 0 || m.height == 0 {
		v.SetContent("loading…")
		return v
	}
	v.SetContent(m.render())
	return v
}

// render draws the current mode.
func (m *Model) render() string {
	header := m.renderHeader()
	footer := m.renderFooter()

	var body []string
	switch m.mode {
	case modeOverview:
		body = m.renderOverview()
	case modeMenu:
		body = m.renderMenu()
	case modePager:
		body = m.renderPager()
	case modeForm:
		body = m.renderForm()
	case modeLive:
		body = m.renderLive()
	}

	h := m.height - 2
	if len(body) > h {
		body = body[:h]
	}
	for len(body) < h {
		body = append(body, "")
	}
	out := append([]string{header}, body...)
	out = append(out, footer)
	return strings.Join(out, "\n")
}

// renderHeader is the one-line title bar.
func (m *Model) renderHeader() string {
	left := styleHeaderKey.Render("nn") + " " + styleDim.Render(m.repo)
	var mid, right string
	switch m.mode {
	case modeOverview:
		mid = styleTitle.Render("overview")
		right = fmt.Sprintf("%d groups", len(m.groups))
	case modeForm:
		if m.form != nil {
			mid = styleTitle.Render("run " + m.form.workflow)
			right = m.form.editHint()
		}
	case modeLive:
		if m.live != nil {
			mid = styleTitle.Render("run " + m.live.workflow)
			right = m.live.status
		}
	case modeMenu, modePager:
		if m.cur != nil {
			title := m.cur.Title()
			if crumb := m.breadcrumb(); crumb != "" {
				title = crumb
			}
			mid = styleTitle.Render(title)
			unread := 0
			for _, it := range m.cur.Items {
				if m.store.EffectiveAttr(it) == AttrUnread {
					unread++
				}
			}
			right = fmt.Sprintf("%d unread, %d total · page %d/%d",
				unread, len(m.cur.Items), m.page+1, m.pageCount())
		}
	}
	gap := m.width - ansi.StringWidth(left) - ansi.StringWidth(mid) - ansi.StringWidth(right) - 2
	if gap < 1 {
		return fit(left+" "+mid, m.width)
	}
	return left + " " + mid + strings.Repeat(" ", gap) + styleDim.Render(right)
}

// breadcrumb is the pushed-group path, e.g. "runs:workflows › news-fetch".
func (m *Model) breadcrumb() string {
	if len(m.stack) <= 1 {
		return ""
	}
	parts := make([]string, 0, len(m.stack))
	for _, id := range m.stack {
		if g, ok := m.byID[id]; ok {
			parts = append(parts, g.Title())
		} else {
			parts = append(parts, id)
		}
	}
	return strings.Join(parts, " › ")
}

// renderOverview is the Y screen: every group, with why it is or is not useful.
func (m *Model) renderOverview() []string {
	out := make([]string, 0, len(m.groups))
	for i, g := range m.groups {
		cursor := " "
		if i == m.cursor {
			cursor = "▸"
		}
		var counts string
		switch {
		case m.loading[g.ID()]:
			counts = styleDim.Render("…")
		case g.Err != "":
			counts = styleErr.Render("err")
		case g.Total == 0:
			counts = styleDim.Render("0")
		default:
			new := m.store.NewCount(g)
			unread := g.Unread
			bits := []string{}
			if new > 0 {
				bits = append(bits, fmt.Sprintf("%d new", new))
			}
			if unread > 0 {
				bits = append(bits, fmt.Sprintf("%d unread", unread))
			}
			if len(bits) == 0 {
				bits = append(bits, fmt.Sprintf("%d", g.Total))
			}
			counts = styleGreenS.Render(strings.Join(bits, " / "))
		}
		title := padRight(g.Title(), 22)
		line := cursor + " " + title + " " + counts
		if g.Err != "" {
			line = cursor + " " + title + " " + styleErr.Render(fit(g.Err, m.width-26))
		}
		if i == m.cursor {
			line = styleCursor.Render(cursor) + " " + styleUnread.Render(title) + " " + counts
		}
		out = append(out, fit(line, m.width))
	}
	if len(out) == 0 {
		out = append(out, styleDim.Render("no groups (nn.groups.yaml declares none)"))
	}
	return out
}

// renderMenu draws one page of the selection menu.
func (m *Model) renderMenu() []string {
	if m.cur == nil {
		return []string{styleDim.Render("no group selected")}
	}
	items := m.pageItems()
	rows := m.pageSize()
	if m.preview != nil {
		rows -= m.previewRows() + 2
	}
	if rows < 1 {
		rows = 1
	}
	// Keep the cursor inside the window when the peek shrinks the menu.
	start := 0
	if m.cursor >= rows {
		start = m.cursor - rows + 1
	}
	if start > len(items) {
		start = len(items)
	}
	end := start + rows
	if end > len(items) {
		end = len(items)
	}

	out := make([]string, 0, rows+len(m.previewLines())+3)
	// A fixed two-cell gutter keeps rows aligned whether or not the cursor is
	// on them; nn highlighted the current row rather than marking it.
	const gutter = "  "
	lineWidth := m.width - len(gutter)
	for i := start; i < end; i++ {
		it := items[i]
		attr := m.store.EffectiveAttr(it)
		line := menuLine(idChar(i), attr, it.Badge, it.Cols, lineWidth)
		prefix := gutter
		if i == m.cursor {
			prefix = "▸ "
		}
		switch {
		case i == m.cursor || attr == AttrSelected:
			line = styleSelected.Render(fit(prefix+line, m.width))
		case attr == AttrUnread:
			line = styleUnread.Render(prefix + line)
		case attr == AttrRead || attr == AttrSeen:
			line = styleRead.Render(prefix + line)
		default:
			line = styleSeen.Render(prefix + line)
		}
		out = append(out, fit(line, m.width))
	}
	if end < len(items) && len(out) > 0 {
		out = append(out, styleDim.Render("  … "+itoa(len(items)-end)+" more on this page"))
	}
	// Reserve the rest of the page so the peek sits at the bottom.
	for len(out) < rows && len(items) > 0 {
		out = append(out, "")
	}
	if m.preview != nil {
		out = append(out, styleRule.Render(repeat("─", m.width)))
		out = append(out, m.preview.title(m.width))
		out = append(out, m.preview.render(m.bodyWidth(), m.previewRows())...)
	}
	if len(out) == 0 {
		if m.cur.Err != "" {
			out = append(out, styleErr.Render("error: "+m.cur.Err))
		} else if m.filter != "" {
			out = append(out, styleDim.Render("no items match "+m.filter))
		} else {
			out = append(out, styleDim.Render("no items"))
		}
	}
	if m.filtering {
		out = append(out, styleAccent.Render("/")+m.filter)
	}
	return out
}

// renderPager draws the reading view.
func (m *Model) renderPager() []string {
	if m.pager == nil {
		return []string{styleDim.Render("nothing to read")}
	}
	return m.pager.render(m.bodyWidth(), m.bodyHeight())
}

// hint is one key/description pair in the footer.
type hint struct{ key, desc string }

// footerHints is the contextual key bar, per mode. Keys are rendered in the
// brightest colour the palette has: the whole point of the bar is that you can
// find the key without reading the sentence.
func (m *Model) footerHints() []hint {
	switch m.mode {
	case modeOverview:
		return []hint{{"j/k", "move"}, {"space", "open group"}, {"R", "reload"}, {"Q", "quit"}}
	case modeMenu:
		if m.preview != nil {
			return []hint{{"%", "close"}, {"j/k", "scroll"}, {"space", "close"}, {"Q", "quit"}}
		}
		return []hint{
			{"a-z0-9", "select"}, {"%", "peek"}, {"space", "continue"},
			{"N/P", "group"}, {"/", "filter"}, {"=", "up"}, {"Y", "overview"}, {"Q", "quit"},
		}
	case modePager:
		return []hint{{"space", "page/next"}, {"b", "back"}, {"j/k", "scroll"}, {"=", "menu"}, {"N", "group"}, {"Q", "quit"}}
	case modeForm:
		if m.form != nil && len(m.form.fields) == 0 {
			return []hint{{"ctrl+s", "run"}, {"=", "cancel"}}
		}
		return []hint{
			{"tab", "field"}, {"space", "toggle"}, {"enter", "edit"},
			{"ctrl+r", "last run"}, {"ctrl+s", "run"}, {"=", "cancel"},
		}
	case modeLive:
		if m.live != nil && m.live.done {
			return []hint{{"space", "history"}, {"=", "menu"}, {"Q", "quit"}}
		}
		return []hint{{"q", "detach"}, {"x", "cancel"}, {"j/k", "scroll"}, {"=", "menu"}, {"Q", "quit"}}
	}
	return nil
}

// renderFooter draws the key bar, dropping hints that do not fit.
func (m *Model) renderFooter() string {
	if m.status != "" {
		return fit(styleDim.Render(m.status), m.width)
	}
	var b strings.Builder
	used := 0
	for i, h := range m.footerHints() {
		key := styleKeyHint.Render(h.key)
		desc := styleFooter.Render(h.desc)
		seg := key + " " + desc
		w := ansi.StringWidth(seg)
		sep := 0
		if i > 0 {
			sep = 3
		}
		if used+sep+w > m.width {
			break
		}
		if i > 0 {
			b.WriteString(styleRule.Render(" · "))
		}
		b.WriteString(seg)
		used += sep + w
	}
	return b.String()
}

// helpFor is the one-line help for a mode (the plan's `?` safety net).
func helpFor(md mode) string {
	switch md {
	case modeOverview:
		return "overview: j/k move, space/enter open a group, R reload all, Q quit"
	case modeMenu:
		return "menu: a-z/0-9 select, . toggle+advance, % peek at the row under the cursor, space continue (page, read, next group), return continue-no-mark, N/P group, / filter, Y overview, = up, Q quit"
	case modePager:
		return "read: space page then next item, b back, j/k scroll, = menu, N next group, Q quit"
	}
	return ""
}

// sortedGroupIDs is a small helper for deterministic rendering in tests.
func sortedGroupIDs(groups []*Group) []string {
	ids := make([]string, 0, len(groups))
	for _, g := range groups {
		ids = append(ids, g.ID())
	}
	sort.Strings(ids)
	return ids
}
