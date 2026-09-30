package ui

import (
	"testing"

	tea "charm.land/bubbletea/v2"
)

func press(m *Model, code rune, text string) {
	msg := tea.KeyPressMsg(tea.Key{Code: code, Text: text})
	_, _ = m.Update(msg)
}

// TestFocusCyclesWide checks tab/shift-tab cycle through all four panes at a
// wide width: Workflows -> Models -> Detail -> Data -> Workflows.
func TestFocusCyclesWide(t *testing.T) {
	m := sampleModel()
	m.focus = PaneWorkflows
	want := []Pane{PaneModels, PaneDetail, PaneData, PaneWorkflows}
	for i, w := range want {
		press(m, tea.KeyTab, "")
		if m.focus != w {
			t.Fatalf("tab %d: focus=%v want %v", i+1, m.focus, w)
		}
	}
	// A full extra cycle returns to the start.
	press(m, tea.KeyTab, "")
	if m.focus != PaneModels {
		t.Fatalf("extra tab: focus=%v want Models", m.focus)
	}
}

// TestFocusCyclesNarrow checks hidden panes are skipped: at width 90 the
// Workflows pane (>=110) is hidden, so Models -> Detail -> Data -> Models.
func TestFocusCyclesNarrow(t *testing.T) {
	m := sampleModel()
	m.width = 90
	m.focus = PaneModels
	want := []Pane{PaneDetail, PaneData, PaneModels}
	for i, w := range want {
		press(m, tea.KeyTab, "")
		if m.focus != w {
			t.Fatalf("narrow tab %d: focus=%v want %v", i+1, m.focus, w)
		}
	}
}

// TestFocusCyclesVeryNarrow checks the Data pane is also dropped below 84.
func TestFocusCyclesVeryNarrow(t *testing.T) {
	m := sampleModel()
	m.width = 70
	m.focus = PaneModels
	want := []Pane{PaneDetail, PaneModels}
	for i, w := range want {
		press(m, tea.KeyTab, "")
		if m.focus != w {
			t.Fatalf("vnarrow tab %d: focus=%v want %v", i+1, m.focus, w)
		}
	}
}
