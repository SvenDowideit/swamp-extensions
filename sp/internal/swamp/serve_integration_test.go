//go:build integration

package swamp

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
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

// TestDetachedServeSurvivesStop verifies the detach path: a server we started
// is left running when Detach is called, so Stop (and process exit) cannot kill
// it. This is the "run a long workflow, detach, quit sp" guarantee.
func TestDetachedServeSurvivesStop(t *testing.T) {
	if _, err := exec.LookPath("swamp"); err != nil {
		t.Skip("swamp binary not on PATH")
	}
	repo, err := FindRepo("")
	if err != nil {
		t.Skipf("not in a swamp repo: %v", err)
	}
	const port = 9096
	ctx := context.Background()

	if ProbeAuthInfo(ctx, port) {
		t.Fatalf("port %d already in use; pick another", port)
	}

	s, err := EnsureServe(ctx, repo.Dir, port)
	if err != nil {
		t.Fatalf("EnsureServe: %v", err)
	}
	if !s.Owned() {
		t.Fatalf("expected an owned server")
	}

	// Detach, then Stop: the server must remain reachable.
	s.Detach()
	if s.Owned() {
		t.Fatalf("Detach should relinquish ownership")
	}
	s.Stop()

	if !ProbeAuthInfo(context.Background(), port) {
		t.Fatalf("detached server is gone after Stop — detach did not survive")
	}

	// Clean up the now-orphaned server ourselves for the test's sake. The
	// product never does this to a detached server; this is test hygiene so we
	// do not leak a listener on the CI host.
	killByPort(t, port)
}

// killByPort terminates whatever swamp serve is listening on port (test cleanup
// only).
func killByPort(t *testing.T, port int) {
	t.Helper()
	out, err := exec.Command("pgrep", "-af", "swamp serve").Output()
	if err != nil {
		return
	}
	marker := fmt.Sprintf("--port %d", port)
	for _, line := range strings.Split(string(out), "\n") {
		if strings.Contains(line, marker) {
			fields := strings.Fields(line)
			if len(fields) > 0 {
				_ = exec.Command("kill", fields[0]).Run()
			}
		}
	}
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
