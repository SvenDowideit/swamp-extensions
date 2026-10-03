/**
 * Pure operation catalogue for `@svendowideit/sudo`.
 *
 * Each operation turns **typed arguments** into an argv array — never a shell
 * string — so a caller cannot smuggle a command through a value. The model
 * validates the args against the operation's zod schema, refuses any operation
 * not in `allowedOperations`, then hands the argv to the elevation strategy.
 *
 * No I/O lives here: this module is pure and unit-testable.
 *
 * @module
 */
import { z } from "npm:zod@4";

/** Minimal view of a zod-style schema: parse raw args into typed values. */
export interface ArgsSchema {
  /** Validate and coerce raw arguments. */
  parse: (value: unknown) => unknown;
}

/** How the model should execute an operation. Always an argv — no shell. */
export type BuildResult = { kind: "argv"; argv: string[] };

/** A named, reviewed operation. */
export interface Operation {
  id: string;
  description: string;
  argsSchema: ArgsSchema;
  /** True when the operation only makes sense for a local elevation route. */
  localOnly: boolean;
  build: (args: Record<string, unknown>) => BuildResult;
}

/** Reject a value that would be interpreted as an option. */
function assertNotOption(field: string, value: string): void {
  if (value.startsWith("-")) {
    throw new Error(
      `${field} must not start with '-' (option injection): ${value}`,
    );
  }
}

/** Reject path traversal and separators in a name used as a single path segment. */
function assertSafeToken(field: string, value: string): void {
  assertNotOption(field, value);
  if (
    !/^[A-Za-z0-9_.:@+-]+$/.test(value) || value.includes("..") ||
    value.startsWith(".")
  ) {
    throw new Error(`${field} contains unsafe characters: ${value}`);
  }
}

function assertAbsoluteNoSymlinkIntent(field: string, value: string): void {
  assertNotOption(field, value);
  if (!value.startsWith("/")) {
    throw new Error(`${field} must be an absolute path: ${value}`);
  }
  if (/[\0\r\n]/.test(value)) {
    throw new Error(`${field} contains control characters`);
  }
}

/** Package managers the install/remove operations support. */
export const PACKAGE_MANAGERS = [
  "apt",
  "dnf",
  "yum",
  "zypper",
  "apk",
  "pacman",
] as const;

const PackageArgs = z.object({
  manager: z.enum(PACKAGE_MANAGERS),
  packages: z.array(z.string().min(1)).min(1),
}).strict();

const ServiceArgs = z.object({
  unit: z.string().min(1),
  action: z.enum(["start", "stop", "restart", "enable", "disable"]),
}).strict();

const DirectoryArgs = z.object({
  path: z.string().min(1),
  mode: z.string().regex(/^[0-7]{3,4}$/).default("0755"),
  owner: z.string().regex(/^[A-Za-z0-9_.+-]+$/).optional(),
  group: z.string().regex(/^[A-Za-z0-9_.+-]+$/).optional(),
}).strict();

const CreateUserArgs = z.object({
  user: z.string().min(1),
  comment: z.string().max(200).default(""),
  group: z.string().regex(/^[A-Za-z0-9_.+-]+$/).optional(),
  groups: z.array(z.string().regex(/^[A-Za-z0-9_.+-]+$/)).default([]),
}).strict();

const ChownArgs = z.object({
  path: z.string().min(1),
  owner: z.string().regex(/^[A-Za-z0-9_.+-]+$/),
  group: z.string().regex(/^[A-Za-z0-9_.+-]+$/),
  recursive: z.boolean().default(false),
}).strict();

const UserGroupArgs = z.object({
  user: z.string().min(1),
  group: z.string().min(1),
}).strict();

const SysctlArgs = z.object({
  key: z.string().regex(/^[A-Za-z0-9_.-]+$/),
  value: z.string().min(1),
}).strict();

const MountArgs = z.object({
  source: z.string().min(1),
  target: z.string().min(1),
  fstype: z.string().regex(/^[A-Za-z0-9_.-]+$/).optional(),
  options: z.string().regex(/^[A-Za-z0-9_.=,-]+$/).optional(),
}).strict();

/** The package-manager install/remove argv, with options before the packages. */
export function packageArgv(
  manager: (typeof PACKAGE_MANAGERS)[number],
  action: "install" | "remove" | "uninstall",
  packages: string[],
): string[] {
  for (const p of packages) assertSafeToken("package", p);
  switch (manager) {
    case "apt":
      return [
        "apt-get",
        action === "install" ? "install" : "remove",
        "-y",
        ...packages,
      ];
    case "dnf":
    case "yum":
      return [
        manager,
        action === "install" ? "install" : "remove",
        "-y",
        ...packages,
      ];
    case "zypper":
      return [
        "zypper",
        "--non-interactive",
        action === "install" ? "install" : "remove",
        ...packages,
      ];
    case "apk":
      return ["apk", action === "install" ? "add" : "del", ...packages];
    case "pacman":
      return [
        "pacman",
        action === "install" ? "-S" : "-R",
        "--noconfirm",
        ...packages,
      ];
  }
}

/** Assert a systemd unit name is safe to pass as an argument. */
export function assertServiceUnit(unit: string): void {
  assertNotOption("unit", unit);
  if (!/^[A-Za-z0-9_@.:-]+$/.test(unit)) {
    throw new Error(`unit contains unsafe characters: ${unit}`);
  }
}

export const OPERATIONS: Record<string, Operation> = {
  installPackage: {
    id: "installPackage",
    description:
      "Install one or more packages with the host's package manager.",
    argsSchema: PackageArgs,
    localOnly: false,
    build: (args) => {
      const a = PackageArgs.parse(args);
      return {
        kind: "argv",
        argv: packageArgv(a.manager, "install", a.packages),
      };
    },
  },
  removePackage: {
    id: "removePackage",
    description: "Remove one or more packages with the host's package manager.",
    argsSchema: PackageArgs,
    localOnly: false,
    build: (args) => {
      const a = PackageArgs.parse(args);
      return {
        kind: "argv",
        argv: packageArgv(a.manager, "remove", a.packages),
      };
    },
  },
  manageService: {
    id: "manageService",
    description:
      "Start, stop, restart, enable, or disable a systemd service by unit name.",
    argsSchema: ServiceArgs,
    localOnly: false,
    build: (args) => {
      const a = ServiceArgs.parse(args);
      assertServiceUnit(a.unit);
      return { kind: "argv", argv: ["systemctl", a.action, a.unit] };
    },
  },
  ensureDirectory: {
    id: "ensureDirectory",
    description:
      "Create a directory (and parents) with a given mode and optional owner/group.",
    argsSchema: DirectoryArgs,
    localOnly: true,
    build: (args) => {
      const a = DirectoryArgs.parse(args);
      assertAbsoluteNoSymlinkIntent("path", a.path);
      const argv = ["install", "-d", "-m", a.mode];
      if (a.owner) argv.push("-o", a.owner);
      if (a.group) argv.push("-g", a.group);
      argv.push(a.path);
      return { kind: "argv", argv };
    },
  },
  chown: {
    id: "chown",
    description:
      "Change the owner and group of a path, optionally recursively.",
    argsSchema: ChownArgs,
    localOnly: true,
    build: (args) => {
      const a = ChownArgs.parse(args);
      assertAbsoluteNoSymlinkIntent("path", a.path);
      const argv = ["chown"];
      if (a.recursive) argv.push("-R");
      argv.push(`${a.owner}:${a.group}`, a.path);
      return { kind: "argv", argv };
    },
  },
  addUserToGroup: {
    id: "addUserToGroup",
    description: "Add an existing user to an existing group.",
    argsSchema: UserGroupArgs,
    localOnly: true,
    build: (args) => {
      const a = UserGroupArgs.parse(args);
      assertSafeToken("user", a.user);
      assertSafeToken("group", a.group);
      return { kind: "argv", argv: ["usermod", "-aG", a.group, a.user] };
    },
  },
  createUser: {
    id: "createUser",
    description:
      "Create a system user (useradd) with an optional primary group and supplementary groups.",
    argsSchema: CreateUserArgs,
    localOnly: true,
    build: (args) => {
      const a = CreateUserArgs.parse(args);
      assertSafeToken("user", a.user);
      const argv = ["useradd", "--system"];
      if (a.comment) {
        if (/[\0\r\n]/.test(a.comment)) {
          throw new Error("comment contains control characters");
        }
        argv.push("--comment", a.comment);
      }
      if (a.group) argv.push("--gid", a.group);
      if (a.groups.length > 0) {
        for (const gr of a.groups) assertSafeToken("group", gr);
        argv.push("--groups", a.groups.join(","));
      }
      argv.push(a.user);
      return { kind: "argv", argv };
    },
  },
  sysctl: {
    id: "sysctl",
    description: "Set a sysctl key at runtime (sysctl -w).",
    argsSchema: SysctlArgs,
    localOnly: false,
    build: (args) => {
      const a = SysctlArgs.parse(args);
      return { kind: "argv", argv: ["sysctl", "-w", `${a.key}=${a.value}`] };
    },
  },
  mount: {
    id: "mount",
    description: "Mount a filesystem at a target path.",
    argsSchema: MountArgs,
    localOnly: true,
    build: (args) => {
      const a = MountArgs.parse(args);
      assertNotOption("source", a.source);
      assertAbsoluteNoSymlinkIntent("target", a.target);
      const argv = ["mount"];
      if (a.fstype) argv.push("-t", a.fstype);
      if (a.options) argv.push("-o", a.options);
      argv.push(a.source, a.target);
      return { kind: "argv", argv };
    },
  },
};

/**
 * Operations enabled by default. `mount`, `ensureDirectory`, `chown`,
 * `addUserToGroup`, and `createUser` are omitted: they mutate the filesystem or
 * account state at arbitrary absolute paths, which is little safer than an
 * arbitrary command. `sysctl` is omitted too: it writes an arbitrary kernel knob
 * (e.g. `kernel.core_pattern`, `kernel.modprobe`), which is a root persistence
 * primitive. All of these must be added to `allowedOperations` explicitly.
 */
export const DEFAULT_ALLOWED_OPERATIONS: string[] = [
  "installPackage",
  "removePackage",
  "manageService",
];

/** List every operation id in the catalogue. */
export function listOperationIds(): string[] {
  return Object.keys(OPERATIONS);
}

/** Look up an operation by id, or undefined. */
export function getOperation(id: string): Operation | undefined {
  return OPERATIONS[id];
}
