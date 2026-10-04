# @svendowideit/fitness-refresh

Refresh every Garmin and Zwift data source in one ordered run, so a downstream
consumer (the diary, a report, a dashboard) always reads a complete, current
local day.

Garmin and Zwift each publish their data through several workflows on their own
schedules. A consumer that runs in between sees a half-populated day: wellness
without yesterday's sleep, an activity list missing the current day, a calendar
that has not been re-ranked. This extension ships one workflow that runs them
all, in the order that matters, for your local calendar day.

## What it does

`@svendowideit/fitness-refresh` runs five child workflows in sequence:

1. **`@svendowideit/garmin-devices-sync`** — derive the Garmin device capability
   map. This must run first: the health sync *gates* sleep, stress and body
   battery on the map, and with an empty map it silently drops them — including
   the sleep score.
2. **`@svendowideit/garmin-health-sync`** — wellness for the last few local days
   through today (last night's sleep, today's running step count), resolved in
   the configured timezone, not UTC.
3. **`@svendowideit/garmin-activities-sync`** — the activity history, with the
   window ending on today-local so the current day is included.
4. **`@svendowideit/zwift-sync`** — ride history and the upcoming event calendar.
5. **`@svendowideit/zwift-recommend`** — rank the freshly synced calendar against
   the rider profile.

Every step re-establishes the auth session it needs, so the workflow is
idempotent and safe to run repeatedly. It is read-only with respect to your
diary: it writes data only, and anything you run afterwards reads it.

## Install

```sh
swamp extension pull @svendowideit/fitness-refresh
```

`@svendowideit/garmin` and `@svendowideit/zwift` are declared as dependencies and
pulled by the same command.

## Configuration

| Input | Type | Default | Meaning |
| --- | --- | --- | --- |
| `timezone` | string | `Australia/Brisbane` | IANA zone that defines "today" and buckets ride/event times. |
| `healthDays` | integer | `3` | Local wellness days through today (capped at 14). |
| `forceRefresh` | boolean | `true` | Re-fetch from Garmin even when a cached response exists. A "refresh" must actually re-read Garmin: the activity-list URL is the same all day, so a cache-first run re-serves the morning's list and misses a ride finished since. |
| `sessionName` | string | `garmin-connect` | Garmin transport instance. |
| `devicesName` | string | `garmin-devices` | Devices/capability instance. |
| `healthName` | string | `garmin-health` | Wellness instance. |
| `activitiesName` | string | `garmin-activities` | Activity-history instance. |
| `riderName` | string | `zwift-rider` | Zwift rider-profile instance. |
| `eventsName` | string | `zwift-events` | Zwift event-calendar instance. |
| `recommenderName` | string | `zwift-recommender` | Zwift recommender instance. |

The trigger is `0 */3 * * *` (every 3 hours, host-local) while `swamp serve`
runs. Note that `swamp serve --no-schedule` disables triggers entirely.

## Examples

```sh
# Sync everything for the local day. Run this before your diary/report job.
swamp workflow run @svendowideit/fitness-refresh

# Running somewhere other than the author's zone, so "today" and the ride and
# event bucketing match where you are.
swamp workflow run @svendowideit/fitness-refresh --input timezone=Europe/London

# After a week away, widen the wellness window so the missing days are filled
# (the run is idempotent; already-seen days are simply re-parsed).
swamp workflow run @svendowideit/fitness-refresh --input healthDays=7

# Check what the refresh produced before running a consumer.
swamp data get garmin-health health-range --json | jq '.content.summaries[-1]'
swamp data get zwift-recommender current --json | jq '.content.recommendations[0]'
```

## Details

### Workflow

`fitness-refresh.yaml` (name `@svendowideit/fitness-refresh`) is a single job
whose five steps are nested `workflow` tasks (`garmin-devices` → `garmin-health`
→ `garmin-activities` → `zwift-sync` → `zwift-recommend`). `garmin-devices` and
`garmin-activities` run before the others; `garmin-health` waits on
`garmin-devices` so the capability map is present when it builds its paths.

There are no models, reports, vaults, or datastores in this extension — it is a
thin orchestrator over the Garmin and Zwift extensions' own workflows. This is
deliberate: those extensions own the auth, parsing, and rate-limiting, and this
one only orders them.

### Prerequisites

- `@svendowideit/garmin` credentials in the `garmin-secrets` vault, and
  `@svendowideit/zwift` credentials in `zwift-secrets`. See those extensions'
  READMEs for the one-time setup.
- `swamp serve` must not be running with `--no-schedule` if you want the
  3-hourly trigger to fire; manual `swamp workflow run` always works.

### Extending it

Add a child workflow with another `type: workflow` step and a `dependsOn` edge.
Keep `garmin-devices-sync` first — it is what stops the health sync from
dropping device-gated metrics. If a source you add is not idempotent, put it
behind a guard rather than reordering the existing steps.

## License

MIT — see LICENSE.txt.
