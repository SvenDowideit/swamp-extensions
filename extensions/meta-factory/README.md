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
- source JSDoc symbol coverage, clean `deno doc --lint` (no slow types), and
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
swamp model @svendowideit/meta-factory method run installSkill \
  --global-arg root=. --input target=both
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

Run the model directly and read the report:

```sh
swamp model @svendowideit/meta-factory method run check \
  --global-arg root=. --input manifest=extensions/models/caddy/manifest.yaml

swamp report get @svendowideit/meta-factory-report \
  --model @svendowideit/meta-factory --markdown
```

Run offline (CI, sandboxes) — the dependency check reports `partial`:

```sh
swamp workflow run @svendowideit/meta-factory \
  --input root=extensions --global-arg offline=true
```

Scaffold a contract-conformant README for a new extension:

```sh
swamp model @svendowideit/meta-factory method run scaffold \
  --global-arg root=. --input manifest=extensions/models/my-extension/manifest.yaml
```

## Details

`@svendowideit/meta-factory` ships one model type (`@svendowideit/meta-factory`),
one report (`@svendowideit/meta-factory-report`), one workflow
(`@svendowideit/meta-factory`), and the `extension-docs` skill. Every method:

| Method | Arguments | Produces |
| ------ | --------- | -------- |
| `check` | `manifest` (string, required), `offline` (boolean, optional) | a `score` resource for one extension |
| `checkAll` | `manifest` (optional), `offline` (optional), `writeSummary` (boolean, default true) | one `score` resource per extension plus a `rollup` summary |
| `scaffold` | `manifest` (string, required), `force` (boolean, default false) | writes `README.md` beside the manifest |
| `installSkill` | `target` (`project`\|`global`\|`both`), `force` (boolean, default true) | copies the bundled skill into the target skill directories |

Resources:

- `score` — the full score card for one extension: total, grade, the checks,
  per-method coverage, manifest/README lint issues, and next actions.
- `rollup` — the summary written by `checkAll`: counts, average score, and every
  extension below the threshold with its top issues.

The score is the weighted sum of seventeen checks (maximum 100): manifest name
and description (4), short `WHAT IT DOES` pitch (6), manifest-as-user-manual
(8), manual section order, installs last (5), **no methods section in the
manifest (5)**, single-step install (13), manifest formatting (5), functional
examples (7), explained examples (7), canonical README sections (5), README
substance (3), README + LICENSE packaging (6), platforms/repository/license
metadata (4), declared artifacts (4), README coverage of every model and method
(6), JSDoc symbol coverage (6), clean `deno doc --lint` (3), and dependency
trust (3). Grades: A ≥ 90, B ≥ 75, C ≥ 60, D ≥ 40, else F. The full breakdown
is in the bundled skill's `references/rubric.md`.

### Extending this extension

The codebase splits cleanly so a new rule or metric can be added without
touching orchestration:

| File | Responsibility |
| ---- | -------------- |
| `quality-rubric.ts` | The contract and scorer: `SECTIONS`, `MANUAL_ELEMENTS`, `WEIGHTS`, every `check*` function (including `checkFormat` and `checkExamples`), and `scoreExtension`. Pure — manifests are parsed from YAML text, README from markdown text. |
| `readme-lint.ts` | README structural lint (canonical sections, heading levels, config table, code blocks). |
| `manifest-lint.ts` | Manifest structural lint (required fields, CalVer, manual coverage, artifact existence). |
| `introspect.ts` | Filesystem discovery of manifests, model types, and method keys. |
| `meta_factory.ts` | Orchestration only: subprocesses (`swamp`, `deno`), data writes, skill install. The subprocess runner (`run`) takes a bounded timeout and is injectable via `_run` for tests. |
| `meta_factory_report.ts` | Markdown/JSON rendering of the score and rollup. |

All `score` resources share one canonical instance key — the manifest path
relative to the repo root — so `check` and `checkAll` address the same
extension. Only `check`/`checkAll` write `score`/`summary`; `scaffold` and
`installSkill` write no data, so a scaffolded README never appears as a real
`F` score.

To add a scored check: add a `check*` function returning `CheckResult`, add its
weight to `WEIGHTS`, and include it in the `checks` array in `scoreExtension`.
To change what the manifest manual must contain: edit `MANUAL_ELEMENTS` (both
the scorer and `manifest-lint.ts` consume it). To change the README section
contract: edit `SECTIONS`.

### Developing and testing

```sh
# Type-check everything.
~/.swamp/deno/deno check *.ts

# Run the unit tests (scorer, linters, discovery, report renderers, and
# execute-level model-method tests with stubbed subprocesses).
~/.swamp/deno/deno test --allow-read --allow-write --allow-run --allow-env

# Slow-type lint (must be empty for the fast-types check).
~/.swamp/deno/deno doc --lint meta_factory.ts meta_factory_report.ts \
  quality-rubric.ts readme-lint.ts manifest-lint.ts introspect.ts

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
