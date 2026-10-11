# @svendowideit/meta-factory

The documentation quality gate for swamp extensions. It turns one guiding
principle into a deterministic score.

> **The published manifest plus README must be enough for a user or agent to
> easily learn how to do everything the published extension does.**

This extension both **states** that principle (as the bundled `extension-docs`
skill agents load automatically) and **verifies** it (as a model that scores any
extension `0–100`).

## What it does

`@svendowideit/meta-factory` scores a swamp extension's `manifest.yaml` +
`README.md` against a fixed contract and reports exactly what is missing:

- the **manifest description is the user manual** — in canonical order, with a
  short `WHAT IT DOES` pitch first (why to be interested — not a method list),
  `INSTALL` next (a **single step**: a multi-step install loses 13% of the
  score, `install` check 0/13), then `DEPENDENCIES`, `RUN`, `CONFIGURE`, and
  `WHAT IT INSTALLS` last. The manifest must **not** contain a `METHODS`
  section: swamp-club generates a formatted method reference at publish, so a
  hand-written list costs the `no-methods` points — the method list lives in the
  README instead;
- the **manifest is well-spaced and readable** — a literal-block description,
  blank-line-separated sections, indented example commands, and blank-line
  separated top-level keys (like
  `extensions/models/web-cache/manifest.yaml`);
- it carries **functional examples** — at least three distinct runnable
  `swamp …` commands, with no `<name>` / `example.com` placeholders — and
  **explains each one**: every non-install command has a comment or sentence
  saying why/when to run it (`explain` check, 7 pts);
- the **README is the extender/maintainer doc** — it must carry visible
  `## What it does` / `## Install` / `## Configuration` / `## Examples` /
  `## Upgrade` / `## Details` sections, name every model and method, and explain
  how the extension is built and changed. An extension that ships a `setup`
  method additionally needs a `## Setup` section (see below);
- **configuration is precious and cumulative** — an extension that ships a
  `setup` method must persist every supplied value (even incomplete) to a durable
  resource, read existing config back before asking again, and prefer config
  another model/extension already saved (`readModelData` / `data.latest`) over
  asking again, so capabilities enable progressively as soon as their config is
  present. `config-lifecycle-lint.ts` reports `config-not-persisted` /
  `config-not-read-back` as errors and `config-not-reused` (plus
  `setup-method-missing` / `setup-recommended` for config-bearing extensions) as
  warnings, and the README must document it in a `## Setup` section — each worth
  5 points (`setup`, `config-lifecycle`). A legitimate case is exempted with
  `// meta-factory-ignore config-lifecycle: <reason>`;
- **reported information is verified reality, not intended state** — an
  extension must test the actual outcome before reporting it, and a failure that
  prevents continuation must be stated clearly and **stop** the run, never
  swallowed, retried unchanged, or continued past while success is claimed.
  Long-lived changes (DNS/TTL, certificates) must report their time-to-ready
  rather than presenting the desired end state as already true. `report-reality-lint.ts`
  reports `failure-swallowed` (a setup/upgrade `catch` that logs without
  failing), `prerequisite-allow-failure` (an `allowFailure: true` step a later
  step depends on through `completed`/`always`) and, as warnings,
  `claim-without-verification` and `eta-missing`; the `## Setup` README section
  must document this verified-reality behaviour. These are reported as
  `reportReality` on the score resource and **never change the score** (a static
  rule cannot reliably tell a blocking failure from a deliberate best-effort
  one), so they surface as diagnostics rather than a gate;
- **definitions are generated, not copied** — a model, workflow, or vault
  config must be created with the matching swamp command (`swamp model create`,
  `swamp workflow create`, `swamp vault create`), so it carries a fresh,
  unique `id`. A hand-written config (no `id`), a fabricated one (non-UUID), or
  a copy (duplicate `id`) fails the `creation` check. `lintDefinitions`
  additionally cross-references the `swamp audit` timeline: a definition
  *created* in the window with no matching create command is flagged
  `create-unconfirmed` — advisory only, since the audit timeline is best-effort
  evidence and never costs points;
- source JSDoc symbol coverage, no slow-type diagnostics from `deno doc --lint`,
  and
  dependency trust.

Separately from the 0-100 documentation score, it also reports **code metrics**
for every extension — a **CRAP score** (the Change Risk Anti-Patterns metric:
complexity squared against coverage) together with the inputs it is derived
from: per-function cyclomatic complexity, source lines, and test coverage. These
are shown in the score card, the `checkAll` rollup, and the scoreboard table.
They are **reported for information only and never affect the score** — no
threshold, no rule; the point is to see where the code sits.

Meta-factory depends on `@svendowideit/test-factory`, so every score also
carries that extension's **test coverage**: the number of tests in the
candidate's `test-factory.yaml`, the distinct `swamp …` commands those tests
run, how many of the commands shown in the manifest `description:` those are,
and how many of the declared methods and workflows the tests exercise — with the
full command lists, so every ratio expands into the exact commands. Meta-factory
does not recompute this — it reads an existing test-factory `coverage` resource
for the manifest (one a prior `test`, `testAll`, or `checkCoverage` run wrote),
and calls test-factory's `checkCoverage` method to compute it when none exists. A
reused resource must match both the manifest path *and* the extension version, so
coverage computed against an older build is treated as stale and recomputed
rather than reported as current. Coverage is reported in the score card, the
`checkAll` rollup, and the scoreboard, for information only. Set
`testCoverage=false` to skip it.

Read the coverage on its own from the test-factory, which stores the complete
lists:

```sh
swamp data get test-factory svendowideit-caddy --json \
  | jq '.content | {testCount, testCommands, documentedCommands,
                    documentedCovered, uncoveredCommands, surface}'
```

Every result is written as swamp data, rendered as a readable report, and the
bundled skill teaches agents to apply the same rules while writing an extension.

Side effects: it runs `swamp extension quality` (network), `deno doc` locally,
and — when an extension has colocated `*_test.ts` files — `deno test
--coverage` to measure them, reads extension files, and writes `score`/`summary`
resources. It never modifies the extensions it scores, except `scaffold`, which
writes a README skeleton on request.

## Install

```sh
swamp extension pull @svendowideit/meta-factory
```

No dependencies — it needs only the swamp CLI and the bundled deno binary that
swamp already ships. Pulling also installs the `extension-docs` skill into your
tool's skill directory, so agents pick up the contract automatically. To refresh
the skill after editing the extension:

```sh
swamp model @svendowideit/meta-factory method run installSkill meta-factory \
  --input target=both
```

## Configuration

Global arguments are set at model creation (`swamp model create
@svendowideit/meta-factory my-meta --global-arg key=value`) or via
`swamp model edit my-meta`:

| Argument | Type | Default | Description |
| -------- | ---- | ------- | ----------- |
| `root` | string | `"."` | Directory scanned by `checkAll` for `manifest.yaml` files, relative to the repo root. |
| `threshold` | integer | `75` | Minimum score for an extension to count as "well documented". |
| `offline` | boolean | `false` | Skip the network dependency audit; the dependency check then gets 50% credit. |
| `skillName` | string | `"extension-docs"` | Name of the bundled skill directory installed by `installSkill`. |
| `definitionsRoot` | string | `"."` | Repository directory scanned for hand-written or copied model/workflow/vault definitions. |
| `auditHours` | integer | `168` | Hours of `swamp audit` history to cross-reference for the creation-command check; `0` disables the audit confirmation. |
| `testCoverage` | boolean | `true` | Attach `@svendowideit/test-factory` coverage to each score. Set `false` when test-factory is not installed. |
| `testFactoryModel` | string | `"test-factory"` | Name of the test-factory model whose `coverage` data is read (or whose `checkCoverage` is called when none exists). |
| `testFactoryType` | string | `"@svendowideit/test-factory"` | Test-factory model type used when calling `checkCoverage`. |

## Examples

Score one extension:

```sh
swamp workflow run @svendowideit/meta-factory \
  --input manifest=extensions/models/caddy/manifest.yaml
```

Score every extension in the repo:

```sh
swamp workflow run @svendowideit/meta-factory --input root=extensions
```

Print the scoreboard — a text table of every **git-tracked** extension with the
reasons each is not 100/100. Pulled or generated copies under `.swamp/` are
excluded, so the table always reflects the repo's own extensions:

```sh
swamp workflow run @svendowideit/meta-factory-scoreboard

swamp report get @svendowideit/meta-factory-scoreboard \
  --workflow @svendowideit/meta-factory-scoreboard --markdown
```

Run the model directly and read the report:

```sh
swamp model @svendowideit/meta-factory method run check meta-factory \
  --input manifest=extensions/models/caddy/manifest.yaml

swamp report get @svendowideit/meta-factory-report \
  --model @svendowideit/meta-factory --markdown
```

Run offline (CI, sandboxes) — the dependency check reports `partial`:

```sh
swamp workflow run @svendowideit/meta-factory \
  --input root=extensions --input offline=true
```

Scaffold a contract-conformant README for a new extension:

```sh
swamp model @svendowideit/meta-factory method run scaffold meta-factory \
  --input manifest=extensions/models/my-extension/manifest.yaml
```

Lint every model/workflow/vault definition for hand-written or copied configs
(no documentation score — useful as its own CI gate). The audit window can be
narrowed for a fast check or widened to look further back:

```sh
# Default: confirm against the last 168h of `swamp audit` history.
swamp model @svendowideit/meta-factory method run lintDefinitions meta-factory

# Look back two weeks instead.
swamp model @svendowideit/meta-factory method run lintDefinitions meta-factory \
  --input auditHours=336

swap report get @svendowideit/meta-factory-report \
  --model @svendowideit/meta-factory --markdown
```

## Upgrade

Upgrade an existing install in one command after updating the extension:

```sh
# Update the extension, then refresh the bundled skill and re-score.
swamp extension update @svendowideit/meta-factory
swamp workflow run @svendowideit/meta-factory-upgrade
```

Why run it: a version bump alone does nothing on the host. Meta-factory installs
nothing on the host — its only local side effect is the bundled `extension-docs`
skill it copies into your tool's skill directory — so the upgrade workflow
re-installs that skill at the current version (overwriting the previous copy so
the local skill always matches the installed extension) and re-scores your
extensions under the new rules, so you can see whether a rubric change moved any
score. It is idempotent; re-running it is safe.

It takes the skill `target` (`project`, `global`, or `both`), and optionally a
single `manifest` to score instead of scanning the whole `root`:

```sh
# Refresh only the project-local skill, and score one extension.
swamp workflow run @svendowideit/meta-factory-upgrade \
  --input target=project --input manifest=extensions/models/caddy/manifest.yaml
```

The re-score step is tolerated to fail, so a below-threshold score does not fail
the upgrade; read the `summary` (rollup) resource for the numbers. When the
upgrade also needs new global arguments on the model, the upgrade chain in
`meta_factory.ts` seeds them on the next method run — the workflow's `checkAll`
step is that run.

## Details

`@svendowideit/meta-factory` ships one model type (`@svendowideit/meta-factory`),
two reports (`@svendowideit/meta-factory-report`, `@svendowideit/meta-factory-scoreboard`),
three workflows (`@svendowideit/meta-factory`, `@svendowideit/meta-factory-scoreboard`,
`@svendowideit/meta-factory-upgrade`), and the `extension-docs` skill. Every
method:

| Method | Arguments | Produces |
| ------ | --------- | -------- |
| `check` | `manifest` (string, required), `offline` (boolean, optional) | a `score` resource for one extension |
| `checkAll` | `manifest` (optional), `offline` (optional), `writeSummary` (boolean, default true), `gitOnly` (boolean, default false) | one `score` resource per extension plus a `rollup` summary |
| `scaffold` | `manifest` (string, required), `force` (boolean, default false) | writes `README.md` beside the manifest |
| `lintDefinitions` | `scanRoot` (string, optional; defaults to the `definitionsRoot` global arg), `auditHours` (integer, optional; defaults to the global arg) | a `definitions` resource listing every model/workflow/vault config, its `id`, and its audit-confirmation status |
| `installSkill` | `target` (`project`\|`global`\|`both`), `force` (boolean, default true) | copies the bundled skill into the target skill directories |

Resources:

- `score` — the full score card for one extension: total, grade, the checks,
  per-method coverage, manifest/README/definition lint issues, next actions, the
  `codeMetrics` block, and the `testCoverage` block (when test-factory is
  installed).
- `rollup` — the summary written by `checkAll`: counts, average score, every
  extension below the threshold with its top issues, and per-extension
  `codeMetrics` and `testCoverage`.
- `definitions` — the standalone creation-command lint written by
  `lintDefinitions`: every config found, its kind, expected creation command,
  its audit-confirmation status, and the issues with their severity.

Reports and workflows:

- `@svendowideit/meta-factory-report` — renders the full score card for one
  extension, the `checkAll` rollup, or the `lintDefinitions` result.
- `@svendowideit/meta-factory-scoreboard` — a workflow-scope report that renders
  a compact text table of every scored extension, lowest score first, with the
  reasons each is not 100/100 (drawn from the score card's `nextActions`). It is
  emitted by the `@svendowideit/meta-factory-scoreboard` workflow and reads its
  input from the `score` resources that step produced.
- `@svendowideit/meta-factory` workflow — scores and gates; fails when any
  extension is below the threshold.
- `@svendowideit/meta-factory-scoreboard` workflow — scores only git-tracked
  extensions (`checkAll gitOnly=true`) and prints the scoreboard, without
  gating.
- `@svendowideit/meta-factory-upgrade` workflow — refreshes the bundled skill
  and re-scores; the single upgrade entry point (see [Upgrade](#upgrade)).

The score is the weighted sum of twenty-one checks (maximum 100): manifest name
and description (4), short `WHAT IT DOES` pitch (5), manifest-as-user-manual
(8), manual section order, installs last (5), **no methods section in the
manifest (5)**, single-step install (13), manifest formatting (4), functional
examples (4), explained examples (4), canonical README sections (6), README
substance (3), **a documented single upgrade workflow (5)**, README + LICENSE
packaging (4), platforms/repository/license metadata (4), declared artifacts
(4), README coverage of every model and method (5), **definitions created by
swamp creation commands (4)**, **the extension version read from `manifest.yaml`
rather than the model's own or an instance's version (3)**, JSDoc symbol
coverage (4), no slow-type diagnostics from `deno doc --lint` (3, filtered to
the rubric's slow-type codes so JSDoc warnings are not double-counted), and
dependency trust (3). Grades:
A ≥ 90, B ≥ 75, C ≥ 60, D ≥ 40, else F. The full breakdown is in the bundled
skill's `references/rubric.md`.

### Extension (package) vs model version

The `version-source` check enforces that an extension which needs to know its
own version at run time reads it from the bundled `manifest.yaml` — anchoring on
a shipped asset with `ctx.extensionFile()` and walking up to the manifest — and
**not** from the model instance. Two values look like "the version" but are not
the extension version:

| Value | What it actually is |
| ----- | ------------------- |
| `model.version` | the model-type / data-schema version (drives `typeVersion` and the `upgrades` chain) |
| `context.definition.version` | the model *instance's* own version |

They are per-type/per-instance and independent of the manifest version: an
unchanged model keeps its schema version across extension releases, and the two
are **not** required to be in lock-step. A legitimate type-version use (e.g.
comparing an instance's `typeVersion` to the installed model version for
staleness) is exempted with a `// meta-factory-ignore version-source: <reason>`
comment on the line or the line directly above it.

### Code metrics (CRAP)

Independent of the documentation score, every `score`/`summary` resource and the
scoreboard table carry a `codeMetrics` block. It answers "where does the code
sit?" — complexity, size, coverage, and the CRAP score that combines the first
and third — with **no thresholds or rules**; nothing here changes the 0-100
documentation grade.

| Metric | Meaning |
| ------ | ------- |
| `functions` | Functions analysed across the extension's source (test files excluded). |
| `loc` | Total source lines in those files. |
| `averageComplexity` / `maxComplexity` | Mean and peak cyclomatic complexity per function. |
| `coverage` / `functionCoverage` | Line coverage (across analysed functions) and the fraction of functions with any coverage. |
| `crapScore` | Extension-level CRAP: `avgComplexity² × (1 − coverage)³ + avgComplexity`. |
| `averageCrap` / `maxCrap` | Mean and worst per-function CRAP. |
| `worstFunctions` | The highest-CRAP functions, with line, complexity, and coverage. |
| `coverageAvailable` | False when the extension has no colocated `*_test.ts`, so coverage and CRAP assume 0% (shown as `n/a`). |

How it is measured:

- **Complexity** — each `.ts` file is parsed with `@babel/parser` (maintained
  TypeScript/JSX parser), decision points (ifs, loops, `case`, `catch`,
  ternaries, `&&`/`||`/`??`) are counted per function, and nested functions are
  excluded from their parent's count. `*_test.ts` files are not measured.
- **Coverage** — the colocated `*_test.ts` files are run under `deno test
  --coverage`, and the lcov report Deno writes is read for the executed lines
  inside each function's span. This is best-effort: if the tests fail to run or
  there are none, complexity is still reported and coverage is marked
  unavailable.
- **CRAP** — `comp² × (1 − coverage)³ + comp` per function; a complex, untested
  function scores worst, a simple or well-covered one stays low. The metric and
  formula are from Alberto Savoia and Bob Evans' *Change Risk Analysis and
  Prediction* (2007), the paper that introduced crap4j:
  <https://www.artima.com/weblogs/viewpost.jsp?thread=215899>. The canonical
  formula is `comp² × (1 − cov/100)³ + comp`; here coverage is carried as a 0..1
  fraction, so the division by 100 is folded into the fraction.

Because the `checkAll`/scoreboard path runs each extension's tests, a full-repo
scoreboard run takes longer than a docs-only pass. `checkAll` accepts the
code-metrics work as part of a normal run; nothing needs to be enabled.

### Extending this extension

The codebase splits cleanly so a new rule or metric can be added without
touching orchestration:

| File | Responsibility |
| ---- | -------------- |
| `quality-rubric.ts` | The contract and scorer: `SECTIONS`, `MANUAL_ELEMENTS`, `WEIGHTS`, every `check*` function (including `checkFormat`, `checkExamples`, and `checkUpgrade`), and `scoreExtension`. Pure — manifests are parsed from YAML text, README from markdown text. |
| `readme-lint.ts` | README structural lint (canonical sections, heading levels, config table, code blocks). |
| `manifest-lint.ts` | Manifest structural lint (required fields, CalVer, manual coverage, artifact existence). |
| `definitions-lint.ts` | Creation-command lint: classifies each model/workflow/vault config, checks its `id` is generated, valid, and unique, and cross-references the `swamp audit` timeline (`parseCreationCommands`) to flag a recent definition no create command confirms. Pure per-source; `lintDefinitions` only walks the filesystem. |
| `code-metrics.ts` | Code-quality metrics: `analyzeComplexity` (`@babel/parser`-based cyclomatic complexity + LOC per function), `parseLcov` (coverage from `deno test --coverage`), `computeCrap`, and `aggregateMetrics`. Pure; filesystem/subprocess work lives in `meta_factory.ts`. Reported only — never scored. |
| `introspect.ts` | Filesystem discovery of manifests, model types, and method keys, plus `manifestsFromGitList` (parses `git ls-files` output into manifest entries). |
| `meta_factory.ts` | Orchestration only: subprocesses (`swamp`, `deno`, `git`), data writes, skill install. The subprocess runner (`run`) takes a bounded timeout and is injectable via `_run` for tests. |
| `meta_factory_report.ts` | Markdown/JSON rendering of the score, rollup, and definitions lint. |
| `meta_factory_scoreboard.ts` | The workflow-scope scoreboard report: `buildScoreboard` / `renderScoreboard` turn the run's `score` resources into the text table and its reasons. Pure renderers, unit-tested directly. |

All `score` resources share one canonical instance key — the manifest path
relative to the repo root — so `check` and `checkAll` address the same
extension. Only `check`/`checkAll` write `score`/`summary`; `scaffold` and
`installSkill` write no data, so a scaffolded README never appears as a real
`F` score. `lintDefinitions` writes a separate `definitions` resource, so it is
never confused with a documentation score.

The `creation` check's audit cross-reference reads only the public
`swamp audit --json` output through the injectable subprocess runner — it never
depends on how or where the audit timeline is stored, so that storage can change
without touching this extension. The matching is deliberately conservative: it
judges only definitions *created* inside the window, treats a
timeline that starts after the definition as unverifiable, and downgrades an
unresolved create command to "no verdict" rather than a false accusation.

To add a scored check: add a `check*` function returning `CheckResult`, add its
weight to `WEIGHTS`, and include it in the `checks` array in `scoreExtension`.
Keep `Object.values(WEIGHTS)` summing to 100 — rebalance existing weights when
adding one. To change what the manifest manual must contain: edit
`MANUAL_ELEMENTS` (both the scorer and `manifest-lint.ts` consume it). To change
the README section contract: edit `SECTIONS` (both the scorer and
`readme-lint.ts` consume it). The `upgrade` check is the worked example of all
three: it adds an `UPGRADE` manual element, an `## Upgrade` README section, and a
`checkUpgrade` function (in `checks`) that scores the documented single upgrade
workflow; adding the section to `SECTIONS` also made `readme-lint.ts` require it.
`checkUpgrade` rewards a `swamp workflow run <name>-upgrade` command with an
explanation of what is automatic and how the user is prompted, and accepts a
"installs nothing on the host, so `swamp extension update` is the whole upgrade"
exemption. It also enforces the **no-memory-game** rule: an upgrade must discover
its own targets, so an `--input model=…`/`--input name=…` identity input caps the
check at ⅖ unless the section also explains the discovery ("discovers every…",
"lists them", "no model name to remember").

### Developing and testing

```sh
# Type-check everything.
~/.swamp/deno/deno check *.ts

# Run the unit tests (scorer, linters, discovery, report renderers, and
# execute-level model-method tests with stubbed subprocesses).
~/.swamp/deno/deno test --allow-read --allow-write --allow-run --allow-env

# Slow-type lint: the declared entrypoints must report no slow-type codes
# (`deno doc --lint` writes them to stderr and exits non-zero). The
# fast-types check filters to the rubric's slow-type codes, so a
# `missing-jsdoc` warning (covered separately by the symbols check) does not
# cost the point.
~/.swamp/deno/deno doc --lint meta_factory.ts meta_factory_report.ts

# Format and lint to the swamp extension style.
swamp extension fmt manifest.yaml --json
```

The bundled skill is edited at `.agents/skills/extension-docs/` (with
`references/rubric.md` and `references/templates.md`); run `installSkill` to
push a copy into the project (`.agents/skills/`) and global
(`~/.agents/skills/`) skill directories.

Prerequisites: the swamp CLI on `PATH` (used for `extension quality` and
`doctor`), and the bundled deno binary at `~/.swamp/deno/deno` (resolved via
`swamp doctor extensions`). Offline runs skip the network audit.

### Future work — merge `upgrade` and `setup`

`upgrade` and `setup` are the same shape: **detect the current state, report it,
and progressively reconcile toward the target**. `upgrade` reconciles a host
install (migrate, rebuild, restart); `setup` reconciles configuration (detect,
persist, enable). They are documented as two sections today, but the end state
is **one** entry point per extension — a single `reconcile`/`setup` workflow
that detects what is already present (including anything a peer saved) and
enhances the extension as far as the available information allows.

When that lands, the rubric should require a single combined section instead of
separate `upgrade` + `setup` sections, and the two checks should fold into one.
This is deferred deliberately: the two contracts are being proven independently
first, and the config-lifecycle migration (adding `setup` to extensions that
lack one) is still in progress.

## License

MIT — see LICENSE.txt.
