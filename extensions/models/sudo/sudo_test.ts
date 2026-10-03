import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1";

import { approvalNonce, isLocalRoute, model, resolveOrder } from "./sudo.ts";
import {
  DEFAULT_STRATEGY_ORDER,
  getStrategy,
  listStrategyIds,
  parseGroupList,
  shellJoin,
  shellQuote,
} from "./sudo_strategies.ts";
import {
  assertServiceUnit,
  getOperation,
  listOperationIds,
  OPERATIONS,
  packageArgv,
} from "./sudo_operations.ts";
// ---------------------------------------------------------------------------
// shell quoting
// ---------------------------------------------------------------------------

Deno.test("shellQuote leaves safe tokens bare and quotes the rest", () => {
  assertEquals(shellQuote("apt-get"), "apt-get");
  assertEquals(shellQuote("/usr/bin/env"), "/usr/bin/env");
  assertEquals(shellQuote("a b"), "'a b'");
  assertEquals(shellQuote(""), "''");
  assertEquals(shellQuote("it's"), "'it'\\''s'");
});

Deno.test("shellJoin cannot be broken out of by a malicious token", () => {
  const joined = shellJoin(["/bin/sh", "-c", "echo hi; rm -rf /"]);
  assertEquals(joined, "/bin/sh -c 'echo hi; rm -rf /'");
  // The semicolon is inside single quotes, so a POSIX shell treats it literally.
  assertStringIncludes(joined, "'echo hi; rm -rf /'");
});

// ---------------------------------------------------------------------------
// strategy catalogue
// ---------------------------------------------------------------------------

Deno.test("the default order names only known strategies", () => {
  for (const id of DEFAULT_STRATEGY_ORDER) {
    assertEquals(getStrategy(id) !== undefined, true, `unknown id ${id}`);
  }
  assertEquals(listStrategyIds().length >= DEFAULT_STRATEGY_ORDER.length, true);
});

Deno.test("no strategy argv uses a bare '--' after run0/pkexec/ssh", () => {
  const g = {
    sshHost: "root.example",
    sshKnownHosts: "",
    containerImage: "alpine@sha256:abc",
    containerName: "c",
    k8sNode: "node-1",
    ssmInstanceId: "",
  };
  // run0 takes no `--` before the program.
  assertEquals(
    getStrategy("run0")!.build(["id", "-u"], g),
    ["run0", "--no-ask-password", "--pipe", "/usr/bin/env", "id", "-u"],
  );
  // pkexec takes no `--` before the program.
  assertEquals(
    getStrategy("pkexec")!.build(["id", "-u"], g),
    ["pkexec", "--disable-internal-agent", "/usr/bin/env", "id", "-u"],
  );
  // ssh stops option parsing at the hostname: no `--`, command is one quoted arg.
  const ssh = getStrategy("ssh-root")!.build(["echo", "hi there"], g);
  assertEquals(ssh[ssh.length - 1], "echo 'hi there'");
  assertEquals(ssh.includes("--"), false);
});

Deno.test("sudo build uses an explicit -- terminator", () => {
  const g = {
    sshHost: "",
    sshKnownHosts: "",
    containerImage: "",
    containerName: "",
    k8sNode: "",
    ssmInstanceId: "",
  };
  assertEquals(
    getStrategy("sudo-n")!.build(["-l"], g),
    ["sudo", "-n", "--", "-l"],
  );
});

Deno.test("container build passes argv positionally, not interpolated", () => {
  const g = {
    sshHost: "",
    sshKnownHosts: "",
    containerImage: "alpine@sha256:abc",
    containerName: "",
    k8sNode: "",
    ssmInstanceId: "",
  };
  const full = getStrategy("docker-run")!.build(
    ["sh", "-c", "echo; rm -rf /"],
    g,
  );
  // The hostile string stays one argv element; it is never concatenated.
  assertEquals(full[full.length - 1], "echo; rm -rf /");
  assertStringIncludes(full.join("\u0000"), 'exec chroot /host "$@"');
});

Deno.test("preconditions gate unconfigured routes", () => {
  const empty = {
    sshHost: "",
    sshKnownHosts: "",
    containerImage: "",
    containerName: "",
    k8sNode: "",
    ssmInstanceId: "",
  };
  assertEquals(getStrategy("ssh-root")!.precondition(empty) !== null, true);
  assertEquals(getStrategy("k8s-node")!.precondition(empty) !== null, true);
  assertEquals(getStrategy("docker-exec")!.precondition(empty) !== null, true);
  assertEquals(getStrategy("ssm-run")!.precondition(empty) !== null, true);
  assertEquals(getStrategy("sudo-n")!.precondition(empty), null);
  assertEquals(getStrategy("docker-run")!.precondition(empty), null);
});

Deno.test("resolveOrder honours a pin and otherwise uses the configured order", () => {
  assertEquals(resolveOrder(["a", "b"], "b"), ["b"]);
  assertEquals(resolveOrder(["a", "b"], "auto"), ["a", "b"]);
  assertEquals(resolveOrder(["a", "b"], ""), ["a", "b"]);
});

Deno.test("isLocalRoute accepts local and capability routes only", () => {
  assertEquals(isLocalRoute("sudo-n"), true);
  assertEquals(isLocalRoute("nsenter"), true);
  assertEquals(isLocalRoute("docker-run"), false);
  assertEquals(isLocalRoute("k8s-node"), false);
  assertEquals(isLocalRoute("ssm-run"), false);
});

Deno.test("parseGroupList splits identity group output", () => {
  assertEquals(parseGroupList("sven adm docker\n"), ["sven", "adm", "docker"]);
  assertEquals(parseGroupList(""), []);
});

// ---------------------------------------------------------------------------
// operation catalogue
// ---------------------------------------------------------------------------

Deno.test("every listed operation has an id-keyed entry", () => {
  for (const id of listOperationIds()) {
    assertEquals(OPERATIONS[id].id, id);
  }
});

Deno.test("packageArgv builds per-manager install and remove argv", () => {
  assertEquals(packageArgv("apt", "install", ["caddy"]), [
    "apt-get",
    "install",
    "-y",
    "caddy",
  ]);
  assertEquals(packageArgv("apt", "remove", ["caddy"]), [
    "apt-get",
    "remove",
    "-y",
    "caddy",
  ]);
  assertEquals(packageArgv("dnf", "install", ["caddy"]), [
    "dnf",
    "install",
    "-y",
    "caddy",
  ]);
  assertEquals(packageArgv("apk", "install", ["caddy"]), [
    "apk",
    "add",
    "caddy",
  ]);
  assertEquals(packageArgv("pacman", "install", ["caddy"]), [
    "pacman",
    "-S",
    "--noconfirm",
    "caddy",
  ]);
});

Deno.test("operations reject option and package injection", () => {
  assertThrows(() => packageArgv("apt", "install", ["--force-yes"]));
  assertThrows(() =>
    getOperation("manageService")!.build({ unit: "--now", action: "start" })
  );
  assertThrows(() =>
    getOperation("manageService")!.build({ unit: "a b", action: "start" })
  );
  assertThrows(() =>
    getOperation("installPackage")!.build({ manager: "apt", packages: [] })
  );
  assertThrows(() =>
    getOperation("sysctl")!.build({ key: "net.ipv4;x", value: "1" })
  );
});

Deno.test("absolute-path operations reject relative paths", () => {
  assertThrows(() =>
    getOperation("chown")!.build({
      path: "etc/passwd",
      owner: "root",
      group: "root",
    })
  );
  assertThrows(() => getOperation("ensureDirectory")!.build({ path: "-rf" }));
});

Deno.test("manageService builds a normalised systemctl argv", () => {
  assertEquals(
    getOperation("manageService")!.build({ unit: "caddy", action: "restart" }),
    { kind: "argv", argv: ["systemctl", "restart", "caddy"] },
  );
});

Deno.test("writeFile validates and returns a staged write", () => {
  const built = getOperation("writeFile")!.build({
    path: "/etc/hosts",
    content: "x\n",
    mode: "0644",
  });
  assertEquals(built, {
    kind: "writeFile",
    path: "/etc/hosts",
    content: "x\n",
    mode: 0o644,
  });
  assertThrows(() =>
    getOperation("writeFile")!.build({ path: "relative", content: "x" })
  );
});

Deno.test("assertServiceUnit accepts units and rejects flags", () => {
  assertServiceUnit("caddy.service");
  assertServiceUnit("getty@tty1");
  assertThrows(() => assertServiceUnit("--now"));
  assertThrows(() => assertServiceUnit("a;b"));
});

// ---------------------------------------------------------------------------
// approval nonce
// ---------------------------------------------------------------------------

Deno.test("approvalNonce is stable for the same command+reason and changes otherwise", async () => {
  const a = await approvalNonce(["id", "-u"], "smoke test");
  const b = await approvalNonce(["id", "-u"], "smoke test");
  const c = await approvalNonce(["id", "-u"], "different");
  const d = await approvalNonce(["rm", "-rf", "/"], "smoke test");
  assertEquals(a, b);
  assertEquals(a === c, false);
  assertEquals(a === d, false);
});

// ---------------------------------------------------------------------------
// model gating
// ---------------------------------------------------------------------------

function testContext(globalArgs: Record<string, unknown>) {
  const written: Record<string, Record<string, unknown>> = {};
  return {
    written,
    context: {
      globalArgs,
      writeResource: (
        spec: string,
        _name: string,
        data: Record<string, unknown>,
      ) => {
        written[spec] = data;
        return Promise.resolve({ name: spec });
      },
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

Deno.test("runApproved refuses without the operator token", async () => {
  const { context } = testContext({ allowArbitrary: true });
  const nonce = await approvalNonce(["id"], "test");
  await assertRejects(
    () =>
      model.methods.runApproved.execute(
        { command: ["id"], reason: "test", nonce, approvalToken: "wrong" },
        context as never,
      ),
    Error,
    "SWAMP_SUDO_APPROVAL_TOKEN is not set",
  );
});

Deno.test("request writes a nonce that matches the command+reason", async () => {
  const { context, written } = testContext({ allowArbitrary: true });
  await model.methods.request.execute(
    { command: ["id", "-u"], reason: "smoke" },
    context as never,
  );
  const request = written["request"];
  assertEquals(typeof request.nonce, "string");
  assertEquals(
    request.nonce,
    await approvalNonce(["id", "-u"], "smoke"),
  );
});

Deno.test("run rejects an operation outside allowedOperations", async () => {
  const { context } = testContext({ allowedOperations: ["manageService"] });
  await assertRejects(
    () =>
      model.methods.run.execute(
        {
          operation: "writeFile",
          args: { path: "/x", content: "y" },
          strategy: "auto",
        },
        context as never,
      ),
    Error,
    "not allowed",
  );
});
