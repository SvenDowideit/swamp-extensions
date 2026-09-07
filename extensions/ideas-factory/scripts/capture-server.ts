/**
 * Capture server for the idea factory — serves the kanban board HTML and
 * exposes the actions the board needs: capture, cluster, revert, modify, answer.
 *
 * Each action invokes a swamp model method, re-renders the board, and (for
 * browser form posts) redirects back to / so the page refreshes.
 *
 * Usage:
 *   ~/.swamp/deno/deno run --allow-net --allow-read --allow-write --allow-env --allow-run \
 *     scripts/capture-server.ts
 *
 * Endpoints:
 *   GET  /               — serve the kanban board HTML
 *   POST /api/capture    — {raw, source?} ; ingest a thought + run the workflow
 *   POST /api/cluster    — {userPrompt?} ; cluster thoughts into ideas (LLM)
 *   POST /api/revert     — {actionId} ; revert an action
 *   POST /api/modify     — {actionId, body?} ; modify an idea's body
 *   POST /api/answer     — {questionId, answer} ; answer an LLM question
 *   POST /api/plan       — {ideaId, userPrompt?} ; plan an idea (Phase 2)
 *   POST /api/plan-feedback — {ideaId, phase?, feedback} ; refine an idea from plan feedback
 */
const PORT = parseInt(Deno.env.get("IDEA_FACTORY_PORT") ?? "8877");
const BOARD_PATH = Deno.env.get("IDEA_FACTORY_BOARD") ??
  `${Deno.env.get("HOME") ?? "/tmp"}/.swamp/ideas-factory/kanban.html`;

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function runSwamp(
  args: string[],
): Promise<{ ok: boolean; output: string }> {
  const cmd = new Deno.Command("swamp", {
    args,
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await cmd.output();
  const out = new TextDecoder().decode(stdout);
  const err = new TextDecoder().decode(stderr);
  return { ok: code === 0, output: (out + err).trim() || out.trim() };
}

/** Run a model method on the ideas-factory instance. */
function runMethod(method: string, inputs: Record<string, string>) {
  const args = ["model", "method", "run", "ideas-factory", method];
  for (const [k, v] of Object.entries(inputs)) {
    if (v !== undefined && v !== "") args.push("--input", `${k}=${v}`);
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
    "ideas-factory",
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

/** Redirect a browser form POST back to the board; JSON callers get JSON. */
function respond(
  req: Request,
  ok: boolean,
  extra: Record<string, unknown> = {},
) {
  const contentType = (req.headers.get("content-type") ?? "").toLowerCase();
  if (contentType.includes("application/x-www-form-urlencoded")) {
    return new Response(null, { status: 303, headers: { location: "/" } });
  }
  return json(ok ? 200 : 500, { ok, ...extra });
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
        "<h1>Idea Factory board not generated yet</h1><p>Run: swamp workflow run @svendowideit/ideas-factory</p>",
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
    const ingest = await runMethod("ingestThought", {
      raw,
      ...(body.source ? { source: body.source } : {}),
    });
    if (!ingest.ok) return respond(req, false, { error: ingest.output });
    await runSwamp([
      "workflow",
      "run",
      "@svendowideit/ideas-factory",
      "--input",
      `boardPath=${BOARD_PATH}`,
      "--skip-reports",
    ]);
    return respond(req, true);
  }

  if (url.pathname === "/api/cluster") {
    const r = await runMethod("clusterThoughts", {
      ...(body.userPrompt ? { userPrompt: body.userPrompt } : {}),
    });
    if (!r.ok) return respond(req, false, { error: r.output });
    await renderBoard();
    return respond(req, true);
  }

  if (url.pathname === "/api/revert") {
    if (!body.actionId) {
      return json(400, { ok: false, error: "actionId required" });
    }
    const r = await runMethod("revertAction", { actionId: body.actionId });
    if (!r.ok) return respond(req, false, { error: r.output });
    await renderBoard();
    return respond(req, true);
  }

  if (url.pathname === "/api/modify") {
    if (!body.actionId) {
      return json(400, { ok: false, error: "actionId required" });
    }
    const r = await runMethod("modifyAction", {
      actionId: body.actionId,
      ...(body.body ? { body: body.body } : {}),
    });
    if (!r.ok) return respond(req, false, { error: r.output });
    await renderBoard();
    return respond(req, true);
  }

  if (url.pathname === "/api/answer") {
    if (!body.questionId || !body.answer) {
      return json(400, { ok: false, error: "questionId and answer required" });
    }
    const r = await runMethod("answerQuestion", {
      questionId: body.questionId,
      answer: body.answer,
    });
    if (!r.ok) return respond(req, false, { error: r.output });
    await renderBoard();
    return respond(req, true);
  }

  if (url.pathname === "/api/dismiss-question") {
    if (!body.questionId) {
      return json(400, { ok: false, error: "questionId required" });
    }
    const r = await runMethod("dismissQuestion", {
      questionId: body.questionId,
    });
    if (!r.ok) return respond(req, false, { error: r.output });
    await renderBoard();
    return respond(req, true);
  }

  if (url.pathname === "/api/plan") {
    if (!body.ideaId) return json(400, { ok: false, error: "ideaId required" });
    const r = await runMethod("planIdea", {
      ideaId: body.ideaId,
      ...(body.userPrompt ? { userPrompt: body.userPrompt } : {}),
    });
    if (!r.ok) return respond(req, false, { error: r.output });
    await renderBoard();
    return respond(req, true);
  }

  if (url.pathname === "/api/plan-feedback") {
    if (!body.ideaId || !body.feedback) {
      return json(400, { ok: false, error: "ideaId and feedback required" });
    }
    const r = await runMethod("planFeedback", {
      ideaId: body.ideaId,
      feedback: body.feedback,
      ...(body.phase ? { phase: body.phase } : {}),
    });
    if (!r.ok) return respond(req, false, { error: r.output });
    await renderBoard();
    return respond(req, true);
  }

  if (url.pathname === "/api/set-target") {
    if (!body.ideaId || !body.type) {
      return json(400, { ok: false, error: "ideaId and type required" });
    }
    const r = await runMethod("setTarget", {
      ideaId: body.ideaId,
      type: body.type,
      ...(body.path ? { path: body.path } : {}),
      ...(body.url ? { url: body.url } : {}),
      ...(body.language ? { language: body.language } : {}),
      ...(body.structure ? { structure: body.structure } : {}),
    });
    if (!r.ok) return respond(req, false, { error: r.output });
    await renderBoard();
    return respond(req, true);
  }

  return json(404, { ok: false, error: "not found" });
}

console.log(`Idea factory capture server on http://127.0.0.1:${PORT}`);
Deno.serve({ port: PORT, hostname: "127.0.0.1" }, handler);
