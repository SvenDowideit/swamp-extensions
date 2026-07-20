/**
 * Swamp Explorer backend.
 *
 * Thin REST API that wraps the `swamp` CLI for the current repo. All commands
 * run with `--json` so we can parse structured output. The repo directory is
 * discovered from the environment (SWAMP_REPO_DIR) or defaults to the parent
 * of this project (the swamp repo at /home/sven/src/swamp-project).
 */
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fsSync from "node:fs";

const execFileAsync = promisify(execFile);

const app = express();
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function findRepoDir(start: string): string {
  let dir = start;
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, ".swamp.yaml");
    if (fsSync.existsSync(candidate)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

const REPO_DIR = process.env.SWAMP_REPO_DIR ||
  findRepoDir(path.resolve(__dirname, ".."));
const PORT = parseInt(process.env.PORT || "5174", 10);
const HOST = process.env.HOST || "0.0.0.0";

interface SwampResult<T> {
  stdout: string;
  stderr: string;
  data: T | null;
}

async function swamp<T>(
  args: string[],
  opts: { cwd?: string; timeout?: number } = {},
): Promise<T> {
  const cwd = opts.cwd || REPO_DIR;
  const { stdout, stderr } = await execFileAsync("swamp", args, {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
    timeout: opts.timeout ?? 120_000,
    env: { ...process.env, SWAMP_REPO_DIR: cwd },
  });
  if (!stdout.trim()) return {} as T;
  return JSON.parse(stdout) as T;
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, repoDir: REPO_DIR });
});

// ---- Models ----
app.get("/api/models", async (_req, res) => {
  try {
    const data = await swamp<{ results: unknown[] }>(["model", "list", "--json"]);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/api/models/:name", async (req, res) => {
  try {
    const data = await swamp<unknown>(["model", "get", req.params.name, "--json"]);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/api/types/:type", async (req, res) => {
  try {
    // type may contain @ and /; decode URI component handles it
    const type = decodeURIComponent(req.params.type);
    const data = await swamp<unknown>(["model", "type", "describe", type, "--json"]);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ---- Workflows ----
app.get("/api/workflows", async (_req, res) => {
  try {
    const data = await swamp<{ results: unknown[] }>(["workflow", "list", "--json"]);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/api/workflows/:name", async (req, res) => {
  try {
    const data = await swamp<unknown>(["workflow", "get", req.params.name, "--json"]);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ---- Data ----
app.get("/api/data/:model", async (req, res) => {
  try {
    const data = await swamp<unknown>(["data", "list", req.params.model, "--json"]);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/api/data/:model/:name", async (req, res) => {
  try {
    const args = ["data", "get", req.params.model, req.params.name];
    if (req.query.version !== undefined && req.query.version !== "") {
      args.push("--version", String(req.query.version));
    }
    args.push("--json");
    const data = await swamp<unknown>(args);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ---- Workflow data (latest run) ----
app.get("/api/workflow-data/:name", async (req, res) => {
  try {
    const data = await swamp<unknown>([
      "data", "list", "--workflow", req.params.name, "--json",
    ]);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ---- Runs ----
app.get("/api/runs", async (_req, res) => {
  try {
    const data = await swamp<unknown>(["run", "history", "--json"]);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// Trigger endpoints
// ---------------------------------------------------------------------------

// Run a workflow. Body: { inputs: Record<string, any> }
app.post("/api/runs/workflow/:name", async (req, res) => {
  try {
    const inputs = (req.body?.inputs ?? {}) as Record<string, unknown>;
    const args = ["workflow", "run", req.params.name];
    for (const [key, value] of Object.entries(inputs)) {
      args.push("--input", `${key}=${formatInputValue(value)}`);
    }
    args.push("--json");
    const data = await swamp<unknown>(args, { timeout: 600_000 });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Run a model method. Body: { inputs: Record<string, any> }
// CLI signature: swamp model method run <model_or_type> <method_name> [definition_name]
app.post("/api/runs/method/:model/:method", async (req, res) => {
  try {
    const inputs = (req.body?.inputs ?? {}) as Record<string, unknown>;
    const args = [
      "model", "method", "run", req.params.model, req.params.method,
    ];
    for (const [key, value] of Object.entries(inputs)) {
      args.push("--input", `${key}=${formatInputValue(value)}`);
    }
    args.push("--json");
    const data = await swamp<unknown>(args, { timeout: 600_000 });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

function formatInputValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  // Complex types (arrays, objects) — encode as JSON using the swamp CLI's
  // `key:json=<json>` suffix.
  return `json=${JSON.stringify(value)}`;
}

// ---------------------------------------------------------------------------
// Static + SPA fallback
// ---------------------------------------------------------------------------

// Serve the built SPA if it exists (works regardless of NODE_ENV).
// dist/server/index.js -> ../web resolves to explorer/dist/web (the vite build output).
// In dev mode, run `npm run dev` to start vite on :5173 which proxies /api here.
const staticDir = path.resolve(__dirname, "..", "web");
if (fsSync.existsSync(path.join(staticDir, "index.html"))) {
  app.use(express.static(staticDir));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api")) return next();
    res.sendFile(path.join(staticDir, "index.html"));
  });
} else {
  console.warn(
    `No built SPA found at ${staticDir}. Run \`npm run build:web\` first, or use \`npm run dev\` for development.`,
  );
}

app.listen(PORT, HOST, () => {
  console.log(`swamp-explorer server listening on http://${HOST}:${PORT}`);
  console.log(`  repo: ${REPO_DIR}`);
});