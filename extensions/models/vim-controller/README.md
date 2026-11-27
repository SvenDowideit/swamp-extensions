# @svendowideit/vim-controller

Edit the Vim buffer a human is watching: read the buffer, replace exact text or
line ranges atomically, move the cursor, draw a virtual agent cursor, and read
quickfix — without spawning `sed` or `cat`.

## What it does

Vim is already a programmable editor when it is started with `--servername`:
`--remote-expr` can read lines, replace a buffer, move the cursor, draw text
properties and read quickfix. This extension wraps that surface as swamp
methods:

- observe: `servers`, `status`, `read`, `diagnostics`
- edit: `edit`, `write`, `undo`
- show: `cursor`, `annotate`
- drive: `command`, `expr`, `keys`
- lifecycle: `open`, `close`
- tracing: `otel-status`

`open` starts Vim in a herdr-core terminal so the window stays open for a human
to watch. `edit` applies exact-text or line-range changes in one call, rejects
an ambiguous match before touching the buffer, returns the undo sequence and a
unified diff, and never leaves a half-applied edit. `annotate` uses Vim text
properties for a virtual cursor, so the human keeps the real one.

Every method can export one OTLP/HTTP span. The endpoint, mesh and bearer token
come from `@svendowideit/otel-settings` when that contract is configured, then
from the standard OTEL environment. A missing or broken observability setup is
reported by `otel-status`, never raised by the method.

## Install

```sh
swamp extension pull @svendowideit/vim-controller
```

Vim needs `+clientserver`, `+channel`, `+textprop` and `+quickfix`, and an X11
display (XWayland is fine). Check with:

```sh
vim --version | grep -E 'clientserver|channel|textprop|quickfix'
```

`open` also needs the `herdr-core` binary (or its `hc` alias) to host the
terminal. An existing Vim started with `--servername` works without
herdr-core.

Optional: pull `@svendowideit/otel-settings` and render its contract if you
want automatic OTLP discovery:

```sh
swamp extension pull @svendowideit/otel-settings
swamp model @svendowideit/otel-settings method run render otel
```

Without that contract, set `OTEL_EXPORTER_OTLP_ENDPOINT` (and optionally
`OTEL_EXPORTER_OTLP_TOKEN`) or `otelEndpoint` on the model.

## Configuration

| Global argument | Default | Meaning |
| --- | --- | --- |
| `vimBin` | `vim` | Vim binary |
| `herdrBin` | `herdr-core` | Binary used by `open` to host Vim when it falls back to a background terminal |
| `herdrAppBin` | `herdr-app` | Binary used by `open` to place Vim in an editor tab, and by `focus` to show it |
| `editorTab` | `Edit` | Name of the per-space tab `open` creates |
| `autoOpen` | `true` | Reopen the editor tab when a method needs a Vim that is not running |
| `serverPrefix` | `swamp-vim` | Prefix for a cwd-derived server name |
| `defaultServer` | `""` | Server used when a method names none |
| `defaultCwd` | `""` | cwd for `open` when the method gives none |
| `maxOutputBytes` | `200000` | Maximum output retained in data |
| `otelEnabled` | `true` | Export OTLP spans |
| `otelModel` | `otel` | `@svendowideit/otel-settings` model name |
| `otelVaultName` | `""` | Vault holding the OTLP bearer token |
| `otelTokenRef` | `OTEL_EXPORTER_OTLP_TOKEN` | Vault/environment key for the token |
| `otelEndpoint` | `""` | Explicit OTLP/HTTP traces endpoint |
| `otelMesh` | `""` | Preferred contract mesh |
| `otelServiceName` | `swamp-vim` | `service.name` for spans |
| `otelTimeoutMs` | `2500` | Maximum time for one span POST |
| `otelDebug` | `false` | Log the resolved endpoint and export errors |
| `eventLogEnabled` | `true` | Append one JSONL event per method for the Herdr activity panel |
| `eventLog` | `~/.local/state/swamp-agent-ide/events.jsonl` | Shared activity log read by the panel |

Per-call arguments:

| Method | Arguments |
| --- | --- |
| `servers` | none |
| `open` | `server`, `file`, `cwd`, `reuse`, `place` (`tab`, `background`), `waitMs` |
| `status` | `server` |
| `read` | `server`, `mode` (`all`, `visible`, `selection`), `start`, `end` |
| `edit` | `server`, `edits`, `save` |
| `write` | `server`, `force` |
| `cursor` | `server`, `line`, `col` |
| `annotate` | `server`, `line`, `col`, `text`, `clear` |
| `select` | `server`, `line1`, `col1`, `line2`, `col2` |
| `diff` | `server` |
| `command` | `server`, `command`, `allowShell` |
| `expr` | `server`, `expr`, `allowUnsafe` |
| `keys` | `server`, `keys` |
| `diagnostics` | `server` |
| `undo` | `server`, `seq` |
| `openFile` | `server`, `file`, `cwd`, `force` |
| `editFile` | `server`, `file`, `cwd`, `edits`, `expectedHash`, `force` |
| `focus` | `server`, `terminal`, `tab` |
| `close` | `server`, `force` |
| `otel-status` | `test` |

Edits are objects. Use one of:

```json
{ "old": "exact text found once", "new": "replacement" }
{ "startLine": 3, "endLine": 3, "lines": ["replacement"] }
{ "setLines": ["whole", "new", "buffer"] }
```

## Examples

See which Vim servers exist, then open a new one in this space's editor tab:

```sh
swamp model @svendowideit/vim-controller method run servers vim
swamp model @svendowideit/vim-controller method run open vim \
  --input file=src/index.ts --input cwd=$PWD
```

`open` reads `HC_TERMINAL_ID` to learn which Herdr space it is in, names the Vim
server after that space (`swamp-vim-swamp-project`) and starts Vim in one tab
named `Edit` for the space, without taking focus: whichever tab the person is
looking at stays their choice. Every later `open` in that space reuses the same
server, so a space keeps one editor. `--input place=background` keeps the old
behaviour of a background terminal parented to the calling pane, and that is
what `open` falls back to when there is no Herdr window.

Make the editor the writer: one call loads the path, applies the edits and saves,
creating the file when it does not exist yet. This is the method to use when a
file change must be visible in the buffer the person is watching:

```sh
swamp model @svendowideit/vim-controller method run editFile vim \
  --input file=src/other.ts \
  --input 'edits:json=[{"old":"old sentence","new":"new sentence"}]'
```

With no `server`, it derives this space's editor, creates the `Edit` tab if it is
not running (never taking focus), and applies line ranges bottom-up. `force`
defaults to true: on this path the buffer is the file, so an unsaved buffer is
replaced rather than refused.

Load a different file into the same editor, so the buffer the person is watching
follows the work (a path that does not exist yet opens empty, and `write`
creates it):

```sh
swamp model @svendowideit/vim-controller method run openFile vim \
  --input server=swamp-vim-swamp-project --input file=src/other.ts
```

`openFile` refuses to replace a buffer that has unsaved changes unless
`--input force=true`, and reports whether the path existed.

Ask for the editor to be shown when you want the person to look at it, and read
where a server lives from `status`:

```sh
swamp model @svendowideit/vim-controller method run focus vim \
  --input server=swamp-vim-swamp-project

swamp model @svendowideit/vim-controller method run status vim \
  --input server=swamp-vim-swamp-project
```

`focus` selects the recorded tab (or focuses its terminal) only when you ask —
`open` never moves the person. `status` reports `machine`, `space`, `tab` and
`placed` beside the buffer state, so an agent can say where the editor is
instead of naming a server nobody can find.

Every method that needs a server reopens the tab if it is gone, so a person can
close the `Edit` tab whenever they like and the next `read`, `edit` or `status`
puts it back on the file `open` last recorded (`autoOpen`, on by default). Set
`autoOpen=false` to make a missing server an error instead.

Closing the tab does not remove it from Herdr's memory: herdr-core keeps a shell
running in the terminal after Vim exits. The extension therefore treats a tab as
its own by the **placement record** (`space`, `tab` and `terminal` written by
`open`) rather than by what is running in it. It closes its own recorded tab
before creating a new one and in `close`, but refuses to touch a tab of the same
name that it did not create and that still holds a live program — that one is
the person's, and the error says to close it or set `editorTab`.

Read what the human sees, then replace one exact sentence:

```sh
swamp model @svendowideit/vim-controller method run read vim \
  --input server=swamp-demo --input mode=visible

swamp model @svendowideit/vim-controller method run edit vim \
  --input server=swamp-demo \
  --input 'edits:json=[{"old":"old sentence","new":"new sentence"}]'
```

The edit fails before changing the buffer if the old text is missing or occurs
more than once. On success the `edit-result` resource carries the undo
sequence, before/after hashes and a unified diff.

Show where the agent is looking without moving the human's cursor:

```sh
swamp model @svendowideit/vim-controller method run annotate vim \
  --input server=swamp-demo \
  --input line=12 --input text="▶ agent"
```

This draws a Vim text property after line 12; `clear=true` removes it.

Select a visual range, or compare the buffer with the file on disk:

```sh
swamp model @svendowideit/vim-controller method run select vim \
  --input server=swamp-demo \
  --input line1=10 --input col1=1 --input line2=14 --input col2=20

swamp model @svendowideit/vim-controller method run diff vim \
  --input server=swamp-demo
```

The first returns the selected lines; the second returns the unified diff between
the buffer and the saved file, without writing anything.

Read diagnostics or run one Ex command:

```sh
swamp model @svendowideit/vim-controller method run diagnostics vim \
  --input server=swamp-demo

swamp model @svendowideit/vim-controller method run command vim \
  --input server=swamp-demo --input command="set number"
```

The first reads Vim's quickfix and location lists. The second runs one Ex
command; shell escapes and process-starting commands need `allowShell=true`.

Check tracing:

```sh
swamp model @svendowideit/vim-controller method run otel-status vim
swamp model @svendowideit/vim-controller method run otel-status vim \
  --input test=true
```

The first says whether spans are enabled, where they go and why not. The second
posts one test span and reports the HTTP result without failing the run.

## Details

Model type: `@svendowideit/vim-controller`.

| Method | Data written |
| --- | --- |
| `servers` | `servers` |
| `open` | `server` |
| `status` | `server-status` |
| `read` | `buffer` |
| `edit` | `edit-result` |
| `write` | `write-result` |
| `cursor`, `undo` | `server-status` |
| `annotate` | `annotation` |
| `command` | `command-result` |
| `expr` | `expr-result` |
| `keys` | `keys-result` |
| `diagnostics` | `diagnostics` |
| `openFile` | `open-file` |
| `editFile` | `edit-result` |
| `focus` | `focus-result` |
| `close` | `close-result` |
| `otel-status` | `otel-status` |

The extension sources the bundled `swamp_vim.vim` runtime into the server on
first use. The runtime only reads and writes the current buffer, cursor, text
properties and quickfix; the extension owns exact-once checks, hashes and the
diff.

### Start Vim yourself

`open` is the easiest path, but any Vim started with a server name works:

```sh
vim --servername swamp-demo -n src/index.ts
```

Then use `server=swamp-demo` with the methods above. A Vim started without
`--servername` cannot be adopted; restart it with the flag.

### Safety

- Exact-text edits are rejected when the old text is missing or ambiguous.
- Line edits are bounds-checked before anything is sent to Vim.
- `command` rejects `!` shell escapes and process-starting commands unless
  `allowShell=true`; it rejects `:qa`/`:quit` in favour of `close`.
- `expr` rejects expressions that can write files or start processes unless
  `allowUnsafe=true`.
- `write` defaults to `:write`; `force=true` is a separate, explicit choice.

### Agent adoption

The extension is designed to be called by an agent, not just by a person. A
tool-call router (for example a pi extension) can expose these methods as a
single `swamp_ide` tool, add a prompt rule that prefers it over `bash`/`edit`,
and record bypassed calls with `swamp.route=bypass`. The extension's spans then
use `swamp.route=vim` and the same `TRACEPARENT`, so a trace shows both routed
and bypassed work.

### Caveats

Placement is local-only for now: a tab in a Herdr space lives on that space's
machine, while every method here runs `vim --remote-expr` on this host. A Vim
tab in a remote space would therefore be a tab no method can reach; the fix is
an `--on` client through `hc exec`, not a bigger placement argument. The
`server` resource already records `machine`, and `machine` is empty while the
server is local.

`+clientserver` is X11-bound on Unix. It works on a Wayland desktop through
XWayland, but not on a headless host with no `DISPLAY`. Vim on macOS is often
built without `+clientserver`; `vim --version` will say. For a fleet/remote
live editor, use Neovim's socket RPC or the herdr-core file methods instead.

`--remote-expr` is serialised with human input: it runs when Vim is not busy.
That is good for pairing (the agent waits for the human) and bad for latency
while the human is typing.

## Upgrade

```sh
swamp extension update
```

Nothing is installed on the host. The bundled `swamp_vim.vim` is re-sourced
when a server does not have the runtime yet.

Upgrading from `2026.11.23.2`: a Vim started before the upgrade still runs in a
background terminal inside the pane that opened it, and keeps working. The next
`open` in a space creates that space's `Edit` tab; `close` ends the old server
and closes a tab this extension placed, so no cleanup step is required.
