package ui

import (
	"strings"
	"testing"

	"charm.land/lipgloss/v2"
	"github.com/svendowideit/swamp-project/sp/internal/swamp"
)

// runDetailFixture is a run whose step produced model data, a report (markdown
// plus its -json twin), and an HTML file.
func runDetailFixture() swamp.RunDetail {
	return swamp.RunDetail{
		RunID:        "abc",
		WorkflowName: "pulse",
		Status:       "succeeded",
		Steps: []swamp.RunStep{
			{
				Name:   "render",
				Status: "succeeded",
				Artifacts: []swamp.RunArtifact{
					{Name: "store", Kind: "resource", ModelName: "pulse", Version: 5},
					{Name: "report-swamp-workflow-summary", Kind: "report", ModelName: "pulse", Version: 3, ReportName: "@swamp/workflow-summary"},
					{Name: "report-swamp-workflow-summary-json", Kind: "report", ModelName: "pulse", Version: 3, ReportName: "@swamp/workflow-summary"},
					{Name: "index.html", Kind: "file", ModelName: "pulse", Version: 21, ContentType: "text/html"},
				},
			},
		},
	}
}

func TestRenderHTMLBasicBlocks(t *testing.T) {
	src := `<!DOCTYPE html><html><head><style>body{color:red}</style></head><body>
	<h1>Pulse Report</h1>
	<p>Hello <b>world</b> and <code>inline()</code>.</p>
	<ul><li>first</li><li>second <a href="https://example.org/x">link</a></li></ul>
	<table><tr><th>Name</th><th>Count</th></tr><tr><td>issues</td><td>42</td></tr></table>
	</body></html>`
	out := strip(strings.Join(renderHTML(src, 60), "\n"))
	for _, want := range []string{"Pulse Report", "Hello world", "inline()", "first", "second", "issues", "42", "Name", "Count"} {
		if !strings.Contains(out, want) {
			t.Errorf("rendered HTML missing %q in:\n%s", want, out)
		}
	}
	if strings.Contains(out, "color:red") {
		t.Errorf("style content leaked into output:\n%s", out)
	}
}

func TestRenderHTMLWrapsLongParagraphs(t *testing.T) {
	long := strings.Repeat("word ", 80)
	out := renderHTML("<p>"+long+"</p>", 40)
	for _, ln := range out {
		if w := lipgloss.Width(ln); w > 40 {
			t.Fatalf("line width %d exceeds 40: %q", w, strip(ln))
		}
	}
	if len(out) < 3 {
		t.Fatalf("expected the paragraph to wrap over several lines, got %d", len(out))
	}
}

func TestRenderMarkdownHeadingsListsTables(t *testing.T) {
	md := "# Disk Audit\n\n" +
		"Scanned **1,146,422** files.\n\n" +
		"## Findings\n\n" +
		"| Finding | Size |\n| --- | --- |\n| Other | 44 GB |\n| VM | 21 GB |\n\n" +
		"- first item\n- second with `code`\n\n" +
		"> quoted note\n"
	out := strip(strings.Join(renderMarkdown(md, 70), "\n"))
	for _, want := range []string{
		"Disk Audit", "Scanned 1,146,422 files", "Findings",
		"Finding", "Size", "Other", "44 GB", "first item", "second with code", "quoted note",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("rendered markdown missing %q in:\n%s", want, out)
		}
	}
}

func TestParseInlineBoldCodeLink(t *testing.T) {
	runs := parseInline("a **b** and `c` and [d](http://e)")
	joined := ""
	for _, r := range runs {
		joined += r.text
	}
	if !strings.Contains(joined, "b") || !strings.Contains(joined, "c") || !strings.Contains(joined, "d") {
		t.Fatalf("inline parse lost text: %q", joined)
	}
	if !strings.Contains(joined, "http://e") {
		t.Fatalf("inline parse lost link url: %q", joined)
	}
}

func TestKindForContentType(t *testing.T) {
	cases := []struct{ ct, name, want string }{
		{"text/html", "news-page", "html"},
		{"text/markdown", "report-x", "markdown"},
		{"application/json", "current", "json"},
		{"", "index.html", "html"},
		{"", "report-x", "text"},
	}
	for _, c := range cases {
		if got := kindForContentType(c.ct, c.name); got != c.want {
			t.Errorf("kindForContentType(%q,%q)=%q want %q", c.ct, c.name, got, c.want)
		}
	}
}

func TestOutputsFromRunDedupesAndLabels(t *testing.T) {
	f := runDetailFixture()
	outs := outputsFromRun(&f)
	// report-swamp-method-summary-json must be dropped as the JSON twin.
	for _, o := range outs {
		if strings.HasSuffix(o.name, "-json") {
			t.Fatalf("json report twin should be dropped: %+v", o)
		}
	}
	if len(outs) < 3 {
		t.Fatalf("expected resource + report + file, got %d: %+v", len(outs), outs)
	}
	var sawReport, sawFile bool
	for _, o := range outs {
		switch o.kind {
		case "report":
			sawReport = true
			if !strings.Contains(runOutputLabel(o), "report ") {
				t.Errorf("report label: %q", runOutputLabel(o))
			}
		case "file":
			sawFile = true
		}
	}
	if !sawReport || !sawFile {
		t.Fatalf("expected a report and a file output: %+v", outs)
	}
}
