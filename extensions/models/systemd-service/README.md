# @svendowideit/systemd-service

A swamp model extension that manages **systemd *user* services** for any
service name and command line.

## What it does

A thin, generic wrapper around `systemctl --user` and unit-file rendering. You
supply the service name and the exact command line to run, and it idempotently
creates, starts, stops, restarts, and removes a persistent systemd *user*
service. It is the reusable building block other extensions call to keep a
long-lived process (a web service, an API, a queue server) alive: rather than
embedding systemd logic in every extension, they invoke this model's methods.

It also answers "what does swamp expect, what actually exists, and what state is
it in?" with a single `audit` call: every model of this type, its live systemd
unit state, declared and listening TCP ports, stale reported state, drift, and
orphan managed units.

Because these are **user** (not system) units, `systemctl --user` alone only
starts them when you log in. `startService` therefore also enables **user
lingering** (`loginctl enable-linger`) so your systemd manager and its enabled
user services start at boot — the way you'd expect a server to behave.

Side effects: it writes one unit file per service at
`<unitDir>/<serviceName>.service`, runs `systemctl --user daemon-reload`, and —
when you start a service — enables it and user lingering. `audit` only reads
(`systemctl --user show`, `ss`, the unit directory, cgroup v2). It modifies
nothing outside the unit directory. Linux-only: it shells out to
`systemctl --user`.

## Install

```sh
swamp extension pull @svendowideit/systemd-service
```

No dependencies: it uses `systemctl --user` and `loginctl`, which ship with
systemd.

## Configuration

Global arguments (set at model creation with `--global-arg key=value`):

| Argument | Default | Description |
| -------- | ------- | ----------- |
| `denoPath` | `~/.swamp/deno/deno` | Path to the Deno binary used to run Deno services (defaults to swamp's bundled Deno). |
| `unitDir` | `~/.config/systemd/user` | Directory where systemd user unit files are written. |
| `cgroupRoot` | `/sys/fs/cgroup` | cgroup v2 mount point. `audit` reads a unit's `<ControlGroup>/cgroup.procs` to attribute live listening ports to its process tree. |

`createService` arguments:

| Argument | Default | Description |
| -------- | ------- | ----------- |
| `serviceName` | — | systemd user service name (without the `.service` suffix). |
| `command` | — | Full command line the service runs. |
| `description` | — | Human-readable description for the `[Unit]` section. |
| `workingDirectory` | — | Working directory for the service (`WorkingDirectory=`). |
| `environment` | `[]` | Environment variables as `KEY=VALUE` strings (`Environment=`). |
| `restart` | `on-failure` | `Restart=` policy. |
| `restartSec` | `5` | `RestartSec=` delay between restarts. |
| `after` | `[network-online.target]` | `After=` dependencies. |
| `wants` | `[network-online.target]` | `Wants=` dependencies. |
| `force` | `false` | Rewrite the unit file even if it already matches. |
| `hardening` | `true` | Apply `PrivateTmp=true` and `ProtectSystem=full`. Set false for a service that must read root-owned SSH config: `PrivateTmp`'s user namespace maps root-owned files to `nobody`, which OpenSSH rejects. |
| `enableEnsureBinariesPath` | `true` | Prepend the `ExecStart` binary's directory to the unit's `PATH` when it is not already there. A caller-supplied `PATH=` is only prepended to; without one the directory goes in front of the systemd default PATH (`/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`). Set false to keep the previously inherited PATH exactly. |

`enableEnsureBinariesPath` matters when the service binary lives outside the
standard directories. A user-installed `swamp` or `herdr-core` lives in
`~/.local/bin`, which the systemd user manager may not have on `PATH`, so the
service can exec its own binary but cannot spawn its sibling tools. The default
puts the binary's directory first (once), so `hc`, `herdr-core`, or any other
sibling is found. The directory is left alone when it is already in the PATH,
and a bare, relative, or `/`-only executable is never added — `.` and `/` on
`PATH` are a security hazard. Pass `enableEnsureBinariesPath=false` for a
service whose inherited PATH must not change.

`startService` arguments:

| Argument | Default | Description |
| -------- | ------- | ----------- |
| `serviceName` | — | systemd user service name (without the `.service` suffix). |
| `linger` | `true` | Enable user lingering (`loginctl enable-linger`) so the service starts at boot. Set `false` to keep login-only behavior. |

`stopService`, `restartService`, `removeService`, and `status` each take no
arguments beyond the model instance name; `status` reports the state of the
service named after the model instance (`context.definition.name`), so name the
model instance after the service you want to inspect.

`audit` arguments:

| Argument | Default | Description |
| -------- | ------- | ----------- |
| `serviceName` | `all` | `all` reports every model of this type; any other value audits only the model whose name or managed unit matches, and errors if none is found. |

Run `audit` against any model instance — the trailing name in
`swamp model … method run audit <name>` is just the model record the run is
filed under; it does not scope the audit. In `all` mode `audit` discovers every
model of this type itself, and the instance you point at does not matter. To
avoid choosing an instance entirely, run the bundled workflow (below), which
needs no name.

## Examples

Stand up a long-lived Deno web service under systemd — the primary use case
(`@svendowideit/news`'s `feedback-server`):

```sh
# Create (or update) the unit and reload systemd.
swamp model @svendowideit/systemd-service method run createService feedback-server \
  --input 'serviceName=feedback-server' \
  --input 'command=~/.swamp/deno/deno run --allow-net --allow-read --allow-write --allow-env scripts/feedback-server.ts' \
  --input 'description=News feedback queue server' \
  --input 'workingDirectory=~/.swamp/pulled-extensions/@svendowideit/news/files' \
  --input 'environment=FEEDBACK_PORT=8765'

# Start it, enable it, and enable user lingering so it survives logout/reboot.
swamp model @svendowideit/systemd-service method run startService feedback-server \
  --input 'serviceName=feedback-server'
```

Pass several environment variables, or override the restart policy:

```sh
# Multiple KEY=VALUE environment entries, and a stricter restart policy.
swamp model @svendowideit/systemd-service method run createService api \
  --input 'serviceName=api' \
  --input 'command=/usr/bin/api --port 8080' \
  --input 'workingDirectory=/srv/api' \
  --input 'environment=PORT=8080' \
  --input 'environment=LOG_LEVEL=info' \
  --input 'restart=always' \
  --input 'restartSec=2'
```

A service installed under `~/.local/bin` gets that directory on its PATH, so it
can spawn sibling tools (`swamp serve` → `herdr-core`/`hc`). The default does
this automatically; the explicit form documents the behavior, and the second
command shows the opt-out for a service that must keep an inherited PATH:

```sh
# Prepends /home/alice/.local/bin to the unit PATH (default behavior).
swamp model @svendowideit/systemd-service method run createService swamp-serve-unit \
  --input 'serviceName=swamp-serve' \
  --input 'command=/home/alice/.local/bin/swamp serve'

# Keep the inherited PATH exactly as it was before this option existed.
swamp model @svendowideit/systemd-service method run createService legacy \
  --input 'serviceName=legacy' \
  --input 'command=/home/alice/.local/bin/legacy' \
  --input 'enableEnsureBinariesPath=false'
```

Restart a service after replacing its executable — `enable --now` does **not**
restart an already-active unit, so a binary upgrade needs this to take effect:

```sh
# Restart and verify the service is active.
swamp model @svendowideit/systemd-service method run restartService feedback-server \
  --input 'serviceName=feedback-server'
```

Stop or fully remove a service:

```sh
# Stop the running service (leaves the unit file in place).
swamp model @svendowideit/systemd-service method run stopService feedback-server \
  --input 'serviceName=feedback-server'

# Stop, disable, delete the unit file, and daemon-reload.
swamp model @svendowideit/systemd-service method run removeService feedback-server \
  --input 'serviceName=feedback-server'
```

Change a unit's definition and re-apply it. Because `createService` is
idempotent, it rewrites the file only when the rendered unit differs, then
reloads systemd:

```sh
# Update the command line; createService rewrites the unit and reloads systemd.
swamp model @svendowideit/systemd-service method run createService api \
  --input 'serviceName=api' \
  --input 'command=/usr/bin/api --port 9090'
```

Audit every service model against the live host in one call. The default
(`all`) discovers every model of this type itself, compares each unit's systemd
state to the last state the model reported, and reads live TCP ports from the
unit's process tree. Pass a service name to narrow the audit to one model:

```sh
# One row per model: state, declared + live ports, stale reported state, drift.
swamp model @svendowideit/systemd-service method run audit feedback-server

# Audit only the model that owns feedback-server (errors if there is none).
swamp model @svendowideit/systemd-service method run audit feedback-server \
  --input 'serviceName=feedback-server'

# Read the structured result (scope, services[], orphanUnits[], counts).
swamp data get feedback-server audit --json
```

### The bundled audit workflow

For a name-free, log-first audit, run the workflow shipped with this extension
(registered as `@svendowideit/systemd-service-audit`). It runs the `audit`
method via direct type execution — so no model instance name has to be typed —
and prints an aligned table of every service to the log:

```sh
# Audit every model; prints a MODEL/SERVICE/STATE/ENABLED/DECLARED/LISTENING/DRIFT table.
swamp workflow run @svendowideit/systemd-service-audit

# Audit one model or managed unit instead; fails if it does not exist.
swamp workflow run @svendowideit/systemd-service-audit \
  --input service=feedback-server

# Read the same structured result the workflow produced.
swamp data get systemd-service-audit audit --json
```

The table marks a `!` in the `DRIFT` column when the last state a model
reported no longer matches the host. The workflow files its run under an
auto-created `systemd-service-audit` model instance.

## Details

`@svendowideit/systemd-service` ships one model type
(`@svendowideit/systemd-service`) with seven methods, and three resources
(`service`, `create`, `audit`).

| Method | Purpose |
| ------ | ------- |
| `createService` | Write (or update) the unit file and `daemon-reload`. Idempotent — if the unit already matches, it is left untouched. Prepends the binary's directory to the unit PATH unless `enableEnsureBinariesPath=false`. |
| `startService` | Enable user lingering, `systemctl --user enable --now`, and verify it is active. |
| `stopService` | `systemctl --user stop`. Idempotent — stopping an already-stopped or never-created service succeeds. |
| `restartService` | `systemctl --user restart` and verify it is active. Use after replacing the service's executable or updating its unit. |
| `removeService` | Stop, disable, delete the unit file, and `daemon-reload`. |
| `status` | Report active/enabled state of the model's service. |
| `audit` | List models of this type with their live systemd unit state, declared + listening TCP ports, last reported state, drift, and orphan managed units. `--input serviceName=all` (default) covers every model; any other value scopes to one and errors when absent. |

The extension also ships one workflow, `@svendowideit/systemd-service-audit`,
which runs `audit` with no instance name and logs the table (see
[The bundled audit workflow](#the-bundled-audit-workflow)).

Resources:

- `service` — the last reported state: `serviceName`, `unitPath`, `active`,
  `enabled`, `checkedAt`.
- `create` — the last `createService` result: `serviceName`, `unitPath`,
  `written`, `checkedAt`.
- `audit` — the last `audit` result: `scope` (`"all"` or the requested
  service), `services[]` (one row per model with `modelName`, `serviceName`,
  `unitPath`, `exists`, `state`, `loadState`, `activeState`, `subState`,
  `unitFileState`, `mainPid`, `declaredPorts`, `listeningPorts[]`,
  `reportedActive`, `reportedEnabled`, `reportedAt`, `drift`), `modelCount`,
  `runningCount`, `failedCount`, `absentCount`, `orphanUnits[]`, `auditedAt`.

### How `audit` works

- **Discovery** — it enumerates every definition of this type (so a model that
  has never run is still listed) and unions in the model names that have
  produced `service`/`create` data, which is also where the *service name* and
  the last reported `active`/`enabled` come from (a model instance may manage a
  differently named unit, e.g. `tuios-daemon` → `tuios.service`).
- **Scope** — `serviceName=all` (the default) keeps every model. Any other
  value keeps only the model whose name or managed unit matches and raises an
  error naming the known models when nothing matches, so a typo is never
  reported as "all clear". Orphan detection runs only in `all` mode.
- **State** — one `systemctl --user show` per unit, mapped to a compact `state`
  (`running`, `starting`, `restarting`, `stopping`, `failed`, `not-found`).
- **Ports** — `declaredPorts` is parsed from the unit file (`--port`,
  `-p`, `PORT=`/`*_PORT=`, `host:port`); `listeningPorts` is the live truth from
  `ss -Hltnp`, attributed to the unit's processes via cgroup v2
  (`<ControlGroup>/cgroup.procs`). Ports are a hint when a process binds a port
  dynamically or is not yet running.
- **Drift** — `drift` is true when the last state a model reported disagrees
  with systemd now (including a unit that has since disappeared).
- **Orphans** — unit files under `unitDir` carrying this extension's
  `Managed by` header but with no matching model.
- **Degrade gracefully** — `ss` without privileges, cgroup v2 unavailable, or a
  missing unit directory simply yield empty port/orphan lists rather than
  failing the audit.

### Safety and validation

- **Service names** are validated against systemd's unit-name rules: a name
  containing `/`, `\`, `..`, whitespace, or null bytes is rejected, so a service
  name can never write or delete a unit file outside `unitDir`.
- **Unit directives cannot be injected.** `command`, `description`,
  `workingDirectory`, `environment`, `after`, and `wants` must not contain
  newlines; a newline would start a new directive (e.g. `User=root`), so it is
  rejected rather than silently stripped.
- **Rendered hardening.** The unit sets `PrivateTmp=true`,
  `ProtectSystem=full`, and `TimeoutStopSec=5` by default. Pass
  `hardening=false` on `createService` when the service must read root-owned
  files (for example an SSH client config under `/etc/ssh/ssh_config.d`):
  `PrivateTmp` runs the service in a user namespace where only the service UID
  is mapped, so root-owned files appear as `nobody` and OpenSSH refuses them.
- **PATH is extended, never guessed.** `createService` reads the executable
  from the `ExecStart` command (including quotes, systemd's `-+!:@` prefixes,
  and `env NAME=VALUE` indirection) and prepends its directory to PATH only
  when it is absent. A relative, bare, or `/`-only executable is skipped, and a
  caller-supplied `PATH=` is only prepended to — never replaced. The default
  tail is systemd's own PATH, not the PATH of whichever process ran swamp, so
  the rendered unit is deterministic and auditable.

### Extending and testing

`systemd_service.ts` holds the model and the pure helpers: `expandHome`,
`renderServiceUnit`, `assertValidServiceName`, `assertNoNewlines`,
`executablePath`, `ensureExecutableDirOnPath` (with `SYSTEMD_DEFAULT_PATH`),
and — for `audit` — `parseDeclaredPorts`, `parseSsListeners`, `parseCgroupPids`,
`resolveCgroupRoot`, and `stateFor`. The helpers are exported so they can be
unit-tested without touching a real systemd session.

```sh
# Type-check and run the unit tests.
~/.swamp/deno/deno check systemd_service.ts
~/.swamp/deno/deno test --allow-read --allow-env systemd_service_test.ts
```

`systemd_service_test.ts` covers home expansion, unit rendering, the
name/directive validation guards, the PATH derivation (quoted/`env`/prefixed
commands, deduplication, the opt-out), the `ss`/cgroup/port parsers, the
systemd state mapping, and the `audit` assembly (including drift detection)
driven through `createModelTestContext` and `withMockedCommand`.

## License

MIT — see LICENSE.txt.
