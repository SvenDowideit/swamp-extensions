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
```

## Configuration (global arguments)

| Argument            | Default                    | Purpose                                  |
| ------------------- | -------------------------- | ---------------------------------------- |
| `caddyBinPath`      | `~/.local/bin/caddy`       | Where the Caddy binary is installed      |
| `caddyVersion`      | *(latest)*                 | Caddy version to install (e.g. `v2.8.4`) |
| `adminApiAddr`      | `localhost:2019`           | Caddy admin API listen address          |
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
