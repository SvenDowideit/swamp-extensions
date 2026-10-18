/**
 * Pure helpers for the `@svendowideit/llama-cpp` model — the "custom kernel"
 * path for GGUF models that stock llama.cpp (and therefore Ollama) cannot
 * load.
 *
 * It maps a model's required kernel (e.g. Aleph-Alpha Kolibri-1's `kolibri1`
 * MoE architecture, which needs a patched llama.cpp) to a concrete prebuilt
 * release asset for the host's OS/architecture/accelerator, and renders the
 * `llama-server` systemd user unit that serves it. All side-effect free, so the
 * registry, asset selection and unit text are fully unit-testable.
 *
 * @module
 */

/** A host platform, as used to select a kernel build. */
export interface Platform {
  /** OS token: `linux`, `darwin` or `windows`. */
  os: string;
  /** Architecture token: `x86_64` or `aarch64`. */
  arch: string;
  /** Accelerator: `cuda`, `rocm`, `vulkan`, `metal` or `cpu`. */
  accel: string;
}

/** One downloadable kernel build (a patched llama.cpp binary archive). */
export interface KernelAsset {
  /** OS this asset targets. */
  os: string;
  /** Architecture this asset targets. */
  arch: string;
  /** Accelerator this asset targets. */
  accel: string;
  /** Release asset file name. */
  name: string;
  /** Archive format: `tar.gz` or `zip`. */
  format: string;
}

/** A model architecture that needs a customised llama.cpp kernel. */
export interface KernelDef {
  /** Stable key (e.g. `kolibri1`). */
  key: string;
  /** Human title. */
  title: string;
  /** Why the stock kernel cannot load it, and what this build is. */
  description: string;
  /** GitHub repository publishing the patched build (`owner/name`). */
  releaseRepo: string;
  /** Default release tag to resolve (a pinned patched build). */
  releaseTag: string;
  /** Builds for each platform. */
  assets: KernelAsset[];
  /** Binaries the archive provides (relative to the extracted tree). */
  binaries: string[];
  /** How to pick a GGUF for this model (a hint for the workflow). */
  ggufHint: string;
  /** How to build this kernel from source when no prebuilt asset matches. */
  source?: KernelSource;
  /** Free-form note (patch commit, upstream tracking, caveats). */
  note: string;
}

/** How to build a kernel from source (used when no prebuilt asset matches). */
export interface KernelSource {
  /** Upstream llama.cpp repository URL to clone. */
  repo: string;
  /** Pinned upstream commit to check out before applying the patch. */
  commit: string;
  /** URL of the kernel patch. */
  patchUrl: string;
  /** File name to save the patch as. */
  patchName: string;
  /** How to apply the patch: `am` (git am, keeps commits) or `apply`. */
  apply: string;
}

/** The built-in registry of custom-kernel model architectures. */
export const KERNELS: Record<string, KernelDef> = {
  kolibri1: {
    key: "kolibri1",
    title: "Aleph-Alpha Kolibri-1 (78B MoE)",
    description:
      "Aleph-Alpha Kolibri-1 — a 78B Mixture-of-Experts reasoning model " +
      "(3.46B active) with the `kolibri1` architecture. Stock llama.cpp (and " +
      "therefore Ollama) cannot load it: it needs the `kolibri1-llama.cpp.patch`. " +
      "This build is a patched llama.cpp that can.",
    releaseRepo: "Seraphiel102/llama.cpp",
    releaseTag: "hob-b11434",
    assets: [
      {
        os: "linux",
        arch: "x86_64",
        accel: "cuda",
        name: "hob-llama.cpp-b11434-bin-ubuntu-cuda-12.8-x64.tar.gz",
        format: "tar.gz",
      },
      {
        os: "linux",
        arch: "x86_64",
        accel: "cpu",
        name: "hob-llama.cpp-b11434-bin-ubuntu-x64.tar.gz",
        format: "tar.gz",
      },
      {
        os: "linux",
        arch: "x86_64",
        accel: "vulkan",
        name: "hob-llama.cpp-b11434-bin-ubuntu-vulkan-x64.tar.gz",
        format: "tar.gz",
      },
      {
        os: "linux",
        arch: "x86_64",
        accel: "rocm",
        name: "hob-llama.cpp-b11434-bin-ubuntu-rocm-10.0-x64.tar.gz",
        format: "tar.gz",
      },
      {
        os: "linux",
        arch: "aarch64",
        accel: "cpu",
        name: "hob-llama.cpp-b11434-bin-ubuntu-arm64.tar.gz",
        format: "tar.gz",
      },
      {
        os: "darwin",
        arch: "x86_64",
        accel: "metal",
        name: "hob-llama.cpp-b11434-bin-macos-x64.tar.gz",
        format: "tar.gz",
      },
      {
        os: "windows",
        arch: "x86_64",
        accel: "cuda",
        name: "hob-llama.cpp-b11434-win-cuda-13.4-x64.zip",
        format: "zip",
      },
      {
        os: "windows",
        arch: "x86_64",
        accel: "cpu",
        name: "hob-llama.cpp-b11434-win-cpu-x64.zip",
        format: "zip",
      },
      {
        os: "windows",
        arch: "aarch64",
        accel: "cpu",
        name: "hob-llama.cpp-b11434-win-cpu-arm64.zip",
        format: "zip",
      },
    ],
    binaries: ["llama-server", "llama-cli"],
    ggufHint: "Hob-forge/Kolibri-1-GGUF (Q2_K is the smallest, ~26.7 GB)",
    source: {
      repo: "https://github.com/ggml-org/llama.cpp",
      commit: "836d571",
      patchUrl:
        "https://huggingface.co/Hob-forge/Kolibri-1-GGUF/resolve/main/kolibri1-llama.cpp.patch",
      patchName: "kolibri1-llama.cpp.patch",
      apply: "am",
    },
    note:
      "Prebuilt from upstream llama.cpp commit 836d571 + kolibri1-llama.cpp.patch " +
      "(https://github.com/Seraphiel102/llama.cpp release hob-b11434). There is " +
      "no aarch64+CUDA asset, so on arm64 with a GPU the kernel is built from " +
      "source (clone at 836d571, git am the patch, cmake with the accelerator). " +
      "Track upstream llama.cpp for native `kolibri1` support, after which Ollama " +
      "will follow.",
  },
};

/** All kernel keys in the registry, sorted. */
export function kernelKeys(): string[] {
  return Object.keys(KERNELS).sort();
}

/** Look up a kernel definition by key, or `null`. */
export function resolveKernel(key: string): KernelDef | null {
  return KERNELS[key] ?? null;
}

/** Normalise an OS token (`Linux` → `linux`). */
export function normalizeOs(os: string): string {
  const o = os.trim().toLowerCase();
  if (o.startsWith("darwin") || o.startsWith("mac") || o === "osx") {
    return "darwin";
  }
  if (o.startsWith("win")) return "windows";
  if (o.startsWith("linux")) return "linux";
  return o;
}

/** Normalise an architecture token (`arm64` → `aarch64`). */
export function normalizeArch(arch: string): string {
  const a = arch.trim().toLowerCase();
  if (a === "arm64" || a === "aarch64") return "aarch64";
  if (a === "x86_64" || a === "amd64" || a === "x64") return "x86_64";
  return a;
}

/** Normalise an accelerator token (`nvidia` → `cuda`, `apple` → `metal`). */
export function normalizeAccel(accel: string): string {
  const a = accel.trim().toLowerCase();
  if (a === "nvidia" || a === "cuda") return "cuda";
  if (a === "amd" || a === "rocm") return "rocm";
  if (a === "apple" || a === "metal") return "metal";
  if (a === "vulkan") return "vulkan";
  if (a === "none" || a === "cpu" || a === "") return "cpu";
  return a;
}

/** Archive format from a file name (`.zip` → `zip`, else `tar.gz`). */
export function archiveFormat(name: string): string {
  return /\.zip$/i.test(name) ? "zip" : "tar.gz";
}

/**
 * Pick the best asset for a platform: an exact os/arch/accel match, then the
 * same os/arch with a CPU build, then the first os/arch asset, else `null`.
 */
export function resolveAsset(
  def: KernelDef,
  platform: Platform,
): KernelAsset | null {
  const os = normalizeOs(platform.os);
  const arch = normalizeArch(platform.arch);
  const accel = normalizeAccel(platform.accel);
  const sameOsArch = def.assets.filter((a) => a.os === os && a.arch === arch);
  return sameOsArch.find((a) => a.accel === accel) ??
    sameOsArch.find((a) => a.accel === "cpu") ??
    sameOsArch.find((a) => a.accel === "metal") ??
    sameOsArch[0] ??
    null;
}

/** Options for {@link buildServerArgs} and {@link renderServiceUnit}. */
export interface ServerOptions {
  /** Absolute path to the `llama-server` binary. */
  serverBin: string;
  /** Absolute path to the GGUF model file. */
  modelPath: string;
  /** Bind host. */
  host: string;
  /** Bind port. */
  port: number;
  /** Context window (`-c`). */
  ctx: number;
  /** Layers to offload to the GPU (`-ngl`; 0 = CPU). */
  ngl: number;
  /** CPU threads (`-t`); 0 omits the flag. */
  threads: number;
  /**
   * Keep-alive (seconds of idleness after which the server sleeps and frees
   * the model, waking on the next request). `--sleep-idle-seconds`; 0 omits it
   * (never sleeps).
   */
  sleepIdleSeconds: number;
  /** Extra raw arguments appended verbatim. */
  extraArgs: string;
}

/** Build the `llama-server` argument vector. */
export function buildServerArgs(o: ServerOptions): string[] {
  const args = [
    "-m",
    o.modelPath,
    "--host",
    o.host,
    "--port",
    String(o.port),
    "-c",
    String(o.ctx),
    "-ngl",
    String(o.ngl),
  ];
  if (o.threads > 0) args.push("-t", String(o.threads));
  if (o.sleepIdleSeconds > 0) {
    args.push("--sleep-idle-seconds", String(o.sleepIdleSeconds));
  }
  const extra = o.extraArgs.trim();
  if (extra) args.push(...extra.split(/\s+/));
  return args;
}

/** Quote a value for a systemd `ExecStart` line when it contains spaces. */
export function shQuote(value: string): string {
  return /[\s"'\\]/.test(value)
    ? `"${value.replace(/(["\\])/g, "\\$1")}"`
    : value;
}

/** Options for {@link renderServiceUnit}. */
export interface UnitOptions extends ServerOptions {
  /** systemd unit name without `.service`. */
  serviceName: string;
  /** Working directory for the unit. */
  workDir: string;
}

/** Render a systemd user unit that runs `llama-server` for one GGUF. */
export function renderServiceUnit(o: UnitOptions): string {
  const exec = [shQuote(o.serverBin), ...buildServerArgs(o).map(shQuote)].join(
    " ",
  );
  return `[Unit]
Description=llama.cpp server (${o.serviceName})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${o.workDir}
ExecStart=${exec}
Restart=always
RestartSec=3
# A long model load should not be killed by a startup timeout.
TimeoutStartSec=infinity

[Install]
WantedBy=default.target
`;
}

/** The systemd unit file path for a name and scope. */
export function unitPath(scope: string, name: string, unitDir = ""): string {
  const dir = unitDir ||
    (scope === "system" ? "/etc/systemd/system" : "~/.config/systemd/user");
  return `${dir.replace(/\/+$/, "")}/${name}.service`;
}

/** The `systemctl` command string for a name and scope (`--user` for user). */
export function systemctl(scope: string, args: string[]): string[] {
  return scope === "system"
    ? ["systemctl", ...args]
    : ["systemctl", "--user", ...args];
}

/** A short human summary of a kernel's per-platform coverage. */
export function assetSummary(def: KernelDef): string {
  return def.assets
    .map((a) => `${a.os}/${a.arch}/${a.accel}`)
    .join(", ");
}

/** CMake flags that enable the accelerator for a source build. */
export function cmakeFlagsFor(accel: string): string[] {
  switch (normalizeAccel(accel)) {
    case "cuda":
      return ["-DGGML_CUDA=ON"];
    case "rocm":
      return ["-DGGML_HIP=ON"];
    case "metal":
      return ["-DGGML_METAL=ON"];
    case "vulkan":
      return ["-DGGML_VULKAN=ON"];
    default:
      return [];
  }
}

/** Options for {@link renderBuildScript}. */
export interface BuildScriptOptions {
  /** Clone/checkout directory for llama.cpp. */
  sourceDir: string;
  /** llama.cpp repository URL. */
  repo: string;
  /** Pinned commit to check out. */
  commit: string;
  /** Kernel patch URL. */
  patchUrl: string;
  /** Patch file name. */
  patchName: string;
  /** `am` (git am) or `apply` (git apply). */
  apply: string;
  /** Extra cmake flags (e.g. `-DGGML_CUDA=ON`). */
  cmakeFlags: string[];
  /** Parallel build jobs; 0 = `nproc`. */
  jobs: number;
  /** Where the built binaries are copied (`llama-server`, `llama-cli`). */
  binDir: string;
  /** Marker written on success (0600). */
  markerPath: string;
  /** Marker written on failure. */
  failPath: string;
  /** Log file the build output is appended to. */
  logPath: string;
}

/** Single-quote a string for safe embedding in a POSIX shell script. */
export function shSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Render a POSIX-shell script that builds a kernel from source: clone llama.cpp
 * at the pinned commit (reusing an existing checkout), apply the kernel patch
 * (idempotently), cmake-configure for the accelerator, build, and copy the
 * binaries into `binDir`. Writes `markerPath` on success and `failPath` on
 * failure. Safe to re-run: an existing complete build is skipped.
 */
export function renderBuildScript(o: BuildScriptOptions): string {
  const q = shSingleQuote;
  const jobs = o.jobs > 0 ? String(o.jobs) : "$(nproc 2>/dev/null || echo 4)";
  const applyCmd = o.apply === "apply"
    ? 'git apply "$PATCHFILE"'
    : 'git am "$PATCHFILE"';
  const lines = [
    "#!/bin/sh",
    "# Generated by @svendowideit/llama-cpp - build the kernel from source.",
    "set -u",
    "umask 022",
    `DONE=${q(o.markerPath)}`,
    `FAIL=${q(o.failPath)}`,
    `SRC=${q(o.sourceDir)}`,
    `BIN=${q(o.binDir)}`,
    'if [ -f "$DONE" ]; then echo "already built"; exit 0; fi',
    'rm -f "$FAIL"',
    "(",
    "  set -e",
    `  exec >>${q(o.logPath)} 2>&1`,
    '  command -v git >/dev/null 2>&1 || { echo "git is required to build from source"; exit 1; }',
    '  command -v cmake >/dev/null 2>&1 || { echo "cmake is required to build from source"; exit 1; }',
    '  if [ ! -d "$SRC/.git" ]; then',
    '    mkdir -p "$(dirname "$SRC")"',
    `    git clone ${q(o.repo)} "$SRC"`,
    "  fi",
    '  cd "$SRC"',
    "  git fetch --tags origin || true",
    `  git checkout -f ${q(o.commit)} || git checkout -f ${q(o.commit)}`,
    `  git reset --hard ${q(o.commit)}`,
    `  PATCHFILE="$SRC/${o.patchName.replace(/"/g, "")}"`,
    '  if [ ! -f "$PATCHFILE" ]; then',
    `    curl -fL --retry 10 --retry-delay 5 -o "$PATCHFILE" ${q(o.patchUrl)}`,
    "  fi",
    '  if git apply --reverse --check "$PATCHFILE" 2>/dev/null; then',
    '    echo "patch already applied"',
    "  else",
    `    ${applyCmd}`,
    "  fi",
    "  # Put the accelerator toolchain on PATH (a worker's shell may not have it).",
    "  for d in /usr/local/cuda/bin /opt/cuda/bin /opt/rocm/bin /usr/local/rocm/bin; do",
    '    [ -d "$d" ] && PATH="$d:$PATH"',
    "  done",
    "  export PATH",
    '  if [ -z "${CUDACXX:-}" ] && [ -x /usr/local/cuda/bin/nvcc ]; then',
    "    export CUDACXX=/usr/local/cuda/bin/nvcc",
    "  fi",
    '  if [ -z "${CUDAToolkit_ROOT:-}" ] && [ -d /usr/local/cuda ]; then',
    "    export CUDAToolkit_ROOT=/usr/local/cuda",
    "  fi",
    `  cmake -B build -DCMAKE_BUILD_TYPE=Release ${
      o.cmakeFlags.map(q).join(" ")
    }`,
    `  cmake --build build --config Release -j ${jobs}`,
    '  mkdir -p "$BIN"',
    '  cp -f build/bin/llama-server "$BIN/llama-server"',
    '  cp -f build/bin/llama-cli "$BIN/llama-cli" 2>/dev/null || true',
    '  chmod +x "$BIN/llama-server" 2>/dev/null || true',
    '  : > "$DONE"',
    `) || { : > "$FAIL"; exit 1; }`,
    "",
  ];
  return lines.join("\n");
}
