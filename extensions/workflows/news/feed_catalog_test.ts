import { assertEquals, assertExists, assertThrows } from "jsr:@std/assert@1";

import {
  type Feed,
  type FeedCounts,
  engagementScore,
  extractChannel,
  extractFeedName,
  feedIdentity,
  generateFeedsHtml,
  isFeedBody,
  model,
  normalizeId,
} from "./feed_catalog.ts";

// ---------------------------------------------------------------------------
// extractFeedName
// ---------------------------------------------------------------------------

Deno.test("extractFeedName extracts hostname from URL", () => {
  assertEquals(extractFeedName("https://example.com/feed.xml"), "example.com");
});

Deno.test("extractFeedName strips www prefix", () => {
  assertEquals(extractFeedName("https://www.example.com/rss"), "example.com");
});

Deno.test("extractFeedName handles URL with path", () => {
  assertEquals(extractFeedName("https://blog.example.com/feed/atom"), "blog.example.com");
});

Deno.test("extractFeedName handles invalid URL gracefully", () => {
  assertEquals(extractFeedName("not-a-url"), "not-a-url");
});

Deno.test("extractFeedName strips trailing slash from hostname", () => {
  assertEquals(extractFeedName("https://example.com/"), "example.com");
});

// ---------------------------------------------------------------------------
// normalizeId
// ---------------------------------------------------------------------------

Deno.test("normalizeId lowercases plain IDs", () => {
  assertEquals(normalizeId("ABC123"), "abc123");
});

Deno.test("normalizeId trims whitespace", () => {
  assertEquals(normalizeId("  abc  "), "abc");
});

Deno.test("normalizeId normalizes HTTP URLs", () => {
  assertEquals(
    normalizeId("https://Example.com/Article#section"),
    "https://example.com/article",
  );
});

Deno.test("normalizeId strips trailing slash from URLs", () => {
  assertEquals(
    normalizeId("https://example.com/article/"),
    "https://example.com/article",
  );
});

Deno.test("normalizeId handles non-URL IDs", () => {
  assertEquals(normalizeId("tag:example.com,2024:123"), "tag:example.com,2024:123");
});

Deno.test("normalizeId handles empty string", () => {
  assertEquals(normalizeId(""), "");
});

// ---------------------------------------------------------------------------
// extractChannel
// ---------------------------------------------------------------------------

Deno.test("extractChannel extracts RSS channel block", () => {
  const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>Test</title><item><title>A</title></item></channel></rss>`;
  const ch = extractChannel(xml);
  assertEquals(ch.includes("<title>Test</title>"), true);
  assertEquals(ch.includes("<item>"), true);
});

Deno.test("extractChannel extracts Atom feed block", () => {
  const xml = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Test</title><entry><title>A</title></entry></feed>`;
  const ch = extractChannel(xml);
  assertEquals(ch.includes("<title>Test</title>"), true);
  assertEquals(ch.includes("<entry>"), true);
});

Deno.test("extractChannel returns empty string for non-feed XML", () => {
  assertEquals(extractChannel("<html><body>hello</body></html>"), "");
});

Deno.test("extractChannel returns empty string for empty input", () => {
  assertEquals(extractChannel(""), "");
});

// ---------------------------------------------------------------------------
// isFeedBody
// ---------------------------------------------------------------------------

Deno.test("isFeedBody detects RSS by content-type", () => {
  assertEquals(isFeedBody("application/rss+xml", ""), true);
});

Deno.test("isFeedBody detects Atom by content-type", () => {
  assertEquals(isFeedBody("application/atom+xml", ""), true);
});

Deno.test("isFeedBody detects JSON feed by content-type", () => {
  assertEquals(isFeedBody("application/feed+json", ""), true);
});

Deno.test("isFeedBody detects text/xml by content-type", () => {
  assertEquals(isFeedBody("text/xml", ""), true);
});

Deno.test("isFeedBody rejects HTML by content-type", () => {
  assertEquals(isFeedBody("text/html", ""), false);
});

Deno.test("isFeedBody rejects XHTML by content-type", () => {
  assertEquals(isFeedBody("application/xhtml+xml", ""), false);
});

Deno.test("isFeedBody detects RSS by body markers", () => {
  assertEquals(isFeedBody("text/plain", '<?xml version="1.0"?><rss version="2.0"><channel>'), true);
});

Deno.test("isFeedBody detects Atom by body markers", () => {
  assertEquals(isFeedBody("text/plain", '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">'), true);
});

Deno.test("isFeedBody detects JSON feed by body markers", () => {
  assertEquals(isFeedBody("text/plain", '{"version":"https://jsonfeed.org/version/1.1","items":[]}'), true);
});

Deno.test("isFeedBody rejects HTML by body markers", () => {
  assertEquals(isFeedBody("text/plain", "<!doctype html><html><head><title>Page</title>"), false);
});

Deno.test("isFeedBody returns false for unknown content", () => {
  assertEquals(isFeedBody("application/octet-stream", "binary data"), false);
});

// ---------------------------------------------------------------------------
// feedIdentity
// ---------------------------------------------------------------------------

Deno.test("feedIdentity computes identity from RSS item GUIDs", () => {
  const xml = `<?xml version="1.0"?>
<rss version="2.0">
<channel>
<title>Test Feed</title>
<description>Feed description</description>
<link>https://example.com</link>
<item><title>A</title><guid>https://example.com/1</guid></item>
<item><title>B</title><guid>https://example.com/2</guid></item>
</channel>
</rss>`;
  const { identity, score } = feedIdentity(xml);
  assertExists(identity);
  assertEquals(identity!.startsWith("items:"), true);
  assertEquals(score > 0, true);
});

Deno.test("feedIdentity computes identity from Atom entry IDs", () => {
  const xml = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<title>Atom Feed</title>
<entry><title>A</title><id>urn:uuid:123</id></entry>
<entry><title>B</title><id>urn:uuid:456</id></entry>
</feed>`;
  const { identity, score } = feedIdentity(xml);
  assertExists(identity);
  assertEquals(identity!.startsWith("items:"), true);
});

Deno.test("feedIdentity falls back to rel=self when no items", () => {
  const xml = `<?xml version="1.0"?>
<rss version="2.0">
<channel>
<title>Empty Feed</title>
<link rel="self" href="https://example.com/feed.xml"/>
</channel>
</rss>`;
  const { identity, score } = feedIdentity(xml);
  assertExists(identity);
  assertEquals(identity!.startsWith("self:"), true);
});

Deno.test("feedIdentity returns null identity for empty feed", () => {
  const xml = `<?xml version="1.0"?><rss version="2.0"><channel></channel></rss>`;
  const { identity, score } = feedIdentity(xml);
  assertEquals(identity, null);
  assertEquals(score, 0);
});

Deno.test("feedIdentity deduplicates identical item IDs", () => {
  const xml = `<?xml version="1.0"?>
<rss version="2.0">
<channel>
<item><title>A</title><guid>https://example.com/1</guid></item>
<item><title>B</title><guid>https://example.com/1</guid></item>
</channel>
</rss>`;
  const { identity } = feedIdentity(xml);
  assertExists(identity);
  // Should only have one ID in the identity string
  const ids = identity!.replace("items:", "").split("\n");
  assertEquals(ids.length, 1);
});

Deno.test("feedIdentity scores higher for feeds with more metadata", () => {
  const minimal = `<?xml version="1.0"?><rss version="2.0"><channel><item><guid>1</guid></item></channel></rss>`;
  const rich = `<?xml version="1.0"?>
<rss version="2.0">
<channel>
<title>Rich Feed</title>
<description>Full description</description>
<link>https://example.com</link>
<lastBuildDate>2026-01-01</lastBuildDate>
<author>author@example.com</author>
<item><guid>1</guid></item>
</channel>
</rss>`;
  const { score: minScore } = feedIdentity(minimal);
  const { score: richScore } = feedIdentity(rich);
  assertEquals(richScore > minScore, true);
});

Deno.test("feedIdentity handles Atom feed with link fallback for IDs", () => {
  const xml = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<entry><title>A</title><link href="https://example.com/1"/></entry>
</feed>`;
  const { identity } = feedIdentity(xml);
  assertExists(identity);
  assertEquals(identity!.startsWith("items:"), true);
});

Deno.test("feedIdentity handles RSS item with link fallback for GUID", () => {
  const xml = `<?xml version="1.0"?>
<rss version="2.0">
<channel>
<item><title>A</title><link>https://example.com/1</link></item>
</channel>
</rss>`;
  const { identity } = feedIdentity(xml);
  assertExists(identity);
  assertEquals(identity!.startsWith("items:"), true);
});

// ---------------------------------------------------------------------------
// generateFeedsHtml
// ---------------------------------------------------------------------------

const sampleFeed = (overrides: Partial<Feed> = {}): Feed => ({
  url: "https://example.com/feed.xml",
  name: "Example Feed",
  category: "tech",
  addedAt: "2026-08-01T00:00:00Z",
  ...overrides,
});

Deno.test("generateFeedsHtml produces valid HTML", () => {
  const html = generateFeedsHtml(
    [sampleFeed()],
    "Test Catalog",
    "2026-08-14T00:00:00Z",
  );
  assertEquals(html.includes("<!DOCTYPE html>"), true);
  assertEquals(html.includes("Test Catalog"), true);
  assertEquals(html.includes("Example Feed"), true);
});

Deno.test("generateFeedsHtml groups feeds by category", () => {
  const feeds: Feed[] = [
    sampleFeed({ url: "https://a.com/feed", category: "tech" }),
    sampleFeed({ url: "https://b.com/feed", category: "news" }),
  ];
  const html = generateFeedsHtml(feeds, "Test", "2026-08-14T00:00:00Z");
  assertEquals(html.includes("tech"), true);
  assertEquals(html.includes("news"), true);
});

Deno.test("generateFeedsHtml shows duplicate feeds indented under canonical", () => {
  const feeds: Feed[] = [
    sampleFeed({ url: "https://primary.com/feed", name: "Primary" }),
    sampleFeed({
      url: "https://dup.com/feed",
      name: "Duplicate",
      duplicate: true,
      duplicateOf: "https://primary.com/feed",
    }),
  ];
  const html = generateFeedsHtml(feeds, "Test", "2026-08-14T00:00:00Z");
  assertEquals(html.includes("Primary"), true);
  assertEquals(html.includes("Duplicate"), true);
  assertEquals(html.includes("duplicate of Primary"), true);
});

Deno.test("generateFeedsHtml shows invalid feeds section", () => {
  const feeds: Feed[] = [
    sampleFeed({
      url: "https://bad.com",
      name: "Bad Feed",
      invalid: true,
      invalidReason: "not a feed",
    }),
  ];
  const html = generateFeedsHtml(feeds, "Test", "2026-08-14T00:00:00Z");
  assertEquals(html.includes("Invalid feeds"), true);
  assertEquals(html.includes("Bad Feed"), true);
  assertEquals(html.includes("not a feed"), true);
});

Deno.test("generateFeedsHtml escapes HTML in feed names", () => {
  const feeds: Feed[] = [
    sampleFeed({ name: "<script>alert('xss')</script>" }),
  ];
  const html = generateFeedsHtml(feeds, "Test", "2026-08-14T00:00:00Z");
  assertEquals(html.includes("<script>alert"), false);
  assertEquals(html.includes("&lt;script&gt;"), true);
});

Deno.test("generateFeedsHtml handles empty feed list", () => {
  const html = generateFeedsHtml([], "Empty", "2026-08-14T00:00:00Z");
  assertEquals(html.includes("<!DOCTYPE html>"), true);
  assertEquals(html.includes("0 feeds"), true);
});

Deno.test("generateFeedsHtml includes article counts when prefs and snapshot provided", () => {
  const feeds: Feed[] = [sampleFeed()];
  const prefs = {
    interested: [{ articleId: "a1", source: "example.com" }],
    ignored: [],
    seen: ["a1", "a2"],
    read: ["a1"],
  };
  const snapshot = {
    articles: [
      { id: "a1", source: "example.com" },
      { id: "a2", source: "example.com" },
    ],
  };
  const html = generateFeedsHtml(feeds, "Test", "2026-08-14T00:00:00Z", prefs, snapshot);
  assertEquals(html.includes("seen 2"), true);
  assertEquals(html.includes("read 1"), true);
  assertEquals(html.includes("interested 1"), true);
});

Deno.test("engagementScore mixes clicked count into interested and penalizes ignored", () => {
  const counts: FeedCounts = {
    seen: 5,
    read: 2,
    interested: 1,
    ignored: 1,
    dedupedFrom: 0,
    dedupedTo: 0,
  };
  // 1*3 + 2*2 - 1*3 = 4
  assertEquals(engagementScore(counts), 4);
});

Deno.test("generateFeedsHtml renders a score pill on the feed card", () => {
  const feeds: Feed[] = [sampleFeed()];
  const prefs = {
    interested: [{ articleId: "a1", source: "example.com" }],
    ignored: [],
    seen: ["a1", "a2"],
    read: ["a1"],
  };
  const snapshot = {
    articles: [
      { id: "a1", source: "example.com" },
      { id: "a2", source: "example.com" },
    ],
  };
  const html = generateFeedsHtml(feeds, "Test", "2026-08-14T00:00:00Z", prefs, snapshot);
  // interested 1, read 1 -> engagement = 1*3 + 1*2 - 0 = 5 -> score-high with ★
  assertEquals(html.includes("score-high"), true);
  assertEquals(html.includes("★ 5"), true);
});

Deno.test("generateFeedsHtml includes orphan duplicates section", () => {
  const feeds: Feed[] = [
    sampleFeed({ url: "https://orphan.com/feed", name: "Orphan", duplicate: true, duplicateOf: "https://missing.com/feed" }),
  ];
  const html = generateFeedsHtml(feeds, "Test", "2026-08-14T00:00:00Z");
  assertEquals(html.includes("Orphan duplicates"), true);
  assertEquals(html.includes("Orphan"), true);
});

Deno.test("generateFeedsHtml includes toggle button for enabled feeds", () => {
  const feeds: Feed[] = [sampleFeed()];
  const html = generateFeedsHtml(feeds, "Test", "2026-08-14T00:00:00Z");
  assertEquals(html.includes("Disable"), true);
});

Deno.test("generateFeedsHtml shows disabled feed styling", () => {
  const feeds: Feed[] = [sampleFeed({ enabled: false })];
  const html = generateFeedsHtml(feeds, "Test", "2026-08-14T00:00:00Z");
  assertEquals(html.includes("Enable"), true);
  assertEquals(html.includes("feed disabled"), true);
});

Deno.test("generateFeedsHtml includes shared-with cross-reference", () => {
  const feeds: Feed[] = [
    sampleFeed({ url: "https://a.com/feed", name: "Feed A" }),
    sampleFeed({ url: "https://b.com/feed", name: "Feed B" }),
  ];
  const snapshot = {
    articles: [
      { id: "a1", source: "a.com", duplicateSources: ["b.com"] },
    ],
  };
  const html = generateFeedsHtml(feeds, "Test", "2026-08-14T00:00:00Z", undefined, snapshot);
  assertEquals(html.includes("shares articles with"), true);
});

Deno.test("generateFeedsHtml includes deduped-to cross-reference", () => {
  const feeds: Feed[] = [
    sampleFeed({ url: "https://a.com/feed", name: "Feed A" }),
    sampleFeed({ url: "https://b.com/feed", name: "Feed B" }),
  ];
  const snapshot = {
    articles: [
      { id: "a1", source: "a.com", duplicate: true, duplicateOf: "b1" },
      { id: "b1", source: "b.com" },
    ],
  };
  const html = generateFeedsHtml(feeds, "Test", "2026-08-14T00:00:00Z", undefined, snapshot);
  assertEquals(html.includes("deduped to"), true);
});

// ---------------------------------------------------------------------------
// seed method
// ---------------------------------------------------------------------------

const seedCtx = (stored: Record<string, unknown> | null) => {
  const writes: Array<{ spec: string; name: string; data: Record<string, unknown> }> = [];
  return {
    ctx: {
      globalArgs: { catalogName: "default" },
      logger: { info: () => {} },
      readResource: async () => stored,
      writeResource: async (
        spec: string,
        name: string,
        data: Record<string, unknown>,
      ) => {
        writes.push({ spec, name, data });
        return { name };
      },
    } as unknown as Parameters<typeof model.methods.seed.execute>[1],
    writes,
  };
};

Deno.test("seed adds default feed when catalog is empty", async () => {
  const { ctx, writes } = seedCtx(null);
  await model.methods.seed.execute(
    { url: "https://swamp-club.com/feed.xml", category: "swamp" },
    ctx,
  );

  assertEquals(writes.length, 1);
  const data = writes[0].data as { feeds: Feed[]; totalCount: number };
  assertEquals(data.feeds.length, 1);
  assertEquals(data.feeds[0].url, "https://swamp-club.com/feed.xml");
  assertEquals(data.feeds[0].category, "swamp");
  assertEquals(data.totalCount, 1);
});

Deno.test("seed is a no-op when catalog already has feeds", async () => {
  const existing = {
    name: "default",
    feeds: [{ url: "https://a.com/feed", name: "a.com", category: "x", addedAt: "2026-08-14T00:00:00Z" }],
    totalCount: 1,
  };
  const { ctx, writes } = seedCtx(existing);
  await model.methods.seed.execute(
    { url: "https://swamp-club.com/feed.xml", category: "swamp" },
    ctx,
  );

  const data = writes[0].data as { feeds: Feed[]; totalCount: number };
  assertEquals(data.feeds.length, 1);
  assertEquals(data.feeds[0].url, "https://a.com/feed");
  assertEquals(data.totalCount, 1);
});
