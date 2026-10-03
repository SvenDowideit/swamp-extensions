# @svendowideit/otel-backend

Stand up a self-hosted observability backend — logs, metrics, and traces — as a
long-lived service, from a small set of **profiles**.

## What it does

A backend is where a collector gateway exports telemetry. This extension models
the backend as a swappable **profile** rather than a hardcoded stack: the
contract (image, ports, data mount, env var names, OTLP path shape, health path)
is a plain data structure, so adding a VictoriaMetrics, LGTM, or ClickHouse lane
is a new profile rather than a rewrite. The gateway owns routing, so the lane can
change without touching a single host.

The profile shipped and tested first is **OpenObserve** — one Rust binary with
Parquet storage and SQL across all signals. It runs as a Docker container from
the published image (`public.ecr.aws/zinclabs/openobserve`). The published static
binaries are *not* used because `downloads.openobserve.ai` rejects non-browser
clients with HTTP 403; the container image is the supported path and is
immutable-pinned by digest by the registry.

- **Install** pulls the image, creates the container with a persistent host data
  directory, and waits until `/healthz` answers.
- **Credentials** (`ZO_ROOT_USER_EMAIL`, `ZO_ROOT_USER_PASSWORD`) are read from a
  swamp vault and passed as container env — never inlined in a model definition.
- **Idempotent:** an identical running container is left alone; `configure`
  reapplies the desired state; `upgrade` moves the image.

## Install

```sh
swamp extension pull @svendowideit/otel-backend
```

Requires Docker, and a swamp vault (e.g. `@svendowideit/systemd-creds`) holding
the admin login. The OpenObserve container seeds its **first admin user** at
first start, so both `ZO_ROOT_USER_EMAIL` and `ZO_ROOT_USER_PASSWORD` must exist
before you run `install`:

```sh
swamp vault create @svendowideit/systemd-creds otel-openobserve-admin
swamp vault put otel-openobserve-admin ZO_ROOT_USER_EMAIL
swamp vault put otel-openobserve-admin ZO_ROOT_USER_PASSWORD
```

The email is **lowercased automatically** (OpenObserve rejects uppercase
addresses — the model warns and lowercases rather than let the container
crash-loop), and the password is checked against the store's policy first: 8-128
characters with at least one lowercase, one uppercase, one digit, and one special
character.

## Configuration

Global arguments set at creation:

| Argument | Type | Default | Meaning |
| --- | --- | --- | --- |
| `profile` | string | `openobserve` | Backend profile to run. |
| `image` | string | `""` | Image (empty = the profile's default). |
| `port` | integer | `5080` | Host port for the UI / OTLP/HTTP. |
| `grpcPort` | integer | `5081` | Host port for OTLP/gRPC. |
| `bindAddress` | string | `127.0.0.1` | Host address to bind published ports to. |
| `dataDir` | string | `~/.local/share/otel-backend` | Host directory persisted as the data volume. |
| `vaultName` | string | `""` | Vault holding the admin credentials. |
| `rootUserEmail` | string | `""` | Admin email to seed (empty = read from the vault). |
| `organization` | string | `default` | Organization served and scoped in the OTLP path. |
| `containerName` | string | `""` | Container name (empty = derived from the model). |
| `restartPolicy` | string | `unless-stopped` | Docker restart policy. |
| `healthTimeoutMs` | integer | `60000` | How long to wait for health after start. |
| `extraEnv` | object | `{}` | Extra container env vars. |

Methods: `install`, `configure`, `status`, `upgrade`, `remove`, `profile`.

## Examples

Create the backend, reading its admin login from a vault (store
`ZO_ROOT_USER_EMAIL` / `ZO_ROOT_USER_PASSWORD` in `otel-openobserve-admin`
first), and run it. Do this once per core node; the login is never written into
the model definition:

```sh
swamp model create @svendowideit/otel-backend otel-backend \
  --global-arg profile=openobserve \
  --global-arg vaultName=otel-openobserve-admin
swamp model method run otel-backend install
```

Check that it is healthy and see the endpoint a gateway should export to — run
this after a restart, or when a gateway reports export failures:

```sh
swamp model method run otel-backend status
swamp data get otel-backend status --json | jq '.content | {healthy, endpoints}'
```

Move to a newer image without losing data (the data directory is a host volume,
so it survives the container swap):

```sh
swamp model method run otel-backend upgrade
```

Tear it down when you are done with a throwaway instance — `removeData` is
destructive and will warn if the container's data is root-owned:

```sh
swamp model method run otel-backend remove --input removeData=true
```

## Details

- **Model type:** `@svendowideit/otel-backend` (a single model, `otel_backend.ts`).
- **Methods:** `install`, `configure`, `status`, `upgrade`, `remove`, `profile`.
- **Resources:** `install` (instance `install`), `status` (`status`), `profile`
  (`profile`), `remove` (`remove`).
- **Profiles:** `PROFILES` is keyed by profile name; `resolveProfile` throws a
  helpful error for an unknown one. `OPENOBSERVE_PROFILE` documents the contract
  (image, `containerPorts`, `dataMount=/data`, `ZO_DATA_DIR`, health `/healthz`,
  OTLP base `/api/<org>`).
- **Idempotency:** `desiredHashFor` hashes image, ports, bind, data dir, restart
  policy, and **env var names** (never secret values); the hash is written as the
  `swamp.desired` container label, and `install` skips an identical running
  container.
- **Health:** `waitForHealth` polls the profile's health path; a refused
  connection or timeout is a health result, not an exception, so `install`
  reports `healthy: false` with a `docker logs` hint rather than throwing.
- **Platforms:** any with Docker.
- **Publishing:** generic — no site-specific values — so it lives in
  `@svendowideit`.

### Development

```sh
~/.swamp/deno/deno check extensions/models/otel-backend/otel_backend.ts
~/.swamp/deno/deno test  extensions/models/otel-backend/otel_backend_test.ts
swamp extension fmt extensions/models/otel-backend/manifest.yaml --check
swamp extension quality extensions/models/otel-backend/manifest.yaml --json
```
