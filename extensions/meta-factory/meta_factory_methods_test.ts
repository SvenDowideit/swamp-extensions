/**
 * Execute-level tests for the meta-factory model methods.
 *
 * These drive the real `execute` functions through `createModelTestContext`,
 * stubbing the external `swamp`/`deno` subprocesses via the injectable `_run`
 * runner. They cover writeResource schema conformance, canonical instance
 * naming, the subprocess timeout/failure classification, and the two file
 * methods (`scaffold`, `installSkill`).
 *
 * @module
 */
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@^0.3.0";

import {
  type CmdResult,
  model,
  run,
  runAuditTimeline,
} from "./meta_factory.ts";

type RunArgs = string[];

/** Build a stub runner that answers each external command deterministically. */
function stubRunner(opts: {
  qualityCode?: number;
  qualityStdout?: string;
  qualityStderr?: string;
  docStdout?: string;
  docLintStdout?: string;
  docLintStderr?: string;
  docLintCode?: number;
  auditStdout?: string;
  auditStderr?: string;
  auditCode?: number;
  gitStdout?: string;
  gitStderr?: string;
  gitCode?: number;
} = {}) {
  const calls: RunArgs[] = [];
  const runner = (bin: string, args: string[]): Promise<CmdResult> => {
    calls.push([bin, ...args]);
    if (bin === "git") {
      return Promise.resolve({
        stdout: opts.gitStdout ?? "",
        stderr: opts.gitStderr ?? "",
        code: opts.gitCode ?? 0,
      });
    }
    if (bin === "swamp" && args[0] === "doctor") {
      return Promise.resolve({
        stdout: JSON.stringify({ denoPath: "/stub/deno" }),
        stderr: "",
        code: 0,
      });
    }
    if (bin === "swamp" && args[0] === "audit") {
      return Promise.resolve({
        stdout: opts.auditStdout ?? "",
        stderr: opts.auditStderr ?? "",
        code: opts.auditCode ?? 0,
      });
    }
    if (bin === "swamp" && args[0] === "extension" && args[1] === "quality") {
      return Promise.resolve({
        stdout: opts.qualityStdout ?? "",
        stderr: opts.qualityStderr ?? "",
        code: opts.qualityCode ?? 0,
      });
    }
    if (bin === "/stub/deno" && args[0] === "doc" && args[1] === "--lint") {
      return Promise.resolve({
        stdout: opts.docLintStdout ?? "",
        stderr: opts.docLintStderr ?? "",
        code: opts.docLintCode ?? 0,
      });
    }
    if (bin === "/stub/deno" && args[0] === "doc") {
      return Promise.resolve({
        stdout: opts.docStdout ?? '{"nodes":{}}',
        stderr: "",
        code: 0,
      });
    }
    return Promise.resolve({ stdout: "", stderr: "unexpected", code: 127 });
  };
  return { runner, calls };
}

const MANIFEST = `manifestVersion: 1
name: "@me/tool"
version: "2026.09.21.1"
description: >
  A small tool that ships one model for a specific audience.

  WHAT IT DOES

    Reads a configured path and writes one result resource, so you get a
    deterministic answer without hand-running shell tools.

  INSTALL

      swamp extension pull @me/tool

  DEPENDENCIES

    None — it is self-contained.

  RUN

      swamp model method run my-tool run

  CONFIGURE

    Set the optional global arguments when creating the model.

  WHAT IT INSTALLS

    Nothing — no services, triggers, schedules, or webhooks.

repository: https://github.com/me/tool

additionalFiles:
  - README.md
  - LICENSE.txt

models:
  - tool.ts
`;

const README = `# @me/tool

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

// Built at runtime so this test file's own text does not contain a literal
// `export const` model declaration. Swamp's extension loader scans raw `.ts`
// text (including colocated `_test.ts` files) for that sequence and would
// otherwise register this fixture as a real model, colliding with the other
// fixture and tripping the I-Repo-1 duplicate-type invariant.
const SOURCE = [
  "export const " + "model = {",
  '  type: "@me/tool",',
  "  methods: {",
  '    run: { description: "x" },',
  "  },",
  "};",
  "",
].join("\n");

/** Create a temp extension directory containing manifest/README/source. */
async function makeExtension(): Promise<string> {
  const root = await Deno.makeTempDir();
  const dir = `${root}/extensions/my-ext`;
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(`${dir}/manifest.yaml`, MANIFEST);
  await Deno.writeTextFile(`${dir}/README.md`, README);
  await Deno.writeTextFile(`${dir}/tool.ts`, SOURCE);
  return root;
}

// deno-lint-ignore no-explicit-any
async function runMethod(name: string, args: any, ctxOpts: any = {}) {
  const ctx = createModelTestContext({
    globalArgs: ctxOpts.globalArgs ?? {},
    methodName: name,
    repoDir: ctxOpts.repoDir,
  });
  // deno-lint-ignore no-explicit-any
  const methods = model.methods as any;
  // deno-lint-ignore no-explicit-any
  const result = await methods[name].execute(args, ctx.context as any);
  return { result, ctx };
}

Deno.test("check writes a schema-conformant score resource", async () => {
  const root = await makeExtension();
  try {
    const { runner } = stubRunner({
      qualityStdout: JSON.stringify({
        dependencyTrust: { passed: true, errors: [] },
      }),
    });
    const { ctx } = await runMethod(
      "check",
      { manifest: "extensions/my-ext/manifest.yaml", _run: runner },
      { repoDir: root, globalArgs: { threshold: 75 } },
    );
    const written = ctx.getWrittenResources();
    assertEquals(written.length, 1);
    assertEquals(written[0].specName, "score");
    const d = written[0].data as Record<string, unknown>;
    for (
      const key of [
        "name",
        "manifest",
        "score",
        "grade",
        "earned",
        "earnedMax",
        "wellDocumented",
        "checks",
        "coverage",
        "examples",
        "missing",
        "nextActions",
        "manifestLint",
        "readmeLint",
        "checkedAt",
      ]
    ) {
      assertEquals(key in d, true, `missing field: ${key}`);
    }
    assertEquals(typeof d.score, "number");
    assertEquals(Array.isArray(d.checks), true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("check and checkAll use the same canonical instance name", async () => {
  const root = await makeExtension();
  try {
    const { runner } = stubRunner({
      qualityStdout: JSON.stringify({
        dependencyTrust: { passed: true, errors: [] },
      }),
    });
    const check = await runMethod(
      "check",
      { manifest: "extensions/my-ext/manifest.yaml", _run: runner },
      { repoDir: root, globalArgs: { threshold: 75 } },
    );
    const checkName = check.ctx.getWrittenResources()[0].name;

    const all = await runMethod(
      "checkAll",
      { _run: runner },
      { repoDir: root, globalArgs: { root: "extensions", threshold: 75 } },
    );
    const scoreNames = all.ctx.getWrittenResources()
      .filter((r) => r.specName === "score")
      .map((r) => r.name);

    assertEquals(scoreNames.includes(checkName), true);
    assertEquals(checkName, "extensions-my-ext-manifest.yaml");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("check marks dependency trust failed on a real audit failure", async () => {
  const root = await makeExtension();
  try {
    const { runner } = stubRunner({
      qualityCode: 1,
      qualityStdout: JSON.stringify({
        dependencyTrust: { passed: false, errors: [{ id: "x" }] },
      }),
    });
    const { ctx } = await runMethod(
      "check",
      { manifest: "extensions/my-ext/manifest.yaml", _run: runner },
      { repoDir: root, globalArgs: { threshold: 75 } },
    );
    const checks = ctx.getWrittenResources()[0].data.checks as Array<
      { id: string; status: string }
    >;
    assertEquals(checks.find((c) => c.id === "deps")?.status, "fail");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("check gives partial credit when the audit is unavailable", async () => {
  const root = await makeExtension();
  try {
    // Non-zero exit with no output => the audit could not run.
    const { runner } = stubRunner({ qualityCode: 1, qualityStdout: "" });
    const { ctx } = await runMethod(
      "check",
      { manifest: "extensions/my-ext/manifest.yaml", _run: runner },
      { repoDir: root, globalArgs: { threshold: 75 } },
    );
    const checks = ctx.getWrittenResources()[0].data.checks as Array<
      { id: string; status: string }
    >;
    assertEquals(checks.find((c) => c.id === "deps")?.status, "partial");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("run strips ANSI escapes from subprocess output", async () => {
  // `deno` colorizes when writing to a pipe; run() must normalise it.
  const proc = await run(
    "printf",
    ["\\033[1;31merror[private-type-ref]\\033[0m: x"],
  );
  assertEquals(proc.stdout, "error[private-type-ref]: x");
  assertEquals(proc.stdout.includes("\u001b"), false);
});

Deno.test("check fails fast-types on stderr slow-type diagnostics", async () => {
  const root = await makeExtension();
  try {
    const { runner } = stubRunner({
      qualityStdout: JSON.stringify({
        dependencyTrust: { passed: true, errors: [] },
      }),
      // deno doc --lint writes diagnostics to stderr and exits non-zero.
      docLintCode: 1,
      docLintStderr:
        "error[missing-return-type]: exported function is missing an explicit return type annotation",
    });
    const { ctx } = await runMethod(
      "check",
      { manifest: "extensions/my-ext/manifest.yaml", _run: runner },
      { repoDir: root, globalArgs: { threshold: 75 } },
    );
    const checks = ctx.getWrittenResources()[0].data.checks as Array<
      { id: string; status: string }
    >;
    assertEquals(checks.find((c) => c.id === "fasttypes")?.status, "fail");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("check passes fast-types when the lint exit is clean", async () => {
  const root = await makeExtension();
  try {
    const { runner } = stubRunner({
      qualityStdout: JSON.stringify({
        dependencyTrust: { passed: true, errors: [] },
      }),
      // A clean run still prints "Checked N files" to stderr, but exits 0.
      docLintCode: 0,
      docLintStderr: "Checked 1 file",
    });
    const { ctx } = await runMethod(
      "check",
      { manifest: "extensions/my-ext/manifest.yaml", _run: runner },
      { repoDir: root, globalArgs: { threshold: 75 } },
    );
    const checks = ctx.getWrittenResources()[0].data.checks as Array<
      { id: string; status: string }
    >;
    assertEquals(checks.find((c) => c.id === "fasttypes")?.status, "pass");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("scaffold writes a README and no score resource", async () => {
  const root = await makeExtension();
  const target = `${root}/extensions/my-ext/README.md`;
  await Deno.remove(target);
  try {
    const { ctx } = await runMethod(
      "scaffold",
      { manifest: "extensions/my-ext/manifest.yaml" },
      { repoDir: root },
    );
    assertEquals(ctx.getWrittenResources().length, 0);
    const md = await Deno.readTextFile(target);
    assertStringIncludes(md, "## What it does");
    assertStringIncludes(md, "## Details");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("scaffold refuses to overwrite without force", async () => {
  const root = await makeExtension();
  try {
    let threw = false;
    try {
      await runMethod(
        "scaffold",
        { manifest: "extensions/my-ext/manifest.yaml" },
        { repoDir: root },
      );
    } catch (err) {
      threw = true;
      assertStringIncludes(String(err), "already exists");
    }
    assertEquals(threw, true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("lintDefinitions writes a definitions resource and flags copies", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${root}/models/@me/tool`, { recursive: true });
    const def = `type: '@me/tool'
typeVersion: 2026.09.21.1
id: 4f616d26-21d2-466d-b5a6-78d0b9065f71
name: my-tool
version: 1
tags: {}
globalArguments: {}
methods: {}
`;
    await Deno.writeTextFile(`${root}/models/@me/tool/one.yaml`, def);
    await Deno.writeTextFile(`${root}/models/@me/tool/two.yaml`, def);

    const { runner } = stubRunner({
      auditStdout: JSON.stringify({ entries: [] }),
    });
    const { ctx } = await runMethod(
      "lintDefinitions",
      { _run: runner },
      { repoDir: root, globalArgs: { definitionsRoot: "models" } },
    );
    const written = ctx.getWrittenResources();
    assertEquals(written.length, 1);
    assertEquals(written[0].specName, "definitions");
    const d = written[0].data as Record<string, unknown>;
    assertEquals(d.scanned, 2);
    assertEquals(d.errorCount, 1);
    const issues = d.issues as Array<{ rule: string }>;
    assertEquals(issues.some((i) => i.rule === "id-duplicate"), true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("lintDefinitions flags a recent definition with no create command", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${root}/models/@me/tool`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/models/@me/tool/my-tool.yaml`,
      `type: '@me/tool'
typeVersion: 2026.09.21.1
id: 4f616d26-21d2-466d-b5a6-78d0b9065f71
name: my-tool
version: 1
tags: {}
globalArguments: {}
methods: {}
`,
    );
    const { runner, calls } = stubRunner({
      auditStdout: JSON.stringify({
        entries: [{
          timestamp: new Date(Date.now() - 3600_000).toISOString(),
          source: "swamp",
          summary: "swamp model list --json",
        }],
      }),
    });
    const { ctx } = await runMethod(
      "lintDefinitions",
      { scanRoot: "models", auditHours: 24, _run: runner },
      { repoDir: root, globalArgs: {} },
    );
    // The audit command was actually invoked.
    assertEquals(
      calls.some((c) => c[0] === "swamp" && c[1] === "audit"),
      true,
    );
    const d = ctx.getWrittenResources()[0].data as Record<string, unknown>;
    assertEquals(d.auditAvailable, true);
    assertEquals(d.confirmedCount, 0);
    const issues = d.issues as Array<{ rule: string }>;
    assertEquals(issues.some((i) => i.rule === "create-unconfirmed"), true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("lintDefinitions confirms a definition with a matching create command", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${root}/models/@me/tool`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/models/@me/tool/my-tool.yaml`,
      `type: '@me/tool'
typeVersion: 2026.09.21.1
id: 4f616d26-21d2-466d-b5a6-78d0b9065f71
name: my-tool
version: 1
tags: {}
globalArguments: {}
methods: {}
`,
    );
    const { runner } = stubRunner({
      auditStdout: JSON.stringify({
        entries: [{
          timestamp: new Date(Date.now() - 3600_000).toISOString(),
          source: "swamp",
          summary: "swamp model create @me/tool my-tool --json",
        }],
      }),
    });
    const { ctx } = await runMethod(
      "lintDefinitions",
      { scanRoot: "models", auditHours: 24, _run: runner },
      { repoDir: root, globalArgs: {} },
    );
    const d = ctx.getWrittenResources()[0].data as Record<string, unknown>;
    assertEquals(d.auditAvailable, true);
    assertEquals(d.confirmedCount, 1);
    const issues = d.issues as Array<{ rule: string }>;
    assertEquals(issues.some((i) => i.rule === "create-unconfirmed"), false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("lintDefinitions skips confirmation when the audit is empty", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${root}/models/@me/tool`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/models/@me/tool/my-tool.yaml`,
      `type: '@me/tool'
typeVersion: 2026.09.21.1
id: 4f616d26-21d2-466d-b5a6-78d0b9065f71
name: my-tool
version: 1
tags: {}
globalArguments: {}
methods: {}
`,
    );
    const { runner } = stubRunner({
      auditStdout: JSON.stringify({
        message: "No audit data found. Run 'swamp repo init --force'…",
      }),
    });
    const { ctx } = await runMethod(
      "lintDefinitions",
      { scanRoot: "models", auditHours: 24, _run: runner },
      { repoDir: root, globalArgs: {} },
    );
    const d = ctx.getWrittenResources()[0].data as Record<string, unknown>;
    assertEquals(d.auditAvailable, false);
    const issues = d.issues as Array<{ rule: string }>;
    assertEquals(issues.some((i) => i.rule === "create-unconfirmed"), false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkAll throws when no manifests match the root", async () => {
  const root = await Deno.makeTempDir();
  await Deno.mkdir(`${root}/extensions`, { recursive: true });
  try {
    let threw = false;
    try {
      await runMethod(
        "checkAll",
        {},
        { repoDir: root, globalArgs: { root: "extensions", threshold: 75 } },
      );
    } catch (err) {
      threw = true;
      assertStringIncludes(String(err), "No manifest.yaml found");
    }
    assertEquals(threw, true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("runAuditTimeline parses entries and computes a now-based window", async () => {
  const { runner } = stubRunner({
    auditStdout: JSON.stringify({
      entries: [
        {
          timestamp: "2026-09-20T10:00:00.000Z",
          source: "swamp",
          summary: "swamp model create @me/tool my-tool --json",
        },
        {
          timestamp: "2026-09-21T11:00:00.000Z",
          source: "swamp",
          summary: "swamp workflow create @me/flow --json",
        },
      ],
    }),
  });
  const before = Date.now();
  const evidence = await runAuditTimeline(runner, 48);
  const after = Date.now();
  assertEquals(evidence.available, true);
  assertEquals(evidence.hours, 48);
  assertEquals(evidence.commands.length, 2);
  // The window start is `now - hours`, bounded by the call's start and end.
  assertEquals(
    evidence.windowStartMs !== undefined &&
      evidence.windowStartMs >= before - 48 * 3600_000 &&
      evidence.windowStartMs <= after - 48 * 3600_000,
    true,
  );
});

Deno.test("runAuditTimeline reports unavailable when the timeline is empty", async () => {
  const { runner } = stubRunner({
    auditStdout: JSON.stringify({ message: "No audit data found." }),
  });
  const evidence = await runAuditTimeline(runner, 24);
  assertEquals(evidence.available, false);
  assertEquals(evidence.commands, []);
});

Deno.test("runAuditTimeline survives a failed audit command", async () => {
  const { runner } = stubRunner({ auditCode: 1, auditStdout: "" });
  const evidence = await runAuditTimeline(runner, 24);
  assertEquals(evidence.available, false);
});

Deno.test("checkAll gitOnly scores only git-tracked manifests", async () => {
  const root = await Deno.makeTempDir();
  try {
    const dir = `${root}/extensions`;
    for (const name of ["tracked", "untracked"]) {
      await Deno.mkdir(`${dir}/${name}`, { recursive: true });
      await Deno.writeTextFile(
        `${dir}/${name}/manifest.yaml`,
        `manifestVersion: 1
name: "@me/${name}"
version: "2026.09.21.1"
description: >
  A tool.

  WHAT IT DOES

    Does a thing for someone, so they do not have to.

  INSTALL

      swamp extension pull @me/${name}

  DEPENDENCIES

    None.

  RUN

      swamp model method run my-tool run

  CONFIGURE

    Set --global-arg path=/tmp.

  WHAT IT INSTALLS

    Nothing.

repository: https://github.com/me/${name}

additionalFiles:
  - README.md
  - LICENSE.txt

models:
  - tool.ts
`,
      );
      await Deno.writeTextFile(`${dir}/${name}/README.md`, "# x\n");
      await Deno.writeTextFile(`${dir}/${name}/tool.ts`, "");
    }
    const { runner } = stubRunner({
      // Only `tracked` is git-tracked; `untracked` exists on disk but is not.
      gitStdout: "tracked/manifest.yaml\n",
      qualityStdout: JSON.stringify({
        dependencyTrust: { passed: true, errors: [] },
      }),
      auditStdout: JSON.stringify({ entries: [] }),
    });
    const { ctx } = await runMethod(
      "checkAll",
      { gitOnly: true, _run: runner },
      { repoDir: root, globalArgs: { root: "extensions", threshold: 75 } },
    );
    const scoreNames = ctx.getWrittenResources()
      .filter((r) => r.specName === "score")
      .map((r) => r.name);
    assertEquals(scoreNames, ["extensions-tracked-manifest.yaml"]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkAll gitOnly falls back to a walk when git fails", async () => {
  const root = await Deno.makeTempDir();
  try {
    const dir = `${root}/extensions/only`;
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/manifest.yaml`,
      `manifestVersion: 1
name: "@me/only"
version: "2026.09.21.1"
description: >
  A tool.

  WHAT IT DOES

    Does a thing for someone, so they do not have to.

  INSTALL

      swamp extension pull @me/only

  DEPENDENCIES

    None.

  RUN

      swamp model method run my-tool run

  CONFIGURE

    Set --global-arg path=/tmp.

  WHAT IT INSTALLS

    Nothing.

repository: https://github.com/me/only

additionalFiles:
  - README.md

models:
  - tool.ts
`,
    );
    const { runner } = stubRunner({
      gitCode: 128,
      gitStderr: "fatal: not a git repository",
      qualityStdout: JSON.stringify({
        dependencyTrust: { passed: true, errors: [] },
      }),
      auditStdout: JSON.stringify({ entries: [] }),
    });
    const { ctx } = await runMethod(
      "checkAll",
      { gitOnly: true, _run: runner },
      { repoDir: root, globalArgs: { root: "extensions", threshold: 75 } },
    );
    const scoreNames = ctx.getWrittenResources()
      .filter((r) => r.specName === "score")
      .map((r) => r.name);
    assertEquals(scoreNames, ["extensions-only-manifest.yaml"]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
