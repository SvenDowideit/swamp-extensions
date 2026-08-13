import { assertEquals, assertExists } from "jsr:@std/assert@1";

import {
  ageOutCitations,
  type Article,
  canonicalUrl,
  clusterHash,
  clusterKey,
  clusterStories,
  computeKeywordWeights,
  dayKey,
  extractEntities,
  extractKeywords,
  generateHtml,
  parseFeed,
  parseNewsAge,
  type Preferences,
  renderStories,
  type Story,
  scoreArticle,
} from "./news_reader.ts";

const sampleArticle = (overrides: Partial<Article> = {}): Article => ({
  id: "abc123",
  title: "Test article",
  url: "https://example.com/article",
  source: "example.com",
  publishedAt: "2026-07-17T00:00:00Z",
  summary: "This is a test summary about technology and AI",
  keywords: ["technology", "ai"],
  ...overrides,
});

Deno.test("computeKeywordWeights assigns positive weights for interested keywords", () => {
  const prefs: Preferences = {
    interested: [{
      articleId: "1",
      recordedAt: new Date().toISOString(),
      source: "test",
      title: "AI breakthrough",
      keywords: ["ai", "technology"],
    }],
    ignored: [{
      articleId: "2",
      recordedAt: new Date().toISOString(),
      source: "test",
      title: "Boring sports news",
      keywords: ["sports", "football"],
    }],
    keywordWeights: {},
  };
  const weights = computeKeywordWeights(prefs);
  assertEquals(weights.ai, 1);
  assertEquals(weights.technology, 1);
  assertEquals(weights.sports, -1);
  assertEquals(weights.football, -1);
});

Deno.test("scoreArticle gives higher score to articles matching interested keywords", () => {
  const weights: Record<string, number> = { ai: 3, technology: 2, sports: -2 };
  const article = sampleArticle({ keywords: ["ai", "technology"] });
  const { score, reasons } = scoreArticle(article, weights);
  assertEquals(score, 5);
  assertExists(reasons.find((r) => r.includes("ai")));
  assertExists(reasons.find((r) => r.includes("technology")));
});

Deno.test("scoreArticle gives negative score for ignored keywords", () => {
  const weights: Record<string, number> = { sports: -3, football: -1 };
  const article = sampleArticle({ keywords: ["sports", "football"] });
  const { score } = scoreArticle(article, weights);
  assertEquals(score, -4);
});

Deno.test("scoreArticle returns zero score for articles with no matching keywords", () => {
  const weights: Record<string, number> = { ai: 5 };
  const article = sampleArticle({ keywords: ["cooking", "recipes"] });
  const { score, reasons } = scoreArticle(article, weights);
  assertEquals(score, 0);
  assertEquals(reasons.length, 0);
});

Deno.test("generateHtml produces valid HTML with article titles", () => {
  const articles = [
    { ...sampleArticle(), score: 3, reasons: ["ai (+2)", "technology (+1)"] },
    {
      ...sampleArticle({
        id: "def456",
        title: "Another article",
        url: "https://example.com/2",
      }),
      score: -1,
      reasons: ["sports (-1)"],
    },
  ];
  const prefs: Preferences = {
    interested: [],
    ignored: [],
    keywordWeights: { ai: 2, technology: 1 },
  };
  const html = generateHtml(
    articles,
    prefs,
    "Test News",
    "2026-07-17T00:00:00Z",
  );
  assertEquals(html.includes("<!DOCTYPE html>"), true);
  assertEquals(html.includes("Test News"), true);
  assertEquals(html.includes("Test article"), true);
  assertEquals(html.includes("Another article"), true);
  assertEquals(html.includes("score-high"), true);
  assertEquals(html.includes("score-low"), true);
});

Deno.test("generateHtml escapes HTML in article titles", () => {
  const articles = [
    {
      ...sampleArticle({ title: "<script>alert('xss')</script>" }),
      score: 0,
      reasons: [],
    },
  ];
  const prefs: Preferences = {
    interested: [],
    ignored: [],
    keywordWeights: {},
  };
  const html = generateHtml(articles, prefs, "Test", "2026-07-17T00:00:00Z");
  assertEquals(html.includes("<script>alert"), false);
  assertEquals(html.includes("&lt;script&gt;"), true);
});

Deno.test("generateHtml includes interest profile when keywords exist", () => {
  const articles = [{ ...sampleArticle(), score: 0, reasons: [] }];
  const prefs: Preferences = {
    interested: [],
    ignored: [],
    keywordWeights: { ai: 3, sports: -1 },
  };
  const html = generateHtml(articles, prefs, "Test", "2026-07-17T00:00:00Z");
  assertEquals(html.includes("Your interest profile:"), true);
  assertEquals(html.includes("ai (+3)"), true);
  assertEquals(html.includes("sports (-1)"), true);
});

Deno.test("generateHtml includes feedback links", () => {
  const articles = [{ ...sampleArticle(), score: 0, reasons: [] }];
  const prefs: Preferences = {
    interested: [],
    ignored: [],
    keywordWeights: {},
  };
  const html = generateHtml(articles, prefs, "Test", "2026-07-17T00:00:00Z");
  assertEquals(html.includes("interested"), true);
  assertEquals(html.includes("ignore"), true);
});

Deno.test("extractKeywords returns most frequent non-stopwords", () => {
  const keywords = extractKeywords(
    "AI breakthrough in quantum computing",
    "Researchers achieve quantum supremacy with new AI model",
  );
  assertEquals(keywords.includes("quantum"), true);
  assertEquals(keywords.includes("breakthrough"), true);
  assertEquals(keywords.includes("researchers"), true);
  // "ai" is only 2 chars — min length is 3, so it's excluded
  assertEquals(keywords.includes("ai"), false);
  // Stopwords should be excluded
  assertEquals(keywords.includes("the"), false);
  assertEquals(keywords.includes("with"), false);
});

Deno.test("extractKeywords respects maxKeywords limit", () => {
  const keywords = extractKeywords(
    "alpha beta gamma delta epsilon zeta eta theta iota kappa",
    "",
    5,
  );
  assertEquals(keywords.length, 5);
});

Deno.test("parseFeed parses RSS 2.0 with CDATA", () => {
  const xml = `<?xml version="1.0"?>
<rss version="2.0">
<channel>
<title><![CDATA[Test Feed]]></title>
<item>
<title><![CDATA[First Article]]></title>
<link>https://example.com/1</link>
<description><![CDATA[Summary of first article]]></description>
<pubDate>Fri, 17 Jul 2026 10:00:00 GMT</pubDate>
<category>tech</category>
</item>
<item>
<title><![CDATA[Second Article]]></title>
<link>https://example.com/2</link>
<description><![CDATA[Summary of second article]]></description>
<pubDate>Fri, 17 Jul 2026 11:00:00 GMT</pubDate>
</item>
</channel>
</rss>`;
  const articles = parseFeed(xml, "https://example.com/feed.xml");
  assertEquals(articles.length, 2);
  assertEquals(articles[0].title, "First Article");
  assertEquals(articles[0].url, "https://example.com/1");
  assertEquals(articles[0].summary, "Summary of first article");
  assertEquals(articles[0].source, "example.com");
  assertEquals(articles[0].keywords.includes("tech"), true);
});

Deno.test("parseFeed parses Atom feed", () => {
  const xml = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<title>Atom Test Feed</title>
<entry>
<title>Atom Article</title>
<link href="https://example.com/atom/1"/>
<summary>Atom article summary</summary>
<published>2026-07-17T10:00:00Z</published>
<category term="science"/>
</entry>
</feed>`;
  const articles = parseFeed(xml, "https://example.com/atom.xml");
  assertEquals(articles.length, 1);
  assertEquals(articles[0].title, "Atom Article");
  assertEquals(articles[0].url, "https://example.com/atom/1");
  assertEquals(articles[0].summary, "Atom article summary");
  assertEquals(articles[0].source, "example.com");
  assertEquals(articles[0].keywords.includes("science"), true);
});

Deno.test("parseFeed falls back to <updated> when Atom feed has no <published>", () => {
  const xml = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<title>Atom Test Feed</title>
<entry>
<title>Atom Article</title>
<link href="https://example.com/atom/1"/>
<summary>Atom article summary</summary>
<updated>2025-07-03T00:00:00Z</updated>
<category term="science"/>
</entry>
</feed>`;
  const articles = parseFeed(xml, "https://example.com/atom.xml");
  assertEquals(articles.length, 1);
  assertEquals(articles[0].publishedAt, "2025-07-03T00:00:00Z");
});

import { assertThrows } from "jsr:@std/assert@1";

Deno.test("parseNewsAge parses valid age strings", () => {
  // Hours
  assertEquals(parseNewsAge("2h"), 2 * 60 * 60 * 1000);
  assertEquals(parseNewsAge("12h"), 12 * 60 * 60 * 1000);
  
  // Days
  assertEquals(parseNewsAge("1d"), 24 * 60 * 60 * 1000);
  assertEquals(parseNewsAge("3d"), 3 * 24 * 60 * 60 * 1000);
  assertEquals(parseNewsAge("7d"), 7 * 24 * 60 * 60 * 1000);
  
  // Weeks
  assertEquals(parseNewsAge("1w"), 7 * 24 * 60 * 60 * 1000);
  assertEquals(parseNewsAge("4w"), 4 * 7 * 24 * 60 * 60 * 1000);
  
  // Months (approximate, 30 days)
  assertEquals(parseNewsAge("1m"), 30 * 24 * 60 * 60 * 1000);
});

Deno.test("parseNewsAge rejects invalid age strings", () => {
  assertThrows(() => parseNewsAge("2x"));
  assertThrows(() => parseNewsAge("days"));
  assertThrows(() => parseNewsAge(""));
  assertThrows(() => parseNewsAge("abc"));
});

// Helper function for testing - extract the filtering logic
function filterArticlesByAge(
  articles: Article[],
  maxAgeMs: number,
  nowMs: number
): Article[] {
  const cutoff = nowMs - maxAgeMs;
  return articles.filter((a) => {
    const pubDate = new Date(a.publishedAt).getTime();
    return pubDate >= cutoff;
  });
}

Deno.test("filterArticlesByAge filters by publication date", () => {
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);
  
  // Use different dates for each article
  const articles: Article[] = [
    { ...sampleArticle(), id: "recent", publishedAt: now.toISOString() },
    {
      ...sampleArticle({ id: "one-hour-ago" }),
      publishedAt: oneHourAgo.toISOString()
    },
    {
      ...sampleArticle({ id: "two-hours-ago" }),
      publishedAt: twoHoursAgo.toISOString()
    }
  ];
  
  // Filter for last 90 minutes (should only get "recent")
  let filtered = filterArticlesByAge(articles, parseNewsAge("1.5h"), now.getTime());
  assertEquals(filtered.length, 1);
  assertEquals(filtered[0].id, "recent");
  
  // Filter for last 2 hours (should get "recent" and "one-hour-ago")
  filtered = filterArticlesByAge(articles, parseNewsAge("2h"), now.getTime());
  assertEquals(filtered.length, 2);
  assertEquals(filtered.map(a => a.id).includes("two-hours-ago"), false);
  
  // Filter for last 30 minutes (should get nothing since all are older)
  filtered = filterArticlesByAge(articles, parseNewsAge("0.5h"), now.getTime());
  assertEquals(filtered.length, 0);
});

const storySample = (overrides: Partial<Story> = {}): Story => ({
  id: clusterHash("topic::entity1,entity2"),
  identity: {
    topic: "topic",
    entities: [
      { name: "Entity1", kind: "org" },
      { name: "Entity2", kind: "person" },
    ],
    seedArticleIds: ["a1"],
  },
  core: [
    {
      text: "Core claim one",
      sources: ["https://example.com/a1"],
      status: "confirmed",
      isDelta: false,
      addedAt: "2026-08-10T00:00:00Z",
    },
  ],
  updates: [],
  conflicts: [],
  status: "confirmed",
  citations: [
    {
      url: "https://example.com/a1",
      title: "Article one",
      source: "example.com",
      publishedAt: "2026-08-10T00:00:00Z",
      firstSeenAt: "2026-08-10T00:00:00Z",
    },
  ],
  createdAt: "2026-08-10T00:00:00Z",
  lastUpdatedAt: "2026-08-10T00:00:00Z",
  lastRegenAt: "2026-08-10T00:00:00Z",
  ...overrides,
});

Deno.test("extractEntities pulls capitalized named entities and skips stop words", () => {
  const entities = extractEntities(
    "OpenAI releases new model",
    "The company announced a product in California.",
  );
  assertExists(entities.find((e) => e.includes("OpenAI")));
  assertExists(entities.find((e) => e.includes("California")));
  assertEquals(entities.includes("The"), false);
});

Deno.test("canonicalUrl normalizes host and path, drops query/fragment", () => {
  assertEquals(
    canonicalUrl("https://Example.com/Article?x=1#frag"),
    "example.com/article",
  );
});

Deno.test("dayKey returns ISO date prefix for valid dates", () => {
  assertEquals(dayKey("2026-08-13T12:00:00Z"), "2026-08-13");
  assertEquals(dayKey("not-a-date"), "");
});

Deno.test("clusterKey is stable and entity-order independent", () => {
  const a = clusterKey("topic", [
    { name: "Beta", kind: "org" },
    { name: "Alpha", kind: "org" },
  ]);
  const b = clusterKey("topic", [
    { name: "Alpha", kind: "org" },
    { name: "Beta", kind: "org" },
  ]);
  assertEquals(a, b);
});

Deno.test("clusterStories groups articles sharing entities or canonical URL", () => {
  const articles: Article[] = [
    sampleArticle({
      id: "a1",
      title: "OpenAI launches new chip",
      summary: "OpenAI announced a new AI chip",
      url: "https://openai.example/story1",
    }),
    sampleArticle({
      id: "a2",
      title: "OpenAI chip details",
      summary: "OpenAI reveals more about its chip",
      url: "https://openai.example/story2",
    }),
    sampleArticle({
      id: "a3",
      title: "Unrelated cooking tips",
      summary: "How to bake bread at home",
      url: "https://cook.example/recipe",
    }),
  ];
  const { clusters, absorbable } = clusterStories(articles);
  const grouped = clusters.filter((c) => c.articles.length >= 2);
  assertExists(grouped.find((c) =>
    c.articles.some((a) => a.id === "a1") && c.articles.some((a) => a.id === "a2")
  ));
  // a3 shares no entity/URL with a1/a2, so it must not be grouped with them.
  const a3Group = clusters.find((c) =>
    c.articles.some((a) => a.id === "a3")
  );
  assertExists(a3Group);
  assertEquals(a3Group.articles.some((a) => a.id === "a1"), false);
  assertEquals(a3Group.articles.some((a) => a.id === "a2"), false);
});

Deno.test("clusterHash is deterministic and stable", () => {
  assertEquals(clusterHash("foo"), clusterHash("foo"));
  assertEquals(clusterHash("foo") === clusterHash("bar"), false);
});

Deno.test("ageOutCitations drops citations older than retention, keeps core", () => {
  const old = Date.now() - 40 * 24 * 3600 * 1000;
  const story = storySample({
    citations: [
      ...storySample().citations,
      {
        url: "https://example.com/old",
        title: "Old article",
        source: "example.com",
        publishedAt: new Date(old).toISOString(),
        firstSeenAt: new Date(old).toISOString(),
      },
    ],
  });
  const aged = ageOutCitations(story, 30);
  assertEquals(aged.citations.some((c) => c.url === "https://example.com/old"), false);
  assertEquals(aged.citations.length >= 1, true);
  assertEquals(aged.core.length, 1);
});

Deno.test("renderStories produces inline stories HTML section", () => {
  const html = renderStories([storySample()], "Fused stories");
  assertEquals(html.includes("<section class=\"stories\">"), true);
  assertEquals(html.includes("Core claim one"), true);
  assertEquals(html.includes("Fused stories"), true);
});
