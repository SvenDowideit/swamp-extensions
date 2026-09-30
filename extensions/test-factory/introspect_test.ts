import { assertEquals } from "jsr:@std/assert@1";
import { extractTypeFromSource, parseExtensionManifest } from "./introspect.ts";

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

Deno.test("parseExtensionManifest reads an inline list", () => {
  const m = parseExtensionManifest(
    `name: "@a/b"\nmodels: [one.ts, two.ts]\nplatforms: []\n`,
  );
  assertEquals(m.models, ["one.ts", "two.ts"]);
});

Deno.test("extractTypeFromSource finds the exported type", () => {
  const src =
    `export const model = {\n  type: "@acme/thing",\n  version: "1",\n};`;
  assertEquals(extractTypeFromSource(src), "@acme/thing");
  assertEquals(extractTypeFromSource("const x = 1;"), null);
});
