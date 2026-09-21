/**
 * Unit tests for the meta-factory documentation scorer.
 *
 * @module
 */
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  checkExamples,
  checkExplain,
  checkFormat,
  checkInstallStep,
  checkManifest,
  checkManual,
  checkNoMethodsSection,
  checkOrder,
  checkPackaging,
  checkPitch,
  checkSections,
  checkSubstance,
  checkSymbols,
  countCodeBlocks,
  declaredArtifactFiles,
  extractExamples,
  extractExplainedExamples,
  gradeFor,
  MAX_SCORE,
  parseManifest,
  readmeHeadings,
  renderReadmeTemplate,
  scoreExtension,
  sectionBody,
  sectionPresent,
  SECTIONS,
  WEIGHTS,
} from "./quality-rubric.ts";

const GOOD_README = `# @me/tool

A small swamp extension that does a useful thing for a specific audience. This
first paragraph is intentionally substantive so the README clears the minimum
substance bar: it explains the problem, the audience, and the side effects.

## What it does

Does a useful thing for a specific audience, writing a file and calling an API.
It reads the configured path, validates it, and writes a single result resource.
Nothing else on the host is touched.

## Install

\`\`\`sh
swamp extension pull @me/tool
\`\`\`

## Configuration

Set these global arguments when creating a model:

| Argument | Type | Default | Description |
| -------- | ---- | ------- | ----------- |
| \`path\` | string | \`"."\` | Where to work. |
| \`verbose\` | boolean | \`false\` | Log extra detail. |

## Examples

\`\`\`sh
# Create the model, pointing it at the directory you want to inspect.
swamp model create @me/tool t --global-arg path=/tmp

# Run the primary method to produce the result resource.
swamp model method run t run

# Force a re-run even when a result already exists.
swamp model method run t run --input force=true
\`\`\`

## Details

| Method | Arguments | Produces |
| ------ | --------- | -------- |
| \`run\` | none | a \`result\` resource |

Prerequisites: none beyond the swamp CLI. The result resource uses
\`lifetime: infinite\` and keeps ten versions. Re-running is idempotent because
the previous result is overwritten in place rather than appended.
`;

const GOOD_MANIFEST = `manifestVersion: 1
name: "@me/tool"
version: "2026.09.21.1"
description: >
  A small tool that ships one model and one report for a specific audience.

  WHAT IT DOES

    Reads a configured path, validates it, and writes one result resource, so
    you get a single, deterministic answer without hand-running shell tools.
    Prefer it over ad-hoc scripts when you need a repeatable, auditable result.

  INSTALL

      swamp extension pull @me/tool

  DEPENDENCIES

    None — it is self-contained and needs only the swamp CLI.

  RUN

      # Run the primary method to produce a result resource.
      swamp model method run my-tool run

      # Run the bundled workflow to do the whole job end to end.
      swamp workflow run @me/tool

  CONFIGURE

    Set the optional global arguments when creating the model, e.g.
    --global-arg path=/tmp, or override per call with --input.

  WHAT IT INSTALLS

    Nothing — no services, triggers, schedules, or webhooks.

repository: https://github.com/me/tool

license: MIT

additionalFiles:
  - README.md
  - LICENSE.txt

models:
  - tool.ts

platforms: []
`;

Deno.test("parseManifest parses fields", () => {
  const m = parseManifest(GOOD_MANIFEST);
  assertEquals(m.name, "@me/tool");
  assertEquals(m.models, ["tool.ts"]);
  assertEquals(m.platforms, []);
});

Deno.test("declaredArtifactFiles collects across content types", () => {
  const m = parseManifest(`name: "@a/b"
models: [x.ts]
reports: [r.ts]
workflows: [w.yaml]
skills: [s]
`);
  assertEquals(declaredArtifactFiles(m).sort(), [
    "r.ts",
    "s",
    "w.yaml",
    "x.ts",
  ]);
});

Deno.test("countCodeBlocks counts fenced pairs", () => {
  assertEquals(countCodeBlocks("```sh\nx\n```"), 1);
  assertEquals(countCodeBlocks("```sh\nx\n```\n\n```ts\ny\n```"), 2);
  assertEquals(countCodeBlocks("no fences"), 0);
});

Deno.test("readmeHeadings lowercases all headings", () => {
  assertEquals(readmeHeadings("# Title\n## What it does\n"), [
    "title",
    "what it does",
  ]);
});

Deno.test("sectionPresent requires a substantive body", () => {
  const spec = SECTIONS[0];
  assertEquals(sectionPresent("## What it does\n\nreal text here", spec), true);
  assertEquals(sectionPresent("## What it does\n\n", spec), false);
  assertEquals(sectionPresent("# nothing", spec), false);
});

Deno.test("sectionBody stops at the next equal heading", () => {
  const body = sectionBody(
    "## Install\n\nstep\n\n## Examples\n\nx",
    SECTIONS[1],
  );
  assertEquals(body, "step");
});

Deno.test("checkManifest rewards a valid name and real description", () => {
  const good = checkManifest(parseManifest(GOOD_MANIFEST));
  assertEquals(good.earned, WEIGHTS.manifest);
  const bad = checkManifest(parseManifest('name: "nope"\ndescription: TODO\n'));
  assertEquals(bad.earned, 0);
});

Deno.test("checkManual passes a complete user manual", () => {
  const check = checkManual(parseManifest(GOOD_MANIFEST));
  assertEquals(check.earned, WEIGHTS.manual);
  assertEquals(check.status, "pass");
});

Deno.test("checkManual names the missing manual elements", () => {
  const check = checkManual(
    parseManifest('name: "@a/b"\ndescription: "Nope."\n'),
  );
  assertStringIncludes(check.note ?? "", "install");
  assertStringIncludes(check.note ?? "", "run");
  assertEquals(check.status, "fail");
});

Deno.test("checkOrder passes sections in canonical order", () => {
  const check = checkOrder(GOOD_MANIFEST);
  assertEquals(check.earned, WEIGHTS.order);
  assertEquals(check.status, "pass");
});

Deno.test("checkPitch passes a short pitch", () => {
  const check = checkPitch(GOOD_MANIFEST);
  assertEquals(check.earned, WEIGHTS.pitch);
  assertEquals(check.status, "pass");
});

Deno.test("checkPitch rejects a method dump in WHAT IT DOES", () => {
  const dump = GOOD_MANIFEST.replace(
    / {2}WHAT IT DOES\n\n(.*?)\n\n {2}INSTALL/s,
    `  WHAT IT DOES

    A tool.

      run      Does a thing.
      sync     Does another thing.
      reset    Does a third thing.

  INSTALL`,
  );
  const check = checkPitch(dump);
  assertEquals(check.status !== "pass", true);
  assertStringIncludes(check.note ?? "", "method");
});

Deno.test("checkNoMethodsSection rejects a methods section in the manifest", () => {
  const withMethods = GOOD_MANIFEST.replace(
    /( {2}WHAT IT INSTALLS\n\n[^\n]*\n)/,
    `$1\n  METHODS\n\n    run   Read the configured path and write a result resource.\n`,
  );
  const check = checkNoMethodsSection(withMethods);
  assertEquals(check.earned, 0);
  assertEquals(check.status, "fail");
  assertStringIncludes(check.note ?? "", "remove the methods section");
});

Deno.test("checkNoMethodsSection passes a manifest without one", () => {
  const check = checkNoMethodsSection(GOOD_MANIFEST);
  assertEquals(check.earned, WEIGHTS.noMethods);
  assertEquals(check.status, "pass");
});

Deno.test("checkOrder penalises WHAT IT INSTALLS appearing early", () => {
  const reordered = GOOD_MANIFEST.replace(
    /description: >\n([\s\S]*?)\nrepository:/,
    (_m, body) => {
      // Move the WHAT IT INSTALLS block to the top of the manual.
      const lines = (body as string).split("\n");
      const start = lines.findIndex((l) => /WHAT IT INSTALLS/.test(l));
      const block = lines.splice(start, lines.length - start);
      return `description: >\n${
        [...block, "", ...lines].join("\n")
      }\nrepository:`;
    },
  );
  const check = checkOrder(reordered);
  assertEquals(check.status !== "pass", true);
  assertStringIncludes(check.note ?? "", "WHAT IT INSTALLS");
});

Deno.test("checkInstallStep passes a single pull", () => {
  const check = checkInstallStep(GOOD_MANIFEST);
  assertEquals(check.earned, WEIGHTS.install);
  assertEquals(check.status, "pass");
});

Deno.test("checkInstallStep fails a multi-step install (13% penalty)", () => {
  const multi = GOOD_MANIFEST.replace(
    "  INSTALL\n\n      swamp extension pull @me/tool",
    "  INSTALL\n\n      swamp extension source add ./extensions/tool\n\n      swamp extension pull @me/tool",
  );
  const check = checkInstallStep(multi);
  assertEquals(check.earned, 0);
  assertEquals(check.status, "fail");
  assertEquals(WEIGHTS.install, 13);
});

Deno.test("checkSections passes a full contract README", () => {
  const check = checkSections(GOOD_README, parseManifest(GOOD_MANIFEST));
  assertEquals(check.earned, WEIGHTS.sections);
});

Deno.test("checkSections errors on a missing section", () => {
  const noInstall = GOOD_README.replace("## Install", "## Nope");
  const check = checkSections(noInstall, parseManifest(GOOD_MANIFEST));
  assertEquals(check.status, "partial");
  assertStringIncludes(check.note ?? "", "Install");
});

Deno.test("checkSections auto-credits Examples when Configuration is absent", () => {
  const noConfig =
    `# x\n\n## What it does\n\nSomething useful here for a reader.\n\n## Install\n\n\`\`\`sh\nswamp extension pull x\n\`\`\`\n\n## Details\n\nSome details about the model and its methods.\n`;
  const check = checkSections(noConfig, parseManifest(GOOD_MANIFEST));
  assertStringIncludes(check.note ?? "", "Configuration");
  assertEquals(check.earned, WEIGHTS.sections - 1);
});

Deno.test("checkSubstance requires length, blocks, and a table", () => {
  const check = checkSubstance(GOOD_README);
  assertEquals(check.earned, WEIGHTS.substance);
  const thin = checkSubstance("# x\n\nshort");
  assertEquals(thin.earned, 0);
});

Deno.test("checkPackaging requires README and license files", () => {
  const good = checkPackaging(parseManifest(GOOD_MANIFEST));
  assertEquals(good.earned, WEIGHTS.packaging);
  const bad = checkPackaging(
    parseManifest('name: "@a/b"\nadditionalFiles: [foo.txt]\n'),
  );
  assertEquals(bad.earned, 0);
});

Deno.test("checkSymbols scores JSDoc coverage fraction", () => {
  const docJson = {
    nodes: {
      "file:///a.ts": {
        symbols: [
          { declarations: [{ jsDoc: { doc: "documented" } }] },
          { declarations: [{ jsDoc: {} }] },
        ],
      },
    },
  };
  const check = checkSymbols(docJson);
  assertEquals(check.earned, WEIGHTS.symbols / 2);
  assertEquals(check.status, "partial");
});

Deno.test("checkFormat passes a well-spaced manifest", () => {
  const check = checkFormat(GOOD_MANIFEST);
  assertEquals(check.earned, WEIGHTS.format);
  assertEquals(check.status, "pass");
});

Deno.test("checkFormat flags an inline one-line description", () => {
  const flat = `manifestVersion: 1
name: "@me/tool"
description: "one long line that is not a literal block and has no spacing at all"
models:
  - tool.ts
`;
  const check = checkFormat(flat);
  assertStringIncludes(check.note ?? "", "literal block");
  assertEquals(check.status, "partial");
});

Deno.test("checkFormat flags a description without blank-line separation", () => {
  const dense = `manifestVersion: 1
name: "@me/tool"
description: >
  Line one of the manual.
  Line two immediately after with no blank line.
  Line three.

models:
  - tool.ts
`;
  const check = checkFormat(dense);
  assertStringIncludes(check.note ?? "", "blank lines");
  assertEquals(check.status, "partial");
});

Deno.test("extractExamples finds swamp invocations only", () => {
  const text = `Some prose.
swamp model method run my-model run
# a comment
swamp workflow run my-flow
echo not-a-swamp-command
  swamp extension pull @me/tool`;
  const found = extractExamples(text);
  assertEquals(found.length, 3);
  assertStringIncludes(found[0], "swamp model method run");
});

Deno.test("checkExamples rewards distinct functional commands", () => {
  const manifest = `description: >
  MANUAL

      swamp extension pull @me/tool

      swamp model method run my-model run

      swamp workflow run @me/tool

models:
  - tool.ts
`;
  const { check, examples } = checkExamples(manifest, "");
  assertEquals(check.earned, WEIGHTS.examples);
  assertEquals(examples.filter((e) => e.functional).length, 3);
});

Deno.test("extractExplainedExamples attributes a comment to its command", () => {
  const text = `\`\`\`sh
# Run the primary method to produce a result resource.
swamp model method run t run

# Run the whole job end to end.
swamp workflow run @me/tool
\`\`\``;
  const found = extractExplainedExamples(text);
  assertEquals(found.length, 2);
  assertEquals(found[0].explained, true);
  assertEquals(found[1].explained, true);
});

Deno.test("extractExplainedExamples leaves a bare command list unexplained", () => {
  const text = `## Examples

\`\`\`sh
swamp model method run t run
swamp workflow run @me/tool
\`\`\``;
  const found = extractExplainedExamples(text);
  assertEquals(found.length, 2);
  assertEquals(found[0].explained, false);
  assertEquals(found[1].explained, false);
});

Deno.test("extractExplainedExamples lets prose introduce a block", () => {
  const text = `Compiling in extra modules needs a different create command:

\`\`\`sh
swamp model create @me/tool t --global-arg 'plugins:json=["a/b"]'
swamp model method run t install
\`\`\``;
  const found = extractExplainedExamples(text);
  assertEquals(found.length, 2);
  assertEquals(found[0].explained, true);
  assertEquals(found[1].explained, true);
});

Deno.test("checkExplain passes when every command is explained", () => {
  const examples = [
    {
      source: "manifest" as const,
      command: "swamp extension pull @me/tool",
      functional: true,
      explained: false,
    },
    {
      source: "manifest" as const,
      command: "swamp model method run t run",
      functional: true,
      explained: true,
    },
  ];
  const check = checkExplain(examples);
  assertEquals(check.earned, WEIGHTS.explain);
  assertEquals(check.status, "pass");
});

Deno.test("checkExplain fails an unexplained command", () => {
  const examples = [
    {
      source: "readme" as const,
      command: "swamp model method run t run",
      functional: true,
      explained: false,
    },
    {
      source: "readme" as const,
      command: "swamp workflow run @me/tool",
      functional: true,
      explained: true,
    },
  ];
  const check = checkExplain(examples);
  assertEquals(check.earned, Math.round(WEIGHTS.explain / 2));
  assertStringIncludes(check.note ?? "", "no explanation");
});

Deno.test("checkExplain exempts the self-evident install command", () => {
  const check = checkExplain([
    {
      source: "manifest" as const,
      command: "swamp extension pull @me/tool",
      functional: true,
      explained: false,
    },
  ]);
  assertEquals(check.earned, WEIGHTS.explain);
  assertEquals(check.status, "pass");
});

Deno.test("checkExamples rejects placeholder commands", () => {
  const manifest = `description: >
  Run:

      swamp model method run <name> run

models:
  - tool.ts
`;
  const { check, examples } = checkExamples(manifest, "");
  assertEquals(check.status, "fail");
  assertEquals(examples[0].functional, false);
});

Deno.test("gradeFor maps score bands", () => {
  assertEquals(gradeFor(95), "A");
  assertEquals(gradeFor(80), "B");
  assertEquals(gradeFor(65), "C");
  assertEquals(gradeFor(45), "D");
  assertEquals(gradeFor(10), "F");
});

Deno.test("scoreExtension totals to MAX_SCORE for a perfect extension", () => {
  const result = scoreExtension({
    manifest: parseManifest(GOOD_MANIFEST),
    manifestSource: GOOD_MANIFEST,
    readme: GOOD_README,
    types: ["@me/tool"],
    methodsByType: { "@me/tool": ["run"] },
    docJson: {
      nodes: {
        "file:///a.ts": {
          symbols: [{ declarations: [{ jsDoc: { doc: "x" } }] }],
        },
      },
    },
    lintStdout: "",
    depsAudited: true,
    depsPassed: true,
  });
  assertEquals(result.earnedMax, MAX_SCORE);
  assertEquals(result.score, 100);
  assertEquals(result.grade, "A");
  assertEquals(result.coverage.length, 1);
  assertEquals(result.nextActions.length, 0);
});

Deno.test("scoreExtension flags an undocumented method", () => {
  const result = scoreExtension({
    manifest: parseManifest(GOOD_MANIFEST),
    readme: GOOD_README,
    types: ["@me/tool"],
    methodsByType: { "@me/tool": ["run", "unlistedMethod"] },
    lintStdout: "",
    depsAudited: false,
  });
  const missing = result.coverage.filter((c) => !c.documented);
  assertEquals(missing.map((c) => c.name), ["unlistedMethod"]);
  assertEquals(result.nextActions.some((a) => a.startsWith("coverage")), true);
});

Deno.test("renderReadmeTemplate produces every canonical section", () => {
  const md = renderReadmeTemplate(parseManifest(GOOD_MANIFEST));
  for (const spec of SECTIONS) {
    assertStringIncludes(md, `## ${spec.heading}`);
  }
});
