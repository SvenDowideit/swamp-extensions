package ui

import (
	"strings"

	"charm.land/lipgloss/v2"
)

// inlineRun is a styled span of text. Renderers build a paragraph as a list of
// runs so wrapping can happen after styling without splitting ANSI sequences.
type inlineRun struct {
	st   lipgloss.Style
	text string
}

// wrapRuns lays styled runs out into lines no wider than width. Whitespace in
// the runs is collapsed to single spaces. prefix begins the first line and
// hanging begins every continuation line (use equal widths for hanging indents).
// A run whose text is exactly "\n" forces a line break.
func wrapRuns(runs []inlineRun, width int, prefix, hanging string) []string {
	if width < 4 {
		width = 4
	}
	var lines []string
	cur := prefix
	curW := lipgloss.Width(prefix)
	empty := true
	flush := func() {
		lines = append(lines, cur)
		cur = hanging
		curW = lipgloss.Width(hanging)
		empty = true
	}
	for _, r := range runs {
		if r.text == "\n" {
			flush()
			continue
		}
		for _, w := range strings.Fields(r.text) {
			ww := lipgloss.Width(w)
			need := ww
			if !empty {
				need++ // separating space
			}
			if !empty && curW+need > width {
				flush()
				need = ww
			}
			if !empty {
				cur += " "
				curW++
			}
			cur += r.st.Render(w)
			curW += ww
			empty = false
		}
	}
	if !empty || len(lines) == 0 {
		lines = append(lines, cur)
	}
	return lines
}

// padCells pads s with spaces to n columns (no truncation).
func padCells(s string, n int) string {
	w := lipgloss.Width(s)
	if w >= n {
		return s
	}
	return s + strings.Repeat(" ", n-w)
}

// tableLines renders a simple aligned table from header+rows of plain strings.
// styleRow is applied per cell via styleFor(rowIndex, colIndex).
func tableLines(header []string, rows [][]string, width int, styleHeader, styleCell func(string) string) []string {
	cols := len(header)
	for _, r := range rows {
		if len(r) > cols {
			cols = len(r)
		}
	}
	if cols == 0 {
		return nil
	}
	w := make([]int, cols)
	for i, h := range header {
		if lipgloss.Width(h) > w[i] {
			w[i] = lipgloss.Width(h)
		}
	}
	for _, r := range rows {
		for i, c := range r {
			if lipgloss.Width(c) > w[i] {
				w[i] = lipgloss.Width(c)
			}
		}
	}
	// Shrink columns proportionally if the table overflows.
	total := 0
	for _, cw := range w {
		total += cw + 3
	}
	if total > width && total > 0 {
		scale := float64(width) / float64(total)
		for i := range w {
			nw := int(float64(w[i]) * scale)
			if nw < 3 {
				nw = 3
			}
			w[i] = nw
		}
	}
	clipCell := func(s string, n int) string {
		if lipgloss.Width(s) <= n {
			return padCells(s, n)
		}
		return truncateANSI(s, n)
	}
	var out []string
	emit := func(cells []string, style func(string) string) {
		var b strings.Builder
		b.WriteString(" ")
		for i := 0; i < cols; i++ {
			c := ""
			if i < len(cells) {
				c = cells[i]
			}
			b.WriteString(style(clipCell(c, w[i])))
			if i < cols-1 {
				b.WriteString("  ")
			}
		}
		out = append(out, strings.TrimRight(b.String(), " "))
	}
	if len(header) > 0 {
		emit(header, styleHeader)
		// rule
		var b strings.Builder
		b.WriteString(" ")
		for i := 0; i < cols; i++ {
			b.WriteString(styleHeader(strings.Repeat("─", w[i])))
			if i < cols-1 {
				b.WriteString("  ")
			}
		}
		out = append(out, strings.TrimRight(b.String(), " "))
	}
	for ri, r := range rows {
		_ = ri
		emit(r, styleCell)
	}
	return out
}
