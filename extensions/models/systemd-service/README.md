# @svendowideit/systemd-service

A swamp model extension that manages **systemd *user* services** for any
service name and command line. It is a thin, generic wrapper around
`systemctl --user` and unit-file rendering — you supply the service name and
the exact command line to run, and it idempotently stands up a persistent
service.

## What it does

| Method | Purpose |
|---|---|
| `createService` | Write (or update) the unit file and `daemon-reload`. Idempotent — if the unit already matches, it is left untouched. |
| `startService` | `systemctl --user enable --now` and verify it is active. |
| `stopService` | `systemctl --user stop`. |
| `removeService` | Stop, disable, delete the unit file, and `daemon-reload`. |
| `status` | Report active/enabled state. |

## Why it exists

Other extensions often need to run a long-lived process (a web service, an
API, a queue server) as a persistent background service. This model type is the
generic building block for that: any other extension can call its methods to
idempotently create and start a systemd user service for an arbitrary command
line.

A primary use case is running **swamp's bundled Deno** to serve dynamic web
services and APIs — for example `@svendowideit/news`'s `feedback-server`:

```sh
swamp model @svendowideit/systemd-service method run createService feedback-server \
  --input 'serviceName=feedback-server' \
  --input 'command=~/.swamp/deno/deno run --allow-net --allow-read --allow-write --allow-env scripts/feedback-server.ts' \
  --input 'description=News feedback queue server' \
  --input 'workingDirectory=~/.swamp/pulled-extensions/@svendowideit/news/files' \
  --input 'environment=FEEDBACK_PORT=8765'

swamp model @svendowideit/systemd-service method run startService feedback-server \
  --input 'serviceName=feedback-server'
```

## Installation

```sh
swamp extension pull @svendowideit/systemd-service
```

## Global arguments

| Argument | Default | Description |
|---|---|---|
| `denoPath` | `~/.swamp/deno/deno` | Path to the Deno binary used to run Deno services (defaults to swamp's bundled Deno). |
| `unitDir` | `~/.config/systemd/user` | Directory where systemd user unit files are written. |

## `createService` arguments

| Argument | Default | Description |
|---|---|---|
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

## License

MIT
