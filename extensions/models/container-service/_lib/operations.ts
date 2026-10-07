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
 * Operation implementations for the @swamp/container-image model.
 *
 * @module
 */

import {
  type Binary,
  type BuildArgs,
  type BuildxBuildArgs,
  GlobalArgsSchema,
  type LoginArgs,
  type PushArgs,
  type RunArgs,
} from "./schemas.ts";
import {
  type ExecResult,
  parseDigest,
  runBuildCommand,
  runBuildxCommand,
  runExportCommand,
  runLoginCommand,
  runPushCommand,
  runRunCommand,
} from "./runner.ts";
import {
  type BinaryProbe,
  checkBuildxAvailable,
  checkRuntimeAvailable,
} from "./checks.ts";

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface ContainerLogger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export interface DataHandle {
  name: string;
}

export interface ContainerContext {
  signal: AbortSignal;
  globalArgs: Record<string, unknown>;
  logger: ContainerLogger;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
    overrides?: { tags?: Record<string, string>; garbageCollection?: number },
  ) => Promise<DataHandle>;
}

// ---------------------------------------------------------------------------
// Validate
// ---------------------------------------------------------------------------

async function probeDaemon(
  binary: Binary,
  signal?: AbortSignal,
): Promise<ExecResult> {
  const args = binary === "container" ? ["system", "status"] : ["info"];
  try {
    const cmd = new Deno.Command(binary, { // swamp-quality-ignore deno-command: the runtime daemon probe is the purpose of this check
      args,
      stdout: "piped",
      stderr: "piped",
      signal,
    });
    const output = await cmd.output();
    const decoder = new TextDecoder();
    return {
      exitCode: output.code,
      stdout: decoder.decode(output.stdout),
      stderr: decoder.decode(output.stderr),
    };
  } catch (err) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
    };
  }
}

async function probeVersion(
  binary: Binary,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const cmd = new Deno.Command(binary, { // swamp-quality-ignore deno-command: probing the runtime version is the purpose of this check
      args: ["--version"],
      stdout: "piped",
      stderr: "piped",
      signal,
    });
    const output = await cmd.output();
    if (output.code !== 0) return undefined;
    return new TextDecoder().decode(output.stdout).trim();
  } catch {
    return undefined;
  }
}

export async function runValidate(
  _args: Record<string, never>,
  ctx: ContainerContext,
  probe?: BinaryProbe,
): Promise<{ dataHandles: DataHandle[] }> {
  const g = GlobalArgsSchema.parse(ctx.globalArgs);
  ctx.logger.info(`Validating ${g.binary} environment`);

  const runtimeCheck = await checkRuntimeAvailable(
    { globalArgs: ctx.globalArgs },
    probe,
  );
  const runtimeFound = runtimeCheck.pass;

  let runtimeVersion: string | undefined;
  let daemonReachable = false;
  let daemonError: string | undefined;
  let buildxAvailable = false;
  let buildxError: string | undefined;

  if (runtimeFound) {
    runtimeVersion = await probeVersion(g.binary, ctx.signal);

    const daemonResult = await probeDaemon(g.binary, ctx.signal);
    daemonReachable = daemonResult.exitCode === 0;
    if (!daemonReachable) {
      daemonError = daemonResult.stderr.trim().split("\n")[0];
    }

    const buildxCheck = await checkBuildxAvailable({
      globalArgs: ctx.globalArgs,
    });
    buildxAvailable = buildxCheck.pass;
    if (!buildxAvailable && buildxCheck.errors?.length) {
      buildxError = buildxCheck.errors[0];
    }
  }

  const methods = {
    build: runtimeFound && daemonReachable,
    run: runtimeFound && daemonReachable,
    login: runtimeFound,
    push: runtimeFound && daemonReachable,
    "multi-platform-build": runtimeFound && daemonReachable && buildxAvailable,
  };

  const data = {
    binary: g.binary,
    runtimeFound,
    runtimeVersion,
    daemonReachable,
    daemonError,
    buildxAvailable,
    buildxError,
    methods,
  };

  const errors: string[] = [];
  if (!runtimeFound) errors.push(`'${g.binary}' not found on PATH`);
  if (runtimeFound && !daemonReachable) {
    errors.push(`${g.binary} daemon not reachable: ${daemonError}`);
  }

  ctx.logger.info(
    `Runtime: ${runtimeFound ? "found" : "MISSING"} | ` +
      `Daemon: ${daemonReachable ? "reachable" : "UNREACHABLE"} | ` +
      `Multi-platform: ${buildxAvailable ? "available" : "unavailable"}`,
  );

  const handle = await ctx.writeResource(
    "validateResult",
    `validate-${g.name}`,
    data as unknown as Record<string, unknown>,
  );

  if (errors.length > 0) {
    throw new Error(
      `Validation failed for '${g.binary}':\n${
        errors.map((e) => `  - ${e}`).join("\n")
      }`,
    );
  }

  return { dataHandles: [handle] };
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export async function runBuild(
  args: BuildArgs,
  ctx: ContainerContext,
): Promise<{ dataHandles: DataHandle[] }> {
  const g = GlobalArgsSchema.parse(ctx.globalArgs);
  ctx.logger.info(
    `Building image${args.tag ? ` ${args.tag}` : ""} with ${g.binary}`,
  );

  const result = await runBuildCommand(g.binary, args, ctx.signal);

  if (result.exitCode !== 0) {
    await ctx.writeResource("buildResult", `build-${g.name}`, {
      tag: args.tag,
      context: args.context,
      dockerfile: args.dockerfile,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      binary: g.binary,
    });
    throw new Error(
      `${g.binary} build failed (exit ${result.exitCode}): ${result.stderr}`,
    );
  }

  if (args.exportFormat && args.exportPath) {
    if (!args.tag) {
      throw new Error(
        "exportFormat requires a tag — set the 'tag' argument so the " +
          "built image can be exported.",
      );
    }
    ctx.logger.info(
      `Exporting ${args.tag} as ${args.exportFormat} to ${args.exportPath}`,
    );
    const exportResult = await runExportCommand(
      g.binary,
      args.tag,
      args.exportFormat,
      args.exportPath,
      ctx.signal,
    );
    if (exportResult.exitCode !== 0) {
      throw new Error(
        `${g.binary} export failed (exit ${exportResult.exitCode}): ${exportResult.stderr}`,
      );
    }
  }

  const handle = await ctx.writeResource("buildResult", `build-${g.name}`, {
    tag: args.tag,
    context: args.context,
    dockerfile: args.dockerfile,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    binary: g.binary,
    exportFormat: args.exportFormat,
    exportPath: args.exportPath,
  });

  return { dataHandles: [handle] };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

export async function runRun(
  args: RunArgs,
  ctx: ContainerContext,
): Promise<{ dataHandles: DataHandle[] }> {
  const g = GlobalArgsSchema.parse(ctx.globalArgs);
  ctx.logger.info(`Running image ${args.image} with ${g.binary}`);

  const result = await runRunCommand(g.binary, args, ctx.signal);

  const handle = await ctx.writeResource("runResult", `run-${g.name}`, {
    image: args.image,
    command: args.command,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    binary: g.binary,
  });

  if (result.exitCode !== 0) {
    throw new Error(
      `${g.binary} run failed (exit ${result.exitCode}): ${result.stderr}`,
    );
  }

  return { dataHandles: [handle] };
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

export async function runLogin(
  args: LoginArgs,
  ctx: ContainerContext,
): Promise<{ dataHandles: DataHandle[] }> {
  const g = GlobalArgsSchema.parse(ctx.globalArgs);
  ctx.logger.info(
    `Logging into ${
      args.server ?? "Docker Hub"
    } as ${args.username} with ${g.binary}`,
  );

  const result = await runLoginCommand(g.binary, args, ctx.signal);

  const handle = await ctx.writeResource("loginResult", `login-${g.name}`, {
    server: args.server,
    username: args.username,
    exitCode: result.exitCode,
    stderr: result.stderr,
    binary: g.binary,
  });

  if (result.exitCode !== 0) {
    throw new Error(
      `${g.binary} login failed (exit ${result.exitCode}): ${result.stderr}`,
    );
  }

  return { dataHandles: [handle] };
}

// ---------------------------------------------------------------------------
// Buildx build
// ---------------------------------------------------------------------------

export async function runBuildxBuild(
  args: BuildxBuildArgs,
  ctx: ContainerContext,
): Promise<{ dataHandles: DataHandle[] }> {
  const g = GlobalArgsSchema.parse(ctx.globalArgs);
  const platformStr = args.platforms.join(",");

  if (g.binary === "podman" && args.tags.length > 1) {
    ctx.logger.warn(
      `Podman multi-platform build only uses the first tag for --manifest. ` +
        `Tags beyond '${args.tags[0]}' will not be pushed. ` +
        `Use the 'push' method to push additional tags.`,
    );
  }

  ctx.logger.info(
    `Building for ${platformStr} with ${g.binary}${args.push ? " (push)" : ""}`,
  );

  const result = await runBuildxCommand(g.binary, args, ctx.signal);

  const handle = await ctx.writeResource(
    "multiPlatformBuildResult",
    `multi-platform-build-${g.name}`,
    {
      platforms: args.platforms,
      tags: args.tags,
      push: args.push,
      digest: result.digest,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      binary: g.binary,
    },
  );

  if (result.exitCode !== 0) {
    throw new Error(
      `${g.binary} multi-platform build failed (exit ${result.exitCode}): ${result.stderr}`,
    );
  }

  return { dataHandles: [handle] };
}

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

export async function runPush(
  args: PushArgs,
  ctx: ContainerContext,
): Promise<{ dataHandles: DataHandle[] }> {
  const g = GlobalArgsSchema.parse(ctx.globalArgs);
  ctx.logger.info(`Pushing ${args.image} with ${g.binary}`);

  const result = await runPushCommand(g.binary, args, ctx.signal);
  const digest = parseDigest(result.stdout + result.stderr);

  const handle = await ctx.writeResource("pushResult", `push-${g.name}`, {
    image: args.image,
    digest,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    binary: g.binary,
  });

  if (result.exitCode !== 0) {
    throw new Error(
      `${g.binary} push failed (exit ${result.exitCode}): ${result.stderr}`,
    );
  }

  return { dataHandles: [handle] };
}
