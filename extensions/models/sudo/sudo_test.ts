import { assertEquals, assertRejects } from "jsr:@std/assert@1";

import {
  isLocalRoute,
  isTimedOut,
  model,
  proofTimeoutMs,
  resolveOrder,
  runCmd,
} from "./sudo.ts";
import {
  containerEndpointIsLocal,
  DEFAULT_STRATEGY_ORDER,
  getStrategy,
} from "./sudo_strategies.ts";

/** Whether this process may spawn commands (plain `deno test` denies `run`). */
function hasRunPermission(): boolean {
  try {
    const status = new Deno.Command("true").outputSync();
    return status.code === 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Routing helpers
// ---------------------------------------------------------------------------

Deno.test("resolveOrder honours a pin and otherwise uses the configured order", () => {
  assertEquals(resolveOrder(["a", "b"], "b"), ["b"]);
  assertEquals(resolveOrder(["a", "b"], "auto"), ["a", "b"]);
  assertEquals(resolveOrder(["a", "b"], ""), ["a", "b"]);
});

Deno.test("ssh-root is a remote route, not a local one", () => {
  assertEquals(getStrategy("ssh-root")!.class, "remote");
  assertEquals(isLocalRoute("ssh-root"), false);
  assertEquals(isLocalRoute("sudo-n"), true);
  assertEquals(isLocalRoute("nsenter"), true);
  // Container routes run the operation on the host via `chroot /host`, so a
  // local-only operation may use them. Orchestrator/oob routes may not.
  assertEquals(isLocalRoute("docker-run"), true);
  assertEquals(isLocalRoute("podman-run"), true);
  assertEquals(isLocalRoute("k8s-node"), false);
  assertEquals(isLocalRoute("ssm-run"), false);
});

Deno.test("the timeout is detected from the termination signal, not a thrown error", () => {
  assertEquals(isTimedOut("SIGTERM", 143), true);
  assertEquals(isTimedOut("SIGTERM", 0), true);
  assertEquals(isTimedOut(null, 143), true);
  assertEquals(isTimedOut(null, 0), false);
  assertEquals(isTimedOut(null, 1), false);
});

Deno.test("proofTimeoutMs gives side-effecting proofs a long timeout", () => {
  assertEquals(proofTimeoutMs(getStrategy("sudo-n")!.sideEffects, 8), 8000);
  assertEquals(
    proofTimeoutMs(getStrategy("docker-run")!.sideEffects, 8),
    120000,
  );
  assertEquals(
    proofTimeoutMs(getStrategy("k8s-node")!.sideEffects, 30),
    120000,
  );
});

Deno.test("the default ladder contains no docker-exec", () => {
  assertEquals(DEFAULT_STRATEGY_ORDER.includes("docker-exec"), false);
  assertEquals(getStrategy("docker-exec"), undefined);
});

// ---------------------------------------------------------------------------
// Route resolution (injectable executor — no host access needed)
// ---------------------------------------------------------------------------

function globalArgs(overrides: Record<string, unknown> = {}) {
  return {
    strategyOrder: [
      "sudo-n",
      "docker-run",
      "podman-run",
      "ssh-root",
      "k8s-node",
      "ssm-run",
    ],
    allowedOperations: ["manageService"],
    allowArbitrary: false,
    sshHost: "",
    sshKnownHosts: "",
    containerImage: "alpine@sha256:abc",
    containerNetwork: "none",
    k8sNode: "",
    ssmInstanceId: "",
    timeoutSeconds: 120,
    probeTimeoutSeconds: 8,
    allowAudit: false,
    approvalVault: "sudo-approval",
    ...overrides,
  };
}

/** An exec stub keyed by the binary; records every invocation. */
function stubExec(
  responses: Record<
    string,
    { stdout?: string; stderr?: string; code?: number; notFound?: boolean }
  >,
) {
  const calls: string[] = [];
  const exec = (
    binary: string,
    _args: string[],
    _timeoutMs: number,
  ) => {
    calls.push(binary);
    const r = responses[binary] ?? { code: 127, notFound: true };
    return Promise.resolve({
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
      code: r.notFound ? 127 : (r.code ?? 0),
      signal: null,
      notFound: r.notFound ?? false,
      timedOut: false,
      truncated: false,
    });
  };
  return { exec, calls };
}

// ---------------------------------------------------------------------------
// Model gating (uses fakes for the swamp method context)
// ---------------------------------------------------------------------------

function testContext(
  globalArgs: Record<string, unknown>,
  stored: Record<string, unknown> | null = null,
  exec?: unknown,
  vault?: { secrets?: Record<string, string>; deleted?: string[] },
) {
  const written: Record<
    string,
    { name: string; data: Record<string, unknown> }
  > = {};
  const deleted: string[] = [];
  const vaultDeleted: string[] = [];
  return {
    written,
    deleted,
    vaultDeleted,
    context: {
      globalArgs,
      writeResource: (
        spec: string,
        name: string,
        data: Record<string, unknown>,
      ) => {
        written[spec] = { name, data };
        return Promise.resolve({ name });
      },
      readResource: (_name?: string, _version?: number) =>
        Promise.resolve(stored),
      deleteResource: (name: string) => {
        deleted.push(name);
        return Promise.resolve();
      },
      ...(exec ? { _exec: exec } : {}),
      ...(vault
        ? {
          vaultService: {
            get: (_v: string, key: string) =>
              Promise.resolve(vault.secrets?.[key] ?? ""),
            delete: (_v: string, key: string) => {
              vaultDeleted.push(key);
              return Promise.resolve();
            },
          },
        }
        : {}),
      definition: { id: "test", name: "sudo-test", version: "test", tags: {} },
    },
  };
}

/** Run `probe` with an injected executor and return its written `probe` data. */
async function runProbe(
  overrides: Record<string, unknown>,
  exec: unknown,
  args: Record<string, unknown> = {},
) {
  const { context, written } = testContext(globalArgs(overrides), null, exec);
  await model.methods.probe.execute(
    // deno-lint-ignore no-explicit-any
    { strategy: "auto", ...args } as any,
    context as never,
  );
  return written["probe"].data as {
    winner: { id: string } | null;
    ladder: Array<{ id: string; proved: boolean; reason: string }>;
  };
}

Deno.test("probe stops at the first proved route and does not probe later ones", async () => {
  // sudo proves root; the container route (side-effecting) must not be touched.
  const { exec, calls } = stubExec({
    sudo: { stdout: "", code: 0 },
    docker: { stdout: "machine-id", code: 0 },
  });
  const data = await runProbe({}, exec);
  assertEquals(data.winner?.id, "sudo-n");
  assertEquals(calls.includes("docker"), false);
});

Deno.test("probe rejects a rootless container daemon before the root probe", async () => {
  const { exec } = stubExec({
    sudo: { stdout: "", code: 1, stderr: "authentication is required" },
    docker: { stdout: '["name=rootless"]', code: 0 },
  });
  const data = await runProbe({}, exec);
  const dockerEntry = data.ladder.find((e) => e.id === "docker-run")!;
  assertEquals(dockerEntry.proved, false);
  assertEquals(dockerEntry.reason, "rootless daemon cannot yield host root");
  assertEquals(data.winner, null);
});

Deno.test("containerEndpointIsLocal distinguishes local sockets from remote endpoints", () => {
  assertEquals(containerEndpointIsLocal(""), true);
  assertEquals(containerEndpointIsLocal("unix:///var/run/docker.sock"), true);
  assertEquals(containerEndpointIsLocal("/run/podman/podman.sock"), true);
  assertEquals(containerEndpointIsLocal("ssh://remote.example"), false);
  assertEquals(containerEndpointIsLocal("tcp://192.0.2.9:2375"), false);
});

Deno.test("container routes refuse a remote daemon", () => {
  const docker = getStrategy("docker-run")!;
  const cfg = {
    sshHost: "",
    sshKnownHosts: "",
    containerImage: "alpine@sha256:abc",
    containerNetwork: "none",
    k8sNode: "",
    ssmInstanceId: "",
    containerEndpoint: "ssh://remote.example",
    k8sRunName: "swamp-sudo-test",
  };
  assertEquals(typeof docker.precondition(cfg) === "string", true);
  assertEquals(docker.precondition({ ...cfg, containerEndpoint: "" }), null);
});

Deno.test("a container route is allowed for a local-only operation (runs on the host via chroot)", async () => {
  // mount is localOnly; docker-run proves host root, so it must NOT be filtered.
  const exec = (
    _binary: string,
    _args: string[],
    _timeoutMs: number,
  ) =>
    Promise.resolve({
      stdout: "machine-id",
      stderr: "",
      code: 0,
      signal: null,
      notFound: false,
      timedOut: false,
      truncated: false,
    });
  const { context, written } = testContext(
    globalArgs({
      allowedOperations: ["mount"],
      strategyOrder: ["docker-run"],
    }),
    null,
    exec,
  );
  await model.methods.run.execute(
    {
      operation: "mount",
      args: { source: "/dev/sda1", target: "/mnt/data" },
      strategy: "auto",
    } as never,
    context as never,
  );
  assertEquals(written["result"].data.strategyUsed, "docker-run");
  assertEquals(written["result"].data.operation, "mount");
});

Deno.test("a remote route is filtered out for a local-only operation", async () => {
  const exec = () =>
    Promise.resolve({
      stdout: "0",
      stderr: "",
      code: 0,
      signal: null,
      notFound: false,
      timedOut: false,
      truncated: false,
    });
  const { context } = testContext(
    globalArgs({
      allowedOperations: ["mount"],
      strategyOrder: ["ssh-root"],
      sshHost: "root.example",
    }),
    null,
    exec,
  );
  await assertRejects(
    () =>
      model.methods.run.execute(
        {
          operation: "mount",
          args: { source: "/dev/sda1", target: "/mnt/data" },
          strategy: "auto",
        } as never,
        context as never,
      ),
    Error,
    "No granted elevation route",
  );
});

Deno.test("request refuses when allowArbitrary is false", async () => {
  const { context } = testContext({ allowArbitrary: false });
  await assertRejects(
    () =>
      model.methods.request.execute(
        { command: ["id"], reason: "test" },
        context as never,
      ),
    Error,
    "Arbitrary commands are disabled",
  );
});

Deno.test("request writes a stable 'pending' record keyed by the request id", async () => {
  const { context, written } = testContext({ allowArbitrary: true });
  await model.methods.request.execute(
    { command: ["id", "-u"], reason: "smoke", requestId: "run-42" },
    context as never,
  );
  assertEquals(written["request"].name, "pending");
  assertEquals(written["request"].data.requestId, "run-42");
  assertEquals(written["request"].data.command, ["id", "-u"]);
  assertEquals(written["request"].data.reason, "smoke");
  // The removed nonce must not reappear on the stored record.
  assertEquals("nonce" in written["request"].data, false);
});

Deno.test("request generates a request id when none is supplied", async () => {
  const { context, written } = testContext({ allowArbitrary: true });
  await model.methods.request.execute(
    { command: ["id"], reason: "x" },
    context as never,
  );
  assertEquals(typeof written["request"].data.requestId, "string");
  assertEquals((written["request"].data.requestId as string).length > 0, true);
});

Deno.test("runApproved refuses when there is no registered request", async () => {
  const { context } = testContext({ allowArbitrary: true }, null);
  await assertRejects(
    () =>
      model.methods.runApproved.execute(
        { command: ["id"], requestId: "r1", approvalToken: "t" },
        context as never,
      ),
    Error,
    "No registered request",
  );
});

Deno.test("runApproved refuses a command that differs from the request", async () => {
  const stored = { requestId: "r1", command: ["id", "-u"], reason: "x" };
  const { context } = testContext({ allowArbitrary: true }, stored);
  await assertRejects(
    () =>
      model.methods.runApproved.execute(
        { command: ["rm", "-rf", "/"], requestId: "r1", approvalToken: "t" },
        context as never,
      ),
    Error,
    "does not match the registered request",
  );
});

Deno.test("runApproved refuses a mismatched request id", async () => {
  const stored = { requestId: "r1", command: ["id", "-u"], reason: "x" };
  const { context } = testContext({ allowArbitrary: true }, stored);
  await assertRejects(
    () =>
      model.methods.runApproved.execute(
        { command: ["id", "-u"], requestId: "r2", approvalToken: "t" },
        context as never,
      ),
    Error,
    "does not match the registered request",
  );
});

Deno.test("run rejects an operation outside allowedOperations", async () => {
  const { context } = testContext({ allowedOperations: ["manageService"] });
  await assertRejects(
    () =>
      model.methods.run.execute(
        {
          operation: "mount",
          args: { source: "/a", target: "/b" },
          strategy: "auto",
        },
        context as never,
      ),
    Error,
    "not allowed",
  );
});

Deno.test("an empty allowlist falls back to the narrow default set", async () => {
  // An empty strategy ladder makes route resolution fail with the ladder
  // report — the point is WHICH error appears: a default-set operation
  // passes the allowlist gate and reaches "no route", an opt-in one is
  // refused up front with "not allowed".
  const { context } = testContext({ allowedOperations: [], strategyOrder: [] });
  await assertRejects(
    () =>
      model.methods.run.execute(
        {
          operation: "manageService",
          args: { unit: "x", action: "stop" },
          strategy: "auto",
        },
        context as never,
      ),
    Error,
    "No granted elevation route",
  );
  await assertRejects(
    () =>
      model.methods.run.execute(
        {
          operation: "installFile",
          args: { src: "/a", dest: "/b" },
          strategy: "auto",
        },
        context as never,
      ),
    Error,
    "not allowed",
  );
});

Deno.test("run rejects an unknown operation id", async () => {
  const { context } = testContext({ allowedOperations: ["nonsense"] });
  await assertRejects(
    () =>
      model.methods.run.execute(
        { operation: "nonsense", args: {}, strategy: "auto" },
        context as never,
      ),
    Error,
    "Unknown operation",
  );
});

Deno.test(
  "a successful runApproved consumes the registered request and secret (single use)",
  async () => {
    const stored = { requestId: "r1", command: ["id", "-u"], reason: "x" };
    // sudo -n true proves root; the approved command then runs.
    const exec = (
      binary: string,
      _args: string[],
      _timeoutMs: number,
    ) =>
      Promise.resolve({
        stdout: binary === "sudo" ? "" : "0",
        stderr: "",
        code: 0,
        signal: null,
        notFound: false,
        timedOut: false,
        truncated: false,
      });
    const { context, deleted, written, vaultDeleted } = testContext(
      { allowArbitrary: true, strategyOrder: ["sudo-n"] },
      stored,
      exec,
      { secrets: { r1: "token-1" } },
    );
    await model.methods.runApproved.execute(
      {
        command: ["id", "-u"],
        requestId: "r1",
        approvalToken: "token-1",
      } as never,
      context as never,
    );
    assertEquals(deleted, ["pending"]);
    assertEquals(vaultDeleted, ["r1"]);
    assertEquals(written["result"].data.requestId, "r1");
  },
);

Deno.test(
  "runApproved refuses when no approval secret is minted for the request",
  async () => {
    const stored = { requestId: "r1", command: ["id", "-u"], reason: "x" };
    const exec = () =>
      Promise.resolve({
        stdout: "0",
        stderr: "",
        code: 0,
        signal: null,
        notFound: false,
        timedOut: false,
        truncated: false,
      });
    const { context } = testContext(
      { allowArbitrary: true, strategyOrder: ["sudo-n"] },
      stored,
      exec,
      { secrets: {} },
    );
    await assertRejects(
      () =>
        model.methods.runApproved.execute(
          { command: ["id", "-u"], requestId: "r1", approvalToken: "x" },
          context as never,
        ),
      Error,
      "No approval secret is minted",
    );
  },
);

Deno.test(
  "runApproved refuses a token that does not match the minted secret",
  async () => {
    const stored = { requestId: "r1", command: ["id", "-u"], reason: "x" };
    const exec = () =>
      Promise.resolve({
        stdout: "0",
        stderr: "",
        code: 0,
        signal: null,
        notFound: false,
        timedOut: false,
        truncated: false,
      });
    const { context } = testContext(
      { allowArbitrary: true, strategyOrder: ["sudo-n"] },
      stored,
      exec,
      { secrets: { r1: "correct-token" } },
    );
    await assertRejects(
      () =>
        model.methods.runApproved.execute(
          { command: ["id", "-u"], requestId: "r1", approvalToken: "wrong" },
          context as never,
        ),
      Error,
      "Approval token does not match",
    );
  },
);

Deno.test(
  "runCmd reports a hung command as timed out rather than exiting silently",
  {
    ignore: !hasRunPermission(),
  },
  async () => {
    const result = await runCmd("sleep", ["30"], 600);
    assertEquals(result.timedOut, true);
    assertEquals(result.truncated, false);
  },
);
