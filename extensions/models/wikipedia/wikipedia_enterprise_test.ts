import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";

import {
  enterpriseArticleUrl,
  type EnterpriseContext,
  enterprisePagePropsBody,
  enterprisePlan,
  enterpriseSessionFromResponse,
  enterpriseStatus,
  enterpriseVaultCandidates,
  parseEnterpriseArticle,
  quotaStatus,
  recordEnterpriseFailure,
  recordEnterpriseUsage,
} from "./wikipedia_enterprise.ts";

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

function makeEnterpriseContext(
  vault: Record<string, string> = {},
  overrides: Partial<EnterpriseContext["globalArgs"]> = {},
): EnterpriseContext {
  const resources = new Map<string, Record<string, unknown>>();
  return {
    globalArgs: {
      cacheDir: "~/.swamp/web-cache",
      enterpriseVaultName: "enterprise-wikimedia",
      enterpriseUsernameKey: "username",
      enterprisePasswordKey: "password",
      enterpriseAccessTokenKey: "access_token",
      enterpriseRefreshTokenKey: "refresh_token",
      enterpriseApiUrl: "https://api.enterprise.wikimedia.com",
      enterpriseAuthUrl: "https://auth.enterprise.wikimedia.com",
      enterpriseProject: "enwiki",
      enterpriseMonthlyQuota: 50_000,
      ...overrides,
    },
    logger: { info: () => {}, debug: () => {}, warn: () => {} },
    readResource: (name) => Promise.resolve(resources.get(name) ?? null),
    writeResource: (spec, name, data) => {
      resources.set(name, data);
      return Promise.resolve({ spec, name });
    },
    vaultService: {
      get: (_vault, key) => Promise.resolve(vault[key] ?? ""),
    },
  };
}

Deno.test("enterpriseVaultCandidates normalises underscore vault names", () => {
  const ctx = makeEnterpriseContext({}, {
    enterpriseVaultName: "enterprise_wikimedia",
  });
  assertEquals(enterpriseVaultCandidates(ctx), [
    "enterprise_wikimedia",
    "enterprise-wikimedia",
  ]);
});

Deno.test("enterpriseArticleUrl builds a GET cache key with the project filter", () => {
  const ctx = makeEnterpriseContext();
  const url = new URL(enterpriseArticleUrl(ctx, "Alfred Bester"));
  assertEquals(
    `${url.origin}${url.pathname}`,
    "https://api.enterprise.wikimedia.com/v2/articles/Alfred_Bester",
  );
  assertEquals(url.searchParams.get("limit"), "1");
  assertEquals(
    JSON.parse(url.searchParams.get("filters")!),
    { field: "is_part_of.identifier", value: "enwiki" },
  );
  assertEquals(
    enterpriseArticleUrl(ctx, "Alfred  Bester"),
    enterpriseArticleUrl(ctx, "Alfred Bester"),
  );
});

Deno.test("parseEnterpriseArticle accepts arrays and rejects error objects", () => {
  assertEquals(parseEnterpriseArticle(JSON.stringify([ARTICLE]))?.name, "Alfred Bester");
  assertEquals(parseEnterpriseArticle(JSON.stringify(ARTICLE))?.name, "Alfred Bester");
  assertEquals(
    parseEnterpriseArticle(JSON.stringify({ status: 401, message: "no" })),
    null,
  );
  assertEquals(parseEnterpriseArticle("not json"), null);
});

Deno.test("enterprisePagePropsBody maps title, url, summary and QID", () => {
  const body = enterprisePagePropsBody(ARTICLE, "Fallback");
  assertStringIncludes(body, '"title":"Alfred Bester"');
  assertStringIncludes(body, '"wikibase_item":"Q286116"');
  assertStringIncludes(body, '"wikibase-shortdesc":"American science fiction writer"');
});

Deno.test("quotaStatus is available by default, exhausted at the limit, and cooling down", async () => {
  const fresh = makeEnterpriseContext();
  const available = await quotaStatus(fresh);
  assertEquals(available.available, true);
  assertEquals(available.used, 0);
  assertEquals(available.limit, 50_000);

  const exhausted = makeEnterpriseContext({}, {
    enterpriseMonthlyQuota: 1,
  });
  await recordEnterpriseUsage(exhausted);
  const denied = await quotaStatus(exhausted);
  assertEquals(denied.available, false);
  assertEquals(denied.reason, "monthly quota exhausted");

  const cooling = makeEnterpriseContext();
  await recordEnterpriseFailure(cooling, "rate");
  assertEquals((await quotaStatus(cooling)).reason, "rate-limit cooldown");

  const authFailed = makeEnterpriseContext();
  await recordEnterpriseFailure(authFailed, "auth");
  assertEquals(
    (await quotaStatus(authFailed)).reason,
    "authentication cooldown",
  );
});

Deno.test("enterprisePlan chooses public without credentials", async () => {
  const dir = await Deno.makeTempDir({ prefix: "wikipedia-enterprise-test-" });
  try {
    const ctx = makeEnterpriseContext({}, { cacheDir: dir });
    const plan = await enterprisePlan(
      ctx,
      "Alfred Bester",
      "https://en.wikipedia.org/wiki/Alfred_Bester",
      "run-1",
    );
    assertEquals(plan.provider, "public");
    assertEquals(plan.reason, "no Enterprise credentials");
    assertEquals(plan.auth, null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("enterprisePlan writes a private token file for a vault access token", async () => {
  const dir = await Deno.makeTempDir({ prefix: "wikipedia-enterprise-test-" });
  try {
    const ctx = makeEnterpriseContext(
      { access_token: "vault-token" },
      { cacheDir: dir },
    );
    const plan = await enterprisePlan(
      ctx,
      "Alfred Bester",
      "https://en.wikipedia.org/wiki/Alfred_Bester",
      "run-2",
    );
    assertEquals(plan.provider, "enterprise");
    assertEquals(plan.reason, "vault access token");
    assertEquals(await Deno.readTextFile(plan.tokenFile), "vault-token");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("enterprisePlan writes a private login body when only username/password exist", async () => {
  const dir = await Deno.makeTempDir({ prefix: "wikipedia-enterprise-test-" });
  try {
    const ctx = makeEnterpriseContext(
      { username: "alice", password: "super-secret" },
      { cacheDir: dir },
    );
    const plan = await enterprisePlan(
      ctx,
      "Alfred Bester",
      "https://en.wikipedia.org/wiki/Alfred_Bester",
      "run-3",
    );
    assertEquals(plan.provider, "enterprise");
    assertEquals(plan.auth?.via, "login");
    assertEquals(
      plan.auth?.url,
      "https://auth.enterprise.wikimedia.com/v1/login",
    );
    const body = JSON.parse(await Deno.readTextFile(plan.auth!.bodyFile));
    assertEquals(body, { username: "alice", password: "super-secret" });
    assertEquals(JSON.stringify(plan).includes("super-secret"), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("enterpriseSessionFromResponse persists the session and token file", async () => {
  const dir = await Deno.makeTempDir({ prefix: "wikipedia-enterprise-test-" });
  try {
    const ctx = makeEnterpriseContext(
      { username: "alice", password: "secret" },
      { cacheDir: dir },
    );
    const plan = await enterprisePlan(
      ctx,
      "Alfred Bester",
      "https://en.wikipedia.org/wiki/Alfred_Bester",
      "run-4",
    );
    await Deno.writeTextFile(
      plan.auth!.responseFile,
      JSON.stringify({
        access_token: "real-token",
        refresh_token: "refresh-token",
        expires_in: 86_400,
      }),
    );
    const result = await enterpriseSessionFromResponse(
      ctx,
      plan.auth!.responseFile,
      plan.tokenFile,
      plan.auth!.bodyFile,
    );
    assertEquals(result.ok, true);
    assertEquals(await Deno.readTextFile(plan.tokenFile), "real-token");
    const session = await ctx.readResource!("enterprise-session") as {
      accessToken: string;
      refreshToken: string;
    };
    assertEquals(session.accessToken, "real-token");
    assertEquals(session.refreshToken, "refresh-token");
    assertEquals(await Deno.readTextFile(plan.auth!.responseFile).catch(() => null), null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("enterpriseStatus never exposes secret values", async () => {
  const ctx = makeEnterpriseContext({
    username: "alice",
    password: "super-secret",
  });
  const status = await enterpriseStatus(ctx);
  assertEquals(status.eligible, true);
  assertEquals(status.hasUsername, true);
  assertEquals(status.hasPassword, true);
  assertEquals(JSON.stringify(status).includes("super-secret"), false);
});
