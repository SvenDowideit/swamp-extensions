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

The score is `round(earned / 100 * 100)`, where `earned` is the sum of
twenty-three weighted checks. The maximum is always 100.

| Check id | Label | Max | Pass condition |
| -------- | ----- | --- | -------------- |
| `manifest` | Manifest name and description | 4 | name matches `@collective/name` (2) and description is non-placeholder (2) |
| `pitch` | `WHAT IT DOES` is a short pitch | 5 | section present (2), 20–140 words (2), not a method dump (2) |
| `manual` | Manifest description is a complete user manual | 7 | all required `MANUAL_ELEMENTS` present and description ≥300 chars |
| `order` | Manual sections are in priority order (installs last) | 4 | headings appear in `MANUAL_ORDER` |
| `no-methods` | Manifest omits a hand-written methods section | 4 | no `METHODS`/`API`/`WHAT IT SHIPS` heading in the description |
| `install` | Getting it is a single step | 13 | exactly one `swamp extension pull`, no extra setup commands |
| `format` | Manifest description is well-spaced and readable | 4 | literal block, blank-line sections, indented commands, blank-line keys |
| `examples` | Manifest/README carry functional examples | 3 | ≥3 distinct runnable `swamp …` commands with no placeholders |
| `explain` | Example commands say why/when to run them | 3 | every functional non-install command has an adjacent comment or sentence; the one-line `swamp extension pull` is exempt |
| `sections` | Canonical README sections | 7 | all required sections present and substantive |
| `setup` | README documents setup, the config lifecycle, and reality | 5 | for an extension that ships a `setup` method: an `## Setup` section (40%) that says config is persisted (even partial), existing/shared config is detected and reused, capabilities enable progressively on approval, and reported outcomes are verified reality with a blocking failure stopping the run (60%); an extension with no `setup` method is credited automatically |
| `substance` | README substance | 3 | ≥1200 chars (2), ≥1 markdown table (1) |
| `upgrade` | README documents a single upgrade workflow | 5 | an `## Upgrade` section names one `swamp workflow run <name>-upgrade` entry point (or the no-host-artifacts exemption) and explains what is automatic or prompted; entry point present but unexplained (¾), section with no entry point (⅖), no section (0) |
| `packaging` | README and LICENSE packaged | 4 | `README.md` in `additionalFiles:` (3) and a license file (3) |
| `metadata` | Platforms, repository, license | 4 | platforms empty-or-≥2 (2), allowlisted HTTPS repo (1), license (1) |
| `artifacts` | Declares shipped artifacts | 4 | ≥1 model/vault/datastore/report/workflow/skill |
| `coverage` | README documents every model and method | 4 | 30% for types named, 70% for methods named |
| `creation` | Definitions created by swamp creation commands | 3 | every model/workflow/vault config has a generated, valid, unique `id` |
| `version-source` | Extension version read from manifest.yaml | 2 | no model source uses `model.version` or `context.definition.version` (the model-type or instance version) as the extension version; a `// meta-factory-ignore version-source: <reason>` comment exempts a legitimate type-version use |
| `config-lifecycle` | Config is persisted, read back, and reused | 5 | a `setup`-shipping extension persists config (even partial), reads existing config back, and does not re-ask; missing-setup and no-reuse are warnings, persistence/read-back failures are errors |
| `symbols` | Source symbols documented (JSDoc) | 3 | scaled by `documented / total` exported declarations |
| `fasttypes` | No slow types (`deno doc --lint`) | 2 | no slow-type diagnostics on stderr |
| `deps` | Dependency trust | 2 | full on a passing audit, ~50% when skipped offline |

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

## The extension version comes from manifest.yaml

`version-source` checks that an extension which needs to know its own version at
run time reads it from the bundled `manifest.yaml`, not from the model instance.
Two values look like "the version" but are **not** the extension (package)
version:

| Value | What it actually is |
| ----- | ------------------- |
| `model.version` | the model-type / data-schema version (drives `typeVersion` and the `upgrades` chain) |
| `context.definition.version` | the model *instance's* own version |

Both are per-type/per-instance and independent of the manifest version: an
unchanged model keeps its schema version across extension releases, and the two
are **not** required to be in lock-step. So the extension version must be
resolved from the manifest — anchor on a shipped asset with `ctx.extensionFile()`
and walk up to `manifest.yaml` (the pulled layout keeps assets under
`<ext>/files/` with the manifest one level up). `version-source-lint.ts` reads
every declared `.ts` artifact and reports each runtime reference to
`model.version` or `context.definition.version`.

A legitimate type-version use — e.g. comparing an instance's `typeVersion` to
the installed model version for staleness — is exempted with a
`// meta-factory-ignore version-source: <reason>` comment on the line or the
line directly above it. Any unexempted reference fails the `version-source`
check (3 points).

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
6. **setup** — the `setup` method and the config lifecycle (only when a `setup` method exists)
7. **upgrade** — how to upgrade an existing install (one workflow)
8. **installs** — what it puts on the host

Any section appearing before an earlier one is an inversion
and costs `4 / 8` points each. A heading is a full-line canonical label (≤45
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

## The upgrade workflow (5 points)

Every extension ships **one** documented upgrade entry point so an existing
install can be brought up to date without the user working out which methods to
re-run. The `upgrade` check reads the README's `## Upgrade` section:

- **full** — the section names a `swamp workflow run <name>-upgrade` command
  (the workflow name contains `upgrade`) and explains what it does
  automatically or how it prompts for input, **or** the section states the
  extension installs nothing on the host and gives `swamp extension update` as
  the whole upgrade;
- **¾** — the entry point is present but the section does not explain the
  automation or the prompting;
- **⅖** — the section exists but names no recognizable single entry point;
- **0** — no `## Upgrade` section.

The workflow itself should migrate the model definition, rebuild/reinstall
anything on the host, reconcile configuration, restart services, and verify,
and be idempotent. It must **discover its own targets** — never require the user
to know an internal name. When there is more than one candidate, list them and
ask. An `--input model=…` identity input caps the check at ⅖ unless the section
also explains how targets are discovered ("discovers every…", "lists them", "no
model name to remember"). Prompt for anything it cannot infer: use
`manual_approval` for a destructive confirmation or anything secret (store it in
a vault or an environment file — never a `wait_for_signal` payload, which is
plaintext), and `wait_for_signal` only for non-secret values.

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

`MANUAL_ELEMENTS` in `quality-rubric.ts` defines the things the manifest
`description:` must cover. A detection regex must match each. The `setup`
element is required **only when the extension ships a `setup` method** (the
config-lifecycle contract); every other element is always required.

| id | Must tell the reader… |
| -- | --------------------- |
| `decide` | a short pitch — the problem it solves and why it is the better option |
| `install` | how to install it (`swamp extension pull …`) |
| `dependencies` | its dependencies, or that it has none / is self-contained |
| `run` | how to run it (a `swamp workflow run` / `swamp model …` command) |
| `configure` | how to configure its optional parts (global args, `--input`) |
| `setup` | how the `setup` method detects/reuses config, persists partial values, and enables capabilities progressively |
| `upgrade` | how to upgrade an existing install — one workflow that automates it |
| `installs` | what it installs — services, triggers, schedules, webhooks — or none |

Each present element earns an equal share of the 7 points; when no `setup`
method exists the `setup` element is dropped from the denominator. A description
shorter than 300 characters cannot earn a full pass even if all keywords appear,
because it has no room to be a usable manual.

## Configuration is precious and cumulative (5 points)

Configuration is the one thing an extension must never lose. An extension that
manages configuration through a `setup` method is held to the **config
lifecycle** contract, enforced by `config-lifecycle-lint.ts` and scored by the
`config-lifecycle` check (5 points):

1. **Persist every input** — a supplied value is written to a durable resource
   (`context.writeResource`) even when incomplete.
2. **Ask once** — read the persisted config (or a peer model's data) back before
   asking the user again.
3. **Reuse what exists** — prefer `context.readModelData` / `data.latest` over
   asking, so another extension's saved config is not re-requested.
4. **Progressively enhance** — enable each capability automatically the moment
   its config is present.

The lint reports `config-not-persisted` and `config-not-read-back` as **errors**
(they cost the check), `config-not-reused` as a **warning**, and
`setup-method-missing` / `setup-recommended` for config-bearing extensions as
**warnings** (a migration signal, not a gate). A legitimate exemption is a
`// meta-factory-ignore config-lifecycle: <reason>` comment (add a rule name to
exempt only that rule), exactly like `version-source`.

Document the contract in the README `## Setup` section (scored by the `setup`
check) and describe it in the manifest `SETUP` element.

## Report reality, not intent (reported, not scored)

Information an extension gives the user must be **actual, verified state**, not
unactioned desired state. `report-reality-lint.ts` enforces four heuristics over
an extension's declared `.ts` sources and `.yaml` workflows:

| rule | severity | catches |
| ---- | -------- | ------- |
| `failure-swallowed` | error | a `catch` in a setup/upgrade file that logs but neither throws nor returns a blocked status — the run continues past a failure |
| `prerequisite-allow-failure` | error | a setup/upgrade step with `allowFailure: true` that a later step depends on via `condition: completed`/`always` — the run continues and can report success that is not real |
| `claim-without-verification` | warning | a source reporting success/state (serving, configured, active, reachable…) without a probe/read of actual state |
| `eta-missing` | warning | work on a long-lived change (DNS/TTL/certificate) with no stated time-to-ready |

Exempt a deliberate best-effort case with
`// meta-factory-ignore report-reality: <reason>` (add a rule name to exempt only
that rule). Unlike `config-lifecycle`, these are **reported as `reportReality` on
the score resource and never change the score** — a static rule cannot reliably
tell a blocking failure from a deliberate optional one (a best-effort
enrichment fetch is not the same as a swallowed `setcap`). The *scored*
enforcement is the `## Setup` requirement to document verified-reality
behaviour (a `## Setup` section that never says outcomes are tested before being
reported, that a blocking failure stops the run, or that a long change reports
its time-to-ready loses setup points).

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

`coverage` is a strong lever (4 points). It is computed as:

```
earned = round(4 * (0.3 * namedTypes/totalTypes + 0.7 * namedMethods/totalMethods))
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
- `readme-lint.ts` — canonical sections present and in order (including the
  required `## Upgrade` section, and `## Setup` only when the extension ships a
  `setup` method), no skipped heading levels, a configuration table, ≥2 code
  blocks, no empty fenced blocks.
- `definitions-lint.ts` — model/workflow/vault configs carry a generated,
  valid, unique `id` (`id-missing` / `id-format` / `id-duplicate`), plus
  `name`/`typeVersion` warnings.
- `config-lifecycle-lint.ts` — a `setup`-shipping extension persists config,
  reads it back, and prefers a peer's saved config (`config-not-persisted` /
  `config-not-read-back` errors, `config-not-reused` / `setup-method-missing` /
  `setup-recommended` warnings).

The manifest and README lints are `error`/`warning` rows in the report and are
not part of the numeric score, so the score stays comparable across versions.
The definitions lint and the config lifecycle lint are different: their errors
also feed the scored `creation` and `config-lifecycle` checks.

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
