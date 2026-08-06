import { assertEquals } from "jsr:@std/assert@1";

import {
  extractDomain,
  extractFeedLinks,
  isFeedContent,
  siteRoot,
  type DiscoveredFeed,
} from "./feed_analysis.ts";

Deno.test("extractDomain returns hostname without www", () => {
  assertEquals(extractDomain("https://www.bbc.co.uk/news/tech"), "bbc.co.uk");
  assertEquals(extractDomain("http://example.com/feed.xml"), "example.com");
  assertEquals(extractDomain("https://hnrss.org/frontpage"), "hnrss.org");
  assertEquals(extractDomain("not-a-url"), "");
});

Deno.test("siteRoot returns scheme + host", () => {
  assertEquals(siteRoot("https://www.bbc.co.uk/news/tech"), "https://www.bbc.co.uk");
  assertEquals(siteRoot("http://example.com/path"), "http://example.com");
  assertEquals(siteRoot("not-a-url"), "");
});

Deno.test("isFeedContent detects RSS XML by content-type", () => {
  assertEquals(isFeedContent("application/rss+xml", "<rss></rss>"), true);
});

Deno.test("isFeedContent detects Atom by body markers", () => {
  assertEquals(isFeedContent("", "<?xml version=\"1.0\"?><feed>"), true);
});

Deno.test("isFeedContent detects JSON Feed by markers", () => {
  assertEquals(
    isFeedContent("", "{ \"version\": \"https://jsonfeed.org/version/1\", \"items\": [] }"),
    true,
  );
});

Deno.test("isFeedContent rejects plain HTML", () => {
  assertEquals(isFeedContent("text/html", "<html><body>Hello</body></html>"), false);
});

Deno.test("extractFeedLinks finds link rel=alternate RSS tags", () => {
  const html =
    `<html><head>` +
    `<link rel="alternate" type="application/rss+xml" href="/feed.xml" title="Main Feed">` +
    `</head><body>content</body></html>`;
  const feeds = extractFeedLinks(html, "https://example.com/article");
  assertEquals(feeds.length, 1);
  assertEquals(feeds[0].url, "https://example.com/feed.xml");
  assertEquals(feeds[0].type, "rss");
  assertEquals(feeds[0].title, "Main Feed");
  assertEquals(feeds[0].sourceSite, "https://example.com");
});

Deno.test("extractFeedLinks finds link rel=alternate Atom tags", () => {
  const html =
    `<link rel="alternate" type="application/atom+xml" href="/atom.xml">`;
  const feeds = extractFeedLinks(html, "https://example.com/page");
  assertEquals(feeds[0].type, "atom");
  assertEquals(feeds[0].url, "https://example.com/atom.xml");
});

Deno.test("extractFeedLinks finds anchor links to feed paths", () => {
  const html = `<a href="/rss">Subscribe via RSS</a>`;
  const feeds = extractFeedLinks(html, "https://example.com/page");
  assertEquals(feeds.length, 1);
  assertEquals(feeds[0].url, "https://example.com/rss");
});

Deno.test("extractFeedLinks deduplicates by URL", () => {
  const html =
    `<link rel="alternate" type="application/rss+xml" href="/feed.xml">` +
    `<a href="/feed.xml">RSS</a>`;
  const feeds = extractFeedLinks(html, "https://example.com/page");
  assertEquals(feeds.length, 1);
});

Deno.test("extractFeedLinks handles relative hrefs against source URL", () => {
  const feeds = extractFeedLinks(
    `<link rel="alternate" type="application/rss+xml" href="/feed">`,
    "https://blog.example.com/post",
  );
  assertEquals(feeds[0].url, "https://blog.example.com/feed");
});

Deno.test("extractFeedLinks ignores pages with no feed links", () => {
  const feeds = extractFeedLinks(
    `<html><body>Just content</body></html>`,
    "https://example.com/page",
  );
  assertEquals(feeds.length, 0);
});
