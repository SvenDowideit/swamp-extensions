package ui

import (
	"strings"
	"testing"

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
