// Command nn is an nn-style reader over a swamp repository: groups of items
// (news, tasks, fleet, objects, runnable workflows), a one-line-per-item
// selection menu, and item UIs for reading and acting.
//
// It speaks the swamp serve WebSocket protocol and, when no server is running,
// starts a local `swamp serve` that it owns and stops when it exits.
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
	"github.com/svendowideit/swamp-project/sp/internal/nn"
	"github.com/svendowideit/swamp-project/sp/internal/swamp"
)

func main() {
	var (
		repoDir  string
		port     int
		baseURL  string
		token    string
		noOwn    bool
		configF  string
		stateF   string
		noState  bool
		check    bool
		group    string
		showHelp bool
	)
	flag.StringVar(&repoDir, "repo", "", "swamp repository directory (default: discover from cwd)")
	flag.IntVar(&port, "port", 9090, "swamp serve port to use or start")
	flag.StringVar(&baseURL, "server", "", "connect to an existing serve URL (ws://…), skips starting one")
	flag.StringVar(&token, "token", os.Getenv("SWAMP_SERVER_TOKEN"), "bearer token for a secured serve")
	flag.BoolVar(&noOwn, "no-spawn", false, "never spawn a local serve; fail if none is running")
	flag.StringVar(&configF, "config", "", "group config (default: <repo>/nn.groups.yaml, else built-in)")
	flag.StringVar(&stateF, "state", "", "state file (default: $NN_STATE or ~/.local/share/nn/state.json)")
	flag.BoolVar(&noState, "no-state", false, "keep attributes in memory only; do not read or write state")
	flag.BoolVar(&check, "check", false, "load every group, print a summary, and exit (nncheck)")
	flag.StringVar(&group, "group", "", "start in this group id instead of the overview")
	flag.BoolVar(&showHelp, "help", false, "show help")
	flag.Parse()

	if showHelp {
		flag.Usage()
		return
	}

	if err := run(runOpts{
		repoDir: repoDir, port: port, baseURL: baseURL, token: token,
		noOwn: noOwn, configF: configF, stateF: stateF, noState: noState,
		check: check, group: group,
	}); err != nil {
		fmt.Fprintln(os.Stderr, "nn: "+err.Error())
		os.Exit(1)
	}
}

type runOpts struct {
	repoDir, baseURL, token string
	port                    int
	noOwn, noState          bool
	configF, stateF         string
	check                   bool
	group                   string
}

func run(o runOpts) error {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var repo *swamp.RepoInfo
	repoDir := o.repoDir
	if o.baseURL == "" {
		var err error
		repo, err = swamp.FindRepo(o.repoDir)
		if err != nil {
			return err
		}
		repoDir = repo.Dir
	}

	var serve *swamp.Serve
	switch {
	case o.baseURL != "":
		serve = &swamp.Serve{BaseURL: o.baseURL, HTTPURL: o.baseURL}
	case o.noOwn:
		if !swamp.ProbeAuthInfo(ctx, o.port) {
			return fmt.Errorf("no swamp serve on port %d and --no-spawn was set", o.port)
		}
		serve = &swamp.Serve{
			BaseURL: fmt.Sprintf("ws://127.0.0.1:%d", o.port),
			HTTPURL: fmt.Sprintf("http://127.0.0.1:%d", o.port),
			Port:    o.port,
		}
	default:
		var err error
		serve, err = swamp.EnsureServe(ctx, repoDir, o.port)
		if err != nil {
			return err
		}
	}
	defer serve.Stop()

	sigCtx, stopSignals := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stopSignals()
	go func() {
		<-sigCtx.Done()
		serve.Stop()
	}()

	dialCtx, dcancel := context.WithTimeout(ctx, 15*time.Second)
	defer dcancel()
	if info, err := swamp.FetchAuthInfo(dialCtx, serve.BaseURL); err == nil && info.Mode == "oauth" {
		return fmt.Errorf("server requires oauth; run `swamp serve token mint` and pass --token")
	}
	client, err := swamp.Dial(dialCtx, serve.BaseURL, o.token)
	if err != nil {
		return fmt.Errorf("connect to serve: %w", err)
	}
	defer client.Close()
	if err := client.Handshake(dialCtx); err != nil {
		return fmt.Errorf("handshake: %w", err)
	}

	cfgPath := o.configF
	if cfgPath == "" {
		cfgPath = nn.DefaultConfigPath(repoDir)
	}
	cfg, cfgSource, err := nn.LoadConfig(cfgPath)
	if err != nil {
		return err
	}

	statePath := o.stateF
	if statePath == "" && !o.noState {
		statePath = nn.DefaultStatePath()
	}
	if o.noState {
		statePath = ""
	}
	store, err := nn.OpenStore(statePath)
	if err != nil {
		return err
	}

	loader := &nn.Loader{API: client}
	model := nn.New(cfg, cfgSource, loader, store, swamp.ShortRepoName(repoDir), serveLabel(serve))

	if o.check {
		return runCheck(ctx, model, loader, cfg)
	}
	if o.group != "" {
		model.SetStartGroup(o.group)
	}

	p := tea.NewProgram(model)
	_, err = p.Run()
	// Persist position on the way out even when the program ended by signal.
	model.Shutdown()
	return err
}

// runCheck loads every group once and prints one line each. This is nncheck:
// it answers "is my config right and did the sources load?" without a TUI.
func runCheck(ctx context.Context, model *nn.Model, loader *nn.Loader, cfg *nn.Config) error {
	failed := 0
	for _, g := range cfg.Groups {
		group := &nn.Group{Spec: g}
		err := loader.Load(ctx, group)
		if err != nil {
			failed++
			fmt.Printf("%-24s err   %v\n", group.ID(), err)
			continue
		}
		newItems := 0
		for _, it := range group.Items {
			if it.NewSince != "" {
				newItems++
			}
		}
		fmt.Printf("%-24s %4d items  %4d dated\n", group.ID(), len(group.Items), newItems)
	}
	if failed > 0 {
		return fmt.Errorf("%d group(s) failed", failed)
	}
	return nil
}

func serveLabel(s *swamp.Serve) string {
	if s == nil {
		return ""
	}
	if s.Port > 0 {
		return fmt.Sprintf("serve :%d", s.Port)
	}
	return "serve remote"
}
