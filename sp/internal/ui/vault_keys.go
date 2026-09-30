package ui

import (
	"context"
	"fmt"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/svendowideit/swamp-project/sp/internal/swamp"
)

// openVaultMode opens the vault browser and loads the tree.
func (m *Model) openVaultMode() tea.Cmd {
	m.vault.open = true
	m.vault.focus = VaultFocusTree
	m.vault.sel = 0
	m.vault.err = nil
	m.vault.status = ""
	m.vault.loading = true
	m.vault.detailLines = nil
	m.vault.revealedKey = ""
	m.vault.revealedValue = ""
	m.vault.auditShown = false
	return m.loadVaultTree()
}

// handleVaultKey processes keys while Vault mode is open.
func (m *Model) handleVaultKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	// Innermost overlays first.
	if m.vault.confirmOpen {
		return m.handleVaultConfirm(msg)
	}
	if m.vault.promptOpen {
		return m.handleVaultPrompt(msg)
	}

	switch msg.String() {
	case "esc", "q":
		m.vault.open = false
		return m, nil
	case "tab":
		if m.vault.focus == VaultFocusTree {
			m.vault.focus = VaultFocusDetail
		} else {
			m.vault.focus = VaultFocusTree
		}
		return m, nil
	case "up", "k":
		return m.vaultMove(-1)
	case "down", "j":
		return m.vaultMove(1)
	case "g":
		if m.vault.focus == VaultFocusTree {
			m.vault.sel = 0
			return m, m.selectVaultRow()
		}
		m.vault.detailScrol = 0
		return m, nil
	case "G":
		if m.vault.focus == VaultFocusTree && len(m.vault.rows) > 0 {
			m.vault.sel = len(m.vault.rows) - 1
			return m, m.selectVaultRow()
		}
		return m, nil
	case "pgup":
		m.vault.detailScrol = maxInt(0, m.vault.detailScrol-10)
		return m, nil
	case "pgdown":
		m.vault.detailScrol += 10
		return m, nil
	case "enter":
		if m.vault.focus == VaultFocusTree {
			return m, m.selectVaultRow()
		}
		return m, nil
	case "r":
		if m.vault.focus == VaultFocusDetail && m.vault.detailKind == "vault" {
			return m, m.revealSelectedKey()
		}
		return m, m.loadVaultTree()
	case "a":
		return m.vaultAdd()
	case "d":
		return m.vaultDelete()
	case "e":
		return m.vaultEdit()
	case "n":
		return m.vaultAnnotate()
	case "t":
		return m.vaultToggleAudit()
	case "c":
		return m.vaultCreate()
	case "P":
		return m.vaultPullExtension()
	}
	return m, nil
}

// vaultMove moves the tree selection (or the key selection when the detail pane
// is focused).
func (m *Model) vaultMove(delta int) (tea.Model, tea.Cmd) {
	if m.vault.focus == VaultFocusDetail && m.vault.detailKind == "vault" {
		if len(m.vault.keys) > 0 {
			m.vault.keySel = clamp(m.vault.keySel+delta, 0, len(m.vault.keys)-1)
			m.vault.revealedKey = ""
			m.vault.revealedValue = ""
			return m, m.inspectVaultKey(m.selectedVaultName(), m.vault.keys[m.vault.keySel])
		}
		return m, nil
	}
	if len(m.vault.rows) == 0 {
		return m, nil
	}
	m.vault.sel = clamp(m.vault.sel+delta, 0, len(m.vault.rows)-1)
	return m, m.selectVaultRow()
}

// selectedVaultName returns the vault name for the current selection, whether a
// vault row is selected directly or the detail pane shows a vault.
func (m *Model) selectedVaultName() string {
	if row, ok := m.vaultCurrent(); ok && row.kind == "vault" {
		return row.name
	}
	return ""
}

// revealSelectedKey fetches and shows the selected key's value.
func (m *Model) revealSelectedKey() tea.Cmd {
	vault := m.selectedVaultName()
	if vault == "" || len(m.vault.keys) == 0 {
		return nil
	}
	key := m.vault.keys[clamp(m.vault.keySel, 0, len(m.vault.keys)-1)]
	if m.vault.revealedKey == key {
		m.vault.revealedKey = ""
		m.vault.revealedValue = ""
		return nil
	}
	client := m.client
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		value, err := client.ReadVaultSecret(ctx, vault, key)
		return vaultSecretLoadedMsg{vault: vault, key: key, value: value, err: err}
	}
}

// vaultToggleAudit loads or hides the audit trail for the selected vault.
func (m *Model) vaultToggleAudit() (tea.Model, tea.Cmd) {
	vault := m.selectedVaultName()
	if vault == "" {
		return m, nil
	}
	if m.vault.auditShown {
		m.vault.auditShown = false
		m.vault.audit = nil
		return m, nil
	}
	m.vault.auditShown = true
	return m, m.loadVaultAudit(vault)
}

// vaultAdd starts adding a new secret key to the selected vault.
func (m *Model) vaultAdd() (tea.Model, tea.Cmd) {
	vault := m.selectedVaultName()
	if vault == "" {
		m.vault.status = "select a vault first (its name has a •)"
		return m, nil
	}
	m.vault.promptOpen = true
	m.vault.promptKind = "put"
	m.vault.promptVault = vault
	m.vault.promptTitle = "Add secret"
	m.vault.promptLabel = "KEY=VALUE"
	m.vault.promptValue = ""
	return m, nil
}

// vaultEdit edits the selected key's value (re-put).
func (m *Model) vaultEdit() (tea.Model, tea.Cmd) {
	vault := m.selectedVaultName()
	if vault == "" || len(m.vault.keys) == 0 {
		m.vault.status = "select a key to edit"
		return m, nil
	}
	key := m.vault.keys[clamp(m.vault.keySel, 0, len(m.vault.keys)-1)]
	m.vault.promptOpen = true
	m.vault.promptKind = "put"
	m.vault.promptVault = vault
	m.vault.promptKey = key
	m.vault.promptTitle = "Edit " + key
	m.vault.promptLabel = "VALUE"
	m.vault.promptValue = ""
	return m, nil
}

// vaultDelete confirms deleting the selected key.
func (m *Model) vaultDelete() (tea.Model, tea.Cmd) {
	vault := m.selectedVaultName()
	if vault == "" || len(m.vault.keys) == 0 {
		m.vault.status = "select a key to delete"
		return m, nil
	}
	key := m.vault.keys[clamp(m.vault.keySel, 0, len(m.vault.keys)-1)]
	m.vault.confirmOpen = true
	m.vault.confirmKind = "delete-key"
	m.vault.confirmVault = vault
	m.vault.confirmKey = key
	m.vault.confirmTitle = "Delete secret"
	m.vault.confirmBody = fmt.Sprintf("Delete %q from vault %q?", key, vault)
	return m, nil
}

// vaultAnnotate prompts for an annotation note on the selected key.
func (m *Model) vaultAnnotate() (tea.Model, tea.Cmd) {
	vault := m.selectedVaultName()
	if vault == "" || len(m.vault.keys) == 0 {
		m.vault.status = "select a key to annotate"
		return m, nil
	}
	key := m.vault.keys[clamp(m.vault.keySel, 0, len(m.vault.keys)-1)]
	m.vault.promptOpen = true
	m.vault.promptKind = "annotate"
	m.vault.promptVault = vault
	m.vault.promptKey = key
	m.vault.promptTitle = "Annotate " + key
	m.vault.promptLabel = "URL or notes (blank = clear)"
	m.vault.promptValue = ""
	return m, nil
}

// vaultCreate prompts for a new vault name using the selected extension.
func (m *Model) vaultCreate() (tea.Model, tea.Cmd) {
	row, ok := m.vaultCurrent()
	var typ string
	switch {
	case ok && row.kind == "extension":
		typ = row.name
	case m.vault.detailKind == "extension" && m.vault.detailTitle != "":
		typ = strings.TrimPrefix(m.vault.detailTitle, "Vault extension — ")
	default:
		m.vault.status = "select a vault extension to create from"
		return m, nil
	}
	m.vault.promptOpen = true
	m.vault.promptKind = "create"
	m.vault.promptVault = ""
	m.vault.promptKey = typ // reuse as the create type
	m.vault.promptTitle = "Create vault (" + typ + ")"
	m.vault.promptLabel = "NAME"
	m.vault.promptValue = ""
	return m, nil
}

// vaultPullExtension pulls the selected extension into the repo.
func (m *Model) vaultPullExtension() (tea.Model, tea.Cmd) {
	row, ok := m.vaultCurrent()
	if !ok || row.kind != "extension" {
		m.vault.status = "select an extension to pull"
		return m, nil
	}
	name := row.name
	client := m.client
	m.vault.busy = true
	m.vault.status = "pulling " + name + "…"
	return m, func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
		defer cancel()
		err := client.PullExtension(ctx, name, true)
		status := "pulled " + name
		if err != nil {
			status = "pull failed: " + err.Error()
		}
		return vaultActionMsg{status: status, err: err}
	}
}

// handleVaultPrompt processes keys while a prompt is open.
func (m *Model) handleVaultPrompt(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc":
		m.vault.promptOpen = false
		return m, nil
	case "enter":
		return m.submitVaultPrompt()
	case "backspace":
		if m.vault.promptValue != "" {
			m.vault.promptValue = m.vault.promptValue[:len(m.vault.promptValue)-1]
		}
		return m, nil
	}
	if len(msg.Text) > 0 {
		m.vault.promptValue += msg.Text
	}
	return m, nil
}

// submitVaultPrompt dispatches the pending prompt action.
func (m *Model) submitVaultPrompt() (tea.Model, tea.Cmd) {
	p := &m.vault
	client := m.client
	vault, key, val := p.promptVault, p.promptKey, p.promptValue
	kind := p.promptKind
	p.promptOpen = false
	p.busy = true

	switch kind {
	case "put":
		if p.promptLabel == "KEY=VALUE" {
			// Add mode: parse KEY=VALUE.
			eq := strings.IndexByte(val, '=')
			if eq < 1 {
				p.busy = false
				p.status = "enter KEY=VALUE"
				return m, nil
			}
			key, val = val[:eq], val[eq+1:]
		}
		if key == "" {
			p.busy = false
			p.status = "key is required"
			return m, nil
		}
		p.status = "storing " + key + "…"
		return m, func() tea.Msg {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			err := client.PutVaultSecret(ctx, vault, key, val, "", "", true)
			status := "stored " + key
			if err != nil {
				status = "put failed: " + err.Error()
			}
			return vaultActionMsg{status: status, err: err, reloadKeys: vault}
		}
	case "annotate":
		if val == "" {
			p.status = "clearing annotation…"
			return m, func() tea.Msg {
				ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
				defer cancel()
				err := client.AnnotateVaultSecret(ctx, vault, key, "", "", nil, true)
				return vaultActionMsg{status: "cleared annotation " + key, err: err, reloadKeys: vault}
			}
		}
		url, notes := val, ""
		if strings.HasPrefix(val, "http://") || strings.HasPrefix(val, "https://") {
			url, notes = val, ""
		} else {
			url, notes = "", val
		}
		p.status = "annotating " + key + "…"
		return m, func() tea.Msg {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			err := client.AnnotateVaultSecret(ctx, vault, key, url, notes, nil, false)
			return vaultActionMsg{status: "annotated " + key, err: err, reloadKeys: vault}
		}
	case "create":
		typ := key // create type was stashed in promptKey
		name := val
		p.status = "creating " + name + "…"
		return m, func() tea.Msg {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			_, err := client.Request(ctx, swamp.ReqVaultCreate, map[string]any{"vaultType": typ, "name": name})
			status := "created " + name
			if err != nil {
				status = "create failed: " + err.Error()
			}
			return vaultActionMsg{status: status, err: err, reloadTree: true}
		}
	}
	return m, nil
}

// handleVaultConfirm processes the delete confirmation.
func (m *Model) handleVaultConfirm(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc", "n":
		m.vault.confirmOpen = false
		return m, nil
	case "y", "enter":
		vault, key := m.vault.confirmVault, m.vault.confirmKey
		m.vault.confirmOpen = false
		m.vault.busy = true
		m.vault.status = "deleting " + key + "…"
		client := m.client
		return m, func() tea.Msg {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			err := client.DeleteVaultSecret(ctx, vault, key)
			status := "deleted " + key
			if err != nil {
				status = "delete failed: " + err.Error()
			}
			return vaultActionMsg{status: status, err: err, reloadKeys: vault}
		}
	}
	return m, nil
}
