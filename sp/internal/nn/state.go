package nn

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// GroupState is the per-group UI state: nn's ".newsrc plus select file", one
// per group. It is deliberately *not* a swamp data resource — it changes on
// every keystroke, and the datastore is versioned and locked.
type GroupState struct {
	Watermark string            `json:"watermark,omitempty"`
	Attrs     map[string]string `json:"attrs,omitempty"`
	Page      int               `json:"page,omitempty"`
	Cursor    int               `json:"cursor,omitempty"`
}

type diskState struct {
	Version    int                       `json:"version"`
	Groups     map[string]*GroupState    `json:"groups"`
	LastGroup  string                    `json:"lastGroup,omitempty"`
	LastInputs map[string]map[string]any `json:"lastInputs,omitempty"`
}

// Store holds per-group attributes, watermarks and positions, and optionally
// persists them. A Store with an empty path is memory-only (used by tests and
// by --no-state).
type Store struct {
	path string
	mu   sync.Mutex
	st   diskState
}

// DefaultStatePath is $NN_STATE, else $XDG_DATA_HOME/nn/state.json, else
// ~/.local/share/nn/state.json.
func DefaultStatePath() string {
	if p := os.Getenv("NN_STATE"); p != "" {
		return p
	}
	if d := os.Getenv("XDG_DATA_HOME"); d != "" {
		return filepath.Join(d, "nn", "state.json")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".local", "share", "nn", "state.json")
}

// OpenStore loads path (missing is fine: a first run starts empty) and returns
// the store. An empty path gives a memory-only store.
func OpenStore(path string) (*Store, error) {
	s := &Store{path: path}
	s.st = diskState{Version: 1, Groups: map[string]*GroupState{}}
	if path == "" {
		return s, nil
	}
	b, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return s, nil
		}
		return nil, fmt.Errorf("read state %s: %w", path, err)
	}
	if len(b) == 0 {
		return s, nil
	}
	var st diskState
	if err := json.Unmarshal(b, &st); err != nil {
		// A corrupt state file must not lose the news. Keep a copy and start
		// clean rather than refusing to run.
		_ = os.Rename(path, path+".corrupt")
		return s, nil
	}
	if st.Groups == nil {
		st.Groups = map[string]*GroupState{}
	}
	s.st = st
	return s, nil
}

// Path reports where the store persists, or "" when in-memory.
func (s *Store) Path() string { return s.path }

// group returns (creating) the state for a group id.
func (s *Store) group(id string) *GroupState {
	gs := s.st.Groups[id]
	if gs == nil {
		gs = &GroupState{Attrs: map[string]string{}}
		s.st.Groups[id] = gs
	}
	if gs.Attrs == nil {
		gs.Attrs = map[string]string{}
	}
	return gs
}

// Attr returns the stored attribute for an item, if any.
func (s *Store) Attr(group, item string) (Attr, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	gs := s.st.Groups[group]
	if gs == nil {
		return AttrUnread, false
	}
	v, ok := gs.Attrs[item]
	return Attr(v), ok
}

// SetAttr records an item's attribute and persists.
func (s *Store) SetAttr(group, item string, a Attr) {
	s.mu.Lock()
	gs := s.group(group)
	if a == AttrUnread {
		delete(gs.Attrs, item)
	} else {
		gs.Attrs[item] = string(a)
	}
	s.mu.Unlock()
	s.Save()
}

// SetAttrs records several attributes at once (one save).
func (s *Store) SetAttrs(group string, items []*Item, a Attr) {
	s.mu.Lock()
	gs := s.group(group)
	for _, it := range items {
		if a == AttrUnread {
			delete(gs.Attrs, it.ID)
		} else {
			gs.Attrs[it.ID] = string(a)
		}
	}
	s.mu.Unlock()
	s.Save()
}

// ClearSelections drops every selected attribute in a group.
func (s *Store) ClearSelections(group string) {
	s.mu.Lock()
	gs := s.group(group)
	for k, v := range gs.Attrs {
		if v == string(AttrSelected) {
			delete(gs.Attrs, k)
		}
	}
	s.mu.Unlock()
}

// Watermark returns the group's "how far have I looked" cursor.
func (s *Store) Watermark(group string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if gs := s.st.Groups[group]; gs != nil {
		return gs.Watermark
	}
	return ""
}

// EffectiveAttr is the attribute an item displays.
//
// An explicit attribute always wins; otherwise the item is unread. There is no
// "auto-read by age" rule: nn's auto-junk-seen (silently marking anything that
// had been displayed as read) was its most-complained-about behaviour, and this
// reader does not reproduce it. An item is unread until a person marks it, and
// `space` marks only what it pages past — as *seen*, not read.
func (s *Store) EffectiveAttr(it *Item) Attr {
	if a, ok := s.Attr(it.Group, it.ID); ok {
		return a
	}
	return AttrUnread
}

// NewCount is how many items arrived after the group's watermark, i.e. since
// the last time a page of that group was paged through. It is informational —
// it never changes an item's attribute.
func (s *Store) NewCount(g *Group) int {
	wm := s.Watermark(g.ID())
	if wm == "" {
		n := 0
		for _, it := range g.Items {
			if it.NewSince != "" {
				n++
			}
		}
		return n
	}
	wmT, ok := parseTime(wm)
	if !ok {
		return 0
	}
	n := 0
	for _, it := range g.Items {
		if it.NewSince != "" && it.SortKey.After(wmT) {
			n++
		}
	}
	return n
}

// MarkSeen marks the unread items among items as seen. This is what `space`
// does to the page it leaves behind — never `read`.
func (s *Store) MarkSeen(items []*Item) {
	var changed bool
	s.mu.Lock()
	for _, it := range items {
		cur := AttrUnread
		if gs := s.st.Groups[it.Group]; gs != nil {
			cur = Attr(gs.Attrs[it.ID])
		}
		if cur != AttrUnread {
			continue
		}
		s.group(it.Group).Attrs[it.ID] = string(AttrSeen)
		changed = true
	}
	s.mu.Unlock()
	if changed {
		s.Save()
	}
}

// AdvanceWatermark moves a group's watermark to the newest seen/read item, so
// items the person never saw stay unread. `nn`'s auto-junk-seen did the
// opposite, and was its most-complained-about behaviour; this is the fix.
func (s *Store) AdvanceWatermark(group string, items []*Item) {
	s.mu.Lock()
	gs := s.group(group)
	cur, hasCur := parseTime(gs.Watermark)
	best := cur
	changed := false
	for _, it := range items {
		if it.Group != group || it.NewSince == "" {
			continue
		}
		a := Attr(gs.Attrs[it.ID])
		if a != AttrSeen && a != AttrRead {
			continue
		}
		if !hasCur || it.SortKey.After(cur) {
			if it.SortKey.After(best) || !changed {
				best = it.SortKey
				changed = true
			}
		}
	}
	if changed {
		wm := best.UTC().Format(time.RFC3339)
		if wm != gs.Watermark {
			gs.Watermark = wm
		}
	}
	s.mu.Unlock()
	if changed {
		s.Save()
	}
}

// Position returns the saved page and cursor for a group.
func (s *Store) Position(group string) (page, cursor int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if gs := s.st.Groups[group]; gs != nil {
		return gs.Page, gs.Cursor
	}
	return 0, 0
}

// SetPosition records the page and cursor for a group.
func (s *Store) SetPosition(group string, page, cursor int) {
	s.mu.Lock()
	gs := s.group(group)
	gs.Page, gs.Cursor = page, cursor
	s.mu.Unlock()
}

// LastGroup is the group the person was reading when they quit.
func (s *Store) LastGroup() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.st.LastGroup
}

// SetLastGroup records the active group.
func (s *Store) SetLastGroup(id string) {
	s.mu.Lock()
	s.st.LastGroup = id
	s.mu.Unlock()
	s.Save()
}

// LastInputs returns the inputs used for a workflow's previous run started from
// this UI (^R in the form).
func (s *Store) LastInputs(workflow string) map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.st.LastInputs[workflow]
}

// SetLastInputs records the inputs a workflow was last started with here.
func (s *Store) SetLastInputs(workflow string, in map[string]any) {
	s.mu.Lock()
	if s.st.LastInputs == nil {
		s.st.LastInputs = map[string]map[string]any{}
	}
	s.st.LastInputs[workflow] = in
	s.mu.Unlock()
	s.Save()
}

// Save writes the state atomically.
func (s *Store) Save() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.saveLocked()
}

func (s *Store) saveLocked() error {
	if s.path == "" {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(s.st, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}
