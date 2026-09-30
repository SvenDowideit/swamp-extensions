package ui

import (
	"regexp"
	"strings"
	"testing"
)

func TestRunConsoleAndInputRenderFits(t *testing.T) {
	ansi := regexp.MustCompile(`\x1b\[[0-9;?<=>]*[a-zA-Z]|\x1b[()][A-Z0-9]|\x1b[>=]`)
	for _, size := range [][2]int{{80, 24}, {120, 30}, {200, 50}} {
		m := New(nil, "r", nil)
		m.width, m.height = size[0], size[1]

		// Run console.
		m.runOpen = true
		m.runTitle = "wf"
		m.runStatus = "running"
		m.runLines = []string{"line one", "line two"}
		out := ansi.ReplaceAllString(m.render(), "")
		if n := len(strings.Split(out, "\n")); n > m.height {
			t.Errorf("console %dx%d rendered %d lines > height", size[0], size[1], n)
		}
		if !strings.Contains(out, "Run —") {
			t.Errorf("console missing title at %dx%d", size[0], size[1])
		}
		if !strings.Contains(out, "[run]") {
			t.Errorf("console missing hints at %dx%d", size[0], size[1])
		}

		// Input form.
		m.runOpen = false
		m.inputOpen = true
		m.inputFields = []runField{{key: "path", value: "/tmp", typ: "string"}}
		m.inputSel = 0
		out = ansi.ReplaceAllString(m.render(), "")
		if n := len(strings.Split(out, "\n")); n > m.height {
			t.Errorf("input %dx%d rendered %d lines > height", size[0], size[1], n)
		}
		if !strings.Contains(out, "Run wf") || !strings.Contains(out, "path") {
			t.Errorf("input form incomplete at %dx%d:\n%s", size[0], size[1], out)
		}
	}
}

// TestOverlaysNeverFillTerminal guards the scroll-off bug for every overlay.
func TestOverlaysNeverFillTerminal(t *testing.T) {
	for _, size := range [][2]int{{80, 24}, {120, 30}, {200, 50}} {
		m := New(nil, "r", nil)
		m.width, m.height = size[0], size[1]

		m.runOpen = true
		m.runTitle = "wf"
		m.runStatus = "running"
		m.runLines = []string{"a", "b", "c"}
		if n := len(strings.Split(m.render(), "\n")); n >= m.height {
			t.Errorf("run console %dx%d rendered %d lines (must be < %d)", size[0], size[1], n, m.height)
		}

		m.runOpen = false
		m.inputOpen = true
		m.inputFields = []runField{{key: "path", value: "/tmp", typ: "string"}}
		if n := len(strings.Split(m.render(), "\n")); n >= m.height {
			t.Errorf("input form %dx%d rendered %d lines (must be < %d)", size[0], size[1], n, m.height)
		}

		m.inputOpen = false
		m.spotterOpen = true
		m.spotterLoaded = true
		m.spotterIndex = []spotterItem{{kind: "model", label: "bom"}}
		if n := len(strings.Split(m.render(), "\n")); n >= m.height {
			t.Errorf("spotter %dx%d rendered %d lines (must be < %d)", size[0], size[1], n, m.height)
		}
	}
}
