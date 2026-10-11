# Templates for a well-documented swamp extension

Ready-to-adapt skeletons that satisfy the meta-factory documentation contract
and every earnable Swamp Club factor.

## `manifest.yaml`

```yaml
manifestVersion: 1
name: "@mycollective/my-extension"
version: "2026.09.21.1"
description: >
  One sentence on what this extension does and who it is for.

  WHAT IT DOES

    One or two sentences (20–140 words): the problem it solves and why it is
    the better option than a similar extension. Do NOT list methods here.

  INSTALL

      swamp extension pull @mycollective/my-extension

  DEPENDENCIES

    None — it needs only the swamp CLI.

  RUN

      # Run the primary method to produce a result resource.
      swamp model method run my-model run

      # Run the bundled workflow to do the whole job end to end.
      swamp workflow run @mycollective/my-extension

  CONFIGURE

    Set the optional global arguments when creating the model, e.g.
    --global-arg exampleArg=value; override per call with --input force=true.

  SETUP

    Configuration is precious and cumulative. Run the setup method to see every
    detected value — including config this or another extension already saved —
    and how to change it; supplied values are persisted even when incomplete and
    each capability enables progressively. It verifies the actual state before
    reporting it and stops on a blocking failure. Only needed when the extension
    ships a setup method:

        swamp model method run my-model setup

  UPGRADE

    Upgrade an existing install with the bundled upgrade workflow; it rebuilds
    and reconciles anything on the host automatically and is idempotent:

        swamp workflow run @mycollective/my-extension-upgrade

  WHAT IT INSTALLS

    Nothing — no services, triggers, schedules, or webhooks on the host.

repository: https://github.com/mycollective/my-extension

license: MIT

paths:
  base: manifest

models:
  - my_model.ts

additionalFiles:
  - README.md
  - LICENSE.txt

platforms: []
```

Checklist: `name` is `@collective/name`; the `description` is a literal block
(`>`) covering every manual element **in order — `WHAT IT DOES` (a short
pitch, not a method list), `INSTALL`, `DEPENDENCIES`, `RUN`, `CONFIGURE`,
`SETUP` (only when the extension ships a `setup` method), `UPGRADE`, and
`WHAT IT INSTALLS` last** — 300+ chars, sections blank-line
separated, commands indented; the manifest has **no `METHODS` section**
(swamp-club generates the method reference at publish — put the method list in
the README); installing is a **single** `swamp extension pull`;
at least three runnable `swamp …` examples appear (no `<name>`/`example.com`
placeholders) and **every non-install example has a comment or sentence saying
why/when to run it**; `repository` is HTTPS on github.com / gitlab.com / codeberg.org /
bitbucket.org; `README.md` and a license file are in `additionalFiles:`;
top-level keys are blank-line separated; `platforms:` is empty (universal) or
has ≥2 entries.

## `README.md`

```markdown
# @mycollective/my-extension

One-paragraph elevator pitch, then a one-line pointer to the sections below.

## What it does

A short paragraph covering the problem solved, the audience, and any side
effects (files written, services started, APIs called). A reader should be able
to decide in 30 seconds whether this is relevant.

## Install

```sh
swamp extension pull @mycollective/my-extension
```

## Configuration

Set these global arguments when creating a model
(`swamp model create @mycollective/my-extension my-model --global-arg key=value`):

| Argument | Type | Default | Description |
| -------- | ---- | ------- | ----------- |
| `exampleArg` | string | `"default"` | What it controls. |
| `enableThing` | boolean | `false` | Whether to do the thing. |

## Setup

Configuration is precious and cumulative: `setup` reports every detected value
(including config this or another extension already saved) and how to change
it. Supplied values are persisted even when incomplete, and each capability
enables automatically as soon as its config is present. It reports **verified
reality, not intent** — it tests the actual outcome before reporting it, stops
on a blocking failure (rather than continuing and claiming success), and says
how long a long-lived change (DNS/TTL, a certificate) will take to be ready.

```sh
# Show detected/persisted config and how to change it.
swamp model method run my-model setup

# Persist a (partial) value so the next capability switches on.
swamp model method run my-model setup --input exampleArg=value
```

## Examples

```sh
# Create the model with a non-default option
swamp model create @mycollective/my-extension my-model \
  --global-arg exampleArg=value

# Run the primary method
swamp model method run my-model run
```

## Upgrade

Upgrade an existing install with the single bundled upgrade workflow: it
discovers the targets it manages (so you never have to know a name) and lists
them, migrates the model definition, rebuilds or reconciles anything on the
host, restarts services, prompts for anything it cannot infer, and is
idempotent.

```sh
# Upgrade an existing install in place; the workflow finds the targets itself.
swamp workflow run @mycollective/my-extension-upgrade
```

## Details

`@mycollective/my-extension` ships one model type. Every method it exposes:

| Method | Arguments | Produces |
| ------ | --------- | -------- |
| `run` | none | a `result` resource |
| `sync` | `force` (boolean) | updates the `state` resource |

Prerequisites: network access, a vault entry for `apiKey`. Resources are stored
with `lifetime: infinite`.

## License

MIT — see LICENSE.txt.
```

## Entrypoint skeleton — JSDoc-annotated TypeScript

Every exported declaration needs a JSDoc block for the `symbols` check, and
every exported function needs an explicit return type for `fasttypes`.

```ts
/**
 * Module-level doc: what this entrypoint is for and when it runs.
 *
 * @module
 */
import { z } from "npm:zod@4";

/** Accepted caller arguments for the model's operations. */
export const argsSchema = z.object({
  name: z.string().describe("The name of the thing to process."),
});

/** Resolved argument type. */
export type Args = z.infer<typeof argsSchema>;

/** Model definition for the thing. */
export const model = {
  type: "@mycollective/my-extension",
  version: "2026.09.21.1",
  globalArguments: z.object({
    exampleArg: z.string().default("default").describe("What it controls."),
  }),
  resources: {
    result: {
      description: "Operation output",
      schema: z.object({ ok: z.boolean() }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    run: {
      description: "Run the thing",
      arguments: argsSchema,
      execute: async (
        _args: Record<string, never>,
        context: {
          writeResource: (
            spec: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const handle = await context.writeResource("result", "current", {
          ok: true,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
```

## Pre-publish sequence

```sh
# Type-check and lint slow types
~/.swamp/deno/deno check my_model.ts
~/.swamp/deno/deno doc --lint my_model.ts   # empty output == clean

# Score the documentation
swamp workflow run @svendowideit/meta-factory \
  --input manifest=extensions/models/my-extension/manifest.yaml

# Verify the registry rubric too
swamp extension quality extensions/models/my-extension/manifest.yaml --json
```

## Common mistakes

| Mistake | Cost | Fix |
| ------- | ---- | --- |
| Missing `## Configuration` section | 1 section point + coverage ambiguity | Add the argument table |
| Configuration present but no `## Examples` | 1 section point | Add a fenced command block |
| `setup` method shipped but no `## Setup` section | 5 setup + 1 section point | Document the config lifecycle in `## Setup` |
| `setup` does not persist/read back config | 5 config-lifecycle points | `writeResource` the values (even partial) and read them back before asking; or add a `// meta-factory-ignore config-lifecycle: <reason>` |
| Setup reports intended state, not verified reality | setup points + a `report-reality` diagnostic | Test the real outcome before reporting it; stop on a blocking failure; report a long change's time-to-ready; or add `// meta-factory-ignore report-reality: <reason>` |
| Setup/upgrade continues past a failed prerequisite | `prerequisite-allow-failure` diagnostic | Make the blocking step `allowFailure: false` and gate dependents on `condition: succeeded` |
| Reports "serving on https://…" while a port/capability is missing | `claim-without-verification` diagnostic | Probe the actual port/endpoint before printing the URL; never instruct impossible URLs |
| No `## Upgrade` section, or no upgrade workflow | up to 5 upgrade points + 1 section point | Ship an idempotent `<name>-upgrade` workflow and document it in `## Upgrade` |
| One method not named in the README | coverage points | Add it to the `## Details` table |
| README shorter than 1200 chars | 2 substance points | Expand the sections with real content |
| No table in the README | 2 substance points | Use a table for configuration/methods |
| README not in `additionalFiles:` | 3 packaging points | Add `README.md` to the manifest |
| `description: TODO` | 4 manifest points | Write a real paragraph |
| Offline run without `offline=true` | dependency check reports partial slowly | Pass `--input offline=true` |
