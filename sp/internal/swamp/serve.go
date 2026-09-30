package swamp

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

// RepoInfo describes a located swamp repository.
type RepoInfo struct {
	Dir string
}

// FindRepo walks up from start (or cwd) looking for a .swamp.yaml marker.
// SWAMP_REPO_DIR overrides discovery.
func FindRepo(start string) (*RepoInfo, error) {
	if env := os.Getenv("SWAMP_REPO_DIR"); env != "" {
		if _, err := os.Stat(filepath.Join(env, ".swamp.yaml")); err == nil {
			return &RepoInfo{Dir: env}, nil
		}
	}
	if start == "" {
		cwd, err := os.Getwd()
		if err != nil {
			return nil, err
		}
		start = cwd
	}
	dir := start
	for i := 0; i < 16; i++ {
		if _, err := os.Stat(filepath.Join(dir, ".swamp.yaml")); err == nil {
			return &RepoInfo{Dir: dir}, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return nil, fmt.Errorf("not inside a swamp repository (no .swamp.yaml found from %s)", start)
}

// Serve is a running (or pre-existing) swamp serve instance.
type Serve struct {
	BaseURL string // ws:// or wss:// URL used by the protocol client
	HTTPURL string // http(s) URL used for /auth/info and /ready
	Port    int
	owned   bool
	cmd     *exec.Cmd
	logPath string
	stopOne sync.Once
}

// Owned reports whether this process started the server and must stop it.
func (s *Serve) Owned() bool { return s.owned }

// LogPath is where a locally started server's output is captured.
func (s *Serve) LogPath() string { return s.logPath }

// Detach relinquishes ownership so Stop becomes a no-op. Use this to leave a
// server (and any runs it hosts) running after the tool exits. The spawned
// process is disowned from the process group by signalling it independently:
// we do NOT kill it, and we drop our handle so cleanup cannot.
func (s *Serve) Detach() {
	if s == nil {
		return
	}
	s.owned = false
}

// Stop terminates a server this process started. A pre-existing server is left
// untouched. It always exits the process group spawned with Setpgid, so no
// orphaned swamp serve survives the tool.
func (s *Serve) Stop() {
	if s == nil || !s.owned || s.cmd == nil || s.cmd.Process == nil {
		return
	}
	s.stopOne.Do(func() {
		pgid := s.cmd.Process.Pid
		// Ask the whole process group to terminate gracefully.
		_ = syscall.Kill(-pgid, syscall.SIGTERM)
		done := make(chan struct{})
		go func() {
			_, _ = s.cmd.Process.Wait()
			close(done)
		}()
		select {
		case <-done:
		case <-time.After(3 * time.Second):
			_ = syscall.Kill(-pgid, syscall.SIGKILL)
			<-done
		}
	})
}

// EnsureServe returns a usable serve for repoDir. If one is already answering on
// the preferred/requested port it is adopted (not owned). Otherwise a local
// `swamp serve` is started and owned by the caller, and stopped by Stop.
func EnsureServe(ctx context.Context, repoDir string, port int) (*Serve, error) {
	if port == 0 {
		port = 9090
	}
	// 1. Adopt an existing server if the port already answers like swamp serve.
	if probeSwapServe(ctx, port) {
		return &Serve{
			BaseURL: fmt.Sprintf("ws://127.0.0.1:%d", port),
			HTTPURL: fmt.Sprintf("http://127.0.0.1:%d", port),
			Port:    port,
			owned:   false,
		}, nil
	}

	// 2. Refuse to stomp on a non-swamp listener.
	if ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port)); err != nil {
		return nil, fmt.Errorf("port %d is in use and is not a swamp serve instance: %w", port, err)
	} else {
		_ = ln.Close()
	}

	// 3. Start our own server.
	swampBin, err := exec.LookPath("swamp")
	if err != nil {
		return nil, fmt.Errorf("swamp binary not found on PATH: %w", err)
	}
	logPath := filepath.Join(os.TempDir(), fmt.Sprintf("swamp-serve-%d.log", port))
	logFile, err := os.Create(logPath)
	if err != nil {
		return nil, err
	}

	cmd := exec.Command(swampBin, "serve",
		"--repo-dir", repoDir,
		"--host", "127.0.0.1",
		"--port", fmt.Sprintf("%d", port),
		"--no-schedule",
	)
	cmd.Dir = repoDir
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	cmd.Env = os.Environ()
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		_ = logFile.Close()
		return nil, fmt.Errorf("start swamp serve: %w", err)
	}
	_ = logFile.Close()

	s := &Serve{
		BaseURL: fmt.Sprintf("ws://127.0.0.1:%d", port),
		HTTPURL: fmt.Sprintf("http://127.0.0.1:%d", port),
		Port:    port,
		owned:   true,
		cmd:     cmd,
		logPath: logPath,
	}

	// 4. Wait for readiness, or fail and clean up.
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		if ctx.Err() != nil {
			s.Stop()
			return nil, ctx.Err()
		}
		if cmd.ProcessState != nil && cmd.ProcessState.Exited() {
			s.Stop()
			return nil, fmt.Errorf("swamp serve exited during startup; see %s", logPath)
		}
		if probeReady(ctx, port) {
			return s, nil
		}
		time.Sleep(250 * time.Millisecond)
	}
	s.Stop()
	return nil, fmt.Errorf("swamp serve did not become ready within 30s; see %s", logPath)
}

// probeSwapServe reports whether /auth/info answers on the port.
func probeSwapServe(ctx context.Context, port int) bool {
	return ProbeAuthInfo(ctx, port)
}

// ProbeAuthInfo reports whether a swamp serve is answering /auth/info on the
// given localhost port.
func ProbeAuthInfo(ctx context.Context, port int) bool {
	c, cancel := context.WithTimeout(ctx, 750*time.Millisecond)
	defer cancel()
	info, err := FetchAuthInfo(c, fmt.Sprintf("http://127.0.0.1:%d", port))
	return err == nil && info.Mode != ""
}

// probeReady reports whether /ready returns 200 with status ready.
func probeReady(ctx context.Context, port int) bool {
	c, cancel := context.WithTimeout(ctx, 750*time.Millisecond)
	defer cancel()
	req, err := http.NewRequestWithContext(c, http.MethodGet,
		fmt.Sprintf("http://127.0.0.1:%d/ready", port), nil)
	if err != nil {
		return false
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

// ShortRepoName is the final path element of the repo, for display.
func ShortRepoName(dir string) string {
	return filepath.Base(strings.TrimRight(dir, string(os.PathSeparator)))
}
