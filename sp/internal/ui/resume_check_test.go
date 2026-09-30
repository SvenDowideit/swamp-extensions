//go:build integration

package ui

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/svendowideit/swamp-project/sp/internal/swamp"
)

// TestLiveResumeEndpointExists confirms workflow.resume is a real request type
// (a domain error for a missing workflow, not an unknown-type protocol error).
func TestLiveResumeEndpointExists(t *testing.T) {
	server := os.Getenv("SP_SERVER")
	if server == "" {
		server = "ws://127.0.0.1:9090"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	client, err := swamp.Dial(ctx, server, "")
	if err != nil {
		t.Skipf("no server at %s: %v", server, err)
	}
	defer client.Close()

	h, err := client.StartRun(ctx, swamp.ReqWorkflowResume, map[string]any{
		"workflowIdOrName": "definitely-not-a-real-workflow-xyz",
		"from":             "nope",
	})
	if err != nil {
		t.Fatalf("StartRun: %v", err)
	}
	select {
	case ev := <-h.Events:
		t.Logf("event: %s", ev.Kind)
	case err := <-h.Errc:
		if err == nil {
			t.Log("resume ended cleanly (unexpected for a bogus workflow)")
			return
		}
		we, ok := err.(*swamp.WireError)
		if ok && we.Code == "invalid_request" {
			t.Fatalf("workflow.resume rejected as invalid_request: %v", err)
		}
		t.Logf("resume domain error (expected): %v", err)
	}
}
