// swamp-quality-ignore testing-completeness: the shared helpers and builders
// are exercised by the sibling obsidian_headless_test.ts, which drives this
// module through a fake Deps (success and failure paths).
/**
 * Pure helpers, host side effects and resource builders for
 * {@link @svendowideit/obsidian-headless}.
 *
 * The model file keeps only schemas and thin `execute` wrappers; everything
 * that reads the host, downloads Node, installs the npm package or edits a
 * vault's config lives here behind {@link Deps}. That split keeps every
 * non-trivial branch unit-testable with a fake {@link Deps}, and keeps the
 * model's methods small.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Side-effect surface
// ---------------------------------------------------------------------------

/** The result of running a subprocess. */
export interface RunResult {
  /** Exit code, or 127 when the binary could not be started. */
  code: number;
  /** Decoded stdout, trimmed. */
  stdout: string;
  /** Decoded stderr, trimmed. */
  stderr: string;
}

/** Options for {@link Deps.run}. */
export interface RunOptions {
  /** Working directory for the command. */
  cwd?: string;
  /** Environment variables to merge over the inherited environment. */
  env?: Record<string, string>;
}

/** The injectable side effects of the extension, so tests can fake the host. */
export interface Deps {
  /** Run a command, capturing output; never throws for a non-zero exit. */
  run: (bin: string, args: string[], opts?: RunOptions) => Promise<RunResult>;
  /** Read a UTF-8 text file, returning "" when it is absent or unreadable. */
  readText: (path: string) => Promise<string>;
  /** Write a UTF-8 text file (parents assumed to exist); true on success. */
  writeText: (path: string, data: string) => Promise<boolean>;
  /** Write raw bytes to a file (parents assumed to exist). */
  writeBinary: (path: string, data: Uint8Array) => Promise<void>;
  /** Whether a path exists. */
  exists: (path: string) => Promise<boolean>;
  /** Create a directory and its parents. */
  mkdirp: (path: string) => Promise<void>;
  /** Remove a file or directory tree, ignoring absence. */
  remove: (path: string) => Promise<void>;
  /** Rename (atomic within a filesystem) `from` onto `to`. */
  rename: (from: string, to: string) => Promise<void>;
  /** List directory entry names, or [] when unreadable. */
  readDir: (path: string) => Promise<string[]>;
  /** Fetch a URL and return the raw bytes; throws on a non-2xx response. */
  fetchBytes: (url: string) => Promise<Uint8Array>;
  /** Read an environment variable for the extension's own decisions. */
  env: (key: string) => string | undefined;
  /** The current user's home directory. */
  home: () => string;
  /** The host platform. */
  platform: () => "linux" | "darwin" | "other";
  /** The host CPU architecture. */
  arch: () => "x64" | "arm64" | "other";
  /** Current time as an ISO 8601 string. */
  now: () => string;
  /** The host's short hostname, or "". */
  hostname: () => Promise<string>;
  /** PIDs whose executable name matches `name` (best-effort; [] if unknown). */
  pids: (name: string) => Promise<number[]>;
  /** Hex SHA-256 of the given bytes. */
  sha256Hex: (bytes: Uint8Array) => Promise<string>;
}

/** The real {@link Deps}, backed by Deno and the host. */
export function realDeps(): Deps {
  return {
    run: async (bin, args, opts = {}) => {
      try {
        // swamp-quality-ignore deno-command: installing a runtime, driving npm and running the ob CLI require subprocesses; every argument is built by this extension, never taken from untrusted input.
        const out = await new Deno.Command(bin, {
          args,
          cwd: opts.cwd,
          env: opts.env,
          stdin: "null",
          stdout: "piped",
          stderr: "piped",
        }).output();
        const dec = new TextDecoder();
        return {
          code: out.code,
          stdout: dec.decode(out.stdout).trim(),
          stderr: dec.decode(out.stderr).trim(),
        };
      } catch (error) {
        return { code: 127, stdout: "", stderr: `${error}` };
      }
    },
    readText: async (path) => {
      try {
        return await Deno.readTextFile(path);
      } catch {
        return "";
      }
    },
    writeText: async (path, data) => {
      try {
        await Deno.writeTextFile(path, data);
        return true;
      } catch {
        return false;
      }
    },
    writeBinary: async (path, data) => {
      await Deno.writeFile(path, data);
    },
    exists: async (path) => {
      try {
        await Deno.stat(path);
        return true;
      } catch {
        return false;
      }
    },
    mkdirp: async (path) => {
      await Deno.mkdir(path, { recursive: true });
    },
    remove: async (path) => {
      try {
        await Deno.remove(path, { recursive: true });
      } catch {
        // already gone
      }
    },
    rename: async (from, to) => {
      await Deno.rename(from, to);
    },
    readDir: async (path) => {
      try {
        const names: string[] = [];
        for await (const entry of Deno.readDir(path)) names.push(entry.name);
        return names;
      } catch {
        return [];
      }
    },
    fetchBytes: async (url) => {
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },
    env: (key) => Deno.env.get(key),
    home: () => Deno.env.get("HOME") ?? "",
    platform: () => {
      const os = Deno.build.os;
      return os === "linux" ? "linux" : os === "darwin" ? "darwin" : "other";
    },
    arch: () => {
      const a = Deno.build.arch;
      return a === "x86_64" ? "x64" : a === "aarch64" ? "arm64" : "other";
    },
    now: () => new Date().toISOString(),
    hostname: async () => {
      // swamp-quality-ignore deno-command: reading the host short name is the only way to derive a default sync device name; the arguments are fixed.
      const out = await new Deno.Command("hostname", {
        args: ["-s"],
        stdin: "null",
        stdout: "piped",
        stderr: "null",
      }).output().catch(() => null);
      if (out && out.code === 0) {
        return new TextDecoder().decode(out.stdout).trim();
      }
      return Deno.env.get("HOSTNAME") ?? "";
    },
    pids: async (name) => {
      // pgrep -x matches the exact process name; absence is [] not an error.
      const out = await realDeps().run("pgrep", ["-x", name]);
      if (out.code !== 0 || !out.stdout) return [];
      return out.stdout.split(/\s+/).map((s) => Number(s)).filter((n) =>
        Number.isFinite(n)
      );
    },
    sha256Hex: async (bytes) => {
      const digest = await crypto.subtle.digest(
        "SHA-256",
        bytes as unknown as BufferSource,
      );
      return [...new Uint8Array(digest)]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    },
  };
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** The resolved configuration a method works from. */
export interface Config {
  /** Obsidian Sync remote vault name (or id) to attach to. */
  vaultName: string;
  /** Local absolute path of the vault directory. */
  vaultPath: string;
  /** Device name recorded in the vault's sync version history. */
  deviceName: string;
  /** Name of the vault's config directory (a dotfolder, default `.obsidian`). */
  configDir: string;
  /** Sync mode to enforce for the vault. */
  syncMode: "bidirectional" | "pull-only" | "mirror-remote";
  /** Directory the managed Node.js runtime is installed under. */
  nodeDir: string;
  /** Node.js version to install when none is present (a major, e.g. `22`). */
  nodeVersion: string;
  /** Explicit node binary to use instead of detecting/installing one. */
  nodePath: string;
  /** npm global prefix the obsidian-headless package is installed into. */
  packagePrefix: string;
  /** obsidian-headless version to install (empty = the latest). */
  packageVersion: string;
  /** End-to-end encryption password, when the remote vault uses E2E. */
  e2ePassword: string;
  /** systemd user service name (without the `.service` suffix). */
  serviceName: string;
  /** Override for the Obsidian desktop app config directory. */
  obsidianConfigDir: string;
}

/** Build a {@link Config}, expanding `~` and applying defaults. */
export function normaliseConfig(
  input: Partial<Config>,
  home: string,
  hostname = "",
): Config {
  const cfg: Config = {
    vaultName: (input.vaultName ?? "").trim(),
    vaultPath: expandHome((input.vaultPath ?? "").trim(), home),
    deviceName: (input.deviceName ?? "").trim() || defaultDeviceName(hostname),
    configDir: (input.configDir ?? "").trim() || ".obsidian",
    syncMode: input.syncMode ?? "bidirectional",
    nodeDir: expandHome(
      (input.nodeDir ?? "").trim() || "~/.local/share/obsidian-headless/node",
      home,
    ),
    nodeVersion: (input.nodeVersion ?? "").trim() || "22",
    nodePath: expandHome((input.nodePath ?? "").trim(), home),
    packagePrefix: expandHome(
      (input.packagePrefix ?? "").trim() || "~/.local/share/obsidian-headless",
      home,
    ),
    packageVersion: (input.packageVersion ?? "").trim(),
    e2ePassword: input.e2ePassword ?? "",
    serviceName: (input.serviceName ?? "").trim() || "obsidian-headless",
    obsidianConfigDir: expandHome((input.obsidianConfigDir ?? "").trim(), home),
  };
  return cfg;
}

// ---------------------------------------------------------------------------
// Pure path + parsing helpers (exported for unit testing)
// ---------------------------------------------------------------------------

/** Expand a leading `~` to `home`; absolute paths pass through. */
export function expandHome(path: string, home: string): string {
  if (!path) return "";
  if (path === "~") return home;
  if (path.startsWith("~/")) return `${home}${path.slice(1)}`;
  return path;
}

/** The obsidian-headless config directory (`<config home>/obsidian-headless`). */
export function headlessConfigDir(
  env: (key: string) => string | undefined,
  home: string,
  platform: string,
): string {
  if (platform === "darwin") return `${home}/.obsidian-headless`;
  const xdg = (env("XDG_CONFIG_HOME") ?? "").trim();
  const base = xdg || `${home}/.config`;
  return `${base}/obsidian-headless`;
}

/** The Obsidian desktop app's config directory for this platform. */
export function desktopConfigDir(
  env: (key: string) => string | undefined,
  home: string,
  platform: string,
): string {
  if (platform === "darwin") {
    return `${home}/Library/Application Support/obsidian`;
  }
  const xdg = (env("XDG_CONFIG_HOME") ?? "").trim();
  const base = xdg || `${home}/.config`;
  return `${base}/obsidian`;
}

/** Parse JSON, returning null instead of throwing. */
export function parseJsonSafe(text: string): unknown {
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** How a vault's `core-plugins.json` records plugin enablement. */
export type CorePluginsKind = "object" | "array" | "none";

/** The sync-plugin state read from a `core-plugins.json` body. */
export interface CorePluginsState {
  /** Whether the file is an object map, a legacy array, or absent/invalid. */
  kind: CorePluginsKind;
  /** Whether the `sync` core plugin is enabled. */
  syncEnabled: boolean;
}

/**
 * Read the `sync` core-plugin flag from a vault's `core-plugins.json`.
 *
 * Modern Obsidian stores a `{ "sync": true }` object; older vaults stored an
 * array of enabled plugin ids. Both are handled; anything else reads as
 * `none`/false.
 */
export function parseCorePlugins(text: string): CorePluginsState {
  const value = parseJsonSafe(text);
  if (Array.isArray(value)) {
    return {
      kind: "array",
      syncEnabled: value.some((v) => String(v) === "sync"),
    };
  }
  if (value && typeof value === "object") {
    return {
      kind: "object",
      syncEnabled: (value as Record<string, unknown>)["sync"] === true,
    };
  }
  return { kind: "none", syncEnabled: false };
}

/** The result of turning the `sync` core plugin off in a config body. */
export interface CorePluginsEdit {
  /** The rewritten file body (unchanged when nothing was enabled). */
  text: string;
  /** Whether the body differs from the input. */
  changed: boolean;
  /** Whether `sync` was enabled before the edit. */
  wasEnabled: boolean;
}

/**
 * Disable the `sync` core plugin in a `core-plugins.json` body.
 *
 * Object form sets `sync: false`; legacy array form removes `"sync"`. A body
 * that already has sync off (or is invalid) is returned unchanged.
 */
export function disableSyncCorePlugin(text: string): CorePluginsEdit {
  const state = parseCorePlugins(text);
  if (!state.syncEnabled) {
    return { text, changed: false, wasEnabled: false };
  }
  const value = parseJsonSafe(text);
  if (Array.isArray(value)) {
    const next = value.filter((v) => String(v) !== "sync");
    return {
      text: JSON.stringify(next, null, 2) + "\n",
      changed: true,
      wasEnabled: true,
    };
  }
  const obj = value as Record<string, unknown>;
  obj["sync"] = false;
  return {
    text: JSON.stringify(obj, null, 2) + "\n",
    changed: true,
    wasEnabled: true,
  };
}

/** One vault registered with the Obsidian desktop app. */
export interface DesktopVault {
  /** The desktop app's internal vault id. */
  id: string;
  /** Absolute path of the vault. */
  path: string;
}

/** Parse `obsidian.json`'s `vaults` map into a list, in stable order. */
export function parseDesktopVaults(text: string): DesktopVault[] {
  const value = parseJsonSafe(text);
  if (!value || typeof value !== "object") return [];
  const vaults = (value as Record<string, unknown>)["vaults"];
  if (!vaults || typeof vaults !== "object") return [];
  const out: DesktopVault[] = [];
  for (const [id, entry] of Object.entries(vaults as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") continue;
    const path = String((entry as Record<string, unknown>)["path"] ?? "");
    if (path) out.push({ id, path });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Whether `vaultPath` is registered with the desktop app. */
export function isDesktopRegistered(
  vaults: DesktopVault[],
  vaultPath: string,
): boolean {
  const target = stripTrailingSlash(vaultPath);
  return vaults.some((v) => stripTrailingSlash(v.path) === target);
}

/** Drop a single trailing slash, unless the whole string is `/`. */
export function stripTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

/** A remote Obsidian Sync vault as reported by `sync-list-remote`. */
export interface RemoteVault {
  /** Remote vault id. */
  id: string;
  /** Remote vault name. */
  name: string;
  /** Server region, or "". */
  region: string;
  /** Whether the vault is shared with the account rather than owned. */
  shared: boolean;
}

/** Parse `ob sync-list-remote --json` into owned + shared vaults. */
export function parseRemoteVaults(text: string): RemoteVault[] {
  const value = parseJsonSafe(text);
  if (!value || typeof value !== "object") return [];
  const obj = value as Record<string, unknown>;
  const out: RemoteVault[] = [];
  const collect = (list: unknown, shared: boolean): void => {
    if (!Array.isArray(list)) return;
    for (const entry of list) {
      if (!entry || typeof entry !== "object") continue;
      const rec = entry as Record<string, unknown>;
      const id = String(rec["id"] ?? "");
      const name = String(rec["name"] ?? "");
      if (!id || !name) continue;
      out.push({ id, name, region: String(rec["region"] ?? ""), shared });
    }
  };
  collect(obj["vaults"], false);
  collect(obj["shared"], true);
  return out;
}

/** Every vault whose name matches exactly (or, failing that, by id). */
export function findRemoteVaults(
  vaults: RemoteVault[],
  nameOrId: string,
): RemoteVault[] {
  const byId = vaults.filter((v) => v.id === nameOrId);
  if (byId.length) return byId;
  return vaults.filter((v) => v.name === nameOrId);
}

/** A locally configured sync vault as reported by `sync-list-local`. */
export interface LocalVault {
  /** Remote vault id the local vault is attached to. */
  id: string;
  /** Local vault path. */
  path: string;
  /** Sync host, or "". */
  host: string;
}

/** Parse `ob sync-list-local --json` into local vaults. */
export function parseLocalVaults(text: string): LocalVault[] {
  const value = parseJsonSafe(text);
  if (!value || typeof value !== "object") return [];
  const list = (value as Record<string, unknown>)["vaults"];
  if (!Array.isArray(list)) return [];
  const out: LocalVault[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const rec = entry as Record<string, unknown>;
    out.push({
      id: String(rec["id"] ?? ""),
      path: String(rec["path"] ?? ""),
      host: String(rec["host"] ?? ""),
    });
  }
  return out;
}

/** The local vault whose path matches `vaultPath`, if any. */
export function findLocalVaultAt(
  vaults: LocalVault[],
  vaultPath: string,
): LocalVault | undefined {
  const target = stripTrailingSlash(vaultPath);
  return vaults.find((v) => stripTrailingSlash(v.path) === target);
}

/** The major version number of a `v22.11.0` / `22.11.0` string, else null. */
export function majorOf(version: string): number | null {
  const m = version.trim().replace(/^v/, "").match(/^(\d+)\./);
  return m ? Number(m[1]) : null;
}

/** The Node.js distribution token for a platform/arch, else null. */
export function nodeDistToken(
  platform: string,
  arch: string,
): string | null {
  if (platform === "linux" && arch === "x64") return "linux-x64";
  if (platform === "linux" && arch === "arm64") return "linux-arm64";
  if (platform === "darwin" && arch === "x64") return "darwin-x64";
  if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
  return null;
}

/** The archive name for a Node version and distribution token. */
export function nodeTarballName(
  version: string,
  distToken: string,
): string {
  const v = version.replace(/^v/, "");
  return `node-v${v}-${distToken}.tar.xz`;
}

/**
 * Choose the newest Node.js version from `index.json` for a wanted major.
 *
 * `index.json` is newest-first, so the first match is the newest patch. When
 * `wanted` is a full `x.y.z` version it is returned as-is (after validation).
 */
export function pickNodeVersion(
  indexJson: string,
  wanted: string,
): string | null {
  const clean = wanted.trim().replace(/^v/, "");
  if (/^\d+\.\d+\.\d+$/.test(clean)) return clean;
  const major = /^\d+$/.test(clean) ? Number(clean) : majorOf(clean);
  const index = parseJsonSafe(indexJson);
  if (!Array.isArray(index)) return null;
  for (const entry of index) {
    if (!entry || typeof entry !== "object") continue;
    const version = String((entry as Record<string, unknown>)["version"] ?? "")
      .replace(/^v/, "");
    if (major === null || majorOf(version) === major) return version;
  }
  return null;
}

/** Find the SHA-256 hex for `filename` in a `SHASUMS256.txt` body, else null. */
export function parseShasums(text: string, filename: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (m && m[2].trim() === filename) return m[1].toLowerCase();
  }
  return null;
}

/** A sensible default device name from the host, or `unknown`. */
export function defaultDeviceName(hostname: string): string {
  const h = hostname.trim() || "unknown-host";
  return `${h}-headless`;
}

/** Whether the stored auth token (file or env) indicates a login. */
export function isLoggedIn(tokenFileText: string, envToken: string): boolean {
  return tokenFileText.trim().length > 0 || envToken.trim().length > 0;
}

/**
 * The command line a systemd unit should run to keep a vault syncing.
 *
 * Absolute paths are used for both the runtime and the CLI so the unit does
 * not depend on a login-shell `PATH` (a systemd user service does not inherit
 * the interactive environment).
 */
export function buildSyncCommand(
  nodeBinary: string,
  cliPath: string,
  vaultPath: string,
  continuous = true,
): string {
  const parts = [nodeBinary, cliPath, "sync", "--path", shellQuote(vaultPath)];
  if (continuous) parts.push("--continuous");
  return parts.join(" ");
}

/** Quote a token for a systemd `ExecStart`-style command line when needed. */
export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

// ---------------------------------------------------------------------------
// Host detection + install builders
// ---------------------------------------------------------------------------

/** A snapshot of what is installed and configured on this host. */
export interface StatusInfo {
  /** Remote vault name the model targets. */
  vaultName: string;
  /** Local vault path the model targets. */
  vaultPath: string;
  /** Whether the vault path exists on disk. */
  vaultPathExists: boolean;
  /** Whether the desktop app has this vault registered. */
  desktopRegistered: boolean;
  /** Every vault path registered with the desktop app. */
  desktopVaults: string[];
  /** Whether the in-app `sync` core plugin is enabled for the vault. */
  inAppSyncEnabled: boolean;
  /** Whether in-app sync is configured (desktop-registered **and** enabled). */
  inAppSyncConfigured: boolean;
  /** Whether the Obsidian desktop app appears to be running right now. */
  obsidianAppRunning: boolean;
  /** Whether a usable Node.js runtime was found. */
  nodeFound: boolean;
  /** Path of the resolved node binary, or "". */
  nodePath: string;
  /** Detected node version (e.g. `v22.11.0`), or "". */
  nodeVersion: string;
  /** Node major version, or 0. */
  nodeMajor: number;
  /** Whether the resolved node satisfies the required major. */
  nodeOk: boolean;
  /** Whether obsidian-headless is installed in the managed prefix. */
  packageInstalled: boolean;
  /** Installed obsidian-headless version, or "". */
  packageVersion: string;
  /** Path to the installed CLI entrypoint, or "". */
  packageCliPath: string;
  /** Whether an Obsidian account login is present. */
  loggedIn: boolean;
  /** Path of the stored auth token file. */
  authTokenPath: string;
  /** Whether the targeted remote vault was found on the account. */
  remoteVaultFound: boolean;
  /** Remote vault id, when found. */
  remoteVaultId: string;
  /** Whether the vault path is already configured for sync locally. */
  localConfigured: boolean;
  /** systemd user service name the workflow will create. */
  serviceName: string;
  /** The exact command to inspect the service. */
  serviceHint: string;
  /** When the snapshot was taken (ISO 8601). */
  checkedAt: string;
}

/** Node resolution result, shared by `setup`, `installNode` and `install`. */
export interface NodeInfo {
  /** Node major version, or 0. */
  major: number;
  /** Full node version (e.g. `v22.11.0`). */
  version: string;
  /** Absolute path of the node binary. */
  binaryPath: string;
  /** Absolute path of the npm CLI entrypoint, or "". */
  npmCliPath: string;
  /** Where the runtime came from. */
  source: "override" | "path" | "managed" | "none";
  /** Whether installation was skipped because a usable node already existed. */
  skipped: boolean;
  /** Directory the managed runtime lives in. */
  installDir: string;
  /** Minimum major required by obsidian-headless. */
  requiredMajor: number;
}

/** Installed obsidian-headless package location + version. */
export interface PackageInfo {
  /** Installed version, or "". */
  version: string;
  /** npm global prefix the package lives in. */
  prefix: string;
  /** Absolute path of `cli.js`. */
  cliPath: string;
  /** Absolute path of the `ob` launcher, or "". */
  obPath: string;
  /** Whether installation was skipped (already at the wanted version). */
  skipped: boolean;
  /** Whether the package is present at all. */
  installed: boolean;
  /** The version that was wanted (empty when resolving `latest`). */
  wantedVersion: string;
}

/** Result of resolving and (if needed) configuring a remote vault for sync. */
export interface VaultInfo {
  /** Remote vault name. */
  vaultName: string;
  /** Remote vault id. */
  vaultId: string;
  /** Server region, or "". */
  region: string;
  /** Local vault path. */
  vaultPath: string;
  /** Whether sync was already configured for this path. */
  configured: boolean;
  /** Whether configuration was skipped because it already existed. */
  skipped: boolean;
  /** The sync mode in force. */
  syncMode: string;
  /** Device name recorded in the version history. */
  deviceName: string;
  /** Every locally configured vault, for diagnostics. */
  localVaults: LocalVault[];
  /** A short human summary of what happened. */
  message: string;
}

/** Result of disabling in-app sync for a vault. */
export interface InAppSyncInfo {
  /** Local vault path. */
  vaultPath: string;
  /** Path of the edited `core-plugins.json`. */
  corePluginsPath: string;
  /** Whether the `sync` core plugin was enabled before the change. */
  enabledBefore: boolean;
  /** Whether in-app sync is now off (true when it never was on). */
  disabled: boolean;
  /** Whether the config file was rewritten. */
  changed: boolean;
  /** Path of the backup taken before the edit, or "". */
  backupPath: string;
  /** Whether the desktop app has this vault registered. */
  desktopRegistered: boolean;
  /** Whether the desktop app appears to be running. */
  appRunning: boolean;
  /** A human note about what happened and any caveat. */
  note: string;
}

/** The final human-readable summary written by the `print` method. */
export interface SummaryInfo {
  /** Whether the host is in the intended end state. */
  ok: boolean;
  /** Ordered human-readable lines. */
  lines: string[];
  /** Remote vault name. */
  vaultName: string;
  /** Local vault path. */
  vaultPath: string;
  /** Installed obsidian-headless version, or "". */
  packageVersion: string;
  /** Resolved node binary path, or "". */
  nodePath: string;
  /** systemd user service name. */
  serviceName: string;
  /** The exact command to inspect the service. */
  serviceHint: string;
  /** When the summary was produced (ISO 8601). */
  checkedAt: string;
}

/** The minimum node major obsidian-headless requires. */
export const REQUIRED_NODE_MAJOR = 22;

/** Split a `node --version` result into a {@link NodeInfo}. */
export async function resolveNode(
  deps: Deps,
  cfg: Config,
): Promise<NodeInfo> {
  const base: NodeInfo = {
    major: 0,
    version: "",
    binaryPath: "",
    npmCliPath: "",
    source: "none",
    skipped: false,
    installDir: cfg.nodeDir,
    requiredMajor: REQUIRED_NODE_MAJOR,
  };

  const fromBinary = async (
    binary: string,
    source: NodeInfo["source"],
  ): Promise<NodeInfo> => {
    const out = await deps.run(binary, ["--version"]);
    if (out.code !== 0) return base;
    const version = out.stdout.trim();
    const major = majorOf(version) ?? 0;
    return {
      ...base,
      major,
      version,
      binaryPath: binary,
      npmCliPath: await npmCliFor(deps, binary),
      source,
    };
  };

  if (cfg.nodePath) {
    const info = await fromBinary(cfg.nodePath, "override");
    return info.binaryPath ? info : base;
  }

  const managed = await managedNode(deps, cfg);
  if (managed) return managed;

  // Fall back to whatever `node` is on PATH.
  const which = await deps.run("which", ["node"]);
  if (which.code === 0 && which.stdout) {
    const info = await fromBinary(which.stdout.trim(), "path");
    if (info.binaryPath) return info;
  }
  return base;
}

/** Find the newest managed Node runtime under `cfg.nodeDir`, if any. */
export async function managedNode(
  deps: Deps,
  cfg: Config,
): Promise<NodeInfo | null> {
  const token = nodeDistToken(deps.platform(), deps.arch());
  if (!token) return null;
  const entries = await deps.readDir(cfg.nodeDir);
  const candidates = entries
    .map((name) => name.match(/^node-v(\d+\.\d+\.\d+)-/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => m[1])
    .sort((a, b) => compareVersions(a, b));
  if (!candidates.length) return null;
  const version = candidates[candidates.length - 1];
  const root = `${cfg.nodeDir}/node-v${version}-${token}`;
  const binary = `${root}/bin/node`;
  if (!(await deps.exists(binary))) return null;
  const out = await deps.run(binary, ["--version"]);
  if (out.code !== 0) return null;
  const v = out.stdout.trim();
  return {
    major: majorOf(v) ?? 0,
    version: v,
    binaryPath: binary,
    npmCliPath: `${root}/lib/node_modules/npm/bin/npm-cli.js`,
    source: "managed",
    skipped: false,
    installDir: cfg.nodeDir,
    requiredMajor: REQUIRED_NODE_MAJOR,
  };
}

/** Locate the npm CLI that ships beside a node binary, or "". */
export async function npmCliFor(
  deps: Deps,
  nodeBinary: string,
): Promise<string> {
  // node at <root>/bin/node → npm CLI at <root>/lib/node_modules/npm/bin/npm-cli.js
  const root = nodeBinary.replace(/\/bin\/node$/, "");
  const candidate = `${root}/lib/node_modules/npm/bin/npm-cli.js`;
  return (await deps.exists(candidate)) ? candidate : "";
}

/** Compare two `x.y.z` version strings numerically. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Ensure a Node.js runtime of the required major is available.
 *
 * An override, a managed runtime or a suitable PATH node is reused; otherwise
 * the official Node.js distribution for this platform is downloaded, verified
 * against `SHASUMS256.txt` and extracted under `cfg.nodeDir`.
 */
export async function ensureNode(
  deps: Deps,
  cfg: Config,
  force = false,
): Promise<NodeInfo> {
  const existing = await resolveNode(deps, cfg);
  if (
    !force && existing.binaryPath && existing.major >= REQUIRED_NODE_MAJOR
  ) {
    return { ...existing, skipped: true };
  }

  const token = nodeDistToken(deps.platform(), deps.arch());
  if (!token) {
    throw new Error(
      `Unsupported platform/arch for a managed Node install: ` +
        `${deps.platform()}/${deps.arch()}. Set nodePath to an existing ` +
        `Node ${REQUIRED_NODE_MAJOR}+ runtime.`,
    );
  }

  const indexText = new TextDecoder().decode(
    await deps.fetchBytes("https://nodejs.org/dist/index.json"),
  );
  const version = pickNodeVersion(indexText, cfg.nodeVersion);
  if (!version) {
    throw new Error(
      `Could not resolve a Node.js release for version "${cfg.nodeVersion}".`,
    );
  }

  const tarball = nodeTarballName(version, token);
  const distUrl = `https://nodejs.org/dist/v${version}/${tarball}`;
  const shaUrl = `https://nodejs.org/dist/v${version}/SHASUMS256.txt`;
  const root = `${cfg.nodeDir}/node-v${version}-${token}`;
  const binary = `${root}/bin/node`;

  if (!force && (await deps.exists(binary))) {
    const info = await resolveNode(deps, cfg);
    if (info.binaryPath) return { ...info, skipped: true };
  }

  await deps.mkdirp(cfg.nodeDir);
  const dest = `${cfg.nodeDir}/${tarball}`;
  const bytes = await deps.fetchBytes(distUrl);
  const shasums = new TextDecoder().decode(await deps.fetchBytes(shaUrl));
  const expected = parseShasums(shasums, tarball);
  const actual = await deps.sha256Hex(bytes);
  if (!expected || expected !== actual) {
    throw new Error(
      `Checksum mismatch for ${tarball}: expected ${expected ?? "(none)"}, ` +
        `got ${actual}. Refusing to extract an unverified archive.`,
    );
  }
  await deps.writeBinary(dest, bytes);
  const untar = await deps.run("tar", ["-xJf", dest, "-C", cfg.nodeDir]);
  await deps.remove(dest);
  if (untar.code !== 0) {
    throw new Error(`Failed to extract ${tarball}: ${untar.stderr}`);
  }
  if (!(await deps.exists(binary))) {
    throw new Error(`Node binary not found at ${binary} after extraction.`);
  }
  const info = await resolveNode(deps, cfg);
  return info.binaryPath ? info : { ...info, binaryPath: binary };
}

/**
 * Resolve the obsidian-headless package installed in `cfg.packagePrefix`.
 *
 * Reads the installed `package.json` for the version; returns an empty result
 * when nothing is installed.
 */
export async function resolvePackage(
  deps: Deps,
  cfg: Config,
): Promise<PackageInfo> {
  const pkgDir = `${cfg.packagePrefix}/lib/node_modules/obsidian-headless`;
  const cliPath = `${pkgDir}/cli.js`;
  const obPath = `${cfg.packagePrefix}/bin/ob`;
  const text = await deps.readText(`${pkgDir}/package.json`);
  const parsed = parseJsonSafe(text);
  const version = parsed && typeof parsed === "object"
    ? String((parsed as Record<string, unknown>)["version"] ?? "")
    : "";
  return {
    version,
    prefix: cfg.packagePrefix,
    cliPath,
    obPath,
    skipped: false,
    installed: Boolean(version) && (await deps.exists(cliPath)),
    wantedVersion: cfg.packageVersion,
  };
}

/** The npm registry's `latest` version for obsidian-headless, or "". */
export async function latestPackageVersion(deps: Deps): Promise<string> {
  const text = new TextDecoder().decode(
    await deps.fetchBytes(
      "https://registry.npmjs.org/obsidian-headless/latest",
    ),
  );
  const parsed = parseJsonSafe(text);
  return parsed && typeof parsed === "object"
    ? String((parsed as Record<string, unknown>)["version"] ?? "")
    : "";
}

/**
 * Install or upgrade the obsidian-headless npm package into the managed prefix.
 *
 * Uses the resolved node's bundled npm with `--prefix`, so nothing is installed
 * globally against a system Node the user may not have. Idempotent: a matching
 * version is skipped unless `force` is set.
 */
export async function ensurePackage(
  deps: Deps,
  cfg: Config,
  node: NodeInfo,
  force = false,
): Promise<PackageInfo> {
  if (!node.binaryPath || !node.npmCliPath) {
    throw new Error(
      "No usable Node/npm runtime — run the installNode method first.",
    );
  }
  const existing = await resolvePackage(deps, cfg);
  const wanted = cfg.packageVersion || (await latestPackageVersion(deps));
  if (!wanted) {
    throw new Error(
      "Could not determine which obsidian-headless version to install.",
    );
  }
  if (!force && existing.installed && existing.version === wanted) {
    return { ...existing, skipped: true, wantedVersion: wanted };
  }

  await deps.mkdirp(cfg.packagePrefix);
  const install = await deps.run(
    node.binaryPath,
    [
      node.npmCliPath,
      "install",
      "-g",
      "--prefix",
      cfg.packagePrefix,
      "--no-audit",
      "--no-fund",
      `obsidian-headless@${wanted}`,
    ],
    { env: { PATH: `${dirname(node.binaryPath)}:${deps.env("PATH") ?? ""}` } },
  );
  if (install.code !== 0) {
    throw new Error(
      `npm install obsidian-headless@${wanted} failed: ${
        install.stderr || install.stdout
      }`,
    );
  }
  const after = await resolvePackage(deps, cfg);
  if (!after.installed) {
    throw new Error(
      `obsidian-headless does not appear installed under ${cfg.packagePrefix}.`,
    );
  }
  return { ...after, wantedVersion: wanted };
}

/** The directory portion of a path. */
export function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i > 0 ? path.slice(0, i) : "/";
}

/** Detect the host state the model reports and the workflow gates on. */
export async function detectStatus(
  deps: Deps,
  cfg: Config,
): Promise<StatusInfo> {
  const platform = deps.platform();
  const home = deps.home();
  const desktopDir = cfg.obsidianConfigDir ||
    desktopConfigDir(deps.env, home, platform);
  const desktopVaults = parseDesktopVaults(
    await deps.readText(`${desktopDir}/obsidian.json`),
  );
  const corePath = corePluginsPath(cfg);
  const core = parseCorePlugins(await deps.readText(corePath));

  const node = await resolveNode(deps, cfg);
  const pkg = await resolvePackage(deps, cfg);

  const headlessDir = headlessConfigDir(deps.env, home, platform);
  const authTokenPath = `${headlessDir}/auth_token`;
  const loggedIn = isLoggedIn(
    await deps.readText(authTokenPath),
    deps.env("OBSIDIAN_AUTH_TOKEN") ?? "",
  );

  let remoteVaultFound = false;
  let remoteVaultId = "";
  let localConfigured = false;
  if (pkg.installed && loggedIn && cfg.vaultName) {
    try {
      const remote = await runOb(deps, node, cfg, [
        "sync-list-remote",
        "--json",
      ]);
      const match = findRemoteVaults(parseRemoteVaults(remote), cfg.vaultName);
      if (match.length === 1) {
        remoteVaultFound = true;
        remoteVaultId = match[0].id;
      }
    } catch {
      // Network/token issues are reported via loggedIn; leave the rest unknown.
    }
  }
  if (pkg.installed && cfg.vaultPath) {
    try {
      const local = await runOb(deps, node, cfg, ["sync-list-local", "--json"]);
      localConfigured = Boolean(
        findLocalVaultAt(parseLocalVaults(local), cfg.vaultPath),
      );
    } catch {
      // Leave as not configured.
    }
  }

  const appPids = await deps.pids("obsidian");
  const vaultPathExists = Boolean(cfg.vaultPath) &&
    (await deps.exists(cfg.vaultPath));

  return {
    vaultName: cfg.vaultName,
    vaultPath: cfg.vaultPath,
    vaultPathExists,
    desktopRegistered: isDesktopRegistered(desktopVaults, cfg.vaultPath),
    desktopVaults: desktopVaults.map((v) => v.path),
    inAppSyncEnabled: core.syncEnabled,
    inAppSyncConfigured: isDesktopRegistered(desktopVaults, cfg.vaultPath) &&
      core.syncEnabled,
    obsidianAppRunning: appPids.length > 0,
    nodeFound: Boolean(node.binaryPath),
    nodePath: node.binaryPath,
    nodeVersion: node.version,
    nodeMajor: node.major,
    nodeOk: node.major >= REQUIRED_NODE_MAJOR,
    packageInstalled: pkg.installed,
    packageVersion: pkg.version,
    packageCliPath: pkg.cliPath,
    loggedIn,
    authTokenPath,
    remoteVaultFound,
    remoteVaultId,
    localConfigured,
    serviceName: cfg.serviceName,
    serviceHint: `systemctl --user status ${cfg.serviceName}.service`,
    checkedAt: deps.now(),
  };
}

/** The vault's `core-plugins.json` path. */
export function corePluginsPath(cfg: Config): string {
  return `${cfg.vaultPath}/${cfg.configDir}/core-plugins.json`;
}

/**
 * Disable the vault's in-app `sync` core plugin, with a timestamped backup.
 *
 * Idempotent: a vault that never had sync on (or is not present) is left
 * untouched. The desktop app may rewrite the file while it is running, so a
 * warning is recorded when the app appears to be up.
 */
export async function disableInAppSyncForVault(
  deps: Deps,
  cfg: Config,
): Promise<InAppSyncInfo> {
  const path = corePluginsPath(cfg);
  const text = await deps.readText(path);
  const edit = disableSyncCorePlugin(text);
  const platform = deps.platform();
  const desktopDir = cfg.obsidianConfigDir ||
    desktopConfigDir(deps.env, deps.home(), platform);
  const desktopRegistered = isDesktopRegistered(
    parseDesktopVaults(await deps.readText(`${desktopDir}/obsidian.json`)),
    cfg.vaultPath,
  );
  const appRunning = (await deps.pids("obsidian")).length > 0;

  let backupPath = "";
  let changed = false;
  if (text.trim() && edit.changed) {
    backupPath = `${path}.pre-headless-${deps.now().replace(/[:.]/g, "-")}`;
    if (!(await deps.writeText(backupPath, text))) backupPath = "";
    const tmp = `${path}.tmp-${deps.now().replace(/[:.]/g, "-")}`;
    if (await deps.writeText(tmp, edit.text)) {
      await deps.rename(tmp, path);
      changed = true;
    } else {
      await deps.remove(tmp);
    }
  }

  const note = !text.trim()
    ? "No core-plugins.json for this vault — nothing to disable."
    : edit.wasEnabled
    ? changed
      ? "In-app sync disabled; headless sync can take over."
      : "In-app sync was enabled but the config could not be rewritten."
    : "In-app sync was already disabled.";

  return {
    vaultPath: cfg.vaultPath,
    corePluginsPath: path,
    enabledBefore: edit.wasEnabled,
    disabled: !edit.wasEnabled || changed,
    changed,
    backupPath,
    desktopRegistered,
    appRunning,
    note: appRunning
      ? `${note} The Obsidian desktop app appears to be running — close it ` +
        `before syncing, or it may rewrite sync settings.`
      : note,
  };
}

/** Run the `ob` CLI with the resolved node, returning stdout (throws on error). */
export async function runOb(
  deps: Deps,
  node: NodeInfo,
  _cfg: Config,
  args: string[],
): Promise<string> {
  if (!node.binaryPath) throw new Error("No Node.js runtime available.");
  const pkg = await resolvePackage(deps, _cfg);
  if (!pkg.installed || !(await deps.exists(pkg.cliPath))) {
    throw new Error("obsidian-headless is not installed.");
  }
  const out = await deps.run(node.binaryPath, [pkg.cliPath, ...args]);
  if (out.code !== 0) {
    throw new Error(out.stderr || out.stdout || `ob ${args.join(" ")} failed`);
  }
  return out.stdout;
}

/**
 * Resolve the remote vault by name and configure the local vault for sync.
 *
 * Reuses an existing local configuration; otherwise runs `ob sync-setup`, then
 * enforces `syncMode` (and device name) with `ob sync-config`.
 */
export async function configureSync(
  deps: Deps,
  cfg: Config,
  node: NodeInfo,
  force = false,
): Promise<VaultInfo> {
  if (!cfg.vaultName) {
    throw new Error(
      "vaultName is required — set it as a global argument or pass --input vaultName=….",
    );
  }
  if (!cfg.vaultPath) {
    throw new Error(
      "vaultPath is required — pass --input vaultPath=/path/to/vault.",
    );
  }
  if (!(await deps.exists(cfg.vaultPath))) {
    throw new Error(`Vault path does not exist: ${cfg.vaultPath}`);
  }

  const headlessDir = headlessConfigDir(deps.env, deps.home(), deps.platform());
  if (
    !isLoggedIn(
      await deps.readText(`${headlessDir}/auth_token`),
      deps.env("OBSIDIAN_AUTH_TOKEN") ?? "",
    )
  ) {
    throw new Error(
      "Not logged in to Obsidian. Run `ob login` once on this host " +
        "(interactive: email, password, and 2FA), then re-run. The stored " +
        "token is reused by the systemd service.",
    );
  }

  const remoteText = await runOb(deps, node, cfg, [
    "sync-list-remote",
    "--json",
  ]);
  const matches = findRemoteVaults(
    parseRemoteVaults(remoteText),
    cfg.vaultName,
  );
  if (matches.length === 0) {
    throw new Error(
      `Remote vault "${cfg.vaultName}" was not found on this account. ` +
        `Check the name with: ob sync-list-remote`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `Multiple remote vaults are named "${cfg.vaultName}" ` +
        `(${matches.map((m) => m.id).join(", ")}). Pass vaultName as the id.`,
    );
  }
  const remote = matches[0];

  const localText = await runOb(deps, node, cfg, ["sync-list-local", "--json"]);
  const localVaults = parseLocalVaults(localText);
  const existing = findLocalVaultAt(localVaults, cfg.vaultPath);

  let message: string;
  let configured = false;
  let skipped = false;
  if (existing && !force) {
    configured = true;
    skipped = true;
    message = `Already configured for sync at ${cfg.vaultPath}.`;
  } else {
    const args = [
      "sync-setup",
      "--vault",
      cfg.vaultName,
      "--path",
      cfg.vaultPath,
      "--device-name",
      cfg.deviceName,
      "--config-dir",
      cfg.configDir,
      "--json",
    ];
    if (cfg.e2ePassword) args.push("--password", cfg.e2ePassword);
    let setup;
    try {
      setup = await deps.run(node.binaryPath, [
        (await resolvePackage(deps, cfg)).cliPath,
        ...args,
      ]);
    } catch (error) {
      throw new Error(`ob sync-setup failed: ${error}`);
    }
    if (setup.code !== 0) {
      const hint = setup.stderr.includes("Password not provided")
        ? " This vault uses end-to-end encryption — provide e2ePassword " +
          "(from a swamp vault) or run `ob sync-setup` interactively once."
        : "";
      throw new Error(
        `ob sync-setup failed: ${setup.stderr || setup.stdout}.${hint}`,
      );
    }
    configured = true;
    message = `Configured sync for remote vault "${remote.name}".`;
  }

  if (cfg.syncMode !== "bidirectional") {
    const cfgOut = await deps.run(node.binaryPath, [
      (await resolvePackage(deps, cfg)).cliPath,
      "sync-config",
      "--path",
      cfg.vaultPath,
      "--mode",
      cfg.syncMode,
      "--json",
    ]);
    if (cfgOut.code !== 0) {
      throw new Error(
        `ob sync-config failed: ${cfgOut.stderr || cfgOut.stdout}`,
      );
    }
  }

  return {
    vaultName: remote.name,
    vaultId: remote.id,
    region: remote.region,
    vaultPath: cfg.vaultPath,
    configured,
    skipped,
    syncMode: cfg.syncMode,
    deviceName: cfg.deviceName,
    localVaults,
    message,
  };
}

/** Compose the `print` method's summary from the latest resource values. */
export function buildSummary(
  status: Partial<StatusInfo>,
  vault: Partial<VaultInfo>,
  pkg: Partial<PackageInfo>,
  inApp: Partial<InAppSyncInfo>,
  now: string,
): SummaryInfo {
  const serviceName = status.serviceName ?? "obsidian-headless";
  const lines: string[] = [];
  const vaultPath = vault.vaultPath ?? status.vaultPath ?? "";
  const vaultName = vault.vaultName ?? status.vaultName ?? "";
  const nodePath = status.nodePath ?? "";
  const packageVersion = pkg.version ?? status.packageVersion ?? "";

  lines.push(
    `Vault:        ${vaultName || "(unnamed)"} → ${vaultPath || "(unset)"}`,
  );
  lines.push(`Node:         ${nodePath || "(none resolved)"}`);
  lines.push(
    `Package:      obsidian-headless ${packageVersion || "(not installed)"}`,
  );
  const inAppState = inApp.disabled === true
    ? "disabled"
    : inApp.enabledBefore
    ? "still enabled"
    : status.inAppSyncConfigured
    ? "enabled"
    : "not configured";
  lines.push(`In-app sync:  ${inAppState}`);
  lines.push(`Service:      ${serviceName}`);
  lines.push(
    `Inspect:      ${
      status.serviceHint ?? `systemctl --user status ${serviceName}.service`
    }`,
  );

  const ok = Boolean(
    vault.configured && packageVersion && nodePath && inApp.disabled !== false,
  );
  return {
    ok,
    lines,
    vaultName,
    vaultPath,
    packageVersion,
    nodePath,
    serviceName,
    serviceHint: status.serviceHint ??
      `systemctl --user status ${serviceName}.service`,
    checkedAt: now,
  };
}
