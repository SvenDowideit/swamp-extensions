# @svendowideit/network-status

One hourly HTML page for the Debian-family part of a mixed fleet: pending
package updates, the security-relevant subset, Ubuntu Pro security counts,
Debian debsecan CVEs, and an extensible list of other network action items.

## What it does

`@svendowideit/network-status` audits every configured Debian-family host over
SSH and writes a single self-contained `index.html`. Per host it runs a
read-only probe — no sudo, no package changes:

- `apt-get -s -qq dist-upgrade` for the pending update set;
- the apt origin string for security classification (default substring
  `-security`, which matches both `Debian-Security:13/stable-security` and
  `Ubuntu:24.04/noble-security`);
- `pro security-status --format json` on Ubuntu, for the standard security
  count and the ESM app/infra counts;
- `debsecan --suite <codename> --format detail` on Debian hosts where it is
  installed, for CVE identifiers and fixed versions.

The page shows an overall verdict, totals, a per-host security section, all
pending updates, skipped/unreachable hosts, and an "Other things to do" list.
Hosts that are not Debian-family are reported as skipped rather than failing the
whole sweep.

The page is designed to grow. `tasks.json` (written by `addTask`, `removeTask`
and `clearTasks`) is a plain JSON list that any other workflow can append to, so
the same file can carry disk alerts, certificate renewals, backups, DNS changes
or anything else the network needs. The Debian audit is the first provider.

### Existing extensions this uses

This extension intentionally does not rebuild the pieces that already exist:

- **`@svendowideit/fleet-inventory`** is the recommended source of the host
  list (its `inventory` data has `os` per host, so a CEL filter can select the
  Debian family).
- **`@svendowideit/caddy`** serves the page with its existing `serveSettings`
  file_server route and derives the certificate and A record. The extension's
  `ensure-caddy-serve` method follows the same additive setup pattern as
  `@svendowideit/ebooks` and `@svendowideit/news`: it reads the caddy model that
  owns this machine, creates/updates a dedicated `status-caddy` model carrying
  only that model's `baseDomain` and `serviceName`, then declares the route.
- **`@aaronge/apt-inventory`** remains the right tool for a local-only,
  no-SSH apt audit. This extension is the fleet fan-out and the one-page status
  surface; it does not duplicate apt-inventory's install/remove methods or its
  local versioned delta report.

## Install

```sh
swamp extension pull @svendowideit/network-status
```

`@svendowideit/caddy` is an optional dependency. Pull it separately to enable
the workflow's serve step; without it the audit and page rendering still work
and the serve step skips with a log:

```sh
swamp extension pull @svendowideit/caddy
```

## Configuration

Global arguments are set at model creation (`swamp model create ...`) or later
with `swamp model edit`. Method arguments override them per run.

| Argument | Type | Default | Purpose |
| --- | --- | --- | --- |
| `hosts` | array | `[]` | Hosts to audit. Each entry is `{name,address,user,port,os,local}` or a `user@host:port` string. `local: true` runs the probe on the swamp host without SSH. |
| `sshUser` | string | current user | Default SSH user when a host does not name one. |
| `identityFile` | string | `""` | Optional SSH identity file, e.g. `~/.ssh/id_ed25519`. |
| `connectTimeoutSec` | integer | `10` | SSH connect timeout. |
| `commandTimeoutSec` | integer | `240` | Per-host probe timeout (apt simulation can be slow on a Pi). |
| `parallel` | integer | `8` | Hosts audited concurrently. |
| `securityOrigin` | string | `-security` | Substring that marks an apt origin as security. `-security` works for Debian and Ubuntu; a Debian-only setup can use `stable-security`. |
| `outputDir` | string | `~/.local/share/network-status` | Output directory; the page goes in `site/index.html` and tasks in `tasks.json`. |
| `outputFile` | string | derived | Override the HTML file path. |
| `tasksFile` | string | derived | Override the task-list JSON path. |
| `pageTitle` | string | `Network status` | Page heading. |
| `statusHostname` | string | `""` | Public hostname shown on the page and used for the link (e.g. `status.x1yoga.fi.gy`). |
| `staleAfterHours` | number | `2` | A host result older than this is marked stale on the page. |
| `cveCheck` | boolean | `true` | Parse debsecan CVE detail when available. |
| `tasks` | array | `[]` | Static tasks always shown; merged with `tasksFile`. |
| `caddyModelName` | string | `""` | Source `@svendowideit/caddy` model to read `baseDomain`/`serviceName` from. Empty auto-discovers the model that owns this machine. |
| `caddyRouteHostname` | string | `""` | Override the served hostname. Empty uses `statusHostname`, else `status.<host>.<domain>` from the source caddy model. |
| `caddyServeModel` | string | `status-caddy` | Dedicated caddy model that carries the status route. |

Method arguments:

| Method | Arguments | Purpose |
| --- | --- | --- |
| `audit` | `hosts`, `cveCheck`, `parallel` | Probe the hosts, write the `summary`/`host` resources, render the page. |
| `render` | none | Re-render from the latest `summary` and the current tasks file. |
| `ensure-caddy-serve` | `model`, `hostname`, `serveRoot`, `serveModel` | Idempotently declare the Caddy `file_server` route. Intended to run from the workflow, not in isolation. |
| `addTask` | `id`, `title`, `detail`, `severity`, `link`, `source`, `due` | Add or replace a task, then re-render. |
| `removeTask` | `id` | Remove a task, then re-render. |
| `clearTasks` | `confirm` | Remove every task; requires `confirm=true`. |

## Examples

Create a model for your fleet. The `hosts` list can be typed by hand, or fed
from another workflow (see the hourly workflow below):

```sh
# One model owns the fleet list and the output paths. `local: true` makes the
# first host prove the collector without needing SSH to itself.
swamp model create @svendowideit/network-status status \
  --global-arg 'hosts:json=[{"name":"localhost","address":"localhost","local":true}]' \
  --global-arg statusHostname=status.x1yoga.fi.gy
```

Run the audit once. This is the same command the hourly workflow uses; it writes
`site/index.html` and the swamp data the page is built from:

```sh
# Read-only: no sudo, no package changes. Add more hosts to the model as your
# fleet grows.
swamp model @svendowideit/network-status method run audit status
```

Add an item that is not about packages. Any workflow can call this; the page is
re-rendered immediately so the next browser load shows it:

```sh
# This is how the one page grows beyond Debian packages: another check adds a
# task instead of inventing a second dashboard.
swamp model @svendowideit/network-status method run addTask status \
  --input title="Renew the TLS certificate for the NAS" \
  --input severity=medium \
  --input detail="Expires in 14 days; renew through the DNS provider."
```

Read the structured result if you want to alert on it from another workflow:

```sh
# The summary resource is the machine-readable contract; securityUpdates > 0
# is the predicate for "a host needs security patches".
swamp data get status summary --json | jq '.content.totals'
```

Serving is part of the workflow, not a command to run in isolation. The final
step calls `ensure-caddy-serve`, which follows the ebooks/news pattern:

- it reads the caddy model that already owns this machine (`caddyModelName`, or
  auto-discovery);
- it creates/updates a dedicated `status-caddy` model with only that model's
  `baseDomain` and `serviceName` — no `dnsRecords`, no new Caddy service;
- it calls `serveSettings` for `status.<host>.<domain>` and lets Caddy derive
  the TLS subject and A record from the route.

On the first run Caddy may take a while to reconcile the new DNS record and
certificate; that is expected. On later runs the route and DNS are unchanged and
the step is a no-op. If Caddy is not installed, or auto-discovery cannot pick a
single source model, the step skips with a log.

### Hourly workflow

The bundled workflow (`network-status-hourly.yaml`) is both the setup path and
the hourly refresh. The audit step writes the page; the serve step declares the
route idempotently:

```yaml
trigger:
  schedule: "0 * * * *"
jobs:
  - name: audit-and-serve
    steps:
      - name: audit
        task:
          type: model_method
          modelType: "@svendowideit/network-status"
          modelName: status
          methodName: audit
      - name: serve
        dependsOn:
          - step: audit
            condition:
              type: always
        task:
          type: model_method
          modelType: "@svendowideit/network-status"
          modelName: status
          methodName: ensure-caddy-serve
          inputs:
            model: ${{ inputs.caddyModelName }}
            hostname: ${{ inputs.statusHostname }}
            serveModel: ${{ inputs.caddyServeModel }}
        allowFailure: true
```

The trigger fires only while `swamp serve` is running. Run the same DAG once by
hand to perform the initial setup (or to retry a slow DNS/TLS reconcile):

```sh
# Audit + idempotent Caddy setup in one workflow run.
swamp workflow run @svendowideit/network-status
```

If auto-discovery is ambiguous because the repo has several caddy models, pin
the source model on the status model:

```sh
# Tell the serve step which existing caddy model owns this host.
swamp model edit status --global-arg caddyModelName=my-caddy
```

### Building the host list from fleet inventory

If `@svendowideit/fleet-inventory` already inventories the network, pass a CEL
filter as the workflow's `hosts` input instead of maintaining a second list. The
inventory's `os` field is the discriminator:

```yaml
inputs:
  hosts:
    type: array
    default: []
jobs:
  - name: audit
    steps:
      - name: collect
        task:
          type: model_method
          modelType: "@svendowideit/network-status"
          modelName: status
          methodName: audit
          inputs:
            hosts: ${{ data.latest("fleet", "inventory").attributes.hosts.filter(h, ["ubuntu","debian","raspbian","devuan"].exists(o, o == h.os)).map(h, {"name": h.name, "address": h.address, "os": h.os}) }}
```

The model uses its own `hosts` global when the audit `hosts` input is empty, so
a workflow with no inventory yet still works.

## Details

`@svendowideit/network-status` ships one model type
(`@svendowideit/network-status`).

### Resources

| Resource | Meaning |
| --- | --- |
| `summary` | Generated timestamp, totals, all host results, tasks and collector errors. This is the page's source of truth. |
| `host` | One per audited host (`host-<name>`): OS, pending updates, security/ESM classification, CVEs, Ubuntu Pro summary, timestamps. |
| `tasks` | The network-wide action list written by `addTask`/`removeTask`/`clearTasks`. |

### The probe

The remote script is POSIX `sh` and is piped over SSH stdin. It reads
`/etc/os-release`, refuses non-Debian-family hosts cleanly, runs the apt
simulation read-only, and then optionally `pro` and `debsecan`. Nothing is
installed and nothing is upgraded. `sudo` is never used.

The security classification is belt-and-braces: the apt origin substring is the
primary signal, and Ubuntu Pro's `standard-security` package list is used as a
second signal when present. ESM packages are labelled separately because they
are not installable until Ubuntu Pro is attached.

### The page

`buildHtml` is pure and exported for tests. It escapes every host-supplied
string, links CVEs to the Debian security tracker, marks security rows, and
auto-refreshes once an hour. The CSS is inline, so the page is one file with no
external assets.

### Caddy and DNS

The page is ordinary static content. `ensure-caddy-serve` creates a dedicated
`status-caddy` model that carries only the source caddy model's `baseDomain`
and `serviceName`, then calls `serveSettings`. Caddy's normal route derivation
adds the TLS subject and the A record; the dedicated model deliberately does not
declare `dnsRecords` itself, because those are merged into the shared Caddy and
would duplicate what the route already derives. The source caddy model must
already own the zone (`baseDomain`, DNS provider credential) exactly as the
ebooks/news extensions expect.

### Subprocesses and safety

The extension spawns processes in two narrow places, and both are documented
because the published quality gate asks why a model would do so:

- `runCommand` runs **only** `ssh` or `sh`. The target, port, user and identity
  file come from the model's typed `hosts` entries; the probe script is piped to
  `sh -s` on stdin, never interpolated into a command string. It is read-only,
  never uses `sudo`, and each invocation has its own timeout.
- `runSwampCmd` runs the `swamp` CLI with fixed literal subcommands plus model
  names, hostnames and roots derived from this model's configuration. It is used
  only by `ensure-caddy-serve` to create the dedicated caddy model and call
  `serveSettings`, matching the optional-peer pattern in
  `@svendowideit/ebooks` and `@svendowideit/news`. It is not a shell.

Neither path accepts free-form shell input. The `swamp-quality-ignore
deno-command` markers above those calls are intentional and point here.

### Adding a new kind of network task

Two supported paths:

1. Call `addTask` from any workflow. The item is stored in `tasks.json` and the
   page re-renders.
2. Write `tasks.json` directly (shape: an array of `{id,title,detail,severity,
   link,source,due,addedAt}`), then call `render`.

This is why the page can accumulate "other things I need to do on my network"
without a second dashboard or a schema change.

## Upgrade

This extension installs nothing on the host, so an upgrade has no in-place
rebuild. Update the pulled copy and re-run `audit` to pick up a new probe or
page template:

```sh
swamp extension update @svendowideit/network-status
swamp model @svendowideit/network-status method run audit status
```

## License

MIT — see LICENSE.txt.
