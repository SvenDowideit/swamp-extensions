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
 * Zod schemas + inferred types for `@swamp/container-image`.
 *
 * @module
 */

import { z } from "npm:zod@4.3.6";

// ---------------------------------------------------------------------------
// Primitive guards
// ---------------------------------------------------------------------------

/**
 * Refuse strings carrying newlines or NUL bytes in option-value positions.
 * Prevents injection of extra CLI flags through user-controlled values.
 */
function safeOptionValue(label: string): z.ZodString {
  return z.string().refine(
    // deno-lint-ignore no-control-regex
    (s) => !/[\x00\r\n]/.test(s),
    { message: `${label} must not contain newlines or NUL bytes` },
  );
}

// deno-lint-ignore no-control-regex
const UNSAFE_KV_RE = /[\x00\r\n]/;

function safeRecord(label: string) {
  return z.record(
    z.string().refine(
      (s) => !UNSAFE_KV_RE.test(s),
      { message: `${label} key must not contain newlines or NUL bytes` },
    ),
    z.string().refine(
      (s) => !UNSAFE_KV_RE.test(s),
      { message: `${label} value must not contain newlines or NUL bytes` },
    ),
  );
}

// ---------------------------------------------------------------------------
// Container runtime binary
// ---------------------------------------------------------------------------

export const BinaryEnum = z.enum(["docker", "podman", "container"]);
export type Binary = z.infer<typeof BinaryEnum>;

// ---------------------------------------------------------------------------
// Output type
// ---------------------------------------------------------------------------

export const ExportFormatEnum = z.enum(["oci", "docker"]);
export type ExportFormat = z.infer<typeof ExportFormatEnum>;

// ---------------------------------------------------------------------------
// Global arguments
// ---------------------------------------------------------------------------

/**
 * How a long-lived `service` container is kept running.
 *
 *   direct  — the runtime's own restart policy (`--restart`). Simplest;
 *             works for docker and podman.
 *   systemd — systemd owns the unit. For docker this writes a user unit that
 *             runs `docker start -a <name>` (docker has no native unit
 *             generator); for podman it writes a Quadlet `.container` file
 *             into `~/.config/containers/systemd/` and starts the generated
 *             `<name>.service`. Gives boot ordering, logging, and a stable
 *             unit name.
 */
export const ServiceBackendEnum = z.enum(["direct", "systemd"]);
export type ServiceBackend = z.infer<typeof ServiceBackendEnum>;

export const GlobalArgsSchema = z.object({
  name: z.string().default("").describe(
    "Model instance name. Supplied automatically by swamp for both direct " +
      "execution and `model create`; set it explicitly only if you need to " +
      "override the name used in resource instance names.",
  ),
  binary: BinaryEnum.default("docker").describe(
    "Container runtime binary: 'docker', 'podman', or 'container' " +
      "(Apple Containers, macOS only). Defaults to 'docker'.",
  ),
  serviceBackend: ServiceBackendEnum.default("direct").describe(
    "How `service` keeps a long-lived container running: 'direct' uses the " +
      "runtime restart policy; 'systemd' writes a user systemd unit (podman: " +
      "a Quadlet .container). Defaults to 'direct'.",
  ),
  systemdUnitDir: z.string().default("~/.config/systemd/user").describe(
    "Directory for generated systemd user units when serviceBackend is " +
      "'systemd' and the runtime is docker.",
  ),
  quadletDir: z.string().default("~/.config/containers/systemd").describe(
    "Directory for generated Quadlet .container units when serviceBackend " +
      "is 'systemd' and the runtime is podman.",
  ),
});

export type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

// ---------------------------------------------------------------------------
// Method argument schemas
// ---------------------------------------------------------------------------

export const BuildArgsSchema = z.object({
  context: safeOptionValue("context").default(".").describe(
    "Build context path.",
  ),
  dockerfile: safeOptionValue("dockerfile").optional().describe(
    "Path to Dockerfile (relative to context).",
  ),
  tag: safeOptionValue("tag").optional().describe(
    "Image tag (e.g. 'myapp:latest').",
  ),
  target: safeOptionValue("target").optional().describe(
    "Multi-stage build target.",
  ),
  buildArgs: safeRecord("buildArgs").optional().describe(
    "Build arguments (--build-arg KEY=VALUE).",
  ),
  labels: safeRecord("labels").optional().describe(
    "Image labels (--label KEY=VALUE).",
  ),
  noCache: z.boolean().default(false).describe(
    "Disable build cache.",
  ),
  exportFormat: ExportFormatEnum.optional().describe(
    "Export the built image as a tar archive in the given format: " +
      "'oci' (OCI archive) or 'docker' (Docker archive). Requires 'tag'. " +
      "Apple Containers only supports 'oci'.",
  ),
  exportPath: z.string().refine(
    // deno-lint-ignore no-control-regex
    (s) => !/[\x00\r\n,]/.test(s),
    {
      message: "exportPath must not contain newlines, NUL bytes, or commas " +
        "(commas are parsed as key=value delimiters by Docker's --output flag)",
    },
  ).optional().describe(
    "Destination path for the exported archive. Required when " +
      "'exportFormat' is set. E.g. './myapp-oci.tar'.",
  ),
});

export type BuildArgs = z.infer<typeof BuildArgsSchema>;

export const RunArgsSchema = z.object({
  image: safeOptionValue("image").describe("Image to run."),
  command: z.array(z.string()).optional().describe(
    "Command and arguments to execute in the container.",
  ),
  env: safeRecord("env").optional().describe(
    "Environment variables (-e KEY=VALUE).",
  ),
  volumes: z.array(safeOptionValue("volume")).optional().describe(
    "Volume mounts (-v host:container).",
  ),
  ports: z.array(safeOptionValue("port")).optional().describe(
    "Port mappings (-p host:container).",
  ),
  network: safeOptionValue("network").optional().describe(
    "Network to connect the container to (--network).",
  ),
  entrypoint: safeOptionValue("entrypoint").optional().describe(
    "Override the container entrypoint (--entrypoint).",
  ),
  privileged: z.boolean().optional().describe(
    "Run the container in privileged mode (--privileged). " +
      "Required for operations like losetup/mount inside the container.",
  ),
  extraArgs: z.array(safeOptionValue("extraArgs")).optional().describe(
    "Additional docker/podman/container run flags passed before the " +
      "image argument. Each element is a single flag or flag=value " +
      "(e.g. ['--cap-add', 'SYS_ADMIN', '--device', '/dev/loop0']).",
  ),
});

export type RunArgs = z.infer<typeof RunArgsSchema>;

// ---------------------------------------------------------------------------
// Service (long-lived, detached) arguments
// ---------------------------------------------------------------------------

/**
 * `service` runs a long-lived container detached, instead of `run`'s
 * foreground `--rm`. `ensure` is desired-state: an identical running
 * container is left alone; a changed desired state is recreated.
 */
export const ServiceArgsSchema = z.object({
  action: z.enum(["ensure", "stop", "restart", "remove"]).default("ensure")
    .describe(
      "'ensure' create+start (idempotent), 'stop' stop a running container, " +
        "'restart' recreate/restart, 'remove' stop and delete.",
    ),
  containerName: safeOptionValue("containerName").describe(
    "Container name. Also the systemd unit / Quadlet name when " +
      "serviceBackend is 'systemd'.",
  ),
  image: safeOptionValue("image").optional().describe(
    "Image to run. Required for 'ensure' and 'restart'.",
  ),
  command: z.array(z.string()).optional().describe(
    "Command and arguments to execute in the container.",
  ),
  env: safeRecord("env").optional().describe(
    "Environment variables (-e KEY=VALUE).",
  ),
  volumes: z.array(safeOptionValue("volume")).optional().describe(
    "Volume mounts (-v host:container or named-volume:container).",
  ),
  ports: z.array(safeOptionValue("port")).optional().describe(
    "Port mappings (-p host:container).",
  ),
  network: safeOptionValue("network").optional().describe(
    "Network to connect the container to (--network).",
  ),
  entrypoint: safeOptionValue("entrypoint").optional().describe(
    "Override the container entrypoint (--entrypoint).",
  ),
  restart: safeOptionValue("restart").default("unless-stopped").describe(
    "Restart policy for serviceBackend 'direct' (docker/podman --restart).",
  ),
  privileged: z.boolean().optional().describe(
    "Run the container in privileged mode (--privileged).",
  ),
  extraArgs: z.array(safeOptionValue("extraArgs")).optional().describe(
    "Additional runtime flags passed before the image argument. Each " +
      "element is a single flag or flag=value.",
  ),
  healthCommand: z.array(safeOptionValue("healthCommand")).optional().describe(
    "A command to run inside the container (via exec) until it exits 0 " +
      "before `ensure` reports success. E.g. ['pg_isready','-U','dtrack']. " +
      "Waits up to healthTimeoutMs.",
  ),
  healthTimeoutMs: z.number().int().positive().default(60000).describe(
    "How long to wait for healthCommand / the container to become ready.",
  ),
  pull: z.boolean().default(true).describe(
    "Pull the image before creating the container.",
  ),
});

export type ServiceArgs = z.infer<typeof ServiceArgsSchema>;
/** Raw call shape — defaults not yet applied (`--input` values). */
export type ServiceArgsInput = z.input<typeof ServiceArgsSchema>;

export const ServiceStatusArgsSchema = z.object({
  containerName: safeOptionValue("containerName").describe(
    "Container name to inspect.",
  ),
});

export type ServiceStatusArgs = z.infer<typeof ServiceStatusArgsSchema>;
export type ServiceStatusArgsInput = z.input<typeof ServiceStatusArgsSchema>;

export const ExecArgsSchema = z.object({
  containerName: safeOptionValue("containerName").describe(
    "Container name to exec in.",
  ),
  command: z.array(safeOptionValue("command")).min(1).describe(
    "Command and arguments to run inside the container (argv, not a shell " +
      "string).",
  ),
  env: safeRecord("env").optional().describe(
    "Environment variables for the command (-e KEY=VALUE).",
  ),
  user: safeOptionValue("user").optional().describe(
    "User to run as inside the container (-u).",
  ),
  workdir: safeOptionValue("workdir").optional().describe(
    "Working directory inside the container (-w).",
  ),
  input: z.string().optional().describe(
    "Data piped to the command's stdin.",
  ),
});

export type ExecArgs = z.infer<typeof ExecArgsSchema>;
export type ExecArgsInput = z.input<typeof ExecArgsSchema>;

export const ExecResultSchema = z.object({
  containerName: z.string(),
  command: z.array(z.string()),
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
  binary: BinaryEnum,
});

export type ExecResult = z.infer<typeof ExecResultSchema>;

export const NetworkArgsSchema = z.object({
  action: z.enum(["ensure", "remove"]).default("ensure").describe(
    "'ensure' create the network if absent (idempotent), 'remove' delete it.",
  ),
  networkName: safeOptionValue("networkName").describe("Network name."),
  driver: safeOptionValue("driver").default("bridge").describe(
    "Network driver (docker/podman: bridge).",
  ),
});

export type NetworkArgs = z.infer<typeof NetworkArgsSchema>;
export type NetworkArgsInput = z.input<typeof NetworkArgsSchema>;

export const NetworkResultSchema = z.object({
  networkName: z.string(),
  action: z.enum(["ensure", "remove"]),
  changed: z.boolean(),
  exists: z.boolean(),
  driver: z.string(),
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
  binary: BinaryEnum,
});

export type NetworkResult = z.infer<typeof NetworkResultSchema>;

export const LoginArgsSchema = z.object({
  server: safeOptionValue("server").optional().describe(
    "Registry server (default: Docker Hub).",
  ),
  username: safeOptionValue("username").describe("Registry username."),
  password: z.string().min(1).meta({ sensitive: true }).describe(
    "Registry password — supply via ${{ vault.get('<vault>', '<key>') }}. " +
      "Piped to --password-stdin; never appears in argv or persisted resources.",
  ),
  tlsVerify: z.boolean().default(true).describe(
    "Verify TLS certificates. Set to false for insecure (HTTP) registries.",
  ),
});

export type LoginArgs = z.infer<typeof LoginArgsSchema>;

export const BuildxBuildArgsSchema = z.object({
  context: safeOptionValue("context").default(".").describe(
    "Build context path.",
  ),
  dockerfile: safeOptionValue("dockerfile").optional().describe(
    "Path to Dockerfile (relative to context).",
  ),
  platforms: z.array(safeOptionValue("platform")).min(1).describe(
    "Target platforms (e.g. ['linux/amd64', 'linux/arm64']).",
  ),
  tags: z.array(safeOptionValue("tag")).min(1).describe(
    "Image tags (e.g. ['registry.example.com/app:latest']).",
  ),
  push: z.boolean().default(true).describe(
    "Push the image after building.",
  ),
  buildArgs: safeRecord("buildArgs").optional().describe(
    "Build arguments (--build-arg KEY=VALUE).",
  ),
  labels: safeRecord("labels").optional().describe(
    "Image labels (--label KEY=VALUE).",
  ),
  cacheFrom: z.array(safeOptionValue("cacheFrom")).optional().describe(
    "Cache sources (--cache-from).",
  ),
  cacheTo: z.array(safeOptionValue("cacheTo")).optional().describe(
    "Cache destinations (--cache-to).",
  ),
});

export type BuildxBuildArgs = z.infer<typeof BuildxBuildArgsSchema>;

export const ValidateArgsSchema = z.object({});

export type ValidateArgs = z.infer<typeof ValidateArgsSchema>;

export const PushArgsSchema = z.object({
  image: safeOptionValue("image").describe(
    "Image reference to push (e.g. 'registry.example.com/app:latest').",
  ),
  tlsVerify: z.boolean().default(true).describe(
    "Verify TLS certificates. Set to false for insecure (HTTP) registries.",
  ),
});

export type PushArgs = z.infer<typeof PushArgsSchema>;

// ---------------------------------------------------------------------------
// Resource schemas
// ---------------------------------------------------------------------------

export const BuildResultSchema = z.object({
  tag: z.string().optional(),
  context: z.string(),
  dockerfile: z.string().optional(),
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
  binary: BinaryEnum,
  exportFormat: ExportFormatEnum.optional(),
  exportPath: z.string().optional(),
});

export type BuildResult = z.infer<typeof BuildResultSchema>;

export const RunResultSchema = z.object({
  image: z.string(),
  command: z.array(z.string()).optional(),
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
  binary: BinaryEnum,
});

export type RunResult = z.infer<typeof RunResultSchema>;

export const ServiceResultSchema = z.object({
  containerName: z.string(),
  action: z.enum(["ensure", "stop", "restart", "remove"]),
  backend: ServiceBackendEnum,
  image: z.string().optional(),
  changed: z.boolean(),
  running: z.boolean(),
  state: z.string(),
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
  binary: BinaryEnum,
  unitName: z.string().optional(),
  unitPath: z.string().optional(),
  healthOk: z.boolean().optional(),
});

export type ServiceResult = z.infer<typeof ServiceResultSchema>;

export const ServiceStatusResultSchema = z.object({
  containerName: z.string(),
  exists: z.boolean(),
  running: z.boolean(),
  state: z.string(),
  health: z.string().optional(),
  image: z.string().optional(),
  ports: z.array(z.string()).default([]),
  unitName: z.string().optional(),
  unitActive: z.boolean().optional(),
  binary: BinaryEnum,
});

export type ServiceStatusResult = z.infer<typeof ServiceStatusResultSchema>;

export const LoginResultSchema = z.object({
  server: z.string().optional(),
  username: z.string(),
  exitCode: z.number().int(),
  stderr: z.string(),
  binary: BinaryEnum,
});

export type LoginResult = z.infer<typeof LoginResultSchema>;

export const BuildxResultSchema = z.object({
  platforms: z.array(z.string()),
  tags: z.array(z.string()),
  push: z.boolean(),
  digest: z.string().optional(),
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
  binary: BinaryEnum,
});

export type BuildxResult = z.infer<typeof BuildxResultSchema>;

export const PushResultSchema = z.object({
  image: z.string(),
  digest: z.string().optional(),
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
  binary: BinaryEnum,
});

export type PushResult = z.infer<typeof PushResultSchema>;

export const ValidateResultSchema = z.object({
  binary: BinaryEnum,
  runtimeFound: z.boolean(),
  runtimeVersion: z.string().optional(),
  daemonReachable: z.boolean(),
  daemonError: z.string().optional(),
  buildxAvailable: z.boolean(),
  buildxError: z.string().optional(),
  methods: z.object({
    build: z.boolean(),
    run: z.boolean(),
    login: z.boolean(),
    push: z.boolean(),
    "multi-platform-build": z.boolean(),
  }),
});

export type ValidateResult = z.infer<typeof ValidateResultSchema>;
