# @svendowideit/garmin-connect

The authenticated transport layer under the `@svendowideit/garmin` extension
family. It owns the single hardest part of talking to Garmin Connect — the
signed OAuth1 login, the rotating OAuth2 bearer token, and the rate limits — so
that every Garmin data model you build reads a cached response instead of
re-implementing authentication.

This is **Phase 1** of the plan in [`PLAN.md`](./PLAN.md). It ships the
transport model and the common session workflow; the domain models
(`garmin-activities`, `garmin-health`, `garmin-devices`, …) come next and will
depend on this extension.

## What it does

Garmin Connect has no public API. Gaining access requires an SSO login, an
OAuth1-signed exchange, and an OAuth2 bearer token that expires within hours;
the API also rate-limits (HTTP 429) and sits behind Cloudflare. Doing that once
per data domain is fragile and wasteful. This extension does it once and exposes
safe, cache-first primitives:

- **`login`** — the full SSO → OAuth1 → OAuth2 chain, MFA-aware, credentials
  read from a vault, tokens persisted marked `sensitive` (so swamp keeps them in
  the vault).
- **`import-tokens`** — seed a session from a base64 `garth` token store, so an
  unattended host never handles a password.
- **`ensure`** — reuse a valid bearer token, or refresh it from the stored OAuth1
  token with **no credentials**; writes a `status` resource a workflow can guard
  on.
- **`fetch` / `fetch-many`** — cached, paced, authenticated GETs of `connectapi`
  paths. A rate-limited or offline run degrades to last-known cached data.
- **`download`** — store an activity export (FIT/TCX/GPX/KML/CSV) as a swamp
  file artefact, with size and sha256 recorded.

It never writes to a Garmin account. It only reads, and it caches everything it
reads.

## Install

```sh
swamp extension pull @svendowideit/garmin-connect
```

## Configuration

Set these global arguments when creating a model
(`swamp model create @svendowideit/garmin-connect garmin-connect --global-arg key=value`),
or override per call with `--input key=value` where a method exposes it.

| Argument | Type | Default | Description |
| -------- | ---- | ------- | ----------- |
| `domain` | string | `"garmin.com"` | Garmin region domain; `garmin.cn` for the China region. |
| `vaultName` | string | `"garmin-secrets"` | Vault to read credentials from and persist the session into. |
| `usernameKey` | string | `"GARMIN_EMAIL"` | Vault key holding the account email. |
| `passwordKey` | string | `"GARMIN_PASSWORD"` | Vault key holding the account password. |
| `mfaCodeKey` | string | `"GARMIN_MFA_CODE"` | Vault key for a one-time MFA code (non-interactive first login). |
| `tokenStoreKey` | string | `"GARMIN_TOKEN_STORE"` | Vault key for a base64 `garth` token store (preferred; no password). |
| `username` / `password` / `tokenStore` | string | — | Inline overrides; normally leave empty and use the vault. |
| `cacheDir` | string | `"~/.swamp/garmin-cache"` | Shared directory raw responses are cached under. |
| `requestDelayMs` | integer | `500` | Minimum delay between origin requests, across runs. `0` disables pacing. |
| `maxRetries` | integer | `2` | Retries after HTTP 429/5xx, with exponential backoff. |
| `retryDelayMs` | integer | `2000` | Base backoff after a retryable failure (`Retry-After` wins when present). |
| `requestTimeoutMs` | integer | `30000` | Wall-clock budget for a single Garmin request. |
| `maxFetchesPerCall` | integer | `100` | Origin fetches a single `fetch-many` makes (cached hits are free). |
| `defaultMaxAgeMs` | integer | `0` | Default freshness window for cached responses (`0` = always prefer cache). |

## Examples

```sh
# See exactly what is configured and what is missing. Read-only; prints no
# secret. Run this first whenever a sync misbehaves.
swamp model @svendowideit/garmin-connect method run setup garmin-connect

# Preferred auth path: store a garth token store once, then seed the session
# from it — no password is ever handled and scheduled runs need no interactivity.
swamp vault put garmin-secrets GARMIN_TOKEN_STORE
swamp model @svendowideit/garmin-connect method run import-tokens garmin-connect

- **Or log in** with credentials. If Garmin returns an MFA challenge, re-run with
  the one-time code.
swamp vault put garmin-secrets GARMIN_EMAIL
swamp vault put garmin-secrets GARMIN_PASSWORD
swamp model @svendowideit/garmin-connect method run login garmin-connect
swamp model @svendowideit/garmin-connect method run login garmin-connect --input interactiveMfa=123456

# To create a token store to paste into the vault (the preferred path), run the
# standalone helper on a terminal — it prompts, handles MFA, and prints the
# base64 store. This is how you avoid ever putting a password in the vault.
~/.swamp/deno/deno run \
  --allow-net=thegarth.s3.amazonaws.com,sso.garmin.com,connectapi.garmin.com \
  --allow-read --allow-write=$HOME/.garminconnect --allow-env \
  extensions/models/garmin/login.ts --print-store

# Guarantee a valid session before a data sync: refreshes an expired bearer
# with no credentials, and fails with a precise fix when none exists.
swamp workflow run @svendowideit/garmin-session

# Fetch one connectapi path; the raw body is cached so a domain model can parse
# it without calling Garmin again.
swamp model @svendowideit/garmin-connect method run fetch garmin-connect \
  --input path=/userprofile-service/socialProfile

# Fetch many paths in one call — one model-lock acquisition and one batch
# summary. Origin fetches are capped, so a large backlog drains across runs.
swamp model @svendowideit/garmin-connect method run fetch-many garmin-connect \
  --input 'paths=["/userprofile-service/socialProfile","/device-service/deviceregistration/devices"]'

# Download an activity's original (ZIP-wrapped) FIT file as a swamp file.
swamp model @svendowideit/garmin-connect method run download garmin-connect \
  --input activityId=1234567890 --input format=fit
```

## Details

### Model and methods

One model type, `@svendowideit/garmin-connect`. Every method it exposes:

| Method | Arguments | Produces |
| ------ | --------- | -------- |
| `setup` | — | A `setup` report of region, vault keys set/unset, and session state, with the exact commands to fix gaps. Read-only. |
| `import-tokens` | `tokenStore` (optional; else vault) | A `session` resource seeded from a base64 `garth` token store. |
| `login` | `interactiveMfa` (optional) | A `session` resource from the full SSO → OAuth1 → OAuth2 login; raises an actionable error when MFA is required. |
| `ensure` | — | A `status` resource (`ready`, `reason`, `bearerValid`, `refreshValid`, `refreshed`, `expiresAt`); refreshes an expired bearer. |
| `fetch` | `path`, `maxAgeMs`, `forceRefresh` | One `fetch` resource (keyed by cache key) with the raw body, status, and cache state. |
| `fetch-many` | `paths[]`, `maxFetches`, `maxAgeMs`, `forceRefresh` | One `fetch` resource per path plus a `batch` summary. |
| `download` | `activityId`, `format` (`fit`\|`tcx`\|`gpx`\|`kml`\|`csv`) | An `export` file artefact plus a `download` metadata resource (bytes, sha256). |

### Workflows

| Workflow | Trigger | Purpose |
| -------- | ------- | ------- |
| `@svendowideit/garmin-session` | `0 5 * * *` | Ensure a usable session: `ensure` → (guarded) `login` → `verify` → `require-session` assert. Reusable by any Garmin data workflow via `type: workflow`. |

### Resources (data contract)

`session-auth` (spec `session`) holds the OAuth1 + OAuth2 tokens, each token
field marked `z.meta({ sensitive: true })` — swamp stores the values in the
vault and substitutes `${{ vault.get(...) }}` references in the resource file, so
the tokens are never written in clear. `session-status` (spec `status`) is the
guardable readiness record. `fetch` resources hold raw response bodies;
`batch` summarises a `fetch-many`; `download` describes a stored `export` file.

### How the seam works

Domain models do **not** call Garmin. A workflow runs `fetch`/`fetch-many` for
the paths a domain needs, then the domain model reads the cached body (from the
shared `cacheDir`, keyed by the same FNV-1a `cacheKey` scheme as
`@svendowideit/web-cache`) and parses it. This keeps parsing pure and
unit-testable, and means one model owns authentication and rate limiting.

### Auth internals

- **OAuth1 (RFC 5849) HMAC-SHA1** is implemented in `oauth1.ts` on WebCrypto —
  no npm OAuth library. It is tested against the RFC 5849 §3.4.1.1 vector and an
  independently computed signature.
- **Login** primes SSO cookies, `POST`s credentials to
  `sso.garmin.com/mobile/api/login` (Android client id `GCM_ANDROID_DARK`),
  exchanges the service ticket for an OAuth1 token, then for the DI OAuth2
  bearer. The public consumer key/secret come from `garth`'s published file.
- **Refresh** re-runs the OAuth2 exchange with the stored OAuth1 token and no
  audience — no password, no MFA. A refresh token lasts days–weeks, which is
  what makes scheduled runs unattended.
- **Rate limiting** is pacing (a persisted `.last-request` timestamp in the
  cache dir) plus backoff on 429/5xx, falling back to a stale cached body when
  retries are exhausted.

### Project structure

```
extensions/models/garmin/
  manifest.yaml
  oauth1.ts            # RFC 5849 HMAC-SHA1 signer (pure)
  garmin_auth.ts       # SSO → OAuth1 → OAuth2, MFA, refresh, redaction
  garmin_connect.ts    # @svendowideit/garmin-connect model
  garmin-session.yaml  # @svendowideit/garmin-session workflow
  login.ts             # standalone interactive login + token-store helper
  *_test.ts            # unit tests (no network, no credentials)
  README.md
  PLAN.md
  LICENSE.txt
```

### Extending and testing

Add a method by adding a key to `methods` in `garmin_connect.ts`, giving it a Zod
`arguments` schema, and documenting it here and in the manifest. Keep network
calls in small helpers and decision logic in exported pure functions so it can
be tested without an account.

```sh
# Unit tests: OAuth1 vectors, the mocked full login flow, cache keys, downloads.
~/.swamp/deno/deno test --allow-net=jsr.io --allow-env --allow-read --allow-write=/tmp

# Type-check one file.
~/.swamp/deno/deno check garmin_connect.ts

# Docs contract: manifest + README must score at or above the threshold.
swamp workflow run @svendowideit/meta-factory \
  --input manifest=extensions/models/garmin/manifest.yaml
```

### Known limitations

- A **live login** (credentials + any MFA) is required once to create the
  session; the tests cover the flow with a mocked network, not a real account.
- Garmin is an **unofficial, undocumented** API and may change; the extension is
  read-only and surfaces Garmin's own error text.
- **Cloudflare** can challenge logins from unusual IPs; the transport reports a
  clear message rather than retrying blindly.
- Domain models are **not yet shipped** — this is the transport only. See
  `PLAN.md` for the phased build.
