# @svendowideit/fleet-census

Read-only census of the software on a host that the **OS package manager does not
own** — and who owns it.

The OS package database only knows its own packages. A `curl | bash` tool, an
`npx` one-shot, a python venv, a container image, a `cargo install`, a Go tool
from `~/go/bin` or a source build is invisible to it, so nothing ever migrates it
to swamp and nothing ever retires it. This extension makes that layer visible as
data: `host`, `software` and `summary`.

## What it does

Two ways to run it: **`inventory`** on one host with no network at all, or
**`census`** across the whole fleet in one command (SSH, one round-trip per host,
per-host data plus a cross-host software index).

One `inventory` run:

1. renders a **read-only POSIX `sh` scanner** and runs it on this host (script on
   stdin — nothing is written to the host);
2. parses its line-oriented output;
3. writes three resources.

What the scanner looks at:

| source | what it contributes |
|---|---|
| `PATH` **plus** known user dirs (`~/.local/bin`, `~/go/bin`, `~/.cargo/bin`, nvm, mise, asdf, deno, bun, volta, `extraDirs`) | every executable, de-duplicated by realpath |
| `dpkg -S` | package ownership — the only evidence that yields `provenance: os` |
| `go version -m` | Go module path + version (identity even when the version is `(devel)`) |
| `~/.local/lib/python*/site-packages`, `pipx`, venvs | distributions that provide a console script (that is what "software" means here) |
| `npm root -g`, `~/.npm/_npx/*` | global packages and the npx cache's top-level dependencies |
| `snap`, `flatpak`, `brew`, `cargo install --list` | third-party package managers |
| `/nix/store` paths | nix packages, with name and version parsed from the store path |
| `docker ps`/`docker images` | container images (a `latest` tag is flagged `floating-tag`) |
| systemd units, both scopes | `ExecStart` → binary, expanded (`%h`, `%u`, `@`, `!`, `sh -c`) and paired with unit state as usage evidence |
| `ip -o link` / `ip -o addr` | the host's own interfaces, MACs and addresses |

Two rules are load-bearing:

- **`managed` means OS package manager or swamp, and nothing else.** A
  third-party manager (`mise`, `npm`, `cargo`, `go`, `pip`, `pipx`, `brew`,
  `nix`) is recorded in `manager`; it does not make the item managed. A `tuios`
  binary that `curl` put on a host is `manageable` (an extension exists that
  could own it), never `managed`.
- **No discovered binary is executed.** Versions come from package databases,
  Go build info, `dist-info` metadata, OCI references, release filenames and the
  Nix store path. Where none of those apply, the version is honestly empty and
  the item is flagged `unknown-version`.

## Install

```sh
swamp extension pull @svendowideit/fleet-census
```

No dependency needs pulling first, and nothing is installed on the host.

## Configuration

Global arguments (`swamp model create … --global-arg k=v`, or `swamp model edit`):

| argument | default | meaning |
|---|---|---|
| `scanTimeoutSec` | `180` | wall-clock budget; the scanner is killed and the result is marked `truncated` |
| `execProbe` | `false` | run the **catalogue's own fixed version probes** (e.g. `swamp --version`, `caddy version`) for binaries that carry no version — **on the host that owns the binary**, over the same ssh transport as the scan. Never probes discovered data; each probe is a fixed argv in `owners_catalog.ts`. Probing on the orchestrator would read a same-named local file and report the wrong machine's version, so that is never done |
| `hashMaxBytes` | `33554432` | hash files up to this size for `sha256`; bigger files record an empty hash |
| `maxItems` | `400` | cap on itemised unowned PATH executables |
| `extraDirs` | `[]` | extra directories to scan beyond PATH and the known user dirs |
| `knownDirs` | `true` | include `~/.local/bin`, `~/go/bin`, `~/.cargo/bin`, nvm, mise, asdf, deno, bun, volta. Keep it on: over a non-interactive `ssh` command `PATH` omits `~/.local/bin` and most hand-installed software would be missed |
| `collectAddresses` | `true` | record interfaces, MACs and addresses |

## Examples

```sh
# Create the model once on the host you want to census, then scan it.
# This is the only command needed to produce data.
swamp model create @svendowideit/fleet-census census
swamp model method run census inventory
```

```sh
# The totals, duplicate binaries and the list of unproven versions.
# Read this first: it tells you how much of the host is unmanaged and what could
# not be identified without executing anything.
swamp data query 'modelName == "census" && name == "summary"' --select content
```

```sh
# The migration candidates: items that a swamp extension could take over, with
# the command to start that migration.
swamp data query 'modelName == "census" && name == "software"' \
  --select 'content.items.filter(i, i.owner.class == "manageable")'
```

```sh
# The host's own addresses and MACs. Compare them with the fleet inventory: a
# stored address that is not in this list is stale, which is often why a host
# looks "silent" in the inventory.
swamp data query 'modelName == "census" && name == "host"' --select content
```

```sh
# Items with no owner and no manager: the genuinely unknown layer, oldest first.
swamp data query 'modelName == "census" && name == "software"' \
  --select 'content.items.filter(i, i.owner.class == "unknown" && i.manager == "none")'
```

## Details

One model type (`@svendowideit/fleet-census`), two methods.

### method `inventory` — this host, no network

Runs the scanner on **this** host (no SSH, no network) and writes:

| resource | contents |
|---|---|
| `host` | `hostname`, `fqdn`, `machineId`, `os`, `arch`, `scannedAt`, `durationMs`, `pathDirs[{dir, source}]`, `interfaces[{name, mac, kind, addresses}]`, `addresses[]`, `counts{osManagedExecutables, unownedExecutables, items, byManager, byProvenance, byOwner}`, `warnings[]`, `truncated` |
| `software` | `{ items: SoftwareItem[] }`; each item has `id`, `name`, `identity{kind, name}`, `version`, `versionSource`, `manager`, `provenance`, `installPath`, `realPath`, `sizeBytes`, `mtime`, `sha256`, `owner{class, extension, command, confidence}`, `evidence[{signal, detail}]`, `flags[]`, `bundledWith` |
| `summary` | counts, `duplicates[{identity, paths}]`, `unknownVersion[]`, `nextCommands` |

### method `census` — the whole fleet over SSH

`census` reads the host list from the `@svendowideit/fleet-inventory` model (or
takes `hosts`), then for each host tries every candidate — the addresses the
inventory knows first, then the names — and runs the same read-only scanner
there (`ssh <user>@<host> sh -s`, script on stdin, so it is one round-trip and no
argument-length limit). Bounded parallelism; a host that does not answer is
**recorded, not fatal**.

Arguments: `hosts` (array, empty = the fleet model's list),
`fleetModel` (default `fleet`), `sshUser`, `timeoutSec` (per host, default 180),
`parallel` (default 6), plus the same `maxItems`/`hashMaxBytes` caps. When a host
hits the `maxItems` cap its `host` record says `truncated: true` with a warning —
the scanner reports the cap rather than breaking silently — and per-host data
names are de-duplicated, so two machines reporting the same hostname cannot
overwrite each other.

It writes:

| resource | contents |
|---|---|
| `host` (one per host, data name = the host) | everything `inventory` records, for that host |
| `software` (data name `<host>.software`) | that host's `items[]` |
| `fleet` | `hosts[]` (per-host result including `ok`, `reachedVia`, `error`, counts), `software[]` and `summary` |

`fleet.software` is the cross-host index — one row per product, computed here so
a report never joins per-host data itself:

| field | meaning |
|---|---|
| `identity`, `identities` | the strongest identity seen (`github:owner/repo` beats `name:tool`), and every distinct one that resolved to this product |
| `hosts[]` | `{host, version, manager, owner, flags, installs}` — `installs > 1` means that host has it twice (two `swamp` copies) |
| `versions[]`, `skewed` | distinct known versions; `skewed` when the fleet disagrees |
| `managedOn[]`, `manageableOn[]` | hosts where it is swamp/OS-managed, or where an extension exists to take it over |
| `missingOn[]` | hosts scanned **successfully** that do not have it (a failed host is unknown, not missing) |

Rows are keyed by product name, so a tool that reports Go build info on one host
and not another does not split into two rows.

### method `report` — the three pages

Renders into `outputDir` (default `~/.local/share/fleet-census/site`) and writes
a `site` resource:

| file | what it answers |
|---|---|
| `software.html` | one row per product, **one column per host**: the version each host has, with its channel and a badge for `installs > 1`; `—` means the host was scanned and does not have it, `?` means it was not scanned; rows where the fleet disagrees are shaded. Each product name **links upstream** (GitHub repo, pkg.go.dev, PyPI, npm, Docker Hub), `latest` links to its release tag, and `act` reveals the exact swamp command that would take it over. Two columns explain the row: **`via`** is what installs it (`snap`, `flatpak`, `pip`, `pip-venv`, `npm`, `nvm`, `rustup`, `cargo`, `go`, `nix`, `oci`, or `none` for a hand-installed binary) and **`owner`** is swamp's verdict per host (`managed×N`, `manageable×N`, `unknown×N`) |
| `host.html` | hosts ordered by **attention**: unreachable (25), unknown software (×3), abandoned dependencies (×8), version skew (×2), conversion opportunities (×2), with a per-host detail of what is abandoned there, **what is behind upstream** (installed → latest) and what could be converted, each **linked upstream** so you can look before deciding |
| `index.html` | totals, links to both tables, the abandoned list, conversion candidates, **Behind upstream** and **Version skew — hosts disagree** as separate tables (they are different problems: a fleet can agree on one version and still be releases behind, which is exactly what `swamp` was), every product linked upstream with the conversion command beside each candidate |
| `census.json` | all of the above, unstyled, for reports and agents |

No external assets (no CDN, no fonts, no JS libraries); every value is escaped;
the only script is a row filter. Links are derived from the resolved identity, so
a Go module links to pkg.go.dev, a PyPI package to PyPI, and a GitHub project to
its repo and release tags — and when no honest URL can be derived, none is
invented.

### method `publish` — serve it through Caddy

Creates (once) a `census-caddy` @svendowideit/caddy model for the zone and ensures
a `file_server` route at the hostname. The route is idempotent and merges with the
other caddy models that share that Caddy instance; DNS and the certificate are
derived from the route.

Nothing has to be supplied: with no `hostname`/`baseDomain` the zone is read from
the installed caddy models and the hostname becomes
`census.<this host>.<zone>` — and the A record is derived from the zone's existing
record. If no caddy model owns a zone, `publish` **refuses** rather than falling
back to a placeholder domain, and records why.

```sh
swamp model method run fleet-census publish \
  --input hostname=census.example.com --input baseDomain=swamp.example.com \
  --input routeIp=192.0.2.10
```

### The `fleet-census-sweep` workflow

```sh
swamp workflow run @svendowideit/fleet-census-sweep
swamp workflow run @svendowideit/fleet-census-sweep --input 'hosts:json=["host-a","host-b"]'
```

The full sweep is `census → metadata → assess → report → publish`: scan every
host, fetch upstream release metadata, join it into freshness, render the three
pages, then serve them at `reportHostname` through Caddy. Set
`publishSite=false` to only write the files.

### Scheduling

The workflow **ships a six-hourly trigger** (`0 */6 * * *`): pulling it gives a
site a census, refreshed reports and a refreshed site every six hours. It needs no
configuration, and it is safe to ship because nothing site-specific is assumed and
nothing is invented:

- `publish` derives the zone from the installed `@svendowideit/caddy` models and
  the hostname as `census.<this host>.<zone>`;
- with no caddy model owning a zone it **refuses** to publish (recorded as
  `ok:false`, with the reason) instead of claiming a placeholder domain;
- with no `hosts` input the census scans the machines the fleet model has
  **probed**, not every raw scan hit.

`swamp serve` registers schedules when it starts, so a serve that was already
running before you pulled this version needs one restart. Delete the workflow's
`trigger:` to run it by hand only, or override the cadence and any inputs in the
site's `.swamp/serve.yaml`:

```yaml
triggers:
  '@svendowideit/fleet-census-sweep':
    schedule: '0 3 * * *'
```

`provenance` is one of `os`, `language`, `third-party`, `container`,
`hand-installed`, `source-build`, `swamp`, `unknown`. `manager` is one of `none`,
`go`, `npm`, `npx`, `pip`, `pip-venv`, `cargo`, `rustup`, `nvm`, `nix`, `snap`,
`flatpak`, `brew`, `deno`, `bun`, `volta`, `vendor`, `oci`.

Flags you will see: `unknown-version`, `no-manager`, `no-owner`, `floating-tag`,
`stale-mtime`.

### Ownership: `managed` vs `manageable` vs `unknown`

`managed` is claimed on evidence, never on a guess:

- **OS package manager** — `snap`/`flatpak` packages are `managed` (per the
  agreed definition); `dpkg`-owned files are counted, not itemised.
- **swamp** — a catalogue hit **plus a systemd unit that the owning extension
  installs, running this exact binary on this host**. That is why a `tuios`
  binary that `curl` put on a host is `manageable` while the one a `tuios` unit
  runs is `managed`, and why `herdr-core` (a desktop app with no service) stays
  `manageable` everywhere.
- **`manageable`** — the catalogue knows an extension that would own it; the
  entry's `command` is the migration step, printed and never executed.
- **`unknown`** — nothing owns it and nothing tracks it. That is the census's
  reason to exist.

The catalogue is `owners_catalog.ts` — data, not a registry call, so a run works
offline. Each entry is `{match, extension, command, unitPatterns, upstreamRepo?,
versionProbe?}`: `unitPatterns` is the evidence that upgrades `manageable` to
`managed`, `upstreamRepo` gives a name-only binary an upstream link and a
freshness lookup (that is how `swamp` gets `github.com/swamp-club/swamp`), and
`versionProbe` is a fixed, catalogue-owned command used only when `execProbe` is
enabled (that is how `swamp` gets a version at all). Adding a tool is one
entry, and the confidence/evidence of every claim is stored on the item:

```
"owner": { "class": "managed", "extension": "@svendowideit/ollama", "confidence": 0.7 }
"evidence": [{ "signal": "managed-by",
               "detail": "unit 'ollama' is installed by @svendowideit/ollama and runs this binary on this host" }]
```

A swamp-installed artefact with no service (a CLI, a library) cannot be proven
`managed` this way yet — that is what the deferred provenance-marker contract
(plan §15 Q1, option C) fixes.

### method `assess` — freshness and abandonment

`assess` joins the `fleet` index with `@svendowideit/github-release-install`'s
`releases` data (produced by the workflow's `metadata` step) into a `freshness`
resource, one row per product:

| field | meaning |
|---|---|
| `installed[]` | per host: the version and the channel it is on (`dev`/`lts`/`latest`/`behind`/`unknown`) |
| `latest`, `lts`, `dev` | the upstream channels and their publication dates |
| `upstreamIdleDays` | days since the newest upstream release (or last push) |
| `oldestInstalledDays` | age of the oldest installed version, when it matches a known tag |
| `behindMajor`, `archived` | distance from upstream, and whether the project is archived |
| `flags[]` | `archived`, `upstream-idle-1y`, `upstream-idle-2y`, `behind`, `behind-major`, `dev-install`, `unknown-version`, `upstream-lookup-failed` |

Thresholds are arguments (`idleWarnDays` 365, `idleBadDays` 730). Only products
whose identity is a `github.com` repository are assessed — a Go module on another
host, an npm package or a container image has no release metadata yet.

## Limits (deliberate, for now)

- **This host only.** The fleet fan-out over `@svendowideit/fleet-inventory`'s
  host list, the two HTML reports (software-indexed and host-indexed) and the
  Caddy/DNS publishing step are the next phases; see
  `docs/fleet-census-plan.md` in the repository this came from.
- **No `managed` claims without host evidence.** A provenance marker written by
  an installer is not implemented yet, so the owner classes you will see are
  `manageable` and `unknown`.
- **No upstream freshness yet.** Version age, LTS/latest/dev channels and the
  abandonment score need the release-registry lookups scheduled for the next
  phase.
- **Provenance is inference.** For hand-installed binaries the evidence is
  "not owned by the package database, and lives in a user directory", which is
  why every item carries its `evidence` — treat a wrong guess as visible, not
  silent.

## Upgrade

```sh
swamp extension pull @svendowideit/fleet-census
swamp model upgrade census
```

The scan is idempotent; re-running `inventory` replaces all three resources.
