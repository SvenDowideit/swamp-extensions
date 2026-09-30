package ui

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
)

// artifactLoadedMsg delivers the content of one run output for the viewer.
// For JSON artifacts, names/cache carry the applicable contextual views.
type artifactLoadedMsg struct {
	title string
	kind  string
	lines []string
	names []string
	cache map[string][]string
	err   error
}

// moveDetailSel moves the run-output selection in the Detail pane. When there
// are no links it falls back to plain scrolling.
func (m *Model) moveDetailSel(delta int) {
	if len(m.detailLinks) == 0 {
		m.detailScroll = clamp(m.detailScroll+delta, 0, len(m.detailLines))
		return
	}
	if m.detailSel < 0 {
		m.detailSel = 0
	} else {
		m.detailSel = clamp(m.detailSel+delta, 0, len(m.detailLinks)-1)
	}
	m.scrollToDetailLine(m.detailLinks[m.detailSel].line)
}

// scrollToDetailLine keeps line visible within the detail viewport.
func (m *Model) scrollToDetailLine(line int) {
	// body height = total - 1 (footer guard) - header - footer; the pane's
	// inner height is that minus 3 (2 border rows + title).
	viewport := m.height - 1 - 1 - 1 - 3
	if viewport < 1 {
		viewport = 1
	}
	if line < m.detailScroll {
		m.detailScroll = line
	}
	if line >= m.detailScroll+viewport {
		m.detailScroll = line - viewport + 1
	}
	if m.detailScroll < 0 {
		m.detailScroll = 0
	}
}

// openArtifact opens the viewer for a run-output link.
func (m *Model) openArtifact(lk detailLink) tea.Cmd {
	m.viewRunID = lk.runID
	return m.openDataRef(lk.artifact)
}

// openDataRef opens the viewer dialog for any data reference (a run output, a
// Playground result row, …) and fetches its content.
func (m *Model) openDataRef(art runOutput) tea.Cmd {
	m.viewOpen = true
	m.viewLoading = true
	m.viewErr = nil
	m.viewScroll = 0
	m.viewArtifact = art
	m.viewTitle = artifactTitle(art)
	m.viewKind = kindForContentType(art.contentType, art.name)
	m.viewNames = nil
	m.viewIdx = 0
	m.viewCache = nil
	m.viewLines = []string{styleMuted.Render("loading " + art.name + "…")}
	return m.loadArtifact(art)
}

func artifactTitle(a runOutput) string {
	name := a.name
	if a.kind == "report" && a.reportName != "" {
		name = a.reportName
	}
	if a.version > 0 {
		name = fmt.Sprintf("%s v%d", name, a.version)
	}
	if a.modelName != "" {
		name = name + "  " + a.modelName
	}
	return name
}

// kindForContentType decides how to render content: html, markdown, json, text.
func kindForContentType(ct, name string) string {
	switch {
	case strings.Contains(ct, "html"):
		return "html"
	case strings.Contains(ct, "markdown"), strings.Contains(ct, "x-markdown"):
		return "markdown"
	case strings.Contains(ct, "json"):
		return "json"
	}
	lower := strings.ToLower(name)
	switch {
	case strings.HasSuffix(lower, ".html"), strings.HasSuffix(lower, ".htm"):
		return "html"
	case strings.HasSuffix(lower, ".md"):
		return "markdown"
	case strings.HasSuffix(lower, ".json"):
		return "json"
	}
	return "text"
}

// loadArtifact fetches the artifact content and renders it off the event loop.
// The artifact is identified by its owning model plus data name and version
// (data.get does not accept a bare data id).
func (m *Model) loadArtifact(a runOutput) tea.Cmd {
	client := m.client
	width := m.width
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		d, err := client.GetDataScoped(ctx, false, a.modelName, a.name, a.version)
		if err != nil {
			// The run record lists the artifact, but its data may have been
			// garbage-collected since. Report that distinctly from a transport
			// error so the user understands why it is missing.
			if strings.Contains(err.Error(), "not found") {
				return artifactLoadedMsg{
					title: artifactTitle(a),
					kind:  kindForContentType(a.contentType, a.name),
					lines: []string{
						styleOrange.Render("artifact no longer available"),
						"",
						styleMuted.Render("The run recorded this output, but the data has since "),
						styleMuted.Render("been garbage-collected (reports keep only a few versions)."),
						"",
						styleMuted.Render("Re-run the workflow to regenerate it."),
					},
				}
			}
			return artifactLoadedMsg{title: artifactTitle(a), kind: kindForContentType(a.contentType, a.name), err: err}
		}
		ct := str(d["contentType"])
		if ct == "" {
			ct = a.contentType
		}
		kind := kindForContentType(ct, a.name)
		content := str(d["content"])
		msg := artifactLoadedMsg{
			title: artifactTitle(a),
			kind:  kind,
			lines: renderArtifact(kind, content, d, width),
		}
		// JSON artifacts get the contextual view registry: a list of applicable
		// views (type-specific first, raw json last) that the user can cycle.
		if kind == "json" {
			innerW := width - 8
			if innerW < 20 {
				innerW = 20
			}
			if names, cache := dataViews(content, innerW); len(names) > 0 {
				msg.names = names
				msg.cache = cache
				msg.lines = cache[names[0]]
			}
		}
		return msg
	}
}

// renderArtifact turns raw content into display lines for the given kind.
func renderArtifact(kind, content string, d map[string]any, width int) []string {
	innerW := width - 8
	if innerW < 20 {
		innerW = 20
	}
	switch kind {
	case "html":
		lines := renderHTML(content, innerW)
		return append([]string{styleMuted.Render("rendered HTML (source in the swamp report)"), ""}, lines...)
	case "markdown":
		return renderMarkdown(content, innerW)
	case "json":
		return prettyJSON(content, innerW)
	default:
		return wrapString(content, innerW)
	}
}

// prettyJSON indents JSON content; falls back to plain text.
func prettyJSON(content string, width int) []string {
	var v any
	if err := json.Unmarshal([]byte(content), &v); err != nil {
		return wrapString(content, width)
	}
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return wrapString(content, width)
	}
	return strings.Split(string(b), "\n")
}

// handleViewKey processes keys while the artifact viewer is open.
func (m *Model) handleViewKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	viewH := m.viewInnerHeight()
	switch msg.String() {
	case "esc", "q":
		m.viewOpen = false
		m.viewLines = nil
	case "up", "k":
		m.viewScroll = clamp(m.viewScroll-1, 0, maxInt(0, len(m.viewLines)-viewH))
	case "down", "j":
		m.viewScroll = clamp(m.viewScroll+1, 0, maxInt(0, len(m.viewLines)-viewH))
	case "pgup":
		m.viewScroll = clamp(m.viewScroll-10, 0, maxInt(0, len(m.viewLines)-viewH))
	case "pgdown":
		m.viewScroll = clamp(m.viewScroll+10, 0, maxInt(0, len(m.viewLines)-viewH))
	case "g", "home":
		m.viewScroll = 0
	case "G", "end":
		m.viewScroll = maxInt(0, len(m.viewLines)-viewH)
	case "v":
		m.cycleView(1)
	}
	return m, nil
}

// cycleView switches to the next/previous contextual view of a JSON artifact.
func (m *Model) cycleView(dir int) {
	if len(m.viewNames) == 0 {
		return
	}
	m.viewIdx = (m.viewIdx + dir + len(m.viewNames)) % len(m.viewNames)
	if lines, ok := m.viewCache[m.viewNames[m.viewIdx]]; ok {
		m.viewLines = lines
		m.viewScroll = 0
	}
}

// viewInnerHeight is the number of content rows the viewer dialog shows.
func (m *Model) viewInnerHeight() int {
	h := clamp(m.height*80/100, 10, m.height-4)
	return h - 4
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}
