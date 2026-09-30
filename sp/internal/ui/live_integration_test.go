//go:build integration

package ui

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/svendowideit/swamp-project/sp/internal/swamp"
)

// TestLiveWorkflowBrowser drives the real model against a running swamp serve:
// it loads the top-level lists, selects a workflow that has produced data, and
// checks the rendered Detail (DAG) and Data panes. Start a server first:
//
//	swamp serve --port 9090 --no-schedule
//	SP_SERVER=ws://127.0.0.1:9090 go test -tags integration ./internal/ui/
func TestLiveWorkflowBrowser(t *testing.T) {
	server := os.Getenv("SP_SERVER")
	if server == "" {
		server = "ws://127.0.0.1:9090"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	client, err := swamp.Dial(ctx, server, "")
	if err != nil {
		t.Skipf("no server at %s: %v", server, err)
	}
	defer client.Close()

	m := New(client, "live", nil)
	m.width, m.height = 160, 45

	// Feed real workflow + model lists through Update exactly as the program
	// would.
	wmsg := m.loadWorkflows()().(workflowsLoadedMsg)
	if wmsg.err != nil {
		t.Fatalf("loadWorkflows: %v", wmsg.err)
	}
	if len(wmsg.workflows) == 0 {
		t.Skip("no workflows in repo")
	}
	m.Update(wmsg)

	mmsg := m.loadModels()().(modelsLoadedMsg)
	if mmsg.err != nil {
		t.Fatalf("loadModels: %v", mmsg.err)
	}
	m.Update(mmsg)

	if !m.bootstrapped {
		t.Fatalf("model did not bootstrap after both lists loaded")
	}

	// Find a workflow that has produced data (has at least one run).
	var chosen string
	for _, w := range m.visibleWorkflows() {
		items := workflowDataItems(ctx, client, w.label)
		if len(items) > 0 {
			chosen = w.label
			break
		}
	}
	if chosen == "" {
		t.Skip("no workflow with data to inspect")
	}

	// Select it and apply the resulting detail message.
	for i, w := range m.workflows {
		if w.label == chosen {
			m.wfSel = i
		}
	}
	dmsg := m.selectWorkflow()().(detailLoadedMsg)
	if dmsg.err != nil {
		t.Fatalf("selectWorkflow(%s): %v", chosen, dmsg.err)
	}
	m.Update(dmsg)

	if m.rootKind != RootWorkflow || m.rootName != chosen {
		t.Fatalf("root=%v/%q want workflow %q", m.rootKind, m.rootName, chosen)
	}
	if len(m.dataItems) == 0 {
		t.Fatalf("workflow %q detail produced no data items", chosen)
	}

	out := strip(m.render())
	if !strings.Contains(out, "Jobs (") {
		t.Errorf("rendered detail missing job DAG:\n%s", out)
	}
	if !strings.Contains(out, chosen) {
		t.Errorf("rendered output missing workflow name %q", chosen)
	}

	// Drill into the first data item and confirm content is fetched.
	m.focus = PaneData
	m.dataSel = 0
	item := m.dataItems[0]
	cmsg := m.loadDataContent(m.rootKind, m.rootName, item.label, m.width)().(detailLoadedMsg)
	if cmsg.err != nil {
		t.Fatalf("loadDataContent(%s/%s): %v", chosen, item.label, cmsg.err)
	}
	m.Update(cmsg)
	if strings.Contains(strip(strings.Join(m.detailLines, "\n")), "data.get:") {
		t.Fatalf("data content failed to load for %s/%s", chosen, item.label)
	}
}

// TestLiveRunOutputsAndViewer selects a workflow with a recorded run, opens
// each of that run's outputs through the viewer, and asserts real content is
// rendered — including HTML when the workflow produced a file artifact.
//
//	swamp serve --port 9090 --no-schedule &
//	SP_SERVER=ws://127.0.0.1:9090 go test -tags integration -run TestLiveRunOutputsAndViewer ./internal/ui/
func TestLiveRunOutputsAndViewer(t *testing.T) {
	server := os.Getenv("SP_SERVER")
	if server == "" {
		server = "ws://127.0.0.1:9090"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()

	client, err := swamp.Dial(ctx, server, "")
	if err != nil {
		t.Skipf("no server at %s: %v", server, err)
	}
	defer client.Close()

	wfs, err := client.SearchWorkflows(ctx, "")
	if err != nil {
		t.Fatalf("workflow.search: %v", err)
	}
	var names []string
	for _, r := range asList(wfs["results"]) {
		if m, ok := r.(map[string]any); ok {
			names = append(names, str(m["name"]))
		}
	}

	m := New(client, "live", nil)
	m.width, m.height = 160, 45

	// Find a workflow whose latest run exposes an output that can still be
	// opened (older runs often had their data garbage-collected). Prefer one
	// with an HTML file so the HTML path is exercised.
	var chosen, fallback string
	for _, name := range names {
		runs, err := client.SearchWorkflowRuns(ctx, name, 1)
		if err != nil || len(runs) == 0 {
			continue
		}
		det, err := client.GetWorkflowRun(ctx, runs[0].RunID)
		if err != nil {
			continue
		}
		outs := outputsFromRun(det)
		if len(outs) == 0 {
			continue
		}
		if fallback == "" {
			fallback = name
		}
		html := false
		live := false
		for _, o := range outs {
			if o.contentType == "text/html" || strings.HasSuffix(o.name, ".html") {
				html = true
			}
			if _, err := client.GetDataScoped(ctx, false, o.modelName, o.name, o.version); err == nil {
				live = true
			}
		}
		if live {
			chosen = name
			if html {
				break // best case: live and HTML
			}
		}
	}
	if chosen == "" {
		chosen = fallback
	}
	if chosen == "" {
		t.Skip("no workflow with a recorded run output")
	}

	for _, name := range names {
		m.workflows = append(m.workflows, node{label: name, kind: "workflow"})
	}
	for i, n := range m.workflows {
		if n.label == chosen {
			m.wfSel = i
		}
	}
	dmsg := m.selectWorkflow()().(detailLoadedMsg)
	if dmsg.err != nil {
		t.Fatalf("selectWorkflow(%s): %v", chosen, dmsg.err)
	}
	m.Update(dmsg)
	if len(m.detailLinks) == 0 {
		t.Fatalf("workflow %q produced no selectable run outputs", chosen)
	}
	if !strings.Contains(strip(strings.Join(m.detailLines, "\n")), "Recent runs") {
		t.Fatalf("detail lines missing recent runs")
	}

	// Focusing the Detail pane and moving selects an output; the rendered pane
	// must then highlight it (the selected row is drawn in reverse video).
	m.focus = PaneDetail
	m.detailScroll = 0
	press(m, tea.KeyDown, "")
	if m.detailSel != 0 {
		t.Fatalf("down in detail should select the first output, got %d", m.detailSel)
	}

	// Open each output and confirm the viewer populates without a hard error.
	// Older runs may list artifacts whose data was garbage-collected; those
	// render an explanatory placeholder rather than an error.
	var htmlSeen bool
	var opened, gone int
	limit := len(m.detailLinks)
	if limit > 30 {
		limit = 30
	}
	for i, lk := range m.detailLinks[:limit] {
		msg := m.openArtifact(lk)()
		al, ok := msg.(artifactLoadedMsg)
		if !ok {
			t.Fatalf("openArtifact(%d) returned %T", i, msg)
		}
		if al.err != nil {
			t.Fatalf("viewer transport error for %s/%s: %v", lk.artifact.modelName, lk.artifact.name, al.err)
		}
		m.Update(al)
		if len(m.viewLines) == 0 {
			t.Fatalf("viewer empty for %s", lk.artifact.name)
		}
		if strings.Contains(strip(strings.Join(al.lines, "\n")), "no longer available") {
			gone++
			continue
		}
		opened++
		if al.kind == "html" {
			htmlSeen = true
			if len(al.lines) < 2 {
				t.Fatalf("html render produced too few lines: %v", al.lines)
			}
		}
	}
	if opened == 0 {
		t.Fatalf("workflow %q: no output could actually be opened", chosen)
	}
	t.Logf("%s: opened %d outputs (%d gc'd), html=%v", chosen, opened, gone, htmlSeen)
}

// TestLivePlayground runs real CEL queries through the Playground: a record
// query (no select), a projection, and a syntax error.
//
//	swamp serve --port 9090 --no-schedule &
//	SP_SERVER=ws://127.0.0.1:9090 go test -tags integration -run TestLivePlayground ./internal/ui/
func TestLivePlayground(t *testing.T) {
	server := os.Getenv("SP_SERVER")
	if server == "" {
		server = "ws://127.0.0.1:9090"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	client, err := swamp.Dial(ctx, server, "")
	if err != nil {
		t.Skipf("no server at %s: %v", server, err)
	}
	defer client.Close()

	m := New(client, "live", nil)
	m.width, m.height = 140, 40
	m.pgOpen = true

	// Record query: every data item is a selectable row.
	m.pgPred = "size >= 0"
	msg := m.runPlayground()()
	if _, ok := msg.(pgResultMsg); !ok {
		t.Fatalf("runPlayground returned %T", msg)
	}
	m.Update(msg)
	if m.pgErr != nil {
		t.Fatalf("record query: %v", m.pgErr)
	}
	if len(m.pgRows) == 0 {
		t.Fatalf("record query returned no rows")
	}
	first := m.pgRows[0]
	if first.modelName == "" || first.name == "" {
		t.Fatalf("record row missing model/name: %+v", first)
	}
	out := strip(m.render())
	if !strings.Contains(out, "Playground") || !strings.Contains(out, "data.query") {
		t.Fatalf("playground not rendered:\n%s", out)
	}

	// Projection query: a list shape renders as a table.
	m.pgSelect = "[modelName, name, string(version), dataType]"
	m.Update(m.runPlayground()())
	if m.pgErr != nil {
		t.Fatalf("projection query: %v", m.pgErr)
	}
	if m.pgResult == nil || m.pgResult.Projected == nil || m.pgResult.Projected.Shape != "list" {
		t.Fatalf("expected a list projection, got %+v", m.pgResult)
	}

	// Scalar projection.
	m.pgSelect = "name"
	m.Update(m.runPlayground()())
	if m.pgResult.Projected.Shape != "scalar" || len(m.pgResult.Projected.Values) == 0 {
		t.Fatalf("expected scalar values, got %+v", m.pgResult.Projected)
	}

	// Syntax error surfaces the server's message, not a panic.
	m.pgSelect = ""
	m.pgPred = "this is not valid !!"
	m.Update(m.runPlayground()())
	if m.pgErr == nil {
		t.Fatalf("expected a CEL syntax error")
	}
	if !strings.Contains(strip(strings.Join(m.pgErrorLines(), "\n")), "Unexpected") {
		t.Fatalf("error not surfaced: %v", m.pgErr)
	}

	// Opening a record row fetches real content into the viewer.
	m.pgPred = "size >= 0"
	m.pgSelect = ""
	m.Update(m.runPlayground()())
	for i, r := range m.pgRows {
		if r.contentType == "text/markdown" || strings.HasSuffix(r.name, ".md") {
			m.pgRowSel = i
			break
		}
	}
	al := m.openPlaygroundRow()()
	if _, ok := al.(artifactLoadedMsg); !ok {
		t.Fatalf("openPlaygroundRow returned %T", al)
	}
	m.Update(al)
	if len(m.viewLines) == 0 {
		t.Fatalf("viewer empty for playground row")
	}
	t.Logf("playground ok: rows=%d", len(m.pgRows))
}

// TestLiveRunStreaming starts a real workflow run over the protocol and drains
// its events through the UI's Update loop, asserting the console reaches a
// terminal state with rendered step output.
//
//	swamp serve --port 9090 --no-schedule &
//	SP_SERVER=ws://127.0.0.1:9090 go test -tags integration -run TestLiveRunStreaming ./internal/ui/
func TestLiveRunStreaming(t *testing.T) {
	server := os.Getenv("SP_SERVER")
	if server == "" {
		server = "ws://127.0.0.1:9090"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	client, err := swamp.Dial(ctx, server, "")
	if err != nil {
		t.Skipf("no server at %s: %v", server, err)
	}
	defer client.Close()

	m := New(client, "live", nil)
	m.width, m.height = 140, 40
	// Pick a fast, side-effect-light workflow if present.
	m.rootKind = RootWorkflow
	m.rootName = "@svendowideit/opencode-theme"

	cmd := m.startRun(nil)
	if cmd == nil {
		t.Skip("startRun produced no command")
	}

	// Drive the real event loop: each message may schedule the next.
	deadline := time.Now().Add(80 * time.Second)
	msg := cmd()
	var steps int
	for msg != nil {
		if time.Now().After(deadline) {
			t.Fatalf("run did not finish; status=%q lines=%d", m.runStatus, len(m.runLines))
		}
		_, next := m.Update(msg)
		steps++
		if next == nil {
			break
		}
		msg = next()
		if m.runStatus == "succeeded" || m.runStatus == "failed" || m.runStatus == "error" {
			// Drain a few more frames so the terminal event is applied.
			for i := 0; i < 3 && msg != nil; i++ {
				_, n := m.Update(msg)
				if n == nil {
					msg = nil
					break
				}
				msg = n()
			}
			break
		}
	}

	if m.runStatus != "succeeded" {
		t.Fatalf("run status=%q (err=%v) lines=\n%s", m.runStatus, m.runErr,
			strip(strings.Join(m.runLines, "\n")))
	}
	out := strip(m.render())
	if !strings.Contains(out, "Run —") || !strings.Contains(out, "succeeded") {
		t.Fatalf("console did not render a successful run:\n%s", out)
	}
	t.Logf("drained %d messages, %d console lines", steps, len(m.runLines))
}

// TestLiveResumeRendersFailedStep confirms a workflow with a failed run shows
// its recent runs and exposes the failed step for resume.
//
//	swamp serve --port 9090 --no-schedule &
//	SP_SERVER=ws://127.0.0.1:9090 go test -tags integration -run TestLiveResumeRendersFailedStep ./internal/ui/
func TestLiveResumeRendersFailedStep(t *testing.T) {
	server := os.Getenv("SP_SERVER")
	if server == "" {
		server = "ws://127.0.0.1:9090"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	client, err := swamp.Dial(ctx, server, "")
	if err != nil {
		t.Skipf("no server at %s: %v", server, err)
	}
	defer client.Close()

	m := New(client, "live", nil)
	m.width, m.height = 140, 40
	wmsg := m.loadWorkflows()().(workflowsLoadedMsg)
	if wmsg.err != nil {
		t.Fatalf("loadWorkflows: %v", wmsg.err)
	}
	m.workflows = wmsg.workflows

	// Find a workflow whose latest run failed and recorded a failed step.
	var chosen string
	for _, w := range m.workflows {
		runs, err := client.SearchWorkflowRuns(ctx, w.label, 1)
		if err != nil || len(runs) == 0 {
			continue
		}
		if runs[0].FailedStep != "" {
			chosen = w.label
			break
		}
	}
	if chosen == "" {
		t.Skip("no workflow with a failed step in recent history")
	}

	for i, w := range m.workflows {
		if w.label == chosen {
			m.wfSel = i
		}
	}
	dmsg := m.selectWorkflow()().(detailLoadedMsg)
	m.Update(dmsg)

	if m.lastFailedStep == "" {
		t.Fatalf("workflow %q has a failed run but lastFailedStep is empty", chosen)
	}
	if m.lastRunID == "" {
		t.Fatalf("expected a lastRunID for %q", chosen)
	}
	out := strip(m.render())
	if !strings.Contains(out, "Recent runs") {
		t.Fatalf("detail missing recent runs:\n%s", out)
	}
	t.Logf("%s: last failed step %q", chosen, m.lastFailedStep)
}
