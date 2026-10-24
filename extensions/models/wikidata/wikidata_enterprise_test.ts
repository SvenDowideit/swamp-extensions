import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";

import {
  enterpriseEntityToPublic,
  enterpriseEntityUrl,
  type EnterpriseContext,
  enterprisePlan,
  enterpriseSessionFromResponse,
  enterpriseStatus,
  enterpriseVaultCandidates,
  parseEnterpriseArticle,
  quotaStatus,
} from "./wikidata_enterprise.ts";

const ENTITY = {
  name: "Q286116",
  entity: {
    identifier: "Q286116",
    type: "item",
    labels: { en: "Alfred Bester" },
    descriptions: { en: "American writer" },
    sitelinks: { enwiki: { title: "Alfred Bester" } },
    statements: {
      P31: [{ value: { type: "wikibase-item", content: "Q5" } }],
    },
  },
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

Deno.test("enterpriseEntityUrl uses items for QIDs and properties for PIDs", () => {
  const ctx = makeEnterpriseContext();
  assertEquals(
    enterpriseEntityUrl(ctx, "Q286116"),
    "https://api.enterprise.wikimedia.com/v2/wikidata/items/Q286116",
  );
  assertEquals(
    enterpriseEntityUrl(ctx, "P31"),
    "https://api.enterprise.wikimedia.com/v2/wikidata/properties/P31",
  );
});

Deno.test("parseEnterpriseArticle and enterpriseEntityToPublic map statements", () => {
  const article = parseEnterpriseArticle(JSON.stringify([ENTITY]))!;
  assertEquals(article.entity?.identifier, "Q286116");
  const entity = enterpriseEntityToPublic(article, "Q286116") as {
    id: string;
    labels: Record<string, { value: string }>;
    claims: Record<string, unknown[]>;
    sitelinks: Record<string, unknown>;
  };
  assertEquals(entity.id, "Q286116");
  assertEquals(entity.labels.en!.value, "Alfred Bester");
  assertStringIncludes(JSON.stringify(entity.claims), "Q5");
  assertEquals(JSON.stringify(entity.sitelinks), JSON.stringify(ENTITY.entity.sitelinks));
});

Deno.test("enterpriseVaultCandidates normalises underscore vault names", () => {
  const ctx = makeEnterpriseContext({}, {
    enterpriseVaultName: "enterprise_wikimedia",
  });
  assertEquals(enterpriseVaultCandidates(ctx), [
    "enterprise_wikimedia",
    "enterprise-wikimedia",
  ]);
});

Deno.test("enterprisePlan is cache-first", async () => {
  const dir = await Deno.makeTempDir({ prefix: "wikidata-enterprise-test-" });
  try {
    const ctx = makeEnterpriseContext({}, { cacheDir: dir });
    const publicUrl = "https://www.wikidata.org/w/api.php?action=wbgetentities&ids=Q286116";
    // No cache yet, no credentials -> public.
    const first = await enterprisePlan(ctx, "Q286116", publicUrl, "run-1");
    assertEquals(first.provider, "public");
    assertEquals(first.reason, "no Enterprise credentials");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("enterprisePlan writes a private token file for a vault access token", async () => {
  const dir = await Deno.makeTempDir({ prefix: "wikidata-enterprise-test-" });
  try {
    const ctx = makeEnterpriseContext(
      { access_token: "vault-token" },
      { cacheDir: dir },
    );
    const publicUrl = "https://www.wikidata.org/w/api.php?action=wbgetentities&ids=Q286116";
    const plan = await enterprisePlan(ctx, "Q286116", publicUrl, "run-2");
    assertEquals(plan.provider, "enterprise");
    assertEquals(plan.reason, "vault access token");
    assertEquals(await Deno.readTextFile(plan.tokenFile), "vault-token");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("enterpriseSessionFromResponse persists the session and token file", async () => {
  const dir = await Deno.makeTempDir({ prefix: "wikidata-enterprise-test-" });
  try {
    const ctx = makeEnterpriseContext(
      { username: "alice", password: "secret" },
      { cacheDir: dir },
    );
    const publicUrl = "https://www.wikidata.org/w/api.php?action=wbgetentities&ids=Q286116";
    const plan = await enterprisePlan(ctx, "Q286116", publicUrl, "run-3");
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
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("quotaStatus and enterpriseStatus never expose secret values", async () => {
  const ctx = makeEnterpriseContext({
    username: "alice",
    password: "super-secret",
  });
  assertEquals((await quotaStatus(ctx)).available, true);
  const status = await enterpriseStatus(ctx);
  assertEquals(status.eligible, true);
  assertEquals(JSON.stringify(status).includes("super-secret"), false);
});
