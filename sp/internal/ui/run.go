package ui

import (
	"context"
	"encoding/json"
	"sort"
	"strconv"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/svendowideit/swamp-project/sp/internal/swamp"
)

// runField is one editable input in the run form.
type runField struct {
	key   string
	value string
	typ   string
}

// runEventMsg delivers one streamed run event.
type runEventMsg struct{ ev swamp.Event }

// runDoneMsg signals the terminal frame of a run.
type runDoneMsg struct{ err error }

// runAttachedMsg reports a run that could not be started (e.g. attach failed).
type runFailedMsg struct{ err error }

// startRunForm opens the input form (or starts immediately if there are none)
// for the currently selected workflow or model method.
func (m *Model) startRunForm() (tea.Model, tea.Cmd) {
	if m.rootName == "" {
		return m, nil
	}
	fields := m.inputFieldsFromSchema()
	if len(fields) == 0 {
		return m, m.startRun(nil)
	}
	m.inputOpen = true
	m.inputFields = fields
	m.inputSel = 0
	m.inputEditing = false
	return m, nil
}

// inputFieldsFromSchema builds editable fields from the root's declared inputs.
func (m *Model) inputFieldsFromSchema() []runField {
	if m.rootInputs == nil {
		return nil
	}
	props, _ := m.rootInputs["properties"].(map[string]any)
	if len(props) == 0 {
		return nil
	}
	required := map[string]bool{}
	for _, r := range asList(m.rootInputs["required"]) {
		required[str(r)] = true
	}
	keys := make([]string, 0, len(props))
	for k := range props {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	fields := make([]runField, 0, len(keys))
	for _, k := range keys {
		pm, _ := props[k].(map[string]any)
		typ := str(pm["type"])
		val := ""
		if def, ok := pm["default"]; ok {
			val = defaultString(def)
		}
		label := k
		if required[k] {
			label = k + " *"
		}
		fields = append(fields, runField{key: label, value: val, typ: typ})
	}
	return fields
}

// startResume re-enters a failed workflow run at a step (workflow.resume).
func (m *Model) startResume(from string) tea.Cmd {
	if m.rootKind != RootWorkflow || m.rootName == "" {
		return nil
	}
	client := m.client
	name := m.rootName
	runID := m.lastRunID

	m.runOpen = true
	m.runTitle = name
	m.runStatus = "resuming…"
	m.runID = ""
	m.runLines = []string{styleMuted.Render("resuming " + name + " from " + from + "…")}
	m.runScroll = 0
	m.runErr = nil
	m.runUnseen = false

	return func() tea.Msg {
		payload := map[string]any{"workflowIdOrName": name, "from": from, "skipAllReports": true}
		if runID != "" {
			payload["runId"] = runID
		}
		h, err := client.StartRun(context.Background(), swamp.ReqWorkflowResume, payload)
		if err != nil {
			return runFailedMsg{err: err}
		}
		return runStartedMsg{handle: h, kind: "workflow", name: name}
	}
}

// startRun starts a workflow run with the given inputs and opens the run
// console. inputs may be nil to use declared defaults.
func (m *Model) startRun(inputs map[string]any) tea.Cmd {
	client := m.client
	kind := "workflow"
	if m.rootKind != RootWorkflow {
		// Running an arbitrary model is out of scope for now; only workflows.
		m.status = "select a workflow to run"
		return nil
	}
	name := m.rootName

	m.runOpen = true
	m.runTitle = name
	m.runStatus = "starting…"
	m.runID = ""
	m.runLines = []string{styleMuted.Render("starting " + name + "…")}
	m.runScroll = 0
	m.runErr = nil
	m.runUnseen = false
	ctx := context.Background()

	return func() tea.Msg {
		payload := map[string]any{"workflowIdOrName": name, "skipAllReports": true}
		if len(inputs) > 0 {
			payload["inputs"] = inputs
		}
		h, err := client.StartRun(ctx, swamp.ReqWorkflowRun, payload)
		if err != nil {
			return runFailedMsg{err: err}
		}
		return runStartedMsg{handle: h, kind: kind, name: name}
	}
}

// runStartedMsg hands the live handle to the UI so it can drain events.
type runStartedMsg struct {
	handle *swamp.RunHandle
	kind   string
	name   string
}

// waitForRunEvent reads exactly one event (or the terminal error) from a
// handle. The UI re-issues it after each event so events stream in.
func waitForRunEvent(h *swamp.RunHandle) tea.Cmd {
	return func() tea.Msg {
		ev, ok := <-h.Events
		if !ok {
			// Events is closed only after the terminal error is buffered.
			return runDoneMsg{err: <-h.Errc}
		}
		return runEventMsg{ev: ev}
	}
}

// cancelRun aborts the active run.
func (m *Model) cancelRun() tea.Cmd {
	h := m.runHandle
	if h == nil {
		return nil
	}
	m.runStatus = "cancelling…"
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := h.Cancel(ctx); err != nil {
			return runFailedMsg{err: err}
		}
		return nil
	}
}

// appendRunEvent renders one event into the console's line buffer.
func (m *Model) appendRunEvent(ev swamp.Event) {
	switch ev.Kind {
	case "run.accepted":
		if id := ev.Str("runId"); id != "" {
			m.runID = id
		}
	case "validating_inputs":
		m.addRunLine("· validating inputs")
	case "evaluating_workflow":
		m.addRunLine("· evaluating workflow")
	case "started":
		m.runID = ev.Str("runId")
		m.runStatus = "running"
		m.addRunLine(styleGreen.Render("▶ started ") + ev.Str("workflowName"))
	case "job_started":
		m.addRunLine(styleKey.Render("job ") + ev.Str("jobId"))
	case "step_started":
		m.addRunLine("  " + styleKey.Render("→ "+ev.Str("stepId")))
	case "model_resolved":
		m.addRunLine("    " + styleMuted.Render(
			ev.Str("modelName")+"."+ev.Str("methodName")))
	case "method_executing":
		// covered by model_resolved
	case "method_output":
		stream := ev.Str("stream")
		prefix := "    "
		line := ev.Str("line")
		if stream == "stderr" {
			m.addRunLine(prefix + styleError.Render(line))
		} else {
			m.addRunLine(prefix + styleMuted.Render(line))
		}
	case "step_completed":
		m.addRunLine("  " + styleGreen.Render("✓ "+ev.Str("stepId")))
	case "step_failed":
		m.addRunLine("  " + styleError.Render("✗ "+ev.Str("stepId")+": "+ev.Str("error")))
	case "job_completed":
		st := ev.Str("status")
		if st == "succeeded" {
			m.addRunLine(styleGreen.Render("job " + ev.Str("jobId") + " " + st))
		} else {
			m.addRunLine(styleError.Render("job " + ev.Str("jobId") + " " + st))
		}
	case "completed":
		run, _ := ev.Raw["run"].(map[string]any)
		st := str(run["status"])
		m.runStatus = st
		if st == "succeeded" {
			m.addRunLine("", styleGreen.Render("■ run "+st))
		} else {
			m.addRunLine("", styleError.Render("■ run "+st))
		}
	default:
		m.addRunLine(styleMuted.Render("· " + ev.Kind))
	}
}

func (m *Model) addRunLine(parts ...string) {
	line := strings.Join(parts, "")
	// Guard against unbounded growth on chatty runs.
	const maxRunLines = 5000
	if len(m.runLines) >= maxRunLines {
		m.runLines = append(m.runLines[:0], m.runLines[len(m.runLines)-maxRunLines/2:]...)
	}
	m.runLines = append(m.runLines, line)
	m.runScroll = 1 << 30 // pin to bottom while running
}

// coerceRunInputs converts form fields to typed values using the input schema.
func (m *Model) coerceRunInputs() map[string]any {
	props, _ := m.rootInputs["properties"].(map[string]any)
	out := map[string]any{}
	for _, f := range m.inputFields {
		key := strings.TrimSuffix(f.key, " *")
		pm, _ := props[key].(map[string]any)
		out[key] = coerceValue(f.value, str(pm["type"]))
	}
	return out
}

// coerceValue converts the text form value to the JSON type named by typ.
func coerceValue(s, typ string) any {
	switch typ {
	case "integer":
		if n, err := strconv.Atoi(strings.TrimSpace(s)); err == nil {
			return n
		}
		return s
	case "number":
		if f, err := strconv.ParseFloat(strings.TrimSpace(s), 64); err == nil {
			return f
		}
		return s
	case "boolean":
		return strings.EqualFold(strings.TrimSpace(s), "true")
	case "array", "object":
		var v any
		if json.Unmarshal([]byte(s), &v) == nil {
			return v
		}
		return s
	default:
		return s
	}
}

func defaultString(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case nil:
		return ""
	default:
		b, _ := json.Marshal(t)
		return string(b)
	}
}

// runConsoleHints is the context key bar shown inside the run dialog.
func (m *Model) runConsoleHints() []hint {
	hs := []hint{
		h("↑↓", "scroll"),
	}
	if m.runBusy {
		hs = append(hs,
			h("c", "cancel run"),
			h("esc", "detach (keeps running)"),
		)
	} else {
		hs = append(hs, h("esc", "close"))
	}
	return hs
}
