package ui

import (
	"testing"

	tea "charm.land/bubbletea/v2"
)

func press(m *Model, code rune, text string) {
	msg := tea.KeyPressMsg(tea.Key{Code: code, Text: text})
	_, _ = m.Update(msg)
}

func TestFocusCycles(t *testing.T) {
	m := sampleModel()
	// tab
	press(m, tea.KeyTab, "")
	if m.focus != PaneDetail {
		t.Fatalf("after tab focus=%v want Detail", m.focus)
	}
	press(m, tea.KeyTab, "")
	if m.focus != PaneData {
		t.Fatalf("after 2nd tab focus=%v want Data", m.focus)
	}
	// l
	press(m, 'l', "l")
	if m.focus != PaneModels {
		t.Fatalf("after 3rd tab focus=%v want Models", m.focus)
	}
}
