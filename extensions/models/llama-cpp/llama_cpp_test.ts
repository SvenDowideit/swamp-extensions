/**
 * Execute-level tests for the `@svendowideit/llama-cpp` model, with commands
 * mocked and a real tar.gz fixture for `install`.
 *
 * @module
 */
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  createModelTestContext,
  withMockedCommand,
} from "jsr:@swamp-club/swamp-testing@^0.3.0";
import {
  expandHome,
  findBinaries,
  model,
  parseTokensPerSecond,
} from "./llama_cpp.ts";

const GLOBALS = {
  name: "lc",
  installDir: "~/.local/llama-cpp",
  downloadDir: "~/.cache/llama-cpp",
  host: "127.0.0.1",
  port: 8080,
  serviceName: "llama-cpp",
  serviceScope: "user",
  unitDir: "",
  ctx: 4096,
  ngl: -1,
  threads: 0,
  extraArgs: "",
  sudo: "sudo",
  releaseRepo: "",
  releaseTag: "",
};

function runMethod(
  methodName: keyof typeof model.methods,
  args: Record<string, unknown>,
  globalArgs: Record<string, unknown> = GLOBALS,
) {
  const ctx = createModelTestContext({
    globalArgs,
    methodName: String(methodName),
  });
  const execute = model.methods[methodName].execute as unknown as (
    a: Record<string, unknown>,
    c: unknown,
  ) => Promise<unknown>;
  return execute(args, ctx.context).then(() => ctx);
}

Deno.test("expandHome expands a leading tilde", () => {
  const home = Deno.env.get("HOME") ?? "";
  assertEquals(expandHome("~/x"), `${home}/x`);
  assertEquals(expandHome("/abs"), "/abs");
});

Deno.test("parseTokensPerSecond reads llama.cpp timing output", () => {
  assertEquals(parseTokensPerSecond("... 12.5 tokens per second ..."), 12.5);
  assertEquals(parseTokensPerSecond("no timing here"), 0);
});

Deno.test("findBinaries walks a tree and maps names to paths", async () => {
  const dir = await Deno.makeTempDir({ prefix: "lc-bins-" });
  try {
    await Deno.mkdir(`${dir}/a/b`, { recursive: true });
    await Deno.writeTextFile(`${dir}/a/b/llama-server`, "x");
    await Deno.writeTextFile(`${dir}/a/llama-cli`, "y");
    const bins = await findBinaries(dir, ["llama-server", "llama-cli"]);
    assertEquals(bins["llama-server"], `${dir}/a/b/llama-server`);
    assertEquals(bins["llama-cli"], `${dir}/a/llama-cli`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("plan resolves the kernel build for the host platform", async () => {
  let ctx: Awaited<ReturnType<typeof runMethod>>;
  await withMockedCommand(
    () => ({ stdout: "Linux x86_64\n", code: 0 }),
    async () => {
      ctx = await runMethod("plan", {
        kernel: "kolibri1",
        os: "linux",
        arch: "aarch64",
        accel: "cpu",
      });
    },
  );
  const p = ctx!.getWrittenResources().find((w) => w.specName === "plan")!;
  assertEquals(p.data.supported, true);
  assertEquals(
    p.data.assetName,
    "hob-llama.cpp-b11434-bin-ubuntu-arm64.tar.gz",
  );
  assertEquals(p.data.kernel, "kolibri1");
  assertStringIncludes(String(p.data.downloadUrl), "Seraphiel102/llama.cpp");
});

Deno.test("plan falls back to a source build when no asset matches the accelerator", async () => {
  let ctx: Awaited<ReturnType<typeof runMethod>>;
  await withMockedCommand(
    () => ({ stdout: "Linux aarch64\n", code: 0 }),
    async () => {
      ctx = await runMethod("plan", {
        kernel: "kolibri1",
        os: "linux",
        arch: "aarch64",
        accel: "cuda",
      });
    },
  );
  const p = ctx!.getWrittenResources().find((w) => w.specName === "plan")!;
  assertEquals(p.data.source, "build");
  assertEquals(p.data.accel, "cuda");
  assertEquals(p.data.supported, true);
  assertEquals(p.data.downloadUrl, "");
  assertEquals(p.data.sourceCommit, "836d571");
  assertStringIncludes(String(p.data.sourceRepo), "llama.cpp");
});

Deno.test("plan uses the release asset when one matches the accelerator", async () => {
  let ctx: Awaited<ReturnType<typeof runMethod>>;
  await withMockedCommand(
    () => ({ stdout: "Linux aarch64\n", code: 0 }),
    async () => {
      ctx = await runMethod("plan", {
        kernel: "kolibri1",
        os: "linux",
        arch: "aarch64",
        accel: "cpu",
      });
    },
  );
  const p = ctx!.getWrittenResources().find((w) => w.specName === "plan")!;
  assertEquals(p.data.source, "release");
  assertEquals(
    p.data.assetName,
    "hob-llama.cpp-b11434-bin-ubuntu-arm64.tar.gz",
  );
  assertStringIncludes(String(p.data.downloadUrl), "Seraphiel102/llama.cpp");
});

Deno.test("kernels lists the registry", async () => {
  let ctx: Awaited<ReturnType<typeof runMethod>>;
  await withMockedCommand(() => ({ stdout: "", code: 0 }), async () => {
    ctx = await runMethod("kernels", {});
  });
  const k = ctx!.getWrittenResources().find((w) => w.specName === "kernels")!;
  assertEquals((k.data.count as number) >= 1, true);
  const list = k.data.kernels as Array<Record<string, unknown>>;
  assertEquals(list.some((x) => x.key === "kolibri1"), true);
});

Deno.test("download streams the kernel asset to disk", async () => {
  const dir = await Deno.makeTempDir({ prefix: "lc-dl-" });
  const realFetch = globalThis.fetch;
  globalThis.fetch =
    (() => Promise.resolve(new Response("binary-bytes"))) as typeof fetch;
  try {
    const ctx = await runMethod("download", {
      url: "https://github.com/x/y/releases/download/t/build.tar.gz",
      dir,
      force: true,
    });
    const d = ctx.getWrittenResources().find((w) => w.specName === "download")!;
    assertEquals(d.data.assetName, "build.tar.gz");
    assertEquals(d.data.sizeBytes, 12);
    assertEquals(await Deno.readTextFile(String(d.data.path)), "binary-bytes");
  } finally {
    globalThis.fetch = realFetch;
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("install extracts a kernel archive and locates binaries", async () => {
  const dir = await Deno.makeTempDir({ prefix: "lc-install-" });
  try {
    const src = `${dir}/src`;
    await Deno.mkdir(`${src}/bin`, { recursive: true });
    await Deno.writeTextFile(`${src}/bin/llama-server`, "#!/bin/sh\necho s\n");
    await Deno.writeTextFile(`${src}/bin/llama-cli`, "#!/bin/sh\necho c\n");
    const tarball = `${dir}/build.tar.gz`;
    await new Deno.Command("tar", {
      args: ["-czf", tarball, "-C", src, "."],
    }).output();
    const out = `${dir}/out`;
    // No command mocking here: install must really extract the archive.
    const ctx = await runMethod("install", {
      archivePath: tarball,
      archiveName: "build.tar.gz",
      checksum: "",
      version: "hob-b11434",
      installDir: out,
      force: false,
    });
    const inst = ctx.getWrittenResources().find((w) =>
      w.specName === "install"
    )!;
    assertStringIncludes(String(inst.data.serverBin), "llama-server");
    assertStringIncludes(String(inst.data.cliBin), "llama-cli");
    assertEquals(inst.data.version, "hob-b11434");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("renderService renders the llama-server unit", async () => {
  let ctx: Awaited<ReturnType<typeof runMethod>>;
  await withMockedCommand(() => ({ stdout: "", code: 0 }), async () => {
    ctx = await runMethod("renderService", {
      model: "/models/kolibri.gguf",
      ctx: 8192,
      ngl: 0,
      host: "",
      port: 0,
      threads: 0,
      extraArgs: "",
      write: false,
    });
  });
  const s = ctx!.getWrittenResources().find((w) => w.specName === "service")!;
  assertStringIncludes(String(s.data.content), "llama-server");
  assertStringIncludes(String(s.data.content), "-m /models/kolibri.gguf");
  assertStringIncludes(String(s.data.content), "-c 8192");
  assertEquals(s.data.written, false);
});

Deno.test("verify runs the smoke prompt and passes on a non-empty answer", async () => {
  let ctx: Awaited<ReturnType<typeof runMethod>>;
  await withMockedCommand(() => ({
    stdout: "Kolibri says hello",
    stderr: "12.0 tokens per second",
    code: 0,
  }), async () => {
    ctx = await runMethod("verify", {
      model: "/models/kolibri.gguf",
      prompt: "hi",
      numPredict: 16,
      ctx: 0,
      ngl: -2,
      threads: -1,
      expectVram: false,
    });
  });
  const v = ctx!.getWrittenResources().find((w) => w.specName === "verify")!;
  assertEquals(v.data.passed, true);
  assertEquals(v.data.response, "Kolibri says hello");
  assertEquals(v.data.tokensPerSecond, 12);
});
