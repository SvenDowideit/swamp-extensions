/**
 * Execute-level tests for the `@svendowideit/ollama-models` model, with the
 * Ollama HTTP API mocked by a stubbed `fetch`. Also covers the pure host-normal
 * and push-target helpers.
 *
 * @module
 */
import { assertEquals } from "jsr:@std/assert@1";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@^0.3.0";
import { buildPushTarget, model, normalizeHost } from "./ollama_models.ts";

const GLOBALS = {
  name: "om",
  host: "http://127.0.0.1:11434",
  registry: "",
  namespace: "",
  timeoutSec: 120,
  keepAlive: "5m",
};

const realFetch = globalThis.fetch;

/** Install a stubbed fetch, restoring it afterwards. The handler gets the URL. */
async function withFetch(
  handler: (url: string, init?: RequestInit) => Response,
  fn: () => Promise<void>,
): Promise<void> {
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    return Promise.resolve(handler(url, init));
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
}

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

Deno.test("normalizeHost adds a scheme and a default", () => {
  assertEquals(normalizeHost("127.0.0.1:11434"), "http://127.0.0.1:11434");
  assertEquals(normalizeHost("http://gpu-box:11434/"), "http://gpu-box:11434");
  assertEquals(normalizeHost(""), "http://127.0.0.1:11434");
});

Deno.test("buildPushTarget combines registry and namespace", () => {
  assertEquals(buildPushTarget("coder", "", ""), "coder");
  assertEquals(buildPushTarget("coder", "", "sven"), "sven/coder");
  assertEquals(
    buildPushTarget("coder", "registry.ollama.ai", "sven"),
    "registry.ollama.ai/sven/coder",
  );
  assertEquals(
    buildPushTarget("sven/coder", "registry.ollama.ai", ""),
    "registry.ollama.ai/sven/coder",
  );
});

Deno.test("renderModelfile writes the resource and the file", async () => {
  const dir = await Deno.makeTempDir({ prefix: "om-mf-" });
  try {
    const out = `${dir}/Modelfile`;
    let ctx: Awaited<ReturnType<typeof runMethod>>;
    await withFetch(() => new Response("{}"), async () => {
      ctx = await runMethod("renderModelfile", {
        modelName: "coder:latest",
        from: "/models/coder-Q4_K_M.gguf",
        template: "{{ .Prompt }}",
        system: "You are a coding assistant.",
        parameters: { temperature: 0.2 },
        sizeBytes: 4683071232,
        contextLength: 32768,
        vramMiB: 24564,
        ramMiB: 128000,
        outputPath: out,
      });
    });
    const mf = ctx!.getWrittenResources().find((w) =>
      w.specName === "modelfile"
    )!;
    assertEquals(mf.data.placement, "gpu");
    assertEquals(mf.data.numGpu, 999);
    const text = String(mf.data.text);
    assertEquals(text.includes("FROM /models/coder-Q4_K_M.gguf"), true);
    assertEquals(text.includes("PARAMETER num_gpu 999"), true);
    assertEquals(text.includes("PARAMETER temperature 0.2"), true);
    assertEquals(await Deno.readTextFile(out), text);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("create uploads a local GGUF as a blob (not a filesystem from)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "om-gguf-" });
  const gguf = `${dir}/model-Q4_K_M.gguf`;
  await Deno.writeTextFile(gguf, "fake-gguf-bytes");
  try {
    let createBody: Record<string, unknown> = {};
    let uploaded = false;
    await withFetch((url, init) => {
      if (url.includes("/api/blobs/")) {
        if (init?.method === "HEAD") return new Response("", { status: 404 });
        uploaded = true;
        return new Response("", { status: 201 });
      }
      if (url.endsWith("/api/create")) {
        createBody = JSON.parse(String(init?.body ?? "{}"));
        return new Response("{}", { status: 200 });
      }
      return new Response("", { status: 200 });
    }, async () => {
      await runMethod("create", {
        model: "coder:latest",
        modelfile: `FROM ${gguf}\nPARAMETER num_ctx 4096\n`,
        from: "",
      });
    });
    assertEquals(uploaded, true);
    const files = createBody.files as Record<string, string>;
    assertEquals(Object.keys(files).length, 1);
    assertEquals(Object.keys(files)[0].endsWith(".gguf"), true);
    assertEquals(String(Object.values(files)[0]).startsWith("sha256:"), true);
    // It must NOT send the filesystem path as `from`.
    assertEquals("from" in createBody, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("pull records the transfer outcome", async () => {
  let ctx: Awaited<ReturnType<typeof runMethod>>;
  await withFetch(() => Response.json({ status: "success" }), async () => {
    ctx = await runMethod("pull", {
      model: "qwen2.5-coder:7b",
      insecure: false,
    });
  });
  const t = ctx!.getWrittenResources().find((w) => w.specName === "transfer")!;
  assertEquals(t.data.op, "pull");
  assertEquals(t.data.status, "ok");
});

Deno.test("push builds the target from registry and namespace", async () => {
  let ctx: Awaited<ReturnType<typeof runMethod>>;
  let seenBody = "";
  await withFetch((_url, init) => {
    seenBody = String(init?.body ?? "");
    return Response.json({ status: "success" });
  }, async () => {
    ctx = await runMethod("push", {
      model: "coder:latest",
      target: "",
      insecure: false,
    }, {
      ...GLOBALS,
      registry: "registry.ollama.ai",
      namespace: "sven",
    });
  });
  const t = ctx!.getWrittenResources().find((w) => w.specName === "transfer")!;
  assertEquals(t.data.target, "registry.ollama.ai/sven/coder:latest");
  assertEquals(seenBody.includes("registry.ollama.ai/sven/coder:latest"), true);
});

Deno.test("create parses the Modelfile into structured create fields", async () => {
  let ctx: Awaited<ReturnType<typeof runMethod>>;
  let seen: Record<string, unknown> = {};
  await withFetch((_url, init) => {
    seen = JSON.parse(String(init?.body ?? "{}"));
    return new Response("{}", { status: 200 });
  }, async () => {
    ctx = await runMethod("create", {
      model: "coder:latest",
      modelfile:
        'FROM /models/coder-Q4_K_M.gguf\nPARAMETER num_gpu 999\nPARAMETER num_ctx 8192\nTEMPLATE """\n{{ .Prompt }}\n"""\nSYSTEM hi\n',
      from: "",
    });
  });
  const c = ctx!.getWrittenResources().find((w) => w.specName === "create")!;
  assertEquals(c.data.created, true);
  // Structured fields, not a raw `modelfile` (Ollama rejects that).
  assertEquals(seen.from, "/models/coder-Q4_K_M.gguf");
  assertEquals(seen.template, "{{ .Prompt }}");
  assertEquals(seen.system, "hi");
  // Numeric parameters are sent as numbers, not strings.
  assertEquals(seen.parameters, { num_gpu: 999, num_ctx: 8192 });
  assertEquals("modelfile" in seen, false);
});

Deno.test("verify runs the model and asserts GPU residency", async () => {
  let ctx: Awaited<ReturnType<typeof runMethod>>;
  await withFetch((url) => {
    if (url.endsWith("/api/ps")) {
      return Response.json({
        models: [{
          name: "coder:latest",
          size: 4683071232,
          size_vram: 4294967296,
        }],
      });
    }
    return Response.json({
      response: "ready",
      eval_count: 20,
      eval_duration: 1_000_000_000,
    });
  }, async () => {
    ctx = await runMethod("verify", {
      model: "coder:latest",
      prompt: "hi",
      requireVram: true,
    });
  });
  const v = ctx!.getWrittenResources().find((w) => w.specName === "verify")!;
  assertEquals(v.data.passed, true);
  assertEquals(v.data.loadedOnGpu, true);
  assertEquals(v.data.tokensPerSecond, 20);
});

Deno.test("verify fails when the model is not on the GPU", async () => {
  let threw = false;
  await withFetch((url) => {
    if (url.endsWith("/api/ps")) {
      return Response.json({
        models: [{ name: "coder:latest", size_vram: 0 }],
      });
    }
    return Response.json({
      response: "ready",
      eval_count: 1,
      eval_duration: 1e9,
    });
  }, async () => {
    try {
      await runMethod("verify", {
        model: "coder:latest",
        prompt: "hi",
        requireVram: true,
      });
    } catch {
      threw = true;
    }
  });
  assertEquals(threw, true);
});
