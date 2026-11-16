package nn

import (
	"github.com/charmbracelet/x/ansi"
)

// previewState is nn's `%`: look at the row under the cursor without leaving the
// menu. It is a *peek*, not a way into reading mode — it marks nothing, and one
// key returns you to the menu.
type previewState struct {
	item   *Item
	offset int
	lines  []string
	width  int
}

// newPreview renders the item's body for the peek pane.
func newPreview(it *Item, width int) *previewState {
	return &previewState{
		item:  it,
		lines: bodyLines(it, width),
		width: width,
	}
}

// scroll moves the peek by delta lines.
func (p *previewState) scroll(delta, height int) {
	p.offset += delta
	if p.offset < 0 {
		p.offset = 0
	}
	max := len(p.lines) - height
	if max < 0 {
		max = 0
	}
	if p.offset > max {
		p.offset = max
	}
}

// title is the peek's one-line header: which row, and what it is.
func (p *previewState) title(width int) string {
	if p.item == nil {
		return styleDim.Render("(nothing to preview)")
	}
	right := styleDim.Render("preview · " + p.item.Format)
	left := styleTitle.Render(ansi.Truncate(p.item.ColsTitle(), width-ansi.StringWidth(right)-2, "…"))
	gap := width - ansi.StringWidth(left) - ansi.StringWidth(right)
	if gap < 1 {
		return left
	}
	return left + spaces(gap) + right
}

// render draws the peek body.
func (p *previewState) render(width, height int) []string {
	out := make([]string, 0, height)
	for i := 0; i < height; i++ {
		n := p.offset + i
		if n >= len(p.lines) {
			break
		}
		out = append(out, fit(p.lines[n], width))
	}
	if len(out) == 0 {
		out = append(out, styleDim.Render("(no preview)"))
	}
	return out
}

// spaces is a tiny helper for gap computation.
func spaces(n int) string {
	if n <= 0 {
		return ""
	}
	b := make([]byte, n)
	for i := range b {
		b[i] = ' '
	}
	return string(b)
}
