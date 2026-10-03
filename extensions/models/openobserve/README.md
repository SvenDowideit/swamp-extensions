# @svendowideit/openobserve

Query and operate a self-hosted [OpenObserve](https://openobserve.ai) instance
from swamp over its REST/SQL API.

## What it does

OpenObserve is one engine for logs, metrics, and traces with a SQL query surface.
That is what makes the fleet's hard questions tractable: correlating what the
inventory thinks exists with what is actually reporting is a join, and SQL does
joins. This model gives swamp a typed way to run those queries and to inspect the
store's streams and retention.

It is deliberately small and read-mostly:

- `query` runs arbitrary SQL over a chosen signal (logs/metrics/traces) and stores
  the rows.
- `streams` lists streams and their document counts.
- `retention` reports each stream's configured retention.
- `health` probes the instance, treating a refused connection as a *health*
  result rather than a model error.

Login credentials are read from a swamp vault and sent as a Basic auth header
(never inlined in a model definition). The search API is read-only, and the
`read-only-sql` check refuses mutations before they are sent.

## Install

```sh
swamp extension pull @svendowideit/openobserve
```

You also need a running OpenObserve instance — install one with
[`@svendowideit/otel-backend`](../otel-backend) — and a swamp vault holding the
login (e.g. `ZO_ROOT_USER_EMAIL` / `ZO_ROOT_USER_PASSWORD`, as the backend seeds).

## Configuration

Global arguments set at creation:

| Argument | Type | Default | Meaning |
| --- | --- | --- | --- |
| `baseUrl` | string | `http://127.0.0.1:5080` | OpenObserve base URL (no trailing slash). |
| `organization` | string | `default` | Organization to query and operate on. |
| `vaultName` | string | `""` | Vault holding the credentials. |
| `emailKey` | string | `ZO_ROOT_USER_EMAIL` | Vault key for the login email. |
| `authRef` | string | `ZO_ROOT_USER_PASSWORD` | Vault key for the login password. |
| `authHeaderKey` | string | `""` | Vault key for a ready-made `Authorization` header; wins over email/password. |
| `timeoutMs` | integer | `30000` | Per-request timeout. |
| `defaultSize` | integer | `100` | Rows a query returns when no `size` is given. |

`query` arguments: `sql` (required), `type` (`logs`|`metrics`|`traces`, default
`logs`), optional `startTime`/`endTime` (**microseconds** since epoch, default the
last hour), optional `size`. `streams` takes an optional `type`; `retention` an
optional `stream`; `health` takes none.

## Examples

Check the instance is reachable and healthy — run this first, and after any
backend restart, to tell a down store from a broken query:

```sh
swamp model method run obs health
swamp data get obs health --json | jq '.content | {reachable, healthy, version}'
```

Run SQL and keep the rows — this is the state-awareness join in miniature
(which service names are reporting, and how many records each has):

```sh
swamp model method run obs query \
  --input 'sql=select service_name, count(*) c from "default" group by service_name order by c desc limit 20'
swamp data get obs last --json | jq '.content.rows'
```

Inspect streams and retention — use this to confirm a new agent's stream exists
and to check retention matches the contract:

```sh
swamp model method run obs streams --input type=logs
swamp model method run obs retention
swamp data get obs streams --json | jq '.content.streams[] | {name, docNum}'
```

## Details

- **Model type:** `@svendowideit/openobserve` (a single model, `openobserve.ts`).
- **Methods:** `query`, `streams`, `retention`, `health`.
- **Resources:** `query` (instance `last`), `streams` (instance `streams`),
  `retention` (instance `retention`), `health` (instance `health`). Distinct
  instance names keep each method's latest result separate.
- **Endpoints:** `POST /api/<org>/_search?type=<signal>` with a
  `{query:{sql,start_time,end_time},size}` body; `GET /api/<org>/streams[?type=]`;
  `GET /healthz`; `GET /config` (for the build version).
- **Times are microseconds.** This is the usual cause of a "successful" query
  that returns zero rows; `resolveWindow` defaults to the last hour in the right
  unit.
- **Auth:** `authHeaderKey` (a fully-formed header) if set, else
  `Basic base64(email:password)` from the vault. A 0 status means the instance
  did not answer — reported, not thrown.
- **Read-only:** the `read-only-sql` check rejects
  `INSERT/UPDATE/DELETE/DROP/ALTER/CREATE/TRUNCATE/REPLACE/MERGE` against the
  `query` method.
- **Platforms:** any (pure HTTP).
- **Publishing:** generic — no site-specific values — so it lives in
  `@svendowideit`.

### Development

```sh
~/.swamp/deno/deno check extensions/models/openobserve/openobserve.ts
~/.swamp/deno/deno test  extensions/models/openobserve/openobserve_test.ts
swamp extension fmt extensions/models/openobserve/manifest.yaml --check
swamp extension quality extensions/models/openobserve/manifest.yaml --json
```
