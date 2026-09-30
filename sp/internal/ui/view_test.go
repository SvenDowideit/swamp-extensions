package ui

import (
	"regexp"
	"strings"
	"testing"
)

var ansiRe = regexp.MustCompile(`\x1b\[[0-9;?<=>]*[a-zA-Z]|\x1b[()][A-Z0-9]|\x1b[>=]`)

func strip(s string) string { return ansiRe.ReplaceAllString(s, "") }

func sampleModel() *Model {
	m := New(nil, "swamp-project", nil)
	m.width, m.height = 140, 40
	m.models = []node{
		{label: "bom", sub: "@svendowideit/bom-weather", kind: "model"},
		{label: "ideas-factory", sub: "@svendowideit/ideas-factory", kind: "model"},
		{label: "meta-factory", sub: "@svendowideit/meta-factory", kind: "model"},
	}
	m.detailTitle = "bom"
	m.detailLines = []string{
		"name bom",
		"type @svendowideit/bom-weather",
		"",
		"Methods",
		"  • resolve",
		"  • sync",
	}
	m.dataItems = []node{
		{label: "forecast", sub: "resource v9  3.2 KiB", kind: "data"},
		{label: "hourly", sub: "resource v11  21.8 KiB", kind: "data"},
	}
	return m
}

func TestRenderContainsPanes(t *testing.T) {
	m := sampleModel()
	out := strip(m.render())
	for _, want := range []string{
		"swamp browser", "swamp-project",
		"Models (3)", "Detail", "Data (2)",
		"bom", "ideas-factory", "meta-factory",
		"Methods", "resolve", "sync",
		"forecast", "hourly",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("render missing %q", want)
		}
	}
}

func TestHeaderHasOriginAndSpacing(t *testing.T) {
	m := sampleModel()
	header := strip(strings.SplitN(m.render(), "\n", 2)[0])
	if !strings.Contains(header, "existing serve") {
		t.Fatalf("header missing origin label: %q", header)
	}
	if strings.Contains(header, "swamp-projectexisting") {
		t.Fatalf("header missing spacing between repo and origin: %q", header)
	}
}

func TestFilterNarrowsModelList(t *testing.T) {
	m := sampleModel()
	m.filter = "factory"
	got := m.visibleModels()
	if len(got) != 2 {
		t.Fatalf("filter 'factory' matched %d, want 2", len(got))
	}
	m.filter = "bom"
	got = m.visibleModels()
	if len(got) != 1 || got[0].label != "bom" {
		t.Fatalf("filter 'bom' got %+v", got)
	}
}

func TestHumanSize(t *testing.T) {
	cases := map[float64]string{
		512:    "512 B",
		2048:   "2.0 KiB",
		3276.8: "3.2 KiB",
	}
	for in, want := range cases {
		if got := humanSize(in); got != want {
			t.Errorf("humanSize(%v)=%q want %q", in, got, want)
		}
	}
}

func TestVisibleSpotterRanksAndFilters(t *testing.T) {
	m := New(nil, "r", nil)
	m.spotterIndex = []spotterItem{
		{kind: "data", label: "forecast", sub: "resource v9", model: "bom", data: "forecast"},
		{kind: "model", label: "bom", sub: "@svendowideit/bom-weather", model: "bom"},
		{kind: "workflow", label: "disk", sub: "1 jobs · 1 steps"},
		{kind: "model", label: "forecast-service", sub: "x", model: "forecast-service"},
	}
	m.spotterQuery = "forecast"
	got := m.visibleSpotter()
	if len(got) != 2 {
		t.Fatalf("want 2 matches, got %d: %+v", len(got), got)
	}
	// Exact match ranks first.
	if got[0].label != "forecast" {
		t.Fatalf("exact match should rank first, got %q", got[0].label)
	}

	m.spotterQuery = "bom"
	got = m.visibleSpotter()
	if len(got) != 1 || got[0].kind != "model" {
		t.Fatalf("query 'bom' should match the model, got %+v", got)
	}

	m.spotterQuery = ""
	got = m.visibleSpotter()
	if len(got) != 4 {
		t.Fatalf("empty query should show up to all items, got %d", len(got))
	}
}

func TestHintsAreContextSensitive(t *testing.T) {
	m := sampleModel()

	m.focus = PaneModels
	got := strip(renderHints(m.keyHints(), 200))
	if !strings.Contains(got, "[models]") || !strings.Contains(got, "open") {
		t.Fatalf("models hints wrong: %q", got)
	}

	m.focus = PaneDetail
	got = strip(renderHints(m.keyHints(), 200))
	if !strings.Contains(got, "[detail]") || !strings.Contains(got, "scroll") {
		t.Fatalf("detail hints wrong: %q", got)
	}

	m.focus = PaneData
	got = strip(renderHints(m.keyHints(), 200))
	if !strings.Contains(got, "[data]") || !strings.Contains(got, "view content") {
		t.Fatalf("data hints wrong: %q", got)
	}

	m.filtering = true
	got = strip(renderHints(m.keyHints(), 200))
	if !strings.Contains(got, "filter models") {
		t.Fatalf("filter hints wrong: %q", got)
	}
}

func TestHintsDropWhenNarrow(t *testing.T) {
	m := sampleModel()
	m.focus = PaneModels
	wide := strip(renderHints(m.keyHints(), 400))
	narrow := strip(renderHints(m.keyHints(), 20))
	if len(narrow) >= len(wide) {
		t.Fatalf("narrow bar should drop hints: wide=%q narrow=%q", wide, narrow)
	}
	if !strings.Contains(narrow, "[models]") {
		t.Fatalf("first hint should survive: %q", narrow)
	}
}

func TestFooterRendersError(t *testing.T) {
	m := sampleModel()
	m.err = errTest{}
	got := strip(m.renderFooter())
	if !strings.Contains(got, "boom") {
		t.Fatalf("footer should show error, got %q", got)
	}
}

type errTest struct{}

func (errTest) Error() string { return "boom" }
