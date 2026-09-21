---
name: extension-docs
description: >
  Enforce the swamp extension documentation contract whenever creating or
  editing a swamp extension — manifest.yaml, README.md, extension models,
  reports, vaults, datastores, or workflows under extensions/. Triggers on
  "swamp extension", "extension manifest", "write a README for my extension",
  "manifest description", "is my extension well documented", "extension quality
  score", "meta-factory", or any work inside extensions/. Requires a full
  user-manual manifest description and visible What it does / Install /
  Configuration / Examples / Details README sections, and produces a
  deterministic 0-100 documentation score.
---

# Extension Docs — the manifest-must-teach principle

## The principle

> **The published manifest plus README must be enough for a user or agent to
> easily learn how to do everything the published extension does.**

Apply it with **two audiences**:

- **The manifest `description:` is the user manual.** The published manifest
  alone must let someone decide whether to pull the extension, install it and
  its dependencies, run it, understand what it installs (services, triggers,
  webhooks), and configure its optional parts.
- **The README is the extender/maintainer doc.** It must also carry the user
  information, but its primary audience is someone thinking of extending the
  extension or fixing something in it.

If a reader has only `manifest.yaml` and `README.md`, they should be able to do
everything above. Anything that requires reading the TypeScript source is a
documentation gap. Apply this to **every** swamp extension you touch.

## The manifest manual contract

The manifest `description:` must cover all seven elements
(`MANUAL_ELEMENTS` in `quality-rubric.ts`), and be at least 300 characters.
**Put the important information first**, in this canonical order
(`MANUAL_ORDER`) — the method reference goes **last**:

| Order | Section | Must tell the reader… |
| ----- | ------- | --------------------- |
| 1 | `WHAT IT DOES` | a **short pitch**: the problem it solves and why it is the better option — **not** a method list |
| 2 | `INSTALL` | how to get it, in **one step** |
| 3 | `DEPENDENCIES` | its dependencies, or that it has none / is self-contained |
| 4 | `RUN` | how to run it (a `swamp workflow run` / `swamp model …` command) |
| 5 | `CONFIGURE` | how to configure its optional parts (global args, `--input`) |
| 6 | `WHAT IT INSTALLS` | what it puts on the host — services, triggers, webhooks — or none |

`WHAT IT DOES` is a 20–140 word pitch so a user can decide it beats a similar
extension — **not** a dump of every method.

**Do not add a `METHODS` section to the manifest.** swamp-club generates a
formatted method reference from the manifest at publish time, so a hand-written
list duplicates it poorly and costs the `no-methods` points. Put the method list
in the **README** (the extender/maintainer doc), where the `coverage` check
looks for it.

Never `TODO`, `tbd`, or a one-liner. The description is the strongest discovery
signal an extension has; treat it as the manual.

## Single-step install — 13% of the score

Getting the extension must be **one command**:

```sh
swamp extension pull @mycollective/my-extension
```

If the `INSTALL` section needs more than that — a second pull, a
`swamp extension source add`, a model-create prerequisite, anything else the
user must run first — the `install` check scores **0/13**. Make it one step.

## Manifest format — space it for reading

Format the manifest so it reads well, following
`extensions/models/web-cache/manifest.yaml`:

- `description:` is a **literal block** (`description: >` or `|`) — never a
  single inline line.
- Separate the manual's sections with **blank lines** (`WHAT IT SHIPS`,
  `INSTALL`, `RUN`, `CONFIGURE`, …).
- **Indent embedded commands 4+ spaces** so they stand out from the prose.
- Separate **top-level keys** (`repository:`, `paths:`, `models:`,
  `additionalFiles:`, `platforms:`, …) with blank lines. The leading header
  block (`manifestVersion` / `name` / `version` / `description`) is exempt.

## Functional examples — show real commands

The manifest description and/or README must contain **at least three distinct
runnable `swamp …` commands**. They must be real invocations, not templates:

- Good: `swamp model method run my-caddy checkHealth`
- Good: `swamp workflow run @svendowideit/meta-factory --input root=extensions`
- Bad: `swamp model method run <name> run` (placeholder)
- Bad: `swamp model create @me/tool my-extension …` (placeholder)

The scorer marks placeholder examples (`<name>`, `my-extension`, `example.com`,
`…`) as non-functional and reports them with a ⚠️.

## Explain every example — why and when

A command list with no context is not documentation. Every functional example
**except the self-evident `swamp extension pull`** must say why or when to run
it, via a comment immediately above it (or a sentence in prose):

```sh
# Gate one extension before publishing — fails if it scores below 75.
swamp workflow run @svendowideit/meta-factory \
  --input manifest=extensions/models/caddy/manifest.yaml

# Score the whole repo for a periodic health check.
swamp workflow run @svendowideit/meta-factory --input root=extensions
```

One comment may introduce a run of consecutive commands. The `explain` check
scores the explained fraction, so an unexplained command costs points and is
named in the report.

## The README section contract

Every extension README has these `##` sections, in this order:

| Section | Required | Contents |
| ------- | -------- | -------- |
| `## What it does` | yes | One short paragraph: problem, audience, side effects. |
| `## Install` | yes | The exact `swamp extension pull <name>` command. |
| `## Configuration` | yes | A markdown table of every global argument (name, type, default, meaning). |
| `## Examples` | yes* | Fenced commands showing the options in use. |
| `## Details` | yes | Models, methods, resources, prerequisites, caveats — plus how the code is structured and how to extend/test it. |

\* `## Examples` may be omitted only when the extension has **no configurable
global arguments** — there is nothing to exemplify. If `## Configuration` is
present, `## Examples` is required.

## Workflow: when you create or edit an extension

1. **Load the contract.** The canonical machine-readable definition is
   `extensions/meta-factory/quality-rubric.ts` (`SECTIONS`, `MANUAL_ELEMENTS`,
   `WEIGHTS`). The full published rubric is in
   [references/rubric.md](references/rubric.md); ready-to-adapt manifest and
   README skeletons are in [references/templates.md](references/templates.md).

2. **Draft the manifest manual.** Cover all six elements above. For a new
   extension, copy the skeleton from
   [references/templates.md](references/templates.md).

3. **Scaffold the README** (new extension, or one missing sections):

   ```sh
   swamp model @svendowideit/meta-factory method run scaffold \
     --global-arg root=. --input manifest=extensions/<type>/<name>/manifest.yaml
   ```

4. **Document every method.** The README `## Details` section (or `## Examples`)
   must name **every method** the extension's models expose, with its
   arguments. The coverage check fails when a method is unnamed.

5. **Score it.** Run the deterministic verification:

   ```sh
   swamp workflow run @svendowideit/meta-factory \
     --input manifest=extensions/<type>/<name>/manifest.yaml
   ```

   Or, for a single manifest without the workflow:

   ```sh
   swamp model @svendowideit/meta-factory method run check \
     --global-arg root=. --input manifest=extensions/<type>/<name>/manifest.yaml
   swamp report get @svendowideit/meta-factory-report \
     --model @svendowideit/meta-factory --markdown
   ```

6. **Fix below-threshold scores.** The report lists the exact failing checks and
   next actions. Re-run until the score clears the threshold (default 75).

7. **Score the whole repo.** Before publishing, or periodically:

   ```sh
   swamp workflow run @svendowideit/meta-factory --input root=extensions
   ```

## What the score measures

The 0-100 score is the weighted sum of seventeen deterministic checks. Full
detail in [references/rubric.md](references/rubric.md); the weights:

| Check | Points | What it verifies |
| ----- | ------ | ---------------- |
| Manifest name + description | 4 | `@collective/name`, non-placeholder description |
| **`WHAT IT DOES` is a short pitch** | **6** | 20–140 words, not a method dump |
| Manifest-as-user-manual | 8 | all six manual elements, 300+ chars |
| **Manual order (installs last)** | **5** | sections in canonical priority order |
| **No methods section in the manifest** | **5** | swamp-club generates the method reference at publish |
| **Single-step install** | **13** | one `swamp extension pull`, no extra setup |
| Manifest formatting | 5 | literal block, blank-line sections, indented commands |
| Functional examples | 7 | ≥3 distinct runnable `swamp …` commands, no placeholders |
| **Explained examples** | **7** | every non-install command says why/when to run it |
| Canonical README sections | 5 | the five visible sections above |
| README substance | 3 | ≥1200 chars, ≥1 table |
| README + LICENSE packaged | 6 | both listed in `additionalFiles:` |
| Platforms / repository / license | 4 | declared metadata |
| Artifacts declared | 4 | at least one model/report/etc. |
| README documents every method | 6 | coverage of model types and method names |
| Source symbols documented | 6 | JSDoc coverage via `deno doc --json` |
| No slow types | 3 | no slow-type codes in `deno doc --lint` stderr |
| Dependency trust | 3 | `swamp extension quality` audit (partial when offline) |

Maximum 100. `≥90` A, `≥75` B, `≥60` C, `≥40` D, else F. The default
"well documented" threshold is 75.

## Installing this skill

The skill ships inside the `@svendowideit/meta-factory` extension. Refresh the
project-local copy after the extension changes:

```sh
swamp model @svendowideit/meta-factory method run installSkill \
  --global-arg root=. --input target=both
```

Project installs land at `.agents/skills/extension-docs/`; global installs at
`~/.agents/skills/extension-docs/`. Restart opencode after installing so the
skill is re-scanned.

## Rules

1. **Never ship a manifest description that omits a manual element.** The
   description is the user manual, not a blurb.
2. **Never ship a README that omits a section** for an existing extension
   without noting why in the commit or issue.
3. **Never leave `description: TODO`.** It technically passes the low bar but
   wastes the strongest discovery signal an extension has.
4. **Prefer a table over prose** for configuration — tables are checked and are
   far easier to scan.
5. **Write the README for an extender.** The user already has the manifest
   manual; the README should explain structure, how to change it, and how to
   test it.
6. **Run the workflow, don't eyeball it.** The score is deterministic for a
   reason: a human guess is not a verification.
