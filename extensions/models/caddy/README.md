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
- **Serve static files** — publish a directory (e.g. a rendered settings bundle)
  over HTTP(S) at a hostname with `serveSettings` (`file_server`), so documents
  are fetchable network-wide without running another server.
- **A default status page** — a fresh install answers `http://localhost` and
  `https://localhost` with a page summarising what's installed (version, domain,
  ACME email, privileged-port capability) and linking to the admin API and any
  configured routes, so a new host is never a blank 404.
- **Terminate TLS** — configure ACME (Let's Encrypt/ZeroSSL), including DNS
  challenge providers for wildcard certificates. Supports single-field providers
  (`api_token`) and multi-field ones (Gandi `bearer_token`; Namecheap
  `api_key`+`user`; DreamHost `api_key`) via `providerConfig`.
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
| `environmentFile` | string | *(unset)* | Path to a systemd `EnvironmentFile` for secrets (e.g. `~/.config/caddy/dns.env`, chmod 600), rendered as `EnvironmentFile=-<path>`. Required for DNS-challenge credentials — see [Wildcard certificates with a DNS provider](#wildcard-certificates-with-a-dns-provider-step-by-step). |

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

Wildcard certificate via a single-field DNS ACME challenge:

```sh
# Cloudflare et al. use one `api_token` field, read from dnsEnvVar.
swamp model method run my-caddy configureTls \
  --input dnsProvider=cloudflare \
  --input dnsEnvVar=CLOUDFLARE_API_TOKEN \
  --input 'subjects:json=["*.example.com","example.com"]'
```

Wildcard certificate via a multi-field DNS provider (Gandi / Namecheap):

```sh
# Gandi's libdns driver expects `bearer_token`, not `api_token`; map each
# credential field to the environment variable that holds it.
swamp model method run my-caddy configureTls \
  --input dnsProvider=gandi \
  --input 'providerConfig:json={"bearer_token":"GANDI_TOKEN"}' \
  --input 'subjects:json=["*.otel.fi.gy","otel.fi.gy"]'

# Namecheap needs both `api_key` and `user` (and a whitelisted client IP).
swamp model method run my-caddy configureTls \
  --input dnsProvider=namecheap \
  --input 'providerConfig:json={"api_key":"NAMECHEAP_API_KEY","user":"NAMECHEAP_USER"}' \
  --input 'subjects:json=["*.example.com"]'
```

Serve a rendered settings directory over HTTPS at a hostname:

```sh
# Publishes /srv/otel/current as static files at settings.otel.fi.gy; Caddy
# terminates TLS for the hostname if automatic HTTPS is configured.
swamp model method run my-caddy serveSettings \
  --input hostname=settings.otel.fi.gy \
  --input root=/srv/otel/current
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

## Managing the model: find, change, and multiple models

### Which Caddy model is "the" one?

There is no registry of "the active model" — a swamp model is just a definition
file, and the extension is driven by *which model you name in the command*. To
find the ones you have:

```sh
# List every model of this type in the repo:
swamp model list --json | jq -r '.results[] | select(.type=="@svendowideit/caddy") | .name'
# -> otel-caddy

# Inspect one: its global args (ports, domain, plugins, serviceName) and type version.
swamp model get otel-caddy --json | jq '{name, typeVersion, globalArguments}'
```

What makes a model "the active one" is its **`serviceName`** (default `caddy`):
that is the systemd unit, and `adminApiAddr` (`localhost:2019`) is the single
running Caddy's admin API. Two models that share the same `serviceName` /
`adminApiAddr` describe **the same running Caddy**; whichever you run a method
on edits that one service. Which model last configured it is recorded on the
status page itself ("Managed by swamp model `<name>`").

### Change an existing model

`swamp model create` fails on an existing name (`Model already exists:
otel-caddy`) — that guard stops you clobbering a model by accident. To change
one, use `swamp model edit`. It is interactive by default; for scripts, feed it
the full definition on stdin (`--json`), including the fields you want to keep:

```sh
# Read the current definition, change one field, write it back.
swamp model get otel-caddy --json \
  | jq '{name, version, tags, globalArguments} | .globalArguments.baseDomain = "new.example.com"' \
  | swamp model edit otel-caddy --json

# Verify the change.
swamp model get otel-caddy --json | jq '.globalArguments.baseDomain'
```

Changing a global arg does **not** touch the running service — global args are
only read when you next run a method. So after editing, re-run whatever consumes
it: edit `plugins` → `installCaddy` (+ `setCapabilities`); edit `listenAddrs` /
`autoHttps` / `environmentFile` → `createService` + `restartService`; edit
`baseDomain` → `configureTls`, `configureStatusPage`, etc.

### More than one Caddy model: they merge, they don't fight

You can (and should) split configuration across several models — e.g. one for
TLS + the status page, another per application or per team. Because only one
process can own :80/:443, those models must cooperate, and the extension makes
them: **every mutating method records what that model wants, then reconciles the
union of all models managing the same Caddy into one valid config.**

A model's Caddy is identified by **(`target`, `serviceName`)**, where `target`
defaults to this machine's hostname. Models with the same pair are merged;
models with a different `serviceName` (or `target`) manage a *separate* Caddy.

How the merge behaves:

- **Routes union.** Each model contributes its routes; a duplicate hostname is a
  real conflict, reported by name (see below).
- **`listenAddrs` and TLS subjects union.**
- **Real conflicts error, naming the models** — rather than a silent last-writer
  wins. Conflicts are: two different upstreams for the same hostname, two
  different TLS emails, or two different DNS providers.
- **Only swamp-managed routes are replaced.** Every route swamp writes carries a
  Caddy `@id` of `swamp:<model>:<hostname>`; reconcile adds/updates/removes only
  those, so routes a human added through the admin API are preserved.
- **The status page is a singleton** on localhost; several models may request one
  (installs do so automatically), and the extension picks one deterministically.

So this is the normal, supported way to work:

```sh
# Model A owns TLS; model B adds an app route. Both manage the same Caddy.
swamp model method run caddy-tls configureTls \
  --input dnsProvider=gandi \
  --input 'providerConfig:json={"bearer_token":"GANDI_BEARER_TOKEN"}' \
  --input 'subjects:json=["*.example.com"]'
swamp model method run caddy-apps ensureDnsProxy \
  --input hostname=shop.example.com --input upstream=127.0.0.1:8080

# The running config contains BOTH: the TLS policy and shop.example.com.
# Adding another route from either model never removes the other's.
```

A conflicting edit is rejected and **not** committed:

```sh
# If caddy-apps and another model both claim shop.example.com with different
# upstreams, this fails loudly and changes nothing:
#   Caddy reconcile conflict for target 'host:caddy':
#   route conflict for 'shop.example.com': desired by 'caddy-b' and 'caddy-apps'
```

To manage a genuinely separate Caddy on the same host (e.g. a second, unprivileged
instance on high ports), give it distinct identity so it does not merge:

```sh
swamp model create @svendowideit/caddy caddy-lab \
  --global-arg serviceName=caddy-lab \
  --global-arg adminApiAddr=localhost:2020 \
  --global-arg configPath=~/.config/caddy-lab/Caddyfile \
  --global-arg caddyBinPath=~/.local/bin/caddy-lab \
  --global-arg autoHttps=off \
  --global-arg 'listenAddrs:json=[":8080"]'
swamp model method run caddy-lab installCaddy
swamp model method run caddy-lab createService
swamp model method run caddy-lab startService
```

Set `reconcile=false` on a model if you want it to write only its own config and
ignore peers (rarely what you want). The `reconcile` resource records which
models were merged on the last run, and the status page names the owning model.

## Details

`@svendowideit/caddy` ships one model type (`@svendowideit/caddy`). Every method
it exposes, with its per-run arguments:

| Method | Arguments | Purpose |
| ------ | --------- | ------- |
| `installCaddy` | `plugins` (array), `force` (boolean), `setCapabilities` (boolean, default true), `configureStatusPage` (boolean, default true) | Download the binary (with module packages compiled in), place it at `caddyBinPath`, verify it runs (`caddy version` + `caddy list-modules`), grant `CAP_NET_BIND_SERVICE` (see [Privileged ports](#privileged-ports-80443)), and install the status page when the admin API is up. |
| `setCapabilities` | `capabilities` (array), `binPath` (string), `quiet` (boolean) | Grant `CAP_NET_BIND_SERVICE` to the binary via `setcap` (then `sudo -n setcap`), or record the exact `sudo setcap` command when sudo is unavailable. Idempotent. |
| `configureStatusPage` | `title` (string), `extraLinks` (array of `{label,url}`), `disabled` (boolean) | Install (or, with `disabled=true`, remove) the status page answering `http://localhost` / `https://localhost`. Idempotent. |
| `plan` | none | Read-only: for **one** Caddy, merge all its models' desired state, compute the config that would be applied, read the live config, and record desired/actual routes, `onlyDesired`/`onlyActual` drift, foreign routes, and both full configs for diffing. Changes nothing. |
| `audit` | none | Read-only, and the one-command entry point: find **every** caddy model, group by the Caddy each manages, and per Caddy report the merged routes (and which model wants each), desired-vs-actual drift, and reachability. Prints a table via the `@svendowideit/caddy-status` report. |
| `createService` | `serviceName` (string) | Write the systemd user unit (`~/.config/systemd/user/caddy.service`) and a minimal Caddyfile. |
| `startService` | `serviceName` (string) | `systemctl --user enable --now caddy` and verify the admin API responds on `localhost:2019`. |
| `stopService` | `serviceName` (string) | Stop the Caddy systemd user service. |
| `restartService` | `serviceName` (string) | Restart the Caddy systemd user service. |
| `checkHealth` | `serviceName` (string) | Report Caddy service + admin API health (healthy / down / service-not-active / admin-api-unreachable). |
| `settingsGuidance` | none | Print the minimal Let's Encrypt settings (base domain, ACME email, admin API token). |
| `addProxyService` | `serviceName`, `upstream`, `baseDomain` | Derive a hostname (`<service-name>.<base-domain>`) and add a reverse-proxy route via the admin API (`POST /config/`) — live, no restart. |
| `removeProxyService` | `serviceName`, `baseDomain` | Stop the backend systemd service and remove the Caddy route for the derived domain. |
| `ensureDnsProxy` | `hostname`, `upstream` | Idempotently ensure a full hostname proxies to a backend `host:port` (add if missing, update if the upstream changed, no-op if correct). Safe to run repeatedly — the desired-state entry point. |
| `serveSettings` | `hostname`, `root`, `browse` (boolean) | Idempotently serve a static directory (e.g. a rendered settings bundle) at a full hostname via Caddy `file_server` (add if missing, update if the root or browse flag changed, no-op if correct). |
| `startBackendService` | `serviceName` | Start a backend systemd user service by name. |
| `stopBackendService` | `serviceName` | Stop a backend systemd user service by name. |
| `restartBackendService` | `serviceName` | Restart a backend systemd user service by name. |
| `storeConfig` | `baseDomain`, `letsEncryptEmail`, `adminApiToken`, `vaultName` | Validate and write the base domain, ACME email, and admin API token to the swamp Vault (`swamp vault put`). |
| `syncConfig` | none | Snapshot the effective config into a swamp resource. |
| `getConfig` | none | Read the stored config back from the swamp resource. |
| `configureTls` | `email`, `dnsProvider`, `dnsEnvVar`, `providerConfig` (object), `subjects` (array) | Configure the Caddy TLS app with the ACME email and an optional DNS provider for wildcard / DNS-challenge issuance. Single-field providers use `dnsEnvVar` (rendered as `api_token`); multi-field providers use `providerConfig` (field → env var), e.g. Gandi `{bearer_token: GANDI_TOKEN}`. |
| `autoProxySwampServe` | `baseDomain`, `prefix`, `port` | Detect running `swamp serve` systemd user services (prefix `swamp-serve-`), derive hostnames, and reconcile their reverse-proxy routes (adds new, removes stopped). |
| `upgradeCaddy` | `plugins` (array), `confirm` (string) | Replace the Caddy binary (current release, with module packages) after explicit confirmation (`confirm=upgrade`), then restart the service. Existing configuration is preserved. |

Resources: the model writes a `install` resource (binary status + capabilities),
`service`, `guidance`, `proxyServices`, `config` (via `syncConfig`), `tlsConfig`,
`autoProxy`, `upgrade`, `health`, `ensureProxy`, `serveSettings`, `capabilities`,
`statusPage`, `desired` (what this model wants from its Caddy), and `reconcile`
(which peer models were merged on the last run).

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
   `duckdns`, `porkbun`, `namecheap`, `gandi`, `dreamhost`. Any module on the
   [Caddy download page](https://caddyserver.com/download) can be requested via
   `plugins` directly (append `@version` to pin). Remember to also add the
   `github.com/caddy-dns/<provider>` package to `plugins` so the driver is
   compiled in.

2. **Set the libdns provider credentials.** Each provider reads its credentials
   from **environment variables** (e.g. `CLOUDFLARE_API_TOKEN`,
   `AWS_ACCESS_KEY_ID`) and the field names differ per provider — most take a
   single `api_token`, but **Gandi** uses `bearer_token`, **Namecheap** needs
   `api_key`+`user`, and **DreamHost** uses `api_key`. Caddy references the
   values in the config as `{env.VAR}`. For a single `api_token` provider,
   `configureTls` renders `{env.CADDY_DNS_API_TOKEN}` by default (override with
   `dnsEnvVar`); for multi-field providers, pass `providerConfig` mapping each
   field to its environment variable. The Caddy process must have those
   variables in its environment — set the model's **`environmentFile`** global
   arg and `createService` renders `EnvironmentFile=-<path>` into the unit (do
   **not** hand-edit the unit; the next `createService` overwrites it).

3. **Configure the DNS ACME challenge.** Run `configureTls` with the provider
   and the subjects (wildcard + apex). This writes a `tls.automation` policy
   with an ACME issuer using the DNS challenge; Caddy then obtains and
   auto-renews certificates for those subjects using the provider's DNS API.
   Verify with `checkHealth` and by requesting a proxied domain over HTTPS.

### Wildcard certificates with a DNS provider (step by step)

The HTTP-01 challenge can't issue **wildcard** certs (`*.example.com`), so a
wildcard needs the ACME **DNS-01** challenge, which writes a `_acme-challenge`
TXT record through the provider's API. This walkthrough uses **Gandi**, whose
libdns driver reads a Personal Access Token from the `bearer_token` field.

**1. Get a Gandi Personal Access Token** with permission to manage the zone's
records (Gandi's old "API key" is not supported by the driver). Create it in
your Gandi account; it looks like a long opaque string.

**2. Create the model with the DNS plugin compiled in, an environment file, and
your ACME email.** The DNS driver is a Caddy module, so it must be in `plugins`:

```sh
# baseDomain is the zone; plugins compiles the Gandi driver into the binary;
# environmentFile is where the PAT will live; letsEncryptEmail is the ACME account.
swamp model create @svendowideit/caddy my-caddy \
  --global-arg baseDomain=example.com \
  --global-arg letsEncryptEmail=admin@example.com \
  --global-arg 'plugins:json=["github.com/caddy-dns/gandi"]' \
  --global-arg environmentFile=~/.config/caddy/dns.env
```

**3. Write the token into the environment file (chmod 600).** Use the model's
`environmentFile` path; the variable name must match the one you pass to
`providerConfig` in step 5:

```sh
# Create the env file with the Gandi PAT. Keep it out of version control.
install -d -m 700 ~/.config/caddy
printf 'GANDI_BEARER_TOKEN=%s\n' "$YOUR_GANDI_PAT" > ~/.config/caddy/dns.env
chmod 600 ~/.config/caddy/dns.env
```

(Alternatively, keep the token in a swamp vault and write it out at deploy time
from `vault.get(...)` rather than pasting it here.)

**4. Install the binary and (re)create the service so the unit loads the env
file.** `createService` renders `EnvironmentFile=-~/.config/caddy/dns.env`:

```sh
swamp model method run my-caddy installCaddy
swamp model method run my-caddy createService
swamp model method run my-caddy startService

# Confirm the unit now reads the env file:
grep EnvironmentFile ~/.config/systemd/user/caddy.service
# -> EnvironmentFile=-/home/you/.config/caddy/dns.env

# Confirm Caddy can actually see the variable (it must print the name, not the value):
systemctl --user show caddy -p Environment | grep -o GANDI_BEARER_TOKEN
```

**5. Configure the DNS-01 challenge.** Map the driver's credential field
(`bearer_token`) to the env var name (`GANDI_BEARER_TOKEN`) with
`providerConfig`, and list the subjects (wildcard + apex). This writes the
`tls.automation` ACME issuer with the DNS challenge:

```sh
swamp model method run my-caddy configureTls \
  --input dnsProvider=gandi \
  --input 'providerConfig:json={"bearer_token":"GANDI_BEARER_TOKEN"}' \
  --input 'subjects:json=["*.example.com","example.com"]'
```

The resulting TLS policy is equivalent to this Caddyfile, which is what Caddy
uses to create the `_acme-challenge` record and prove control of the zone:

```caddyfile
example.com {
  tls {
    dns gandi {env.GANDI_BEARER_TOKEN}
  }
}
```

**6. Verify.** Point a route at a backend under the wildcard, then request it
over HTTPS; Caddy issues the cert on first use:

```sh
swamp model method run my-caddy ensureDnsProxy \
  --input hostname=app.example.com --input upstream=127.0.0.1:8080

# First request triggers issuance (may take a few seconds); a valid cert means
# the DNS-01 challenge succeeded.
curl -sv https://app.example.com/ 2>&1 | grep -iE 'SSL certificate|subject:'
```

If issuance fails, Caddy logs the ACME error (`journalctl --user -u caddy`),
which usually names the provider problem directly — e.g. an unauthorized/expired
PAT, or a token without permission on the zone. The status page's
"Compiled-in plugins" line confirms `github.com/caddy-dns/gandi` is present.

### Privileged ports (80/443)

Caddy runs as an unprivileged systemd **user** service, so by default it cannot
bind ports 80/443. Grant the binary the `CAP_NET_BIND_SERVICE` capability:

```sh
# installCaddy tries this automatically (setCapabilities defaults to true).
# Run it on its own to (re)apply or to get the exact command:
swamp model method run my-caddy setCapabilities

# If the model had no sudo, run the printed command once by hand:
sudo setcap 'cap_net_bind_service=+ep' ~/.local/bin/caddy
```

Details:

- `setCapabilities` first tries `setcap`, then non-interactive `sudo -n setcap`.
  If neither works it does **not** fail — it records the exact `sudo setcap …`
  command in the `capabilities` resource (field `command`) and logs it, so you
  can copy-paste it. `installCaddy` does the same and stores it in the `install`
  resource as `needsSudoForPorts`.
- **Replacing the binary drops the capability.** `upgradeCaddy` and
  `installCaddy force=true` reapply it automatically if it was set before; if you
  ever download a new binary by other means, re-run `setCapabilities`.
- **The generated unit is kept out of a user namespace** (no `ProtectSystem` /
  `PrivateTmp`) and does not set `LimitNPROC`, because both would silently break
  privileged binding — see [Why the unit has no hardening](#why-the-unit-has-no-hardening).
  Re-run `createService` after upgrading from an older version to regenerate it.
- Alternatives if you cannot or will not use capabilities: run Caddy as a root
  system service, or keep it unprivileged on high ports (`listenAddrs=[":8080"]`,
  `autoHttps=off`) behind a separate TLS terminator.

### Why the unit has no hardening

Two systemd options that look sensible actively prevent an unprivileged user
service from binding 80/443, so `createService` omits them:

- **`LimitNPROC`** is per-UID for a systemd *user* service, so it counts every
  process and thread you are already running. A low value (e.g. `512`) makes
  Caddy's Go runtime fail to spawn a thread with `EAGAIN` and exit `status=2`
  ("failed to create new OS thread … may need to increase ulimit -u"). The user
  manager's `TasksMax` already bounds the slice.
- **`ProtectSystem=full` / `PrivateTmp=true`** require a mount namespace, which
  an unprivileged user service can only create inside a **child user
  namespace**. A process in a child userns cannot bind host privileged ports
  even with `CAP_NET_BIND_SERVICE` set: the kernel's `ns_capable()` check tests
  the network namespace's owning (parent) userns, so the bind fails `EACCES`.

If you do not need privileged ports, you can add hardening back by editing the
unit after `createService` (swamp will rewrite it on the next `createService`).

### The default status page

A fresh Caddy has no routes, so it answers nothing useful. `installCaddy`
(default) and `startService` install a status page showing:

- the installed Caddy version, base domain, and ACME email,
- whether `CAP_NET_BIND_SERVICE` is set (i.e. whether 80/443 will work),
- the **third-party plugins compiled into the binary** (parsed from
  `caddy list-modules --json`), grouped by Go package with version and module
  names — or a note that the binary is stock,
- a link to the Caddy admin API (`http://localhost:2019/config/`), and
- a link per configured proxy route.

**It answers on every hostname your models name, as a fallback.** The page's
hostnames are the loopback set (`localhost`, `127.0.0.1`, `[::1]`) **plus every
TLS subject and explicit status hostname** any model declares, **minus any
hostname that already has its own route**. So:

- a configured hostname (e.g. `x1yoga.fi.gy`) is never a blank 404 — it serves the
  status page until a real route claims it;
- an explicit route always wins (the status route is written last);
- crucially, because the hostname now appears in a route match, **Caddy requests a
  certificate for it**. Caddy only issues certs for names it sees in a route, so
  without this a "configured" hostname would get no cert and `dig` would fail.

It is a single Caddy `static_response` route — no file on disk. Manage it
directly:

```sh
# (Re)install it after changing routes or domains, or set a custom title.
swamp model method run my-caddy configureStatusPage
swamp model method run my-caddy configureStatusPage --input title="My Caddy"

# Add your own links (label + url objects).
swamp model method run my-caddy configureStatusPage \
  --input 'extraLinks:json=[{"label":"Grafana","url":"http://localhost:3000"}]'

# Remove it if you want localhost to be handled by a real site.
swamp model method run my-caddy configureStatusPage --input disabled=true
```

Because `installCaddy` runs before the service exists, the status page is
installed on a best-effort basis there (it needs the admin API) and is reliably
(re)installed by `startService`; the `caddy-setup` workflow also calls
`configureStatusPage` after `start`.

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

### One command to see what's going on

You do **not** need to know (or look up) any model names. This single command
finds every caddy model in the repo, groups them by the Caddy they manage, merges
what each wants, reads each Caddy's live config, and prints a table plus the
drift:

```sh
# `<anyname>` is just a scratch instance to run the method on; it is
# auto-created and can be any name. Nothing is changed.
swamp model method run @svendowideit/caddy audit caddy-status
```

It prints, per Caddy:

```
# Caddy status
## x1yoga · caddy — ✓ in sync
- Models: `otel-caddy`, `caddy-web`
- Admin API: localhost:2019
| URL (route)       | Kind  | Target         | Wanted by  |
| alpha.otel.fi.gy  | proxy | 127.0.0.1:8081 | otel-caddy |
| beta.otel.fi.gy   | proxy | 127.0.0.1:8082 | caddy-web  |
```

`✗ DRIFT` and "Wanted but not live" / "Live but not wanted" lines appear when the
merged desire and the running config disagree; `⚠ unreachable` when a Caddy's
admin API can't be read. The output also includes an **Unmerged** table — each
model's *own* desired state before merging — and a **Next commands** block with
the exact commands to inspect each layer, so you never have to guess or look
elsewhere. The same data is stored for scripting:

```sh
swamp data get caddy-status audit --json | jq '.content.cadies[] | {
  target, models, unmerged, desiredRoutes, onlyDesired, onlyActual, inSync,
  nextCommands }'
```

Three layers, each inspectable and each named in the Next commands output:

- **Unmerged** — one row per model (`unmerged` in the output, or
  `swamp data get <model> desired --json | jq .content`).
- **Merged** — `plan`'s `desiredConfig` (the whole config the extension would
  apply), or `swamp data get <runModel> plan --json | jq '.content.desiredConfig'`.
- **Actual** — the live config at the admin API.

A `TLS / DNS` section reports the certificate layer too, so a DNS-01 setup is not
hidden:

```
TLS / DNS:
- Desired (by `my-caddy`): provider `gandi`, email `admin@example.com`,
  subjects `*.example.com`, creds bearer_token
- Live: `*.example.com` (DNS-01 via `gandi`)
- Plugins wanted: github.com/caddy-dns/gandi — all compiled in
- Env file: `~/.config/caddy/dns.env` — present, keys: GANDI_BEARER_TOKEN
- TLS in sync: ✓
```

It compares the provider/email/subjects and credential fields your models want
against the running TLS config, checks each wanted plugin is compiled into the
binary (and names any missing ones — re-run `installCaddy`), and verifies the
`environmentFile` exists with the expected keys. If the driver and env file are
set up but no model has run `configureTls` yet, the section says so and tells you
to run it.

It also reports **certificates actually issued** (read from Caddy's data
directory) and lists any desired subject with no cert yet:

```
- Live config: `x1yoga.fi.gy` (DNS-01 via `gandi`)
- Certificates issued: NONE yet — still pending: `x1yoga.fi.gy`
```

That distinction matters: "config present" is not "certificate issued". When a
cert is pending, the ACME failure is in the Caddy log
(`journalctl --user -u caddy`) — e.g. a Gandi PAT without record-write
permission returns `LiveDNS returned a 403 (Access was denied to this resource)`.

To compare the **whole desired config** against the **live config** for one
Caddy, use `plan` (same merge, but stores both full configs):

```sh
swamp model method run @svendowideit/caddy plan caddy-status
swamp data get caddy-status plan --json \
  | jq '.content.desiredConfig' > /tmp/desired.json
swamp data get caddy-status plan --json \
  | jq '.content.actualConfig'  > /tmp/actual.json
diff -u /tmp/desired.json /tmp/actual.json
```

The three layers, if you want them separately:

| Layer | Meaning | Where |
| ----- | ------- | ----- |
| **Desired** | what the models want (one file each) | `swamp data get <model> desired --json` |
| **Merged/actions** | what reconcile computed & applied | `swamp data get <model> reconcile --json` |
| **Actual** | what the running Caddy serves | `curl -s http://localhost:2019/config/ \| jq` |

`onlyDesired` non-empty means a model wants a route that is **not** live (re-run
the mutating method; a reconcile normally does it). `onlyActual` non-empty means
a swamp-tagged route is live that no model wants (a leftover; the next reconcile
removes it). `foreignRoutes` are routes added through the admin API by hand —
swamp never removes these. Routes are tagged `swamp:<model>:<host>`, so you can
also list just ours from Caddy:

```sh
curl -s http://localhost:2019/config/apps/http/servers/srv0/routes \
  | jq '[.[] | select(."@id" | startswith("swamp:")) | {id: ."@id", hosts: [.match[].host[]]}]'
```

Checking one hostname end-to-end:

```sh
swamp model method run @svendowideit/caddy ensureDnsProxy caddy-web \
  --input hostname=shop.example.com --input upstream=127.0.0.1:8080

# desired: shop.example.com should be here
swamp data get caddy-web desired --json | jq '.content.routes[].hostname'
# actual: and the live config should agree
curl -s http://localhost:2019/config/apps/http/servers/srv0/routes | jq '[.[]."@id"]'
# 3. if they differ, plan tells you which side is missing what
swamp model method run otel-caddy plan
swamp data get otel-caddy plan --json | jq '.content | {onlyDesired, onlyActual, inSync}'
```

Note DNS is a separate system: a route existing in Caddy does not create a DNS
record (that is `@svendowideit/libdns` / your provider's API, §7.1 of the plan),
so `dig` failing while the route exists is expected until the record is added.

### Config persistence

Routes are applied live via the admin API, not written to the Caddyfile. Caddy
autosaves the running JSON config (to `~/.config/caddy/autosave.json`), but only
reloads it when started with `--resume`. The systemd unit therefore runs:

```
ExecStart=... run --resume --config <Caddyfile> --adapter caddyfile
```

Replacing the binary (upgrade) clears file capabilities, which is why
`upgradeCaddy` reapplies `CAP_NET_BIND_SERVICE` after the download — otherwise a
running 443 listener would fail to come back up.

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
