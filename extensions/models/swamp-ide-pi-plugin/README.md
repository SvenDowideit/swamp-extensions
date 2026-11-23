# @svendowideit/swamp-ide-pi-plugin

Install, enable and disable the pi addin that routes tool calls through
`@svendowideit/swamp-ide`, and records every routed and bypassed call.

## What it does

The pi addin is a file in pi's extension directory. This extension owns that
file:

- `install` writes the bundled addin into `<project>/.pi/extensions/swamp-ide.ts`
  or `~/.pi/agent/extensions/swamp-ide.ts`.
- It refuses to overwrite or remove a file that does not contain its managed
  marker, unless `force=true`.
- `set enabled=true` writes the session marker used by the addin; `enabled=false`
  removes that session's marker, or all markers when no session id is given.
- `uninstall` removes the managed file and every marker for the scope.
- `status` reports pi availability, the install path, and which sessions are
  enabled.

The addin itself exposes `swamp_ide`, prefers it over built-in file/shell tools,
and records routed and bypassed tool calls as OTLP spans and JSONL activity
events for the Herdr panel. It runs methods through a single warm `swamp serve`
WebSocket per session and falls back to the CLI only when that connection cannot
be established. It also keeps a per-program histogram of the bash commands that
still bypass the IDE, so the next herdr-core/vim method can be chosen from real
use. `@svendowideit/swamp-ide` calls `set` so one command can enable or disable
the whole system.

## Install

```sh
swamp extension pull @svendowideit/swamp-ide-pi-plugin
```

pi must be on PATH, or a `~/.pi/agent` install must exist. The addin imports
`typebox` from pi itself; no extra dependency is installed.

## Configuration

| Global argument | Default | Meaning |
| --- | --- | --- |
| `piBin` | `pi` | pi executable |
| `scope` | `project` | Install into the project `.pi` or `~/.pi/agent` |
| `projectDir` | `""` | Project root for project scope; empty uses the current directory |
| `force` | `false` | Overwrite/remove a destination that is not managed |

`set` takes `enabled` and optional `sessionId` (empty uses `PI_SESSION_ID`;
empty on disable clears every marker). `install` and `uninstall` take optional
`scope` and `force` overrides.

| Addin environment variable | Default | Meaning |
| --- | --- | --- |
| `SWAMP_IDE_MODE` | `advise` | `off`, `advise`, or `enforce` |
| `SWAMP_IDE_SERVE` | unset | `off` disables the serve fast path |
| `SWAMP_SERVE_URL` | `ws://127.0.0.1:9090` | swamp serve endpoint |
| `SWAMP_AGENT_IDE_EVENT_LOG` | `~/.local/state/swamp-agent-ide/events.jsonl` | activity events for the Herdr panel |
| `SWAMP_AGENT_IDE_SHELLOUT_LOG` | `~/.local/state/swamp-agent-ide/shellouts.jsonl` | shell-out histogram records |
| `SWAMP_IDE_OTEL_ENABLED` | `true` | set `false` to stop span export |

## Examples

Install the managed addin into this project:

```sh
swamp model @svendowideit/swamp-ide-pi-plugin method run install ide-pi
```

Enable it for the current pi session, then run `/reload` in pi:

```sh
swamp model @svendowideit/swamp-ide-pi-plugin method run set ide-pi \
  --input enabled=true
```

Report what is installed and which sessions are enabled:

```sh
swamp model @svendowideit/swamp-ide-pi-plugin method run status ide-pi
```

Disable it for every session without removing the managed file:

```sh
swamp model @svendowideit/swamp-ide-pi-plugin method run set ide-pi \
  --input enabled=false
```

## Details

Model type: `@svendowideit/swamp-ide-pi-plugin`.

| Method | Data written |
| --- | --- |
| `install` | `plugin` (instance `swamp-ide`) |
| `set` | `plugin` (instance `swamp-ide`) |
| `uninstall` | `plugin` (instance `swamp-ide`) |
| `status` | `plugin` (instance `swamp-ide`) |

Managed paths:

- project: `.pi/extensions/swamp-ide.ts` and `.pi/swamp-ide/<session>.enabled`
- global: `~/.pi/agent/extensions/swamp-ide.ts` and
  `~/.pi/agent/swamp-ide/<session>.enabled`

The extension does not edit pi's `settings.json`. The installed file carries a
managed marker; a file without it is treated as someone else's and is never
removed silently.

## Upgrade

```sh
swamp extension update
```

Re-run `install` after an upgrade to refresh the managed addin.

## Serve fast path and shell-out histogram

After `/reload`, the addin opens one WebSocket to `SWAMP_SERVE_URL` and sends
`model.method.run` requests over it. The connection is cached for the session; a
failed connect is retried after 30 seconds. If serve is not reachable, the
addin spawns the CLI exactly as before. Once a request has been sent it is never
retried through the CLI, because the method may already have produced data.

Every bash tool call is split into shell segments and its executable is appended
to `SWAMP_AGENT_IDE_SHELLOUT_LOG` as one JSON object per program. In pi:

- `/swamp-ide` shows the serve connection and the top five programs.
- `/swamp-ide histogram` shows the top twenty programs and program+subcommand
  counts, with `bypass`/`other` totals.

The same program and subcommand are attached to the OTLP span as
`swamp.agent.shell.program`, `swamp.agent.shell.subcommand`, and
`swamp.agent.shell.category`, so the dashboard can group them too.
