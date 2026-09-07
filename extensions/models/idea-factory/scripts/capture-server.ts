/**
 * Capture server for the idea factory — serves the kanban board HTML and
 * accepts new thoughts via POST /api/capture.
 *
 * The capture endpoint enqueues the thought by invoking the swamp model method
 * `ingestThought`, then runs the `idea-factory` workflow (classify -> route ->
 * render) so the board reflects the new thought.
 *
 * Usage:
 *   ~/.swamp/deno/deno run --allow-net --allow-read --allow-write --allow-env --allow-run \
 *     scripts/capture-server.ts [--port 8877]
 *
 * Endpoints:
 *   GET  /  — serve the kanban board HTML
 *   POST /api/capture — body {raw: "...", source?: "..."} ; enqueues a thought
 */
import { z } from "npm:zod@4";

const PORT = parseInt(Deno.env.get("IDEA_FACTORY_PORT") ?? "8877");
const BOARD_PATH = Deno.env.get("IDEA_FACTORY_BOARD") ??
  `${Deno.env.get("HOME") ?? "/tmp"}/.swamp/idea-factory/kanban.html`;

const CaptureBodySchema = z.object({
  raw: z.string().min(1),
  source: z.string().optional(),
});

const encoder = new TextEncoder();

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function runSwamp(args: string[]): Promise<{ ok: boolean; output: string }> {
  const cmd = new Deno.Command("swamp", { args, stdout: "piped", stderr: "piped" });
  const { code, stdout, stderr } = await cmd.output();
  const out = new TextDecoder().decode(stdout);
  const err = new TextDecoder().decode(stderr);
  return { ok: code === 0, output: (out + err).trim() || out.trim() };
}

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    try {
      const html = await Deno.readTextFile(BOARD_PATH);
      return new Response(html, { headers: { "content-type": "text/html" } });
    } catch {
      return new Response(
        "<h1>Idea Factory board not generated yet</h1><p>Run: swamp workflow run idea-factory</p>",
        { headers: { "content-type": "text/html" }, status: 200 },
      );
    }
  }

  if (req.method === "POST" && url.pathname === "/api/capture") {
    let parsed;
    try {
      const body = await req.text();
      // Accept both JSON and form-encoded payloads.
      parsed = z.object({
        raw: z.string().min(1),
        source: z.string().optional(),
      }).safeParse(
        req.headers.get("content-type")?.includes("json")
          ? JSON.parse(body)
          : Object.fromEntries(new URLSearchParams(body).entries()),
      );
    } catch {
      return json(400, { ok: false, error: "invalid body" });
    }
    if (!parsed.success) {
      return json(400, { ok: false, error: parsed.error.message });
    }
    const { raw, source } = parsed.data;

    const ingest = await runSwamp([
      "model",
      "method",
      "run",
      "idea-factory",
      "ingestThought",
      "--input",
      `raw=${raw}`,
      ...(source ? ["--input", `source=${source}`] : []),
      "--skip-reports",
    ]);
    if (!ingest.ok) {
      return json(500, { ok: false, error: ingest.output });
    }

    // Classify, route, and re-render the board.
    await runSwamp(["workflow", "run", "idea-factory", "--skip-reports"]);

    return json(200, { ok: true });
  }

  return json(404, { ok: false, error: "not found" });
}

console.log(`Idea factory capture server on http://127.0.0.1:${PORT}`);
Deno.serve({ port: PORT, hostname: "127.0.0.1" }, handler);
