/**
 * @svendowideit/ollama-models
 *
 * Everything Ollama lets you do with a model, as swamp methods: list, show,
 * pull, push, copy, delete, run, chat, embed, unload, and — the point of the
 * set — generate a Modelfile customised to this host, then `create` the model
 * from it and `verify` that it actually loads on the GPU and answers.
 *
 * It talks to the Ollama HTTP API at `OLLAMA_HOST` (local or a GPU host on the
 * LAN), so one repo can build models on every machine in the fleet.
 *
 * Methods:
 *   - `setup`            resolve and persist the server config
 *   - `sync`/`list`      the server version and the local models
 *   - `show`/`ps`        one model's details / what is loaded right now
 *   - `pull`/`push`/`copy`/`delete`  move models in and out of registries
 *   - `renderModelfile`  customise a Modelfile to a VRAM/RAM budget
 *   - `create`           build a model from a Modelfile (or a GGUF path)
 *   - `run`/`chat`/`embed`/`unload`  inference
 *   - `verify`           run it and assert it loaded on the GPU
 *   - `print`            log a summary
 *
 * @module
 */

import { z } from "npm:zod@4";
import {
  deriveFitParameters,
  type FitResult,
  mergeParameters,
  type Parameter,
  parseModelfile,
  renderModelfile,
  tokensPerSecond,
} from "./ollama_models_shared.ts";

/** The model type name. */
export const OLLAMA_MODELS_TYPE = "@svendowideit/ollama-models";

// ---------------------------------------------------------------------------
// Global arguments
// ---------------------------------------------------------------------------

const GlobalArgsSchema = z.object({
  name: z.string().default("").describe(
    "Model instance name (supplied by swamp).",
  ),
  host: z.string().default("http://127.0.0.1:11434").describe(
    "Ollama server base URL (`127.0.0.1:11434` is accepted; http:// is added).",
  ),
  registry: z.string().default("").describe(
    "Default push registry host (e.g. `registry.ollama.ai`). Empty uses the server default.",
  ),
  namespace: z.string().default("").describe(
    "Default push namespace (e.g. your ollama.com user). Empty pushes as-is.",
  ),
  timeoutSec: z.number().int().default(120).describe(
    "Per-request HTTP timeout in seconds (large pulls need a big value).",
  ),
  keepAlive: z.string().default("5m").describe(
    "Default `keep_alive` for inference calls (e.g. `5m`, `0` to unload).",
  ),
}).strict();

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

// ---------------------------------------------------------------------------
// Method arguments
// ---------------------------------------------------------------------------

const SetupArgsSchema = z.object({});
const SyncArgsSchema = z.object({});
const ListArgsSchema = z.object({});
const ShowArgsSchema = z.object({ model: z.string() });
const PsArgsSchema = z.object({});
const PullArgsSchema = z.object({
  model: z.string().describe("Model to pull, e.g. `qwen2.5-coder:7b`."),
  insecure: z.boolean().default(false).describe(
    "Allow an insecure registry connection.",
  ),
});
const PushArgsSchema = z.object({
  model: z.string().describe("Local model to push."),
  target: z.string().default("").describe(
    "Full target name (`namespace/model:tag`). Empty builds it from the global registry/namespace.",
  ),
  insecure: z.boolean().default(false),
});
const CopyArgsSchema = z.object({
  source: z.string(),
  destination: z.string(),
});
const DeleteArgsSchema = z.object({ model: z.string() });

const RenderArgsSchema = z.object({
  modelName: z.string().describe("Target Ollama model name (`name:tag`)."),
  from: z.string().describe(
    "`FROM`: a local GGUF path (from a Hugging Face download) or an existing model.",
  ),
  adapter: z.string().default("").describe("Optional `ADAPTER` (LoRA) path."),
  template: z.string().default("").describe(
    "`TEMPLATE` (usually the Hugging Face chat template). Empty omits it.",
  ),
  system: z.string().default("").describe("`SYSTEM` instructions/persona."),
  license: z.string().default("").describe("Optional `LICENSE` text."),
  parameters: z.record(z.string(), z.union([z.string(), z.number()])).default(
    {},
  )
    .describe(
      "Extra `PARAMETER` values (e.g. {temperature: 0.2}); these win over derived ones.",
    ),
  quant: z.string().default("").describe("Informational quant label."),
  sizeBytes: z.number().int().default(0).describe(
    "GGUF size in bytes (for fit maths).",
  ),
  contextLength: z.number().int().default(0).describe(
    "Model's max context (from Hugging Face `inspect`); 0 defaults to 4096.",
  ),
  vramMiB: z.number().int().default(0).describe(
    "GPU VRAM budget (from gpu-facts).",
  ),
  ramMiB: z.number().int().default(0).describe("RAM budget (from gpu-facts)."),
  numCtx: z.number().int().default(0).describe(
    "Override the derived `num_ctx`.",
  ),
  numGpu: z.number().int().default(-1).describe(
    "Override the derived `num_gpu` (-1 = derive).",
  ),
  outputPath: z.string().default("").describe(
    "Write the Modelfile here too (e.g. `Modelfile` in a build dir). Empty only records it.",
  ),
});

const CreateArgsSchema = z.object({
  model: z.string().describe("Target Ollama model name."),
  modelfile: z.string().default("").describe(
    "Modelfile contents. Empty uses the last `renderModelfile` result.",
  ),
  from: z.string().default("").describe(
    "Import a GGUF directly (sent as `from`) when no Modelfile text is given.",
  ),
});
const RunArgsSchema = z.object({
  model: z.string(),
  prompt: z.string().describe("The prompt."),
  system: z.string().default(""),
  options: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
  keepAlive: z.string().default(""),
});
const ChatArgsSchema = z.object({
  model: z.string(),
  messages: z.array(z.object({
    role: z.string(),
    content: z.string(),
  })),
  options: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
  keepAlive: z.string().default(""),
});
const EmbedArgsSchema = z.object({
  model: z.string(),
  input: z.array(z.string()),
});
const UnloadArgsSchema = z.object({ model: z.string() });
const VerifyArgsSchema = z.object({
  model: z.string(),
  prompt: z.string().default("Reply with the single word: ready."),
  requireVram: z.boolean().default(true).describe(
    "Require the model to be loaded on the GPU (size_vram > 0).",
  ),
});
const PrintArgsSchema = z.object({});

type SetupArgs = z.infer<typeof SetupArgsSchema>;
type SyncArgs = z.infer<typeof SyncArgsSchema>;
type ListArgs = z.infer<typeof ListArgsSchema>;
type ShowArgs = z.infer<typeof ShowArgsSchema>;
type PsArgs = z.infer<typeof PsArgsSchema>;
type PullArgs = z.infer<typeof PullArgsSchema>;
type PushArgs = z.infer<typeof PushArgsSchema>;
type CopyArgs = z.infer<typeof CopyArgsSchema>;
type DeleteArgs = z.infer<typeof DeleteArgsSchema>;
type RenderArgs = z.infer<typeof RenderArgsSchema>;
type CreateArgs = z.infer<typeof CreateArgsSchema>;
type RunArgs = z.infer<typeof RunArgsSchema>;
type ChatArgs = z.infer<typeof ChatArgsSchema>;
type EmbedArgs = z.infer<typeof EmbedArgsSchema>;
type UnloadArgs = z.infer<typeof UnloadArgsSchema>;
type VerifyArgs = z.infer<typeof VerifyArgsSchema>;
type PrintArgs = z.infer<typeof PrintArgsSchema>;

// ---------------------------------------------------------------------------
// Output schemas
// ---------------------------------------------------------------------------

const ConfigSchema = z.object({
  host: z.string(),
  reachable: z.boolean().default(false),
  version: z.string().default(""),
  configuredAt: z.string(),
});

const ServerSchema = z.object({
  host: z.string(),
  version: z.string().default(""),
  reachable: z.boolean().default(false),
  checkedAt: z.string(),
});

const ModelInfoSchema = z.object({
  name: z.string(),
  model: z.string().default(""),
  sizeBytes: z.number().int().default(0),
  digest: z.string().default(""),
  modifiedAt: z.string().default(""),
  parameterSize: z.string().default(""),
  quantization: z.string().default(""),
});

const ModelsSchema = z.object({
  host: z.string(),
  count: z.number().int().default(0),
  models: z.array(ModelInfoSchema).default([]),
  listedAt: z.string(),
});

const RunModelSchema = z.object({
  name: z.string(),
  sizeBytes: z.number().int().default(0),
  sizeVramBytes: z.number().int().default(0),
  expiresAt: z.string().default(""),
});

const RunningSchema = z.object({
  host: z.string(),
  count: z.number().int().default(0),
  running: z.array(RunModelSchema).default([]),
  checkedAt: z.string(),
});

const TransferSchema = z.object({
  op: z.string(),
  model: z.string(),
  target: z.string().default(""),
  status: z.string().default(""),
  detail: z.string().default(""),
  at: z.string(),
});

const ModelfileSchema = z.object({
  modelName: z.string(),
  from: z.string(),
  quant: z.string().default(""),
  text: z.string(),
  parameters: z.array(z.object({
    key: z.string(),
    value: z.string(),
  })).default([]),
  placement: z.string().default(""),
  numCtx: z.number().int().default(0),
  numGpu: z.number().int().default(0),
  outputPath: z.string().default(""),
  renderedAt: z.string(),
});

const CreateSchema = z.object({
  model: z.string(),
  from: z.string().default(""),
  status: z.string().default(""),
  created: z.boolean().default(false),
  at: z.string(),
});

const RunSchema = z.object({
  model: z.string(),
  kind: z.string(),
  prompt: z.string().default(""),
  response: z.string().default(""),
  evalCount: z.number().int().default(0),
  evalDurationNs: z.number().int().default(0),
  tokensPerSecond: z.number().default(0),
  at: z.string(),
});

const VerifySchema = z.object({
  model: z.string(),
  passed: z.boolean(),
  loadedOnGpu: z.boolean().default(false),
  sizeVramBytes: z.number().int().default(0),
  tokensPerSecond: z.number().default(0),
  response: z.string().default(""),
  checks: z.array(z.object({
    name: z.string(),
    passed: z.boolean(),
  })).default([]),
  at: z.string(),
});

const SummarySchema = z.object({
  text: z.string(),
  printedAt: z.string(),
});

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

/** The result of an Ollama API request. */
export interface ApiResult {
  /** HTTP status code. */
  status: number;
  /** Response body as text. */
  text: string;
}

/** Normalise `127.0.0.1:11434` to `http://127.0.0.1:11434`. */
export function normalizeHost(host: string): string {
  const h = host.trim().replace(/\/+$/, "");
  if (!h) return "http://127.0.0.1:11434";
  return /^https?:\/\//i.test(h) ? h : `http://${h}`;
}

/** Send a JSON request to the Ollama API, returning status + text. */
async function apiRequest(
  host: string,
  method: string,
  path: string,
  body: Record<string, unknown> | null,
  timeoutSec: number,
): Promise<ApiResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);
  try {
    const init: RequestInit = { method, signal: controller.signal };
    if (body !== null) {
      init.headers = { "Content-Type": "application/json" };
      init.body = JSON.stringify(body);
    }
    const res = await fetch(`${normalizeHost(host)}${path}`, init);
    return { status: res.status, text: await res.text() };
  } finally {
    clearTimeout(timer);
  }
}

/** Parse JSON, returning `null` on any failure. */
function safeJson(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text);
    return typeof v === "object" && v !== null && !Array.isArray(v)
      ? v as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/** Read a string field, or "". */
function s(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Read a number field, or 0. */
function n(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Build the effective push target from the model and the registry/namespace. */
export function buildPushTarget(
  model: string,
  registry: string,
  namespace: string,
): string {
  if (registry && model.includes("/")) {
    return `${registry}/${model}`;
  }
  if (registry) {
    return `${registry}/${namespace ? namespace + "/" : ""}${model}`;
  }
  if (namespace && !model.includes("/")) return `${namespace}/${model}`;
  return model;
}

/** Whether a path is a readable local file. */
async function isLocalFile(path: string): Promise<boolean> {
  try {
    const st = await Deno.stat(path);
    return st.isFile;
  } catch {
    return false;
  }
}

/** The Ollama blob digest (`sha256:<hex>`) for a local file, or "" if unavailable. */
async function fileDigest(path: string): Promise<string> {
  try {
    const out = await new Deno.Command("sha256sum", {
      args: [path],
      stdout: "piped",
      stderr: "null",
    }).output();
    if (out.code !== 0) return "";
    const hex = new TextDecoder().decode(out.stdout).trim().split(/\s+/)[0];
    return hex ? `sha256:${hex.toLowerCase()}` : "";
  } catch {
    return "";
  }
}

/** Upload a local GGUF as an Ollama blob unless the server already has it. */
async function ensureBlob(
  host: string,
  path: string,
  digest: string,
  _timeoutSec: number,
): Promise<void> {
  const base = normalizeHost(host);
  const head = await fetch(`${base}/api/blobs/${digest}`, { method: "HEAD" });
  if (head.ok) return;
  const file = await Deno.open(path, { read: true });
  try {
    const res = await fetch(`${base}/api/blobs/${digest}`, {
      method: "POST",
      body: file.readable,
      // Deno requires duplex for a streaming request body.
      duplex: "half",
    } as RequestInit);
    if (!res.ok) {
      throw new Error(
        `blob upload failed: HTTP ${res.status}: ${
          (await res.text()).slice(0, 200)
        }`,
      );
    }
  } finally {
    file.close();
  }
}

// ---------------------------------------------------------------------------
// Model definition
// ---------------------------------------------------------------------------

interface MethodContext {
  globalArgs: GlobalArgs;
  logger?: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warn: (msg: string, props?: Record<string, unknown>) => void;
  };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
  readResource?: (
    instanceName: string,
    version?: number,
  ) => Promise<Record<string, unknown> | null>;
}

/** Read this model's own newest record of one resource (by instance name). */
async function latestRecord(
  ctx: MethodContext,
  instanceName: string,
): Promise<Record<string, unknown> | null> {
  if (!ctx.readResource) return null;
  try {
    return await ctx.readResource(instanceName);
  } catch {
    return null;
  }
}

/** Fetch the server version, or "" when unreachable. */
async function serverVersion(
  g: GlobalArgs,
): Promise<{ reachable: boolean; version: string }> {
  try {
    const res = await apiRequest(
      g.host,
      "GET",
      "/api/version",
      null,
      g.timeoutSec,
    );
    if (res.status !== 200) return { reachable: false, version: "" };
    return { reachable: true, version: s(safeJson(res.text)?.["version"]) };
  } catch {
    return { reachable: false, version: "" };
  }
}

/** A model that drives the Ollama HTTP API. */
export const model = {
  type: OLLAMA_MODELS_TYPE,
  version: "2026.10.16.9",
  globalArguments: GlobalArgsSchema,

  upgrades: [
    {
      toVersion: "2026.10.16.9",
      description:
        "Initial release: the full Ollama model surface over HTTP — sync/list/" +
        "show/ps, pull/push/copy/delete, a VRAM-aware `renderModelfile`, " +
        "`create` from a Modelfile or GGUF, run/chat/embed/unload, and `verify` " +
        "which runs the model and asserts it loaded on the GPU. Talks to " +
        "OLLAMA_HOST so it can build models on any host in the fleet. Ships the " +
        "`@svendowideit/ollama-model-factory` workflow that chains gpu-facts, " +
        "huggingface and these methods end to end.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],

  resources: {
    config: {
      description: "Persisted Ollama server config.",
      schema: ConfigSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    server: {
      description: "The Ollama server version and reachability.",
      schema: ServerSchema,
      lifetime: "7d" as const,
      garbageCollection: 10,
    },
    models: {
      description: "The local models.",
      schema: ModelsSchema,
      lifetime: "7d" as const,
      garbageCollection: 10,
    },
    model: {
      description: "One model's details.",
      schema: ModelInfoSchema,
      lifetime: "7d" as const,
      garbageCollection: 10,
    },
    running: {
      description: "Models currently loaded (with VRAM use).",
      schema: RunningSchema,
      lifetime: "7d" as const,
      garbageCollection: 10,
    },
    transfer: {
      description: "A pull/push/copy/delete outcome.",
      schema: TransferSchema,
      lifetime: "7d" as const,
      garbageCollection: 10,
    },
    modelfile: {
      description: "A rendered, host-customised Modelfile.",
      schema: ModelfileSchema,
      lifetime: "7d" as const,
      garbageCollection: 10,
    },
    create: {
      description: "The result of creating a model.",
      schema: CreateSchema,
      lifetime: "7d" as const,
      garbageCollection: 10,
    },
    run: {
      description: "An inference result.",
      schema: RunSchema,
      lifetime: "7d" as const,
      garbageCollection: 10,
    },
    verify: {
      description: "Whether a model runs and loads on the GPU.",
      schema: VerifySchema,
      lifetime: "7d" as const,
      garbageCollection: 10,
    },
    summary: {
      description: "A printed summary.",
      schema: SummarySchema,
      lifetime: "7d" as const,
      garbageCollection: 5,
    },
  },

  methods: {
    setup: {
      description:
        "Resolve and persist the Ollama server config: read any existing config " +
        "back first, probe `/api/version`, and write the `config` resource.",
      arguments: SetupArgsSchema,
      execute: async (
        _args: SetupArgs,
        ctx: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = ctx.globalArgs;
        const prior = await latestRecord(ctx, "config");
        const host = normalizeHost(g.host || s(prior?.["host"]));
        const { reachable, version } = await serverVersion({ ...g, host });
        const handle = await ctx.writeResource("config", "config", {
          host,
          reachable,
          version,
          configuredAt: new Date().toISOString(),
        });
        ctx.logger?.info("ollama-models setup: {host} reachable={r} {v}", {
          host,
          r: reachable,
          v: version,
        });
        return { dataHandles: [handle] };
      },
    },

    sync: {
      description: "Read the server version and the local models.",
      arguments: SyncArgsSchema,
      execute: async (
        _args: SyncArgs,
        ctx: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }, { name: string }] }> => {
        const g = ctx.globalArgs;
        const { reachable, version } = await serverVersion(g);
        const server = await ctx.writeResource("server", "server", {
          host: normalizeHost(g.host),
          version,
          reachable,
          checkedAt: new Date().toISOString(),
        });
        const tags = await apiRequest(
          g.host,
          "GET",
          "/api/tags",
          null,
          g.timeoutSec,
        );
        const list = safeJson(tags.text)?.["models"];
        const models = Array.isArray(list)
          ? list.map((m) => {
            const o = (m ?? {}) as Record<string, unknown>;
            const details = (o["details"] ?? {}) as Record<string, unknown>;
            return {
              name: s(o["name"]),
              model: s(o["model"] ?? o["name"]),
              sizeBytes: n(o["size"]),
              digest: s(o["digest"]),
              modifiedAt: s(o["modified_at"]),
              parameterSize: s(details["parameter_size"]),
              quantization: s(details["quantization_level"]),
            };
          })
          : [];
        const modelsHandle = await ctx.writeResource("models", "models", {
          host: normalizeHost(g.host),
          count: models.length,
          models,
          listedAt: new Date().toISOString(),
        });
        ctx.logger?.info("ollama-models sync: {v}, {n} model(s)", {
          v: version || "unreachable",
          n: models.length,
        });
        return { dataHandles: [server, modelsHandle] };
      },
    },

    list: {
      description: "List the local models.",
      arguments: ListArgsSchema,
      execute: async (
        _args: ListArgs,
        ctx: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = ctx.globalArgs;
        const tags = await apiRequest(
          g.host,
          "GET",
          "/api/tags",
          null,
          g.timeoutSec,
        );
        const list = safeJson(tags.text)?.["models"];
        const models = Array.isArray(list)
          ? list.map((m) => {
            const o = (m ?? {}) as Record<string, unknown>;
            const details = (o["details"] ?? {}) as Record<string, unknown>;
            return {
              name: s(o["name"]),
              model: s(o["model"] ?? o["name"]),
              sizeBytes: n(o["size"]),
              digest: s(o["digest"]),
              modifiedAt: s(o["modified_at"]),
              parameterSize: s(details["parameter_size"]),
              quantization: s(details["quantization_level"]),
            };
          })
          : [];
        const handle = await ctx.writeResource("models", "models", {
          host: normalizeHost(g.host),
          count: models.length,
          models,
          listedAt: new Date().toISOString(),
        });
        ctx.logger?.info("ollama-models list: {n} model(s)", {
          n: models.length,
        });
        return { dataHandles: [handle] };
      },
    },

    show: {
      description: "Show one model's details (parameters, template, size).",
      arguments: ShowArgsSchema,
      execute: async (
        args: ShowArgs,
        ctx: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = ctx.globalArgs;
        const res = await apiRequest(g.host, "POST", "/api/show", {
          model: args.model,
        }, g.timeoutSec);
        if (res.status !== 200) {
          throw new Error(
            `ollama show failed: HTTP ${res.status} for ${args.model}`,
          );
        }
        const o = safeJson(res.text) ?? {};
        const details = (o["details"] ?? {}) as Record<string, unknown>;
        const handle = await ctx.writeResource("model", "model", {
          name: args.model,
          model: s(o["model"] ?? args.model),
          sizeBytes: n(o["size"]),
          digest: s(o["digest"]),
          modifiedAt: s(o["modified_at"]),
          parameterSize: s(details["parameter_size"]),
          quantization: s(details["quantization_level"]),
        });
        ctx.logger?.info("ollama-models show: {model}", { model: args.model });
        return { dataHandles: [handle] };
      },
    },

    ps: {
      description: "List the models currently loaded (with their VRAM use).",
      arguments: PsArgsSchema,
      execute: async (
        _args: PsArgs,
        ctx: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = ctx.globalArgs;
        const res = await apiRequest(
          g.host,
          "GET",
          "/api/ps",
          null,
          g.timeoutSec,
        );
        const list = safeJson(res.text)?.["models"];
        const running = Array.isArray(list)
          ? list.map((m) => {
            const o = (m ?? {}) as Record<string, unknown>;
            return {
              name: s(o["name"]),
              sizeBytes: n(o["size"]),
              sizeVramBytes: n(o["size_vram"]),
              expiresAt: s(o["expires_at"]),
            };
          })
          : [];
        const handle = await ctx.writeResource("running", "running", {
          host: normalizeHost(g.host),
          count: running.length,
          running,
          checkedAt: new Date().toISOString(),
        });
        ctx.logger?.info("ollama-models ps: {n} loaded", { n: running.length });
        return { dataHandles: [handle] };
      },
    },

    pull: {
      description: "Pull a model from a registry.",
      arguments: PullArgsSchema,
      execute: async (
        args: PullArgs,
        ctx: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = ctx.globalArgs;
        const res = await apiRequest(g.host, "POST", "/api/pull", {
          model: args.model,
          stream: false,
          insecure: args.insecure,
        }, g.timeoutSec);
        const handle = await ctx.writeResource("transfer", "transfer", {
          op: "pull",
          model: args.model,
          target: "",
          status: res.status === 200 ? "ok" : `HTTP ${res.status}`,
          detail: s(safeJson(res.text)?.["status"]),
          at: new Date().toISOString(),
        });
        ctx.logger?.info("ollama-models pull: {model} -> {status}", {
          model: args.model,
          status: res.status === 200 ? "ok" : res.status,
        });
        return { dataHandles: [handle] };
      },
    },

    push: {
      description:
        "Push a local model to a registry (namespace/registry configurable).",
      arguments: PushArgsSchema,
      execute: async (
        args: PushArgs,
        ctx: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = ctx.globalArgs;
        const target = args.target ||
          buildPushTarget(args.model, g.registry, g.namespace);
        const res = await apiRequest(g.host, "POST", "/api/push", {
          model: target,
          stream: false,
          insecure: args.insecure,
        }, g.timeoutSec);
        const handle = await ctx.writeResource("transfer", "transfer", {
          op: "push",
          model: args.model,
          target,
          status: res.status === 200 ? "ok" : `HTTP ${res.status}`,
          detail: s(safeJson(res.text)?.["status"]),
          at: new Date().toISOString(),
        });
        ctx.logger?.info("ollama-models push: {target} -> {status}", {
          target,
          status: res.status === 200 ? "ok" : res.status,
        });
        return { dataHandles: [handle] };
      },
    },

    copy: {
      description: "Copy a model to a new name.",
      arguments: CopyArgsSchema,
      execute: async (
        args: CopyArgs,
        ctx: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = ctx.globalArgs;
        const res = await apiRequest(g.host, "POST", "/api/copy", {
          source: args.source,
          destination: args.destination,
        }, g.timeoutSec);
        const handle = await ctx.writeResource("transfer", "transfer", {
          op: "copy",
          model: args.source,
          target: args.destination,
          status: res.status === 200 ? "ok" : `HTTP ${res.status}`,
          detail: "",
          at: new Date().toISOString(),
        });
        ctx.logger?.info("ollama-models copy: {src} -> {dst}", {
          src: args.source,
          dst: args.destination,
        });
        return { dataHandles: [handle] };
      },
    },

    delete: {
      description: "Delete a local model.",
      arguments: DeleteArgsSchema,
      execute: async (
        args: DeleteArgs,
        ctx: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = ctx.globalArgs;
        const res = await apiRequest(g.host, "DELETE", "/api/delete", {
          model: args.model,
        }, g.timeoutSec);
        const handle = await ctx.writeResource("transfer", "transfer", {
          op: "delete",
          model: args.model,
          target: "",
          status: res.status === 200 ? "ok" : `HTTP ${res.status}`,
          detail: "",
          at: new Date().toISOString(),
        });
        ctx.logger?.info("ollama-models delete: {model} -> {status}", {
          model: args.model,
          status: res.status === 200 ? "ok" : res.status,
        });
        return { dataHandles: [handle] };
      },
    },

    renderModelfile: {
      description:
        "Render a Modelfile customised to this host: derive `num_ctx`/`num_gpu` " +
        "from the GGUF size and the VRAM/RAM budget, attach the chat template " +
        "and your instructions, and record (and optionally write) the text.",
      arguments: RenderArgsSchema,
      execute: async (
        args: RenderArgs,
        ctx: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const fit: FitResult = deriveFitParameters(
          args.sizeBytes,
          args.contextLength,
          { vramMiB: args.vramMiB, ramMiB: args.ramMiB },
        );
        const numCtx = args.numCtx > 0 ? args.numCtx : fit.numCtx;
        const numGpu = args.numGpu >= 0 ? args.numGpu : fit.numGpu;
        // Only true Modelfile PARAMETERs here. `keep_alive` is a runtime option,
        // not a Modelfile parameter — Ollama rejects it ("unknown parameter").
        const derived: Parameter[] = [
          { key: "num_ctx", value: String(numCtx) },
          { key: "num_gpu", value: String(numGpu) },
        ];
        const user: Parameter[] = Object.entries(args.parameters).map(
          ([key, value]) => ({ key, value: String(value) }),
        );
        const parameters = mergeParameters(derived, user);
        const text = renderModelfile({
          from: args.from,
          adapter: args.adapter || undefined,
          template: args.template || undefined,
          system: args.system || undefined,
          license: args.license || undefined,
          parameters,
        });
        if (args.outputPath) {
          await Deno.writeTextFile(args.outputPath, text);
        }
        const handle = await ctx.writeResource("modelfile", "modelfile", {
          modelName: args.modelName,
          from: args.from,
          quant: args.quant,
          text,
          parameters,
          placement: fit.placement,
          numCtx,
          numGpu,
          outputPath: args.outputPath,
          renderedAt: new Date().toISOString(),
        });
        ctx.logger?.info(
          "ollama-models renderModelfile: {name} ({placement}, num_ctx={ctx}, num_gpu={gpu})",
          {
            name: args.modelName,
            placement: fit.placement,
            ctx: numCtx,
            gpu: numGpu,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    create: {
      description:
        "Create an Ollama model from a Modelfile (contents or the last " +
        "`renderModelfile` result) or directly from a GGUF path.",
      arguments: CreateArgsSchema,
      execute: async (
        args: CreateArgs,
        ctx: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = ctx.globalArgs;
        let modelfile = args.modelfile.trim();
        let from = args.from.trim();
        if (!modelfile && !from) {
          const prior = await latestRecord(ctx, "modelfile");
          modelfile = s(prior?.["text"]);
          from = s(prior?.["from"]);
        }
        // Ollama's /api/create wants structured fields, not the raw Modelfile
        // text. A GGUF is imported by uploading it as a blob and passing
        // `files` — the server does not read the client's filesystem, so a
        // bare `from: /path` is reported as "invalid model name".
        const body: Record<string, unknown> = {
          model: args.model,
          stream: false,
        };
        if (modelfile) {
          const parsed = parseModelfile(modelfile);
          if (parsed.template) body["template"] = parsed.template;
          if (parsed.system) body["system"] = parsed.system;
          // Ollama rejects string values for numeric options
          // ("num_ctx must be of type integer"): coerce numerics.
          const params: Record<string, unknown> = {};
          for (const p of parsed.parameters) {
            params[p.key] = /^-?\d+$/.test(p.value)
              ? Number.parseInt(p.value, 10)
              : /^-?\d*\.\d+$/.test(p.value)
              ? Number.parseFloat(p.value)
              : p.value;
          }
          if (Object.keys(params).length > 0) body["parameters"] = params;
          if (!from) from = parsed.from;
        }
        if (from && /\.gguf$/i.test(from) && await isLocalFile(from)) {
          const digest = await fileDigest(from);
          if (digest) {
            await ensureBlob(g.host, from, digest, g.timeoutSec);
            const name = from.split("/").pop() ?? "model.gguf";
            body["files"] = { [name]: digest };
          } else {
            body["from"] = from;
          }
        } else if (from) {
          body["from"] = from;
        }
        if (!body["from"] && !body["files"]) {
          throw new Error(
            "create needs a Modelfile with a FROM line (via renderModelfile) or a GGUF `from` path",
          );
        }
        const res = await apiRequest(
          g.host,
          "POST",
          "/api/create",
          body,
          g.timeoutSec,
        );
        const handle = await ctx.writeResource("create", "create", {
          model: args.model,
          from: from || modelfile.split("\n")[0]?.replace(/^FROM\s+/, "") || "",
          status: res.status === 200 ? "ok" : `HTTP ${res.status}`,
          created: res.status === 200,
          at: new Date().toISOString(),
        });
        if (res.status !== 200) {
          throw new Error(
            `ollama create failed: HTTP ${res.status}: ${
              res.text.slice(0, 300)
            }`,
          );
        }
        ctx.logger?.info("ollama-models create: {model} created", {
          model: args.model,
        });
        return { dataHandles: [handle] };
      },
    },

    run: {
      description: "Run a single prompt against a model.",
      arguments: RunArgsSchema,
      execute: async (
        args: RunArgs,
        ctx: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = ctx.globalArgs;
        const body: Record<string, unknown> = {
          model: args.model,
          prompt: args.prompt,
          stream: false,
          options: args.options,
        };
        if (args.system) body["system"] = args.system;
        body["keep_alive"] = args.keepAlive || g.keepAlive;
        const res = await apiRequest(
          g.host,
          "POST",
          "/api/generate",
          body,
          g.timeoutSec,
        );
        const o = safeJson(res.text) ?? {};
        const handle = await ctx.writeResource("run", "run", {
          model: args.model,
          kind: "generate",
          prompt: args.prompt,
          response: s(o["response"]),
          evalCount: n(o["eval_count"]),
          evalDurationNs: n(o["eval_duration"]),
          tokensPerSecond: tokensPerSecond(
            n(o["eval_count"]),
            n(o["eval_duration"]),
          ),
          at: new Date().toISOString(),
        });
        ctx.logger?.info("ollama-models run: {model}", { model: args.model });
        return { dataHandles: [handle] };
      },
    },

    chat: {
      description: "Run a chat completion against a model.",
      arguments: ChatArgsSchema,
      execute: async (
        args: ChatArgs,
        ctx: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = ctx.globalArgs;
        const res = await apiRequest(g.host, "POST", "/api/chat", {
          model: args.model,
          messages: args.messages,
          stream: false,
          options: args.options,
          keep_alive: args.keepAlive || g.keepAlive,
        }, g.timeoutSec);
        const o = safeJson(res.text) ?? {};
        const message = (o["message"] ?? {}) as Record<string, unknown>;
        const handle = await ctx.writeResource("run", "run", {
          model: args.model,
          kind: "chat",
          prompt: args.messages.map((m) => m.content).join("\n"),
          response: s(message["content"]),
          evalCount: n(o["eval_count"]),
          evalDurationNs: n(o["eval_duration"]),
          tokensPerSecond: tokensPerSecond(
            n(o["eval_count"]),
            n(o["eval_duration"]),
          ),
          at: new Date().toISOString(),
        });
        ctx.logger?.info("ollama-models chat: {model}", { model: args.model });
        return { dataHandles: [handle] };
      },
    },

    embed: {
      description: "Compute embeddings for one or more inputs.",
      arguments: EmbedArgsSchema,
      execute: async (
        args: EmbedArgs,
        ctx: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = ctx.globalArgs;
        const res = await apiRequest(g.host, "POST", "/api/embed", {
          model: args.model,
          input: args.input,
        }, g.timeoutSec);
        const o = safeJson(res.text) ?? {};
        const embeddings = o["embeddings"];
        const count = Array.isArray(embeddings) ? embeddings.length : 0;
        const handle = await ctx.writeResource("run", "run", {
          model: args.model,
          kind: "embed",
          prompt: `${args.input.length} input(s)`,
          response: `${count} embedding(s)`,
          evalCount: 0,
          evalDurationNs: n(o["total_duration"]),
          tokensPerSecond: 0,
          at: new Date().toISOString(),
        });
        ctx.logger?.info("ollama-models embed: {model} {n} embedding(s)", {
          model: args.model,
          n: count,
        });
        return { dataHandles: [handle] };
      },
    },

    unload: {
      description: "Unload a model from memory (keep_alive: 0).",
      arguments: UnloadArgsSchema,
      execute: async (
        args: UnloadArgs,
        ctx: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = ctx.globalArgs;
        const res = await apiRequest(g.host, "POST", "/api/generate", {
          model: args.model,
          keep_alive: 0,
        }, g.timeoutSec);
        const handle = await ctx.writeResource("transfer", "transfer", {
          op: "unload",
          model: args.model,
          target: "",
          status: res.status === 200 ? "ok" : `HTTP ${res.status}`,
          detail: "",
          at: new Date().toISOString(),
        });
        ctx.logger?.info("ollama-models unload: {model}", {
          model: args.model,
        });
        return { dataHandles: [handle] };
      },
    },

    verify: {
      description:
        "Run a smoke prompt, then check `/api/ps`: assert the model loaded on " +
        "the GPU (`size_vram > 0`), answered, and record tokens/second.",
      arguments: VerifyArgsSchema,
      execute: async (
        args: VerifyArgs,
        ctx: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = ctx.globalArgs;
        const gen = await apiRequest(g.host, "POST", "/api/generate", {
          model: args.model,
          prompt: args.prompt,
          stream: false,
          keep_alive: g.keepAlive,
        }, g.timeoutSec);
        const genO = safeJson(gen.text) ?? {};
        const response = s(genO["response"]);
        const tps = tokensPerSecond(
          n(genO["eval_count"]),
          n(genO["eval_duration"]),
        );
        const ps = await apiRequest(
          g.host,
          "GET",
          "/api/ps",
          null,
          g.timeoutSec,
        );
        const list = safeJson(ps.text)?.["models"];
        const running = Array.isArray(list) ? list : [];
        const found = running
          .map((m) => (m ?? {}) as Record<string, unknown>)
          .find((m) =>
            s(m["name"]).split(":")[0] === args.model.split(":")[0]
          ) ??
          running[0] as Record<string, unknown> | undefined;
        const sizeVram = found ? n(found["size_vram"]) : 0;
        const loadedOnGpu = sizeVram > 0;
        const answered = response.trim().length > 0;
        const vramOk = !args.requireVram || loadedOnGpu;
        const passed = gen.status === 200 && answered && vramOk;
        const checks = [
          { name: "generate HTTP 200", passed: gen.status === 200 },
          { name: "non-empty response", passed: answered },
          { name: "loaded on GPU (size_vram > 0)", passed: loadedOnGpu },
        ];
        const handle = await ctx.writeResource("verify", "verify", {
          model: args.model,
          passed,
          loadedOnGpu,
          sizeVramBytes: sizeVram,
          tokensPerSecond: tps,
          response,
          checks,
          at: new Date().toISOString(),
        });
        if (!passed) {
          throw new Error(
            `ollama verify failed for ${args.model}: ` +
              checks.map((c) => `${c.name}=${c.passed}`).join(", "),
          );
        }
        ctx.logger?.info(
          "ollama-models verify: {model} passed ({tps} tok/s, vram={vram} B)",
          { model: args.model, tps, vram: sizeVram },
        );
        return { dataHandles: [handle] };
      },
    },

    print: {
      description: "Log the last modelfile/create/verify summary.",
      arguments: PrintArgsSchema,
      execute: async (
        _args: PrintArgs,
        ctx: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const mf = await latestRecord(ctx, "modelfile");
        const cr = await latestRecord(ctx, "create");
        const vf = await latestRecord(ctx, "verify");
        const lines: string[] = [];
        if (mf) {
          lines.push(
            `modelfile: ${mf["modelName"]} (${mf["placement"]}) for ${
              mf["from"]
            }`,
          );
        }
        if (cr) lines.push(`create: ${cr["model"]} -> ${cr["status"]}`);
        if (vf) {
          lines.push(
            `verify: ${vf["model"]} passed=${vf["passed"]} vram=${
              vf["sizeVramBytes"]
            } B ${vf["tokensPerSecond"]} tok/s`,
          );
        }
        const text = lines.join("\n") || "nothing recorded yet";
        const handle = await ctx.writeResource("summary", "summary", {
          text,
          printedAt: new Date().toISOString(),
        });
        ctx.logger?.info("ollama-models summary:\n{text}", { text });
        return { dataHandles: [handle] };
      },
    },
  },
};
