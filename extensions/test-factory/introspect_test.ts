import { assertEquals } from "jsr:@std/assert@1";
import { join } from "jsr:@std/path@1";
import {
  extractTypeFromSource,
  inspectExtension,
  parseExtensionManifest,
} from "./introspect.ts";

const MANIFEST = `manifestVersion: 1
name: "@acme/thing"
version: "2026.01.01.1"
description: >
  A thing that does things.

  WHAT IT DOES

    Does the thing.
models:
  - thing.ts
  - other.ts
workflows:
  - thing-flow.yaml
reports:
  - thing_report.ts
additionalFiles:
  - README.md
platforms: []
`;

Deno.test("parseExtensionManifest reads identity and lists", () => {
  const m = parseExtensionManifest(MANIFEST);
  assertEquals(m.name, "@acme/thing");
  assertEquals(m.version, "2026.01.01.1");
  assertEquals(m.models, ["thing.ts", "other.ts"]);
  assertEquals(m.workflows, ["thing-flow.yaml"]);
  assertEquals(m.reports, ["thing_report.ts"]);
  assertEquals(m.vaults, []);
});

Deno.test("parseExtensionManifest stops a list at the next top-level key", () => {
  const m = parseExtensionManifest(MANIFEST);
  assertEquals(m.models.includes("additionalFiles"), false);
  assertEquals(m.models.includes("README.md"), false);
});

Deno.test("parseExtensionManifest reads additionalFiles", () => {
  const m = parseExtensionManifest(MANIFEST);
  assertEquals(m.additionalFiles, ["README.md"]);
});

Deno.test("parseExtensionManifest reads an inline list", () => {
  const m = parseExtensionManifest(
    `name: "@a/b"\nmodels: [one.ts, two.ts]\nplatforms: []\n`,
  );
  assertEquals(m.models, ["one.ts", "two.ts"]);
});

Deno.test("extractTypeFromSource finds the exported type", () => {
  // Concatenated so the loader's raw-text scan does not register this fixture
  // as a real model (which would collide on `@acme/thing` across test files).
  const src = `export const ` +
    `model = {\n  type: "@acme/thing",\n  version: "1",\n};`;
  assertEquals(extractTypeFromSource(src), "@acme/thing");
  assertEquals(extractTypeFromSource("const x = 1;"), null);
});

Deno.test("extractTypeFromSource ignores a union-valued type field", () => {
  // A model like @svendowideit/caddy also has `type: "A" | "AAAA" | "CNAME";`
  // on a record schema; that must not be reported as the model type.
  const src = `const Record = {\n  type: "A" | "AAAA" | "CNAME",\n};\n` +
    `export const ` + `model = {\n  type: "@acme/thing",\n};`;
  assertEquals(extractTypeFromSource(src), "@acme/thing");
  assertEquals(
    extractTypeFromSource(`const r = { type: "A" | "AAAA" | "CNAME" };`),
    null,
  );
});

Deno.test("inspectExtension discovers test-factory.yaml from additionalFiles", async () => {
  const dir = await Deno.makeTempDir({ prefix: "tf-intro-" });
  try {
    await Deno.writeTextFile(
      join(dir, "manifest.yaml"),
      `manifestVersion: 1
name: "@acme/thing"
version: "1"
models:
  - thing.ts
additionalFiles:
  - README.md
  - acceptance/test-factory.yaml
`,
    );
    await Deno.writeTextFile(
      join(dir, "thing.ts"),
      `export const ` + `model = { type: "@acme/thing", version: "1" };`,
    );
    const info = await inspectExtension(join(dir, "manifest.yaml"));
    assertEquals(
      info.testsPath,
      join(dir, "acceptance", "test-factory.yaml"),
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("inspectExtension leaves testsPath empty when no tests file ships", async () => {
  const dir = await Deno.makeTempDir({ prefix: "tf-intro-" });
  try {
    await Deno.writeTextFile(
      join(dir, "manifest.yaml"),
      `manifestVersion: 1
name: "@acme/thing"
version: "1"
models:
  - thing.ts
additionalFiles:
  - README.md
`,
    );
    await Deno.writeTextFile(
      join(dir, "thing.ts"),
      `export const ` + `model = { type: "@acme/thing", version: "1" };`,
    );
    const info = await inspectExtension(join(dir, "manifest.yaml"));
    assertEquals(info.testsPath, "");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
