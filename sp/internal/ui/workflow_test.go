package ui

import (
	"testing"

	tea "charm.land/bubbletea/v2"
)

// TestBootstrapPrefersWorkflow verifies that once both top-level lists have
// loaded, the initial root is a workflow and its DAG is requested.
func TestBootstrapPrefersWorkflow(t *testing.T) {
	m := New(nil, "r", nil)
	m.width, m.height = 140, 40

	// Workflows arrive first: no bootstrap yet (models not loaded).
	_, cmd := m.Update(workflowsLoadedMsg{workflows: []node{
		{label: "@x/wf", sub: "1 jobs · 2 steps", kind: "workflow"},
	}})
	if cmd != nil {
		t.Fatalf("should not bootstrap before models load")
	}
	if m.bootstrapped {
		t.Fatalf("bootstrapped too early")
	}

	// Models arrive: now bootstrap selects the workflow.
	_, cmd = m.Update(modelsLoadedMsg{models: []node{
		{label: "m1", sub: "@x/type", kind: "model"},
	}})
	if !m.bootstrapped {
		t.Fatalf("did not bootstrap after both loaded")
	}
	if m.focus != PaneWorkflows {
		t.Fatalf("focus=%v want Workflows", m.focus)
	}
	if cmd == nil {
		t.Fatalf("expected a selectWorkflow command")
	}
}

// TestBootstrapFallsBackToModel covers a repo with no workflows.
func TestBootstrapFallsBackToModel(t *testing.T) {
	m := New(nil, "r", nil)
	m.width, m.height = 140, 40
	m.Update(workflowsLoadedMsg{workflows: nil})
	_, cmd := m.Update(modelsLoadedMsg{models: []node{
		{label: "m1", sub: "@x/type", kind: "model"},
	}})
	if !m.bootstrapped {
		t.Fatalf("did not bootstrap")
	}
	if m.focus != PaneModels {
		t.Fatalf("focus=%v want Models", m.focus)
	}
	if cmd == nil {
		t.Fatalf("expected a selectModel command")
	}
}

// TestWorkflowRootDrivesDetailAndData checks a workflow detail sets the root
// and that the Data pane then carries workflow data.
func TestWorkflowRootDrivesDetailAndData(t *testing.T) {
	m := sampleModel()
	m.Update(detailLoadedMsg{
		title: "caddy-ensure-proxy", root: RootWorkflow, name: "caddy-ensure-proxy",
		lines: []string{"name caddy-ensure-proxy"},
		items: []node{{label: "current", sub: "resource v50", kind: "data"}},
	})
	if m.rootKind != RootWorkflow || m.rootName != "caddy-ensure-proxy" {
		t.Fatalf("root not set: kind=%v name=%q", m.rootKind, m.rootName)
	}
	if len(m.dataItems) != 1 {
		t.Fatalf("workflow data not stored: %+v", m.dataItems)
	}
}

// TestEnterOnDataOpensContentFromWorkflowRoot verifies the data drill-down uses
// the workflow root (not a model name).
func TestEnterOnDataOpensContentFromWorkflowRoot(t *testing.T) {
	m := sampleModel()
	m.rootKind = RootWorkflow
	m.rootName = "@svendowideit/tuios-install"
	m.dataItems = []node{{label: "current", sub: "resource v50", kind: "data"}}
	m.focus = PaneData
	_, cmd := m.Update(tea.KeyPressMsg(tea.Key{Code: tea.KeyEnter}))
	if cmd == nil {
		t.Fatalf("enter on data should issue a load command")
	}
}

// TestEscReturnsToOwningPane checks esc goes back to Workflows for a workflow
// root (at a width where that pane is visible) and Models otherwise.
func TestEscReturnsToOwningPane(t *testing.T) {
	m := sampleModel()
	m.width = 140
	m.rootKind = RootWorkflow
	m.focus = PaneDetail
	press(m, tea.KeyEscape, "")
	if m.focus != PaneWorkflows {
		t.Fatalf("esc from workflow root: focus=%v want Workflows", m.focus)
	}

	m.rootKind = RootModel
	m.focus = PaneDetail
	press(m, tea.KeyEscape, "")
	if m.focus != PaneModels {
		t.Fatalf("esc from model root: focus=%v want Models", m.focus)
	}
}
