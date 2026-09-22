/**
 * Tests for the transport's login flow, focused on the two-run MFA handshake.
 *
 * The bug this locks in: swamp runs each model method in a fresh process, so an
 * MFA resume builds a *new* SSO session. Garmin's `/mfa/verifyCode` acts on the
 * session the password step established, so the cookie jar must survive between
 * runs — it is persisted in the `pending-mfa` resource and restored on resume.
 *
 * The tests drive the model's real `login` method with `globalThis.fetch`
 * stubbed, so the production path is exercised end to end with no network and no
 * credentials.
 *
 * @module
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { model } from "./garmin_connect.ts";

/** The production `login` method's execute entry point. */
const login = model.methods.login.execute;

/**
 * A tiny in-memory stand-in for the swamp method context.
 *
 * `writeResource` mimics swamp: it records the payload so a later run can read
 * it back, which is exactly how the pending-MFA handshake works.
 */
function fakeContext(globalArgs: Record<string, unknown> = {}) {
  const resources = new Map<string, Record<string, unknown>>();
  const logs: string[] = [];
  return {
    resources,
    logs,
    ctx: {
      globalArgs: {
        domain: "garmin.com",
        vaultName: "garmin-secrets",
        usernameKey: "GARMIN_EMAIL",
        passwordKey: "GARMIN_PASSWORD",
        mfaCodeKey: "GARMIN_MFA_CODE",
        tokenStoreKey: "GARMIN_TOKEN_STORE",
        username: "user@example.com",
        password: "hunter2",
        ...globalArgs,
      },
      logger: {
        info: (m: string, p?: Record<string, unknown>) =>
          logs.push(`${m} ${p ? JSON.stringify(p) : ""}`),
        debug: () => {},
        warn: () => {},
      },
      readResource: (name: string) =>
        Promise.resolve(resources.get(name) ?? null),
      writeResource: (
        _spec: string,
        name: string,
        data: Record<string, unknown>,
      ) => {
        resources.set(name, data);
        return Promise.resolve({ name });
      },
      createFileWriter: () => ({
        writeAll: () => Promise.resolve({ name: "f" }),
        writeText: () => Promise.resolve({ name: "f" }),
      }),
    },
  };
}

/** A routing mock Garmin, recording the cookie sent to verifyCode. */
function garminFetch(state: {
  verifyCookie: string | null;
  loginCalls: number;
}): typeof fetch {
  const route = (input: RequestInfo | URL, init?: RequestInit): Response => {
    const url = typeof input === "string" ? input : input.toString();
    const headers = new Headers(init?.headers);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    // The OAuth consumer file the auth module fetches on first use.
    if (url.includes("oauth_consumer.json")) {
      return json({ consumer_key: "ck", consumer_secret: "cs" });
    }
    if (url.includes("/mobile/sso/en/sign-in")) {
      return new Response("<html/>", {
        status: 200,
        headers: { "set-cookie": "GARMIN-SSO=abc; Path=/" },
      });
    }
    if (url.includes("/mobile/api/login")) {
      state.loginCalls++;
      const res = json({
        responseStatus: { type: "MFA_REQUIRED" },
        customerMfaInfo: { mfaLastMethodUsed: "email" },
      });
      res.headers.append("set-cookie", "GARMIN-SSO=abc; Path=/");
      return res;
    }
    if (url.includes("/mfa/verifyCode")) {
      state.verifyCookie = headers.get("cookie");
      return json({
        responseStatus: { type: "SUCCESSFUL" },
        serviceTicketId: "TICKET-MFA",
      });
    }
    if (url.includes("/oauth-service/oauth/preauthorized")) {
      return new Response("oauth_token=OT&oauth_token_secret=OS", {
        status: 200,
      });
    }
    if (url.includes("/exchange/user/2.0")) {
      return json({
        scope: "s",
        token_type: "Bearer",
        access_token: "AT",
        refresh_token: "RT",
        expires_in: 3600,
        refresh_token_expires_in: 7200,
      });
    }
    if (url.includes("/socialProfile")) {
      return json({ displayName: "rider-42", fullName: "Test Rider" });
    }
    return new Response("?", { status: 404 });
  };
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(route(input, init))) as typeof fetch;
}

/** Install a mock fetch for the duration of a test body. */
async function withFetch(
  state: { verifyCookie: string | null; loginCalls: number },
  body: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  // deno-lint-ignore no-explicit-any
  (globalThis as any).fetch = garminFetch(state);
  try {
    await body();
  } finally {
    // deno-lint-ignore no-explicit-any
    (globalThis as any).fetch = original;
  }
}

/** Assert a promise rejects with a message matching `re`. */
async function rejects(fn: () => Promise<unknown>, re: RegExp): Promise<void> {
  let caught: unknown;
  try {
    await fn();
  } catch (err) {
    caught = err;
  }
  assert(caught instanceof Error, `expected a rejection matching ${re}`);
  assert(
    re.test((caught as Error).message),
    `error "${(caught as Error).message}" did not match ${re}`,
  );
}

Deno.test("login: password → MFA challenge persists the cookie jar", async () => {
  const state = { verifyCookie: null, loginCalls: 0 };
  const { ctx, resources } = fakeContext();
  await withFetch(state, async () => {
    await rejects(() => login({}, ctx as never), /requires MFA/);
  });

  const pending = resources.get("pending-mfa")!;
  assertEquals(pending.consumed, false);
  assertEquals(pending.method, "email");
  const jar = JSON.parse(pending.cookieJar as string);
  assert(jar["sso.garmin.com"], "jar holds the SSO host cookies");
});

Deno.test("login: MFA resume across runs carries the cookies and signs in", async () => {
  const state = { verifyCookie: null, loginCalls: 0 };

  // Run 1 — raises the challenge and persists the jar.
  const run1 = fakeContext();
  await withFetch(state, async () => {
    await rejects(() => login({}, run1.ctx as never), /requires MFA/);
  });
  const savedJar = run1.resources.get("pending-mfa")!.cookieJar as string;

  // Run 2 — a *fresh* context (new process), seeded with run 1's pending-mfa.
  const run2 = fakeContext();
  run2.resources.set("pending-mfa", {
    challengedAt: "2026-01-01T00:00:00.000Z",
    domain: "garmin.com",
    method: "email",
    cookieJar: savedJar,
    consumed: false,
  });

  await withFetch(state, async () => {
    const result = await login({ interactiveMfa: "123456" }, run2.ctx as never);
    assertEquals(result.dataHandles.length, 1);
  });

  // verifyCode received the SSO cookie restored from run 1 — the whole point.
  assertEquals(state.verifyCookie, "GARMIN-SSO=abc");

  // A session was written and the pending challenge marked consumed.
  const session = run2.resources.get("session-auth")!;
  assertEquals(session.via, "mfa resume");
  assertEquals(session.displayName, "rider-42");
  assertEquals(run2.resources.get("pending-mfa")!.consumed, true);
});

Deno.test("login: resume with no pending challenge fails clearly", async () => {
  const { ctx } = fakeContext();
  const state = { verifyCookie: null, loginCalls: 0 };
  await withFetch(state, async () => {
    await rejects(
      () => login({ interactiveMfa: "123456" }, ctx as never),
      /No suspended MFA login/,
    );
  });
});

Deno.test("login: password path rejects when no credentials", async () => {
  const { ctx } = fakeContext({ username: "", password: "" });
  const state = { verifyCookie: null, loginCalls: 0 };
  await withFetch(state, async () => {
    await rejects(() => login({}, ctx as never), /credentials missing/);
  });
});
