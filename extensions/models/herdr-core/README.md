# @svendowideit/herdr-core

Give an agent hands and eyes in a herdr-core session that stays running:
terminals, files, commands, search, and the whole machine fleet, as swamp
methods and data instead of a shell process per action.

## What it does

`herdr-core` is the persistent runtime behind the Herdr desktop app. A
background server owns terminals, their programs, scrollback, files and a fleet
of other machines. This extension turns that runtime into swamp methods:

- observe: `status`, `terminals`, `read`, `wait`, `machines`
- drive: `run`, `send`, `keys`, `interrupt`, `kill`, `rm`, `put`
- files: `file-read`, `file-write`, `file-edit`
- processes: `exec`, `search`
- fleet: `machine-add`, `machine-remove`
- tracing: `otel-status`

Every call records typed swamp data. One call can fan out over many targets,
taking the swamp lock once. The same session is visible in every Herdr client,
so a human can watch while the agent works.

Every method can export one OTLP/HTTP span. The endpoint, mesh and bearer token
come from `@svendowideit/otel-settings` when that contract is configured, then
from the standard OTEL environment. A missing or broken observability setup is
reported by `otel-status`, never raised by the method.

## Install

```sh
swamp extension pull @svendowideit/herdr-core
```

The `herdr-core` binary (or its `hc` alias) must be on PATH, or set `herdrBin`.
It is installed by `@svendowideit/herdr-app` and shared by every Herdr install
on the machine.

Optional: pull `@svendowideit/otel-settings` and render its contract if you
want the extension to discover the OTLP endpoint automatically:

```sh
swamp extension pull @svendowideit/otel-settings
swamp model @svendowideit/otel-settings method run render otel
```

Without that contract, set `OTEL_EXPORTER_OTLP_ENDPOINT` (and optionally
`OTEL_EXPORTER_OTLP_TOKEN`) or `otelEndpoint` on the model.

## Configuration

| Global argument | Default | Meaning |
| --- | --- | --- |
| `herdrBin` | `herdr-core` | The binary or `hc` alias to run |
| `defaultCwd` | `""` | Working directory when a method does not give one |
| `defaultMachine` | `""` | herdr-core machine to target by default |
| `maxOutputBytes` | `200000` | Maximum output retained in data |
| `otelEnabled` | `true` | Export OTLP spans |
| `otelModel` | `otel` | `@svendowideit/otel-settings` model name |
| `otelVaultName` | `""` | Vault holding the OTLP bearer token |
| `otelTokenRef` | `OTEL_EXPORTER_OTLP_TOKEN` | Vault/environment key for the token |
| `otelEndpoint` | `""` | Explicit OTLP/HTTP traces endpoint |
| `otelMesh` | `""` | Preferred contract mesh; empty uses `defaultMesh` |
| `otelServiceName` | `swamp-herdr-core` | `service.name` for spans |
| `otelTimeoutMs` | `2500` | Maximum time for one span POST |
| `otelDebug` | `false` | Log the resolved endpoint and export errors |
| `eventLogEnabled` | `true` | Append one JSONL event per method for the Herdr activity panel |
| `eventLog` | `~/.local/state/swamp-agent-ide/events.jsonl` | Shared activity log read by the panel |

Per-call arguments:

| Method | Arguments |
| --- | --- |
| `status` | none |
| `terminals` | `all`, `machine`, `agent`, `cwd`, `state`, `label`, `detail` |
| `read` | `targets`, `machine`, `lines` |
| `run` | `argv`, `name`, `cwd`, `machine`, `labels`, `bg`, `keep`, `timeout` |
| `send` | `targets`, `machine`, `text`, `force`, `ifStatus`, `wait`, `timeout` |
| `keys` | `targets`, `machine`, `keys` |
| `interrupt`, `kill`, `rm` | `targets`, `machine` |
| `put` | `target`, `file`, `machine` |
| `wait` | `target`, `machine`, `output`, `children`, `timeout` |
| `exec` | `argv`, `machines`, `machine`, `cwd`, `env`, `timeout`, `stdin` |
| `file-read` | `paths`, `machine`, `cwd`, `offset`, `limit` |
| `file-write` | `path`, `content`, `machine`, `cwd` |
| `file-edit` | `path`, `edits` (each `{old,new}`), `machine`, `cwd` |
| `file-edit-lines` | `path`, `edits` (each `{startLine,endLine,lines,expectedLines}`), `machine`, `cwd`, `expectedHash` |
| `search` | `pattern`, `paths`, `globs`, `machine`, `cwd`, `caseSensitive`, `fixedStrings`, `hidden`, `noIgnore`, `maxResults` |
| `machines` | none |
| `machine-add` | `target`, `name`, `via`, `install`, `temporary` |
| `machine-remove` | `machine` |
| `otel-status` | `test` |
| `label` | `target`, `machine`, `labels` |
| `pi-sessions` | `all`, `machine`, `maxAgeDays` |
| `pi-resume` | `all`, `machine`, `maxAgeDays`, `dryRun`, `only` |

## Examples

Read the live session before choosing a target:

```sh
swamp model @svendowideit/herdr-core method run terminals herdr-core \
  --input all=true --input agent=pi
```

This lists the terminals an agent can attach to or read, with the machine and
working directory already resolved.

Run a test in a terminal a human can watch, and wait for its exit code:

```sh
swamp model @svendowideit/herdr-core method run run herdr-core \
  --input 'argv:json=["npm","test"]' \
  --input cwd="$PWD" \
  --input name=test-run
```

This replaces `npm test` in a throwaway shell with a real terminal that stays
alive, so the output is still there after the run.

Search a repository and replace one exact sentence:

```sh
swamp model @svendowideit/herdr-core method run search herdr-core \
  --input pattern=agent-ide-control

swamp model @svendowideit/herdr-core method run file-edit herdr-core \
  --input path=docs/notes.md \
  --input 'edits:json=[{"old":"old sentence","new":"new sentence"}]'
```

The search returns path/line/column evidence. The edit replaces exactly one
occurrence and writes the file atomically; if the old text is missing or
ambiguous, the call fails and the file is unchanged.

When the lines are already known, replace a line range instead of guessing at
exact text. `expectedLines` is the context the caller saw; if those lines have
moved, the call is refused rather than writing to the wrong place:

```sh
swamp model @svendowideit/herdr-core method run file-edit-lines herdr-core   --input path=src/index.ts   --input 'edits:json=[{"startLine":12,"endLine":14,"lines":["return 42;"],"expectedLines":["// TODO","return 0;","}"]}]'
```

Use `search` or `file-read` first to find the line numbers. `expectedHash` adds
a whole-file check when the caller has a prior read.

Do the same on a machine the server already knows:

```sh
swamp model @svendowideit/herdr-core method run exec herdr-core \
  --input machine=xeon \
  --input 'argv:json=["git","status","--short"]'
```

This is the fleet path: `exec` runs without a terminal, returns the exit code
and exact output, and can fan out over several machines in one call.

Check tracing:

```sh
swamp model @svendowideit/herdr-core method run otel-status herdr-core
swamp model @svendowideit/herdr-core method run otel-status herdr-core \
  --input test=true
```

The first call says whether spans are enabled, where they go and why not. The
second posts one test span and reports the HTTP result without failing the run.

## Details

Model type: `@svendowideit/herdr-core`.

Methods and data:

| Method | Data written |
| --- | --- |
| `status` | `status` |
| `terminals` | one `terminal` per terminal, plus `fleet` |
| `read` | one `read-result` per target |
| `run` | `run-result` |
| `send` | `send-result` per target |
| `keys` | `keys-result` per target |
| `interrupt` | `interrupt-result` per target |
| `kill` | `kill-result` per target |
| `rm` | `remove-result` per target |
| `put` | `put-result` |
| `wait` | `wait-result` |
| `exec` | `exec-result` per machine |
| `file-read` / `file-write` / `file-edit` | `file-result` |
| `search` | `search-result` |
| `machines` | `machines`, plus one `machine` per machine |
| `machine-add` / `machine-remove` | `machine` |
| `otel-status` | `otel-status` |

The extension is a client of the existing `herdr-core` binary. It does not
start its own server, edit herdr-core's state files, or replace the Herdr app.
It writes only swamp resources.

### Agent adoption

The extension is designed to be called by an agent, not just by a person. A
tool-call router (for example a pi extension) can expose these methods as a
single `swamp_ide` tool, add a prompt rule that prefers it over `bash`/`read`/
`edit`, and record bypassed calls with `swamp.route=bypass`. The extension's
spans then use `swamp.route=herdr-core` and the same `TRACEPARENT`, so a trace
shows both routed and bypassed work.

### Tracing

`otel-status` resolves in this order:

1. `otelEndpoint`
2. the newest `resolved` (or legacy `settings`) resource on `otelModel`
3. `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` or `OTEL_EXPORTER_OTLP_ENDPOINT`

The bearer token comes from `otelVaultName` + `otelTokenRef`, then the same
environment key, then `authorization` in `OTEL_EXPORTER_OTLP_*_HEADERS`.

Spans carry `swamp.route`, `swamp.method`, `swamp.target`, `swamp.machine`,
`swamp.outcome`, `swamp.success`, `swamp.duration_ms` and `swamp.error`. Use
those attributes to define what success means in your observability backend.

## Upgrade

```sh
swamp extension update
```

Nothing is installed on the host, so updating the pulled model type is enough.
