/**
 * Docker backend for the test factory.
 *
 * Every function here shells out to the `docker` CLI through an injectable
 * runner. It owns image builds, networks, container lifecycle, and `exec`, so
 * the orchestration in `test_factory.ts` can stay readable and the whole
 * backend can be unit-tested with a stub runner.
 *
 * @module
 */
import { type Distro } from "./scenarios.ts";

/** Captured result of a spawned subprocess. */
export interface CmdResult {
  /** Decoded standard output (ANSI stripped). */
  stdout: string;
  /** Decoded standard error (ANSI stripped). */
  stderr: string;
  /** Exit code; `124` on timeout, `127` when the binary could not run. */
  code: number;
}

/** A subprocess runner, injectable so tests can stub external commands. */
export type RunFn = (
  bin: string,
  args: string[],
  opts?: { stdin?: string; timeoutMs?: number },
) => Promise<CmdResult>;

/** Default wall-clock budget for a single docker command. */
export const DEFAULT_CMD_TIMEOUT_MS = 600_000;

/** Strip ANSI SGR sequences so captured output is safe to pattern-match. */
export function stripAnsi(text: string): string {
  // deno-lint-ignore no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

/**
 * Run a subprocess to completion, bounded by a timeout.
 *
 * A timeout is reported as exit code `124`; a spawn failure as `127`. Docker
 * commands routinely exceed the default when they download images, so callers
 * pass a generous `timeoutMs`.
 */
export const run: RunFn = async (bin, args, opts = {}) => {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CMD_TIMEOUT_MS;
  try {
    const proc = new Deno.Command(bin, {
      args,
      stdin: opts.stdin === undefined ? "null" : "piped",
      stdout: "piped",
      stderr: "piped",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const child = proc.spawn();
    if (opts.stdin !== undefined) {
      const writer = child.stdin.getWriter();
      await writer.write(new TextEncoder().encode(opts.stdin));
      await writer.close();
    }
    const out = await child.output();
    return {
      stdout: stripAnsi(new TextDecoder().decode(out.stdout)),
      stderr: stripAnsi(new TextDecoder().decode(out.stderr)),
      code: out.code,
    };
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      return {
        stdout: "",
        stderr: `timed out after ${timeoutMs}ms`,
        code: 124,
      };
    }
    return {
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
      code: 127,
    };
  }
};

/** True when a docker command failed because the binary/daemon is missing. */
export function dockerUnavailable(res: CmdResult): boolean {
  return res.code === 127 ||
    /command not found|Cannot connect to the Docker daemon|docker: not found/i
      .test(res.stderr);
}

/** Probe the Docker daemon and return its server version. */
export async function dockerVersion(
  runFn: RunFn = run,
): Promise<{ available: boolean; version: string; detail: string }> {
  const res = await runFn("docker", [
    "version",
    "--format",
    "{{.Server.Version}}",
  ], { timeoutMs: 30_000 });
  if (res.code !== 0) {
    return {
      available: false,
      version: "",
      detail: res.stderr.trim() || "docker daemon unavailable",
    };
  }
  return { available: true, version: res.stdout.trim(), detail: "" };
}

/** True when a docker image is present locally. */
export async function imageExists(
  runFn: RunFn,
  image: string,
): Promise<boolean> {
  const res = await runFn("docker", ["image", "inspect", image], {
    timeoutMs: 30_000,
  });
  return res.code === 0;
}

/** Image tag for a distro's harness image. */
export function distroImageTag(distro: Distro, systemd: boolean): string {
  return `swamp-test-factory/${distro.name}${systemd ? "-systemd" : ""}:latest`;
}

/** Build context files for a distro harness image. */
export function distroDockerfile(
  distro: Distro,
  systemd: boolean,
): string {
  const lines = [`FROM ${distro.image}`];
  switch (distro.family) {
    case "debian":
      lines.push(
        "RUN apt-get update -qq && apt-get install -y -qq curl ca-certificates git jq tar gzip unzip procps iproute2 >/dev/null 2>&1 && rm -rf /var/lib/apt/lists/*",
      );
      if (systemd) {
        lines.push(
          "RUN apt-get update -qq && apt-get install -y -qq systemd systemd-sysv dbus >/dev/null 2>&1 && rm -rf /var/lib/apt/lists/*",
        );
      }
      break;
    case "rpm":
      // curl is preinstalled (as curl-minimal on Rocky 9) and conflicts with
      // the full package, so install only what is genuinely missing.
      lines.push(
        "RUN dnf install -y -q ca-certificates git jq tar gzip unzip procps-ng iproute >/dev/null && dnf clean all >/dev/null",
      );
      if (systemd) {
        lines.push(
          "RUN dnf install -y -q systemd >/dev/null && dnf clean all >/dev/null",
        );
      }
      break;
    case "apk":
      // Alpine is musl (swamp cannot run) but still needs the tooling for a
      // diagnosed failure. Wolfi already ships busybox tar/gzip/unzip; both
      // distros provide curl, git and jq.
      lines.push(
        "RUN apk add --no-cache curl ca-certificates git jq || apk add --no-cache curl git jq; true",
      );
      if (systemd) {
        lines.push("RUN apk add --no-cache systemd openrc || true");
      }
      break;
  }
  lines.push("ENV SWAMP_TELEMETRY_DISABLED=1");
  lines.push("ENV HOME=/root");
  // The container is long-lived: systemd as PID 1 on a systemd host, a plain
  // `sleep` otherwise. The model runs each role (harness, serve, workers) with
  // `docker exec`, so it works the same whether or not systemd is present and
  // never races a container that has already exited.
  if (systemd) {
    lines.push('CMD ["/sbin/init"]');
  } else {
    lines.push('CMD ["sleep", "infinity"]');
  }
  return lines.join("\n") + "\n";
}

/**
 * Ensure a distro harness image exists, building it on first use.
 *
 * The image carries only *prerequisites* (curl/git/jq, plus systemd when
 * requested) — never swamp itself — so it is independent of the swamp version
 * under test and cacheable across runs. `rebuild` forces a fresh build.
 */
export async function ensureImage(
  runFn: RunFn,
  distro: Distro,
  systemd: boolean,
  rebuild = false,
): Promise<
  { image: string; built: boolean; buildOutput: string; ok: boolean }
> {
  const image = distroImageTag(distro, systemd);
  if (!rebuild && await imageExists(runFn, image)) {
    return { image, built: false, buildOutput: "", ok: true };
  }
  const dir = await Deno.makeTempDir({ prefix: "tf-build-" });
  try {
    await Deno.writeTextFile(
      `${dir}/Dockerfile`,
      distroDockerfile(distro, systemd),
    );
    const res = await runFn(
      "docker",
      ["build", "-t", image, dir],
      { timeoutMs: 900_000 },
    );
    const buildOutput = `${res.stdout}\n${res.stderr}`.trim();
    return { image, built: true, buildOutput, ok: res.code === 0 };
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

/** Create a docker network if it does not already exist. */
export async function ensureNetwork(runFn: RunFn, name: string): Promise<void> {
  const res = await runFn("docker", ["network", "create", name], {
    timeoutMs: 30_000,
  });
  // A "already exists" error is fine; any other failure is surfaced by the
  // caller when it first tries to attach a container.
  if (res.code !== 0 && !/already exists/i.test(res.stderr)) {
    throw new Error(`docker network create ${name} failed: ${res.stderr}`);
  }
}

/** Remove a docker network, ignoring "not found" and "has active endpoints". */
export async function removeNetwork(runFn: RunFn, name: string): Promise<void> {
  await runFn("docker", ["network", "rm", name], { timeoutMs: 30_000 });
}

/** Options for launching a detached container. */
export interface RunDetachedOptions {
  name: string;
  image: string;
  /** Attach to a named network. */
  network?: string;
  /** Share another container's network namespace (e.g. `container:orch`). */
  networkContainer?: string;
  /** Publish a port (host:container). */
  publish?: string;
  /** Run privileged (needed for systemd). */
  privileged?: boolean;
  /** Boot systemd: adds the cgroup mount, cgroupns, and PID-1 entrypoint. */
  systemd?: boolean;
  /** Bind mounts (`host:container[:ro]`). */
  mounts?: string[];
  /** Environment variables. */
  env?: Record<string, string>;
  /** Working directory. */
  workdir?: string;
  /** Explicit container command; defaults to the image's CMD. */
  cmd?: string[];
  /** Container labels. */
  labels?: Record<string, string>;
}

/** Start a detached container and return its id. */
export async function runDetached(
  runFn: RunFn,
  opts: RunDetachedOptions,
): Promise<{ id: string; ok: boolean; output: string }> {
  const args = ["run", "-d", "--name", opts.name];
  if (opts.network) args.push("--network", opts.network);
  if (opts.networkContainer) {
    args.push("--network", `container:${opts.networkContainer}`);
  }
  if (opts.publish) args.push("-p", opts.publish);
  if (opts.privileged) args.push("--privileged");
  if (opts.systemd) {
    // Boot systemd as PID 1 with the cgroup filesystem the init expects.
    args.push(
      "--privileged",
      "--cgroupns=host",
      "-v",
      "/sys/fs/cgroup:/sys/fs/cgroup:rw",
      "--tmpfs",
      "/run",
    );
  }
  for (const mount of opts.mounts ?? []) args.push("-v", mount);
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    args.push("-e", `${k}=${v}`);
  }
  if (opts.workdir) args.push("-w", opts.workdir);
  for (const [k, v] of Object.entries(opts.labels ?? {})) {
    args.push("--label", `${k}=${v}`);
  }
  args.push(opts.image);
  if (opts.cmd && opts.cmd.length > 0) {
    for (const c of opts.cmd) args.push(c);
  } else if (opts.systemd) {
    args.push("/sbin/init");
  }
  const res = await runFn("docker", args, { timeoutMs: 120_000 });
  return {
    id: res.stdout.trim(),
    ok: res.code === 0,
    output: `${res.stdout}\n${res.stderr}`.trim(),
  };
}

/** Run a command inside a running container. */
export async function exec(
  runFn: RunFn,
  container: string,
  argv: string[],
  opts: { env?: Record<string, string>; timeoutMs?: number } = {},
): Promise<CmdResult> {
  const args = ["exec"];
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    args.push("-e", `${k}=${v}`);
  }
  args.push(container, ...argv);
  return await runFn("docker", args, {
    timeoutMs: opts.timeoutMs ?? DEFAULT_CMD_TIMEOUT_MS,
  });
}

/**
 * Run a command inside a running container **detached**.
 *
 * Used for processes that are meant to keep running (a worker's connect loop):
 * `docker exec -d` returns as soon as the process is started, so the caller is
 * not blocked on a forever-running command.
 */
export async function execDetached(
  runFn: RunFn,
  container: string,
  argv: string[],
): Promise<{ ok: boolean; output: string }> {
  const res = await runFn("docker", ["exec", "-d", container, ...argv], {
    timeoutMs: 60_000,
  });
  return { ok: res.code === 0, output: `${res.stdout}\n${res.stderr}`.trim() };
}

/** Fetch a container's combined stdout/stderr logs. */
export async function logs(
  runFn: RunFn,
  container: string,
): Promise<string> {
  const res = await runFn("docker", ["logs", container], { timeoutMs: 60_000 });
  return `${res.stdout}\n${res.stderr}`.trim();
}

/** Create a named volume if it does not already exist. */
export async function ensureVolume(runFn: RunFn, name: string): Promise<void> {
  const res = await runFn("docker", ["volume", "create", name], {
    timeoutMs: 30_000,
  });
  if (res.code !== 0 && !/already exists/i.test(res.stderr)) {
    throw new Error(`docker volume create ${name} failed: ${res.stderr}`);
  }
}

/** Remove a named volume, ignoring "not found". */
export async function removeVolume(
  runFn: RunFn,
  name: string,
): Promise<void> {
  await runFn("docker", ["volume", "rm", name], { timeoutMs: 30_000 });
}

/** Force-remove a container. */
export async function removeContainer(
  runFn: RunFn,
  container: string,
): Promise<void> {
  await runFn("docker", ["rm", "-f", container], { timeoutMs: 60_000 });
}

/** List container ids matching a label filter. */
export async function listContainers(
  runFn: RunFn,
  labelFilter: string,
): Promise<string[]> {
  const res = await runFn("docker", [
    "ps",
    "-aq",
    "--filter",
    `label=${labelFilter}`,
  ], { timeoutMs: 30_000 });
  if (res.code !== 0) return [];
  return res.stdout.split("\n").map((s) => s.trim()).filter((s) =>
    s.length > 0
  );
}

/**
 * Poll a path on the *host* until it exists, or timeout.
 *
 * Used to await the harness's completion sentinel, which the container writes
 * into a bind-mounted host directory. This survives the container exiting (an
 * `exec` against a finished container would fail), so the result can always be
 * read back.
 */
export async function waitHostFile(
  path: string,
  timeoutMs = 60_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const exists = await Deno.stat(path).then(() => true).catch(() => false);
    if (exists) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}
