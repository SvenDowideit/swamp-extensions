//go:build integration

package ui

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

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
