package nn

import (
	"context"

	tea "charm.land/bubbletea/v2"
	"github.com/svendowideit/swamp-project/sp/internal/swamp"
)

// cursorItem is the item under the menu cursor on the current page.
func (m *Model) cursorItem() *Item {
	items := m.pageItems()
	if m.cursor < 0 || m.cursor >= len(items) {
		return nil
	}
	return items[m.cursor]
}

// openForm opens the run form for a "+ run" item.
func (m *Model) openForm(it *Item) (tea.Model, tea.Cmd) {
	if it == nil {
		return m, nil
	}
	workflow := scalar(it.Raw["workflow"])
	if workflow == "" {
		m.status = "this item has no workflow to run"
		return m, nil
	}
	if errMsg := scalar(it.Raw["inputError"]); errMsg != "" {
		m.status = "cannot read inputs: " + errMsg
		return m, nil
	}
	m.form = newForm(workflow, it.Raw["inputs"], m.store.LastInputs(workflow))
	m.mode = modeForm
	m.status = ""
	return m, nil
}

// handleFormKey drives the run form.
func (m *Model) handleFormKey(key string) (tea.Model, tea.Cmd) {
	f := m.form
	if f == nil {
		m.mode = modeMenu
		return m, nil
	}

	if f.editing {
		if fld := f.current(); fld != nil {
			switch key {
			case "esc":
				f.editing = false
				fld.Reset()
			case "enter":
				f.editing = false
			case "backspace":
				if fld.Text != "" {
					r := []rune(fld.Text)
					fld.Text = string(r[:len(r)-1])
				}
			case "space":
				fld.Text += " "
			default:
				if len([]rune(key)) == 1 {
					fld.Text += key
				}
			}
		}
		return m, nil
	}

	switch key {
	case "esc", "=":
		m.form = nil
		m.mode = modeMenu
		return m, nil
	case "Q":
		m.leaveGroup()
		m.quit = true
		return m, tea.Quit
	case "tab", "down", "j":
		f.move(1)
	case "shift+tab", "up", "k":
		f.move(-1)
	case "space":
		if fld := f.current(); fld != nil && fld.IsBool() {
			fld.Bool = !fld.Bool
		} else if fld := f.current(); fld != nil {
			f.editing = true
		}
	case "enter":
		if fld := f.current(); fld != nil && !fld.IsBool() {
			f.editing = true
		}
	case "ctrl+r":
		f.restore(m.store.LastInputs(f.workflow))
	case "ctrl+s":
		inputs, err := f.submitValues()
		if err != nil {
			f.err = err.Error()
			return m, nil
		}
		f.err = ""
		m.store.SetLastInputs(f.workflow, inputs)
		return m, m.startRun(f.workflow, inputs)
	}
	return m, nil
}

// startRun launches a workflow run and switches to the live item UI.
func (m *Model) startRun(workflow string, inputs map[string]any) tea.Cmd {
	api := m.runAPI
	if api == nil {
		m.status = "no run client: cannot start workflows"
		return nil
	}
	m.live = newLive(workflow)
	m.form = nil
	m.mode = modeLive
	m.status = ""

	payload := map[string]any{"workflowIdOrName": workflow, "skipAllReports": true}
	if len(inputs) > 0 {
		payload["inputs"] = inputs
	}
	return func() tea.Msg {
		h, err := api.StartRun(context.Background(), swamp.ReqWorkflowRun, payload)
		if err != nil {
			return runDoneMsg{err: err}
		}
		return runStartedMsg{handle: h}
	}
}

// handleLiveKey drives the live run view.
func (m *Model) handleLiveKey(key string) (tea.Model, tea.Cmd) {
	l := m.live
	if l == nil {
		m.mode = modeMenu
		return m, nil
	}
	switch key {
	case "Q":
		m.leaveGroup()
		m.quit = true
		return m, tea.Quit
	case "q":
		// Detach: the server owns the run, so leaving the view does not stop it.
		m.mode = modeMenu
		m.live = nil
		m.runHandle = nil
		m.reloadCurrent()
		return m, nil
	case "x":
		if h := m.runHandle; h != nil {
			_ = h.Cancel(context.Background())
			l.add(styleOrangeS.Render("· cancel requested"))
		}
	case "space", "enter", "=":
		if l.done {
			m.mode = modeMenu
			m.live = nil
			m.reloadCurrent()
		}
	case "down", "j":
		l.scroll += 1
	case "up", "k":
		l.scroll -= 1
	}
	return m, nil
}

// reloadCurrent refreshes the current group in place (history after a run).
func (m *Model) reloadCurrent() tea.Cmd {
	if m.cur == nil {
		return nil
	}
	return m.loadCmd(m.cur)
}

// renderForm draws the run form with its status line.
func (m *Model) renderForm() []string {
	if m.form == nil {
		return []string{styleDim.Render("no form")}
	}
	body := m.form.render(m.bodyWidth(), m.bodyHeight())
	return body
}

// renderLive draws the live run.
func (m *Model) renderLive() []string {
	if m.live == nil {
		return []string{styleDim.Render("no run")}
	}
	out := []string{m.live.header(m.bodyWidth()), ""}
	return append(out, m.live.render(m.bodyWidth(), m.bodyHeight()-2)...)
}
