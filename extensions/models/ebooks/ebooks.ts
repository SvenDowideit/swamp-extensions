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
 * the `BookMetadataSchema`/`detectBookMetadata` implementation with the generic
 * `@svendowideit/book-metadata` model, so the same metadata shape is reusable
 * for physical books.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { isAbsolute, join, resolve } from "jsr:@std/path@1";
import {
  type AuthorResolutionMap,
  AuthorResolutionMapSchema,
  type BookMetadata,
  BookMetadataSchema,
  type BookResolutionMap,
  BookResolutionMapSchema,
  CURRENT_PARSER_VERSION,
  detectBookMetadata,
  resolveWikipediaName,
} from "./book_metadata.ts";

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

const ResolveWikipediaArgsSchema = z.object({
  maxDurationMs: z.number().int().positive()
    .default(5 * 60 * 1000)
    .describe(
      "Self-imposed wall-clock budget per resolve run (default 5 minutes)",
    ),
});

type ResolveWikipediaArgs = z.infer<typeof ResolveWikipediaArgsSchema>;

const EbookSchema = z.object({
  path: z.string(),
  name: z.string(),
  ext: z.string(),
  bytes: z.number().nonnegative(),
});

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

type State = z.infer<typeof StateSchema>;

/** Map of ebook path -> detected metadata (absent until detection runs). */
const MetadataMapSchema = z.record(z.string(), BookMetadataSchema);

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

/** Escape a string for safe embedding in an HTML attribute / text node. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Fresh scan state for a given root. */
function freshState(root: string): State {
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
 * Drop non-resolution keys that may have leaked into a resolution map from a
 * previous instance-name collision (e.g. "outputPath"/"count"/"generatedAt").
 * Keeps only entries whose value looks like a Resolution record.
 */
function sanitizeResolutionMap<T extends Record<string, unknown>>(
  map: T | null,
): T {
  const out: Record<string, unknown> = {};
  if (map) {
    for (const [k, v] of Object.entries(map)) {
      if (v && typeof v === "object" && "name" in v && "kind" in v) {
        out[k] = v;
      }
    }
  }
  return out as T;
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
    let size: number | null = null;
    try {
      const st = Deno.statSync(full);
      if (st.isDirectory) {
        isDir = true;
      } else {
        size = st.size ?? 0;
      }
    } catch {
      continue;
    }

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
function renderHtml(
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

/** Render an author-grouped index of ebooks that have a detected author. */
function renderAuthorsHtml(
  title: string,
  state: State,
  metadata: Record<string, BookMetadata>,
  authorRes: AuthorResolutionMap,
  bookRes: BookResolutionMap,
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

  // Sort authors: Wikipedia-resolved (linked) authors first, alphabetically,
  // then the remaining unresolved authors, alphabetically.
  const authorNames = [...byAuthor.keys()].sort((a, b) => {
    const aLinked = authorRes[a]?.url != null;
    const bLinked = authorRes[b]?.url != null;
    if (aLinked !== bLinked) return aLinked ? -1 : 1;
    return a.localeCompare(b, undefined, { sensitivity: "base" });
  });

  const sections = authorNames.map((author) => {
    const resolved = authorRes[author];
    const link = resolved?.url;
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
    Object.values(authorRes).filter((r) => r.resolved || r.kind === "not-found")
      .length;
  const checkedBooks =
    Object.values(bookRes).filter((r) => r.resolved || r.kind === "not-found")
      .length;

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
  version: "2026.09.19.1",
  globalArguments: GlobalArgsSchema,
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
    authors: {
      description:
        "Wikipedia resolution of detected author names (keyed by detected name)",
      schema: AuthorResolutionMapSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    books: {
      description:
        "Wikipedia resolution of detected book titles (keyed by detected title)",
      schema: BookResolutionMapSchema,
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
        "Resolve detected authors and book titles against Wikipedia: confirm " +
        "each is a known author or book, correct aliases/misspellings, and " +
        "record the canonical name, kind and Wikipedia URL. Already-resolved " +
        "names are skipped. Resumable within maxDurationMs.",
      arguments: ResolveWikipediaArgsSchema,
      execute: async (
        args: ResolveWikipediaArgs,
        context: MethodContext,
      ): Promise<{ dataHandles: { name: string }[] }> => {
        const metadata = await context.readResource("metadata") as
          | Record<string, BookMetadata>
          | null;

        const authors = await context.readResource("authors") as
          | AuthorResolutionMap
          | null;
        const authorRes: AuthorResolutionMap = sanitizeResolutionMap(authors);

        const books = await context.readResource("books") as
          | BookResolutionMap
          | null;
        const bookRes: BookResolutionMap = sanitizeResolutionMap(books);

        // Collect distinct author names and titles that need resolving.
        const authorNames = new Set<string>();
        const titles = new Set<string>();
        for (const md of Object.values(metadata ?? {})) {
          for (const a of md.authors ?? (md.author ? [md.author] : [])) {
            authorNames.add(a);
          }
          if (md.title) titles.add(md.title);
        }

        const deadline = Date.now() + args.maxDurationMs;
        let requested = 0;
        let skipped = 0;

        const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

        const authorNamesArr = [...authorNames];
        for (const name of authorNamesArr) {
          if (Date.now() >= deadline) break;
          const r = authorRes[name];
          // Skip only finalized results (resolved, or a confirmed "not-found").
          // Retry "rate-limited" and "error" (transient) on a later run.
          if (r && (r.resolved || r.kind === "not-found")) {
            skipped += 1;
            continue;
          }
          authorRes[name] = await resolveWikipediaName(name, "author");
          requested += 1;
          await sleep(150); // polite pacing to avoid Wikipedia rate limits
        }

        const titlesArr = [...titles];
        for (const title of titlesArr) {
          if (Date.now() >= deadline) break;
          const r = bookRes[title];
          if (r && (r.resolved || r.kind === "not-found")) {
            skipped += 1;
            continue;
          }
          bookRes[title] = await resolveWikipediaName(title, "book");
          requested += 1;
          await sleep(150);
        }

        const pendingAuthors =
          Object.values(authorRes).filter((r) =>
            !r.resolved && r.kind !== "not-found"
          ).length;
        const pendingBooks =
          Object.values(bookRes).filter((r) =>
            !r.resolved && r.kind !== "not-found"
          ).length;

        context.logger.info(
          "Wikipedia: {requested} newly requested, {skipped} already resolved, {pendingAuthors} authors pending, {pendingBooks} books pending (totals: {authors} authors, {books} books)",
          {
            requested,
            skipped,
            pendingAuthors,
            pendingBooks,
            authors: Object.keys(authorRes).length,
            books: Object.keys(bookRes).length,
          },
        );

        const ha = await context.writeResource("authors", "authors", authorRes);
        const hb = await context.writeResource("books", "books", bookRes);
        return { dataHandles: [ha, hb] };
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
        const authors = await context.readResource("authors") as
          | AuthorResolutionMap
          | null;
        const books = await context.readResource("books") as
          | BookResolutionMap
          | null;
        const outputPath = absolutePath(context.globalArgs.authorsOutputPath);

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
          sanitizeResolutionMap(authors),
          sanitizeResolutionMap(books),
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
