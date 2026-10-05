# @svendowideit/release-train

The release dashboard for a swamp extension repository: a dependency diagram of
every extension you own plus the extensions they use, annotated with on-disk and
published versions, publish state, hygiene compliance, and test depth — and an
ordered publish plan.

> **One read-only command answers "what do I ship next, in what order, to which
> channel, and is it actually ready?"**

It publishes nothing, bumps nothing, and edits no extension. It composes the
data that already exists — the manifests, git, the registry, and
`@svendowideit/meta-factory`'s score/coverage resources — into one picture.

## What it does

An extension repo drifts into a release backlog: some extensions have local
changes, some are ahead of what is published, some depend on another that must
ship first, and the answer is spread across `git status`,
`swamp extension version`, the meta-factory scoreboard, and the adversarial
review files. `@svendowideit/release-train` reads all of it once and renders:

- **A dependency graph** — one node per extension, edges from
  `manifest.yaml:dependencies:` (dependent → dependency, external dependencies
  included), rendered as Mermaid with status colours and per-node docs score,
  unit coverage, acceptance-test count, and review state.
- **Publish state** — for each extension, its on-disk version, the latest
  version published to **each** of stable / rc / beta, the version actually
  pulled, and whether it is `up-to-date`, `needs-publish`, `blocked` (a
  dependency must publish first), or `unknown` (the registry could not be
  reached). `unknown` is never reported as "never published". When the registry
  is unreachable (offline, or a transient failure), release-train first reuses
  the versions from a **previous run**, clearly labelled in the `Source` column
  and the run header as possibly out of date, and otherwise falls back to the
  lockfile's installed version as a lower bound — so an already-pulled version
  still reads as `up-to-date` and a lack of registry knowledge is never
  presented as "needs publishing".
- **An ordered publish plan** — dependencies first, with each step's advisory
  target channel, the exact `swamp extension push` command, and the hygiene
  failures to fix first.
- **Hygiene compliance** — manifest==model version, an `upgrades` entry for the
  version, `swamp extension fmt --check`, workflow validation, the docs score
  against the threshold, and whether an adversarial review exists for the current
  code (read from the push preflight, so it is bound to the exact content hash).
- **Test depth** — colocated unit tests (count + measured line/function
  coverage) **separated from** the black-box `test-factory.yaml` acceptance tests
  (count, documented commands and shipped methods/workflows exercised).

Side effects: it runs `swamp extension info`/`fmt`/`workflow validate`/`push
--dry-run` and `swamp extension quality` (all skippable with `offline` /
`runChecks=false`), reads manifests and git, reads the meta-factory's data, and
writes a Mermaid diagram, a **one-file dashboard**, and its own
`node`/`graph`/`plan`/`summary` resources. It never modifies the extensions it
analyses.

### One-file dashboard

Everything lands in a single markdown document (`release-train.md` by default,
and the same text from `swamp report get … --markdown`). GitHub and gist render
it natively — the fenced ```` ```mermaid ```` block becomes the dependency graph
and every section is a markdown table:

1. **Status** — the legend: how many extensions are up-to-date / need publishing
   / blocked / external / have hygiene issues.
2. **Dependency graph** — the Mermaid diagram, coloured with the swamp-club
   palette (green up-to-date, amber needs-publish, red blocked, magenta unknown,
   grey external) and an explicit label text colour, so it stays legible in both
   GitHub light and dark mode. The Status table above it is the colour key.
3. **Hygiene and test matrix** — one row per extension: versions, published
   stable/rc/beta, publish state, manifest==model, upgrades, `fmt`, workflow
   validation, docs score, review state, unit-test count + coverage, acceptance
   count, and issue count.
4. **Publish plan** — the ordered steps with blockers, advised channel, exact
   command, and hygiene failures.
5. **External dependencies** — dependencies outside the repo, with who depends
   on them.
6. **No acceptance tests declared** — each extension with none, with its manifest
   path and unit coverage.
7. **Hygiene issues** and **stale meta-factory data** — the full issue lists.
8. **Regenerate** — the commands to reproduce the document.

Because it is one self-contained file, it can be committed, attached to a
release, or pasted into a gist and shared as a live diagram.

## Install

```sh
swamp extension pull @svendowideit/release-train
```

`@svendowideit/meta-factory` (and, transitively, `@svendowideit/test-factory`) is
pulled automatically — release-train reads its `score`/`summary` resources for
the docs and test axes.

## Configuration

Global arguments are set at model creation (`swamp model create
@svendowideit/release-train release-train --global-arg key=value`) or per run
with `--input`.

| Argument | Type | Default | Description |
| -------- | ---- | ------- | ----------- |
| `root` | string | `"extensions"` | Directory (relative to the repo root) scanned for manifests when git discovery is unavailable. |
| `gitOnly` | boolean | `true` | Discover only git-tracked manifests, excluding pulled/generated copies under `.swamp/`. |
| `includeExternal` | boolean | `true` | Show and query dependencies that are not in this repo as external nodes. |
| `runChecks` | boolean | `true` | Run the quality/fmt/deno/workflow-validate/push-dry-run hygiene checks. |
| `concurrency` | integer | `4` | How many extensions to check in parallel. |
| `checkTimeoutMs` | integer | `120000` | Per-subprocess timeout; a timeout is recorded as a hygiene issue, never fatal. |
| `offline` | boolean | `false` | Skip registry lookups and network checks; published versions come from the lockfile and review state is unknown. |
| `threshold` | integer | `75` | Documentation score below which an extension is advised to stay on beta. |
| `metaModel` | string | `"meta-factory"` | Meta-factory model whose `score`/`summary` resources are read for docs score and coverage. |
| `outputFile` | string | `"release-train.mmd"` | Path (relative to the repo root) the Mermaid diagram is written to by `analyze`. |
| `markdownFile` | string | `"release-train.md"` | Path (relative to the repo root) for the one-file GitHub/gist-renderable dashboard. Empty disables the write. |

## Examples

Run the whole dashboard — dependency diagram, hygiene/test matrix, and the
ordered publish plan — as one workflow. It writes `release-train.md`, a single
GitHub/gist-renderable document (fenced Mermaid + tables):

```sh
swamp workflow run @svendowideit/release-train
cat release-train.md
```

Write the one-file dashboard somewhere else (or disable it with an empty value):

```sh
swamp workflow run @svendowideit/release-train --input markdownFile=docs/releases.md
swamp workflow run @svendowideit/release-train --input markdownFile=
```

Skip the slower hygiene checks when you only want the graph and the reused
status (versions, publish state, docs/test axes):

```sh
swamp workflow run @svendowideit/release-train --input runChecks=false
```

Run offline on a machine with no network (CI, a sandbox) — published versions
come from the lockfile and review state is reported unknown:

```sh
swamp workflow run @svendowideit/release-train --input offline=true
```

Run just the analysis and read the diagram written to disk:

```sh
swamp model @svendowideit/release-train method run analyze release-train
cat release-train.mmd
```

Read the same one-file document from the last run, as markdown (no file needed):

```sh
swamp report get @svendowideit/release-train-report \
  --workflow @svendowideit/release-train --markdown
```

Read the ordered plan as JSON, for scripting:

```sh
swamp data get release-train plan --json | jq '.content.steps'
```

## Details

`@svendowideit/release-train` ships one model type, one report, and one workflow.

| Member | Kind | Purpose |
| ------ | ---- | ------- |
| `@svendowideit/release-train` | model | `analyze` discovers, graphs, gathers status, and writes the diagram and plan. |
| `analyze` | method | The single fan-out method (args: none; use the global args). |
| `@svendowideit/release-train-report` | report (workflow scope) | Renders the one-file dashboard: Mermaid diagram, status legend, hygiene/test matrix, publish plan, external deps, and the no-test/hygiene lists. |
| `@svendowideit/release-train` | workflow | Runs `analyze`, then the report; never gates. |

### Resources

| Resource | Instance | Contents |
| -------- | -------- | -------- |
| `node` | one per extension (name sanitized) | on-disk/model/upgrades versions, published per channel, installed version, changed, dirty files, publish state, blockers, channel advice, `hygiene` block, `tests` block, dependencies, dependents. |
| `graph` | `repo` | nodes, edges (with `external` flag), topological `publishOrder`, external nodes, cycle. |
| `plan` | `plan` | ordered steps with state, blockers, target channel, command, hygiene failures. |
| `summary` | `rollup` | counts by state, hygiene failures, untested-acceptance and stale-data lists, publish order. |

### How the analysis works

1. **Discover** git-tracked `manifest.yaml` files (`git ls-files`), falling back
   to a filesystem walk; parse name, version, `dependencies`, models, workflows,
   additional files.
2. **Graph** — edges dependent → dependency; external dependencies become
   external nodes; topological sort (Kahn) gives the publish order, with a
   deterministic break and a reported `cycle` when one exists.
3. **Versions** — manifest version, the model's `version:`, the latest
   `upgrades[].toVersion`; published versions from `swamp extension info`
   (stable/rc/beta) with the lockfile as fallback; installed version/channel from
   `upstream_extensions.json`.
4. **Changed / publish state** — the on-disk version ahead of everything
   published is the authoritative "needs publishing" signal; git dirtiness
   explains it. A dependent is `blocked` while any local dependency is pending.
5. **Hygiene** — manifest==model, `upgrades`, `fmt --check`, `workflow validate`,
   docs score vs `threshold`, and review state from `push --dry-run --json`
   (`adversarial-review-report` → missing/stale; `adversarial-review-dimension-issue`
   → issues).
6. **Tests** — reused from meta-factory: `codeMetrics.coverage`/`functionCoverage`
   (unit) and `testCoverage` (acceptance commands/methods/workflows), plus a
   colocated `*_test.ts` count. A resource whose version differs from on-disk is
   marked `dataStale` rather than trusted.

### Channel advice (advisory only)

Every channel's published version is always reported. The **suggested** target
is conservative: never-published or failing checks → `beta`; a stable line that
passes → `stable`; an rc line → `rc`. release-train never picks the channel for
you and never promotes.

### Extending this extension

| File | Responsibility |
| ---- | -------------- |
| `introspect.ts` | Pure parsers: manifest, model version, upgrades, workflow name, review filename/state, `upstream_extensions.json`, `git status`/`ls-files`. |
| `graph.ts` | Pure graph/status core: CalVer compare, edges, topological order, publish state, channel advice, plan. |
| `release_train.ts` | Orchestration only: subprocesses, registry lookups, meta-factory reads, resource writes, Mermaid write. |
| `release_train_report.ts` | Pure renderers for the diagram, matrix, and plan; the workflow-scope report. |

To add an axis: extend the relevant schema and the pure gatherer, then surface it
in `renderReport`. Keep the graph and status logic in `graph.ts` (unit-tested
without I/O).

### Developing and testing

```sh
# Type-check everything.
~/.swamp/deno/deno check *.ts

# Unit tests (pure graph/status, parsers, renderers, and model helpers).
~/.swamp/deno/deno test --allow-read --allow-write --allow-env *_test.ts

# Format and lint to the swamp extension style.
swamp extension fmt manifest.yaml --check
```

The acceptance tests live in `acceptance/test-factory.yaml` and prove the
user-facing outcome end to end (one `analyze` run produces a graph with edges and
a publish order, writes the `.mmd`, and the report renders all three sections):

```sh
swamp model @svendowideit/test-factory method run test tf \
  --input manifest=extensions/release-train/manifest.yaml \
  --input scenario=debian-standalone
```

## License

MIT — see LICENSE.txt.
