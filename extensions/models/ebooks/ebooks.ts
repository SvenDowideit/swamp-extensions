/**
 * Ebooks — incrementally walks the local filesystem looking for ebook files
 * (epub, mobi, azw, pdf, …) and renders an HTML page linking to each file's
 * location on disk.
 *
 * The scan is resumable: every `scan-disk` run picks up where the previous one
 * left off (a breadth-first directory frontier is persisted as swamp data), and
 * each run self-terminates after `maxDurationMs` (default 5 minutes) so a
 * workflow can pass control to the next step without rescanning ground already
 * covered. A scan only restarts from the root once the whole tree has been
 * enumerated (`completed`).
 *
 * @module
 */
import { z } from "npm:zod@4";
import { isAbsolute, join, resolve } from "jsr:@std/path@1";

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

const RenderArgsSchema = z.object({
  title: z.string().default("Ebooks").describe("Page title"),
});

type RenderArgs = z.infer<typeof RenderArgsSchema>;

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
function renderHtml(title: string, state: State): string {
  const items = state.ebooks
    .slice()
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((b) => {
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
        if (prev && prev.completed) {
          context.logger.info("Previous scan complete — starting a fresh scan");
          state = freshState(root);
        } else if (prev) {
          state = prev;
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
    "render-html-list": {
      description:
        "Render the discovered ebooks into an HTML page at the configured outputPath.",
      arguments: RenderArgsSchema,
      execute: async (
        args: RenderArgs,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const state = await context.readResource("state") as State | null;
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

        const html = renderHtml(args.title, state);
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
  },
};
