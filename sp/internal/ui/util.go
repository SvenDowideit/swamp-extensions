package ui

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

// str renders any JSON value as a compact display string.
func str(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case bool:
		return fmt.Sprintf("%v", t)
	case float64:
		if t == float64(int64(t)) {
			return fmt.Sprintf("%d", int64(t))
		}
		return fmt.Sprintf("%g", t)
	default:
		b, err := json.Marshal(t)
		if err != nil {
			return fmt.Sprintf("%v", t)
		}
		return string(b)
	}
}

// asList coerces a JSON value into a slice where possible.
func asList(v any) []any {
	switch t := v.(type) {
	case nil:
		return nil
	case []any:
		return t
	case map[string]any:
		return []any{t}
	default:
		return nil
	}
}

// firstLine returns the first non-empty line of s, trimmed.
func firstLine(s string) string {
	for _, ln := range strings.Split(s, "\n") {
		if strings.TrimSpace(ln) != "" {
			return strings.TrimSpace(ln)
		}
	}
	return ""
}

// humanSize formats a numeric byte count.
func humanSize(v any) string {
	f, ok := v.(float64)
	if !ok {
		return ""
	}
	n := int64(f)
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := int64(unit), 0
	for x := n / unit; x >= unit; x /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %ciB", float64(n)/float64(div), "KMGT"[exp])
}

// prettyContent turns a data.get response into display lines. The content may be
// a JSON object/array, a string, or base64 for binary. Falls back gracefully.
func prettyContent(d map[string]any, width int) []string {
	content := d["content"]
	if content == nil {
		return []string{styleMuted.Render("(no content)")}
	}

	var val any = content
	if s, ok := content.(string); ok {
		// Try to parse JSON-encoded content.
		var parsed any
		if json.Unmarshal([]byte(s), &parsed) == nil {
			val = parsed
		} else {
			return wrapString(s, width)
		}
	}

	b, err := json.MarshalIndent(val, "", "  ")
	if err != nil {
		return wrapString(str(val), width)
	}
	pretty := string(b)
	lines := strings.Split(pretty, "\n")
	// Cap very large payloads.
	const maxLines = 4000
	if len(lines) > maxLines {
		lines = append(lines[:maxLines], styleMuted.Render(
			fmt.Sprintf("… %d more lines truncated", len(lines)-maxLines)))
	}
	return lines
}

func wrapString(s string, width int) []string {
	if width <= 0 {
		width = 100
	}
	var out []string
	for _, ln := range strings.Split(s, "\n") {
		for len(ln) > width {
			out = append(out, ln[:width])
			ln = ln[width:]
		}
		out = append(out, ln)
	}
	return out
}

// listWindow returns the half-open item range [top, bottom) to render so that
// the selected item (sel) stays visible in a viewport of innerH rows, where
// each item occupies rowsPerItem rows. It scrolls the minimum amount and never
// scrolls past the end of the list.
func listWindow(n, sel, rowsPerItem, innerH int) (top, bottom int) {
	visible := innerH / rowsPerItem
	if visible < 1 {
		visible = 1
	}
	if n <= visible {
		return 0, n
	}
	top = 0
	if sel >= visible {
		top = sel - visible + 1
	}
	if top > n-visible {
		top = n - visible
	}
	if top < 0 {
		top = 0
	}
	return top, top + visible
}

// rangeLabel renders " (a–b/n)" for a scrolled list, or "" when everything fits.
func rangeLabel(n, top, bottom int) string {
	if top == 0 && bottom >= n {
		return ""
	}
	return fmt.Sprintf(" %d–%d/%d", top+1, bottom, n)
}

// scrollbarThumb computes the proportional thumb [start, end) for a viewport
// showing `visible` of `total` rows, scrolled to `top`. It returns ok=false when
// the content fits (no bar needed).
func scrollbarThumb(total, visible, top, trackH int) (start, end int, ok bool) {
	if total <= visible || trackH <= 0 {
		return 0, 0, false
	}
	thumb := trackH * visible / total
	if thumb < 1 {
		thumb = 1
	}
	if thumb > trackH {
		thumb = trackH
	}
	maxTop := total - visible
	if maxTop < 1 {
		maxTop = 1
	}
	pos := 0
	if top > 0 {
		pos = (trackH - thumb) * top / maxTop
	}
	if pos < 0 {
		pos = 0
	}
	if pos+thumb > trackH {
		pos = trackH - thumb
	}
	return pos, pos + thumb, true
}

// scrollbarString renders a vertical scrollbar of trackH cells for a viewport
// showing `visible` of `total` rows at offset `top`, using the given glyphs.
func scrollbarString(total, visible, top, trackH int, track, thumb string) []string {
	out := make([]string, trackH)
	for i := range out {
		out[i] = track
	}
	start, end, ok := scrollbarThumb(total, visible, top, trackH)
	if !ok {
		return out
	}
	for i := start; i < end && i < trackH; i++ {
		out[i] = thumb
	}
	return out
}

// containsStr reports whether ss contains s.
func containsStr(ss []string, s string) bool {
	for _, x := range ss {
		if x == s {
			return true
		}
	}
	return false
}

// joinNonEmpty filters empty strings, then joins with sep.
func joinNonEmpty(sep string, parts ...string) string {
	kept := parts[:0]
	for _, p := range parts {
		if p != "" {
			kept = append(kept, p)
		}
	}
	return strings.Join(kept, sep)
}

// sortedKeys is a small helper for debugging maps.
func sortedKeys(m map[string]any) []string {
	ks := make([]string, 0, len(m))
	for k := range m {
		ks = append(ks, k)
	}
	sort.Strings(ks)
	return ks
}
