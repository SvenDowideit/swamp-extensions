/**
 * Swamp Club extension-registry collector for Swamp Pulse.
 *
 * Reads the public registry API (`/api/v1/extensions/search`) and reports the
 * extensions that are **new** or **changed** within a window, plus the
 * all-time most-pulled extensions.
 *
 * The registry API exposes no date filter, so windowing works by paging the
 * `sort=updated` ordering until a page falls entirely before the window. That
 * one ordering covers both streams: a newly published extension always has
 * `createdAt == updatedAt`, so it appears in the same sweep and is classified
 * as *new* rather than *updated* by comparing the two timestamps.
 *
 * Read-only and unauthenticated. Mirrors the `@svendowideit/swamp-club`
 * conventions for timeouts, 429 handling, truncation flags and CEL-safe text.
 *
 * @module
 */

import { z } from "npm:zod@4";

import { celEscape } from "./cel_text.ts";

const EXTENSION_NAME = "@svendowideit/swamp-ext-registry";

const GlobalArgs = z.object({
  host: z.string().min(1).default("swamp-club.com").describe(
    "Swamp Club host, with or without scheme (default swamp-club.com).",
  ),
  requestTimeoutMs: z.number().int().min(1000).max(120000).default(20000)
    .describe("Per-request timeout in milliseconds."),
  pageSize: z.number().int().min(1).max(100).default(100).describe(
    "Extensions requested per page (the API caps this at 100).",
  ),
});
// NOTE: deliberately NOT .strict() — swamp merges global args into method
// arguments, and a strict global schema rejects them. See the same note in
// swamp_club.ts.

type GlobalArgs = z.infer<typeof GlobalArgs>;

/** One registry entry, normalised for rendering. */
export type Extension = {
  /** Fully-qualified extension name (@scope/name). */
  name: string;
  /** Collective that owns the extension. */
  namespace: string;
  /** Registry description (may be long). */
  description: string;
  /** Source repository URL (may be empty). */
  repository: string;
  /** Host of the source repository (github.com, codeberg.org, …). */
  repositoryHost: string;
  /** Whether the registry verified the repository URL. */
  repositoryVerified: boolean;
  /** Project homepage, if any. */
  homepageUrl: string;
  /** Latest published version. */
  latestVersion: string;
  /** Latest release-candidate version, if any. */
  latestRc: string;
  /** Latest beta version, if any. */
  latestBeta: string;
  /** Publishing username. */
  author: string;
  /** Registry labels. */
  labels: string[];
  /** Content kinds the extension ships (models, workflows, reports, …). */
  contentTypes: string[];
  /** Declared platforms. */
  platforms: string[];
  /** Quality grade (A/B/…) or empty. */
  scoreGrade: string;
  /** Quality percentage, or 0. */
  scorePercentage: number;
  /** All-time pull count. */
  pullCount: number;
  /** First publication timestamp. */
  createdAt: string;
  /** Most recent update timestamp. */
  updatedAt: string;
  /** True when the extension was first published within the queried window. */
  isNew: boolean;
  /** True when it was updated (but not first published) in the window. */
  isUpdated: boolean;
  /** Registry page for the extension. */
  registryUrl: string;
};

const ExtensionSchema: z.ZodType<Extension> = z.object({
  name: z.string().describe("Fully-qualified extension name (@scope/name)"),
  namespace: z.string().describe("Collective that owns the extension"),
  description: z.string().describe("Registry description (may be long)"),
  repository: z.string().describe("Source repository URL (may be empty)"),
  repositoryHost: z.string().describe(
    "Host of the source repository (github.com, codeberg.org, …)",
  ),
  repositoryVerified: z.boolean().describe(
    "Whether the registry verified the repository URL",
  ),
  homepageUrl: z.string().describe("Project homepage, if any"),
  latestVersion: z.string().describe("Latest published version"),
  latestRc: z.string().describe("Latest release-candidate version, if any"),
  latestBeta: z.string().describe("Latest beta version, if any"),
  author: z.string().describe("Publishing username"),
  labels: z.array(z.string()).describe("Registry labels"),
  contentTypes: z.array(z.string()).describe(
    "Content kinds the extension ships (models, workflows, reports, …)",
  ),
  platforms: z.array(z.string()).describe("Declared platforms"),
  scoreGrade: z.string().describe("Quality grade (A/B/…) or empty"),
  scorePercentage: z.number().describe("Quality percentage, or 0"),
  pullCount: z.number().describe("All-time pull count"),
  createdAt: z.string().describe("First publication timestamp"),
  updatedAt: z.string().describe("Most recent update timestamp"),
  isNew: z.boolean().describe(
    "True when the extension was first published within the queried window",
  ),
  isUpdated: z.boolean().describe(
    "True when it was updated (but not first published) in the window",
  ),
  registryUrl: z.string().describe("Registry page for the extension"),
});

/** A page of matched registry entries plus the counts that explain it. */
export type Collection = {
  /** Matched extensions. */
  extensions: Extension[];
  /** Number matched. */
  count: number;
  /** New in the window. */
  newCount: number;
  /** Updated in the window. */
  updatedCount: number;
  /** Highest all-time pull counts, regardless of the window. */
  significant: Extension[];
  /** Total extensions in the registry. */
  totalRegistry: number;
  /** Search pages read. */
  pagesFetched: number;
  /** True when the page cap was reached before the window was exhausted. */
  truncated: boolean;
  /** Lower bound used for the window. */
  since: string;
  /** Upper bound used for the window. */
  until: string;
  /** Timestamp the collection was fetched. */
  fetchedAt: string;
  /** Method execution duration in milliseconds. */
  durationMs: number;
  /** Extension that collected this data. */
  collectedBy: string;
};

const CollectionSchema: z.ZodType<Collection> = z.object({
  extensions: z.array(ExtensionSchema).describe("Matched extensions"),
  count: z.number().describe("Number matched"),
  newCount: z.number().describe("New in the window"),
  updatedCount: z.number().describe("Updated in the window"),
  significant: z.array(ExtensionSchema).describe(
    "Highest all-time pull counts, regardless of the window",
  ),
  totalRegistry: z.number().describe("Total extensions in the registry"),
  pagesFetched: z.number().describe("Search pages read"),
  truncated: z.boolean().describe(
    "True when the page cap was reached before the window was exhausted",
  ),
  since: z.string().describe("Lower bound used for the window"),
  until: z.string().describe("Upper bound used for the window"),
  fetchedAt: z.string().describe("Timestamp the collection was fetched"),
  durationMs: z.number().describe("Method execution duration in milliseconds"),
  collectedBy: z.string().describe("Extension that collected this data"),
});

/**
 * Zod schemas shared with the pulse model.
 *
 * Kept as members of one exported object rather than separately-exported
 * constants: an exported `z.ZodType<T>` constant is reported by
 * `deno doc --lint` as a `private-type-ref` slow type (zod's own types are
 * private), whereas a nested property of an exported object is not checked.
 */
export const schemas = {
  /** Normalised registry entry. */
  extension: ExtensionSchema,
  /** A page of matched registry entries. */
  collection: CollectionSchema,
};

type Context = {
  globalArgs: GlobalArgs;
  writeResource: (
    spec: string,
    name: string,
    data: unknown,
  ) => Promise<{ name: string }>;
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
  };
};

/** Build an absolute registry API URL. */
function url(host: string, path: string): string {
  return `https://${
    host.replace(/^https?:\/\//, "").replace(/\/+$/, "")
  }/api/v1${path}`;
}

/**
 * Issue a registry request.
 *
 * Retries once on HTTP 429, honouring `Retry-After`. Throws a descriptive
 * error carrying the status and body for every other non-2xx response.
 */
async function request(
  ctx: Context,
  path: string,
): Promise<Response> {
  const target = url(ctx.globalArgs.host, path);
  const send = () =>
    fetch(target, {
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(ctx.globalArgs.requestTimeoutMs),
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
  return response;
}

/** Extract the host from a repository URL, or return "". */
export function repoHost(repository: string): string {
  try {
    return new URL(String(repository ?? "")).host;
  } catch {
    return "";
  }
}

/** Normalise one raw registry row into the output schema shape. */
export function normalizeExtension(
  raw: Record<string, unknown>,
  window: { sinceMs: number; untilMs: number },
  host: string,
): Extension {
  const name = String(raw.name ?? "");
  const createdAt = String(raw.createdAt ?? "");
  const updatedAt = String(raw.updatedAt ?? createdAt);
  const createdMs = Date.parse(createdAt);
  const updatedMs = Date.parse(updatedAt);
  const score = (raw.score ?? {}) as { grade?: string; percentage?: number };

  const inWindow = (t: number) =>
    Number.isFinite(t) && t >= window.sinceMs && t <= window.untilMs;
  // A brand-new extension has createdAt == updatedAt; treat it as new only.
  const isNew = inWindow(createdMs);
  const isUpdated = !isNew && inWindow(updatedMs);

  return {
    name,
    namespace: String(raw.namespace ?? ""),
    description: celEscape(String(raw.description ?? "")),
    repository: String(raw.repository ?? ""),
    repositoryHost: repoHost(String(raw.repository ?? "")),
    repositoryVerified: Boolean(raw.repositoryVerified ?? false),
    homepageUrl: String(raw.homepageUrl ?? ""),
    latestVersion: String(raw.latestVersion ?? ""),
    latestRc: String(raw.latestRc ?? ""),
    latestBeta: String(raw.latestBeta ?? ""),
    author: String(
      (raw.author as Record<string, unknown> | undefined)?.username ?? "",
    ),
    labels: Array.isArray(raw.labels)
      ? (raw.labels as unknown[]).map(String)
      : [],
    contentTypes: Array.isArray(raw.contentTypes)
      ? (raw.contentTypes as unknown[]).map(String)
      : [],
    platforms: Array.isArray(raw.platforms)
      ? (raw.platforms as unknown[]).map(String)
      : [],
    scoreGrade: String(score.grade ?? ""),
    scorePercentage: Number(score.percentage ?? 0),
    pullCount: Number(raw.pullCount ?? 0),
    createdAt,
    updatedAt,
    isNew,
    isUpdated,
    registryUrl: `https://${
      host.replace(/^https?:\/\//, "")
    }/extensions/${name}`,
  };
}

/** Registry extension collector. */
export const model = {
  type: "@svendowideit/swamp-ext-registry",
  version: "2026.09.24.1",
  globalArguments: GlobalArgs,
  upgrades: [
    {
      toVersion: "2026.09.18.1",
      description: "Initial release — extension-registry collector",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.09.24.1",
      description:
        "No schema changes — typing only: explicit Extension/Collection types replace z.infer exports so deno doc --lint reports no slow types.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    extensions: {
      description:
        "Registry extensions that are new or changed in a window, plus the most pulled",
      schema: CollectionSchema,
      lifetime: "1h" as const,
      garbageCollection: 5,
    },
  },
  methods: {
    collect_extensions: {
      description:
        "Page the public extension registry and report extensions that are new or updated within a window, plus the all-time most-pulled overall.",
      arguments: z.object({
        since: z.string().describe(
          "ISO-8601 lower bound on createdAt/updatedAt (inclusive).",
        ),
        until: z.string().optional().describe(
          "ISO-8601 upper bound (inclusive). Defaults to now.",
        ),
        maxPages: z.number().int().min(1).max(40).default(35).describe(
          "Maximum search pages to read (100 extensions each).",
        ),
        significantLimit: z.number().int().min(1).max(100).default(25)
          .describe("How many most-pulled extensions to report."),
      }),
      execute: async (
        args: {
          since: string;
          until?: string;
          maxPages: number;
          significantLimit: number;
        },
        context: Context,
      ) => {
        const startMs = Date.now();
        const until = args.until ?? new Date().toISOString();
        const since = args.since && args.since.trim()
          ? args.since
          : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
        const sinceMs = Date.parse(since);
        const untilMs = Date.parse(until);
        const pageSize = context.globalArgs.pageSize;

        const matched: Extension[] = [];
        const allSeen: Extension[] = [];
        let totalRegistry = 0;
        let pages = 0;
        let truncated = false;

        for (let page = 1; page <= args.maxPages; page++) {
          const response = await request(
            context,
            `/extensions/search?perPage=${pageSize}&sort=updated&page=${page}`,
          );
          const body = await response.json() as {
            extensions?: Record<string, unknown>[];
            meta?: { total?: number };
          };
          const rows = Array.isArray(body.extensions) ? body.extensions : [];
          totalRegistry = Number(body.meta?.total ?? totalRegistry);
          pages = page;
          if (rows.length === 0) break;

          let pastWindow = false;
          for (const raw of rows) {
            const normalized = normalizeExtension(
              raw,
              { sinceMs, untilMs },
              context.globalArgs.host,
            );
            allSeen.push(normalized);
            if (normalized.isNew || normalized.isUpdated) {
              matched.push(normalized);
            }
            // `sort=updated` is descending, so once an entry predates the
            // window every later page does too.
            if (Date.parse(normalized.updatedAt) < sinceMs) pastWindow = true;
          }

          if (pastWindow || rows.length < pageSize) break;
          if (page === args.maxPages) truncated = true;
        }

        const significant = allSeen
          .slice()
          .sort((a, b) => b.pullCount - a.pullCount)
          .slice(0, args.significantLimit);

        const handle = await context.writeResource("extensions", "registry", {
          extensions: matched,
          count: matched.length,
          newCount: matched.filter((e) => e.isNew).length,
          updatedCount: matched.filter((e) => e.isUpdated).length,
          significant,
          totalRegistry,
          pagesFetched: pages,
          truncated,
          since,
          until,
          fetchedAt: new Date().toISOString(),
          durationMs: Date.now() - startMs,
          collectedBy: EXTENSION_NAME,
        });
        context.logger.info(
          "Registry: {count} changed ({new} new, {updated} updated) in window, {pages} pages",
          {
            count: matched.length,
            new: matched.filter((e) => e.isNew).length,
            updated: matched.filter((e) => e.isUpdated).length,
            pages,
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
