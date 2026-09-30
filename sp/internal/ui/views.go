package ui

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"charm.land/lipgloss/v2"
)

// ctxView is one contextual, type-specific rendering of a JSON data artifact.
// name is shown to the user; render returns ok=false when the value does not
// fit the view (so the registry can fall through to a generic one).
type ctxView struct {
	name   string
	render func(v any, width int) ([]string, bool)
}

// ctxViews is the view registry, ordered most-specific first. The moldable
// layer is deliberately pluggable: an extension can add a view by appending
// here (or, in the swamp-native future, by shipping a report that declares one).
// "json" is always available as the raw fallback and is appended last.
var ctxViews = []ctxView{
	{name: "forecast", render: renderForecastView},
	{name: "bars", render: renderBarsView},
	{name: "table", render: renderTableView},
	{name: "fields", render: renderFieldsView},
}

// dataViews renders every applicable contextual view for a JSON artifact. It
// returns the ordered view names (always ending in "json") and their lines.
// A nil/empty map means the content is not JSON.
func dataViews(content string, width int) (names []string, rendered map[string][]string) {
	var v any
	if err := json.Unmarshal([]byte(content), &v); err != nil {
		return nil, nil
	}
	rendered = map[string][]string{}
	for _, cv := range ctxViews {
		if lines, ok := cv.render(v, width); ok && len(lines) > 0 {
			names = append(names, cv.name)
			rendered[cv.name] = lines
		}
	}
	names = append(names, "json")
	rendered["json"] = prettyJSON(content, width)
	return names, rendered
}

// --- forecast view ---------------------------------------------------------

// renderForecastView renders a BOM-style daily forecast (an object with a
// "days" array of per-day objects) as a readable per-day table.
func renderForecastView(v any, width int) ([]string, bool) {
	obj, ok := v.(map[string]any)
	if !ok {
		return nil, false
	}
	days := asList(obj["days"])
	if len(days) == 0 {
		return nil, false
	}
	// Require the day objects to look like a forecast (date/temp fields).
	first, _ := days[0].(map[string]any)
	if first == nil || (first["date"] == nil && first["weekday"] == nil) {
		return nil, false
	}

	var out []string
	if place, ok := obj["place"].(map[string]any); ok {
		if n := str(place["name"]); n != "" {
			out = append(out, styleKey.Render("place ")+n+
				styleMuted.Render("  "+joinNonEmpty(", ", str(place["state"]), str(place["postcode"]))))
		}
	}
	if region := str(obj["forecastRegion"]); region != "" {
		out = append(out, styleKey.Render("region")+" "+region)
	}
	if issue := str(obj["issueTime"]); issue != "" {
		out = append(out, styleKey.Render("issued")+" "+shortTime(issue))
	}
	if len(days) > 0 {
		out = append(out, "")
	}

	header := []string{"Day", "Forecast", "Min", "Max", "Rain"}
	var rows [][]string
	for _, d := range days {
		dm, ok := d.(map[string]any)
		if !ok {
			continue
		}
		day := strings.TrimSpace(joinNonEmpty(" ", weekdayShort(str(dm["weekday"])), shortDate(str(dm["date"]))))
		desc := str(dm["shortText"])
		if desc == "" {
			desc = str(dm["icon"])
		}
		rows = append(rows, []string{
			iconGlyph(str(dm["icon"])) + " " + day,
			desc,
			tempCell(dm["tempMin"]),
			tempCell(dm["tempMax"]),
			rainCell(dm["rainChance"]),
		})
	}
	out = append(out, tableLines(header, rows, width,
		func(s string) string { return stylePaneTitle.Render(s) },
		func(s string) string { return styleItem.Render(s) })...)
	return out, true
}

// --- bars view -------------------------------------------------------------

// barSeries is an array of objects that can render as a horizontal bar chart.
type barSeries struct {
	label string
	value float64
	frac  float64 // 0..1; computed when absent
	unit  string  // "bytes" | "count" | ""
}

// renderBarsView finds a distribution array (categories, extensions, topDirs,
// byRepo, …) and renders it as proportional bars. It requires either explicit
// fractions or a numeric measure plus a label.
func renderBarsView(v any, width int) ([]string, bool) {
	obj, ok := v.(map[string]any)
	if !ok {
		return nil, false
	}
	series, title, ok := pickBarSeries(obj)
	if !ok || len(series) < 2 {
		return nil, false
	}

	var out []string
	if title != "" {
		out = append(out, stylePaneTitle.Render(title), "")
	}
	// Scale bars across the widest label and value.
	maxVal := 0.0
	labelW, valueW := 0, 0
	for _, s := range series {
		if s.value > maxVal {
			maxVal = s.value
		}
		if lipgloss.Width(s.label) > labelW {
			labelW = lipgloss.Width(s.label)
		}
		if w := lipgloss.Width(formatMeasure(s.value, s.unit)); w > valueW {
			valueW = w
		}
	}
	if labelW > width/2 {
		labelW = width / 2
	}
	// Columns: indent(2) + label + 2 + value + 2 + bar + 1 + pct(4).
	// Reserve one column for the viewer scrollbar.
	inner := width - 1
	barW := inner - labelW - valueW - 11
	if barW < 6 {
		barW = 6
	}
	for _, s := range series {
		frac := s.frac
		if frac == 0 && maxVal > 0 {
			frac = s.value / maxVal
		}
		if frac > 1 {
			frac = 1
		}
		if frac < 0 {
			frac = 0
		}
		filled := int(frac*float64(barW) + 0.5)
		if filled > barW {
			filled = barW
		}
		bar := styleScrollThumb.Render(strings.Repeat("█", filled)) +
			styleScrollTrack.Render(strings.Repeat("░", barW-filled))
		value := formatMeasure(s.value, s.unit)
		// Show an explicit fraction as a percentage; otherwise the value column
		// already conveys the measure and a relative % would mislead.
		pct := ""
		if s.frac > 0 {
			pct = fmt.Sprintf("%3.0f%%", s.frac*100)
		}
		out = append(out, "  "+
			styleItem.Render(padTrunc(s.label, labelW, false))+"  "+
			styleMuted.Render(padCells(value, valueW))+"  "+
			bar+" "+
			styleMuted.Render(pct))
	}
	return out, true
}

// pickBarSeries selects the best distribution array in obj and reports its
// title. Preference: explicit fractions, then byte measures, then counts.
func pickBarSeries(obj map[string]any) (series []barSeries, title string, ok bool) {
	type cand struct {
		key  string
		rank int
	}
	var cands []cand
	for k, raw := range obj {
		arr := asList(raw)
		if len(arr) < 2 {
			continue
		}
		first, _ := arr[0].(map[string]any)
		if first == nil {
			continue
		}
		rank := -1
		switch {
		case first["fraction"] != nil && hasLabel(first):
			rank = 0
		case first["totalBytes"] != nil && hasLabel(first):
			rank = 1
		case first["bytes"] != nil && hasLabel(first):
			rank = 2
		case first["count"] != nil && hasLabel(first):
			rank = 3
		}
		if rank >= 0 {
			cands = append(cands, cand{k, rank})
		}
	}
	if len(cands) == 0 {
		return nil, "", false
	}
	sort.Slice(cands, func(i, j int) bool {
		if cands[i].rank != cands[j].rank {
			return cands[i].rank < cands[j].rank
		}
		return cands[i].key < cands[j].key
	})
	key := cands[0].key
	for _, raw := range asList(obj[key]) {
		m, _ := raw.(map[string]any)
		if m == nil {
			continue
		}
		s := barSeries{label: labelOf(m)}
		switch {
		case m["fraction"] != nil:
			s.frac = numOf(m["fraction"])
			s.value = numOf(m["totalBytes"])
			s.unit = "bytes"
		case m["totalBytes"] != nil:
			s.value = numOf(m["totalBytes"])
			s.unit = "bytes"
		case m["bytes"] != nil:
			s.value = numOf(m["bytes"])
			s.unit = "bytes"
		case m["count"] != nil:
			s.value = numOf(m["count"])
		}
		series = append(series, s)
	}
	return series, humanizeKey(key), true
}

func hasLabel(m map[string]any) bool {
	return m["label"] != nil || m["name"] != nil || m["category"] != nil || m["extension"] != nil
}

func labelOf(m map[string]any) string {
	for _, k := range []string{"label", "name", "category", "extension", "repo", "key"} {
		if s := str(m[k]); s != "" {
			return s
		}
	}
	return "(unnamed)"
}

// formatMeasure renders a numeric measure with a unit.
func formatMeasure(v float64, unit string) string {
	switch unit {
	case "bytes":
		return humanSize(v)
	case "count":
		return humanInt(v)
	default:
		if v == float64(int64(v)) {
			return humanInt(v)
		}
		return fmt.Sprintf("%g", v)
	}
}

// --- generic table view ----------------------------------------------------

// renderTableView renders the largest array-of-objects field as a table. This
// is the generic "any tabular resource" view (largestFiles, notableDirs,
// events, extensions, items, …).
func renderTableView(v any, width int) ([]string, bool) {
	var arr []any
	title := ""
	switch t := v.(type) {
	case []any:
		arr = t
	case map[string]any:
		// Pick the longest array-of-objects value.
		best := -1
		for k, raw := range t {
			a := asList(raw)
			if len(a) == 0 {
				continue
			}
			if _, ok := a[0].(map[string]any); !ok {
				continue
			}
			if len(a) > best {
				best = len(a)
				arr = a
				title = k
			}
		}
	default:
		return nil, false
	}
	if len(arr) == 0 {
		return nil, false
	}
	first, ok := arr[0].(map[string]any)
	if !ok {
		return nil, false
	}

	// Choose a small, stable column set from the first row.
	cols := orderedKeys(first)
	const maxCols = 6
	if len(cols) > maxCols {
		cols = cols[:maxCols]
	}
	if len(cols) == 0 {
		return nil, false
	}

	const maxRows = 60
	rows := make([][]string, 0, minInt(len(arr), maxRows))
	for i, raw := range arr {
		if i >= maxRows {
			break
		}
		m, _ := raw.(map[string]any)
		row := make([]string, len(cols))
		for j, c := range cols {
			row[j] = cellValue(m[c])
		}
		rows = append(rows, row)
	}

	var out []string
	if title != "" {
		out = append(out, stylePaneTitle.Render(humanizeKey(title)+fmt.Sprintf(" (%d)", len(arr))), "")
	}
	out = append(out, tableLines(cols, rows, width,
		func(s string) string { return stylePaneTitle.Render(s) },
		func(s string) string { return styleItem.Render(s) })...)
	if len(arr) > maxRows {
		out = append(out, "", styleMuted.Render(fmt.Sprintf("… %d more rows", len(arr)-maxRows)))
	}
	return out, true
}

// --- fields view -----------------------------------------------------------

// renderFieldsView is the always-applicable object summary: one aligned
// key/value row per field, with nested values summarised. It is the "raw
// structure at a glance" companion to the full JSON dump.
func renderFieldsView(v any, width int) ([]string, bool) {
	obj, ok := v.(map[string]any)
	if !ok || len(obj) == 0 {
		return nil, false
	}
	keys := orderedKeys(obj)
	keyW := 0
	for _, k := range keys {
		if len(k) > keyW {
			keyW = len(k)
		}
	}
	if keyW > width/2 {
		keyW = width / 2
	}
	var out []string
	for _, k := range keys {
		out = append(out, "  "+styleKey.Render(padTrunc(k, keyW, false))+"  "+
			styleItem.Render(summarizeValue(obj[k], width-keyW-4)))
	}
	return out, true
}

// summarizeValue renders a field value compactly on one line.
func summarizeValue(v any, width int) string {
	switch t := v.(type) {
	case nil:
		return styleMuted.Render("null")
	case string:
		if looksLikeTimestamp(t) {
			return shortTime(t)
		}
		return truncStr(t, width)
	case bool:
		return fmt.Sprintf("%v", t)
	case float64:
		return formatScalar(t)
	case map[string]any:
		return styleMuted.Render(fmt.Sprintf("{%d fields}", len(t)))
	case []any:
		if len(t) == 0 {
			return styleMuted.Render("[]")
		}
		if m, ok := t[0].(map[string]any); ok {
			return styleMuted.Render(fmt.Sprintf("[%d × {%d fields}]", len(t), len(m)))
		}
		return styleMuted.Render(fmt.Sprintf("[%d]", len(t)))
	default:
		return truncStr(str(t), width)
	}
}

// --- helpers ---------------------------------------------------------------

// orderedKeys returns a map's keys with common identity fields first, then the
// rest alphabetically.
func orderedKeys(m map[string]any) []string {
	priority := []string{"name", "title", "path", "date", "weekday", "kind", "category", "status", "label"}
	seen := map[string]bool{}
	var out []string
	for _, k := range priority {
		if _, ok := m[k]; ok {
			out = append(out, k)
			seen[k] = true
		}
	}
	var rest []string
	for k := range m {
		if !seen[k] {
			rest = append(rest, k)
		}
	}
	sort.Strings(rest)
	return append(out, rest...)
}

// cellValue renders a table cell value on one line.
func cellValue(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case []any:
		return formatScalar(float64(len(t))) + " items"
	case map[string]any:
		return fmt.Sprintf("{%d}", len(t))
	default:
		return formatScalar(t)
	}
}

// padTrunc pads s to width, truncating if necessary.
func padTrunc(s string, width int, ellipsis bool) string {
	if lipgloss.Width(s) > width {
		if ellipsis {
			return truncateANSI(s, width)
		}
		return truncateANSI(s, width)
	}
	return padCells(s, width)
}

func humanizeKey(k string) string {
	if k == "" {
		return ""
	}
	// "largestFiles" -> "Largest files"; "top_dirs" -> "Top dirs".
	k = strings.ReplaceAll(k, "_", " ")
	r := []rune(k)
	var b strings.Builder
	for i, c := range r {
		if i == 0 {
			b.WriteString(strings.ToUpper(string(c)))
			continue
		}
		if c >= 'A' && c <= 'Z' {
			b.WriteByte(' ')
			b.WriteRune(c + ('a' - 'A'))
			continue
		}
		b.WriteRune(c)
	}
	return b.String()
}

func numOf(v any) float64 {
	f, _ := v.(float64)
	return f
}

func humanInt(v float64) string {
	n := int64(v)
	s := fmt.Sprintf("%d", n)
	// thousands separators
	neg := strings.HasPrefix(s, "-")
	if neg {
		s = s[1:]
	}
	var parts []string
	for len(s) > 3 {
		parts = append([]string{s[len(s)-3:]}, parts...)
		s = s[:len(s)-3]
	}
	parts = append([]string{s}, parts...)
	out := strings.Join(parts, ",")
	if neg {
		out = "-" + out
	}
	return out
}

func shortDate(s string) string {
	if len(s) >= 10 {
		return s[5:10] // MM-DD
	}
	return s
}

func shortTime(s string) string {
	// 2026-09-30T11:02:43Z -> "2026-09-30 11:02"
	if len(s) >= 16 {
		return s[:10] + " " + s[11:16]
	}
	return s
}

// looksLikeTimestamp reports whether s is an ISO-8601 instant worth shortening
// in a one-line field summary.
func looksLikeTimestamp(s string) bool {
	if len(s) < 16 || s[4] != '-' || s[10] != 'T' {
		return false
	}
	for _, i := range []int{0, 1, 2, 3, 5, 6, 8, 9, 11, 12} {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

func weekdayShort(s string) string {
	if len(s) >= 3 {
		return s[:3]
	}
	return s
}

func tempCell(v any) string {
	if v == nil {
		return styleMuted.Render("–")
	}
	return fmt.Sprintf("%.0f°", numOf(v))
}

func rainCell(v any) string {
	if v == nil {
		return styleMuted.Render("–")
	}
	n := int(numOf(v))
	return fmt.Sprintf("%d%%", n)
}

// iconGlyph maps a BOM/weather icon token to a compact glyph.
func iconGlyph(icon string) string {
	switch {
	case strings.Contains(icon, "storm"), strings.Contains(icon, "thunder"):
		return "⛈"
	case strings.Contains(icon, "shower"), strings.Contains(icon, "rain"):
		return "🌧"
	case strings.Contains(icon, "snow"):
		return "❄"
	case strings.Contains(icon, "fog"), strings.Contains(icon, "haze"), strings.Contains(icon, "mist"):
		return "🌫"
	case strings.Contains(icon, "cloud"):
		return "☁"
	case strings.Contains(icon, "partly"), strings.Contains(icon, "mostly_sunny"):
		return "⛅"
	case strings.Contains(icon, "sunny"), strings.Contains(icon, "clear"):
		return "☀"
	case strings.Contains(icon, "wind"):
		return "🌬"
	default:
		return "•"
	}
}
