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
  `## Details` sections, name every model and method, and explain how the
  extension is built and changed;
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

Every result is written as swamp data, rendered as a readable report, and the
bundled skill teaches agents to apply the same rules while writing an extension.

Side effects: it runs `swamp extension quality` (network) and `deno doc`
locally, reads extension files, and writes `score`/`summary` resources. It never
modifies the extensions it scores, except `scaffold`, which writes a README
skeleton on request.

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

swamp report get @svendowideit/meta-factory-report \
  --model @svendowideit/meta-factory --markdown
```

## Details

`@svendowideit/meta-factory` ships one model type (`@svendowideit/meta-factory`),
two reports (`@svendowideit/meta-factory-report`, `@svendowideit/meta-factory-scoreboard`),
two workflows (`@svendowideit/meta-factory`, `@svendowideit/meta-factory-scoreboard`),
and the `extension-docs` skill. Every method:

| Method | Arguments | Produces |
| ------ | --------- | -------- |
| `check` | `manifest` (string, required), `offline` (boolean, optional) | a `score` resource for one extension |
| `checkAll` | `manifest` (optional), `offline` (optional), `writeSummary` (boolean, default true), `gitOnly` (boolean, default false) | one `score` resource per extension plus a `rollup` summary |
| `scaffold` | `manifest` (string, required), `force` (boolean, default false) | writes `README.md` beside the manifest |
| `lintDefinitions` | `scanRoot` (string, optional; defaults to the `definitionsRoot` global arg), `auditHours` (integer, optional; defaults to the global arg) | a `definitions` resource listing every model/workflow/vault config, its `id`, and its audit-confirmation status |
| `installSkill` | `target` (`project`\|`global`\|`both`), `force` (boolean, default true) | copies the bundled skill into the target skill directories |

Resources:

- `score` — the full score card for one extension: total, grade, the checks,
  per-method coverage, manifest/README/definition lint issues, and next actions.
- `rollup` — the summary written by `checkAll`: counts, average score, and every
  extension below the threshold with its top issues.
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

The score is the weighted sum of eighteen checks (maximum 100): manifest name
and description (4), short `WHAT IT DOES` pitch (5), manifest-as-user-manual
(8), manual section order, installs last (5), **no methods section in the
manifest (5)**, single-step install (13), manifest formatting (5), functional
examples (6), explained examples (6), canonical README sections (5), README
substance (3), README + LICENSE packaging (6), platforms/repository/license
metadata (4), declared artifacts (4), README coverage of every model and method
(5), **definitions created by swamp creation commands (5)**, JSDoc symbol
coverage (5), no slow-type diagnostics from `deno doc --lint` (3, filtered to
the rubric's slow-type codes so JSDoc warnings are not double-counted), and
dependency trust (3). Grades: A ≥ 90, B ≥ 75, C ≥ 60, D ≥ 40, else F. The full
breakdown is in the bundled skill's `references/rubric.md`.

### Extending this extension

The codebase splits cleanly so a new rule or metric can be added without
touching orchestration:

| File | Responsibility |
| ---- | -------------- |
| `quality-rubric.ts` | The contract and scorer: `SECTIONS`, `MANUAL_ELEMENTS`, `WEIGHTS`, every `check*` function (including `checkFormat` and `checkExamples`), and `scoreExtension`. Pure — manifests are parsed from YAML text, README from markdown text. |
| `readme-lint.ts` | README structural lint (canonical sections, heading levels, config table, code blocks). |
| `manifest-lint.ts` | Manifest structural lint (required fields, CalVer, manual coverage, artifact existence). |
| `definitions-lint.ts` | Creation-command lint: classifies each model/workflow/vault config, checks its `id` is generated, valid, and unique, and cross-references the `swamp audit` timeline (`parseCreationCommands`) to flag a recent definition no create command confirms. Pure per-source; `lintDefinitions` only walks the filesystem. |
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
the README section contract: edit `SECTIONS`.

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

## License

MIT — see LICENSE.txt.
