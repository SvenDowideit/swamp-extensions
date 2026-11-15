package nn

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/charmbracelet/x/ansi"
)

// lookup walks a dotted path into a decoded JSON value.
//
// Supported forms: "a.b.c", "a.0.b" (numeric index into an array). Unknown or
// missing paths return nil rather than an error: a config that names a field
// the source does not have should render blank, not break the group.
func lookup(v any, path string) any {
	if path == "" {
		return v
	}
	cur := v
	for _, part := range strings.Split(path, ".") {
		switch node := cur.(type) {
		case map[string]any:
			cur = node[part]
		case []any:
			i, err := strconv.Atoi(part)
			if err != nil || i < 0 || i >= len(node) {
				return nil
			}
			cur = node[i]
		default:
			return nil
		}
	}
	return cur
}

// lookupAll is lookup over a decoded root with a fallback chain: the first path
// that yields a non-nil value wins.
func lookupAll(root any, paths ...string) any {
	for _, p := range paths {
		if v := lookup(root, p); v != nil {
			return v
		}
	}
	return nil
}

// scalar renders a JSON scalar as one line of plain text. Containers are
// rendered compactly so a menu column never spans lines.
func scalar(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return strings.Join(strings.Fields(t), " ")
	case float64:
		if t == float64(int64(t)) {
			return strconv.FormatInt(int64(t), 10)
		}
		return strconv.FormatFloat(t, 'f', -1, 64)
	case bool:
		if t {
			return "yes"
		}
		return "no"
	case []any:
		parts := make([]string, 0, len(t))
		for _, e := range t {
			if s := scalar(e); s != "" {
				parts = append(parts, s)
			}
		}
		return strings.Join(parts, ", ")
	case map[string]any:
		return fmt.Sprintf("{%d fields}", len(t))
	default:
		return fmt.Sprint(t)
	}
}

// timeLayouts are the timestamp shapes swamp sources emit, most specific first.
var timeLayouts = []string{
	time.RFC3339Nano,
	time.RFC3339,
	time.RFC1123Z,
	time.RFC1123,
	"Mon, 2 Jan 2006 15:04:05 -0700",
	"2006-01-02T15:04:05",
	"2006-01-02 15:04:05",
	"2006-01-02",
}

// parseTime parses the timestamp shapes swamp sources produce. The second
// result is false when the string is not a time, in which case callers fall
// back to lexical ordering.
func parseTime(s string) (time.Time, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return time.Time{}, false
	}
	for _, layout := range timeLayouts {
		if t, err := time.Parse(layout, s); err == nil {
			return t, true
		}
	}
	return time.Time{}, false
}

// sortTime renders a timestamp as a comparable value. Non-time strings keep a
// zero time so they sort before dated items and never advance a watermark.
func sortTime(s string) time.Time {
	t, _ := parseTime(s)
	return t
}

// timestampFor returns the item's newness timestamp in a canonical, comparable
// form (RFC3339 UTC), or the raw string when it does not parse.
func timestampFor(v any) string {
	s := scalar(v)
	if t, ok := parseTime(s); ok {
		return t.UTC().Format(time.RFC3339)
	}
	return s
}

// sortSpec is a parsed `sort:` clause: one or more "field [asc|desc]" terms.
type sortSpec struct {
	field string
	desc  bool
}

// parseSort parses "publishedAt desc" or "severity desc, name asc".
func parseSort(s string) []sortSpec {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	var out []sortSpec
	for _, term := range strings.Split(s, ",") {
		fields := strings.Fields(term)
		if len(fields) == 0 {
			continue
		}
		sp := sortSpec{field: fields[0]}
		if len(fields) > 1 && strings.EqualFold(fields[1], "desc") {
			sp.desc = true
		}
		out = append(out, sp)
	}
	return out
}

// sortItems orders items in place by the spec. Timestamps compare
// chronologically when both sides parse; anything else compares as text.
func sortItems(items []*Item, specs []sortSpec) {
	if len(specs) == 0 {
		return
	}
	sort.SliceStable(items, func(i, j int) bool {
		for _, sp := range specs {
			a, b := itemField(items[i], sp.field), itemField(items[j], sp.field)
			if a == b {
				continue
			}
			if sp.desc {
				return a > b
			}
			return a < b
		}
		return false
	})
}

// itemField returns the comparable value of a field for sorting. Timestamps are
// normalised (see sortTime) so both time.Times and plain strings compare.
func itemField(it *Item, field string) string {
	switch field {
	case "newSince", "sortKey":
		return it.SortKey.UTC().Format(time.RFC3339Nano)
	case "id":
		return it.ID
	case "status":
		return it.Status
	}
	if it.Raw != nil {
		return scalar(lookup(it.Raw, field))
	}
	return ""
}

// menuLine renders one item as a single plain-text row:
//
//	<id><attr> <badge> <cols...>
//
// It never wraps: columns are dropped from the right when the width runs out,
// and the final column is ellipsised. Styling is applied by the caller to the
// whole row, so no ANSI is embedded here.
func menuLine(idChar string, attr Attr, badge string, cols []string, width int) string {
	head := idChar + attr.Glyph() + " "
	if badge != "" {
		head += badge + " "
	}
	avail := width - ansi.StringWidth(head)
	if avail <= 0 {
		return strings.TrimRight(head, " ")
	}

	var b strings.Builder
	used := 0
	for i, c := range cols {
		c = strings.TrimSpace(c)
		if c == "" {
			continue
		}
		sep := 0
		if used > 0 {
			sep = 2
		}
		remaining := avail - used - sep
		if remaining <= 1 {
			break
		}
		// Reserve room for a trailing ellipsis when this is not the last
		// column we could fit; the final column gets whatever is left.
		n := ansi.StringWidth(c)
		if n > remaining {
			c = ansi.Truncate(c, remaining-1, "…")
			n = ansi.StringWidth(c)
			if used > 0 {
				b.WriteString("  ")
			}
			b.WriteString(c)
			used += sep + n
			break
		}
		if used > 0 {
			b.WriteString("  ")
		}
		b.WriteString(c)
		used += sep + n
		_ = i
	}
	return strings.TrimRight(head+b.String(), " ")
}

// itoa is a tiny helper so the shell can build status strings without fmt.
func itoa(n int) string { return strconv.Itoa(n) }

// idChar maps a row index to nn's article id: a-z then 0-9.
func idChar(i int) string {
	switch {
	case i >= 0 && i < 26:
		return string(rune('a' + i))
	case i < 36:
		return string(rune('0' + i - 26))
	default:
		return "?"
	}
}

// idIndex is the inverse of idChar: it reports the row index a typed key
// selects, and whether the key is an id key at all.
func idIndex(key string) (int, bool) {
	if len(key) != 1 {
		return 0, false
	}
	c := key[0]
	switch {
	case c >= 'a' && c <= 'z':
		return int(c - 'a'), true
	case c >= '0' && c <= '9':
		return 26 + int(c-'0'), true
	}
	return 0, false
}

// padRight pads or truncates plain text to exactly width cells.
func padRight(s string, width int) string {
	n := ansi.StringWidth(s)
	if n > width {
		return ansi.Truncate(s, width, "")
	}
	return s + strings.Repeat(" ", width-n)
}

// fit truncates a styled line to width cells, keeping its escape sequences.
func fit(s string, width int) string {
	if ansi.StringWidth(s) <= width {
		return s
	}
	return ansi.Truncate(s, width, "…")
}
