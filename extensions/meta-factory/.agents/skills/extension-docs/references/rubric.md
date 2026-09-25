# The meta-factory documentation rubric

Deterministic scoring reference for `@svendowideit/meta-factory`. The
machine-readable source of truth is
`extensions/meta-factory/quality-rubric.ts`.

## The two audiences

The contract splits documentation by audience:

- **The manifest `description:` is the user manual.** The published manifest
  alone must let someone decide whether to pull the extension, install it and
  its dependencies, run it, understand what it installs (services, triggers,
  webhooks), and configure its optional parts.
- **The README is the extender/maintainer doc.** It must also carry the user
  information, but its primary audience is someone thinking of extending the
  extension or fixing something in it.

## Scoring model

The score is `round(earned / 100 * 100)`, where `earned` is the sum of eighteen
weighted checks. The maximum is always 100.

| Check id | Label | Max | Pass condition |
| -------- | ----- | --- | -------------- |
| `manifest` | Manifest name and description | 4 | name matches `@collective/name` (2) and description is non-placeholder (2) |
| `pitch` | `WHAT IT DOES` is a short pitch | 5 | section present (2), 20–140 words (2), not a method dump (2) |
| `manual` | Manifest description is a complete user manual | 8 | all six `MANUAL_ELEMENTS` present and description ≥300 chars |
| `order` | Manual sections are in priority order (installs last) | 5 | headings appear in `MANUAL_ORDER` |
| `no-methods` | Manifest omits a hand-written methods section | 5 | no `METHODS`/`API`/`WHAT IT SHIPS` heading in the description |
| `install` | Getting it is a single step | 13 | exactly one `swamp extension pull`, no extra setup commands |
| `format` | Manifest description is well-spaced and readable | 5 | literal block, blank-line sections, indented commands, blank-line keys |
| `examples` | Manifest/README carry functional examples | 6 | ≥3 distinct runnable `swamp …` commands with no placeholders |
| `explain` | Example commands say why/when to run them | 6 | every functional non-install command has an adjacent comment or sentence; the one-line `swamp extension pull` is exempt |
| `sections` | Canonical README sections | 5 | all five sections present and substantive |
| `substance` | README substance | 3 | ≥1200 chars (2), ≥1 markdown table (1) |
| `packaging` | README and LICENSE packaged | 6 | `README.md` in `additionalFiles:` (3) and a license file (3) |
| `metadata` | Platforms, repository, license | 4 | platforms empty-or-≥2 (2), allowlisted HTTPS repo (1), license (1) |
| `artifacts` | Declares shipped artifacts | 4 | ≥1 model/vault/datastore/report/workflow/skill |
| `coverage` | README documents every model and method | 5 | 30% for types named, 70% for methods named |
| `creation` | Definitions created by swamp creation commands | 5 | every model/workflow/vault config has a generated, valid, unique `id` |
| `symbols` | Source symbols documented (JSDoc) | 5 | scaled by `documented / total` exported declarations |
| `fasttypes` | No slow types (`deno doc --lint`) | 3 | no slow-type diagnostics on stderr |
| `deps` | Dependency trust | 3 | full on a passing audit, ~50% when skipped offline |

## Definitions are generated, not copied

A model, workflow, or vault config must be produced by its swamp creation
command, never hand-written or copied from another extension:

| Definition | Creation command |
| ---------- | ---------------- |
| Model | `swamp model create <type> <name> --json` |
| Workflow | `swamp workflow create <name> --json` |
| Vault | `swamp vault create <type> <name> --json` |

`definitions-lint.ts` classifies each config by shape and checks its `id:`:

- **`id-missing`** (error) — a hand-written file with no `id:`.
- **`id-format`** (error) — an `id:` that is not a UUID (fabricated by hand).
- **`id-duplicate`** (error) — an `id:` already declared by another config
  (the copy-paste symptom). A file named after its `name:`/`id` is treated as
  the generated original, so the copy is the one reported.
- **`create-unconfirmed`** (warning) — a definition *created* inside the audit
  window with no matching `swamp … create` command in the `swamp audit`
  timeline. Catches a hand-written or copied file that carries a plausible id.
- **`name-missing`** / **`typeVersion-missing`** (warning) — generation always
  records these.

Any structural error (`id-missing` / `id-format` / `id-duplicate`) costs the
whole `creation` check. The `create-unconfirmed` audit signal and the
`name-missing` / `typeVersion-missing` warnings are advisory only — they are
reported but cost no points, so an absent audit timeline never penalises a
legitimate definition.
Only issues under the scored extension's own directory are attributed to it.
Run the standalone scan for the whole repo:

```sh
swamp model @svendowideit/meta-factory method run lintDefinitions meta-factory
```

### The audit cross-reference

`lintDefinitions` reads the `swamp audit --json` timeline and recovers the
definition-creation commands that ran in the last `auditHours` hours (default
168; set `0` to disable). It is deliberately conservative, because the audit
timeline is best-effort evidence, not proof:

- A definition is judged only when it was **created** inside the window
  (birthtime), so editing an older, legitimately-created file never flags it.
- The window is the overlap of "the last `auditHours`" with "what the timeline
  actually covers" — a definition older than the timeline's own retention is
  unverifiable, not suspicious.
- A create command the parser cannot resolve to a name (e.g. an unexpanded
  shell variable) suppresses the warning entirely.
- `@collective/` prefixes are normalised, and `for <var> in …` loops are
  expanded, so a command like `for w in a b; do swamp workflow create @me/$w;
  done` confirms both `a` and `b`.
- When no timeline is available, the check is skipped — an absent log is not
  evidence that a command did not run.

The unmatched result is a `create-unconfirmed` **warning**; it never turns the
`creation` check into a failure on its own.

## No methods section in the manifest

The manifest `description:` must **not** contain a hand-written methods list.
swamp-club generates a formatted method reference from the manifest at publish
time, so a `METHODS` / `API` / `WHAT IT SHIPS` section duplicates it poorly.
The `no-methods` check scores zero when such a heading appears. Method lists
belong in the **README** (the extender/maintainer doc), which `coverage` checks.

## `WHAT IT DOES` is a short pitch

`WHAT IT DOES` must let a user decide this extension is a better option than a
similar one and solves their problem. It is **not** a list of methods:

- section present (2),
- 20–140 words (2) — enough to be complete, short enough to scan,
- not a method dump (2): fewer than three `name   description` list rows. The
  method list belongs in the **README**, not the manifest.

## Manual section order (installs last)

The manual puts the important information first, following this canonical order
(`MANUAL_ORDER`):

1. **decide** — `WHAT IT DOES`: a short pitch for why to be interested
2. **install** — how to get it
3. **dependencies** — or that it has none
4. **run** — how to run it
5. **configure** — how to set its options
6. **installs** — what it puts on the host

Any section appearing before an earlier one is an inversion
and costs `5 / 6` points each. A heading is a full-line canonical label (≤45
chars), so a method row like `run   Read the path.` is not mistaken for the
`RUN` heading.

## Single-step install (13 points)

Getting the extension must be **one command**:

```sh
swamp extension pull @mycollective/my-extension
```

The `install` check reads the manifest's `INSTALL` section. If it contains more
than one `swamp extension pull`, or any extra setup command (a `source add`,
a model-create prerequisite, etc.), the check scores **0/13** — a multi-step
install loses the full 13%.

## Well-spaced manifest format

A readable manifest follows `extensions/models/web-cache/manifest.yaml`:

- `description:` is a **literal block** (`description: >` or `|`), never a
  single inline line.
- The manual's sections are separated by **blank lines**.
- Embedded commands are **indented 4+ spaces** so they stand out from prose.
- **Top-level keys** (`repository:`, `paths:`, `models:`, `additionalFiles:`,
  `platforms:`, …) are separated by blank lines. The leading header block
  (`manifestVersion` / `name` / `version` / `description`) is exempt.

## Functional examples

`checkExamples` scans the manifest description and README for lines beginning
with a swamp invocation
(`swamp model|workflow|extension|vault|report|data|serve|auth`). It requires
**three distinct** runnable commands. Commands containing placeholders —
`<name>`, `my-extension`, `example.com`, `…` — are marked non-functional and do
not count. The report lists every example found and marks placeholders with ⚠️.

## Explained examples

`checkExplain` requires every functional, non-install command to say **why or
when** to run it — a user reading the manifest shouldn't be handed an
unexplained command list. A command is "explained" when a comment (`# …`) or a
prose sentence sits immediately above it (or on the same line), or when it
follows other commands under one shared comment. The one-line
`swamp extension pull` install is self-evident and exempt. The score is the
explained fraction, so explaining most-but-not-all commands earns partial credit
and the report names the offenders.

## The manifest-as-user-manual elements

`MANUAL_ELEMENTS` in `quality-rubric.ts` defines the six things the manifest
`description:` must cover. A detection regex must match each:

| id | Must tell the reader… |
| -- | --------------------- |
| `decide` | a short pitch — the problem it solves and why it is the better option |
| `install` | how to install it (`swamp extension pull …`) |
| `dependencies` | its dependencies, or that it has none / is self-contained |
| `run` | how to run it (a `swamp workflow run` / `swamp model …` command) |
| `configure` | how to configure its optional parts (global args, `--input`) |
| `installs` | what it installs — services, triggers, schedules, webhooks — or none |

Each present element earns `8 / 6` points. A description shorter than 300
characters cannot earn a full pass even if all keywords appear, because it has
no room to be a usable manual.

## Grade bands

| Grade | Range |
| ----- | ----- |
| A | ≥ 90 |
| B | ≥ 75 |
| C | ≥ 60 |
| D | ≥ 40 |
| F | < 40 |

The default `wellDocumented` threshold is **75** (grade B).

## Coverage scoring detail

`coverage` is a strong lever (18 points). It is computed as:

```
earned = round(18 * (0.3 * namedTypes/totalTypes + 0.7 * namedMethods/totalMethods))
```

A method counts as named when its exact identifier appears anywhere in the
README text (case-insensitive). The report lists every unnamed method under
**Undocumented methods** so the fix is mechanical: add it to the `## Details`
table or an `## Examples` block.

## Offline behaviour

`deps` requires network access (OSV.dev + npm registry via
`swamp extension quality`). Run with `--global-arg offline=true` (or
`--input offline=true`) in CI or a sandbox; the check then reports `partial`
with 50% credit, and the remaining checks are unaffected.

## Structure lint

Independent of the score, the model also runs two structural linters whose
issues appear in the report:

- `manifest-lint.ts` — required fields, CalVer version, placeholder
  description, every manual element (`manual-*` rules), artifact existence,
  `README.md` packaging.
- `readme-lint.ts` — canonical sections present and in order, no skipped
  heading levels, a configuration table, ≥2 code blocks, no empty fenced
  blocks.
- `definitions-lint.ts` — model/workflow/vault configs carry a generated,
  valid, unique `id` (`id-missing` / `id-format` / `id-duplicate`), plus
  `name`/`typeVersion` warnings.

The manifest and README lints are `error`/`warning` rows in the report and are
not part of the numeric score, so the score stays comparable across versions.
The definitions lint is different: it also feeds the scored `creation` check
(any error costs the whole 5 points).

## The scoreboard workflow

`@svendowideit/meta-factory-scoreboard` is a second workflow that scores only
**git-tracked** extensions (`checkAll gitOnly=true`, via `git ls-files`) and
prints a text table of every score with the reasons each is not 100/100. Pulled
or generated copies — anything under `.swamp/`, or otherwise untracked — are
excluded, so the table reflects only the repository's own extensions. It never
gates; it is a read-only report. Its reasons come from each score card's
`nextActions` (the scorer's own deduplicated fix list). Run it with:

```sh
swamp workflow run @svendowideit/meta-factory-scoreboard
```

## Code metrics (CRAP) — reported, not scored

Every score card and the scoreboard table also carry a `codeMetrics` block,
computed by `code-metrics.ts`. It is deliberately **outside** the 0-100 score —
no threshold, no rule — and exists only to show where the code sits:

- **complexity** — `@babel/parser`-parsed cyclomatic complexity per function
  (test files excluded), plus LOC.
- **coverage** — from running the colocated `*_test.ts` under `deno test
  --coverage` and reading the lcov report; `n/a` when there are no tests.
- **CRAP** — `comp² × (1 − coverage)³ + comp`, per function and for the
  extension as a whole. The highest-CRAP functions are both complex and
  untested, so they are the best candidates for tests or refactoring. The metric
  and formula are from Savoia & Evans (2007), the crap4j paper:
  <https://www.artima.com/weblogs/viewpost.jsp?thread=215899>.

## Relationship to the Swamp Club rubric

The published Swamp Club rubric (README, code example, rich README, symbols,
fast types, description, platforms, license, repository, dependency trust,
verified-by-swamp) is a **subset** of this rubric. Meeting the meta-factory
contract satisfies every client-earnable Swamp Club factor; the extra points
here are for the manifest-as-manual requirement, the visible section contract,
method coverage, and packaging — documentation quality the registry rubric does
not yet measure.
