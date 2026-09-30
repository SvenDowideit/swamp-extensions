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
