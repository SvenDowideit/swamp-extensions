/**
 * Execute-level tests for the `@svendowideit/huggingface` model: the Hub HTTP
 * calls are mocked with a stubbed `fetch`, so the search/inspect/recommend/
 * clarify/download flows run without the network.
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
  model,
  parseSelection,
  resolveToken,
} from "./huggingface.ts";

const GLOBALS = {
  name: "hf",
  endpoint: "https://huggingface.co",
  token: "t",
  tokenEnvVar: "HF_TOKEN",
  library: "gguf",
  timeoutSec: 30,
  cacheDir: "~/.cache/huggingface",
};

const realFetch = globalThis.fetch;

/** Install a stubbed fetch for the duration of `fn`, always restoring it. */
async function withFetch(
  handler: (url: string) => Response,
  fn: () => Promise<void>,
): Promise<void> {
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    return Promise.resolve(handler(url));
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

Deno.test("resolveToken prefers the global, then the env var, else anonymous", () => {
  assertEquals(resolveToken({ ...GLOBALS, token: "abc" }), {
    token: "abc",
    source: "global",
  });
  const saved = Deno.env.get("HF_TOKEN");
  Deno.env.set("HF_TOKEN", "fromenv");
  try {
    assertEquals(resolveToken({ ...GLOBALS, token: "" }), {
      token: "fromenv",
      source: "env:HF_TOKEN",
    });
  } finally {
    if (saved === undefined) Deno.env.delete("HF_TOKEN");
    else Deno.env.set("HF_TOKEN", saved);
  }
  Deno.env.delete("HF_TOKEN");
  assertEquals(resolveToken({ ...GLOBALS, token: "" }).source, "anonymous");
});

Deno.test("parseSelection splits repo#quant", () => {
  assertEquals(parseSelection("a/b#Q4_K_M"), { repo: "a/b", quant: "Q4_K_M" });
  assertEquals(parseSelection("a/b"), { repo: "a/b", quant: "" });
});

Deno.test("expandHome expands a leading tilde", () => {
  const home = Deno.env.get("HOME") ?? "";
  assertEquals(expandHome("~"), home);
  assertEquals(expandHome("~/x"), `${home}/x`);
  assertEquals(expandHome("/abs/x"), "/abs/x");
});

Deno.test("auth reports the identity from /api/whoami-v2", async () => {
  let ctx: Awaited<ReturnType<typeof runMethod>>;
  await withFetch(() => Response.json({ name: "svend" }), async () => {
    ctx = await runMethod("auth", {});
  });
  const auth = ctx!.getWrittenResources().find((w) => w.specName === "auth")!;
  assertEquals(auth.data.authenticated, true);
  assertEquals(auth.data.user, "svend");
  assertEquals(auth.data.tokenSource, "global");
});

Deno.test("search writes the parsed results", async () => {
  let ctx: Awaited<ReturnType<typeof runMethod>>;
  await withFetch(
    () =>
      Response.json([
        { id: "Qwen/Qwen2.5-Coder-7B-Instruct-GGUF", downloads: 10 },
      ]),
    async () => {
      ctx = await runMethod("search", { ask: "coder", limit: 5 });
    },
  );
  const s = ctx!.getWrittenResources().find((w) => w.specName === "search")!;
  assertEquals(s.data.count, 1);
  const results = s.data.results as Array<Record<string, unknown>>;
  assertEquals(results[0].id, "Qwen/Qwen2.5-Coder-7B-Instruct-GGUF");
});

Deno.test("recommend ranks budget-scored candidates and flags ambiguity", async () => {
  const mib = 1048576;
  let ctx: Awaited<ReturnType<typeof runMethod>>;
  await withFetch((url) => {
    if (url.includes("/tree/")) {
      const size = url.includes("a/coder") ? 7000 * mib : 8000 * mib;
      return Response.json([
        { type: "file", path: "c-Q4_K_M.gguf", lfs: { size, oid: "o" } },
      ]);
    }
    return Response.json([{ id: "a/coder" }, { id: "b/coder" }]);
  }, async () => {
    ctx = await runMethod("recommend", {
      ask: "a coder",
      vramMiB: 24564,
      ramMiB: 128000,
      candidates: 2,
      quant: "",
    });
  });
  const rec = ctx!.getWrittenResources().find(
    (w) => w.specName === "recommendation",
  )!;
  assertEquals(rec.data.ambiguous, true);
  const candidates = rec.data.candidates as Array<Record<string, unknown>>;
  assertEquals(candidates.length, 2);
  assertEquals(candidates[0].verdict, "gpu");
  assertEquals((rec.data.options as unknown[]).length, 2);
});

Deno.test("clarify with an answer writes the selection", async () => {
  let ctx: Awaited<ReturnType<typeof runMethod>>;
  await withFetch(() => new Response("{}"), async () => {
    ctx = await runMethod("clarify", {
      answer: "Qwen/Qwen2.5-Coder-7B-GGUF#Q4_K_M",
    });
  });
  const sel = ctx!.getWrittenResources().find((w) =>
    w.specName === "selection"
  )!;
  assertEquals(sel.data.repo, "Qwen/Qwen2.5-Coder-7B-GGUF");
  assertEquals(sel.data.quant, "Q4_K_M");
});

Deno.test("clarify with no answer emits the question from the recommendation", async () => {
  const written: Array<{ specName: string; data: Record<string, unknown> }> =
    [];
  const context = {
    globalArgs: GLOBALS,
    logger: { info: () => {}, warn: () => {} },
    writeResource: (
      specName: string,
      _name: string,
      data: Record<string, unknown>,
    ) => {
      written.push({ specName, data });
      return Promise.resolve({ name: _name });
    },
    readResource: (instanceName: string) =>
      Promise.resolve(
        instanceName === "recommendation"
          ? {
            question: "Which one?",
            options: [{ value: "a/b#Q4_K_M", label: "a/b", tradeoff: "fits" }],
          }
          : null,
      ),
  };
  const execute = model.methods.clarify.execute as unknown as (
    a: Record<string, unknown>,
    c: unknown,
  ) => Promise<unknown>;
  await execute({ answer: "" }, context);
  const clar = written.find((w) => w.specName === "clarification")!;
  assertEquals(clar.data.question, "Which one?");
  assertEquals(clar.data.resolved, false);
});

Deno.test("download streams files to the destination and records them", async () => {
  const dir = await Deno.makeTempDir({ prefix: "hf-dl-" });
  try {
    let ctx: Awaited<ReturnType<typeof runMethod>>;
    await withFetch((url) => {
      if (url.includes("/tree/")) {
        return Response.json([
          {
            type: "file",
            path: "c-Q4_K_M.gguf",
            lfs: { size: 11, oid: "deadbeef" },
          },
        ]);
      }
      return new Response("hello world");
    }, async () => {
      ctx = await runMethod("download", {
        repo: "a/coder",
        revision: "main",
        quant: "Q4_K_M",
        files: [],
        dest: dir,
        verify: true,
      });
    });
    const dl = ctx!.getWrittenResources().find((w) =>
      w.specName === "download"
    )!;
    const files = dl.data.files as Array<Record<string, unknown>>;
    assertEquals(files.length, 1);
    assertEquals(files[0].sizeBytes, 11);
    const local = String(files[0].localPath);
    assertEquals(await Deno.readTextFile(local), "hello world");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("download resumes a partial file with a Range request", async () => {
  const dir = await Deno.makeTempDir({ prefix: "hf-resume-" });
  const realFetch = globalThis.fetch;
  const local = `${dir}/m-Q4_K_M.gguf`;
  await Deno.writeTextFile(local, "hello");
  let range = "";
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    if (url.includes("/tree/")) {
      return Promise.resolve(
        Response.json([
          { type: "file", path: "m-Q4_K_M.gguf", lfs: { size: 11, oid: "o" } },
        ]),
      );
    }
    range = new Headers(init?.headers).get("range") ?? "";
    return Promise.resolve(new Response(" world", { status: 206 }));
  }) as typeof fetch;
  try {
    const ctx = await runMethod("download", {
      repo: "a/b",
      revision: "main",
      quant: "Q4_K_M",
      files: [],
      dest: dir,
      verify: false,
      detached: false,
    });
    assertEquals(range, "bytes=5-");
    const d = ctx.getWrittenResources().find((w) => w.specName === "download")!;
    const files = d.data.files as Array<Record<string, unknown>>;
    assertEquals(files[0].sizeBytes, 11);
    assertEquals(files[0].resumed, true);
    assertEquals(await Deno.readTextFile(local), "hello world");
  } finally {
    globalThis.fetch = realFetch;
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("download skips a complete file without re-fetching it", async () => {
  const dir = await Deno.makeTempDir({ prefix: "hf-skip-" });
  const realFetch = globalThis.fetch;
  await Deno.writeTextFile(`${dir}/m-Q4_K_M.gguf`, "hello world");
  let resolveCalls = 0;
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    if (url.includes("/tree/")) {
      return Promise.resolve(
        Response.json([
          { type: "file", path: "m-Q4_K_M.gguf", lfs: { size: 11, oid: "o" } },
        ]),
      );
    }
    resolveCalls++;
    return Promise.resolve(new Response("nope", { status: 200 }));
  }) as typeof fetch;
  try {
    const ctx = await runMethod("download", {
      repo: "a/b",
      revision: "main",
      quant: "Q4_K_M",
      files: [],
      dest: dir,
      verify: false,
      detached: false,
    });
    assertEquals(resolveCalls, 0);
    const d = ctx.getWrittenResources().find((w) => w.specName === "download")!;
    const files = d.data.files as Array<Record<string, unknown>>;
    assertEquals(files[0].resumed, true);
    assertEquals(files[0].sizeBytes, 11);
  } finally {
    globalThis.fetch = realFetch;
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("download detached starts a host-managed transfer", async () => {
  const dir = await Deno.makeTempDir({ prefix: "hf-det-" });
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    if (url.includes("/tree/")) {
      return Promise.resolve(
        Response.json([
          { type: "file", path: "m-Q4_K_M.gguf", lfs: { size: 11, oid: "o" } },
        ]),
      );
    }
    return Promise.resolve(new Response("x", { status: 200 }));
  }) as typeof fetch;
  try {
    let ctx: Awaited<ReturnType<typeof runMethod>>;
    await withMockedCommand(
      () => ({ stdout: "", stderr: "", code: 0 }),
      async () => {
        ctx = await runMethod("download", {
          repo: "a/b",
          revision: "main",
          quant: "Q4_K_M",
          files: [],
          dest: dir,
          verify: false,
          detached: true,
        });
      },
    );
    const t = ctx!.getWrittenResources().find((w) =>
      w.specName === "transfer"
    )!;
    assertEquals(t.data.status, "running");
    assertEquals(t.data.how, "systemd-run");
    assertStringIncludes(String(t.data.scriptPath), ".transfers/");
  } finally {
    globalThis.fetch = realFetch;
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("downloadStatus completes a finished transfer", async () => {
  const dir = await Deno.makeTempDir({ prefix: "hf-status-" });
  const file = `${dir}/m.gguf`;
  await Deno.writeTextFile(file, "complete-bytes");
  const marker = `${dir}/x.done`;
  await Deno.writeTextFile(marker, "");
  const written: Array<{ specName: string; data: Record<string, unknown> }> =
    [];
  const transfer = {
    repo: "a/b",
    revision: "main",
    dest: dir,
    files: [{
      path: "m.gguf",
      localPath: file,
      expectedBytes: 14,
      expectedOid: "",
    }],
    scriptPath: `${dir}/x.sh`,
    markerPath: marker,
    failPath: `${dir}/x.fail`,
    unit: "u",
    how: "systemd-run",
    status: "running",
    startedAt: new Date().toISOString(),
  };
  const context = {
    globalArgs: GLOBALS,
    logger: { info: () => {}, warn: () => {} },
    writeResource: (
      specName: string,
      name: string,
      data: Record<string, unknown>,
    ) => {
      written.push({ specName, data });
      return Promise.resolve({ name });
    },
    readResource: (n: string) =>
      Promise.resolve(n === "transfer" ? transfer : null),
  };
  const execute = model.methods.downloadStatus.execute as unknown as (
    a: Record<string, unknown>,
    c: unknown,
  ) => Promise<unknown>;
  try {
    await execute({ wait: false, maxWaitSec: 0, verify: false }, context);
    const dl = written.find((w) => w.specName === "download")!;
    const files = dl.data.files as Array<Record<string, unknown>>;
    assertEquals(files[0].sizeBytes, 14);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
