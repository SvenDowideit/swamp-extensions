/**
 * @svendowideit/huggingface
 *
 * Ask Hugging Face for models that meet a requirement, then download the one
 * you choose. It turns "what models will help me do <something>?" into a ranked,
 * hardware-aware shortlist, asks you which to build when the choice is genuinely
 * ambiguous, and fetches the exact GGUF quant (with its revision and checksum)
 * that an Ollama Modelfile can `FROM`.
 *
 * The recommendation is scored against a real hardware budget (`vramMiB` /
 * `ramMiB`, typically read from `@svendowideit/gpu-facts`), so the same ask
 * yields different answers on a 4090 box, a Jetson or a Mac.
 *
 * Methods:
 *   - `auth`        resolve the HF token (vault/env) and report the identity
 *   - `search`      search the Hub by ask + structured filters
 *   - `inspect`     one repo: file tree, GGUF quants, context length, chat template
 *   - `recommend`   search + inspect + score against a budget, ranked
 *   - `clarify`     ask the user to choose when ambiguous, or resolve an answer
 *   - `download`    fetch the chosen files at a pinned revision
 *   - `print`       log a summary of the last recommendation/download
 *
 * @module
 */

import { z } from "npm:zod@4";
import {
  buildModelInfoUrl,
  buildRecommendation,
  buildResolveUrl,
  buildSearchUrl,
  buildTreeUrl,
  type CandidateInput,
  type ClarOption,
  type HfFile,
  type HfModelSummary,
  parseChatTemplate,
  parseContextLength,
  parseHfModelList,
  parseHfTree,
  renderDownloadScript,
  type ScriptFile,
  searchTerms,
  selectGgufFiles,
} from "./huggingface_shared.ts";

/** The model type name. */
export const HF_TYPE = "@svendowideit/huggingface";

// ---------------------------------------------------------------------------
// Global arguments
// ---------------------------------------------------------------------------

const GlobalArgsSchema = z.object({
  name: z.string().default("").describe(
    "Model instance name (supplied by swamp).",
  ),
  endpoint: z.string().default("https://huggingface.co").describe(
    "Hugging Face Hub base URL.",
  ),
  token: z.string().default("").meta({ sensitive: true }).describe(
    "Hugging Face access token for gated/private repos. Stored in the vault; " +
      "prefer the HF_TOKEN environment variable instead of passing it inline.",
  ),
  // swamp-quality-ignore credentials-sensitive-field
  tokenEnvVar: z.string().default("HF_TOKEN").describe(
    "Environment variable the token is read from when `token` is empty.",
  ),
  library: z.string().default("gguf").describe(
    "Default library filter for `search` (`gguf` for Ollama-usable models). " +
      'Pass "" to search every library.',
  ),
  timeoutSec: z.number().int().default(30).describe(
    "Per-request HTTP timeout in seconds.",
  ),
  cacheDir: z.string().default("~/.cache/huggingface").describe(
    "Default download directory (expanded for `~`).",
  ),
}).strict();

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

// ---------------------------------------------------------------------------
// Method arguments
// ---------------------------------------------------------------------------

const AuthArgsSchema = z.object({});

const SearchArgsSchema = z.object({
  ask: z.string().default("").describe(
    "Natural-language requirement, e.g. `a local coding assistant`.",
  ),
  limit: z.number().int().default(20).describe("Maximum results."),
  library: z.string().default("").describe(
    "Override the global library filter (`gguf`). Empty uses the global.",
  ),
  pipelineTag: z.string().default("").describe(
    "Override the inferred pipeline tag. Empty infers it from `ask`.",
  ),
});

const InspectArgsSchema = z.object({
  repo: z.string().describe(
    "Repo id, e.g. `Qwen/Qwen2.5-Coder-7B-Instruct-GGUF`.",
  ),
  revision: z.string().default("main").describe("Revision/branch/tag."),
});

const RecommendArgsSchema = z.object({
  ask: z.string().describe("Natural-language requirement."),
  vramMiB: z.number().int().default(0).describe(
    "GPU VRAM budget in MiB (0 = unknown). Read it from @svendowideit/gpu-facts.",
  ),
  ramMiB: z.number().int().default(0).describe(
    "System RAM budget in MiB (0 = unknown).",
  ),
  candidates: z.number().int().default(4).describe(
    "How many top search hits to inspect for size.",
  ),
  quant: z.string().default("").describe(
    "Prefer this quant (e.g. `Q4_K_M`). Empty picks the largest GGUF per repo.",
  ),
});

const ClarifyArgsSchema = z.object({
  answer: z.string().default("").describe(
    "The chosen option value (`repo#quant`). Empty emits the question.",
  ),
});

const DownloadArgsSchema = z.object({
  repo: z.string().describe("Repo id."),
  revision: z.string().default("main").describe("Revision to pin."),
  quant: z.string().default("").describe("Quant to fetch (e.g. `Q4_K_M`)."),
  files: z.array(z.string()).default([]).describe(
    "Explicit file paths to fetch. Empty resolves from `quant`, else the largest GGUF.",
  ),
  dest: z.string().default("").describe(
    "Destination directory. Empty uses the global `cacheDir`.",
  ),
  verify: z.boolean().default(true).describe(
    "Verify each file's SHA-256 against the Hub's LFS oid when `sha256sum` is available.",
  ),
  detached: z.boolean().default(false).describe(
    "Start the transfer as a host-managed background process (systemd-run/setsid) " +
      "that outlives this run, and return immediately; use `downloadStatus` to " +
      "await/verify it. Recommended for very large files.",
  ),
});

const DownloadStatusArgsSchema = z.object({
  wait: z.boolean().default(false).describe(
    "Poll until the detached transfer finishes (or `maxWaitSec` elapses).",
  ),
  maxWaitSec: z.number().int().default(1800).describe(
    "Maximum seconds to wait when `wait` is set.",
  ),
  verify: z.boolean().default(true).describe(
    "Verify each file's SHA-256 against the Hub's LFS oid when available.",
  ),
});

const PrintArgsSchema = z.object({});
const SetupArgsSchema = z.object({});

type AuthArgs = z.infer<typeof AuthArgsSchema>;
type SearchArgs = z.infer<typeof SearchArgsSchema>;
type InspectArgs = z.infer<typeof InspectArgsSchema>;
type RecommendArgs = z.infer<typeof RecommendArgsSchema>;
type ClarifyArgs = z.infer<typeof ClarifyArgsSchema>;
type DownloadArgs = z.infer<typeof DownloadArgsSchema>;
type DownloadStatusArgs = z.infer<typeof DownloadStatusArgsSchema>;
type PrintArgs = z.infer<typeof PrintArgsSchema>;
type SetupArgs = z.infer<typeof SetupArgsSchema>;

// ---------------------------------------------------------------------------
// Output schemas
// ---------------------------------------------------------------------------

const ModelSummarySchema = z.object({
  id: z.string(),
  author: z.string().default(""),
  downloads: z.number().int().default(0),
  likes: z.number().int().default(0),
  tags: z.array(z.string()).default([]),
  pipelineTag: z.string().default(""),
  library: z.string().default(""),
  gated: z.boolean().default(false),
  private: z.boolean().default(false),
  lastModified: z.string().default(""),
});

const HfFileSchema = z.object({
  path: z.string(),
  sizeBytes: z.number().int().default(0),
  oid: z.string().default(""),
  quant: z.string().default(""),
  isGguf: z.boolean().default(false),
});

const AuthSchema = z.object({
  authenticated: z.boolean(),
  user: z.string().default(""),
  endpoint: z.string(),
  tokenSource: z.string().default(""),
  checkedAt: z.string(),
});

const SearchSchema = z.object({
  ask: z.string().default(""),
  url: z.string().default(""),
  count: z.number().int().default(0),
  results: z.array(ModelSummarySchema).default([]),
  searchedAt: z.string(),
});

const ModelSchema = z.object({
  repo: z.string(),
  revision: z.string().default("main"),
  pipelineTag: z.string().default(""),
  library: z.string().default(""),
  contextLength: z.number().int().default(0),
  chatTemplate: z.string().default(""),
  files: z.array(HfFileSchema).default([]),
  gguf: z.array(HfFileSchema).default([]),
  inspectedAt: z.string(),
});

const CandidateSchema = z.object({
  repo: z.string(),
  quant: z.string().default(""),
  file: z.string().default(""),
  sizeBytes: z.number().int().default(0),
  sizeMiB: z.number().int().default(0),
  verdict: z.string(),
  headroomMiB: z.number().int().default(0),
  notes: z.string().default(""),
});

const ClarOptionSchema = z.object({
  value: z.string(),
  label: z.string(),
  tradeoff: z.string().default(""),
});

const RecommendationSchema = z.object({
  ask: z.string(),
  budget: z.object({
    vramMiB: z.number().int().default(0),
    ramMiB: z.number().int().default(0),
  }),
  candidates: z.array(CandidateSchema).default([]),
  ambiguous: z.boolean().default(false),
  question: z.string().default(""),
  options: z.array(ClarOptionSchema).default([]),
  recommendedAt: z.string(),
});

const ClarificationSchema = z.object({
  question: z.string(),
  options: z.array(ClarOptionSchema).default([]),
  resolved: z.boolean().default(false),
  answer: z.string().default(""),
  askedAt: z.string(),
});

const SelectionSchema = z.object({
  repo: z.string(),
  quant: z.string().default(""),
  file: z.string().default(""),
  source: z.string().default("answer"),
  selectedAt: z.string(),
});

const DownloadFileSchema = z.object({
  path: z.string(),
  localPath: z.string(),
  sizeBytes: z.number().int().default(0),
  expectedOid: z.string().default(""),
  verified: z.boolean().default(false),
  resumed: z.boolean().default(false),
});

const TransferFileSchema = z.object({
  path: z.string(),
  localPath: z.string(),
  expectedBytes: z.number().int().default(0),
  expectedOid: z.string().default(""),
});

const TransferSchema = z.object({
  repo: z.string(),
  revision: z.string().default("main"),
  dest: z.string(),
  files: z.array(TransferFileSchema).default([]),
  scriptPath: z.string().default(""),
  markerPath: z.string().default(""),
  failPath: z.string().default(""),
  unit: z.string().default(""),
  how: z.string().default(""),
  status: z.string().default("running"),
  startedAt: z.string(),
});

const DownloadSchema = z.object({
  repo: z.string(),
  revision: z.string().default("main"),
  dest: z.string(),
  files: z.array(DownloadFileSchema).default([]),
  totalBytes: z.number().int().default(0),
  downloadedAt: z.string(),
});

const SummarySchema = z.object({
  text: z.string(),
  printedAt: z.string(),
});

const ConfigSchema = z.object({
  endpoint: z.string(),
  library: z.string().default("gguf"),
  // swamp-quality-ignore credentials-sensitive-field
  tokenEnvVar: z.string().default("HF_TOKEN"),
  timeoutSec: z.number().int().default(30),
  cacheDir: z.string().default("~/.cache/huggingface"),
  tokenConfigured: z.boolean().default(false),
  tokenSource: z.string().default("anonymous"),
  configuredAt: z.string(),
});

// ---------------------------------------------------------------------------
// HTTP + helpers
// ---------------------------------------------------------------------------

/** The result of a Hub HTTP request. */
export interface HttpText {
  /** HTTP status code. */
  status: number;
  /** Response body as text. */
  text: string;
}

/** Resolve the token from the global (`vault`) value or the environment. */
export function resolveToken(
  g: { token: string; tokenEnvVar: string },
): { token: string; source: string } {
  if (g.token.trim()) return { token: g.token.trim(), source: "global" };
  const env = Deno.env.get(g.tokenEnvVar);
  if (env && env.trim()) {
    return { token: env.trim(), source: `env:${g.tokenEnvVar}` };
  }
  return { token: "", source: "anonymous" };
}

/** Expand a leading `~` to the user's home directory. */
export function expandHome(path: string): string {
  if (path === "~" || path.startsWith("~/")) {
    const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? "";
    return home ? `${home}${path.slice(1)}` : path;
  }
  return path;
}

/** GET a Hub URL, returning status + text (never throwing on HTTP status). */
async function getText(
  url: string,
  token: string,
  timeoutSec: number,
): Promise<HttpText> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const res = await fetch(url, { headers, signal: controller.signal });
    return { status: res.status, text: await res.text() };
  } finally {
    clearTimeout(timer);
  }
}

/** Parse `repo#quant` (or a bare repo) into its parts. */
export function parseSelection(value: string): { repo: string; quant: string } {
  const [repo, quant] = value.split("#");
  return { repo: (repo ?? "").trim(), quant: (quant ?? "").trim() };
}

/** Run a command, capturing output (never throwing). */
async function runCommand(
  bin: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const out = await new Deno.Command(bin, {
      args,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    const dec = new TextDecoder();
    return {
      code: out.code,
      stdout: dec.decode(out.stdout),
      stderr: dec.decode(out.stderr),
    };
  } catch {
    return { code: -1, stdout: "", stderr: `${bin} not found` };
  }
}

/** Whether a path exists (any type). */
async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** The size of a file in bytes, or 0. */
async function fileSize(path: string): Promise<number> {
  try {
    const st = await Deno.stat(path);
    return st.isFile ? st.size : 0;
  } catch {
    return 0;
  }
}

/**
 * Start a shell script detached from this process so it outlives the run.
 * Prefers a transient systemd **user** unit (host-managed, survives the
 * worker); falls back to `setsid`/`nohup`.
 */
export async function startDetached(opts: {
  scriptPath: string;
  unit: string;
  logPath: string;
  home: string;
}): Promise<{ how: string; unit: string; pid: number }> {
  // Never start a second copy of a transfer that is already running. A
  // transient oneshot unit reports "activating" while it runs, not "active".
  const active = await runCommand("systemctl", [
    "--user",
    "is-active",
    opts.unit,
  ]);
  const state = active.stdout.trim();
  if (state === "active" || state === "activating") {
    return { how: "already-running", unit: opts.unit, pid: 0 };
  }
  const sr = await runCommand("systemd-run", [
    "--user",
    "--collect",
    `--unit=${opts.unit}`,
    "--property=Type=oneshot",
    `--setenv=HOME=${opts.home}`,
    "/bin/sh",
    opts.scriptPath,
  ]);
  if (sr.code === 0) return { how: "systemd-run", unit: opts.unit, pid: 0 };
  const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
  const cmd = `setsid /bin/sh ${q(opts.scriptPath)} >${
    q(opts.logPath)
  } 2>&1 </dev/null & echo $!`;
  const r = await runCommand("sh", ["-c", cmd]);
  const pid = Number.parseInt(r.stdout.trim(), 10);
  return {
    how: r.code === 0 ? "setsid" : "failed",
    unit: "",
    pid: Number.isFinite(pid) ? pid : 0,
  };
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

/** Search the Hub, returning the parsed summaries and the URL used. */
async function runSearch(
  g: GlobalArgs,
  token: string,
  ask: string,
  limit: number,
  library: string,
  pipelineTag: string,
): Promise<{ url: string; results: HfModelSummary[] }> {
  // The Hub's `search` is a substring match, not semantic: try the ask, then
  // its keywords, then filter-only, so a natural-language ask still finds hits.
  let last: { url: string; results: HfModelSummary[] } = {
    url: "",
    results: [],
  };
  for (const term of searchTerms(ask)) {
    const url = buildSearchUrl(g.endpoint, {
      ask: term,
      limit,
      library: library || g.library,
      pipelineTag,
    });
    const res = await getText(url, token, g.timeoutSec);
    if (res.status !== 200) {
      throw new Error(
        `Hugging Face search failed: HTTP ${res.status} for ${url}`,
      );
    }
    last = { url, results: parseHfModelList(res.text) };
    if (last.results.length > 0) return last;
  }
  return last;
}

/** Fetch a repo's tree and the largest GGUF (or the requested quant). */
async function pickGguf(
  g: GlobalArgs,
  token: string,
  repo: string,
  revision: string,
  quant: string,
): Promise<HfFile | null> {
  const url = buildTreeUrl(g.endpoint, repo, revision);
  const res = await getText(url, token, g.timeoutSec);
  if (res.status !== 200) return null;
  const files = parseHfTree(res.text);
  const wanted = selectGgufFiles(files, quant);
  if (wanted.length === 0) return null;
  return wanted.sort((a, b) => b.sizeBytes - a.sizeBytes)[0];
}

/** A model that searches, recommends and downloads Hugging Face models. */
export const model = {
  type: HF_TYPE,
  version: "2026.10.16.8",
  globalArguments: GlobalArgsSchema,

  upgrades: [
    {
      toVersion: "2026.10.16.8",
      description:
        "Initial release: search the Hugging Face Hub by ask + filters, inspect " +
        "a repo's tree/GGUF quants/context length/chat template, recommend a " +
        "model scored against a VRAM/RAM budget, ask the user to choose when " +
        "ambiguous (for a workflow wait_for_signal), and download the chosen " +
        "files at a pinned revision. Token via vault (`token`, sensitive) or the " +
        "HF_TOKEN environment variable. Search falls back from the raw ask to its " +
        "keywords to filter-only (the Hub's `search` is a substring match). " +
        "Downloads are **resumable** (HTTP Range; skip-if-complete) so a retry " +
        "never re-downloads, and `download` with `detached=true` starts a " +
        "host-managed background transfer that outlives the run, awaited/verified " +
        "by the new `downloadStatus` method.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],

  resources: {
    auth: {
      description:
        "Whether the Hub is reachable and how requests authenticate.",
      schema: AuthSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    search: {
      description: "Search results for one ask.",
      schema: SearchSchema,
      lifetime: "7d" as const,
      garbageCollection: 10,
    },
    model: {
      description:
        "One repo's metadata: files, GGUF quants, context, template.",
      schema: ModelSchema,
      lifetime: "7d" as const,
      garbageCollection: 10,
    },
    recommendation: {
      description: "Ranked, budget-scored candidates for one ask.",
      schema: RecommendationSchema,
      lifetime: "7d" as const,
      garbageCollection: 10,
    },
    clarification: {
      description:
        "A question to put to the user when the choice is ambiguous.",
      schema: ClarificationSchema,
      lifetime: "7d" as const,
      garbageCollection: 10,
    },
    selection: {
      description: "The repo/quant the user chose.",
      schema: SelectionSchema,
      lifetime: "7d" as const,
      garbageCollection: 10,
    },
    transfer: {
      description: "An in-progress detached (host-managed) download.",
      schema: TransferSchema,
      lifetime: "7d" as const,
      garbageCollection: 10,
    },
    download: {
      description: "The files fetched for a repo at a pinned revision.",
      schema: DownloadSchema,
      lifetime: "7d" as const,
      garbageCollection: 10,
    },
    summary: {
      description: "A printed summary of the last recommendation/download.",
      schema: SummarySchema,
      lifetime: "7d" as const,
      garbageCollection: 5,
    },
    config: {
      description:
        "Persisted Hugging Face configuration (token presence, endpoint).",
      schema: ConfigSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
  },

  methods: {
    setup: {
      description:
        "Resolve and persist this model's configuration. Reads any existing " +
        "config back first, reports the detected endpoint/token source, and " +
        "writes a `config` resource so later runs and other extensions reuse " +
        "it instead of re-asking. The token itself is never written to the " +
        "resource — only whether one is configured and where it came from.",
      arguments: SetupArgsSchema,
      execute: async (
        _args: SetupArgs,
        ctx: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = ctx.globalArgs;
        const prior = await latestRecord(ctx, "config");
        const endpoint = g.endpoint || String(prior?.["endpoint"] ?? "");
        const library = g.library || String(prior?.["library"] ?? "gguf");
        const { token, source } = resolveToken(g);
        const handle = await ctx.writeResource("config", "config", {
          endpoint,
          library,
          tokenEnvVar: g.tokenEnvVar,
          timeoutSec: g.timeoutSec,
          cacheDir: g.cacheDir,
          tokenConfigured: token.length > 0,
          tokenSource: source,
          configuredAt: new Date().toISOString(),
        });
        ctx.logger?.info(
          "huggingface setup: endpoint={endpoint} library={library} token={token}",
          { endpoint, library, token: source },
        );
        return { dataHandles: [handle] };
      },
    },

    auth: {
      description:
        "Resolve the Hugging Face token (vault `token` or the tokenEnvVar " +
        "environment variable) and report the identity the Hub sees.",
      arguments: AuthArgsSchema,
      execute: async (
        _args: AuthArgs,
        ctx: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = ctx.globalArgs;
        const { token, source } = resolveToken(g);
        let user = "";
        let authenticated = false;
        if (token) {
          const res = await getText(
            `${g.endpoint.replace(/\/+$/, "")}/api/whoami-v2`,
            token,
            g.timeoutSec,
          );
          if (res.status === 200) {
            authenticated = true;
            try {
              const o = JSON.parse(res.text) as Record<string, unknown>;
              user = String(
                o["name"] ?? o["fullname"] ?? o["preferred_username"] ?? "",
              );
            } catch {
              user = "";
            }
          }
        }
        const handle = await ctx.writeResource("auth", "auth", {
          authenticated,
          user,
          endpoint: g.endpoint,
          tokenSource: source,
          checkedAt: new Date().toISOString(),
        });
        ctx.logger?.info("huggingface auth: {state}", {
          state: authenticated
            ? `authenticated as ${user || "?"} (${source})`
            : token
            ? `token present (${source}) but not accepted`
            : "anonymous (public models only)",
        });
        return { dataHandles: [handle] };
      },
    },

    search: {
      description:
        "Search the Hub by natural-language ask plus structured filters " +
        "(library, pipeline tag). Writes the `search` resource.",
      arguments: SearchArgsSchema,
      execute: async (
        args: SearchArgs,
        ctx: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = ctx.globalArgs;
        const { token } = resolveToken(g);
        const { url, results } = await runSearch(
          g,
          token,
          args.ask,
          args.limit,
          args.library,
          args.pipelineTag,
        );
        const handle = await ctx.writeResource("search", "search", {
          ask: args.ask,
          url,
          count: results.length,
          results,
          searchedAt: new Date().toISOString(),
        });
        ctx.logger?.info("huggingface search: {count} result(s) for {ask}", {
          count: results.length,
          ask: args.ask,
        });
        return { dataHandles: [handle] };
      },
    },

    inspect: {
      description:
        "Read one repo's file tree, GGUF quants, context length and chat " +
        "template. Writes the `model` resource.",
      arguments: InspectArgsSchema,
      execute: async (
        args: InspectArgs,
        ctx: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = ctx.globalArgs;
        const { token } = resolveToken(g);
        const treeRes = await getText(
          buildTreeUrl(g.endpoint, args.repo, args.revision),
          token,
          g.timeoutSec,
        );
        if (treeRes.status !== 200) {
          throw new Error(
            `Hugging Face inspect failed: HTTP ${treeRes.status} for ${args.repo}`,
          );
        }
        const files = parseHfTree(treeRes.text);
        const gguf = files.filter((f) => f.isGguf);
        const configRes = await getText(
          buildResolveUrl(g.endpoint, args.repo, args.revision, "config.json"),
          token,
          g.timeoutSec,
        );
        const tokRes = await getText(
          buildResolveUrl(
            g.endpoint,
            args.repo,
            args.revision,
            "tokenizer_config.json",
          ),
          token,
          g.timeoutSec,
        );
        const jinjaRes = await getText(
          buildResolveUrl(
            g.endpoint,
            args.repo,
            args.revision,
            "chat_template.jinja",
          ),
          token,
          g.timeoutSec,
        );
        const infoRes = await getText(
          buildModelInfoUrl(g.endpoint, args.repo),
          token,
          g.timeoutSec,
        );
        let pipelineTag = "";
        let library = "";
        if (infoRes.status === 200) {
          try {
            const o = JSON.parse(infoRes.text) as Record<string, unknown>;
            pipelineTag = String(o["pipeline_tag"] ?? "");
            library = String(o["library_name"] ?? "");
          } catch {
            // leave blank
          }
        }
        const handle = await ctx.writeResource("model", "model", {
          repo: args.repo,
          revision: args.revision,
          pipelineTag,
          library,
          contextLength: parseContextLength(
            configRes.status === 200 ? configRes.text : "",
          ),
          chatTemplate: parseChatTemplate(
            tokRes.status === 200 ? tokRes.text : "",
            jinjaRes.status === 200 ? jinjaRes.text : "",
          ),
          files,
          gguf,
          inspectedAt: new Date().toISOString(),
        });
        ctx.logger?.info("huggingface inspect: {repo} - {gguf} GGUF file(s)", {
          repo: args.repo,
          gguf: gguf.length,
        });
        return { dataHandles: [handle] };
      },
    },

    recommend: {
      description:
        "Search, inspect the top hits, score them against a VRAM/RAM budget " +
        "and write the ranked `recommendation` resource (with a question when " +
        "the choice is ambiguous).",
      arguments: RecommendArgsSchema,
      execute: async (
        args: RecommendArgs,
        ctx: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = ctx.globalArgs;
        const { token } = resolveToken(g);
        const { results } = await runSearch(
          g,
          token,
          args.ask,
          Math.max(args.candidates, 5),
          "",
          "",
        );
        const inputs: CandidateInput[] = [];
        for (const r of results.slice(0, Math.max(1, args.candidates))) {
          const file = await pickGguf(g, token, r.id, "main", args.quant);
          if (!file) continue;
          inputs.push({
            repo: r.id,
            quant: file.quant,
            file: file.path,
            sizeBytes: file.sizeBytes,
          });
        }
        const rec = buildRecommendation(args.ask, {
          vramMiB: args.vramMiB,
          ramMiB: args.ramMiB,
        }, inputs);
        const handle = await ctx.writeResource(
          "recommendation",
          "recommendation",
          {
            ...rec,
            recommendedAt: new Date().toISOString(),
          },
        );
        ctx.logger?.info(
          "huggingface recommend: {n} candidate(s), ambiguous={amb}",
          { n: rec.candidates.length, amb: rec.ambiguous },
        );
        return { dataHandles: [handle] };
      },
    },

    clarify: {
      description:
        "With `answer` empty, emit the `clarification` question + options for a " +
        "workflow `wait_for_signal` to collect. With `answer` (e.g. " +
        "`repo#Q4_K_M`), write the resolved `selection` instead.",
      arguments: ClarifyArgsSchema,
      execute: async (
        args: ClarifyArgs,
        ctx: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const answer = args.answer.trim();
        if (answer) {
          const { repo, quant } = parseSelection(answer);
          const handle = await ctx.writeResource("selection", "selection", {
            repo,
            quant,
            file: "",
            source: "answer",
            selectedAt: new Date().toISOString(),
          });
          ctx.logger?.info("huggingface clarify: selection {repo} {quant}", {
            repo,
            quant,
          });
          return { dataHandles: [handle] };
        }
        const rec = await latestRecord(ctx, "recommendation");
        const question = String(rec?.["question"] ?? "") ||
          "No recommendation recorded — run `recommend` first.";
        const options = (rec?.["options"] as ClarOption[] | undefined) ?? [];
        const handle = await ctx.writeResource(
          "clarification",
          "clarification",
          {
            question,
            options,
            resolved: false,
            answer: "",
            askedAt: new Date().toISOString(),
          },
        );
        ctx.logger?.info(
          "huggingface clarify: asking ({n} option(s)) — answer with " +
            '`swamp workflow signal --key hf-choice --payload \'{"answer":"..."}\'`',
          { n: options.length },
        );
        return { dataHandles: [handle] };
      },
    },

    download: {
      description:
        "Download the chosen files (by `files`, else `quant`, else the largest " +
        "GGUF) at a pinned revision, optionally verifying each against its LFS " +
        "SHA-256. Writes the `download` resource with local paths.",
      arguments: DownloadArgsSchema,
      execute: async (
        args: DownloadArgs,
        ctx: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = ctx.globalArgs;
        const { token } = resolveToken(g);
        const dest = expandHome(args.dest || g.cacheDir);
        await Deno.mkdir(dest, { recursive: true });
        const treeRes = await getText(
          buildTreeUrl(g.endpoint, args.repo, args.revision),
          token,
          g.timeoutSec,
        );
        if (treeRes.status !== 200) {
          throw new Error(
            `Hugging Face download failed: HTTP ${treeRes.status} listing ${args.repo}`,
          );
        }
        const tree = parseHfTree(treeRes.text);
        let chosen: HfFile[];
        if (args.files.length > 0) {
          chosen = args.files.map((p) =>
            tree.find((f) => f.path === p) ?? {
              path: p,
              sizeBytes: 0,
              oid: "",
              quant: "",
              isGguf: p.endsWith(".gguf"),
            }
          );
        } else {
          const gguf = selectGgufFiles(tree, args.quant);
          if (gguf.length === 0) {
            throw new Error(
              `no GGUF file found in ${args.repo}` +
                (args.quant ? ` for quant ${args.quant}` : ""),
            );
          }
          chosen = [gguf.sort((a, b) => b.sizeBytes - a.sizeBytes)[0]];
        }

        // Detached: start a host-managed background transfer that outlives this
        // run, then return; `downloadStatus` awaits and verifies it.
        if (args.detached) {
          const key = `${args.repo}-${args.revision}`
            .replace(/[^a-z0-9]+/gi, "-")
            .toLowerCase()
            .slice(0, 48);
          const workDir = `${expandHome(g.cacheDir)}/.transfers`;
          await Deno.mkdir(workDir, { recursive: true });
          const markerPath = `${workDir}/${key}.done`;
          const failPath = `${workDir}/${key}.fail`;
          const scriptPath = `${workDir}/${key}.sh`;
          const logPath = `${workDir}/${key}.log`;
          const configPath = token ? `${workDir}/${key}.curlrc` : "";
          if (configPath) {
            await Deno.writeTextFile(
              configPath,
              `header = "Authorization: Bearer ${token}"\n`,
              { mode: 0o600 },
            );
          }
          const scriptFiles: ScriptFile[] = chosen.map((f) => ({
            url: buildResolveUrl(g.endpoint, args.repo, args.revision, f.path),
            dest: `${dest.replace(/\/+$/, "")}/${f.path.split("/").pop()}`,
            expectedBytes: f.sizeBytes,
          }));
          const script = renderDownloadScript({
            files: scriptFiles,
            markerPath,
            failPath,
            configPath,
          });
          await Deno.writeTextFile(scriptPath, script, { mode: 0o755 });
          const unit = `hf-download-${key}`.slice(0, 60);
          const started = await startDetached({
            scriptPath,
            unit,
            logPath,
            home: expandHome("~"),
          });
          const handle = await ctx.writeResource("transfer", "transfer", {
            repo: args.repo,
            revision: args.revision,
            dest,
            files: chosen.map((f, i) => ({
              path: f.path,
              localPath: scriptFiles[i].dest,
              expectedBytes: f.sizeBytes,
              expectedOid: f.oid,
            })),
            scriptPath,
            markerPath,
            failPath,
            unit: started.unit,
            how: started.how,
            status: "running",
            startedAt: new Date().toISOString(),
          });
          ctx.logger?.info(
            "huggingface download (detached): {n} file(s) started via {how}",
            { n: scriptFiles.length, how: started.how },
          );
          return { dataHandles: [handle] };
        }

        const records = [];
        let total = 0;
        for (const f of chosen) {
          const url = buildResolveUrl(
            g.endpoint,
            args.repo,
            args.revision,
            f.path,
          );
          const localPath = `${dest.replace(/\/+$/, "")}/${
            f.path.split("/").pop()
          }`;
          const dl = await resumableDownload(
            url,
            token,
            localPath,
            f.sizeBytes,
            g.timeoutSec,
          );
          total += dl.bytes;
          const verified = args.verify && f.oid
            ? await verifySha256(localPath, f.oid)
            : false;
          records.push({
            path: f.path,
            localPath,
            sizeBytes: dl.bytes,
            expectedOid: f.oid,
            verified,
            resumed: dl.resumed,
          });
        }
        const handle = await ctx.writeResource("download", "download", {
          repo: args.repo,
          revision: args.revision,
          dest,
          files: records,
          totalBytes: total,
          downloadedAt: new Date().toISOString(),
        });
        ctx.logger?.info("huggingface download: {n} file(s) to {dest}", {
          n: records.length,
          dest,
        });
        return { dataHandles: [handle] };
      },
    },

    downloadStatus: {
      description:
        "Await and verify a detached download started by `download` " +
        "(detached=true). With `wait` it polls until the host-managed transfer " +
        "finishes; on completion it verifies checksums and writes the `download` " +
        "resource. Safe to re-run — the transfer runs independently of this run.",
      arguments: DownloadStatusArgsSchema,
      execute: async (
        args: DownloadStatusArgs,
        ctx: MethodContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const tr = await latestRecord(ctx, "transfer");
        if (!tr) {
          throw new Error(
            "no detached transfer recorded — run `download` with detached=true first",
          );
        }
        const files = (tr["files"] as Array<Record<string, unknown>>) ?? [];
        const marker = String(tr["markerPath"] ?? "");
        const fail = String(tr["failPath"] ?? "");
        const deadline = Date.now() + Math.max(0, args.maxWaitSec) * 1000;
        const progress = async (): Promise<{ got: number; want: number }> => {
          let got = 0;
          let want = 0;
          for (const f of files) {
            got += await fileSize(String(f["localPath"] ?? ""));
            want += Number(f["expectedBytes"] ?? 0);
          }
          return { got, want };
        };
        while (true) {
          if (await pathExists(fail)) {
            throw new Error(
              `detached download failed — inspect ${tr["scriptPath"]} and ${
                String(tr["dest"] ?? "")
              }`,
            );
          }
          if (await pathExists(marker)) break;
          if (!args.wait) {
            const p = await progress();
            ctx.logger?.info(
              "huggingface downloadStatus: running ({got}/{want} B)",
              { got: p.got, want: p.want },
            );
            const handle = await ctx.writeResource("transfer", "transfer", {
              ...tr,
              status: "running",
            });
            return { dataHandles: [handle] };
          }
          if (Date.now() >= deadline) {
            const p = await progress();
            throw new Error(
              `detached download still running (${p.got}/${p.want} B); it ` +
                `continues independently of this run — re-run this step to await it`,
            );
          }
          await new Promise((r) => setTimeout(r, 15000));
        }
        const canVerify =
          (await runCommand("sha256sum", ["--version"])).code === 0;
        const records = [];
        for (const f of files) {
          const localPath = String(f["localPath"] ?? "");
          const oid = String(f["expectedOid"] ?? "");
          const sizeBytes = await fileSize(localPath);
          const verified = args.verify && oid && canVerify
            ? await verifySha256(localPath, oid)
            : false;
          records.push({
            path: String(f["path"] ?? ""),
            localPath,
            sizeBytes,
            expectedOid: oid,
            verified,
            resumed: false,
          });
        }
        if (args.verify && canVerify) {
          const bad = records.filter((r) => r.expectedOid && !r.verified);
          if (bad.length > 0) {
            throw new Error(
              `checksum verification failed for ${
                bad.map((r) => r.localPath).join(", ")
              } — the transfer may be corrupt; remove the file and re-run`,
            );
          }
        }
        const total = records.reduce((s, r) => s + r.sizeBytes, 0);
        const dl = await ctx.writeResource("download", "download", {
          repo: String(tr["repo"] ?? ""),
          revision: String(tr["revision"] ?? "main"),
          dest: String(tr["dest"] ?? ""),
          files: records,
          totalBytes: total,
          downloadedAt: new Date().toISOString(),
        });
        const trh = await ctx.writeResource("transfer", "transfer", {
          ...tr,
          status: "complete",
        });
        ctx.logger?.info("huggingface downloadStatus: complete ({bytes} B)", {
          bytes: total,
        });
        return { dataHandles: [dl, trh] };
      },
    },

    print: {
      description: "Log a summary of the last recommendation and download.",
      arguments: PrintArgsSchema,
      execute: async (
        _args: PrintArgs,
        ctx: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const rec = await latestRecord(ctx, "recommendation");
        const dl = await latestRecord(ctx, "download");
        const lines: string[] = [];
        if (rec) {
          const cands = (rec["candidates"] as Array<Record<string, unknown>>) ??
            [];
          lines.push(`ask: ${rec["ask"]}`);
          for (const c of cands.slice(0, 5)) {
            lines.push(
              `  ${c["verdict"]} ${c["repo"]} ${c["quant"]} (${
                c["sizeMiB"]
              } MiB)`,
            );
          }
        }
        if (dl) {
          lines.push(`download: ${dl["repo"]} -> ${dl["dest"]}`);
          const files = (dl["files"] as Array<Record<string, unknown>>) ?? [];
          for (const f of files) {
            lines.push(
              `  ${f["localPath"]} (${f["sizeBytes"]} B, verified=${
                f["verified"]
              })`,
            );
          }
        }
        const text = lines.join("\n") || "nothing recorded yet";
        const handle = await ctx.writeResource("summary", "summary", {
          text,
          printedAt: new Date().toISOString(),
        });
        ctx.logger?.info("huggingface summary:\n{text}", { text });
        return { dataHandles: [handle] };
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Streaming download + checksum
// ---------------------------------------------------------------------------

/** Stream an HTTP body to a file, returning the byte count written. */
async function resumableDownload(
  url: string,
  token: string,
  localPath: string,
  expectedBytes: number,
  timeoutSec: number,
): Promise<{ bytes: number; resumed: boolean }> {
  let have = 0;
  try {
    const st = await Deno.stat(localPath);
    if (st.isFile) have = st.size;
  } catch {
    have = 0;
  }
  // Already complete — nothing to do, and no request made.
  if (expectedBytes > 0 && have >= expectedBytes) {
    return { bytes: have, resumed: true };
  }
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(timeoutSec, 30) * 1000,
  );
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  let res: Response;
  try {
    // Resume from a partial file with a Range request.
    if (have > 0) headers["Range"] = `bytes=${have}-`;
    res = await fetch(url, { headers, signal: controller.signal });
  } finally {
    // The timeout covers connect/headers only — a slow body must not be killed.
    clearTimeout(timer);
  }
  if (res.status !== 200 && res.status !== 206) {
    throw new Error(`download failed: HTTP ${res.status} for ${url}`);
  }
  if (!res.body) throw new Error(`download failed: no body for ${url}`);
  // Append only when the server honoured the Range (206); otherwise restart.
  const appending = res.status === 206 && have > 0;
  const file = appending
    ? await Deno.open(localPath, { create: true, write: true, append: true })
    : await Deno.open(localPath, { create: true, write: true, truncate: true });
  let written = appending ? have : 0;
  try {
    for await (const chunk of res.body) {
      await file.write(chunk);
      written += chunk.length;
    }
  } finally {
    file.close();
  }
  return { bytes: written, resumed: have > 0 };
}

/** Verify a file's SHA-256 against an expected LFS oid using `sha256sum`. */
async function verifySha256(
  localPath: string,
  expected: string,
): Promise<boolean> {
  try {
    const out = await new Deno.Command("sha256sum", {
      args: [localPath],
      stdout: "piped",
      stderr: "null",
    }).output();
    if (out.code !== 0) return false;
    const actual = new TextDecoder().decode(out.stdout).trim().split(/\s+/)[0];
    return actual.toLowerCase() === expected.toLowerCase();
  } catch {
    return false;
  }
}
