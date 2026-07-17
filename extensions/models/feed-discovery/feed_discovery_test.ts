import { assertEquals } from "jsr:@std/assert@1";

import {
  type DiscoveredFeed,
  extractDomain,
  extractFeedLinks,
  siteRoot,
} from "./feed_discovery.ts";

Deno.test("extractDomain returns hostname without www", () => {
  assertEquals(extractDomain("https://www.bbc.co.uk/news/tech"), "bbc.co.uk");
  assertEquals(extractDomain("http://example.com/feed.xml"), "example.com");
  assertEquals(extractDomain("https://hnrss.org/frontpage"), "hnrss.org");
  assertEquals(extractDomain("not-a-url"), "");
});

Deno.test("siteRoot returns scheme + host", () => {
  assertEquals(
    siteRoot("https://www.bbc.co.uk/news/tech"),
    "https://www.bbc.co.uk",
  );
  assertEquals(siteRoot("http://example.com/path"), "http://example.com");
  assertEquals(siteRoot("not-a-url"), "");
});

Deno.test("extractFeedLinks finds RSS <link> tags", () => {
  const html = `<html><head>
<link rel="alternate" type="application/rss+xml" href="/feed.xml" title="Main Feed">
<link rel="alternate" type="application/atom+xml" href="/atom.xml" title="Atom Feed">
</head><body>content</body></html>`;
  const feeds = extractFeedLinks(html, "https://example.com/article");
  assertEquals(feeds.length, 2);
  assertEquals(feeds[0].url, "https://example.com/feed.xml");
  assertEquals(feeds[0].type, "rss");
  assertEquals(feeds[1].url, "https://example.com/atom.xml");
  assertEquals(feeds[1].type, "atom");
});

Deno.test("extractFeedLinks resolves relative URLs", () => {
  const html =
    `<link rel="alternate" type="application/rss+xml" href="https://blog.example.com/rss" title="Blog">`;
  const feeds = extractFeedLinks(html, "https://example.com/article");
  assertEquals(feeds.length, 1);
  assertEquals(feeds[0].url, "https://blog.example.com/rss");
});

Deno.test("extractFeedLinks ignores non-feed link tags", () => {
  const html = `<head>
<link rel="stylesheet" href="/style.css">
<link rel="alternate" type="text/html" href="/mobile" title="Mobile">
<link rel="alternate" type="application/rss+xml" href="/feed.xml" title="RSS">
</head>`;
  const feeds = extractFeedLinks(html, "https://example.com/page");
  assertEquals(feeds.length, 1);
  assertEquals(feeds[0].url, "https://example.com/feed.xml");
});

Deno.test("extractFeedLinks finds <a> tags linking to feed paths", () => {
  const html = `<body>
<a href="/rss.xml">RSS Feed</a>
<a href="/about">About Us</a>
<a href="/feed/">Subscribe via RSS</a>
</body>`;
  const feeds = extractFeedLinks(html, "https://example.com/article");
  assertEquals(feeds.length, 2);
  assertEquals(feeds[0].url, "https://example.com/rss.xml");
  assertEquals(feeds[1].url, "https://example.com/feed/");
});

Deno.test("extractFeedLinks deduplicates feed URLs", () => {
  const html = `<head>
<link rel="alternate" type="application/rss+xml" href="/feed.xml" title="Feed">
</head><body>
<a href="/feed.xml">RSS Feed</a>
</body>`;
  const feeds = extractFeedLinks(html, "https://example.com/page");
  assertEquals(feeds.length, 1);
});

Deno.test("extractFeedLinks handles empty HTML", () => {
  const feeds = extractFeedLinks("", "https://example.com");
  assertEquals(feeds.length, 0);
});

Deno.test("extractFeedLinks handles malformed HTML gracefully", () => {
  const html = `<link rel="alternate" type="application/rss+xml"`;
  const feeds = extractFeedLinks(html, "https://example.com");
  assertEquals(feeds.length, 0);
});
