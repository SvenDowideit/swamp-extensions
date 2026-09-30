package ui

import (
	"strings"

	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"
	"golang.org/x/net/html"
)

// htmlStyle is the inherited inline style while walking the document tree.
type htmlStyle struct {
	bold   bool
	italic bool
	code   bool
	link   bool
	quote  bool
}

func (s htmlStyle) lip() lipgloss.Style {
	st := lipgloss.NewStyle()
	if s.quote {
		st = st.Foreground(colMuted).Italic(true)
	}
	if s.code {
		st = st.Foreground(colAccent2)
	}
	if s.link {
		st = st.Foreground(colAccent).Underline(true)
	}
	if s.bold {
		st = st.Bold(true)
	}
	if s.italic {
		st = st.Italic(true)
	}
	return st
}

// htmlRenderer converts an HTML document into wrapped, styled display lines.
type htmlRenderer struct {
	width   int
	out     []string
	runs    []inlineRun
	prefix  string
	hanging string
}

func (r *htmlRenderer) flush() {
	if len(r.runs) == 0 {
		return
	}
	lines := wrapRuns(r.runs, r.width, r.prefix, r.hanging)
	r.out = append(r.out, lines...)
	r.runs = nil
}

func (r *htmlRenderer) add(text string, st htmlStyle) {
	if text == "" {
		return
	}
	r.runs = append(r.runs, inlineRun{st: st.lip(), text: text})
}

func (r *htmlRenderer) blank() {
	r.flush()
	if n := len(r.out); n > 0 && r.out[n-1] != "" {
		r.out = append(r.out, "")
	}
}

// renderHTML renders an HTML string to display lines no wider than width.
func renderHTML(src string, width int) []string {
	if width < 12 {
		width = 12
	}
	doc, err := html.Parse(strings.NewReader(src))
	if err != nil {
		return wrapString(stripTags(src), width)
	}
	r := &htmlRenderer{width: width}
	body := findBody(doc)
	if body == nil {
		body = doc
	}
	r.walk(body, htmlStyle{})
	r.flush()
	r.trimTrailing()
	if len(r.out) == 0 {
		return []string{styleMuted.Render("(empty document)")}
	}
	return r.out
}

func (r *htmlRenderer) trimTrailing() {
	for len(r.out) > 0 && strings.TrimSpace(ansi.Strip(r.out[len(r.out)-1])) == "" {
		r.out = r.out[:len(r.out)-1]
	}
}

func findBody(n *html.Node) *html.Node {
	if n.Type == html.ElementNode && n.Data == "body" {
		return n
	}
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		if b := findBody(c); b != nil {
			return b
		}
	}
	return nil
}

// walk traverses the tree, dispatching block elements and accumulating inline.
func (r *htmlRenderer) walk(n *html.Node, st htmlStyle) {
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		r.node(c, st)
	}
}

func (r *htmlRenderer) node(n *html.Node, st htmlStyle) {
	if n.Type == html.CommentNode {
		return
	}
	if n.Type == html.TextNode {
		r.add(collapseSpace(n.Data), st)
		return
	}
	if n.Type != html.ElementNode {
		return
	}
	switch n.Data {
	case "script", "style", "head", "meta", "link", "noscript", "template", "svg":
		return
	case "br":
		r.flush()
		return
	case "hr":
		r.blank()
		r.out = append(r.out, styleMuted.Render(strings.Repeat("─", r.width)))
		return
	case "p", "div", "section", "article", "header", "footer", "main", "figure":
		r.para(n, st)
	case "h1", "h2", "h3", "h4", "h5", "h6":
		r.heading(n, st, int(n.Data[1]-'0'))
	case "ul", "ol":
		r.list(n, st, n.Data == "ol")
	case "blockquote":
		r.blank()
		save := r.prefix
		saveH := r.hanging
		r.prefix = save + styleMuted.Render("│ ") + "  "
		r.hanging = saveH + styleMuted.Render("│ ") + "  "
		st.quote = true
		r.walk(n, st)
		r.flush()
		r.prefix, r.hanging = save, saveH
	case "pre":
		r.pre(n, st)
	case "table":
		r.table(n, st)
	case "tr":
		// handled by table
		r.walk(n, st)
	case "b", "strong":
		st.bold = true
		r.walk(n, st)
	case "i", "em":
		st.italic = true
		r.walk(n, st)
	case "code", "kbd", "samp", "tt":
		st.code = true
		r.walk(n, st)
	case "a":
		st.link = true
		r.walk(n, st)
	default:
		r.walk(n, st)
	}
}

func (r *htmlRenderer) para(n *html.Node, st htmlStyle) {
	r.flush()
	// A standalone image renders its alt text.
	r.walk(n, st)
	r.flush()
}

func (r *htmlRenderer) heading(n *html.Node, st htmlStyle, level int) {
	if level > 3 {
		level = 3
	}
	r.blank()
	st.bold = true
	marker := ""
	switch level {
	case 1:
		marker = "# "
	case 2:
		marker = "## "
	case 3:
		marker = "### "
	}
	saveP, saveH := r.prefix, r.hanging
	r.prefix = marker
	r.hanging = strings.Repeat(" ", len(marker))
	r.walk(n, st)
	r.flush()
	r.prefix, r.hanging = saveP, saveH
	r.blank()
}

func (r *htmlRenderer) list(n *html.Node, st htmlStyle, ordered bool) {
	r.flush()
	i := 0
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		if c.Type != html.ElementNode || c.Data != "li" {
			continue
		}
		i++
		marker := "• "
		if ordered {
			marker = itoa(i) + ". "
		}
		saveP, saveH := r.prefix, r.hanging
		r.prefix = saveP + marker
		r.hanging = saveH + strings.Repeat(" ", len(marker))
		r.walk(c, st)
		r.flush()
		r.prefix, r.hanging = saveP, saveH
	}
}

func (r *htmlRenderer) pre(n *html.Node, st htmlStyle) {
	if n.FirstChild != nil && n.FirstChild.Type == html.ElementNode && n.FirstChild.Data == "code" {
		n = n.FirstChild
	}
	r.blank()
	raw := textContent(n)
	for _, line := range strings.Split(strings.Trim(raw, "\n"), "\n") {
		for len(line) > r.width {
			r.out = append(r.out, st.lip().Render(line[:r.width]))
			line = line[r.width:]
		}
		r.out = append(r.out, st.lip().Render(line))
	}
	r.blank()
}

func (r *htmlRenderer) table(n *html.Node, st htmlStyle) {
	r.blank()
	var header []string
	var rows [][]string
	for _, tr := range findTags(n, "tr") {
		var cells []string
		var cellStyles []htmlStyle
		isHeader := false
		for c := tr.FirstChild; c != nil; c = c.NextSibling {
			if c.Type != html.ElementNode {
				continue
			}
			if c.Data != "td" && c.Data != "th" {
				continue
			}
			if c.Data == "th" {
				isHeader = true
			}
			cells = append(cells, strings.TrimSpace(textContent(c)))
			cellStyles = append(cellStyles, st)
		}
		if len(cells) == 0 {
			continue
		}
		if isHeader && header == nil {
			header = cells
			continue
		}
		rows = append(rows, cells)
	}
	if header == nil && len(rows) > 0 {
		header = rows[0]
		rows = rows[1:]
	}
	styleHeader := func(s string) string { return stylePaneTitle.Render(s) }
	styleCell := func(s string) string { return styleItem.Render(s) }
	r.out = append(r.out, tableLines(header, rows, r.width, styleHeader, styleCell)...)
	r.blank()
}

func findTags(n *html.Node, tag string) []*html.Node {
	var out []*html.Node
	var rec func(*html.Node)
	rec = func(x *html.Node) {
		if x.Type == html.ElementNode && x.Data == tag {
			out = append(out, x)
			return // don't descend into nested tables
		}
		for c := x.FirstChild; c != nil; c = c.NextSibling {
			rec(c)
		}
	}
	rec(n)
	return out
}

func textContent(n *html.Node) string {
	var b strings.Builder
	var rec func(*html.Node)
	rec = func(x *html.Node) {
		switch x.Type {
		case html.TextNode:
			b.WriteString(x.Data)
		case html.ElementNode:
			if x.Data == "br" {
				b.WriteString("\n")
				return
			}
			if x.Data == "script" || x.Data == "style" {
				return
			}
			for c := x.FirstChild; c != nil; c = c.NextSibling {
				rec(c)
			}
		}
	}
	rec(n)
	return b.String()
}

// collapseSpace trims and collapses runs of whitespace to single spaces. It
// returns "" for whitespace-only text so it does not create empty runs.
func collapseSpace(s string) string {
	return strings.Join(strings.Fields(s), " ")
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}

// stripTags is a crude fallback when HTML parsing fails.
func stripTags(s string) string {
	var b strings.Builder
	inTag := false
	for _, r := range s {
		switch {
		case r == '<':
			inTag = true
		case r == '>':
			inTag = false
		case !inTag:
			b.WriteRune(r)
		}
	}
	return b.String()
}
