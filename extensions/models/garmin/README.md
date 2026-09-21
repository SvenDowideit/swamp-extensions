# @svendowideit/garmin

Sync a Garmin Connect account into swamp. One authenticated transport, plus
domain models that read its cached responses — starting with devices and the
capability map that gates the rest.

`@svendowideit/garmin` is a **package of several model types** (like
`@svendowideit/news`): the transport type `@svendowideit/garmin-connect`, and
domain types such as `@svendowideit/garmin-devices`. Activities, daily health,
body composition and performance metrics are planned next (see
[`PLAN.md`](./PLAN.md)).

## What it does

Garmin Connect has no public API. Gaining access requires an SSO login, an
OAuth1-signed exchange, and an OAuth2 bearer token that expires within hours;
the API also rate-limits (HTTP 429) and sits behind Cloudflare. Doing that once
per data domain is fragile and wasteful, and Garmin's features vary by device —
golf, solar, HRV, SpO2 and the rest only exist when the account owns a device
that supports them.

This extension solves both problems with a layered design:

- **One transport owns auth.** `@svendowideit/garmin-connect` runs the login
  chain (MFA-aware), refreshes the bearer token with no credentials, makes
  cached, paced, authenticated GETs, and downloads binary exports as swamp
  files. Credentials and tokens live in a vault; tokens are marked `sensitive`.
- **Domain models only parse.** `@svendowideit/garmin-devices` declares the
  `connectapi` paths it needs and reads the transport's cached responses. It
  writes a normalised device inventory and a **capability map** that later
  workflows guard on, so a workflow never asks for data a device cannot produce.
- **The seam is a workflow.** The transport's `fetch-many` fetches a batch, the
  domain model's `sync` parses it. Parsing stays pure and unit-testable.

It never writes to a Garmin account. It only reads, and it caches everything it
reads.

## Install

```sh
swamp extension pull @svendowideit/garmin
```

## Configuration

Global arguments per model. Set them when creating a model
(`swamp model create <type> <name> --global-arg key=value`) or override per call
with `--input key=value` where a method exposes it.

### `@svendowideit/garmin-connect`

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

### `@svendowideit/garmin-devices`

| Argument | Type | Default | Description |
| -------- | ---- | ------- | ----------- |
| `cacheDir` | string | `"~/.swamp/garmin-cache"` | Shared cache the transport writes to; must match `garmin-connect`. |
| `capabilityOverrides` | object | `{}` | Force capabilities true/false, overriding detection (e.g. `{"golf": false}`). |

## Examples

```sh
# See exactly what is configured and what is missing. Read-only; prints no
# secret. Run this first whenever a sync misbehaves.
swamp model @svendowideit/garmin-connect method run setup garmin-connect

# Preferred auth path: store a garth token store once, then seed the session
# from it — no password is ever handled and scheduled runs need no interactivity.
swamp vault put garmin-secrets GARMIN_TOKEN_STORE
swamp model @svendowideit/garmin-connect method run import-tokens garmin-connect

# Or sign in with credentials. If Garmin returns an MFA challenge, re-run with
# the one-time code.
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

# Sync the device inventory and derive the capability map — the whole
# transport → domain seam in one run. Run after any device change.
swamp workflow run @svendowideit/garmin-devices-sync

# Read the capability map; use it as a workflow guard rather than guessing.
swamp data get garmin-devices device-capabilities --json \
  | jq '.content.capabilities | to_entries | map(select(.value)) | map(.key)'

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

# Correct a capability when detection misses your device, without editing code.
swamp model @svendowideit/garmin-devices method run sync garmin-devices \
  --input 'overrides={"golf":false,"spo2":true}'
```

## Details

### Model types and methods

**`@svendowideit/garmin-connect`** — the authenticated transport:

| Method | Arguments | Produces |
| ------ | --------- | -------- |
| `setup` | — | A `setup` report of region, vault keys set/unset, and session state, with exact fix commands. Read-only. |
| `import-tokens` | `tokenStore` (optional; else vault) | A `session` resource seeded from a base64 `garth` token store. |
| `login` | `interactiveMfa` (optional) | A `session` resource from the full SSO → OAuth1 → OAuth2 login; raises an actionable error when MFA is required. |
| `ensure` | — | A `status` resource (`ready`, `reason`, `bearerValid`, `refreshValid`, `refreshed`, `expiresAt`); refreshes an expired bearer. |
| `fetch` | `path`, `maxAgeMs`, `forceRefresh` | One `fetch` resource (keyed by cache key) with the raw body, status, and cache state. |
| `fetch-many` | `paths[]`, `maxFetches`, `maxAgeMs`, `forceRefresh` | One `fetch` resource per path plus a `batch` summary. |
| `download` | `activityId`, `format` (`fit`\|`tcx`\|`gpx`\|`kml`\|`csv`) | An `export` file artefact plus a `download` metadata resource (bytes, sha256). |

**`@svendowideit/garmin-devices`** — inventory + capabilities:

| Method | Arguments | Produces |
| ------ | --------- | -------- |
| `setup` | — | A `setup` report of cache state and override configuration. Read-only. |
| `paths` | — | A `paths` resource listing the `connectapi` paths this model needs. |
| `sync` | `overrides` (optional) | A `devices` resource (normalised inventory) and a `capabilities` resource (the capability map). |

### Workflows

| Workflow | Trigger | Purpose |
| -------- | ------- | ------- |
| `@svendowideit/garmin-session` | `0 5 * * *` | Ensure a usable session: `ensure` → (guarded) `login` → `verify` → `require-session` assert. Reusable by any Garmin data workflow via `type: workflow`. |
| `@svendowideit/garmin-devices-sync` | `10 5 * * *` | The reference transport→domain seam: call `garmin-session` → `garmin-devices.paths` → `garmin-connect.fetch-many` → `garmin-devices.sync` → assert. |

### The capability map

`@svendowideit/garmin-devices` classifies each device by product line (watch,
cycling, handheld, golf, fitness, scale, dive, aviation) from its name, product
SKU and application key, then unions the feature sets of those lines. A `fenix`
yields the wearable wellness set plus `solar`, `golf` and `maps`; an `Edge` adds
`cycling`, `ftp` and `powerZones`. Account-level settings add `menstrual` and
`nutrition`; `measurementSystem` records metric/imperial.

Derivation is conservative and auditable: `confidence` marks each capability
`derived` or `override`, `unknownProducts` lists devices that matched no known
line, and `capabilityOverrides` (global or per-run) let a user correct anything
without editing code. A workflow gates a job like so:

```yaml
when: ${{ data.latest("garmin-devices", "device-capabilities").attributes.capabilities.hrv == true }}
```

### Resources (data contract)

`session-auth` (spec `session`) holds the OAuth1 + OAuth2 tokens, each token
field marked `z.meta({ sensitive: true })` — swamp stores the values in the
vault and substitutes `${{ vault.get(...) }}` references in the resource file.
`session-status` (spec `status`) is the guardable readiness record. `device-list`
(spec `devices`) and `device-capabilities` (spec `capabilities`) are the domain
outputs. `fetch` resources hold raw response bodies; `batch` summarises a
`fetch-many`; `download` describes a stored `export` file.

### How the seam works

Domain models do **not** call Garmin. A workflow runs `fetch`/`fetch-many` for
the paths a domain declares, then the domain model reads the cached body from the
shared `cacheDir` — keyed by the same FNV-1a scheme as
`@svendowideit/web-cache` — and parses it. This keeps parsing pure and
unit-testable, and means one model owns authentication and rate limiting.

### Auth internals

- **OAuth1 (RFC 5849) HMAC-SHA1** is implemented in `oauth1.ts` on WebCrypto —
  no npm OAuth library. Tested against the RFC 5849 §3.4.1.1 vector and an
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
  garmin_cache.ts      # shared on-disk response cache (writer + readers)
  garmin_connect.ts    # @svendowideit/garmin-connect (transport)
  garmin_devices.ts    # @svendowideit/garmin-devices (inventory + capabilities)
  garmin-session.yaml  # @svendowideit/garmin-session workflow
  garmin-devices-sync.yaml  # @svendowideit/garmin-devices-sync workflow
  login.ts             # standalone interactive login + token-store helper
  *_test.ts            # unit tests (no network, no credentials)
  README.md
  PLAN.md
  LICENSE.txt
```

### Extending and testing

To add a domain model, follow `garmin_devices.ts`: export a `DEVICE_PATHS`-style
constant of the `connectapi` paths you need, a `paths` method that returns them,
and a `sync` method that reads them via `readCachedByPath` and writes resources.
Then add a workflow that calls `garmin-session` → your `paths` →
`garmin-connect.fetch-many` → your `sync`. Keep decision logic in exported pure
functions so it can be tested without an account.

```sh
# Unit tests: OAuth1 vectors, the mocked full login flow, devices/capabilities.
~/.swamp/deno/deno test --allow-net=jsr.io --allow-env --allow-read --allow-write=/tmp

# Type-check one file.
~/.swamp/deno/deno check garmin_devices.ts

# Docs contract: manifest + README must score at or above the threshold.
swamp workflow run @svendowideit/meta-factory \
  --input manifest=extensions/models/garmin/manifest.yaml
```

### Known limitations

- A **live login** (credentials + any MFA) is required once to create the
  session; the tests cover the flow with a mocked network, not a real account.
- **Capability detection is heuristic.** It recognises the common product lines
  but Garmin's naming drifts; unrecognised devices are listed in
  `unknownProducts` and every flag can be corrected with `capabilityOverrides`.
- Garmin is an **unofficial, undocumented** API and may change; the extension is
  read-only and surfaces Garmin's own error text.
- **Cloudflare** can challenge logins from unusual IPs; the transport reports a
  clear message rather than retrying blindly.
- Activities, daily health, body composition and performance models are **not yet
  shipped** — see `PLAN.md` for the phased build.
