# @svendowideit/zwift-coach

Turn your own Zwift and Garmin history into a periodised training plan and
validated `.zwo` workouts. This is the read-only Phase 1/2 coach. Delivery (SSH/SCP, local, sync,
bundle) and custom/agent goals are later phases.

## What it does

Most plans ask you to guess your available days and hours. This one derives
them from the history you already have:

- Backfills every Zwift ride the API returns, parses each FIT for normalised
  power, and merges as much Garmin history as exists.
- Is incremental: the activity list is re-read, cached detail/NP is reused, and
  only new rides or rides newer than `refreshDays` are refreshed.
- Computes TSS, CTL/ATL/TSB, yearly totals, power peaks and the FTP at each
  ride.
- Infers availability: p80 days/week and hours/week, preferred weekdays and
  start hours, p90 session length, recent 8-week trend and gap.
- Reads Garmin weight/body composition and wellness/readiness when available.
- Classifies your ride mix (race / banded / group / workout / solo) so the one
  fun session each week matches what you actually enjoy.
- Builds a periodised plan with one title/hook/why per session, recovery weeks,
  age/readiness-aware ramp and a taper.
- Renders conservative `.zwo` XML, validated for block count, file size and
  power/duration sanity.

## Install

```sh
swamp extension pull @svendowideit/zwift-coach
```

Install `@svendowideit/garmin` if you want outdoor history, weight/body
composition, readiness and performance data.

## Getting a more complete Garmin history

The coach reads the `garmin-activities` `activity-list`. To pull a wider cycling
window before planning:

```sh
swamp workflow run @svendowideit/garmin-activities-sync \
  --input startDate=2015-01-01 --input activityType=cycling
```

Garmin returns one list window per run. If your history is larger than one
response, run successive date windows and leave the window you want the coach to
use as the last run; the coach reads the most recent `activity-list`. Garmin is
optional.

## Configuration

### Coach workflow inputs (`@svendowideit/zwift-coach-plan`)

| Input | Default | Meaning |
| --- | --- | --- |
| `goal` | `improve` | `regain`, `improve` or `event` |
| `targetDate` | empty | `YYYY-MM-DD` for an event goal |
| `targetFtpPct` | `0.05` | FTP improvement fraction for `improve` |
| `targetWeightKg` | `65` | Optional secondary weight target |
| `daysPerWeek` | `0` | Override; 0 = infer from merged history |
| `hoursPerWeek` | `0` | Override; 0 = infer from merged history |
| `overrideAvailability` | `false` | Use explicit values even above the p80 |
| `backfillDays` | `3650` | Zwift history window |
| `backfillMaxActivities` | `2000` | Max Zwift activities to request |
| `includeFit` | `true` | Parse Zwift FIT NP only when it is not cached |
| `refreshDays` | `7` | Refresh detail for rides newer than this many days |
| `force` | `false` | Ignore the cached history and re-fetch every ride (repair only) |
| `fitConcurrency` | `4` | Parallel FIT downloads during a backfill (1–8) |
| `horizonDays` | `14` | Render this many days from the plan start |
| `weeks` | `0` | Override plan length; 0 = goal default |
| `age` | `0` | Override; 0 = Garmin/profile |
| `startDate` | empty | Plan start (Monday); empty = next Monday |

## Examples

```sh
# 1. Backfill every available Zwift ride, parse FITs (NP) and merge Garmin.
swamp workflow run @svendowideit/zwift-coach-backfill \
  --input backfillDays=3650 --input includeFit=true

# 2. Analyse, compile an improve goal, plan 12 weeks, render 14 days and
#    write a preview. Days/hours come from the merged history, not a guess.
swamp workflow run @svendowideit/zwift-coach-plan \
  --input goal=improve --input targetFtpPct=0.05

# 3. Regain the fitness you had, using the sustained peak CTL/FTP. The plan
#    starts at the next Monday and uses your historical days/hours.
swamp workflow run @svendowideit/zwift-coach-plan --input goal=regain
```

## Reading the result

The plan workflow ends with a guided list. Start with the human-readable
preview, then inspect JSON only if you need to compare load or edit the plan:

```sh
# Start here: one section per week, with each session's date, title, duration,
# TSS and one-line "why".
swamp data query 'behavior("zwift-coach") && name == "preview-current"' \
  --single --json --select content | jq -r '.markdown'

# Then: the structured first week (phase, target/actual TSS, session targets).
swamp data query 'behavior("zwift-coach") && name == "plan-current"' \
  --single --json --select content | jq '.weeks[0]'

# Workouts ready for delivery (not installed in this phase).
swamp data query 'behavior("zwift-coach") && name == "render-current"' \
  --single --json --select content | jq '.workouts[] | {date,title,filename,size}'

# Only if something looks wrong: NP/estimated/missing and FIT-reuse counts.
swamp data query 'modelType == "@svendowideit/zwift-rider" && name == "training-history"' \
  --single --json --select content | jq '.dataQuality'
```

## Details

### Coach methods

| Type | Method | Purpose |
| --- | --- | --- |
| `@svendowideit/zwift-coach` | `setup` | Read-only report of expected resources |
| `@svendowideit/zwift-coach` | `analyze` | Build `fitness-current` |
| `@svendowideit/zwift-coach` | `goal` | Compile `regain`/`improve`/`event` into `goal-current` |
| `@svendowideit/zwift-coach` | `plan` | Generate `plan-current` weeks/sessions |
| `@svendowideit/zwift-coach` | `render` | Render `workout-*` + `render-current` ZWO |
| `@svendowideit/zwift-coach` | `preview` | Write `preview-current` markdown |
| `@svendowideit/zwift-coach` | `howto` | Log the guided commands for inspecting the result |

### Coach resources

- `fitness-current` — current/peak fitness, availability, weight, readiness,
  ride flavour and flags.
- `goal-current` — compiled targets, assumptions and warnings.
- `plan-current` — weeks and sessions (no XML).
- `workout-<session>` / `render-current` — rendered ZWO and its index.
- `preview-current` — human-readable markdown.
- `howto-current` — the guided reading list.

### Safety and limits

- Ramp defaults: under 40 → 5 CTL/week, 40–49 → 4, 50–59 → 3, 60+ → 2.5, with
  recovery weeks more frequent with age.
- Readiness (Garmin HRV/resting HR/sleep/training readiness) and a detraining
  gap adjust the plan; a stale FTP produces a benchmark warning.
- The plan is a suggestion, not medical advice. Weight tracking does not
  prescribe calories; rapid/unintentional loss is a stop flag.
- ZWO validation enforces ≤250 blocks, <64 KB and sane power/duration ranges.
