import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  type VersionSourceFile,
  lintVersionSource,
  lintVersionSources,
} from "./version-source-lint.ts";

const CLEAN = `
import { z } from "npm:zod@4";

const MODEL_VERSION = "2026.01.01.1";

export const model = {
  type: "@me/tool",
  version: MODEL_VERSION,
  globalArguments: z.object({}),
  methods: {
    run: {
      description: "resolve the extension version from the manifest",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: { extensionFile: (p: string) => string },
      ) => {
        const manifestPath = context.extensionFile("");
        return { dataHandles: [], manifestPath };
      },
    },
  },
};
`;

Deno.test("clean source that reads the manifest has no version-source issues", () => {
  assertEquals(lintVersionSource(CLEAN), []);
});

Deno.test("flags model.version used as the extension version", () => {
  const source = `const v = model.version;`;
  const issues = lintVersionSource(source, "tool.ts");
  assertEquals(issues.length, 1);
  assertEquals(issues[0].rule, "model-version-used");
  assertEquals(issues[0].line, 1);
  assertEquals(issues[0].path, "tool.ts");
  assert(issues[0].message.includes("manifest.yaml"));
});

Deno.test("flags context.definition.version (the instance version)", () => {
  const source = [
    "execute: async (_args, context) => {",
    "  const v = context.definition.version;",
    "  return { dataHandles: [] };",
    "},",
  ].join("\n");
  const issues = lintVersionSource(source);
  assertEquals(issues.length, 1);
  assertEquals(issues[0].rule, "instance-version-used");
  assertEquals(issues[0].line, 2);
});

Deno.test("flags context.definition?.version (optional chaining)", () => {
  const issues = lintVersionSource(`const v = context.definition?.version;`);
  assertEquals(issues.length, 1);
  assertEquals(issues[0].rule, "instance-version-used");
});

Deno.test("an ignore comment on the line above exempts the reference", () => {
  const source = [
    "// swamp-quality-ignore version-source: staleness compares type versions",
    "const staleness = compare(instance.typeVersion, model.version);",
  ].join("\n");
  assertEquals(lintVersionSource(source), []);
});

Deno.test("an ignore comment on the same line exempts the reference", () => {
  const source =
    "const staleness = compare(t, model.version); // swamp-quality-ignore version-source: staleness";
  assertEquals(lintVersionSource(source), []);
});

Deno.test("prose about the rule is not flagged (comments are stripped)", () => {
  const source = "// do not use model.version for the extension version";
  assertEquals(lintVersionSource(source), []);
});

Deno.test("block comments and JSDoc are not flagged", () => {
  const source = [
    "/**",
    " * Never use model.version or context.definition.version here.",
    " */",
    "const x = 1;",
  ].join("\n");
  assertEquals(lintVersionSource(source), []);
});

Deno.test("the model's own schema version may differ from the extension version", () => {
  // The declared MODEL_VERSION (schema) is whatever the author wants; the rule
  // never compares it to the manifest version, so divergence is not flagged.
  const issues = lintVersionSource(CLEAN);
  assertEquals(issues, []);
});

Deno.test("lintVersionSources carries each file's path onto its issues", () => {
  const files: VersionSourceFile[] = [
    { path: "a.ts", source: "const x = model.version;" },
    { path: "b.ts", source: CLEAN },
    { path: "c.ts", source: "const y = context.definition.version;" },
  ];
  const issues = lintVersionSources(files);
  assertEquals(issues.length, 2);
  assertEquals(issues.map((i) => i.path), ["a.ts", "c.ts"]);
});
