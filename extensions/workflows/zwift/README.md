# @svendowideit/zwift

Retrieve your Zwift ride history and upcoming calendar, then get told **which
events to enter** — ranked against what you can actually do and when you
actually ride.

Zwift has no public API and no recommendation feature. This extension fills that
gap with three model types and two workflows:

- **`@svendowideit/zwift-rider`** — signs in to your Zwift account, pulls your
  profile and recent rides, and derives a **recency-decayed** ability profile
  (w/kg band, typical duration, hour-of-day and duration habits).
- **`@svendowideit/zwift-events`** — pulls every race and group event in the
  next 10 days from Zwift's public calendar. No account needed.
- **`@svendowideit/zwift-recommender`** — joins the two and scores each event
  subgroup on ability fit, habit fit, freshness, availability and a race/ride
  bias, emitting every component so a pick can be audited.
- **`zwift-sync`** / **`zwift-recommend`** — the scheduled workflows that wire
  them together.

The endpoints are undocumented and may change. This extension is read-only: it
never writes to your Zwift account.

## What it does

Zwift's own calendar makes you scan hundreds of events by hand, and it does not
know that you are a Cat C rider who normally trains for an hour at 6am. This
extension reads your own history from Zwift, weights recent rides more heavily
than old ones (a configurable half-life, 21 days by default), and ranks the
upcoming calendar against that profile.

For every candidate event subgroup it computes and records:

| Component      | What it measures                                                                 |
| -------------- | -------------------------------------------------------------------------------- |
| `ability`      | how the subgroup's race category (A–E) or w/kg pace band compares with your w/kg |
| `timing`       | how closely the local start hour matches your decayed hour-of-day histogram      |
| `duration`     | how closely the estimated event length matches your decayed duration histogram   |
| `freshness`    | whether you have done that route/event recently (a repeat penalty)               |
| `availability` | a bonus for your habitual hours and a blunt penalty for the small hours          |
| `typeAffinity` | the `raceBias` dial: races vs group rides                                        |

The output is a ranked list with a human-readable `reason` per pick, so you can
see _why_ something was recommended rather than trusting a black box.

## Install

```sh
swamp extension pull @svendowideit/zwift
```

That is the whole install. The workflows auto-create the model instances
(`zwift-rider`, `zwift-events`, `zwift-recommender`) on first run — there is no
`swamp model create` prerequisite.

The one thing you must supply yourself is a credential in a vault, because your
ride history is private. Create the vault first, then store the credential in
it:

```sh
# Create a vault to hold the credential. This example uses the systemd-creds
# backend — secrets encrypted at rest (AES256-GCM, bound to your UID +
# machine-id), no daemon, requires systemd v256+. Any vault type works; see
# https://swamp-club.com/manual/reference/vaults
swamp vault create @svendowideit/systemd-creds zwift-secrets

# Store your Zwift account credentials (or a refresh token) once. Prefer a
# refresh token: once one is stored, the password is no longer needed.
swamp vault put zwift-secrets ZWIFT_USERNAME
swamp vault put zwift-secrets ZWIFT_PASSWORD
```

If you would rather not stand up a backend, `local_encryption` is built in and
needs no extra extension:

```sh
swamp vault create local_encryption zwift-secrets
```

See the [Vaults reference](https://swamp-club.com/manual/reference/vaults) for
every backend (AWS Secrets Manager, Azure Key Vault, 1Password, and yours via
`extensions/vaults/`).

## Configuration

All configuration is global arguments on the models plus inputs on the
workflows. Set them on the model instance (recommended, because scheduled runs
have no `--input`), or override per run for a one-off.

### `zwift-sync` workflow inputs

| Input          | Type    | Default        | Meaning                                                                             |
| -------------- | ------- | -------------- | ----------------------------------------------------------------------------------- |
| `riderName`    | string  | `zwift-rider`  | Rider model instance name.                                                          |
| `eventsName`   | string  | `zwift-events` | Events model instance name.                                                         |
| `historyDays`  | integer | `120`          | How many days of ride history to keep.                                              |
| `halfLifeDays` | number  | `21`           | Recency half-life — a ride this old counts half as much as today's.                 |
| `horizonDays`  | number  | `10`           | How many days ahead to collect events.                                              |
| `timezone`     | string  | `""`           | IANA zone (e.g. `Australia/Brisbane`) for local-time bucketing; empty = host local. |
| `sport`        | string  | `""`           | Keep only `CYCLING` or `RUNNING`; empty = all.                                      |

### `zwift-recommend` workflow inputs

| Input               | Type    | Default             | Meaning                                                             |
| ------------------- | ------- | ------------------- | ------------------------------------------------------------------- |
| `riderName`         | string  | `zwift-rider`       | Rider instance to read ability/history from.                        |
| `eventsName`        | string  | `zwift-events`      | Events instance to read the schedule from.                          |
| `recommenderName`   | string  | `zwift-recommender` | Recommender instance name.                                          |
| `topN`              | integer | `12`                | How many picks to return.                                           |
| `raceBias`          | number  | `0.6`               | `0.5` neutral, `1` strongly prefers races, `0` prefers group rides. |
| `includeGroupRides` | boolean | `true`              | `false` = races and TTs only.                                       |
| `horizonDays`       | number  | `10`                | Only recommend events within this window.                           |
| `halfLifeDays`      | number  | `21`                | Recency half-life used when scoring habit fit.                      |
| `explain`           | boolean | `true`              | Attach a `reason` to each recommendation.                           |

### `zwift-rider` global arguments

| Argument                                 | Type    | Default                          | Meaning                                                                    |
| ---------------------------------------- | ------- | -------------------------------- | -------------------------------------------------------------------------- |
| `vaultName`                              | string  | `zwift-secrets`                  | Vault to read credentials from and persist the rotated refresh token into. |
| `usernameKey`                            | string  | `ZWIFT_USERNAME`                 | Vault key for the account email/username.                                  |
| `passwordKey`                            | string  | `ZWIFT_PASSWORD`                 | Vault key for the account password.                                        |
| `refreshTokenKey`                        | string  | `ZWIFT_REFRESH_TOKEN`            | Vault key for a pre-obtained refresh token.                                |
| `username` / `password` / `refreshToken` | string  | —                                | Optional inline overrides; normally use the vault.                         |
| `apiBase`                                | string  | `https://us-or-rly101.zwift.com` | Zwift REST base URL.                                                       |
| `authBase`                               | string  | `https://secure.zwift.com`       | Zwift Keycloak base URL.                                                   |
| `timezone`                               | string  | `""`                             | IANA zone for ride bucketing; empty = host local.                          |
| `historyDays`                            | integer | `120`                            | Window of rides to keep.                                                   |
| `halfLifeDays`                           | number  | `21`                             | Recency half-life in days.                                                 |
| `maxActivities`                          | integer | `400`                            | Max activities requested from Zwift.                                       |
| `sport`                                  | string  | `""`                             | Keep only `CYCLING` or `RUNNING`.                                          |

### `zwift-events` global arguments

| Argument             | Type     | Default                 | Meaning                                                 |
| -------------------- | -------- | ----------------------- | ------------------------------------------------------- |
| `horizonDays`        | number   | `10`                    | Days ahead to collect.                                  |
| `maxSeries`          | integer  | `40`                    | Max event series to expand (one request each).          |
| `maxEventsPerSeries` | integer  | `200`                   | Max events requested per series.                        |
| `sports`             | string[] | `["CYCLING"]`           | Sports to include.                                      |
| `eventTypes`         | string[] | races, TTs, group rides | Event types to include.                                 |
| `includePrivate`     | boolean  | `false`                 | Include private/unlisted events.                        |
| `referenceSpeedKph`  | number   | `32`                    | Speed used to estimate a duration when Zwift omits one. |

### `zwift-recommender` global arguments

| Argument            | Type    | Default   | Meaning                                         |
| ------------------- | ------- | --------- | ----------------------------------------------- |
| `timezone`          | string  | `""`      | Must match the rider model's timezone.          |
| `topN`              | integer | `12`      | Picks to return.                                |
| `horizonDays`       | number  | `10`      | Scoring window.                                 |
| `raceBias`          | number  | `0.6`     | Race vs ride preference.                        |
| `hourTolerance`     | number  | `2`       | Hours of slack when matching start time.        |
| `durationTolerance` | number  | `2`       | Buckets of slack when matching length.          |
| `repeatWindowDays`  | number  | `14`      | Repeat penalty look-back window.                |
| `repeatPenalty`     | number  | `0.35`    | Multiplier applied to recently repeated routes. |
| `maxPerSeries`      | integer | `2`       | Diversity cap per series/recurring event.       |
| `weights`           | object  | see below | Relative weights of each component.             |

Default `weights`: `ability: 0.35`, `timing: 0.3`, `duration: 0.2`,
`freshness: 0.1`, `availability: 0.05`.

## Examples

```sh
# Create the vault that holds your credential (systemd-creds backend here; any
# type works). Skip this if you already have a vault named zwift-secrets.
swamp vault create @svendowideit/systemd-creds zwift-secrets

# Store credentials once — the sync workflow persists the rotated refresh
# token, so later runs do not need the password.
swamp vault put zwift-secrets ZWIFT_USERNAME
swamp vault put zwift-secrets ZWIFT_PASSWORD

# Verify configuration and see exactly what is missing (read-only).
swamp model @svendowideit/zwift-rider method run setup zwift-rider

# Sync 120 days of history and derive the ability profile, by hand.
swamp workflow run @svendowideit/zwift-sync

# Widen the history window and shrink the decay half-life for a rider coming
# back from injury, then re-derive the profile.
swamp workflow run @svendowideit/zwift-sync --input historyDays=180 --input halfLifeDays=14

# Collect two weeks of events instead of the default ten days.
swamp workflow run @svendowideit/zwift-sync --input horizonDays=14

# Rank races and group rides, with reasons attached.
swamp workflow run @svendowideit/zwift-recommend

# Only recommend races, and only the top 8.
swamp workflow run @svendowideit/zwift-recommend --input includeGroupRides=false --input topN=8

# Inspect the picks — score, start time and the reason for each.
swamp data get zwift-recommender current --json \
  | jq '.content.recommendations[] | {rank, score, eventName, reason}'

# Run a one-off recommendation with a stronger race preference and a shorter
# window, without changing the model's stored settings.
swamp workflow run @svendowideit/zwift-recommend \
  --input raceBias=0.9 --input horizonDays=7
```

## Details

### What it installs

Nothing on the host. Two cron triggers are registered when `swamp serve` runs:
`@svendowideit/zwift-sync` at `0 6,12,15 * * *` and `zwift-recommend` at
`30 6,12,15 * * *`. No services, no daemons, no webhooks.

### Models and methods

| Type                              | Method      | Purpose                                                                                                       |
| --------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------- |
| `@svendowideit/zwift-rider`       | `setup`     | Report credential/config readiness and the exact commands to fix gaps. Read-only; never prints a secret.      |
| `@svendowideit/zwift-rider`       | `sync`      | Sign in, fetch profile + activities, persist each ride, derive the ability profile, rotate the refresh token. |
| `@svendowideit/zwift-events`      | `fetch`     | Collect events over the horizon by expanding the series the public feed references.                           |
| `@svendowideit/zwift-recommender` | `recommend` | Score every event subgroup against the rider profile and write the ranked top N.                              |

### Resources (data contract)

`zwift-rider` writes: `activity-<id>` (one per ride), `history-current` (all
rides in one array, for a single CEL expression), `profile-current`,
`ability-current`, `session-auth` (the refresh token, marked `sensitive: true`
so swamp stores it in the vault) and `sync-summary`.

`zwift-events` writes `upcoming` — every event and subgroup in the window.

`zwift-recommender` writes `current` — the ranked set plus the profile context.

### How the workflows wire together

`zwift-sync` runs two jobs in parallel (different models, so no lock
contention). `zwift-recommend` reads across models using CEL, never re-fetching:

```yaml
ability: ${{ data.latest(inputs.riderName, "ability-current").attributes }}
schedule: ${{ data.latest(inputs.eventsName, "upcoming").attributes }}
recentRides: ${{ data.latest(inputs.riderName, "history-current").?attributes.?rides.orValue([]) }}
```

An `assert` step fails the run with a clear message when the sync workflow has
not produced those resources yet.

### Local-time scheduling

"Three times a day at 6am, midday and 3pm **local time**, not UTC" is expressed
as the cron `0 6,12,15 * * *` (and `30 6,12,15 * * *` for the recommender).
swamp's scheduler (`Deno.cron`, registered by `swamp serve`) evaluates the cron
in the **host process's local timezone**; swamp has no per-workflow `timezone`
field.

So to fire at the user's local wall-clock times, `swamp serve` must run in that
timezone. On the user's own machine that is automatic. On a server, set it in
the service environment, e.g.:

```ini
[Service]
Environment=TZ=Australia/Brisbane
Environment=HOME=/root
```

The `timezone` global argument on the models is separate and does the
_reporting_ work — it decides which local hour a ride or event start maps to, so
the habit histogram is correct even if the scheduler and the rider are in
different zones. Set it explicitly whenever the host TZ is not the rider's.

### How the ranking works

1. Every event subgroup in the window becomes a candidate (start in the future,
   inside the horizon).
2. Each is scored on the five components plus the type-affinity dial.
3. Candidates are sorted by score.
4. A diversity cap (`maxPerSeries`) keeps one busy recurring series from filling
   the list; leftover slots are then filled by score.

`abilityFit` penalises being under-qualified less than being wildly
over-qualified, so a marginally harder race can still outrank a trivial one.
`freshnessScore` decays towards `repeatPenalty` as a repeat gets more recent, so
yesterday's route is suppressed more than one from a fortnight ago.

### Credentials and security

- Credentials are read from the vault, never hard-coded. The `session-auth`
  resource stores the rotated refresh token with `z.meta({ sensitive: true })`,
  so swamp keeps the value in the vault, not in the resource file.
- A refresh token is preferred over a password, and once stored, the password is
  no longer needed.
- Error messages surface Keycloak's own reason and never include the credential.
- The model is read-only against Zwift.

### Project structure

```
extensions/workflows/zwift/
  manifest.yaml
  zwift_auth.ts            # Keycloak password/refresh grant + redaction
  zwift_util.ts            # date parsing, local-time bucketing, decay, histograms
  zwift_rider.ts           # @svendowideit/zwift-rider
  zwift_events.ts          # @svendowideit/zwift-events
  zwift_recommender.ts     # @svendowideit/zwift-recommender
  *_test.ts                # unit tests (no network)
  README.md
  LICENSE.txt
```

Pure logic — bucketing, decay, scoring, parsing — lives in exported functions so
it can be tested without a Zwift account or a network. The models are thin
wrappers that fetch, normalise, and write resources.

### Extending and testing

Add a method by adding a key to `methods` in the relevant model file, give it a
Zod `arguments` schema, and document it here. Keep the network call in a small
helper and put any decision logic in an exported pure function.

```sh
# Unit tests (no network, no credentials).
~/.swamp/deno/deno test

# Type-check one file.
~/.swamp/deno/deno check zwift_recommender.ts

# Docs contract: manifest + README must score at or above the threshold.
swamp workflow run @svendowideit/meta-factory \
  --input manifest=extensions/workflows/zwift/manifest.yaml
```

Known limitations:

- Zwift's public event feed is capped at 200 events and ignores its
  `event_starts_after` parameter; the horizon is completed by expanding each
  referenced **series**, so an event with no series and a start more than a few
  hours out may be missed. `maxSeries` bounds the extra requests.
- Durations are often zero in the calendar; they are estimated from distance and
  `referenceSpeedKph` and flagged `durationEstimated`.
- Zwift sometimes omits average power on activities, in which case ability falls
  back to the profile FTP or the best-power curve.
