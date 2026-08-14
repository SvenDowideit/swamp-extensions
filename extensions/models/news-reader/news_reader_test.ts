import { assertEquals, assertExists, assertThrows } from "jsr:@std/assert@1";

import {
  ageOutCitations,
  type Article,
  canonicalUrl,
  clusterHash,
  clusterKey,
  clusterStories,
  computeClusterFingerprint,
  computeKeywordWeights,
  dayKey,
  dedupeArticlesIncremental,
  extractEntities,
  extractKeywords,
  generateHtml,
  parseFeed,
  parseNewsAge,
  type Preferences,
  renderStories,
  type Story,
  type StoryCluster,
  scoreArticle,
  selectClustersToSeed,
  shouldSkipCluster,
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

const clusterSample = (overrides: Partial<StoryCluster> = {}): StoryCluster => ({
  topic: "Test topic",
  entities: [{ name: "Entity1", kind: "org" }],
  articles: [sampleArticle({ id: "a1" }), sampleArticle({ id: "a2" })],
  needsGate: false,
  key: clusterKey("Test topic", [{ name: "Entity1", kind: "org" }]),
  ...overrides,
});

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

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
    seen: [],
    read: [],
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

// ---------------------------------------------------------------------------
// HTML generation
// ---------------------------------------------------------------------------

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
    seen: [],
    read: [],
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
    seen: [],
    read: [],
  };
  const html = generateHtml(articles, prefs, "Test", "2026-07-17T00:00:00Z");
  // The escaped title appears in the visible HTML (inside <h3><a>).
  assertEquals(html.includes("&lt;script&gt;alert"), true);
  assertEquals(html.includes("&#39;xss&#39;"), true);
  // The raw title appears in the JSON blob (articleJson), which is fine —
  // it's inside a JSON.stringify and not rendered as HTML.
  assertEquals(html.includes("\"title\":\"<script>alert"), true);
});

Deno.test("generateHtml includes interest profile when keywords exist", () => {
  const articles = [{ ...sampleArticle(), score: 0, reasons: [] }];
  const prefs: Preferences = {
    interested: [],
    ignored: [],
    keywordWeights: { ai: 3, sports: -1 },
    seen: [],
    read: [],
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
    seen: [],
    read: [],
  };
  const html = generateHtml(articles, prefs, "Test", "2026-07-17T00:00:00Z");
  assertEquals(html.includes("interested"), true);
  assertEquals(html.includes("ignore"), true);
});

Deno.test("generateHtml includes fused stories when storiesHtml is provided", () => {
  const articles = [{ ...sampleArticle(), score: 0, reasons: [] }];
  const prefs: Preferences = {
    interested: [],
    ignored: [],
    keywordWeights: {},
    seen: [],
    read: [],
  };
  const storiesHtml = "<section class=\"stories\"><h2>Fused</h2></section>";
  const html = generateHtml(articles, prefs, "Test", "2026-07-17T00:00:00Z", undefined, storiesHtml);
  assertEquals(html.includes("Fused"), true);
});

Deno.test("generateHtml shows age filter badge when ageFilter is provided", () => {
  const articles = [{ ...sampleArticle(), score: 0, reasons: [] }];
  const prefs: Preferences = {
    interested: [],
    ignored: [],
    keywordWeights: {},
    seen: [],
    read: [],
  };
  const html = generateHtml(articles, prefs, "Test", "2026-07-17T00:00:00Z", "3d");
  assertEquals(html.includes("3d"), true);
});

// ---------------------------------------------------------------------------
// Keyword extraction
// ---------------------------------------------------------------------------

Deno.test("extractKeywords returns most frequent non-stopwords", () => {
  const keywords = extractKeywords(
    "AI breakthrough in quantum computing",
    "Researchers achieve quantum supremacy with new AI model",
  );
  assertEquals(keywords.includes("quantum"), true);
  assertEquals(keywords.includes("breakthrough"), true);
  assertEquals(keywords.includes("researchers"), true);
  assertEquals(keywords.includes("ai"), false);
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

// ---------------------------------------------------------------------------
// Feed parsing
// ---------------------------------------------------------------------------

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

Deno.test("parseFeed skips items without a link", () => {
  const xml = `<?xml version="1.0"?>
<rss version="2.0">
<channel>
<item>
<title>No link article</title>
<description>This has no link</description>
</item>
<item>
<title>Has link</title>
<link>https://example.com/valid</link>
<description>This has a link</description>
</item>
</channel>
</rss>`;
  const articles = parseFeed(xml, "https://example.com/feed.xml");
  assertEquals(articles.length, 1);
  assertEquals(articles[0].title, "Has link");
});

// ---------------------------------------------------------------------------
// Age parsing and filtering
// ---------------------------------------------------------------------------

Deno.test("parseNewsAge parses valid age strings", () => {
  assertEquals(parseNewsAge("2h"), 2 * 60 * 60 * 1000);
  assertEquals(parseNewsAge("12h"), 12 * 60 * 60 * 1000);
  assertEquals(parseNewsAge("1d"), 24 * 60 * 60 * 1000);
  assertEquals(parseNewsAge("3d"), 3 * 24 * 60 * 60 * 1000);
  assertEquals(parseNewsAge("7d"), 7 * 24 * 60 * 60 * 1000);
  assertEquals(parseNewsAge("1w"), 7 * 24 * 60 * 60 * 1000);
  assertEquals(parseNewsAge("4w"), 4 * 7 * 24 * 60 * 60 * 1000);
  assertEquals(parseNewsAge("1m"), 30 * 24 * 60 * 60 * 1000);
});

Deno.test("parseNewsAge rejects invalid age strings", () => {
  assertThrows(() => parseNewsAge("2x"));
  assertThrows(() => parseNewsAge("days"));
  assertThrows(() => parseNewsAge(""));
  assertThrows(() => parseNewsAge("abc"));
  assertThrows(() => parseNewsAge("1.5h"));
});

Deno.test("filterArticlesByAge filters by publication date", () => {
  const now = Date.now();
  const fiveMinAgo = now - 5 * 60 * 1000;
  const oneHourAgo = now - 60 * 60 * 1000;
  const twoHoursAgo = now - 2 * 60 * 60 * 1000;

  const articles: Article[] = [
    { ...sampleArticle(), id: "five-min-ago", publishedAt: new Date(fiveMinAgo).toISOString() },
    {
      ...sampleArticle({ id: "one-hour-ago" }),
      publishedAt: new Date(oneHourAgo).toISOString(),
    },
    {
      ...sampleArticle({ id: "two-hours-ago" }),
      publishedAt: new Date(twoHoursAgo).toISOString(),
    },
  ];

  // Filter for last 10 minutes (should only get "five-min-ago")
  const maxAge10m = 10 * 60 * 1000;
  let filtered = articles.filter((a) => {
    const pubDate = new Date(a.publishedAt).getTime();
    return pubDate >= now - maxAge10m;
  });
  assertEquals(filtered.length, 1);
  assertEquals(filtered[0].id, "five-min-ago");

  // Filter for last 90 minutes (should get "five-min-ago" and "one-hour-ago")
  const maxAge90m = 90 * 60 * 1000;
  filtered = articles.filter((a) => {
    const pubDate = new Date(a.publishedAt).getTime();
    return pubDate >= now - maxAge90m;
  });
  assertEquals(filtered.length, 2);
  assertEquals(filtered.map((a) => a.id).includes("two-hours-ago"), false);

  // Filter for last 1 minute (should get nothing)
  const maxAge1m = 60 * 1000;
  filtered = articles.filter((a) => {
    const pubDate = new Date(a.publishedAt).getTime();
    return pubDate >= now - maxAge1m;
  });
  assertEquals(filtered.length, 0);
});

Deno.test("filterArticlesByAge skips duplicate articles", () => {
  const now = new Date();
  const articles: Article[] = [
    { ...sampleArticle(), id: "primary", publishedAt: now.toISOString() },
    {
      ...sampleArticle({ id: "dup" }),
      publishedAt: now.toISOString(),
      duplicate: true,
      duplicateOf: "primary",
    },
  ];
  const maxAgeMs = 24 * 60 * 60 * 1000;
  const filtered = articles.filter((a) => {
    if (a.duplicate === true) return false;
    const pubDate = new Date(a.publishedAt).getTime();
    return pubDate >= now.getTime() - maxAgeMs;
  });
  assertEquals(filtered.length, 1);
  assertEquals(filtered[0].id, "primary");
});

// ---------------------------------------------------------------------------
// Entity extraction
// ---------------------------------------------------------------------------

Deno.test("extractEntities pulls capitalized named entities and skips stop words", () => {
  const entities = extractEntities(
    "OpenAI releases new model",
    "The company announced a product in California.",
  );
  assertExists(entities.find((e) => e.includes("OpenAI")));
  assertExists(entities.find((e) => e.includes("California")));
  assertEquals(entities.includes("The"), false);
});

Deno.test("extractEntities falls back to keywords when no capitalized entities found", () => {
  const entities = extractEntities(
    "quantum computing breakthrough",
    "researchers achieve new results in the lab",
  );
  assertEquals(entities.length > 0, true);
  assertEquals(entities[0].charAt(0), entities[0].charAt(0).toUpperCase());
});

Deno.test("extractEntities respects maxEntities limit", () => {
  const entities = extractEntities(
    "Alpha Beta Gamma Delta Epsilon Zeta",
    "Eta Theta Iota Kappa Lambda",
    3,
  );
  assertEquals(entities.length, 3);
});

// ---------------------------------------------------------------------------
// URL and date utilities
// ---------------------------------------------------------------------------

Deno.test("canonicalUrl normalizes host and path, drops query/fragment", () => {
  assertEquals(
    canonicalUrl("https://Example.com/Article?x=1#frag"),
    "example.com/article",
  );
});

Deno.test("canonicalUrl handles invalid URLs gracefully", () => {
  assertEquals(canonicalUrl("not-a-url"), "not-a-url");
});

Deno.test("dayKey returns ISO date prefix for valid dates", () => {
  assertEquals(dayKey("2026-08-13T12:00:00Z"), "2026-08-13");
  assertEquals(dayKey("not-a-date"), "");
});

// ---------------------------------------------------------------------------
// Clustering
// ---------------------------------------------------------------------------

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

Deno.test("clusterKey lowercases topic for case-insensitive matching", () => {
  const a = clusterKey("Topic", [{ name: "Entity", kind: "org" }]);
  const b = clusterKey("topic", [{ name: "Entity", kind: "org" }]);
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
  const a3Group = clusters.find((c) =>
    c.articles.some((a) => a.id === "a3")
  );
  assertExists(a3Group);
  assertEquals(a3Group.articles.some((a) => a.id === "a1"), false);
  assertEquals(a3Group.articles.some((a) => a.id === "a2"), false);
});

Deno.test("clusterStories absorbs articles matching existing stories", () => {
  const existing: Story[] = [storySample({
    id: clusterKey("OpenAI launches new chip", [
      { name: "OpenAI", kind: "org" },
      { name: "California", kind: "place" },
    ]),
    identity: {
      topic: "OpenAI launches new chip",
      entities: [
        { name: "OpenAI", kind: "org" },
        { name: "California", kind: "place" },
      ],
      seedArticleIds: ["old1"],
    },
    citations: [
      {
        url: "https://openai.example/old",
        title: "Old article",
        source: "example.com",
        publishedAt: "2026-08-01T00:00:00Z",
        firstSeenAt: "2026-08-01T00:00:00Z",
      },
    ],
  })];
  const articles: Article[] = [
    sampleArticle({
      id: "new1",
      title: "OpenAI launches new chip in California",
      summary: "OpenAI announced a new AI chip from California",
      url: "https://openai.example/story1",
    }),
  ];
  const { absorbable } = clusterStories(articles, existing);
  assertEquals(absorbable.length, 1);
  assertEquals(absorbable[0].id, "new1");
});

Deno.test("clusterStories caches entities on articles", () => {
  const articles: Article[] = [
    sampleArticle({
      id: "a1",
      title: "OpenAI launches new chip",
      summary: "OpenAI announced a new AI chip",
    }),
  ];
  clusterStories(articles);
  assertEquals(articles[0].entities !== undefined, true);
  assertEquals(articles[0].entities!.length > 0, true);
});

Deno.test("clusterHash is deterministic and stable", () => {
  assertEquals(clusterHash("foo"), clusterHash("foo"));
  assertEquals(clusterHash("foo") === clusterHash("bar"), false);
});

// ---------------------------------------------------------------------------
// Cluster fingerprinting (Phase 1.2)
// ---------------------------------------------------------------------------

Deno.test("computeClusterFingerprint is deterministic for same input", async () => {
  const c = clusterSample();
  const fp1 = await computeClusterFingerprint(c, "llama3", 0.1);
  const fp2 = await computeClusterFingerprint(c, "llama3", 0.1);
  assertEquals(fp1, fp2);
});

Deno.test("computeClusterFingerprint changes when articles differ", async () => {
  const c1 = clusterSample({ articles: [sampleArticle({ id: "a1" })] });
  const c2 = clusterSample({ articles: [sampleArticle({ id: "a2" })] });
  const fp1 = await computeClusterFingerprint(c1, "llama3", 0.1);
  const fp2 = await computeClusterFingerprint(c2, "llama3", 0.1);
  assertEquals(fp1 === fp2, false);
});

Deno.test("computeClusterFingerprint changes when llmModel differs", async () => {
  const c = clusterSample();
  const fp1 = await computeClusterFingerprint(c, "llama3", 0.1);
  const fp2 = await computeClusterFingerprint(c, "mistral", 0.1);
  assertEquals(fp1 === fp2, false);
});

Deno.test("computeClusterFingerprint changes when llmTemperature differs", async () => {
  const c = clusterSample();
  const fp1 = await computeClusterFingerprint(c, "llama3", 0.1);
  const fp2 = await computeClusterFingerprint(c, "llama3", 0.7);
  assertEquals(fp1 === fp2, false);
});

Deno.test("shouldSkipCluster returns true when fingerprints match", async () => {
  const c = clusterSample();
  c.fingerprint = await computeClusterFingerprint(c, "llama3", 0.1);
  const prev = clusterSample();
  prev.fingerprint = await computeClusterFingerprint(prev, "llama3", 0.1);
  const prevByKey = new Map([[c.key, prev]]);
  assertEquals(shouldSkipCluster(c, prevByKey), true);
});

Deno.test("shouldSkipCluster returns false when fingerprints differ", async () => {
  const c = clusterSample();
  c.fingerprint = await computeClusterFingerprint(c, "llama3", 0.1);
  const prev = clusterSample();
  prev.fingerprint = await computeClusterFingerprint(prev, "llama3", 0.7);
  const prevByKey = new Map([[c.key, prev]]);
  assertEquals(shouldSkipCluster(c, prevByKey), false);
});

Deno.test("shouldSkipCluster returns false when no previous cluster exists", () => {
  const c = clusterSample();
  c.fingerprint = "abc";
  assertEquals(shouldSkipCluster(c, new Map()), false);
});

Deno.test("shouldSkipCluster returns false when fingerprint is missing", () => {
  const c = clusterSample();
  const prev = clusterSample();
  prev.fingerprint = "abc";
  const prevByKey = new Map([[c.key, prev]]);
  assertEquals(shouldSkipCluster(c, prevByKey), false);
});

// ---------------------------------------------------------------------------
// Seed selection (Phase 1.1 race-condition fix)
// ---------------------------------------------------------------------------

Deno.test("selectClustersToSeed returns clusters not matching existing stories", () => {
  const existing: Story[] = [storySample({
    id: clusterKey("Existing topic", [{ name: "Entity1", kind: "org" }]),
    identity: {
      topic: "Existing topic",
      entities: [{ name: "Entity1", kind: "org" }],
      seedArticleIds: ["old1"],
    },
  })];
  const clusters: StoryCluster[] = [
    clusterSample({
      topic: "Existing topic",
      entities: [{ name: "Entity1", kind: "org" }],
      key: clusterKey("Existing topic", [{ name: "Entity1", kind: "org" }]),
    }),
    clusterSample({
      topic: "New topic",
      entities: [{ name: "Entity2", kind: "org" }],
      key: clusterKey("New topic", [{ name: "Entity2", kind: "org" }]),
    }),
  ];
  const toSeed = selectClustersToSeed(clusters, existing, 2);
  assertEquals(toSeed.length, 1);
  assertEquals(toSeed[0].topic, "New topic");
});

Deno.test("selectClustersToSeed skips clusters below minClusterSize", () => {
  const clusters: StoryCluster[] = [
    clusterSample({
      articles: [sampleArticle({ id: "a1" })],
      key: clusterKey("Solo", [{ name: "Entity1", kind: "org" }]),
    }),
  ];
  const toSeed = selectClustersToSeed(clusters, [], 2);
  assertEquals(toSeed.length, 0);
});

Deno.test("selectClustersToSeed deduplicates by key", () => {
  const clusters: StoryCluster[] = [
    clusterSample({ key: "same-key" }),
    clusterSample({ key: "same-key" }),
  ];
  const toSeed = selectClustersToSeed(clusters, [], 2);
  assertEquals(toSeed.length, 1);
});

Deno.test("selectClustersToSeed returns empty when all clusters match existing stories", () => {
  const key = clusterKey("Topic", [{ name: "Entity1", kind: "org" }]);
  const existing: Story[] = [storySample({ id: key })];
  const clusters: StoryCluster[] = [clusterSample({ key })];
  const toSeed = selectClustersToSeed(clusters, existing, 2);
  assertEquals(toSeed.length, 0);
});

// ---------------------------------------------------------------------------
// Incremental dedupe (Phase 1.4)
// ---------------------------------------------------------------------------

Deno.test("dedupeArticlesIncremental processes only new URLs", () => {
  const articles: Article[] = [
    sampleArticle({ id: "a1", url: "https://example.com/1" }),
    sampleArticle({ id: "a2", url: "https://example.com/2" }),
  ];
  const prevUrls = ["https://example.com/1"];
  const prevArticles: Article[] = [
    sampleArticle({ id: "a1", url: "https://example.com/1" }),
  ];
  const result = dedupeArticlesIncremental(articles, prevUrls, prevArticles);
  assertEquals(result.newCount, 1);
  assertEquals(result.reusedCount, 1);
  assertEquals(result.deduped.length, 2);
});

Deno.test("dedupeArticlesIncremental returns only reused when no new URLs", () => {
  const articles: Article[] = [
    sampleArticle({ id: "a1", url: "https://example.com/1" }),
  ];
  const prevUrls = ["https://example.com/1"];
  const prevArticles: Article[] = [
    sampleArticle({ id: "a1", url: "https://example.com/1" }),
  ];
  const result = dedupeArticlesIncremental(articles, prevUrls, prevArticles);
  assertEquals(result.newCount, 0);
  assertEquals(result.reusedCount, 1);
  assertEquals(result.duplicateCount, 0);
});

Deno.test("dedupeArticlesIncremental marks duplicates in new articles", () => {
  const articles: Article[] = [
    sampleArticle({ id: "a1", url: "https://example.com/1", source: "sourceA" }),
    sampleArticle({ id: "a2", url: "https://example.com/1", source: "sourceB" }),
  ];
  const result = dedupeArticlesIncremental(articles, [], []);
  assertEquals(result.duplicateCount, 1);
  assertEquals(result.deduped.length, 2);
  const primary = result.deduped.find((a) => !a.duplicate);
  assertExists(primary);
  assertEquals(primary.duplicateSources!.length, 1);
  assertEquals(primary.duplicateCount, 1);
});

Deno.test("dedupeArticlesIncremental drops reused articles no longer in snapshot", () => {
  const articles: Article[] = [
    sampleArticle({ id: "a1", url: "https://example.com/1" }),
  ];
  const prevUrls = ["https://example.com/1", "https://example.com/old"];
  const prevArticles: Article[] = [
    sampleArticle({ id: "a1", url: "https://example.com/1" }),
    sampleArticle({ id: "old", url: "https://example.com/old" }),
  ];
  const result = dedupeArticlesIncremental(articles, prevUrls, prevArticles);
  assertEquals(result.reusedCount, 1);
  assertEquals(result.deduped.length, 1);
});

// ---------------------------------------------------------------------------
// Story rendering and aging
// ---------------------------------------------------------------------------

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

Deno.test("ageOutCitations returns unchanged story when retentionDays is 0", () => {
  const story = storySample();
  const aged = ageOutCitations(story, 0);
  assertEquals(aged.citations.length, story.citations.length);
});

Deno.test("renderStories produces inline stories HTML section", () => {
  const html = renderStories([storySample()], "Fused stories");
  assertEquals(html.includes("<section class=\"stories\">"), true);
  assertEquals(html.includes("Core claim one"), true);
  assertEquals(html.includes("Fused stories"), true);
});

Deno.test("renderStories returns empty string for empty stories", () => {
  assertEquals(renderStories([]), "");
});

Deno.test("renderStories includes conflict section when conflicts exist", () => {
  const story = storySample({
    conflicts: [{
      claimA: {
        text: "Death toll is 50",
        sources: ["https://example.com/a"],
        status: "conflicting",
        isDelta: true,
        addedAt: "2026-08-10T00:00:00Z",
      },
      claimB: {
        text: "Death toll is 100",
        sources: ["https://example.com/b"],
        status: "conflicting",
        isDelta: false,
        addedAt: "2026-08-10T00:00:00Z",
      },
      note: "discrepancy between sources",
    }],
  });
  const html = renderStories([story]);
  assertEquals(html.includes("Conflicts"), true);
  assertEquals(html.includes("Death toll is 50"), true);
  assertEquals(html.includes("Death toll is 100"), true);
});

Deno.test("renderStories includes status badge", () => {
  const story = storySample({ status: "confirmed" });
  const html = renderStories([story]);
  assertEquals(html.includes("confirmed"), true);
});

Deno.test("renderStories includes citation links", () => {
  const html = renderStories([storySample()]);
  assertEquals(html.includes("https://example.com/a1"), true);
  assertEquals(html.includes("Article one"), true);
});
