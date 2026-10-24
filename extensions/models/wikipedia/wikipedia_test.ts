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
import { enterpriseArticleUrl } from "./wikipedia_enterprise.ts";

const ARTICLE = {
  name: "Alfred Bester",
  identifier: 123,
  abstract: "American science fiction writer",
  url: "https://en.wikipedia.org/wiki/Alfred_Bester",
  article_body: {
    wikitext: "{{Infobox writer | name = Alfred Bester }}",
    html: "<p>Alfred Bester</p>",
  },
  main_entity: { identifier: "Q286116" },
};

interface VaultOptions {
  vault?: Record<string, string>;
}

function makeContext(
  globals: Record<string, unknown> = {},
  opts: VaultOptions = {},
) {
  const written: {
    specName: string;
    name: string;
    data: Record<string, unknown>;
  }[] = [];
  const resources = new Map<string, Record<string, unknown>>();
  const logs: string[] = [];
  const log = (message: string, props?: Record<string, unknown>) => {
    logs.push(props ? `${message} ${JSON.stringify(props)}` : message);
  };
  const context = {
    globalArgs: model.globalArguments.parse(globals),
    logger: {
      info: log,
      debug: log,
      warn: log,
      warning: log,
      error: log,
    },
    writeResource: (
      specName: string,
      name: string,
      data: Record<string, unknown>,
    ) => {
      written.push({ specName, name, data });
      resources.set(name, data);
      return Promise.resolve({ name });
    },
    readResource: (name: string) => Promise.resolve(resources.get(name) ?? null),
    vaultService: opts.vault
      ? {
        get: (_vault: string, key: string) =>
          Promise.resolve(opts.vault![key] ?? ""),
      }
      : undefined,
  };
  return { context, written, resources, logs };
}

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
const ENTERPRISE_URL = enterpriseArticleUrl(defaultCtx, "Alfred Bester");

// ---------------------------------------------------------------------------
// Parsers and URL builders
// ---------------------------------------------------------------------------

Deno.test("detectInfoboxName finds a writer infobox", () => {
  const wikitext = `{{short description|American science fiction author}}
{{Infobox writer
 | name = Alfred Bester
}}
`;
  assertEquals(detectInfoboxName(wikitext), "infobox writer");
});

Deno.test("parseInfoboxTemplate extracts key/value params", () => {
  const wikitext = `{{Infobox writer
 | name = Alfred Bester
 | birth_date = {{Birth date|1913|12|18}}
 | occupation = Novelist
}}`;
  const parsed = parseInfoboxTemplate(wikitext);
  assertEquals(parsed._template, "infobox writer");
  assertEquals(parsed["name"], "Alfred Bester");
  assertEquals(parsed["birth_date"], "{{Birth date|1913|12|18}}");
});

Deno.test("cache key helpers are stable", () => {
  assertEquals(fnv1a("hello"), "4f9f2cab");
  assertEquals(
    normalizeUrl("https://EN.wikipedia.ORG/x?b=2&a=1#frag"),
    "https://en.wikipedia.org/x?a=1&b=2",
  );
  assertEquals(
    webCacheKey("https://e.com/x?a=1&b=2"),
    webCacheKey("https://e.com/x?b=2&a=1"),
  );
});

Deno.test("pageUrl builds all format URLs", () => {
  assertEquals(
    pageUrl(defaultCtx, "Alfred Bester", "parsoid"),
    "https://en.wikipedia.org/api/rest_v1/page/Alfred%20Bester/html",
  );
  assertStringIncludes(
    pageUrl(defaultCtx, "Alfred Bester", "wikitext"),
    "action=parse",
  );
  assertStringIncludes(
    pageUrl(defaultCtx, "Alfred Bester", "html"),
    "prop=text",
  );
  assertStringIncludes(
    pageUrl(defaultCtx, "Alfred Bester", "json"),
    "prop=info%7Cpageprops",
  );
});

Deno.test("searchUrl and pagePropsUrl build public URLs", () => {
  assertStringIncludes(SEARCH_URL, "action=opensearch");
  assertStringIncludes(SEARCH_URL, "search=Alfred+Bester");
  assertStringIncludes(PROPS_URL, "titles=Alfred+Bester");
});

Deno.test("extractContent handles every format", () => {
  assertEquals(
    extractContent("wikitext", { parse: { wikitext: "hello" } }),
    "hello",
  );
  assertEquals(
    extractContent("wikitext", { parse: { wikitext: { "*": "hello" } } }),
    "hello",
  );
  assertEquals(
    extractContent("html", { parse: { text: "<p>hi</p>" } }),
    "<p>hi</p>",
  );
  assertEquals(extractContent("json", { a: 1 }), JSON.stringify({ a: 1 }, null, 2));
  assertEquals(extractContent("parsoid", "<html></html>"), "<html></html>");
  assertEquals(extractContent("summary", "{}"), "{}");
  assertEquals(extractContent("wikitext", {}), null);
});

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
});

// ---------------------------------------------------------------------------
// Method integration (dual cache, no network)
// ---------------------------------------------------------------------------

Deno.test("search uses the public cache", async () => {
  const body = JSON.stringify([
    "Alfred Bester",
    ["Alfred Bester", "Alfred Bester (novel)"],
    ["American writer", "1956 novel"],
    ["https://en.wikipedia.org/wiki/Alfred_Bester", "https://en.wikipedia.org/wiki/The_Demolished_Man"],
  ]);
  const dir = await seedCache(SEARCH_URL, body);
  try {
    const { context, written } = makeContext({ cacheDir: dir });
    await model.methods.search.execute({
      query: "Alfred Bester",
      limit: 5,
      url: SEARCH_URL,
    }, context);
    assertEquals(written[0].specName, "search");
    assertEquals(written[0].data.source, "public-cache");
    assertEquals(written[0].data.cached, true);
    const results = written[0].data.results as Record<string, unknown>[];
    assertEquals(results.length, 2);
    assertEquals(results[0].title, "Alfred Bester");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("get-page parses a public-cache body", async () => {
  const body = JSON.stringify({ parse: { wikitext: "Some '''wikitext'''." } });
  const dir = await seedCache(WIKITEXT_URL, body);
  try {
    const { context, written } = makeContext({ cacheDir: dir });
    await model.methods["get-page"].execute({
      title: "Alfred Bester",
      format: "wikitext",
      url: WIKITEXT_URL,
    }, context);
    assertEquals(written[0].data.content, "Some '''wikitext'''.");
    assertEquals(written[0].data.source, "public-cache");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("get-page parses an Enterprise-cache body", async () => {
  const dir = await seedCache(ENTERPRISE_URL, JSON.stringify([ARTICLE]));
  try {
    const { context, written } = makeContext({ cacheDir: dir });
    await model.methods["get-page"].execute({
      title: "Alfred Bester",
      format: "wikitext",
      url: WIKITEXT_URL,
    }, context);
    assertEquals(
      written[0].data.content,
      ARTICLE.article_body.wikitext,
    );
    assertEquals(written[0].data.source, "enterprise-cache");
    assertEquals(written[0].data.cached, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("get-page reports none on a miss in both caches", async () => {
  const dir = await Deno.makeTempDir({ prefix: "wikipedia-test-" });
  try {
    const { context, written } = makeContext({ cacheDir: dir });
    await model.methods["get-page"].execute({
      title: "Missing Page",
      format: "wikitext",
    }, context);
    assertEquals(written[0].data.content, null);
    assertEquals(written[0].data.cached, false);
    assertEquals(written[0].data.source, "none");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("get-infobox extracts from an Enterprise-cache body", async () => {
  const dir = await seedCache(ENTERPRISE_URL, JSON.stringify([ARTICLE]));
  try {
    const { context, written } = makeContext({ cacheDir: dir });
    await model.methods["get-infobox"].execute({
      title: "Alfred Bester",
      url: WIKITEXT_URL,
    }, context);
    assertEquals(written[0].data.template, "infobox writer");
    assertEquals(written[0].data.source, "enterprise-cache");
    const infobox = written[0].data.infobox as Record<string, string>;
    assertEquals(infobox["name"], "Alfred Bester");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("get-page-props parses a public page-props body", async () => {
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
    await model.methods["get-page-props"].execute({
      titles: ["Alfred Bester"],
      url: PROPS_URL,
    }, context);
    assertEquals(written[0].data.source, "public-cache");
    const pages = written[0].data.pages as Record<string, Record<string, unknown>>;
    assertEquals(pages["Alfred Bester"]!.wikidataId, "Q286116");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("get-page-props resolves a single title from the Enterprise cache", async () => {
  const dir = await seedCache(ENTERPRISE_URL, JSON.stringify([ARTICLE]));
  try {
    const { context, written } = makeContext({ cacheDir: dir });
    await model.methods["get-page-props"].execute({
      titles: ["Alfred Bester"],
      url: PROPS_URL,
    }, context);
    assertEquals(written[0].data.source, "enterprise-cache");
    const pages = written[0].data.pages as Record<string, Record<string, unknown>>;
    assertEquals(pages["Alfred Bester"]!.wikidataId, "Q286116");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("enterprise-plan chooses public without credentials", async () => {
  const dir = await Deno.makeTempDir({ prefix: "wikipedia-test-" });
  try {
    const { context, written } = makeContext({ cacheDir: dir });
    await model.methods["enterprise-plan"].execute({
      title: "Alfred Bester",
      format: "wikitext",
      runId: "run-test",
    }, context);
    assertEquals(written[0].specName, "enterprise-plan");
    assertEquals(written[0].data.provider, "public");
    assertEquals(written[0].data.reason, "no Enterprise credentials");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("enterprise-plan chooses Enterprise with a vault access token", async () => {
  const dir = await Deno.makeTempDir({ prefix: "wikipedia-test-" });
  try {
    const { context, written } = makeContext(
      { cacheDir: dir },
      { vault: { access_token: "vault-token" } },
    );
    await model.methods["enterprise-plan"].execute({
      title: "Alfred Bester",
      format: "wikitext",
      runId: "run-test",
    }, context);
    assertEquals(written[0].data.provider, "enterprise");
    assertEquals(written[0].data.reason, "vault access token");
    assertEquals(
      await Deno.readTextFile(written[0].data.tokenFile as string),
      "vault-token",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("enterprise-session method persists a login response", async () => {
  const dir = await Deno.makeTempDir({ prefix: "wikipedia-test-" });
  try {
    const responseFile = `${dir}/auth-response.json`;
    const tokenFile = `${dir}/token`;
    await Deno.writeTextFile(
      responseFile,
      JSON.stringify({
        access_token: "real-token",
        refresh_token: "refresh-token",
        expires_in: 86_400,
      }),
    );
    const { context, written } = makeContext({ cacheDir: dir }, {
      vault: { username: "alice", password: "secret" },
    });
    await model.methods["enterprise-session"].execute({
      responseFile,
      tokenFile,
    }, context);
    const result = written.find((w) => w.specName === "enterprise-session-result")!;
    assertEquals(result.data.ok, true);
    assertEquals(await Deno.readTextFile(tokenFile), "real-token");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("enterprise-record and enterprise-failure update usage", async () => {
  const { context, resources } = makeContext();
  await model.methods["enterprise-record"].execute({}, context);
  const afterRecord = resources.get("enterprise-usage") as { used: number };
  assertEquals(afterRecord.used, 1);
  await model.methods["enterprise-failure"].execute({ kind: "auth" }, context);
  const afterFailure = resources.get("enterprise-usage") as {
    authFailedUntil: number;
  };
  assertEquals(afterFailure.authFailedUntil > Date.now(), true);
});

Deno.test("enterprise-status reports readiness without leaking secrets", async () => {
  const { context, written } = makeContext({}, {
    vault: { username: "alice", password: "super-secret" },
  });
  await model.methods["enterprise-status"].execute({}, context);
  assertEquals(written[0].specName, "enterprise-status");
  assertEquals(written[0].data.eligible, true);
  assertEquals(JSON.stringify(written[0].data).includes("super-secret"), false);
});
