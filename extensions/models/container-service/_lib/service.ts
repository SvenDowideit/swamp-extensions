// Swamp, an Automation Framework
// Copyright (C) 2026 Elder Swamp Club, Inc.
//
// This file is part of Swamp.
//
// Swamp is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation, with the Swamp
// Extension and Definition Exception (found in the "COPYING-EXCEPTION"
// file).
//
// Swamp is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with Swamp.  If not, see <https://www.gnu.org/licenses/>.

/**
 * Long-lived container `service` lifecycle for `@svendowideit/container-service`.
 *
 * `@swamp/container-image`'s `run` is foreground-only (`docker run --rm`), so
 * it cannot host a daemon. This module adds the detached lifecycle:
 *
 *   ensure   create + start (idempotent desired-state)
 *   stop     stop a running container
 *   restart  recreate/restart
 *   remove   stop and delete
 *
 * plus two ways to keep it running:
 *
 *   backend=direct   the runtime restart policy (`--restart`)
 *   backend=systemd  a user systemd unit. For podman this is a Quadlet
 *                    `.container` file; for docker (no native unit generator)
 *                    a unit that runs `docker start -a <name>`.
 *
 * All process spawning goes through the runner's injectable executor seam, so
 * tests can drive the whole lifecycle without a container runtime.
 *
 * @module
 */

import type {
  Binary,
  ExecArgsInput,
  NetworkArgsInput,
  ServiceArgs,
  ServiceArgsInput,
  ServiceStatusArgsInput,
  ServiceStatusResult,
} from "./schemas.ts";
import {
  ExecArgsSchema,
  NetworkArgsSchema,
  ServiceArgsSchema,
  ServiceStatusArgsSchema,
} from "./schemas.ts";
import { execCommand } from "./runner.ts";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Expand a leading `~` to the user's home directory (systemd won't). */
export function expandHome(path: string): string {
  if (path === "~") {
    return Deno.env.get("HOME") ??
      Deno.env.get("USERPROFILE") ?? path;
  }
  if (path.startsWith("~/")) {
    const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE");
    if (home) return `${home}${path.slice(1)}`;
  }
  return path;
}

/** Container/unit names: no slashes, control chars, or spaces. */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export function assertSafeName(name: string): void {
  if (!NAME_RE.test(name)) {
    throw new Error(
      `Invalid container/unit name '${name}': use letters, digits, '.', '_' ` +
        `and '-' only (must not be empty or start with a separator).`,
    );
  }
}

function envFlags(env?: Record<string, string>): string[] {
  if (!env) return [];
  return Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
}

function volumeFlags(volumes?: string[]): string[] {
  return (volumes ?? []).flatMap((v) => ["-v", v]);
}

function portFlags(ports?: string[]): string[] {
  return (ports ?? []).flatMap((p) => ["-p", p]);
}

/**
 * Build the `<binary> create` argv for a service container. `create` (not
 * `run`) is used so the container exists ahead of systemd/the restart policy.
 */
export function buildServiceCreateArgv(
  binary: Binary,
  argsInput: ServiceArgsInput,
): string[] {
  const args = ServiceArgsSchema.parse(argsInput);
  const argv: string[] = [binary, "create"];
  argv.push("--name", args.containerName);
  if (args.restart) argv.push("--restart", args.restart);
  if (args.privileged) argv.push("--privileged");
  if (args.entrypoint) argv.push("--entrypoint", args.entrypoint);
  if (args.network) argv.push("--network", args.network);
  argv.push(...envFlags(args.env));
  argv.push(...volumeFlags(args.volumes));
  argv.push(...portFlags(args.ports));
  argv.push(
    "--label",
    `swamp.desired=${desiredServiceHash(args)}`,
  );
  if (args.extraArgs) argv.push(...args.extraArgs);
  argv.push(args.image!);
  if (args.command) argv.push(...args.command);
  return argv;
}

/**
 * Hash of the container's desired state. Secret env *values* are deliberately
 * excluded — only env *names* are hashed, so no secret is persisted as a
 * label (matching `@svendowideit/otel-backend`). Changing a secret value
 * therefore does not by itself trigger a recreate; run `remove` then
 * `ensure` (or change another field) to apply it.
 */
export function desiredServiceHash(argsInput: ServiceArgsInput): string {
  const args = ServiceArgsSchema.parse(argsInput);
  const material = JSON.stringify({
    image: args.image ?? "",
    command: args.command ?? [],
    envNames: Object.keys(args.env ?? {}).sort(),
    volumes: args.volumes ?? [],
    ports: args.ports ?? [],
    network: args.network ?? "",
    entrypoint: args.entrypoint ?? "",
    privileged: args.privileged ?? false,
    restart: args.restart ?? "",
    extraArgs: args.extraArgs ?? [],
  });
  return fnv1a(material);
}

/** FNV-1a 32-bit — small, stable, dependency-free (matches otel-backend). */
export function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Parse `docker inspect --format '{{.State.Status}}'` output. */
export function parseContainerState(stdout: string): string {
  return stdout.trim();
}

/** Parse `docker inspect --format '{{.State.Health.Status}}'` (may be empty). */
export function parseContainerHealth(stdout: string): string | undefined {
  const v = stdout.trim();
  return v.length > 0 ? v : undefined;
}

/** Parse `docker inspect --format '{{json .Config.Image}}'`. */
export function parseContainerImage(stdout: string): string | undefined {
  const v = stdout.trim();
  if (v.length === 0) return undefined;
  try {
    const parsed = JSON.parse(v);
    return typeof parsed === "string" ? parsed : undefined;
  } catch {
    return v;
  }
}

/** Parse `docker port <name>` lines into `host:port -> container` strings. */
export function parseContainerPorts(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

// ---------------------------------------------------------------------------
// systemd rendering
// ---------------------------------------------------------------------------

/** Render a docker systemd user unit that owns the container's lifecycle. */
export function renderDockerUnit(
  argsInput: ServiceArgsInput,
  dockerBin: string,
  description?: string,
): string {
  const args = ServiceArgsSchema.parse(argsInput);
  const name = args.containerName;
  const lines: string[] = [];
  lines.push(`[Unit]`);
  lines.push(`Description=${description ?? `swamp container service ${name}`}`);
  lines.push(`After=network-online.target`);
  lines.push(`Wants=network-online.target`);
  lines.push(``);
  lines.push(`[Service]`);
  lines.push(`Type=simple`);
  lines.push(`Restart=always`);
  lines.push(`RestartSec=5`);
  // `docker start -a` stays attached so systemd tracks the container.
  lines.push(`ExecStart=${dockerBin} start -a ${name}`);
  lines.push(`ExecStop=${dockerBin} stop ${name}`);
  lines.push(`TimeoutStartSec=0`);
  lines.push(``);
  lines.push(`[Install]`);
  lines.push(`WantedBy=default.target`);
  lines.push(``);
  return lines.join("\n");
}

/**
 * Render a Podman Quadlet `.container` unit. Quadlet turns this file into a
 * generated `<name>.service`; systemd (not the container runtime) owns the
 * restart policy.
 */
export function renderQuadlet(
  argsInput: ServiceArgsInput,
  description?: string,
): string {
  const args = ServiceArgsSchema.parse(argsInput);
  const lines: string[] = [];
  lines.push(`[Unit]`);
  lines.push(
    `Description=${
      description ?? `swamp container service ${args.containerName}`
    }`,
  );
  lines.push(``);
  lines.push(`[Container]`);
  lines.push(`Image=${args.image}`);
  lines.push(`ContainerName=${args.containerName}`);
  if (args.command && args.command.length > 0) {
    lines.push(`Exec=${args.command.join(" ")}`);
  }
  if (args.entrypoint) lines.push(`Entrypoint=${args.entrypoint}`);
  if (args.network) lines.push(`Network=${args.network}`);
  for (const [k, v] of Object.entries(args.env ?? {})) {
    lines.push(`Environment=${k}=${v}`);
  }
  for (const vol of args.volumes ?? []) lines.push(`Volume=${vol}`);
  for (const port of args.ports ?? []) lines.push(`PublishPort=${port}`);
  lines.push(``);
  lines.push(`[Service]`);
  lines.push(`Restart=always`);
  lines.push(`TimeoutStartSec=900`);
  lines.push(``);
  lines.push(`[Install]`);
  lines.push(`WantedBy=default.target`);
  lines.push(``);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Runtime interaction
// ---------------------------------------------------------------------------

async function runtime(
  binary: Binary,
  args: string[],
  signal?: AbortSignal,
) {
  return await execCommand({ bin: binary, args, signal });
}

async function containerExists(
  binary: Binary,
  name: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const res = await runtime(binary, ["inspect", name], signal);
  return res.exitCode === 0;
}

async function inspectField(
  binary: Binary,
  name: string,
  format: string,
  signal?: AbortSignal,
): Promise<string> {
  const res = await runtime(
    binary,
    ["inspect", "--format", format, name],
    signal,
  );
  return res.exitCode === 0 ? res.stdout.trim() : "";
}

async function waitForExecHealth(
  binary: Binary,
  name: string,
  command: string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ ok: boolean; lastStderr: string }> {
  const deadline = Date.now() + timeoutMs;
  let lastStderr = "";
  while (true) {
    const res = await runtime(binary, ["exec", name, ...command], signal);
    if (res.exitCode === 0) return { ok: true, lastStderr: "" };
    lastStderr = res.stderr.trim();
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return { ok: false, lastStderr };
}

// ---------------------------------------------------------------------------
// systemd helpers
// ---------------------------------------------------------------------------

async function systemctl(args: string[], signal?: AbortSignal) {
  return await execCommand({
    bin: "systemctl",
    args: ["--user", ...args],
    signal,
  });
}

async function writeUnit(path: string, content: string): Promise<void> {
  const idx = path.lastIndexOf("/");
  if (idx > 0) await Deno.mkdir(path.slice(0, idx), { recursive: true });
  await Deno.writeTextFile(path, content);
}

async function removeUnit(path: string): Promise<void> {
  try {
    await Deno.remove(path);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export interface ServiceLogger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export interface DataHandle {
  name: string;
}

export interface ServiceContext {
  signal: AbortSignal;
  globalArgs: Record<string, unknown>;
  logger: ServiceLogger;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
    overrides?: { tags?: Record<string, string>; garbageCollection?: number },
  ) => Promise<DataHandle>;
}

export interface ServiceGlobalArgs {
  name: string;
  binary: Binary;
  serviceBackend: "direct" | "systemd";
  systemdUnitDir: string;
  quadletDir: string;
}

interface ServiceOutcome {
  changed: boolean;
  running: boolean;
  state: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  unitName?: string;
  unitPath?: string;
  healthOk?: boolean;
}

/**
 * Run the service lifecycle. Returns the outcome; the caller persists it.
 */
export async function runService(
  argsInput: ServiceArgsInput,
  g: ServiceGlobalArgs,
  ctx: ServiceContext,
): Promise<ServiceOutcome> {
  const args = ServiceArgsSchema.parse(argsInput);
  assertSafeName(args.containerName);
  if ((args.action === "ensure" || args.action === "restart") && !args.image) {
    throw new Error(`'${args.action}' requires the 'image' argument.`);
  }

  if (g.serviceBackend === "systemd") {
    return await runSystemdService(args, g, ctx);
  }
  return await runDirectService(args, g, ctx);
}

async function runDirectService(
  args: ServiceArgs,
  g: ServiceGlobalArgs,
  ctx: ServiceContext,
): Promise<ServiceOutcome> {
  const { binary } = g;
  const name = args.containerName;

  if (args.action === "stop") {
    const res = await runtime(binary, ["stop", name], ctx.signal);
    const state = await inspectField(
      binary,
      name,
      "{{.State.Status}}",
      ctx.signal,
    );
    return {
      changed: res.exitCode === 0,
      running: false,
      state: state || "stopped",
      exitCode: res.exitCode,
      stdout: res.stdout,
      stderr: res.stderr,
    };
  }

  if (args.action === "remove") {
    const res = await runtime(binary, ["rm", "-f", name], ctx.signal);
    return {
      changed: res.exitCode === 0,
      running: false,
      state: "removed",
      exitCode: res.exitCode,
      stdout: res.stdout,
      stderr: res.stderr,
    };
  }

  // ensure / restart
  const exists = await containerExists(binary, name, ctx.signal);
  let changed = false;
  const desired = desiredServiceHash(args);

  if (exists) {
    const current = await inspectField(
      binary,
      name,
      `{{index .Config.Labels "swamp.desired"}}`,
      ctx.signal,
    );
    if (args.action === "restart" || current !== desired) {
      ctx.logger.info(
        `Recreating ${name} (desired state changed or restart requested)`,
      );
      await runtime(binary, ["rm", "-f", name], ctx.signal);
      changed = true;
    }
  } else {
    changed = true;
  }

  if (!exists || changed) {
    if (args.pull && args.image) {
      const pull = await runtime(binary, ["pull", args.image], ctx.signal);
      if (pull.exitCode !== 0) {
        ctx.logger.warn(`pull of ${args.image} failed: ${pull.stderr.trim()}`);
      }
    }
    const create = await runtime(
      binary,
      buildServiceCreateArgv(binary, args).slice(1),
      ctx.signal,
    );
    if (create.exitCode !== 0) {
      throw new Error(
        `${binary} create failed (exit ${create.exitCode}): ${create.stderr}`,
      );
    }
  }

  const start = await runtime(binary, ["start", name], ctx.signal);
  if (start.exitCode !== 0) {
    throw new Error(
      `${binary} start failed (exit ${start.exitCode}): ${start.stderr}`,
    );
  }

  let healthOk: boolean | undefined;
  if (args.healthCommand && args.healthCommand.length > 0) {
    const health = await waitForExecHealth(
      binary,
      name,
      args.healthCommand,
      args.healthTimeoutMs,
      ctx.signal,
    );
    healthOk = health.ok;
    if (!health.ok) {
      const logs = await runtime(
        binary,
        ["logs", "--tail", "40", name],
        ctx.signal,
      );
      throw new Error(
        `Health command '${args.healthCommand.join(" ")}' did not succeed ` +
          `within ${args.healthTimeoutMs}ms for ${name}. Last error: ` +
          `${health.lastStderr}\n` +
          `Check \`${binary} logs ${name}\`. Last output:\n${logs.stdout}${logs.stderr}`,
      );
    }
  }

  const state = await inspectField(
    binary,
    name,
    "{{.State.Status}}",
    ctx.signal,
  );
  return {
    changed,
    running: state === "running",
    state: state || "unknown",
    exitCode: 0,
    stdout: start.stdout,
    stderr: start.stderr,
    healthOk,
  };
}

async function runSystemdService(
  args: ServiceArgs,
  g: ServiceGlobalArgs,
  ctx: ServiceContext,
): Promise<ServiceOutcome> {
  const { binary } = g;
  const name = args.containerName;

  if (binary === "container") {
    throw new Error(
      "serviceBackend 'systemd' is not supported with Apple Containers — " +
        "use backend 'direct' or docker/podman.",
    );
  }

  if (args.action === "stop") {
    const res = await systemctl(["stop", name], ctx.signal);
    return {
      changed: res.exitCode === 0,
      running: false,
      state: "stopped",
      exitCode: res.exitCode,
      stdout: res.stdout,
      stderr: res.stderr,
      unitName: `${name}.service`,
    };
  }

  if (args.action === "remove") {
    await systemctl(["disable", "--now", name], ctx.signal);
    if (binary === "docker") {
      await runtime(binary, ["rm", "-f", name], ctx.signal);
      await removeUnit(`${expandHome(g.systemdUnitDir)}/${name}.service`);
    } else {
      await removeUnit(`${expandHome(g.quadletDir)}/${name}.container`);
    }
    await systemctl(["daemon-reload"], ctx.signal);
    return {
      changed: true,
      running: false,
      state: "removed",
      exitCode: 0,
      stdout: "",
      stderr: "",
      unitName: `${name}.service`,
    };
  }

  // ensure / restart
  let unitPath: string | undefined;
  if (binary === "podman") {
    unitPath = `${expandHome(g.quadletDir)}/${name}.container`;
    await writeUnit(unitPath, renderQuadlet(args));
    await runtime(binary, ["rm", "-f", name], ctx.signal).catch(() => {});
  } else {
    unitPath = `${expandHome(g.systemdUnitDir)}/${name}.service`;
    // (Re)create the container the unit will start, then write the unit.
    const exists = await containerExists(binary, name, ctx.signal);
    if (exists) await runtime(binary, ["rm", "-f", name], ctx.signal);
    if (args.pull && args.image) {
      await runtime(binary, ["pull", args.image], ctx.signal);
    }
    const create = await runtime(
      binary,
      buildServiceCreateArgv(binary, args).slice(1),
      ctx.signal,
    );
    if (create.exitCode !== 0) {
      throw new Error(
        `${binary} create failed (exit ${create.exitCode}): ${create.stderr}`,
      );
    }
    await writeUnit(unitPath, renderDockerUnit(args, "docker"));
  }

  const reload = await systemctl(["daemon-reload"], ctx.signal);
  if (reload.exitCode !== 0) {
    throw new Error(`systemctl --user daemon-reload failed: ${reload.stderr}`);
  }

  const enable = await systemctl(["enable", "--now", name], ctx.signal);
  if (enable.exitCode !== 0 && args.action === "ensure") {
    throw new Error(
      `systemctl --user enable --now ${name} failed (exit ${enable.exitCode}): ` +
        `${enable.stderr}`,
    );
  }
  // A `restart` on an already-enabled unit.
  if (args.action === "restart") {
    await systemctl(["restart", name], ctx.signal);
  }

  const active = await systemctl(["is-active", name], ctx.signal);
  return {
    changed: true,
    running: active.stdout.trim() === "active",
    state: active.stdout.trim() || "unknown",
    exitCode: 0,
    stdout: enable.stdout,
    stderr: enable.stderr,
    unitName: `${name}.service`,
    unitPath,
  };
}

export async function runServiceStatus(
  argsInput: ServiceStatusArgsInput,
  g: ServiceGlobalArgs,
  ctx: ServiceContext,
): Promise<ServiceStatusResult> {
  const args = ServiceStatusArgsSchema.parse(argsInput);
  assertSafeName(args.containerName);
  const { binary } = g;
  const name = args.containerName;

  const exists = await containerExists(binary, name, ctx.signal);
  let state = "absent";
  let image: string | undefined;
  let health: string | undefined;
  let ports: string[] = [];

  if (exists) {
    state =
      (await inspectField(binary, name, "{{.State.Status}}", ctx.signal)) ||
      "unknown";
    image = parseContainerImage(
      await inspectField(binary, name, "{{json .Config.Image}}", ctx.signal),
    );
    health = parseContainerHealth(
      await inspectField(
        binary,
        name,
        "{{if .State.Health}}{{.State.Health.Status}}{{end}}",
        ctx.signal,
      ),
    );
    const portRes = await runtime(binary, ["port", name], ctx.signal);
    if (portRes.exitCode === 0) ports = parseContainerPorts(portRes.stdout);
  }

  let unitName: string | undefined;
  let unitActive: boolean | undefined;
  if (g.serviceBackend === "systemd" && exists) {
    unitName = `${name}.service`;
    const active = await systemctl(["is-active", name], ctx.signal);
    unitActive = active.stdout.trim() === "active";
  }

  return {
    containerName: name,
    exists,
    running: state === "running",
    state,
    health,
    image,
    ports,
    unitName,
    unitActive,
    binary,
  };
}

/**
 * Run a command inside a service container and capture its output. The
 * counterpart to `service` for one-off in-container work (e.g. seeding a
 * database). `command` is an argv, never a shell string; stdin is injected via
 * the executor seam so nothing is written to a temporary file.
 */
export async function runContainerExec(
  argsInput: ExecArgsInput,
  g: ServiceGlobalArgs,
  ctx: ServiceContext,
) {
  const args = ExecArgsSchema.parse(argsInput);
  assertSafeName(args.containerName);
  const argv: string[] = ["exec"];
  // Attach stdin (-i) only when there is data to send, so an interactive
  // command is never left hanging on a pipe.
  if (args.input !== undefined) argv.push("-i");
  for (const [k, v] of Object.entries(args.env ?? {})) {
    argv.push("-e", `${k}=${v}`);
  }
  if (args.user) argv.push("-u", args.user);
  if (args.workdir) argv.push("-w", args.workdir);
  argv.push(args.containerName, ...args.command);
  const res = await execCommand({
    bin: g.binary,
    args: argv,
    stdin: args.input,
    signal: ctx.signal,
  });
  return {
    containerName: args.containerName,
    command: args.command,
    exitCode: res.exitCode,
    stdout: res.stdout,
    stderr: res.stderr,
    binary: g.binary,
  };
}

/**
 * Idempotently ensure (or remove) a container network. `ensure` is a no-op
 * when the network already exists, so it is safe to call before `service`.
 */
export async function runNetwork(
  argsInput: NetworkArgsInput,
  g: ServiceGlobalArgs,
  ctx: ServiceContext,
) {
  const args = NetworkArgsSchema.parse(argsInput);
  assertSafeName(args.networkName);
  const inspect = await execCommand({
    bin: g.binary,
    args: ["network", "inspect", args.networkName],
    signal: ctx.signal,
  });
  const exists = inspect.exitCode === 0;

  if (args.action === "remove") {
    const res = exists
      ? await execCommand({
        bin: g.binary,
        args: ["network", "rm", args.networkName],
        signal: ctx.signal,
      })
      : { exitCode: 0, stdout: "", stderr: "" };
    return {
      networkName: args.networkName,
      action: args.action,
      changed: exists,
      exists: false,
      driver: args.driver,
      exitCode: res.exitCode,
      stdout: res.stdout,
      stderr: res.stderr,
      binary: g.binary,
    };
  }

  if (exists) {
    return {
      networkName: args.networkName,
      action: args.action,
      changed: false,
      exists: true,
      driver: args.driver,
      exitCode: 0,
      stdout: "",
      stderr: "",
      binary: g.binary,
    };
  }

  const res = await execCommand({
    bin: g.binary,
    args: ["network", "create", "--driver", args.driver, args.networkName],
    signal: ctx.signal,
  });
  if (res.exitCode !== 0) {
    throw new Error(
      `${g.binary} network create failed (exit ${res.exitCode}): ${res.stderr}`,
    );
  }
  return {
    networkName: args.networkName,
    action: args.action,
    changed: true,
    exists: true,
    driver: args.driver,
    exitCode: 0,
    stdout: res.stdout,
    stderr: res.stderr,
    binary: g.binary,
  };
}
