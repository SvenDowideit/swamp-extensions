import { assertEquals, assertRejects } from "jsr:@std/assert@1";

import {
  describeTokens,
  getAccessToken,
  redact,
  SECRET_KEYS,
  tokensUsable,
  type ZwiftTokens,
} from "./zwift_auth.ts";

/** Build a fake fetch that returns one canned response and records the call. */
function fakeFetch(
  status: number,
  body: unknown,
  captured?: { url?: string; init?: RequestInit },
): typeof fetch {
  return ((url: string | URL, init?: RequestInit) => {
    if (captured) {
      captured.url = String(url);
      captured.init = init;
    }
    return Promise.resolve(
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }) as typeof fetch;
}

Deno.test("getAccessToken performs a password grant and shapes the result", async () => {
  const captured: { url?: string; init?: RequestInit } = {};
  const tokens = await getAccessToken({
    username: "rider@example.com",
    password: "hunter2",
    fetchImpl: fakeFetch(200, {
      access_token: "abc",
      refresh_token: "def",
      expires_in: 3600,
      scope: "openid profile",
    }, captured),
  });

  assertEquals(tokens.accessToken, "abc");
  assertEquals(tokens.refreshToken, "def");
  assertEquals(tokens.scope, "openid profile");
  assertEquals(tokens.expiresIn, 3600);
  assertEquals(
    captured.url,
    "https://secure.zwift.com/auth/realms/zwift/tokens/access/codes",
  );
  const body = String(captured.init?.body);
  assertEquals(body.includes("grant_type=password"), true);
  assertEquals(body.includes("client_id=Developer+Client"), true);
  assertEquals(body.includes("username=rider%40example.com"), true);
});

Deno.test("getAccessToken prefers a refresh token over a password", async () => {
  const captured: { url?: string; init?: RequestInit } = {};
  await getAccessToken({
    username: "rider@example.com",
    password: "hunter2",
    refreshToken: "stored-refresh",
    fetchImpl: fakeFetch(200, { access_token: "abc" }, captured),
  });
  const body = String(captured.init?.body);
  assertEquals(body.includes("grant_type=refresh_token"), true);
  assertEquals(body.includes("refresh_token=stored-refresh"), true);
  assertEquals(body.includes("password"), false);
});

Deno.test("getAccessToken rejects when no credentials were supplied", async () => {
  await assertRejects(
    () => getAccessToken({ fetchImpl: fakeFetch(200, { access_token: "x" }) }),
    Error,
    "no credentials",
  );
});

Deno.test("getAccessToken surfaces Keycloak's own error without the password", async () => {
  await assertRejects(
    () =>
      getAccessToken({
        username: "rider@example.com",
        password: "hunter2",
        fetchImpl: fakeFetch(400, {
          error: "invalid_grant",
          error_description: "Invalid user credentials",
        }),
      }),
    Error,
    "Invalid user credentials",
  );
});

Deno.test("getAccessToken reports the status on an HTML gateway error", async () => {
  await assertRejects(
    () =>
      getAccessToken({
        username: "rider@example.com",
        password: "hunter2",
        fetchImpl: fakeFetch(502, "<html>bad gateway</html>"),
      }),
    Error,
    "HTTP 502",
  );
});

Deno.test("tokensUsable respects the expiry skew", () => {
  const fresh: ZwiftTokens = {
    accessToken: "a",
    refreshToken: null,
    expiresIn: 3600,
    expiresAt: Date.now() + 3_600_000,
    scope: null,
  };
  assertEquals(tokensUsable(fresh), true);

  const nearlyExpired: ZwiftTokens = {
    ...fresh,
    expiresAt: Date.now() + 5_000,
  };
  assertEquals(tokensUsable(nearlyExpired), false);

  const unknownLifetime: ZwiftTokens = {
    ...fresh,
    expiresIn: null,
    expiresAt: Number.POSITIVE_INFINITY,
  };
  assertEquals(tokensUsable(unknownLifetime), true);

  assertEquals(tokensUsable({ ...fresh, accessToken: "" }), false);
});

Deno.test("describeTokens exposes no token material", () => {
  const described = describeTokens({
    accessToken: "secret-access",
    refreshToken: "secret-refresh",
    expiresIn: 3600,
    expiresAt: Date.now() + 3_600_000,
    scope: null,
  });
  const json = JSON.stringify(described);
  assertEquals(json.includes("secret-access"), false);
  assertEquals(json.includes("secret-refresh"), false);
  assertEquals(described.hasRefreshToken, true);
});

Deno.test("redact replaces every secret-named key, recursively", () => {
  const redacted = redact({
    access_token: "a",
    nested: { refreshToken: "b", safe: 1 },
    list: [{ password: "c" }],
  }) as Record<string, unknown>;
  assertEquals(redacted.access_token, "<redacted>");
  assertEquals(
    (redacted.nested as Record<string, unknown>).refreshToken,
    "<redacted>",
  );
  assertEquals((redacted.nested as Record<string, unknown>).safe, 1);
  assertEquals(
    ((redacted.list as unknown[])[0] as Record<string, unknown>).password,
    "<redacted>",
  );
});

Deno.test("SECRET_KEYS covers both snake_case and camelCase", () => {
  assertEquals(SECRET_KEYS.includes("access_token"), true);
  assertEquals(SECRET_KEYS.includes("accessToken"), true);
  assertEquals(SECRET_KEYS.includes("password"), true);
});
