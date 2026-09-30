package ui

import (
	"fmt"
	"strings"
	"testing"
)

// TestRenderNeverFillsTerminal guards the bug where panes sized to exactly the
// terminal height pushed the status bar off the bottom (the terminal scrolls by
// one when content equals the row count).
func TestRenderNeverFillsTerminal(t *testing.T) {
	m := sampleModel()
	for _, size := range [][2]int{{60, 12}, {120, 20}, {120, 30}, {200, 50}} {
		m.width, m.height = size[0], size[1]
		out := m.render()
		lines := strings.Split(out, "\n")
		if len(lines) >= m.height {
			t.Errorf("%dx%d: render is %d lines, must be < %d",
				size[0], size[1], len(lines), m.height)
		}
		last := strip(lines[len(lines)-1])
		if !strings.Contains(last, "[models]") {
			t.Errorf("%dx%d: bottom line is not the status bar: %q", size[0], size[1], last)
		}
	}
}

// TestFooterVisibleAtEveryFocus verifies the context-sensitive bar is the last
// rendered line in each state.
func TestFooterVisibleAtEveryFocus(t *testing.T) {
	m := sampleModel()
	m.width, m.height = 120, 30
	for _, tc := range []struct {
		focus Pane
		want  string
	}{
		{PaneModels, "[models]"},
		{PaneDetail, "[detail]"},
		{PaneData, "[data]"},
	} {
		m.focus = tc.focus
		lines := strings.Split(strings.TrimRight(m.render(), "\n"), "\n")
		if got := strip(lines[len(lines)-1]); !strings.Contains(got, tc.want) {
			t.Errorf("focus %v: bottom bar %q missing %q", tc.focus, got, tc.want)
		}
	}
}

// TestSpotterOverlayFits ensures the search overlay never draws beyond the
// terminal bounds.
func TestSpotterOverlayFits(t *testing.T) {
	m := sampleModel()
	m.spotterOpen = true
	m.spotterLoaded = true
	m.spotterIndex = []spotterItem{
		{kind: "model", label: "bom", sub: "@svendowideit/bom-weather"},
		{kind: "workflow", label: "disk", sub: "1 jobs · 1 steps"},
		{kind: "data", label: "forecast", sub: "resource v9"},
	}
	for _, size := range [][2]int{{80, 24}, {120, 30}, {200, 60}} {
		m.width, m.height = size[0], size[1]
		out := strip(m.render())
		lines := strings.Split(out, "\n")
		if len(lines) > m.height {
			t.Errorf("%dx%d: spotter render %d lines exceeds height", size[0], size[1], len(lines))
		}
		if !strings.Contains(out, "Spotter") {
			t.Errorf("%dx%d: spotter overlay missing", size[0], size[1])
		}
	}
}

func TestListWindowKeepsSelectionVisible(t *testing.T) {
	// 20 items, 2 rows each -> 5 visible in a 10-row viewport.
	const n, rows, innerH = 20, 2, 10

	// Selection near the top: window stays at the top.
	top, bottom := listWindow(n, 0, rows, innerH)
	if top != 0 || bottom != 5 {
		t.Fatalf("sel=0 window=[%d,%d) want [0,5)", top, bottom)
	}
	top, bottom = listWindow(n, 4, rows, innerH)
	if top != 0 || bottom != 5 {
		t.Fatalf("sel=4 window=[%d,%d) want [0,5)", top, bottom)
	}

	// Selection just past the fold: scrolls by one.
	top, bottom = listWindow(n, 5, rows, innerH)
	if top != 1 || bottom != 6 {
		t.Fatalf("sel=5 window=[%d,%d) want [1,6)", top, bottom)
	}

	// Selection at the end: window clamps to the end.
	top, bottom = listWindow(n, 19, rows, innerH)
	if bottom != n {
		t.Fatalf("sel=19 bottom=%d want %d", bottom, n)
	}
	if !(top <= 19 && 19 < bottom) {
		t.Fatalf("sel=19 not in window=[%d,%d)", top, bottom)
	}

	// Invariant: the selection is always inside the window, and the window is
	// the right size or clamped to the list.
	for sel := 0; sel < n; sel++ {
		top, bottom = listWindow(n, sel, rows, innerH)
		if sel < top || sel >= bottom {
			t.Fatalf("sel=%d outside window=[%d,%d)", sel, top, bottom)
		}
		if bottom-top > n {
			t.Fatalf("window larger than list: [%d,%d)", top, bottom)
		}
	}
}

func TestListWindowSmallListNoScroll(t *testing.T) {
	top, bottom := listWindow(3, 2, 2, 20)
	if top != 0 || bottom != 3 {
		t.Fatalf("small list should not scroll: [%d,%d)", top, bottom)
	}
	if rangeLabel(3, top, bottom) != "" {
		t.Fatalf("no scroll indicator when all fit")
	}
	if got := rangeLabel(20, 0, 5); got == "" {
		t.Fatalf("expected a scroll indicator when not all fit")
	}
}

func TestSelectedModelStaysVisibleWhenScrolled(t *testing.T) {
	m := New(nil, "r", nil)
	m.width, m.height = 120, 24
	for i := 0; i < 30; i++ {
		m.models = append(m.models, node{
			label: fmt.Sprintf("model-%02d", i),
			sub:   "@x/type",
			kind:  "model",
		})
	}
	m.focus = PaneModels

	// Selection near the top: window at top, first item visible.
	m.modelSel = 1
	out := strip(m.renderModels(40, 20))
	if !strings.Contains(out, "model-01") {
		t.Fatalf("sel=1 not visible:\n%s", out)
	}
	if strings.Contains(out, "model-29") {
		t.Fatalf("sel=1 should not have scrolled to the end:\n%s", out)
	}

	// Selection far down: it must still be rendered, and early items gone.
	m.modelSel = 25
	out = strip(m.renderModels(40, 20))
	if !strings.Contains(out, "model-25") {
		t.Fatalf("sel=25 not visible after scroll:\n%s", out)
	}
	if strings.Contains(out, "model-00") {
		t.Fatalf("sel=25 should have scrolled past the start:\n%s", out)
	}
	// Range indicator appears in the title.
	if !strings.Contains(out, "/30") {
		t.Fatalf("expected a scroll range indicator in the title:\n%s", out)
	}
}

func TestScrollbarThumbProportionalAndMoving(t *testing.T) {
	// 200 rows of content, 10 visible.
	start, end, ok := scrollbarThumb(200, 10, 0, 10)
	if !ok || start != 0 {
		t.Fatalf("top: start=%d end=%d ok=%v", start, end, ok)
	}
	if end < 1 {
		t.Fatalf("thumb must be at least 1 cell")
	}
	// Scrolled to the end, the thumb bottom must reach the track bottom.
	_, endBottom, _ := scrollbarThumb(200, 10, 190, 10)
	if endBottom != 10 {
		t.Fatalf("bottom: thumb end=%d want 10", endBottom)
	}
	// No bar when content fits.
	if _, _, ok := scrollbarThumb(10, 10, 0, 10); ok {
		t.Fatalf("expected no scrollbar when content fits")
	}
	if _, _, ok := scrollbarThumb(5, 10, 0, 10); ok {
		t.Fatalf("expected no scrollbar when content is shorter")
	}
	// Thumb stays within the track for every offset.
	for top := 0; top <= 190; top++ {
		s, e, ok := scrollbarThumb(200, 10, top, 10)
		if !ok || s < 0 || e > 10 || s >= e {
			t.Fatalf("top=%d invalid thumb [%d,%d)", top, s, e)
		}
	}
}

func TestListPanesShowScrollbarWhenOverflowing(t *testing.T) {
	m := New(nil, "r", nil)
	m.width, m.height = 120, 20
	for i := 0; i < 40; i++ {
		m.models = append(m.models, node{label: fmt.Sprintf("m%02d", i), sub: "@x/t"})
	}
	m.focus = PaneModels
	out := strip(m.renderModels(40, m.height-4))
	if !strings.Contains(out, "█") {
		t.Fatalf("expected a scrollbar thumb for an overflowing model list:\n%s", out)
	}

	// A short list must not show a bar.
	m2 := New(nil, "r", nil)
	m2.width, m2.height = 120, 20
	for i := 0; i < 3; i++ {
		m2.models = append(m2.models, node{label: fmt.Sprintf("m%02d", i), sub: "@x/t"})
	}
	out2 := strip(m2.renderModels(40, m2.height-4))
	if strings.Contains(out2, "█") {
		t.Fatalf("short list should have no scrollbar:\n%s", out2)
	}
}

func TestDetailPaneShowsScrollbar(t *testing.T) {
	m := New(nil, "r", nil)
	m.width, m.height = 120, 20
	for i := 0; i < 100; i++ {
		m.detailLines = append(m.detailLines, fmt.Sprintf("detail line %d", i))
	}
	m.focus = PaneDetail
	out := strip(m.renderDetail(60, m.height-4))
	if !strings.Contains(out, "█") {
		t.Fatalf("expected a scrollbar on an overflowing detail pane:\n%s", out)
	}
}

func TestScrollbarThumbMovesInRender(t *testing.T) {
	m := New(nil, "r", nil)
	m.width, m.height = 120, 20
	for i := 0; i < 60; i++ {
		m.models = append(m.models, node{label: fmt.Sprintf("m%02d", i), sub: "@x/t"})
	}
	m.focus = PaneModels
	h := m.height - 4

	thumbRow := func() int {
		rows := strings.Split(strip(m.renderModels(40, h)), "\n")
		for i, r := range rows {
			if strings.Contains(r, "█") {
				return i
			}
		}
		return -1
	}

	m.modelSel = 0
	top0 := thumbRow()
	m.modelSel = 59
	topEnd := thumbRow()
	if top0 < 0 || topEnd < 0 {
		t.Fatalf("no thumb found (start=%d end=%d)", top0, topEnd)
	}
	if topEnd <= top0 {
		t.Fatalf("thumb did not move down as selection increased: start=%d end=%d", top0, topEnd)
	}
}
