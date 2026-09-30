// Command sp is a Smalltalk-inspired browser for swamp repositories. It speaks
// the swamp serve WebSocket protocol and, when no server is running, starts a
// local `swamp serve` that it owns and stops when the browser exits.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/svendowideit/swamp-project/sp/internal/swamp"
	"github.com/svendowideit/swamp-project/sp/internal/ui"
)

func main() {
	var (
		repoDir  string
		port     int
		baseURL  string
		token    string
		noOwn    bool
		showHelp bool
	)
	flag.StringVar(&repoDir, "repo", "", "swamp repository directory (default: discover from cwd)")
	flag.IntVar(&port, "port", 9090, "swamp serve port to use or start")
	flag.StringVar(&baseURL, "server", "", "connect to an existing serve URL (ws://…), skips starting one")
	flag.StringVar(&token, "token", os.Getenv("SWAMP_SERVER_TOKEN"), "bearer token for a secured serve")
	flag.BoolVar(&noOwn, "no-spawn", false, "never spawn a local serve; fail if none is running")
	flag.BoolVar(&showHelp, "help", false, "show help")
	flag.Parse()

	if showHelp {
		flag.Usage()
		return
	}

	if err := run(repoDir, port, baseURL, token, noOwn); err != nil {
		fmt.Fprintln(os.Stderr, "sp: "+err.Error())
		os.Exit(1)
	}
}

func run(repoDir string, port int, baseURL, token string, noOwn bool) error {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Locate the repo unless an explicit server URL was given.
	var repo *swamp.RepoInfo
	if baseURL == "" {
		var err error
		repo, err = swamp.FindRepo(repoDir)
		if err != nil {
			return err
		}
		repoDir = repo.Dir
	} else {
		repoDir = baseURL
	}

	// Ensure a server, adopting one if present.
	var serve *swamp.Serve
	if baseURL != "" {
		serve = &swamp.Serve{BaseURL: baseURL, HTTPURL: baseURL}
	} else if noOwn {
		if !swamp.ProbeAuthInfo(ctx, port) {
			return fmt.Errorf("no swamp serve on port %d and --no-spawn was set", port)
		}
		serve = &swamp.Serve{
			BaseURL: fmt.Sprintf("ws://127.0.0.1:%d", port),
			HTTPURL: fmt.Sprintf("http://127.0.0.1:%d", port),
			Port:    port,
		}
	} else {
		var err error
		serve, err = swamp.EnsureServe(ctx, repoDir, port)
		if err != nil {
			return err
		}
	}
	// Guarantee the owned server dies with us, even on signal.
	defer serve.Stop()

	// Signal handling: bubbletea returns on SIGINT, but we still want cleanup.
	sigCtx, stopSignals := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stopSignals()
	go func() {
		<-sigCtx.Done()
		serve.Stop()
	}()

	// Negotiate auth, then dial.
	dialCtx, dcancel := context.WithTimeout(ctx, 15*time.Second)
	defer dcancel()
	if info, err := swamp.FetchAuthInfo(dialCtx, serve.BaseURL); err == nil && info.Mode == "oauth" {
		return fmt.Errorf("server requires oauth; run `swamp serve token mint` and pass --token")
	}

	client, err := swamp.Dial(dialCtx, serve.BaseURL, token)
	if err != nil {
		return fmt.Errorf("connect to serve: %w", err)
	}
	defer client.Close()
	if err := client.Handshake(dialCtx); err != nil {
		return fmt.Errorf("handshake: %w", err)
	}

	model := ui.New(client, swamp.ShortRepoName(repoDir), serve)
	p := tea.NewProgram(model)
	_, err = p.Run()
	return err
}
