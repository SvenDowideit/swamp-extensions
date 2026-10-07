# @svendowideit/container-service

Build, run, push — and **keep alive** — containers from swamp, on Docker,
Podman, or Apple Containers.

## What it does

A vendored fork of [`@swamp/container-image`](https://github.com/swamp-club/swamp-extensions)
(see [Provenance](#provenance)). Upstream's `run` method is `docker run --rm`
in the **foreground**, so it is right for one-shot jobs and wrong for a
database or an API server that must stay up. This fork keeps the entire
build/run/push surface unchanged and adds the missing lifecycle:

- **`service`** — desired-state detached lifecycle: `ensure` (create + start,
  a no-op when the running container already matches the desired state),
  `stop`, `restart`, `remove`.
- **`serviceStatus`** — existence, running state, health, image, published
  ports, and (for the systemd backend) unit state.
- **`exec`** — run a one-off argv inside a service container and capture its
  output (e.g. `pg_isready`, or a `psql` seed script). Never a shell string.
- **`network`** — idempotently create (or remove) a container network so
  services can join it by name; `ensure` is a no-op when it already exists.

Two ways to keep a service alive, selected by the `serviceBackend` global:

- **`direct`** — the runtime restart policy (`--restart`), for Docker and
  Podman.
- **`systemd`** — systemd owns the unit:
  - **Podman** → a [Quadlet](https://docs.podman.io/en/latest/markdown/podman-systemd.unit.5.html)
    `.container` file in `~/.config/containers/systemd/`; Quadlet generates
    `<name>.service`.
  - **Docker** → a systemd **user unit** that runs `docker start -a <name>`
    (`docker` has no native unit generator in this range). Gives boot ordering,
    logging, and a stable unit name.

Idempotency uses a desired-state hash written as a `swamp.desired` container
label. **Secret env values are never hashed or persisted** — only env *names*
go into the hash, so no secret reaches a container label or a resource.

## Install

```sh
swamp extension pull @svendowideit/container-service
```

## Configuration

Global arguments (set at model creation with `--global-arg key=value`):

| Argument | Type | Default | Meaning |
| --- | --- | --- | --- |
| `name` | string | — | Model instance name (set by `swamp model create`). |
| `binary` | `docker` \| `podman` \| `container` | `docker` | Container runtime binary. |
| `serviceBackend` | `direct` \| `systemd` | `direct` | How `service` keeps a container running. |
| `systemdUnitDir` | string | `~/.config/systemd/user` | Unit directory for docker units. |
| `quadletDir` | string | `~/.config/containers/systemd` | Directory for podman Quadlets. |

`service` method arguments:

| Argument | Type | Default | Meaning |
| --- | --- | --- | --- |
| `action` | `ensure` \| `stop` \| `restart` \| `remove` | `ensure` | Lifecycle action. |
| `containerName` | string | — | Container name (also the unit/Quadlet name). |
| `image` | string | — | Image (required for `ensure`/`restart`). |
| `command` | string[] | — | Command/args inside the container. |
| `env` | object | — | Environment variables (`-e KEY=VALUE`). |
| `volumes` | string[] | — | Volume mounts. |
| `ports` | string[] | — | Port mappings. |
| `network` | string | — | Network to connect to. |
| `entrypoint` | string | — | Override the entrypoint. |
| `restart` | string | `unless-stopped` | Restart policy (direct backend). |
| `pull` | boolean | `true` | Pull the image before creating (direct). |
| `healthCommand` | string[] | — | In-container command polled until it exits 0. |
| `healthTimeoutMs` | integer | `60000` | Health wait budget. |
| `privileged` | boolean | — | `--privileged`. |
| `extraArgs` | string[] | — | Extra runtime flags before the image. |

`serviceStatus` takes only `containerName`. `network` takes `networkName`,
optional `action` (`ensure`|`remove`), and `driver`.

Methods: `validate`, `build`, `run`, `service`, `serviceStatus`, `exec`,
`network`, `login`, `push`, `multi-platform-build`.

## Examples

Run a long-lived Postgres with a health gate, kept alive by the runtime:

```sh
swamp model @svendowideit/container-service method run service postgres \
  --input containerName=postgres \
  --input image=postgres:18-alpine \
  --input 'ports:json=["127.0.0.1:5432:5432"]' \
  --input 'volumes:json=["pgdata:/var/lib/postgresql/data"]' \
  --input 'env:json={"POSTGRES_PASSWORD":"example"}' \
  --input 'healthCommand:json=["pg_isready"]'
```

The same service owned by systemd (Podman Quadlet). Create the model once with
`serviceBackend=systemd`, then `ensure`:

```sh
swamp model create @svendowideit/container-service postgres-svc \
  --global-arg binary=podman --global-arg serviceBackend=systemd
swamp model method run postgres-svc service \
  --input containerName=postgres \
  --input image=postgres:18-alpine \
  --input 'volumes:json=["pgdata:/var/lib/postgresql/data"]' \
  --input 'env:json={"POSTGRES_PASSWORD":"example"}'
```

Check it is healthy, and see which ports it publishes:

```sh
swamp model method run postgres-svc serviceStatus --input containerName=postgres
swamp data get postgres-svc service-status-postgres --json \
  | jq '.content | {running, health, ports, unitActive}'
```

Tear it down when you are done — `action=remove` stops the container (and the
unit, when the systemd backend is used) and deletes it:

```sh
swamp model method run postgres-svc service \
  --input containerName=postgres --input action=remove
```

Run a one-off command inside the running service (argv, not a shell string) —
useful for a readiness probe or seeding:

```sh
swamp model method run postgres-svc exec \
  --input containerName=postgres \
  --input 'command:json=["pg_isready","-U","postgres"]'
```

Ensure the network that the service — and any peer service — joins by name:

```sh
swamp model method run postgres-svc network --input networkName=swamp-net
```

## Details

- **Model type:** `@svendowideit/container-service` (`container_service.ts`).
- **Methods:** `validate`, `build`, `run`, `service`, `serviceStatus`, `exec`,
  `network`, `login`, `push`, `multi-platform-build`.
- **Resources:** `serviceResult` (`service-<containerName>`),
  `serviceStatusResult` (`service-status-<containerName>`),
  `execResult` (`exec-<containerName>`), `networkResult`
  (`network-<networkName>`), plus the upstream `validateResult`,
  `buildResult`, `runResult`, `loginResult`, `multiPlatformBuildResult`,
  `pushResult`.
- **`_lib/service.ts`** holds the pure argv/render helpers
  (`buildServiceCreateArgv`, `desiredServiceHash`, `renderDockerUnit`,
  `renderQuadlet`, `expandHome`, `assertSafeName`) and the two operation
  functions `runService`, `runServiceStatus`. Every process spawn goes through
  the runner's injectable executor seam, so the whole lifecycle is tested with
  a fake runtime.
- **systemd backend:** Podman writes a Quadlet `.container` and starts
  `<name>.service` after `daemon-reload`; Docker creates the container up front
  (so the unit can `docker start -a` it) and writes a user unit. Apple
  Containers is rejected for this backend.
- **Security:** no `sh -c`; user strings are guarded against newline/NUL at
  schema time; `login`'s password is piped via `--password-stdin`.

### Provenance

This extension is a fork of `@swamp/container-image` (AGPL-3.0, © Elder Swamp
Club, Inc.), vendored so the detached `service` lifecycle and systemd backend
could be added without waiting on upstream. The upstream build/run/push
schemas, runner, operations, and checks are preserved; only the model identity,
the global arguments, `_lib/service.ts`, and new methods are additions. The
LICENSE.txt is the upstream AGPL-3.0 license.

### Development

```sh
~/.swamp/deno/deno check extensions/models/container-service/container_service.ts
~/.swamp/deno/deno test  --allow-all extensions/models/container-service/tests/container_service_test.ts
swamp extension fmt extensions/models/container-service/manifest.yaml --check
```
