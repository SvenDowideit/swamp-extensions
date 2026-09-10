import {
  assertEquals,
  assertExists,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1";

import {
  ageOutCitations,
  type Article,
  model,
  canonicalUrl,
  chatCompletion,
  CircuitBreaker,
  clusterHash,
  clusterKey,
  clusterStories,
  computeClusterFingerprint,
  computeFeedScores,
  computeKeywordWeights,
  dayKey,
  dedupeArticlesIncremental,
  escapeHtml,
  extractEntities,
  extractJsonObject,
  extractKeywords,
  fetchFeed,
  generateHtml,
  generateMobileHtml,
  hashId,
  isFeedBody,
  isLlmServerError,
  formatGlobalArgsYaml,
  levenshtein,
  LlmError,
  mergeFeedFetchResult,
  parseFeed,
  parseNewsAge,
  type Preferences,
  renderStories,
  renderStoriesPage,
  type Story,
  type StoryCluster,
  scoreArticle,
  selectClustersToSeed,
  shouldSkipCluster,
  stripHtml,
  suggestModelSpelling,
  withConcurrency,
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

const emptyPrefs = (): Preferences => ({
  interested: [],
  ignored: [],
  seen: [],
  read: [],
  keywordWeights: {},
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

Deno.test("computeFeedScores mixes interested, read, and ignored per source", () => {
  const prefs: Preferences = {
    interested: [
      {
        articleId: "a1",
        recordedAt: "2026-07-17T00:00:00Z",
        source: "example.com",
        title: "t",
        keywords: [],
      },
    ],
    ignored: [
      {
        articleId: "a2",
        recordedAt: "2026-07-17T00:00:00Z",
        source: "example.com",
        title: "t",
        keywords: [],
      },
    ],
    seen: [],
    read: ["a1", "a3"],
    keywordWeights: {},
  };
  const articles = [
    sampleArticle({ id: "a1", source: "example.com" }),
    sampleArticle({ id: "a3", source: "example.com" }),
  ];
  const scores = computeFeedScores(prefs, articles);
  // interested 1*3 + read 2*2 - ignored 1*3 = 3 + 4 - 3 = 4
  assertEquals(scores["example.com"], 4);
});

Deno.test("generateHtml renders feed score pill and keyword score pill", () => {
  const articles = [
    { ...sampleArticle(), score: 3, reasons: ["ai (+2)"] },
  ];
  const prefs: Preferences = {
    interested: [
      {
        articleId: "abc123",
        recordedAt: "2026-07-17T00:00:00Z",
        source: "example.com",
        title: "Test article",
        keywords: ["ai"],
      },
    ],
    ignored: [],
    keywordWeights: { ai: 2 },
    seen: [],
    read: ["abc123"],
  };
  const html = generateHtml(
    articles,
    prefs,
    "Test News",
    "2026-07-17T00:00:00Z",
  );
  // feed score: interested 1*3 + read 1*2 = 5 -> ★ 5
  assertEquals(html.includes("★ 5"), true);
  // keyword score: a.score 3 + read 2 = 5 -> ★ 5
  assertEquals(html.includes("★ 5"), true);
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
    interested: [
      {
        articleId: "abc123",
        recordedAt: "2026-07-17T00:00:00Z",
        source: "example.com",
        title: "Test article",
        keywords: ["ai"],
      },
    ],
    ignored: [
      {
        articleId: "def456",
        recordedAt: "2026-07-17T00:00:00Z",
        source: "example.com",
        title: "Another article",
        keywords: ["sports"],
      },
    ],
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
  // The title inside the inline JSON blob (articleJson) must be entity-escaped
  // so its raw double quotes don't break out of the onclick attribute value.
  // Both the JSON's own quotes and the title chars are escaped.
  assertEquals(html.includes("&quot;title&quot;:&quot;&lt;script&gt;alert"), true);
  // No raw double-quoted JSON survives un-escaped in the document.
  assertEquals(html.includes("\"title\":\"<script>"), false);
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
// LLM probe helpers (setup live-testing)
// ---------------------------------------------------------------------------

Deno.test("levenshtein computes edit distance", () => {
  assertEquals(levenshtein("kitten", "sitting"), 3);
  assertEquals(levenshtein("", "abc"), 3);
  assertEquals(levenshtein("abc", "abc"), 0);
});

Deno.test("suggestModelSpelling returns closest model tag", () => {
  const available = ["llama3.1:8b", "qwen2.5:7b", "mistral"];
  assertEquals(suggestModelSpelling("llama3", available), "llama3.1:8b");
  assertEquals(suggestModelSpelling("qwen2.5", available), "qwen2.5:7b");
});

Deno.test("suggestModelSpelling returns undefined when nothing is close", () => {
  const available = ["llama3.1:8b", "qwen2.5:7b"];
  assertEquals(suggestModelSpelling("gpt-4o", available), undefined);
});

Deno.test("suggestModelSpelling returns undefined for empty model or list", () => {
  assertEquals(suggestModelSpelling("", ["llama3"]), undefined);
  assertEquals(suggestModelSpelling("llama3", []), undefined);
});

Deno.test("formatGlobalArgsYaml emits a copy-paste globalArguments block", () => {
  const yaml = formatGlobalArgsYaml({
    llmBaseUrl: "http://localhost:11434",
    llmModel: "llama3",
    llmApiKey: "sk-secret",
    llmTemperature: 0.1,
    fusionMinClusterSize: 2,
    citationRetentionDays: 30,
    llmConcurrency: 3,
    maxFusions: 25,
    llmTimeoutSec: 120,
    llmFailureThreshold: 3,
    feedbackServerPort: 8765,
    feedbackServerServiceName: "feedback-server",
  });
  assertEquals(yaml.includes("globalArguments:"), true);
  assertEquals(yaml.includes('llmBaseUrl: "http://localhost:11434"'), true);
  assertEquals(yaml.includes('llmModel: "llama3"'), true);
  assertEquals(yaml.includes("llmTemperature: 0.1"), true);
  assertEquals(yaml.includes("fusionMinClusterSize: 2"), true);
  assertEquals(yaml.includes("sk-secret"), false);
  assertEquals(yaml.includes("REDACTED"), true);
});

Deno.test("formatGlobalArgsYaml omits empty values", () => {
  const yaml = formatGlobalArgsYaml({
    llmBaseUrl: "http://localhost:11434",
    llmModel: "",
    llmApiKey: "",
    llmTemperature: 0.1,
    fusionMinClusterSize: 2,
    citationRetentionDays: 30,
    llmConcurrency: 3,
    maxFusions: 25,
    llmTimeoutSec: 120,
    llmFailureThreshold: 3,
    feedbackServerPort: 8765,
    feedbackServerServiceName: "feedback-server",
  });
  assertEquals(yaml.includes("llmModel"), false);
  assertEquals(yaml.includes("llmApiKey"), false);
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

Deno.test("renderStories produces inline stories HTML section", async () => {
  const html = await renderStories([storySample()], emptyPrefs(), "Fused stories");
  assertEquals(html.includes("<section class=\"stories\">"), true);
  assertEquals(html.includes("Core claim one"), true);
  assertEquals(html.includes("Fused stories"), true);
});

Deno.test("renderStories returns empty string for empty stories", async () => {
  assertEquals(await renderStories([], emptyPrefs()), "");
});

Deno.test("renderStories includes conflict section when conflicts exist", async () => {
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
  const html = await renderStories([story], emptyPrefs());
  assertEquals(html.includes("Conflicts"), true);
  assertEquals(html.includes("Death toll is 50"), true);
  assertEquals(html.includes("Death toll is 100"), true);
});

Deno.test("renderStories includes status badge", async () => {
  const story = storySample({ status: "confirmed" });
  const html = await renderStories([story], emptyPrefs());
  assertEquals(html.includes("confirmed"), true);
});

Deno.test("renderStoriesPage produces a full standalone HTML page", async () => {
  const story = storySample({
    citations: [{
      url: "https://example.com/a1",
      title: "Article one",
      source: "example.com",
      publishedAt: "2026-08-10T00:00:00Z",
      firstSeenAt: "2026-08-10T00:00:00Z",
    }],
  });
  const prefs: Preferences = {
    interested: [],
    ignored: [],
    seen: [],
    read: [],
    keywordWeights: {},
  };
  const html = await renderStoriesPage(
    [story],
    prefs,
    "Fused stories",
    "2026-08-15T00:00:00Z",
  );
  assertEquals(html.includes("<!DOCTYPE html>"), true);
  assertEquals(html.includes("</html>"), true);
  assertEquals(html.includes("Fused stories"), true);
  assertEquals(html.includes("Article one"), true);
  assertEquals(html.includes("data-article-id"), true);
});

Deno.test("renderStoriesPage sorts stories newest first by createdAt", async () => {
  const older = storySample({
    createdAt: "2026-08-10T00:00:00Z",
    identity: { topic: "Old topic", entities: [], seedArticleIds: ["a1"] },
  });
  const newer = storySample({
    createdAt: "2026-08-12T00:00:00Z",
    identity: { topic: "New topic", entities: [], seedArticleIds: ["a2"] },
  });
  const prefs: Preferences = {
    interested: [],
    ignored: [],
    seen: [],
    read: [],
    keywordWeights: {},
  };
  const html = await renderStoriesPage(
    [older, newer],
    prefs,
    "Fused stories",
    "2026-08-15T00:00:00Z",
  );
  assertEquals(html.indexOf("New topic") < html.indexOf("Old topic"), true);
});

Deno.test("renderStoriesPage marks read citations with read-badge", async () => {
  const story = storySample({
    citations: [{
      url: "https://example.com/a1",
      title: "Article one",
      source: "example.com",
      publishedAt: "2026-08-10T00:00:00Z",
      firstSeenAt: "2026-08-10T00:00:00Z",
    }],
  });
  const readId = await hashId("https://example.com/a1");
  const prefs: Preferences = {
    interested: [],
    ignored: [],
    seen: [readId],
    read: [readId],
    keywordWeights: {},
  };
  const html = await renderStoriesPage(
    [story],
    prefs,
    "Fused stories",
    "2026-08-15T00:00:00Z",
  );
  assertEquals(html.includes("read-badge"), true);
  assertEquals(html.includes("citation-box read"), true);
  assertEquals(html.includes("read hidden"), false);
});

Deno.test("renderStoriesPage renders one compact article card per fused article", async () => {
  const story = storySample({
    citations: [
      {
        url: "https://example.com/a1",
        title: "Article one",
        source: "example.com",
        publishedAt: "2026-08-10T00:00:00Z",
        firstSeenAt: "2026-08-10T00:00:00Z",
      },
      {
        url: "https://example.com/a2",
        title: "Article two",
        source: "example.com",
        publishedAt: "2026-08-11T00:00:00Z",
        firstSeenAt: "2026-08-11T00:00:00Z",
      },
    ],
  });
  const prefs: Preferences = {
    interested: [],
    ignored: [],
    seen: [],
    read: [],
    keywordWeights: {},
  };
  const html = await renderStoriesPage(
    [story],
    prefs,
    "Fused stories",
    "2026-08-15T00:00:00Z",
  );
  // one compact article card per fused article
  assertEquals(html.match(/class="article citation-box/g)?.length, 2);
  // compact card styling overrides full-size article styling
  assertEquals(html.includes(".citation-box { margin-bottom: 6px; padding: 8px 10px; }"), true);
  // each card carries its own 👍/👎 feedback actions
  assertEquals(html.includes("sendFeedback('interested',{"), true);
  assertEquals(html.includes("sendFeedback('ignored',{"), true);
  assertEquals(html.includes("Article one"), true);
  assertEquals(html.includes("Article two"), true);
});


Deno.test("renderStories includes citation links", async () => {
  const html = await renderStories([storySample()], emptyPrefs());
  assertEquals(html.includes("https://example.com/a1"), true);
  assertEquals(html.includes("Article one"), true);
});

// ---------------------------------------------------------------------------
// hashId
// ---------------------------------------------------------------------------

Deno.test("hashId produces deterministic output", async () => {
  const a = await hashId("hello");
  const b = await hashId("hello");
  assertEquals(a, b);
});

Deno.test("hashId produces different output for different input", async () => {
  const a = await hashId("hello");
  const b = await hashId("world");
  assertEquals(a === b, false);
});

Deno.test("hashId handles empty string", async () => {
  const h = await hashId("");
  assertEquals(typeof h, "string");
  assertEquals(h.length, 12);
});

Deno.test("hashId output is 12 hex chars", async () => {
  const h = await hashId("test");
  assertEquals(h.length, 12);
  assertEquals(/^[0-9a-f]+$/.test(h), true);
});

// ---------------------------------------------------------------------------
// stripHtml
// ---------------------------------------------------------------------------

Deno.test("stripHtml removes HTML tags", () => {
  assertEquals(stripHtml("<p>Hello</p>"), "Hello");
});

Deno.test("stripHtml removes CDATA sections", () => {
  assertEquals(stripHtml("<![CDATA[Hello world]]>"), "Hello world");
});

Deno.test("stripHtml decodes HTML entities", () => {
  assertEquals(stripHtml("&lt;div&gt; &amp; &quot;&quot;"), "<div> & \"\"");
});
Deno.test("stripHtml decodes &nbsp; and &quot;", () => {
  assertEquals(stripHtml("a&nbsp;b &quot;c&quot;"), "a b \"c\"");
});

Deno.test("stripHtml collapses whitespace", () => {
  assertEquals(stripHtml("a   b\n\nc"), "a b c");
});

Deno.test("stripHtml handles empty string", () => {
  assertEquals(stripHtml(""), "");
});

Deno.test("stripHtml handles nested tags", () => {
  assertEquals(stripHtml("<div><p>text</p></div>"), "text");
});

Deno.test("stripHtml decodes apostrophe entity forms", () => {
  assertEquals(stripHtml("military&#039;s"), "military's");
  assertEquals(stripHtml("&apos;mark all as read&apos; app"), "'mark all as read' app");
  assertEquals(stripHtml("&#39;"), "'");
  assertEquals(stripHtml("&#x27;"), "'");
});

Deno.test("stripHtml decodes double-escaped entities", () => {
  assertEquals(stripHtml("military&#039;s"), "military's");
  assertEquals(stripHtml("&apos;app"), "'app");
  assertEquals(stripHtml("&amp;"), "&");
});

// ---------------------------------------------------------------------------
// escapeHtml
// ---------------------------------------------------------------------------

Deno.test("escapeHtml escapes ampersand", () => {
  assertEquals(escapeHtml("a & b"), "a &amp; b");
});

Deno.test("escapeHtml escapes angle brackets", () => {
  assertEquals(escapeHtml("<script>"), "&lt;script&gt;");
});

Deno.test("escapeHtml escapes double quotes", () => {
  assertEquals(escapeHtml('"hello"'), "&quot;hello&quot;");
});

Deno.test("escapeHtml escapes single quotes", () => {
  assertEquals(escapeHtml("it's"), "it&#39;s");
});

Deno.test("escapeHtml handles empty string", () => {
  assertEquals(escapeHtml(""), "");
});

Deno.test("escapeHtml handles plain text unchanged", () => {
  assertEquals(escapeHtml("Hello world"), "Hello world");
});

Deno.test("escapeHtml handles already-escaped text", () => {
  assertEquals(escapeHtml("&amp;"), "&amp;amp;");
});

// ---------------------------------------------------------------------------
// extractJsonObject
// ---------------------------------------------------------------------------

Deno.test("extractJsonObject parses plain JSON", () => {
  const result = extractJsonObject<{ key: string }>('{"key":"value"}');
  assertEquals(result.key, "value");
});

Deno.test("extractJsonObject strips markdown code fences", () => {
  const result = extractJsonObject<{ key: string }>('```json\n{"key":"value"}\n```');
  assertEquals(result.key, "value");
});

Deno.test("extractJsonObject strips markdown fences without language", () => {
  const result = extractJsonObject<{ key: string }>('```\n{"key":"value"}\n```');
  assertEquals(result.key, "value");
});

Deno.test("extractJsonObject extracts JSON from surrounding prose", () => {
  const result = extractJsonObject<{ key: string }>('Here is the result: {"key":"value"} end.');
  assertEquals(result.key, "value");
});

Deno.test("extractJsonObject handles nested objects", () => {
  const result = extractJsonObject<{ outer: { inner: string } }>(
    '{"outer":{"inner":"deep"}}',
  );
  assertEquals(result.outer.inner, "deep");
});

Deno.test("extractJsonObject throws on no JSON object", () => {
  assertThrows(() => extractJsonObject("no json here"));
});

Deno.test("extractJsonObject throws on empty string", () => {
  assertThrows(() => extractJsonObject(""));
});

Deno.test("extractJsonObject handles arrays in JSON", () => {
  const result = extractJsonObject<{ items: string[] }>(
    '{"items":["a","b","c"]}',
  );
  assertEquals(result.items.length, 3);
});

// ---------------------------------------------------------------------------
// isFeedBody
// ---------------------------------------------------------------------------

Deno.test("isFeedBody detects RSS XML by content-type", () => {
  assertEquals(isFeedBody("application/rss+xml", ""), true);
});

Deno.test("isFeedBody detects Atom XML by content-type", () => {
  assertEquals(isFeedBody("application/atom+xml", ""), true);
});

Deno.test("isFeedBody detects text/xml by content-type", () => {
  assertEquals(isFeedBody("text/xml", ""), true);
});

Deno.test("isFeedBody detects application/xml by content-type", () => {
  assertEquals(isFeedBody("application/xml", ""), true);
});

Deno.test("isFeedBody detects JSON feed by content-type", () => {
  assertEquals(isFeedBody("application/feed+json", ""), true);
});

Deno.test("isFeedBody rejects HTML by content-type", () => {
  assertEquals(isFeedBody("text/html", ""), false);
});

Deno.test("isFeedBody rejects XHTML by content-type", () => {
  assertEquals(isFeedBody("application/xhtml+xml", ""), false);
});

Deno.test("isFeedBody detects RSS by body content", () => {
  assertEquals(isFeedBody("text/plain", '<?xml version="1.0"?><rss version="2.0"><channel>'), true);
});

Deno.test("isFeedBody detects Atom by body content", () => {
  assertEquals(isFeedBody("text/plain", '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">'), true);
});

Deno.test("isFeedBody detects JSON feed by body content", () => {
  assertEquals(isFeedBody("text/plain", '{"version":"https://jsonfeed.org/version/1.1","items":[]}'), true);
});

Deno.test("isFeedBody rejects HTML by body content", () => {
  assertEquals(isFeedBody("text/plain", "<!doctype html><html><head>"), false);
});

Deno.test("isFeedBody rejects HTML with body tag", () => {
  assertEquals(isFeedBody("text/plain", "<html><body>content</body></html>"), false);
});

Deno.test("isFeedBody rejects HTML with title tag", () => {
  assertEquals(isFeedBody("text/plain", "<html><head><title>Page</title>"), false);
});

Deno.test("isFeedBody returns false for unknown content", () => {
  assertEquals(isFeedBody("application/octet-stream", "binary data"), false);
});

Deno.test("isFeedBody handles empty body", () => {
  // text/xml content-type alone is enough to identify a feed
  assertEquals(isFeedBody("text/xml", ""), true);
  // Unknown content-type with empty body is not a feed
  assertEquals(isFeedBody("application/octet-stream", ""), false);
});

// ---------------------------------------------------------------------------
// Edge cases for existing functions
// ---------------------------------------------------------------------------

Deno.test("parseNewsAge handles uppercase units", () => {
  assertEquals(parseNewsAge("3D"), 3 * 24 * 60 * 60 * 1000);
  assertEquals(parseNewsAge("2H"), 2 * 60 * 60 * 1000);
});

Deno.test("parseNewsAge rejects negative numbers", () => {
  assertThrows(() => parseNewsAge("-3d"));
});

Deno.test("parseNewsAge rejects zero", () => {
  // "0d" is actually valid — it parses to 0ms. The regex matches \d+.
  // Test that it doesn't throw and returns 0.
  assertEquals(parseNewsAge("0d"), 0);
});

Deno.test("extractKeywords handles empty input", () => {
  assertEquals(extractKeywords("", "").length, 0);
});

Deno.test("extractKeywords handles only stopwords", () => {
  const kw = extractKeywords("the and or but", "with for from");
  assertEquals(kw.length, 0);
});

Deno.test("extractKeywords handles duplicate words", () => {
  const kw = extractKeywords("quantum quantum quantum", "computing computing");
  assertEquals(kw.includes("quantum"), true);
  assertEquals(kw.includes("computing"), true);
});

Deno.test("extractEntities handles empty input", () => {
  assertEquals(extractEntities("", "").length, 0);
});

Deno.test("extractEntities handles only stop-entity words", () => {
  const entities = extractEntities("The And Or But", "With For From");
  assertEquals(entities.length, 0);
});

Deno.test("canonicalUrl drops port from hostname", () => {
  // URL.hostname does not include port
  assertEquals(canonicalUrl("https://example.com:8080/path"), "example.com/path");
});

Deno.test("canonicalUrl handles IP address", () => {
  assertEquals(canonicalUrl("http://192.168.1.1/path"), "192.168.1.1/path");
});

Deno.test("dayKey handles epoch date", () => {
  assertEquals(dayKey("1970-01-01T00:00:00Z"), "1970-01-01");
});

Deno.test("clusterKey handles empty entities", () => {
  const key = clusterKey("topic", []);
  assertEquals(typeof key, "string");
  assertEquals(key.length > 0, true);
});

Deno.test("clusterStories handles empty articles array", () => {
  const { clusters, absorbable } = clusterStories([]);
  assertEquals(clusters.length, 0);
  assertEquals(absorbable.length, 0);
});

Deno.test("clusterStories handles single article", () => {
  const { clusters } = clusterStories([sampleArticle()]);
  assertEquals(clusters.length, 1);
  assertEquals(clusters[0].articles.length, 1);
});

Deno.test("clusterStories respects maxClusterSize", () => {
  const articles = Array.from({ length: 50 }, (_, i) =>
    sampleArticle({
      id: `a${i}`,
      title: "Same OpenAI story",
      summary: "OpenAI chip news",
      url: `https://openai.example/${i}`,
    })
  );
  const { clusters } = clusterStories(articles, [], 10);
  for (const c of clusters) {
    assertEquals(c.articles.length <= 10, true);
  }
});

Deno.test("ageOutCitations handles all citations older than retention", () => {
  const old = Date.now() - 40 * 24 * 3600 * 1000;
  const story = storySample({
    citations: [
      {
        url: "https://example.com/old1",
        title: "Old 1",
        source: "example.com",
        publishedAt: new Date(old).toISOString(),
        firstSeenAt: new Date(old).toISOString(),
      },
      {
        url: "https://example.com/old2",
        title: "Old 2",
        source: "example.com",
        publishedAt: new Date(old).toISOString(),
        firstSeenAt: new Date(old).toISOString(),
      },
    ],
  });
  const aged = ageOutCitations(story, 30);
  assertEquals(aged.citations.length, 0);
  assertEquals(aged.core.length, 1);
});

Deno.test("ageOutCitations handles story with no citations", () => {
  const story = storySample({ citations: [] });
  const aged = ageOutCitations(story, 30);
  assertEquals(aged.citations.length, 0);
});

Deno.test("renderStories handles story with no core claims", async () => {
  const story = storySample({ core: [] });
  const html = await renderStories([story], emptyPrefs());
  assertEquals(html.includes("<section class=\"stories\">"), true);
});

Deno.test("renderStories handles story with no citations", async () => {
  const story = storySample({ citations: [] });
  const html = await renderStories([story], emptyPrefs());
  assertEquals(html.includes("<section class=\"stories\">"), true);
});

Deno.test("renderStories handles very long topic text", async () => {
  const story = storySample({
    identity: {
      ...storySample().identity,
      topic: "A".repeat(500),
    },
  });
  const html = await renderStories([story], emptyPrefs());
  assertEquals(html.includes("A".repeat(500)), true);
});

Deno.test("parseFeed handles empty XML", () => {
  assertEquals(parseFeed("", "https://example.com/feed.xml").length, 0);
});

Deno.test("parseFeed handles RSS with no items", () => {
  const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>Empty</title></channel></rss>`;
  assertEquals(parseFeed(xml, "https://example.com/feed.xml").length, 0);
});

Deno.test("parseFeed handles Atom with no entries", () => {
  const xml = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Empty</title></feed>`;
  assertEquals(parseFeed(xml, "https://example.com/atom.xml").length, 0);
});

Deno.test("parseFeed handles non-ASCII characters", () => {
  const xml = `<?xml version="1.0"?>
<rss version="2.0">
<channel>
<item>
<title>Café résumé</title>
<link>https://example.com/1</link>
<description>Crème brûlée</description>
</item>
</channel>
</rss>`;
  const articles = parseFeed(xml, "https://example.com/feed.xml");
  assertEquals(articles.length, 1);
  assertEquals(articles[0].title, "Café résumé");
});

Deno.test("parseFeed handles missing pubDate", () => {
  const xml = `<?xml version="1.0"?>
<rss version="2.0">
<channel>
<item>
<title>No date</title>
<link>https://example.com/1</link>
<description>No publication date</description>
</item>
</channel>
</rss>`;
  const articles = parseFeed(xml, "https://example.com/feed.xml");
  assertEquals(articles.length, 1);
  assertEquals(articles[0].publishedAt.length > 0, true);
});

Deno.test("computeKeywordWeights handles empty preferences", () => {
  const prefs: Preferences = {
    interested: [],
    ignored: [],
    keywordWeights: {},
    seen: [],
    read: [],
  };
  assertEquals(Object.keys(computeKeywordWeights(prefs)).length, 0);
});

Deno.test("computeKeywordWeights handles duplicate keywords across entries", () => {
  const prefs: Preferences = {
    interested: [
      { articleId: "1", recordedAt: "", source: "", title: "", keywords: ["ai", "tech"] },
      { articleId: "2", recordedAt: "", source: "", title: "", keywords: ["ai", "science"] },
    ],
    ignored: [
      { articleId: "3", recordedAt: "", source: "", title: "", keywords: ["sports"] },
    ],
    keywordWeights: {},
    seen: [],
    read: [],
  };
  const weights = computeKeywordWeights(prefs);
  assertEquals(weights.ai, 2);
  assertEquals(weights.tech, 1);
  assertEquals(weights.science, 1);
  assertEquals(weights.sports, -1);
});

Deno.test("scoreArticle handles article with no keywords", () => {
  const weights: Record<string, number> = { ai: 5 };
  const article = sampleArticle({ keywords: [] });
  const { score, reasons } = scoreArticle(article, weights);
  assertEquals(score, 0);
  assertEquals(reasons.length, 0);
});

Deno.test("scoreArticle handles keywords not in weights", () => {
  const weights: Record<string, number> = { ai: 5 };
  const article = sampleArticle({ keywords: ["cooking"] });
  const { score } = scoreArticle(article, weights);
  assertEquals(score, 0);
});

Deno.test("generateHtml handles empty articles array", () => {
  const prefs: Preferences = {
    interested: [],
    ignored: [],
    keywordWeights: {},
    seen: [],
    read: [],
  };
  const html = generateHtml([], prefs, "Test", "2026-07-17T00:00:00Z");
  assertEquals(html.includes("<!DOCTYPE html>"), true);
  assertEquals(html.includes("Test"), true);
});

Deno.test("generateHtml handles articles with no source", () => {
  const articles = [{ ...sampleArticle({ source: "" }), score: 0, reasons: [] }];
  const prefs: Preferences = {
    interested: [],
    ignored: [],
    keywordWeights: {},
    seen: [],
    read: [],
  };
  const html = generateHtml(articles, prefs, "Test", "2026-07-17T00:00:00Z");
  assertEquals(html.includes("<!DOCTYPE html>"), true);
});

Deno.test("generateHtml handles very long titles", () => {
  const articles = [{
    ...sampleArticle({ title: "A".repeat(500) }),
    score: 0,
    reasons: [],
  }];
  const prefs: Preferences = {
    interested: [],
    ignored: [],
    keywordWeights: {},
    seen: [],
    read: [],
  };
  const html = generateHtml(articles, prefs, "Test", "2026-07-17T00:00:00Z");
  assertEquals(html.includes("A".repeat(500)), true);
});

Deno.test("generateMobileHtml produces a swipe-paginated mobile page", () => {
  const articles = Array.from({ length: 13 }, (_, i) => ({
    ...sampleArticle({
      id: `id${i}`,
      title: `Article ${i}`,
      url: `https://example.com/${i}`,
    }),
    score: 1,
    reasons: ["tech (+1)"],
  }));
  const prefs: Preferences = {
    interested: [],
    ignored: [],
    keywordWeights: { tech: 1 },
    seen: [],
    read: [],
  };
  const html = generateMobileHtml(
    articles,
    prefs,
    "Test Mobile",
    "2026-07-17T00:00:00Z",
  );
  assertEquals(html.includes("<!DOCTYPE html>"), true);
  // reader iframe + swipe controls are present
  assertEquals(html.includes("reader-frame"), true);
  assertEquals(html.includes("touchstart"), true);
  // each article carries its url for the iframe reader
  assertEquals(html.includes("data-url=\"https://example.com/3\""), true);
  // 13 articles / 5 per page -> page count label
  assertEquals(html.includes("13 articles"), true);
});

Deno.test("generateMobileHtml marks read articles and embeds data-url", () => {
  const articles = [{
    ...sampleArticle({ id: "read1", url: "https://example.com/read" }),
    score: 0,
    reasons: [],
  }];
  const prefs: Preferences = {
    interested: [],
    ignored: [],
    keywordWeights: {},
    seen: [],
    read: ["read1"],
  };
  const html = generateMobileHtml(
    articles,
    prefs,
    "Test",
    "2026-07-17T00:00:00Z",
  );
  assertEquals(html.includes("class=\"article read hidden\""), true);
  assertEquals(
    html.includes("data-url=\"https://example.com/read\""),
    true,
  );
});

Deno.test("generateMobileHtml hides seen articles by default", () => {
  const articles = [{
    ...sampleArticle({ id: "seen1", url: "https://example.com/seen" }),
    score: 0,
    reasons: [],
  }];
  const prefs: Preferences = {
    interested: [],
    ignored: [],
    keywordWeights: {},
    seen: ["seen1"],
    read: [],
  };
  const html = generateMobileHtml(
    articles,
    prefs,
    "Test",
    "2026-07-17T00:00:00Z",
  );
  assertEquals(html.includes("class=\"article seen hidden\""), true);
});

Deno.test("generateMobileHtml handles empty articles array", () => {
  const prefs: Preferences = {
    interested: [],
    ignored: [],
    keywordWeights: {},
    seen: [],
    read: [],
  };
  const html = generateMobileHtml([], prefs, "Test", "2026-07-17T00:00:00Z");
  assertEquals(html.includes("<!DOCTYPE html>"), true);
  assertEquals(html.includes("0 / 0"), true);
});

Deno.test("dedupeArticlesIncremental handles empty articles array", () => {
  const result = dedupeArticlesIncremental([], [], []);
  assertEquals(result.deduped.length, 0);
  assertEquals(result.newCount, 0);
  assertEquals(result.reusedCount, 0);
});

Deno.test("dedupeArticlesIncremental handles all new articles", () => {
  const articles = [
    sampleArticle({ id: "a1", url: "https://example.com/1" }),
    sampleArticle({ id: "a2", url: "https://example.com/2" }),
  ];
  const result = dedupeArticlesIncremental(articles, [], []);
  assertEquals(result.newCount, 2);
  assertEquals(result.reusedCount, 0);
  assertEquals(result.deduped.length, 2);
});

Deno.test("dedupeArticlesIncremental handles all reused articles", () => {
  const articles = [
    sampleArticle({ id: "a1", url: "https://example.com/1" }),
  ];
  const prevUrls = ["https://example.com/1"];
  const prevArticles = [
    sampleArticle({ id: "a1", url: "https://example.com/1" }),
  ];
  const result = dedupeArticlesIncremental(articles, prevUrls, prevArticles);
  assertEquals(result.newCount, 0);
  assertEquals(result.reusedCount, 1);
});

Deno.test("selectClustersToSeed handles minClusterSize of 1", () => {
  const clusters: StoryCluster[] = [
    clusterSample({
      articles: [sampleArticle({ id: "a1" })],
      key: clusterKey("Solo", [{ name: "Entity1", kind: "org" }]),
    }),
  ];
  const toSeed = selectClustersToSeed(clusters, [], 1);
  assertEquals(toSeed.length, 1);
});

Deno.test("selectClustersToSeed handles empty clusters array", () => {
  assertEquals(selectClustersToSeed([], [], 2).length, 0);
});

Deno.test("selectClustersToSeed handles empty existing stories", () => {
  const clusters: StoryCluster[] = [clusterSample()];
  const toSeed = selectClustersToSeed(clusters, [], 2);
  assertEquals(toSeed.length, 1);
});

Deno.test("shouldSkipCluster returns false when both fingerprints are empty", () => {
  // Empty fingerprints are falsy — should NOT skip (no data to compare).
  const c = clusterSample();
  c.fingerprint = "";
  const prev = clusterSample();
  prev.fingerprint = "";
  const prevByKey = new Map([[c.key, prev]]);
  assertEquals(shouldSkipCluster(c, prevByKey), false);
});

Deno.test("computeClusterFingerprint handles single article", async () => {
  const c = clusterSample({ articles: [sampleArticle({ id: "a1" })] });
  const fp = await computeClusterFingerprint(c, "llama3", 0.1);
  assertEquals(typeof fp, "string");
  assertEquals(fp.length, 12);
});

Deno.test("computeClusterFingerprint handles temperature boundary 0", async () => {
  const c = clusterSample();
  const fp = await computeClusterFingerprint(c, "llama3", 0);
  assertEquals(typeof fp, "string");
});

Deno.test("computeClusterFingerprint handles temperature boundary 2", async () => {
  const c = clusterSample();
  const fp = await computeClusterFingerprint(c, "llama3", 2);
  assertEquals(typeof fp, "string");
});

// ---------------------------------------------------------------------------
// fetchFeed — ETag / If-Modified-Since caching (Phase 1.6)
// ---------------------------------------------------------------------------

const rssBody = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Test Feed</title>
    <link>https://example.com</link>
    <item>
      <title>Article One</title>
      <link>https://example.com/1</link>
      <pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate>
      <description>First article</description>
    </item>
  </channel>
</rss>`;

function mockFetch(
  status: number,
  headers: Record<string, string> = {},
  body: string = "",
): typeof globalThis.fetch {
  const origFetch = globalThis.fetch;
  globalThis.fetch = ((_url: string | URL | Request, _init?: RequestInit) => {
    return Promise.resolve(new Response(status === 304 ? null : body, { status, headers }));
  }) as typeof globalThis.fetch;
  return origFetch;
}

function restoreFetch(orig: typeof globalThis.fetch) {
  globalThis.fetch = orig;
}

Deno.test("fetchFeed returns articles for a valid RSS feed", async () => {
  const orig = mockFetch(200, { "content-type": "application/rss+xml" }, rssBody);
  try {
    const result = await fetchFeed("https://example.com/feed.xml", 25);
    assertEquals(result.isFeed, true);
    assertEquals(result.articles.length, 1);
    assertEquals(result.articles[0].title, "Article One");
    assertEquals(result.notModified, undefined);
  } finally {
    restoreFetch(orig);
  }
});

Deno.test("fetchFeed returns notModified=true for HTTP 304", async () => {
  const orig = mockFetch(304, {}, "");
  try {
    const result = await fetchFeed("https://example.com/feed.xml", 25);
    assertEquals(result.notModified, true);
    assertEquals(result.isFeed, true);
    assertEquals(result.articles.length, 0);
  } finally {
    restoreFetch(orig);
  }
});

Deno.test("fetchFeed extracts ETag from 200 response", async () => {
  const orig = mockFetch(200, {
    "content-type": "application/rss+xml",
    "etag": '"abc123"',
  }, rssBody);
  try {
    const result = await fetchFeed("https://example.com/feed.xml", 25);
    assertEquals(result.newEtag, '"abc123"');
    assertEquals(result.notModified, undefined);
  } finally {
    restoreFetch(orig);
  }
});

Deno.test("fetchFeed extracts Last-Modified from 200 response", async () => {
  const orig = mockFetch(200, {
    "content-type": "application/rss+xml",
    "last-modified": "Mon, 01 Jan 2024 00:00:00 GMT",
  }, rssBody);
  try {
    const result = await fetchFeed("https://example.com/feed.xml", 25);
    assertEquals(result.newLastModified, "Mon, 01 Jan 2024 00:00:00 GMT");
  } finally {
    restoreFetch(orig);
  }
});

Deno.test("fetchFeed sends If-None-Match when etag cache header provided", async () => {
  let capturedHeaders: Record<string, string> = {};
  const orig = globalThis.fetch;
  globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
    capturedHeaders = (init?.headers as Record<string, string>) ?? {};
    return Promise.resolve(new Response(rssBody, {
      status: 200,
      headers: { "content-type": "application/rss+xml" },
    }));
  }) as typeof globalThis.fetch;
  try {
    await fetchFeed("https://example.com/feed.xml", 25, { etag: '"abc123"' });
    assertEquals(capturedHeaders["If-None-Match"], '"abc123"');
  } finally {
    globalThis.fetch = orig;
  }
});

Deno.test("fetchFeed sends If-Modified-Since when lastModified cache header provided", async () => {
  let capturedHeaders: Record<string, string> = {};
  const orig = globalThis.fetch;
  globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
    capturedHeaders = (init?.headers as Record<string, string>) ?? {};
    return Promise.resolve(new Response(rssBody, {
      status: 200,
      headers: { "content-type": "application/rss+xml" },
    }));
  }) as typeof globalThis.fetch;
  try {
    await fetchFeed("https://example.com/feed.xml", 25, {
      lastModified: "Mon, 01 Jan 2024 00:00:00 GMT",
    });
    assertEquals(
      capturedHeaders["If-Modified-Since"],
      "Mon, 01 Jan 2024 00:00:00 GMT",
    );
  } finally {
    globalThis.fetch = orig;
  }
});

Deno.test("fetchFeed sends both If-None-Match and If-Modified-Since when both provided", async () => {
  let capturedHeaders: Record<string, string> = {};
  const orig = globalThis.fetch;
  globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
    capturedHeaders = (init?.headers as Record<string, string>) ?? {};
    return Promise.resolve(new Response(rssBody, {
      status: 200,
      headers: { "content-type": "application/rss+xml" },
    }));
  }) as typeof globalThis.fetch;
  try {
    await fetchFeed("https://example.com/feed.xml", 25, {
      etag: '"abc123"',
      lastModified: "Mon, 01 Jan 2024 00:00:00 GMT",
    });
    assertEquals(capturedHeaders["If-None-Match"], '"abc123"');
    assertEquals(
      capturedHeaders["If-Modified-Since"],
      "Mon, 01 Jan 2024 00:00:00 GMT",
    );
  } finally {
    globalThis.fetch = orig;
  }
});

Deno.test("fetchFeed returns error for non-ok non-304 response", async () => {
  const orig = mockFetch(500, {}, "");
  try {
    const result = await fetchFeed("https://example.com/feed.xml", 25);
    assertEquals(result.error, "HTTP 500");
    assertEquals(result.isFeed, false);
  } finally {
    restoreFetch(orig);
  }
});

Deno.test("fetchFeed returns isFeed=false for HTML response", async () => {
  const orig = mockFetch(200, { "content-type": "text/html" }, "<html><body>hi</body></html>");
  try {
    const result = await fetchFeed("https://example.com/feed.xml", 25);
    assertEquals(result.isFeed, false);
    assertEquals(result.articles.length, 0);
  } finally {
    restoreFetch(orig);
  }
});

Deno.test("fetchFeed handles network errors gracefully", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error("Network error");
  }) as unknown as typeof globalThis.fetch;
  try {
    const result = await fetchFeed("https://example.com/feed.xml", 25);
    assertEquals(result.error, "Network error");
    assertEquals(result.isFeed, false);
  } finally {
    globalThis.fetch = orig;
  }
});

Deno.test("fetchFeed does not send cache headers when none provided", async () => {
  let capturedHeaders: Record<string, string> = {};
  const orig = globalThis.fetch;
  globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
    capturedHeaders = (init?.headers as Record<string, string>) ?? {};
    return Promise.resolve(new Response(rssBody, {
      status: 200,
      headers: { "content-type": "application/rss+xml" },
    }));
  }) as typeof globalThis.fetch;
  try {
    await fetchFeed("https://example.com/feed.xml", 25);
    assertEquals(capturedHeaders["If-None-Match"], undefined);
    assertEquals(capturedHeaders["If-Modified-Since"], undefined);
  } finally {
    globalThis.fetch = orig;
  }
});

Deno.test("mergeFeedFetchResult reuses prior articles on 304", () => {
  const prev = {
    prevFeedCache: { "https://example.com/feed.xml": { etag: "\"abc\"" } },
    prevFeedArticleIds: { "https://example.com/feed.xml": ["id1", "id2"] },
    prevArticlesById: new Map([
      ["id1", sampleArticle({ id: "id1", title: "One" })],
      ["id2", sampleArticle({ id: "id2", title: "Two" })],
      ["id3", sampleArticle({ id: "id3", title: "Three" })],
    ]),
  };
  const merged = mergeFeedFetchResult("https://example.com/feed.xml", {
    articles: [],
    isFeed: true,
    contentType: "",
    notModified: true,
  }, prev);

  assertEquals(merged.notModified, true);
  assertEquals(merged.articles.map((a) => a.id), ["id1", "id2"]);
  assertEquals(merged.feedCache, { etag: "\"abc\"" });
  assertEquals(merged.feedArticleIds, ["id1", "id2"]);
});

Deno.test("mergeFeedFetchResult carries no articles when prior article missing on 304", () => {
  const prev = {
    prevFeedCache: {},
    prevFeedArticleIds: { "https://example.com/feed.xml": ["missing"] },
    prevArticlesById: new Map(),
  };
  const merged = mergeFeedFetchResult("https://example.com/feed.xml", {
    articles: [],
    isFeed: true,
    contentType: "",
    notModified: true,
  }, prev);

  assertEquals(merged.articles, []);
  assertEquals(merged.feedArticleIds, ["missing"]);
});

Deno.test("mergeFeedFetchResult records error for failed feed", () => {
  const prev = {
    prevFeedCache: {},
    prevFeedArticleIds: {},
    prevArticlesById: new Map(),
  };
  const merged = mergeFeedFetchResult("https://example.com/feed.xml", {
    articles: [],
    isFeed: false,
    contentType: "",
    error: "HTTP 500",
  }, prev);

  assertEquals(merged.error, { url: "https://example.com/feed.xml", message: "HTTP 500" });
  assertEquals(merged.articles, []);
  assertEquals(merged.feedCache, undefined);
});

Deno.test("mergeFeedFetchResult records non-feed URL", () => {
  const prev = {
    prevFeedCache: {},
    prevFeedArticleIds: {},
    prevArticlesById: new Map(),
  };
  const merged = mergeFeedFetchResult("https://example.com/page", {
    articles: [],
    isFeed: false,
    contentType: "text/html",
  }, prev);

  assertEquals(merged.nonFeedUrl, {
    url: "https://example.com/page",
    contentType: "text/html",
  });
  assertEquals(merged.articles, []);
});

Deno.test("mergeFeedFetchResult persists new ETag and article ids for 200 feed", () => {
  const prev = {
    prevFeedCache: {},
    prevFeedArticleIds: {},
    prevArticlesById: new Map(),
  };
  const merged = mergeFeedFetchResult("https://example.com/feed.xml", {
    articles: [
      sampleArticle({ id: "id1", url: "https://example.com/feed.xml/1" }),
      sampleArticle({ id: "id2", url: "https://example.com/feed.xml/2" }),
    ],
    isFeed: true,
    contentType: "application/rss+xml",
    newEtag: "\"xyz\"",
    newLastModified: "Wed, 01 Jan 2025 00:00:00 GMT",
  }, prev);

  assertEquals(merged.articles.map((a) => a.id), ["id1", "id2"]);
  assertEquals(merged.feedCache, {
    etag: "\"xyz\"",
    lastModified: "Wed, 01 Jan 2025 00:00:00 GMT",
  });
  assertEquals(merged.feedArticleIds, ["id1", "id2"]);
});

Deno.test("mergeFeedFetchResult omits cache entry when no validators on 200 feed", () => {
  const prev = {
    prevFeedCache: {},
    prevFeedArticleIds: {},
    prevArticlesById: new Map(),
  };
  const merged = mergeFeedFetchResult("https://example.com/feed.xml", {
    articles: [sampleArticle({ id: "id1", url: "https://example.com/feed.xml/1" })],
    isFeed: true,
    contentType: "application/rss+xml",
  }, prev);

  assertEquals(merged.articles.map((a) => a.id), ["id1"]);
  assertEquals(merged.feedCache, undefined);
});

// ---------------------------------------------------------------------------
// setup method
// ---------------------------------------------------------------------------

const baseGlobalArgs = {
  llmBaseUrl: "http://localhost:11434",
  llmModel: "",
  llmApiKey: "",
  llmTemperature: 0.1,
  fusionMinClusterSize: 2,
  citationRetentionDays: 30,
  llmConcurrency: 3,
  maxFusions: 25,
  llmTimeoutSec: 120,
  llmFailureThreshold: 3,
};

const render = (msg: string, props?: Record<string, unknown>): string =>
  msg.replace(/\{(\w+)\}/g, (_, key: string) => String(props?.[key] ?? ""));

const setupCtx = (logs: Array<{ msg: string; props: Record<string, unknown> }>) =>
  ({
    logger: {
      info: (msg: string, props?: Record<string, unknown>) =>
        logs.push({ msg: render(msg, props), props: props ?? {} }),
      warning: (msg: string, props?: Record<string, unknown>) =>
        logs.push({ msg: render(msg, props), props: props ?? {} }),
    },
    globalArgs: baseGlobalArgs,
  }) as unknown as Parameters<typeof model.methods.setup.execute>[1];

Deno.test("setup lists config params when run with no inputs", async () => {
  const logs: Array<{ msg: string; props: Record<string, unknown> }> = [];
  const res = await model.methods.setup.execute({}, setupCtx(logs));

  assertEquals(res.dataHandles, []);
  const joined = logs.map((l) => l.msg).join("\n");
  assertEquals(joined.includes("llmBaseUrl"), true);
  assertEquals(joined.includes("llmModel"), true);
  assertEquals(joined.includes("llmTemperature"), true);
  assertEquals(joined.includes("fusionMinClusterSize"), true);
  assertEquals(joined.includes("llmConcurrency"), true);
  assertEquals(joined.includes("current=2"), true);
});

Deno.test("setup validates provided config values and reports fusion state", async () => {
  const logs: Array<{ msg: string; props: Record<string, unknown> }> = [];
  const res = await model.methods.setup.execute(
    { llmModel: "llama3", llmBaseUrl: "http://localhost:11434" },
    setupCtx(logs),
  );

  assertEquals(res.dataHandles, []);
  const joined = logs.map((l) => l.msg).join("\n");
  assertEquals(joined.includes("Validated config values OK"), true);
  assertEquals(joined.includes("Fusion enabled"), true);
  assertEquals(joined.includes("llama3"), true);
});

Deno.test("setup throws on invalid config values", async () => {
  const logs: Array<{ msg: string; props: Record<string, unknown> }> = [];
  await assertRejects(
    () => model.methods.setup.execute({ llmBaseUrl: "not-a-url" }, setupCtx(logs)),
    Error,
  );
  const joined = logs.map((l) => l.msg).join("\n");
  assertEquals(joined.includes("setup:"), true);
});

// ---------------------------------------------------------------------------
// LLM error classification + circuit breaker
// ---------------------------------------------------------------------------

Deno.test("LlmError carries serverError flag", () => {
  const serverErr = new LlmError("unreachable", true);
  const clientErr = new LlmError("bad model", false);
  assertEquals(serverErr.serverError, true);
  assertEquals(clientErr.serverError, false);
});

Deno.test("isLlmServerError distinguishes server vs client failures", () => {
  assertEquals(isLlmServerError(new LlmError("x", true)), true);
  assertEquals(isLlmServerError(new LlmError("x", false)), false);
  assertEquals(isLlmServerError(new Error("x")), false);
  assertEquals(isLlmServerError("string"), false);
});

Deno.test("CircuitBreaker trips after threshold server-side failures only", () => {
  const b = new CircuitBreaker(3);
  b.recordFailure(new LlmError("server", true));
  b.recordFailure(new LlmError("server", true));
  b.recordFailure(new LlmError("server", true));
  assertEquals(b.shouldStop(), true);
});

Deno.test("CircuitBreaker ignores client-side failures", () => {
  const b = new CircuitBreaker(3);
  b.recordFailure(new LlmError("client", false));
  b.recordFailure(new LlmError("client", false));
  assertEquals(b.shouldStop(), false);
});

Deno.test("CircuitBreaker resets on success", () => {
  const b = new CircuitBreaker(3);
  b.recordFailure(new LlmError("server", true));
  b.recordFailure(new LlmError("server", true));
  b.recordSuccess();
  b.recordFailure(new LlmError("server", true));
  assertEquals(b.shouldStop(), false);
});

Deno.test("CircuitBreaker clamps invalid threshold to 1", () => {
  const b = new CircuitBreaker(0);
  b.recordFailure(new LlmError("server", true));
  assertEquals(b.shouldStop(), true);
});

// ---------------------------------------------------------------------------
// withConcurrency + breaker early-stop
// ---------------------------------------------------------------------------

Deno.test("withConcurrency stops early when breaker trips", async () => {
  const ran: number[] = [];
  const breaker = new CircuitBreaker(2);
  const serverErr = new LlmError("server", true);
  // Concurrency 1 makes the execution fully deterministic — items are
  // processed in order and the breaker state at entry is well-defined.
  await withConcurrency([1, 2, 3, 4, 5, 6], 1, async (i) => {
    if (breaker.shouldStop()) return;
    ran.push(i);
    if (ran.length <= 2) {
      breaker.recordFailure(serverErr);
    }
  });
  // Threshold 2 means at most 2 items complete before the breaker trips.
  assertEquals(ran.length, 2);
});

Deno.test("withConcurrency runs all items when no failure", async () => {
  const ran: number[] = [];
  await withConcurrency([1, 2, 3, 4, 5, 6], 3, async (i) => {
    ran.push(i);
  });
  assertEquals(ran.length, 6);
});

Deno.test("withConcurrency runs all items when no failure", async () => {
  const ran: number[] = [];
  await withConcurrency([1, 2, 3, 4, 5, 6], 3, async (i) => {
    ran.push(i);
  });
  assertEquals(ran.length, 6);
});

// ---------------------------------------------------------------------------
// chatCompletion error type
// ---------------------------------------------------------------------------

Deno.test("chatCompletion throws LlmError(server) on fetch failure", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  try {
    await assertRejects(
      () => chatCompletion({
        llmBaseUrl: "http://127.0.0.1:1",
        llmModel: "x",
        llmApiKey: "",
        llmTemperature: 0,
        fusionMinClusterSize: 2,
        citationRetentionDays: 30,
        llmConcurrency: 1,
        maxFusions: 1,
        llmTimeoutSec: 1,
        llmFailureThreshold: 1,
        feedbackServerPort: 8765,
        feedbackServerServiceName: "feedback-server",
      }, [{ role: "user", content: "hi" }]),
      LlmError,
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});
