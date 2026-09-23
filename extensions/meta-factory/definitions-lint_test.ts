/**
 * Unit tests for the definition-config (creation-command) lint.
 *
 * @module
 */
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  type AuditEvidence,
  classifyDefinition,
  creationCommand,
  hasCreationCommand,
  lintDefinitions,
  lintDefinitionSource,
  parseCreationCommands,
  renderDefinitionsScan,
  topLevelScalar,
} from "./definitions-lint.ts";

const MODEL = `type: '@me/tool'
typeVersion: 2026.09.21.1
id: 4f616d26-21d2-466d-b5a6-78d0b9065f71
name: my-tool
version: 1
tags: {}
globalArguments:
  path: /tmp
methods: {}
`;

const WORKFLOW = `id: f45bd969-6ef9-4ada-8b85-359d153150db
name: "@me/flow"
description: |
  A flow.
inputs:
  properties: {}
  required: []
jobs: []
version: 1
`;

const VAULT = `id: 74b98162-c68e-4d92-addb-b07a688c1915
name: garmin-secrets
type: '@me/vault'
config: {}
createdAt: '2026-09-22T04:53:03.340Z'
`;

const MANIFEST = `manifestVersion: 1
name: "@me/tool"
version: "2026.09.21.1"
description: >
  A tool.
models:
  - tool.ts
`;

Deno.test("classifyDefinition identifies each config kind", () => {
  assertEquals(classifyDefinition(MODEL), "model");
  assertEquals(classifyDefinition(WORKFLOW), "workflow");
  assertEquals(classifyDefinition(VAULT), "vault");
  assertEquals(classifyDefinition(MANIFEST), "manifest");
  assertEquals(classifyDefinition("swampVersion: 1\n"), "unknown");
});

Deno.test("creationCommand maps a kind to the swamp command", () => {
  assertEquals(
    creationCommand("model", { type: "@me/tool", name: "my-tool" }),
    "swamp model create @me/tool my-tool",
  );
  assertEquals(
    creationCommand("workflow", { name: "@me/flow" }),
    "swamp workflow create @me/flow",
  );
  assertEquals(
    creationCommand("vault", { type: "@me/vault", name: "v" }),
    "swamp vault create @me/vault v",
  );
});

Deno.test("topLevelScalar reads a quoted scalar", () => {
  assertEquals(topLevelScalar(MODEL, "name"), "my-tool");
  assertEquals(topLevelScalar(WORKFLOW, "name"), "@me/flow");
  assertEquals(topLevelScalar(MODEL, "missing"), null);
});

Deno.test("lintDefinitionSource passes a generated model", () => {
  const result = lintDefinitionSource(MODEL, { path: "models/my-tool.yaml" });
  assertEquals(result.ok, true);
  assertEquals(result.kind, "model");
  assertEquals(result.issues, []);
});

Deno.test("lintDefinitionSource passes generated workflow and vault", () => {
  assertEquals(lintDefinitionSource(WORKFLOW).ok, true);
  assertEquals(lintDefinitionSource(VAULT).ok, true);
});

Deno.test("lintDefinitionSource flags a hand-written file with no id", () => {
  const source = `type: '@me/tool'
name: my-tool
globalArguments: {}
methods: {}
`;
  const result = lintDefinitionSource(source, { path: "models/t.yaml" });
  assertEquals(result.ok, false);
  assertEquals(result.issues[0].rule, "id-missing");
  assertStringIncludes(result.issues[0].message, "swamp model create");
});

Deno.test("lintDefinitionSource flags a non-UUID id", () => {
  const source = `id: my-fake-id
name: "@me/flow"
jobs: []
version: 1
`;
  const result = lintDefinitionSource(source);
  assertEquals(result.ok, false);
  assertEquals(result.issues[0].rule, "id-format");
  assertStringIncludes(result.issues[0].message, "swamp workflow create");
});

Deno.test("lintDefinitionSource flags a copied id as duplicate", () => {
  const id = "4f616d26-21d2-466d-b5a6-78d0b9065f71";
  const knownIds = new Map([[id, "models/original.yaml"]]);
  const result = lintDefinitionSource(MODEL, {
    path: "models/copy.yaml",
    knownIds,
  });
  assertEquals(result.ok, false);
  assertEquals(result.issues[0].rule, "id-duplicate");
  assertStringIncludes(result.issues[0].message, "models/original.yaml");
});

Deno.test("lintDefinitionSource warns on a missing name", () => {
  const source = `id: 4f616d26-21d2-466d-b5a6-78d0b9065f71
typeVersion: 2026.09.21.1
type: '@me/tool'
globalArguments: {}
methods: {}
`;
  const result = lintDefinitionSource(source);
  assertEquals(result.ok, true); // warnings only
  assertEquals(result.issues.some((i) => i.rule === "name-missing"), true);
});

Deno.test("lintDefinitions scans a tree and detects copies", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${root}/models/@me/tool`, { recursive: true });
    await Deno.writeTextFile(`${root}/models/@me/tool/one.yaml`, MODEL);
    // A copy of `one.yaml` keeps the same id — the copy-paste symptom.
    await Deno.writeTextFile(`${root}/models/@me/tool/two.yaml`, MODEL);
    await Deno.writeTextFile(`${root}/models/@me/tool/manifest.yaml`, MANIFEST);
    await Deno.writeTextFile(`${root}/.swamp.yaml`, "swampVersion: 1\n");

    const scan = await lintDefinitions(root);
    assertEquals(scan.scanned, 2);
    const dupes = scan.issues.filter((i) => i.rule === "id-duplicate");
    assertEquals(dupes.length, 1);
    assertStringIncludes(dupes[0].path, "two.yaml");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("lintDefinitions blames the copy, not the generated original", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${root}/models/@me/tool`, { recursive: true });
    // A generated file is named after its `name:`; the copy is not.
    await Deno.writeTextFile(`${root}/models/@me/tool/my-tool.yaml`, MODEL);
    await Deno.writeTextFile(`${root}/models/@me/tool/zz-copy.yaml`, MODEL);
    const scan = await lintDefinitions(root);
    const dupes = scan.issues.filter((i) => i.rule === "id-duplicate");
    assertEquals(dupes.length, 1);
    assertStringIncludes(dupes[0].path, "zz-copy.yaml");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("lintDefinitions detects a copy even when unnamed", async () => {
  const root = await Deno.makeTempDir();
  try {
    // An unnamed model is auto-named after its id.
    await Deno.mkdir(`${root}/models/@me/tool`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/models/@me/tool/4f616d26-21d2-466d-b5a6-78d0b9065f71.yaml`,
      MODEL,
    );
    await Deno.writeTextFile(`${root}/models/@me/tool/zz-copy.yaml`, MODEL);
    const scan = await lintDefinitions(root);
    const dupes = scan.issues.filter((i) => i.rule === "id-duplicate");
    assertEquals(dupes.length, 1);
    assertStringIncludes(dupes[0].path, "zz-copy.yaml");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("renderDefinitionsScan summarises clean and failing trees", () => {
  assertEquals(
    renderDefinitionsScan({ scanned: 2, definitions: [], issues: [] }),
    "Definitions structure OK (2 config(s) checked)",
  );
  const failed = renderDefinitionsScan({
    scanned: 1,
    definitions: [],
    issues: [{
      path: "m.yaml",
      severity: "error",
      rule: "id-missing",
      message: "no id",
    }],
  });
  assertStringIncludes(failed, "FAILED");
  assertStringIncludes(failed, "m.yaml");
});

Deno.test("parseCreationCommands extracts names across a pipeline", () => {
  const commands = parseCreationCommands([
    {
      timestamp: "2026-09-20T10:00:00Z",
      source: "swamp",
      summary:
        "swamp model create @me/tool my-tool --global-arg path=/tmp && swamp model method run my-tool run",
    },
    {
      timestamp: "2026-09-20T10:01:00Z",
      source: "swamp",
      summary: "swamp workflow create @me/flow --json",
    },
    {
      timestamp: "2026-09-20T10:02:00Z",
      source: "swamp",
      summary: "swamp vault create @me/vault my-vault --json",
    },
  ]);
  assertEquals(commands, [
    {
      kind: "model",
      name: "my-tool",
      timestamp: "2026-09-20T10:00:00Z",
      resolved: true,
    },
    {
      kind: "workflow",
      name: "flow",
      timestamp: "2026-09-20T10:01:00Z",
      resolved: true,
    },
    {
      kind: "vault",
      name: "my-vault",
      timestamp: "2026-09-20T10:02:00Z",
      resolved: true,
    },
  ]);
});

Deno.test("parseCreationCommands normalises a collective prefix", () => {
  const commands = parseCreationCommands([
    { summary: "swamp workflow create @me/flow --json", timestamp: "t" },
  ]);
  assertEquals(commands[0].name, "flow");
});

Deno.test("parseCreationCommands expands a for-loop variable", () => {
  const commands = parseCreationCommands([
    {
      summary:
        "for w in garmin-activities-sync garmin-download; do swamp workflow create @me/$w --json; done",
      timestamp: "t",
    },
  ]);
  assertEquals(
    commands.map((c) => c.name).sort(),
    ["garmin-activities-sync", "garmin-download"].sort(),
  );
  assertEquals(commands.every((c) => c.resolved), true);
});

Deno.test("parseCreationCommands marks an unexpanded variable unresolved", () => {
  const commands = parseCreationCommands([
    { summary: "swamp workflow create @me/$name --json", timestamp: "t" },
  ]);
  assertEquals(commands.length, 1);
  assertEquals(commands[0].resolved, false);
});

Deno.test("parseCreationCommands ignores non-create commands", () => {
  const commands = parseCreationCommands([
    { timestamp: "t", summary: "swamp model list --json" },
    { timestamp: "t", summary: "swamp model create --help" },
  ]);
  // The `--help` invocation has no positional `<type> <name>`, so no command
  // is recovered and it cannot satisfy a real definition's confirmation.
  assertEquals(commands, []);
});

Deno.test("hasCreationCommand matches by name", () => {
  const commands = parseCreationCommands([
    { summary: "swamp model create @me/tool my-tool --json", timestamp: "t" },
  ]);
  assertEquals(hasCreationCommand(commands, "my-tool"), true);
  assertEquals(hasCreationCommand(commands, "other"), false);
});

Deno.test("lintDefinitionSource flags an unconfirmed recent definition", () => {
  const audit: AuditEvidence = {
    available: true,
    hours: 24,
    windowStartMs: 0,
    commands: [],
  };
  const result = lintDefinitionSource(MODEL, {
    path: "models/my-tool.yaml",
    audit,
    createdMs: 1_000_000,
  });
  assertEquals(result.createConfirmed, false);
  assertEquals(
    result.issues.some((i) => i.rule === "create-unconfirmed"),
    true,
  );
  assertEquals(result.ok, true); // warning, not an error
});

Deno.test("lintDefinitionSource confirms a matching create command", () => {
  const audit: AuditEvidence = {
    available: true,
    hours: 24,
    windowStartMs: 0,
    commands: [{
      kind: "model",
      name: "my-tool",
      timestamp: "t",
      resolved: true,
    }],
  };
  const result = lintDefinitionSource(MODEL, {
    path: "models/my-tool.yaml",
    audit,
    createdMs: 1_000_000,
  });
  assertEquals(result.createConfirmed, true);
  assertEquals(result.issues.length, 0);
});

Deno.test("lintDefinitionSource ignores a definition older than the window", () => {
  const audit: AuditEvidence = {
    available: true,
    hours: 24,
    windowStartMs: 5_000_000,
    commands: [],
  };
  const result = lintDefinitionSource(MODEL, {
    path: "models/my-tool.yaml",
    audit,
    createdMs: 1_000_000, // older than windowStartMs
  });
  assertEquals(result.createConfirmed, undefined);
  assertEquals(result.issues.length, 0);
});

Deno.test("lintDefinitionSource skips the audit when unavailable", () => {
  const audit: AuditEvidence = { available: false, hours: 24, commands: [] };
  const result = lintDefinitionSource(MODEL, {
    path: "models/my-tool.yaml",
    audit,
    createdMs: 1_000_000,
  });
  assertEquals(result.createConfirmed, undefined);
  assertEquals(result.issues.length, 0);
});
