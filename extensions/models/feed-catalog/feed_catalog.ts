/**
 * Feed catalog — manages a curated list of RSS/Atom feeds for the news reader.
 *
 * Store your favorite feeds in a swamp data resource, organized by category
 * (tech, news, programming, podcasting). The news workflow reads this catalog
 * to know which feeds to fetch.
 *
 * @module
 */
import { z } from "npm:zod@4";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const GlobalArgsSchema = z.object({
  /** Optional catalog name for multiple catalogs (default: "default"). */
  catalogName: z.string().default("default").describe(
    "Catalog name (for multiple catalogs)",
  ),
}).strict();

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const AddFeedArgsSchema = z.object({
  url: z.string().url().describe("RSS/Atom feed URL to add"),
  category: z.string().default("uncategorized").describe(
    "Category tag (e.g., tech, news, programming, podcasting)",
  ),
  name: z.string().optional().describe(
    "Human-readable feed name (defaults to hostname)",
  ),
}).describe("Arguments for adding a feed");

type AddFeedArgs = z.infer<typeof AddFeedArgsSchema>;

const RemoveFeedArgsSchema = z.object({
  url: z.string().url().describe("RSS/Atom feed URL to remove"),
}).describe("Arguments for removing a feed");

type RemoveFeedArgs = z.infer<typeof RemoveFeedArgsSchema>;

const ListFeedsArgsSchema = z.object({
  category: z.string().optional().describe("Filter by category (optional)"),
  limit: z.number().int().min(0).max(500).default(0).describe(
    "Maximum feeds to return. Use 0 for unlimited.",
  ),
}).describe("Arguments for listing feeds");

type ListFeedsArgs = z.infer<typeof ListFeedsArgsSchema>;

const ListCategoriesArgsSchema = z.object({}).describe(
  "Arguments for listing feed categories",
);

const DedupeArgsSchema = z.object({}).describe(
  "Arguments for deduplicating the feed catalog",
);

type DedupeArgs = z.infer<typeof DedupeArgsSchema>;

const DedupeResultSchema = z.object({
  name: z.string(),
  groups: z.number(),
  groupsWithDuplicates: z.number(),
  markedDuplicates: z.number(),
  markedInvalid: z.number(),
  errors: z.array(
    z.object({ url: z.string(), message: z.string() }),
  ).optional(),
  nonFeedUrls: z.array(
    z.object({ url: z.string(), contentType: z.string() }),
  ).optional(),
  ranAt: z.iso.datetime(),
});

type ListCategoriesArgs = z.infer<typeof ListCategoriesArgsSchema>;

const GenerateFeedsHtmlArgsSchema = z.object({
  outputPath: z.string().default("feeds.html").describe(
    "Local file path to write the generated HTML page (default: feeds.html)",
  ),
  title: z.string().default("Feed Catalog").describe("Page title"),
}).describe("Arguments for generating the feeds HTML page");

type GenerateFeedsHtmlArgs = z.infer<typeof GenerateFeedsHtmlArgsSchema>;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single feed in the catalog. */
export interface Feed {
  /** Feed URL (canonical, no trailing slash). */
  url: string;
  /** Human-readable name (derived from hostname if not provided). */
  name: string;
  /** Category tag for grouping/filtering feeds. */
  category: string;
  /** ISO-8601 timestamp when feed was added. */
  addedAt: string;
  /** Whether this feed is a duplicate of another catalog feed. */
  duplicate?: boolean;
  /** URL of the canonical feed that this feed duplicates. */
  duplicateOf?: string;
  /** Whether this feed resolved to an HTML page/unknown content instead of a feed. */
  invalid?: boolean;
  /** Human-readable reason the feed was marked invalid (e.g. not a feed). */
  invalidReason?: string;
}

/** The complete feed catalog. */
export interface FeedCatalog {
  /** Catalog name (for multiple catalogs). */
  name: string;
  /** All feeds in this catalog. */
  feeds: Feed[];
  /** Total count of feeds. */
  totalCount: number;
}

/** Output of the listCategories method. */
export interface CategoriesList {
  /** Catalog name. */
  name: string;
  /** All unique categories in the catalog. */
  categories: string[];
  /** Total count of categories. */
  totalCount: number;
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/** Extract a human-readable name from a feed URL. */
export function extractFeedName(url: string): string {
  try {
    const u = new URL(url);
    let host = u.hostname.replace(/^www\./, "");
    if (host.endsWith("/")) host = host.slice(0, -1);
    return host;
  } catch {
    return url.replace(/https?:\/\//, "").replace(/\/$/, "");
  }
}

/** Normalize a feed item id for duplicate comparison. */
function normalizeId(id: string): string {
  const trimmed = id.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const u = new URL(trimmed);
      u.hash = "";
      return u.href.replace(/\/$/, "").toLowerCase();
    } catch {
      // fall through to plain lowercasing
    }
  }
  return trimmed.toLowerCase();
}

/** Extract the channel/feed-level block (first <channel> or <feed>). */
function extractChannel(xml: string): string {
  const channel = xml.match(/<channel[\s>][\s\S]*?<\/channel>/i);
  if (channel) return channel[0];
  const feed = xml.match(/<feed[\s>][\s\S]*?<\/feed>/i);
  return feed?.[0] ?? "";
}

/** True if a string contains a given tag form. */
function hasTag(text: string, re: RegExp): boolean {
  return re.test(text);
}

/**
 * True if a fetched body is a feed (RSS/Atom/JSON feed) rather than a plain
 * HTML page. Mirrors news-reader's `isFeedBody` so the dedupe step can flag
 * catalog entries that resolved to HTML pages — the same detection the
 * news workflow's fetch step performs — so the two paths back each other up.
 */
function isFeedBody(contentType: string, body: string): boolean {
  const ct = contentType.toLowerCase();
  // 1. Content-type header: definite feed types win immediately.
  if (
    ct.includes("rss+xml") ||
    ct.includes("atom+xml") ||
    ct.includes("feed+json") ||
    ct.includes("text/xml") ||
    ct.includes("application/xml") ||
    ct.includes("application/json")
  ) {
    return true;
  }
  // 2. Content-type header: definite HTML pages are not feeds.
  if (ct.includes("html") || ct.includes("xhtml")) return false;

  // 3. Body content detection — many servers send no/odd content-type, so
  //    inspect the body markers directly.
  const trimmed = body.trimStart().slice(0, 300).toLowerCase();
  // Feed bodies: XML/RSS/Atom/JSON-feed markers.
  if (trimmed.startsWith("<?xml") || trimmed.startsWith("{")) {
    return trimmed.includes("<rss") ||
      trimmed.includes("<feed") ||
      trimmed.includes("<rdf:rdf") ||
      (trimmed.includes('"version"') && trimmed.includes('"items"'));
  }
  // HTML bodies: well-known structural tags mark a page, not a feed.
  if (
    trimmed.startsWith("<!doctype") ||
    trimmed.includes("<html") ||
    trimmed.includes("<head") ||
    trimmed.includes("<body") ||
    trimmed.includes("<title")
  ) {
    return false;
  }
  // Unknown → treat as not-a-feed so it gets flagged for re-discovery.
  return false;
}

/**
 * Compute a feed's canonical identity (sorted normalized item ids, or the
 * rel=self link when no items exist) and an expressiveness score used to pick
 * which duplicate is canonical.
 */
function feedIdentity(xml: string): { identity: string | null; score: number } {
  const channel = extractChannel(xml);
  const isAtom = channel.includes("<entry") || channel.includes("<feed");
  const itemRegex = isAtom
    ? /<entry[\s>][\s\S]*?<\/entry>/gi
    : /<item[\s>][\s\S]*?<\/item>/gi;
  const items = xml.match(itemRegex) ?? [];
  const ids: string[] = [];
  for (const item of items) {
    let id: string | null = null;
    if (isAtom) {
      const m = item.match(/<id[^>]*>([\s\S]*?)<\/id>/i);
      id = m?.[1] ?? null;
      if (!id) {
        const lm = item.match(/<link[^>]*href=["']([^"']+)["'][^>]*>/i);
        id = lm?.[1] ?? null;
      }
    } else {
      const gm = item.match(/<guid[^>]*>([\s\S]*?)<\/guid>/i);
      id = gm?.[1] ?? null;
      if (!id) {
        const lm = item.match(/<link[^>]*>([\s\S]*?)<\/link>/i);
        id = lm?.[1] ?? null;
      }
    }
    if (id) ids.push(normalizeId(id));
  }
  const uniq = Array.from(new Set(ids)).sort();
  let identity: string | null = null;
  if (uniq.length > 0) {
    identity = "items:" + uniq.join("\n");
  } else {
    const self = xml.match(
      /<link[^>]*\brel=["']self["'][^>]*href=["']([^"']+)["'][^>]*>/i,
    )?.[1] ?? null;
    if (self) identity = "self:" + normalizeId(self);
  }
  if (!identity) return { identity: null, score: 0 };

  let score = 0;
  if (hasTag(channel, /<title[\s>][\s\S]*?<\/title>/i)) score += 1;
  if (isAtom) score += 1;
  if (
    hasTag(channel, /<description[\s>][\s\S]*?<\/description>/i) ||
    hasTag(channel, /<subtitle[\s>][\s\S]*?<\/subtitle>/i)
  ) score += 1;
  if (hasTag(channel, /<(author|managingEditor|webMaster)[\s>][\s\S]*?<\/\1>/i)) {
    score += 1;
  }
  if (hasTag(channel, /<(lastBuildDate|pubDate|updated)[\s>][\s\S]*?<\/\1>/i)) {
    score += 1;
  }
  if (hasTag(channel, /<link[\s>]/i)) score += 1;
  if (uniq.length > 0) score += 1;
  return { identity, score };
}

/** Escape HTML special characters for safe interpolation. */
function escapeHtml(s: string): string {
  const map: Record<string, string> = {
    "&": "\u0026amp;",
    "<": "\u003c;",
    ">": "\u003e;",
    '"': "\u0026quot;",
    "'": "\u0026#39;",
  };
  return s.replace(/[&<>"']/g, (c) => map[c]);
}

/**
 * Build a static HTML page listing all feeds, grouping each feed together with
 * the duplicates that point back to it (canonical first, duplicates indented
 * underneath).
 */
export function generateFeedsHtml(
  feeds: Feed[],
  title: string,
  generatedAt: string,
): string {
  const canonical = feeds.filter((f) => !f.duplicate && f.invalid !== true);
  const invalidFeeds = feeds.filter((f) => f.invalid === true);
  const dupMap = new Map<string, Feed[]>();
  for (const f of feeds) {
    if (f.duplicate && f.duplicateOf) {
      const list = dupMap.get(f.duplicateOf) ?? [];
      list.push(f);
      dupMap.set(f.duplicateOf, list);
    }
  }
  // Feeds marked as duplicates whose canonical isn't present (e.g., removed).
  const orphanDups = feeds.filter(
    (f) => f.duplicate && f.duplicateOf &&
      !canonical.some((c) => c.url === f.duplicateOf),
  );

  const categories = Array.from(new Set(canonical.map((f) => f.category)))
    .sort();

  const card = (f: Feed, badge: string): string => {
    const name = escapeHtml(f.name);
    const url = escapeHtml(f.url);
    const added = escapeHtml(f.addedAt);
    const reason = f.invalid && f.invalidReason
      ? `\n<div class="reason">${escapeHtml(f.invalidReason)}</div>`
      : "";
    const cls = f.invalid ? " feed invalid" : "";
    return [
      `<div class="feed${cls}">`,
      `<h3>${name}<span class="badge">${badge}</span></h3>`,
      `<div class="url"><a href="${url}">${url}</a></div>`,
      `<div class="added">added ${added}</div>${reason}`,
      `</div>`,
    ].join("\n");
  };

  const sections: string[] = [];
  sections.push(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 960px; margin: 0 auto; padding: 24px; background: #fafafa; color: #222; }
h1 { border-bottom: 2px solid #333; padding-bottom: 8px; }
.meta { color: #666; font-size: 0.9em; margin: 12px 0 24px; }
h2 { margin-top: 30px; color: #333; }
.feed { border: 1px solid #e0e0e0; border-radius: 8px; padding: 12px 16px; margin: 8px 0; background: white; }
.feed h3 { margin: 0 0 6px 0; font-size: 1.05em; }
.feed .url { color: #555; font-size: 0.85em; word-break: break-all; }
.feed .added { color: #888; font-size: 0.8em; margin-top: 6px; }
.badge { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 0.75em; background: #eee; color: #444; margin-left: 8px; font-weight: normal; }
.badge.dup { background: #ffc107; color: #222; }
.badge.invalid { background: #e53935; color: white; }
.feed.dup { border-left: 3px solid #ffc107; margin-left: 26px; }
.feed.invalid { border-left: 3px solid #e53935; opacity: 0.55; }
.feed.invalid .reason { color: #e53935; font-size: 0.8em; margin-top: 6px; }
.toggle { margin: 0 0 12px; }
.toggle button { padding: 4px 10px; border: 1px solid #ccc; border-radius: 6px; background: white; cursor: pointer; font-size: 0.85em; }
#invalid-feeds { display: none; }
#invalid-feeds.show { display: block; }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<div class="meta">${feeds.length} feeds · ${canonical.length} canonical · ${dupMap.size} duplicate groups · ${invalidFeeds.length} invalid · generated ${escapeHtml(generatedAt)}</div>
${invalidFeeds.length > 0
    ? `<div class="toggle"><button id="toggle-invalid" type="button">Show invalid feeds (${invalidFeeds.length})</button></div>`
    : ""}`);

  for (const category of categories) {
    sections.push(`<h2>${escapeHtml(category)}</h2>`);
    for (const f of canonical.filter((c) => c.category === category)) {
      sections.push(card(f, "canonical"));
      const dups = (dupMap.get(f.url) ?? []).filter((d) =>
        d.category === category,
      );
      for (const d of dups) {
        sections.push(
          card(d, `duplicate of ${escapeHtml(f.name)}`).replace(
            `<div class="feed">`,
            `<div class="feed dup">`,
          ),
        );
      }
    }
  }

  if (orphanDups.length > 0) {
    sections.push(`<h2>Orphan duplicates</h2>`);
    for (const d of orphanDups) {
      sections.push(
        card(d, "duplicate (canonical missing)").replace(
          `<div class="feed">`,
          `<div class="feed dup">`,
        ),
      );
    }
  }

  if (invalidFeeds.length > 0) {
    sections.push(`<div id="invalid-feeds">
<h2>Invalid feeds</h2>`);
    for (const f of invalidFeeds) {
      sections.push(card(f, "invalid"));
    }
    sections.push(`</div>`);
  }

  sections.push(feedCatalogPageScript());
  sections.push(`</body>
</html>`);
  return sections.join("\n");
}

function feedCatalogPageScript(): string {
  return `<script>
(function () {
  var btn = document.getElementById("toggle-invalid");
  var section = document.getElementById("invalid-feeds");
  if (!btn || !section) return;
  btn.addEventListener("click", function () {
    var show = section.classList.toggle("show");
    btn.textContent = show
      ? "Hide invalid feeds"
      : "Show invalid feeds (" + section.querySelectorAll(".feed").length + ")";
  });
})();
</script>`;
}

// ---------------------------------------------------------------------------
// Shared context type for all methods
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
  createFileWriter: (
    specName: string,
    instanceName: string,
    overrides?: Record<string, unknown>,
  ) => Promise<{ writeText: (text: string) => Promise<{ name: string }> }>;
};

// ---------------------------------------------------------------------------
// Zod schemas for resources
// ---------------------------------------------------------------------------

const FeedSchema = z.object({
  url: z.string().url(),
  name: z.string(),
  category: z.string(),
  addedAt: z.iso.datetime(),
  duplicate: z.boolean().optional(),
  duplicateOf: z.string().optional(),
  invalid: z.boolean().optional(),
  invalidReason: z.string().optional(),
});

const FeedCatalogSchema = z.object({
  name: z.string(),
  feeds: z.array(FeedSchema),
  totalCount: z.number(),
});

const CategoriesListSchema = z.object({
  name: z.string(),
  categories: z.array(z.string()),
  totalCount: z.number(),
});

// ---------------------------------------------------------------------------
// Model definition
// ---------------------------------------------------------------------------

export const model = {
  type: "@svendowideit/feed-catalog",
  version: "2026.08.06.1784424438",
  globalArguments: GlobalArgsSchema,
  resources: {
    catalog: {
      description: "Feed catalog (list of RSS/Atom feeds with categories)",
      schema: FeedCatalogSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    categories: {
      description: "List of unique categories in the catalog",
      schema: CategoriesListSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    dedupe: {
      description: "Result of the dedupe method",
      schema: DedupeResultSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
  },
  files: {
    report: {
      description: "Generated static HTML pages (e.g. the feeds listing)",
      contentType: "text/html",
      lifetime: "infinite",
      garbageCollection: 5,
    },
  },
  methods: {
    add: {
      description: "Add a feed URL to the catalog",
      arguments: AddFeedArgsSchema,
      execute: async (
        args: AddFeedArgs,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const logger = context.logger;
        const catalogName = context.globalArgs.catalogName;

        let catalogData = await context.readResource("current") as
          | FeedCatalog
          | null;
        if (!catalogData || catalogData.name !== catalogName) {
          catalogData = { name: catalogName, feeds: [], totalCount: 0 };
        }

        const feedName = args.name ?? extractFeedName(args.url);
        const newFeed: Feed = {
          url: new URL(args.url).href.replace(/\/$/, ""),
          name: feedName,
          category: args.category,
          addedAt: new Date().toISOString(),
        };

        if (catalogData.feeds.some((f) => f.url === newFeed.url)) {
          logger?.info("Feed already in catalog: {name} ({url})", {
            name: newFeed.name,
            url: newFeed.url,
          });
          // No-op — feed already exists, not an error
          const handle = await context.writeResource("catalog", "current", {
            name: catalogData.name,
            feeds: catalogData.feeds,
            totalCount: catalogData.totalCount,
          });
          return { dataHandles: [handle] };
        }

        catalogData.feeds.push(newFeed);
        catalogData.totalCount = catalogData.feeds.length;

        logger?.info("Added feed {name} ({url}) to category '{category}'", {
          name: newFeed.name,
          url: newFeed.url,
          category: newFeed.category,
        });

        const handle = await context.writeResource("catalog", "current", {
          name: catalogData.name,
          feeds: catalogData.feeds,
          totalCount: catalogData.totalCount,
        });

        return { dataHandles: [handle] };
      },
    },
    dedupe: {
      description:
        "Fetch each catalog feed, group duplicates by content identity, and mark the less expressive (or second) feed as a duplicate.",
      arguments: DedupeArgsSchema,
      execute: async (
        _args: DedupeArgs,
        context: MethodContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const logger = context.logger;
        const catalogName = context.globalArgs.catalogName;
        const catalogData = await context.readResource("current") as
          | FeedCatalog
          | null;
        if (!catalogData) {
          throw new Error("No feed catalog found. Add feeds first with 'add'.");
        }

        // Fetch each feed once, compute its identity + expressiveness score.
        const groups = new Map<string, Array<Feed & { score: number }>>();
        const errors: { url: string; message: string }[] = [];
        const nonFeedUrls: { url: string; contentType: string }[] = [];
        const nonFeedSet = new Set<string>();
        const total = catalogData.feeds.length;
        let processed = 0;
        let lastProgressLog = 0;
        for (const feed of catalogData.feeds) {
          // Skip entries already marked invalid by a previous run — they are
          // not feeds and should not be re-fetched.
          if (feed.invalid === true) {
            processed++;
            continue;
          }
          let xml: string;
          let contentType = "";
          try {
            const resp = await fetch(feed.url, {
              headers: { "User-Agent": "swamp-feed-catalog/1.0" },
              signal: AbortSignal.timeout(15000),
            });
            contentType = resp.headers.get("content-type") ?? "";
            if (!resp.ok) {
              errors.push({ url: feed.url, message: `HTTP ${resp.status}` });
              processed++;
              continue;
            }
            xml = await resp.text();
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            errors.push({ url: feed.url, message: msg });
            processed++;
            continue;
          }
          // Flag catalog entries that resolved to HTML pages instead of feeds —
          // same detection as the news workflow's fetch step, so feed-discovery
          // can re-crawl the domain even when only this workflow ran.
          if (!isFeedBody(contentType, xml)) {
            nonFeedUrls.push({ url: feed.url, contentType });
            nonFeedSet.add(feed.url);
            processed++;
            logger?.info(
              "Feed {url} is not a feed (HTML page or unknown content type); flagged for re-discovery",
              { url: feed.url, contentType },
            );
            continue;
          }
          const { identity, score } = feedIdentity(xml);
          if (!identity) {
            processed++;
            continue; // no items/self-link → leave as-is
          }
          const group = groups.get(identity) ?? [];
          group.push({ ...feed, score });
          groups.set(identity, group);
          processed++;

          // Periodic progress so long dedupe runs report "x of y" as they go.
          const now = Date.now();
          if (
            processed % 10 === 0 ||
            now - lastProgressLog >= 10_000
          ) {
            lastProgressLog = now;
            logger?.info(
              "Dedupe progress: {done} of {total} feeds",
              { done: processed, total },
            );
          }
        }

        // Within each group pick the most expressive feed as canonical; ties →
        // the earliest-added feed wins, so the "second" duplicate is marked.
        const duplicateOf = new Map<string, string>();
        let groupsWithDuplicates = 0;
        for (const [identity, group] of groups) {
          if (group.length <= 1) continue;
          groupsWithDuplicates++;
          group.sort(
            (a, b) => (b.score - a.score) || a.addedAt.localeCompare(b.addedAt),
          );
          const canonical = group[0];
          for (let i = 1; i < group.length; i++) {
            const dup = group[i];
            duplicateOf.set(dup.url, canonical.url);
            logger?.info(
              "Feed {url} ({name}) marked duplicate of {canonical} ({canonicalName})",
              {
                url: dup.url,
                name: dup.name,
                canonical: canonical.url,
                canonicalName: canonical.name,
              },
            );
          }
        }

        let markedDuplicates = 0;
        let markedInvalid = 0;
        const updatedFeeds = catalogData.feeds.map((feed) => {
          const canonical = duplicateOf.get(feed.url);
          if (canonical) {
            markedDuplicates++;
            return { ...feed, duplicate: true, duplicateOf: canonical };
          }
          if (nonFeedSet.has(feed.url)) {
            markedInvalid++;
            return {
              ...feed,
              invalid: true,
              invalidReason: "not a feed (HTML page or unknown content type)",
            };
          }
          return feed;
        });
        catalogData.feeds = updatedFeeds;
        catalogData.totalCount = updatedFeeds.length;

        const handle = await context.writeResource("catalog", "current", {
          name: catalogData.name,
          feeds: catalogData.feeds,
          totalCount: catalogData.totalCount,
        });
        const resultHandle = await context.writeResource(
          "dedupe",
          "dedupe-result",
          {
            name: catalogData.name,
            groups: groups.size,
            groupsWithDuplicates,
            markedDuplicates,
            markedInvalid,
            errors,
            nonFeedUrls,
            ranAt: new Date().toISOString(),
          },
        );
        logger?.info(
          "Dedupe: {groups} groups, {dupGroups} with duplicates, {marked} marked, {errors} errors, {nonFeeds} non-feed",
          {
            groups: groups.size,
            dupGroups: groupsWithDuplicates,
            marked: markedDuplicates,
            invalid: markedInvalid,
            errors: errors.length,
            nonFeeds: nonFeedUrls.length,
          },
        );
        return { dataHandles: [handle, resultHandle] };
      },
    },
    generateFeedsHtml: {
      description:
        "Generate a static HTML page listing all feeds in the catalog, grouping each feed with its duplicates.",
      arguments: GenerateFeedsHtmlArgsSchema,
      execute: async (
        args: GenerateFeedsHtmlArgs,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const logger = context.logger;
        const catalogData = await context.readResource("current") as
          | FeedCatalog
          | null;
        if (!catalogData) {
          throw new Error(
            "No feed catalog found. Add feeds first with the 'add' method.",
          );
        }
        const generatedAt = new Date().toISOString();
        const html = generateFeedsHtml(
          catalogData.feeds,
          args.title,
          generatedAt,
        );

        const writer = await context.createFileWriter("report", "feeds-page");
        const handle = await writer.writeText(html);
        await Deno.writeTextFile(args.outputPath, html);

        logger?.info(
          "Wrote feeds HTML to {path} ({bytes} bytes) and file artifact",
          { path: args.outputPath, bytes: html.length },
        );

        return { dataHandles: [handle] };
      },
    },
    remove: {
      description: "Remove a feed URL from the catalog",
      arguments: RemoveFeedArgsSchema,
      execute: async (
        args: RemoveFeedArgs,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const logger = context.logger;

        const catalogData = await context.readResource("current") as
          | FeedCatalog
          | null;
        if (!catalogData) {
          throw new Error(
            "No feed catalog found. Add a feed first with 'add'.",
          );
        }

        const url = args.url.replace(/\/$/, "");

        const beforeCount = catalogData.feeds.length;
        catalogData.feeds = catalogData.feeds.filter((f) => f.url !== url);
        catalogData.totalCount = catalogData.feeds.length;

        if (catalogData.feeds.length === beforeCount) {
          throw new Error(`Feed not found in catalog: ${url}`);
        }

        logger?.info("Removed feed {url} from catalog", { url });

        const handle = await context.writeResource("catalog", "current", {
          name: catalogData.name,
          feeds: catalogData.feeds,
          totalCount: catalogData.totalCount,
        });

        return { dataHandles: [handle] };
      },
    },
    list: {
      description:
        "List feeds in the catalog. If category is omitted, all categories are returned. Use limit=0 for unlimited.",
      arguments: ListFeedsArgsSchema,
      execute: async (
        args: ListFeedsArgs,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const logger = context.logger;

        const catalogData = await context.readResource("current") as
          | FeedCatalog
          | null;
        if (!catalogData) {
          throw new Error(
            "No feed catalog found. Add feeds first with the 'add' method.",
          );
        }

        let feeds: Feed[] = catalogData.feeds;

        if (args.category) {
          feeds = feeds.filter((f) => f.category === args.category);
        }

        const limit = args.limit ?? 0;
        if (limit > 0 && feeds.length > limit) {
          feeds = feeds.slice(0, limit);
        }

        const output: FeedCatalog = {
          name: catalogData.name,
          feeds,
          totalCount: feeds.length,
        };

        logger?.info(
          "Listing {count} feeds from catalog '{catalog}'{category}",
          {
            count: feeds.length,
            catalog: catalogData.name,
            category: args.category ? ` (category: ${args.category})` : "",
          },
        );

        const handle = await context.writeResource(
          "catalog",
          "list-output",
          { ...output },
        );

        return { dataHandles: [handle] };
      },
    },
    listCategories: {
      description: "List all unique categories in the catalog",
      arguments: ListCategoriesArgsSchema,
      execute: async (
        _args: ListCategoriesArgs,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const logger = context.logger;

        const catalogData = await context.readResource("current") as
          | FeedCatalog
          | null;
        if (!catalogData) {
          throw new Error(
            "No feed catalog found. Add feeds first with the 'add' method.",
          );
        }

        const categories = Array.from(
          new Set(catalogData.feeds.map((f) => f.category)),
        ).sort();

        const output: CategoriesList = {
          name: catalogData.name,
          categories,
          totalCount: categories.length,
        };

        logger?.info(
          "Found {count} categories in catalog '{catalog}'",
          { count: categories.length, catalog: catalogData.name },
        );

        const handle = await context.writeResource(
          "categories",
          "list-output",
          { ...output },
        );

        return { dataHandles: [handle] };
      },
    },
  },
};
