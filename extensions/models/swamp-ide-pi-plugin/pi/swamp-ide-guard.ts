// Managed by @svendowideit/swamp-ide-pi-plugin. Do not edit this installed
// copy by hand; change the bundled source and reinstall with
// `swamp model @svendowideit/swamp-ide-pi-plugin method run install`.
//
// Fail-safe guard for swamp-ide.
//
// This file is installed globally, independent of the project-local addin. It
// reads the per-session marker and, when swamp-ide is enabled, makes `swamp_ide`
// the only active pi tool. If the addin did not register `swamp_ide`, the guard
// restores the baseline tools, records `enforced:false` with a reason, and shows
// "tracking off": a missing tracker must degrade, not lock the person out.

import { existsSync, readdirSync } from "node:fs";
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { guardPlan } from "./swamp-ide-policy.ts";

const MARKER = "Managed by @svendowideit/swamp-ide-pi-plugin";
const EVENT_LOG = process.env.SWAMP_AGENT_IDE_EVENT_LOG ??
  join(homedir(), ".local/state/swamp-agent-ide/events.jsonl");
const GUARD_HEARTBEAT = process.env.SWAMP_AGENT_IDE_GUARD_HEARTBEAT ??
  join(homedir(), ".local/state/swamp-agent-ide/guard.json");
const SESSION_POINTER = join(
  homedir(),
  ".local/state/swamp-agent-ide/pi-session.json",
);
const LOADED_AT = new Date().toISOString();

function markerDirs() {
  const dirs = [join(homedir(), ".pi", "agent", "swamp-ide")];
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    dirs.push(join(dir, ".pi", "swamp-ide"));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirs;
}

function enabled() {
  if (process.env.SWAMP_IDE_FORCE === "1") return true;
  if ((process.env.SWAMP_IDE_MODE ?? "").toLowerCase() === "off") return false;
  const session = currentSessionId();
  if (!session) return false;
  return markerDirs().some((dir) =>
    existsSync(join(dir, `${session}.enabled`))
  );
}

/** Pi does not put PI_SESSION_ID in the extension process; a single enabled
 * marker is unambiguous and lets the workflow's global marker match. */
function currentSessionId() {
  const env = process.env.PI_SESSION_ID ?? "";
  if (env) return env;
  const ids = new Set();
  for (const dir of markerDirs()) {
    try {
      for (const name of readdirSync(dir)) {
        if (name.endsWith(".enabled")) {
          ids.add(name.slice(0, -".enabled".length));
        }
      }
    } catch {
      // no marker directory
    }
  }
  return ids.size === 1 ? [...ids][0] : "";
}

async function appendEvent(event: Record<string, unknown>) {
  try {
    await mkdir(dirname(EVENT_LOG), { recursive: true });
    await appendFile(EVENT_LOG, JSON.stringify(event) + "\n", "utf8");
    const info = await stat(EVENT_LOG);
    if (info.size > 900_000) {
      const text = await readFile(EVENT_LOG, "utf8");
      const lines = text.split(/\r?\n/).filter(Boolean).slice(-1000);
      await writeFile(EVENT_LOG, lines.join("\n") + "\n", "utf8");
    }
  } catch {
    // Tracking is best-effort; the heartbeat is the health signal.
  }
}

async function writeHeartbeat(values: Record<string, unknown>) {
  try {
    await mkdir(dirname(GUARD_HEARTBEAT), { recursive: true });
    await writeFile(
      GUARD_HEARTBEAT,
      JSON.stringify({
        component: "guard",
        loadedAt: LOADED_AT,
        updatedAt: new Date().toISOString(),
        pid: process.pid,
        session: currentSessionId(),
        cwd: process.cwd(),
        ...values,
      }),
      "utf8",
    );
    await writeFile(
      SESSION_POINTER,
      JSON.stringify({
        session: currentSessionId(),
        pid: process.pid,
        cwd: process.cwd(),
        loadedAt: LOADED_AT,
        updatedAt: new Date().toISOString(),
      }),
      "utf8",
    );
  } catch {
    // The panel will show the missing heartbeat.
  }
}

/** Only block bypass tools while swamp_ide is actually the active tool. */
let enforcing = false;

/** Apply the guard and report whether it is enforcing. A missing tracker
 * degrades to the baseline tool set; it never locks the person out. */
function apply(pi: any) {
  const all = typeof pi.getAllTools === "function"
    ? pi.getAllTools().map((tool: { name: string }) => tool.name)
    : [];
  const plan = guardPlan(all);
  let reason = plan.reason;
  enforcing = false;
  if (plan.hasSwampIde) {
    try {
      pi.setActiveTools(plan.activeTools);
      enforcing = true;
    } catch {
      reason = "swamp_ide is registered but the guard could not restrict tools";
    }
  } else if (plan.activeTools.length > 0) {
    try {
      pi.setActiveTools(plan.activeTools);
    } catch {
      reason = `${plan.reason}; could not restore the baseline tool set`;
    }
  }
  const activeTools = typeof pi.getActiveTools === "function"
    ? pi.getActiveTools()
    : [];
  void writeHeartbeat({
    hasSwampIde: plan.hasSwampIde,
    activeTools,
    allTools: all,
    enforced: enforcing,
    reason,
  });
  return { ok: enforcing, hasSwampIde: plan.hasSwampIde, reason };
}

export default function swampIdeGuard(pi: any) {
  // Write the live-session pointer even when the marker is missing. The
  // enable workflow uses it to target this session without asking the user.
  void writeHeartbeat({
    hasSwampIde: false,
    activeTools: [],
    enforced: false,
    reason: "guard loaded; not applied yet",
  });
  if (!enabled()) return;
  const heartbeatTimer = setInterval(() => {
    apply(pi);
  }, 30_000);
  heartbeatTimer.unref?.();

  pi.on("before_agent_start", async (_event: any, ctx: any) => {
    const result = apply(pi);
    if (!result.hasSwampIde) {
      ctx?.ui?.notify(
        `swamp-ide guard: swamp_ide is not loaded; tracking off, tools left enabled. Restart pi after installing the addin. (${result.reason})`,
        "warning",
      );
    } else if (!result.ok) {
      ctx?.ui?.notify(
        `swamp-ide guard: ${result.reason}; tools left enabled.`,
        "warning",
      );
    }
  });

  pi.on("session_start", async () => {
    const result = apply(pi);
    void appendEvent({
      ts: LOADED_AT,
      source: "guard",
      kind: "startup",
      name: "swamp-ide guard",
      route: "guard",
      outcome: result.ok ? "success" : "error",
      detail: result.ok
        ? "swamp_ide registered; enforcing"
        : result.reason,
      session: currentSessionId(),
      cwd: process.cwd(),
      error: result.ok ? "" : result.reason,
    });
  });

  pi.on("tool_call", async (event: any) => {
    // A degraded guard records but does not block: the point of the fallback
    // is that a missing tracker is visible, not that the person is stranded.
    if (!enforcing) return;
    const tool = event.toolName ?? event.tool ?? "unknown";
    if (tool === "swamp_ide") return;
    void appendEvent({
      ts: new Date().toISOString(),
      source: "guard",
      kind: "blocked",
      name: tool,
      route: "blocked",
      outcome: "error",
      detail: "guard blocked a non-swamp_ide tool",
      session: currentSessionId(),
      cwd: process.cwd(),
      error: "swamp-ide guard",
    });
    return {
      block: true,
      reason:
        "swamp-ide guard: only swamp_ide is allowed in an enabled session. Use system=herdr-core for files/search/exec, system=vim for live buffers, or system=swamp model=<instance> for swamp model methods.",
    };
  });
}

// Keep the marker in the file so the installer can safely identify its copy.
void MARKER;
