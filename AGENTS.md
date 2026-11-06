<!-- BEGIN swamp managed section - DO NOT EDIT -->
# Project

This repository is managed with [swamp](https://github.com/swamp-club/swamp).

## Rules

1. **Search before you build.** When automating AWS, APIs, or any external service: (a) search community extensions with `swamp extension search <query>` — prefer `@swamp/*` official extensions first, (b) search local/installed types with `swamp behavior type search <query>`, (c) if a community extension exists, install it with `swamp extension pull <package>` instead of building from scratch, (d) extend an existing type if it covers the domain but lacks the method you need, (e) only create a custom extension behavior in `extensions/models/` as a last resort. Use the `swamp` skill for guidance. The `command/shell` behavior is ONLY for ad-hoc one-off shell commands, NEVER for wrapping CLI tools or building integrations.
2. **Extend, don't be clever.** When a behavior covers the domain but lacks the method you need, extend it with `export const extension` — don't bypass it with shell scripts, CLI tools, or multi-step hacks. One method, one purpose. Use `swamp behavior type describe <type> --json` to check available methods.
3. **Use the data model.** Once data exists in a behavior (via `lookup`, `start`, `sync`, etc.), reference it with CEL expressions. Don't re-fetch data that's already available.
4. **CEL expressions everywhere.** Wire behaviors together with CEL expressions. Always prefer `data.latest("<name>", "<dataName>").attributes.<field>` over the deprecated `model.<name>.resource.<spec>.<instance>.attributes.<field>` pattern.
5. **Verify before destructive operations.** Always `swamp behavior get <name> --json` and verify resource IDs before running delete/stop/destroy methods.
6. **Prefer fan-out methods over loops.** When operating on multiple targets, use a single method that handles all targets internally (factory pattern) rather than looping N separate `swamp behavior run` calls against the same behavior. Multiple parallel calls against the same behavior contend on the per-behavior lock, causing timeouts. A single fan-out method acquires the lock once and produces all outputs in one execution. Check `swamp behavior type describe` for methods that accept filters or produce multiple outputs.
7. **Extension npm deps are bundled; pin them.** Swamp's bundler inlines all npm packages (except zod) into extension bundles at bundle time. When the extension has a `deno.json`, the `deno.lock` beside it decides which versions are bundled; otherwise the registry's current release does. Always pin explicit versions in `npm:` and `jsr:` import specifiers (e.g., `npm:lodash-es@4.17.21`) — `swamp extension push` warns on unpinned and range specifiers.
8. **Reports for reusable data pipelines.** When the task involves building a repeatable pipeline to transform, aggregate, or analyze behavior output (security reports, cost analysis, compliance checks, summaries), create a report extension. Use the `swamp` skill for guidance.
9. **"Workflow" means a swamp workflow.** In this repository the word "workflow" (and "create/run/execute/validate/debug workflow", "automate", "orchestrate", "automated/nightly job") refers to a swamp workflow — a declarative YAML DAG of behavior-method steps authored via `swamp workflow create`. Load and follow the `swamp` skill for these requests. Do NOT interpret these as a request to build an agent task list, spin up worktrees, or schedule a cron/remote agent. Only use those orchestration mechanisms when the user explicitly names one (e.g. "task list", "subagent", "worktree", "cron", "remote agent") or explicitly asks you to do the work yourself step by step rather than author a swamp workflow.
10. **Use swamp, don't bypass it.** Always work through swamp commands — don't go around them with raw shell tools. Use `swamp data query` to find data, not `grep`/`find` on `.swamp/` files. Use behavior methods to interact with resources, not `curl`/`aws`/`gcloud`/`kubectl` when a behavior type already wraps that API — check with `swamp behavior type search`. Use `swamp help` for CLI discovery, not guesswork. Composing with swamp output is fine (e.g. piping `--json` through `jq`) — the anti-pattern is bypassing swamp entirely.
11. **Inspect reports after failures.** When a behavior method or workflow run fails, inspect its generated reports before retrying or changing definitions. Reports run even on failure and capture structured diagnostics — error messages, execution status, arguments, and data output pointers. Use `swamp report get @swamp/method-summary --model <model> --json` for method failures or `swamp report get @swamp/workflow-summary --workflow <workflow> --json` for workflow failures. Run `swamp help report get` to confirm current retrieval syntax.

## Skills

**IMPORTANT:** Always load swamp skills, even when in plan mode. The skills provide
essential context for working with this repository.

- `swamp` - Swamp CLI — behaviors, workflows, data, vaults, extensions, publishing, repos, reports, issues, and troubleshooting
- `swamp-getting-started` - Interactive onboarding for new swamp users

## Getting Started

If you were asked to read a task brief under `tasks/` (a file whose first
line is `<!-- swamp start brief v1 -->`), read that brief, then invoke the
`swamp-getting-started` skill and follow it from its brief entry point.

If the user is new to swamp or asks to get started, or a swamp command you
run shows this repository has no behaviors yet, invoke the
`swamp-getting-started` skill. It checks for existing behaviors itself and walks
new users through an interactive onboarding tutorial.

Otherwise, use the `swamp` skill to work with swamp behaviors.

## Commands

Use `swamp --help` to see available commands. For a machine-readable JSON
schema of the CLI (commands, options, arguments) intended for agent
consumption, run `swamp help [<command>...]` — e.g. `swamp help` returns
the full tree, and `swamp help behavior run` scopes to a subtree.

Behaviors (formerly models) are managed with `swamp behavior` — e.g.
`swamp behavior run <name> <method>` (or
`swamp behavior run @<type> <method> <name>` to run against a type
directly). Every `swamp model …` spelling remains supported.
<!-- END swamp managed section -->

## Existing extensions are mandatory — never bypass them

If a swamp extension exists that manages a resource, command, API, file, or
service, that extension is the **only** permitted way to read or change it.
This is a hard rule, not a preference.

### MUST

1. **Identify the owning extension first.** Before acting on a managed
   resource, run `swamp extension search <query>` and
   `swamp behavior type search <query>`, then read the extension's
   `manifest.yaml`, `README.md`, and
   `swamp behavior type describe <type> --json`.
2. **Use the extension's model methods for every read and write.** Wire them
   with CEL expressions and swamp workflows. Do not reimplement their parsing,
   validation, or side effects.
3. **Extend, don't bypass.** If the extension covers the domain but lacks the
   operation, add a method to the extension (`export const extension` or a new
   method) with tests. One method, one purpose.
4. **Fix the extension, not the symptom.** If the extension is broken, reproduce
   it with the extension's own methods, fix the extension and its tests, or stop
   and report. Do not work around it.

### NEVER

- Hand-edit a file or state the extension manages: Caddy config,
  `autosave.json`, Caddyfile, systemd units, DNS records, vault contents,
  extension model files, or extension data.
- Run the underlying tool or API directly when an extension wraps it:
  `caddy`, `systemctl --user`, `curl` to a managed API, `dig`/provider APIs for
  DNS managed by `@svendowideit/caddy`, raw `aws`/`gcloud`/`kubectl`, etc.
- Create a parallel script, ad-hoc `command/shell` model, or second extension
  to do the same job.
- "Unblock" a failing task by changing the extension's model data, desired
  state, config, or managed state by hand.
- Infer permission to bypass from "make it work", "make it live", or "finish
  it". Only an explicit instruction naming the extension and operation
  authorizes a change.

### STOP AND REPORT

Stop immediately and report when any of these is true:

- No extension exists (then follow the search-before-you-build rules).
- The extension lacks the method you need (extend it; do not bypass).
- The extension or its provider is failing (fix the extension or report it;
  do not bypass).
- Satisfying the request would require a direct edit or a direct call to a
  managed resource.

### Pre-action gate

Answer these before every mutating command:

1. Which extension owns this resource?
2. Which extension method am I calling?
3. Does this command write any file/data that extension manages? If yes, STOP.
4. Am I calling an underlying tool the extension wraps? If yes, STOP.
5. If the extension is missing or broken, have I stopped and reported instead
   of working around it?

### Forbidden examples in this repository

- Editing `~/.config/caddy/autosave.json` or running `caddy run` instead of
  using `swamp model @svendowideit/caddy method run ...`.
- Editing `models/@svendowideit/caddy/*.yaml` outside the approved swamp model
  workflow instead of using the extension's methods or
  `swamp model get ... | jq ... | swamp model edit ...`.
- Calling the Gandi API directly for DNS owned by `@svendowideit/caddy`.
- Hand-editing a systemd unit instead of using
  `@svendowideit/systemd-service`.
- Using `command/shell` to wrap a tool that an extension already manages.

## Tooling

- **Deno is bundled by swamp.** A Deno binary ships at `~/.swamp/deno/deno`.
  ALWAYS use that to run `deno test` / `deno check` / `deno bundle` — never
  install a separate Deno (e.g. via `curl ... | sh`). Verify with
  `~/.swamp/deno/deno --version`.

## Extension documentation contract

Any work on a swamp extension (`extensions/**/manifest.yaml` + `README.md`)
must follow the `extension-docs` skill's contract:

> The published manifest plus README must be enough for a user or agent to
> easily learn how to do everything the published extension does.

Two audiences:

- **The manifest `description:` is the user manual.** It must present, in this
  order — `WHAT IT DOES` (a **short pitch**: the problem it solves and why it
  is the better option, *not* a method list), `INSTALL`, `DEPENDENCIES`, `RUN`,
  `CONFIGURE`, and `WHAT IT INSTALLS` **last**. Do **not** add a `METHODS`
  section to the manifest: swamp-club generates a formatted method reference at
  publish time. **Installing must be a single `swamp extension pull`** — a
  multi-step install loses 13% of the score. Format it like
  `extensions/models/web-cache/manifest.yaml`: a literal block (`>`), blank
  lines between sections, embedded commands indented 4+ spaces, and
  blank-line-separated top-level keys.
- **The README is the extender/maintainer doc.** It must carry visible
  `## What it does`, `## Install`, `## Configuration` (argument table),
  `## Examples`, and `## Details` (every model + method named), plus enough
  structure for someone extending or fixing the extension. README and LICENSE
  must be in `additionalFiles:`.

Both the manifest and the README must contain **functional examples** — at
least three distinct runnable `swamp …` commands, with no `<name>` /
`example.com` placeholders — and must **explain each one**: every non-install
command needs a comment or sentence saying why or when to run it (the
one-line `swamp extension pull` is exempt). A bare command list is not
documentation.

Verify deterministically (never eyeball it):

```sh
swamp workflow run @svendowideit/meta-factory \
  --input manifest=extensions/<type>/<name>/manifest.yaml
```

Scores 0–100; the workflow fails if any scored extension is below the
threshold (default 75). Refresh the bundled skill with
`swamp model @svendowideit/meta-factory method run installSkill meta-factory
--input target=both`.

## Extension release hygiene

**Whenever you change an extension, prepare it for release and report it.**
Changing `extensions/<type>/<name>/**` (source, manifest, README, workflows,
bundled files) is not finished until the extension is release-ready:

1. **Bump the version.** Run `swamp extension version --manifest <manifest>`
   and set both the manifest `version:` and the model's `version:` to the
   returned `nextVersion` — they must match. Add or update the model's
   `upgrades:` entry (`toVersion` = the new version) when the model version
   moves.
2. **Verify.** Run the tests (`~/.swamp/deno/deno test`), `deno check`,
   `swamp extension fmt <manifest> --check`, `swamp workflow validate` for any
   workflow, and the meta-factory score.
3. **Record the adversarial review** for the new content hash (needed to push).
4. **Tell the user**, in the same message: the extension name, old → new
   version, what changed, the verification result, and the exact
   `swamp extension push` command to publish it. Publishing is a separate,
   outward-facing step — prepare and report it, but do not push unless asked.

This applies to every extension touched, including ones changed only as a
dependency of another (e.g. extending a shared release-installer). A change
that is committed but unpublished leaves other machines pulling a stale bundle
— the exact failure mode this rule exists to prevent.


