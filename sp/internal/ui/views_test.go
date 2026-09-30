package ui

import (
	"strings"
	"testing"
)

const forecastJSON = `{
  "forecastRegion": "Brisbane",
  "issueTime": "2026-09-30T11:02:43Z",
  "place": {"name": "Stafford Heights", "state": "QLD", "postcode": "4053"},
  "days": [
    {"date": "2026-09-30", "weekday": "Wednesday", "icon": "mostly_sunny", "shortText": "Clear.", "tempMin": null, "tempMax": 24, "rainChance": 20},
    {"date": "2026-10-01", "weekday": "Thursday", "icon": "partly_cloudy", "shortText": "Partly cloudy.", "tempMin": 13, "tempMax": 25, "rainChance": 5}
  ]
}`

const diskJSON = `{
  "rootPath": "/",
  "totalBytes": 115900000000,
  "categories": [
    {"category": "other", "label": "Other", "totalBytes": 111402517144, "fileCount": 680070, "fraction": 0.6417},
    {"category": "vm", "label": "VM/disk images", "totalBytes": 21802379825, "fileCount": 24, "fraction": 0.1256},
    {"category": "database", "label": "Databases", "totalBytes": 8395505552, "fileCount": 2277, "fraction": 0.0484}
  ],
  "largestFiles": [
    {"name": "swap.img", "bytes": 8589934592, "category": "vm"},
    {"name": "AGENTS.md", "bytes": 5326, "extension": "md"}
  ]
}`

func TestForecastViewDetectedAndRendered(t *testing.T) {
	names, cache := dataViews(forecastJSON, 80)
	if len(names) == 0 || names[0] != "forecast" {
		t.Fatalf("expected forecast as the first view, got %v", names)
	}
	if names[len(names)-1] != "json" {
		t.Fatalf("json must always be the last view, got %v", names)
	}
	out := strip(strings.Join(cache["forecast"], "\n"))
	for _, want := range []string{"Stafford Heights", "Brisbane", "Wed 09-30", "Clear.", "24°", "Thu 10-01"} {
		if !strings.Contains(out, want) {
			t.Errorf("forecast view missing %q:\n%s", want, out)
		}
	}
	if strings.Contains(out, "null") {
		t.Errorf("forecast view should render missing temps as –, not null:\n%s", out)
	}
}

func TestBarsViewDetectedAndProportional(t *testing.T) {
	names, cache := dataViews(diskJSON, 80)
	if len(names) == 0 || names[0] != "bars" {
		t.Fatalf("expected bars as the first view, got %v", names)
	}
	out := strip(strings.Join(cache["bars"], "\n"))
	for _, want := range []string{"Categories", "Other", "VM/disk images", "Databases", "%"} {
		if !strings.Contains(out, want) {
			t.Errorf("bars view missing %q:\n%s", want, out)
		}
	}
	if !strings.Contains(out, "█") {
		t.Errorf("bars view should draw bars:\n%s", out)
	}
	// The largest category's bar must be at least as long as the smallest.
	lines := strings.Split(strip(strings.Join(cache["bars"], "\n")), "\n")
	barLen := func(s string) int { return strings.Count(s, "█") }
	var lens []int
	for _, ln := range lines {
		if strings.Contains(ln, "█") {
			lens = append(lens, barLen(ln))
		}
	}
	if len(lens) < 2 || lens[0] < lens[len(lens)-1] {
		t.Fatalf("expected descending bar lengths, got %v", lens)
	}
}

func TestTableViewForGenericArray(t *testing.T) {
	json := `{"largestFiles":[
	  {"name":"swap.img","bytes":8589934592,"category":"vm"},
	  {"name":"AGENTS.md","bytes":5326,"extension":"md"}
	]}`
	names, cache := dataViews(json, 80)
	if !containsStr(names, "table") {
		t.Fatalf("expected a table view for an array of objects, got %v", names)
	}
	out := strip(strings.Join(cache["table"], "\n"))
	for _, want := range []string{"swap.img", "AGENTS.md"} {
		if !strings.Contains(out, want) {
			t.Errorf("table view missing %q:\n%s", want, out)
		}
	}
}

func TestFieldsViewAlwaysForObjects(t *testing.T) {
	json := `{"place":{"name":"x"},"issueTime":"2026-09-30T11:02:43Z","unchanged":true,"count":3}`
	names, cache := dataViews(json, 80)
	if !containsStr(names, "fields") {
		t.Fatalf("expected a fields view for an object, got %v", names)
	}
	out := strip(strings.Join(cache["fields"], "\n"))
	for _, want := range []string{"issueTime", "2026-09-30 11:02", "unchanged", "true", "{1 fields}"} {
		if !strings.Contains(out, want) {
			t.Errorf("fields view missing %q:\n%s", want, out)
		}
	}
}

func TestNonJSONHasNoViews(t *testing.T) {
	if names, _ := dataViews("not json at all", 80); names != nil {
		t.Fatalf("non-JSON content should have no contextual views, got %v", names)
	}
}

func TestCycleViewSwitchesRenderedLines(t *testing.T) {
	m := sampleModel()
	m.viewOpen = true
	m.viewKind = "json"
	names, cache := dataViews(forecastJSON, 80)
	m.viewNames = names
	m.viewCache = cache
	m.viewIdx = 0
	m.viewLines = cache[names[0]]

	first := strip(strings.Join(m.viewLines, "\n"))
	m.cycleView(1)
	if m.viewIdx != 1 {
		t.Fatalf("cycle advanced to %d", m.viewIdx)
	}
	second := strip(strings.Join(m.viewLines, "\n"))
	if first == second {
		t.Fatalf("cycling views should change the rendered lines")
	}
	// Cycling all the way round returns to the start.
	for i := 0; i < len(names)-1; i++ {
		m.cycleView(1)
	}
	if m.viewIdx != 0 {
		t.Fatalf("cycling should wrap to the first view, got %d", m.viewIdx)
	}
}

func TestHumanIntAndMeasure(t *testing.T) {
	if got := humanInt(1146422); got != "1,146,422" {
		t.Errorf("humanInt(1146422)=%q", got)
	}
	if got := formatMeasure(1536, "bytes"); got != "1.5 KiB" {
		t.Errorf("formatMeasure bytes=%q", got)
	}
	if got := humanizeKey("largestFiles"); got != "Largest files" {
		t.Errorf("humanizeKey=%q", got)
	}
}
