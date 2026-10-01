package swamp

import "context"

// VaultType is one available vault backend type (built-in or extension).
type VaultType struct {
	Type        string
	Name        string
	Description string
}

// Vault is a configured vault instance.
type Vault struct {
	ID          string
	Name        string
	Type        string
	CreatedAt   string
	StoragePath string
	Config      map[string]any
}

// VaultKeyMeta is the metadata for one stored secret key, as reported by
// vault.inspect. The value itself is never included.
type VaultKeyMeta struct {
	VaultName            string
	Key                  string
	VaultType            string
	SizeBytes            int64
	SizeChars            int64
	ValueType            string
	SupportsAnnotations  bool
	HasAnnotation        bool
	AnnotationURL        string
	AnnotationNotes      string
	AnnotationLabels     map[string]string
	AnnotationUpdatedAt  string
	SupportsRefreshHooks bool
	HasRefreshHook       bool
	RefreshCommand       string
	RefreshTTL           string
	RefreshLast          string
}

// VaultAuditEntry is one entry in a vault's audit trail.
type VaultAuditEntry struct {
	Action        string
	Timestamp     string
	VaultName     string
	VaultType     string
	SecretKey     string
	CallerContext string
}

// Extension is one entry from the extension registry or the installed list.
type Extension struct {
	Name         string
	Description  string
	LatestVer    string
	ContentTypes []string
	Repository   string
	Verified     bool
	Installed    bool
	Version      string
	// Channel is the release channel the installed version came from
	// (stable/beta/rc); PulledAt is when it was pulled into this repo.
	Channel  string
	PulledAt string
}

// SearchVaultTypes lists the available vault backend types.
func (c *Client) SearchVaultTypes(ctx context.Context, query string) ([]VaultType, error) {
	p := map[string]any{}
	if query != "" {
		p["query"] = query
	}
	res, err := c.dataRequest(ctx, ReqVaultTypeSearch, p)
	if err != nil {
		return nil, err
	}
	var out []VaultType
	for _, r := range asAnyList(res["results"]) {
		m, ok := r.(map[string]any)
		if !ok {
			continue
		}
		out = append(out, VaultType{
			Type:        jsonStr(m["type"]),
			Name:        jsonStr(m["name"]),
			Description: jsonStr(m["description"]),
		})
	}
	return out, nil
}

// SearchVaults lists configured vaults.
func (c *Client) SearchVaults(ctx context.Context, query string) ([]Vault, error) {
	p := map[string]any{}
	if query != "" {
		p["query"] = query
	}
	res, err := c.dataRequest(ctx, ReqVaultSearch, p)
	if err != nil {
		return nil, err
	}
	var out []Vault
	for _, r := range asAnyList(res["results"]) {
		out = append(out, vaultFromMap(r))
	}
	return out, nil
}

// GetVault fetches one vault's detail (including storage path and config).
func (c *Client) GetVault(ctx context.Context, nameOrID string) (Vault, error) {
	res, err := c.dataRequest(ctx, ReqVaultGet, map[string]any{"vaultNameOrId": nameOrID})
	if err != nil {
		return Vault{}, err
	}
	return vaultFromMap(res), nil
}

func vaultFromMap(r any) Vault {
	m, _ := r.(map[string]any)
	if m == nil {
		return Vault{}
	}
	v := Vault{
		ID:          jsonStr(m["id"]),
		Name:        jsonStr(m["name"]),
		Type:        jsonStr(m["type"]),
		CreatedAt:   jsonStr(m["createdAt"]),
		StoragePath: jsonStr(m["storagePath"]),
	}
	if cfg, ok := m["config"].(map[string]any); ok {
		v.Config = cfg
	}
	return v
}

// ListVaultKeys returns the secret key names in a vault (never values).
func (c *Client) ListVaultKeys(ctx context.Context, vault string) ([]string, error) {
	res, err := c.dataRequest(ctx, ReqVaultListKeys, map[string]any{"vaultName": vault})
	if err != nil {
		return nil, err
	}
	var keys []string
	for _, k := range asAnyList(res["secretKeys"]) {
		keys = append(keys, jsonStr(k))
	}
	return keys, nil
}

// InspectVaultKey returns metadata for one secret key (no value).
func (c *Client) InspectVaultKey(ctx context.Context, vault, key string) (VaultKeyMeta, error) {
	res, err := c.dataRequest(ctx, ReqVaultInspect, map[string]any{"vaultName": vault, "key": key})
	if err != nil {
		return VaultKeyMeta{}, err
	}
	m := &VaultKeyMeta{
		VaultName:            jsonStr(res["vaultName"]),
		Key:                  jsonStr(res["secretKey"]),
		VaultType:            jsonStr(res["vaultType"]),
		SizeBytes:            int64(num(res["sizeBytes"])),
		SizeChars:            int64(num(res["sizeChars"])),
		ValueType:            jsonStr(res["valueType"]),
		SupportsAnnotations:  boolVal(res["supportsAnnotations"]),
		HasAnnotation:        boolVal(res["hasAnnotation"]),
		SupportsRefreshHooks: boolVal(res["supportsRefreshHooks"]),
		HasRefreshHook:       boolVal(res["hasRefreshHook"]),
	}
	if a, ok := res["annotation"].(map[string]any); ok && a != nil {
		m.AnnotationURL = jsonStr(a["url"])
		m.AnnotationNotes = jsonStr(a["notes"])
		m.AnnotationUpdatedAt = jsonStr(a["updatedAt"])
		if labels, ok := a["labels"].(map[string]any); ok {
			m.AnnotationLabels = map[string]string{}
			for k, v := range labels {
				m.AnnotationLabels[k] = jsonStr(v)
			}
		}
	}
	if h, ok := res["refreshHook"].(map[string]any); ok && h != nil {
		m.RefreshCommand = jsonStr(h["command"])
		m.RefreshTTL = jsonStr(h["ttl"])
		m.RefreshLast = jsonStr(h["lastRefreshedAt"])
	}
	return *m, nil
}

// ReadVaultSecret reveals a secret value. The caller is responsible for not
// persisting or logging it.
func (c *Client) ReadVaultSecret(ctx context.Context, vault, key string) (string, error) {
	res, err := c.dataRequest(ctx, ReqVaultReadSecret, map[string]any{"vaultName": vault, "secretKey": key})
	if err != nil {
		return "", err
	}
	return jsonStr(res["value"]), nil
}

// PutVaultSecret stores (or overwrites) a secret value. refreshFrom + refreshTTL
// are optional and must be supplied together.
func (c *Client) PutVaultSecret(ctx context.Context, vault, key, value, refreshFrom, refreshTTL string, force bool) error {
	p := map[string]any{"vaultName": vault, "key": key, "value": value}
	if refreshFrom != "" {
		p["refreshFrom"] = refreshFrom
	}
	if refreshTTL != "" {
		p["refreshTtl"] = refreshTTL
	}
	if force {
		p["force"] = true
	}
	_, err := c.Request(ctx, ReqVaultPut, p)
	return err
}

// DeleteVaultSecret removes a secret key.
func (c *Client) DeleteVaultSecret(ctx context.Context, vault, key string) error {
	_, err := c.Request(ctx, ReqVaultDelete, map[string]any{"vaultName": vault, "key": key})
	return err
}

// AnnotateVaultSecret attaches provenance metadata (merge semantics). Empty
// fields are omitted; set clear to remove all annotations.
func (c *Client) AnnotateVaultSecret(ctx context.Context, vault, key, url, notes string, labels map[string]string, clear bool) error {
	p := map[string]any{"vaultName": vault, "key": key}
	if url != "" {
		p["url"] = url
	}
	if notes != "" {
		p["notes"] = notes
	}
	if len(labels) > 0 {
		p["labels"] = labels
	}
	if clear {
		p["clear"] = true
	}
	_, err := c.Request(ctx, ReqVaultAnnotate, p)
	return err
}

// VaultAuditTrail returns recent audit entries, optionally filtered by vault.
func (c *Client) VaultAuditTrail(ctx context.Context, vault string, limit int) ([]VaultAuditEntry, error) {
	p := map[string]any{}
	if vault != "" {
		p["vaultName"] = vault
	}
	if limit > 0 {
		p["limit"] = limit
	}
	res, err := c.dataRequest(ctx, ReqVaultAuditTrail, p)
	if err != nil {
		return nil, err
	}
	var out []VaultAuditEntry
	for _, r := range asAnyList(res["entries"]) {
		m, ok := r.(map[string]any)
		if !ok {
			continue
		}
		out = append(out, VaultAuditEntry{
			Action:        jsonStr(m["action"]),
			Timestamp:     jsonStr(m["timestamp"]),
			VaultName:     jsonStr(m["vaultName"]),
			VaultType:     jsonStr(m["vaultType"]),
			SecretKey:     jsonStr(m["secretKey"]),
			CallerContext: jsonStr(m["callerContext"]),
		})
	}
	return out, nil
}

// SearchExtensions searches the extension registry. contentType optionally
// filters (e.g. "vaults").
func (c *Client) SearchExtensions(ctx context.Context, query, contentType string) ([]Extension, error) {
	p := map[string]any{}
	if query != "" {
		p["query"] = query
	}
	if contentType != "" {
		p["contentType"] = contentType
	}
	res, err := c.dataRequest(ctx, ReqExtensionSearch, p)
	if err != nil {
		return nil, err
	}
	var out []Extension
	for _, r := range asAnyList(res["results"]) {
		out = append(out, extensionFromMap(r))
	}
	return out, nil
}

// GetExtensionInfo returns registry metadata for one extension (the latest
// stable description, versions per channel, etc.). This is registry/catalog
// data, NOT the manifest of the version pulled into this repo — use
// ListInstalledExtensions for what is actually installed.
func (c *Client) GetExtensionInfo(ctx context.Context, name string) (map[string]any, error) {
	return c.dataRequest(ctx, ReqExtensionInfo, map[string]any{"extensionName": name})
}

// ListInstalledExtensions lists the extensions pulled into the repository the
// server is bound to. This is the authoritative source for the version and
// channel actually installed and active — unlike extension.info, which
// describes the registry's latest release.
func (c *Client) ListInstalledExtensions(ctx context.Context) (map[string]Extension, error) {
	res, err := c.dataRequest(ctx, ReqExtensionList, nil)
	if err != nil {
		return nil, err
	}
	out := map[string]Extension{}
	for _, r := range asAnyList(res["extensions"]) {
		e := extensionFromMap(r)
		if e.Name != "" {
			out[e.Name] = e
		}
	}
	return out, nil
}

// PullExtension installs an extension from the registry into the repo.
func (c *Client) PullExtension(ctx context.Context, name string, force bool) error {
	p := map[string]any{"extensionName": name}
	if force {
		p["force"] = true
	}
	_, err := c.Request(ctx, ReqExtensionPull, p)
	return err
}

func extensionFromMap(r any) Extension {
	m, _ := r.(map[string]any)
	if m == nil {
		return Extension{}
	}
	e := Extension{
		Name:        jsonStr(m["name"]),
		Description: jsonStr(m["description"]),
		LatestVer:   jsonStr(m["latestVersion"]),
		Repository:  jsonStr(m["repository"]),
		Verified:    boolVal(m["repositoryVerified"]),
		Version:     jsonStr(m["version"]),
		Channel:     jsonStr(m["channel"]),
		PulledAt:    jsonStr(m["pulledAt"]),
	}
	for _, ct := range asAnyList(m["contentTypes"]) {
		e.ContentTypes = append(e.ContentTypes, jsonStr(ct))
	}
	if m["pulledAt"] != nil {
		e.Installed = true
	}
	return e
}
