# @svendowideit/garmin

Sync a Garmin Connect account into swamp. One authenticated transport, plus
domain models that read its cached responses — devices with a capability map
that gates the rest, the activity history with FIT/TCX/GPX downloads, daily
wellness, weight/body composition, and training + performance metrics.

`@svendowideit/garmin` is a **package of several model types** (like
`@svendowideit/news`): the transport type `@svendowideit/garmin-connect`, and
domain types `@svendowideit/garmin-devices`, `@svendowideit/garmin-activities`,
`@svendowideit/garmin-health`, `@svendowideit/garmin-body` and
`@svendowideit/garmin-performance` (see [`PLAN.md`](./PLAN.md)).

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
  `@svendowideit/garmin-activities` does the same for the activity history, and
  because per-activity detail (splits, weather, HR zones) is one request per
  activity, it fans the whole set into a **single** transport batch instead of N
  contended calls. `@svendowideit/garmin-health` covers daily wellness and drops
  the device-gated metrics (HRV, SpO2, respiration, body battery) the account's
  devices cannot record; `@svendowideit/garmin-body` covers weight and body
  composition; `@svendowideit/garmin-performance` covers training and
  performance metrics (training status/readiness, VO2max, race predictions,
  endurance and hill score, FTP, personal records), likewise gated.
- **The seam is a workflow.** The transport's `fetch-many` / `download-many`
  fetches a batch, the domain model's `sync` parses it. Parsing stays pure and
  unit-testable.

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

### `@svendowideit/garmin-activities`

| Argument | Type | Default | Description |
| -------- | ---- | ------- | ----------- |
| `cacheDir` | string | `"~/.swamp/garmin-cache"` | Shared cache the transport writes to; must match `garmin-connect`. |
| `detailKinds` | string[] | `["detail","splits","weather"]` | Per-activity sub-resources to fetch (`detail`, `splits`, `splitSummaries`, `weather`, `hrTimeInZones`, `powerTimeInZones`, `exerciseSets`, `details`). |
| `timezone` | string | `""` | IANA zone for bucketing start times; empty uses Garmin's local fields. |

### `@svendowideit/garmin-health`

| Argument | Type | Default | Description |
| -------- | ---- | ------- | ----------- |
| `cacheDir` | string | `"~/.swamp/garmin-cache"` | Shared cache the transport writes to; must match `garmin-connect`. |
| `metrics` | string[] | summary, sleep, stress, heartRate, restingHeartRate, bodyBattery, stepsChart | Wellness metrics to fetch. Also: `respiration`, `spo2`, `hrv`, `intensityMinutes`, `floors`. |
| `respectCapabilities` | boolean | `true` | Drop device-gated metrics the account's devices do not support. |

### `@svendowideit/garmin-body`

| Argument | Type | Default | Description |
| -------- | ---- | ------- | ----------- |
| `cacheDir` | string | `"~/.swamp/garmin-cache"` | Shared cache the transport writes to; must match `garmin-connect`. |
| `unit` | string | `"kg"` | Display unit for the normalised `weight` field (`kg` or `lb`); exact grams are always kept. |

### `@svendowideit/garmin-performance`

| Argument | Type | Default | Description |
| -------- | ---- | ------- | ----------- |
| `cacheDir` | string | `"~/.swamp/garmin-cache"` | Shared cache the transport writes to; must match `garmin-connect`. |
| `metrics` | string[] | trainingStatus, trainingReadiness, vo2max, racePredictions, ftp, personalRecords | Metrics to fetch. Also: `enduranceScore`, `hillScore`, `fitnessAge`. |
| `respectCapabilities` | boolean | `true` | Drop device-gated metrics the account's devices do not support. |

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
# the one-time code (it is emailed/texted to you). The challenge's SSO cookies
# are persisted automatically, so the resume works — do it promptly, as the code
# and its cookies expire within minutes.
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

# Sync the activity history for a window. Run it before downloading, and daily
# so the history stays current. Widen the window or filter by sport as needed.
swamp workflow run @svendowideit/garmin-activities-sync
swamp workflow run @svendowideit/garmin-activities-sync --input days=90 --input activityType=cycling

# Sync daily wellness (default: yesterday — the last complete day). Device-gated
# metrics are fetched only when the capability map says the account can record
# them; widen the window to backfill.
swamp workflow run @svendowideit/garmin-health-sync
swamp workflow run @svendowideit/garmin-health-sync --input startDate=2026-01-01 --input endDate=2026-01-31

# Sync weight and body composition (default: yesterday). Body composition only
# appears when a compatible scale is paired.
swamp workflow run @svendowideit/garmin-body-sync
swamp workflow run @svendowideit/garmin-body-sync --input startDate=2025-01-01 --input endDate=2026-01-31

# Sync training and performance metrics (default: yesterday — Garmin often has
# no data for today yet). Device-gated metrics are only fetched when the
# capability map says the account can compute them; latestOnly is a cheap
# FTP + personal-records refresh.
swamp workflow run @svendowideit/garmin-performance-sync
swamp workflow run @svendowideit/garmin-performance-sync --input startDate=2026-01-01 --input endDate=2026-01-31
swamp workflow run @svendowideit/garmin-performance-sync --input latestOnly=true

# Read the wellness roll-up, the weight trend, and the performance records.
swamp data get garmin-health health-range --json \
  | jq '.content.summaries[] | {date, steps, sleepScore, avgStress, hrvLastNightAvg}'
swamp data get garmin-body body-range --json \
  | jq '.content.weighIns[] | {date, weight, bmi, bodyFatPercent}'
swamp data get garmin-performance records --json \
  | jq '.content | {ftp, best, personalRecords}'
swamp data get garmin-performance metrics-<date> --json \
  | jq '.content | {trainingStatus, trainingReadiness, vo2maxRunning, racePrediction5k}'

# Download original activity files for the synced list. FIT is the default;
# re-runs skip files already downloaded, and `limit` spreads a backlog.
swamp workflow run @svendowideit/garmin-download
swamp workflow run @svendowideit/garmin-download --input format=tcx --input limit=50

# Read the synced history — the whole array is in one resource for easy piping.
swamp data get garmin-activities activity-list --json \
  | jq '.content.activities[] | {name, typeKey, distanceMeters, aerobicTrainingEffect}'

# Fetch one connectapi path; the raw body is cached so a domain model can parse
# it without calling Garmin again.
swamp model @svendowideit/garmin-connect method run fetch garmin-connect \
  --input path=/userprofile-service/socialProfile

# Fetch many paths in one call — one model-lock acquisition and one batch
# summary. Origin fetches are capped, so a large backlog drains across runs.
swamp model @svendowideit/garmin-connect method run fetch-many garmin-connect \
  --input 'paths=["/userprofile-service/socialProfile","/device-service/deviceregistration/devices"]'

# Download one activity's original (ZIP-wrapped) FIT file as a swamp file.
swamp model @svendowideit/garmin-connect method run download garmin-connect \
  --input activityId=1234567890 --input format=fit

# Correct a capability when detection misses your device, without editing code.
swamp model @svendowideit/garmin-devices method run sync garmin-devices \
  --input 'overrides={"golf":false,"spo2":true}'

# Pull more per-activity detail (HR and power time-in-zones) on the next sync.
swamp model @svendowideit/garmin-activities method run detail-paths garmin-activities \
  --input 'kinds=["detail","hrTimeInZones","powerTimeInZones"]'
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
| `download-many` | `activityIds[]`, `format`, `maxDownloads`, `skipExisting` | One `export` file + `download` per id, plus a `downloads` batch summary (`downloaded`/`skipped`/`failed`/`failedIds`). Skips existing, caps a backlog, continues past one failure. |

**`@svendowideit/garmin-devices`** — inventory + capabilities:

| Method | Arguments | Produces |
| ------ | --------- | -------- |
| `setup` | — | A `setup` report of cache state and override configuration. Read-only. |
| `paths` | — | A `paths` resource listing the `connectapi` paths this model needs. |
| `sync` | `overrides` (optional) | A `devices` resource (normalised inventory) and a `capabilities` resource (the capability map). |

**`@svendowideit/garmin-activities`** — activity history:

| Method | Arguments | Produces |
| ------ | --------- | -------- |
| `setup` | — | A `setup` report of the configured window and detail kinds. Read-only. |
| `activity-list-path` | `days`, `startDate`, `endDate`, `activityType`, `limit`, `sortOrder` | A `paths` resource with the one date-ranged, paged list path. |
| `detail-paths` | `ids` (optional), `kinds` (optional), `useLastList` | A `paths` resource with every per-activity detail path, for one `fetch-many`. |
| `sync` | `ids` (optional), `includeDetails` | An `activity-list` resource, one `activity-<id>` per activity, and `detail-<id>-<kind>` per cached detail response. |

**`@svendowideit/garmin-health`** — daily wellness:

| Method | Arguments | Produces |
| ------ | --------- | -------- |
| `setup` | — | A `setup` report of the configured metrics, gating, and display-name state. Read-only. |
| `paths` | `date`/`startDate`/`endDate`, `metrics`, `capabilities`, `displayName`, `maxDays` | A `paths` resource for every date × metric, plus `skipped` (metrics dropped by gating). |
| `sync` | `date`/`startDate`/`endDate`, `metrics`, `displayName` | One `daily-<date>` per day (summary + raw metric bodies) and a `health-range` roll-up. |

**`@svendowideit/garmin-body`** — weight and body composition:

| Method | Arguments | Produces |
| ------ | --------- | -------- |
| `setup` | — | A `setup` report of unit and whether body composition has been seen. Read-only. |
| `paths` | `date`/`startDate`/`endDate`, `mode`, `maxDays` | A `paths` resource — one range request, or one day-view request per day. |
| `sync` | `date`/`startDate`/`endDate` | One `weigh-in-<date>` per weigh-in (latest sample per day) and a `body-range` roll-up with `hasBodyComposition`. |

**`@svendowideit/garmin-performance`** — training and performance metrics:

| Method | Arguments | Produces |
| ------ | --------- | -------- |
| `setup` | — | A `setup` report of the configured metrics, split into daily and latest. Read-only. |
| `paths` | `date`/`startDate`/`endDate`, `metrics`, `capabilities`, `displayName`, `latestOnly`, `maxDays` | A `paths` resource — one per day for date-keyed metrics, one total for latest metrics (FTP, PRs) — plus `skipped`. |
| `sync` | `date`/`startDate`/`endDate`, `displayName` | One `metrics-<date>` per day, a `performance-range` roll-up, and a `records` resource (FTP, personal records, bests seen). |

### Workflows

| Workflow | Trigger | Purpose |
| -------- | ------- | ------- |
| `@svendowideit/garmin-session` | `0 5 * * *` | Ensure a usable session: `ensure` → (guarded) `login` → `verify` → `require-session` assert. Reusable by any Garmin data workflow via `type: workflow`. |
| `@svendowideit/garmin-devices-sync` | `10 5 * * *` | The reference transport→domain seam: call `garmin-session` → `garmin-devices.paths` → `garmin-connect.fetch-many` → `garmin-devices.sync` → assert. |
| `@svendowideit/garmin-activities-sync` | `20 5 * * *` | High-volume variant: `garmin-session` → `garmin-activities.activity-list-path` → `detail-paths` → `fetch-many` (list) → `fetch-many` (details) → `sync` → assert. Details are built from the previous run's list (two-pass). |
| `@svendowideit/garmin-health-sync` | `30 5 * * *` | `garmin-session` → transport `profile` (display name) → `garmin-health.paths` (gated by `garmin-devices` capabilities) → `fetch-many` → `sync` → assert. |
| `@svendowideit/garmin-body-sync` | `40 5 * * *` | `garmin-session` → `garmin-body.paths` → `fetch-many` → `sync` → assert. |
| `@svendowideit/garmin-performance-sync` | `50 5 * * *` | `garmin-session` → transport `profile` → `garmin-performance.paths` (gated) → `fetch-many` → `sync` → assert. |
| `@svendowideit/garmin-download` | on demand | Download activity exports for the synced list: `garmin-session` → assert list exists → `garmin-connect.download-many` → assert. |

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
(spec `devices`) and `device-capabilities` (spec `capabilities`) are the device
outputs. `activity-list` (spec `list`) is the whole window in one resource;
`activity-<id>` (spec `activity`) is one normalised activity; `detail-<id>-<kind>`
(spec `detail`) is one per-activity detail body. `daily-<date>` (spec `daily`) is
one day's wellness summary plus its raw metric bodies; `health-range` (spec
`range`) is the window roll-up. `weigh-in-<date>` (spec `weighIn`) and
`body-range` (spec `range`) do the same for weight. `metrics-<date>` (spec
`metrics`) is one day of performance data, `performance-range` (spec `range`) is
the window roll-up, and `records` (spec `records`) holds the latest values (FTP,
personal records) plus the bests seen. `fetch` resources hold raw response
bodies; `batch` summarises a `fetch-many`; `download`/`downloads` describe
stored `export` files.

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
- **MFA spans two runs.** If Garmin demands a second factor, the challenge's SSO
  cookie jar is persisted in the `pending-mfa` resource (sensitive, so it lives
  in the vault) and the run stops with the code prompt. The resume run restores
  that jar before calling `verifyCode`, because Garmin acts on the session the
  password step established — a fresh session without the cookies fails. Codes
  and their cookies expire within minutes; if a resume says no challenge is
  pending, start a fresh login. A successful login clears `pending-mfa`.
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
  garmin_activities.ts # @svendowideit/garmin-activities (history + detail)
  garmin_health.ts     # @svendowideit/garmin-health (daily wellness)
  garmin_body.ts       # @svendowideit/garmin-body (weight + body composition)
  garmin_performance.ts # @svendowideit/garmin-performance (training + metrics)
  garmin-session.yaml             # @svendowideit/garmin-session
  garmin-devices-sync.yaml        # @svendowideit/garmin-devices-sync
  garmin-activities-sync.yaml     # @svendowideit/garmin-activities-sync
  garmin-health-sync.yaml         # @svendowideit/garmin-health-sync
  garmin-body-sync.yaml           # @svendowideit/garmin-body-sync
  garmin-performance-sync.yaml    # @svendowideit/garmin-performance-sync
  garmin-download.yaml            # @svendowideit/garmin-download
  login.ts             # standalone interactive login + token-store helper
  *_test.ts            # unit tests (no network, no credentials)
  README.md
  PLAN.md
  LICENSE.txt
```

### Extending and testing

To add a domain model, follow `garmin_devices.ts` / `garmin_activities.ts` /
`garmin_health.ts`: export a constant of the `connectapi` paths you need (and
pure path builders), a `paths`-style method that returns them, and a `sync`
method that reads them via `readCachedByPath` and writes resources. Then add a
workflow that calls `garmin-session` → your path builder(s) →
`garmin-connect.fetch-many` → your `sync`. Keep decision logic in exported pure
functions so it can be tested without an account, and fan per-item paths into one
`fetch-many` rather than N parallel `fetch` calls (the per-model lock makes N
calls contend).

Two conventions worth copying: a domain model **never reads another model's
resource** (that is what workflow CEL wiring is for) — it reads cached bodies
from `cacheDir`, and takes cross-model values like the capability map or the
display name as **method arguments** wired in by the workflow. And any field
that may legitimately be absent (a metric a device did not record, a body-fat
reading a weight-only scale cannot give) is `null`, never `0`, with an explicit
`hasBodyComposition`-style flag where a consumer needs to tell them apart.

```sh
# Unit tests: OAuth1 vectors, the mocked full login flow, devices, activities.
~/.swamp/deno/deno test --allow-net=jsr.io --allow-env --allow-read --allow-write=/tmp

# Type-check one file.
~/.swamp/deno/deno check garmin_activities.ts

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
- **Activity detail is two-pass.** Per-activity detail is built from the previous
  run's list, because ids are not known until the list is synced. The first run
  fetches the list; the next adds detail. Downloads likewise run after a sync.
- **Wellness and performance metrics depend on devices.** HRV, SpO2, respiration
  and body battery (wellness) and VO2max, training status/readiness and the
  scores (performance) are only fetched when the capability map says a device
  computes them; a metric genuinely absent for a day is `null`, and
  `health-range.metricsSkipped` / `performance-range.metricsSkipped` record what
  gating removed.
- **Body composition needs a compatible scale.** A weight-only scale reports
  weight alone; `body-range.hasBodyComposition` says which you have, and the
  per-weigh-in composition fields are `null` when not measured.
- **Cloudflare** can challenge logins from unusual IPs, and Garmin **rate-limits**
  repeated login attempts (HTTP 429). The transport detects both and reports what
  happened and what to do — including how long to wait when Garmin sends a
  `Retry-After` header. If you see a 429, stop retrying (fast repeats lengthen
  the block); wait, then try once. A token store via `import-tokens` sidesteps the
  login endpoint entirely and is the most reliable path on a shared host.
- Garmin is an **unofficial, undocumented** API and may change; the extension is
  read-only and surfaces Garmin's own error text.
