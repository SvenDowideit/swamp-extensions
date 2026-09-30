package ui

import (
	"fmt"
	"strings"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
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

	bodyH := m.height - lipgloss.Height(header) - lipgloss.Height(footer)
	if bodyH < 4 {
		bodyH = 4
	}
	// column widths: 28% models, flexible detail, 26% data
	modelsW := clamp(m.width*28/100, 20, 44)
	dataW := clamp(m.width*26/100, 20, 44)
	detailW := m.width - modelsW - dataW - 4
	if detailW < 20 {
		detailW = 20
	}

	modelsPane := m.renderModels(modelsW, bodyH)
	detailPane := m.renderDetail(detailW, bodyH)
	dataPane := m.renderData(dataW, bodyH)

	body := lipgloss.JoinHorizontal(lipgloss.Top, modelsPane, detailPane, dataPane)
	panes := lipgloss.JoinVertical(lipgloss.Left, header, body, footer)

	if m.spotterOpen {
		return m.renderSpotter()
	}
	return panes
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
	box = box + "\n" + styleMuted.Render("↑↓ move  enter jump  esc close")

	// Centre over the background.
	return lipgloss.Place(m.width, m.height, lipgloss.Center, lipgloss.Center, box)
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
	gap := m.width - lipgloss.Width(title) - lipgloss.Width(repo) - lipgloss.Width(right) - 2
	if gap < 1 {
		gap = 1
	}
	return title + " " + repo + strings.Repeat(" ", gap) + right
}

func (m *Model) renderFooter() string {
	var b strings.Builder
	if m.err != nil {
		b.WriteString(styleError.Render("✗ " + m.err.Error()))
	} else if m.filtering {
		b.WriteString(styleKey.Render("/") + m.filter + "▏")
		b.WriteString(styleMuted.Render("  enter:apply  esc:clear"))
	} else {
		b.WriteString(styleMuted.Render(
			"s search  tab switch  ↑↓ move  enter open  / filter  r reload  q quit"))
	}
	return "\n" + b.String()
}

func (m *Model) pane(title string, focused bool, content string, w, h int) string {
	st := stylePane
	titleSt := stylePaneTitleBlur
	if focused {
		st = stylePaneFocus
		titleSt = stylePaneTitle
	}
	innerW := w - 4
	innerH := h - 2
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
	body := clip(content, innerW, innerH)
	joined := head + "\n" + body
	return st.Width(w).Height(h).Render(joined)
}

func (m *Model) renderModels(w, h int) string {
	models := m.visibleModels()
	var b strings.Builder
	for i, n := range models {
		line := styleItem.Render(n.label)
		if i == m.modelSel && m.focus == PaneModels {
			line = styleSelected.Render(" " + n.label)
		} else if i == m.modelSel {
			line = styleSelectedBlur.Render(" " + n.label)
		}
		b.WriteString(line)
		b.WriteString("\n")
		b.WriteString(styleItemSub.Render("   " + shortType(n.sub)))
		b.WriteString("\n")
	}
	return m.pane(fmt.Sprintf("Models (%d)", len(models)), m.focus == PaneModels, b.String(), w, h)
}

func (m *Model) renderDetail(w, h int) string {
	title := "Detail"
	if m.detailTitle != "" {
		title = "Detail — " + m.detailTitle
	}
	content := strings.Join(m.detailLines, "\n")
	// Apply scroll by dropping leading lines.
	if m.detailScroll > 0 && m.detailScroll < len(m.detailLines) {
		content = strings.Join(m.detailLines[m.detailScroll:], "\n")
	}
	return m.pane(title, m.focus == PaneDetail, content, w, h)
}

func (m *Model) renderData(w, h int) string {
	var b strings.Builder
	for i, n := range m.dataItems {
		line := styleItem.Render(n.label)
		if i == m.dataSel && m.focus == PaneData {
			line = styleSelected.Render(" " + n.label)
		} else if i == m.dataSel {
			line = styleSelectedBlur.Render(" " + n.label)
		}
		b.WriteString(line)
		b.WriteString("\n")
		b.WriteString(styleItemSub.Render("   " + n.sub))
		b.WriteString("\n")
	}
	if len(m.dataItems) == 0 {
		b.WriteString(styleMuted.Render("(no data)"))
	}
	return m.pane(fmt.Sprintf("Data (%d)", len(m.dataItems)), m.focus == PaneData, b.String(), w, h)
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
