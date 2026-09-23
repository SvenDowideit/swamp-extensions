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
import { isAbsolute, join, resolve } from "jsr:@std/path@1";
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
    const home = Deno.env.get("HOME") ?? "~";
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
    const key = content.from ?? content.name;
    if (key) byName.set(key, content);
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
    const res = resolutions.get(item.name);
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

/** Model definition for incrementally scanning and listing local ebooks. */
export const model = {
  type: "@svendowideit/ebooks",
  version: "2026.09.24.1",
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
  },
};
