package ui

import (
	"fmt"
	"strings"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"
)

func (m *Model) View() tea.View {
	var v tea.View
	v.AltScreen = true
	v.SetContent(m.render())
	return v
}

func (m *Model) render() string {
	if m.width == 0 || m.height == 0 {
		return "loading…"
	}

	header := m.renderHeader()
	footer := m.renderFooter()

	// Keep the total rendered height one row short of the terminal. Emitting
	// exactly m.height lines makes the terminal scroll by one, pushing the
	// status bar off the bottom.
	bodyH := m.height - 1 - lipgloss.Height(header) - lipgloss.Height(footer)
	if bodyH < 4 {
		bodyH = 4
	}
	// Column widths. Narrow terminals drop the Workflows pane first, then
	// Data, so the Detail pane always has room.
	wfW := clamp(m.width*22/100, 18, 34)
	modelsW := clamp(m.width*24/100, 18, 38)
	dataW := clamp(m.width*22/100, 18, 38)
	showWf := m.width >= 110
	showData := m.width >= 84
	if !showWf {
		wfW = 0
	}
	if !showData {
		dataW = 0
	}
	detailW := m.width - wfW - modelsW - dataW - 4
	if detailW < 20 {
		detailW = 20
	}

	panes := []string{m.renderModels(modelsW, bodyH), m.renderDetail(detailW, bodyH)}
	if showWf {
		panes = append([]string{m.renderWorkflows(wfW, bodyH)}, panes...)
	}
	if showData {
		panes = append(panes, m.renderData(dataW, bodyH))
	}
	body := lipgloss.JoinHorizontal(lipgloss.Top, panes...)
	all := lipgloss.JoinVertical(lipgloss.Left, header, body, footer)

	switch {
	case m.quitConfirm:
		return overlayAt(all, m.renderQuitConfirm(), m.width)
	case m.inputOpen:
		return m.renderInputForm()
	case m.viewOpen:
		return overlayAt(all, m.renderViewer(), m.width)
	case m.runOpen:
		return overlayAt(all, m.renderRunDialog(), m.width)
	case m.pgOpen:
		return overlayAt(all, m.renderPlayground(), m.width)
	case m.spotterOpen:
		return m.renderSpotter()
	}
	return all
}

// renderPlayground draws the CEL query console as an overlay: an editable
// predicate and select, and a shape-aware result view.
func (m *Model) renderPlayground() string {
	w := clamp(m.width-6, 50, m.width)
	ht := clamp(m.height*84/100, 12, m.height-3)
	innerW := w - 4
	innerH := ht - 4
	if innerW < 20 {
		innerW = 20
	}
	if innerH < 3 {
		innerH = 3
	}

	var b strings.Builder
	// Predicate field.
	b.WriteString(m.pgFieldLine("predicate", m.pgPred, 0, innerW))
	b.WriteString("\n")
	// Select field.
	b.WriteString(m.pgFieldLine("select", m.pgSelect, 1, innerW))
	b.WriteString("\n")
	b.WriteString(styleMuted.Render(strings.Repeat("─", innerW)))
	b.WriteString("\n")

	// The dialog's content (inside the border) is ht-2 rows: a 1-row header, the
	// field block (2 fields + separator = 3 rows), the results, and a 1-row
	// footer. So the results get ht-7 rows.
	resH := ht - 7
	if resH < 1 {
		resH = 1
	}
	// The help panel replaces the results with a cheat-sheet and examples.
	var body string
	if m.pgHelp {
		hlines, _ := m.pgHelpLines(innerW)
		top := clamp(m.pgHelpScroll, 0, maxInt(0, len(hlines)-1))
		body = clip(strings.Join(hlines[top:], "\n"), innerW, resH)
	} else {
		body = m.renderPlaygroundResults(innerW, resH)
	}
	// Pad the body to resH rows so the footer sits at the dialog's bottom.
	if n := resH - strings.Count(body, "\n") - 1; n > 0 {
		body += strings.Repeat("\n", n)
	}
	b.WriteString(body)

	chip := ""
	if m.pgHelp {
		chip = styleMuted.Render("help")
	} else if m.pgLoading {
		chip = styleOrange.Render("◐ querying…")
	} else if m.pgErr != nil {
		chip = styleError.Render("✗ error")
	} else if m.pgResult != nil {
		chip = styleMuted.Render(fmt.Sprintf("%d rows", m.pgResult.Total))
		if m.pgResult.Limited {
			chip += styleMuted.Render(" (limited)")
		}
	}
	head := stylePaneTitle.Render("Playground") + "  " + styleKind.Render("data.query")
	gap := innerW - lipgloss.Width(head) - lipgloss.Width(chip)
	if gap < 1 {
		gap = 1
	}
	headerLine := head + strings.Repeat(" ", gap) + chip

	footer := renderHints(m.playgroundHints(), innerW)
	joined := headerLine + "\n" + b.String() + "\n" + styleMuted.Render(footer)
	return stylePaneFocus.Width(w).Height(ht).Render(joined)
}

// playgroundHints is the context key bar for the Playground.
func (m *Model) playgroundHints() []hint {
	if m.pgHelp {
		return []hint{
			h("↑↓", "example"),
			h("enter", "run example"),
			h("?", "hide help"),
			h("esc", "close"),
		}
	}
	if m.pgEditing {
		return []hint{
			h("type", "edit "+pgFieldName(m.pgField)),
			h("enter", "run"),
			h("esc", "done"),
		}
	}
	hs := []hint{
		h("e", "edit"),
		h("tab", "field"),
		h("enter", "run"),
	}
	if len(m.pgRows) > 0 {
		hs = append(hs, h("↑↓", "row"), h("v", "view row"))
	}
	if len(m.pgHistory) > 0 {
		hs = append(hs, h("[ ]", "history"))
	}
	hs = append(hs, h("?", "help"), h("esc", "close"))
	return hs
}

func pgFieldName(i int) string {
	if i == 0 {
		return "predicate"
	}
	return "select"
}

// pgFieldLine renders one labeled, optionally-focused query field.
func (m *Model) pgFieldLine(label, value string, field, width int) string {
	focused := m.pgField == field
	labelSt := styleMuted
	if focused {
		labelSt = styleKey
	}
	prefix := "  "
	if focused && m.pgEditing {
		prefix = styleKey.Render("✎ ")
	} else if focused {
		prefix = styleKey.Render("▸ ")
	}
	text := value
	if focused && m.pgEditing {
		text += "▏"
	}
	line := prefix + labelSt.Render(padRight(label, 9)) + " " + text
	return truncateANSI(line, width)
}

// renderViewer draws the artifact viewer as a large overlay over the browser.
func (m *Model) renderViewer() string {
	w := clamp(m.width-4, 40, m.width)
	ht := clamp(m.height*80/100, 10, m.height-4)
	innerW := w - 4
	innerH := ht - 4
	if innerW < 8 {
		innerW = 8
	}
	if innerH < 1 {
		innerH = 1
	}

	kindTag := styleKind.Render("[" + m.viewKind + "]")
	head := stylePaneTitle.Render(m.viewTitle) + "  " + kindTag
	if m.viewLoading {
		head += styleMuted.Render("  loading…")
	}

	// Scroll window over the rendered content.
	maxScroll := maxInt(0, len(m.viewLines)-innerH)
	top := clamp(m.viewScroll, 0, maxScroll)
	end := top + innerH
	if end > len(m.viewLines) {
		end = len(m.viewLines)
	}
	textW := innerW
	bar := len(m.viewLines) > innerH
	if bar {
		textW = innerW - 1
	}
	body := clip(strings.Join(m.viewLines[top:end], "\n"), textW, innerH)
	if bar {
		body = stampScrollbar(body, paneScroll{total: len(m.viewLines), visible: innerH, top: top}, innerW, innerH)
	}

	hints := []hint{h("↑↓", "scroll"), h("g/G", "top/end"), h("esc", "close")}
	footer := renderHints(hints, innerW)
	joined := head + "\n" + body + "\n" + styleMuted.Render(footer)
	return stylePaneFocus.Width(w).Height(ht).Render(joined)
}

// renderQuitConfirm draws the "a run is still active" prompt.
func (m *Model) renderQuitConfirm() string {
	w := clamp(m.width*60/100, 44, 88)
	var b strings.Builder
	b.WriteString(styleError.Render("A run is still in progress") + "\n\n")
	b.WriteString(fmt.Sprintf("%s  %s\n\n",
		runStatusChip(m.runStatus),
		styleMuted.Render(m.runTitle+" "+shortID(m.runID))))
	b.WriteString(styleMuted.Render(
		"The run is owned by swamp serve, not by this browser.\n"+
			"Detaching leaves it running; cancelling stops it.") + "\n")
	b.WriteString("\n")
	b.WriteString(renderHints([]hint{
		h("d", "detach & quit (run continues)"),
		h("x", "cancel run & quit"),
		h("esc", "stay"),
	}, w-4))
	return stylePaneFocus.Width(w).Render(stylePaneTitle.Render("Quit?") + "\n" + b.String())
}

// overlayAt composites fg over base, centred horizontally and placed so its
// bottom sits just above the base's last line (the context key bar, which stays
// visible). base is expected to be m.height-1 lines tall.
func overlayAt(base, fg string, totalW int) string {
	b := strings.Split(base, "\n")
	f := strings.Split(fg, "\n")
	fw := 0
	for _, l := range f {
		if w := ansi.StringWidth(l); w > fw {
			fw = w
		}
	}
	x := (totalW - fw) / 2
	if x < 0 {
		x = 0
	}
	// One blank row above the footer.
	y := len(b) - 1 - len(f)
	if y < 0 {
		y = 0
	}
	for i, fl := range f {
		yy := y + i
		if yy < 0 || yy >= len(b) {
			continue
		}
		bl := b[yy]
		bw := ansi.StringWidth(bl)
		if bw < totalW {
			bl += strings.Repeat(" ", totalW-bw)
			bw = totalW
		}
		left := ansi.Cut(bl, 0, x)
		right := ""
		if x+fw < bw {
			right = ansi.Cut(bl, x+fw, bw)
		}
		b[yy] = left + fl + right
	}
	return strings.Join(b, "\n")
}

// renderSpotter draws the global search box centred on the screen.
func (m *Model) renderSpotter() string {
	w := clamp(m.width*70/100, 40, 100)
	results := m.visibleSpotter()
	const maxRows = 14
	if len(results) > maxRows {
		results = results[:maxRows]
	}

	var b strings.Builder
	// query line
	cursor := ""
	if m.spotterLoaded {
		cursor = "▏"
	}
	b.WriteString(styleKey.Render("search ") + m.spotterQuery + cursor + "\n")
	if !m.spotterLoaded {
		b.WriteString(styleMuted.Render("building index (models, workflows, data)…") + "\n")
	} else if len(results) == 0 {
		b.WriteString(styleMuted.Render("no matches") + "\n")
	}
	for i, it := range results {
		plainKind := padRight(it.kind, 8)
		if i == m.spotterSel {
			text := " " + plainKind + " " + it.label
			if it.sub != "" {
				text += "  " + it.sub
			}
			b.WriteString(styleSelected.Render(text) + "\n")
			continue
		}
		line := styleKind.Render(plainKind) + " " + it.label
		if it.sub != "" {
			line += styleMuted.Render("  " + it.sub)
		}
		b.WriteString(line + "\n")
	}

	box := stylePaneFocus.Width(w).Render(
		stylePaneTitle.Render("Spotter") + "\n" + b.String())
	box = box + "\n" + renderHints([]hint{
		h("type", "search"),
		h("↑↓", "move"),
		h("enter", "jump"),
		h("esc", "close"),
	}, w)

	// Centre over the background.
	return lipgloss.Place(m.width, placeHeight(m.height), lipgloss.Center, lipgloss.Center, box)
}

// renderRunDialog draws the live run console as a compact dialog sized to a
// fraction of the screen, leaving the browser and the context key bar visible.
func (m *Model) renderRunDialog() string {
	// Dialog footprint: ~86% wide, ~70% tall, clamped so the bottom sits above
	// the footer.
	w := clamp(m.width*86/100, 44, m.width-2)
	h := clamp(m.height*70/100, 8, m.height-6)
	if h > m.height-2 {
		h = m.height - 2
	}
	if w > m.width {
		w = m.width
	}
	// Layout: h is the dialog's total height (border included). Inside the
	// border we have a 1-row title, the event body, and a 1-row hint line, so
	// the body gets h-4 rows. w includes 2 border + 2 padding columns, and we
	// reserve the last column for a scrollbar.
	innerW := w - 4
	innerH := h - 4
	if innerH < 1 {
		innerH = 1
	}
	textW := innerW
	bar := innerH > 0 && len(m.runLines) > innerH
	if bar {
		textW = innerW - 1
	}

	title := "Run — " + m.runTitle
	if m.runID != "" {
		title += "  " + styleMuted.Render(shortID(m.runID))
	}
	chip := runStatusChip(m.runStatus)
	head := stylePaneTitle.Render(title)
	gap := innerW - lipgloss.Width(head) - lipgloss.Width(chip)
	if gap < 1 {
		gap = 1
	}
	headerLine := head + strings.Repeat(" ", gap) + chip

	// Scroll window over the event lines.
	top := m.runTop(innerH)
	end := top + innerH
	if end > len(m.runLines) {
		end = len(m.runLines)
	}
	body := clip(strings.Join(m.runLines[top:end], "\n"), textW, innerH)
	if bar {
		body = stampScrollbar(body, paneScroll{
			total: len(m.runLines), visible: innerH, top: top,
		}, innerW, innerH)
	}

	footer := renderHints(m.runConsoleHints(), innerW)
	joined := headerLine + "\n" + body + "\n" + styleMuted.Render(footer)
	// Height is inner content (title+body+footer) + 2 border rows.
	return stylePaneFocus.Width(w).Height(h).Render(joined)
}

// runTop resolves the run console's scroll offset to a concrete top row.
func (m *Model) runTop(innerH int) int {
	maxScroll := len(m.runLines) - innerH
	if maxScroll < 0 {
		maxScroll = 0
	}
	if m.runScroll >= 1<<29 {
		return maxScroll // pinned to bottom
	}
	return clamp(m.runScroll, 0, maxScroll)
}

// runStatusChip renders the coloured status indicator for the run dialog.
func runStatusChip(status string) string {
	switch status {
	case "running":
		return styleGreen.Render("● running")
	case "starting…", "resuming…", "cancelling…":
		return styleOrange.Render("◐ " + status)
	case "succeeded":
		return styleGreen.Render("■ succeeded")
	case "failed", "error":
		return styleError.Render("■ " + status)
	default:
		return styleMuted.Render(status)
	}
}

// renderInputForm draws the workflow run input form centred on screen.
func (m *Model) renderInputForm() string {
	w := clamp(m.width*60/100, 40, 90)
	var b strings.Builder
	b.WriteString(stylePaneTitle.Render("Run "+m.runTitle) + "\n\n")
	for i, f := range m.inputFields {
		label := padRight(f.key, 20)
		val := f.value
		if i == m.inputSel {
			marker := "  "
			if m.inputEditing {
				marker = styleKey.Render("✎ ")
				val = val + "▏"
			} else {
				marker = styleKey.Render("▸ ")
			}
			b.WriteString(marker + styleKey.Render(label) + " " + val + "\n")
		} else {
			b.WriteString("  " + styleMuted.Render(label) + " " + styleMuted.Render(val) + "\n")
		}
		if f.typ != "" {
			b.WriteString("    " + styleMuted.Render(f.typ) + "\n")
		}
	}
	box := stylePaneFocus.Width(w).Render(b.String())
	box += "\n" + renderHints([]hint{
		h("↑↓", "field"),
		h("type", "edit"),
		h("enter", "run"),
		h("esc", "cancel"),
	}, w)
	return lipgloss.Place(m.width, placeHeight(m.height), lipgloss.Center, lipgloss.Center, box)
}

// shortID abbreviates a UUID for display.
func shortID(id string) string {
	if len(id) > 8 {
		return id[:8]
	}
	return id
}

func padRight(s string, n int) string {
	if len(s) >= n {
		return s
	}
	return s + strings.Repeat(" ", n-len(s))
}

func (m *Model) renderHeader() string {
	title := styleTitle.Render("swamp browser")
	repo := styleSubtitle.Render(m.repo)
	origin := "attached"
	if m.serve != nil && m.serve.Owned() {
		origin = fmt.Sprintf("local serve :%d (owned)", m.serve.Port)
	} else {
		origin = "existing serve"
	}
	right := styleStatus.Render(origin)
	// A detached (or open) run is surfaced in the header so it is never
	// ambiguous whether a run is still going.
	if m.runHandle != nil || m.runBusy || m.runUnseen {
		chip := runStatusChip(m.runStatus)
		if m.runID != "" {
			chip += styleMuted.Render(" " + shortID(m.runID))
		}
		if !m.runOpen {
			hint := "o open"
			if m.runUnseen && !m.runBusy {
				hint = "o results"
				chip = styleKey.Render("! ") + chip
			}
			chip += styleKey.Render("  (" + hint + ")")
		}
		right = chip + "   " + right
	}
	gap := m.width - lipgloss.Width(title) - lipgloss.Width(repo) - lipgloss.Width(right) - 2
	if gap < 1 {
		gap = 1
	}
	return title + " " + repo + strings.Repeat(" ", gap) + right
}

// hint is one key/description pair in the status bar.
type hint struct {
	key  string
	desc string
}

func h(key, desc string) hint { return hint{key: key, desc: desc} }

// keyHints returns the context-sensitive key hints for the current state.
func (m *Model) keyHints() []hint {
	switch {
	case m.filtering:
		return []hint{
			h("type", "filter models"),
			h("enter", "apply"),
			h("esc", "clear"),
		}
	case m.focus == PaneWorkflows:
		hs := []hint{
			h("[workflows]", ""),
			h("↑↓", "move"),
			h("enter", "open DAG"),
			h("R", "run"),
		}
		if m.lastFailedStep != "" {
			hs = append(hs, h("u", "resume "+m.lastFailedStep))
		}
		hs = append(hs,
			h("/", "filter"),
			h("tab", "pane"),
			h("s", "search"),
			h("p", "playground"),
			h("r", "reload"),
			h("q", "quit"),
		)
		return hs
	case m.focus == PaneDetail:
		hs := []hint{
			h("[detail]", ""),
		}
		if len(m.detailLinks) > 0 {
			hs = append(hs, h("↑↓", "select output"), h("enter", "view"))
		} else {
			hs = append(hs, h("↑↓", "scroll"), h("pgup/pgdn", "page"))
		}
		if m.rootKind == RootWorkflow {
			hs = append(hs, h("R", "run"))
			if m.lastFailedStep != "" {
				hs = append(hs, h("u", "resume "+m.lastFailedStep))
			}
		}
		hs = append(hs,
			h("tab", "pane"),
			h("s", "search"),
			h("p", "playground"),
			h("esc", "root"),
			h("r", "reload"),
			h("q", "quit"),
		)
		return hs
	case m.focus == PaneData:
		return []hint{
			h("[data]", ""),
			h("↑↓", "move"),
			h("enter", "view content"),
			h("tab", "pane"),
			h("s", "search"),
			h("p", "playground"),
			h("esc", "root"),
			h("r", "reload"),
			h("q", "quit"),
		}
	default: // PaneModels
		return []hint{
			h("[models]", ""),
			h("↑↓", "move"),
			h("enter", "open"),
			h("/", "filter"),
			h("tab", "pane"),
			h("s", "search"),
			h("p", "playground"),
			h("r", "reload"),
			h("q", "quit"),
		}
	}
}

// renderHints lays out hints on one line, dropping trailing hints that would
// overflow width. Each hint renders as "key desc" with the key accented.
func renderHints(hints []hint, width int) string {
	var b strings.Builder
	used := 0
	for i, hn := range hints {
		// Section labels like "[models]" render dimmed with no key styling.
		var seg string
		if strings.HasPrefix(hn.key, "[") {
			seg = stylePaneTitle.Render(hn.key)
		} else {
			seg = styleKey.Render(hn.key)
			if hn.desc != "" {
				seg += " " + styleMuted.Render(hn.desc)
			}
		}
		segW := lipgloss.Width(seg)
		sepW := 0
		if i > 0 {
			sepW = 2
		}
		if used+sepW+segW > width {
			break
		}
		if i > 0 {
			b.WriteString("  ")
			used += sepW
		}
		b.WriteString(seg)
		used += segW
	}
	return b.String()
}

func (m *Model) renderFooter() string {
	switch {
	case m.err != nil:
		return styleError.Render("✗ " + m.err.Error())
	case m.filtering:
		return styleKey.Render("/") + m.filter + "▏  " +
			renderHints(m.keyHints(), m.width)
	default:
		return renderHints(m.keyHints(), m.width)
	}
}

// paneScroll describes how full a pane's content is, for the scrollbar.
type paneScroll struct {
	total   int // total content rows
	visible int // rows the viewport shows
	top     int // first visible row
}

func (s paneScroll) needed() bool { return s.total > s.visible && s.visible > 0 }

func (m *Model) pane(title string, focused bool, content string, w, h int, sc paneScroll) string {
	st := stylePane
	titleSt := stylePaneTitleBlur
	if focused {
		st = stylePaneFocus
		titleSt = stylePaneTitle
	}
	// w includes 2 border + 2 padding columns; h includes 2 border rows plus
	// the 1-row pane title.
	innerW := w - 4
	innerH := h - 3
	if innerW < 1 {
		innerW = 1
	}
	if innerH < 1 {
		innerH = 1
	}
	head := titleSt.Render(title)
	if m.focus == PaneModels && title == "Models" && m.filtering {
		head = titleSt.Render(title) + styleMuted.Render("  /"+m.filter)
	}
	if lipgloss.Width(head) > innerW {
		head = truncateANSI(head, innerW)
	}

	// Reserve the last inner column for the scrollbar whenever the content
	// overflows, so the bar is always visible.
	hasBar := sc.needed() && innerW >= 3
	contentW := innerW
	if hasBar {
		contentW = innerW - 1
	}
	body := clip(content, contentW, innerH)
	if hasBar {
		body = stampScrollbar(body, sc, innerW, innerH)
	}
	joined := head + "\n" + body
	return st.Width(w).Height(h).Render(joined)
}

// stampScrollbar overlays a proportional scrollbar in the last inner column of
// each body row, padding rows to the full inner height so the bar is continuous.
func stampScrollbar(body string, sc paneScroll, innerW, innerH int) string {
	rows := strings.Split(body, "\n")
	bar := scrollbarString(sc.total, sc.visible, sc.top, innerH,
		styleScrollTrack.Render("│"), styleScrollThumb.Render("█"))
	if len(bar) < innerH {
		bar = append(bar, make([]string, innerH-len(bar))...)
	}
	out := make([]string, innerH)
	for i := 0; i < innerH; i++ {
		var line string
		if i < len(rows) {
			line = rows[i]
		}
		w := lipgloss.Width(line)
		if w > innerW-1 {
			line = truncateANSI(line, innerW-1)
			w = innerW - 1
		}
		line += strings.Repeat(" ", innerW-1-w)
		line += bar[i]
		out[i] = line
	}
	return strings.Join(out, "\n")
}

func (m *Model) renderWorkflows(w, h int) string {
	wfs := m.visibleWorkflows()
	top, bottom := listWindow(len(wfs), m.wfSel, 2, h-3)
	var b strings.Builder
	for i := top; i < bottom; i++ {
		n := wfs[i]
		b.WriteString(m.listLabel(i, m.wfSel, n.label, m.focus == PaneWorkflows))
		b.WriteString("\n")
		b.WriteString(styleItemSub.Render("   " + n.sub))
		b.WriteString("\n")
	}
	if len(wfs) == 0 {
		b.WriteString(styleMuted.Render("(no workflows)"))
	}
	title := fmt.Sprintf("Workflows (%d)%s", len(wfs), rangeLabel(len(wfs), top, bottom))
	sc := paneScroll{total: len(wfs) * 2, visible: (bottom - top) * 2, top: top * 2}
	return m.pane(title, m.focus == PaneWorkflows, b.String(), w, h, sc)
}

func (m *Model) renderModels(w, h int) string {
	models := m.visibleModels()
	top, bottom := listWindow(len(models), m.modelSel, 2, h-3)
	var b strings.Builder
	for i := top; i < bottom; i++ {
		n := models[i]
		b.WriteString(m.listLabel(i, m.modelSel, n.label, m.focus == PaneModels))
		b.WriteString("\n")
		b.WriteString(styleItemSub.Render("   " + shortType(n.sub)))
		b.WriteString("\n")
	}
	title := fmt.Sprintf("Models (%d)%s", len(models), rangeLabel(len(models), top, bottom))
	sc := paneScroll{total: len(models) * 2, visible: (bottom - top) * 2, top: top * 2}
	return m.pane(title, m.focus == PaneModels, b.String(), w, h, sc)
}

// listLabel renders one selectable list row, styled by selection and focus.
func (m *Model) listLabel(i, sel int, label string, focused bool) string {
	if i == sel && focused {
		return styleSelected.Render(" " + label)
	}
	if i == sel {
		return styleSelectedBlur.Render(" " + label)
	}
	return styleItem.Render(label)
}

func (m *Model) renderDetail(w, h int) string {
	title := "Detail"
	if m.detailTitle != "" {
		title = "Detail — " + m.detailTitle
	}
	// Substitute the highlighted row for the selected run-output link so the
	// selection reads as interactive (and its artifact kind shows as an accent).
	lines := m.detailLines
	if m.detailSel >= 0 && m.detailSel < len(m.detailLinks) {
		lk := m.detailLinks[m.detailSel]
		if lk.line >= 0 && lk.line < len(lines) {
			cp := make([]string, len(lines))
			copy(cp, lines)
			cp[lk.line] = styleSelected.Render(lk.plain)
			lines = cp
		}
	}
	content := strings.Join(lines, "\n")
	// Apply scroll by dropping leading lines.
	if m.detailScroll > 0 && m.detailScroll < len(lines) {
		content = strings.Join(lines[m.detailScroll:], "\n")
	}
	sc := paneScroll{total: len(lines), visible: h - 3, top: m.detailScroll}
	return m.pane(title, m.focus == PaneDetail, content, w, h, sc)
}

func (m *Model) renderData(w, h int) string {
	top, bottom := listWindow(len(m.dataItems), m.dataSel, 2, h-3)
	var b strings.Builder
	for i := top; i < bottom; i++ {
		n := m.dataItems[i]
		b.WriteString(m.listLabel(i, m.dataSel, n.label, m.focus == PaneData))
		b.WriteString("\n")
		b.WriteString(styleItemSub.Render("   " + n.sub))
		b.WriteString("\n")
	}
	if len(m.dataItems) == 0 {
		b.WriteString(styleMuted.Render("(no data)"))
	}
	title := fmt.Sprintf("Data (%d)%s", len(m.dataItems), rangeLabel(len(m.dataItems), top, bottom))
	sc := paneScroll{total: len(m.dataItems) * 2, visible: (bottom - top) * 2, top: top * 2}
	return m.pane(title, m.focus == PaneData, b.String(), w, h, sc)
}

// clip trims content to innerW x innerH (approximate; ANSI-aware via lipgloss).
func clip(content string, w, h int) string {
	lines := strings.Split(content, "\n")
	if len(lines) > h {
		lines = lines[:h]
	}
	out := make([]string, len(lines))
	for i, ln := range lines {
		if lipgloss.Width(ln) > w {
			out[i] = truncateANSI(ln, w)
		} else {
			out[i] = ln
		}
	}
	return strings.Join(out, "\n")
}

// truncateANSI cuts a styled string to width w using lipgloss, preserving styles.
func truncateANSI(s string, w int) string {
	if w <= 0 {
		return ""
	}
	return lipgloss.NewStyle().MaxWidth(w).Render(s)
}

func shortType(t string) string {
	if i := strings.LastIndex(t, "/"); i >= 0 {
		return t[i+1:]
	}
	return t
}

// placeHeight keeps composed overlays one row short of the terminal so the
// bottom line is never scrolled off (see render()).
func placeHeight(h int) int {
	if h > 1 {
		return h - 1
	}
	return h
}
