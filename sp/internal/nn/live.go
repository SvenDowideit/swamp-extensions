package nn

import (
	"fmt"
	"strings"

	"github.com/svendowideit/swamp-project/sp/internal/swamp"
)

// liveState is the item UI for a run in progress: a paging log that updates in
// place. A run is not a modal — it is an item that happens to still be moving.
type liveState struct {
	workflow string
	runID    string
	status   string
	lines    []string
	scroll   int // 0 pins to the bottom while running
	err      error
	done     bool
}

// newLive starts a live view for a workflow run.
func newLive(workflow string) *liveState {
	return &liveState{
		workflow: workflow,
		status:   "starting…",
		lines:    []string{styleDim.Render("starting " + workflow + "…")},
	}
}

// appendEvent renders one streamed run event as a log line.
func (l *liveState) appendEvent(ev swamp.Event) {
	switch ev.Kind {
	case "run.accepted":
		if id := ev.Str("runId"); id != "" {
			l.runID = id
		}
	case "validating_inputs":
		l.add(styleDim.Render("· validating inputs"))
	case "evaluating_workflow":
		l.add(styleDim.Render("· evaluating workflow"))
	case "resolving_model":
		l.add(styleDim.Render("· resolving model"))
	case "evaluating_expressions":
		l.add(styleDim.Render("· evaluating expressions"))
	case "executing":
		l.add(styleDim.Render("· executing " + ev.Str("methodName")))
	case "started":
		l.runID = ev.Str("runId")
		l.status = "running"
		l.add(styleGreenS.Render("▶ started ") + ev.Str("workflowName"))
	case "job_started":
		l.add(styleAccent.Render("job ") + ev.Str("jobId"))
	case "step_started":
		l.add("  " + styleAccent.Render("→ "+ev.Str("stepId")))
	case "model_resolved":
		l.add("    " + styleDim.Render(ev.Str("modelName")+"."+ev.Str("methodName")))
	case "method_output":
		line := ev.Str("line")
		if ev.Str("stream") == "stderr" {
			l.add("    " + styleErr.Render(line))
		} else {
			l.add("    " + styleDim.Render(line))
		}
	case "step_completed":
		l.add("  " + styleGreenS.Render("✓ "+ev.Str("stepId")))
	case "step_failed":
		l.add("  " + styleErr.Render("✗ "+ev.Str("stepId")+": "+ev.Str("error")))
	case "job_completed":
		st := ev.Str("status")
		if st == "succeeded" {
			l.add(styleGreenS.Render("job " + ev.Str("jobId") + " " + st))
		} else {
			l.add(styleErr.Render("job " + ev.Str("jobId") + " " + st))
		}
	case "completed":
		// Workflow runs report a completed `run` object; method runs report the
		// status inline. Accept both rather than guessing one shape.
		run, _ := ev.Raw["run"].(map[string]any)
		st := scalar(run["status"])
		if st == "" {
			st = ev.Str("status")
		}
		l.status = st
		l.done = true
		if st == "succeeded" {
			l.add("", styleGreenS.Render("■ run "+st))
		} else {
			l.add("", styleErr.Render("■ run "+st))
		}
	default:
		l.add(styleDim.Render("· " + ev.Kind))
	}
}

// add appends a line (or a blank + line) and pins the view to the bottom.
func (l *liveState) add(parts ...string) {
	line := strings.Join(parts, "")
	const maxLines = 5000
	if len(l.lines) >= maxLines {
		l.lines = append(l.lines[:0], l.lines[len(l.lines)-maxLines/2:]...)
	}
	l.lines = append(l.lines, line)
	l.scroll = 1 << 30
}

// finish records the terminal result.
func (l *liveState) finish(err error) {
	l.done = true
	if err != nil {
		l.err = err
		if l.status == "" || l.status == "running" {
			l.status = "error"
		}
		l.add(styleErr.Render("! " + err.Error()))
	}
	if l.status == "" || l.status == "running" {
		// A clean terminal frame with no reported status is a success.
		if err == nil {
			l.status = "succeeded"
		} else {
			l.status = "error"
		}
	}
}

// render draws the visible tail of the log.
func (l *liveState) render(width, height int) []string {
	if height < 1 {
		height = 1
	}
	start := len(l.lines) - height
	if start < 0 {
		start = 0
	}
	if l.scroll < start {
		l.scroll = start
	}
	out := make([]string, 0, height)
	for i := start; i < len(l.lines) && len(out) < height; i++ {
		out = append(out, fit(l.lines[i], width))
	}
	if len(out) == 0 {
		out = append(out, styleDim.Render("(no output yet)"))
	}
	return out
}

// header is the one-line run status.
func (l *liveState) header(width int) string {
	badge := styleOrangeS.Render("▶ running")
	if l.done {
		if l.status == "succeeded" || l.status == "ok" {
			badge = styleGreenS.Render("✓ " + l.status)
		} else {
			badge = styleErr.Render("✗ " + l.status)
		}
	}
	id := l.runID
	if len(id) > 8 {
		id = id[:8]
	}
	right := fmt.Sprintf("%s  %s", l.workflow, id)
	return styleTitle.Render("run ") + badge + " " + styleDim.Render(fit(right, width-12))
}
