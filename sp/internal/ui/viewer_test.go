package ui

import (
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
)

// detailWithOutputs builds a model whose Detail pane has selectable run outputs.
func detailWithOutputs() *Model {
	m := sampleModel()
	m.focus = PaneDetail
	m.rootKind = RootWorkflow
	m.rootName = "pulse"
	m.Update(detailLoadedMsg{
		title: "pulse", root: RootWorkflow, name: "pulse",
		lines: []string{
			"name pulse",
			"",
			"Recent runs (1)",
			"  ● succeeded  01-02T03:04  1/1 steps  9ms",
			"      ◆ store  [pulse v5]",
			"      ▤ report @swamp/workflow-summary  [render · pulse v3]",
			"      ◫ index.html  [render · pulse v21]",
		},
		links: []detailLink{
			{line: 4, plain: "      ◆ store  [pulse v5]", artifact: runOutput{kind: "resource", name: "store", modelName: "pulse", version: 5}, runID: "abc"},
			{line: 5, plain: "      ▤ report @swamp/workflow-summary  [render · pulse v3]", artifact: runOutput{kind: "report", name: "report-swamp-workflow-summary", modelName: "pulse", version: 3, reportName: "@swamp/workflow-summary", contentType: "text/markdown"}, runID: "abc"},
			{line: 6, plain: "      ◫ index.html  [render · pulse v21]", artifact: runOutput{kind: "file", name: "index.html", modelName: "pulse", version: 21, contentType: "text/html"}, runID: "abc"},
		},
	})
	return m
}

func TestDetailSelectionMovesThroughOutputs(t *testing.T) {
	m := detailWithOutputs()
	if len(m.detailLinks) != 3 {
		t.Fatalf("expected 3 links, got %d", len(m.detailLinks))
	}
	if m.detailSel != -1 {
		t.Fatalf("selection should start cleared, got %d", m.detailSel)
	}
	press(m, tea.KeyDown, "")
	if m.detailSel != 0 {
		t.Fatalf("first down should select 0, got %d", m.detailSel)
	}
	press(m, tea.KeyDown, "")
	press(m, tea.KeyDown, "")
	if m.detailSel != 2 {
		t.Fatalf("expected selection at last link, got %d", m.detailSel)
	}
	// Clamp at the end.
	press(m, tea.KeyDown, "")
	if m.detailSel != 2 {
		t.Fatalf("selection should clamp at end, got %d", m.detailSel)
	}
	press(m, tea.KeyUp, "")
	if m.detailSel != 1 {
		t.Fatalf("expected selection 1, got %d", m.detailSel)
	}
}

func TestEnterOpensViewerForSelectedOutput(t *testing.T) {
	m := detailWithOutputs()
	m.detailSel = 2 // index.html
	_, cmd := m.Update(tea.KeyPressMsg(tea.Key{Code: tea.KeyEnter}))
	if !m.viewOpen {
		t.Fatalf("enter on a selected output should open the viewer")
	}
	if m.viewKind != "html" {
		t.Fatalf("index.html should open as html, got %q", m.viewKind)
	}
	if cmd == nil {
		t.Fatalf("opening the viewer should issue a load command")
	}
}

func TestViewerKeysScrollAndClose(t *testing.T) {
	m := detailWithOutputs()
	m.viewOpen = true
	m.viewKind = "markdown"
	m.viewTitle = "report"
	m.viewLines = make([]string, 100)
	for i := range m.viewLines {
		m.viewLines[i] = "line"
	}
	m.Update(tea.KeyPressMsg(tea.Key{Code: tea.KeyDown}))
	if m.viewScroll != 1 {
		t.Fatalf("down should scroll by 1, got %d", m.viewScroll)
	}
	m.Update(tea.KeyPressMsg(tea.Key{Code: tea.KeyPgDown}))
	if m.viewScroll != 11 {
		t.Fatalf("pgdown should scroll by 10, got %d", m.viewScroll)
	}
	m.Update(tea.KeyPressMsg(tea.Key{Code: tea.KeyEscape}))
	if m.viewOpen {
		t.Fatalf("esc should close the viewer")
	}
}

func TestViewerRendersContentAndScrollbar(t *testing.T) {
	m := sampleModel()
	m.width, m.height = 120, 30
	m.viewOpen = true
	m.viewKind = "markdown"
	m.viewTitle = "report x v3"
	for i := 0; i < 120; i++ {
		m.viewLines = append(m.viewLines, "content line")
	}
	out := strip(m.render())
	if !strings.Contains(out, "report x v3") {
		t.Fatalf("viewer title missing:\n%s", out)
	}
	if !strings.Contains(out, "[markdown]") {
		t.Fatalf("viewer kind tag missing:\n%s", out)
	}
	if !strings.Contains(out, "█") {
		t.Fatalf("viewer should show a scrollbar for overflowing content")
	}
	if !strings.Contains(out, "[models]") {
		t.Fatalf("browser context bar should still be visible under the viewer")
	}
}

func TestArtifactLoadedMsgPopulatesViewer(t *testing.T) {
	m := detailWithOutputs()
	m.viewOpen = true
	m.viewLoading = true
	m.Update(artifactLoadedMsg{title: "t", kind: "html", lines: []string{"a", "b"}})
	if m.viewLoading {
		t.Fatalf("loading should clear")
	}
	if len(m.viewLines) != 2 || m.viewKind != "html" {
		t.Fatalf("viewer not populated: kind=%q lines=%v", m.viewKind, m.viewLines)
	}
}

func TestArtifactLoadedErrorIsShown(t *testing.T) {
	m := detailWithOutputs()
	m.viewOpen = true
	m.viewLoading = true
	m.Update(artifactLoadedMsg{err: errTest{}, kind: "text"})
	if m.viewErr == nil {
		t.Fatalf("expected the error to be recorded")
	}
	if !strings.Contains(strip(strings.Join(m.viewLines, "\n")), "boom") {
		t.Fatalf("error not rendered: %v", m.viewLines)
	}
}
