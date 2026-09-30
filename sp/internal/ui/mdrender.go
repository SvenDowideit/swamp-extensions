package ui

import (
	"strings"

	"charm.land/lipgloss/v2"
)

// renderMarkdown renders a practical subset of CommonMark (headings, lists,
// tables, blockquotes, fenced code, rules, inline emphasis/code/links) into
// wrapped, styled display lines. It is intentionally small: reports emitted by
// swamp use simple, predictable markdown.
func renderMarkdown(src string, width int) []string {
	if width < 12 {
		width = 12
	}
	r := &htmlRenderer{width: width}
	lines := strings.Split(strings.ReplaceAll(src, "\r\n", "\n"), "\n")

	inFence := false
	var fence []string
	flushFence := func() {
		if len(fence) == 0 {
			return
		}
		r.blank()
		for _, ln := range fence {
			r.out = append(r.out, styleMuted.Render("  │ ")+styleItem.Render(ln))
		}
		fence = nil
		r.blank()
	}

	i := 0
	for i < len(lines) {
		line := lines[i]
		trimmed := strings.TrimSpace(line)

		// Fenced code blocks.
		if strings.HasPrefix(trimmed, "```") {
			if inFence {
				flushFence()
				inFence = false
			} else {
				r.flush()
				inFence = true
			}
			i++
			continue
		}
		if inFence {
			fence = append(fence, strings.TrimRight(line, " \t"))
			i++
			continue
		}

		switch {
		case trimmed == "":
			r.blank()
			i++
		case isRule(trimmed):
			r.blank()
			r.out = append(r.out, styleMuted.Render(strings.Repeat("─", width)))
			r.blank()
			i++
		case strings.HasPrefix(trimmed, "### "):
			r.markdownHeading(trimmed[4:], 3)
			i++
		case strings.HasPrefix(trimmed, "## "):
			r.markdownHeading(trimmed[3:], 2)
			i++
		case strings.HasPrefix(trimmed, "# "):
			r.markdownHeading(trimmed[2:], 1)
			i++
		case isTableHeader(lines, i):
			i = r.markdownTable(lines, i)
		case strings.HasPrefix(trimmed, "> "), trimmed == ">":
			r.markdownQuote(lines, &i)
		case listMarker(trimmed) != "":
			r.markdownList(lines, &i)
		default:
			r.markdownParagraph(line)
			i++
		}
	}
	r.flush()
	r.trimTrailing()
	if len(r.out) == 0 {
		return []string{styleMuted.Render("(empty)")}
	}
	return r.out
}

func (r *htmlRenderer) markdownHeading(text string, level int) {
	r.blank()
	st := lipgloss.NewStyle().Bold(true).Foreground(colAccent)
	if level >= 3 {
		st = st.Foreground(colAccent2)
	}
	r.out = append(r.out, st.Render(text))
	if level == 1 {
		r.out = append(r.out, styleMuted.Render(strings.Repeat("─", minInt(r.width, lipgloss.Width(text)))))
	}
	r.blank()
}

func (r *htmlRenderer) markdownParagraph(line string) {
	r.flush()
	r.runs = parseInline(line)
	r.flush()
}

func (r *htmlRenderer) markdownQuote(lines []string, i *int) {
	r.flush()
	for *i < len(lines) {
		t := strings.TrimSpace(lines[*i])
		if !strings.HasPrefix(t, ">") {
			break
		}
		t = strings.TrimSpace(strings.TrimPrefix(t, ">"))
		r.runs = parseInline(t)
		save := r.prefix
		r.prefix = save + styleMuted.Render("│ ") + " "
		saveH := r.hanging
		r.hanging = saveH + styleMuted.Render("│ ") + " "
		r.flush()
		r.prefix, r.hanging = save, saveH
		*i++
	}
	r.blank()
}

func (r *htmlRenderer) markdownList(lines []string, i *int) {
	r.flush()
	for *i < len(lines) {
		line := lines[*i]
		trimmed := strings.TrimSpace(line)
		marker := listMarker(trimmed)
		if marker == "" {
			break
		}
		indent := len(line) - len(strings.TrimLeft(line, " "))
		text := strings.TrimSpace(trimmed[len(marker):])
		saveP, saveH := r.prefix, r.hanging
		lead := strings.Repeat(" ", indent)
		r.prefix = saveP + lead + marker
		hanging := strings.Repeat(" ", len(marker))
		r.hanging = saveH + lead + hanging
		r.runs = parseInline(text)
		r.flush()
		r.prefix, r.hanging = saveP, saveH
		*i++
	}
}

func (r *htmlRenderer) markdownTable(lines []string, i int) int {
	r.flush()
	header := splitTableRow(lines[i])
	align := splitTableRow(lines[i+1])
	_ = align
	i2 := i + 2
	var rows [][]string
	for i2 < len(lines) && strings.Contains(lines[i2], "|") && strings.TrimSpace(lines[i2]) != "" {
		rows = append(rows, splitTableRow(lines[i2]))
		i2++
	}
	r.blank()
	r.out = append(r.out, tableLines(header, rows, r.width,
		func(s string) string { return stylePaneTitle.Render(s) },
		func(s string) string { return styleItem.Render(s) })...)
	r.blank()
	return i2
}

// --- small helpers ---

func isRule(s string) bool {
	if len(s) < 3 {
		return false
	}
	c := s[0]
	if c != '-' && c != '*' && c != '_' {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] != c && s[i] != ' ' {
			return false
		}
	}
	return true
}

func isTableHeader(lines []string, i int) bool {
	if i+1 >= len(lines) {
		return false
	}
	if !strings.Contains(lines[i], "|") {
		return false
	}
	next := lines[i+1]
	if !strings.Contains(next, "|") {
		return false
	}
	cells := 0
	for _, seg := range strings.Split(next, "|") {
		seg = strings.TrimSpace(seg)
		if seg == "" {
			continue // leading/trailing pipes yield empty cells
		}
		seg = strings.Trim(seg, ":")
		if seg == "" || strings.Trim(seg, "-") != "" {
			return false
		}
		cells++
	}
	return cells > 0
}

// listMarker returns the bullet/number prefix if trimmed begins a list item.
func listMarker(trimmed string) string {
	if strings.HasPrefix(trimmed, "- ") || strings.HasPrefix(trimmed, "* ") || strings.HasPrefix(trimmed, "+ ") {
		return trimmed[:2]
	}
	// ordered: "12. "
	j := 0
	for j < len(trimmed) && trimmed[j] >= '0' && trimmed[j] <= '9' {
		j++
	}
	if j > 0 && j+1 < len(trimmed) && trimmed[j] == '.' && trimmed[j+1] == ' ' {
		return trimmed[:j+2]
	}
	return ""
}

// splitTableRow splits a markdown table row into trimmed cells.
func splitTableRow(s string) []string {
	s = strings.TrimSpace(s)
	s = strings.TrimPrefix(s, "|")
	s = strings.TrimSuffix(s, "|")
	parts := strings.Split(s, "|")
	for i := range parts {
		parts[i] = strings.TrimSpace(parts[i])
	}
	return parts
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}
