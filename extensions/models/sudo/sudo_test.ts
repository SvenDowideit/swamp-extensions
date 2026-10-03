import { assertEquals, assertRejects } from "jsr:@std/assert@1";

import {
  approvalNonce,
  isLocalRoute,
  model,
  proofTimeoutMs,
  resolveOrder,
} from "./sudo.ts";
import { DEFAULT_STRATEGY_ORDER, getStrategy } from "./sudo_strategies.ts";

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
  assertEquals(isLocalRoute("docker-run"), false);
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
// Approval nonce
// ---------------------------------------------------------------------------

Deno.test("approvalNonce binds the request id, command, and reason", async () => {
  const a = await approvalNonce("r1", ["id", "-u"], "smoke test");
  const b = await approvalNonce("r1", ["id", "-u"], "smoke test");
  const cid = await approvalNonce("r2", ["id", "-u"], "smoke test");
  const cmd = await approvalNonce("r1", ["rm", "-rf", "/"], "smoke test");
  assertEquals(a, b);
  assertEquals(a === cid, false);
  assertEquals(a === cmd, false);
});

// ---------------------------------------------------------------------------
// Model gating (uses fakes for the swamp method context)
// ---------------------------------------------------------------------------

function testContext(
  globalArgs: Record<string, unknown>,
  stored: Record<string, unknown> | null = null,
) {
  const written: Record<
    string,
    { name: string; data: Record<string, unknown> }
  > = {};
  return {
    written,
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
      definition: { id: "test", name: "sudo-test", version: "test", tags: {} },
    },
  };
}

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
  assertEquals(
    written["request"].data.nonce,
    await approvalNonce("run-42", ["id", "-u"], "smoke"),
  );
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
