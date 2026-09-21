/**
 * Minimal OAuth 1.0a (RFC 5849) HMAC-SHA1 request signer.
 *
 * Garmin's `connectapi` tier authenticates API calls with an OAuth2 Bearer
 * token, but *obtaining* that token requires two OAuth1-signed requests
 * (`/oauth-service/oauth/preauthorized` and `/oauth-service/oauth/exchange/
 * user/2.0`). This module implements exactly the subset those two calls need,
 * using Deno's WebCrypto (`crypto.subtle`) rather than an npm OAuth library.
 *
 * Scope, deliberately small:
 *   - `HMAC-SHA1` only (the only method Garmin's consumer accepts).
 *   - Header-transport only (`Authorization: OAuth …`); no query/body signing.
 *   - Query-string params are parsed from the URL, not signed as a raw string.
 *
 * Everything here is pure and exported, so it is unit-testable against RFC 5849
 * known-answer vectors without touching the network.
 *
 * @module
 */

/** Credentials and token material used to sign one request. */
export interface OAuth1Credentials {
  /** Consumer (application) key. */
  consumerKey: string;
  /** Consumer (application) secret. */
  consumerSecret: string;
  /** Token from a previous step (omit for the two-legged preauthorized call). */
  token?: string;
  /** Token secret paired with {@link token}. */
  tokenSecret?: string;
}

/** Options for {@link signOAuth1}. */
export interface SignOptions {
  /** HTTP method, upper-cased (e.g. `GET`, `POST`). */
  method: string;
  /** Full request URL, including any query string. */
  url: string;
  /** `application/x-www-form-urlencoded` body params, if the request has one. */
  bodyParams?: Record<string, string>;
  /** Extra OAuth protocol params (e.g. the DI `audience` is *not* one). */
  extraOAuthParams?: Record<string, string>;
  /** Override the nonce (tests only). */
  nonce?: string;
  /** Override the timestamp in seconds (tests only). */
  timestamp?: number;
}

/**
 * RFC 3986 percent-encoding, as required by RFC 5849 §3.6.
 *
 * Encodes everything except the unreserved set `A-Z a-z 0-9 - . _ ~`. This
 * differs from `encodeURIComponent` in that `!`, `*`, `'`, `(`, `)` also get
 * encoded — which matters because Garmin's ticket strings contain characters
 * that `encodeURIComponent` would otherwise leave intact.
 */
export function percentEncode(input: string): string {
  return encodeURIComponent(input).replace(
    /[!*'()]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

/** Hex-encoded random bytes of the given length, for the OAuth nonce. */
function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Base64-encode an ArrayBuffer. */
function base64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = "";
  for (const b of view) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** HMAC-SHA1 of `message` under `key`, returned base64-encoded. */
export async function hmacSha1(
  key: string,
  message: string,
): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    new TextEncoder().encode(message),
  );
  return base64(sig);
}

/**
 * Build the RFC 5849 §3.4.1 signature base string:
 *
 *     METHOD & percentEncode(baseUrl) & percentEncode(normalizedParams)
 *
 * `baseUrl` has its query string and fragment stripped. Params are sorted by
 * encoded key, then encoded value.
 */
export function buildBaseString(
  method: string,
  url: string,
  params: [string, string][],
): string {
  const u = new URL(url);
  const baseUrl = `${u.origin}${u.pathname}`;

  const encoded = params
    .map(([k, v]) => [percentEncode(k), percentEncode(v)] as [string, string])
    .sort((
      a,
      b,
    ) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : (a[0] < b[0] ? -1 : 1)));

  const normalized = encoded.map(([k, v]) => `${k}=${v}`).join("&");
  return [
    method.toUpperCase(),
    percentEncode(baseUrl),
    percentEncode(normalized),
  ].join("&");
}

/** Collect query params from a URL (duplicates preserved). */
function queryParams(url: string): [string, string][] {
  const u = new URL(url);
  const out: [string, string][] = [];
  u.searchParams.forEach((v, k) => out.push([k, v]));
  return out;
}

/**
 * Sign a request and return the `Authorization` header value.
 *
 * The OAuth protocol params (`oauth_consumer_key`, `oauth_nonce`,
 * `oauth_signature_method`, `oauth_timestamp`, `oauth_version`, `oauth_token`)
 * are merged with the query and body params for the base string, then the
 * header carries the protocol params plus the computed `oauth_signature`.
 * Non-OAuth query/body params are *not* echoed in the header (header transport
 * only), matching what Garmin's consumer expects.
 */
export async function signOAuth1(
  creds: OAuth1Credentials,
  opts: SignOptions,
): Promise<string> {
  const method = opts.method.toUpperCase();
  const oauthParams: [string, string][] = [
    ["oauth_consumer_key", creds.consumerKey],
    ["oauth_nonce", opts.nonce ?? randomHex(16)],
    ["oauth_signature_method", "HMAC-SHA1"],
    [
      "oauth_timestamp",
      String(opts.timestamp ?? Math.floor(Date.now() / 1000)),
    ],
    ["oauth_version", "1.0"],
  ];
  if (creds.token) oauthParams.push(["oauth_token", creds.token]);
  for (const [k, v] of Object.entries(opts.extraOAuthParams ?? {})) {
    oauthParams.push([k, v]);
  }

  const bodyParams = Object.entries(opts.bodyParams ?? {});
  const allParams: [string, string][] = [
    ...oauthParams,
    ...queryParams(opts.url),
    ...bodyParams,
  ];

  const baseString = buildBaseString(method, opts.url, allParams);
  const signingKey = `${percentEncode(creds.consumerSecret)}&${
    percentEncode(creds.tokenSecret ?? "")
  }`;
  const signature = await hmacSha1(signingKey, baseString);

  const headerParams = [
    ...oauthParams,
    ["oauth_signature", signature] as [string, string],
  ]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${percentEncode(k)}="${percentEncode(v)}"`);

  return `OAuth ${headerParams.join(", ")}`;
}
