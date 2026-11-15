package nn

import (
	"fmt"
	"os"
	"path/filepath"

	"gopkg.in/yaml.v3"
)

// ConfigFileName is the repo-level group definition file. When absent, the
// built-in defaults below are used.
const ConfigFileName = "nn.groups.yaml"

// DefaultConfig is the built-in group set: the sources that exist in this
// repository today. It is expressed in the same declarative shape a
// nn.groups.yaml would use, so a repo file replaces it outright rather than
// being merged with it.
func DefaultConfig() *Config {
	cfg := &Config{
		Version:  1,
		Defaults: Defaults{PageSize: 40, Sort: "", NewFirst: true},
		Groups: []GroupSpec{
			{
				ID: "news", Title: "news", Kind: "data",
				Model: "local-news", Type: "@svendowideit/news-reader",
				Resource: "filtered-snapshot", Path: "articles",
				IDField: "id", Format: "article",
				Menu:     []string{"source", "title"},
				Body:     "summary",
				Meta:     []string{"source", "publishedAt", "url"},
				Link:     "url",
				NewSince: "publishedAt",
				Sort:     "publishedAt desc",
			},
			{
				ID: "tasks:inbox", Title: "tasks:inbox", Kind: "data",
				Model: "gtd", Type: "@svendowideit/gtd",
				Resource: "inbox", Path: "items",
				IDField: "id", Format: "task",
				Menu:     []string{"status", "raw"},
				Body:     "raw",
				Meta:     []string{"source", "capturedAt"},
				NewSince: "capturedAt",
				Sort:     "capturedAt desc",
			},
			{
				ID: "tasks:next", Title: "tasks:next", Kind: "data",
				Model: "gtd", Type: "@svendowideit/gtd",
				Resource: "next-actions", Path: "items",
				IDField: "id", Format: "task",
				Menu:     []string{"context", "title"},
				Body:     "notes",
				Meta:     []string{"priority", "context", "createdAt"},
				NewSince: "createdAt",
				Sort:     "createdAt desc",
			},
			{
				ID: "tasks:waiting", Title: "tasks:waiting", Kind: "data",
				Model: "gtd", Type: "@svendowideit/gtd",
				Resource: "waiting-for", Path: "items",
				IDField: "id", Format: "task",
				Menu:     []string{"delegatee", "title"},
				Body:     "notes",
				Meta:     []string{"delegatedAt", "expectedBy"},
				NewSince: "delegatedAt",
				Sort:     "delegatedAt desc",
			},
			{
				ID: "fleet", Title: "fleet", Kind: "data",
				Model: "fleet", Type: "@svendowideit/fleet-inventory",
				Resource: "inventory", Path: "hosts",
				IDField: "name", Format: "row",
				Menu: []string{"tier", "os", "deviceClass", "name"},
			},
			{
				ID: "objects:workflows", Title: "objects:workflows", Kind: "objects",
				Collection: "workflows",
				IDField:    "name", Format: "object",
				Menu: []string{"name", "description"},
			},
			{
				ID: "objects:models", Title: "objects:models", Kind: "objects",
				Collection: "models",
				IDField:    "name", Format: "object",
				Menu: []string{"type", "name"},
			},
		},
	}
	for i := range cfg.Groups {
		applyDefaults(&cfg.Groups[i], cfg.Defaults)
	}
	return cfg
}

// LoadConfig reads path if it exists, and otherwise returns the built-in
// defaults. A malformed file is an error: a silently empty group list would
// look exactly like "no news today", the one failure mode this reader must not
// have.
func LoadConfig(path string) (*Config, string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return DefaultConfig(), "built-in", nil
		}
		return nil, "", fmt.Errorf("read %s: %w", path, err)
	}
	var cfg Config
	if err := yaml.Unmarshal(b, &cfg); err != nil {
		return nil, "", fmt.Errorf("parse %s: %w", path, err)
	}
	if len(cfg.Groups) == 0 {
		return nil, "", fmt.Errorf("%s declares no groups", path)
	}
	if cfg.Defaults.PageSize == 0 {
		cfg.Defaults.PageSize = 40
	}
	for i := range cfg.Groups {
		applyDefaults(&cfg.Groups[i], cfg.Defaults)
	}
	return &cfg, filepath.Base(path), nil
}

// applyDefaults fills the group's unset projection fields from the document
// defaults.
func applyDefaults(g *GroupSpec, d Defaults) {
	if g.Format == "" {
		g.Format = d.Format
	}
	if g.Format == "" {
		g.Format = "text"
	}
	if g.Sort == "" {
		g.Sort = d.Sort
	}
	if g.PageSize == 0 {
		g.PageSize = d.PageSize
	}
	if g.IDField == "" {
		g.IDField = "id"
	}
	for i := range g.Children {
		applyDefaults(&g.Children[i], d)
	}
}

// DefaultConfigPath is the config file inside a repository, or "" when the
// repository directory is unknown.
func DefaultConfigPath(repoDir string) string {
	if repoDir == "" {
		return ""
	}
	return filepath.Join(repoDir, ConfigFileName)
}
