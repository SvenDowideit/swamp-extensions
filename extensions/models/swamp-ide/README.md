# @svendowideit/swamp-ide

The single front door for the agent IDE: install, enable and disable the
herdr-core/vim-controller routing, the pi addin and the resizable Herdr
Swamp IDE panel.

## What it does

One extension pulls the pieces together and gives you one pair of commands:

- `@svendowideit/swamp-ide-enable` — installs and selects the resizable
  right-hand Swamp IDE panel/layout with three stacked sections (Activity,
  Command histogram and Leases), installs and gates the pi addin when pi is
  available, and creates or updates the OpenObserve dashboard when OpenObserve
  is installed and healthy.
- `@svendowideit/swamp-ide-disable` — removes the pi session gate and the
  Herdr panel/layout, returning to the base layout. OpenObserve history is left
  alone.

The optional parts are declared optional and the workflows allow them to be
absent, so the base setup still works with only `herdr-core` and
`vim-controller`. The model also exposes `status` so you can inspect what is
installed without changing it.

## Install

```sh
swamp extension pull @svendowideit/swamp-ide
```

This pulls the required `@svendowideit/herdr-core` and
`@svendowideit/vim-controller`. The pi plugin and OpenObserve page are optional;
pull them when you want those parts.

## Configuration

| Global argument | Default | Meaning |
| --- | --- | --- |
| `herdrBin` | `herdr-app` | Herdr desktop binary used for the live layout switch |
| `herdrHome` | `""` | Herdr home; empty uses `HERDR_APP_HOME` or `~/.config/herdr-app` |
| `layout` | `swamp-ide` | Layout installed by this extension |
| `baseLayout` | `swamp` | Layout to return to when the IDE layout is disabled |

The pi plugin and OpenObserve extensions have their own global arguments; the
workflows pass their defaults.

## Examples

Enable the whole system for the current pi session:

```sh
swamp workflow run @svendowideit/swamp-ide-enable
```

It discovers the newest live pi session from the session files/guard pointer,
so `PI_SESSION_ID` does not need to be passed. Use
`--input sessionId=<id>` only to target a different session.

This installs/selects the Herdr Swamp IDE layout, installs the managed pi
addin and writes this session's marker, and creates/updates the OpenObserve
dashboard if the store is reachable. The panel has three independently
resizable sections: Activity, Command histogram and Leases. The histogram
lists programs with counts and expands to the top 10 commands per program.
The Leases section is human-only: click a lease to extend it by 5m/30m/1h or
revoke it with confirmation. Run `/reload` in pi (or restart it) to load the
addin.

Inspect what is installed without changing anything:

```sh
swamp model @svendowideit/swamp-ide method run status ide
```

Disable the session gate and remove the Herdr panel/layout:

```sh
swamp workflow run @svendowideit/swamp-ide-disable
```

The OpenObserve dashboard is deliberately not deleted; it is an observability
record, not runtime state.

Install the panel files without switching the layout:

```sh
swamp model @svendowideit/swamp-ide method run setHerdr ide \
  --input enabled=true
```

Set `herdrHome` as a model global arg if you want to stage the files for
another Herdr profile; leave it empty to use the running app's home.

## Details

Model type: `@svendowideit/swamp-ide`.

| Method | Data written |
| --- | --- |
| `setHerdr` | `herdr` (instance `swamp-ide`) |
| `status` | `herdr` (instance `swamp-ide`) |

Workflows:

- `@svendowideit/swamp-ide-enable` — pi addin `set`, Herdr `setHerdr`, optional
  OpenObserve `dashboard`; the optional steps are allowed to fail.
- `@svendowideit/swamp-ide-disable` — pi addin `set enabled=false`, Herdr
  `setHerdr enabled=false`.

Installed Herdr files: `<herdrHome>/mods/swamp-activity/{main.js,mod.json}`,
`<herdrHome>/mods/swamp-ide/{main.js,mod.json}`,
`<herdrHome>/mods/swamp-ide-approval/{main.js,mod.json}` and
`<herdrHome>/layouts/swamp-ide.json`. The Swamp IDE mod is the right-hand
panel; it reads `events.jsonl`, `shellouts.jsonl`, `addin.json` and
`guard.json`, and shows the Activity, Command histogram and Leases sections
plus the component-health indicator. The histogram lists programs with counts
and expands to the top 10 commands per program. The Leases section lets a
human extend (+5m/+30m/+1h) or revoke a lease with a two-click confirmation;
the agent cannot operate those controls. Each lease shows its recorded purpose
and risk on hover, and its row summarises the target file(s) or command; the
detail area has its own scrollbar when the scope list is long.

The approval mod watches `~/.local/state/swamp-agent-ide/pending-approval.json`
and opens a modal dialog. It starts with a plain-language "You are granting"
summary and an explicit Target: the exact protected file, exact command,
swamp method, or a loud "NO specific file" warning for a broad method grant.
It then shows what is allowed and not allowed, a HIGH/MEDIUM risk
explanation, how to undo, the agent's reason/goal, and the technical action.
Its detail body scrolls; Approve, Deny, Explain and Copy stay in a pinned
footer. Approve writes a named lease feature carrying the purpose, target and
risk and a decision; Deny/Explain write only the decision. Closing with X or
Esc writes a `fallback` decision and removes the pending request. Copy writes
the full request to `last-request.txt` and the clipboard (`wl-copy`/`xclip`
when available). The model runs the Herdr app's documented `do layout.switch`
command; it does not edit Herdr settings or use a shell.

## Upgrade

```sh
swamp extension update
```

Re-run `@svendowideit/swamp-ide-enable` after an upgrade to refresh the managed
files.
