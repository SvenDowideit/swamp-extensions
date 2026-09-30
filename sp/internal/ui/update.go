package ui

import (
	"strings"

	tea "charm.land/bubbletea/v2"
)

// Init kicks off the initial loads.
func (m *Model) Init() tea.Cmd {
	return tea.Batch(m.loadWorkflows(), m.loadModels(), m.tick())
}

func (m *Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
		// If a resize hid the focused pane, move focus to the nearest visible
		// one so keys never target an invisible pane.
		if !m.paneVisible(m.focus) {
			panes := m.visiblePanes()
			if len(panes) > 0 {
				m.focus = panes[0]
			}
		}
		return m, nil

	case workflowsLoadedMsg:
		m.wfLoaded = true
		if msg.err != nil {
			m.err = msg.err
			m.status = "error"
			return m, m.bootstrapCmd()
		}
		m.workflows = msg.workflows
		m.loading = false
		m.status = "ready"
		return m, m.bootstrapCmd()

	case modelsLoadedMsg:
		m.modelLoaded = true
		if msg.err != nil {
			m.err = msg.err
			m.status = "error"
			return m, m.bootstrapCmd()
		}
		m.models = msg.models
		m.err = nil
		m.loading = false
		m.status = "ready"
		return m, m.bootstrapCmd()

	case detailLoadedMsg:
		if msg.err != nil {
			m.err = msg.err
		}
		m.detailTitle = msg.title
		m.detailLines = msg.lines
		m.detailScroll = 0
		if msg.name != "" {
			m.rootKind = msg.root
			m.rootName = msg.name
		}
		if msg.items != nil {
			m.dataItems = msg.items
			m.dataSel = 0
			if m.pendingData != "" {
				for i, it := range m.dataItems {
					if it.label == m.pendingData {
						m.dataSel = i
						break
					}
				}
				m.pendingData = ""
			}
		}
		return m, nil

	case spotterLoadedMsg:
		m.spotterLoaded = true
		m.spotterIndex = append(append(append([]spotterItem{},
			msg.models...), msg.workflows...), msg.data...)
		if msg.err != nil {
			m.err = msg.err
		}
		return m, nil

	case tea.KeyPressMsg:
		return m.handleKey(msg)
	}
	return m, nil
}

func (m *Model) handleKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	key := msg.String()

	// Spotter overlay consumes all keys while open.
	if m.spotterOpen {
		return m.handleSpotterKey(msg)
	}

	// Filter input mode consumes most keys.
	if m.filtering {
		switch key {
		case "esc":
			m.filtering = false
			m.filter = ""
			m.resetListSel()
		case "enter":
			m.filtering = false
		case "backspace":
			if m.filter != "" {
				m.filter = m.filter[:len(m.filter)-1]
			}
			m.resetListSel()
		default:
			if len(msg.Text) > 0 {
				m.filter += msg.Text
				m.resetListSel()
			}
		}
		return m, nil
	}

	switch key {
	case "q", "ctrl+c":
		m.stopServe()
		return m, tea.Quit

	case "esc":
		// Return to the pane that owns the current root (workflow or model).
		switch {
		case m.rootKind == RootWorkflow && m.width >= 110:
			m.focus = PaneWorkflows
		default:
			m.focus = PaneModels
		}

	case "/":
		m.filtering = true
		m.filter = ""
		if m.focus == PaneWorkflows {
			m.focus = PaneWorkflows
		} else {
			m.focus = PaneModels
		}

	case "s", "ctrl+p":
		m.spotterOpen = true
		m.spotterQuery = ""
		m.spotterSel = 0
		if !m.spotterLoaded {
			return m, m.loadSpotter()
		}

	case "tab", "l", "right":
		m.focus = m.cyclePane(1)

	case "shift+tab", "h", "left":
		m.focus = m.cyclePane(-1)

	case "up", "k":
		if m.focus == PaneDetail {
			if m.detailScroll > 0 {
				m.detailScroll--
			}
		} else {
			m.moveSelection(-1)
		}
	case "down", "j":
		if m.focus == PaneDetail {
			m.detailScroll++
		} else {
			m.moveSelection(1)
		}
	case "pgup":
		if m.focus == PaneDetail {
			m.detailScroll = clamp(m.detailScroll-10, 0, len(m.detailLines))
		}
	case "pgdown":
		if m.focus == PaneDetail {
			m.detailScroll = clamp(m.detailScroll+10, 0, len(m.detailLines))
		}

	case "g":
		m.setSel(0)
	case "G":
		m.setSel(1 << 30)

	case "r":
		m.status = "reloading…"
		return m, tea.Batch(m.loadWorkflows(), m.loadModels())

	case "enter":
		switch m.focus {
		case PaneWorkflows:
			return m, m.selectWorkflow()
		case PaneModels:
			return m, m.selectModel()
		case PaneData:
			if len(m.dataItems) > 0 && m.rootName != "" {
				item := m.dataItems[clamp(m.dataSel, 0, len(m.dataItems)-1)]
				m.focus = PaneDetail
				return m, m.loadDataContent(m.rootKind, m.rootName, item.label, m.width)
			}
		}
	}
	return m, nil
}

// handleSpotterKey processes keys while the global search overlay is open.
func (m *Model) handleSpotterKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	key := msg.String()
	results := m.visibleSpotter()

	switch key {
	case "esc", "ctrl+p":
		m.spotterOpen = false
		return m, nil
	case "down", "ctrl+j", "tab":
		if len(results) > 0 {
			m.spotterSel = clamp(m.spotterSel+1, 0, len(results)-1)
		}
		return m, nil
	case "up", "ctrl+k", "shift+tab":
		if len(results) > 0 {
			m.spotterSel = clamp(m.spotterSel-1, 0, len(results)-1)
		}
		return m, nil
	case "backspace":
		if m.spotterQuery != "" {
			m.spotterQuery = m.spotterQuery[:len(m.spotterQuery)-1]
			m.spotterSel = 0
		}
		return m, nil
	case "enter":
		if len(results) == 0 {
			return m, nil
		}
		pick := results[clamp(m.spotterSel, 0, len(results)-1)]
		m.spotterOpen = false
		return m.jumpTo(pick)
	}
	if len(msg.Text) > 0 {
		m.spotterQuery += msg.Text
		m.spotterSel = 0
	}
	return m, nil
}

// jumpTo navigates the browser to the chosen search result.
func (m *Model) jumpTo(it spotterItem) (tea.Model, tea.Cmd) {
	m.filter = ""
	m.filtering = false
	switch it.kind {
	case "workflow":
		for i, n := range m.workflows {
			if n.label == it.label {
				m.wfSel = i
				break
			}
		}
		m.focus = PaneWorkflows
		return m, m.selectWorkflow()
	case "model", "data":
		for i, n := range m.models {
			if n.label == it.model {
				m.modelSel = i
				break
			}
		}
		m.focus = PaneModels
		cmd := m.selectModel()
		if it.kind == "data" {
			m.focus = PaneData
			// After detail loads, select the requested data item.
			m.pendingData = it.data
		}
		return m, cmd
	}
	return m, nil
}

// bootstrapCmd selects the initial root once, after both top-level lists have
// loaded, so the choice does not depend on which response arrives first.
func (m *Model) bootstrapCmd() tea.Cmd {
	if m.bootstrapped || !m.wfLoaded || !m.modelLoaded {
		return nil
	}
	m.bootstrapped = true
	if m.rootName != "" {
		return nil
	}
	m.wfSel = 0
	m.modelSel = 0
	// Prefer a workflow as the initial root; fall back to a model.
	if len(m.visibleWorkflows()) > 0 {
		m.focus = PaneWorkflows
		return m.selectWorkflow()
	}
	if len(m.visibleModels()) > 0 {
		m.focus = PaneModels
		return m.selectModel()
	}
	return nil
}

// visiblePanes lists the panes shown at the current width, in focus order.
func (m *Model) visiblePanes() []Pane {
	panes := []Pane{}
	if m.width >= 110 {
		panes = append(panes, PaneWorkflows)
	}
	panes = append(panes, PaneModels, PaneDetail)
	if m.width >= 84 {
		panes = append(panes, PaneData)
	}
	return panes
}

// paneVisible reports whether p is shown at the current width.
func (m *Model) paneVisible(p Pane) bool {
	for _, v := range m.visiblePanes() {
		if v == p {
			return true
		}
	}
	return false
}

// cyclePane moves focus to the next/previous visible pane.
func (m *Model) cyclePane(dir int) Pane {
	panes := m.visiblePanes()
	if len(panes) == 0 {
		return m.focus
	}
	cur := 0
	for i, p := range panes {
		if p == m.focus {
			cur = i
			break
		}
	}
	next := (cur + dir + len(panes)) % len(panes)
	return panes[next]
}

// tick is currently unused but reserved for periodic refresh.
func (m *Model) tick() tea.Cmd { return nil }

func (m *Model) moveSelection(delta int) {
	switch m.focus {
	case PaneWorkflows:
		n := len(m.visibleWorkflows())
		if n == 0 {
			return
		}
		m.wfSel = clamp(m.wfSel+delta, 0, n-1)
	case PaneModels:
		n := len(m.visibleModels())
		if n == 0 {
			return
		}
		m.modelSel = clamp(m.modelSel+delta, 0, n-1)
	case PaneData:
		n := len(m.dataItems)
		if n == 0 {
			return
		}
		m.dataSel = clamp(m.dataSel+delta, 0, n-1)
	case PaneDetail:
		// no selection semantics yet
	}
}

// resetListSel clears the focused list pane's selection after a filter change.
func (m *Model) resetListSel() {
	m.wfSel = 0
	m.modelSel = 0
}

func (m *Model) setSel(which int) {
	if which == 0 {
		m.wfSel, m.modelSel, m.dataSel = 0, 0, 0
		return
	}
	if s := m.visibleWorkflows(); len(s) > 0 {
		m.wfSel = len(s) - 1
	}
	if s := m.visibleModels(); len(s) > 0 {
		m.modelSel = len(s) - 1
	}
	if len(m.dataItems) > 0 {
		m.dataSel = len(m.dataItems) - 1
	}
}

func (m *Model) stopServe() {
	if m.serve != nil && m.serve.Owned() {
		if m.serve.LogPath() != "" {
			_ = strings.TrimSpace(m.serve.LogPath())
		}
		m.serve.Stop()
	}
}
