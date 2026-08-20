import { assertEquals } from "jsr:@std/assert@1";

import {
  type DiscoveredFeed,
  extractDomain,
  extractFeedLinks,
  isFeedContent,
  normalizePages,
  siteRoot,
} from "./feed_analysis.ts";

// ---------------------------------------------------------------------------
// extractDomain
// ---------------------------------------------------------------------------

Deno.test("extractDomain extracts hostname from URL", () => {
  assertEquals(extractDomain("https://example.com/path"), "example.com");
});

Deno.test("extractDomain strips www prefix", () => {
  assertEquals(extractDomain("https://www.example.com"), "example.com");
});

Deno.test("extractDomain handles URL with subdomain", () => {
  assertEquals(extractDomain("https://blog.example.com/post"), "blog.example.com");
});

Deno.test("extractDomain handles invalid URL", () => {
  assertEquals(extractDomain("not-a-url"), "");
});

Deno.test("extractDomain handles empty string", () => {
  assertEquals(extractDomain(""), "");
});

// ---------------------------------------------------------------------------
// siteRoot
// ---------------------------------------------------------------------------

Deno.test("siteRoot returns scheme and host", () => {
  assertEquals(siteRoot("https://example.com/path/to/page"), "https://example.com");
});

Deno.test("siteRoot preserves port", () => {
  assertEquals(siteRoot("http://localhost:8080/path"), "http://localhost:8080");
});

Deno.test("siteRoot handles invalid URL", () => {
  assertEquals(siteRoot("not-a-url"), "");
});

Deno.test("siteRoot handles empty string", () => {
  assertEquals(siteRoot(""), "");
});

// ---------------------------------------------------------------------------
// isFeedContent
// ---------------------------------------------------------------------------

Deno.test("isFeedContent detects RSS by content-type", () => {
  assertEquals(isFeedContent("application/rss+xml", ""), true);
});

Deno.test("isFeedContent detects Atom by content-type", () => {
  assertEquals(isFeedContent("application/atom+xml", ""), true);
});

Deno.test("isFeedContent detects JSON feed by content-type", () => {
  assertEquals(isFeedContent("application/feed+json", ""), true);
});

Deno.test("isFeedContent detects text/xml by content-type", () => {
  assertEquals(isFeedContent("text/xml", ""), true);
});

Deno.test("isFeedContent detects application/xml by content-type", () => {
  assertEquals(isFeedContent("application/xml", ""), true);
});

Deno.test("isFeedContent detects RSS by body markers", () => {
  assertEquals(isFeedContent("text/plain", '<?xml version="1.0"?><rss version="2.0"><channel>'), true);
});

Deno.test("isFeedContent detects Atom by body markers", () => {
  assertEquals(isFeedContent("text/plain", '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">'), true);
});

Deno.test("isFeedContent detects JSON feed by body markers", () => {
  assertEquals(isFeedContent("text/plain", '{"version":"https://jsonfeed.org/version/1.1","items":[]}'), true);
});

Deno.test("isFeedContent detects RDF/RSS by body markers", () => {
  assertEquals(isFeedContent("text/plain", '<?xml version="1.0"?><rdf:RDF xmlns="..."><channel>'), true);
});

Deno.test("isFeedContent rejects non-XML/non-JSON body", () => {
  assertEquals(isFeedContent("text/plain", "just some text"), false);
});

Deno.test("isFeedContent rejects HTML body", () => {
  assertEquals(isFeedContent("text/plain", "<!doctype html><html><head><title>Page</title>"), false);
});

// ---------------------------------------------------------------------------
// extractFeedLinks
// ---------------------------------------------------------------------------

Deno.test("extractFeedLinks finds <link rel=alternate> RSS feeds", () => {
  const html = `<html><head><link rel="alternate" type="application/rss+xml" href="/feed.xml" title="RSS Feed"/></head></html>`;
  const feeds = extractFeedLinks(html, "https://example.com");
  assertEquals(feeds.length, 1);
  assertEquals(feeds[0].url, "https://example.com/feed.xml");
  assertEquals(feeds[0].type, "rss");
  assertEquals(feeds[0].title, "RSS Feed");
});

Deno.test("extractFeedLinks finds <link rel=alternate> Atom feeds", () => {
  const html = `<html><head><link rel="alternate" type="application/atom+xml" href="/atom.xml"/></head></html>`;
  const feeds = extractFeedLinks(html, "https://example.com");
  assertEquals(feeds.length, 1);
  assertEquals(feeds[0].type, "atom");
});

Deno.test("extractFeedLinks finds anchor tags with RSS in href", () => {
  const html = `<html><body><a href="/rss">Subscribe via RSS</a></body></html>`;
  const feeds = extractFeedLinks(html, "https://example.com");
  assertEquals(feeds.length, 1);
  assertEquals(feeds[0].url, "https://example.com/rss");
});

Deno.test("extractFeedLinks finds anchor tags with feed in text", () => {
  const html = `<html><body><a href="/news.xml">News Feed</a></body></html>`;
  const feeds = extractFeedLinks(html, "https://example.com");
  assertEquals(feeds.length, 1);
  assertEquals(feeds[0].url, "https://example.com/news.xml");
});

Deno.test("extractFeedLinks finds anchor tags with atom in href", () => {
  const html = `<html><body><a href="/atom.xml">Subscribe</a></body></html>`;
  const feeds = extractFeedLinks(html, "https://example.com");
  assertEquals(feeds.length, 1);
  assertEquals(feeds[0].type, "atom");
});

Deno.test("extractFeedLinks deduplicates by URL", () => {
  const html = `<html><head>
<link rel="alternate" type="application/rss+xml" href="/feed.xml"/>
</head><body>
<a href="/feed.xml">RSS Feed</a>
</body></html>`;
  const feeds = extractFeedLinks(html, "https://example.com");
  assertEquals(feeds.length, 1);
});

Deno.test("extractFeedLinks handles empty HTML", () => {
  assertEquals(extractFeedLinks("", "https://example.com").length, 0);
});

Deno.test("extractFeedLinks handles HTML with no feed links", () => {
  const html = `<html><head><title>No feeds</title></head><body><p>Hello</p></body></html>`;
  assertEquals(extractFeedLinks(html, "https://example.com").length, 0);
});

Deno.test("extractFeedLinks resolves relative URLs against site root", () => {
  const html = `<html><head><link rel="alternate" type="application/rss+xml" href="feed.xml"/></head></html>`;
  const feeds = extractFeedLinks(html, "https://example.com/blog/");
  // extractFeedLinks uses siteRoot() as the base, not the full source URL
  assertEquals(feeds[0].url, "https://example.com/feed.xml");
});

Deno.test("extractFeedLinks sets sourceSite to the site root", () => {
  const html = `<html><head><link rel="alternate" type="application/rss+xml" href="/feed.xml"/></head></html>`;
  const feeds = extractFeedLinks(html, "https://example.com/page");
  assertEquals(feeds[0].sourceSite, "https://example.com");
});

Deno.test("extractFeedLinks includes category field", () => {
  const html = `<html><head><link rel="alternate" type="application/rss+xml" href="/feed.xml"/></head></html>`;
  const feeds = extractFeedLinks(html, "https://example.com");
  assertEquals(feeds[0].category, "");
});

Deno.test("extractFeedLinks finds multiple feed links", () => {
  const html = `<html><head>
<link rel="alternate" type="application/rss+xml" href="/rss.xml"/>
<link rel="alternate" type="application/atom+xml" href="/atom.xml"/>
</head></html>`;
  const feeds = extractFeedLinks(html, "https://example.com");
  assertEquals(feeds.length, 2);
});

// ---------------------------------------------------------------------------
// normalizePages
// ---------------------------------------------------------------------------

Deno.test("normalizePages extracts {url,name,category} objects", () => {
  assertEquals(normalizePages([
    { url: "https://a.com", name: "A", category: "tech" },
  ]), [{ url: "https://a.com", name: "A", category: "tech" }]);
});

Deno.test("normalizePages coerces plain string URL entries", () => {
  assertEquals(normalizePages(["https://a.com"]), [
    { url: "https://a.com", name: "", category: "" },
  ]);
});

Deno.test("normalizePages tolerates missing name/category", () => {
  assertEquals(
    normalizePages([{ url: "https://a.com" }, { url: "https://b.com", name: "B" }]),
    [
      { url: "https://a.com", name: "", category: "" },
      { url: "https://b.com", name: "B", category: "" },
    ],
  );
});

Deno.test("normalizePages drops entries without a usable url", () => {
  assertEquals(normalizePages([{}, { name: "no-url" }, ""]), []);
});

Deno.test("normalizePages handles non-array and null input", () => {
  assertEquals(normalizePages(undefined), []);
  assertEquals(normalizePages(null), []);
  assertEquals(normalizePages("not-an-array"), []);
});
