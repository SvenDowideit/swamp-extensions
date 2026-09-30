package ui

import (
	"context"
	"fmt"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/svendowideit/swamp-project/sp/internal/swamp"
)

// pgResultMsg delivers the outcome of a Playground query.
type pgResultMsg struct {
	result *swamp.QueryResult
	rows   []runOutput
	err    error
}

// pgResultLimit caps how many records the Playground will request and render.
const pgResultLimit = 500

// pgExample is one runnable example in the Playground help panel.
type pgExample struct {
	title string
	desc  string
	pred  string
	sel   string
}

// pgExamples are ready-to-run queries that double as the Playground tutorial.
// They are chosen to be meaningful in any swamp repo.
var pgExamples = []pgExample{
	{
		title: "Everything",
		desc:  "list every data artifact as a table",
		pred:  "size >= 0",
		sel:   "[modelName, name, string(version), dataType, string(size)]",
	},
	{
		title: "One model",
		desc:  "all data a model has produced",
		pred:  `modelName == "bom"`,
		sel:   "[name, string(version), dataType, string(size)]",
	},
	{
		title: "Files only",
		desc:  "rendered files such as HTML pages",
		pred:  `dataType == "file"`,
		sel:   "[modelName, name, contentType, string(size)]",
	},
	{
		title: "Reports",
		desc:  "report artifacts, by report name",
		pred:  `tags.type == "report"`,
		sel:   "[modelName, name, string(tags.reportName)]",
	},
	{
		title: "Large artifacts",
		desc:  "anything over 1 MiB",
		pred:  "size > 1048576",
		sel:   "[modelName, name, string(size)]",
	},
	{
		title: "JSON resources",
		desc:  "structured resources only",
		pred:  `contentType == "application/json"`,
		sel:   "[modelName, name, string(version), string(specName)]",
	},
	{
		title: "By workflow",
		desc:  "data tagged with a workflow name",
		pred:  `workflowName != ""`,
		sel:   "[workflowName, modelName, name, dataType]",
	},
	{
		title: "Name prefix",
		desc:  "CEL string methods (startsWith / contains)",
		pred:  `name.startsWith("report-")`,
		sel:   "[modelName, name]",
	},
}

// pgHelpLines builds the help panel: a syntax cheat-sheet followed by the
// runnable examples, with the selected example marked. It returns the lines and
// the line index where the selected example begins (so the view can scroll to
// keep it visible).
func (m *Model) pgHelpLines(width int) ([]string, int) {
	inner := width - 4
	if inner < 20 {
		inner = 20
	}
	var lines []string
	selLine := 0
	add := func(s string) { lines = append(lines, s) }

	add(stylePaneTitle.Render("Query the data catalog with CEL"))
	add(styleMuted.Render("The predicate is a CEL expression evaluated over every"))
	add(styleMuted.Render("data artifact. Leave select blank to get whole records"))
	add(styleMuted.Render("(each openable); add a projection to shape the output."))
	add("")
	add(stylePaneTitle.Render("Fields"))
	for _, ln := range []string{
		"modelName  name  version  dataType  contentType  size",
		"specName  lifetime  streaming  createdAt  ownerType",
		"tags.<key>        e.g. tags.type == \"report\"",
		"attributes.<key>  the artifact's JSON content",
		"workflowName  workflowRunId  jobName  stepName",
	} {
		add("  " + styleItem.Render(ln))
	}
	add("")
	add(stylePaneTitle.Render("Operators"))
	for _, ln := range []string{
		"== != > >= < <=        &&  ||  !",
		"name.contains(\"x\")  startsWith  endsWith  matches(\"re\")",
		"has(tags.env)          string(version)  string(size)",
	} {
		add("  " + styleItem.Render(ln))
	}
	add("")
	add(stylePaneTitle.Render("Select shapes"))
	for _, ln := range []string{
		"blank            whole records (open with v)",
		"[a, b, c]        table with positional columns",
		"{x: a, y: b}     table with named columns",
		"a                one value per row (scalars)",
	} {
		add("  " + styleItem.Render(ln))
	}
	add("")
	add(stylePaneTitle.Render("Examples — ↑↓ then enter to run"))
	for i, ex := range pgExamples {
		marker := "  "
		line := fmt.Sprintf("%-16s %s", ex.title, styleMuted.Render(ex.desc))
		if i == m.pgHelpSel {
			marker = styleKey.Render("▸ ")
			line = styleSelected.Render(fmt.Sprintf("%-16s %s", ex.title, ex.desc))
			selLine = len(lines)
		}
		add(marker + line)
		if i == m.pgHelpSel {
			add("      " + styleMuted.Render("pred  ") + styleKind.Render(truncStr(ex.pred, inner-8)))
			if ex.sel != "" {
				add("      " + styleMuted.Render("sel   ") + styleKind.Render(truncStr(ex.sel, inner-8)))
			}
		}
	}
	return lines, selLine
}

// helpViewportRows is the number of rows the help panel can show.
func (m *Model) helpViewportRows() int {
	ht := clamp(m.height*84/100, 12, m.height-3)
	return maxInt(1, ht-7)
}

// ensureHelpSelVisible scrolls the help panel so the selected example (and its
// two detail rows) are visible, without scrolling before the first example.
func (m *Model) ensureHelpSelVisible() {
	// selLine needs the rendered help lines; recompute to find its index.
	_, selLine := m.pgHelpLines(m.width)
	viewport := m.helpViewportRows()
	if selLine < m.pgHelpScroll {
		m.pgHelpScroll = selLine
	}
	if selLine+2 >= m.pgHelpScroll+viewport {
		m.pgHelpScroll = selLine + 3 - viewport
	}
	if m.pgHelpScroll < 0 {
		m.pgHelpScroll = 0
	}
}

// pgLoadExample copies the selected example into the query fields and runs it.
func (m *Model) pgLoadExample() tea.Cmd {
	if m.pgHelpSel < 0 || m.pgHelpSel >= len(pgExamples) {
		return nil
	}
	ex := pgExamples[m.pgHelpSel]
	m.pgPred = ex.pred
	m.pgSelect = ex.sel
	m.pgHelp = false
	return m.runPlayground()
}

// openPlayground opens the CEL query console. It starts on the help panel the
// first time (until the user dismisses it), and prefills the predicate from the
// selected model so the first query is immediately meaningful.
func (m *Model) openPlayground() tea.Cmd {
	m.pgOpen = true
	m.pgField = 0
	m.pgEditing = false
	m.pgErr = nil
	m.pgHistIdx = -1
	// Show the teaching panel unless the user has dismissed it before, or a
	// query has already been run this session.
	if !m.pgHelpOff && m.pgResult == nil {
		m.pgHelp = true
		m.pgHelpScroll = 0
	}
	if m.pgPred == "" && m.pgSelect == "" {
		if m.focus == PaneModels {
			if models := m.visibleModels(); len(models) > 0 {
				name := models[clamp(m.modelSel, 0, len(models)-1)].label
				m.pgPred = fmt.Sprintf("modelName == %q", name)
			}
		}
	}
	return nil
}

// runPlayground evaluates the current predicate/select over the catalog.
func (m *Model) runPlayground() tea.Cmd {
	pred := strings.TrimSpace(m.pgPred)
	if pred == "" {
		m.pgErr = fmt.Errorf("enter a predicate, e.g. size >= 0")
		return nil
	}
	sel := strings.TrimSpace(m.pgSelect)
	m.pgLoading = true
	m.pgErr = nil
	m.pgRowSel = 0
	m.pgScroll = 0
	m.pgHelp = false
	m.rememberQuery(pred, sel)

	client := m.client
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
		defer cancel()
		res, err := client.QueryData(ctx, pred, sel, pgResultLimit)
		if err != nil {
			return pgResultMsg{err: err}
		}
		return pgResultMsg{result: res, rows: pgRowsFromResult(res)}
	}
}

// rememberQuery records a query in the history, de-duplicating consecutive and
// existing identical entries.
func (m *Model) rememberQuery(pred, sel string) {
	for i, q := range m.pgHistory {
		if q.pred == pred && q.selectExpr == sel {
			m.pgHistory = append(m.pgHistory[:i], m.pgHistory[i+1:]...)
			break
		}
	}
	m.pgHistory = append(m.pgHistory, pgQuery{pred: pred, selectExpr: sel})
	const maxHist = 30
	if len(m.pgHistory) > maxHist {
		m.pgHistory = m.pgHistory[len(m.pgHistory)-maxHist:]
	}
	m.pgHistIdx = len(m.pgHistory) - 1
}

// pgRowsFromResult turns record rows into selectable data refs so each result
// can be opened in the artifact viewer.
func pgRowsFromResult(res *swamp.QueryResult) []runOutput {
	if res == nil {
		return nil
	}
	var out []runOutput
	for _, r := range res.Records {
		ref := runOutput{
			name:        str(r["name"]),
			modelName:   str(r["modelName"]),
			version:     int(numVal(r["version"])),
			contentType: str(r["contentType"]),
			kind:        str(r["dataType"]),
		}
		if tags, ok := r["tags"].(map[string]any); ok {
			ref.reportName = str(tags["reportName"])
		}
		out = append(out, ref)
	}
	return out
}

// numVal coerces a JSON number to float64.
func numVal(v any) float64 {
	f, _ := v.(float64)
	return f
}

// handlePlaygroundKey processes keys while the Playground is open.
func (m *Model) handlePlaygroundKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	key := msg.String()

	if m.pgEditing {
		switch key {
		case "esc":
			m.pgEditing = false
		case "enter":
			m.pgEditing = false
			return m, m.runPlayground()
		case "backspace":
			m.pgEditValue(func(s string) string {
				if s == "" {
					return s
				}
				return s[:len(s)-1]
			})
		default:
			if len(msg.Text) > 0 {
				m.pgEditValue(func(s string) string { return s + msg.Text })
			}
		}
		return m, nil
	}

	// Help panel: navigate and run examples, or dismiss it.
	if m.pgHelp {
		switch key {
		case "esc", "?", "h":
			m.pgHelp = false
			m.pgHelpOff = true
		case "q":
			m.pgOpen = false
		case "up", "k":
			m.pgHelpSel = clamp(m.pgHelpSel-1, 0, len(pgExamples)-1)
			m.ensureHelpSelVisible()
		case "down", "j":
			m.pgHelpSel = clamp(m.pgHelpSel+1, 0, len(pgExamples)-1)
			m.ensureHelpSelVisible()
		case "g":
			m.pgHelpSel = 0
			m.ensureHelpSelVisible()
		case "G":
			m.pgHelpSel = len(pgExamples) - 1
			m.ensureHelpSelVisible()
		case "pgup":
			m.pgHelpScroll = maxInt(0, m.pgHelpScroll-10)
		case "pgdown":
			m.pgHelpScroll += 10
		case "enter":
			return m, m.pgLoadExample()
		}
		return m, nil
	}

	switch key {
	case "esc", "q":
		m.pgOpen = false
	case "?":
		m.pgHelp = true
		m.pgHelpScroll = 0
		m.ensureHelpSelVisible()
	case "tab":
		m.pgField = (m.pgField + 1) % 2
	case "enter":
		// On a selectable result row, open it; otherwise run the query.
		if len(m.pgRows) > 0 && m.pgRowSel >= 0 {
			return m, m.openPlaygroundRow()
		}
		return m, m.runPlayground()
	case "ctrl+r", "r":
		return m, m.runPlayground()
	case "e", "i":
		m.pgEditing = true
	case "up", "k":
		m.pgMove(-1)
	case "down", "j":
		m.pgMove(1)
	case "pgup":
		m.pgScroll = clamp(m.pgScroll-10, 0, maxInt(0, m.pgResultLen()-1))
	case "pgdown":
		m.pgScroll = clamp(m.pgScroll+10, 0, maxInt(0, m.pgResultLen()-1))
	case "g":
		m.pgRowSel = 0
		m.pgScroll = 0
	case "G":
		if len(m.pgRows) > 0 {
			m.pgRowSel = len(m.pgRows) - 1
		}
	case "[":
		m.pgBrowseHistory(-1)
	case "]":
		m.pgBrowseHistory(1)
	case "v":
		return m, m.openPlaygroundRow()
	case "y":
		// Seed the select field with a useful default projection.
		if m.pgSelect == "" {
			m.pgSelect = "[modelName, name, string(version), string(size)]"
		}
	}
	return m, nil
}

// pgEditValue applies f to the currently focused field's value.
func (m *Model) pgEditValue(f func(string) string) {
	if m.pgField == 0 {
		m.pgPred = f(m.pgPred)
	} else {
		m.pgSelect = f(m.pgSelect)
	}
}

// pgMove moves the result-row selection, or scrolls when there are no rows.
func (m *Model) pgMove(delta int) {
	if len(m.pgRows) == 0 {
		m.pgScroll = clamp(m.pgScroll+delta, 0, maxInt(0, m.pgResultLen()-1))
		return
	}
	m.pgRowSel = clamp(m.pgRowSel+delta, 0, len(m.pgRows)-1)
}

// pgResultLen is the number of rendered result lines (best-effort scroll bound).
func (m *Model) pgResultLen() int {
	if m.pgResult == nil {
		return 0
	}
	if m.pgResult.Projected != nil {
		if len(m.pgResult.Projected.Rows) > 0 {
			return len(m.pgResult.Projected.Rows)
		}
		return len(m.pgResult.Projected.Values)
	}
	return len(m.pgResult.Records)
}

// pgBrowseHistory steps through the query history, loading each entry.
func (m *Model) pgBrowseHistory(dir int) {
	if len(m.pgHistory) == 0 {
		return
	}
	if m.pgHistIdx < 0 {
		m.pgHistIdx = len(m.pgHistory) - 1
	}
	m.pgHistIdx = clamp(m.pgHistIdx+dir, 0, len(m.pgHistory)-1)
	q := m.pgHistory[m.pgHistIdx]
	m.pgPred = q.pred
	m.pgSelect = q.selectExpr
}

// openPlaygroundRow opens the selected record result in the viewer.
func (m *Model) openPlaygroundRow() tea.Cmd {
	if len(m.pgRows) == 0 {
		return nil
	}
	return m.openDataRef(m.pgRows[clamp(m.pgRowSel, 0, len(m.pgRows)-1)])
}

// renderPlaygroundResults renders the query outcome, shaped as records, a
// positional list, a named map, or scalars. Content is scrolled by pgScroll.
func (m *Model) renderPlaygroundResults(width, height int) string {
	if m.pgErr != nil {
		return clip(strings.Join(m.pgErrorLines(), "\n"), width, height)
	}
	if m.pgLoading && m.pgResult == nil {
		return styleMuted.Render("querying…")
	}
	res := m.pgResult
	if res == nil {
		return styleMuted.Render("enter a predicate and press enter to query")
	}

	var lines []string
	switch {
	case res.Projected != nil && res.Projected.Shape == "scalar":
		for i, v := range res.Projected.Values {
			lines = append(lines, fmt.Sprintf("  %s %s", styleMuted.Render(fmt.Sprintf("%d", i+1)), formatScalar(v)))
		}
		if len(res.Projected.Values) == 0 {
			lines = append(lines, styleMuted.Render("  (no rows)"))
		}
	case res.Projected != nil && res.Projected.Shape == "map":
		cols := res.Projected.Columns
		rows := make([][]string, 0, len(res.Projected.Rows))
		for _, r := range res.Projected.Rows {
			rm, _ := r.(map[string]any)
			row := make([]string, len(cols))
			for i, c := range cols {
				row[i] = formatScalar(rm[c])
			}
			rows = append(rows, row)
		}
		lines = tableLines(cols, rows, width,
			func(s string) string { return stylePaneTitle.Render(s) },
			func(s string) string { return styleItem.Render(s) })
	case res.Projected != nil && res.Projected.Shape == "list":
		var rows [][]string
		cols := len(res.Projected.Columns)
		for _, r := range res.Projected.Rows {
			list, _ := r.([]any)
			row := make([]string, len(list))
			for i, v := range list {
				row[i] = formatScalar(v)
			}
			rows = append(rows, row)
		}
		header := res.Projected.Columns
		if cols == 0 {
			header = nil
		}
		lines = tableLines(header, rows, width,
			func(s string) string { return stylePaneTitle.Render(s) },
			func(s string) string { return styleItem.Render(s) })
	case len(res.Records) > 0:
		lines = m.playgroundRecordLines(res, width)
	default:
		lines = append(lines, styleMuted.Render("  (no results)"))
	}

	// Apply scroll. For record results, window so the selected row is visible.
	top := m.pgScroll
	if len(m.pgRows) > 0 {
		top = windowTop(len(lines), m.pgRowSel, height)
	}
	top = clamp(top, 0, len(lines))
	visible := lines[top:]
	return clip(strings.Join(visible, "\n"), width, height)
}

// windowTop returns the first visible line so that sel is in view for a
// viewport of the given height, scrolling the minimum amount.
func windowTop(total, sel, height int) int {
	if height < 1 {
		height = 1
	}
	if total <= height {
		return 0
	}
	top := 0
	if sel >= height {
		top = sel - height + 1
	}
	if top > total-height {
		top = total - height
	}
	if top < 0 {
		top = 0
	}
	return top
}

// playgroundRecordLines renders raw DataRecords as one selectable row each: the
// selected row is highlighted and shows model/name/version/type/size.
func (m *Model) playgroundRecordLines(res *swamp.QueryResult, width int) []string {
	lines := make([]string, 0, len(res.Records))
	for i, r := range res.Records {
		plain := fmt.Sprintf("  %-26s %-30s v%-4s %-9s %s",
			truncStr(str(r["modelName"]), 26),
			truncStr(str(r["name"]), 30),
			str(r["version"]),
			truncStr(str(r["dataType"]), 9),
			humanSize(r["size"]),
		)
		if i == m.pgRowSel {
			lines = append(lines, styleSelected.Render(truncateANSI(plain, width)))
		} else {
			lines = append(lines, styleItem.Render(truncateANSI(plain, width)))
		}
	}
	return lines
}

// pgErrorLines formats a CEL/query error, including the server's caret snippet.
func (m *Model) pgErrorLines() []string {
	lines := []string{styleError.Render("✗ query failed")}
	for _, ln := range strings.Split(m.pgErr.Error(), "\n") {
		lines = append(lines, styleMuted.Render("  "+ln))
	}
	return lines
}

// formatScalar renders one CEL scalar value compactly.
func formatScalar(v any) string {
	switch t := v.(type) {
	case nil:
		return styleMuted.Render("null")
	case string:
		return t
	case bool:
		return fmt.Sprintf("%v", t)
	case float64:
		if t == float64(int64(t)) {
			return fmt.Sprintf("%d", int64(t))
		}
		return fmt.Sprintf("%g", t)
	default:
		return str(t)
	}
}

// truncStr shortens a display string to n runes with an ellipsis.
func truncStr(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	if n <= 1 {
		return string(r[:n])
	}
	return string(r[:n-1]) + "…"
}
