import { assertEquals, assertThrows } from "jsr:@std/assert@1";

import {
  DEFAULT_ALLOWED_OPERATIONS,
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

Deno.test("writeFile is removed; the default allowlist is the narrow set", () => {
  assertEquals(getOperation("writeFile"), undefined);
  assertEquals(DEFAULT_ALLOWED_OPERATIONS.includes("writeFile"), false);
  assertEquals(DEFAULT_ALLOWED_OPERATIONS, [
    "installPackage",
    "removePackage",
    "manageService",
    "sysctl",
  ]);
  for (
    const id of [
      "mount",
      "chown",
      "ensureDirectory",
      "addUserToGroup",
      "createUser",
    ]
  ) {
    assertEquals(getOperation(id) !== undefined, true, `${id} missing`);
    assertEquals(DEFAULT_ALLOWED_OPERATIONS.includes(id), false);
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

Deno.test("createUser builds a validated useradd argv", () => {
  assertEquals(
    getOperation("createUser")!.build({ user: "svc", comment: "service user" }),
    {
      kind: "argv",
      argv: ["useradd", "--system", "--comment", "service user", "svc"],
    },
  );
  assertThrows(() => getOperation("createUser")!.build({ user: "-x" }));
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
