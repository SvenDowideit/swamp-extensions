# @svendowideit/caddy

A swamp model extension that manages Caddy on a Linux host with systemd. It is
a **swamp extension** (a TypeScript model type) that drives Caddy via its admin
API and systemd — **not** a Go Caddy plugin.

## What it does (MVP)

The MVP covers the initial setup and lifecycle of Caddy itself:

1. **`installCaddy`** — downloads the current Caddy binary from the
   [caddyserver.com download API](https://caddyserver.com/api/download) (with
   any requested module packages compiled in), places it at `caddyBinPath`, and
   verifies it runs (`caddy version` + `caddy list-modules`). No Go toolchain or
   `xcaddy` needed.
2. **`createService`** — writes a systemd **user** service unit
   (`~/.config/systemd/user/caddy.service`) that runs Caddy with the admin API
   enabled, plus a minimal Caddyfile.
3. **`startService`** — starts and enables the service
   (`systemctl --user enable --now caddy`) and verifies the admin API responds
   on `localhost:2019`.
4. **`settingsGuidance`** — prints the minimal settings needed for a useful
   Let's Encrypt TLS-configured Caddy: base domain, ACME email, and admin API
   token.

## What it does (Iteration 1)

Iteration 1 adds live reverse-proxy management via the Caddy admin API:

1. **`addProxyService`** — takes a service name + `host:port`, derives a
   hostname (`<service-name>.<base-domain>`), and adds a reverse-proxy route via
   the admin API (`POST /config/`) — live, no restart. Returns a descriptive
   error if the domain is already in use.
2. **`removeProxyService`** — stops the associated backend systemd service and
   removes the Caddy route for the derived domain. Errors if the domain is not
   found.
3. **`startBackendService` / `stopBackendService` / `restartBackendService`** —
   manage backend systemd user services by name via `systemctl --user`.

## What it does (Iteration 2)

Iteration 2 adds Vault integration, admin API protection, and config storage:

1. **`storeConfig`** — validates and writes the base domain, ACME email, and
   admin API token to the swamp Vault (via `swamp vault put`).
2. **`syncConfig`** — snapshots the effective config into a swamp resource.
3. **`getConfig`** — reads the stored config back from the swamp resource.
4. **Admin API protection** — the admin endpoint can be bound to a permissioned
   Unix socket by setting `adminApiAddr: unix//path/to/socket`; the client talks
   over it (Caddy's recommended protection).

Secrets are read from the Vault by setting global arguments to
`${{ vault.get(<vault>, <key>) }}` expressions (resolved by swamp before the
method runs) — e.g. `--global-arg 'adminApiToken=${{ vault.get(caddy-secrets, caddy-admin-token) }}'`.

## What it does (Iteration 3)

Iteration 3 adds TLS configuration and `swamp serve` auto-proxying:

1. **`configureTls`** — configures the Caddy TLS app with the ACME email and an
   optional DNS provider (for wildcard / DNS-challenge issuance). The DNS
   provider credential is read from an environment variable (e.g.
   `{env.CADDY_DNS_API_TOKEN}`) that you set in the systemd unit or Vault.
2. **`autoProxySwampServe`** — detects running `swamp serve` systemd user
   services (prefix `swamp-serve-`), derives hostnames from their names, and
   reconciles their reverse-proxy routes (adds new, removes stopped).

## What it does (Iteration 4)

Iteration 4 adds binary upgrades, health monitoring, and service lifecycle:

1. **`upgradeCaddy`** — replaces the Caddy binary (current release, with module
   packages) with explicit confirmation (`confirm=upgrade`), then restarts the
   service. Existing configuration is preserved.
2. **`checkHealth`** — reports Caddy service + admin API health (healthy /
   down / service-not-active / admin-api-unreachable).
3. **`stopService` / `restartService`** — stop/restart the Caddy systemd user
   service (complementing the MVP's `startService`).

## Desired-state proxy

**`ensureDnsProxy`** — idempotently ensure a full hostname proxies to a backend
`host:port`. Adds the route if missing, updates it if the upstream changed, and
is a no-op if already correct. Safe to run repeatedly (desired-state), so it can
be called by a user or another extension/workflow.

```sh
swamp model method run my-caddy ensureDnsProxy \
  --input hostname=foo.example.com --input upstream=127.0.0.1:8080
```

## Workflows

Two workflows ship alongside the extension (in this repo's `workflows/`):

- **`caddy-setup`** — the full setup: `installCaddy` → `createService` →
  `startService` → `settingsGuidance` → `configureTls` (best-effort). All steps
  are idempotent, so re-running is safe.
- **`caddy-ensure-proxy`** — first runs `caddy-setup` (idempotent), then
  `ensureDnsProxy` for the given `hostname` + `upstream`. This is the
  desired-state entry point: one command that ensures Caddy is up *and* the
  proxy exists.

```sh
# one-time model creation
swamp model create @svendowideit/caddy my-caddy \
  --global-arg baseDomain=example.com --global-arg letsEncryptEmail=admin@example.com

# full setup (idempotent)
swamp workflow run caddy-setup

# desired-state proxy ensure (idempotent — also runs setup first)
swamp workflow run caddy-ensure-proxy \
  --input hostname=foo.example.com --input upstream=127.0.0.1:8080
```

## Installation

```sh
swamp extension pull @svendowideit/caddy
```

## Usage

```sh
swamp model create @svendowideit/caddy my-caddy
swamp model edit my-caddy   # set baseDomain, letsEncryptEmail, etc.

swamp model method run my-caddy installCaddy
swamp model method run my-caddy createService
swamp model method run my-caddy startService
swamp model method run my-caddy settingsGuidance

# Iteration 1 — live proxy management
swamp model method run my-caddy addProxyService \
  --input serviceName=my-app --input upstream=127.0.0.1:8080
swamp model method run my-caddy removeProxyService \
  --input serviceName=my-app
swamp model method run my-caddy restartBackendService \
  --input serviceName=my-app

# Iteration 2 — Vault + config
swamp model method run my-caddy storeConfig \
  --input baseDomain=example.com --input letsEncryptEmail=admin@example.com
swamp model method run my-caddy syncConfig
swamp model method run my-caddy getConfig

# Iteration 3 — TLS + auto-proxy
swamp model method run my-caddy configureTls \
  --input dnsProvider=cloudflare --input 'subjects:json=["*.example.com","example.com"]'
swamp model method run my-caddy autoProxySwampServe

# Iteration 4 — upgrade, health, lifecycle
swamp model method run my-caddy upgradeCaddy --input confirm=upgrade
swamp model method run my-caddy checkHealth
swamp model method run my-caddy restartService
```

## Configuration (global arguments)

| Argument            | Default                    | Purpose                                  |
| ------------------- | -------------------------- | ---------------------------------------- |
| `caddyBinPath`      | `~/.local/bin/caddy`       | Where the Caddy binary is installed      |

| `adminApiAddr`      | `localhost:2019`           | Caddy admin API listen address (or `unix//path`); written to the Caddyfile global options |
| `adminApiToken`     | *(unset)*                  | Optional admin API token (Bearer header) |
| `vaultName`         | *(unset)*                  | Vault used by `storeConfig` to write secrets |
| `configPath`        | `~/.config/caddy/Caddyfile` | Caddy config file the service runs     |
| `serviceName`       | `caddy`                    | systemd user service name               |
| `autoHttps`         | `on`                       | Automatic HTTPS mode: `on`, `off` (plain HTTP), or `disable_redirects`/`disable_certs`/`ignore_loaded_certs` |
| `listenAddrs`       | `[":443", ":80"]`          | HTTP server listen addresses for admin-API routes (e.g. `[":8888", ":8443"]` for unprivileged ports) |
| `baseDomain`        | *(unset)*                  | Base domain for derived hostnames       |
| `letsEncryptEmail`  | *(unset)*                  | ACME / Let's Encrypt email              |
| `plugins`           | `[]`                       | Module packages to compile into the downloaded binary (e.g. `github.com/caddy-dns/cloudflare`, optionally `@version`) |

## Requirements

- Linux with systemd (user services enabled).
- `systemctl --user` works in the environment the model runs in.
- Network access to `caddyserver.com` to download the binary.

## DNS ACME certificates (libdns drivers)

Caddy issues certificates automatically via ACME (Let's Encrypt / ZeroSSL). For
a normal domain, the HTTP-01 challenge works out of the box. For **wildcard
certificates** (`*.example.com`) or DNS-only validation, Caddy needs a **DNS
provider plugin** — these are built on the
[libdns](https://github.com/libdns/libdns) library, one module per provider
(`github.com/caddy-dns/<provider>`).

### 1. Download Caddy with the right libdns driver

Caddy's standard binary does **not** include DNS providers. The extension
requests them as packages from the caddyserver.com download API, which compiles
them into the binary server-side (no local Go toolchain needed). Set the
`plugins` global argument (or pass `--input plugins:json=[...]` to
`installCaddy` / `upgradeCaddy`):

```sh
swamp model create @svendowideit/caddy my-caddy \
  --global-arg 'plugins:json=["github.com/caddy-dns/cloudflare"]'
swamp model method run my-caddy installCaddy
```

Supported provider names (mapped by `configureTls`): `cloudflare`, `route53`,
`digitalocean`, `duckdns`, `porkbun`, `namecheap`. Any module package
registered on the [Caddy download page](https://caddyserver.com/download) can be
requested via `plugins` directly (append `@version` to pin one).

### 2. Set the libdns provider credentials

Each provider reads its credentials from an **environment variable** (e.g.
`CLOUDFLARE_API_TOKEN`, `AWS_ACCESS_KEY_ID`). Caddy references these in the
config as `{env.VAR}`. The extension's `configureTls` renders the credential as
`{env.CADDY_DNS_API_TOKEN}` by default (override with `dnsEnvVar`).

The Caddy process must have that variable in its environment. Add it to the
systemd user unit (prefer an `EnvironmentFile` with restricted permissions, or
`systemd-creds`, over a plaintext `Environment=` line):

```ini
# ~/.config/systemd/user/caddy.service
[Service]
EnvironmentFile=-%h/.config/caddy/dns.env
```

```sh
# ~/.config/caddy/dns.env  (chmod 600)
CADDY_DNS_API_TOKEN=your-cloudflare-api-token
```

Store the token in the swamp Vault and wire it in, rather than committing it:

```sh
echo "your-token" | swamp vault put caddy-secrets caddy-dns-token
```

### 3. Configure the DNS ACME challenge

Run `configureTls` with the provider and the subjects (wildcard + apex):

```sh
swamp model method run my-caddy configureTls \
  --input dnsProvider=cloudflare \
  --input 'subjects:json=["*.example.com","example.com"]'
```

This writes a `tls.automation` policy with an ACME issuer using the DNS
challenge. Caddy then obtains and auto-renews certificates for those subjects
using the provider's DNS API. Verify with `checkHealth` and by requesting a
proxied domain over HTTPS.

## Plain HTTP / unprivileged ports

To run Caddy as an unprivileged systemd user service (no `CAP_NET_BIND_SERVICE`)
serving plain HTTP on non-resolvable or mDNS hostnames, set:

```sh
swamp model create @svendowideit/caddy my-caddy \
  --global-arg 'listenAddrs:json=[":8888", ":8443"]' \
  --global-arg autoHttps=off
```

- `listenAddrs` — the HTTP server listen addresses used for routes added via the
  admin API (default `[":443", ":80"]`).
- `autoHttps=off` — disables both certificate automation and HTTP→HTTPS
  redirects. Use `disable_redirects` to keep cert automation but skip the
  redirect server, or `disable_certs` to keep redirects but skip issuance.

`createService` writes these into the generated Caddyfile, and the admin API
config keeps them when adding routes, so re-running `installCaddy` /
`createService` no longer reintroduces TLS or privileged-port assumptions.

## Config persistence

Routes are applied live via the admin API, not written to the Caddyfile. Caddy
autosaves the running JSON config (to `~/.config/caddy/autosave.json`), but only
reloads it when started with `--resume`. The systemd unit therefore runs:

```
ExecStart=... run --resume --config <Caddyfile> --adapter caddyfile
```

On a fresh install there is no autosave file yet, so Caddy falls back to the
generated Caddyfile; on subsequent restarts it resumes the last admin-API
config, so proxy routes survive `stopService` / `restartService` and reboots.
There is no `ExecReload` pointing at the Caddyfile — doing so would discard the
admin-API config.

Re-run `createService` after upgrading from an older version to regenerate the
unit with `--resume`.

## Notes

- The admin API is powerful; Caddy recommends protecting it. Bind it to a
  permissioned Unix socket by setting `adminApiAddr: unix//path/to/socket`
  (the extension's client talks over it), or front it with an auth proxy and
  set `adminApiToken`.
- The admin endpoint is written to the Caddyfile's `admin` global option. Caddy
  v2.11+ removed the `caddy run --admin` CLI flag, so the systemd unit does not
  pass `--admin`.
- Binding privileged ports (80/443) as a user service requires
  `CAP_NET_BIND_SERVICE`; the admin API port (2019) is unprivileged.
