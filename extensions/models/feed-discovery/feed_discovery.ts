/**
 * Feed discovery — reads article URLs from the news-reader's snapshot, finds
 * domains not yet in the feed-catalog, fetches their HTML to extract RSS/Atom
 * feed links, and upserts discovered feeds into the feed-catalog.
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
    "Maximum new domains to crawl for feed discovery (default 10)",
  ),
  category: z.string().default("discovered").describe(
    "Category tag for discovered feeds (default 'discovered')",
  ),
  dryRun: z.boolean().default(false).describe(
    "If true, discover feeds but don't add them to the catalog (default false)",
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
  /** Unique domains found in articles. */
  uniqueDomains: number;
  /** Domains already in the catalog (skipped). */
  existingDomains: number;
  /** New domains crawled. */
  domainsCrawled: number;
  /** Feeds discovered. */
  discoveredFeeds: DiscoveredFeed[];
  /** Errors encountered during crawling. */
  errors: { url: string; message: string }[];
  /** Whether feeds were added to the catalog (false if dryRun). */
  addedToCatalog: boolean;
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const DiscoveredFeedSchema = z.object({
  url: z.string().url(),
  type: z.string(),
  title: z.string(),
  sourceSite: z.string(),
});

const DiscoveryResultSchema = z.object({
  discoveredAt: z.iso.datetime(),
  articleUrlsExamined: z.number().int(),
  uniqueDomains: z.number().int(),
  existingDomains: z.number().int(),
  domainsCrawled: z.number().int(),
  discoveredFeeds: z.array(DiscoveredFeedSchema),
  errors: z.array(z.object({ url: z.string(), message: z.string() })),
  addedToCatalog: z.boolean(),
});

// ---------------------------------------------------------------------------
// Context type
// ---------------------------------------------------------------------------

type MethodContext = {
  globalArgs: GlobalArgs;
  logger?: { info: (msg: string, props?: Record<string, unknown>) => void };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
  readResource: (
    instanceName: string,
    version?: number,
  ) => Promise<Record<string, unknown> | null>;
  dataRepository: {
    getContent: (
      type: string,
      modelId: string,
      dataName: string,
      version?: number,
    ) => Promise<Uint8Array | null>;
    findAllForModel: (
      type: string,
      modelId: string,
    ) => Promise<
      { name: string; version: number; type: string; modelId: string }[]
    >;
  };
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract the registered domain (hostname without leading www.). */
export function extractDomain(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Get the site root URL (scheme + host). */
export function siteRoot(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "";
  }
}

/** Read cross-model data using dataRepository.getContent with a known modelId. */
async function readCrossModelData(
  dataRepository: MethodContext["dataRepository"],
  modelType: string,
  modelId: string,
  dataName: string,
): Promise<Record<string, unknown> | null> {
  try {
    const content = await dataRepository.getContent(
      modelType,
      modelId,
      dataName,
    );
    if (!content) return null;
    return JSON.parse(new TextDecoder().decode(content));
  } catch {
    return null;
  }
}

/** Extract RSS/Atom feed <link> tags from HTML. */
export function extractFeedLinks(
  html: string,
  sourceUrl: string,
): DiscoveredFeed[] {
  const feeds: DiscoveredFeed[] = [];
  const root = siteRoot(sourceUrl);

  // Match <link rel="alternate" type="application/rss+xml" href="..." title="...">
  // and <link rel="alternate" type="application/atom+xml" href="..." title="...">
  const linkRegex = /<link[^>]*rel=["']alternate["'][^>]*>/gi;
  const links = html.match(linkRegex) ?? [];

  for (const link of links) {
    const typeMatch = link.match(/type=["']([^"']+)["']/i);
    const hrefMatch = link.match(/href=["']([^"']+)["']/i);
    const titleMatch = link.match(/title=["']([^"']*)["']/i);

    const type = typeMatch?.[1] ?? "";
    const href = hrefMatch?.[1] ?? "";
    const title = titleMatch?.[1] ?? "";

    // Only accept RSS/Atom feed types
    if (
      !type.includes("rss") && !type.includes("atom") &&
      !href.includes("/rss") && !href.includes("/feed") &&
      !href.includes(".rss") && !href.includes(".xml") &&
      !href.includes("/atom")
    ) {
      continue;
    }

    if (!href) continue;

    // Resolve relative URLs against the source
    let feedUrl: string;
    try {
      feedUrl = href.startsWith("http") ? href : new URL(href, sourceUrl).href;
    } catch {
      continue;
    }

    const feedType: string = type.includes("atom") ? "atom" : "rss";

    feeds.push({
      url: feedUrl,
      type: feedType,
      title,
      sourceSite: root,
    });
  }

  // Also look for <a> tags linking to common feed paths (fallback)
  const anchorRegex = /<a[^>]*href=["']([^"']+)["'][^>]*>([^<]*)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = anchorRegex.exec(html)) !== null) {
    const href = m[1];
    const text = m[2]?.toLowerCase() ?? "";
    if (
      (href.includes("/rss") || href.includes("/feed") ||
        href.includes(".rss") ||
        href.includes("/atom") || href.includes("rss.xml")) &&
      (text.includes("rss") || text.includes("feed") || text.includes("atom") ||
        text.includes("subscribe"))
    ) {
      let feedUrl: string;
      try {
        feedUrl = href.startsWith("http")
          ? href
          : new URL(href, sourceUrl).href;
      } catch {
        continue;
      }
      // Don't add duplicates
      if (feeds.some((f) => f.url === feedUrl)) continue;
      feeds.push({
        url: feedUrl,
        type: "unknown",
        title: m[2]?.trim() ?? "",
        sourceSite: root,
      });
    }
  }

  return feeds;
}

/** Fetch HTML from a URL with timeout. */
async function fetchHtml(
  url: string,
): Promise<{ html: string; error?: string }> {
  try {
    const resp = await fetch(url, {
      headers: {
        "User-Agent": "swamp-feed-discovery/1.0",
        "Accept": "text/html",
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) {
      return { html: "", error: `HTTP ${resp.status}` };
    }
    const contentType = resp.headers.get("content-type") ?? "";
    if (
      !contentType.includes("text/html") &&
      !contentType.includes("application/xhtml")
    ) {
      return { html: "", error: `Not HTML: ${contentType}` };
    }
    const html = await resp.text();
    return { html };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { html: "", error: msg };
  }
}

// ---------------------------------------------------------------------------
// Model definition
// ---------------------------------------------------------------------------

/** Model definition for discovering RSS feeds from article URLs. */
export const model = {
  type: "@svendowideit/feed-discovery",
  version: "2026.07.17.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    discovery: {
      description: "Result of the last feed discovery run",
      schema: DiscoveryResultSchema,
      lifetime: "30d",
      garbageCollection: 10,
    },
  },
  methods: {
    discover: {
      description:
        "Discover new RSS feeds from article URLs in the news-reader snapshot and add them to the feed-catalog",
      arguments: DiscoverArgsSchema,
      execute: async (
        args: DiscoverArgs,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const logger = context.logger;
        const newsReaderId = context.globalArgs.newsReaderModelId;
        const feedCatalogId = context.globalArgs.feedCatalogModelId;

        // 1. Read the news-reader's latest snapshot to get article URLs
        if (!newsReaderId) {
          throw new Error(
            "newsReaderModelId global arg is required — set it to the news-reader model instance ID. " +
              "Run: swamp model create @svendowideit/feed-discovery feed-discovery " +
              "--global-arg newsReaderModelId=<news-reader-model-id> --global-arg feedCatalogModelId=<feed-catalog-model-id>",
          );
        }
        const snapshotData = await readCrossModelData(
          context.dataRepository,
          "@svendowideit/news-reader",
          newsReaderId,
          "feed-snapshot",
        ) as { articles?: { url: string; source: string }[] } | null;
        if (
          !snapshotData || !snapshotData.articles ||
          snapshotData.articles.length === 0
        ) {
          throw new Error(
            "No articles found in news-reader snapshot. Run the news workflow's fetch step first.",
          );
        }

        const articleUrls = snapshotData.articles.map((a) => a.url);
        logger?.info("Found {count} article URLs in news-reader snapshot", {
          count: articleUrls.length,
        });

        // 2. Extract unique domains from article URLs
        const articleDomains = new Set<string>();
        for (const url of articleUrls) {
          const domain = extractDomain(url);
          if (domain) articleDomains.add(domain);
        }
        logger?.info("Found {count} unique domains in articles", {
          count: articleDomains.size,
        });

        // 3. Read the feed-catalog to find which domains are already known
        const catalogData = (feedCatalogId
          ? await readCrossModelData(
            context.dataRepository,
            "@svendowideit/feed-catalog",
            feedCatalogId,
            "current",
          )
          : null) as { feeds?: { url: string }[] } | null;
        const knownDomains = new Set<string>();
        if (catalogData?.feeds) {
          for (const feed of catalogData.feeds) {
            const d = extractDomain(feed.url);
            if (d) knownDomains.add(d);
          }
        }
        logger?.info("{count} domains already in feed-catalog", {
          count: knownDomains.size,
        });

        // 4. Find new domains to crawl
        const newDomains = [...articleDomains].filter((d) =>
          !knownDomains.has(d)
        );
        const domainsToCrawl = newDomains.slice(0, args.maxSitesToCrawl);
        logger?.info(
          "Crawling {count} new domains (of {total} new, {existing} already known)",
          {
            count: domainsToCrawl.length,
            total: newDomains.length,
            existing: knownDomains.size,
          },
        );

        // 5. Crawl each new domain's root page to find feed links
        const allDiscovered: DiscoveredFeed[] = [];
        const errors: { url: string; message: string }[] = [];

        for (const domain of domainsToCrawl) {
          const siteUrl = `https://${domain}`;
          logger?.info("Crawling {site}", { site: siteUrl });

          const result = await fetchHtml(siteUrl);
          if (result.error) {
            errors.push({ url: siteUrl, message: result.error });
            // Try http as fallback
            const httpResult = await fetchHtml(`http://${domain}`);
            if (httpResult.error) {
              errors.push({
                url: `http://${domain}`,
                message: httpResult.error,
              });
              continue;
            }
            const feeds = extractFeedLinks(httpResult.html, `http://${domain}`);
            allDiscovered.push(...feeds);
            logger?.info("Found {n} feeds on {site}", {
              n: feeds.length,
              site: `http://${domain}`,
            });
          } else {
            const feeds = extractFeedLinks(result.html, siteUrl);
            allDiscovered.push(...feeds);
            logger?.info("Found {n} feeds on {site}", {
              n: feeds.length,
              site: siteUrl,
            });
          }
        }

        // 6. Deduplicate discovered feeds (by URL)
        const seen = new Set<string>();
        const uniqueDiscovered = allDiscovered.filter((f) => {
          if (seen.has(f.url)) return false;
          seen.add(f.url);
          return true;
        });

        logger?.info(
          "Discovered {total} feeds ({unique} unique) from {domains} domains",
          {
            total: allDiscovered.length,
            unique: uniqueDiscovered.length,
            domains: domainsToCrawl.length,
          },
        );

        // 7. Write discovery result (the workflow will upsert into feed-catalog via forEach)
        if (args.dryRun) {
          logger?.info("Dry run — {n} feeds would be added to catalog", {
            n: uniqueDiscovered.length,
          });
        } else {
          logger?.info("{n} feeds ready for upsert into feed-catalog", {
            n: uniqueDiscovered.length,
          });
        }

        // 8. Write discovery result
        const result: DiscoveryResult = {
          discoveredAt: new Date().toISOString(),
          articleUrlsExamined: articleUrls.length,
          uniqueDomains: articleDomains.size,
          existingDomains: knownDomains.size,
          domainsCrawled: domainsToCrawl.length,
          discoveredFeeds: uniqueDiscovered,
          errors,
          addedToCatalog: !args.dryRun && uniqueDiscovered.length > 0,
        };

        const handle = await context.writeResource(
          "discovery",
          "discovery-result",
          {
            discoveredAt: result.discoveredAt,
            articleUrlsExamined: result.articleUrlsExamined,
            uniqueDomains: result.uniqueDomains,
            existingDomains: result.existingDomains,
            domainsCrawled: result.domainsCrawled,
            discoveredFeeds: result.discoveredFeeds,
            errors: result.errors,
            addedToCatalog: result.addedToCatalog,
          },
        );

        return { dataHandles: [handle] };
      },
    },
  },
};
