package ui

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
	"github.com/svendowideit/swamp-project/sp/internal/swamp"
)

// --- async messages ---

// vaultTreeLoadedMsg delivers the vault tree (extensions + vaults).
type vaultTreeLoadedMsg struct {
	types  []swamp.VaultType
	vaults []swamp.Vault
	err    error
}

// vaultKeysLoadedMsg delivers a vault's key list.
type vaultKeysLoadedMsg struct {
	vault string
	keys  []string
	err   error
}

// vaultMetaLoadedMsg delivers one key's metadata.
type vaultMetaLoadedMsg struct {
	vault string
	key   string
	meta  swamp.VaultKeyMeta
	err   error
}

// vaultSecretLoadedMsg delivers a revealed secret value.
type vaultSecretLoadedMsg struct {
	vault string
	key   string
	value string
	err   error
}

// vaultAuditLoadedMsg delivers a vault's audit trail.
type vaultAuditLoadedMsg struct {
	vault   string
	entries []swamp.VaultAuditEntry
	err     error
}

// vaultExtInfoLoadedMsg delivers extension.info for a selected extension.
type vaultExtInfoLoadedMsg struct {
	name string
	info map[string]any
	err  error
}

// vaultActionMsg reports the outcome of a mutating vault action.
type vaultActionMsg struct {
	status string
	err    error
	// reloadTree/reloadKeys tell the reducer what to refresh on success.
	reloadTree bool
	reloadKeys string // vault name whose keys should reload
}

// --- load commands ---

// loadVaultTree builds the left tree: every available vault extension (built-in
// or installed), each with its configured vaults nested underneath.
func (m *Model) loadVaultTree() tea.Cmd {
	client := m.client
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		types, err := client.SearchVaultTypes(ctx, "")
		if err != nil {
			return vaultTreeLoadedMsg{err: err}
		}
		vaults, err := client.SearchVaults(ctx, "")
		if err != nil {
			return vaultTreeLoadedMsg{err: err}
		}
		return vaultTreeLoadedMsg{types: types, vaults: vaults}
	}
}

// buildVaultRows turns types + vaults into the flattened tree.
func buildVaultRows(types []swamp.VaultType, vaults []swamp.Vault) []VaultRow {
	byType := map[string][]swamp.Vault{}
	var order []string
	for _, v := range vaults {
		if _, ok := byType[v.Type]; !ok {
			order = append(order, v.Type)
		}
		byType[v.Type] = append(byType[v.Type], v)
	}
	for t := range byType {
		if !containsStr(order, t) {
			order = append(order, t)
		}
	}

	var rows []VaultRow
	seen := map[string]bool{}
	addType := func(typ, name, desc string) {
		if seen[typ] {
			return
		}
		seen[typ] = true
		count := len(byType[typ])
		sub := fmt.Sprintf("%d vault", count)
		if count != 1 {
			sub += "s"
		}
		if desc != "" {
			sub = firstLine(desc)
		}
		rows = append(rows, VaultRow{kind: "extension", name: typ, typeName: name, sub: sub, depth: 0})
		vs := byType[typ]
		sort.Slice(vs, func(i, j int) bool { return vs[i].Name < vs[j].Name })
		for _, v := range vs {
			rows = append(rows, VaultRow{
				kind: "vault", name: v.Name, typeName: typeDisplayName(types, v.Type),
				sub: v.CreatedAt, depth: 1, vault: v,
			})
		}
	}

	// Known types first (sorted), then any orphan vault types.
	sort.Slice(types, func(i, j int) bool { return types[i].Type < types[j].Type })
	for _, t := range types {
		addType(t.Type, t.Name, t.Description)
	}
	for _, t := range order {
		if !seen[t] {
			addType(t, t, "")
		}
	}
	return rows
}

func typeDisplayName(types []swamp.VaultType, typ string) string {
	for _, t := range types {
		if t.Type == typ {
			if t.Name != "" {
				return t.Name
			}
			return typ
		}
	}
	return typ
}

// loadVaultKeys lists the secret keys in a vault.
func (m *Model) loadVaultKeys(vault string) tea.Cmd {
	client := m.client
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		keys, err := client.ListVaultKeys(ctx, vault)
		return vaultKeysLoadedMsg{vault: vault, keys: keys, err: err}
	}
}

// inspectVaultKey loads metadata for one key.
func (m *Model) inspectVaultKey(vault, key string) tea.Cmd {
	client := m.client
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		meta, err := client.InspectVaultKey(ctx, vault, key)
		return vaultMetaLoadedMsg{vault: vault, key: key, meta: meta, err: err}
	}
}

// loadVaultAudit loads the audit trail for a vault (or all vaults when empty).
func (m *Model) loadVaultAudit(vault string) tea.Cmd {
	client := m.client
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		entries, err := client.VaultAuditTrail(ctx, vault, 200)
		return vaultAuditLoadedMsg{vault: vault, entries: entries, err: err}
	}
}

// loadVaultExtInfo loads extension.info for the selected extension.
func (m *Model) loadVaultExtInfo(name string) tea.Cmd {
	client := m.client
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		info, err := client.GetExtensionInfo(ctx, name)
		return vaultExtInfoLoadedMsg{name: name, info: info, err: err}
	}
}

// --- selection / refresh ---

// vaultCurrent returns the selected tree row, if any.
func (m *Model) vaultCurrent() (VaultRow, bool) {
	if m.vault.sel < 0 || m.vault.sel >= len(m.vault.rows) {
		return VaultRow{}, false
	}
	return m.vault.rows[m.vault.sel], true
}

// selectVaultRow loads the right pane for the current selection.
func (m *Model) selectVaultRow() tea.Cmd {
	row, ok := m.vaultCurrent()
	if !ok {
		return nil
	}
	m.vault.detailScrol = 0
	m.vault.revealedKey = ""
	m.vault.revealedValue = ""
	m.vault.auditShown = false
	m.vault.audit = nil
	switch row.kind {
	case "extension":
		m.vault.detailKind = "extension"
		m.vault.detailTitle = "Vault extension — " + row.name
		m.vault.extInfo = nil
		m.vault.detailLines = []string{styleMuted.Render("loading extension info…")}
		return m.loadVaultExtInfo(row.name)
	default:
		m.vault.detailKind = "vault"
		m.vault.detailTitle = "Vault — " + row.name
		m.vault.keys = nil
		m.vault.keyMeta = map[string]swamp.VaultKeyMeta{}
		m.vault.keySel = 0
		m.vault.detailLines = []string{styleMuted.Render("loading keys…")}
		return m.loadVaultKeys(row.name)
	}
}

// --- key table rendering ---

// renderVaultDetail renders the right pane for the current selection.
func (m *Model) renderVaultDetail(width, height int) string {
	switch m.vault.detailKind {
	case "extension":
		return m.renderVaultExtension(width, height)
	default:
		return m.renderVaultKeys(width, height)
	}
}

// renderVaultExtension renders extension.info: the manifest description plus the
// vault type metadata (name, config schema) and actions.
func (m *Model) renderVaultExtension(width, height int) string {
	row, _ := m.vaultCurrent()
	info := m.vault.extInfo
	var lines []string
	if info == nil {
		if m.vault.err != nil {
			lines = append(lines, styleError.Render("✗ "+m.vault.err.Error()))
		} else {
			lines = append(lines, styleMuted.Render("loading…"))
		}
		return clip(strings.Join(lines, "\n"), width, height)
	}

	lines = append(lines, styleKey.Render("extension ")+str(info["name"]))
	if v := str(info["latestVersion"]); v != "" {
		lines = append(lines, styleKey.Render("latest    ")+v)
	}
	if ct := strList(info["contentTypes"]); len(ct) > 0 {
		lines = append(lines, styleKey.Render("provides  ")+strings.Join(ct, ", "))
	}
	if r := str(info["repository"]); r != "" {
		verified := ""
		if b, _ := info["repositoryVerified"].(bool); b {
			verified = styleGreen.Render("  ✓ verified")
		}
		lines = append(lines, styleKey.Render("repo      ")+r+verified)
	}

	// The vault type this extension provides (from contentMetadata.vaults).
	if cm, ok := info["contentMetadata"].(map[string]any); ok {
		for _, v := range asList(cm["vaults"]) {
			vm, _ := v.(map[string]any)
			if vm == nil {
				continue
			}
			lines = append(lines, "", stylePaneTitle.Render("Vault backend"))
			lines = append(lines, "  "+styleKey.Render("type  ")+str(vm["type"]))
			if n := str(vm["name"]); n != "" {
				lines = append(lines, "  "+styleKey.Render("name  ")+n)
			}
			if d := str(vm["description"]); d != "" {
				lines = append(lines, "  "+styleMuted.Render(truncStr(d, width-4)))
			}
		}
	}

	// The manifest description (the user manual).
	if d := str(info["description"]); d != "" {
		lines = append(lines, "", stylePaneTitle.Render("About"))
		lines = append(lines, wrapString(d, width-2)...)
	}
	if deps := strList(info["dependencies"]); len(deps) > 0 {
		lines = append(lines, "", stylePaneTitle.Render("Dependencies"))
		for _, d := range deps {
			lines = append(lines, "  "+styleMuted.Render(d))
		}
	}

	// Actions for the extension.
	lines = append(lines, "", stylePaneTitle.Render("Actions"))
	installed := m.vaultExtensionInstalled(row.name)
	if installed {
		lines = append(lines, "  "+styleGreen.Render("✓ installed")+styleMuted.Render("  (a create vault below uses it)"))
	} else {
		lines = append(lines, "  "+styleKey.Render("P")+styleMuted.Render("  pull this extension into the repo"))
	}
	lines = append(lines, "  "+styleKey.Render("c")+styleMuted.Render("  create a vault using this extension"))
	return clip(strings.Join(lines, "\n"), width, height)
}

// vaultExtensionInstalled reports whether an extension type is available (its
// vaults exist or a vault type with that name is known).
func (m *Model) vaultExtensionInstalled(name string) bool {
	for _, r := range m.vault.rows {
		if r.kind == "vault" && r.vault.Type == name {
			return true
		}
	}
	// Built-in types ship with swamp and need no pull.
	switch name {
	case "local_encryption", "aws-sm", "azure-kv", "1password":
		return true
	}
	return false
}

// renderVaultKeys renders a vault's secret keys as a table, plus a detail strip
// for the selected key (metadata, reveal, audit).
func (m *Model) renderVaultKeys(width, height int) string {
	if m.vault.err != nil {
		return clip(styleError.Render("✗ "+m.vault.err.Error()), width, height)
	}
	if m.vault.keys == nil {
		return clip(styleMuted.Render("loading keys…"), width, height)
	}
	var out []string
	if len(m.vault.keys) == 0 {
		out = append(out, styleMuted.Render("  no secret keys yet — press 'a' to add one"))
	} else {
		header := []string{"Key", "Type", "Size", ""}
		var rows [][]string
		for _, k := range m.vault.keys {
			meta := m.vault.keyMeta[k]
			typ := meta.ValueType
			if typ == "" {
				typ = "…"
			}
			size := "-"
			if meta.SizeChars > 0 {
				size = fmt.Sprintf("%d B", meta.SizeChars)
			}
			note := ""
			if meta.HasAnnotation {
				note = "✎"
			}
			// Cap the key name so the other columns keep their headers.
			rows = append(rows, []string{truncStr(k, 46), typ, size, note})
		}
		// Window the table so the selected key stays visible; the key rows
		// occupy positions 2.. in the rendered table (below header + rule).
		const hdrRows = 2
		visible := height - hdrRows - 6 // reserve the detail strip
		if visible < 3 {
			visible = 3
		}
		top := windowTop(len(rows), m.vault.keySel, visible)
		shown := rows[top:]
		if len(shown) > visible {
			shown = shown[:visible]
		}
		table := tableLines(header, shown, width,
			func(s string) string { return stylePaneTitle.Render(s) },
			func(s string) string { return styleItem.Render(s) })
		selRow := m.vault.keySel - top + hdrRows
		for i := range table {
			if i == selRow {
				table[i] = styleSelected.Render(stripCell(table[i]))
			}
		}
		if top > 0 {
			out = append(out, styleMuted.Render(fmt.Sprintf("  ↑ %d more", top)))
		}
		out = append(out, table...)
		if rest := len(rows) - top - len(shown); rest > 0 {
			out = append(out, styleMuted.Render(fmt.Sprintf("  ↓ %d more", rest)))
		}
	}

	// Detail strip for the selected key.
	if len(m.vault.keys) > 0 {
		key := m.vault.keys[clamp(m.vault.keySel, 0, len(m.vault.keys)-1)]
		out = append(out, "", stylePaneTitle.Render("Key — "+key))
		if v := m.vault.revealedValue; m.vault.revealedKey == key && v != "" {
			out = append(out, "  "+styleKey.Render("value  ")+styleOrange.Render(v))
			out = append(out, "  "+styleMuted.Render("(revealed — press 'r' to hide)"))
		} else {
			out = append(out, "  "+styleKey.Render("value  ")+styleMuted.Render("•••••• (press 'r' to reveal)"))
		}
		if meta, ok := m.vault.keyMeta[key]; ok && meta.ValueType != "" {
			out = append(out, "  "+styleKey.Render("meta   ")+
				styleMuted.Render(fmt.Sprintf("%s, %d chars", meta.ValueType, meta.SizeChars)))
			if meta.HasAnnotation {
				var parts []string
				if meta.AnnotationURL != "" {
					parts = append(parts, meta.AnnotationURL)
				}
				if meta.AnnotationNotes != "" {
					parts = append(parts, meta.AnnotationNotes)
				}
				for k, v := range meta.AnnotationLabels {
					parts = append(parts, k+"="+v)
				}
				if len(parts) > 0 {
					out = append(out, "  "+styleKey.Render("annot  ")+styleMuted.Render(strings.Join(parts, "  ")))
				}
			}
			if meta.HasRefreshHook {
				out = append(out, "  "+styleKey.Render("refresh")+" "+
					styleMuted.Render(meta.RefreshCommand+"  ttl "+meta.RefreshTTL+"  last "+shortTime(meta.RefreshLast)))
			}
		}
	}

	// Audit trail, when shown.
	if m.vault.auditShown {
		out = append(out, "", stylePaneTitle.Render(fmt.Sprintf("Audit trail (%d)", len(m.vault.audit))))
		if len(m.vault.audit) == 0 {
			out = append(out, styleMuted.Render("  (no entries)"))
		}
		for i, e := range m.vault.audit {
			if i >= 40 {
				out = append(out, styleMuted.Render(fmt.Sprintf("  … %d more", len(m.vault.audit)-i)))
				break
			}
			out = append(out, fmt.Sprintf("  %s %-9s %s  %s",
				styleMuted.Render(shortTime(e.Timestamp)),
				styleKind.Render(e.Action),
				styleItem.Render(truncStr(e.SecretKey, 40)),
				styleMuted.Render(e.CallerContext)))
		}
	}
	return clip(strings.Join(out, "\n"), width, height)
}

// stripCell removes ANSI styling from a rendered table row so it can be
// re-rendered with the selection style.
func stripCell(s string) string {
	return ansi.Strip(s)
}

// strList coerces a JSON array of strings.
func strList(v any) []string {
	var out []string
	for _, x := range asList(v) {
		if s := str(x); s != "" {
			out = append(out, s)
		}
	}
	return out
}
