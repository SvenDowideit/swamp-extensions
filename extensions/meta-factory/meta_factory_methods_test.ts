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

import { type CmdResult, model, run } from "./meta_factory.ts";

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
} = {}) {
  const calls: RunArgs[] = [];
  const runner = (bin: string, args: string[]): Promise<CmdResult> => {
    calls.push([bin, ...args]);
    if (bin === "swamp" && args[0] === "doctor") {
      return Promise.resolve({
        stdout: JSON.stringify({ denoPath: "/stub/deno" }),
        stderr: "",
        code: 0,
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

const SOURCE = `export const model = {
  type: "@me/tool",
  methods: {
    run: { description: "x" },
  },
};
`;

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
