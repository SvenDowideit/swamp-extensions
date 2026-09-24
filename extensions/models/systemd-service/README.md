# @svendowideit/systemd-service

A swamp model extension that manages **systemd *user* services** for any
service name and command line.

## What it does

A thin, generic wrapper around `systemctl --user` and unit-file rendering. You
supply the service name and the exact command line to run, and it idempotently
creates, starts, stops, and removes a persistent systemd *user* service. It is
the reusable building block other extensions call to keep a long-lived process
(a web service, an API, a queue server) alive: rather than embedding systemd
logic in every extension, they invoke this model's methods.

Because these are **user** (not system) units, `systemctl --user` alone only
starts them when you log in. `startService` therefore also enables **user
lingering** (`loginctl enable-linger`) so your systemd manager and its enabled
user services start at boot — the way you'd expect a server to behave.

Side effects: it writes one unit file per service at
`<unitDir>/<serviceName>.service`, runs `systemctl --user daemon-reload`, and —
when you start a service — enables it and user lingering. It modifies nothing
outside the unit directory. Linux-only: it shells out to `systemctl --user`.

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

`startService` arguments:

| Argument | Default | Description |
| -------- | ------- | ----------- |
| `serviceName` | — | systemd user service name (without the `.service` suffix). |
| `linger` | `true` | Enable user lingering (`loginctl enable-linger`) so the service starts at boot. Set `false` to keep login-only behavior. |

`stopService`, `removeService`, and `status` each take no arguments beyond the
model instance name; `status` reports the state of the service named after the
model instance (`context.definition.name`), so name the model instance after the
service you want to inspect.

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

## Details

`@svendowideit/systemd-service` ships one model type
(`@svendowideit/systemd-service`) with five methods, and two resources
(`service`, `create`).

| Method | Purpose |
| ------ | ------- |
| `createService` | Write (or update) the unit file and `daemon-reload`. Idempotent — if the unit already matches, it is left untouched. |
| `startService` | Enable user lingering, `systemctl --user enable --now`, and verify it is active. |
| `stopService` | `systemctl --user stop`. Idempotent — stopping an already-stopped or never-created service succeeds. |
| `removeService` | Stop, disable, delete the unit file, and `daemon-reload`. |
| `status` | Report active/enabled state of the model's service. |

Resources:

- `service` — the last reported state: `serviceName`, `unitPath`, `active`,
  `enabled`, `checkedAt`.
- `create` — the last `createService` result: `serviceName`, `unitPath`,
  `written`, `checkedAt`.

### Safety and validation

- **Service names** are validated against systemd's unit-name rules: a name
  containing `/`, `\`, `..`, whitespace, or null bytes is rejected, so a service
  name can never write or delete a unit file outside `unitDir`.
- **Unit directives cannot be injected.** `command`, `description`,
  `workingDirectory`, `environment`, `after`, and `wants` must not contain
  newlines; a newline would start a new directive (e.g. `User=root`), so it is
  rejected rather than silently stripped.
- **Rendered hardening.** The unit sets `PrivateTmp=true`,
  `ProtectSystem=full`, and `TimeoutStopSec=5`.

### Extending and testing

`systemd_service.ts` holds the model and the pure helpers `expandHome`,
`renderServiceUnit`, `assertValidServiceName`, and `assertNoNewlines`. The
helpers are exported so they can be unit-tested without touching a real systemd
session.

```sh
# Type-check and run the unit tests.
~/.swamp/deno/deno check systemd_service.ts
~/.swamp/deno/deno test --allow-read --allow-env systemd_service_test.ts
```

`systemd_service_test.ts` covers home expansion, unit rendering, and the
name/directive validation guards.

## License

MIT — see LICENSE.txt.
