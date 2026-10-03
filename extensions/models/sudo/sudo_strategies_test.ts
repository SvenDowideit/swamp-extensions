import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";

import {
  DEFAULT_STRATEGY_ORDER,
  dockerIsRootless,
  getStrategy,
  listStrategyIds,
  parseGroupList,
  podmanIsRootless,
  safeEnv,
  shellJoin,
  shellQuote,
} from "./sudo_strategies.ts";

const g = {
  sshHost: "root.example",
  sshKnownHosts: "/etc/swamp/known_hosts",
  containerImage: "alpine@sha256:abc",
  containerNetwork: "none",
  k8sNode: "node-1",
  ssmInstanceId: "",
};

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
  assertStringIncludes(joined, "'echo hi; rm -rf /'");
});

Deno.test("the default order names only known strategies", () => {
  for (const id of DEFAULT_STRATEGY_ORDER) {
    assertEquals(getStrategy(id) !== undefined, true, `unknown id ${id}`);
  }
  assertEquals(listStrategyIds().length >= DEFAULT_STRATEGY_ORDER.length, true);
});

Deno.test("docker-exec is removed from the catalogue", () => {
  assertEquals(getStrategy("docker-exec"), undefined);
  assertEquals(DEFAULT_STRATEGY_ORDER.includes("docker-exec"), false);
});

Deno.test("run0 and pkexec take no '--' before the program", () => {
  assertEquals(
    getStrategy("run0")!.build(["id", "-u"], g),
    ["run0", "--no-ask-password", "--pipe", "/usr/bin/env", "id", "-u"],
  );
  assertEquals(
    getStrategy("pkexec")!.build(["id", "-u"], g),
    ["pkexec", "--disable-internal-agent", "/usr/bin/env", "id", "-u"],
  );
});

Deno.test("ssh stops option parsing at the hostname: no '--', one quoted command", () => {
  const ssh = getStrategy("ssh-root")!.build(["echo", "hi there"], g);
  assertEquals(ssh[ssh.length - 1], "echo 'hi there'");
  assertEquals(ssh.includes("--"), false);
  assertStringIncludes(ssh.join(" "), "-o StrictHostKeyChecking=yes");
});

Deno.test("sudo build uses an explicit -- terminator", () => {
  assertEquals(
    getStrategy("sudo-n")!.build(["-l"], g),
    ["sudo", "-n", "--", "-l"],
  );
});

Deno.test("container build passes argv positionally and defaults to network none", () => {
  const full = getStrategy("docker-run")!.build(
    ["sh", "-c", "echo; rm -rf /"],
    g,
  );
  assertEquals(full[full.length - 1], "echo; rm -rf /");
  assertStringIncludes(full.join("\u0000"), 'exec chroot /host "$@"');
  assertStringIncludes(full.join(" "), "--network=none");
});

Deno.test("container network mode is configurable", () => {
  const hostNet = getStrategy("docker-run")!.build(["id"], {
    ...g,
    containerNetwork: "host",
  });
  assertStringIncludes(hostNet.join(" "), "--network=host");
});

Deno.test("container proof reads a host-visible marker, not container id", () => {
  const probe = getStrategy("docker-run")!.probeArgv(g);
  assertStringIncludes(probe.join(" "), "/etc/machine-id");
  assertEquals(probe.join(" ").includes("id -u"), false);
});

Deno.test("rootless detection helpers", () => {
  assert(dockerIsRootless('["name=seccomp","name=rootless"]'));
  assert(!dockerIsRootless('["name=seccomp,profile=builtin"]'));
  assert(podmanIsRootless("true"));
  assert(podmanIsRootless('"rootless": true'));
  assert(!podmanIsRootless("false"));
});

Deno.test("docker and podman expose a rootless check; nerdctl does not", () => {
  assertEquals(typeof getStrategy("docker-run")!.rootless, "object");
  assertEquals(typeof getStrategy("podman-run")!.rootless, "object");
  assertEquals(getStrategy("nerdctl-run")!.rootless, undefined);
});

Deno.test("preconditions gate unconfigured routes", () => {
  const empty = { ...g, sshHost: "", k8sNode: "", ssmInstanceId: "" };
  assertEquals(getStrategy("ssh-root")!.precondition(empty) !== null, true);
  assertEquals(getStrategy("k8s-node")!.precondition(empty) !== null, true);
  assertEquals(getStrategy("ssm-run")!.precondition(empty) !== null, true);
  assertEquals(getStrategy("sudo-n")!.precondition(empty), null);
  assertEquals(getStrategy("docker-run")!.precondition(empty), null);
});

Deno.test("elevation failure is distinguished from a program failure", () => {
  const sudo = getStrategy("sudo-n")!;
  assertEquals(
    sudo.elevationFailed(1, "sudo: interactive authentication is required"),
    true,
  );
  assertEquals(sudo.elevationFailed(5, "Unit not found"), false);
  const ssh = getStrategy("ssh-root")!;
  assertEquals(ssh.elevationFailed(255, "Permission denied (publickey)"), true);
});

Deno.test("k8s proof runs inside the host chroot (no /host/host path)", () => {
  const probe = getStrategy("k8s-node")!.probeArgv(g).join(" ");
  assertStringIncludes(probe, "chroot");
  assertStringIncludes(probe, "/etc/machine-id");
  assertEquals(probe.includes("/host/etc/machine-id"), false);
});

Deno.test("parseGroupList splits identity group output", () => {
  assertEquals(parseGroupList("sven adm docker\n"), ["sven", "adm", "docker"]);
  assertEquals(parseGroupList(""), []);
});

Deno.test("safeEnv returns empty rather than throwing without env access", () => {
  assertEquals(typeof safeEnv("__SWAMP_SUDO_MISSING__"), "string");
});
