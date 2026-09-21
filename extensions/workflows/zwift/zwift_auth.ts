/**
 * Shared Zwift authentication for the `@svendowideit/zwift` extension.
 *
 * Zwift's backend is undocumented. Authentication is a Keycloak password or
 * refresh-token grant against the `Developer Client` client, which yields a
 * short-lived access token plus a long-lived refresh token. This module owns
 * that exchange so both models (`zwift-rider` and `zwift-events`) share one
 * implementation and one error surface.
 *
 * Credentials are never hard-coded. The caller supplies either explicit
 * username/password values (normally `${{ vault.get(...) }}` expressions) or a
 * stored refresh token; both password and refresh-token grants are supported so
 * a user who already has a refresh token never has to expose a password.
 *
 * @module
 */

/** Base URL of Zwift's Keycloak realm. */
export const DEFAULT_AUTH_BASE = "https://secure.zwift.com";

/** Base URL of Zwift's REST API gateway. */
export const DEFAULT_API_BASE = "https://us-or-rly101.zwift.com";

/** Client id the Zwift companion/mobile app authenticates as. */
export const PUBLIC_CLIENT_ID = "Developer Client";

/** The legacy password-grant endpoint. Still accepts `Developer Client`. */
const LEGACY_TOKEN_PATH = "/auth/realms/zwift/tokens/access/codes";

/** Result of a successful token exchange. Tokens must never be logged. */
export interface ZwiftTokens {
  /** Bearer token for API calls. */
  accessToken: string;
  /** Long-lived token used to mint future access tokens. */
  refreshToken: string | null;
  /** Access-token lifetime in seconds. */
  expiresIn: number | null;
  /** Epoch ms at which the access token expires. */
  expiresAt: number;
  /** Granted scope string, if returned. */
  scope: string | null;
}

/** Raised when Zwift rejects the supplied credentials or token. */
export class ZwiftAuthError extends Error {
  /** HTTP status returned by the auth endpoint, when there was one. */
  readonly status: number | null;

  /** Create an auth error with an optional upstream status. */
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "ZwiftAuthError";
    this.status = status;
  }
}

/** Credentials accepted by {@link getAccessToken}. */
export interface AuthInput {
  /** Zwift account email/username (password grant). */
  username?: string;
  /** Zwift account password (password grant). */
  password?: string;
  /** A previously obtained refresh token (preferred over a password). */
  refreshToken?: string;
  /** Override the Keycloak base URL. */
  authBase?: string;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
}

/** Shape of the Keycloak token response that this module reads. */
interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

/**
 * True when `tokens` are still usable, with a safety margin so a token never
 * expires mid-request. A missing/zero `expiresIn` is treated as "unknown" and
 * therefore usable — Zwift's refresh-derived access tokens can be very long
 * lived.
 */
export function tokensUsable(tokens: ZwiftTokens, skewMs = 30_000): boolean {
  if (!tokens.accessToken) return false;
  if (!Number.isFinite(tokens.expiresAt)) return true;
  return tokens.expiresAt - skewMs > Date.now();
}

/**
 * Exchange a password or refresh token for an access token.
 *
 * A refresh token is preferred when both are supplied: it is the safer,
 * longer-lived credential and does not require storing a password. Throws a
 * {@link ZwiftAuthError} carrying Keycloak's own reason (never the credentials).
 */
export async function getAccessToken(input: AuthInput): Promise<ZwiftTokens> {
  const authBase = (input.authBase ?? DEFAULT_AUTH_BASE).replace(/\/+$/, "");
  const doFetch = input.fetchImpl ?? fetch;
  const url = `${authBase}${LEGACY_TOKEN_PATH}`;

  const form = new URLSearchParams({ client_id: PUBLIC_CLIENT_ID });
  if (input.refreshToken) {
    form.set("grant_type", "refresh_token");
    form.set("refresh_token", input.refreshToken);
  } else if (input.username && input.password) {
    form.set("grant_type", "password");
    form.set("username", input.username);
    form.set("password", input.password);
  } else {
    throw new ZwiftAuthError(
      "no credentials: supply username + password, or a refresh token",
    );
  }

  let res: Response;
  try {
    res = await doFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
  } catch (err) {
    throw new ZwiftAuthError(`auth request failed: ${(err as Error).message}`);
  }

  const text = await res.text();
  let body: TokenResponse = {};
  try {
    body = JSON.parse(text) as TokenResponse;
  } catch {
    // Keycloak returns HTML on some gateway failures; keep a short excerpt.
    body = { error: text.slice(0, 120) };
  }

  if (!res.ok || !body.access_token) {
    const detail = body.error_description || body.error || "no access token";
    throw new ZwiftAuthError(
      `Zwift sign-in failed (HTTP ${res.status}) — ${detail}`,
      res.status,
    );
  }

  const expiresIn = typeof body.expires_in === "number"
    ? body.expires_in
    : null;
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? null,
    expiresIn,
    expiresAt: expiresIn === null
      ? Number.POSITIVE_INFINITY
      : Date.now() + expiresIn * 1000,
    scope: body.scope ?? null,
  };
}

/** Session facts with no token material in them, safe to log or persist. */
export function describeTokens(tokens: ZwiftTokens): {
  expiresIn: number | null;
  expiresAt: string | null;
  scope: string | null;
  hasRefreshToken: boolean;
} {
  return {
    expiresIn: tokens.expiresIn,
    expiresAt: Number.isFinite(tokens.expiresAt)
      ? new Date(tokens.expiresAt).toISOString()
      : null,
    scope: tokens.scope,
    hasRefreshToken: tokens.refreshToken !== null,
  };
}

/** Keys whose values must never reach a log, an error, or stored data. */
export const SECRET_KEYS = [
  "access_token",
  "refresh_token",
  "id_token",
  "password",
  "accessToken",
  "refreshToken",
];

/**
 * Deep-copy `value`, replacing any secret-named key with `<redacted>`. Used on
 * any response echoed into a resource so a credential can never be persisted.
 */
export function redact(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEYS.includes(k) ? "<redacted>" : redact(v);
  }
  return out;
}
