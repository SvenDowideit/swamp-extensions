/**
 * Execute-level tests for the test-factory model methods.
 *
 * These drive the real `execute` functions through `createModelTestContext`,
 * stubbing docker via the injectable `_run` runner. They prove the model wires
 * the catalog, harness builder, and result writer together correctly without
 * booting a single container.
 *
 * @module
 */
import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@^0.3.0";

import type { CmdResult } from "./docker.ts";
import {
  containerEnv,
  model,
  preflightTests,
  resolveApiKey,
  resolvePhases,
} from "./test_factory.ts";
import type { TestSpec } from "./tests.ts";

type Call = [string, ...string[]];

/** A canned harness result the stubbed container would have written. */
function harnessResult(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    installOk: true,
    swampVersion: "swamp 2026.09.30.1",
    doctorStatus: "pass",
    doctorStates: {},
    sourceAddOk: true,
    registeredTypes: ["@acme/thing"],
    modelTypes: ["@acme/thing"],
    missingTypes: [],
    definitions: [{ type: "@acme/thing", name: "tf-def-1", ok: true }],
    workflows: [],
    fixtures: [],
    ...overrides,
  });
}

/** Stub runner: answers docker + git deterministically. */
function stubRunner(
  opts: {
    dockerAvailable?: boolean;
    harness?: string;
    gitStdout?: string;
  } = {},
) {
  const calls: Call[] = [];
  const runner = (bin: string, args: string[]): Promise<CmdResult> => {
    calls.push([bin, ...args]);
    if (bin === "git") {
      return Promise.resolve({
        stdout: opts.gitStdout ?? "",
        stderr: "",
        code: 0,
      });
    }
    if (bin === "docker") {
      const sub = args.join(" ");
      if (sub.startsWith("version")) {
        return Promise.resolve({
          stdout: opts.dockerAvailable === false ? "" : "29.1.3",
          stderr: opts.dockerAvailable === false ? "no daemon" : "",
          code: opts.dockerAvailable === false ? 1 : 0,
        });
      }
      if (sub.startsWith("image inspect")) {
        return Promise.resolve({ stdout: "sha", stderr: "", code: 0 });
      }
      if (sub.startsWith("run -d")) {
        return Promise.resolve({ stdout: "container-id", stderr: "", code: 0 });
      }
      if (sub.includes("{{.State.Running}}")) {
        return Promise.resolve({ stdout: "true", stderr: "", code: 0 });
      }
      if (sub.startsWith("exec") && args.includes("cat")) {
        return Promise.resolve({
          stdout: opts.harness ?? harnessResult(),
          stderr: "",
          code: 0,
        });
      }
      if (sub.startsWith("exec")) {
        return Promise.resolve({ stdout: "", stderr: "", code: 0 });
      }
      if (sub.startsWith("logs")) {
        return Promise.resolve({ stdout: "[tf] done", stderr: "", code: 0 });
      }
      return Promise.resolve({ stdout: "", stderr: "", code: 0 });
    }
    return Promise.resolve({ stdout: "", stderr: "", code: 0 });
  };
  return { runner, calls };
}

/** A temp candidate extension the model can inspect. */
async function writeCandidate(
  opts: { withTests?: boolean } = {},
): Promise<{ manifest: string; dir: string }> {
  const dir = await Deno.makeTempDir({ prefix: "tf-candidate-" });
  const additional = opts.withTests
    ? `additionalFiles:
  - README.md
  - test-factory.yaml
`
    : "";
  await Deno.writeTextFile(
    `${dir}/manifest.yaml`,
    `manifestVersion: 1
name: "@acme/thing"
version: "2026.01.01.1"
models:
  - thing.ts
${additional}`,
  );
  // Concatenated so the loader's raw-text scan does not register this fixture
  // as a real model (which would collide on `@acme/thing` across test files).
  await Deno.writeTextFile(
    `${dir}/thing.ts`,
    `export const ` + `model = { type: "@acme/thing", version: "1" };`,
  );
  if (opts.withTests) {
    await Deno.writeTextFile(
      `${dir}/test-factory.yaml`,
      `tests:
  - name: version-prints
    confirms: the binary runs and prints a version.
    cannot: must not exit non-zero or print an error.
    steps:
      - name: version
        run: swamp --version
        expect:
          exitCode: 0
          stdoutNotContains: [error]
`,
    );
  }
  return { manifest: `${dir}/manifest.yaml`, dir };
}

/**
 * Create a host output dir pre-populated with the harness result and its
 * completion sentinel, the way a real container would leave it, and return the
 * `_outBaseDir` the model should use.
 */
async function provisionOutput(harness: string): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "tf-out-" });
  await Deno.writeTextFile(`${dir}/result.json`, harness);
  await Deno.writeTextFile(`${dir}/done`, "");
  return dir;
}

type MethodArgs = Record<string, unknown>;
type Executable = {
  execute: (args: MethodArgs, context: unknown) => Promise<unknown>;
};

async function runMethod(
  name: string,
  args: MethodArgs,
  ctxOpts: {
    repoDir: string;
    globalArgs?: Record<string, unknown>;
    harness?: string;
  },
) {
  const ctx = createModelTestContext({
    globalArgs: ctxOpts.globalArgs ?? {},
    methodName: name,
    repoDir: ctxOpts.repoDir,
  });
  const outBaseDir = await provisionOutput(
    ctxOpts.harness ?? harnessResult(),
  );
  const methods = model.methods as unknown as Record<string, Executable>;
  const promise = methods[name].execute(
    { ...args, _outBaseDir: outBaseDir },
    ctx.context as unknown,
  ) as Promise<{ dataHandles: unknown[] }>;
  return { promise, ctx };
}

Deno.test("test writes a result and a summary", async () => {
  const { runner } = stubRunner();
  const { manifest, dir } = await writeCandidate();
  try {
    const { promise, ctx } = await runMethod(
      "test",
      {
        manifest,
        scenario: "debian-standalone",
        phases: "smoke,load,definitions",
        _run: runner,
      },
      { repoDir: dir },
    );
    const result = await promise;
    assertEquals(result.dataHandles.length, 2);
    const written = ctx.getWrittenResources();
    const results = written.filter((r) => r.specName === "result");
    assertEquals(results.length, 1);
    assertEquals(results[0].name, "debian-standalone");
    assertEquals(results[0].data.ok, true);
    assertEquals(results[0].data.doctorStatus, "pass");
    // The result records what was tested, and what each phase proves.
    assertEquals(results[0].data.extension, "@acme/thing");
    assertEquals(results[0].data.extensionVersion, "2026.01.01.1");
    assertStringIncludes(
      results[0].data.intent as string,
      "@acme/thing@2026.01.01.1",
    );
    const claims = results[0].data.claims as Array<Record<string, unknown>>;
    assertEquals(claims.map((c) => c.phase), ["smoke", "load", "definitions"]);
    assertStringIncludes(
      (claims[2].commands as string[]).join("\n"),
      "swamp model create '@acme/thing'",
    );
    const summaries = written.filter((r) => r.specName === "summary");
    assertEquals(summaries.length, 1);
    assertEquals(summaries[0].data.passCount, 1);
    assertEquals(summaries[0].data.count, 1);
    assertEquals(summaries[0].data.version, "2026.01.01.1");
    assertEquals(
      (summaries[0].data.claims as unknown[]).length,
      3,
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("a candidate shipping test-factory.yaml runs the tests phase", async () => {
  const { runner } = stubRunner();
  const { manifest, dir } = await writeCandidate({ withTests: true });
  try {
    const { promise, ctx } = await runMethod(
      "test",
      { manifest, scenario: "debian-standalone", _run: runner },
      {
        repoDir: dir,
        harness: harnessResult({
          tests: [{
            name: "version-prints",
            ok: true,
            steps: [{
              name: "version",
              run: "swamp --version",
              ok: true,
              exitCode: 0,
              matched: ["exitCode 0 ok"],
              stdout: "swamp 2026.09.30.1",
              stderr: "",
            }],
          }],
        }),
      },
    );
    await promise;
    const result = ctx.getWrittenResources().find((r) =>
      r.specName === "result"
    )!;
    // `tests` was auto-enabled (no explicit `phases`), and the run passed.
    assertStringIncludes(
      (result.data.phasesRequested as string[]).join(","),
      "tests",
    );
    const tests = result.data.tests as Array<Record<string, unknown>>;
    assertEquals(tests.length, 1);
    assertEquals(tests[0].name, "version-prints");
    assertEquals(tests[0].ok, true);
    assertStringIncludes(tests[0].confirms as string, "prints a version");
    assertEquals(result.data.status, "pass");
    const summary = ctx.getWrittenResources().find((r) =>
      r.specName === "summary"
    )!;
    assertEquals(summary.data.testCount, 1);
    assertEquals(summary.data.testsPassed, 1);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("checkCoverage reports documented and shipped-surface coverage", async () => {
  const dir = await Deno.makeTempDir({ prefix: "tf-cov-" });
  try {
    await Deno.writeTextFile(
      `${dir}/manifest.yaml`,
      `manifestVersion: 1
name: "@acme/thing"
version: "2026.01.01.1"
description: >
  WHAT IT DOES

    A thing.

  RUN

      swamp model method run my-thing installCaddy
      swamp model method run my-thing plan
models:
  - thing.ts
additionalFiles:
  - test-factory.yaml
`,
    );
    await Deno.writeTextFile(
      `${dir}/thing.ts`,
      `export const ` + `model = {\n` +
        `  type: "@acme/thing",\n  methods: {\n` +
        `    installCaddy: {},\n    plan: {},\n    extra: {},\n  },\n};`,
    );
    await Deno.writeTextFile(
      `${dir}/test-factory.yaml`,
      `tests:
  - name: install
    confirms: it installs.
    cannot: must not fail.
    steps:
      - name: run
        run: swamp model method run e2e installCaddy
        expect: { exitCode: 0, stdoutNotContains: [error] }
`,
    );
    const { promise, ctx } = await runMethod(
      "checkCoverage",
      { manifest: `${dir}/manifest.yaml` },
      { repoDir: dir },
    );
    const result = await promise;
    assertEquals(result.dataHandles.length, 1);
    const resource = ctx.getWrittenResources().find((r) =>
      r.specName === "coverage"
    )!;
    assertEquals(resource.data.extension, "@acme/thing");
    assertEquals(resource.data.testCount, 1);
    assertEquals(resource.data.testCommands, [
      "swamp model method run e2e installCaddy",
    ]);
    assertEquals(resource.data.documentedCommands, [
      "swamp model method run my-thing installCaddy",
      "swamp model method run my-thing plan",
    ]);
    assertEquals(resource.data.documentedCovered, [
      "swamp model method run my-thing installCaddy",
    ]);
    assertEquals(resource.data.uncoveredCommands, [
      "swamp model method run my-thing plan",
    ]);
    const surface = resource.data.surface as Record<string, unknown>;
    assertEquals(surface.methods, [
      "@acme/thing.extra",
      "@acme/thing.installCaddy",
      "@acme/thing.plan",
    ]);
    assertEquals(surface.methodsCovered, ["@acme/thing.installCaddy"]);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("checkCoverage is docker-free", async () => {
  // The stub runner treats docker as unavailable; checkCoverage must not care.
  const { runner } = stubRunner({ dockerAvailable: false });
  const dir = await Deno.makeTempDir({ prefix: "tf-cov-" });
  try {
    await Deno.writeTextFile(
      `${dir}/manifest.yaml`,
      `manifestVersion: 1\nname: "@acme/thing"\nversion: "1"\nmodels:\n  - thing.ts\n`,
    );
    await Deno.writeTextFile(
      `${dir}/thing.ts`,
      `export const ` + `model = { type: "@acme/thing", version: "1" };`,
    );
    const { promise } = await runMethod(
      "checkCoverage",
      { manifest: `${dir}/manifest.yaml`, _run: runner },
      { repoDir: dir },
    );
    const result = await promise;
    assertEquals(result.dataHandles.length, 1);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("a failing harness yields a failed result", async () => {
  const { runner } = stubRunner();
  const { manifest, dir } = await writeCandidate();
  try {
    const { promise, ctx } = await runMethod(
      "test",
      {
        manifest,
        scenario: "debian-standalone",
        phases: "smoke,load,definitions",
        _run: runner,
      },
      {
        repoDir: dir,
        harness: harnessResult({
          missingTypes: ["@acme/thing"],
          definitions: [
            { type: "@acme/thing", name: "x", ok: false, error: "boom" },
          ],
        }),
      },
    );
    await promise;
    const write = ctx.getWrittenResources().find((r) =>
      r.specName === "result"
    )!;
    assertEquals(write.data.ok, false);
    assertEquals(write.data.status, "fail");
    assertEquals((write.data.errors as string[]).length > 0, true);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("an expected-fail scenario passes when the install fails", async () => {
  const { runner } = stubRunner();
  const { manifest, dir } = await writeCandidate();
  try {
    const { promise, ctx } = await runMethod(
      "test",
      {
        manifest,
        scenario: "alpine-standalone",
        phases: "smoke",
        _run: runner,
      },
      {
        repoDir: dir,
        harness: JSON.stringify({
          installOk: false,
          installError: "__res_init: symbol not found",
          swampVersion: "",
        }),
      },
    );
    await promise;
    const write = ctx.getWrittenResources().find((r) =>
      r.specName === "result"
    )!;
    assertEquals(write.data.ok, true);
    assertEquals(write.data.status, "pass");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("test refuses to run without a container runtime", async () => {
  const { runner } = stubRunner({ dockerAvailable: false });
  const { manifest, dir } = await writeCandidate();
  try {
    const { promise } = await runMethod(
      "test",
      { manifest, scenario: "debian-standalone", _run: runner },
      { repoDir: dir },
    );
    await assertRejects(
      () => promise,
      Error,
      "container runtime unavailable",
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("test requires a manifest", async () => {
  const { runner } = stubRunner();
  const { dir } = await writeCandidate();
  try {
    const { promise } = await runMethod(
      "test",
      { manifest: "", scenario: "debian-standalone", _run: runner },
      { repoDir: dir },
    );
    await assertRejects(() => promise, Error, "manifest");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("testAll sweeps every git-tracked manifest", async () => {
  const { runner, calls } = stubRunner({
    gitStdout: "extensions/a/manifest.yaml\nextensions/b/manifest.yaml\n",
  });
  const dir = await Deno.makeTempDir({ prefix: "tf-sweep-" });
  try {
    for (const name of ["a", "b"]) {
      await Deno.mkdir(`${dir}/extensions/${name}`, { recursive: true });
      await Deno.writeTextFile(
        `${dir}/extensions/${name}/manifest.yaml`,
        `manifestVersion: 1\nname: "@acme/${name}"\nversion: "1"\nmodels:\n  - ${name}.ts\n`,
      );
      await Deno.writeTextFile(
        `${dir}/extensions/${name}/${name}.ts`,
        `export const ` + `model = { type: "@acme/${name}", version: "1" };`,
      );
    }
    const { promise } = await runMethod(
      "testAll",
      {
        root: "extensions",
        scenario: "debian-standalone",
        phases: "smoke",
        _run: runner,
      },
      { repoDir: dir },
    );
    const result = await promise;
    // Two extensions x (one result + one summary).
    assertEquals(result.dataHandles.length, 4);
    assertEquals(
      calls.some((c) => c[0] === "git" && c[1] === "ls-files"),
      true,
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

/** A fake vault service for resolveApiKey tests. */
function fakeVault(
  names: string[],
  secrets: Record<string, string>,
): {
  getVaultNames: () => string[];
  get: (v: string, k: string) => Promise<string>;
} {
  return {
    getVaultNames: () => names,
    get: (v, k) => {
      const id = `${v}/${k}`;
      if (id in secrets) return Promise.resolve(secrets[id]);
      return Promise.reject(new Error(`no secret ${id}`));
    },
  };
}

Deno.test("resolveApiKey reads the named vault by default", async () => {
  const key = await resolveApiKey({
    globalArgs: {
      vault: "test-factory-vault",
      vaultEntry: "SWAMP_API_KEY",
      swampApiKey: "",
    },
    vaultService: fakeVault(["test-factory-vault"], {
      "test-factory-vault/SWAMP_API_KEY": "swamp_org_from_vault",
    }),
  });
  assertEquals(key, "swamp_org_from_vault");
});

Deno.test("an explicit swampApiKey wins over the vault", async () => {
  const key = await resolveApiKey({
    globalArgs: {
      vault: "test-factory-vault",
      vaultEntry: "SWAMP_API_KEY",
      swampApiKey: "swamp_org_explicit",
    },
    vaultService: fakeVault(["test-factory-vault"], {
      "test-factory-vault/SWAMP_API_KEY": "swamp_org_from_vault",
    }),
  });
  assertEquals(key, "swamp_org_explicit");
});

Deno.test("a missing vault or key yields no key, not an error", async () => {
  assertEquals(
    await resolveApiKey({
      globalArgs: {
        vault: "other-vault",
        vaultEntry: "SWAMP_API_KEY",
        swampApiKey: "",
      },
      vaultService: fakeVault(["test-factory-vault"], {
        "test-factory-vault/SWAMP_API_KEY": "x",
      }),
    }),
    "",
  );
  assertEquals(
    await resolveApiKey({
      globalArgs: {
        vault: "test-factory-vault",
        vaultEntry: "MISSING",
        swampApiKey: "",
      },
      vaultService: fakeVault(["test-factory-vault"], {}),
    }),
    "",
  );
  assertEquals(
    await resolveApiKey({
      globalArgs: {
        vault: "test-factory-vault",
        vaultEntry: "SWAMP_API_KEY",
        swampApiKey: "",
      },
    }),
    "",
  );
});

Deno.test("a vault read failure warns via logger.warn and yields no key", async () => {
  // Guards the LogTape surface: the logger method is `warn`, not `warning`.
  // A `logger.warning(...)` call would throw here rather than warn.
  const warnings: string[] = [];
  const key = await resolveApiKey({
    globalArgs: {
      vault: "test-factory-vault",
      vaultEntry: "SWAMP_API_KEY",
      swampApiKey: "",
    },
    vaultService: fakeVault(["test-factory-vault"], {}),
    logger: { warn: (msg) => warnings.push(msg) },
  });
  assertEquals(key, "");
  assertEquals(warnings.length, 1);
  assertStringIncludes(warnings[0], "Could not read SWAMP_API_KEY");
});

Deno.test("containerEnv sets SWAMP_API_KEY only when provided", () => {
  const withKey = containerEnv("swamp_org_deadbeef");
  assertEquals(withKey.SWAMP_API_KEY, "swamp_org_deadbeef");
  assertEquals(withKey.SWAMP_TELEMETRY_DISABLED, "1");

  const without = containerEnv("");
  assertEquals("SWAMP_API_KEY" in without, false);
});

Deno.test("the API key is passed to every container via docker run -e", async () => {
  const { runner, calls } = stubRunner();
  const { manifest, dir } = await writeCandidate();
  try {
    const { promise } = await runMethod(
      "test",
      {
        manifest,
        scenario: "debian-standalone",
        phases: "smoke",
        _run: runner,
      },
      {
        repoDir: dir,
        globalArgs: { swampApiKey: "swamp_org_cafef00d" },
      },
    );
    await promise;
    const runCalls = calls.filter((c) => c[0] === "docker" && c[1] === "run");
    assertEquals(runCalls.length >= 1, true);
    for (const call of runCalls) {
      assertEquals(call.includes("SWAMP_API_KEY=swamp_org_cafef00d"), true);
    }
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("listScenarios writes no data", async () => {
  const { promise } = await runMethod("listScenarios", {}, { repoDir: "/tmp" });
  const result = await promise;
  assertEquals(result.dataHandles, []);
});

Deno.test("resolvePhases auto-enables tests after definitions", () => {
  assertEquals(
    resolvePhases("", "smoke,load,definitions", true),
    ["smoke", "load", "definitions", "tests"],
  );
  // An explicit override always wins.
  assertEquals(
    resolvePhases("smoke,load", "smoke,load,definitions", true),
    ["smoke", "load"],
  );
  // No tests file → no tests phase.
  assertEquals(
    resolvePhases("", "smoke,load,definitions", false),
    ["smoke", "load", "definitions"],
  );
});

const soundTest: TestSpec = {
  name: "t",
  confirms: "does the thing",
  cannot: "must not error",
  variables: {},
  steps: [{
    name: "s",
    run: "swamp --version",
    timeoutSeconds: 30,
    continueOnFailure: false,
    expect: { exitCode: 0, stdoutNotContains: ["error"] },
  }],
};

Deno.test("preflightTests throws on a non-proving test", () => {
  const broken: TestSpec = {
    ...soundTest,
    steps: [{ ...soundTest.steps[0], expect: { exitCode: 0 } }],
  };
  assertThrows(
    () => preflightTests([broken], ["tests"]),
    Error,
    "no step asserts a negative",
  );
});

Deno.test("preflightTests is a no-op when tests are not requested", () => {
  preflightTests([{ ...soundTest, confirms: "" }], ["smoke"]);
});
