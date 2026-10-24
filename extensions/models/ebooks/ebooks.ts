/**
 * Ebooks — incrementally walks the local filesystem looking for ebook files
 * (epub, mobi, azw, pdf, …), detects bibliographic metadata for each, and
 * renders an HTML page linking to each file's location on disk.
 *
 * The scan is resumable: every `scan-disk` run picks up where the previous one
 * left off (a breadth-first directory frontier is persisted as swamp data), and
 * each run self-terminates after `maxDurationMs` (default 5 minutes) so a
 * workflow can pass control to the next step without rescanning ground already
 * covered. A scan only restarts from the root once the whole tree has been
 * enumerated (`completed`).
 *
 * Metadata detection (see `detect-metadata`) is likewise resumable and shares
 * the `schemas.book`/`detectBookMetadata` implementation with the generic
 * `@svendowideit/book-metadata` model, so the same metadata shape is reusable
 * for physical books.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { dirname, isAbsolute, join, resolve } from "jsr:@std/path@1";
import {
  type BookMetadata,
  classifyResolved,
  CURRENT_PARSER_VERSION,
  CURRENT_RESOLUTION_VERSION,
  detectBookMetadata,
  pickCandidate,
  type Resolution,
  type ResolvedPage,
  schemas,
  type SearchCandidate,
} from "./book_metadata.ts";

/** Book metadata and resolution record shapes shared with the ebook models. */
export type { BookMetadata, Resolution };

const DEFAULT_EXTENSIONS = [
  "epub",
  "mobi",
  "azw",
  "azw3",
  "fb2",
  "lit",
  "djvu",
  "pdf",
];

/** Default @svendowideit/caddy model the ebooks file_server route is declared on. */
export const DEFAULT_EBOOKS_CADDY_MODEL = "ebooks-caddy";

/** Host label the ebooks pages are served under (ebooks.<host>.<domain>). */
export const EBOOKS_ROUTE_LABEL = "ebooks";

const GlobalArgsSchema = z.object({
  root: z.string()
    .default("~")
    .describe("Filesystem path to scan for ebooks (default ~)"),
  outputPath: z.string()
    .default("~/.swamp/ebooks/ebooks.html")
    .describe("Filesystem path for the generated HTML listing"),
  authorsOutputPath: z.string()
    .default("~/.swamp/ebooks/index.html")
    .describe(
      "Filesystem path for the author-grouped index (only ebooks with a " +
        "detected author)",
    ),
  extensions: z.array(z.string())
    .default(DEFAULT_EXTENSIONS)
    .describe("File extensions to treat as ebooks (without the dot)"),
  excludePatterns: z.array(z.string())
    .default([".git", ".swamp", "node_modules", ".cache", ".Trash"])
    .describe("Directory names to skip while scanning"),
  cacheDir: z.string()
    .default("~/.swamp/web-cache")
    .describe(
      "Shared web-cache directory to read cached Wikipedia/Wikidata responses " +
        "from (must match the @svendowideit/web-cache model's cacheDir).",
    ),
  caddyModelName: z.string()
    .default("")
    .describe(
      "Name of the @svendowideit/caddy model whose base domain and host record " +
        "supply the ebooks hostname. Empty (default) auto-discovers the caddy " +
        "model that owns this machine. Only used by ensure-caddy-serve, when " +
        "@svendowideit/caddy is installed.",
    ),
  caddyRouteHostname: z.string()
    .default("")
    .describe(
      "Override the full hostname the ebooks pages are served under. Empty " +
        "(default) derives `ebooks.<host>.<domain>` from the caddy model above.",
    ),
}).strict();

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const ScanDiskArgsSchema = z.object({
  maxDurationMs: z.number().int().positive()
    .default(5 * 60 * 1000)
    .describe(
      "Self-imposed wall-clock budget per scan run (default 5 minutes)",
    ),
});

type ScanDiskArgs = z.infer<typeof ScanDiskArgsSchema>;

const DetectMetadataArgsSchema = z.object({
  file: z.string()
    .optional()
    .describe(
      "Specific ebook file to detect metadata for. Omit to detect metadata " +
        "for all discovered ebooks (until maxDurationMs is reached).",
    ),
  maxDurationMs: z.number().int().positive()
    .default(5 * 60 * 1000)
    .describe(
      "Self-imposed wall-clock budget per detect run (default 5 minutes)",
    ),
});

type DetectMetadataArgs = z.infer<typeof DetectMetadataArgsSchema>;

const RenderArgsSchema = z.object({
  title: z.string().default("Ebooks").describe("Page title"),
});

type RenderArgs = z.infer<typeof RenderArgsSchema>;

const RenderAuthorsArgsSchema = z.object({
  title: z.string().default("Ebooks by Author").describe("Page title"),
});

type RenderAuthorsArgs = z.infer<typeof RenderAuthorsArgsSchema>;

const EnsureCaddyServeArgsSchema = z.object({
  model: z.string().optional().describe(
    "Source @svendowideit/caddy model whose base domain and host record supply " +
      "the ebooks hostname. Defaults to the global caddyModelName, else " +
      "auto-discovers the caddy model that owns this machine.",
  ),
  serveModel: z.string().optional().describe(
    `The @svendowideit/caddy model the ebooks route is declared on (default ` +
      `${DEFAULT_EBOOKS_CADDY_MODEL}, auto-created when absent).`,
  ),
  hostname: z.string().optional().describe(
    "Full hostname to serve the pages on. Defaults to the global " +
      "caddyRouteHostname, else `ebooks.<host>.<domain>` from the source caddy " +
      "model.",
  ),
  serveRoot: z.string().optional().describe(
    "Directory to serve over HTTP(S). Defaults to the directory of the " +
      "configured outputPath (e.g. ~/.swamp/ebooks).",
  ),
});

type EnsureCaddyServeArgs = z.infer<typeof EnsureCaddyServeArgsSchema>;

/**
 * Pick one name's canonical candidate. The inputs arrive as already-parsed
 * wikipedia data (referenced via `data.latest`); this only applies the
 * ebook-specific candidate selection and writes a `candidate` record.
 */
const PickArgsSchema = z.object({
  name: z.string(),
  expectKind: z.enum(["author", "book"]),
  key: z.string().optional().describe(
    "Filesystem-safe instance key for this name (defaults to nameKey(name))",
  ),
  results: z.array(z.object({
    title: z.string(),
    description: z.string().nullable(),
    url: z.string().nullable(),
  })).default([]),
  pages: z.record(
    z.string(),
    z.object({
      title: z.string(),
      url: z.string().nullable(),
      shortdesc: z.string().nullable(),
      wikidataId: z.string().nullable(),
    }),
  ).default({}),
});

type PickArgs = z.infer<typeof PickArgsSchema>;

/** A chosen candidate (the pick-candidate output). */
const CandidateSchema = z.object({
  name: z.string(),
  expectKind: z.enum(["author", "book"]),
  title: z.string().nullable(),
  url: z.string().nullable(),
  description: z.string().nullable(),
  wikidataId: z.string().nullable(),
});

type Candidate = z.infer<typeof CandidateSchema>;

/**
 * Classify one name and write the final resolution record. The candidate and
 * the wikipedia/wikidata signals arrive as already-parsed inputs.
 */
const ClassifyArgsSchema = z.object({
  name: z.string(),
  expectKind: z.enum(["author", "book"]),
  key: z.string().optional().describe(
    "Filesystem-safe instance key for this name (defaults to nameKey(name))",
  ),
  title: z.string().nullable().default(null),
  url: z.string().nullable().default(null),
  description: z.string().nullable().default(null),
  wikidataId: z.string().nullable().default(null),
  infoboxTemplate: z.string().nullable().default(null),
  instanceOf: z.array(z.string()).default([]),
});

type ClassifyArgs = z.infer<typeof ClassifyArgsSchema>;

/** A name to resolve (author or book title). */
export type NameItem = {
  /** The name to resolve. */
  name: string;
  /** Whether it is expected to be an author or a book. */
  expectKind: "author" | "book";
  /** Filesystem-safe key for this name (see `nameKey`). */
  key: string;
};

const NameItemSchema = z.object({
  name: z.string(),
  expectKind: z.enum(["author", "book"]),
  /** Filesystem-safe key for this name (see `nameKey`). */
  key: z.string(),
});

/** The set of names that need resolving (emitted by `plan-resolution`). */
const NamesSchema = z.object({
  items: z.array(NameItemSchema),
  /** Number of names emitted this run. */
  planned: z.number().int().nonnegative(),
  /** Names not emitted because the per-run cap was reached. */
  backlog: z.number().int().nonnegative(),
  /** True when the cap left names for a later run. */
  truncated: z.boolean(),
});

type Names = z.infer<typeof NamesSchema>;

/** Args for the deprecated resolve-wikipedia back-compat method. */
const ResolveWikipediaArgsSchema = z.object({});
type ResolveWikipediaArgs = z.infer<typeof ResolveWikipediaArgsSchema>;

/** Args for plan-resolution (emits the name list). */
const PlanArgsSchema = z.object({
  maxNames: z.number().int().positive()
    .default(20)
    .describe(
      "Cap on the number of names emitted this run. Already-resolved names are " +
        "excluded first, so a large backlog is spread across runs.",
    ),
});
type PlanArgs = z.infer<typeof PlanArgsSchema>;

/** A discovered ebook file. */
export type Ebook = {
  /** Absolute path. */
  path: string;
  /** Base name. */
  name: string;
  /** Lowercase extension (without the dot). */
  ext: string;
  /** Size in bytes. */
  bytes: number;
};

const EbookSchema = z.object({
  path: z.string(),
  name: z.string(),
  ext: z.string(),
  bytes: z.number().nonnegative(),
});

/** Resumable filesystem scan state. */
export type State = {
  /** Root path being scanned. */
  root: string;
  /** Whether the whole tree has been covered. */
  completed: boolean;
  /** Remaining directory frontier. */
  queue: string[];
  /** Directories already visited. */
  seenDirs: string[];
  /** Discovered ebook files. */
  ebooks: Ebook[];
  /** Number of directories scanned so far. */
  scannedDirs: number;
  /** ISO timestamp the scan started. */
  startedAt: string;
  /** ISO timestamp of the last update. */
  updatedAt: string;
};

const StateSchema = z.object({
  root: z.string(),
  completed: z.boolean(),
  queue: z.array(z.string()),
  seenDirs: z.array(z.string()),
  ebooks: z.array(EbookSchema),
  scannedDirs: z.number().int().nonnegative(),
  startedAt: z.string(),
  updatedAt: z.string(),
});

/** Map of ebook path -> detected metadata (absent until detection runs). */
const MetadataMapSchema = z.record(z.string(), schemas.book);

const PageResultSchema = z.object({
  outputPath: z.string(),
  count: z.number().int().nonnegative(),
  generatedAt: z.string(),
});

type MethodContext = {
  globalArgs: GlobalArgs;
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    debug?: (msg: string, props?: Record<string, unknown>) => void;
    warning?: (msg: string, props?: Record<string, unknown>) => void;
  };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
  readResource: (
    instanceName: string,
    version?: number,
  ) => Promise<Record<string, unknown> | null>;
  dataRepository: {
    findAllForModel: (
      type: string,
      modelId: string,
    ) => Promise<
      {
        name: string;
        tags: Record<string, string>;
        createdAt: Date;
        isDeleted: boolean;
        isRenamed: boolean;
      }[]
    >;
  };
  modelType: string;
  modelId: string;
};

/** Expand `~` and relative paths to an absolute path. */
function absolutePath(raw: string): string {
  if (raw.startsWith("~")) {
    if (raw === "~/.swamp" || raw.startsWith("~/.swamp/")) {
      const swampHome = Deno.env.get("SWAMP_HOME");
      if (swampHome) {
        const base = swampHome.replace(/\/+$/, "");
        const suffix = raw.slice("~/.swamp".length).replace(/^[/\\]/, "");
        return suffix ? join(base, suffix) : base;
      }
    }
    const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? "~";
    return join(home, raw.slice(1).replace(/^[/\\]/, "") || "");
  }
  if (!isAbsolute(raw)) return resolve(raw);
  return raw;
}

/** Normalize extension to a lowercased, dotless token. */
function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

/** Deterministic 32-bit FNV-1a hash (hex) of a string — stable across runs. */
export function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * A stable, filesystem-safe key for an arbitrary detected name (author or
 * title). Names come from filenames and file contents and can be extremely
 * long, non-ASCII, or garbage — so the key is sanitized to `[a-z0-9-]`,
 * truncated, and suffixed with a short hash of the *original* name to keep it
 * unique and bounded well under filesystem name limits. The human-readable
 * name is always carried in the record itself; this key is only for storage.
 */
export function nameKey(name: string): string {
  const normalized = name.replace(/\s+/g, " ").trim().toLowerCase();
  const safe = normalized
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  const hash = fnv1a(normalized);
  return safe ? `${safe}-${hash}` : hash;
}

/** Escape a string for safe embedding in an HTML attribute / text node. */
export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Fresh scan state for a given root. */
export function freshState(root: string): State {
  return {
    root,
    completed: false,
    queue: [root],
    seenDirs: [],
    ebooks: [],
    scannedDirs: 0,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Load every stored resolution record, keyed by the *original detected name*
 * (the record's `from` field). Enumerating once and keying by `from` makes this
 * independent of how the record's instance name was derived (new safe keys or
 * legacy raw names), and avoids one read per candidate name.
 */
async function loadResolutions(
  context: MethodContext,
): Promise<Map<string, Resolution>> {
  const byName = new Map<string, Resolution>();
  const all = await context.dataRepository.findAllForModel(
    context.modelType,
    context.modelId,
  );
  for (const rec of all) {
    if (rec.tags?.specName !== "resolution") continue;
    if (rec.isDeleted || rec.isRenamed) continue;
    const content = await context.readResource(rec.name) as Resolution | null;
    if (!content) continue;
    const raw = content.from ?? content.name ?? "";
    if (!raw) continue;
    // Match candidates case-insensitively and whitespace-insensitively: the
    // same author arrives as "Katherine MaClean" in one scan and
    // "Katherine MacLean" in the next. Keep the raw spelling too so legacy
    // callers of planNames (and older records) still line up.
    for (
      const key of [
        nameKey(raw),
        raw,
        content.name ? nameKey(content.name) : "",
      ]
    ) {
      if (!key) continue;
      const existing = byName.get(key);
      if (
        !existing ||
        (content.resolved && !existing.resolved) ||
        ((content.resolvedAt ?? "") > (existing.resolvedAt ?? ""))
      ) {
        byName.set(key, content);
      }
    }
  }
  return byName;
}

/**
 * A plan of which names to resolve next, plus the counts that explain it.
 */
export interface NamePlan {
  selected: NameItem[];
  fresh: number;
  failed: number;
  done: number;
  backlog: number;
  /** True when the cap left names for a later run (backlog > 0). */
  truncated: boolean;
}

/**
 * Pure selection logic: given every candidate name and the resolutions already
 * on record, choose the next `maxNames` to resolve so the backlog drains:
 *
 *   1. names with no resolution record ("fresh") fill ~90% of the budget
 *   2. the remaining slots go to names that failed (resolved=false), least
 *      recently attempted first, so transient failures get retried
 *   3. if there aren't enough failures, the rest of the budget goes to fresh
 *
 * Successfully-resolved names are never selected. `maxNames <= 0` means "all".
 */
export function planNames(
  candidates: NameItem[],
  resolutions: Map<string, Resolution>,
  maxNames: number,
): NamePlan {
  const fresh: NameItem[] = [];
  const failed: { item: NameItem; at: string }[] = [];
  let done = 0;
  for (const item of candidates) {
    const res = resolutions.get(item.key) ?? resolutions.get(item.name);
    if (!res) {
      fresh.push(item);
    } else if (res.resolved) {
      done += 1;
    } else {
      failed.push({ item, at: res.resolvedAt ?? "" });
    }
  }
  // Least-recently-attempted failures first.
  failed.sort((a, b) => a.at.localeCompare(b.at));

  const selected: NameItem[] = [];
  const picked = new Set<string>();
  const unlimited = maxNames <= 0;
  const take = (item: NameItem) => {
    if (!unlimited && selected.length >= maxNames) return;
    const k = `${item.expectKind}:${item.name}`;
    if (picked.has(k)) return;
    picked.add(k);
    selected.push(item);
  };

  const freshTarget = unlimited
    ? fresh.length
    : Math.min(fresh.length, Math.ceil(maxNames * 0.9));
  for (let i = 0; i < freshTarget; i++) take(fresh[i]);
  for (const f of failed) take(f.item);
  // If there weren't enough failures to fill the budget, use more fresh names.
  for (const item of fresh) take(item);

  const backlog = fresh.length + failed.length - selected.length;
  return {
    selected,
    fresh: fresh.length,
    failed: failed.length,
    done,
    backlog,
    truncated: backlog > 0,
  };
}

/**
 * Collect the names that need resolving from the detected metadata, excluding
 * successfully-resolved names and prioritising fresh names over retries.
 */
async function collectNames(
  metadata: Record<string, BookMetadata>,
  context: MethodContext,
  maxNames: number,
): Promise<Names> {
  // Collect authors and titles as separate sets. Authors are ranked by how
  // many ebooks credit them (most prolific first) so each run resolves the
  // names that affect the most books, rather than filename artefacts that
  // happen to sort early. Authors come before titles so the author index
  // actually makes progress.
  const authorCount = new Map<string, number>();
  const titleSet = new Set<string>();
  for (const md of Object.values(metadata)) {
    for (const a of md.authors ?? (md.author ? [md.author] : [])) {
      if (a.trim()) authorCount.set(a, (authorCount.get(a) ?? 0) + 1);
    }
    if (md.title && md.title.trim()) titleSet.add(md.title);
  }

  const candidates: NameItem[] = [];
  const seen = new Set<string>();
  const addCandidate = (name: string, expectKind: "author" | "book") => {
    const dedupeKey = `${expectKind}:${name}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    candidates.push({ name, expectKind, key: nameKey(name) });
  };
  // Skip names with no letters at all — filename artefacts like "01", "." or
  // "271 009 5", never a person. Rank the rest by book count, then name.
  const hasLetter = (s: string) => /\p{L}/u.test(s);
  const rankedAuthors = [...authorCount.keys()]
    .filter(hasLetter)
    .sort((a, b) =>
      (authorCount.get(b)! - authorCount.get(a)!) || a.localeCompare(b)
    );
  for (const name of rankedAuthors) addCandidate(name, "author");
  for (const name of [...titleSet].sort()) addCandidate(name, "book");

  const resolutions = await loadResolutions(context);
  const plan = planNames(candidates, resolutions, maxNames);

  context.logger.info(
    "Planned {planned}/{max} names ({fresh} fresh, {failed} retryable, {done} done, {backlog} backlog remaining)",
    {
      planned: plan.selected.length,
      max: maxNames <= 0 ? "all" : maxNames,
      fresh: plan.fresh,
      failed: plan.failed,
      done: plan.done,
      backlog: plan.backlog,
    },
  );
  for (const item of plan.selected) {
    context.logger.info("  plan → {kind}: {name}", {
      kind: item.expectKind,
      name: item.name,
    });
  }
  return {
    items: plan.selected,
    planned: plan.selected.length,
    backlog: plan.backlog,
    truncated: plan.truncated,
  };
}

/** Read directory entry names, returning null on error. */
function readDir(dir: string): string[] | null {
  try {
    return Array.from(Deno.readDirSync(dir)).map((e) => e.name);
  } catch {
    return null;
  }
}

/**
 * Process one directory from the BFS frontier: classify its ebook files and
 * enqueue any unseen subdirectories.
 */
function scanDirectory(
  dir: string,
  state: State,
  extensions: Set<string>,
  excludePatterns: string[],
): void {
  const names = readDir(dir);
  if (names === null) return;

  for (const name of names) {
    const full = join(dir, name);
    const ext = fileExtension(name);

    let isDir = false;
    let isSymlink = false;
    let size: number | null = null;
    try {
      // `lstat` (not `stat`) so symbolic links are not followed. Following a
      // directory symlink can recurse forever on a loop (until the OS path
      // limit stops it) and double-counts any file reachable by both its real
      // path and a link. Skips symlinks entirely, matching the default of
      // sibling scanners in this repo. Callers who want links can add them
      // under the real tree.
      const st = Deno.lstatSync(full);
      isSymlink = st.isSymlink;
      if (st.isDirectory) {
        isDir = true;
      } else {
        size = st.size ?? 0;
      }
    } catch {
      continue;
    }

    if (isSymlink) continue;

    if (isDir) {
      if (excludePatterns.includes(name)) continue;
      if (state.seenDirs.includes(full)) continue;
      state.seenDirs.push(full);
      state.queue.push(full);
      continue;
    }

    if (extensions.has(ext)) {
      state.ebooks.push({ path: full, name, ext, bytes: size ?? 0 });
    }
  }
  state.scannedDirs += 1;
}

/** Render the HTML listing page. */
export function renderHtml(
  title: string,
  state: State,
  metadata: Record<string, BookMetadata>,
): string {
  const items = state.ebooks
    .slice()
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((b) => {
      const md = metadata[b.path];
      const label = md?.title ?? md?.author ?? null;
      const edition = md?.editionPublishedAt ?? md?.publishedAt ?? null;

      if (label) {
        const byline = [md.author, edition ? `ed. ${edition}` : null]
          .filter(Boolean)
          .join(" · ");
        return (
          `<li><a href="${esc(b.path)}" title="${esc(b.path)}">${
            esc(label)
          }</a>` +
          `<span class="meta">${esc(byline || b.ext.toUpperCase())}</span>` +
          `<div class="path">${esc(b.path)}</div></li>`
        );
      }

      return (
        `<li><a href="${esc(b.path)}">${esc(b.path)}</a>` +
        `<span class="meta">${
          esc(b.ext.toUpperCase())
        } · ${b.bytes.toLocaleString()} B</span></li>`
      );
    })
    .join("\n    ");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem; color: #1a1a1a; }
  h1 { font-size: 1.5rem; }
  .summary { color: #555; margin-bottom: 1.5rem; }
  ul { list-style: none; padding: 0; }
  li { padding: 0.35rem 0; border-bottom: 1px solid #eee; }
  a { text-decoration: none; color: #0b57d0; word-break: break-all; }
  a:hover { text-decoration: underline; }
  .meta { color: #888; margin-left: 0.75rem; font-size: 0.85rem; white-space: nowrap; }
  .path { color: #aaa; font-size: 0.8rem; word-break: break-all; }
</style>
</head>
<body>
<h1>${esc(title)}</h1>
<p class="summary">${state.ebooks.length} ebook${
    state.ebooks.length === 1 ? "" : "s"
  }${state.completed ? "" : " (scan in progress)"}</p>
<ul>
    ${items || "<li>No ebooks found yet.</li>"}
</ul>
</body>
</html>
`;
}

/**
 * True when a resolution should be linked as an author: it resolved and was
 * classified as a person (kind "author"). Other kinds (book, other, …) are
 * intentionally excluded so false positives are not linked.
 */
function isLinkedAuthor(res: Resolution | undefined): boolean {
  return !!res && res.resolved && res.kind === "author" && res.url != null;
}

/** Render an author-grouped index of ebooks that have a detected author. */
export function renderAuthorsHtml(
  title: string,
  state: State,
  metadata: Record<string, BookMetadata>,
  resolutions: Record<string, Resolution>,
): string {
  // Group ebooks by author; skip any without a detected author. A book with
  // multiple authors is listed under each of them.
  const byAuthor = new Map<string, { md: BookMetadata; path: string }[]>();
  for (const b of state.ebooks) {
    const md = metadata[b.path];
    const authors = md?.authors?.length
      ? md.authors
      : (md?.author ? [md.author] : []);
    for (const author of authors) {
      const list = byAuthor.get(author) ?? [];
      list.push({ md, path: b.path });
      byAuthor.set(author, list);
    }
  }

  // Sort authors: Wikipedia-resolved authors (linked, and classified as a
  // person) first, alphabetically, then the remaining unresolved authors,
  // alphabetically.
  const authorNames = [...byAuthor.keys()].sort((a, b) => {
    const aLinked = isLinkedAuthor(resolutions[a]);
    const bLinked = isLinkedAuthor(resolutions[b]);
    if (aLinked !== bLinked) return aLinked ? -1 : 1;
    return a.localeCompare(b, undefined, { sensitivity: "base" });
  });

  const sections = authorNames.map((author) => {
    const resolved = resolutions[author];
    // Only link an author to Wikipedia when it was actually classified as a
    // person (not a book title, number, or other page). This keeps false
    // positives like "3" or "A Dance" from being linked as authors.
    const link = isLinkedAuthor(resolved) ? resolved!.url : null;
    const books = byAuthor.get(author)!
      .sort((a, b) =>
        (a.md.title ?? a.path).localeCompare(b.md.title ?? b.path)
      )
      .map(({ md, path }) => {
        const edition = md.editionPublishedAt ?? md.publishedAt ?? null;
        const label = md.title ?? path;
        return (
          `<li><a href="${esc(path)}" title="${esc(path)}">${esc(label)}</a>` +
          `<span class="meta">${edition ? `ed. ${esc(edition)}` : ""}</span>` +
          `<div class="path">${esc(path)}</div></li>`
        );
      })
      .join("\n      ");

    const heading = link
      ? `<h2><a href="${esc(link)}" target="_blank" rel="noopener">${
        esc(author)
      }</a></h2>`
      : `<h2>${esc(author)}</h2>`;

    return (
      `<section>\n  ${heading}\n  <ul>\n      ${
        books || "<li>No books.</li>"
      }\n  </ul>\n</section>`
    );
  }).join("\n  ");

  const total = [...byAuthor.values()].reduce((n, l) => n + l.length, 0);

  const checkedAuthors =
    Object.values(resolutions).filter((r) =>
      r.expectKind === "author" && (r.resolved || r.kind === "not-found")
    ).length;
  const checkedBooks =
    Object.values(resolutions).filter((r) =>
      r.expectKind === "book" && (r.resolved || r.kind === "not-found")
    ).length;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem; color: #1a1a1a; }
  h1 { font-size: 1.5rem; }
  h2 { font-size: 1.2rem; margin: 1.5rem 0 0.5rem; border-bottom: 1px solid #eee; padding-bottom: 0.25rem; }
  .summary { color: #555; margin-bottom: 1rem; }
  ul { list-style: none; padding: 0; }
  li { padding: 0.3rem 0; border-bottom: 1px solid #f2f2f2; }
  a { text-decoration: none; color: #0b57d0; word-break: break-all; }
  a:hover { text-decoration: underline; }
  .meta { color: #888; margin-left: 0.75rem; font-size: 0.85rem; white-space: nowrap; }
  .path { color: #aaa; font-size: 0.8rem; word-break: break-all; }
</style>
</head>
<body>
<h1>${esc(title)}</h1>
<p class="summary">${authorNames.length} author${
    authorNames.length === 1 ? "" : "s"
  } · ${total} ebook${
    total === 1 ? "" : "s"
  } · ${checkedAuthors} Wikipedia-checked author${
    checkedAuthors === 1 ? "" : "s"
  } · ${checkedBooks} Wikipedia-checked book${checkedBooks === 1 ? "" : "s"}</p>
  ${sections || "<p>No ebooks with a detected author yet.</p>"}
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Optional @svendowideit/caddy integration (serve the rendered pages over HTTP)
// ---------------------------------------------------------------------------

/** Status of the file_server route that serves the rendered ebooks pages. */
const CaddyServeOutputSchema = z.object({
  hostname: z.string(),
  root: z.string(),
  /** The @svendowideit/caddy model the route is declared on (ebooks-caddy). */
  serveModel: z.string(),
  /** The caddy model the host and domain were read from. */
  sourceModel: z.string(),
  baseDomain: z.string(),
  changed: z.boolean(),
  servedAt: z.string(),
});

/**
 * Facts about one @svendowideit/caddy model, read from its persisted
 * `globalArguments`. The ebooks extension reads these to learn the host and
 * domain the operator already configured in caddy, so it can serve
 * `ebooks.<host>.<domain>` without hardcoding either.
 */
export type CaddyModelFacts = {
  /** The caddy model name. */
  modelName: string;
  /** Base domain the caddy is authoritative for (e.g. `fi.gy`); "" if unset. */
  baseDomain: string;
  /** This host's own FQDN (e.g. `x1yoga.fi.gy`), or the base domain. */
  hostFqdn: string;
  /** systemd unit name of the caddy it manages (e.g. `caddy`). */
  serviceName: string;
  /** Host the caddy runs on; "" means this machine. */
  target: string;
};

/**
 * Read caddy facts from a `swamp model get <caddy> --json` payload.
 *
 * The host's own FQDN is the A/AAAA record under the base domain whose leftmost
 * label is this machine's hostname, else the deepest such record, else the base
 * domain itself — so a model that owns `x1yoga.fi.gy` yields `x1yoga.fi.gy` and
 * the route becomes `ebooks.x1yoga.fi.gy`. Pure, so the derivation is testable
 * without a live swamp.
 */
export function parseCaddyModelFacts(
  modelName: string,
  raw: { globalArguments?: Record<string, unknown> },
  hostname = "",
): CaddyModelFacts {
  const g = (raw.globalArguments ?? {}) as Record<string, unknown>;
  const baseDomain = typeof g.baseDomain === "string" ? g.baseDomain : "";
  const serviceName = typeof g.serviceName === "string" && g.serviceName
    ? g.serviceName
    : "caddy";
  const target = typeof g.target === "string" ? g.target : "";
  const records = Array.isArray(g.dnsRecords)
    ? (g.dnsRecords as Array<Record<string, unknown>>)
    : [];

  const base = baseDomain.toLowerCase().replace(/^\.+/, "");
  const shortHost = hostname.split(".")[0].toLowerCase();
  const candidates: string[] = [];
  for (const r of records) {
    if (typeof r.name !== "string" || typeof r.type !== "string") continue;
    const type = r.type.toUpperCase();
    if (type !== "A" && type !== "AAAA") continue;
    const name = r.name.toLowerCase().replace(/^\.+/, "");
    if (base && name !== base && !name.endsWith(`.${base}`)) continue;
    const value = Array.isArray(r.value) ? r.value : [];
    if (!value.some((v) => typeof v === "string" && !!v)) continue;
    candidates.push(name);
  }
  const named = candidates.find(
    (n) => shortHost && n.split(".")[0] === shortHost,
  );
  const deepest = candidates.slice().sort(
    (a, b) => b.split(".").length - a.split(".").length,
  )[0];
  const hostFqdn = named ?? deepest ?? baseDomain;
  return { modelName, baseDomain, hostFqdn, serviceName, target };
}

/** The names of the @svendowideit/caddy models in a `swamp model list --json` payload. */
export function caddyModelNames(listJson: string): string[] {
  try {
    const parsed = JSON.parse(listJson) as {
      results?: Array<{ name?: unknown; type?: unknown }>;
    };
    return (parsed.results ?? [])
      .filter((r) =>
        r.type === "@svendowideit/caddy" && typeof r.name === "string"
      )
      .map((r) => r.name as string);
  } catch {
    return [];
  }
}

/**
 * Pick the caddy model that owns this host: the one whose host FQDN starts with
 * this machine's hostname. Falls back to the only model that has a base domain
 * set. Returns null when the choice is absent or ambiguous, so the caller skips
 * rather than guessing.
 */
export function pickSourceCaddy(
  facts: CaddyModelFacts[],
  hostname: string,
): CaddyModelFacts | null {
  const shortHost = hostname.split(".")[0].toLowerCase();
  const matches = facts.filter(
    (f) => shortHost && f.hostFqdn.split(".")[0] === shortHost,
  );
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) return null;
  const withDomain = facts.filter((f) => f.baseDomain);
  return withDomain.length === 1 ? withDomain[0] : null;
}

/**
 * The hostname the ebooks pages are served under: `<label>.<hostFqdn>`. The
 * FQDN already carries the domain caddy owns, so `x1yoga.fi.gy` yields
 * `ebooks.x1yoga.fi.gy`; a FQDN already under the label is returned unchanged.
 */
export function ebooksRouteHostname(
  hostFqdn: string,
  label = EBOOKS_ROUTE_LABEL,
): string {
  const host = hostFqdn.trim().replace(/^\.+/, "");
  if (!host) return "";
  const prefix = `${label}.`;
  return host.startsWith(prefix) ? host : `${prefix}${host}`;
}

/** This machine's hostname (`Deno.hostname()`, minus any domain part). */
export function machineHostname(): string {
  try {
    return Deno.hostname();
  } catch {
    return Deno.env.get("HOSTNAME") ?? "";
  }
}

/** Run a `swamp` CLI command and capture stdout/stderr/exit code. */
export async function runSwampCmd(
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    // swamp-quality-ignore deno-command: optional caddy peer discovered at runtime; args are fixed literals or globals of this model, never untrusted input — see README.
    const proc = new Deno.Command("swamp", {
      args,
      stdout: "piped",
      stderr: "piped",
    });
    const out = await proc.output();
    return {
      stdout: new TextDecoder().decode(out.stdout),
      stderr: new TextDecoder().decode(out.stderr),
      code: out.code,
    };
  } catch (err) {
    return {
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
      code: 127,
    };
  }
}

/** Model definition for incrementally scanning and listing local ebooks. */
export const model = {
  type: "@svendowideit/ebooks",
  version: "2026.10.24.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.09.20.2",
      description:
        "No schema changes — plan-resolution now records planned/backlog/" +
        "truncated on the names record; docs corrected to the current methods",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.09.24.1",
      description:
        "Documentation and typing only: the manifest is now the full user manual " +
        "and the README uses the canonical sections. The exported metadata types " +
        "are explicit (no behaviour change); global and method arguments are " +
        "unchanged.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.18.1",
      description:
        "Adds an ensure-caddy-serve method (and caddyServe resource) that, when " +
        "@svendowideit/caddy is installed, declares a file_server route serving " +
        "the rendered ebooks directory at ebooks.<host>.<domain> on a dedicated " +
        "ebooks-caddy model that caddy merges with the models it already runs. " +
        "Adds optional caddyModelName and caddyRouteHostname globals (both " +
        'default ""). Schema is additive — existing models upgrade with no ' +
        "changes.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.18.2",
      description:
        "Declares @svendowideit/caddy in the manifest's optionalDependencies, " +
        "so release tooling can show it as an optional peer (used when " +
        "installed, never required). No model or resource schema changes.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.23.1",
      description:
        "Honour SWAMP_HOME when resolving ~/.swamp-relative output/cache paths.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.24.1",
      description:
        "No model schema changes — propagate the run-level maxFetches budget " +
        "through the resolution workflows.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    state: {
      description:
        "Resumable scan state (frontier, seen dirs, discovered ebooks)",
      schema: StateSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    metadata: {
      description:
        "Detected book metadata keyed by ebook path (shared shape with " +
        "@svendowideit/book-metadata)",
      schema: MetadataMapSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    names: {
      description:
        "The set of names that need resolving (emitted by plan-resolution)",
      schema: NamesSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    resolution: {
      description:
        "A per-name Wikipedia/Wikidata resolution record (factory: one instance " +
        "per resolved name)",
      schema: schemas.resolution,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    candidate: {
      description: "A chosen candidate (the pick-candidate output, per name)",
      schema: CandidateSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    page: {
      description: "Result of the last HTML page generation",
      schema: PageResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    caddyServe: {
      description:
        "Status of the Caddy file_server route that serves the rendered pages " +
        "(hostname, root, the ebooks-caddy model it lives on)",
      schema: CaddyServeOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    "scan-disk": {
      description:
        "Resume (or start) an ebook scan, enumerating directories until the " +
        "per-run time budget is exhausted or the whole tree is covered.",
      arguments: ScanDiskArgsSchema,
      execute: async (
        args: ScanDiskArgs,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const root = absolutePath(context.globalArgs.root);
        const extensions = new Set(
          context.globalArgs.extensions.map((e) => e.toLowerCase()),
        );
        const excludePatterns = context.globalArgs.excludePatterns;

        const prev = await context.readResource("state") as State | null;
        let state: State;
        if (prev) {
          // Additive: never discard prior scan state. If a different root is
          // requested, treat it as additional territory to scan rather than a
          // reset — enqueue it so nothing already found is ever lost.
          state = prev;
          if (state.root !== root && !state.seenDirs.includes(root)) {
            context.logger.info(
              "Adding new root {root} to existing scan state (additive)",
              { root },
            );
            state.seenDirs.push(root);
            state.queue.push(root);
            state.completed = false;
          }
        } else {
          state = freshState(root);
        }

        const deadline = Date.now() + args.maxDurationMs;
        let dirs = 0;
        while (state.queue.length > 0 && Date.now() < deadline) {
          const dir = state.queue.shift()!;
          scanDirectory(dir, state, extensions, excludePatterns);
          dirs += 1;
        }

        state.completed = state.queue.length === 0;
        state.updatedAt = new Date().toISOString();

        context.logger.info(
          "Scanned {dirs} dirs this run — {ebooks} ebooks, {remaining} dirs remaining, {status}",
          {
            dirs,
            ebooks: state.ebooks.length,
            remaining: state.queue.length,
            status: state.completed ? "complete" : "paused (time budget)",
          },
        );

        const handle = await context.writeResource("state", "state", state);
        return { dataHandles: [handle] };
      },
    },
    "detect-metadata": {
      description:
        "Detect bibliographic metadata (author, title, ISBN, publish dates) " +
        "for a specified ebook file — or for all discovered ebooks — and store " +
        "it, linked back to each ebook by path.",
      arguments: DetectMetadataArgsSchema,
      execute: async (
        args: DetectMetadataArgs,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const state = await context.readResource("state") as State | null;
        const prevMeta = await context.readResource("metadata") as
          | Record<string, BookMetadata>
          | null;
        const metadata: Record<string, BookMetadata> = { ...(prevMeta ?? {}) };

        const targets: string[] = args.file
          ? [absolutePath(args.file)]
          : (state?.ebooks ?? []).map((e) => e.path);

        const deadline = Date.now() + args.maxDurationMs;
        let detected = 0;
        for (const path of targets) {
          if (Date.now() >= deadline) break;
          const prev = metadata[path];
          // Skip only if already detected with the current parser version.
          if (prev && (prev.parserVersion ?? 0) >= CURRENT_PARSER_VERSION) {
            continue;
          }
          const md = await detectBookMetadata(path);
          metadata[path] = md;
          detected += 1;
        }

        // Remaining = targets that still need detection (missing or stale).
        let remaining = 0;
        for (const path of targets) {
          const prev = metadata[path];
          if (!prev || (prev.parserVersion ?? 0) < CURRENT_PARSER_VERSION) {
            remaining += 1;
          }
        }

        context.logger.info(
          "Detected metadata for {detected} ebooks ({remaining} remaining)",
          { detected, remaining },
        );

        const handle = await context.writeResource(
          "metadata",
          "metadata",
          metadata,
        );
        return { dataHandles: [handle] };
      },
    },
    "resolve-wikipedia": {
      description:
        "DEPRECATED — kept for back-compat. Resolution is now a per-name " +
        "workflow pipeline (plan-resolution → forEach name → " +
        "@svendowideit/ebooks-resolve-name → classify). This method only emits " +
        "the name list (same as plan-resolution).",
      arguments: ResolveWikipediaArgsSchema,
      execute: async (
        _args: ResolveWikipediaArgs,
        context: MethodContext,
      ): Promise<{ dataHandles: { name: string }[] }> => {
        const metadata = await context.readResource("metadata") as
          | Record<string, BookMetadata>
          | null;
        const names = await collectNames(metadata ?? {}, context, 0);
        const handle = await context.writeResource("names", "names", names);
        context.logger.info("Collected {n} names to resolve", {
          n: names.items.length,
        });
        return { dataHandles: [handle] };
      },
    },
    "plan-resolution": {
      description:
        "Compute the set of author names and book titles that need resolving " +
        "and emit them as a name list, excluding already-resolved names and " +
        "capped at `maxNames` per run. Does no fetching — the workflow fans out " +
        "per name into @svendowideit/ebooks-resolve-name.",
      arguments: PlanArgsSchema,
      execute: async (
        args: PlanArgs,
        context: MethodContext,
      ): Promise<{ dataHandles: { name: string }[] }> => {
        const metadata = await context.readResource("metadata") as
          | Record<string, BookMetadata>
          | null;
        const names = await collectNames(
          metadata ?? {},
          context,
          args.maxNames,
        );
        const handle = await context.writeResource("names", "names", names);
        context.logger.info("Planned {n} names to resolve", {
          n: names.items.length,
        });
        return { dataHandles: [handle] };
      },
    },
    "pick-candidate": {
      description:
        "Pick one name's canonical candidate from its already-parsed search + " +
        "page-props results. Writes a `candidate` record. Called per name by " +
        "@svendowideit/ebooks-resolve-name.",
      arguments: PickArgsSchema,
      execute: async (
        args: PickArgs,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const chosen = pickCandidate(
          args.expectKind,
          args.results as SearchCandidate[],
          args.pages as Record<string, ResolvedPage>,
        );
        const candidate: Candidate = {
          name: args.name,
          expectKind: args.expectKind,
          title: chosen?.title ?? null,
          url: chosen?.url ?? null,
          description: chosen?.description ?? null,
          wikidataId: chosen?.wikidataId ?? null,
        };
        const key = args.key ?? nameKey(args.name);
        const handle = await context.writeResource(
          "candidate",
          `candidate-${key}`,
          candidate,
        );
        context.logger.info("Picked candidate {title} for {name} ({key})", {
          title: chosen?.title ?? "none",
          name: args.name,
          key,
        });
        return { dataHandles: [handle] };
      },
    },
    "classify": {
      description:
        "Classify one name (author vs book) and write the final `resolution` " +
        "record. Called per name by @svendowideit/ebooks-resolve-name.",
      arguments: ClassifyArgsSchema,
      execute: async (
        args: ClassifyArgs,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const kind = classifyResolved(
          args.infoboxTemplate,
          args.instanceOf.length ? args.instanceOf : null,
        );

        const resolution: Resolution = {
          name: args.title ?? args.name,
          url: args.url,
          description: args.description,
          kind,
          resolved: args.title != null,
          from: args.name,
          resolvedAt: new Date().toISOString(),
          infobox: args.infoboxTemplate,
          wikidataId: args.wikidataId,
          instanceOf: args.instanceOf,
          resolutionVersion: CURRENT_RESOLUTION_VERSION,
          expectKind: args.expectKind,
        };

        const key = args.key ?? nameKey(args.name);
        const handle = await context.writeResource(
          "resolution",
          `resolution-${key}`,
          resolution,
        );
        context.logger.info("Classified {name} as {kind} ({key})", {
          name: args.name,
          kind,
          key,
        });
        return { dataHandles: [handle] };
      },
    },
    "render-html-list": {
      description:
        "Render the discovered ebooks into an HTML page at the configured outputPath.",
      arguments: RenderArgsSchema,
      execute: async (
        args: RenderArgs,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const state = await context.readResource("state") as State | null;
        const metadata = await context.readResource("metadata") as
          | Record<string, BookMetadata>
          | null;
        const outputPath = absolutePath(context.globalArgs.outputPath);

        if (!state || state.ebooks.length === 0) {
          const handle = await context.writeResource("page", "page", {
            outputPath,
            count: 0,
            generatedAt: new Date().toISOString(),
          });
          context.logger.info(
            "No ebooks discovered yet — skipped HTML generation",
          );
          return { dataHandles: [handle] };
        }

        const html = renderHtml(args.title, state, metadata ?? {});
        try {
          await Deno.mkdir(join(outputPath, ".."), { recursive: true });
          await Deno.writeTextFile(outputPath, html);
        } catch (err) {
          throw new Error(
            `Failed to write HTML page: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }

        const handle = await context.writeResource("page", "page", {
          outputPath,
          count: state.ebooks.length,
          generatedAt: new Date().toISOString(),
        });
        context.logger.info(
          "Wrote {count} ebooks to {path}",
          { count: state.ebooks.length, path: outputPath },
        );
        return { dataHandles: [handle] };
      },
    },
    "render-html-authors": {
      description:
        "Render an author-grouped index page (only ebooks with a detected " +
        "author) at the configured authorsOutputPath.",
      arguments: RenderAuthorsArgsSchema,
      execute: async (
        args: RenderAuthorsArgs,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const state = await context.readResource("state") as State | null;
        const metadata = await context.readResource("metadata") as
          | Record<string, BookMetadata>
          | null;
        const outputPath = absolutePath(context.globalArgs.authorsOutputPath);

        // Resolutions are keyed by the detected name (author or title). Load
        // them all once and index by the record's `from` field.
        const byName = await loadResolutions(context);
        const resolutions: Record<string, Resolution> = {};
        for (const md of Object.values(metadata ?? {})) {
          for (const name of md.authors ?? (md.author ? [md.author] : [])) {
            const rec = byName.get(name);
            if (rec) resolutions[name] = rec;
          }
        }

        const html = renderAuthorsHtml(
          args.title,
          state ?? {
            root: "",
            completed: true,
            queue: [],
            seenDirs: [],
            ebooks: [],
            scannedDirs: 0,
            startedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          metadata ?? {},
          resolutions,
        );

        try {
          await Deno.mkdir(join(outputPath, ".."), { recursive: true });
          await Deno.writeTextFile(outputPath, html);
        } catch (err) {
          throw new Error(
            `Failed to write HTML page: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }

        const handle = await context.writeResource("page", "authors-page", {
          outputPath,
          count: Object.keys(metadata ?? {}).length,
          generatedAt: new Date().toISOString(),
        });
        context.logger.info(
          "Wrote author index to {path}",
          { path: outputPath },
        );
        return { dataHandles: [handle] };
      },
    },
    "ensure-caddy-serve": {
      description:
        "When @svendowideit/caddy is installed, declare a Caddy file_server " +
        "route that serves the rendered ebooks directory at " +
        "`ebooks.<host>.<domain>`, reading the host and domain from the caddy " +
        "model that already owns this machine. Uses a dedicated ebooks-caddy " +
        "model that the caddy extension merges with the models it already runs, " +
        "and relies on caddy's route derivation for the A record and " +
        "certificate. Skips with a log when caddy is not installed or no single " +
        "caddy model can be chosen.",
      arguments: EnsureCaddyServeArgsSchema,
      execute: async (
        args: EnsureCaddyServeArgs,
        context: MethodContext,
      ): Promise<{ dataHandles: { name: string }[] }> => {
        const logger = context.logger;

        // Only run when the caddy extension is installed — it is an optional
        // peer, like the feedback server's systemd-service dependency.
        const probe = await runSwampCmd([
          "model",
          "type",
          "search",
          "@svendowideit/caddy",
          "--json",
        ]);
        const installed = probe.code === 0 &&
          probe.stdout.includes("@svendowideit/caddy");
        if (!installed) {
          logger.info(
            "@svendowideit/caddy not installed — skipping ebooks file-serving setup. Run `swamp extension pull @svendowideit/caddy` to enable it.",
          );
          return { dataHandles: [] };
        }

        // Find the caddy model(s) this repo defines and read their facts.
        const list = await runSwampCmd(["model", "list", "--json"]);
        if (list.code !== 0) {
          logger.info(
            "Could not list models ({code}) — skipping ebooks file-serving setup.",
            { code: list.code },
          );
          return { dataHandles: [] };
        }
        const names = caddyModelNames(list.stdout);
        if (names.length === 0) {
          logger.info(
            "No @svendowideit/caddy model found — skipping ebooks file-serving setup. Create one first, e.g. `swamp model create @svendowideit/caddy my-caddy --global-arg baseDomain=example.com`.",
          );
          return { dataHandles: [] };
        }
        const host = machineHostname();
        const facts: CaddyModelFacts[] = [];
        for (const name of names) {
          const got = await runSwampCmd(["model", "get", name, "--json"]);
          if (got.code !== 0) continue;
          try {
            facts.push(
              parseCaddyModelFacts(name, JSON.parse(got.stdout), host),
            );
          } catch {
            // Unparseable model JSON: ignore this model.
          }
        }

        const explicit = args.model?.trim() ||
          context.globalArgs.caddyModelName?.trim();
        let source: CaddyModelFacts | null;
        if (explicit) {
          source = facts.find((f) => f.modelName === explicit) ?? null;
          if (!source) {
            logger.info(
              "caddy model '{model}' not found — skipping ebooks file-serving setup.",
              { model: explicit },
            );
            return { dataHandles: [] };
          }
        } else {
          source = pickSourceCaddy(facts, host);
          if (!source) {
            logger.info(
              "Could not pick a single caddy model to read the ebooks host/domain from ({models}) — skipping ebooks file-serving setup. Set caddyModelName on this model to choose one.",
              { models: names.join(", ") },
            );
            return { dataHandles: [] };
          }
        }

        const hostname = args.hostname?.trim() ||
          context.globalArgs.caddyRouteHostname?.trim() ||
          ebooksRouteHostname(source.hostFqdn);
        if (!hostname) {
          logger.info(
            "caddy model '{model}' has no base domain — skipping ebooks file-serving setup.",
            { model: source.modelName },
          );
          return { dataHandles: [] };
        }
        // Serve the directory the pages are rendered into (default
        // ~/.swamp/ebooks), so both ebooks.html and index.html are reachable.
        // NOTE: deliberately named `serveRoot`, not `root` — the model's global
        // arg `root` (the scan root) would otherwise be bound into this method's
        // args by the same name and override the derived path.
        const root = args.serveRoot?.trim()
          ? absolutePath(args.serveRoot.trim())
          : dirname(absolutePath(context.globalArgs.outputPath));
        const serveModel = args.serveModel?.trim() ||
          DEFAULT_EBOOKS_CADDY_MODEL;

        // Ensure our own caddy model exists. It carries the source model's base
        // domain and systemd unit so the caddy extension merges its route with
        // the models already running under that unit — we add a route, not
        // rewrite theirs. Everything else (certificate, A record) is derived by
        // caddy at merge time, so nothing else is set here.
        const existing = await runSwampCmd([
          "model",
          "get",
          serveModel,
          "--json",
        ]);
        if (existing.code !== 0) {
          const createArgs = [
            "model",
            "create",
            "@svendowideit/caddy",
            serveModel,
            "--global-arg",
            `baseDomain=${source.baseDomain}`,
            "--global-arg",
            `serviceName=${source.serviceName}`,
          ];
          if (source.target) {
            createArgs.push("--global-arg", `target=${source.target}`);
          }
          const create = await runSwampCmd(createArgs);
          if (create.code !== 0) {
            throw new Error(
              `Failed to create caddy model ${serveModel} (${create.code}): ${
                create.stderr || create.stdout
              }`,
            );
          }
          logger.info(
            "Created caddy model {model} (baseDomain {domain}, unit {unit}) to serve the ebooks pages",
            {
              model: serveModel,
              domain: source.baseDomain,
              unit: source.serviceName,
            },
          );
        } else {
          try {
            const cur = parseCaddyModelFacts(
              serveModel,
              JSON.parse(existing.stdout),
              host,
            );
            if (
              cur.baseDomain && source.baseDomain &&
              cur.baseDomain !== source.baseDomain
            ) {
              logger.warning?.(
                "caddy model {model} baseDomain '{cur}' differs from '{src}'; update it with `swamp model edit {model} --global-arg baseDomain={src}`",
                {
                  model: serveModel,
                  cur: cur.baseDomain,
                  src: source.baseDomain,
                },
              );
            }
          } catch {
            // Unparseable model JSON: leave the existing model as-is.
          }
        }

        // Declare the file_server route. Caddy derives the TLS subject (auto
        // certificate) and, when a DNS provider is configured, the A record
        // from the base domain the merged models already own.
        const run = await runSwampCmd([
          "model",
          "method",
          "run",
          serveModel,
          "serveSettings",
          "--input",
          `hostname=${hostname}`,
          "--input",
          `root=${root}`,
          "--skip-reports",
        ]);
        if (run.code !== 0) {
          throw new Error(
            `serveSettings failed (${run.code}): ${run.stderr || run.stdout}`,
          );
        }

        logger.info(
          "Ebooks pages served: {hostname} -> {root} via caddy model {model} (domain from {source})",
          {
            hostname,
            root,
            model: serveModel,
            source: source.modelName,
          },
        );
        const handle = await context.writeResource(
          "caddyServe",
          "caddy-serve-current",
          {
            hostname,
            root,
            serveModel,
            sourceModel: source.modelName,
            baseDomain: source.baseDomain,
            changed: true,
            servedAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
