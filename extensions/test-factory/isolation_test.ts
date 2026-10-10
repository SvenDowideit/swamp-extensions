import { assertEquals } from "jsr:@std/assert@1";
import { applyRunToken, evaluateIsolation } from "./isolation.ts";
import type { IsolationCheck } from "./services.ts";

function check(over: Partial<IsolationCheck>): IsolationCheck {
  return {
    name: "c",
    confirms: "a",
    cannot: "b",
    absentOnHost: [],
    noPublishedPorts: [],
    ...over,
  };
}

Deno.test("applyRunToken substitutes both spellings and leaves others", () => {
  assertEquals(applyRunToken("/x-$TF_RUN_ID", "abc"), "/x-abc");
  assertEquals(applyRunToken("/x-${TF_RUN_ID}", "abc"), "/x-abc");
  assertEquals(applyRunToken("echo $HOME", "abc"), "echo $HOME");
});

Deno.test("evaluateIsolation passes when every probe holds", () => {
  const f = evaluateIsolation(
    check({
      sandbox: "sudo true",
      absentOnHost: ["/x"],
      noPublishedPorts: ["harness"],
    }),
    {
      sandbox: { code: 0, stdout: "", stderr: "" },
      hostPaths: [{ path: "/x", exists: false }],
      publishedPorts: [{ role: "harness", container: "c1", bindings: [] }],
    },
  );
  assertEquals(f.ok, true);
  assertEquals(f.steps.length, 3);
  assertEquals(f.steps.every((s) => s.ok), true);
});

Deno.test("evaluateIsolation fails when the sandbox command fails", () => {
  const f = evaluateIsolation(
    check({ sandbox: "sudo false" }),
    {
      sandbox: { code: 1, stdout: "", stderr: "denied" },
      hostPaths: [],
      publishedPorts: [],
    },
  );
  assertEquals(f.ok, false);
  assertEquals(f.errors.some((e) => e.includes("exited 1")), true);
});

Deno.test("evaluateIsolation fails when a host path exists", () => {
  const f = evaluateIsolation(
    check({ absentOnHost: ["/escaped-abc"] }),
    {
      sandbox: null,
      hostPaths: [{ path: "/escaped-abc", exists: true }],
      publishedPorts: [],
    },
  );
  assertEquals(f.ok, false);
  assertEquals(f.errors.some((e) => e.includes("must not")), true);
});

Deno.test("evaluateIsolation fails when a container publishes a port", () => {
  const f = evaluateIsolation(
    check({ noPublishedPorts: ["harness"] }),
    {
      sandbox: null,
      hostPaths: [],
      publishedPorts: [{
        role: "harness",
        container: "c1",
        bindings: ["80/tcp -> 0.0.0.0:8080"],
      }],
    },
  );
  assertEquals(f.ok, false);
  assertEquals(f.errors.some((e) => e.includes("publishes port")), true);
});

Deno.test("evaluateIsolation fails when nothing was probed", () => {
  const f = evaluateIsolation(check({}), {
    sandbox: null,
    hostPaths: [],
    publishedPorts: [],
  });
  assertEquals(f.ok, false);
  assertEquals(f.errors.some((e) => e.includes("no probes")), true);
});
