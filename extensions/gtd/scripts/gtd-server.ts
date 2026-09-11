/**
 * GTD API service — serves the responsive GTD board HTML and exposes the
 * htmx endpoints the board needs: capture, clarify, complete, defer, revert,
 * engage, and the daily/weekly reviews.
 *
 * Each action runs a swamp model method, re-renders the board, and returns the
 * HTML fragment for the target column so htmx can swap it in place (no full
 * page reload).
 *
 * Usage:
 *   ~/.swamp/deno/deno run --allow-net --allow-read --allow-write --allow-env --allow-run \
 *     scripts/gtd-server.ts
 *
 * Endpoints:
 *   GET  /               — serve the GTD board HTML
 *   POST /api/capture    — {raw, source?} ; capture into the inbox
 *   POST /api/clarify    — {itemId?, kind?, context?, priority?, due?, delegatee?, when?, area?}
 *   POST /api/complete    — {itemId, list}
 *   POST /api/defer      — {itemId, when?}
 *   POST /api/revert     — {itemId, list}
 *   POST /api/engage     — {context?, time?, energy?, limit?}
 *   POST /api/weekly-review
 *   POST /api/daily-review
 */
const PORT = parseInt(Deno.env.get("GTD_PORT") ?? "8878");
const BOARD_PATH = Deno.env.get("GTD_BOARD") ??
  `${Deno.env.get("HOME") ?? "/tmp"}/.swamp/gtd/board.html`;

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function runSwamp(
  args: string[],
): Promise<{ ok: boolean; output: string }> {
  const cmd = new Deno.Command(await swampBin(), {
    args,
    cwd: repoDir(),
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await cmd.output();
  const out = new TextDecoder().decode(stdout);
  const err = new TextDecoder().decode(stderr);
  return { ok: code === 0, output: (out + err).trim() || out.trim() };
}

/**
 * Resolve the repo root from this script's own location. The script lives at
 * <repo>/extensions/gtd/scripts/gtd-server.ts, so the repo is three levels up.
 * Running `swamp` from the repo root is required — swamp resolves the repo from
 * the current directory, and a systemd service may start in an unrelated cwd.
 */
function repoDir(): string {
  return new URL("../../..", import.meta.url).pathname;
}

/** Resolve the absolute path to the `swamp` binary (systemd PATH may be minimal). */
async function swampBin(): Promise<string> {
  try {
    const which = new Deno.Command("which", { args: ["swamp"] });
    const out = await which.output();
    if (out.code === 0) {
      const p = new TextDecoder().decode(out.stdout).trim();
      if (p) return p;
    }
  } catch {
    // fall through
  }
  return `${Deno.env.get("HOME") ?? "/tmp"}/.local/bin/swamp`;
}

/** Run a model method on the gtd instance. */
function runMethod(method: string, inputs: Record<string, string>) {
  const args = ["model", "method", "run", "gtd", method];
  for (const [k, v] of Object.entries(inputs)) {
    if (v !== undefined && v !== "") {
      // Values starting with @ are read as file paths by the CLI; escape them.
      const val = v.startsWith("@") ? `\\${v}` : v;
      args.push("--input", `${k}=${val}`);
    }
  }
  args.push("--skip-reports");
  return runSwamp(args);
}

/** Re-render the board to the path we serve. */
function renderBoard() {
  return runSwamp([
    "model",
    "method",
    "run",
    "gtd",
    "renderBoard",
    "--input",
    `path=${BOARD_PATH}`,
    "--skip-reports",
  ]);
}

/** Parse a form-encoded or JSON body into a record. */
async function parseBody(req: Request): Promise<Record<string, string> | null> {
  const contentType = (req.headers.get("content-type") ?? "").toLowerCase();
  const body = await req.text();
  try {
    if (contentType.includes("json")) {
      const o = JSON.parse(body);
      return Object.fromEntries(
        Object.entries(o).map(([k, v]) => [k, String(v)]),
      );
    }
    return Object.fromEntries(new URLSearchParams(body).entries());
  } catch {
    return null;
  }
}

/** Extract a top-level element with the given id (section or div) from the board. */
function extractFragment(html: string, id: string): string | null {
  if (id === "board-container") {
    // The container is the last element before <script>; match greedily so
    // nested sections/divs are all captured.
    const m = html.match(
      /<div id="board-container">[\s\S]*<\/div>(?=\s*<script>)/,
    );
    return m ? m[0] : null;
  }
  const re = new RegExp(
    `<(?:section|div) id="${id}"[^>]*>[\\s\\S]*?<\\/(?:section|div)>`,
  );
  const m = html.match(re);
  return m ? m[0] : null;
}

/** Run an action, re-render, and return the full board container for htmx. */
async function act(
  method: string,
  inputs: Record<string, string>,
): Promise<Response> {
  const r = await runMethod(method, inputs);
  if (!r.ok) return json(500, { ok: false, error: r.output });
  await renderBoard();
  const html = await Deno.readTextFile(BOARD_PATH).catch(() => "");
  const frag = extractFragment(html, "board-container");
  if (!frag) return json(500, { ok: false, error: "fragment not found" });
  return new Response(frag, { headers: { "content-type": "text/html" } });
}

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);

  if (
    req.method === "GET" &&
    (url.pathname === "/" || url.pathname === "/index.html")
  ) {
    try {
      const html = await Deno.readTextFile(BOARD_PATH);
      return new Response(html, { headers: { "content-type": "text/html" } });
    } catch {
      return new Response(
        "<h1>GTD board not generated yet</h1><p>Run: swamp workflow run @svendowideit/gtd</p>",
        { headers: { "content-type": "text/html" }, status: 200 },
      );
    }
  }

  if (req.method !== "POST") {
    return json(404, { ok: false, error: "not found" });
  }

  const body = await parseBody(req);
  if (body === null) return json(400, { ok: false, error: "invalid body" });

  if (url.pathname === "/api/capture") {
    const raw = body.raw ?? "";
    if (!raw) return json(400, { ok: false, error: "raw is required" });
    return act("capture", {
      raw,
      ...(body.source ? { source: body.source } : {}),
    });
  }

  if (url.pathname === "/api/clarify") {
    return act("clarify", {
      ...(body.itemId ? { itemId: body.itemId } : {}),
      ...(body.kind ? { kind: body.kind } : {}),
      ...(body.context ? { context: body.context } : {}),
      ...(body.priority ? { priority: body.priority } : {}),
      ...(body.due ? { due: body.due } : {}),
      ...(body.delegatee ? { delegatee: body.delegatee } : {}),
      ...(body.when ? { when: body.when } : {}),
      ...(body.area ? { area: body.area } : {}),
    });
  }

  if (url.pathname === "/api/complete") {
    if (!body.itemId || !body.list) {
      return json(400, { ok: false, error: "itemId and list required" });
    }
    return act("complete", { itemId: body.itemId, list: body.list });
  }

  if (url.pathname === "/api/defer") {
    if (!body.itemId) return json(400, { ok: false, error: "itemId required" });
    return act("defer", {
      itemId: body.itemId,
      ...(body.when ? { when: body.when } : {}),
    });
  }

  if (url.pathname === "/api/revert") {
    if (!body.itemId || !body.list) {
      return json(400, { ok: false, error: "itemId and list required" });
    }
    return act("revert", { itemId: body.itemId, list: body.list });
  }

  if (url.pathname === "/api/engage") {
    return act("engage", {
      ...(body.context ? { context: body.context } : {}),
      ...(body.time ? { time: body.time } : {}),
      ...(body.energy ? { energy: body.energy } : {}),
      ...(body.limit ? { limit: body.limit } : {}),
    });
  }

  if (url.pathname === "/api/weekly-review") {
    return act("weeklyReview", {});
  }

  if (url.pathname === "/api/daily-review") {
    return act("dailyReview", {});
  }

  return json(404, { ok: false, error: "not found" });
}

console.log(`GTD server on http://127.0.0.1:${PORT}`);
Deno.serve({ port: PORT, hostname: "127.0.0.1" }, handler);
