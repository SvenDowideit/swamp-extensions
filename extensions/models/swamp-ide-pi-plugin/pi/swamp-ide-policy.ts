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
