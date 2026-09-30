package ui

import (
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/svendowideit/swamp-project/sp/internal/swamp"
)

func TestAppendRunEventRendersConsole(t *testing.T) {
	m := New(nil, "r", nil)
	m.width, m.height = 120, 30
	m.runOpen = true
	m.runTitle = "opencode-theme"
	m.runStatus = "running"
	for _, ev := range []swamp.Event{
		{Raw: map[string]any{"kind": "started", "runId": "abc12345-xxxx", "workflowName": "@x/y"}},
		{Raw: map[string]any{"kind": "job_started", "jobId": "main"}},
		{Raw: map[string]any{"kind": "step_started", "stepId": "install-theme"}},
		{Raw: map[string]any{"kind": "method_output", "line": "theme installed", "stream": "stdout"}},
		{Raw: map[string]any{"kind": "step_completed", "stepId": "install-theme"}},
		{Raw: map[string]any{"kind": "job_completed", "jobId": "main", "status": "succeeded"}},
		{Raw: map[string]any{"kind": "completed", "run": map[string]any{"status": "succeeded"}}},
	} {
		ev.Kind = ev.Raw["kind"].(string)
		m.appendRunEvent(ev)
	}
	if m.runID != "abc12345-xxxx" {
		t.Fatalf("runID=%q", m.runID)
	}
	if m.runStatus != "succeeded" {
		t.Fatalf("status=%q", m.runStatus)
	}
	out := strip(m.render())
	for _, want := range []string{"Run —", "install-theme", "theme installed", "succeeded"} {
		if !strings.Contains(out, want) {
			t.Errorf("console missing %q:\n%s", want, out)
		}
	}
}

func TestInputFormCoercion(t *testing.T) {
	m := New(nil, "r", nil)
	m.width, m.height = 120, 30
	m.inputOpen = true
	m.rootInputs = map[string]any{
		"properties": map[string]any{
			"path":     map[string]any{"type": "string"},
			"deep":     map[string]any{"type": "boolean"},
			"minBytes": map[string]any{"type": "integer"},
			"tags":     map[string]any{"type": "array"},
		},
	}
	m.inputFields = []runField{
		{key: "deep", value: "true", typ: "boolean"},
		{key: "minBytes", value: "1024", typ: "integer"},
		{key: "path", value: "/tmp", typ: "string"},
		{key: "tags *", value: `["a","b"]`, typ: "array"},
	}
	got := m.coerceRunInputs()
	if got["deep"] != true {
		t.Errorf("deep=%v", got["deep"])
	}
	if got["minBytes"] != 1024 {
		t.Errorf("minBytes=%v", got["minBytes"])
	}
	if got["path"] != "/tmp" {
		t.Errorf("path=%v", got["path"])
	}
	tags, ok := got["tags"].([]any)
	if !ok || len(tags) != 2 {
		t.Errorf("tags=%v", got["tags"])
	}
}

// TestRunDialogFitsAndShowsHelp ensures the dialog is smaller than the screen
// and the browser's context help bar stays visible beneath it.
func TestRunDialogFitsAndShowsHelp(t *testing.T) {
	for _, size := range [][2]int{{90, 28}, {120, 34}, {200, 50}} {
		m := New(nil, "r", nil)
		m.width, m.height = size[0], size[1]
		m.workflows = []node{{label: "wf", sub: "1 jobs · 1 steps"}}
		m.runOpen = true
		m.runBusy = true
		m.runTitle = "wf"
		m.runStatus = "running"
		for i := 0; i < 100; i++ {
			m.runLines = append(m.runLines, "line")
		}
		out := strip(m.render())
		lines := strings.Split(out, "\n")
		if len(lines) >= m.height {
			t.Errorf("%dx%d: rendered %d lines >= height", size[0], size[1], len(lines))
		}
		// The context key bar is the last line and must still be there.
		if last := lines[len(lines)-1]; !strings.Contains(last, "[") {
			t.Errorf("%dx%d: context help bar not visible under dialog: %q", size[0], size[1], last)
		}
		// The dialog has a scrollbar for the overflowing event log.
		if !strings.Contains(out, "█") {
			t.Errorf("%dx%d: run dialog missing scrollbar", size[0], size[1])
		}
	}
}

// TestDetachKeepsRunHandle verifies closing the dialog while busy does not
// discard the handle (so it keeps draining and can be reopened).
func TestDetachKeepsRunHandle(t *testing.T) {
	m := sampleModel()
	m.runOpen = true
	m.runBusy = true
	m.runHandle = &swamp.RunHandle{}
	m.runTitle = "wf"
	m.runStatus = "running"

	// esc detaches.
	_, _ = m.handleRunKey(tea.KeyPressMsg(tea.Key{Code: tea.KeyEscape}))
	if m.runOpen {
		t.Fatalf("esc should close the dialog")
	}
	if m.runHandle == nil || !m.runBusy {
		t.Fatalf("detach must keep the handle and busy state")
	}

	// 'o' reopens it.
	press(m, 'o', "o")
	if !m.runOpen {
		t.Fatalf("'o' should reopen the run dialog")
	}
}

// TestQuitConfirmFlow checks that quitting while a run is active prompts, and
// that detach does not stop an owned serve.
func TestQuitConfirmFlow(t *testing.T) {
	m := sampleModel()
	m.runBusy = true
	m.runStatus = "running"
	m.runTitle = "wf"

	press(m, 'q', "q")
	if !m.quitConfirm {
		t.Fatalf("quitting with an active run should prompt")
	}
	// esc stays.
	press(m, tea.KeyEscape, "")
	if m.quitConfirm {
		t.Fatalf("esc should dismiss the prompt")
	}

	// detach & quit must not call stopServe; a nil serve is safe here.
	m.quitConfirm = true
	_, cmd := m.handleQuitConfirmKey(tea.KeyPressMsg(tea.Key{Code: 'd', Text: "d"}))
	if cmd == nil {
		t.Fatalf("detach should return a quit command")
	}
}

// TestRunUnseenFlagsResult verifies a terminal run while detached marks a
// result to surface in the header.
func TestRunUnseenFlagsResult(t *testing.T) {
	m := sampleModel()
	m.runOpen = false
	m.runBusy = true
	m.runStatus = "running"
	m.Update(runDoneMsg{err: nil})
	if !m.runUnseen {
		t.Fatalf("a finished-but-unseen run should be flagged")
	}
	out := strip(m.render())
	if !strings.Contains(out, "results") {
		t.Fatalf("header should advertise unseen run results:\n%s", firstLine(out))
	}
	// Opening clears it.
	press(m, 'o', "o")
	if m.runUnseen {
		t.Fatalf("opening the run should clear the unseen flag")
	}
}
