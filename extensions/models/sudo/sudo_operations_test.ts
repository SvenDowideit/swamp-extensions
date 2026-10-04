import { assertEquals, assertThrows } from "jsr:@std/assert@1";

import {
  DEFAULT_ALLOWED_OPERATIONS,
  getOperation,
  listOperationIds,
  OPERATIONS,
  PACKAGE_MANAGERS,
  packageArgv,
} from "./sudo_operations.ts";

Deno.test("filesystem/account-mutating operations are localOnly (refuse remote routes)", () => {
  for (
    const id of [
      "chown",
      "ensureDirectory",
      "addUserToGroup",
      "createUser",
      "mount",
      "installFile",
      "removePath",
      "copyDirectory",
      "runScript",
    ]
  ) {
    assertEquals(getOperation(id)!.localOnly, true, `${id} must be localOnly`);
  }
});

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
  ]);
  for (
    const id of [
      "mount",
      "chown",
      "ensureDirectory",
      "addUserToGroup",
      "createUser",
      "sysctl",
      "installFile",
      "daemonReload",
      "removePath",
      "copyDirectory",
      "runScript",
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
  assertThrows(() =>
    getOperation("installFile")!.build({ src: "rel.bin", dest: "/usr/bin/x" })
  );
  assertThrows(() =>
    getOperation("installFile")!.build({ src: "/tmp/x", dest: "-m" })
  );
  assertThrows(() => getOperation("removePath")!.build({ path: "tmp/x" }));
  assertThrows(() => getOperation("runScript")!.build({ script: "-c" }));
});

Deno.test("installFile builds an install -D -m argv", () => {
  assertEquals(
    getOperation("installFile")!.build({
      src: "/tmp/stage/ollama",
      dest: "/usr/local/bin/ollama",
      mode: "0755",
    }),
    {
      kind: "argv",
      argv: [
        "install",
        "-D",
        "-m",
        "0755",
        "/tmp/stage/ollama",
        "/usr/local/bin/ollama",
      ],
    },
  );
  assertEquals(
    getOperation("installFile")!.build({
      src: "/tmp/stage/unit",
      dest: "/etc/systemd/system/ollama.service",
    }),
    {
      kind: "argv",
      argv: [
        "install",
        "-D",
        "-m",
        "0644",
        "/tmp/stage/unit",
        "/etc/systemd/system/ollama.service",
      ],
    },
  );
  assertThrows(() =>
    getOperation("installFile")!.build({ src: "/tmp/x", mode: "0999" })
  );
});

Deno.test("daemonReload builds systemctl daemon-reload", () => {
  assertEquals(getOperation("daemonReload")!.build({}), {
    kind: "argv",
    argv: ["systemctl", "daemon-reload"],
  });
  assertThrows(() =>
    getOperation("daemonReload")!.build({ extra: "injected" })
  );
});

Deno.test("removePath builds a guarded rm -rf argv", () => {
  assertEquals(
    getOperation("removePath")!.build({ path: "/usr/local/lib/ollama" }),
    { kind: "argv", argv: ["rm", "-rf", "--", "/usr/local/lib/ollama"] },
  );
  assertThrows(() => getOperation("removePath")!.build({ path: "/" }));
  assertThrows(() => getOperation("removePath")!.build({ path: ".." }));
});

Deno.test("runScript builds a sh-interpreted argv for an absolute script", () => {
  assertEquals(
    getOperation("runScript")!.build({
      script: "/tmp/stage/install.sh",
      args: [],
    }),
    { kind: "argv", argv: ["sh", "/tmp/stage/install.sh"] },
  );
  assertEquals(
    getOperation("runScript")!.build({
      script: "/tmp/stage/install.sh",
      args: ["--verbose"],
    }),
    { kind: "argv", argv: ["sh", "/tmp/stage/install.sh", "--verbose"] },
  );
  assertThrows(() => getOperation("runScript")!.build({ script: "~/x.sh" }));
  assertThrows(() =>
    getOperation("runScript")!.build({ script: "/tmp/x.sh", args: ["a\nb"] })
  );
});

Deno.test("copyDirectory builds a guarded cp -a argv", () => {
  assertEquals(
    getOperation("copyDirectory")!.build({
      src: "/tmp/stage/lib/ollama",
      dest: "/usr/local/lib/ollama",
    }),
    {
      kind: "argv",
      argv: ["cp", "-a", "/tmp/stage/lib/ollama/.", "/usr/local/lib/ollama/"],
    },
  );
  assertThrows(() =>
    getOperation("copyDirectory")!.build({ src: "rel/dir", dest: "/usr/lib/x" })
  );
  assertThrows(() =>
    getOperation("copyDirectory")!.build({ src: "/", dest: "/backup" })
  );
});

Deno.test("manageService builds a normalised systemctl argv", () => {
  assertEquals(
    getOperation("manageService")!.build({ unit: "caddy", action: "restart" }),
    { kind: "argv", argv: ["systemctl", "restart", "caddy"] },
  );
});
