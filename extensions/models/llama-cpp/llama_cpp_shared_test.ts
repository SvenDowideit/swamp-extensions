/**
 * Tests for the pure registry, asset-selection and unit-rendering helpers in
 * `llama_cpp_shared.ts`.
 *
 * @module
 */
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  archiveFormat,
  assetSummary,
  buildServerArgs,
  cmakeFlagsFor,
  kernelKeys,
  KERNELS,
  normalizeAccel,
  normalizeArch,
  normalizeOs,
  renderBuildScript,
  renderServiceUnit,
  resolveAsset,
  resolveKernel,
  systemctl,
  unitPath,
} from "./llama_cpp_shared.ts";

Deno.test("registry has kolibri1 and resolves by key", () => {
  assertEquals(kernelKeys().includes("kolibri1"), true);
  assertEquals(
    resolveKernel("kolibri1")?.releaseRepo,
    "Seraphiel102/llama.cpp",
  );
  assertEquals(resolveKernel("nope"), null);
  assertStringIncludes(KERNELS.kolibri1.note, "kolibri1-llama.cpp.patch");
});

Deno.test("normalizers map OS/arch/accel tokens", () => {
  assertEquals(normalizeOs("Darwin"), "darwin");
  assertEquals(normalizeOs("Linux"), "linux");
  assertEquals(normalizeOs("MINGW64_NT"), "mingw64_nt");
  assertEquals(normalizeArch("arm64"), "aarch64");
  assertEquals(normalizeArch("x86_64"), "x86_64");
  assertEquals(normalizeAccel("nvidia"), "cuda");
  assertEquals(normalizeAccel("apple"), "metal");
  assertEquals(normalizeAccel(""), "cpu");
});

Deno.test("archiveFormat detects zip vs tar.gz", () => {
  assertEquals(archiveFormat("a.tar.gz"), "tar.gz");
  assertEquals(archiveFormat("a.zip"), "zip");
  assertEquals(archiveFormat("a"), "tar.gz");
});

Deno.test("resolveAsset picks the platform build, with cpu fallback", () => {
  const def = KERNELS.kolibri1;
  assertEquals(
    resolveAsset(def, { os: "linux", arch: "aarch64", accel: "cpu" })?.name,
    "hob-llama.cpp-b11434-bin-ubuntu-arm64.tar.gz",
  );
  assertEquals(
    resolveAsset(def, { os: "Linux", arch: "x86_64", accel: "nvidia" })?.name,
    "hob-llama.cpp-b11434-bin-ubuntu-cuda-12.8-x64.tar.gz",
  );
  // Unknown accel on a known os/arch falls back to the cpu build.
  assertEquals(
    resolveAsset(def, { os: "linux", arch: "x86_64", accel: "warp" })?.name,
    "hob-llama.cpp-b11434-bin-ubuntu-x64.tar.gz",
  );
  // Windows cuda is a zip.
  assertEquals(
    resolveAsset(def, { os: "windows", arch: "x86_64", accel: "cuda" })?.format,
    "zip",
  );
  // No darwin/aarch64 build exists.
  assertEquals(
    resolveAsset(def, { os: "darwin", arch: "aarch64", accel: "metal" }),
    null,
  );
});

Deno.test("buildServerArgs builds the llama-server argv", () => {
  const args = buildServerArgs({
    serverBin: "/opt/llama-server",
    modelPath: "/m.gguf",
    host: "0.0.0.0",
    port: 8080,
    ctx: 8192,
    ngl: 999,
    threads: 8,
    sleepIdleSeconds: 3600,
    extraArgs: "--flash-attn -b 512",
  });
  assertEquals(args, [
    "-m",
    "/m.gguf",
    "--host",
    "0.0.0.0",
    "--port",
    "8080",
    "-c",
    "8192",
    "-ngl",
    "999",
    "-t",
    "8",
    "--sleep-idle-seconds",
    "3600",
    "--flash-attn",
    "-b",
    "512",
  ]);
  // threads 0 omits -t; sleepIdleSeconds 0 omits --sleep-idle-seconds.
  const minimal = buildServerArgs({
    serverBin: "s",
    modelPath: "m",
    host: "h",
    port: 1,
    ctx: 1,
    ngl: 0,
    threads: 0,
    sleepIdleSeconds: 0,
    extraArgs: "",
  });
  assertEquals(minimal.includes("-t"), false);
  assertEquals(minimal.includes("--sleep-idle-seconds"), false);
});

Deno.test("renderServiceUnit emits a working unit", () => {
  const unit = renderServiceUnit({
    serviceName: "llama-cpp",
    serverBin: "/opt/llama-server",
    modelPath: "/models/kolibri.gguf",
    host: "127.0.0.1",
    port: 8080,
    ctx: 4096,
    ngl: 0,
    threads: 0,
    sleepIdleSeconds: 3600,
    extraArgs: "",
    workDir: "/home/user",
  });
  assertStringIncludes(unit, "[Unit]");
  assertStringIncludes(
    unit,
    "ExecStart=/opt/llama-server -m /models/kolibri.gguf",
  );
  assertStringIncludes(unit, "--port 8080");
  assertStringIncludes(unit, "--sleep-idle-seconds 3600");
  assertStringIncludes(unit, "TimeoutStartSec=infinity");
  assertStringIncludes(unit, "WantedBy=default.target");
});

Deno.test("unitPath and systemctl respect the scope", () => {
  assertEquals(
    unitPath("user", "llama-cpp"),
    "~/.config/systemd/user/llama-cpp.service",
  );
  assertEquals(
    unitPath("system", "llama-cpp"),
    "/etc/systemd/system/llama-cpp.service",
  );
  assertEquals(unitPath("user", "x", "/tmp/u"), "/tmp/u/x.service");
  assertEquals(systemctl("user", ["restart", "x"]), [
    "systemctl",
    "--user",
    "restart",
    "x",
  ]);
  assertEquals(systemctl("system", ["restart", "x"]), [
    "systemctl",
    "restart",
    "x",
  ]);
});

Deno.test("assetSummary lists coverage", () => {
  assertStringIncludes(assetSummary(KERNELS.kolibri1), "linux/aarch64/cpu");
});

Deno.test("cmakeFlagsFor enables the accelerator", () => {
  assertEquals(cmakeFlagsFor("cuda"), ["-DGGML_CUDA=ON"]);
  assertEquals(cmakeFlagsFor("nvidia"), ["-DGGML_CUDA=ON"]);
  assertEquals(cmakeFlagsFor("rocm"), ["-DGGML_HIP=ON"]);
  assertEquals(cmakeFlagsFor("metal"), ["-DGGML_METAL=ON"]);
  assertEquals(cmakeFlagsFor("cpu"), []);
});

Deno.test("renderBuildScript clones, patches, cmake-builds and marks done", () => {
  const s = renderBuildScript({
    sourceDir: "/src/llama.cpp",
    repo: "https://github.com/ggml-org/llama.cpp",
    commit: "836d571",
    patchUrl: "https://huggingface.co/x/y/resolve/main/p.patch",
    patchName: "p.patch",
    apply: "am",
    cmakeFlags: ["-DGGML_CUDA=ON"],
    jobs: 8,
    binDir: "/install/bin",
    markerPath: "/w/x.done",
    failPath: "/w/x.fail",
    logPath: "/w/x.log",
  });
  assertStringIncludes(
    s,
    "git clone 'https://github.com/ggml-org/llama.cpp' \"$SRC\"",
  );
  assertStringIncludes(s, 'git am "$PATCHFILE"');
  assertStringIncludes(s, "-DGGML_CUDA=ON");
  assertStringIncludes(s, "cmake --build build --config Release -j 8");
  assertStringIncludes(s, '"$BIN/llama-server"');
  assertStringIncludes(s, ': > "$DONE"');
  assertStringIncludes(s, ': > "$FAIL"; exit 1');
});

Deno.test("renderBuildScript defaults jobs to nproc", () => {
  const s = renderBuildScript({
    sourceDir: "/s",
    repo: "r",
    commit: "c",
    patchUrl: "p",
    patchName: "p.patch",
    apply: "apply",
    cmakeFlags: [],
    jobs: 0,
    binDir: "/b",
    markerPath: "m",
    failPath: "f",
    logPath: "l",
  });
  assertStringIncludes(s, "cmake --build build --config Release -j $(nproc");
  assertStringIncludes(s, 'git apply "$PATCHFILE"');
});
