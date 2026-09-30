package ui

import (
	"strings"
	"testing"
)

func TestMarkdownTableRenders(t *testing.T) {
	md := "Data Output\n\n| Name | Kind | Retrieval Command |\n| ---- | ---- | ----------------- |\n| publish-config | resource | swamp data get pulse publish-config --version 13 |\n"
	out := strip(strings.Join(renderMarkdown(md, 100), "\n"))
	if strings.Contains(out, "| ---- |") {
		t.Fatalf("table separator leaked into output:\n%s", out)
	}
	for _, want := range []string{"Name", "Kind", "Retrieval", "publish-config", "resource", "─"} {
		if !strings.Contains(out, want) {
			t.Errorf("table output missing %q:\n%s", want, out)
		}
	}
}
