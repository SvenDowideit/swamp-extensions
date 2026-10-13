/**
 * Extension releases — an additive, append-only log of swamp extension releases
 * and promotions across the `stable`, `rc` and `beta` channels.
 *
 * Every few hours `collect` reads the public swamp-club registry for a set of
 * namespaces (by default the current swamp user and every collective they
 * belong to), compares each extension's published channel versions with the
 * last-seen snapshot, and appends one immutable entry to the `log` resource for
 * every version that appears on a channel it had not been seen on before. A
 * version seen first on a lower channel and later on a higher one is recorded
 * as a promotion, so the diary (and anything else reading the log) can show the
 * whole beta → rc → stable story without ever losing an earlier entry.
 *
 * The registry is read-only and unauthenticated; the only local command used is
 * `swamp auth whoami --json`, and only when the tracked namespaces are not
 * configured explicitly. This module never publishes, promotes, or edits an
 * extension.
 *
 * @module
 */

import { z } from "npm:zod@4";

/** Default swamp-club host, with or without scheme. */
export const DEFAULT_HOST = "swamp-club.com";

/**
 * Default first-run window, in hours. On the very first run there is no
 * snapshot to diff against, so releasing the whole back-catalogue into the log
 * would flood the diary. Only versions published within this window are
 * logged on the first run; everything older just seeds the snapshot.
 */
export const DEFAULT_BOOTSTRAP_HOURS = 48;

/** Default number of registry search pages read per namespace (100 each). */
export const DEFAULT_MAX_SEARCH_PAGES = 20;

/** Default number of version pages read per changed extension (100 each). */
export const DEFAULT_VERSION_PAGES = 2;

/** Release channels, ordered lowest to highest. */
export const CHANNELS = ["beta", "rc", "stable"] as const;

/** A release channel name. */
export type Channel = typeof CHANNELS[number];

/** Promotion rank — a higher rank is a promotion target from a lower one. */
export const CHANNEL_RANK: Record<string, number> = {
  beta: 1,
  rc: 2,
  stable: 3,
};

const GlobalArgsSchema = z.object({
  host: z.string().min(1).default(DEFAULT_HOST).describe(
    "Swamp Club host, with or without scheme (default swamp-club.com).",
  ),
  requestTimeoutMs: z.number().int().min(1000).max(120000).default(20_000)
    .describe("Per-request timeout in milliseconds."),
  namespaces: z.array(z.string()).default([]).describe(
    "Collective/user slugs to track, without a leading '@' (e.g. " +
      '["svendowideit","figy"]). Empty discovers the current swamp user and ' +
      "every collective they belong to via `swamp auth whoami`.",
  ),
  bootstrapHours: z.number().int().min(0).max(24 * 365).default(
    DEFAULT_BOOTSTRAP_HOURS,
  ).describe(
    "On the first run only, log versions published within this many hours so " +
      "the back-catalogue is not released into the log at once.",
  ),
  maxSearchPages: z.number().int().min(1).max(60).default(
    DEFAULT_MAX_SEARCH_PAGES,
  ).describe("Maximum registry search pages per namespace (100 each)."),
  versionPages: z.number().int().min(1).max(10).default(DEFAULT_VERSION_PAGES)
    .describe("Maximum version pages read per changed extension (100 each)."),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const CollectArgsSchema = z.object({
  bootstrapHours: z.number().int().min(0).max(24 * 365).optional().describe(
    "Override the first-run bootstrap window for this call.",
  ),
});

type CollectArgs = z.infer<typeof CollectArgsSchema>;

/** One immutable release/promotion record appended to the log. */
export interface ReleaseEntry {
  /** Fully-qualified extension name (`@scope/name`). */
  extension: string;
  /** Namespace (collective) that owns the extension. */
  namespace: string;
  /** Published version string. */
  version: string;
  /** Channel the version was newly seen on (`stable` | `rc` | `beta`). */
  channel: string;
  /** `publish` for a first sighting, `promote` for a channel move. */
  event: string;
  /** Lower channel the version was previously seen on, or `""`. */
  fromChannel: string;
  /** Registry publish timestamp for the version, or `observedAt` if absent. */
  publishedAt: string;
  /** When this poll first observed the version/channel pair (ISO 8601). */
  observedAt: string;
  /** Publishing username reported by the registry, or `""`. */
  author: string;
  /** Registry page for the extension. */
  url: string;
}

const ReleaseEntrySchema = z.object({
  extension: z.string(),
  namespace: z.string(),
  version: z.string(),
  channel: z.string(),
  event: z.string(),
  fromChannel: z.string(),
  publishedAt: z.string(),
  observedAt: z.string(),
  author: z.string(),
  url: z.string(),
});

const LogSchema = z.object({
  entries: z.array(ReleaseEntrySchema),
  count: z.number().int().nonnegative(),
  updatedAt: z.string(),
  namespaces: z.array(z.string()),
});

const ChannelEntrySchema = z.object({
  stable: z.string(),
  rc: z.string(),
  beta: z.string(),
  updatedAt: z.string(),
  author: z.string(),
});

const StateSchema = z.object({
  channels: z.record(z.string(), ChannelEntrySchema),
  pairs: z.record(z.string(), z.array(z.string())),
  namespaces: z.array(z.string()),
  updatedAt: z.string(),
});

/** Published versions for an extension, one per channel (`""` when absent). */
export interface ChannelTriple {
  /** Latest stable version. */
  stable: string;
  /** Latest release-candidate version. */
  rc: string;
  /** Latest beta version. */
  beta: string;
}

/** A registry row, normalised for diffing. */
export interface RegistryExtension {
  /** Fully-qualified extension name. */
  name: string;
  /** Namespace (collective) that owns it. */
  namespace: string;
  /** Publishing username. */
  author: string;
  /** Latest stable version. */
  latestVersion: string;
  /** Latest rc version. */
  latestRc: string;
  /** Latest beta version. */
  latestBeta: string;
  /** Registry last-updated timestamp. */
  updatedAt: string;
  /** Registry page URL. */
  url: string;
}

/** One version row from `/extensions/{name}/versions`. */
export interface VersionRow {
  /** Version string. */
  version: string;
  /** Channel this version is currently published on. */
  channel: string;
  /** Publish timestamp, or `""`. */
  publishedAt: string;
}

/** Structural view of the method context fields this extension uses. */
interface ExecContext {
  globalArgs: GlobalArgs;
  repoDir: string;
  logger?: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warn: (msg: string, props?: Record<string, unknown>) => void;
    debug?: (msg: string, props?: Record<string, unknown>) => void;
  };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
  readResource?: (
    instanceName: string,
    version?: number,
  ) => Promise<Record<string, unknown> | null>;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for testing)
// ---------------------------------------------------------------------------

/** Strip a scheme and trailing slashes from a host. */
export function normalizeHost(host: string): string {
  return String(host ?? "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

/** Registry page URL for an extension. */
export function registryUrl(host: string, name: string): string {
  return `https://${normalizeHost(host)}/extensions/${name}`;
}

/** Strip a leading `@` and surrounding whitespace from a namespace slug. */
export function normalizeNamespace(slug: string): string {
  return String(slug ?? "").trim().replace(/^@/, "");
}

/** Deduplicate and normalise a list of namespace slugs, dropping blanks. */
export function dedupeNamespaces(slugs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of slugs) {
    const slug = normalizeNamespace(raw);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    out.push(slug);
  }
  return out;
}

/** The canonical key identifying a seen version on a channel. */
export function pairKey(version: string, channel: string): string {
  return `${version}|${channel}`;
}

/** True when `channel` is a known release channel. */
export function isChannel(channel: string): boolean {
  return Object.prototype.hasOwnProperty.call(CHANNEL_RANK, channel);
}

/** The published-versions triple for a registry row. */
export function channelTriple(ext: RegistryExtension): ChannelTriple {
  return {
    stable: ext.latestVersion ?? "",
    rc: ext.latestRc ?? "",
    beta: ext.latestBeta ?? "",
  };
}

/** True when two channel triples describe the same published versions. */
export function triplesEqual(
  a: ChannelTriple,
  b: ChannelTriple,
): boolean {
  return a.stable === b.stable && a.rc === b.rc && a.beta === b.beta;
}

/** Normalise one registry search row. */
export function normalizeRow(
  raw: Record<string, unknown>,
  host: string,
): RegistryExtension {
  const name = String(raw.name ?? "");
  const author = (raw.author as Record<string, unknown> | undefined) ?? {};
  return {
    name,
    namespace: String(raw.namespace ?? ""),
    author: String(author.username ?? ""),
    latestVersion: String(raw.latestVersion ?? ""),
    latestRc: String(raw.latestRc ?? ""),
    latestBeta: String(raw.latestBeta ?? ""),
    updatedAt: String(raw.updatedAt ?? ""),
    url: registryUrl(host, name),
  };
}

/** Normalise the `versions` array of a `/versions` response. */
export function normalizeVersionRows(
  body: Record<string, unknown>,
): VersionRow[] {
  const rows = Array.isArray(body.versions)
    ? body.versions as Array<Record<string, unknown>>
    : [];
  const out: VersionRow[] = [];
  for (const raw of rows) {
    const version = String(raw.version ?? "");
    if (!version) continue;
    out.push({
      version,
      channel: String(raw.channel ?? "").toLowerCase(),
      publishedAt: String(raw.publishedAt ?? ""),
    });
  }
  return out;
}

/**
 * Build the full set of known `version|channel` keys for an extension from its
 * current version rows, so the next run can diff against it. This includes
 * pairs that did not qualify for the log (e.g. suppressed by the first-run
 * bootstrap window): they are baseline, not news.
 */
export function collectPairs(versions: VersionRow[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of versions) {
    if (!row.version || !isChannel(row.channel)) continue;
    const key = pairKey(row.version, row.channel);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/** Options for {@link planEntries}. */
export interface PlanOptions {
  /** Fully-qualified extension name. */
  extension: string;
  /** Namespace (collective) that owns it. */
  namespace: string;
  /** Publishing username, or `""`. */
  author: string;
  /** Registry page URL. */
  url: string;
  /** Current version rows from the registry. */
  versions: VersionRow[];
  /** `version|channel` pairs already seen in the snapshot. */
  knownPairs: Set<string>;
  /** When set, suppress entries published before this epoch ms (first run). */
  bootstrapSinceMs: number | null;
  /** Poll timestamp for entries that have no registry publish time. */
  observedAt: string;
}

/**
 * Diff the current version rows against the snapshot and return the immutable
 * log entries for every newly-seen `version|channel` pair, in registry order.
 *
 * A version seen before on a lower-ranked channel and now on a higher one is a
 * promotion (`event: "promote"`, `fromChannel` recorded); anything else is a
 * `publish`. When `bootstrapSinceMs` is set (first run), only entries whose
 * publish time is at or after it are emitted — older pairs are still added to
 * the caller's snapshot by {@link collectPairs}, so they never resurface.
 */
export function planEntries(opts: PlanOptions): ReleaseEntry[] {
  const entries: ReleaseEntry[] = [];
  const seen = new Set(opts.knownPairs);

  for (const row of opts.versions) {
    if (!row.version || !isChannel(row.channel)) continue;
    const key = pairKey(row.version, row.channel);
    if (seen.has(key)) continue;
    seen.add(key);

    let fromChannel = "";
    for (const c of CHANNELS) {
      if (c === row.channel) continue;
      if (CHANNEL_RANK[c] >= CHANNEL_RANK[row.channel]) continue;
      if (opts.knownPairs.has(pairKey(row.version, c))) {
        if (!fromChannel || CHANNEL_RANK[c] > CHANNEL_RANK[fromChannel]) {
          fromChannel = c;
        }
      }
    }

    const publishedAt = row.publishedAt || opts.observedAt;
    if (opts.bootstrapSinceMs !== null) {
      const t = Date.parse(publishedAt);
      if (!Number.isFinite(t) || t < opts.bootstrapSinceMs) continue;
    }

    entries.push({
      extension: opts.extension,
      namespace: opts.namespace,
      version: row.version,
      channel: row.channel,
      event: fromChannel ? "promote" : "publish",
      fromChannel,
      publishedAt,
      observedAt: opts.observedAt,
      author: opts.author,
      url: opts.url,
    });
  }

  return entries;
}

/**
 * Parse `trustedCollectives:` from a `.swamp.yaml` body, used as an offline
 * fallback when `swamp auth whoami` is unavailable. Only the entries directly
 * under that top-level key are read.
 */
export function parseTrustedCollectives(yaml: string): string[] {
  const lines = String(yaml ?? "").split("\n");
  const out: string[] = [];
  let inBlock = false;
  for (const line of lines) {
    if (/^trustedCollectives:\s*$/.test(line)) {
      inBlock = true;
      continue;
    }
    if (!inBlock) continue;
    const item = line.match(/^\s+-\s+(.+?)\s*$/);
    if (item) {
      out.push(normalizeNamespace(item[1].replace(/^["']|["']$/g, "")));
      continue;
    }
    if (line.trim().length > 0 && /^[A-Za-z]/.test(line)) break;
  }
  return dedupeNamespaces(out);
}

// ---------------------------------------------------------------------------
// Command + registry I/O
// ---------------------------------------------------------------------------

/** Result of running a subprocess. */
interface CmdResult {
  /** Exit code (124 = timed out, 127 = not spawned). */
  code: number;
  /** Captured stdout. */
  stdout: string;
  /** Captured stderr. */
  stderr: string;
}

/**
 * Run a command with a bounded timeout.
 *
 * The only caller is `swamp auth whoami --json`, used to discover the current
 * user and their collectives when `namespaces` is not configured. The arguments
 * are a fixed list with no user input, the working directory is the repo, and
 * the read-only fallback to `.swamp.yaml` covers an unauthenticated host.
 */
async function runCommand(
  bin: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<CmdResult> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // swamp-quality-ignore deno-command: fixed-argument swamp auth whoami --json scope discovery documented in the README
    const out = await new Deno.Command(bin, {
      args,
      cwd: opts.cwd,
      stdout: "piped",
      stderr: "piped",
      signal: controller.signal,
    }).output();
    return {
      code: out.code,
      stdout: new TextDecoder().decode(out.stdout),
      stderr: new TextDecoder().decode(out.stderr),
    };
  } catch (err) {
    const timedOut = err instanceof DOMException && err.name === "AbortError";
    return {
      code: timedOut ? 124 : 127,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Issue a registry API request, retrying once on HTTP 429. */
async function registryRequest(
  host: string,
  path: string,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const target = `https://${normalizeHost(host)}/api/v1${path}`;
  const send = () =>
    fetch(target, {
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });

  let response: Response;
  try {
    response = await send();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Registry request to ${path} failed: ${message}`);
  }

  if (response.status === 429) {
    const retryAfter = Number(response.headers.get("retry-after") ?? "1");
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(retryAfter * 1000, 30_000)
      : 1000;
    await response.body?.cancel();
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    response = await send();
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Registry API ${path} returned HTTP ${response.status}: ${body}`,
    );
  }
  return await response.json() as Record<string, unknown>;
}

/** Page a namespace's extensions from the search API. */
async function searchNamespace(
  host: string,
  namespace: string,
  timeoutMs: number,
  maxPages: number,
): Promise<RegistryExtension[]> {
  const out: RegistryExtension[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const body = await registryRequest(
      host,
      `/extensions/search?perPage=100&sort=updated&collective=${
        encodeURIComponent(namespace)
      }&page=${page}`,
      timeoutMs,
    );
    const rows = Array.isArray(body.extensions)
      ? body.extensions as Array<Record<string, unknown>>
      : [];
    for (const raw of rows) out.push(normalizeRow(raw, host));
    if (rows.length < 100) break;
  }
  return out;
}

/** Page an extension's versions from the versions API. */
async function fetchVersions(
  host: string,
  name: string,
  timeoutMs: number,
  versionPages: number,
): Promise<VersionRow[]> {
  const out: VersionRow[] = [];
  for (let page = 1; page <= versionPages; page++) {
    const body = await registryRequest(
      host,
      `/extensions/${name}/versions?perPage=100&page=${page}`,
      timeoutMs,
    );
    const rows = normalizeVersionRows(body);
    out.push(...rows);
    const meta = (body.meta as Record<string, unknown> | undefined) ?? {};
    const total = Number(meta.total ?? 0);
    if (rows.length === 0 || (total > 0 && page * 100 >= total)) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Namespace resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the namespace slugs to track. When `namespaces` is configured, only
 * those are used (never any others). Otherwise the current swamp user and every
 * collective they belong to are discovered via `swamp auth whoami --json`,
 * falling back to `trustedCollectives:` in `.swamp.yaml`.
 */
async function resolveNamespaces(
  globalArgs: GlobalArgs,
  repoDir: string,
  logger?: ExecContext["logger"],
): Promise<{ namespaces: string[]; source: string }> {
  if (globalArgs.namespaces && globalArgs.namespaces.length > 0) {
    return {
      namespaces: dedupeNamespaces(globalArgs.namespaces),
      source: "configured",
    };
  }

  const who = await runCommand("swamp", ["auth", "whoami", "--json"], {
    cwd: repoDir,
    timeoutMs: 15_000,
  });
  if (who.code === 0) {
    try {
      const identity = JSON.parse(who.stdout) as {
        username?: string;
        collectives?: string[];
      };
      const names = dedupeNamespaces([
        identity.username ?? "",
        ...(identity.collectives ?? []),
      ]);
      if (names.length > 0) return { namespaces: names, source: "whoami" };
    } catch {
      // fall through to the repo config
    }
  }

  try {
    const yaml = await Deno.readTextFile(`${repoDir}/.swamp.yaml`);
    const trusted = parseTrustedCollectives(yaml);
    if (trusted.length > 0) return { namespaces: trusted, source: "config" };
  } catch {
    // nothing to fall back to
  }

  logger?.warn(
    "Could not discover namespaces: `swamp auth whoami` failed and " +
      "trustedCollectives was empty. Configure the `namespaces` global arg.",
    { stderr: who.stderr.slice(0, 200) },
  );
  throw new Error(
    "No namespaces to track. Set the `namespaces` global arg (e.g. " +
      "`--global-arg 'namespaces:json=[\"svendowideit\"]'`) or run " +
      "`swamp auth login`.",
  );
}

// ---------------------------------------------------------------------------
// Previous resources
// ---------------------------------------------------------------------------

/** Read the previous `state` resource, or null when absent/unreadable. */
async function readPriorState(
  context: ExecContext,
): Promise<Record<string, unknown> | null> {
  if (!context.readResource) return null;
  try {
    return await context.readResource("state");
  } catch {
    return null;
  }
}

/** Read the previous `log` resource, or null when absent/unreadable. */
async function readPriorLog(
  context: ExecContext,
): Promise<Record<string, unknown> | null> {
  if (!context.readResource) return null;
  try {
    return await context.readResource("log");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Model definition
// ---------------------------------------------------------------------------

/** Model definition for the extension release log. */
export const model = {
  type: "@svendowideit/extension-releases",
  version: "2026.10.13.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.10.13.1",
      description:
        "Initial release — an additive log of extension releases and " +
        "promotions across the stable / rc / beta channels.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    log: {
      description:
        "Append-only log of extension releases and promotions by channel",
      schema: LogSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    state: {
      description:
        "Last-seen channel/version pairs per tracked extension (diff baseline)",
      schema: StateSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
  },
  methods: {
    collect: {
      description:
        "Poll the registry for every tracked namespace and append newly-seen " +
        "version/channel releases and promotions to the additive log",
      arguments: CollectArgsSchema,
      execute: async (
        args: CollectArgs,
        context: ExecContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const started = Date.now();
        const g = context.globalArgs;
        const observedAt = new Date().toISOString();
        const logger = context.logger;

        const { namespaces, source } = await resolveNamespaces(
          g,
          context.repoDir,
          logger,
        );
        logger?.info(
          "Tracking {count} namespace(s) ({source}): {list}",
          {
            count: namespaces.length,
            source,
            list: namespaces.join(", "),
          },
        );

        const priorStateRaw = await readPriorState(context);
        const priorLogRaw = await readPriorLog(context);
        const firstRun = priorStateRaw === null;
        const priorChannels = (priorStateRaw?.channels as Record<
          string,
          Record<string, unknown>
        >) ??
          {};
        const priorPairs = (priorStateRaw?.pairs as Record<string, string[]>) ??
          {};
        const priorEntries = Array.isArray(priorLogRaw?.entries)
          ? priorLogRaw.entries as ReleaseEntry[]
          : [];

        // Discover every extension across the tracked namespaces.
        const found = new Map<string, RegistryExtension>();
        for (const ns of namespaces) {
          try {
            const exts = await searchNamespace(
              g.host,
              ns,
              g.requestTimeoutMs,
              g.maxSearchPages,
            );
            for (const ext of exts) {
              if (ext.name && !found.has(ext.name)) found.set(ext.name, ext);
            }
          } catch (err) {
            logger?.warn("Search failed for namespace {ns}: {err}", {
              ns,
              err: err instanceof Error ? err.message : String(err),
            });
          }
        }
        if (found.size === 0) {
          logger?.warn(
            "No extensions found across {count} namespace(s); leaving log unchanged",
            { count: namespaces.length },
          );
        }

        const bootstrapHours = args.bootstrapHours ?? g.bootstrapHours;
        const bootstrapSinceMs = firstRun
          ? Date.now() - bootstrapHours * 3_600_000
          : null;

        const newEntries: ReleaseEntry[] = [];
        const stateChannels: Record<string, Record<string, unknown>> = {};
        const statePairs: Record<string, string[]> = {};
        let fetched = 0;
        let unchanged = 0;

        for (const ext of found.values()) {
          const prior = priorChannels[ext.name];
          const triple = channelTriple(ext);
          const priorTriple: ChannelTriple = {
            stable: String(prior?.stable ?? ""),
            rc: String(prior?.rc ?? ""),
            beta: String(prior?.beta ?? ""),
          };
          const changed = !prior ||
            !triplesEqual(triple, priorTriple) ||
            String(prior?.updatedAt ?? "") !== ext.updatedAt;

          if (!changed) {
            unchanged++;
            stateChannels[ext.name] = {
              ...triple,
              updatedAt: ext.updatedAt,
              author: ext.author,
            };
            statePairs[ext.name] = priorPairs[ext.name] ?? [];
            continue;
          }

          fetched++;
          let versions: VersionRow[];
          try {
            versions = await fetchVersions(
              g.host,
              ext.name,
              g.requestTimeoutMs,
              g.versionPages,
            );
          } catch (err) {
            logger?.warn("Version fetch failed for {name}: {err}", {
              name: ext.name,
              err: err instanceof Error ? err.message : String(err),
            });
            stateChannels[ext.name] = {
              ...triple,
              updatedAt: ext.updatedAt,
              author: ext.author,
            };
            statePairs[ext.name] = priorPairs[ext.name] ?? [];
            continue;
          }

          const knownPairs = new Set(priorPairs[ext.name] ?? []);
          newEntries.push(
            ...planEntries({
              extension: ext.name,
              namespace: ext.namespace,
              author: ext.author,
              url: ext.url,
              versions,
              knownPairs,
              bootstrapSinceMs,
              observedAt,
            }),
          );
          stateChannels[ext.name] = {
            ...triple,
            updatedAt: ext.updatedAt,
            author: ext.author,
          };
          statePairs[ext.name] = collectPairs(versions);
        }

        newEntries.sort((a, b) =>
          (a.publishedAt || "").localeCompare(b.publishedAt || "") ||
          a.extension.localeCompare(b.extension) ||
          a.version.localeCompare(b.version) ||
          a.channel.localeCompare(b.channel)
        );

        const entries = [...priorEntries, ...newEntries];
        const logHandle = await context.writeResource("log", "log", {
          entries,
          count: entries.length,
          updatedAt: observedAt,
          namespaces,
        } as unknown as Record<string, unknown>);
        const stateHandle = await context.writeResource("state", "state", {
          channels: stateChannels,
          pairs: statePairs,
          namespaces,
          updatedAt: observedAt,
        } as unknown as Record<string, unknown>);

        logger?.info(
          "Collected {new} new release(s) across {tracked} extension(s) " +
            "({fetched} checked, {unchanged} unchanged) in {ms}ms; log now {total}",
          {
            new: newEntries.length,
            tracked: found.size,
            fetched,
            unchanged,
            ms: Date.now() - started,
            total: entries.length,
          },
        );

        return { dataHandles: [logHandle, stateHandle] };
      },
    },
  },
};
