# @svendowideit/swamp-ide-openobserve

The optional OpenObserve page for `@svendowideit/swamp-ide`: one dashboard that
separates routed herdr-core/vim work from bypassed built-in tool calls.

## What it does

It creates or updates the **Swamp Agent IDE** dashboard in an existing
OpenObserve instance. Panels:

- routed vs bypassed counts, with ok/error splits;
- operations by route;
- recent bypassed tool calls;
- recent routed herdr-core/vim calls;
- recent IDE errors;
- the shell-out histogram, grouped by per-program/subcommand bash span name.

The dashboard groups on real OpenObserve trace columns (`service_name`,
`operation_name`, `swamp_outcome`), because OpenObserve does not expose
arbitrary span attributes as columns. The pi plugin encodes the route in the span name:
`swamp_ide.herdr-core.*`, `swamp_ide.vim.*`, `swamp_ide.swamp.*`,
`bypass.bash.<program>[.<subcommand>]` and `tool.bash.<program>`.
The shell-out panel selects the `bypass.bash.%` and `tool.bash.%` span names
and groups by `operation_name`, which is a real OpenObserve column.

`swamp-ide` installs this extension only when OpenObserve is already installed
and healthy; it is not required for the routing or the Herdr activity panel.

## Install

```sh
swamp extension pull @svendowideit/swamp-ide-openobserve
```

A running OpenObserve instance and a vault holding its login are required. The
defaults match `@svendowideit/otel-backend`: `http://127.0.0.1:5080` and the
`otel-openobserve-admin` vault.

## Configuration

| Global argument | Default | Meaning |
| --- | --- | --- |
| `baseUrl` | `http://127.0.0.1:5080` | OpenObserve base URL (no trailing slash) |
| `organization` | `default` | Organization that owns the dashboard |
| `vaultName` | `otel-openobserve-admin` | Vault holding the login |
| `emailKey` | `ZO_ROOT_USER_EMAIL` | Vault key for the login email |
| `authRef` | `ZO_ROOT_USER_PASSWORD` | Vault key for the login password |
| `authHeaderKey` | `""` | Ready-made `Authorization` header key; wins when set |
| `timeoutMs` | `30000` | Per-request timeout |

`dashboard` arguments: `title` (default `Swamp Agent IDE`), `stream` (default
`default`), `folder` (default `default`), `update` (default `true`) and
`uiBaseUrl` (the returned link base; empty uses `baseUrl`). `status` takes
`title` and `folder`.

## Examples

Create or update the dashboard against the local OpenObserve:

```sh
swamp model @svendowideit/swamp-ide-openobserve method run dashboard ide-openobserve \
  --input uiBaseUrl=https://obs.otel.fi.gy
```

Open the returned `url`; the panels update from the `default` trace stream. Use
`uiBaseUrl` when the API is reached over a local address but the UI is public.

Check whether it exists without changing it:

```sh
swamp model @svendowideit/swamp-ide-openobserve method run status ide-openobserve
```

This is what `swamp-ide` calls during setup when OpenObserve is already healthy.

Keep a second page for staging:

```sh
swamp model @svendowideit/swamp-ide-openobserve method run dashboard ide-openobserve \
  --input title="Swamp Agent IDE — staging" --input folder=staging
```

## Details

Model type: `@svendowideit/swamp-ide-openobserve`.

| Method | Data written |
| --- | --- |
| `dashboard` | `dashboard` (instance `swamp-agent-ide`) |
| `status` | `status` (instance `swamp-agent-ide`) |

The extension only calls the OpenObserve HTTP API. It writes no files on the
host. Credentials are read from the vault; they never appear in a resource.
The dashboard is matched by title, so repeated `dashboard` calls update rather
than duplicate it.

## Upgrade

```sh
swamp extension update
```
