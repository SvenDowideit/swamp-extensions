# @svendowideit/extension-releases

An append-only log of swamp extension releases and channel promotions, polled
from the public swamp-club registry every few hours and diffed against the last
run. It answers "what did we ship, and when?" for the current swamp user and
the collectives they belong to, and feeds the `## Extensions published` section
of the daily diary.

> **Append-only by design.** A version first seen on `beta` and later promoted
> to `stable` adds a second entry naming the source channel — the first entry is
> never rewritten.

## What it does

Every few hours `collect` reads the public swamp-club registry for every
extension owned by the tracked namespaces. It compares each extension's
published `stable` / `rc` / `beta` versions with the snapshot saved by the
previous run, and appends one immutable entry to the `log` resource for each
version it has not seen on that channel before. A version seen first on a lower
channel and later on a higher one is recorded as a `promote` entry with its
source channel; anything else is a `publish`. The registry read is read-only
and unauthenticated; `swamp auth whoami` is consulted only to discover the
default tracking scope. Nothing is published, promoted, or edited, and no
earlier entry is ever dropped or rewritten.

Side effects: it makes read-only HTTP requests to the swamp-club registry,
optionally runs `swamp auth whoami --json`, and writes two swamp resources —
`log` (append-only history) and `state` (the diff baseline).

## Install

```sh
swamp extension pull @svendowideit/extension-releases
```

## Configuration

Global arguments are set at model creation
(`swamp model create @svendowideit/extension-releases extension-releases
--global-arg key=value`) or per run with `--input`.

| Argument | Type | Default | Description |
| -------- | ---- | ------- | ----------- |
| `namespaces` | array | `[]` | Collective/user slugs to track, without a leading `@`. Empty discovers the current swamp user and every collective they belong to via `swamp auth whoami --json` (falling back to `trustedCollectives:` in `.swamp.yaml`). When set, **only** that list is tracked. |
| `host` | string | `"swamp-club.com"` | Swamp-club host, with or without scheme. |
| `requestTimeoutMs` | integer | `20000` | Per-request timeout in milliseconds. |
| `bootstrapHours` | integer | `48` | First-run window: only versions published within this many hours are logged on the very first run, so the back-catalogue seeds the snapshot instead of flooding the log. |
| `maxSearchPages` | integer | `20` | Maximum registry search pages per namespace (100 extensions each). |
| `versionPages` | integer | `2` | Maximum version pages read per changed extension (100 each). |

The `collect` method additionally accepts an optional `bootstrapHours` override.

## Examples

Track the default scope (the current user and all their collectives) and append
anything new. The bundled workflow also does this every four hours under
`swamp serve`:

```sh
# Run the scheduled collector now: poll the default scope and append anything
# new. Under `swamp serve` this same workflow also runs every four hours.
swamp workflow run @svendowideit/extension-releases
```

Run just the model method when you want the timing or arguments under your own
control (the workflow is a one-step wrapper around it):

```sh
swamp model @svendowideit/extension-releases method run collect extension-releases
```

Track an explicit list instead — only these namespaces are read, never anything
else:

```sh
# Pin the tracked namespaces; only this list is ever read.
swamp model create @svendowideit/extension-releases extension-releases \
  --global-arg 'namespaces:json=["svendowideit","figy"]'
```

Read the accumulated log for scripting; entries are append-only and oldest
first, so the tail of `entries` is the most recent activity:

```sh
swamp data query 'modelName == "extension-releases" && name == "log"' --select content
```

Read the diff baseline (last-seen channel versions) to see why a run decided an
extension had changed:

```sh
swamp data query 'modelName == "extension-releases" && name == "state"' --select content
```

## Upgrade

The extension installs nothing on the host — no services, daemons, cron
triggers, or webhooks — so there is no in-place rebuild to run. Upgrade by
updating the extension; its model and bundled workflow apply on the next run,
and the existing `log` and `state` resources are read back unchanged:

```sh
swamp extension update @svendowideit/extension-releases
```

## Details

`@svendowideit/extension-releases` ships one model type and one workflow.

| Member | Kind | Purpose |
| ------ | ---- | ------- |
| `@svendowideit/extension-releases` | model | `collect` is the only method. |
| `collect` | method | Poll the registry for each tracked namespace, diff against `state`, and append new `version|channel` pairs to `log`. Arg: optional `bootstrapHours`. |
| `@svendowideit/extension-releases` | workflow | Runs `collect`; scheduled `0 */4 * * *`. |

### Resources

| Resource | Contains |
| -------- | -------- |
| `log` | `entries[]` (append-only), `count`, `updatedAt`, `namespaces`. Each entry: `extension`, `namespace`, `version`, `channel`, `event` (`publish`/`promote`), `fromChannel`, `publishedAt`, `observedAt`, `author`, `url`. |
| `state` | `channels` (per extension: last-seen `stable`/`rc`/`beta` versions + `updatedAt` + `author`), `pairs` (per extension: known `version|channel` keys), `namespaces`, `updatedAt`. |

### How a run decides what is new

1. **Scope** — `namespaces` if configured; otherwise the current user and their
   collectives from `swamp auth whoami --json`, falling back to
   `trustedCollectives:` in `.swamp.yaml`.
2. **Discover** — page `/api/v1/extensions/search?collective=<slug>&sort=updated`
   (100 per page) for each namespace.
3. **Change test** — an extension is re-read only when its channel triple or its
   registry `updatedAt` differs from `state`, so unchanged extensions cost no
   version requests.
4. **Diff** — page `/api/v1/extensions/{name}/versions` and emit an entry for
   every `version|channel` pair not already in `state.pairs`. A pair whose
   version was already seen on a lower-ranked channel is a `promote`; the rest
   are `publish`.
5. **Append** — existing `log.entries` are concatenated with the new entries and
   written back; `state` is updated with the current pairs.

Channels rank `stable` > `rc` > `beta`. Entries are bucketed in the diary by
`observedAt` (when the poll saw them), not `publishedAt`, so a promotion of an
older version appears on the day it happened.

### Extending this extension

| File | Responsibility |
| ---- | -------------- |
| `extension_releases.ts` | The whole model: pure helpers (`normalizeRow`, `planEntries`, `collectPairs`, `parseTrustedCollectives`, …) plus the I/O (`searchNamespace`, `fetchVersions`, `resolveNamespaces`) and the `collect` execute. |
| `extension-releases.yaml` | The scheduled workflow. |
| `extension_releases_test.ts` | Unit tests for the pure helpers. |
| `acceptance/test-factory.yaml` | Black-box acceptance tests. |

To add an axis (for example, release notes text), extend the `ReleaseEntry`
schema and the pure `planEntries`, then surface it in the log consumer.

### Developing and testing

```sh
# Type-check everything.
~/.swamp/deno/deno check *.ts

# Unit tests (pure diff/normalise helpers).
~/.swamp/deno/deno test --allow-read --allow-write --allow-env --allow-run extension_releases_test.ts

# Format and lint to the swamp extension style.
swamp extension fmt manifest.yaml --check
```

The acceptance tests live in `acceptance/test-factory.yaml` and prove the
user-facing outcome end to end (a first `collect` writes a log whose entries
carry a registry URL, and a second run is idempotent).

## License

MIT — see LICENSE.txt.
