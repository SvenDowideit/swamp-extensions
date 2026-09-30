# @svendowideit/test-factory

Run a swamp extension inside containers, on different Linux distributions and
swamp deployment topologies, and report exactly where it breaks.

> An extension can document perfectly and still fail to install, register, define
> or run on a given host. This extension boots it on that host and tells you.

## What it does

`@svendowideit/test-factory` takes a candidate extension `manifest.yaml`, works
out what it declares (the model types and workflow names are read straight from
the manifest), and tests it in a fresh container of the requested distro. It
walks the layers in order and reports each separately:

| Phase | What is asserted |
| ----- | ---------------- |
| `smoke` | swamp installs and `swamp doctor extensions` reports `pass`. |
| `load` | every declared model type registers (`swamp model type search`). |
| `definitions` | `swamp model create` succeeds for each type, and every declared workflow validates. |
| `fixtures` | caller-supplied method runs execute (and optionally match expected output). |

Beyond a single node it can stand up a real deployment:

- **`standalone`** — one container, no server.
- **`serve`** — a container running `swamp serve` as an orchestrator, with the
  extension's workflows validated against it.
- **`fleet`** — a `swamp serve` orchestrator plus one or more worker containers
  that enroll with worker tokens and execute a dispatched probe workflow step.
  Workers share the orchestrator's network namespace and dial the loopback-only
  serve socket, so no TLS or swamp-club account is needed.

The distro catalog covers the three package families — apk, deb and rpm — with
and without systemd:

| Distro | Family | systemd | Notes |
| ------ | ------ | ------- | ----- |
| `alpine` | apk | no | musl-only: swamp's glibc binary cannot run. Expected to fail — proves the harness diagnoses it. |
| `wolfi` | apk | no | apk-based but glibc: swamp runs without systemd. |
| `debian` | deb | yes | glibc baseline. |
| `ubuntu` | deb | yes | the common production host. |
| `fedora` | rpm | yes | rpm family, systemd as PID 1. |
| `rocky` | rpm | yes | RHEL-compatible rpm. |

On a systemd host the container boots `systemd` as PID 1 and the harness runs
under it; the result includes `systemctl is-system-running`, so a "systemd"
scenario proves systemd is actually live rather than a plain container in
disguise.

Container images carry only prerequisites (curl/git/jq, plus systemd when asked)
— swamp is downloaded **in-container** at the version under test — so images
cache across runs and swamp versions, and the thing you install is the thing you
tested.

A scenario is a known-good/known-bad expectation: `expected: fail` scenarios
(such as Alpine) pass when the run indeed fails, so the harness is validated too.

## Install

```sh
swamp extension pull @svendowideit/test-factory
```

No dependencies beyond a local container runtime. Docker is the default; set the
`dockerBinary` global to `podman` to use podman. The only network access is the
swamp release download; `serve`/`fleet` run `swamp serve` with `--auth-mode none`
on loopback, so no swamp-club account is required.

## Configuration

Global arguments are set at model creation (`swamp model create
@svendowideit/test-factory my-tf --global-arg key=value`) or via
`swamp model edit my-tf`:

| Argument | Type | Default | Description |
| -------- | ---- | ------- | ----------- |
| `dockerBinary` | string | `"docker"` | Container CLI to drive. |
| `swampVersion` | string | `""` | Pin the swamp release tag under test; empty uses the latest release. |
| `releaseBaseUrl` | string | GitHub releases | Base URL for swamp release downloads. |
| `defaultPhases` | string | `"smoke,load,definitions"` | Phases run when a run does not override them. |
| `workers` | integer | `2` | Default worker count for `fleet` scenarios. |
| `keepOnFailure` | boolean | `false` | Leave containers running when a scenario fails, for inspection. |
| `probe` | boolean | `true` | In `serve`/`fleet`, run the dispatch probe workflow. |

Per-run overrides on `test`: `manifest` (required), `scenario`, `distro`,
`topology`, `systemd`, `workers`, `phases`, `fixturesFile`, `scenarioFile`,
`expected`. `testAll` adds `root` and `gitOnly`. `cleanup` takes `prefix`;
`listScenarios` takes `distro`.

## Examples

List the catalog before you choose something to run:

```sh
swamp model @svendowideit/test-factory method run listScenarios tf
```

Test one extension on one distro — the fast, dependency-free smoke + load +
definitions path, and the first thing to run after changing an extension:

```sh
swamp model @svendowideit/test-factory method run test tf \
  --input manifest=extensions/models/systemd-service/manifest.yaml \
  --input scenario=ubuntu-systemd-standalone
```

Fan out across distros to see which ones a change broke:

```sh
swamp model @svendowideit/test-factory method run test tf \
  --input manifest=extensions/models/caddy/manifest.yaml \
  --input distro=ubuntu,fedora,rocky --input systemd=true
```

Exercise remote execution — a serve orchestrator plus two enrolled workers that
run the dispatched probe step:

```sh
swamp model @svendowideit/test-factory method run test tf \
  --input manifest=extensions/models/github-release-install/manifest.yaml \
  --input topology=fleet --input workers=2
```

Run a fixture-backed method and require a marker in its output, so the fixture
proves behaviour rather than just exit code:

```sh
cat > fixtures.yaml <<'YAML'
- type: "@svendowideit/github-release-install"
  method: check
  instance: tf-fixture
  input.repo: caddyserver/caddy
  expectContains: caddy_2
YAML

swamp model @svendowideit/test-factory method run test tf \
  --input manifest=extensions/models/github-release-install/manifest.yaml \
  --input scenario=debian-standalone \
  --input phases=fixtures --input fixturesFile=fixtures.yaml
```

Gate a CI run on the result with the workflow, which fails when any scenario does
not behave as expected:

```sh
swamp workflow run @svendowideit/test-factory \
  --input manifest=extensions/test-factory/manifest.yaml \
  --input scenario=debian-standalone
```

Sweep every git-tracked extension in the repo (one lock acquisition, one result
per extension/scenario, never gating):

```sh
swamp workflow run @svendowideit/test-factory-sweep \
  --input root=extensions/models --input distro=ubuntu --input systemd=false
```

Read the per-scenario breakdown from the last run:

```sh
swamp report get @svendowideit/test-factory-report --model tf --markdown
```

## Details

`@svendowideit/test-factory` ships one model type
(`@svendowideit/test-factory`), one report
(`@svendowideit/test-factory-report`), and two workflows
(`@svendowideit/test-factory`, `@svendowideit/test-factory-sweep`).

| Method | Arguments | Produces |
| ------ | --------- | -------- |
| `listScenarios` | `distro` (optional) | no data; logs the distro catalog and resolved scenarios |
| `test` | `manifest` (required), `scenario`, `distro`, `topology`, `systemd`, `workers`, `phases`, `fixturesFile`, `scenarioFile`, `expected` | one `result` resource per scenario plus a `summary` rollup |
| `testAll` | `test`'s arguments plus `root`, `gitOnly` | one `result` per scenario per discovered extension, plus a `summary` per extension |
| `cleanup` | `prefix` (default `tf-`) | removes leftover `tf-` containers, networks and volumes |

Resources:

- `result` — one scenario's outcome: distro, topology, expected verdict, per-phase
  results, definition/workflow/fixture detail, the `topologyResult` (serve ready,
  workers enrolled, dispatch ok), errors, the tail-capped `logs`
  (`logsTruncated` marks when the cap bit), and the resolved swamp version.
- `summary` — the rollup from a `test`/`testAll` fan-out: counts and one row per
  scenario.

Reports and workflows:

- `@svendowideit/test-factory-report` — renders a scenario result card (phase
  table, definitions, workflows, fixtures, errors, logs), or the fan-out summary
  table. Scope: method.
- `@svendowideit/test-factory` workflow — runs `test` then asserts
  `failCount == 0 && errorCount == 0`; use it as a CI gate.
- `@svendowideit/test-factory-sweep` workflow — runs `testAll` over git-tracked
  manifests and never gates.

### How it is built

The code splits so a new distro, phase or topology can be added without touching
orchestration:

| File | Responsibility |
| ---- | -------------- |
| `scenarios.ts` | The distro catalog, the scenario catalog, filter resolution, and scenario-file parsing. Pure. |
| `harness.ts` | Builds the in-container `sh` script from a typed plan, and parses/evaluates its JSON result. Pure. |
| `topology.ts` | Builds the `swamp serve` / token / worker / probe scripts for the `serve` and `fleet` topologies. Pure. |
| `introspect.ts` | Reads a manifest's declared model types and workflow names, and parses the manifest itself (tiny YAML subset). |
| `docker.ts` | The Docker backend: image builds, networks, volumes, container lifecycle, `exec`, `exec -d`, log/result reads. Every call goes through an injectable runner. |
| `test_factory.ts` | Orchestration only: catalog → per-scenario container work → typed `result`/`summary` resources. |
| `test_factory_report.ts` | Markdown/JSON rendering of a result or the rollup. |

Design decisions worth knowing:

- **The harness always finishes.** It writes `result.json` incrementally and a
  `done` sentinel last; the result is written into a host bind mount so it
  survives the container exiting and never needs an `exec` against a stopped
  container.
- **Containers are long-lived; roles run via `exec`.** A systemd host boots
  systemd as PID 1 and the harness runs under it; a non-systemd host idles. Every
  role is a script under `docker exec`, so the same code path works with or
  without systemd and nothing races an exited container.
- **Workers are real separate containers.** Each installs swamp itself (a worker
  host has no repo), enrolls with its token, retries forever, and reaches serve
  through the shared network namespace.
- **Alpine is a first-class expected failure.** Its `expected: fail` scenario
  passes only when swamp genuinely cannot run there, which is how the harness
  proves it diagnoses rather than hangs.

To add a distro: add a `Distro` entry in `scenarios.ts` and a `case` in
`distroDockerfile`. To add a topology: extend `Topology` and add its scripts to
`topology.ts`. To assert something new in a container: add a phase to
`HarnessPhase` and a block to `buildHarnessScript`, then a check in
`evaluateResult` and a field on `ResultSchema`.

### Developing and testing

```sh
# Type-check everything.
~/.swamp/deno/deno check *.ts

# Unit tests (catalog, harness script/result, topology scripts, introspection,
# report renderers, and execute-level model-method tests with a stubbed runner).
~/.swamp/deno/deno test --allow-read --allow-write --allow-run --allow-env

# Format and lint to the swamp extension style.
swamp extension fmt manifest.yaml --json

# End-to-end, against this very extension (Debian is the fast choice).
swamp model @svendowideit/test-factory method run test tf \
  --input manifest=extensions/test-factory/manifest.yaml \
  --input scenario=debian-standalone
```

Prerequisites: a container runtime reachable by the `dockerBinary` global, able
to build images and run privileged containers for the systemd scenarios.

## License

MIT — see LICENSE.txt.
