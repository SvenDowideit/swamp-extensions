# @figy/swamp-worker

Site-specific fi.gy half of the swamp worker setup: enlist this host as a swamp
worker for an fi.gy `swamp serve`, driving the generic
`@svendowideit/swamp-worker` model through one workflow.

## What it does

The portable model (`@svendowideit/swamp-worker`) knows how to render and
reconcile a worker unit, mint its token and report its state — but it knows no
serve URL and no identity of its own. This extension supplies the fi.gy ones and
composes them into one ordered workflow, `@figy/swamp-worker-bootstrap`:

| Step | Method | What it does |
| ---- | ------ | ------------ |
| `mint` | `mintToken` | Mint a long-duration enrollment token and write it to the `0600` token file. |
| `service` | `ensureService` | Render the unit, write it only if changed, `daemon-reload`, enable with linger, start (restart only on change). |
| `status` | `status` | Report the live unit and whether this identity's workers are enrolled. |

Re-running the workflow **reconciles** — nothing is re-installed, and only what
drifted is rewritten and restarted. Because every artifact is namespaced by
`identity` (`swamp-worker-<identity>.service`, cache dir, token/env files), this
worker coexists with workers other repos install on the same host and never
touches them.

## Install

```sh
swamp extension pull @figy/swamp-worker
```

Requires `@svendowideit/swamp-worker` (pulled separately) and a running fi.gy
`swamp serve` the worker can reach.

## Configuration

Workflow inputs (on `@figy/swamp-worker-bootstrap`):

| Input | Type | Default | Description |
| ----- | ---- | ------- | ----------- |
| `serveUrl` | string | — | The serve URL the worker dials (`wss://` for a TLS front). **Required.** |
| `identity` | string | `figy` | Worker identity slug; namespaces the unit and artifacts. |
| `duration` | string | `30d` | Enrollment token lifetime (a hard deadline). |

The generic model's own globals (binary path, dirs, concurrency, linger) are set
on the `worker` model instance as usual.

## Examples

Create the generic worker model once — `identity` namespaces the worker so it is
unique per repo. Then run the site workflow to mint, reconcile and report:

```sh
swamp model create @svendowideit/swamp-worker worker \
  --global-arg identity=figy
swamp workflow run @figy/swamp-worker-bootstrap \
  --input serveUrl=wss://swamp.x1yoga.fi.gy
```

Point a host at a different serve instance (for example the rc serve) by giving
it a different identity, so the two workers coexist on the host:

```sh
swamp model create @svendowideit/swamp-worker worker-rc \
  --global-arg identity=rc
swamp workflow run @figy/swamp-worker-bootstrap \
  --input serveUrl=wss://rc.swamp.x1yoga.fi.gy --input identity=rc
```

Inspect the live unit and enrollment after a run, and use a short token lifetime
when testing the rotation path:

```sh
swamp workflow run @figy/swamp-worker-bootstrap \
  --input serveUrl=wss://swamp.x1yoga.fi.gy --input duration=1h
swamp model method run worker status
```

## Details

`@figy/swamp-worker` ships one workflow (`@figy/swamp-worker-bootstrap`); it ships
no models or reports of its own — all behaviour lives in
`@svendowideit/swamp-worker`. It installs nothing itself.

The workflow hardcodes the generic model instance name `worker`, so create that
instance (with your chosen `identity`) before running it. The `identity` passed to
the workflow is applied to each step's `globalArgs`, keeping the unit name, cache
dir and token/env files consistent with the model instance.

Fan-out to a *set* of remote hosts over SSH (`@swamp/ssh`) — the multi-node
`dev`/`rc`/`stable` deployment — is the next phase; this Phase 0 slice deploys the
worker on the host the workflow runs on.

## License

MIT — see LICENSE.txt.
