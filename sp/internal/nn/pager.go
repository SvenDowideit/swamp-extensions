package nn

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/charmbracelet/x/ansi"
	"github.com/svendowideit/swamp-project/sp/internal/ui"
)

// bodyLines renders an item's document for the pager.
//
// Format selects the renderer; this is the P0 subset of the plan's item UI
// registry (markdown and html reuse sp's renderers rather than forking them).
func bodyLines(it *Item, width int) []string {
	if width < 12 {
		width = 12
	}
	var out []string
	if len(it.Meta) > 0 {
		out = append(out, styleDim.Render(strings.Join(it.Meta, " · ")))
		out = append(out, "")
	}

	switch it.Format {
	case "markdown":
		return append(out, ui.RenderMarkdown(it.Body, width)...)
	case "html":
		return append(out, ui.RenderHTML(it.Body, width)...)
	case "row", "json":
		out = append(out, fieldLines(it.Raw, width)...)
		if body := strings.TrimSpace(it.Body); body != "" {
			out = append(out, "")
			out = append(out, ui.Wrap(body, width)...)
		}
		return out
	case "run":
		out = append(out, fieldLines(it.Raw, width)...)
		if body := strings.TrimSpace(it.Body); body != "" {
			out = append(out, "")
			out = append(out, styleErr.Render(body))
		}
		return out
	case "task":
		if body := strings.TrimSpace(it.Body); body != "" {
			out = append(out, ui.Wrap(body, width)...)
			out = append(out, "")
		}
		return append(out, fieldLines(it.Raw, width)...)
	case "object":
		if body := strings.TrimSpace(it.Body); body != "" {
			out = append(out, ui.Wrap(body, width)...)
			out = append(out, "")
		}
		return append(out, fieldLines(it.Raw, width)...)
	default: // article, text, link, anything else
		if body := strings.TrimSpace(it.Body); body != "" {
			out = append(out, ui.Wrap(body, width)...)
			return out
		}
		return append(out, fieldLines(it.Raw, width)...)
	}
}

// fieldLines renders a record as sorted key/value lines, skipping empties.
func fieldLines(raw map[string]any, width int) []string {
	if len(raw) == 0 {
		return []string{styleDim.Render("(no fields)")}
	}
	keys := make([]string, 0, len(raw))
	for k := range raw {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := make([]string, 0, len(keys))
	for _, k := range keys {
		v := raw[k]
		if v == nil {
			continue
		}
		var s string
		switch t := v.(type) {
		case string:
			s = strings.TrimSpace(t)
			if s == "" {
				continue
			}
		case map[string]any, []any:
			b, err := json.Marshal(v)
			if err != nil {
				continue
			}
			s = string(b)
		default:
			s = scalar(v)
		}
		label := styleAccent2.Render(k + ":")
		wrapped := ui.Wrap(s, width-ansi.StringWidth(label)-1)
		if len(wrapped) == 0 {
			continue
		}
		out = append(out, " "+label+" "+wrapped[0])
		for _, cont := range wrapped[1:] {
			out = append(out, "   "+cont)
		}
	}
	return out
}

// pagerState is the read item UI: a page-at-a-time view over one or more items.
type pagerState struct {
	items  []*Item
	idx    int
	offset int

	cache     []string
	cacheKey  string
	cacheWide int
}

// newPager builds a pager over items, starting at index start.
func newPager(items []*Item, start int) *pagerState {
	if start < 0 || start >= len(items) {
		start = 0
	}
	return &pagerState{items: items, idx: start}
}

// current returns the item being read.
func (p *pagerState) current() *Item {
	if p.idx < 0 || p.idx >= len(p.items) {
		return nil
	}
	return p.items[p.idx]
}

// lines returns the rendered body of the current item at width.
func (p *pagerState) lines(width int) []string {
	it := p.current()
	if it == nil {
		return nil
	}
	key := it.Group + "\x00" + it.ID
	if p.cacheKey == key && p.cacheWide == width {
		return p.cache
	}
	p.cache = bodyLines(it, width)
	p.cacheKey, p.cacheWide = key, width
	return p.cache
}

// pageSize is the number of body lines a screen of height h shows.
func pageSize(h int) int {
	if h < 3 {
		return 1
	}
	return h
}

// advance moves one page forward, then one item forward. It returns the items
// that were fully read, and whether the pager is finished.
func (p *pagerState) advance(width, height int) (read []*Item, done bool) {
	lines := p.lines(width)
	if p.offset+pageSize(height) < len(lines) {
		p.offset += pageSize(height)
		return nil, false
	}
	if it := p.current(); it != nil {
		read = append(read, it)
	}
	p.idx++
	p.offset = 0
	if p.idx >= len(p.items) {
		return read, true
	}
	return read, false
}

// back moves one page, then one item, backwards.
func (p *pagerState) back() {
	if p.offset > 0 {
		p.offset = 0
		return
	}
	if p.idx > 0 {
		p.idx--
		p.offset = 0
	}
}

// scroll moves by delta lines within the current item.
func (p *pagerState) scroll(delta, width, height int) {
	lines := p.lines(width)
	p.offset += delta
	if p.offset < 0 {
		p.offset = 0
	}
	max := len(lines) - pageSize(height)
	if max < 0 {
		max = 0
	}
	if p.offset > max {
		p.offset = max
	}
}

// progress is the percentage of the current item read.
func (p *pagerState) progress(width, height int) int {
	lines := p.lines(width)
	if len(lines) == 0 {
		return 100
	}
	end := p.offset + pageSize(height)
	if end > len(lines) {
		end = len(lines)
	}
	return end * 100 / len(lines)
}

// render draws the current page.
func (p *pagerState) render(width, height int) []string {
	lines := p.lines(width)
	out := make([]string, 0, height)
	for i := 0; i < height; i++ {
		n := p.offset + i
		if n >= len(lines) {
			break
		}
		out = append(out, fit(lines[n], width))
	}
	if len(out) == 0 {
		out = append(out, styleDim.Render("(empty)"))
	}
	return out
}

// pagerStatus is the header line above the body.
func (p *pagerState) pagerStatus(width int) string {
	it := p.current()
	if it == nil {
		return ""
	}
	pos := ""
	if len(p.items) > 1 {
		pos = fmt.Sprintf(" (%d of %d)", p.idx+1, len(p.items))
	}
	return styleTitle.Render(fit(it.ColsTitle(), width-len(pos))) + styleDim.Render(pos)
}

// ColsTitle is the item's display title: its last menu column, which is the
// subject/title by convention.
func (it *Item) ColsTitle() string {
	if len(it.Cols) == 0 {
		return it.ID
	}
	return it.Cols[len(it.Cols)-1]
}
