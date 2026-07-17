import { assertEquals, assertExists } from "jsr:@std/assert@1";

import {
  type Article,
  computeKeywordWeights,
  extractKeywords,
  generateHtml,
  parseFeed,
  type Preferences,
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
