package ui

import (
	"strings"

	tea "charm.land/bubbletea/v2"
)

// Init kicks off the initial loads.
func (m *Model) Init() tea.Cmd {
	return tea.Batch(m.loadModels(), m.tick())
}

func (m *Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
		return m, nil

	case modelsLoadedMsg:
		if msg.err != nil {
			m.err = msg.err
			m.status = "error"
			return m, nil
		}
		m.models = msg.models
		m.err = nil
		m.loading = false
		m.status = "ready"
		return m, m.selectModel()

	case detailLoadedMsg:
		if msg.err != nil {
			m.err = msg.err
		}
		m.detailTitle = msg.title
		m.detailLines = msg.lines
		m.detailScroll = 0
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
			m.modelSel = 0
		case "enter":
			m.filtering = false
		case "backspace":
			if m.filter != "" {
				m.filter = m.filter[:len(m.filter)-1]
			}
			m.modelSel = 0
		default:
			if len(msg.Text) > 0 {
				m.filter += msg.Text
				m.modelSel = 0
			}
		}
		return m, nil
	}

	switch key {
	case "q", "ctrl+c":
		m.stopServe()
		return m, tea.Quit

	case "esc":
		if m.focus != PaneModels {
			m.focus = PaneModels
		}

	case "/":
		m.filtering = true
		m.focus = PaneModels

	case "s", "ctrl+p":
		m.spotterOpen = true
		m.spotterQuery = ""
		m.spotterSel = 0
		if !m.spotterLoaded {
			return m, m.loadSpotter()
		}

	case "tab", "l", "right":
		m.focus = (m.focus + 1) % PaneCount

	case "shift+tab", "h", "left":
		m.focus = (m.focus + PaneCount - 1) % PaneCount

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
		return m, m.loadModels()

	case "enter":
		if m.focus == PaneModels {
			return m, m.selectModel()
		}
		if m.focus == PaneData {
			models := m.visibleModels()
			if len(models) > 0 && len(m.dataItems) > 0 {
				sel := models[clamp(m.modelSel, 0, len(models)-1)]
				item := m.dataItems[clamp(m.dataSel, 0, len(m.dataItems)-1)]
				m.focus = PaneDetail
				return m, m.loadDataContent(sel.label, item.label, m.width)
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
	switch it.kind {
	case "model", "data":
		// Select the model in the models pane, then load its detail.
		for i, n := range m.models {
			if n.label == it.model {
				m.filter = ""
				m.filtering = false
				m.modelSel = i
				break
			}
		}
		m.focus = PaneModels
		cmd := m.selectModel()
		if it.kind == "data" {
			m.focus = PaneData
			// After detail loads, select the requested data item. We set a
			// pending hint consumed in the detailLoadedMsg handler.
			m.pendingData = it.data
		}
		return m, cmd
	case "workflow":
		// Workflows are not yet a pane; fall back to filtering the model list
		// is wrong, so just surface it in the status until the workflow pane
		// lands. (Next roadmap item.)
		m.status = "workflow: " + it.label + " (workflow pane coming next)"
		return m, nil
	}
	return m, nil
}

// tick is currently unused but reserved for periodic refresh.
func (m *Model) tick() tea.Cmd { return nil }

func (m *Model) moveSelection(delta int) {
	switch m.focus {
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

func (m *Model) setSel(which int) {
	if which == 0 {
		m.modelSel = 0
		m.dataSel = 0
		return
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
