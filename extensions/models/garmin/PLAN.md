# `@svendowideit/garmin` — implementation plan

Sync and download a user's Garmin Connect data into swamp models, so it can be
queried, wired into workflows, and joined with other data (e.g. the Zwift
models).

This document is the design record. It captures the research, the architecture
decision, and the phased build order. It is not the user-facing documentation —
that lives in `manifest.yaml` and `README.md` once the models exist.

## 1. Goal

- Pull a user's **Garmin Connect** data into swamp: activities, daily wellness,
  body composition, performance metrics, devices, and raw activity files
  (FIT/TCX/GPX).
- Keep **one** authentication/session implementation — Garmin's auth is
  fragile (Cloudflare, MFA, OAuth1 signing, rotating tokens) and must not be
  duplicated per data domain.
- Model the data in **several domain models**, each owning one coherent
  resource shape, fed through a **common transport model** and a **common
  transport workflow**.
- Account for **device-dependent** data: golf, solar, HRV, SpO2, respiration,
  running tolerance, etc. only exist if the user owns a supporting device.

## 2. Research findings

### 2.1 Registry

- `swamp extension search garmin` → **0 results**. No `@swamp/*` Garmin type,
  no community extension. A new extension is justified.
- Closest in-repo prior art:
  - `@svendowideit/zwift` — authenticated fitness-platform sync, vault-backed
    credentials, rotating refresh token, multi-model + workflows.
  - `@svendowideit/web-cache` + `@svendowideit/wikidata` / `wikipedia` — the
    **transport/parser seam**: one model fetches and caches; domain models read
    the cached body and parse it, fetching nothing themselves.
  - `@svendowideit/news` — multi-model pipeline, nested workflows, CEL handoff.

### 2.2 Garmin API (unofficial)

Verified against `python-garminconnect` (`Garmin` wrapper + endpoint
inventory) and `garth` (`sso.py`, `http.py`, `auth_tokens.py`).

**Base:** `https://connectapi.garmin.com` (`.cn` for the China region).

**Authentication chain:**

| Step | Call |
| ---- | ---- |
| 1. SSO login | `POST https://sso.garmin.com/mobile/api/login` with `clientId=GCM_ANDROID_DARK`, `service=https://mobile.integration.garmin.com/gcm/android`, JSON `{username, password, rememberMe:false, captchaToken:""}`. Returns `serviceTicketId`, or `responseStatus.type = MFA_REQUIRED`. |
| 2. MFA | `POST /mobile/api/mfa/verifyCode` with `{mfaMethod, mfaVerificationCode, …}` → `serviceTicketId`. |
| 3. OAuth1 token | `GET https://connectapi.garmin.com/oauth-service/oauth/preauthorized?ticket=…&login-url=…&accepts-mfa-tokens=true`, signed **OAuth1 HMAC-SHA1**, consumer key/secret from `https://thegarth.s3.amazonaws.com/oauth_consumer.json`, UA `com.garmin.android.apps.connectmobile`. Returns `oauth_token`, `oauth_token_secret` (form-encoded). |
| 4. OAuth2 token | `POST https://connectapi.garmin.com/oauth-service/oauth/exchange/user/2.0`, signed with the OAuth1 token, body `audience=GARMIN_CONNECT_MOBILE_ANDROID_DI`. Returns `access_token`, `refresh_token`, `expires_in`, `refresh_token_expires_in`, `token_type`, `scope`. |
| 5. Refresh | Repeat step 4 **without** `audience`, using the stored OAuth1 token. No credentials, no MFA — this is what makes scheduled runs unattended. |
| 6. API call | `Authorization: Bearer <access_token>` against `connectapi.garmin.com`. |

Token lifetime: `refresh_token_expires_at` is long (days–weeks); a full
re-login (credentials + possible MFA) is only needed when it expires or is
revoked.

**Endpoint tiers** (grouped; full paths gathered during research):

- User/profile: `/userprofile-service/socialProfile`, `/userprofile-service/userprofile/user-settings`
- Devices: `/device-service/deviceregistration/devices`, `/device-service/deviceservice/mylastused`, `/web-gateway/device-info/primary-training-device`, `/web-gateway/solar/{device_id}/{start}/{end}`
- Activities: `/activitylist-service/activities/search/activities`, `/activitylist-service/activities/count`, `/activity-service/activity/{id}` (+ `/splits`, `/details`, `/weather`, `/hrTimeInZones`, `/powerTimeInZones`, `/exerciseSets`)
- Downloads: `/download-service/files/activity/{id}` (FIT/ZIP), `/download-service/export/{tcx,gpx,kml,csv}/activity/{id}`, `/download-service/files/wellness/{date}`
- Daily wellness: `/usersummary-service/usersummary/daily/{name}`, `/wellness-service/wellness/dailySleepData`, `/dailyStress`, `/dailyHeartRate`, `/bodyBattery/reports/daily`, `/spo2`, `/respiration`, `/daily/im`, `/floorsChartData/daily`
- Metrics/performance: `/metrics-service/metrics/maxmet/daily` (VO2max), `/trainingstatus/aggregated`, `/trainingreadiness`, `/racepredictions`, `/hillscore`, `/endurancescore`, `/hrv-service/hrv/{date}`
- Body: `/weight-service/weight/dateRange`
- Goals/records: `/personalrecord-service/personalrecord/prs`, `/goal-service/goal/goals`, `/badge-service/badge/earned`
- Feature/device-gated: golf (`/gcs-golfcommunity/api/v2/*`), nutrition
  (`/nutrition-service/*`), menstrual (`/periodichealth-service/*`),
  solar, running tolerance.

### 2.3 Constraints that shape the design

- **Garmin cannot use `@svendowideit/web-cache`.** Web-cache is anonymous
  GET-only. Garmin needs signed OAuth1/OAuth2 requests and binary downloads. A
  dedicated authenticated transport is required.
- **OAuth1 HMAC-SHA1 signing in Deno** (WebCrypto) is the main technical risk —
  hence Phase 0.
- **MFA + Cloudflare** make unattended first login unreliable. Seed tokens once
  interactively, then rely on refresh.
- **Many endpoints are device-dependent.** A missing device must skip work, not
  fail a run.
- ~~The swamp file-writer API observed in-tree only exposes `writeText`;
  binary artefact support must be confirmed in Phase 0.~~ **Resolved in Phase
  0:** `context.createFileWriter(...)` returns a `DataWriter` with
  `writeAll(content: Uint8Array)`, `writeStream(stream, opts)` and
  `getFilePath()`, so binary FIT/TCX/GPX artefacts are natively supported.

## 3. Architecture — layered transport + domain parsers

```
                      ┌────────────────────────────┐
   credentials/vault  │  @svendowideit/garmin-     │  signed fetch / download
   ─────────────────► │  connect  (TRANSPORT)      │  ──────────────────────► Garmin
                      │  SSO→OAuth1→OAuth2, cache, │
                      │  pacing, token rotation    │
                      └─────────────┬──────────────┘
                                    │ raw responses cached in
                                    │ ~/.swamp/garmin-cache/<key>/
              ┌─────────────────────┼─────────────────────┐
              ▼                     ▼                     ▼
     garmin-devices        garmin-activities       garmin-health
     (+capabilities)       garmin-body             garmin-performance
              │                     │                     │
              └──────── CEL data.latest(...).attributes ┘
                        wired together by workflows
```

Two data paths, chosen deliberately:

- **Signed raw cache (transport C: web-cache/wikidata seam)** for bulk,
  replayable, multi-parsed, or binary data: activity lists, per-activity
  details, downloads, daily wellness ranges. Parsers are pure functions, so they
  are unit-testable with no network and no credentials.
- **CEL resource handoff (transport D: zwift/news seam)** for small payloads
  that drive control flow: profile, device list, **capabilities**, summaries.

**Rationale:** cache for *data*, CEL for *control*. Garmin is high-volume and
produces binaries that cannot ride CEL inputs, so the cache wins for the bulk;
but capabilities/profile are tiny control signals best read as
`data.latest("garmin-devices", "capabilities").attributes`.

## 4. Data-model comparison

| Approach | Auth | Testability | Data flow | Failure isolation | Verdict |
| --- | --- | --- | --- | --- | --- |
| **A. One giant `garmin` model, a method per endpoint** | once | poor | internal | one bad method taints all; single per-model lock | Reject — violates "several data models"; device-dependent schemas collide |
| **B. Each domain model authenticates itself** | N× | poor | N× | N× login/429/Cloudflare risk; token-rotation races | Reject |
| **C. Transport + domain parsers over a signed raw cache** | once | excellent | workflow-ordered | per-domain; cache replayable | Strong for bulk/downloads |
| **D. Transport resources + CEL `data.latest(...)` handoff** | once | good | explicit DAG | coupling is a resource schema | Strong for small payloads |
| **E. Hybrid C+D (chosen)** | once | excellent | cache for data, CEL for control | per-domain | **Recommended** |

## 5. Type inventory

| Type | Role | Resources |
| ---- | ---- | --------- |
| `@svendowideit/garmin-connect` | Transport: SSO→OAuth1→OAuth2, refresh, signed `fetch` / `fetch-many` / `download`, disk cache, pacing/retry | `session` (sensitive tokens), `fetch`, `batch`, `download`, `setup` |
| `@svendowideit/garmin-devices` | Device inventory + **capability map** (gates the rest) | `devices`, `capabilities` |
| `@svendowideit/garmin-activities` | Activity list + per-activity detail + FIT/TCX/GPX orchestration | `activity-<id>`, `history`, `sync` |
| `@svendowideit/garmin-health` | Daily wellness: summary, sleep, stress, HR, body battery, SpO2, respiration, HRV | `daily-<date>`, `range` |
| `@svendowideit/garmin-body` | Weight / body composition | `weighIn-<date>`, `range` |
| `@svendowideit/garmin-performance` | Training status/readiness, VO2max, race predictions, FTP, PRs | `metrics-<date>`, `records` |
| `@svendowideit/garmin-golf`, `garmin-nutrition`, `garmin-menstrual` | Optional feature-gated packs | — |

## 6. Workflows

| Workflow | Shape |
| -------- | ----- |
| `@svendowideit/garmin-session` | **Common transport workflow.** Nested, reusable: ensure login → refresh tokens → write `session`. Invoked by every other workflow. |
| `@svendowideit/garmin-sync` | Parent: `session` → devices (capabilities) → parallel domain jobs **guarded by capability expressions** |
| `@svendowideit/garmin-download` | `session` → list activities → `forEach` activity → `garmin-connect.download` |
| `@svendowideit/garmin-backfill` | Historical date-range pull; independent cadence |

Device gating example (parent workflow step guard):

```yaml
# only run the HRV job when a supporting device is present
when: ${{ data.latest("garmin-devices", "capabilities").attributes.hrv == true }}
```

## 7. Device-dependency strategy

| Approach | Verdict |
| -------- | ------- |
| **(a) Capability map + workflow guards** — `garmin-devices` derives `{solar, golf, hrv, spo2, respiration, runningTolerance, …}` from the connected device list + user settings; workflows guard jobs on it | **Recommended.** Explicit, auditable, cheap; a missing device skips work instead of failing a run. |
| (b) Each domain model probes and records `unsupported` | Keep as a fallback feeding (a): a supported-but-unconfigured device can still return empty, so domains record observations. |
| (c) Static user-config flags on the transport | Reject — brittle; makes the user hand-maintain what Garmin already knows. |

## 8. Concrete decisions

1. **Cache key** = normalised `path?query` (host is fixed), FNV-1a scheme like
   `web_cache.ts:283`, in a **separate** dir `~/.swamp/garmin-cache` — never
   shared with `web-cache` (different auth semantics).
2. **Token storage:** the `session` resource carries OAuth1 + OAuth2 tokens with
   `.meta({ sensitive: true })`, so swamp keeps them in the vault (zwift
   precedent, `zwift_rider.ts:299`). Long-lived refresh token → unattended runs.
3. **Bootstrap:** `garmin-connect.login` supports (i) interactive
   credentials+MFA once and (ii) **importing a `garth` token JSON** (base64), so
   no password is needed. Recommend the token-import path for scheduled runs.
4. **Downloads:** transport `download` writes raw bytes through
   `context.createFileWriter(...).writeAll(bytes)` (or `writeStream`), recording
   `size/sha256/format` in the `download` resource. A local mirror under
   `~/.swamp/garmin/` is optional for tools that need a path.
5. **Rate limiting:** adapt web-cache's pacing/retry (persisted
   `.last-request`, 429 backoff) inside the transport.
6. **Auth reuse:** scaffold error surface + redaction from `zwift_auth.ts`; the
   OAuth1 signer is new code with its own tests.

## 9. Risks

- **OAuth1 HMAC-SHA1 signing in Deno** — highest risk; Phase 0 spike gates the
  rest.
- **MFA / Cloudflare** — seed tokens, then refresh; interactive-only first
  login.
- **Undocumented API + ToS** — keep the extension read-only, document it.
- **FIT is a ZIP** — store raw; summarise from activity JSON, don't parse.
- **Token expiry** — if refresh expires, require re-seed; `setup` must report it.

## 10. Delivery phases

0. **Spike** (this phase): prove SSO → OAuth1 → OAuth2 → `GET
   /userprofile-service/socialProfile` from Deno. Also confirm binary
   file-writer support.
1. `garmin-connect` + `garmin-session` workflow + `setup`.
2. `garmin-devices` + `capabilities`.
3. `garmin-activities` + `garmin-download`.
4. `garmin-health` + `garmin-body`.
5. `garmin-performance`.
6. Optional device-gated packs; a `garmin-summary` report.
7. Every phase: unit tests (`~/.swamp/deno/deno test`), README + manifest
   manual, and a `meta-factory` doc score ≥ 75.

## 11. Phase 0 spike artefacts

> **Promoted in Phase 1.** `oauth1.ts`, `garmin_auth.ts` and their tests moved
> up to the extension root and are now shipped. `login.ts` remained as the
> standalone token-store bootstrap helper. The `spike/` directory is gone.

- `oauth1.ts` — OAuth1 HMAC-SHA1 signer (RFC 5849), pure and testable.
- `oauth1_test.ts` — RFC 5849 known-answer vector + determinism tests.
- `garmin_auth.ts` — SSO login → service ticket → OAuth1 → OAuth2; token
  refresh; `connectapi` GET with `Authorization: Bearer`.
- `login.ts` — CLI: prompts/reads credentials, handles MFA, writes tokens, and
  can print a base64 token store for the vault.

## 12. Phase 1 status (complete)

Shipped as the `@svendowideit/garmin-connect` extension (doc score 99/100):

- `garmin_connect.ts` — the transport model, methods: `setup`, `import-tokens`,
  `login`, `ensure`, `fetch`, `fetch-many`, `download`. Resources: `session`
  (tokens sensitive), `fetch`, `batch`, `download`, `setup`, `status`; file spec
  `export`.
- `garmin-session.yaml` — the common session workflow
  (`ensure → guarded login → verify → require-session`), cron `0 5 * * *`,
  reusable by later data workflows via `type: workflow`.
- On-disk cache/pacing under `~/.swamp/garmin-cache`, keyed by the same FNV-1a
  scheme as `@svendowideit/web-cache`.
- 25 unit tests (OAuth1 vectors, mocked full login flow, MFA, refresh, cache
  keys, downloads, token-store import) — all network-free.

Verified live: SSO reachability, an authenticated request (401 on a fake token,
degrading gracefully), sensitive-field vault masking, and the workflow's
guard/assert behaviour.

### Next: Phase 2 — `garmin-devices` + capabilities

Add the device-inventory model and its derived capability map, then the first
parent workflow that gates domain jobs on those capabilities.

## 13. Phase 2 status (complete)

Shipped in the `@svendowideit/garmin` package (renamed from
`@svendowideit/garmin-connect` in Phase 2, matching §5):

- `garmin_cache.ts` — extracted the shared on-disk cache (key scheme, layout,
  `readCachedByPath`) so the transport writes and every domain model reads
  through one contract.
- `garmin_devices.ts` — the `@svendowideit/garmin-devices` model. Methods:
  `setup`, `paths`, `sync`. Resources: `devices` → `device-list`,
  `capabilities` → `device-capabilities`, `paths`, `setup`. Derives a
  capability map from the device inventory + user settings, with
  `capabilityOverrides` for correction and `confidence`/`unknownProducts` for
  auditability.
- `garmin-devices-sync.yaml` — the **reference transport→domain seam**:
  `garmin-session` → `garmin-devices.paths` → `garmin-connect.fetch-many` →
  `garmin-devices.sync` → assert. Cron `10 5 * * *`.
- 11 new device/capability unit tests (36 total).
- Package renamed to `@svendowideit/garmin`; README rewritten as a package-level
  doc; manifest lists both model types and both workflows.

Verified: the nested workflow ran end to end against a synthetic cache (all
transport calls cache-hits), deriving watch+cycling capabilities across two
devices.

### Next: Phase 3 — `garmin-activities` + `garmin-download`

Activity list, per-activity detail, and FIT/TCX/GPX orchestration built on the
transport's `download`.

## 14. Phase 3 status (complete)

Shipped in the `@svendowideit/garmin` package:

- `garmin_connect.ts` extended: `download` refactored onto a shared
  `downloadOne` helper, plus a new fan-out **`download-many`** (skips existing,
  caps a backlog via `maxDownloads`, continues past one failure, reports
  `downloaded`/`skipped`/`failed`/`failedIds`). New `downloads` batch resource.
- `garmin_activities.ts` — the `@svendowideit/garmin-activities` model. Methods:
  `setup`, `activity-list-path`, `detail-paths`, `sync`. Resources: `activity`
  → `activity-<id>`, `list` → `activity-list`, `detail` → `detail-<id>-<kind>`,
  `paths`, `setup`. Pure path builders + defensive normalisation (common and
  strength-specific fields).
- `garmin-activities-sync.yaml` — high-volume seam: session → list path →
  detail paths → `fetch-many` (list) → `fetch-many` (detail) → sync → assert.
  Cron `20 5 * * *`.
- `garmin-download.yaml` — on-demand: session → assert list → `download-many` →
  assert.
- 11 new activity unit tests (47 total).

Design notes:

- **Per-activity detail fans into one `fetch-many`**, not N parallel `fetch`
  calls — one per-model lock acquisition (repository fan-out rule).
- **`detail-paths` reads its own previous `activity-list`** when `ids` is
  omitted, so the workflow needs no fragile CEL and behaves on the first run
  (empty result → guarded fetch skip). Detail sync is therefore two-pass, which
  is documented.
- **`download-many` is idempotent and interruptible**: `skipExisting` makes
  re-runs cheap, and the per-call cap spreads a large backfill across runs.

Verified: the full workflow ran against a synthetic cache — 3 activities across
cycling/running/strength normalised correctly, 9 detail responses parsed from
cache, and `download-many` continued past two failed downloads and reported them
in `failedIds`.

### Next: Phase 4 — `garmin-health` + `garmin-body`

Daily wellness (summary, sleep, stress, HR, body battery, SpO2, respiration,
HRV) and weight/body composition, both gated by the device capability map.

## 15. Phase 4 status (complete)

Shipped in the `@svendowideit/garmin` package:

- `garmin_connect.ts` extended with a `profile` method + `profile` resource:
  several wellness endpoints are addressed by the user's **display name**, so
  the transport records it once (`displayName` + `displayNameEncoded`) for the
  health model to consume. Cache-first, with a `displayName` override arg.
- `garmin_health.ts` — the `@svendowideit/garmin-health` model. Methods:
  `setup`, `paths`, `sync`. Resources: `daily` → `daily-<date>`, `range` →
  `health-range`, `paths`, `setup`. A metric registry (13 metrics) with per-
  metric path builders, display-name handling, and capability gating via
  `selectMetrics`. `mergeMetric` defensively folds each metric body into one
  per-day summary.
- `garmin_body.ts` — the `@svendowideit/garmin-body` model. Methods: `setup`,
  `paths`, `sync`. Resources: `weighIn` → `weigh-in-<date>`, `range` →
  `body-range`, `paths`, `setup`. Range or per-day modes; grams→display-unit
  normalisation; keeps the latest sample per day; `hasBodyComposition` flag.
- `garmin-health-sync.yaml` (cron `30 5 * * *`) and `garmin-body-sync.yaml`
  (cron `40 5 * * *`).
- 28 new unit tests (75 total).

Design notes:

- **A domain model never reads another model's resource.** The health model needs
  the capability map and the display name, which live on other models; it takes
  them as **method arguments** wired in by the workflow via CEL, falling back to
  the cached social profile for the display name. `setup`, which runs standalone,
  reads the cached profile and shows the ungated metric set with a note.
- **Gating is bidirectional and visible.** `selectMetrics` returns both the
  selected and skipped metrics so the workflow logs *why* a metric is absent.
- **Absent ≠ zero.** Every optional wellness/body field is `null` when not
  recorded, with an explicit `hasBodyComposition` flag for body data.

Two real bugs were found by the tests and fixed: Garmin stores weight in **grams
regardless of `unitKey`** (the community libraries all divide by 1000), and
Garmin timestamps are naive strings that JS parses as *local* time, shifting the
calendar date — the date is now taken from the string's own date part.

Verified: both workflows ran end to end against a synthetic cache. Health
produced 4 metrics with no capability map and **7 with it** (sleep score 82
extracted from the nested shape); body produced 2 weigh-ins where the
composition-bearing one carried fat %/metabolic age and the weight-only one
correctly showed `null`, with `hasBodyComposition: true` for the range.

### Next: Phase 5 — `garmin-performance`

Training status/readiness, VO2max, race predictions, FTP and personal records,
gated by the capability map.

## 16. Phase 5 status (complete)

Shipped in the `@svendowideit/garmin` package:

- `garmin_performance.ts` — the `@svendowideit/garmin-performance` model.
  Methods: `setup`, `paths`, `sync`. Resources: `metrics` → `metrics-<date>`,
  `range` → `performance-range`, `records`, `paths`, `setup`. A metric registry
  (9 metrics) split into **daily** (training status/readiness, VO2max, race
  predictions, endurance/hill score, fitness age) and **latest** (FTP, personal
  records). `mergeMetric` handles the differently-shaped responses; `parseFtp`
  and `parsePersonalRecords` extract the date-less values; `sync` also records
  window bests.
- `garmin-performance-sync.yaml` — session → `profile` → `performance.paths`
  (gated) → `fetch-many` → `sync` → assert. Cron `50 5 * * *`.
- 18 new unit tests (93 total).

Design notes:

- **Two metric kinds share one model.** Daily metrics expand to one path per day;
  latest metrics contribute exactly one path. `latestOnly` drops the daily paths
  for a cheap refresh.
- **Shapes differ**, so parsing is per-metric: training status nests per device,
  training readiness is a list of snapshots (the newest wins), VO2max is one
  level down per sport (`generic`/`cycling`), and race predictions arrive as
  either seconds or clock strings — all normalised.
- **`records` is separate from `range`** because FTP and personal records have no
  calendar date, so they cannot live in a date-keyed row.

Verified: the workflow ran end to end against a synthetic cache. With no cycling
capability, FTP was correctly skipped (4 daily + 1 latest path); with gating off
it fetched and parsed FTP 285, endurance 6500 and hill 72 alongside VO2max 45.3
(running) / 52.1 (cycling), training status PRODUCTIVE, and a 5K personal
record.

### Remaining

Optional/feature-gated packs (`garmin-golf`, `garmin-nutrition`,
`garmin-menstrual`) and a `garmin-summary` report remain, per §5/§6. The core
domain models planned in §5 are now all shipped.
