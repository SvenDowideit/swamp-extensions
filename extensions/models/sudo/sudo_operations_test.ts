import { assertEquals, assertThrows } from "jsr:@std/assert@1";

import {
  assertServiceUnit,
  getOperation,
  listOperationIds,
  OPERATIONS,
  PACKAGE_MANAGERS,
  packageArgv,
} from "./sudo_operations.ts";

Deno.test("every listed operation has an id-keyed entry", () => {
  for (const id of listOperationIds()) {
    assertEquals(OPERATIONS[id].id, id);
  }
});

Deno.test("PackageManagers covers every manager the install argv supports", () => {
  for (const m of PACKAGE_MANAGERS) {
    const argv = packageArgv(m, "install", ["caddy"]);
    assertEquals(argv.length > 0, true, `no argv for ${m}`);
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
  assertEquals(packageArgv("dnf", "install", ["caddy"])[0], "dnf");
  assertEquals(packageArgv("yum", "install", ["caddy"])[0], "yum");
  assertEquals(packageArgv("zypper", "install", ["caddy"]), [
    "zypper",
    "--non-interactive",
    "install",
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
  assertThrows(() =>
    getOperation("addUserToGroup")!.build({ user: "-x", group: "sudo" })
  );
  assertThrows(() =>
    getOperation("mount")!.build({ source: "-o", target: "/mnt/x" })
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
