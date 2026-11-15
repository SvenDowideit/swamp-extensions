// Package nn implements an nn-style reader over swamp: groups of items, a
// selection menu of one line each, and item UIs for reading and acting.
//
// It is deliberately small and declarative. Sources are described in
// nn.groups.yaml (or the built-in defaults) and resolved through a swamp serve
// client; this package owns the shell — selection, attributes, paging, item
// UIs — and nothing else. See docs/nn-tui-plan.md for the design.
package nn

import "time"

// Attr is an item's nn attribute. The zero value means unread, exactly as in
// nn's menu, where an unmarked item is unread.
type Attr string

const (
	AttrUnread   Attr = ""
	AttrSeen     Attr = "seen"
	AttrSelected Attr = "selected"
	AttrLeave    Attr = "leave"
	AttrRead     Attr = "read"
)

// Glyph is the single character nn shows in the menu for this attribute.
func (a Attr) Glyph() string {
	switch a {
	case AttrSeen:
		return ","
	case AttrSelected:
		return "*"
	case AttrLeave:
		return "="
	case AttrRead:
		return "."
	default:
		return "·"
	}
}

// Item is one menu row.
type Item struct {
	// ID is stable across loads; it keys attributes and watermarks.
	ID string
	// Group is the id of the group that produced this item.
	Group string
	// Format binds the item to an Item UI: article, markdown, html, text,
	// row, json, runnable, run, link, form.
	Format string
	// Cols are the plain-text menu columns, already trimmed by the loader.
	Cols []string
	// Badge is an optional one-word capability/severity marker ("SEC", "K").
	Badge string
	// NewSince is the item's newness timestamp (raw, as the source gave it).
	NewSince string
	// SortKey is the comparable timestamp used for ordering and watermarks.
	SortKey time.Time
	// Body is the raw document shown by the item UI.
	Body string
	// Meta is the header line(s) shown above the body.
	Meta []string
	// Link is the URL the item points at, if any.
	Link string
	// Child, when set, is the group id that `space`/`enter` pushes instead of
	// opening an item UI (used for runnables -> history).
	Child string
	// Status is the one-word run status, when the item is a run.
	Status string
	// Raw is the source record, kept for item UIs that need more than Body.
	Raw map[string]any
}

// Group is a named, ordered source of items.
type Group struct {
	Spec GroupSpec
	// Items is the loaded menu contents.
	Items []*Item
	// Children are real sub-sources, loaded on demand.
	Children []*Group
	// Err is set when the group could not be loaded. A group that failed is
	// shown with its reason and counted as "err" in the overview — never as 0.
	Err string
	// Loaded records whether Items/Children are current.
	Loaded bool
	// LoadedAt is when the last successful load finished.
	LoadedAt time.Time
	// Unread is the number of items whose effective attribute is unread.
	Unread int
	// Total is len(Items).
	Total int
}

// ID returns the group's stable identifier.
func (g *Group) ID() string { return g.Spec.ID }

// Title returns the label shown in the overview and the header.
func (g *Group) Title() string {
	if g.Spec.Title != "" {
		return g.Spec.Title
	}
	return g.Spec.ID
}

// Defaults are config values applied to every group unless overridden.
type Defaults struct {
	PageSize int    `yaml:"pageSize"`
	Format   string `yaml:"format"`
	Sort     string `yaml:"sort"`
	NewFirst bool   `yaml:"newFirst"`
}

// Config is the whole nn.groups.yaml document.
type Config struct {
	Version  int         `yaml:"version"`
	Defaults Defaults    `yaml:"defaults"`
	Groups   []GroupSpec `yaml:"groups"`
}

// GroupSpec is one declarative group definition. Every field is a plain value
// or a field path — deliberately not an expression language (see the plan's
// "the config is not a programming language" rule).
//
// Model and Resource name the swamp data that owns the items:
//
//	model:    local-news                       # a model instance
//	resource: filtered-snapshot                # a data resource name
//	path:     articles                         # dotted path into its content
type GroupSpec struct {
	ID     string `yaml:"id"`
	Title  string `yaml:"title"`
	Parent string `yaml:"parent"`
	// Kind selects the loader: data | objects | runs.
	Kind string `yaml:"kind"`

	// data loader
	Model    string `yaml:"model"`
	Type     string `yaml:"type"`
	Resource string `yaml:"resource"`
	Path     string `yaml:"path"`

	// objects loader
	Collection string `yaml:"collection"` // workflows | models

	// runs loader
	Workflow string `yaml:"workflow"`

	// Item projection: field paths only.
	IDField  string   `yaml:"id"`
	Format   string   `yaml:"format"`
	Menu     []string `yaml:"menu"`
	Body     string   `yaml:"body"`
	Meta     []string `yaml:"meta"`
	Link     string   `yaml:"link"`
	Badge    string   `yaml:"badge"`
	BadgeTag string   `yaml:"badgeTag"`
	NewSince string   `yaml:"newSince"`
	Sort     string   `yaml:"sort"`
	PageSize int      `yaml:"pageSize"`

	// Children are real sub-sources (loaded on demand).
	Children []GroupSpec `yaml:"groups"`
}
