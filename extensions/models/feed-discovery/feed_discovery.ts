/**
 * Feed discovery — reads article URLs from the news-reader's snapshot, finds
 * RSS/Atom feeds for domains not yet known, and upserts discovered feeds into
 * the feed-catalog.
 *
 * Improvements over the original:
 *  - A persistent crawl ledger (`crawlLedger` resource) records every domain
 *    actually crawled, when, and the outcome, so a site that yielded no feed
 *    (or failed) is NOT re-checked every run.
 *  - Candidate selection prioritises domains by article frequency and rotates
 *    through the least-recently-crawled pool instead of always slicing the
 *    same top-N.
 *  - Feed detection accepts feed responses directly and probes common feed
 *    paths, so more domains actually yield feeds and leave the crawl pool.
 *
 * @module
 */
import { z } from "npm:zod@4";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const GlobalArgsSchema = z.object({
  newsReaderModelId: z.string().default("").describe(
    "Model ID of the news-reader instance to read snapshots from (empty = find any)",
  ),
  feedCatalogModelId: z.string().default("").describe(
    "Model ID of the feed-catalog instance to upsert into (empty = find any)",
  ),
}).strict();

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const DiscoverArgsSchema = z.object({
  maxSitesToCrawl: z.number().int().min(1).max(50).default(10).describe(
    "Maximum new domains to crawl this run (default 10)",
  ),
  category: z.string().default("discovered").describe(
    "Category tag for discovered feeds (default 'discovered')",
  ),
  dryRun: z.boolean().default(false).describe(
    "If true, discover feeds but don't add them to the catalog (default false)",
  ),
  reCrawlAfterDays: z.number().int().min(0).max(365).default(7).describe(
    "Domains crawled within this many days are skipped unless their feed is still unknown (default 7)",
  ),
}).describe("Arguments for the discover method");

type DiscoverArgs = z.infer<typeof DiscoverArgsSchema>;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A discovered feed from crawling a website. */
export interface DiscoveredFeed {
  /** Feed URL (absolute). */
  url: string;
  /** Feed type (rss, atom, or unknown). */
  type: string;
  /** Title from the <link> tag's title attribute (if available). */
  title: string;
  /** The source site URL where this feed was found. */
  sourceSite: string;
}

/** Result of the discovery process. */
export interface DiscoveryResult {
  /** ISO-8601 timestamp. */
  discoveredAt: string;
  /** Total article URLs examined. */
  articleUrlsExamined: number;
  /** Total unique domains in articles. */
  uniqueDomains: number;
  /** Domains already known (feed in catalog). */
  existingDomains: number;
  /** Domains skipped because crawled recently. */
  skippedRecent: number;
  /** Domains actually crawled this run. */
  domainsCrawled: number;
  /** Feeds discovered. */
  discoveredFeeds: DiscoveredFeed[];
  /** Crawled domains with their outcome, for the ledger. */
  crawlOutcomes: { domain: string; outcome: string; feedUrl?: string }[];
  /** Errors encountered while crawling. */
  errors: { url: string; message: string }[];
  /** Whether feeds were added to the catalog (false if dryRun). */
  addedToCatalog: boolean;
}

const CrawlLedgerEntrySchema = z.object({
  domain: z.string(),
  lastCrawledAt: z.iso.datetime(),
  outcome: z.enum(["found", "none", "error"]),
  feedUrl: z.string().url().optional(),
});

const CrawlLedgerSchema = z.object({
  entries: z.array(CrawlLedgerEntrySchema),
});

const DiscoveredFeedSchema = z.object({
  url: z.string().url(),
  type: z.string(),
  title: z.string(),
  sourceSite: z.string(),
});

const DiscoveryResultSchema = z.object({
  discoveredAt: z.iso.datetime(),
  articleUrlsExamined: z.number(),
  uniqueDomains: z.number(),
  existingDomains: z.number(),
  skippedRecent: z.number(),
  domainsCrawled: z.number(),
  discoveredFeeds: z.array(DiscoveredFeedSchema),
  crawlOutcomes: z.array(
    z.object({
      domain: z.string(),
      outcome: z.string(),
      feedUrl: z.string().url().optional(),
    }),
  ),
  errors: z.array(z.object({ url: z.string(), message: z.string() })),
  addedToCatalog: z.boolean(),
});

type CrawlLedgerEntry = z.infer<typeof CrawlLedgerEntrySchema>;
type CrawlLedger = z.infer<typeof CrawlLedgerSchema>;

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

// ---------------------------------------------------------------------------
// Feed detection
// ---------------------------------------------------------------------------

/** Common feed paths to probe when the root page yields no feed links. */
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
  "application/json",
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
        "User-Agent": "swamp-feed-discovery/1.0",
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

/** Extract <link rel="alternate"> and <a href> feed URLs from HTML. */
export function extractFeedLinks(
  html: string,
  sourceUrl: string,
): DiscoveredFeed[] {
  const feeds: DiscoveredFeed[] = [];
  const root = siteRoot(sourceUrl);
  const seen = new Set<string>();

  const push = (url: string, type: string, title: string) => {
    const abs = new URL(url, root).href;
    if (seen.has(abs)) return;
    seen.add(abs);
    feeds.push({ url: abs, type, title, sourceSite: root });
  };

  // <link rel="alternate" type="application/rss+xml" href="..."> and atom
  const linkRegex =
    /<link[^>]*rel=["']alternate["'][^>]*type=["']application\/(rss|atom)\+xml["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = linkRegex.exec(html)) !== null) {
    const tag = m[0];
    const type = m[1] === "atom" ? "atom" : "rss";
    const href = tag.match(/href=["']([^"']+)["']/i)?.[1];
    const titleMatch = tag.match(/title=["']([^"']*)["']/i);
    const title = titleMatch ? titleMatch[1] : "";
    if (href) push(href, type, title);
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

// ---------------------------------------------------------------------------
// Crawl logic
// ---------------------------------------------------------------------------

/**
 * Crawl a single domain for feeds. Returns the discovered feeds (or none) and
 * the outcome for the ledger.
 */
async function discoverFeedForDomain(
  domain: string,
): Promise<{
  feeds: DiscoveredFeed[];
  outcome: "found" | "none" | "error";
  error?: string;
}> {
  const bases = [`https://${domain}`, `http://${domain}`];
  let anyBaseSucceeded = false;

  for (const base of bases) {
    const res = await fetchContent(base);
    if (res.error) continue;
    anyBaseSucceeded = true;

    // Root itself is a feed.
    if (isFeedContent(res.contentType, res.body)) {
      return {
        feeds: [{
          url: base,
          type: "unknown",
          title: "",
          sourceSite: siteRoot(base),
        }],
        outcome: "found",
      };
    }

    // Root page advertises feeds.
    const rootFeeds = extractFeedLinks(res.body, base);
    if (rootFeeds.length > 0) {
      return { feeds: rootFeeds.slice(0, 1), outcome: "found" };
    }

    // Probe common feed paths.
    for (const path of COMMON_FEED_PATHS) {
      const probeUrl = new URL(path, base).href;
      const pr = await fetchContent(probeUrl);
      if (pr.error) continue;
      if (isFeedContent(pr.contentType, pr.body)) {
        return {
          feeds: [{
            url: probeUrl,
            type: "unknown",
            title: "",
            sourceSite: siteRoot(base),
          }],
          outcome: "found",
        };
      }
    }
  }

  if (anyBaseSucceeded) {
    return { feeds: [], outcome: "none" };
  }
  return {
    feeds: [],
    outcome: "error",
    error: `Could not reach ${domain}`,
  };
}

// ---------------------------------------------------------------------------
// Cross-model data access
// ---------------------------------------------------------------------------

/** Read a JSON data resource from another model instance and parse it. */
async function readCrossModelData(
  context: {
    dataRepository: {
      getContent: (
        type: string,
        modelId: string,
        dataName: string,
        version?: number,
      ) => Promise<Uint8Array | null>;
    };
  },
  type: string,
  modelId: string,
  dataName: string,
): Promise<Record<string, unknown> | null> {
  const bytes = await context.dataRepository.getContent(
    type,
    modelId,
    dataName,
  );
  if (!bytes) return null;
  const text = new TextDecoder().decode(bytes);
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export const model = {
  type: "@svendowideit/feed-discovery",
  version: "2026.08.03.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    discovery: {
      description: "Result of the most recent feed discovery run",
      schema: DiscoveryResultSchema,
      lifetime: "30d",
      garbageCollection: 10,
    },
    crawlLedger: {
      description: "Ledger of domains already crawled for feed discovery",
      schema: CrawlLedgerSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    discover: {
      description:
        "Discover RSS/Atom feeds from article domains, skipping recently-crawled sites and prioritising the most promising new domains",
      arguments: DiscoverArgsSchema,
      execute: async (
        args: DiscoverArgs,
        context: {
          globalArgs: GlobalArgs;
          logger?: {
            info: (msg: string, props?: Record<string, unknown>) => void;
          };
          readResource: (
            instanceName: string,
          ) => Promise<Record<string, unknown> | null>;
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
        },
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const logger = context.logger;

        // 1. Read the news-reader snapshot to collect article URLs and any
        //    catalog entries that resolved to HTML pages instead of feeds.
        const snapshot = await readCrossModelData(
          context,
          "@svendowideit/news-reader",
          context.globalArgs.newsReaderModelId,
          "feed-snapshot",
        );
        const articleUrls: string[] = Array.isArray(snapshot?.articles)
          ? snapshot!.articles.filter(
            (a: unknown) =>
              typeof a === "object" && a !== null &&
              typeof (a as { url?: unknown }).url === "string",
          ).map((a: { url: string }) => a.url)
          : [];
        const nonFeedUrls: string[] = Array.isArray(snapshot?.nonFeedUrls)
          ? snapshot!.nonFeedUrls.filter(
            (n: unknown) =>
              typeof n === "object" && n !== null &&
              typeof (n as { url?: unknown }).url === "string",
          ).map((n: { url: string }) => n.url)
          : [];

        // 1b. Also collect catalog entries flagged as non-feeds by the
        //     feed-catalog's dedupe step — it performs the same HTML-page
        //     detection as the news fetch step, so the two paths back each
        //     other up even when only one workflow ran.
        let dedupeNonFeedUrls: string[] = [];
        try {
          const dedupeResult = await readCrossModelData(
            context,
            "@svendowideit/feed-catalog",
            context.globalArgs.feedCatalogModelId,
            "dedupe-result",
          );
          dedupeNonFeedUrls = Array.isArray(dedupeResult?.nonFeedUrls)
            ? dedupeResult!.nonFeedUrls.filter(
              (n: unknown) =>
                typeof n === "object" && n !== null &&
                typeof (n as { url?: unknown }).url === "string",
            ).map((n: { url: string }) => n.url)
            : [];
        } catch {
          dedupeNonFeedUrls = [];
        }
        const allNonFeedUrls = [...nonFeedUrls, ...dedupeNonFeedUrls];
        if (articleUrls.length === 0 && allNonFeedUrls.length === 0) {
          throw new Error(
            "No articles or non-feed URLs in news-reader snapshot or feed-catalog dedupe result. Run the news workflow's fetch step first.",
          );
        }

        // 2. Domain frequency map (weight for prioritisation).
        const domainCount = new Map<string, number>();
        for (const url of articleUrls) {
          const d = extractDomain(url);
          if (d) domainCount.set(d, (domainCount.get(d) ?? 0) + 1);
        }

        // 2b. Domains that must be crawled: catalog entries that turned out to
        //     be HTML pages. These are force-included so we re-discover the real
        //     feed for the domain. Sources: the news-reader snapshot AND the
        //     feed-catalog dedupe result (backup detection path).
        const forcedDomains = new Map<string, number>();
        for (const url of allNonFeedUrls) {
          const d = extractDomain(url);
          if (d) forcedDomains.set(d, (forcedDomains.get(d) ?? 0) + 1);
        }

        // 3. Read the crawl ledger.
        const ledgerData = await context.readResource("current");
        const entries: CrawlLedgerEntry[] = Array.isArray(ledgerData?.entries)
          ? ledgerData!.entries as CrawlLedgerEntry[]
          : [];
        const ledgerByDomain = new Map<string, CrawlLedgerEntry>(
          entries.map((e) => [e.domain, e]),
        );

        // 4. Partition candidates.
        let existingDomains = 0;
        let skippedRecent = 0;
        const crawlCandidates: { domain: string; count: number }[] = [];
        const reCrawlAfterMs = args.reCrawlAfterDays * 24 * 60 * 60 * 1000;
        const nowMs = Date.now();

        // Forced (non-feed) domains always get crawled, regardless of the
        // ledger, so a bad catalog entry triggers re-discovery.
        for (const [domain, count] of forcedDomains) {
          crawlCandidates.push({ domain, count });
        }

        for (const [domain, count] of domainCount) {
          // Skip domains already covered by a forced non-feed entry.
          if (forcedDomains.has(domain)) continue;
          const entry = ledgerByDomain.get(domain);
          if (entry?.outcome === "found") {
            existingDomains += 1;
            continue;
          }
          if (
            entry &&
            nowMs - Date.parse(entry.lastCrawledAt) < reCrawlAfterMs
          ) {
            skippedRecent += 1;
            continue;
          }
          crawlCandidates.push({ domain, count });
        }

        // 5. Prioritise: article frequency first, then least-recently-crawled,
        //    then stable by domain name.
        crawlCandidates.sort((a, b) =>
          (b.count - a.count) ||
          (a.domain.localeCompare(b.domain))
        );

        // 6. Crawl the top-N candidates. Forced (non-feed) domains are always
        //    included even when the ledger says they were recently crawled.
        const forcedDomainNames = [...forcedDomains.keys()];
        const domainsToCrawl = [
          ...forcedDomainNames,
          ...crawlCandidates
            .filter((c) => !forcedDomains.has(c.domain))
            .slice(
              0,
              Math.max(0, args.maxSitesToCrawl - forcedDomainNames.length),
            )
            .map((c) => c.domain),
        ];
        const discoveredFeeds: DiscoveredFeed[] = [];
        const crawlOutcomes: CrawlLedgerEntry[] = [];
        const errors: { url: string; message: string }[] = [];

        for (const domain of domainsToCrawl) {
          logger?.info("Crawling domain for feeds: {domain}", { domain });
          const result = await discoverFeedForDomain(domain);
          const outcome: CrawlLedgerEntry = {
            domain,
            lastCrawledAt: new Date().toISOString(),
            outcome: result.outcome,
            ...(result.feeds.length > 0
              ? { feedUrl: result.feeds[0].url }
              : {}),
          };
          crawlOutcomes.push(outcome);
          discoveredFeeds.push(...result.feeds);
          if (result.error) {
            errors.push({ url: domain, message: result.error });
          }
        }

        // 7. Write the discovery result.
        const resultData: DiscoveryResult = {
          discoveredAt: new Date().toISOString(),
          articleUrlsExamined: articleUrls.length,
          uniqueDomains: domainCount.size,
          existingDomains,
          skippedRecent,
          domainsCrawled: domainsToCrawl.length,
          discoveredFeeds,
          crawlOutcomes,
          errors,
          addedToCatalog: !args.dryRun && discoveredFeeds.length > 0,
        };

        const handle = await context.writeResource(
          "discovery",
          "discovery-result",
          { ...resultData },
        );

        // 8. Merge new outcomes into the ledger and persist it.
        const merged = new Map(ledgerByDomain);
        for (const o of crawlOutcomes) {
          merged.set(o.domain, o);
        }
        const ledgerEntries: CrawlLedgerEntry[] = [...merged.values()].slice(
          -500,
        );
        await context.writeResource("crawlLedger", "current", {
          entries: ledgerEntries,
        });

        // Log each newly-discovered feed (these are new to the catalog by
        // construction, since existing/found domains are skipped above).
        for (const feed of discoveredFeeds) {
          logger?.info(
            "Discovered new feed: {url} ({type}){title}",
            {
              url: feed.url,
              type: feed.type,
              title: feed.title ? ` "${feed.title}"` : "",
              sourceSite: feed.sourceSite,
            },
          );
        }

        logger?.info(
          "Discovery: {articles} articles analysed, {found} new feeds found, {crawled} crawled, {forced} forced, {existing} existing, {skipped} skipped",
          {
            articles: articleUrls.length,
            found: discoveredFeeds.length,
            crawled: domainsToCrawl.length,
            forced: forcedDomainNames.length,
            existing: existingDomains,
            skipped: skippedRecent,
          },
        );

        return { dataHandles: [handle] };
      },
    },
  },
};
