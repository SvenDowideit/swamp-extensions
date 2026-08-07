/**
 * Feedback queue HTTP server for the news-reader workflow.
 *
 * Stores feedback entries as individual time-sortable JSON files in a queue
 * directory. The news workflow's gather-feedback step polls GET, processes
 * entries, and deletes them via DELETE.
 *
 * Usage:
 *   deno run --allow-net --allow-read --allow-write --allow-env \
 *     scripts/feedback-server.ts [--port 8765] [--html path/to/news.html] [--queue-dir path/to/queue] [--pages-dir path/to/pages]
 *
 * If `deno` is not on your PATH, swamp installs it at ~/.swamp/deno/deno:
 *   ~/.swamp/deno/deno run --allow-net --allow-read --allow-write --allow-env \
 *     scripts/feedback-server.ts [--port 8765] [--html path/to/news.html] [--queue-dir path/to/queue] [--pages-dir path/to/pages]
 *
 * Endpoints:
 *   POST /api/feedback  — enqueue a feedback entry
 *   GET  /api/feedback?limit=N  — dequeue oldest N entries
 *   DELETE /api/feedback?id=ULID  — delete one entry
 *   DELETE /api/feedback?ids=ULID1,ULID2  — batch delete
 *   POST /api/pages  — enqueue a page URL to parse for feed discovery
 *   GET  /api/pages?limit=N  — list queued pages (oldest first)
 *   DELETE /api/pages?id=ULID  — delete one page
 *   DELETE /api/pages?ids=ULID1,ULID2  — batch delete
  *   GET  /  — serve the HTML page (if --html provided)
  *   GET  /feeds.html  — serve the feeds listing (if --feeds provided)
  */

function generateId(): string {
  const ts = Date.now().toString(36).padStart(8, "0");
  const rand = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  return `${ts}-${rand}`;
}

const PORT = parseInt(Deno.env.get("FEEDBACK_PORT") ?? "8765");
const HTML_PATH = Deno.env.get("FEEDBACK_HTML_PATH") ?? "";
const FEEDS_PATH = Deno.env.get("FEEDBACK_FEEDS_PATH") ?? "";
const QUEUE_DIR = Deno.env.get("FEEDBACK_QUEUE_DIR") ?? "";
const PAGES_DIR = Deno.env.get("FEEDBACK_PAGES_DIR") ?? "";
const FEED_STATE_DIR = Deno.env.get("FEEDBACK_FEED_STATE_DIR") ?? "";

function parseArgs(): {
  port: number;
  htmlPath: string;
  feedsPath: string;
  queueDir: string;
  pagesDir: string;
  feedStateDir: string;
} {
  let port = PORT;
  let htmlPath = HTML_PATH;
  let feedsPath = FEEDS_PATH;
  let queueDir = QUEUE_DIR;
  let pagesDir = PAGES_DIR;
  let feedStateDir = FEED_STATE_DIR;
  const args = Deno.args;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" && i + 1 < args.length) {
      port = parseInt(args[++i], 10);
    } else if (args[i] === "--html" && i + 1 < args.length) {
      htmlPath = args[++i];
    } else if (args[i] === "--feeds" && i + 1 < args.length) {
      feedsPath = args[++i];
    } else if (args[i] === "--queue-dir" && i + 1 < args.length) {
      queueDir = args[++i];
    } else if (args[i] === "--pages-dir" && i + 1 < args.length) {
      pagesDir = args[++i];
    } else if (args[i] === "--feed-state-dir" && i + 1 < args.length) {
      feedStateDir = args[++i];
    }
  }
  if (!queueDir) {
    queueDir = `${Deno.env.get("HOME") ?? "/tmp"}/.swamp/feedback-queue`;
  }
  if (!pagesDir) {
    pagesDir = `${Deno.env.get("HOME") ?? "/tmp"}/.swamp/pages-queue`;
  }
  if (!feedStateDir) {
    feedStateDir = `${Deno.env.get("HOME") ?? "/tmp"}/.swamp/feed-state`;
  }
  return { port, htmlPath, feedsPath, queueDir, pagesDir, feedStateDir };
}

interface FeedbackEntry {
  articleId: string;
  action: "interested" | "ignored" | "seen" | "read";
  source?: string;
  title?: string;
  keywords?: string[];
}

interface QueuedEntry extends FeedbackEntry {
  id: string;
  createdAt: string;
}

interface QueuedPage {
  id: string;
  url: string;
  createdAt: string;
}

async function ensureQueueDir(dir: string): Promise<void> {
  try {
    await Deno.mkdir(dir, { recursive: true });
  } catch {
    // already exists
  }
}

async function writeEntry(dir: string, entry: unknown): Promise<void> {
  const path = `${dir}/${(entry as { id: string }).id}.json`;
  await Deno.writeTextFile(path, JSON.stringify(entry));
}

async function readEntries<T extends { id: string }>(
  dir: string,
  limit: number,
): Promise<T[]> {
  const entries: T[] = [];
  try {
    for await (const dirEntry of Deno.readDir(dir)) {
      if (dirEntry.isFile && dirEntry.name.endsWith(".json")) {
        const path = `${dir}/${dirEntry.name}`;
        const text = await Deno.readTextFile(path);
        try {
          entries.push(JSON.parse(text) as T);
        } catch {
          // skip corrupt files
        }
      }
    }
  } catch {
    // dir doesn't exist yet
  }
  entries.sort((a, b) => a.id.localeCompare(b.id));
  return entries.slice(0, limit);
}

async function countEntries(dir: string): Promise<number> {
  let count = 0;
  try {
    for await (const dirEntry of Deno.readDir(dir)) {
      if (dirEntry.isFile && dirEntry.name.endsWith(".json")) count++;
    }
  } catch {
    // dir doesn't exist yet
  }
  return count;
}

async function deleteEntry(dir: string, id: string): Promise<boolean> {
  const path = `${dir}/${id}.json`;
  try {
    await Deno.remove(path);
    return true;
  } catch {
    return false;
  }
}

async function deleteEntries(dir: string, ids: string[]): Promise<number> {
  let deleted = 0;
  for (const id of ids) {
    if (await deleteEntry(dir, id)) deleted++;
  }
  return deleted;
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

async function handleRequest(
  req: Request,
  htmlPath: string,
  feedsPath: string,
  queueDir: string,
  pagesDir: string,
  feedStateDir: string,
): Promise<Response> {
  const url = new URL(req.url);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  if (req.method === "GET" && url.pathname === "/feeds.html") {
    if (!feedsPath) {
      return new Response("No feeds page configured. Use --feeds flag.", {
        status: 404,
        headers: corsHeaders(),
      });
    }
    try {
      const html = await Deno.readTextFile(feedsPath);
      return new Response(html, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          ...corsHeaders(),
        },
      });
    } catch {
      return new Response("Feeds file not found", {
        status: 404,
        headers: corsHeaders(),
      });
    }
  }

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "")) {
    if (!htmlPath) {
      return new Response("No HTML page configured. Use --html flag.", {
        status: 404,
        headers: corsHeaders(),
      });
    }
    try {
      const html = await Deno.readTextFile(htmlPath);
      return new Response(html, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          ...corsHeaders(),
        },
      });
    } catch {
      return new Response("HTML file not found", {
        status: 404,
        headers: corsHeaders(),
      });
    }
  }

  if (url.pathname === "/api/feedback") {
    if (req.method === "POST") {
      try {
        const body: FeedbackEntry = await req.json();
        if (!body.articleId || !body.action) {
          return jsonResponse(
            { error: "articleId and action are required" },
            400,
          );
        }
        if (
          body.action !== "interested" &&
          body.action !== "ignored" &&
          body.action !== "seen" &&
          body.action !== "read"
        ) {
          return jsonResponse(
            {
              error:
                'action must be "interested", "ignored", "seen", or "read"',
            },
            400,
          );
        }

        const entry: QueuedEntry = {
          id: generateId(),
          createdAt: new Date().toISOString(),
          articleId: body.articleId,
          action: body.action,
          source: body.source ?? "",
          title: body.title ?? "",
          keywords: body.keywords ?? [],
        };

        await ensureQueueDir(queueDir);
        await writeEntry(queueDir, entry);

        return jsonResponse({ id: entry.id, status: "queued" }, 201);
      } catch (err) {
        return jsonResponse(
          { error: err instanceof Error ? err.message : "Invalid request" },
          400,
        );
      }
    }

    if (req.method === "GET") {
      const limit = Math.min(
        Math.max(parseInt(url.searchParams.get("limit") ?? "20"), 1),
        100,
      );
      const entries = await readEntries(queueDir, limit);
      return jsonResponse({
        items: entries,
        remaining: entries.length,
        queued: await countEntries(queueDir),
      });
    }

    if (req.method === "DELETE") {
      const idParam = url.searchParams.get("id");
      const idsParam = url.searchParams.get("ids");

      if (idsParam) {
        const ids = idsParam.split(",").map((s) => s.trim()).filter(Boolean);
        const deleted = await deleteEntries(queueDir, ids);
        return jsonResponse({ deleted, ids });
      }

      if (idParam) {
        const ok = await deleteEntry(queueDir, idParam);
        return jsonResponse(
          { id: idParam, status: ok ? "deleted" : "not_found" },
          ok ? 200 : 404,
        );
      }

      return jsonResponse(
        { error: "Provide ?id= or ?ids= query parameter" },
        400,
      );
    }
  }

  if (url.pathname === "/api/feed") {
    if (req.method === "POST") {
      try {
        const body = await req.json();
        const feedUrl = body.url ?? "";
        const enabled = body.enabled;
        if (!feedUrl || typeof enabled !== "boolean") {
          return jsonResponse(
            { error: "url (string) and enabled (boolean) are required" },
            400,
          );
        }
        const entry = {
          id: generateId(),
          url: feedUrl,
          enabled,
          createdAt: new Date().toISOString(),
        };
        await ensureQueueDir(feedStateDir);
        await writeEntry(feedStateDir, entry);
        return jsonResponse({ id: entry.id, status: "queued" }, 201);
      } catch (err) {
        return jsonResponse(
          { error: err instanceof Error ? err.message : "Invalid request" },
          400,
        );
      }
    }

    if (req.method === "GET") {
      const limit = Math.min(
        Math.max(parseInt(url.searchParams.get("limit") ?? "20"), 1),
        100,
      );
      const entries = await readEntries(feedStateDir, limit) as Array<{
        id: string; url: string; enabled: boolean; createdAt: string;
      }>;
      return jsonResponse({
        items: entries,
        remaining: entries.length,
        queued: await countEntries(feedStateDir),
      });
    }

    if (req.method === "DELETE") {
      const idParam = url.searchParams.get("id");
      const idsParam = url.searchParams.get("ids");

      if (idsParam) {
        const ids = idsParam.split(",").map((s) => s.trim()).filter(Boolean);
        const deleted = await deleteEntries(feedStateDir, ids);
        return jsonResponse({ deleted, ids });
      }

      if (idParam) {
        const ok = await deleteEntry(feedStateDir, idParam);
        return jsonResponse(
          { id: idParam, status: ok ? "deleted" : "not_found" },
          ok ? 200 : 404,
        );
      }

      return jsonResponse(
        { error: "Provide ?id= or ?ids= query parameter" },
        400,
      );
    }
  }

  if (url.pathname === "/api/pages") {
    if (req.method === "POST") {
      try {
        const body = await req.json();
        const urlValue = body.url ?? body.pageUrl ?? "";
        if (!urlValue) {
          return jsonResponse(
            { error: "url is required" },
            400,
          );
        }
        const entry: QueuedPage = {
          id: generateId(),
          url: String(urlValue),
          createdAt: new Date().toISOString(),
        };
        await ensureQueueDir(pagesDir);
        await writeEntry(pagesDir, entry);
        return jsonResponse({ id: entry.id, status: "queued" }, 201);
      } catch (err) {
        return jsonResponse(
          { error: err instanceof Error ? err.message : "Invalid request" },
          400,
        );
      }
    }

    if (req.method === "GET") {
      const limit = Math.min(
        Math.max(parseInt(url.searchParams.get("limit") ?? "20"), 1),
        100,
      );
      const entries = await readEntries(pagesDir, limit) as QueuedPage[];
      return jsonResponse({
        items: entries,
        remaining: entries.length,
        queued: await countEntries(pagesDir),
      });
    }

    if (req.method === "DELETE") {
      const idParam = url.searchParams.get("id");
      const idsParam = url.searchParams.get("ids");

      if (idsParam) {
        const ids = idsParam.split(",").map((s) => s.trim()).filter(Boolean);
        const deleted = await deleteEntries(pagesDir, ids);
        return jsonResponse({ deleted, ids });
      }

      if (idParam) {
        const ok = await deleteEntry(pagesDir, idParam);
        return jsonResponse(
          { id: idParam, status: ok ? "deleted" : "not_found" },
          ok ? 200 : 404,
        );
      }

      return jsonResponse(
        { error: "Provide ?id= or ?ids= query parameter" },
        400,
      );
    }
  }

  return new Response("Not found", { status: 404, headers: corsHeaders() });
}

const { port, htmlPath, feedsPath, queueDir, pagesDir, feedStateDir } = parseArgs();

await ensureQueueDir(queueDir);
await ensureQueueDir(pagesDir);
await ensureQueueDir(feedStateDir);

Deno.serve({ port }, (req) =>
  handleRequest(req, htmlPath, feedsPath, queueDir, pagesDir, feedStateDir)
);

console.error(`Feedback server listening on http://localhost:${port}`);
console.error(`Queue directory: ${queueDir}`);
console.error(`Pages directory: ${pagesDir}`);
console.error(`Feed state directory: ${feedStateDir}`);
if (htmlPath) {
  console.error(`Serving HTML from: ${htmlPath} (at /)`);
}
if (feedsPath) {
  console.error(`Serving feeds HTML from: ${feedsPath} (at /feeds.html)`);
}
