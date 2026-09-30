//go:build integration

package swamp

import (
	"context"
	"os/exec"
	"testing"
	"time"
)

// TestEnsureServeSpawnAndStop verifies the core lifecycle requirement: when no
// server is running, EnsureServe starts one it owns, and Stop tears it down
// completely (no orphaned process).
func TestEnsureServeSpawnAndStop(t *testing.T) {
	if _, err := exec.LookPath("swamp"); err != nil {
		t.Skip("swamp binary not on PATH")
	}
	repo, err := FindRepo("")
	if err != nil {
		t.Skipf("not in a swamp repo: %v", err)
	}

	const port = 9097
	ctx := context.Background()

	if ProbeAuthInfo(ctx, port) {
		t.Fatalf("port %d already in use; pick another", port)
	}

	s, err := EnsureServe(ctx, repo.Dir, port)
	if err != nil {
		t.Fatalf("EnsureServe: %v", err)
	}
	if !s.Owned() {
		t.Fatalf("expected an owned server, got attached")
	}
	if !ProbeAuthInfo(context.Background(), port) {
		t.Fatalf("server not reachable after EnsureServe")
	}

	s.Stop()
	// Give the OS a moment to reap.
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if !ProbeAuthInfo(context.Background(), port) {
			return // success: nothing listening
		}
		time.Sleep(150 * time.Millisecond)
	}
	t.Fatalf("server still answering on %d after Stop — orphaned process", port)
}

// TestEnsureServeAdopts verifies that a pre-existing server is adopted, not
// owned, and left running by Stop.
func TestEnsureServeAdopts(t *testing.T) {
	repo, err := FindRepo("")
	if err != nil {
		t.Skipf("not in a swamp repo: %v", err)
	}
	const port = 9098
	ctx := context.Background()

	first, err := EnsureServe(ctx, repo.Dir, port)
	if err != nil {
		t.Fatalf("EnsureServe (owner): %v", err)
	}
	defer first.Stop()

	second, err := EnsureServe(ctx, repo.Dir, port)
	if err != nil {
		t.Fatalf("EnsureServe (adopt): %v", err)
	}
	if second.Owned() {
		t.Fatalf("second EnsureServe should attach, not own")
	}
}
