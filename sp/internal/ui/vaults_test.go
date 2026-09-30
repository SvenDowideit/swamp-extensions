package ui

import (
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/svendowideit/swamp-project/sp/internal/swamp"
)

func vaultModel() *Model {
	m := sampleModel()
	m.width, m.height = 150, 42
	m.vault.open = true
	m.vault.focus = VaultFocusTree
	return m
}

func TestBuildVaultRowsTree(t *testing.T) {
	types := []swamp.VaultType{
		{Type: "local_encryption", Name: "Local Encryption", Description: "AES-GCM local files"},
		{Type: "@x/systemd-creds", Name: "systemd-creds Vault", Description: "systemd creds"},
	}
	vaults := []swamp.Vault{
		{Name: "b-vault", Type: "@x/systemd-creds"},
		{Name: "a-vault", Type: "@x/systemd-creds"},
		{Name: "local-one", Type: "local_encryption"},
	}
	rows := buildVaultRows(types, vaults)

	// Extension rows first, each followed by its (sorted) vaults.
	if rows[0].kind != "extension" || rows[0].name != "@x/systemd-creds" {
		t.Fatalf("expected sorted extension first, got %+v", rows[0])
	}
	if rows[1].kind != "vault" || rows[1].name != "a-vault" {
		t.Fatalf("expected a-vault nested under extension, got %+v", rows[1])
	}
	if rows[1].depth != 1 {
		t.Fatalf("vault rows should be indented (depth 1)")
	}
	if rows[2].name != "b-vault" {
		t.Fatalf("vaults not sorted: %+v", rows[2])
	}
	// local_encryption extension + its vault.
	var sawLocal bool
	for _, r := range rows {
		if r.kind == "extension" && r.name == "local_encryption" {
			sawLocal = true
		}
	}
	if !sawLocal {
		t.Fatalf("local_encryption extension missing from tree: %+v", rows)
	}
}

func TestVaultModeOpensAndRenders(t *testing.T) {
	m := sampleModel()
	m.width, m.height = 150, 42
	m.Update(m.openVaultMode())
	if !m.vault.open {
		t.Fatalf("openVaultMode should set open")
	}
	// Feed a tree. (The select command is not executed here — no live client.)
	m.Update(vaultTreeLoadedMsg{
		types: []swamp.VaultType{{Type: "@x/v", Name: "V", Description: "d"}},
		vaults: []swamp.Vault{
			{Name: "prod", Type: "@x/v"},
		},
	})
	out := strip(m.render())
	for _, want := range []string{"Vaults", "Extensions & vaults", "@x/v", "prod"} {
		if !strings.Contains(out, want) {
			t.Errorf("vault render missing %q:\n%s", want, out)
		}
	}
}

func TestVaultKeysTableAndSelection(t *testing.T) {
	m := vaultModel()
	m.vault.rows = []VaultRow{
		{kind: "extension", name: "@x/v", typeName: "V"},
		{kind: "vault", name: "prod", vault: swamp.Vault{Name: "prod", Type: "@x/v"}},
	}
	m.vault.sel = 1
	m.Update(vaultKeysLoadedMsg{vault: "prod", keys: []string{"API_KEY", "DB_URL", "TOKEN"}})
	m.vault.keyMeta = map[string]swamp.VaultKeyMeta{
		"API_KEY": {ValueType: "string", SizeChars: 24},
	}
	out := strip(m.render())
	for _, want := range []string{"API_KEY", "DB_URL", "TOKEN", "Key — "} {
		if !strings.Contains(out, want) {
			t.Errorf("keys table missing %q:\n%s", want, out)
		}
	}
	// Move the key selection while the detail pane is focused.
	m.vault.focus = VaultFocusDetail
	m.vault.keySel = 0
	_, _ = m.vaultMove(1)
	if m.vault.keySel != 1 {
		t.Fatalf("key selection should advance to 1, got %d", m.vault.keySel)
	}
	_, _ = m.vaultMove(-1)
	if m.vault.keySel != 0 {
		t.Fatalf("key selection should return to 0, got %d", m.vault.keySel)
	}
}

func TestVaultRevealTogglesAndStores(t *testing.T) {
	m := vaultModel()
	m.vault.rows = []VaultRow{{kind: "vault", name: "prod", vault: swamp.Vault{Name: "prod"}}}
	m.vault.sel = 0
	m.vault.detailKind = "vault"
	m.vault.keys = []string{"API_KEY"}
	m.vault.keySel = 0

	// Toggle reveal on -> command issued.
	cmd := m.revealSelectedKey()
	if cmd == nil {
		t.Fatalf("reveal should issue a command")
	}
	m.Update(vaultSecretLoadedMsg{vault: "prod", key: "API_KEY", value: "s3cr3t"})
	out := strip(m.render())
	if !strings.Contains(out, "s3cr3t") {
		t.Fatalf("revealed value not shown:\n%s", out)
	}
	// Toggle again clears without a command.
	if c := m.revealSelectedKey(); c != nil {
		t.Fatalf("second reveal press should hide, not refetch")
	}
	if m.vault.revealedValue != "" {
		t.Fatalf("revealed value should be cleared")
	}
}

func TestVaultAddPromptParsesKeyValue(t *testing.T) {
	m := vaultModel()
	m.vault.rows = []VaultRow{{kind: "vault", name: "prod", vault: swamp.Vault{Name: "prod"}}}
	m.vault.sel = 0
	m.vault.detailKind = "vault"
	m.Update(vaultKeysLoadedMsg{vault: "prod", keys: []string{"EXISTING"}})

	// 'a' opens the add prompt.
	model, _ := m.vaultAdd()
	m = model.(*Model)
	if !m.vault.promptOpen || m.vault.promptKind != "put" {
		t.Fatalf("add should open a put prompt: %+v", m.vault)
	}
	m.vault.promptValue = "NEWKEY=hello"
	_, cmd := m.submitVaultPrompt()
	if cmd == nil {
		t.Fatalf("submitting a valid KEY=VALUE should issue a put command")
	}
	if m.vault.promptOpen {
		t.Fatalf("prompt should be closed after submit")
	}
	// A malformed value is rejected without a command.
	m.vault.promptOpen = true
	m.vault.promptValue = "nokeyhere"
	_, cmd = m.submitVaultPrompt()
	if cmd != nil {
		t.Fatalf("malformed input should not issue a command")
	}
	if !strings.Contains(m.vault.status, "KEY=VALUE") {
		t.Fatalf("expected a format hint, got %q", m.vault.status)
	}
}

func TestVaultDeleteRequiresConfirm(t *testing.T) {
	m := vaultModel()
	m.vault.rows = []VaultRow{{kind: "vault", name: "prod", vault: swamp.Vault{Name: "prod"}}}
	m.vault.sel = 0
	m.vault.detailKind = "vault"
	m.vault.keys = []string{"API_KEY"}
	m.vault.keySel = 0

	model, _ := m.vaultDelete()
	m = model.(*Model)
	if !m.vault.confirmOpen || m.vault.confirmKind != "delete-key" {
		t.Fatalf("delete should open a confirm: %+v", m.vault)
	}
	if m.vault.confirmKey != "API_KEY" {
		t.Fatalf("confirm should target API_KEY, got %q", m.vault.confirmKey)
	}
	// 'n' cancels.
	press(m, tea.KeyEscape, "")
	if m.vault.confirmOpen {
		t.Fatalf("esc should cancel the confirm")
	}
}

func TestVaultCreatePromptForExtension(t *testing.T) {
	m := vaultModel()
	m.vault.rows = []VaultRow{
		{kind: "extension", name: "@x/systemd-creds", typeName: "systemd-creds Vault"},
	}
	m.vault.sel = 0

	model, _ := m.vaultCreate()
	m = model.(*Model)
	if !m.vault.promptOpen || m.vault.promptKind != "create" {
		t.Fatalf("create should open a prompt: %+v", m.vault)
	}
	if m.vault.promptKey != "@x/systemd-creds" {
		t.Fatalf("create prompt should remember the type, got %q", m.vault.promptKey)
	}
	m.vault.promptValue = "new-vault"
	_, cmd := m.submitVaultPrompt()
	if cmd == nil || !m.vault.busy {
		t.Fatalf("submit should issue a create command and mark busy")
	}
}

func TestVaultExtensionPaneShowsManifest(t *testing.T) {
	m := vaultModel()
	m.vault.rows = []VaultRow{{kind: "extension", name: "@x/systemd-creds", typeName: "systemd-creds"}}
	m.vault.sel = 0
	m.vault.detailKind = "extension"
	m.vault.detailTitle = "Vault extension — @x/systemd-creds"
	m.Update(vaultExtInfoLoadedMsg{name: "@x/systemd-creds", info: map[string]any{
		"name":         "@x/systemd-creds",
		"description":  "Stores secrets encrypted at rest.",
		"contentTypes": []any{"vaults"},
		"contentMetadata": map[string]any{
			"vaults": []any{map[string]any{"type": "@x/systemd-creds", "name": "systemd-creds Vault"}},
		},
	}})
	out := strip(m.render())
	for _, want := range []string{"Vault backend", "@x/systemd-creds", "About", "encrypted at rest", "Actions"} {
		if !strings.Contains(out, want) {
			t.Errorf("extension pane missing %q:\n%s", want, out)
		}
	}
}

func TestVaultAuditRenders(t *testing.T) {
	m := vaultModel()
	m.vault.rows = []VaultRow{{kind: "vault", name: "prod", vault: swamp.Vault{Name: "prod"}}}
	m.vault.sel = 0
	m.vault.detailKind = "vault"
	m.vault.keys = []string{"API_KEY"}
	m.vault.auditShown = true
	m.Update(vaultAuditLoadedMsg{vault: "prod", entries: []swamp.VaultAuditEntry{
		{Action: "put", Timestamp: "2026-09-25T05:58:40.873Z", SecretKey: "API_KEY", CallerContext: "cli:vault-put"},
	}})
	out := strip(m.render())
	if !strings.Contains(out, "Audit trail") || !strings.Contains(out, "put") || !strings.Contains(out, "API_KEY") {
		t.Fatalf("audit trail not rendered:\n%s", out)
	}
}

func TestVaultOpenKeyHint(t *testing.T) {
	m := sampleModel()
	m.focus = PaneModels
	hints := strip(renderHints(m.keyHints(), 400))
	if !strings.Contains(hints, "vaults") {
		t.Fatalf("context bar should advertise vaults: %q", hints)
	}
}
