import { assertEquals } from "jsr:@std/assert@1";
import {
  parseGitLsFiles,
  parseGitStatusPorcelain,
  parseManifest,
  parseModelVersion,
  parseReviewFilename,
  parseUpgradesToVersion,
  parseUpstreamExtensions,
  reviewStateFromWarnings,
} from "./introspect.ts";

const MANIFEST = `manifestVersion: 1
name: "@svendowideit/thing"
version: "2026.10.05.1"
description: >
  A thing that does things.

  WHAT IT DOES

    Does the thing.
dependencies:
  - "@svendowideit/web-cache"
  - "@magistr/obsidian-vault"
models:
  - thing.ts
  - helper.ts
workflows:
  - thing-flow.yaml
reports: []
additionalFiles:
  - README.md
  - acceptance/test-factory.yaml
platforms: []
`;

Deno.test("parseManifest reads identity, lists and dependencies", () => {
  const m = parseManifest(MANIFEST);
  assertEquals(m.name, "@svendowideit/thing");
  assertEquals(m.version, "2026.10.05.1");
  assertEquals(m.dependencies, [
    "@svendowideit/web-cache",
    "@magistr/obsidian-vault",
  ]);
  assertEquals(m.models, ["thing.ts", "helper.ts"]);
  assertEquals(m.workflows, ["thing-flow.yaml"]);
  assertEquals(m.additionalFiles, [
    "README.md",
    "acceptance/test-factory.yaml",
  ]);
});

Deno.test("parseManifest stops a list at the next top-level key", () => {
  const m = parseManifest(MANIFEST);
  assertEquals(m.dependencies.includes("thing.ts"), false);
  assertEquals(m.dependencies.includes("@magistr/obsidian-vault"), true);
});

Deno.test("parseManifest reads an inline list and an empty list", () => {
  const m = parseManifest(
    `name: "@a/b"\nmodels: [one.ts, two.ts]\ndependencies: []\nplatforms: []\n`,
  );
  assertEquals(m.models, ["one.ts", "two.ts"]);
  assertEquals(m.dependencies, []);
});

Deno.test("parseManifest preserves # inside a description block", () => {
  const m = parseManifest(
    `name: "@a/b"\ndescription: >\n  swamp model method run x # not a comment\nplatforms: []\n`,
  );
  assertEquals(m.description.includes("# not a comment"), true);
});

Deno.test("parseModelVersion finds the exported model version", () => {
  const src = `export const ` +
    `model = {\n  type: "@a/b",\n  version: "2026.10.05.1",\n};`;
  assertEquals(parseModelVersion(src), "2026.10.05.1");
  assertEquals(parseModelVersion("const x = 1;"), "");
});

Deno.test("parseModelVersion ignores a non-CalVer version", () => {
  assertEquals(parseModelVersion(`version: "1"`), "");
});

Deno.test("parseUpgradesToVersion returns the last upgrade target", () => {
  const src = `upgrades: [
    { toVersion: "2026.09.01.1", description: "a" },
    { toVersion: "2026.10.05.1", description: "b" },
  ]`;
  assertEquals(parseUpgradesToVersion(src), "2026.10.05.1");
  assertEquals(parseUpgradesToVersion("const x = 1;"), "");
});

Deno.test("parseReviewFilename parses collective, name and hash", () => {
  const ref = parseReviewFilename(
    "_svendowideit_web-cache-157f1af891dc1e387e6d6312e73d3cea" +
      "5e923c74591489418461ea36f0ce03c0.json",
  );
  assertEquals(ref?.collective, "svendowideit");
  assertEquals(ref?.name, "web-cache");
  assertEquals(ref?.hash.startsWith("157f1af8"), true);
});

Deno.test("parseReviewFilename rejects non-review files", () => {
  assertEquals(parseReviewFilename("README.md"), null);
  assertEquals(parseReviewFilename("_foo-bar.json"), null);
});

Deno.test("parseUpstreamExtensions reads version and channel", () => {
  const json = JSON.stringify({
    "@svendowideit/systemd-creds": {
      version: "2026.10.01.1",
      channel: "beta",
      files: [],
    },
    "@webframp/github": { version: "2026.09.18.1", files: [] },
  });
  const out = parseUpstreamExtensions(json);
  assertEquals(out["@svendowideit/systemd-creds"].version, "2026.10.01.1");
  assertEquals(out["@svendowideit/systemd-creds"].channel, "beta");
  assertEquals(out["@webframp/github"].version, "2026.09.18.1");
  assertEquals(out["@webframp/github"].channel, "");
});

Deno.test("parseUpstreamExtensions tolerates malformed JSON", () => {
  assertEquals(parseUpstreamExtensions("not json"), {});
});

Deno.test("parseGitStatusPorcelain strips status columns and renames", () => {
  assertEquals(
    parseGitStatusPorcelain(
      " M extensions/models/caddy/manifest.yaml\n" +
        "?? extensions/models/new/manifest.yaml\n" +
        "R  old/path.ts -> extensions/models/new/thing.ts\n",
    ),
    [
      "extensions/models/caddy/manifest.yaml",
      "extensions/models/new/manifest.yaml",
      "extensions/models/new/thing.ts",
    ],
  );
});

Deno.test("parseGitLsFiles keeps only tracked manifest.yaml paths", () => {
  assertEquals(
    parseGitLsFiles(
      "extensions/models/caddy/manifest.yaml\n" +
        "extensions/models/caddy/caddy.ts\n" +
        ".swamp/pulled-extensions/@a/b/manifest.yaml\n" +
        "extensions/foo/node_modules/x/manifest.yaml\n",
    ),
    ["extensions/models/caddy/manifest.yaml"],
  );
});

Deno.test("reviewStateFromWarnings: none is ok", () => {
  assertEquals(reviewStateFromWarnings([]).state, "ok");
  assertEquals(reviewStateFromWarnings(undefined).state, "ok");
});

Deno.test("reviewStateFromWarnings: report rule is missing", () => {
  const r = reviewStateFromWarnings([
    {
      ruleId: "adversarial-review-report",
      file: "/tmp/swamp-extension-review/_a_b-deadbeef.json",
      message: "No adversarial review recorded",
    },
  ]);
  assertEquals(r.state, "missing");
  assertEquals(r.path.endsWith("_a_b-deadbeef.json"), true);
});

Deno.test("reviewStateFromWarnings: dimension issue is issues", () => {
  const r = reviewStateFromWarnings([
    {
      ruleId: "adversarial-review-dimension-issue",
      message: "delete swallows",
    },
  ]);
  assertEquals(r.state, "issues");
  assertEquals(r.note, "delete swallows");
});

Deno.test("reviewStateFromWarnings: unrelated warning is unknown", () => {
  assertEquals(
    reviewStateFromWarnings([{ ruleId: "some-other-rule" }]).state,
    "unknown",
  );
});
