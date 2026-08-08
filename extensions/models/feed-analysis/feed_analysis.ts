/**
 * Feed analysis — reads pages gathered by the news-reader's gather-pages step,
 * fetches each page, discovers RSS/Atom feeds (via <link rel="alternate"> tags,
 * anchor links to feed paths, direct feed responses, or common feed paths), and
 * writes a `page-discovery-result` resource listing the discovered feeds so the
 * news workflow's upsert-page step can add them to the feed-catalog.
 *
 * The news-reader's `pages-current` data resource has shape:
 *   { pages: [{ url, name, category }], gatheredAt }
 *
 * @module
 */
import { z } from "npm:zod@4";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const GlobalArgsSchema = z.object({
  newsReaderModelId: z.string().default("").describe(
    "Model ID of the news-reader instance whose pages-current data to read",
  ),
}).strict();

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const AnalyzePagesArgsSchema = z.object({
  maxPagesPerRun: z.number().int().min(1).max(500).default(50).describe(
    "Maximum pages to analyze this run (default 50)",
  ),
  probeCommonPaths: z.boolean().default(true).describe(
    "Probe common feed paths on pages that advertise no feed link (default true)",
  ),
}).describe("Arguments for the analyzePages method");

type AnalyzePagesArgs = z.infer<typeof AnalyzePagesArgsSchema>;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A discovered feed from analyzing a page. */
export interface DiscoveredFeed {
  /** Feed URL (absolute). */
  url: string;
  /** Feed type (rss, atom, or unknown). */
  type: string;
  /** Title from the feed link's title attribute or page name (if available). */
  title: string;
  /** The source page/site URL where this feed was found. */
  sourceSite: string;
  /** Category of the source page (from the news-reader pages data), if any. */
  category: string;
}

/** Result of the page-analysis run. */
export interface PageDiscoveryResult {
  /** ISO-8601 timestamp. */
  analyzedAt: string;
  /** Total pages examined. */
  pagesAnalyzed: number;
  /** Pages from which at least one feed was discovered. */
  pagesWithFeeds: number;
  /** Feeds discovered across all pages (deduplicated by URL). */
  discoveredFeeds: DiscoveredFeed[];
  /** Errors encountered while fetching/analyzing pages. */
  errors: { url: string; message: string }[];
}

const DiscoveredFeedSchema = z.object({
  url: z.string().url(),
  type: z.string(),
  title: z.string(),
  sourceSite: z.string(),
  category: z.string(),
});

const PageDiscoveryResultSchema = z.object({
  analyzedAt: z.iso.datetime(),
  pagesAnalyzed: z.number(),
  pagesWithFeeds: z.number(),
  discoveredFeeds: z.array(DiscoveredFeedSchema),
  errors: z.array(z.object({ url: z.string(), message: z.string() })),
});

type MethodContext = {
  globalArgs: GlobalArgs;
  logger?: { info: (msg: string, props?: Record<string, unknown>) => void };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
  dataRepository: {
    getContent: (
      type: string,
      modelId: string,
      dataName: string,
      version?: number,
    ) => Promise<Uint8Array | null>;
  };
};

// ---------------------------------------------------------------------------
// Domain helpers
// ---------------------------------------------------------------------------

/** Extract the registered domain from a URL (strip protocol, path, and www.). */
export function extractDomain(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Get the site root URL (scheme + host) for a URL. */
export function siteRoot(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "";
  }
}

/** Common feed paths to probe when a page advertises no feed link. */
const COMMON_FEED_PATHS = [
  "/rss",
  "/feed",
  "/rss.xml",
  "/feed.xml",
  "/atom.xml",
  "/index.xml",
  "/feed/",
  "/rss/",
  "/atom/",
];

const FEED_CONTENT_TYPES = [
  "application/rss+xml",
  "application/atom+xml",
  "application/feed+json",
  "text/xml",
  "application/xml",
];

/**
 * Detect whether a fetched body is itself a feed (XML RSS/Atom or JSON Feed)
 * based on its content-type and initial body markers.
 */
export function isFeedContent(contentType: string, body: string): boolean {
  const ct = contentType.toLowerCase();
  if (FEED_CONTENT_TYPES.some((t) => ct.includes(t))) {
    return true;
  }
  const trimmed = body.trimStart().slice(0, 300).toLowerCase();
  if (!trimmed.startsWith("<?xml") && !trimmed.startsWith("{")) return false;
  return trimmed.includes("<rss") ||
    trimmed.includes("<feed") ||
    trimmed.includes("<rdf:rdf") ||
    (trimmed.includes('"version"') && trimmed.includes('"items"'));
}

/** Fetch a URL and return its body plus content-type (without rejecting feeds). */
export async function fetchContent(
  url: string,
): Promise<{ body: string; contentType: string; error?: string }> {
  try {
    const resp = await fetch(url, {
      headers: {
        "User-Agent": "swamp-feed-analysis/1.0",
        "Accept":
          "text/html,application/xhtml+xml,application/xml,application/rss+xml,application/atom+xml,application/feed+json,*/*",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) {
      return { body: "", contentType: "", error: `HTTP ${resp.status}` };
    }
    const contentType = resp.headers.get("content-type") ?? "";
    const body = await resp.text();
    return { body, contentType };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { body: "", contentType: "", error: msg };
  }
}

/**
 * Extract feed URLs from HTML via <link rel="alternate"> tags and <a href>
 * anchors linking to feed paths.
 */
export function extractFeedLinks(
  html: string,
  sourceUrl: string,
): DiscoveredFeed[] {
  const feeds: DiscoveredFeed[] = [];
  const root = siteRoot(sourceUrl);
  const seen = new Set<string>();

  const push = (url: string, type: string, title: string) => {
    try {
      const abs = new URL(url, root).href;
      if (seen.has(abs)) return;
      seen.add(abs);
      feeds.push({ url: abs, type, title, sourceSite: root, category: "" });
    } catch {
      // skip unparseable URLs
    }
  };

  // <link rel="alternate" type="application/rss+xml" href="..."> and atom
  const linkRegex =
    /<link[^>]*rel=["']alternate["'][^>]*type=["']application\/(rss|atom)\+xml["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = linkRegex.exec(html)) !== null) {
    const tag = m[0];
    const kind = m[1] === "atom" ? "atom" : "rss";
    const href = tag.match(/href=["']([^"']+)["']/i)?.[1];
    const titleMatch = tag.match(/title=["']([^"']*)["']/i);
    const title = titleMatch ? titleMatch[1] : "";
    if (href) push(href, kind, title);
  }

  // <a href="...">Subscribe via RSS</a> style anchors
  const anchorRegex = /<a[^>]*href=["']([^"']+)["'][^>]*>([^<]*)<\/a>/gi;
  while ((m = anchorRegex.exec(html)) !== null) {
    const href = m[1];
    const text = (m[2] ?? "").toLowerCase();
    const lower = href.toLowerCase();
    if (
      lower.includes("rss") ||
      lower.includes("atom") ||
      lower.includes("feed") ||
      text.includes("rss") ||
      text.includes("atom") ||
      text.includes("feed")
    ) {
      push(href, lower.includes("atom") ? "atom" : "rss", "");
    }
  }

  return feeds;
}

/** Probe the common feed paths on a page's site root. */
async function probeCommonPaths(
  sourceUrl: string,
): Promise<DiscoveredFeed[]> {
  const base = siteRoot(sourceUrl);
  if (!base) return [];
  const feeds: DiscoveredFeed[] = [];
  for (const path of COMMON_FEED_PATHS) {
    const probeUrl = new URL(path, base).href;
    const res = await fetchContent(probeUrl);
    if (res.error) continue;
    if (isFeedContent(res.contentType, res.body)) {
      const type = res.contentType.includes("atom")
        ? "atom"
        : res.contentType.includes("rss")
        ? "rss"
        : "unknown";
      feeds.push({
        url: probeUrl,
        type,
        title: "",
        sourceSite: base,
        category: "",
      });
    }
  }
  return feeds;
}

// ---------------------------------------------------------------------------
// Cross-model data access
// ---------------------------------------------------------------------------

/** Read a JSON data resource written by another model instance. */
async function readCrossModelData(
  context: MethodContext,
  type: string,
  modelId: string,
  dataName: string,
): Promise<Record<string, unknown> | null> {
  if (!modelId) return null;
  const bytes = await context.dataRepository.getContent(
    type,
    modelId,
    dataName,
  );
  if (!bytes) return null;
  const text = new TextDecoder().decode(bytes);
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export const model = {
  type: "@svendowideit/feed-analysis",
  version: "2026.08.03.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    pageDiscovery: {
      description: "Result of the most recent page-analysis run",
      schema: PageDiscoveryResultSchema,
      lifetime: "30d",
      garbageCollection: 10,
    },
  },
  methods: {
    analyzePages: {
      description:
        "Analyze pages gathered by the news-reader, discover RSS/Atom feeds in each page, and write a page-discovery-result resource",
      arguments: AnalyzePagesArgsSchema,
      execute: async (
        args: AnalyzePagesArgs,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const logger = context.logger;

        const pagesData = await readCrossModelData(
          context,
          "@svendowideit/news-reader",
          context.globalArgs.newsReaderModelId,
          "pages-current",
        );

        const pages: unknown[] = Array.isArray(pagesData?.pages)
          ? pagesData!.pages
          : [];

        const discovered: DiscoveredFeed[] = [];
        const seenUrls = new Set<string>();
        const errors: { url: string; message: string }[] = [];
        let pagesWithFeeds = 0;
        const limit = Math.min(pages.length, args.maxPagesPerRun);

        for (let i = 0; i < limit; i++) {
          const page = pages[i] as {
            url?: unknown;
            name?: unknown;
            category?: unknown;
          } | null;
          const url = page && typeof page.url === "string" ? page.url : "";
          if (!url) continue;
          const name = page && typeof page.name === "string" ? page.name : "";
          const category = page && typeof page.category === "string"
            ? page.category
            : "";

          logger?.info("Analyzing page: {url}", { url });
          const res = await fetchContent(url);
          if (res.error) {
            errors.push({ url, message: res.error });
            continue;
          }

          let pageFeeds: DiscoveredFeed[] = [];

          // The page itself is a feed.
          if (isFeedContent(res.contentType, res.body)) {
            const type = res.contentType.includes("atom")
              ? "atom"
              : res.contentType.includes("rss")
              ? "rss"
              : "unknown";
            pageFeeds.push({
              url,
              type,
              title: name,
              sourceSite: siteRoot(url),
              category,
            });
          } else {
            pageFeeds = extractFeedLinks(res.body, url);
            // No advertised feed link — probe common paths on the site root.
            if (pageFeeds.length === 0 && args.probeCommonPaths) {
              pageFeeds = await probeCommonPaths(url);
            }
          }

          // Deduplicate across all pages and collect.
          let added = 0;
          for (const feed of pageFeeds) {
            if (seenUrls.has(feed.url)) continue;
            seenUrls.add(feed.url);
            if (!feed.title) feed.title = name;
            if (!feed.category) feed.category = category;
            discovered.push(feed);
            added++;
          }
          if (added > 0) pagesWithFeeds++;

          for (const feed of pageFeeds) {
            logger?.info("Discovered feed: {url} ({type})", {
              url: feed.url,
              type: feed.type,
            });
          }
        }

        const result: PageDiscoveryResult = {
          analyzedAt: new Date().toISOString(),
          pagesAnalyzed: limit,
          pagesWithFeeds,
          discoveredFeeds: discovered,
          errors,
        };

        const handle = await context.writeResource(
          "pageDiscovery",
          "page-discovery-result",
          { ...result },
        );

        logger?.info(
          "analyzePages: {pages} pages analyzed, {found} feeds discovered, {errors} errors",
          {
            pages: limit,
            found: discovered.length,
            errors: errors.length,
          },
        );

        return { dataHandles: [handle] };
      },
    },
  },
};
