package nn

import (
	"os"
	"path/filepath"
	"strings"
)

// SequenceFileName is nn's presentation sequence: the order your attention
// moves through the groups, as a file, not a heuristic.
const SequenceFileName = "nn.sequence"

// LoadSequence reads a sequence file. A missing file is not an error (the
// config order stands). Each non-empty, non-comment line is one of:
//
//	id        show this group here
//	! id      never show this group
//	NEW       every group not named above goes here
//
// File order is the order. This is the useful half of nn's meta-notation;
// `<`/`>`/`RC`/`%…%` are not carried over, because a plain ordered list says the
// same thing and cannot surprise anyone.
func LoadSequence(path string) (order, ignored []string, err error) {
	if path == "" {
		return nil, nil, nil
	}
	b, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil, nil
		}
		return nil, nil, err
	}
	for _, line := range strings.Split(string(b), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if strings.HasPrefix(line, "!") {
			if id := strings.TrimSpace(line[1:]); id != "" {
				ignored = append(ignored, id)
			}
			continue
		}
		order = append(order, line)
	}
	return order, ignored, nil
}

// ApplySequence reorders groups per the sequence and drops ignored ones. Groups
// the file does not mention are kept: at the NEW slot when there is one, and
// appended at the end otherwise. Nothing is ever lost silently.
func ApplySequence(groups []*Group, order, ignored []string) []*Group {
	byID := make(map[string]*Group, len(groups))
	for _, g := range groups {
		byID[g.ID()] = g
	}
	drop := make(map[string]bool, len(ignored))
	for _, id := range ignored {
		drop[id] = true
	}
	used := make(map[string]bool, len(groups))
	out := make([]*Group, 0, len(groups))

	appendGroup := func(g *Group) {
		if g == nil || used[g.ID()] || drop[g.ID()] {
			return
		}
		used[g.ID()] = true
		out = append(out, g)
	}
	rest := func() {
		for _, g := range groups {
			appendGroup(g)
		}
	}

	for _, entry := range order {
		if entry == "NEW" {
			rest()
			continue
		}
		appendGroup(byID[entry])
	}
	rest()
	return out
}

// DefaultSequencePath is the sequence file inside a repository.
func DefaultSequencePath(repoDir string) string {
	if repoDir == "" {
		return ""
	}
	return filepath.Join(repoDir, SequenceFileName)
}
