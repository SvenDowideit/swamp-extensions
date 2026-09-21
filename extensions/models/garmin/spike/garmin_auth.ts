/**
 * Garmin Connect authentication — SSO → OAuth1 → OAuth2, plus token refresh and
 * an authenticated `connectapi` GET.
 *
 * This is the spike-grade proof of the transport layer planned in `../PLAN.md`.
 * It ports the flow documented by `garth` (`sso.py`, `http.py`) to Deno using
 * only `fetch` and WebCrypto — no npm OAuth library:
 *
 *   1. Prime SSO cookies (browser-like GET).
 *   2. `POST /mobile/api/login` (Android client id) → service ticket, or MFA.
 *   3. Exchange the ticket for an OAuth1 token (signed, two-legged GET).
 *   4. Exchange the OAuth1 token for the DI OAuth2 bearer token.
 *   5. Refresh the bearer token with no user interaction.
 *
 * Secrets are never logged. The public {@link redact} helper scrubs token-named
 * keys from anything that might be persisted or printed.
 *
 * @module
 */
import { type OAuth1Credentials, signOAuth1 } from "./oauth1.ts";

/** Base host of the Garmin Connect API tier. */
export const CONNECTAPI_HOST = "connectapi.garmin.com";
/** Host of the SSO (login) service. */
export const SSO_HOST = "sso.garmin.com";
/** Android app SSO client id — must match the OAuth consumer key below. */
export const CLIENT_ID = "GCM_ANDROID_DARK";
/** OAuth consumer key/secret file published by the `garth` project. */
export const OAUTH_CONSUMER_URL =
  "https://thegarth.s3.amazonaws.com/oauth_consumer.json";
/** DI audience required when *first* exchanging OAuth1 → OAuth2. */
export const DI_AUDIENCE = "GARMIN_CONNECT_MOBILE_ANDROID_DI";

const SSO_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) " +
  "AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const OAUTH_UA = { "User-Agent": "com.garmin.android.apps.connectmobile" };
/** API-tier user agent, matching garth's `GCM-iOS-5.22.1.4`. */
export const API_UA = "GCM-iOS-5.22.1.4";

/** OAuth1 token as returned by the preauthorized endpoint. */
export interface OAuth1Token {
  /** OAuth1 token (acts as the username half of the pair). */
  oauth_token: string;
  /** OAuth1 token secret (the secret half). */
  oauth_token_secret: string;
  /** Region domain, e.g. `garmin.com`. */
  domain: string;
}

/** OAuth2 (DI) bearer token returned by the exchange endpoint. */
export interface OAuth2Token {
  /** Granted scope. */
  scope: string;
  /** Token type, always `Bearer`. */
  token_type: string;
  /** Short-lived access token for `Authorization: Bearer …`. */
  access_token: string;
  /** Long-lived refresh token. */
  refresh_token: string;
  /** Access-token lifetime, seconds. */
  expires_in: number;
  /** Access-token absolute expiry, epoch seconds. */
  expires_at: number;
  /** Refresh-token lifetime, seconds. */
  refresh_token_expires_in: number;
  /** Refresh-token absolute expiry, epoch seconds. */
  refresh_token_expires_at: number;
}

/** Raised when Garmin rejects credentials, a ticket, or a token. */
export class GarminAuthError extends Error {
  /** HTTP status, when the failure came from a response. */
  readonly status: number | null;
  /** Create an auth error with an optional upstream status. */
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "GarminAuthError";
    this.status = status;
  }
}

/** Public OAuth consumer credentials from the S3 file. */
export interface OAuthConsumer {
  consumer_key: string;
  consumer_secret: string;
}

/** Result of an MFA challenge that needs a code before login can complete. */
export interface MfaChallenge {
  /** Discriminator. */
  status: "mfa_required";
  /** MFA method Garmin reported (e.g. `email`). */
  method: string;
}

/** A minimal cookie jar, scoped per host. */
class CookieJar {
  #byHost = new Map<string, Map<string, string>>();

  /** Capture `Set-Cookie` headers from a response. */
  capture(url: string, res: Response): void {
    const host = new URL(url).host;
    const jar = this.#byHost.get(host) ?? new Map<string, string>();
    // Deno exposes combined Set-Cookie via getSetCookie().
    for (const cookie of res.headers.getSetCookie()) {
      const pair = cookie.split(";")[0]!;
      const eq = pair.indexOf("=");
      if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    this.#byHost.set(host, jar);
  }

  /** Header value for a request to `url`, or `""` when none apply. */
  header(url: string): string {
    const jar = this.#byHost.get(new URL(url).host);
    if (!jar || jar.size === 0) return "";
    return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

/** Injected dependencies, so the flow is testable without the network. */
export interface AuthDeps {
  /** `fetch` implementation (defaults to the global). */
  fetchImpl?: typeof fetch;
  /** OAuth consumer creds (defaults to fetching {@link OAUTH_CONSUMER_URL}). */
  consumer?: OAuthConsumer;
  /** Clock override (tests). */
  now?: () => number;
}

/** Fetch the public OAuth consumer key/secret. */
export async function fetchConsumer(
  fetchImpl: typeof fetch = fetch,
): Promise<OAuthConsumer> {
  const res = await fetchImpl(OAUTH_CONSUMER_URL);
  if (!res.ok) {
    throw new GarminAuthError(
      `could not fetch OAuth consumer (HTTP ${res.status})`,
      res.status,
    );
  }
  const body = await res.json() as OAuthConsumer;
  if (!body.consumer_key || !body.consumer_secret) {
    throw new GarminAuthError("OAuth consumer file missing key/secret");
  }
  return body;
}

/** Encode `obj` as an `application/x-www-form-urlencoded` string. */
function formEncode(obj: Record<string, string>): string {
  return new URLSearchParams(obj).toString();
}

/** Parse a `application/x-www-form-urlencoded` body into a flat map. */
export function parseForm(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(body)) out[k] = v;
  return out;
}

/** The SSO login params shared by every `/mobile/api/*` call. */
function loginParams(domain: string): Record<string, string> {
  return {
    clientId: CLIENT_ID,
    locale: "en-US",
    service: `https://mobile.integration.${domain}/gcm/android`,
  };
}

/** A mutable login session carrying the cookie jar and consumer creds. */
export interface AuthSession {
  /** The cookie jar in play. */
  jar: CookieJar;
  /** Resolved OAuth consumer creds. */
  consumer: OAuthConsumer;
  /** Region domain. */
  domain: string;
  /** `fetch`. */
  fetchImpl: typeof fetch;
  /** Clock. */
  now: () => number;
  /** SSO login params for the region. */
  params: Record<string, string>;
}

/** Build an {@link AuthSession}, resolving the consumer creds. */
export async function createSession(
  domain = "garmin.com",
  deps: AuthDeps = {},
): Promise<AuthSession> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const consumer = deps.consumer ?? await fetchConsumer(fetchImpl);
  return {
    jar: new CookieJar(),
    consumer,
    domain,
    fetchImpl,
    now: deps.now ?? (() => Date.now()),
    params: loginParams(domain),
  };
}

/**
 * Start a login: prime SSO cookies, POST credentials.
 *
 * Returns the service ticket string on success, or an
 * {@link MfaChallenge} when Garmin demands a second factor. Never includes the
 * password in any error.
 */
export async function beginLogin(
  session: AuthSession,
  username: string,
  password: string,
): Promise<string | MfaChallenge> {
  // 1. Prime cookies so the POST looks like a browser flow.
  const signInUrl =
    `https://${SSO_HOST}/mobile/sso/en/sign-in?clientId=${CLIENT_ID}`;
  const prime = await session.fetchImpl(signInUrl, {
    headers: {
      "User-Agent": SSO_UA,
      "Accept":
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
    },
  }).catch((err) => {
    throw new GarminAuthError(`SSO priming failed: ${(err as Error).message}`);
  });
  session.jar.capture(signInUrl, prime);

  // 2. Submit credentials.
  const loginUrl = `https://${SSO_HOST}/mobile/api/login?${
    formEncode(session.params)
  }`;
  const res = await session.fetchImpl(loginUrl, {
    method: "POST",
    headers: {
      "User-Agent": SSO_UA,
      "Accept": "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9",
      "Content-Type": "application/json",
      ...(session.jar.header(loginUrl)
        ? { Cookie: session.jar.header(loginUrl) }
        : {}),
    },
    body: JSON.stringify({
      username,
      password,
      rememberMe: false,
      captchaToken: "",
    }),
  }).catch((err) => {
    throw new GarminAuthError(`SSO login failed: ${(err as Error).message}`);
  });
  session.jar.capture(loginUrl, res);

  const text = await res.text();
  let json: {
    responseStatus?: { type?: string; message?: string };
    serviceTicketId?: string;
    customerMfaInfo?: { mfaLastMethodUsed?: string };
  } = {};
  try {
    json = JSON.parse(text);
  } catch {
    throw new GarminAuthError(
      `SSO returned non-JSON (HTTP ${res.status}) — likely a Cloudflare ` +
        `challenge or a changed endpoint: ${text.slice(0, 160)}`,
      res.status,
    );
  }

  const type = json.responseStatus?.type;
  if (!res.ok && !type) {
    throw new GarminAuthError(
      `SSO login failed (HTTP ${res.status})`,
      res.status,
    );
  }
  if (type === "MFA_REQUIRED") {
    return {
      status: "mfa_required",
      method: json.customerMfaInfo?.mfaLastMethodUsed ?? "email",
    };
  }
  if (type !== "SUCCESSFUL" || !json.serviceTicketId) {
    const detail = json.responseStatus?.message ?? type ?? "unknown";
    throw new GarminAuthError(
      `SSO login rejected: ${detail} (HTTP ${res.status})`,
      res.status,
    );
  }
  return json.serviceTicketId;
}

/** Complete an MFA challenge with a one-time code, returning the ticket. */
export async function completeMfa(
  session: AuthSession,
  code: string,
  method = "email",
): Promise<string> {
  const url = `https://${SSO_HOST}/mobile/api/mfa/verifyCode?${
    formEncode(session.params)
  }`;
  const res = await session.fetchImpl(url, {
    method: "POST",
    headers: {
      "User-Agent": SSO_UA,
      "Accept": "application/json, text/plain, */*",
      "Content-Type": "application/json",
      ...(session.jar.header(url) ? { Cookie: session.jar.header(url) } : {}),
    },
    body: JSON.stringify({
      mfaMethod: method,
      mfaVerificationCode: code,
      rememberMyBrowser: false,
      reconsentList: [],
      mfaSetup: false,
    }),
  }).catch((err) => {
    throw new GarminAuthError(`MFA verify failed: ${(err as Error).message}`);
  });
  session.jar.capture(url, res);

  const json = await res.json() as {
    responseStatus?: { type?: string; message?: string };
    serviceTicketId?: string;
  };
  if (json.responseStatus?.type !== "SUCCESSFUL" || !json.serviceTicketId) {
    throw new GarminAuthError(
      `MFA rejected: ${json.responseStatus?.message ?? "unknown"} ` +
        `(HTTP ${res.status})`,
      res.status,
    );
  }
  return json.serviceTicketId;
}

/**
 * Exchange a service ticket for an OAuth1 token (two-legged signed GET).
 *
 * Uses header-transport OAuth1 with no token — the ticket in the query string
 * is the grant.
 */
export async function getOAuth1Token(
  session: AuthSession,
  ticket: string,
): Promise<OAuth1Token> {
  const loginUrl = `https://mobile.integration.${session.domain}/gcm/android`;
  const url = `https://${CONNECTAPI_HOST}/oauth-service/oauth/preauthorized?${
    formEncode({
      ticket,
      "login-url": loginUrl,
      "accepts-mfa-tokens": "true",
    })
  }`;
  const creds: OAuth1Credentials = {
    consumerKey: session.consumer.consumer_key,
    consumerSecret: session.consumer.consumer_secret,
  };
  const auth = await signOAuth1(creds, { method: "GET", url });

  const res = await session.fetchImpl(url, {
    headers: { ...OAUTH_UA, Authorization: auth },
  }).catch((err) => {
    throw new GarminAuthError(
      `OAuth1 preauthorized failed: ${(err as Error).message}`,
    );
  });
  const text = await res.text();
  if (!res.ok) {
    throw new GarminAuthError(
      `OAuth1 preauthorized failed (HTTP ${res.status}): ${text.slice(0, 160)}`,
      res.status,
    );
  }
  const parsed = parseForm(text);
  if (!parsed.oauth_token || !parsed.oauth_token_secret) {
    throw new GarminAuthError("OAuth1 response missing token pair");
  }
  return {
    oauth_token: parsed.oauth_token,
    oauth_token_secret: parsed.oauth_token_secret,
    domain: session.domain,
  };
}

/** Set absolute expiries on a raw OAuth2 token response. */
export function withExpiries(
  raw:
    & { expires_in: number; refresh_token_expires_in: number }
    & Record<
      string,
      unknown
    >,
  nowSeconds: number,
): OAuth2Token {
  return {
    scope: String(raw.scope ?? ""),
    token_type: String(raw.token_type ?? "Bearer"),
    access_token: String(raw.access_token ?? ""),
    refresh_token: String(raw.refresh_token ?? ""),
    expires_in: raw.expires_in,
    expires_at: nowSeconds + raw.expires_in,
    refresh_token_expires_in: raw.refresh_token_expires_in,
    refresh_token_expires_at: nowSeconds + raw.refresh_token_expires_in,
  };
}

/**
 * Exchange an OAuth1 token for an OAuth2 bearer token.
 *
 * `login` adds the DI audience, which Garmin requires for the *first* exchange;
 * a refresh omits it. The body params are part of the OAuth1 signature.
 */
export async function exchangeOAuth2(
  session: AuthSession,
  oauth1: OAuth1Token,
  login: boolean,
): Promise<OAuth2Token> {
  const url =
    `https://${CONNECTAPI_HOST}/oauth-service/oauth/exchange/user/2.0`;
  const bodyParams: Record<string, string> = login
    ? { audience: DI_AUDIENCE }
    : {};
  const creds: OAuth1Credentials = {
    consumerKey: session.consumer.consumer_key,
    consumerSecret: session.consumer.consumer_secret,
    token: oauth1.oauth_token,
    tokenSecret: oauth1.oauth_token_secret,
  };
  const auth = await signOAuth1(creds, {
    method: "POST",
    url,
    bodyParams,
  });

  const res = await session.fetchImpl(url, {
    method: "POST",
    headers: {
      ...OAUTH_UA,
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: auth,
    },
    body: formEncode(bodyParams),
  }).catch((err) => {
    throw new GarminAuthError(
      `OAuth2 exchange failed: ${(err as Error).message}`,
    );
  });
  const text = await res.text();
  if (!res.ok) {
    throw new GarminAuthError(
      `OAuth2 exchange failed (HTTP ${res.status}): ${text.slice(0, 160)}`,
      res.status,
    );
  }
  const raw = JSON.parse(text) as {
    expires_in: number;
    refresh_token_expires_in: number;
  } & Record<string, unknown>;
  if (!raw.access_token) {
    throw new GarminAuthError("OAuth2 response missing access_token");
  }
  return withExpiries(raw, Math.floor((session.now?.() ?? Date.now()) / 1000));
}

/** Authenticated GET of a `connectapi` path, returning parsed JSON. */
export async function connectapiGet(
  session: AuthSession,
  oauth2: OAuth2Token,
  path: string,
): Promise<unknown> {
  const url = `https://${CONNECTAPI_HOST}${
    path.startsWith("/") ? "" : "/"
  }${path}`;
  const res = await session.fetchImpl(url, {
    headers: {
      "User-Agent": API_UA,
      Authorization: `Bearer ${oauth2.access_token}`,
      Accept: "application/json",
    },
  }).catch((err) => {
    throw new GarminAuthError(
      `GET ${path} failed: ${(err as Error).message}`,
    );
  });
  const text = await res.text();
  if (!res.ok) {
    throw new GarminAuthError(
      `GET ${path} failed (HTTP ${res.status}): ${text.slice(0, 200)}`,
      res.status,
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new GarminAuthError(`GET ${path} returned non-JSON`);
  }
}

/** True when the access token is still usable, with a safety margin. */
export function bearerUsable(
  token: OAuth2Token,
  nowSeconds: number,
  skewSeconds = 60,
): boolean {
  return Boolean(token.access_token) &&
    token.expires_at - skewSeconds > nowSeconds;
}

/** Keys whose values must never reach a log, an error, or stored data. */
export const SECRET_KEYS = [
  "access_token",
  "refresh_token",
  "oauth_token",
  "oauth_token_secret",
  "password",
  "mfaVerificationCode",
];

/** Deep-copy `value`, replacing any secret-named key with `<redacted>`. */
export function redact(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEYS.includes(k) ? "<redacted>" : redact(v);
  }
  return out;
}
