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
| `tests` | the extension's own documented acceptance tests (`test-factory.yaml`) pass. |
| `fixtures` | caller-supplied method runs execute (and optionally match expected output). |

### Acceptance tests: `test-factory.yaml`

An extension can ship a `test-factory.yaml` (listed in its `manifest.yaml`
`additionalFiles:`) declaring the **user-facing outcomes** it promises. The
`tests` phase runs them per distro/topology and reports each test — and the
exact commands behind it — so a reader can judge both whether the tests were
adequate and whether they exercised what they claim.

The file pairs human prose with deterministic, runnable steps. There is no
runtime model call: the `confirms` and `cannot` prose and the `steps` are
authored together, and a lint enforces that every `confirms` claim has a
positive assertion and every `cannot` claim a negative one — a test cannot pass
while proving nothing.

```yaml
tests:
  - name: check-prints-latest
    confirms: >
      `check` prints the latest release tag for a public repo, as README "Run"
      shows.
    cannot: >
      must not exit non-zero, and must not print an error.
    documents: README.md#run          # where the outcome is documented
    variables:
      REPO: caddyserver/caddy
    steps:
      - name: create
        run: swamp model create @acme/thing check-me
        expect: { exitCode: 0 }
      - name: run
        run: >
          swamp model @acme/thing method run check check-me --input repo=$REPO
        expect:
          exitCode: 0
          outputContains: [caddy_]        # stdout or stderr
          outputNotContains: [error, not found]
          outputMatches: "caddy_v\\d"
        timeoutSeconds: 120
```

Step fields: `name`, `run` (single line or `|` block), `workingDir`,
`timeoutSeconds` (default 120), `continueOnFailure`, and `expect`. `expect`
supports `exitCode` (number or list), `stdoutContains` / `stdoutNotContains` /
`stderrContains` / `stderrNotContains`, `stdoutMatches` / `stdoutNotMatches`
(POSIX ERE), `outputContains` / `outputNotContains` / `outputMatches` (stdout
and stderr combined — useful because swamp logs to stderr and data to stdout),
and `fileExists`.

Discovery is driven by the candidate's own manifest: the factory uses any
`additionalFiles:` entry whose basename is `test-factory.yaml` (a subdirectory
is fine). A run auto-enables the `tests` phase when the candidate ships that
file; an explicit `--input phases=...` always overrides. A malformed or
non-proving file fails loudly before any container boots.

> **Note on a swamp warning.** swamp's workflow auto-discovery enumerates every
> `.yaml`/`.yml` under an extension directory (skipping only `manifest.yaml`) and
> ignores `additionalFiles:` when doing so. It therefore tries to parse the
> candidate's `test-factory.yaml` as a workflow and logs
> `Skipping broken extension workflow … Unknown key 'tests'`. This is cosmetic:
> extension install, `swamp doctor extensions`, the documentation score, and the
> `tests` phase itself are all unaffected. The `tests` key is intentionally a
> test-factory schema, not a workflow schema.

### Container test systems: `networks:`, `harness:`, `services:`

Some outcomes need services swamp does not provide — an authoritative DNS server
to write records into, a database, a peer node. The same `test-factory.yaml` can
declare a small container topology to run **around** the harness. The factory
creates the networks, builds/starts the services, waits for their healthchecks,
joins the swamp container to the networks, and exports each service's address to
the tests as a shell variable.

```yaml
networks:
  net1: { subnet: 192.0.2.0/24 }
  net2: { subnet: 198.51.100.0/24 }   # a second endpoint for the harness

harness:
  dig: true                            # install `dig` before the tests run
  networks:                            # the swamp container's attachments
    net1: { ipv4_address: 192.0.2.10 }
    net2: { ipv4_address: 198.51.100.10 }

services:
  bind:
    build: ./test/bind                 # context dir, relative to the manifest
    networks:
      net1: { ipv4_address: 192.0.2.11 }
    healthcheck:
      command: ["dig", "+short", "@127.0.0.1", "example.com", "SOA"]
      intervalSeconds: 1
      retries: 30
```

- **`networks`** — `name: { subnet }`. Pin the subnet so a static `ipv4_address`
  is valid (docker refuses an out-of-subnet address).
- **`harness`** — the swamp container's own `networks` (with optional static
  IPs; two networks give it two endpoints) and `dig: true` to install `dig` into
  the harness image before the tests.
- **`services`** — `name: { image | build, networks, healthcheck | waitForSeconds, environment, mounts, command, privileged, dockerfile }`.
  Each is reachable by name (a docker network alias), so a test can `dig @bind`
  without knowing its address. `build` is a context directory relative to the
  manifest; `mounts` host paths are relative to the manifest too.

Every declared address is exported to the tests as a variable — `TF_<SERVICE>_IP`
(its first attachment) and `TF_<SERVICE>_IP_<NETWORK>`, plus `TF_HARNESS_IP_<NETWORK>`
for the swamp container itself — so a step references the topology instead of a
literal:

```yaml
steps:
  - name: alpha-resolves-to-both-endpoints
    run: dig +short @bind alpha.example.com A | sort
    expect: { stdoutContains: ["192.0.2.10", "198.51.100.10"] }
  - name: served-from-first-endpoint
    run: >
      curl -s -o /dev/null -w '%{http_code}'
      --resolve alpha.example.com:80:$TF_HARNESS_IP_NET1 http://alpha.example.com/
    expect: { stdoutContains: ["200"] }
```

The parser is intentionally forgiving and entirely optional: a file with no
`networks:`/`harness:`/`services:` behaves exactly as before, and a malformed
topology (unknown network, missing image, duplicate address) fails loudly before
any container boots.

`@svendowideit/caddy` is the worked example — see its `test-factory.yaml` plus
`test/bind/`. It runs a real BIND over RFC2136 and verifies, with `dig` and
`curl`, that Caddy wrote the A records and serves 200/418/404 from the right
endpoints. Run it with:

```sh
swamp model @svendowideit/test-factory method run test tf \
  --input manifest=extensions/models/caddy/manifest.yaml \
  --input scenario=ubuntu-systemd-standalone
```

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
tested. When a test system requests `harness.dig: true`, `dig` is installed into
the running container before the tests rather than baked into a new image
variant, so the cache still holds.

On a **systemd** host a model that drives a systemd *user* service (such as
`@svendowideit/caddy`'s `systemctl --user`) needs root's user manager running:
the harness enables linger (`loginctl enable-linger root`) and waits for
`/run/user/0` before any phase, then exports `XDG_RUNTIME_DIR=/run/user/0`.

A scenario is a known-good/known-bad expectation: `expected: fail` scenarios
(such as Alpine) pass when the run indeed fails, so the harness is validated too.

### What each run records, and why

A pass/fail badge is not enough to judge a test. Every `result` and `summary`
carries an audit record so you can decide **whether the tests were adequate for
your needs**, and **whether they actually tested what they claim**:

- `extension` and `extensionVersion` — exactly which build was under test.
- `intent` — one sentence naming what the scenario set out to prove (host,
  topology, phases).
- `claims[]` — for every requested phase, the assertion a PASS stands for
  (`claim`) and the literal command lines the harness ran to establish it
  (`commands`). These are generated from the same plan as the in-container
  script, so the recorded mechanics cannot drift from what actually ran.

The markdown report renders all of this (a "What this run proves" list and a
"How it was proved" block of the exact commands), and the console log announces
the claims before the run starts. A `fixtures` phase with no fixtures is
recorded as proving nothing — honestly, rather than vacuously passing.

## Install

```sh
swamp extension pull @svendowideit/test-factory
```

No dependencies beyond a local container runtime. Docker is the default; set the
`dockerBinary` global to `podman` to use podman. The only network access is the
swamp release download; `serve`/`fleet` run `swamp serve` with `--auth-mode none`
on loopback, so no swamp-club account is required by default. Where `swamp serve`
*is* gated, store a collective API token in the `test-factory-vault` vault under
`SWAMP_API_KEY` and every container gets it as `SWAMP_API_KEY` (see Configure).

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
| `vault` | string | `"test-factory-vault"` | Vault the API key is read from when `swampApiKey` is empty. |
| `vaultEntry` | string | `"SWAMP_API_KEY"` | Secret key read from `vault`. |
| `swampApiKey` | string (sensitive) | `""` | swamp-club collective API token exported as `SWAMP_API_KEY` in **every** container. Leave empty (the default) and it is read from `vault`/`vaultEntry` — so a `test-factory-vault` holding `SWAMP_API_KEY` is picked up automatically, with no extra arguments. Because the field is sensitive a literal is rejected; an override must be a vault expression (see the Examples section). |

Per-run overrides on `test`: `manifest` (required), `scenario`, `distro`,
`topology`, `systemd`, `workers`, `phases`, `fixturesFile`, `scenarioFile`,
`expected`. `testAll` adds `root` and `gitOnly`. `cleanup` takes `prefix`;
`listScenarios` takes `distro`. The `tests` phase is added automatically when
the candidate ships a `test-factory.yaml`; pass `phases=smoke,load,definitions`
to skip it deliberately.

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

On a host where `swamp serve` is a gated team feature, the factory exports a
collective API token into every container. It reads that token from the vault
named `test-factory-vault` under the key `SWAMP_API_KEY` — so create the vault,
mint a token, and store it; every run picks it up with no extra arguments:

```sh
# 1. Mint a collective API token with the serve scope. The key is printed once
#    (it looks like swamp_org_…); copy it for the next step.
swamp auth token create --collective my-collective --scopes 'serve:*'

# 2. Create the vault the factory reads from, using the systemd-creds backend.
swamp vault create @svendowideit/systemd-creds test-factory-vault

# 3. Store the token under the key the factory expects. It is prompted for, so
#    it never lands in your shell history. A pipeline works too:
#    `echo -n "$KEY" | swamp vault put ...`.
swamp vault put test-factory-vault SWAMP_API_KEY

# 4. Run any serve/fleet scenario — SWAMP_API_KEY is now set in the containers.
swamp model @svendowideit/test-factory method run test tf \
  --input manifest=extensions/models/github-release-install/manifest.yaml \
  --input topology=fleet --input workers=2

# Confirm the secret is stored; list tokens to revoke one later.
swamp vault list-keys test-factory-vault
swamp auth token list --collective my-collective
```

To read from a different vault or key, set the `vault`/`vaultEntry` globals (for
example `--global-arg vault=other-vault --global-arg vaultEntry=MY_TOKEN`), or
override `swampApiKey` with a vault expression:

```sh
swamp model create @svendowideit/test-factory tf \
  --global-arg 'swampApiKey=${{ vault.get(other-vault, MY_TOKEN) }}'
```

Run an extension's own documented acceptance tests — this is the fastest way to
see whether the outcomes its README promises actually hold on a given host. When
the candidate ships a `test-factory.yaml`, the `tests` phase is auto-enabled:

```sh
swamp model @svendowideit/test-factory method run test tf \
  --input manifest=extensions/models/github-release-install/manifest.yaml \
  --input scenario=debian-standalone
```

Read just the documented-test breakdown from the last run:

```sh
swamp report get @svendowideit/test-factory-report --model tf --markdown
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

- `result` — one scenario's outcome: the candidate `extension` and
  `extensionVersion`, the `intent`, the per-phase `claims` (assertion + literal
  commands), distro, topology, expected verdict, per-phase results,
  definition/workflow/fixture detail, the documented `tests` (each with its
  prose and full per-step output), the `topologyResult` (serve ready, workers
  enrolled, dispatch ok), errors, the tail-capped `logs` (`logsTruncated` marks
  when the cap bit), and the resolved swamp version.
- `summary` — the rollup from a `test`/`testAll` fan-out: extension and version,
  the shared `claims`, scenario counts, documented-test counts
  (`testCount`/`testsPassed`), and one row per scenario.

Reports and workflows:

- `@svendowideit/test-factory-report` — renders a scenario result card (intent,
  "What this run proves", "How it was proved", phase table, definitions,
  workflows, documented tests, fixtures, errors, logs), or the fan-out summary.
  Scope: method.
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
| `tests.ts` | Parses `test-factory.yaml`, lints prose against assertions, generates the tests phase script, and merges harness outcomes with the authored prose. Pure. |
| `services.ts` | Parses a `test-factory.yaml`'s optional `networks:`/`harness:`/`services:` container topology, derives the `TF_*` test variables, and lints the topology. Pure. |
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
`evaluateResult` and a field on `ResultSchema`. For a new *expectation* in the
`tests` phase, extend `Expectation` in `tests.ts`, emit it in
`buildTestBlock`, and teach the positive/negative helpers about it so
`lintTests` keeps prose and assertions in agreement.

`@svendowideit/test-factory` tests itself: `acceptance/test-factory.yaml` (listed
in `additionalFiles:`) confirms the catalog, filtering and method surface the
README documents, and is exercised end-to-end by the `debian-standalone`
self-test above.

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
