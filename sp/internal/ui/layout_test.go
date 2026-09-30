package ui

import (
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
