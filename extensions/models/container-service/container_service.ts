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
 * Swamp model that builds, runs, pushes, and **runs long-lived services** in
 * containers, via Docker, Podman, or Apple Containers.
 *
 * A vendored extension of `@swamp/container-image` (see README "Provenance").
 * The upstream build/run/push methods are unchanged; this fork adds a detached
 * `service` lifecycle (`service`, `serviceStatus`) with a `direct` restart
 * policy backend and a `systemd` backend (podman Quadlet; docker user unit).
 *
 * The model entrypoint is intentionally thin — schemas live in
 * `_lib/schemas.ts`, operation logic in `_lib/operations.ts` and
 * `_lib/service.ts`, and checks in `_lib/checks.ts`.
 *
 * @module
 */

import {
  BuildArgsSchema,
  BuildResultSchema,
  BuildxBuildArgsSchema,
  BuildxResultSchema,
  ExecArgsSchema,
  ExecResultSchema,
  GlobalArgsSchema,
  LoginArgsSchema,
  LoginResultSchema,
  NetworkArgsSchema,
  NetworkResultSchema,
  PushArgsSchema,
  PushResultSchema,
  RunArgsSchema,
  RunResultSchema,
  ServiceArgsSchema,
  ServiceResultSchema,
  ServiceStatusArgsSchema,
  ServiceStatusResultSchema,
  ValidateArgsSchema,
  ValidateResultSchema,
} from "./_lib/schemas.ts";
import type {
  BuildArgs,
  BuildxBuildArgs,
  ExecArgsInput,
  LoginArgs,
  NetworkArgsInput,
  PushArgs,
  RunArgs,
  ServiceArgsInput,
  ServiceStatusArgsInput,
} from "./_lib/schemas.ts";
import {
  type ContainerContext,
  runBuild,
  runBuildxBuild,
  runLogin,
  runPush,
  runRun,
  runValidate,
} from "./_lib/operations.ts";
import {
  runContainerExec,
  runNetwork,
  runService,
  runServiceStatus,
  type ServiceContext,
  type ServiceGlobalArgs,
} from "./_lib/service.ts";
import {
  type BinaryProbe,
  type BuildxProbe,
  checkBuildxAvailable,
  type CheckContext,
  checkRuntimeAvailable,
} from "./_lib/checks.ts";

export const model = {
  type: "@svendowideit/container-service",
  version: "2026.10.07.1",
  globalArguments: GlobalArgsSchema,

  upgrades: [
    {
      toVersion: "2026.10.07.1",
      description:
        "Initial release: a fork of @swamp/container-image adding a detached " +
        "`service` lifecycle (service/serviceStatus) with direct and systemd " +
        "backends, plus `exec` (argv in a running container) and `network` " +
        "(idempotent network ensure/remove).",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],

  resources: {
    validateResult: {
      description:
        "Outcome of a `validate` invocation — runtime presence, daemon " +
        "connectivity, buildx availability, and per-method readiness.",
      schema: ValidateResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    buildResult: {
      description:
        "Outcome of a `build` invocation — tag, exit code, and captured output.",
      schema: BuildResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 50,
    },
    runResult: {
      description:
        "Outcome of a `run` invocation — image, exit code, stdout, and stderr.",
      schema: RunResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 50,
    },
    loginResult: {
      description:
        "Outcome of a `login` invocation — server, username, and exit code. " +
        "Password is never persisted.",
      schema: LoginResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    multiPlatformBuildResult: {
      description:
        "Outcome of a `multi-platform-build` invocation — platforms, tags, " +
        "pushed digest, exit code, and captured output.",
      schema: BuildxResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 50,
    },
    pushResult: {
      description:
        "Outcome of a `push` invocation — image reference, pushed digest, " +
        "exit code, and captured output.",
      schema: PushResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 50,
    },
    serviceResult: {
      description:
        "Outcome of a `service` invocation — container state, whether the " +
        "container was created/recreated, the systemd unit when applicable, " +
        "and captured output.",
      schema: ServiceResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    serviceStatusResult: {
      description:
        "Outcome of a `serviceStatus` invocation — existence, running state, " +
        "health, image, published ports, and systemd unit state.",
      schema: ServiceStatusResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    execResult: {
      description:
        "Outcome of an `exec` invocation — the argv run inside the container, " +
        "exit code, stdout, and stderr.",
      schema: ExecResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    networkResult: {
      description:
        "Outcome of a `network` invocation — network name, whether it was " +
        "created, and captured output.",
      schema: NetworkResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  checks: {
    "runtime-available": {
      description:
        "Ensures the configured container runtime binary is on PATH.",
      labels: ["policy"],
      appliesTo: [
        "build",
        "run",
        "service",
        "serviceStatus",
        "exec",
        "network",
        "login",
        "push",
        "multi-platform-build",
      ],
      execute: (ctx: CheckContext, probe?: BinaryProbe) =>
        checkRuntimeAvailable(ctx, probe),
    },
    "multi-platform-available": {
      description:
        "Ensures multi-platform build support is available. Docker needs " +
        "the buildx plugin; podman has native support; Apple Containers " +
        "is single-platform only.",
      labels: ["policy"],
      appliesTo: ["multi-platform-build"],
      execute: (ctx: CheckContext, probe?: BuildxProbe) =>
        checkBuildxAvailable(ctx, probe),
    },
  },

  methods: {
    validate: {
      description:
        "Check that the container runtime is installed, the daemon is " +
        "reachable, and report which methods are available. Fails fast " +
        "if critical dependencies are missing.",
      arguments: ValidateArgsSchema,
      execute: (args: Record<string, never>, ctx: ContainerContext) =>
        runValidate(args, ctx),
    },
    build: {
      description:
        "Build a container image from a Dockerfile. Supports OCI output format.",
      arguments: BuildArgsSchema,
      execute: (args: BuildArgs, ctx: ContainerContext) => runBuild(args, ctx),
    },
    run: {
      description:
        "Run a container image with --rm. Captures stdout and stderr. Use " +
        "`service` instead for a long-lived daemon.",
      arguments: RunArgsSchema,
      execute: (args: RunArgs, ctx: ContainerContext) => runRun(args, ctx),
    },
    service: {
      description:
        "Idempotently run a long-lived container detached: `ensure` create " +
        "+ start (a no-op if already correct), `stop`, `restart`, `remove`. " +
        "With serviceBackend 'systemd' the unit is a podman Quadlet or a " +
        "docker user unit; otherwise the runtime restart policy is used.",
      arguments: ServiceArgsSchema,
      execute: async (args: ServiceArgsInput, ctx: ServiceContext) => {
        const g = ctx.globalArgs as unknown as ServiceGlobalArgs;
        const outcome = await runService(args, g, ctx);
        const handle = await ctx.writeResource(
          "serviceResult",
          `service-${args.containerName}`,
          {
            containerName: args.containerName,
            action: args.action,
            backend: g.serviceBackend,
            image: args.image,
            ...outcome,
            binary: g.binary,
          },
        );
        return { dataHandles: [handle] };
      },
    },
    serviceStatus: {
      description:
        "Inspect a service container: existence, running state, health, " +
        "image, published ports, and (when serviceBackend is 'systemd') the " +
        "systemd unit state.",
      arguments: ServiceStatusArgsSchema,
      execute: async (args: ServiceStatusArgsInput, ctx: ServiceContext) => {
        const g = ctx.globalArgs as unknown as ServiceGlobalArgs;
        const result = await runServiceStatus(args, g, ctx);
        const handle = await ctx.writeResource(
          "serviceStatusResult",
          `service-status-${args.containerName}`,
          result as unknown as Record<string, unknown>,
        );
        return { dataHandles: [handle] };
      },
    },
    exec: {
      description:
        "Run a command inside a service container and capture its output. " +
        "The argv counterpart to `service`, for one-off in-container work " +
        "(e.g. seeding a database). Never a shell string.",
      arguments: ExecArgsSchema,
      execute: async (args: ExecArgsInput, ctx: ServiceContext) => {
        const g = ctx.globalArgs as unknown as ServiceGlobalArgs;
        const result = await runContainerExec(args, g, ctx);
        const handle = await ctx.writeResource(
          "execResult",
          `exec-${result.containerName}`,
          result as unknown as Record<string, unknown>,
        );
        return { dataHandles: [handle] };
      },
    },
    network: {
      description:
        "Idempotently create (or remove) a container network so other " +
        "services can join it by name. `ensure` is a no-op when the network " +
        "already exists.",
      arguments: NetworkArgsSchema,
      execute: async (args: NetworkArgsInput, ctx: ServiceContext) => {
        const g = ctx.globalArgs as unknown as ServiceGlobalArgs;
        const result = await runNetwork(args, g, ctx);
        const handle = await ctx.writeResource(
          "networkResult",
          `network-${result.networkName}`,
          result as unknown as Record<string, unknown>,
        );
        return { dataHandles: [handle] };
      },
    },
    login: {
      description:
        "Log into a container registry. Password is piped via --password-stdin " +
        "and never appears in argv or persisted resources. All runtimes " +
        "supported (Apple Containers routes through 'registry login').",
      arguments: LoginArgsSchema,
      execute: (args: LoginArgs, ctx: ContainerContext) => runLogin(args, ctx),
    },
    push: {
      description:
        "Push a container image to a registry. Captures the pushed digest. " +
        "All runtimes supported (Apple Containers routes through " +
        "'image push').",
      arguments: PushArgsSchema,
      execute: (args: PushArgs, ctx: ContainerContext) => runPush(args, ctx),
    },
    "multi-platform-build": {
      description:
        "Multi-platform build and optional push. Docker uses buildx; Podman " +
        "uses native --platform + manifest push. Captures the pushed digest. " +
        "Not available for Apple Containers (single-platform only).",
      arguments: BuildxBuildArgsSchema,
      execute: (args: BuildxBuildArgs, ctx: ContainerContext) =>
        runBuildxBuild(args, ctx),
    },
  },
};
