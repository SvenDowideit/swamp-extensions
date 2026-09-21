# Garmin Connect auth spike (Phase 0)

Proof of the riskiest part of `@svendowideit/garmin`: obtaining and refreshing a
Garmin Connect bearer token from Deno, using only `fetch` and WebCrypto — no npm
OAuth library, no Python.

See `../PLAN.md` for the full design. This directory is a spike, **not** a
published extension — it is not listed in any manifest and ships no models.

## What it proves

| Area | Status |
| ---- | ------ |
| OAuth1 (RFC 5849) HMAC-SHA1 signing in Deno | ✅ verified against an independent HMAC computation |
| SSO `/mobile/api/login` reachability + cookie priming | ✅ live-probed (HTTP 400 on empty creds, not a Cloudflare block) |
| Full flow wiring: SSO → OAuth1 → OAuth2 → `connectapi` GET | ✅ offline, with a routing mock `fetch` |
| MFA challenge / resume | ✅ offline |
| Token refresh (no DI audience, no credentials) | ✅ offline |
| Error surface never leaks a secret | ✅ unit-tested |
| Binary file writer (`writeAll(Uint8Array)`, `writeStream`) | ✅ confirmed in the swamp binary |

## Files

| File | Purpose |
| ---- | ------- |
| `oauth1.ts` | OAuth1 signer: percent-encoding, base string, HMAC-SHA1, header assembly. Pure. |
| `oauth1_test.ts` | RFC 5849 §3.4.1.1 base-string vector + HMAC vectors + determinism. |
| `garmin_auth.ts` | SSO login, MFA, OAuth1 preauthorized, OAuth2 exchange/refresh, `connectapiGet`, redaction. |
| `garmin_auth_test.ts` | Offline end-to-end flow, MFA, refresh, error and redaction tests. |
| `login.ts` | CLI that performs a real login and writes token files. |

## Run the tests (no network, no credentials)

```sh
# All spike tests. jsr.io is needed only to fetch @std/assert.
~/.swamp/deno/deno test --allow-net=jsr.io oauth1_test.ts garmin_auth_test.ts
```

## Run a real login

```sh
# Interactive prompt for the password (not echoed). MFA is handled by re-running
# with --mfa once the first attempt reports MFA_REQUIRED.
~/.swamp/deno/deno run \
  --allow-net=thegarth.s3.amazonaws.com,sso.garmin.com,connectapi.garmin.com \
  --allow-read --allow-write=$HOME/.garminconnect --allow-env \
  login.ts --out ~/.garminconnect

# If MFA is required:
~/.swamp/deno/deno run -A login.ts --out ~/.garminconnect --mfa 123456

# On success it prints the authenticated display name and writes
# oauth1_token.json + oauth2_token.json (mode 0600) to --out.
```

For a non-interactive run, set `GARMIN_EMAIL` and `GARMIN_PASSWORD` in the
environment. Prefer the interactive prompt or a secret manager — an exported
password is a leaked password.

## Design notes

- **OAuth1 header transport only.** Garmin's consumer signs with the
  `Authorization` header; query/body params feed the base string but are not
  echoed in the header.
- **The refresh path is what makes scheduled runs viable.** First login needs
  credentials (+ MFA); thereafter `exchangeOAuth2(..., login: false)` mints a
  new bearer token from the stored OAuth1 token with no interaction.
- **A full credential login also yields tokens that can be imported**, so a
  future model can avoid ever handling a password on the host — seed a
  `garth`/spike token store once, then only ever refresh.
- **`redact()` is the single choke point** for anything logged or persisted;
  token-named keys become `<redacted>`.

## What this spike does NOT prove

- A **live end-to-end login** (needs your credentials + a real MFA exchange).
- **Cloudflare behaviour under a real login** from an unusual IP. The priming
  GET works now, but Garmin has rate-limited and challenged logins historically;
  the transport must handle 429 and non-JSON responses (it does, with a clear
  message).
- **Rate limits on the API tier.** Pacing/retry (planned in `../PLAN.md` §8.5)
  is not implemented here.

## Next

Phase 1: wrap this flow in `@svendowideit/garmin-connect` (transport model) with
cache, pacing, `fetch`/`fetch-many`/`download`, the `garmin-session` workflow,
and `setup` — then a live smoke test with a real account.
