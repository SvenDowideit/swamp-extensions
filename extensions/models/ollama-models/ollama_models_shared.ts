/**
 * Pure Modelfile rendering and memory-fit maths for the
 * `@svendowideit/ollama-models` model.
 *
 * Everything here is side-effect free — it takes a model's GGUF size, context
 * length and a VRAM/RAM budget and returns the Modelfile text and the derived
 * `PARAMETER` set — so the "customise it to my systems" logic is unit-testable
 * without an Ollama server.
 *
 * @module
 */

/** The extra memory a running model needs beyond the weights (runtime + buffers). */
export const RUNTIME_OVERHEAD_MIB = 512;

/** A coarse KV-cache estimate, in MiB per 1024 tokens of context. */
export const KV_MIB_PER_1K = 64;

/** The hardware budget a Modelfile is customised to. */
export interface FitBudget {
  /** GPU VRAM in MiB (0 = CPU-only / unknown). */
  vramMiB: number;
  /** System RAM in MiB (0 = unknown). */
  ramMiB: number;
}

/** One derived or supplied `PARAMETER` line. */
export interface Parameter {
  /** Parameter name (e.g. `num_ctx`). */
  key: string;
  /** Parameter value (rendered as a string). */
  value: string;
}

/** One conversation seed (`MESSAGE role content`). */
export interface Message {
  /** Role (`system` | `user` | `assistant`). */
  role: string;
  /** Content. */
  content: string;
}

/** Everything needed to render a Modelfile. */
export interface RenderOptions {
  /** `FROM` target: a local GGUF path, or an existing model name. */
  from: string;
  /** Optional `ADAPTER` (LoRA) path. */
  adapter?: string;
  /** Optional `TEMPLATE` (usually the model's chat template). */
  template?: string;
  /** Optional `SYSTEM` instructions/persona. */
  system?: string;
  /** Optional `LICENSE` text. */
  license?: string;
  /** `PARAMETER` lines, in order. */
  parameters?: Parameter[];
  /** Optional `MESSAGE` seed turns, in order. */
  messages?: Message[];
}

/** The result of {@link deriveFitParameters}. */
export interface FitResult {
  /** `num_gpu`: 999 = all layers on GPU; 0 = CPU only. */
  numGpu: number;
  /** `num_ctx`: the context window to set. */
  numCtx: number;
  /** Estimated KV-cache size in MiB. */
  kvCacheMiB: number;
  /** The tier the model runs on. */
  placement: "gpu" | "cpu" | "too-large";
  /** A short human note explaining the choice. */
  note: string;
}

/** Format a Modelfile value, using triple quotes when it spans lines or quotes. */
export function quoteModelfileValue(value: string): string {
  const needsQuotes = /[\n"]/.test(value);
  if (!needsQuotes) return value;
  return `"""\n${value.replace(/"""/g, '\\"\\"\\"')}\n"""`;
}

/**
 * Derive `num_ctx`, `num_gpu` and the KV-cache estimate from a model's size,
 * its context length and the host budget. Prefers full GPU offload at the
 * requested context; reduces the context to fit VRAM; falls back to CPU.
 */
export function deriveFitParameters(
  sizeBytes: number,
  contextLength: number,
  budget: FitBudget,
): FitResult {
  const modelMiB = Math.max(0, Math.round(sizeBytes / 1048576));
  const requested = contextLength > 0 ? contextLength : 4096;
  const kvFor = (ctx: number): number =>
    Math.max(0, Math.round((ctx / 1024) * KV_MIB_PER_1K));

  const fits = modelMiB + RUNTIME_OVERHEAD_MIB + kvFor(requested) <=
    budget.vramMiB;
  if (budget.vramMiB > 0 && fits) {
    return {
      numGpu: 999,
      numCtx: requested,
      kvCacheMiB: kvFor(requested),
      placement: "gpu",
      note: `all layers on GPU at ${requested} tokens of context`,
    };
  }
  // Model fits VRAM but the requested context does not — shrink the context.
  const room = budget.vramMiB - RUNTIME_OVERHEAD_MIB - modelMiB;
  if (budget.vramMiB > 0 && room > 0) {
    const maxCtx = Math.floor((room / KV_MIB_PER_1K) * 1024);
    const ctx = Math.max(2048, Math.floor(maxCtx / 1024) * 1024);
    if (ctx >= 2048 && ctx < requested) {
      return {
        numGpu: 999,
        numCtx: ctx,
        kvCacheMiB: kvFor(ctx),
        placement: "gpu",
        note: `all layers on GPU; context reduced to ${ctx} to fit VRAM`,
      };
    }
  }
  // Fall back to CPU if it fits RAM.
  if (budget.ramMiB > 0 && modelMiB + RUNTIME_OVERHEAD_MIB <= budget.ramMiB) {
    return {
      numGpu: 0,
      numCtx: requested,
      kvCacheMiB: kvFor(requested),
      placement: "cpu",
      note: `too large for VRAM; runs on CPU at ${requested} tokens`,
    };
  }
  return {
    numGpu: 0,
    numCtx: requested,
    kvCacheMiB: kvFor(requested),
    placement: "too-large",
    note: "exceeds this host's VRAM and RAM",
  };
}

/** Merge derived defaults with user parameters (user values win, order kept). */
export function mergeParameters(
  derived: Parameter[],
  user: Parameter[],
): Parameter[] {
  const byKey = new Map<string, Parameter>();
  for (const p of derived) byKey.set(p.key, p);
  for (const p of user) byKey.set(p.key, p);
  return [...byKey.values()];
}

/** Render a Modelfile from {@link RenderOptions}. */
export function renderModelfile(opts: RenderOptions): string {
  const lines: string[] = [];
  lines.push(`FROM ${opts.from}`);
  if (opts.adapter) lines.push(`ADAPTER ${opts.adapter}`);
  if (opts.template && opts.template.trim()) {
    lines.push(`TEMPLATE ${quoteModelfileValue(opts.template.trim())}`);
  }
  for (const p of opts.parameters ?? []) {
    lines.push(`PARAMETER ${p.key} ${p.value}`);
  }
  if (opts.system && opts.system.trim()) {
    lines.push(`SYSTEM ${quoteModelfileValue(opts.system.trim())}`);
  }
  for (const m of opts.messages ?? []) {
    lines.push(`MESSAGE ${m.role} ${quoteModelfileValue(m.content)}`);
  }
  if (opts.license && opts.license.trim()) {
    lines.push(`LICENSE ${quoteModelfileValue(opts.license.trim())}`);
  }
  return lines.join("\n") + "\n";
}

/** Parse the `FROM`, `PARAMETER`, `TEMPLATE` and `SYSTEM` lines of a Modelfile. */
export function parseModelfile(text: string): {
  from: string;
  parameters: Parameter[];
  template: string;
  system: string;
} {
  const parameters: Parameter[] = [];
  let from = "";
  let template = "";
  let system = "";
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const m = line.match(/^(\w+)\s+([\s\S]*)$/);
    if (!m) continue;
    let value = m[2];
    // Consume a multi-line triple-quoted block onto one logical value. A lone
    // `"""` opens a block; `"""value"""` on one line is already complete.
    const t = value.trimEnd();
    if (t.startsWith('"""') && !(t.length > 3 && t.endsWith('"""'))) {
      const parts: string[] = [value.slice(3)];
      for (i++; i < lines.length; i++) {
        const cur = lines[i];
        if (cur.trimEnd().endsWith('"""')) {
          parts.push(cur.trimEnd().slice(0, -3));
          break;
        }
        parts.push(cur);
      }
      value = parts.join("\n").trim();
    } else {
      value = value.replace(/^"""|"""$/g, "").trim();
    }
    const key = m[1];
    switch (key.toUpperCase()) {
      case "FROM":
        from = value;
        break;
      case "TEMPLATE":
        template = value;
        break;
      case "SYSTEM":
        system = value;
        break;
      case "PARAMETER": {
        const [pk, ...rest] = value.split(/\s+/);
        parameters.push({ key: pk, value: rest.join(" ") });
        break;
      }
    }
  }
  return { from, parameters, template, system };
}

/** Compute tokens/second from Ollama's `eval_count` / `eval_duration` (ns). */
export function tokensPerSecond(
  evalCount: number,
  evalDurationNs: number,
): number {
  if (!evalCount || !evalDurationNs) return 0;
  return Math.round((evalCount / (evalDurationNs / 1e9)) * 100) / 100;
}
