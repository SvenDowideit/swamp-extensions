import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";

import {
  entityUrl,
  expandHome,
  extractClaimValues,
  fnv1a,
  localized,
  model,
  normalizeUrl,
  parseEntities,
  searchUrl,
  sitelinkUrl,
  webCacheKey,
} from "./wikidata.ts";

Deno.test("extractClaimValues pulls value ids from value snaks", () => {
  const claims = [
    { mainsnak: { datavalue: { value: { id: "Q5" } } } },
    { mainsnak: { datavalue: { value: { id: "Q149454" } } } },
  ];
  assertEquals(extractClaimValues(claims), ["Q5", "Q149454"]);
});

Deno.test("extractClaimValues skips novalue/somevalue snaks", () => {
  const claims = [
    { mainsnak: { snaktype: "novalue" } },
    { mainsnak: { snaktype: "somevalue" } },
    { mainsnak: { datavalue: { value: { id: "Q571" } } } },
  ];
  assertEquals(extractClaimValues(claims), ["Q571"]);
});

Deno.test("extractClaimValues handles missing/empty claims", () => {
  assertEquals(extractClaimValues(undefined), []);
  assertEquals(extractClaimValues([]), []);
});

Deno.test("parseEntities returns null for non-objects", () => {
  assertEquals(parseEntities(null), null);
  assertEquals(parseEntities("nope"), null);
  assertEquals(parseEntities(42), null);
});

Deno.test("parseEntities returns null when no entities key", () => {
  assertEquals(parseEntities({ foo: "bar" }), null);
});

Deno.test("parseEntities extracts the entities map", () => {
  const entities = parseEntities({
    entities: { Q286116: { id: "Q286116", type: "item" } },
  });
  assertEquals(entities !== null, true);
  assertEquals(entities!["Q286116"]!.id, "Q286116");
});

Deno.test("localized returns the matching language first", () => {
  const map = {
    en: { language: "en", value: "Alfred Bester" },
    de: { language: "de", value: "Alfred Bester (de)" },
  };
  assertEquals(localized(map, "en"), "Alfred Bester");
});

Deno.test("localized falls back to the first entry", () => {
  const map = {
    de: { language: "de", value: "Alfred Bester (de)" },
  };
  assertEquals(localized(map, "en"), "Alfred Bester (de)");
});

Deno.test("localized returns null when map is absent or empty", () => {
  assertEquals(localized(undefined, "en"), null);
  assertEquals(localized({}, "en"), null);
});

// ---------------------------------------------------------------------------
// Shared cache-key helpers (must match @svendowideit/web-cache)
// ---------------------------------------------------------------------------

Deno.test("expandHome expands a leading ~ against $HOME", () => {
  const original = Deno.env.get("HOME");
  Deno.env.set("HOME", "/home/alice");
  try {
    assertEquals(expandHome("~"), "/home/alice");
    assertEquals(expandHome("~/x/y"), "/home/alice/x/y");
    assertEquals(expandHome("/abs/path"), "/abs/path");
  } finally {
    if (original === undefined) Deno.env.delete("HOME");
    else Deno.env.set("HOME", original);
  }
});

Deno.test("fnv1a is deterministic and matches the known vector", () => {
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

Deno.test("searchUrl builds a wbsearchentities URL", () => {
  const { context } = makeContext();
  const url = searchUrl(context, "Alfred Bester", 5, "en");
  assertStringIncludes(url, "action=wbsearchentities");
  assertStringIncludes(url, "search=Alfred+Bester");
  assertStringIncludes(url, "language=en");
  assertStringIncludes(url, "limit=5");
  assertStringIncludes(url, "format=json");
  assertStringIncludes(url, "type=item");
});

Deno.test("entityUrl builds a wbgetentities URL with the right props", () => {
  const { context } = makeContext({ language: "de" });
  const url = entityUrl(context, "Q286116");
  assertStringIncludes(url, "action=wbgetentities");
  assertStringIncludes(url, "ids=Q286116");
  assertStringIncludes(url, "languages=de");
  assertStringIncludes(url, "format=json");
});

Deno.test("sitelinkUrl builds a title→entity sitelink URL", () => {
  const { context } = makeContext();
  const url = sitelinkUrl(context, "Alfred Bester", "enwiki");
  assertStringIncludes(url, "action=wbgetentities");
  assertStringIncludes(url, "sites=enwiki");
  assertStringIncludes(url, "titles=Alfred+Bester");
});

Deno.test("URL builders honor a custom apiUrl", () => {
  const { context } = makeContext({ apiUrl: "https://example.com/api.php" });
  assertEquals(entityUrl(context, "Q1").startsWith("https://example.com/api.php?"), true);
});

// ---------------------------------------------------------------------------
// Method integration (seeded cache dirs, no network)
// ---------------------------------------------------------------------------

/** Write a cached body for `url` into a fresh temp cache dir. */
async function seedCache(
  url: string,
  body: string,
): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "wikidata-test-" });
  const key = webCacheKey(url);
  await Deno.mkdir(`${dir}/${key}`, { recursive: true });
  await Deno.writeTextFile(`${dir}/${key}/body`, body);
  return dir;
}

const defaultCtx = makeContext().context;
const ENTITY_URL = entityUrl(defaultCtx, "Q286116");
const SEARCH_URL = searchUrl(defaultCtx, "Alfred Bester", 10, "en");
const SITELINK_URL = sitelinkUrl(defaultCtx, "Alfred Bester", "enwiki");

const ENTITY_BODY = JSON.stringify({
  entities: {
    Q286116: {
      id: "Q286116",
      type: "item",
      labels: { en: { language: "en", value: "Alfred Bester" } },
      descriptions: { en: { language: "en", value: "American writer" } },
      sitelinks: {
        enwiki: { site: "enwiki", title: "Alfred Bester" },
      },
      claims: {
        P31: [
          { mainsnak: { datavalue: { value: { id: "Q5" } } } },
          { mainsnak: { datavalue: { value: { id: "Q149454" } } } },
        ],
        P106: [
          { mainsnak: { datavalue: { value: { id: "Q36180" } } } },
        ],
      },
    },
  },
});

const SEARCH_BODY = JSON.stringify({
  search: [
    { id: "Q286116", label: "Alfred Bester", description: "American writer", url: "https://www.wikidata.org/wiki/Q286116" },
    { id: "Q123", label: "Other", description: null, url: null },
  ],
});

Deno.test("search-url method writes a url resource", async () => {
  const { context, written } = makeContext();
  await model.methods["search-url"].execute({ query: "Alfred Bester", limit: 5 }, context);
  assertEquals(written[0].specName, "url");
  assertEquals(written[0].name, "search-url");
  assertStringIncludes(written[0].data.url as string, "wbsearchentities");
});

Deno.test("entity-url method writes a url resource", async () => {
  const { context, written } = makeContext();
  await model.methods["entity-url"].execute({ id: "Q286116" }, context);
  assertEquals(written[0].name, "entity-url");
  assertStringIncludes(written[0].data.url as string, "ids=Q286116");
});

Deno.test("resolve-title-url method writes a url resource", async () => {
  const { context, written } = makeContext();
  await model.methods["resolve-title-url"].execute({ title: "Alfred Bester" }, context);
  assertEquals(written[0].name, "resolve-title-url");
  assertStringIncludes(written[0].data.url as string, "sites=enwiki");
});

Deno.test("search parses a cached wbsearchentities response", async () => {
  const dir = await seedCache(SEARCH_URL, SEARCH_BODY);
  try {
    const { context, written } = makeContext({ cacheDir: dir });
    await model.methods.search.execute({ query: "Alfred Bester", limit: 10, url: SEARCH_URL }, context);
    assertEquals(written[0].specName, "search");
    assertEquals(written[0].name, "search-Alfred Bester");
    assertEquals(written[0].data.cached, true);
    const results = written[0].data.results as Record<string, unknown>[];
    assertEquals(results.length, 2);
    assertEquals(results[0].id, "Q286116");
    assertEquals(results[0].label, "Alfred Bester");
    assertEquals(results[1].description, null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("search reports cached=false and no results on a cache miss", async () => {
  const dir = await Deno.makeTempDir({ prefix: "wikidata-test-" });
  try {
    const { context, written } = makeContext({ cacheDir: dir });
    await model.methods.search.execute({ query: "Nobody", limit: 10 }, context);
    assertEquals(written[0].data.cached, false);
    assertEquals((written[0].data.results as unknown[]).length, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("get-entity parses an entity with localized label/description", async () => {
  const dir = await seedCache(ENTITY_URL, ENTITY_BODY);
  try {
    const { context, written } = makeContext({ cacheDir: dir });
    await model.methods["get-entity"].execute({ id: "Q286116", url: ENTITY_URL }, context);
    assertEquals(written[0].specName, "entity");
    assertEquals(written[0].name, "entity-Q286116");
    assertEquals(written[0].data.cached, true);
    const entity = written[0].data.entity as Record<string, unknown>;
    assertEquals(entity.id, "Q286116");
    assertEquals(entity.label, "Alfred Bester");
    assertEquals(entity.description, "American writer");
    assertEquals(entity.sitelinks !== null, true);
    assertEquals(entity.claims !== null, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("get-entity returns entity=null on a miss", async () => {
  const dir = await Deno.makeTempDir({ prefix: "wikidata-test-" });
  try {
    const { context, written } = makeContext({ cacheDir: dir });
    await model.methods["get-entity"].execute({ id: "Q999999" }, context);
    assertEquals(written[0].data.entity, null);
    assertEquals(written[0].data.cached, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("resolve-title matches a sitelink title to the QID", async () => {
  const dir = await seedCache(SITELINK_URL, ENTITY_BODY);
  try {
    const { context, written } = makeContext({ cacheDir: dir });
    await model.methods["resolve-title"].execute({ title: "Alfred Bester", url: SITELINK_URL }, context);
    assertEquals(written[0].specName, "resolution");
    assertEquals(written[0].name, "resolution-Alfred Bester");
    assertEquals(written[0].data.id, "Q286116");
    assertEquals(written[0].data.site, "enwiki");
    assertEquals(written[0].data.label, "Alfred Bester");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("resolve-title falls back to the only returned entity", async () => {
  const dir = await seedCache(SITELINK_URL, ENTITY_BODY);
  try {
    const { context, written } = makeContext({ cacheDir: dir });
    await model.methods["resolve-title"].execute({ title: "Different Title", url: SITELINK_URL }, context);
    assertEquals(written[0].data.id, "Q286116");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("get-claims extracts values for a named property", async () => {
  const dir = await seedCache(ENTITY_URL, ENTITY_BODY);
  try {
    const { context, written } = makeContext({ cacheDir: dir });
    await model.methods["get-claims"].execute({ id: "Q286116", property: "P106", url: ENTITY_URL }, context);
    assertEquals(written[0].specName, "claims");
    assertEquals(written[0].name, "claims-Q286116-P106");
    assertEquals(written[0].data.values, ["Q36180"]);
    assertEquals(written[0].data.cached, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("get-instance-of extracts P31 values", async () => {
  const dir = await seedCache(ENTITY_URL, ENTITY_BODY);
  try {
    const { context, written } = makeContext({ cacheDir: dir });
    await model.methods["get-instance-of"].execute({ id: "Q286116", url: ENTITY_URL }, context);
    assertEquals(written[0].specName, "instance-of");
    assertEquals(written[0].name, "instance-of-Q286116");
    assertEquals(written[0].data.instanceOf, ["Q5", "Q149454"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("get-instance-of honors a custom data key", async () => {
  const dir = await seedCache(ENTITY_URL, ENTITY_BODY);
  try {
    const { context, written } = makeContext({ cacheDir: dir });
    await model.methods["get-instance-of"].execute({ id: "Q286116", key: "bester", url: ENTITY_URL }, context);
    assertEquals(written[0].name, "instance-of-bester");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
