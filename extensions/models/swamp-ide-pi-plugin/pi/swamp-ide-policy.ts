// Managed by @svendowideit/swamp-ide-pi-plugin. Do not edit this installed
// copy by hand; change the bundled source and reinstall with
// `swamp model @svendowideit/swamp-ide-pi-plugin method run install`.
//
/**
 * Pure policy for the swamp-ide capability gate.
 *
 * The addin must not be able to change the addin, guard, markers, Herdr
 * panels/layouts, state directory or the swamp-ide extension source without a
 * human-created lease. This module is deliberately pure so it can be tested
 * without pi or a live session.
 */

export interface CallInfo {
  system: string;
  method: string;
  model?: string;
  input?: Record<string, unknown>;
  cwd?: string;
  home?: string;
  /** Canonical path for file-* calls, when the addin could resolve it. */
  canonicalPath?: string;
  /** Hash of exact argv+cwd for exec/run. */
  commandHash?: string;
}

export interface Decision {
  mutating: boolean;
  scope: string;
  reason: string;
}

export interface GuardPlan {
  hasSwampIde: boolean;
  enforcing: boolean;
  /** Tools to activate. Empty means "leave the current set alone". */
  activeTools: string[];
  reason: string;
}

/**
 * Decide what the guard should do with the tool set.
 *
 * A missing tracker must degrade, never lock the person out: when `swamp_ide`
 * is not registered the guard restores the baseline tool set and stops
 * enforcing. `activeTools` is empty when there is nothing safe to restore, so
 * the caller does not call `setActiveTools([])` and strand the session.
 */
export function guardPlan(allTools: string[]): GuardPlan {
  const tools = Array.isArray(allTools)
    ? allTools.filter((name) => typeof name === "string" && name.length > 0)
    : [];
  if (tools.includes("swamp_ide")) {
    return {
      hasSwampIde: true,
      enforcing: true,
      activeTools: ["swamp_ide"],
      reason: "swamp_ide registered",
    };
  }
  return {
    hasSwampIde: false,
    enforcing: false,
    activeTools: tools,
    reason:
      "swamp_ide is not registered; tracking off, baseline tools left enabled",
  };
}

export interface Lease {
  session?: string;
  scope?: string;
  scopes?: string[];
  scopeExpiry?: Record<string, string>;
  features?: Record<
    string,
    {
      scopes?: string[];
      expiresAt?: string;
      untilRevoked?: boolean;
      session?: string;
      purpose?: string;
      risk?: string;
    }
  >;
  issuedAt?: string;
  expiresAt?: string;
}

const SHELL_WRAPPERS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

/** A shell wrapper hides the real command from the approval dialog. */
export function isShellWrapper(argv: unknown): boolean {
  if (!Array.isArray(argv) || argv.length < 2) return false;
  const command = String(argv[0] ?? "").split("/").pop() ?? "";
  return SHELL_WRAPPERS.has(command) && String(argv[1] ?? "") === "-c";
}

export interface CommandAlternative {
  program: string;
  system: "herdr-core" | "vim" | "swamp";
  method: string;
  reason: string;
}

/**
 * Commands that should normally be replaced by a swamp_ide method. Add a new
 * entry here when a new internal tool covers another command; the approval
 * dialog and policy tests pick it up automatically.
 */
const COMMAND_ALTERNATIVES: Record<
  string,
  Omit<CommandAlternative, "program">
> = {
  rg: {
    system: "herdr-core",
    method: "search",
    reason: "search files without spawning a process",
  },
  grep: {
    system: "herdr-core",
    method: "search",
    reason: "search files without spawning a process",
  },
  find: {
    system: "herdr-core",
    method: "search",
    reason: "search files without spawning a process",
  },
  fd: {
    system: "herdr-core",
    method: "search",
    reason: "search files without spawning a process",
  },
  cat: {
    system: "herdr-core",
    method: "file-read",
    reason: "read file identity and content through swamp data",
  },
  head: {
    system: "herdr-core",
    method: "file-read",
    reason: "read file identity and content through swamp data",
  },
  tail: {
    system: "herdr-core",
    method: "file-read",
    reason: "read file identity and content through swamp data",
  },
  sed: {
    system: "herdr-core",
    method: "file-edit",
    reason: "apply an exact-once edit and return a diff",
  },
  awk: {
    system: "herdr-core",
    method: "file-edit",
    reason: "apply an exact-once edit and return a diff",
  },
};

/** Native method alternatives for a command's first executable. */
export function commandAlternatives(argv: unknown): CommandAlternative[] {
  if (!Array.isArray(argv) || argv.length === 0) return [];
  const program = String(argv[0] ?? "").split("/").pop() ?? "";
  const entry = COMMAND_ALTERNATIVES[program];
  return entry ? [{ program, ...entry }] : [];
}

const BROAD_SCOPES = new Set([
  "all",
  "protected",
  "file-edit",
  "file-write",
  "file-edit-lines",
  "exec",
  "run",
  "exec:unhashed",
  "run:unhashed",
  "send",
  "keys",
  "interrupt",
  "kill",
  "rm",
  "put",
  "vim:edit",
  "vim:write",
  "vim:command",
]);

/** A scope that does not name the actual target is too broad to approve. */
export function isBroadScope(scope: string): boolean {
  const value = String(scope ?? "");
  return BROAD_SCOPES.has(value) || value === "dir:" || value === "dir:/";
}

/**
 * Whether a granted scope covers a requested scope. Exact scopes match
 * themselves. A `dir:<directory>` grant covers `file:<path>` only when the
 * file is inside that directory; it never covers the filesystem root.
 */
export function scopeCovers(granted: string, requested: string): boolean {
  const grant = String(granted ?? "");
  const want = String(requested ?? "");
  if (!grant || !want) return false;
  if (grant === want) return true;
  if (!grant.startsWith("dir:")) return false;
  const prefix = want.startsWith("file:")
    ? "file:"
    : want.startsWith("protected:")
    ? "protected:"
    : "";
  if (!prefix) return false;
  const directory = grant.slice("dir:".length).replace(/\\/g, "/").replace(
    /\/+$/,
    "",
  );
  const file = want.slice(prefix.length).replace(/\\/g, "/");
  if (!directory || directory === "/" || !file) return false;
  return file.startsWith(`${directory}/`);
}

const WRITE_METHODS = new Set([
  "file-write",
  "file-edit",
  "file-edit-lines",
]);

/** Write methods take one `path`; `paths` is only for file-read/search. */
export function writeInputProblem(
  system: string,
  method: string,
  input: Record<string, unknown> | undefined,
): string {
  if (system !== "herdr-core" || !WRITE_METHODS.has(method)) return "";
  const hasPath = typeof input?.path === "string" &&
    String(input.path).trim().length > 0;
  const hasPaths = Array.isArray(input?.paths);
  if (hasPath && hasPaths) {
    return "write methods take a single `path`, not both `path` and `paths`";
  }
  if (hasPaths) {
    return `write methods take a single \`path\`; \`paths\` is only for file-read/search. Call ${method} once per file.`;
  }
  if (!hasPath) {
    return `write methods require a single \`path\`; \`paths\` is only for file-read/search`;
  }
  return "";
}

export interface Authorization {
  status: "allowed" | "not-required" | "blocked";
  scope: string;
  via: "read-only" | "lease" | "dialog" | "none";
  feature?: string;
  expiresAt?: string;
  approval?: "approve" | "deny" | "fallback" | "explain" | "timeout" | "unavailable" | "cancelled" | "too-broad" | "use-tool" | null;
  reason: string;
}

/** The named feature that covers a scope, if one does. */
export function matchingFeature(
  lease: Lease | null,
  scope: string,
): { name: string; expiresAt: string } | null {
  let best: { name: string; expiresAt: string } | null = null;
  let bestTime = -Infinity;
  for (const [name, feature] of Object.entries(lease?.features ?? {})) {
    if (
      !Array.isArray(feature.scopes) ||
      !feature.scopes.some((granted) => scopeCovers(granted, scope))
    ) continue;
    const expiresAt = String(feature.expiresAt ?? "");
    const time = Date.parse(expiresAt);
    if (time > bestTime) {
      best = { name, expiresAt };
      bestTime = time;
    }
  }
  return best;
}

/** Build the structured authorization record from a lease that allowed the call. */
export function authorizationFromLease(
  lease: Lease | null,
  scope: string,
  via: "lease" | "dialog",
  approval: Authorization["approval"] = null,
): Authorization {
  const feature = matchingFeature(lease, scope);
  return {
    status: "allowed",
    scope,
    via,
    feature: feature?.name,
    expiresAt: feature?.expiresAt ||
      lease?.scopeExpiry?.[scope] || lease?.expiresAt || "",
    approval,
    reason: via === "dialog"
      ? "approval accepted and lease written"
      : "exact scope already covered",
  };
}

export function blockedAuthorization(
  scope: string,
  approval: Authorization["approval"],
  reason: string,
): Authorization {
  return { status: "blocked", scope, via: "none", approval, reason };
}

export function notRequiredAuthorization(reason: string): Authorization {
  return {
    status: "not-required",
    scope: "",
    via: "read-only",
    approval: null,
    reason,
  };
}

function cleanReason(reason: string): string {
  return String(reason ?? "").replace(/\s+/g, " ").replace(/\.$/, "");
}

function expiryLabel(expiresAt: string | undefined): string {
  if (!expiresAt) return "";
  if (String(expiresAt).startsWith("2099")) return "until revoked";
  return `expires ${expiresAt}`;
}

/** Fixed, human-readable output. The addin includes this verbatim. */
export function formatAuthorization(auth: Authorization): string {
  const reason = cleanReason(auth.reason);
  if (auth.status === "not-required") {
    return `Authorization: not required; ${reason}.`;
  }
  if (auth.status === "allowed") {
    const feature = auth.feature ? ` \`${auth.feature}\`` : "";
    const expiry = expiryLabel(auth.expiresAt);
    const when = expiry ? ` (${expiry})` : "";
    if (auth.via === "dialog") {
      return `Authorization: allowed because you approved the Herdr dialog; a lease now covers this exact scope${feature}${when}.`;
    }
    return `Authorization: allowed by existing lease${feature}${when}; this exact scope was already covered.`;
  }
  return `Authorization: blocked; ${reason}.`;
}

const READ_ONLY_HERDR = new Set([
  "status",
  "terminals",
  "read",
  "wait",
  "search",
  "file-read",
  "machines",
  "otel-status",
]);

const READ_ONLY_VIM = new Set([
  "servers",
  "status",
  "read",
  "diagnostics",
  "diff",
]);

/** Protected paths: the addin/guard, its markers/state, Herdr UI, and the
 * swamp-ide extension sources. */
export function isProtectedPath(path: string, home: string): boolean {
  const p = String(path ?? "").replace(/\\/g, "/");
  const h = String(home ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  if (!p) return false;
  const roots = [
    `${h}/.pi/`,
    `${h}/.config/herdr-app/mods/`,
    `${h}/.config/herdr-app/layouts/`,
    `${h}/.local/state/swamp-agent-ide/`,
  ];
  if (roots.some((root) => p === root.slice(0, -1) || p.startsWith(root))) {
    return true;
  }
  return /\/extensions\/models\/swamp-ide(?:-[^/]+)?(?:\/|$)/.test(p) ||
    /\/\.pi\/extensions\//.test(p) ||
    /\/\.pi\/swamp-ide\//.test(p);
}

/** Classify a swamp_ide call without performing it. */
export function classifyCall(info: CallInfo): Decision {
  const system = String(info.system ?? "");
  const method = String(info.method ?? "");
  const input = info.input ?? {};
  const home = info.home ?? "";
  const cwd = info.cwd ?? process.cwd();

  if (system === "herdr-core") {
    if (READ_ONLY_HERDR.has(method)) {
      return { mutating: false, scope: "", reason: "read-only herdr-core call" };
    }
    if (method === "file-write" || method === "file-edit" || method === "file-edit-lines") {
      const raw = String(input.path ?? "");
      const path = info.canonicalPath || raw;
      if (isProtectedPath(path, home)) {
        return {
          mutating: true,
          scope: `protected:${path}`,
          reason: `write to protected path ${path}`,
        };
      }
      return {
        mutating: true,
        scope: path ? `file:${path}` : method,
        reason: path
          ? `edit exactly ${path}`
          : `mutating ${method} without a resolved file path`,
      };
    }
    return {
      mutating: true,
      scope: method === "exec"
        ? `exec:${info.commandHash ?? "unhashed"}`
        : method === "run"
        ? `run:${info.commandHash ?? "unhashed"}`
        : method,
      reason: `mutating herdr-core ${method}`,
    };
  }

  if (system === "vim") {
    if (READ_ONLY_VIM.has(method)) {
      return { mutating: false, scope: "", reason: "read-only vim call" };
    }
    return {
      mutating: true,
      scope: `vim:${method}`,
      reason: `mutating vim ${method}`,
    };
  }

  if (system === "swamp") {
    if (method === "status") {
      return { mutating: false, scope: "", reason: "read-only swamp status" };
    }
    const model = String(info.model ?? "");
    return {
      mutating: true,
      scope: `swamp:${model}.${method}`,
      reason: `mutating swamp method ${model}.${method}`,
    };
  }

  return {
    mutating: true,
    scope: `system:${system || "unknown"}`,
    reason: `unknown system ${system || "unknown"}`,
  };
}

/** A lease is valid only for the matching session, exact scope (or all), and
 * before expiry. `protected` is a deliberate broad grant for protected paths. */
export function leaseAllows(
  lease: Lease | null,
  scope: string,
  session?: string,
  now = Date.now(),
): boolean {
  if (!lease || !scope) return false;
  let expiry = lease.scopeExpiry?.[scope] ?? lease.expiresAt;
  const matching = Object.values(lease.features ?? {}).filter((feature) =>
    Array.isArray(feature.scopes) &&
    feature.scopes.some((granted) => scopeCovers(granted, scope))
  );
  if (matching.length > 0) {
    let best = null;
    let bestTime = -Infinity;
    for (const feature of matching) {
      const featureSession = String(feature.session ?? "");
      if (session && featureSession && featureSession !== session) continue;
      if (
        session && !featureSession && lease.session &&
        lease.session !== session
      ) continue;
      const candidate = String(feature.expiresAt ?? "");
      const time = Date.parse(candidate);
      if (time > bestTime) {
        best = feature;
        bestTime = time;
      }
    }
    if (!best) return false;
    expiry = best.expiresAt ?? expiry;
  } else if (lease.session && session && lease.session !== session) {
    return false;
  }
  const expires = Date.parse(String(expiry ?? ""));
  if (!isFinite(expires) || expires <= now) return false;
  const scopes = Array.isArray(lease.scopes) && lease.scopes.length > 0
    ? lease.scopes
    : [String(lease.scope ?? "")];
  if (scopes.includes("all")) return true;
  return scopes.some((granted) => scopeCovers(String(granted), scope));
}

/**
 * Pi auto-discovers every `extensions/*.ts` file as an extension and refuses to
 * load a module whose default export is not a factory function ("Extension
 * does not export a valid factory function"). This module is a library: it
 * must sit beside the addin and the guard, which import the helpers above by
 * name. The inert factory below only satisfies pi's loader, so the addin
 * keeps loading; it registers no hooks, tools or commands of its own.
 */
export default function swampIdePolicyLibrary(): void {
  // Intentionally empty. The addin and the guard import named helpers.
}

/** The minimum of an activity event these helpers read. */
export interface ActivityEvent {
  ts?: string;
  via?: string;
  reason?: string;
  route?: string;
  outcome?: string;
  durationMs?: number;
  name?: string;
  model?: string;
  method?: string;
  target?: string;
  kind?: string;
  error?: string;
}

/**
 * How a call reached swamp: `ws` for the serve socket, `cli` for a spawned
 * swamp process, `herdr-core`/`vim`/`guard`/`bypass` for the other routes, and
 * `none` for an event with neither field — the shape written before `via`
 * existed, where `route: "swamp"` cannot tell the two apart.
 */
export function activityVia(event: ActivityEvent): string {
  const via = String(event?.via ?? "").trim().toLowerCase();
  if (via) return via;
  const route = String(event?.route ?? "").trim().toLowerCase();
  if (
    route === "herdr-core" || route === "vim" || route === "guard" ||
    route === "bypass"
  ) {
    return route;
  }
  return "none";
}

/** What the call was: `model.method`, a tool and its method, or a plain name. */
export function activityTarget(event: ActivityEvent): string {
  const model = String(event?.model ?? "").trim();
  const method = String(event?.method ?? "").trim();
  const name = String(event?.name ?? "").trim();
  if (model && model !== "pi" && method) return `${model}.${method}`;
  if (name && method && name !== method) return `${name} ${method}`;
  if (name) return name;
  return String(event?.target ?? "").trim() || "?";
}

/**
 * One line per activity event, for the panel and `/swamp-ide log`:
 * `12:47:31  ws   data.query  ok     0.8s`. A `cli` line carries the reason it
 * could not use the socket; an `error` line carries the error.
 */
export function formatActivityLine(event: ActivityEvent): string {
  const time = String(event?.ts ?? "").slice(11, 19) || "--:--:--";
  const via = activityVia(event);
  const target = activityTarget(event).slice(0, 28).padEnd(28);
  const failed = String(event?.outcome ?? "").trim() === "error";
  const outcome = (failed ? "error" : "ok").padEnd(5);
  const ms = Number(event?.durationMs ?? 0);
  const duration = (ms > 0 ? `${(ms / 1000).toFixed(1)}s` : "-").padStart(6);
  const note = failed
    ? String(event?.error ?? "").split("\n")[0].slice(0, 40)
    : via === "cli"
    ? String(event?.reason ?? "").slice(0, 40)
    : "";
  return [time, via.padEnd(10), target, outcome, duration, note]
    .filter((part) => part.trim() !== "")
    .join(" ");
}

/** Count `ws` against `cli` over the events, collecting why the cli ones fell back. */
export function activitySummary(events: ActivityEvent[]): {
  total: number;
  ws: number;
  cli: number;
  other: number;
  reasons: string[];
} {
  let ws = 0;
  let cli = 0;
  let other = 0;
  const reasons = new Set<string>();
  for (const event of events ?? []) {
    const via = activityVia(event);
    if (via === "ws") {
      ws += 1;
    } else if (via === "cli") {
      cli += 1;
      const reason = String(event?.reason ?? "").trim();
      if (reason) reasons.add(reason);
    } else {
      other += 1;
    }
  }
  return {
    total: (events ?? []).length,
    ws,
    cli,
    other,
    reasons: [...reasons].sort(),
  };
}

/** `activity 42 · ws 38 · cli 4 (extension.fmt, workflow.validate)` */
export function formatActivitySummary(events: ActivityEvent[]): string {
  const summary = activitySummary(events);
  const reasons = summary.reasons.length
    ? ` (${summary.reasons.join(", ")})`
    : "";
  return `activity ${summary.total} · ws ${summary.ws} · cli ${summary.cli}${reasons}`;
}

/** Extensions Vim should not be asked to open: binary buffers mangle. */
const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "pdf", "zip", "gz", "tgz",
  "bz2", "xz", "7z", "tar", "jar", "wasm", "so", "dylib", "dll", "exe", "o", "a",
  "pyc", "class", "mp3", "mp4", "mov", "mkv", "wav", "flac", "ogg", "woff",
  "woff2", "ttf", "otf", "db", "sqlite", "sqlite3",
]);

/**
 * Map a herdr-core file mutation to one `editFile` call on this space's editor.
 *
 * Returns null when the call must stay on herdr-core: a remote `machine`, a
 * binary-ish path, content holding a NUL byte, or a method that is not a text
 * write. Null is not a silent pass-through - the caller records why.
 */
export function vimEditInputs(
  system: string,
  method: string,
  input: Record<string, unknown> | undefined,
  cwd: string,
  terminal = "",
  parentExists: (folder: string) => boolean = () => true,
): { inputs: Record<string, unknown>; fallback: string } | null {
  if (system !== "herdr-core") return null;
  if (method !== "file-write" && method !== "file-edit" &&
    method !== "file-edit-lines") {
    return null;
  }
  const args = input ?? {};
  if (String(args.machine ?? "").trim()) {
    return null;
  }
  const path = String(args.path ?? "").trim();
  if (!path) return null;
  // The editor buffer cannot create a folder: with a missing directory the
  // write fails, and herdr-core's file-write makes missing folders. The check
  // is injected so this stays pure and a regression is testable.
  const baseDir = String(args.cwd ?? "") || cwd;
  const cut = path.lastIndexOf("/");
  const parent = cut > 0 ? path.slice(0, cut) : "";
  const folder = !parent
    ? baseDir
    : parent.startsWith("/")
    ? parent
    : `${baseDir}/${parent}`;
  if (folder && !parentExists(folder)) {
    return { inputs: {}, fallback: "parent directory missing" };
  }
  // The caller's terminal travels with the request: a method run inside swamp
  // serve has no HC_TERMINAL_ID, so it cannot resolve the caller's space alone.
  const base = {
    file: path,
    cwd: String(args.cwd ?? "") || cwd,
    force: true,
    ...(String(terminal ?? "").trim() ? { terminal: String(terminal).trim() } : {}),
  };
  if (method === "file-write") {
    const content = String(args.content ?? "");
    if (content.includes("\u0000")) {
      return { inputs: {}, fallback: "binary content" };
    }
    const extension = path.split(".").pop()?.toLowerCase() ?? "";
    if (BINARY_EXTENSIONS.has(extension)) {
      return { inputs: {}, fallback: "binary file type" };
    }
    return {
      inputs: { ...base, edits: [{ setLines: content.split("\n") }] },
      fallback: "",
    };
  }
  const edits = Array.isArray(args.edits) ? args.edits : [];
  if (edits.length === 0) return null;
  if (method === "file-edit") {
    return {
      inputs: {
        ...base,
        edits: edits.map((edit) => {
          const row = edit as Record<string, unknown>;
          return { old: row.old, new: row.new };
        }),
      },
      fallback: "",
    };
  }
  return {
    inputs: {
      ...base,
      expectedHash: String(args.expectedHash ?? ""),
      edits: edits.map((edit) => {
        const row = edit as Record<string, unknown>;
        return {
          startLine: row.startLine,
          endLine: row.endLine,
          lines: row.lines,
          expectedLines: row.expectedLines,
        };
      }),
    },
    fallback: "",
  };
}

/** A shell-out the agent should express as a native method instead. */
export interface NativeToolRefusal {
  program: string;
  system: string;
  method: string;
  reason: string;
  /** The exact swamp_ide call to make instead, arguments filled in. */
  instead: string;
}

/** Flags whose following argument is not the pattern or a path. */
const VALUE_FLAGS = new Set([
  "-e", "-f", "-m", "-A", "-B", "-C", "-g", "--include", "--exclude", "-t",
  "--type", "--max-count", "--glob", "--type-add",
]);

/** The positional arguments of a simple command, skipping flags and values. */
export function positionalArgs(argv: string[]): string[] {
  const out: string[] = [];
  let skipNext = false;
  for (const arg of argv.slice(1)) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (arg.startsWith("-")) {
      if (VALUE_FLAGS.has(arg) && !arg.includes("=")) skipNext = true;
      continue;
    }
    out.push(arg);
  }
  return out;
}

/** JSON an agent can paste into `input=`, with no placeholders. */
function inputJson(value: Record<string, string>): string {
  return JSON.stringify(value);
}

/**
 * Refuse a shell-out that has a native method, and say exactly what to call.
 *
 * The approval dialog offers this choice too, but that asks a person to reject
 * the same command over and over; a shell-out with a first-class replacement is
 * refused before the dialog, so the agent learns the tool rather than the
 * person learning the refusal.
 */
export function nativeToolRefusal(argv: unknown): NativeToolRefusal | null {
  if (!Array.isArray(argv) || argv.length === 0) return null;
  const args = argv.map((arg) => String(arg));
  const program = args[0].split("/").pop() ?? "";
  const alternative = COMMAND_ALTERNATIVES[program];
  if (!alternative) return null;
  const positional = positionalArgs(args);
  let instead = "";
  if (program === "grep" || program === "rg") {
    const pattern = positional[0] ?? "";
    const paths = positional.slice(1);
    const input: Record<string, unknown> = { pattern };
    if (paths.length > 0) input.paths = paths;
    instead = `swamp_ide system=${alternative.system} method=${alternative.method} ` +
      `input=${JSON.stringify(input)}`;
  } else if (program === "find" || program === "fd") {
    const path = positional[0] || ".";
    const pattern = positional[1] ?? "";
    const input: Record<string, unknown> = { pattern: pattern || "." };
    input.paths = [path];
    instead = `swamp_ide system=${alternative.system} method=${alternative.method} ` +
      `input=${JSON.stringify(input)}`;
  } else if (positional.length > 0) {
    instead = `swamp_ide system=${alternative.system} method=${alternative.method} ` +
      `input=${inputJson({ path: positional[positional.length - 1] })}`;
  } else {
    instead = `swamp_ide system=${alternative.system} method=${alternative.method}`;
  }
  return {
    program,
    system: alternative.system,
    method: alternative.method,
    reason: alternative.reason,
    instead,
  };
}

/**
 * What a vim mutation is missing.
 *
 * `edit` and `write` act on the loaded buffer, so without a path the request has
 * no file to be about: it becomes a broad scope, which the policy refuses. Say
 * what is missing instead of letting it surface as "too broad".
 */
export function vimWriteInputProblem(
  system: string,
  method: string,
  input: Record<string, unknown> | undefined,
): string {
  if (system !== "vim") return "";
  if (method !== "edit" && method !== "write" && method !== "undo") return "";
  const args = input ?? {};
  if (String(args.path ?? "").trim()) return "";
  return `a vim ${method} needs input.path: the buffer is the writer, so name ` +
    `the file it is for (or use system=herdr-core method=file-edit, which ` +
    `loads the path through this space's editor)`;
}

/** Model types this addin drives by name. */
export const HERDR_CORE_TYPE = "@svendowideit/herdr-core";
export const VIM_CONTROLLER_TYPE = "@svendowideit/vim-controller";

/**
 * The per-session instance name for a shared behaviour.
 *
 * One instance per pi session keeps each session's calls off everyone else's
 * lock; the name says which pane and which session it belongs to, so a person or
 * agent reading `swamp run doctor` or `swamp model list` can see who is holding
 * what: `<behaviour>-pi-<terminal>-<session>` (e.g. `herdr-core-pi-t2g-01a206`).
 */
export function sessionInstanceName(
  base: string,
  terminal: string,
  session: string,
): string {
  const clean = (value: string) =>
    String(value ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(
      /^-+|-+$/g,
      "",
    );
  const parts = [
    clean(base) || "model",
    "pi",
    clean(terminal).slice(0, 12) || "local",
    clean(session).slice(0, 8) || "anon",
  ];
  return parts.join("-").slice(0, 60).replace(/-+$/, "");
}

/** What a call was trying to do, in one readable phrase. */
export function describeAttempt(
  system: string,
  method: string,
  input: Record<string, unknown> | undefined,
): string {
  const args = input ?? {};
  if (system === "herdr-core") {
    if ((method === "exec" || method === "run") && Array.isArray(args.argv)) {
      return `${method} ${(args.argv as unknown[]).map(String).join(" ")}`;
    }
    if (String(args.path ?? "").trim()) {
      return `${method} ${String(args.path)}`;
    }
    if (String(args.pattern ?? "").trim()) {
      return `${method} ${JSON.stringify(String(args.pattern))}`;
    }
    return method;
  }
  if (system === "vim") {
    const path = String(args.path ?? args.file ?? "").trim();
    const server = String(args.server ?? "").trim();
    return [method, path, server ? `on ${server}` : ""].filter(Boolean).join(" ");
  }
  const model = String(args.model ?? "").trim();
  return [model, method].filter(Boolean).join(".") || method;
}

/** A swamp lock timeout, split into the parts a reader needs. */
export interface LockDetail {
  /** The lock that was contended: a model instance name. */
  waiting: string;
  /** The process the error names as the holder. */
  holderPid: string;
  /** The swamp error code, when the message carried one. */
  code: string;
}

/**
 * Pull the lock facts out of a swamp error message.
 *
 * A lock timeout is only useful if it says what was contended and who held it;
 * swamp's message names the holder pid, and the caller knows which instance it
 * was asking for, so both end up on the event.
 */
export function lockDetailFromError(
  text: string,
  waiting = "",
): LockDetail | null {
  const message = String(text ?? "");
  const isLock = /lock_timeout|holds the (model|behaviour|behavior) lock|model lock/i
    .test(message);
  if (!isLock) return null;
  const pid = message.match(/pid[\s:=]+(\d{2,})/i);
  const code = message.match(/lock_timeout/i) ? "lock_timeout" : "lock_held";
  return {
    waiting: String(waiting ?? "").trim(),
    holderPid: pid ? pid[1] : "",
    code,
  };
}
