/**
 * Static HTTP server for the Swamp Pulse pages.
 *
 * Serves the four generated HTML pages from the pulse output directory, with
 * path-traversal protection and a small security header set. Modelled on the
 * news feedback server.
 *
 * Usage:
 *   deno run --allow-net --allow-read --allow-env scripts/pulse-server.ts \
 *     [--port 8899] [--dir ~/.swamp/swamp-pulse]
 *
 * If `deno` is not on your PATH, swamp ships one at ~/.swamp/deno/deno:
 *   ~/.swamp/deno/deno run --allow-net --allow-read --allow-env \
 *     scripts/pulse-server.ts [--port 8899] [--dir ~/.swamp/swamp-pulse]
 *
 * Endpoints:
 *   GET /                 — documentation summary (index.html)
 *   GET /leaderboard.html — activity leaderboard (24h / 7d / month)
 *   GET /changes.html     — commits / changes tour
 *   GET /releases.html    — releases tour
 *   GET /issues.html      — Lab issues tour
 *   GET /healthz          — health check
 *
 * @module
 */

const HOME = Deno.env.get("HOME") ?? "/tmp";

/** Expand a leading `~` to the user's home directory. */
export function expandHome(path: string): string {
  if (path === "~") return HOME;
  if (path.startsWith("~/")) return `${HOME}${path.slice(1)}`;
  return path;
}

const ALLOWED = new Set([
  "/",
  "/index.html",
  "/leaderboard.html",
  "/changes.html",
  "/releases.html",
  "/issues.html",
]);

/** Parse CLI arguments into a `{ port, dir }` config. */
export function parseArgs(args: string[]): { port: number; dir: string } {
  let port = Number(Deno.env.get("PULSE_PORT") ?? "8899");
  let dir = Deno.env.get("PULSE_DIR") ?? `${HOME}/.swamp/swamp-pulse`;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" && i + 1 < args.length) {
      port = parseInt(args[++i], 10);
    } else if (args[i] === "--dir" && i + 1 < args.length) {
      dir = args[++i];
    }
  }
  return { port, dir: expandHome(dir) };
}

/** Map a request pathname to an allowlisted filename, or null. */
export function resolvePage(pathname: string): string | null {
  if (!ALLOWED.has(pathname)) return null;
  return pathname === "/" || pathname === "/index.html"
    ? "index.html"
    : pathname.slice(1);
}

if (import.meta.main) {
  const { port, dir } = parseArgs(Deno.args);

  Deno.serve({ port }, async (req) => {
    const url = new URL(req.url);

    if (url.pathname === "/healthz") {
      return new Response("ok", {
        headers: { "content-type": "text/plain" },
      });
    }

    const filename = resolvePage(url.pathname);
    if (!filename) {
      return new Response("Not found", { status: 404 });
    }

    try {
      const html = await Deno.readTextFile(`${dir}/${filename}`);
      return new Response(html, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
        },
      });
    } catch {
      return new Response(
        `Page not generated yet: ${filename}. Run the swamp-pulse workflow.`,
        { status: 404, headers: { "content-type": "text/plain" } },
      );
    }
  });

  console.error(`Swamp Pulse server listening on http://localhost:${port}`);
  console.error(`Serving pages from ${dir}`);
}
