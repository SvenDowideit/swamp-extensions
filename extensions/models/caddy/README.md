# @svendowideit/caddy

A [swamp](https://swamp-club.com) model extension that installs and manages
[Caddy](https://caddyserver.com) on a Linux host with systemd. It is a **swamp
extension** (a TypeScript model type) that drives Caddy through its **admin
API** and **systemd** — it is **not** a Go Caddy plugin.

## What it does

Installs the Caddy binary and runs it as a systemd **user** service, then
manages reverse-proxy routes and TLS live through Caddy's admin API. Routes are
applied via the admin API (not the Caddyfile) and **persist across service
restarts and reboots** (Caddy autosave + `--resume`). It can:

- **Install Caddy** — download the current release, optionally compiling in
  extra modules (DNS providers, the teapot handler, etc.) with no local Go
  toolchain, and place it at `caddyBinPath`.
- **Run it as a service** — write and manage a systemd user service, either as
  a normal TLS reverse proxy on 80/443 or unprivileged on high ports with plain
  HTTP.
- **Proxy services** — add/remove reverse-proxy routes live through the admin
  API (no restart), or declare the route you want and let `ensureDnsProxy`
  reconcile it.
- **Terminate TLS** — configure ACME (Let's Encrypt/ZeroSSL), including DNS
  challenge providers for wildcard certificates.
- **Operate it** — health checks, service lifecycle, config snapshots,
  Vault-backed settings, and binary upgrades.

Side effects: it writes a binary to `caddyBinPath`, writes a systemd user unit
and a Caddyfile under `~/.config`, starts/stops services via `systemctl --user`,
and downloads from `caddyserver.com`.

## Install

```sh
swamp extension pull @svendowideit/caddy
```

Requires Linux with systemd user services, and network access to
`caddyserver.com` to download the binary. See
[Requirements](#requirements) for details.

## Configuration

Global arguments are set at model creation (or `swamp model edit my-caddy`) and
apply to every method run. Every argument is optional; the defaults below apply
when it is unset.

| Argument | Type | Default | Purpose |
| -------- | ---- | ------- | ------- |
| `caddyBinPath` | string | `~/.local/bin/caddy` | Where the Caddy binary is installed. |
| `configPath` | string | `~/.config/caddy/Caddyfile` | Caddy config file the service starts from. |
| `serviceName` | string | `caddy` | systemd user service name. |
| `adminApiAddr` | string | `localhost:2019` | Admin API listen address (or `unix//path`); written to the Caddyfile global options. |
| `adminApiToken` | string | *(unset)* | Optional admin API token (Bearer header). |
| `autoHttps` | string | `on` | Automatic HTTPS mode: `on`, `off` (plain HTTP), or `disable_redirects` / `disable_certs` / `ignore_loaded_certs`. |
| `listenAddrs` | array | `[":443", ":80"]` | HTTP server listen addresses for admin-API routes (e.g. `[":8888", ":8443"]` for unprivileged ports). |
| `baseDomain` | string | *(unset)* | Base domain for derived hostnames (`addProxyService`). |
| `letsEncryptEmail` | string | *(unset)* | ACME / Let's Encrypt email (`configureTls`). |
| `plugins` | array | `[]` | Module packages to compile into the downloaded binary, each optionally `@version`-pinned. |
| `vaultName` | string | *(unset)* | Vault used by `storeConfig` to write secrets. |

Methods also take **per-run arguments** (`--input …`) that override the global
for that call. See the [method reference](#methods) for every argument. Several
common configuration choices:

| I want… | Set |
| ------- | --- |
| Public TLS reverse proxy on 443 | `baseDomain=example.com letsEncryptEmail=admin@example.com` |
| Unprivileged plain HTTP | `autoHttps=off listenAddrs:json=[":8888",":8443"]` |
| Extra Caddy modules in the binary | `plugins:json=["github.com/hairyhenderson/caddy-teapot-module"]` |
| A protected admin API | `adminApiAddr=unix//run/user/1000/caddy.sock` |
| Vault-backed settings | `vaultName=caddy-secrets` then `storeConfig` |

Secrets are read from the Vault by setting global arguments to
`${{ vault.get(<vault>, <key>) }}` expressions (resolved by swamp before the
method runs) — e.g.
`--global-arg 'adminApiToken=${{ vault.get(caddy-secrets, caddy-admin-token) }}'`.

## Examples

Minimal end-to-end setup:

```sh
# 1. Create a model. Set baseDomain/letsEncryptEmail for a public TLS proxy,
#    or autoHttps=off + listenAddrs for unprivileged plain HTTP.
swamp model create @svendowideit/caddy my-caddy \
  --global-arg baseDomain=example.com \
  --global-arg letsEncryptEmail=admin@example.com

# 2. Install the binary, create and start the service.
swamp model method run my-caddy installCaddy
swamp model method run my-caddy createService
swamp model method run my-caddy startService

# 3. Proxy a backend, then check health.
swamp model method run my-caddy addProxyService \
  --input serviceName=my-app --input upstream=127.0.0.1:8080
swamp model method run my-caddy checkHealth
```

Bundled idempotent workflows:

```sh
# full setup: installCaddy → createService → startService → settingsGuidance → configureTls
swamp workflow run caddy-setup

# desired-state proxy: setup (idempotent) + ensureDnsProxy for hostname/upstream
swamp workflow run caddy-ensure-proxy \
  --input hostname=foo.example.com --input upstream=127.0.0.1:8080
```

Compiling in extra Caddy modules (the teapot handler, one of several packages):

```sh
swamp model create @svendowideit/caddy my-caddy \
  --global-arg 'plugins:json=[
    "github.com/hairyhenderson/caddy-teapot-module",
    "github.com/caddy-dns/cloudflare@v0.2.4"
  ]'
swamp model method run my-caddy installCaddy
```

Wildcard certificate via a DNS ACME challenge:

```sh
swamp model method run my-caddy configureTls \
  --input dnsProvider=cloudflare \
  --input 'subjects:json=["*.example.com","example.com"]'
```

Plain HTTP on unprivileged ports:

```sh
swamp model create @svendowideit/caddy my-caddy \
  --global-arg 'listenAddrs:json=[":8888", ":8443"]' \
  --global-arg autoHttps=off
```

Changing configuration and inspecting it later:

```sh
swamp model get my-caddy --json | jq '.globalArguments'
swamp model edit my-caddy
```

## Details

`@svendowideit/caddy` ships one model type (`@svendowideit/caddy`). Every method
it exposes, with its per-run arguments:

| Method | Arguments | Purpose |
| ------ | --------- | ------- |
| `installCaddy` | `plugins` (array), `force` (boolean) | Download the binary (with module packages compiled in), place it at `caddyBinPath`, verify it runs (`caddy version` + `caddy list-modules`). |
| `createService` | `serviceName` (string) | Write the systemd user unit (`~/.config/systemd/user/caddy.service`) and a minimal Caddyfile. |
| `startService` | `serviceName` (string) | `systemctl --user enable --now caddy` and verify the admin API responds on `localhost:2019`. |
| `stopService` | `serviceName` (string) | Stop the Caddy systemd user service. |
| `restartService` | `serviceName` (string) | Restart the Caddy systemd user service. |
| `checkHealth` | `serviceName` (string) | Report Caddy service + admin API health (healthy / down / service-not-active / admin-api-unreachable). |
| `settingsGuidance` | none | Print the minimal Let's Encrypt settings (base domain, ACME email, admin API token). |
| `addProxyService` | `serviceName`, `upstream`, `baseDomain` | Derive a hostname (`<service-name>.<base-domain>`) and add a reverse-proxy route via the admin API (`POST /config/`) — live, no restart. |
| `removeProxyService` | `serviceName`, `baseDomain` | Stop the backend systemd service and remove the Caddy route for the derived domain. |
| `ensureDnsProxy` | `hostname`, `upstream` | Idempotently ensure a full hostname proxies to a backend `host:port` (add if missing, update if the upstream changed, no-op if correct). Safe to run repeatedly — the desired-state entry point. |
| `startBackendService` | `serviceName` | Start a backend systemd user service by name. |
| `stopBackendService` | `serviceName` | Stop a backend systemd user service by name. |
| `restartBackendService` | `serviceName` | Restart a backend systemd user service by name. |
| `storeConfig` | `baseDomain`, `letsEncryptEmail`, `adminApiToken`, `vaultName` | Validate and write the base domain, ACME email, and admin API token to the swamp Vault (`swamp vault put`). |
| `syncConfig` | none | Snapshot the effective config into a swamp resource. |
| `getConfig` | none | Read the stored config back from the swamp resource. |
| `configureTls` | `email`, `dnsProvider`, `dnsEnvVar`, `subjects` | Configure the Caddy TLS app with the ACME email and an optional DNS provider for wildcard / DNS-challenge issuance. |
| `autoProxySwampServe` | `baseDomain`, `prefix`, `port` | Detect running `swamp serve` systemd user services (prefix `swamp-serve-`), derive hostnames, and reconcile their reverse-proxy routes (adds new, removes stopped). |
| `upgradeCaddy` | `plugins` (array), `confirm` (string) | Replace the Caddy binary (current release, with module packages) after explicit confirmation (`confirm=upgrade`), then restart the service. Existing configuration is preserved. |

Resources: the model writes a `install` resource (binary status), `service`,
`guidance`, `proxyServices`, `config` (via `syncConfig`), `tlsConfig`,
`autoProxy`, `upgrade`, `health`, and `ensureProxy`.

### Extra Caddy modules (`plugins`)

Caddy's stock binary does **not** include third-party modules. The extension
asks the [caddyserver.com download API](https://caddyserver.com/api/download)
to compile them in server-side, so **no Go toolchain or `xcaddy` is needed**.
Pass any package listed on the [Caddy download page](https://caddyserver.com/download)
as a `plugins` entry; `installCaddy` / `upgradeCaddy` pass each as a repeated
`p=` parameter. Pin a package to a version by appending `@<version>`
(`go get`-style); each package is pinned independently. After installing,
confirm the modules are present:

```sh
swamp model method run my-caddy installCaddy    # runs `caddy list-modules`
~/.local/bin/caddy list-modules | grep -E 'teapot|dns.providers'
```

Module *behaviour* (e.g. a `teapot` route) is configured through Caddy itself,
not through `plugins`; this extension exposes generic proxy/TLS methods, and
more bespoke config can be applied with the admin API.

### DNS ACME certificates (libdns drivers)

Caddy issues certificates automatically via ACME (Let's Encrypt / ZeroSSL). For
a normal domain, the HTTP-01 challenge works out of the box. For **wildcard
certificates** (`*.example.com`) or DNS-only validation, Caddy needs a **DNS
provider plugin** — built on the [libdns](https://github.com/libdns/libdns)
library, one module per provider (`github.com/caddy-dns/<provider>`).

1. **Download Caddy with the right libdns driver.** Add the provider package to
   `plugins` (see [Extra Caddy modules](#extra-caddy-modules-plugins)) and
   install — the API compiles it into the binary server-side. `configureTls`
   maps these provider names: `cloudflare`, `route53`, `digitalocean`,
   `duckdns`, `porkbun`, `namecheap`. Any module on the
   [Caddy download page](https://caddyserver.com/download) can be requested via
   `plugins` directly (append `@version` to pin).

2. **Set the libdns provider credentials.** Each provider reads its credentials
   from an **environment variable** (e.g. `CLOUDFLARE_API_TOKEN`,
   `AWS_ACCESS_KEY_ID`). Caddy references these in the config as `{env.VAR}`;
   `configureTls` renders the credential as `{env.CADDY_DNS_API_TOKEN}` by
   default (override with `dnsEnvVar`). The Caddy process must have that
   variable in its environment. Add it to the systemd user unit, preferring an
   `EnvironmentFile` with restricted permissions (or `systemd-creds`) over a
   plaintext `Environment=` line:

   ```ini
   # ~/.config/systemd/user/caddy.service
   [Service]
   EnvironmentFile=-%h/.config/caddy/dns.env
   ```

   ```sh
   # ~/.config/caddy/dns.env  (chmod 600)
   CADDY_DNS_API_TOKEN=your-cloudflare-api-token
   ```

   Prefer storing the token in the Vault rather than committing it:

   ```sh
   echo "your-token" | swamp vault put caddy-secrets caddy-dns-token
   ```

3. **Configure the DNS ACME challenge.** Run `configureTls` with the provider
   and the subjects (wildcard + apex). This writes a `tls.automation` policy
   with an ACME issuer using the DNS challenge; Caddy then obtains and
   auto-renews certificates for those subjects using the provider's DNS API.
   Verify with `checkHealth` and by requesting a proxied domain over HTTPS.

### Plain HTTP / unprivileged ports

To run Caddy as an unprivileged systemd user service (no
`CAP_NET_BIND_SERVICE`) serving plain HTTP on non-resolvable or mDNS hostnames,
set `listenAddrs` to unprivileged ports and `autoHttps=off`. `listenAddrs` is
the HTTP server listen addresses used for routes added via the admin API
(default `[":443", ":80"]`). `autoHttps=off` disables both certificate
automation and HTTP→HTTPS redirects; use `disable_redirects` to keep cert
automation but skip the redirect server, or `disable_certs` to keep redirects
but skip issuance. `createService` writes these into the generated Caddyfile,
and the admin API config keeps them when adding routes.

### Config persistence

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
admin-API config. Re-run `createService` after upgrading from an older version
to regenerate the unit with `--resume`.

### Requirements

- Linux with systemd (user services enabled).
- `systemctl --user` works in the environment the model runs in.
- Network access to `caddyserver.com` to download the binary.
- Binding privileged ports (80/443) as a user service requires
  `CAP_NET_BIND_SERVICE`; the admin API port (2019) is unprivileged.

### Notes

- The admin API is powerful; Caddy recommends protecting it. Bind it to a
  permissioned Unix socket by setting `adminApiAddr: unix//path/to/socket`
  (the extension's client talks over it), or front it with an auth proxy and
  set `adminApiToken`.
- The admin endpoint is written to the Caddyfile's `admin` global option. Caddy
  v2.11+ removed the `caddy run --admin` CLI flag, so the systemd unit does not
  pass `--admin`.
- The bundled workflows `caddy-setup` and `caddy-ensure-proxy` ship alongside
  the extension (in this repo's `workflows/`); all their steps are idempotent.

## License

MIT — see LICENSE.txt.
