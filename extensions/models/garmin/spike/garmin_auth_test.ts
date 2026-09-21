/**
 * Offline tests for the Garmin auth flow.
 *
 * A mock `fetch` routes by URL and returns canned Garmin-shaped responses, so
 * the whole SSO → OAuth1 → OAuth2 → profile path is exercised with no network
 * and no credentials. The point is to prove the wiring: cookie capture, form
 * parsing, signature headers, expiry arithmetic, MFA handling, and redaction.
 *
 * @module
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  beginLogin,
  completeMfa,
  connectapiGet,
  createSession,
  exchangeOAuth2,
  GarminAuthError,
  getOAuth1Token,
  type OAuthConsumer,
  redact,
  withExpiries,
} from "./garmin_auth.ts";

const CONSUMER: OAuthConsumer = {
  consumer_key: "ck-123",
  consumer_secret: "cs-456",
};

/** Build a Response with one or more `Set-Cookie` headers. */
function withCookies(body: string, cookies: string[], init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(body, { ...init, headers });
}

/** Records of every request the mock saw, for assertions. */
interface Seen {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}

/** A routing mock fetch. */
function mockFetch(
  handler: (seen: Seen) => Response | Promise<Response>,
): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const record: Seen = {
      url,
      method: (init?.method ?? "GET").toUpperCase(),
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : "",
    };
    seen.push(record);
    return await handler(record);
  }) as typeof fetch;
  return { fetch: impl, seen };
}

Deno.test("full login flow: SSO → OAuth1 → OAuth2 → profile", async () => {
  const { fetch: fetchImpl, seen } = mockFetch((req) => {
    if (req.url.includes("/mobile/sso/en/sign-in")) {
      return withCookies("<html>sign in</html>", ["GARMIN-SSO=abc; Path=/"]);
    }
    if (req.url.includes("/mobile/api/login")) {
      return withCookies(
        JSON.stringify({
          responseStatus: { type: "SUCCESSFUL" },
          serviceTicketId: "TICKET-1",
        }),
        ["GARMIN-SSO=abc; Path=/"],
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (req.url.includes("/oauth-service/oauth/preauthorized")) {
      return new Response(
        "oauth_token=OT-1&oauth_token_secret=OS-1",
        { status: 200 },
      );
    }
    if (req.url.includes("/oauth-service/oauth/exchange/user/2.0")) {
      return new Response(
        JSON.stringify({
          scope: "CONNECT_READ",
          token_type: "Bearer",
          access_token: "AT-1",
          refresh_token: "RT-1",
          expires_in: 3600,
          refresh_token_expires_in: 7200,
        }),
        { status: 200 },
      );
    }
    if (req.url.includes("/userprofile-service/socialProfile")) {
      return new Response(
        JSON.stringify({ displayName: "rider-42", fullName: "Test Rider" }),
        { status: 200 },
      );
    }
    return new Response("not found", { status: 404 });
  });

  const now = 1_000_000;
  const session = await createSession("garmin.com", {
    fetchImpl,
    consumer: CONSUMER,
    now: () => now * 1000,
  });

  const ticket = await beginLogin(session, "user@example.com", "hunter2");
  assertEquals(ticket, "TICKET-1");

  // The password must appear only in the login body, in no other request.
  const loginReq = seen.find((r) => r.url.includes("/mobile/api/login"))!;
  assert(loginReq.body.includes("hunter2"));
  const cookieHeader = loginReq.headers.get("cookie");
  assertEquals(cookieHeader, "GARMIN-SSO=abc");

  const oauth1 = await getOAuth1Token(session, ticket as string);
  assertEquals(oauth1.oauth_token, "OT-1");
  assertEquals(oauth1.oauth_token_secret, "OS-1");
  assertEquals(oauth1.domain, "garmin.com");

  const preauth = seen.find((r) => r.url.includes("preauthorized"))!;
  const preauthAuth = preauth.headers.get("authorization")!;
  assert(preauthAuth.startsWith("OAuth "));
  assert(preauthAuth.includes('oauth_consumer_key="ck-123"'));
  assert(preauthAuth.includes("oauth_signature="));
  assert(
    !preauthAuth.includes("oauth_token="),
    "two-legged request has no token",
  );

  const oauth2 = await exchangeOAuth2(session, oauth1, true);
  assertEquals(oauth2.access_token, "AT-1");
  assertEquals(oauth2.refresh_token, "RT-1");
  assertEquals(oauth2.expires_at, now + 3600);
  assertEquals(oauth2.refresh_token_expires_at, now + 7200);

  const exchangeReq = seen.find((r) => r.url.includes("/exchange/user/2.0"))!;
  assertEquals(exchangeReq.body, "audience=GARMIN_CONNECT_MOBILE_ANDROID_DI");
  const exchangeAuth = exchangeReq.headers.get("authorization")!;
  assert(exchangeAuth.includes('oauth_token="OT-1"'));

  const profile = await connectapiGet(
    session,
    oauth2,
    "/userprofile-service/socialProfile",
  ) as Record<string, unknown>;
  assertEquals(profile.displayName, "rider-42");

  const apiReq = seen.find((r) => r.url.includes("socialProfile"))!;
  assertEquals(apiReq.headers.get("authorization"), "Bearer AT-1");
});

Deno.test("refresh omits the DI audience", async () => {
  const { fetch: fetchImpl, seen } = mockFetch(() =>
    new Response(
      JSON.stringify({
        scope: "s",
        token_type: "Bearer",
        access_token: "AT-2",
        refresh_token: "RT-2",
        expires_in: 3600,
        refresh_token_expires_in: 7200,
      }),
      { status: 200 },
    )
  );
  const session = await createSession("garmin.com", {
    fetchImpl,
    consumer: CONSUMER,
    now: () => 0,
  });
  await exchangeOAuth2(
    session,
    { oauth_token: "OT", oauth_token_secret: "OS", domain: "garmin.com" },
    false,
  );
  assertEquals(seen[0]!.body, "");
});

Deno.test("MFA challenge returns a challenge, then verifies", async () => {
  let loginCalls = 0;
  const { fetch: fetchImpl } = mockFetch((req) => {
    if (req.url.includes("/mobile/sso/en/sign-in")) {
      return withCookies("<html/>", ["GARMIN-SSO=abc"]);
    }
    if (req.url.includes("/mobile/api/login")) {
      loginCalls++;
      return new Response(
        JSON.stringify({
          responseStatus: { type: "MFA_REQUIRED" },
          customerMfaInfo: { mfaLastMethodUsed: "email" },
        }),
        { status: 200 },
      );
    }
    if (req.url.includes("/mfa/verifyCode")) {
      return new Response(
        JSON.stringify({
          responseStatus: { type: "SUCCESSFUL" },
          serviceTicketId: "TICKET-MFA",
        }),
        { status: 200 },
      );
    }
    return new Response("?", { status: 404 });
  });
  const session = await createSession("garmin.com", {
    fetchImpl,
    consumer: CONSUMER,
  });

  const result = await beginLogin(session, "u", "p");
  assert(typeof result !== "string");
  assertEquals(result.status, "mfa_required");
  assertEquals(result.method, "email");
  assertEquals(loginCalls, 1);

  const ticket = await completeMfa(session, "123456", result.method);
  assertEquals(ticket, "TICKET-MFA");
});

Deno.test("wrong password surfaces a redacted error", async () => {
  const { fetch: fetchImpl } = mockFetch((req) => {
    if (req.url.includes("/mobile/sso/en/sign-in")) {
      return withCookies("<html/>", []);
    }
    return new Response(
      JSON.stringify({
        responseStatus: { type: "INVALID_CREDENTIALS", message: "bad user" },
      }),
      { status: 401 },
    );
  });
  const session = await createSession("garmin.com", {
    fetchImpl,
    consumer: CONSUMER,
  });
  await assertRejects(
    () => beginLogin(session, "u", "TOP-SECRET-PASSWORD"),
    GarminAuthError,
    "bad user",
  );
});

Deno.test("non-JSON SSO response mentions Cloudflare", async () => {
  const { fetch: fetchImpl } = mockFetch((req) => {
    if (req.url.includes("/mobile/sso/en/sign-in")) {
      return withCookies("<html/>", []);
    }
    return new Response("<html>Just a moment…</html>", { status: 403 });
  });
  const session = await createSession("garmin.com", {
    fetchImpl,
    consumer: CONSUMER,
  });
  await assertRejects(
    () => beginLogin(session, "u", "p"),
    GarminAuthError,
    "Cloudflare",
  );
});

Deno.test("withExpiries computes absolute times", () => {
  const t = withExpiries(
    {
      scope: "s",
      token_type: "Bearer",
      access_token: "a",
      refresh_token: "r",
      expires_in: 100,
      refresh_token_expires_in: 200,
    },
    5000,
  );
  assertEquals(t.expires_at, 5100);
  assertEquals(t.refresh_token_expires_at, 5200);
});

Deno.test("redact scrubs token-named keys recursively", () => {
  const out = redact({
    access_token: "SECRET",
    nested: { refresh_token: "SECRET2", keep: "ok" },
    list: [{ oauth_token_secret: "SECRET3" }],
  }) as Record<string, unknown>;
  assertEquals(out.access_token, "<redacted>");
  assertEquals((out.nested as Record<string, unknown>).keep, "ok");
  assertEquals(
    (out.nested as Record<string, unknown>).refresh_token,
    "<redacted>",
  );
  const list = out.list as Record<string, unknown>[];
  assertEquals(list[0]!.oauth_token_secret, "<redacted>");
});
