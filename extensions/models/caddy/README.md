# @svendowideit/caddy

A swamp model extension that manages Caddy on a Linux host with systemd. It is
a **swamp extension** (a TypeScript model type) that drives Caddy via its admin
API and systemd — **not** a Go Caddy plugin.

## What it does (MVP)

The MVP covers the initial setup and lifecycle of Caddy itself:

1. **`installCaddy`** — downloads the Caddy binary (or builds it with
   [xcaddy](https://github.com/caddyserver/xcaddy) when plugins are requested),
   places it at `caddyBinPath`, and verifies it runs (`caddy version` +
   `caddy list-modules`).
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
```

## Configuration (global arguments)

| Argument            | Default                    | Purpose                                  |
| ------------------- | -------------------------- | ---------------------------------------- |
| `caddyBinPath`      | `~/.local/bin/caddy`       | Where the Caddy binary is installed      |
| `caddyVersion`      | *(latest)*                 | Caddy version to install (e.g. `v2.8.4`) |
| `adminApiAddr`      | `localhost:2019`           | Caddy admin API listen address (or `unix//path`) |
| `adminApiToken`     | *(unset)*                  | Optional admin API token (Bearer header) |
| `vaultName`         | *(unset)*                  | Vault used by `storeConfig` to write secrets |
| `configPath`        | `~/.config/caddy/Caddyfile` | Caddy config file the service runs     |
| `serviceName`       | `caddy`                    | systemd user service name               |
| `baseDomain`        | *(unset)*                  | Base domain for derived hostnames       |
| `letsEncryptEmail`  | *(unset)*                  | ACME / Let's Encrypt email              |
| `plugins`           | `[]`                       | Caddy plugins to build in via xcaddy    |

## Requirements

- Linux with systemd (user services enabled).
- `systemctl --user` works in the environment the model runs in.
- For plugin builds: Go + [xcaddy](https://github.com/caddyserver/xcaddy) on
  `PATH`.

## Notes

- The admin API is powerful; Caddy recommends protecting it. The MVP prints
  guidance to store an admin API token in the swamp Vault. Binding to a
  permissioned Unix socket or enforcing a token is a later iteration.
- Binding privileged ports (80/443) as a user service requires
  `CAP_NET_BIND_SERVICE`; the MVP only needs the unprivileged admin API port.
