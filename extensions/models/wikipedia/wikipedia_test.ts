import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";

import {
  detectInfoboxName,
  extractContent,
  fnv1a,
  model,
  normalizeUrl,
  pagePropsUrl,
  pageUrl,
  parseInfoboxTemplate,
  parsePageProps,
  searchUrl,
  webCacheKey,
} from "./wikipedia.ts";

function makeContext(globals: Record<string, unknown> = {}) {
  const written: {
    specName: string;
    name: string;
    data: Record<string, unknown>;
  }[] = [];
  const context = {
    globalArgs: model.globalArguments.parse(globals),
    logger: {
      info: () => {},
      debug: () => {},
      warn: () => {},
      warning: () => {},
      error: () => {},
    },
    writeResource: (
      specName: string,
      name: string,
      data: Record<string, unknown>,
    ) => {
      written.push({ specName, name, data });
      return Promise.resolve({ name });
    },
  };
  return { context, written };
}

Deno.test("detectInfoboxName finds a writer infobox", () => {
  const wikitext = `{{short description|American science fiction author}}
{{Infobox writer
 | name = Alfred Bester
}}
`;
  assertEquals(detectInfoboxName(wikitext), "infobox writer");
});

Deno.test("detectInfoboxName is case-insensitive and underscore-tolerant", () => {
  assertEquals(detectInfoboxName("{{Infobox_Novelist |name=..."), "infobox novelist");
  assertEquals(detectInfoboxName("{{Infobox Person |name=..."), "infobox person");
});

Deno.test("parseInfoboxTemplate extracts key/value params", () => {
  const wikitext = `{{Infobox writer
 | name = Alfred Bester
 | birth_date = {{Birth date|1913|12|18}}
 | occupation = Novelist
 | notable_works = The Demolished Man
}}`;
  const parsed = parseInfoboxTemplate(wikitext);
  assertEquals(parsed._template, "infobox writer");
  assertEquals(parsed["name"], "Alfred Bester");
  assertEquals(parsed["birth_date"], "{{Birth date|1913|12|18}}");
  assertEquals(parsed["occupation"], "Novelist");
  assertEquals(parsed["notable_works"], "The Demolished Man");
});

// ---------------------------------------------------------------------------
// Shared cache-key helpers (must match @svendowideit/web-cache)
// ---------------------------------------------------------------------------

Deno.test("fnv1a matches the known vector", () => {
  assertEquals(fnv1a("hello"), "4f9f2cab");
});

Deno.test("normalizeUrl sorts params and lowercases host", () => {
  assertEquals(
    normalizeUrl("https://EN.wikipedia.ORG/x?b=2&a=1#frag"),
    "https://en.wikipedia.org/x?a=1&b=2",
  );
});

Deno.test("webCacheKey is stable and URL-only", () => {
  const a = webCacheKey("https://e.com/x?a=1&b=2");
  const b = webCacheKey("https://e.com/x?b=2&a=1");
  assertEquals(a, b);
  assertEquals(a.includes("http"), false);
});

// ---------------------------------------------------------------------------
// URL builders
// ---------------------------------------------------------------------------

Deno.test("pageUrl builds the wikitext URL", () => {
  const { context } = makeContext();
  const url = pageUrl(context, "Alfred Bester", "wikitext");
  assertStringIncludes(url, "action=parse");
  assertStringIncludes(url, "prop=wikitext");
  assertStringIncludes(url, "page=Alfred+Bester");
  assertStringIncludes(url, "formatversion=2");
});

Deno.test("pageUrl builds the html URL", () => {
  const { context } = makeContext();
  assertStringIncludes(pageUrl(context, "X", "html"), "prop=text");
});

Deno.test("pageUrl uses REST for parsoid and summary", () => {
  const { context } = makeContext();
  assertEquals(
    pageUrl(context, "Alfred Bester", "parsoid"),
    "https://en.wikipedia.org/api/rest_v1/page/Alfred%20Bester/html",
  );
  assertEquals(
    pageUrl(context, "Alfred Bester", "summary"),
    "https://en.wikipedia.org/api/rest_v1/page/summary/Alfred%20Bester",
  );
});

Deno.test("pageUrl builds the json page-props URL", () => {
  const { context } = makeContext();
  const url = pageUrl(context, "X", "json");
  assertStringIncludes(url, "action=query");
  assertStringIncludes(url, "prop=info%7Cpageprops");
  assertStringIncludes(url, "redirects=1");
});

Deno.test("searchUrl builds an opensearch URL", () => {
  const { context } = makeContext();
  const url = searchUrl(context, "Alfred Bester", 5);
  assertStringIncludes(url, "action=opensearch");
  assertStringIncludes(url, "search=Alfred+Bester");
  assertStringIncludes(url, "limit=5");
});

Deno.test("pagePropsUrl joins titles with a pipe", () => {
  const { context } = makeContext();
  const url = pagePropsUrl(context, ["A", "B", "C"]);
  assertStringIncludes(url, "action=query");
  assertStringIncludes(url, "prop=info%7Cpageprops");
  assertStringIncludes(url, "titles=A%7CB%7CC");
});

// ---------------------------------------------------------------------------
// extractContent format branches
// ---------------------------------------------------------------------------

Deno.test("extractContent pulls wikitext from formatversion=2", () => {
  assertEquals(
    extractContent("wikitext", { parse: { wikitext: "hello" } }),
    "hello",
  );
});

Deno.test("extractContent pulls wikitext from formatversion=1", () => {
  assertEquals(
    extractContent("wikitext", { parse: { wikitext: { "*": "hello" } } }),
    "hello",
  );
});

Deno.test("extractContent pulls html from text (both versions)", () => {
  assertEquals(extractContent("html", { parse: { text: "<p>hi</p>" } }), "<p>hi</p>");
  assertEquals(
    extractContent("html", { parse: { text: { "*": "<p>hi</p>" } } }),
    "<p>hi</p>",
  );
});

Deno.test("extractContent stringifies json", () => {
  assertEquals(extractContent("json", { a: 1 }), JSON.stringify({ a: 1 }, null, 2));
});

Deno.test("extractContent passes through parsoid/summary strings", () => {
  assertEquals(extractContent("parsoid", "<html></html>"), "<html></html>");
  assertEquals(extractContent("summary", "{}"), "{}");
});

Deno.test("extractContent returns null for missing/malformed content", () => {
  assertEquals(extractContent("wikitext", {}), null);
  assertEquals(extractContent("html", null), null);
});

// ---------------------------------------------------------------------------
// parsePageProps
// ---------------------------------------------------------------------------

Deno.test("parsePageProps maps pages and follows redirects", () => {
  const body = JSON.stringify({
    query: {
      redirects: [{ from: "Alfred Bester (writer)", to: "Alfred Bester" }],
      pages: {
        "1": {
          title: "Alfred Bester (writer)",
          canonicalurl: "https://en.wikipedia.org/wiki/Alfred_Bester",
          pageprops: {
            "wikibase-shortdesc": "American writer",
            "wikibase_item": "Q286116",
          },
        },
      },
    },
  });
  const pages = parsePageProps(body);
  assertEquals(Object.keys(pages), ["Alfred Bester"]);
  assertEquals(pages["Alfred Bester"]!.wikidataId, "Q286116");
  assertEquals(pages["Alfred Bester"]!.shortdesc, "American writer");
  assertEquals(
    pages["Alfred Bester"]!.url,
    "https://en.wikipedia.org/wiki/Alfred_Bester",
  );
});

Deno.test("parsePageProps returns empty for null/malformed body", () => {
  assertEquals(parsePageProps(null), {});
  assertEquals(parsePageProps("{not json"), {});
});

// ---------------------------------------------------------------------------
// Method integration (seeded cache dirs, no network)
// ---------------------------------------------------------------------------

async function seedCache(url: string, body: string): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "wikipedia-test-" });
  const key = webCacheKey(url);
  await Deno.mkdir(`${dir}/${key}`, { recursive: true });
  await Deno.writeTextFile(`${dir}/${key}/body`, body);
  return dir;
}

const defaultCtx = makeContext().context;
const WIKITEXT_URL = pageUrl(defaultCtx, "Alfred Bester", "wikitext");
const SEARCH_URL = searchUrl(defaultCtx, "Alfred Bester", 5);
const PROPS_URL = pagePropsUrl(defaultCtx, ["Alfred Bester"]);

Deno.test("search-url method writes a url resource", async () => {
  const { context, written } = makeContext();
  await model.methods["search-url"].execute({ query: "Alfred Bester", limit: 5 }, context);
  assertEquals(written[0].specName, "url");
  assertEquals(written[0].name, "search-url");
  assertStringIncludes(written[0].data.url as string, "opensearch");
});

Deno.test("page-url method writes a url resource", async () => {
  const { context, written } = makeContext();
  await model.methods["page-url"].execute({ title: "Alfred Bester", format: "wikitext" }, context);
  assertEquals(written[0].name, "page-url");
  assertStringIncludes(written[0].data.url as string, "action=parse");
});

Deno.test("page-props-url method writes a url resource", async () => {
  const { context, written } = makeContext();
  await model.methods["page-props-url"].execute({ titles: ["A", "B"] }, context);
  assertEquals(written[0].name, "page-props-url");
  assertStringIncludes(written[0].data.url as string, "titles=A%7CB");
});

Deno.test("search parses a cached opensearch response", async () => {
  const body = JSON.stringify([
    "Alfred Bester",
    ["Alfred Bester", "Alfred Bester (novel)"],
    ["American writer", "1956 novel"],
    ["https://en.wikipedia.org/wiki/Alfred_Bester", "https://en.wikipedia.org/wiki/The_Demolished_Man"],
  ]);
  const dir = await seedCache(SEARCH_URL, body);
  try {
    const { context, written } = makeContext({ cacheDir: dir });
    await model.methods.search.execute({ query: "Alfred Bester", limit: 5, url: SEARCH_URL }, context);
    assertEquals(written[0].specName, "search");
    assertEquals(written[0].name, "search-Alfred Bester");
    assertEquals(written[0].data.cached, true);
    const results = written[0].data.results as Record<string, unknown>[];
    assertEquals(results.length, 2);
    assertEquals(results[0].title, "Alfred Bester");
    assertEquals(results[0].description, "American writer");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("search returns empty results on a cache miss", async () => {
  const dir = await Deno.makeTempDir({ prefix: "wikipedia-test-" });
  try {
    const { context, written } = makeContext({ cacheDir: dir });
    await model.methods.search.execute({ query: "Nobody Here", limit: 5 }, context);
    assertEquals(written[0].data.cached, false);
    assertEquals((written[0].data.results as unknown[]).length, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("get-page parses wikitext (formatversion=2)", async () => {
  const body = JSON.stringify({ parse: { wikitext: "Some '''wikitext'''." } });
  const dir = await seedCache(WIKITEXT_URL, body);
  try {
    const { context, written } = makeContext({ cacheDir: dir });
    await model.methods["get-page"].execute({ title: "Alfred Bester", format: "wikitext", url: WIKITEXT_URL }, context);
    assertEquals(written[0].specName, "page");
    assertEquals(written[0].name, "page-Alfred Bester");
    assertEquals(written[0].data.content, "Some '''wikitext'''.");
    assertEquals(written[0].data.cached, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("get-page returns the raw body for parsoid/summary", async () => {
  const raw = "<html><body>parsoid</body></html>";
  const url = pageUrl(defaultCtx, "Alfred Bester", "parsoid");
  const dir = await seedCache(url, raw);
  try {
    const { context, written } = makeContext({ cacheDir: dir });
    await model.methods["get-page"].execute({ title: "Alfred Bester", format: "parsoid", url }, context);
    assertEquals(written[0].data.content, raw);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("get-page falls back to the raw body when JSON is malformed", async () => {
  const dir = await seedCache(WIKITEXT_URL, "not json at all");
  try {
    const { context, written } = makeContext({ cacheDir: dir });
    await model.methods["get-page"].execute({ title: "Alfred Bester", format: "wikitext", url: WIKITEXT_URL }, context);
    assertEquals(written[0].data.content, "not json at all");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("get-page yields null content on a cache miss", async () => {
  const dir = await Deno.makeTempDir({ prefix: "wikipedia-test-" });
  try {
    const { context, written } = makeContext({ cacheDir: dir });
    await model.methods["get-page"].execute({ title: "Missing Page", format: "wikitext" }, context);
    assertEquals(written[0].data.content, null);
    assertEquals(written[0].data.cached, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("get-infobox extracts an infobox from cached wikitext", async () => {
  const wikitext = `{{Infobox writer
 | name = Alfred Bester
 | occupation = Novelist
}}`;
  const body = JSON.stringify({ parse: { wikitext } });
  const dir = await seedCache(WIKITEXT_URL, body);
  try {
    const { context, written } = makeContext({ cacheDir: dir });
    await model.methods["get-infobox"].execute({ title: "Alfred Bester", url: WIKITEXT_URL }, context);
    assertEquals(written[0].specName, "infobox");
    assertEquals(written[0].name, "infobox-Alfred Bester");
    assertEquals(written[0].data.template, "infobox writer");
    const infobox = written[0].data.infobox as Record<string, string>;
    assertEquals(infobox["name"], "Alfred Bester");
    assertEquals(infobox["occupation"], "Novelist");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("get-infobox returns an empty infobox for a non-matching template", async () => {
  const wikitext = `{{Infobox writer | name = Alfred Bester }}`;
  const body = JSON.stringify({ parse: { wikitext } });
  const dir = await seedCache(WIKITEXT_URL, body);
  try {
    const { context, written } = makeContext({ cacheDir: dir });
    await model.methods["get-infobox"].execute({ title: "Alfred Bester", template: "book", url: WIKITEXT_URL }, context);
    const infobox = written[0].data.infobox as Record<string, string>;
    assertEquals(infobox["name"], undefined);
    assertEquals(infobox._template, "infobox writer");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("get-page-props parses a cached page-props response", async () => {
  const body = JSON.stringify({
    query: {
      pages: {
        "1": {
          title: "Alfred Bester",
          fullurl: "https://en.wikipedia.org/wiki/Alfred_Bester",
          pageprops: { "wikibase_item": "Q286116" },
        },
      },
    },
  });
  const dir = await seedCache(PROPS_URL, body);
  try {
    const { context, written } = makeContext({ cacheDir: dir });
    await model.methods["get-page-props"].execute({ titles: ["Alfred Bester"], url: PROPS_URL }, context);
    assertEquals(written[0].specName, "page-props");
    assertEquals(written[0].name, "page-props-Alfred Bester");
    assertEquals(written[0].data.cached, true);
    const pages = written[0].data.pages as Record<string, Record<string, unknown>>;
    assertEquals(pages["Alfred Bester"]!.wikidataId, "Q286116");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("get-page-props honors a custom data key", async () => {
  const dir = await seedCache(PROPS_URL, JSON.stringify({ query: { pages: {} } }));
  try {
    const { context, written } = makeContext({ cacheDir: dir });
    await model.methods["get-page-props"].execute({ titles: ["Alfred Bester"], key: "bester", url: PROPS_URL }, context);
    assertEquals(written[0].name, "page-props-bester");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
