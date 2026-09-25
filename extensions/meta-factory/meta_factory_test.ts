/**
 * Unit tests for the meta-factory model, linters, and discovery helpers.
 *
 * @module
 */
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { lintManifest } from "./manifest-lint.ts";
import { lintReadme } from "./readme-lint.ts";
import {
  discoverManifests,
  extractMethodKeysFromSource,
  extractTypeFromSource,
  manifestsFromGitList,
  sanitizeInstanceName,
} from "./introspect.ts";
import { parseManifest } from "./quality-rubric.ts";
import { discoverGitManifests, model, type RunFn } from "./meta_factory.ts";
import { renderScore, renderSummary, report } from "./meta_factory_report.ts";

const GOOD_README = `# @me/tool

## What it does

Does a useful thing for a specific audience, writing a file and calling an API.

## Install

\`\`\`sh
swamp extension pull @me/tool
\`\`\`

## Configuration

| Argument | Type | Default | Description |
| -------- | ---- | ------- | ----------- |
| \`path\` | string | \`"."\` | Where to work. |

## Examples

\`\`\`sh
swamp model create @me/tool t --global-arg path=/tmp
\`\`\`

## Details

Some details about the model and its methods.
`;

const GOOD_MANIFEST = `manifestVersion: 1
name: "@me/tool"
version: "2026.09.21.1"
description: >
  A small tool that ships one model and one report for a specific audience.

  WHAT IT DOES

    Reads a configured path, validates it, and writes one result resource, so
    you get a single deterministic answer without hand-running shell tools.

  INSTALL

      swamp extension pull @me/tool

  DEPENDENCIES

    None — it is self-contained and needs only the swamp CLI.

  RUN

      swamp model method run my-tool run

  CONFIGURE

    Set the optional global arguments when creating the model, e.g.
    --global-arg path=/tmp, or override per call with --input.

  WHAT IT INSTALLS

    Nothing — no services, triggers, schedules, or webhooks.

repository: https://github.com/me/tool

additionalFiles:
  - README.md
  - LICENSE.txt

models:
  - tool.ts
`;

Deno.test("lintManifest passes a good manifest", () => {
  const result = lintManifest(parseManifest(GOOD_MANIFEST), {
    hasReadme: true,
  });
  assertEquals(result.ok, true);
  assertEquals(result.issues, []);
});

Deno.test("lintManifest flags placeholder description and missing artifacts", () => {
  const result = lintManifest(
    parseManifest('name: "@a/b"\nversion: "2026.1.1.1"\ndescription: TODO\n'),
    { hasReadme: false },
  );
  assertEquals(result.ok, false);
  const rules = result.issues.map((i) => i.rule);
  assertStringIncludes(rules.join(","), "description");
  assertStringIncludes(rules.join(","), "artifacts");
  assertStringIncludes(rules.join(","), "readme-packaged");
});

Deno.test("lintReadme passes the contract README", () => {
  const result = lintReadme(GOOD_README, parseManifest(GOOD_MANIFEST));
  assertEquals(result.ok, true);
});

Deno.test("lintReadme flags a missing configuration table", () => {
  const md = GOOD_README.replace(
    "| -------- | ---- | ------- | ----------- |",
    "not a table",
  );
  const result = lintReadme(md, parseManifest(GOOD_MANIFEST));
  assertEquals(result.ok, false);
  const rules = result.issues.map((i) => i.rule);
  assertStringIncludes(rules.join(","), "config-table");
});

Deno.test("lintReadme flags missing sections", () => {
  const result = lintReadme(
    "# x\n\n## What it does\n\nsomething\n",
    parseManifest(GOOD_MANIFEST),
  );
  assertEquals(result.ok, false);
  assertStringIncludes(
    result.issues.map((i) => i.rule).join(","),
    "missing-section",
  );
});

Deno.test("lintReadme does not flag adjacent non-empty blocks", () => {
  const md = GOOD_README.replace(
    "swamp extension pull @me/tool",
    "swamp extension pull @me/tool\n```\n\n```sh\necho hi",
  );
  const result = lintReadme(md, parseManifest(GOOD_MANIFEST));
  assertEquals(
    result.issues.some((i) => i.rule === "empty-code-block"),
    false,
  );
});

Deno.test("extractTypeFromSource finds the type literal", () => {
  assertEquals(
    extractTypeFromSource('const tool = {\n  type: "@me/tool",'),
    "@me/tool",
  );
  assertEquals(extractTypeFromSource("const x = 1;"), null);
});

Deno.test("extractMethodKeysFromSource reads top-level method keys", () => {
  const src = `const tool = {
  type: "@me/tool",
  methods: {
    run: {
      description: "x",
    },
    sync: {
      description: "y",
    },
  },
};`;
  assertEquals(extractMethodKeysFromSource(src), ["run", "sync"]);
});

Deno.test("extractMethodKeysFromSource ignores nested object keys", () => {
  const src = `const tool = {
  type: "@me/tool",
  methods: {
    run: {
      arguments: {
        args: { foo: 1 },
        other: { bar: 2 },
      },
    },
    sync: { description: "y" },
  },
};`;
  assertEquals(extractMethodKeysFromSource(src), ["run", "sync"]);
});

Deno.test("extractMethodKeysFromSource returns empty without methods", () => {
  assertEquals(extractMethodKeysFromSource("const x = 1;"), []);
});

Deno.test("sanitizeInstanceName is filesystem-safe", () => {
  assertEquals(
    sanitizeInstanceName("extensions/models/my-ext/manifest.yaml"),
    "extensions-models-my-ext-manifest.yaml",
  );
  assertEquals(sanitizeInstanceName("a b/c"), "a-b-c");
});

Deno.test("discoverManifests finds manifests under a fixtures tree", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${root}/a`, { recursive: true });
    await Deno.mkdir(`${root}/b`, { recursive: true });
    await Deno.writeTextFile(`${root}/a/manifest.yaml`, "name: a\n");
    await Deno.writeTextFile(`${root}/b/manifest.yaml`, "name: b\n");
    await Deno.writeTextFile(`${root}/b/README.md`, "# b\n");
    const found = await discoverManifests(root);
    assertEquals(found.length, 2);
    assertEquals(found.map((f) => f.relative).sort(), [
      "a/manifest.yaml",
      "b/manifest.yaml",
    ]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("model exposes the five documented methods", () => {
  assertEquals(Object.keys(model.methods).sort(), [
    "check",
    "checkAll",
    "installSkill",
    "lintDefinitions",
    "scaffold",
  ]);
  assertEquals(typeof model.type, "string");
});

Deno.test("model has an upgrade entry for its current version", () => {
  const upgrades = model.upgrades ?? [];
  const entry = upgrades.find((u) => u.toVersion === model.version);
  assertEquals(entry !== undefined, true);
});

Deno.test("the definitionsRoot/auditHours upgrade seeds the new globals", () => {
  const upgrades = model.upgrades ?? [];
  const entry = upgrades.find((u) => u.toVersion === "2026.09.23.1");
  assertEquals(entry !== undefined, true);
  // That upgrade seeds the two globals it introduced with their defaults, and
  // must not clobber an existing value.
  const migrated = entry!.upgradeAttributes({ root: "extensions" });
  assertEquals(migrated.definitionsRoot, ".");
  assertEquals(migrated.auditHours, 168);
  const kept = entry!.upgradeAttributes({
    definitionsRoot: "src",
    auditHours: 5,
  });
  assertEquals(kept.definitionsRoot, "src");
  assertEquals(kept.auditHours, 5);
});

Deno.test("report renders a score card", () => {
  const md = renderScore({
    name: "@me/tool",
    manifest: "manifest.yaml",
    score: 88,
    grade: "B",
    earned: 88,
    earnedMax: 100,
    wellDocumented: true,
    checks: [{
      id: "manifest",
      label: "Manifest",
      earned: 6,
      max: 6,
      status: "pass",
    }],
    coverage: [{ type: "@me/tool", name: "run", documented: true }],
    examples: [],
    nextActions: [],
    manifestLint: [],
    readmeLint: [],
    definitionIssues: [],
  });
  assertStringIncludes(md, "@me/tool — 88/100 (B)");
  assertStringIncludes(md, "well documented");
});

Deno.test("report renders a summary rollup", () => {
  const md = renderSummary({
    root: "extensions",
    threshold: 75,
    count: 2,
    averageScore: 80,
    passCount: 1,
    failCount: 1,
    belowThreshold: [{
      name: "@me/bad",
      manifest: "bad/manifest.yaml",
      score: 40,
      topIssues: ["sections: missing `## Install`"],
    }],
    scores: [
      {
        name: "@me/good",
        manifest: "good/manifest.yaml",
        score: 95,
        grade: "A",
      },
      { name: "@me/bad", manifest: "bad/manifest.yaml", score: 40, grade: "D" },
    ],
  });
  assertStringIncludes(md, "average **80/100**");
  assertStringIncludes(md, "Below threshold (1)");
  assertEquals(typeof report.name, "string");
});

Deno.test("manifestsFromGitList keeps only manifest.yaml paths", () => {
  const entries = manifestsFromGitList("/repo", [
    "extensions/meta-factory/manifest.yaml",
    "extensions/meta-factory/README.md",
    ".swamp/pulled-extensions/@me/tool/manifest.yaml",
    "extensions/models/tool/manifest.yaml",
    "",
  ]);
  assertEquals(
    entries.map((e) => e.relative),
    [
      "extensions/meta-factory/manifest.yaml",
      "extensions/models/tool/manifest.yaml",
    ],
  );
  assertEquals(entries[0].path, "/repo/extensions/meta-factory/manifest.yaml");
  assertEquals(entries[0].dir, "/repo/extensions/meta-factory");
});

Deno.test("discoverGitManifests returns null when git fails", async () => {
  const runner: RunFn = () =>
    Promise.resolve({ stdout: "", stderr: "not a git repo", code: 128 });
  assertEquals(await discoverGitManifests(runner, "/repo"), null);
});

Deno.test("discoverGitManifests parses git ls-files output", async () => {
  const runner: RunFn = (_bin, _args, cwd) => {
    assertEquals(cwd, "/repo");
    return Promise.resolve({
      stdout:
        "extensions/models/a/manifest.yaml\nextensions/models/b/manifest.yaml\n",
      stderr: "",
      code: 0,
    });
  };
  const entries = await discoverGitManifests(runner, "/repo");
  assertEquals(entries?.map((e) => e.relative), [
    "extensions/models/a/manifest.yaml",
    "extensions/models/b/manifest.yaml",
  ]);
});
