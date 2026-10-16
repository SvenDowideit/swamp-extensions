/**
 * Pure parsing, URL building, scoring and clarification helpers for the
 * `@svendowideit/huggingface` model.
 *
 * Everything here is side-effect free — it takes Hugging Face API JSON (as
 * text) plus a hardware budget and returns typed structures — so the whole
 * recommendation/ambiguity logic is unit-testable without the network.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A model as returned by the Hugging Face search/list API. */
export interface HfModelSummary {
  /** Repo id, `owner/name`. */
  id: string;
  /** Owner (the part before `/`), or "". */
  author: string;
  /** Download count. */
  downloads: number;
  /** Like count. */
  likes: number;
  /** Repository tags. */
  tags: string[];
  /** `pipeline_tag` (e.g. `text-generation`), or "". */
  pipelineTag: string;
  /** `library_name` (e.g. `gguf`, `transformers`), or "". */
  library: string;
  /** Whether access is gated (`gated` true/`auto`/`manual`). */
  gated: boolean;
  /** Whether the repo is private. */
  private: boolean;
  /** Last-modified timestamp, or "". */
  lastModified: string;
}

/** A file in a model repository's tree. */
export interface HfFile {
  /** Path within the repo (e.g. `qwen2.5-coder-32b-Q4_K_M.gguf`). */
  path: string;
  /** Size in bytes (`lfs.size` when present, else `size`). */
  sizeBytes: number;
  /** SHA-256 (LFS) or git object id, or "". */
  oid: string;
  /** Detected GGUF quantisation, or "" for non-GGUF files. */
  quant: string;
  /** Whether this is a `.gguf` file. */
  isGguf: boolean;
}

/** The hardware budget a recommendation is scored against. */
export interface Budget {
  /** Total GPU VRAM in MiB (0 = unknown/CPU-only). */
  vramMiB: number;
  /** System RAM in MiB (0 = unknown). */
  ramMiB: number;
}

/** One scored model/quant candidate. */
export interface Candidate {
  /** Repo id. */
  repo: string;
  /** Detected quant, or "". */
  quant: string;
  /** File path within the repo. */
  file: string;
  /** File size in bytes. */
  sizeBytes: number;
  /** File size in MiB. */
  sizeMiB: number;
  /** Where it can run. */
  verdict: "gpu" | "cpu" | "too-large";
  /** Free memory left in MiB on the tier it fits (negative when too large). */
  headroomMiB: number;
  /** A short human note. */
  notes: string;
}

/** One selectable clarification option. */
export interface ClarOption {
  /** The machine value the workflow will signal back. */
  value: string;
  /** Human label. */
  label: string;
  /** The trade-off, so the choice is informed. */
  tradeoff: string;
}

/** The ranked recommendation for one ask. */
export interface Recommendation {
  /** The natural-language requirement. */
  ask: string;
  /** The budget it was scored against. */
  budget: Budget;
  /** Ranked candidates (best fit first). */
  candidates: Candidate[];
  /** True when more than one candidate is a reasonable choice. */
  ambiguous: boolean;
  /** A question to ask the user when ambiguous, else "". */
  question: string;
  /** The options to offer when ambiguous. */
  options: ClarOption[];
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Narrow an unknown value to a plain record. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** A string field, or "". */
function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** A number field, or 0. */
function num(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** Parse one search/list API object into a summary. */
export function parseHfModelSummary(value: unknown): HfModelSummary | null {
  const o = asRecord(value);
  if (!o) return null;
  const id = str(o["id"] ?? o["modelId"]);
  if (!id) return null;
  const tags = Array.isArray(o["tags"])
    ? (o["tags"] as unknown[]).map((t) => String(t))
    : [];
  const gatedRaw = o["gated"];
  const gated = gatedRaw === true || gatedRaw === "auto" ||
    gatedRaw === "manual";
  return {
    id,
    author: str(o["author"]) || id.split("/")[0] || "",
    downloads: num(o["downloads"]),
    likes: num(o["likes"]),
    tags,
    pipelineTag: str(o["pipeline_tag"]),
    library: str(o["library_name"]),
    gated,
    private: o["private"] === true,
    lastModified: str(o["lastModified"] ?? o["last_modified"]),
  };
}

/** Parse a `/api/models` JSON array into summaries (skipping malformed rows). */
export function parseHfModelList(json: string): HfModelSummary[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const arr = Array.isArray(parsed)
    ? parsed
    : asRecord(parsed)?.["models"] ?? asRecord(parsed)?.["results"];
  if (!Array.isArray(arr)) return [];
  const out: HfModelSummary[] = [];
  for (const item of arr) {
    const s = parseHfModelSummary(item);
    if (s) out.push(s);
  }
  return out;
}

/** Detect a GGUF quantisation token in a file name, upper-cased, or "". */
export function detectGgufQuant(path: string): string {
  if (!/\.gguf$/i.test(path)) return "";
  const base = path.replace(/\.gguf$/i, "");
  const re = /(iq\d+(?:_[a-z0-9]+)+|q\d+(?:_[a-z0-9]+)*|bf16|fp16|f16|f32)/gi;
  let last = "";
  let m: RegExpExecArray | null;
  while ((m = re.exec(base)) !== null) {
    const after = base[m.index + m[0].length] ?? "";
    // A full quant token (`q4_k_m`, `iq4_xs`, `q8_0`, `f16`) is kept; a bare
    // `q<N>` that is really the start of a word (e.g. `q4bit`) is rejected.
    if (!m[0].includes("_") && /[a-z]/i.test(after)) continue;
    last = m[0].toUpperCase();
  }
  return last;
}

/** Whether a path is a `.gguf` file. */
export function isGgufFile(path: string): boolean {
  return /\.gguf$/i.test(path);
}

/**
 * Parse `GET /api/models/{id}/tree/{rev}?recursive=true` JSON into files,
 * reading `lfs.size` when the file is stored in LFS (the large-GGUF case).
 */
export function parseHfTree(json: string): HfFile[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: HfFile[] = [];
  for (const item of parsed) {
    const o = asRecord(item);
    if (!o || o["type"] !== "file") continue;
    const path = str(o["path"]);
    if (!path) continue;
    const lfs = asRecord(o["lfs"]);
    const sizeBytes = lfs ? num(lfs["size"]) : num(o["size"]);
    const oid = lfs ? str(lfs["oid"]) : str(o["oid"]);
    out.push({
      path,
      sizeBytes,
      oid,
      quant: detectGgufQuant(path),
      isGguf: isGgufFile(path),
    });
  }
  return out;
}

/** Pick the GGUF files matching a wanted quant (case-insensitive). */
export function selectGgufFiles(files: HfFile[], quant = ""): HfFile[] {
  const gguf = files.filter((f) => f.isGguf);
  if (!quant) return gguf;
  const want = quant.toUpperCase();
  return gguf.filter((f) => f.quant === want);
}

/** Read `context_length` from a `config.json` body, trying common keys. */
export function parseContextLength(configJson: string): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(configJson);
  } catch {
    return 0;
  }
  const o = asRecord(parsed);
  if (!o) return 0;
  for (
    const key of [
      "max_position_embeddings",
      "n_positions",
      "context_length",
      "seq_length",
      "model_max_length",
    ]
  ) {
    const v = o[key];
    if (typeof v === "number" && v > 0) return v;
  }
  return 0;
}

/** Extract a chat template from `tokenizer_config.json` (string or named list). */
export function parseChatTemplate(
  tokenizerConfigJson: string,
  jinjaText = "",
): string {
  if (jinjaText.trim()) return jinjaText;
  let parsed: unknown;
  try {
    parsed = JSON.parse(tokenizerConfigJson);
  } catch {
    return "";
  }
  const o = asRecord(parsed);
  if (!o) return "";
  const ct = o["chat_template"];
  if (typeof ct === "string") return ct;
  if (Array.isArray(ct)) {
    // Prefer the default entry, else the first.
    const entries = ct.map(asRecord).filter((e): e is Record<string, unknown> =>
      e !== null
    );
    const def = entries.find((e) => e["name"] === "default") ?? entries[0];
    return def ? str(def["template"]) : "";
  }
  return "";
}

/** Format a byte count as a human string (e.g. `7.4 GB`). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 100 ? 0 : 1)} ${units[i]}`;
}

// ---------------------------------------------------------------------------
// URL building
// ---------------------------------------------------------------------------

/** Options for {@link buildSearchUrl}. */
export interface SearchOptions {
  /** The natural-language ask / search terms. */
  ask?: string;
  /** Max results. */
  limit?: number;
  /** Restrict to a library tag (default `gguf`; pass "" for any). */
  library?: string;
  /** Restrict to a pipeline tag. */
  pipelineTag?: string;
  /** Sort key (default `downloads`). */
  sort?: string;
}

/** Map a natural-language ask to a likely HF `pipeline_tag`, or "". */
export function requirementToPipelineTag(ask: string): string {
  const a = ask.toLowerCase();
  const has = (...words: string[]): boolean => words.some((w) => a.includes(w));
  if (has("image", "photo", "picture", "draw", "paint")) {
    return "text-to-image";
  }
  if (has("speech", "voice", "transcri", "audio", "whisper")) {
    return "automatic-speech-recognition";
  }
  if (has("embed", "similarity", "vector", "retrieval", "rag")) {
    return "feature-extraction";
  }
  if (
    has(
      "code",
      "coding",
      "program",
      "chat",
      "assistant",
      "write",
      "writing",
      "summar",
      "reason",
      "translate",
      "question",
    )
  ) {
    return "text-generation";
  }
  return "";
}

/** Words dropped when reducing a natural-language ask to a Hub search term. */
const SEARCH_STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "for",
  "to",
  "of",
  "with",
  "that",
  "help",
  "me",
  "my",
  "i",
  "want",
  "need",
  "would",
  "like",
  "local",
  "model",
  "models",
  "llm",
  "something",
  "do",
  "does",
  "can",
  "you",
  "please",
  "best",
  "good",
  "using",
  "use",
  "on",
  "in",
  "and",
  "or",
  "is",
  "are",
  "it",
  "this",
  "run",
  "running",
  "able",
  "which",
  "will",
  "assistant",
  "make",
  "get",
]);

/**
 * Reduce a natural-language ask to an ordered list of Hub `search` terms to
 * try. The Hub's `search` is a substring match over repo ids/cards, not a
 * semantic one, so a whole sentence usually matches nothing: this falls back
 * from the raw ask, to its meaningful keywords, to the single strongest word,
 * and finally to `""` (filter-only, ranked by downloads).
 */
export function searchTerms(ask: string): string[] {
  const raw = ask.trim();
  const words = raw
    .toLowerCase()
    .split(/[^a-z0-9.+-]+/)
    .filter((w) => w.length > 2 && !SEARCH_STOPWORDS.has(w));
  const out: string[] = [];
  const push = (t: string): void => {
    if (!out.includes(t)) out.push(t);
  };
  if (raw) push(raw);
  if (words.length) push(words.slice(0, 2).join(" "));
  if (words.length) push(words[0]);
  push("");
  return out;
}

/** Build the `/api/models` search URL. */
export function buildSearchUrl(
  endpoint: string,
  opts: SearchOptions = {},
): string {
  const base = endpoint.replace(/\/+$/, "");
  const params = new URLSearchParams();
  if (opts.ask) params.set("search", opts.ask.trim());
  const library = opts.library === undefined ? "gguf" : opts.library;
  if (library) params.append("filter", library);
  const pipeline = opts.pipelineTag ?? requirementToPipelineTag(opts.ask ?? "");
  if (pipeline) params.set("pipeline_tag", pipeline);
  params.set("sort", opts.sort ?? "downloads");
  params.set("direction", "-1");
  params.set("limit", String(opts.limit ?? 20));
  params.set("full", "true");
  params.set("config", "true");
  return `${base}/api/models?${params.toString()}`;
}

/** Build `/api/models/{id}` (with blobs) for one repo. */
export function buildModelInfoUrl(endpoint: string, id: string): string {
  const base = endpoint.replace(/\/+$/, "");
  return `${base}/api/models/${id}?blobs=true`;
}

/** Build the recursive tree URL for a repo revision. */
export function buildTreeUrl(
  endpoint: string,
  id: string,
  revision = "main",
): string {
  const base = endpoint.replace(/\/+$/, "");
  return `${base}/api/models/${id}/tree/${revision}?recursive=true`;
}

/** Build a `resolve` download URL for one file at a revision. */
export function buildResolveUrl(
  endpoint: string,
  id: string,
  revision: string,
  path: string,
): string {
  const base = endpoint.replace(/\/+$/, "");
  return `${base}/${id}/resolve/${revision}/${path}`;
}

// ---------------------------------------------------------------------------
// Fit scoring + recommendation
// ---------------------------------------------------------------------------

/** The extra memory a running model needs on top of the file size (context, overhead). */
export const RUNTIME_OVERHEAD_MIB = 1024;

/** A candidate as scored: the memory it needs versus the budget. */
export function assessFit(sizeMiB: number, budget: Budget): {
  verdict: "gpu" | "cpu" | "too-large";
  headroomMiB: number;
} {
  const need = sizeMiB + RUNTIME_OVERHEAD_MIB;
  if (budget.vramMiB > 0 && need <= budget.vramMiB) {
    return { verdict: "gpu", headroomMiB: budget.vramMiB - need };
  }
  if (budget.ramMiB > 0 && need <= budget.ramMiB) {
    return { verdict: "cpu", headroomMiB: budget.ramMiB - need };
  }
  const ceiling = Math.max(budget.vramMiB, budget.ramMiB);
  return { verdict: "too-large", headroomMiB: ceiling - need };
}

/** One input row for {@link buildRecommendation}: a repo's chosen GGUF file. */
export interface CandidateInput {
  /** Repo id. */
  repo: string;
  /** Detected quant. */
  quant: string;
  /** File path. */
  file: string;
  /** File size in bytes. */
  sizeBytes: number;
}

/** Rank candidates by fit, then by size (largest usable wins). */
export function rankCandidates(
  inputs: CandidateInput[],
  budget: Budget,
): Candidate[] {
  const rank: Record<Candidate["verdict"], number> = {
    gpu: 0,
    cpu: 1,
    "too-large": 2,
  };
  const scored: Candidate[] = inputs.map((c) => {
    const sizeMiB = Math.round(c.sizeBytes / 1048576);
    const fit = assessFit(sizeMiB, budget);
    const notes = fit.verdict === "gpu"
      ? `fits GPU with ${fit.headroomMiB} MiB to spare`
      : fit.verdict === "cpu"
      ? `too big for VRAM; runs on CPU with ${fit.headroomMiB} MiB to spare`
      : "exceeds this host's VRAM and RAM";
    return { ...c, sizeMiB, ...fit, notes };
  });
  scored.sort((a, b) =>
    rank[a.verdict] - rank[b.verdict] || b.sizeMiB - a.sizeMiB ||
    a.repo.localeCompare(b.repo)
  );
  return scored;
}

/** Build the clarification options for the usable candidates. */
export function buildOptions(candidates: Candidate[], max = 4): ClarOption[] {
  return candidates
    .filter((c) => c.verdict !== "too-large")
    .slice(0, max)
    .map((c) => ({
      value: `${c.repo}#${c.quant || c.file}`,
      label: `${c.repo} (${c.quant || "gguf"}) — ${formatBytes(c.sizeBytes)}`,
      tradeoff: c.notes,
    }));
}

/**
 * Assemble the full recommendation: rank, decide whether the choice is
 * ambiguous (more than one usable candidate), and build the question/options.
 */
export function buildRecommendation(
  ask: string,
  budget: Budget,
  inputs: CandidateInput[],
): Recommendation {
  const candidates = rankCandidates(inputs, budget);
  const usable = candidates.filter((c) => c.verdict !== "too-large");
  const ambiguous = usable.length > 1;
  const options = ambiguous ? buildOptions(candidates) : [];
  const question = ambiguous
    ? `Which model should I build? ${usable.length} candidates fit this host: ` +
      options.map((o) => `${o.value} (${o.tradeoff})`).join("; ")
    : "";
  return { ask, budget, candidates, ambiguous, question, options };
}
