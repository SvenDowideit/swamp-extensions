# @svendowideit/zwift-coach

Turn your own Zwift and Garmin history into a periodised training plan and
validated `.zwo` workouts, then deliver the workouts to Zwift over SSH, a local
workouts folder, a sync folder or a portable bundle. Built-in goals cover
regain/improve/event; custom goals (including sprint and max-wattage targets)
come from the rider's own words or a validated agent-authored PlanSpec.

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
- Parses custom goals deterministically: power for a duration, max wattage,
  FTP, w/kg, CTL, weight, a horizon and days/hours. Ambiguous goals return
  clarifying questions instead of inventing a target.
- Exposes `GoalSpec`/`PlanSpec` schemas, examples, safety limits and a prompt
  through `scaffold-current`. An external agent (for example opencode) can
  author a `PlanSpec`; `validate-current` rejects raw XML, unsafe session
  frequency, consecutive hard days, phase-length drift and over-cap sessions
  before anything is rendered.
- Delivers the rendered files. The coach model writes local, sync-folder and
  bundle outputs itself; SSH and SCP are delegated to the existing
  `@swamp/ssh` extension, never reimplemented here.
- Delivers idempotently: it writes atomically, refuses to overwrite a file
  without the coach marker, skips files that are already current, and can prune
  only its own older workouts.

Auto-delivery tries each channel in this order and stops at the first one that
works:

1. SSH through `@swamp/ssh`
2. local/mounted Zwift workouts folder
3. sync folder (Syncthing, Dropbox, Nextcloud, iCloud Drive)
4. portable bundle (always succeeds)

## Install

```sh
swamp extension pull @svendowideit/zwift-coach
```

`@svendowideit/zwift` and `@swamp/ssh` are pulled automatically because they are
declared as dependencies.

Install `@svendowideit/garmin` if you want outdoor history, weight/body
composition, readiness and performance data.

## Setup

Run the read-only setup check once to confirm the Zwift credentials, history
depth, FTP and Garmin availability. It reuses whatever
`@svendowideit/zwift-rider` and the optional `@svendowideit/garmin-*` models have
already written, so you do not re-enter FTP or history. It prints what the coach
expects and what to fix; it does not print secrets and does not write plan data.
A missing required resource stops the plan workflow before it plans.

```sh
swamp model @svendowideit/zwift-rider method run setup zwift-rider
```

Then backfill the history once, or whenever you want fresh data:

```sh
swamp workflow run @svendowideit/zwift-coach-backfill \
  --input backfillDays=3650 --input includeFit=true
```

Choose one delivery path and put it in the plan workflow or an explicit
delivery workflow:

- `workoutsDir` + `riderId` when swamp can write Zwift's workouts folder.
- `syncDir` when a file-sync tool mirrors that folder to the Zwift host.
- `sshAddress` when the Zwift host is remote and reachable with `ssh`/`scp`.
  `sshUser`, `sshKey` and `sshPort` are optional overrides; leave them empty to
  use your normal ssh config and agent, exactly as `ssh macmini` does.
- Nothing when you want the portable bundle fallback.

## Upgrade

```sh
swamp extension pull @svendowideit/zwift-coach
```

Pulling the extension again replaces the installed model and workflows with the
current published version. This extension installs no services or host files, so
there is no separate upgrade workflow: `swamp extension pull` (or
`swamp extension update`) is the whole upgrade. Existing `plan-current`,
`render-current` and `delivery-current` resources are kept; re-run the plan
workflow to render and deliver with the new version.

## Custom goals and agent-authored plans

The built-in `regain`/`improve`/`event` goals are the fast path. A goal like
“in 3 months, hold ≥700 W for 60 s and raise max wattage above 1300 W” is a
sprint/anaerobic goal, so it uses the custom workflow instead:

```sh
swamp workflow run @svendowideit/zwift-coach-custom \
  --input description="In 3 months, hold >=700W for 60s, raise max wattage above 1300W, and move toward 65kg"
```

That parses the horizon, the 60 s target, the max-wattage target and the
secondary weight target, then generates a deterministic sprint plan with
sprint, anaerobic, endurance and recovery sessions and tests on the
recovery-week cadence.

### Absolute targets, not FTP multiples

Sprint and 60 s goals are absolute-power goals. The coach reads the rider's
`power-curve-current` (`5 s`, `15 s`, `60 s`, `300 s`, `1200 s`) and writes
`FreeRide`/`MaxEffort` blocks with the target watts and current best in the
workout text. It does not derive a 1300 W max or a 700 W 60 s effort from FTP.
If the curve is missing, the plan inserts a week-0 5 s/60 s test instead of
inventing a percentage. If the gap is large, the plan says so: with a 473 W
current 60 s best, 700 W is 48% higher; the plan progresses from 473 W and puts
700 W in the peak as a stretch, rather than pretending 12 weeks will close it.

Read the curve and the gap:

```sh
swamp data query 'modelType == "@svendowideit/zwift-rider" && name == "power-curve-current"' \
  --single --json --select content | jq '.best'
```

Sprint sessions are also shaped for the rider, not for a template:

- 5–6 minute rotating primers (cadence ladder, progressive spin-up, mini-race
  opener), not a 15-minute ramp;
- separate **torque** sprints (6 s, 70–90 rpm) and **cadence** sprints (8 s,
  capped from your 5 s best-window cadence);
- a 3 s lead-in ramp, then the max effort, then a 10–20 s ramp-down and 2–3
  minutes easy — no instant jump, no coasting;
- a human-readable block summary in `preview-current` and the ZWO description,
  with watts, cadence and duration, plus a glossary for TSS/CTL/ATL/TSB/IF.

The weight target is a separate lever: Z2 volume and a weekly trend review, not
sprint intervals. The plan keeps at least one endurance session every week and
does not prescribe calories.

The extension does **not** call an LLM. To use an agent, run it with
`scaffold-current` and pass its JSON back:

```sh
# The scaffold carries the versioned PlanSpec schema, examples, availability
# and safety limits. Give it to opencode (or another agent) and ask for one
# JSON object, no prose and no XML.
swamp data query 'behavior("zwift-coach") && name == "scaffold-current"' \
  --single --json --select content > scaffold.json

# Validate and plan from the agent's JSON. Validation is fail-closed: errors
# stop the workflow before render/deliver.
swamp workflow run @svendowideit/zwift-coach-custom \
  --input description="In 3 months, hold >=700W for 60s..." \
  --input planSpecJson="$(cat plan-spec.json)"
```

Read `validation-current` before trusting a plan:

```sh
swamp data query 'behavior("zwift-coach") && name == "validation-current"' \
  --single --json --select content | jq '{errors,warnings,suggestions}'
```

## Weekly review and feedback

Record how a session felt. This is the data the plan cannot infer from FIT:

```sh
swamp model @svendowideit/zwift-coach method run feedback zwift-coach \
  --input date=2026-11-18 --input enjoyment=2 --input bored=true \
  --input cadenceMaxed=true --input recoveryTooAbrupt=true
```

Then run the weekly review:

```sh
swamp workflow run @svendowideit/zwift-coach-review
```

The review:

- compares planned sessions with the rides that actually happened;
- reports completion by type, fun-session completion, enjoyment/boredom and
  weight/readiness;
- detects explicit boredom, two low ratings, two skipped fun sessions, a
  consistently skipped type, low overall adherence, cadence maxed out, abrupt
  recovery, fast/gaining/stalled weight and low readiness;
- changes only **future** weeks: rotates the fun format, swaps a boring aerobic
  type for a similar one, shortens Z2/recovery when adherence is low, protects
  readiness, adjusts sprint cadence/recovery, and changes weight volume;
- marks volume/weight adjustments on the plan so the same change is not applied
  again every week.

`review-current.summaryMarkdown` is a diary-ready weekly note. If you use
`@svendowideit/diary`, use it as the source text for the day:

```sh
swamp data query 'behavior("zwift-coach") && name == "review-current"' \
  --single --json --select content | jq -r '.summaryMarkdown'
```

The bundled `@svendowideit/zwift-coach-review` workflow runs Monday 06:00
host-local while `swamp serve` is running. Set `autoAdapt=false` to report
changes without rewriting the plan, or `autoDeliver=false` to review without
delivering.

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
| `autoDeliver` | `true` | Deliver after rendering; `false` renders only |
| `dryRun` | `false` | Stage and report, but do not write files |

### Custom workflow inputs (`@svendowideit/zwift-coach-custom`)

| Input | Default | Meaning |
| --- | --- | --- |
| `description` | empty | The rider's own goal words (required) |
| `planSpecJson` | empty | Optional agent-authored `PlanSpec` JSON |
| `equipment` | trainer, power_meter, resistance | Available equipment |
| `availableDays` | empty | ISO weekdays (1=Mon); empty = history |
| `indoorOnly` | `false` | Plan indoor sessions only |
| `injuries` | empty | Injuries or constraints to respect |
| `targetWeightKg` | `0` | 0 = parse from the description |
| `weeks` | `0` | 0 = parse the horizon from the description |
| `style` | empty | Optional `pyramidal`/`polarised`/`sprint` override |

### Delivery inputs

These are accepted by the plan and custom workflows and by the explicit
delivery workflows.

| Input | Default | Meaning |
| --- | --- | --- |
| `riderId` | empty | Zwift numeric ID; empty = `profile-current.id` |
| `workoutsDir` | empty | Local/mounted Zwift workouts folder |
| `syncDir` | empty | Folder replicated to the Zwift host |
| `bundleDir` | `.swamp/zwift-coach/bundles` | Portable bundle output |
| `subfolder` | `zwift-coach` | Isolated folder under the rider ID / sync folder |
| `prune` | `false` | Remove only marked files not in this render |
| `sshModel` | `zwift-hosts` | `@swamp/ssh` fleet name |
| `sshAddress` | empty | SSH address of the Zwift host; empty = skip SSH |
| `sshUser` | empty | SSH user; empty = ssh config/agent default |
| `sshPort` | `22` | SSH port |
| `sshKey` | empty | Identity file; empty = ssh config/agent default |
| `sshHostKeyChecking` | `accept-new` | `yes`, `accept-new`, `no` or `off` |
| `hosts` | `macmini` | Host selector passed to `@swamp/ssh` |
| `remoteWorkoutsDir` | empty | Remote folder; empty = `$HOME/Documents/Zwift/Workouts` |

### SSH prerequisites

The SSH workflow builds the `@swamp/ssh` global arguments from the inputs above,
so you do not have to pre-create a fleet model. The only required input is
`sshAddress`. Empty `sshUser`/`sshKey` are omitted from the transport, so
`@swamp/ssh` uses the current user and your normal ssh config/agent, exactly as
`ssh macmini` does. Run it explicitly first so you can see the remote path and
any host-key prompt:

```sh
swamp workflow run @svendowideit/zwift-coach-deliver-ssh \
  --input sshAddress=macmini
```

Add `--input sshUser=...` or `--input sshKey=...` only when the default user/key
does not apply. Use `--input dryRun=true` to create and check the remote folders
without copying or installing files.

### Getting a more complete Garmin history

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

## Examples

```sh
# 1. Backfill every available Zwift ride, parse FITs (NP) and merge Garmin.
#    Run this once, or whenever you want fresh history before planning.
swamp workflow run @svendowideit/zwift-coach-backfill \
  --input backfillDays=3650 --input includeFit=true

# 2. Analyse, compile an improve goal, plan 12 weeks, render 14 days and
#    auto-deliver. With no delivery input it ends at a portable bundle, which
#    is the safe default when Zwift is not reachable from this machine.
swamp workflow run @svendowideit/zwift-coach-plan \
  --input goal=improve --input targetFtpPct=0.05

# 3. Regain the fitness you had, using the sustained peak CTL/FTP, and deliver
#    straight into a local Zwift workouts folder. Change 123456 to your Zwift
#    numeric rider ID (the folder name under Workouts/).
swamp workflow run @svendowideit/zwift-coach-plan \
  --input goal=regain \
  --input workoutsDir="$HOME/Documents/Zwift/Workouts" \
  --input riderId=123456

# 4. Deliver the already-rendered workouts over SSH through @swamp/ssh. Use
#    this when Zwift runs on a different host. Only the address is required;
#    empty user/key use the current user and your ssh config/agent.
swamp workflow run @svendowideit/zwift-coach-deliver-ssh \
  --input sshAddress=macmini

# 5. Deliver into a sync folder instead. Point Syncthing/Dropbox/Nextcloud at
#    this folder and let the Zwift host mirror it; no swamp or SSH is needed on
#    the Zwift host.
swamp workflow run @svendowideit/zwift-coach-deliver-sync \
  --input syncDir="$HOME/Sync/zwift-coach"

# 6. Write a portable bundle when neither a path nor SSH is available. Copy
#    workouts/ into <Zwift>/Workouts/<riderId>/zwift-coach/.
swamp workflow run @svendowideit/zwift-coach-deliver-bundle \
  --input bundleDir="$HOME/.local/share/zwift-coach"

# 7. Custom sprint/weight goal in the rider's own words. The deterministic
#    path needs no agent and produces sprint, anaerobic, endurance and recovery
#    sessions that fit the inferred days/hours.
swamp workflow run @svendowideit/zwift-coach-custom \
  --input description="In 3 months, hold >=700W for 60s, raise max wattage above 1300W, and move toward 65kg"

# 8. Agent-authored PlanSpec. Get the schema from scaffold-current, have the
#    agent return one JSON object, then pass it back. Validation is fail-closed.
swamp workflow run @svendowideit/zwift-coach-custom \
  --input description="In 3 months, hold >=700W for 60s..." \
  --input planSpecJson="$(cat plan-spec.json)"
```

## Reading the result

The plan workflow ends with a guided list. Start with the human-readable
preview, then check delivery, then inspect JSON only if you need to compare load
or edit the plan:

```sh
# Start here: one section per week, with each session's date, title, duration,
# TSS and one-line "why".
swamp data query 'behavior("zwift-coach") && name == "preview-current"' \
  --single --json --select content | jq -r '.markdown'

# Where did delivery put the files, and did it warn about anything?
swamp data query 'behavior("zwift-coach") && name == "delivery-current"' \
  --single --json --select content | jq '{winner,destination,warnings,attempts}'

# Then: the structured first week (phase, target/actual TSS, session targets).
swamp data query 'behavior("zwift-coach") && name == "plan-current"' \
  --single --json --select content | jq '.weeks[0]'

# Workouts ready for delivery.
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
| `@svendowideit/zwift-coach` | `goal` | Compile `regain`/`improve`/`event` or a custom description into `goal-current` |
| `@svendowideit/zwift-coach` | `scaffold` | Emit `scaffold-current` PlanSpec/GoalSpec schema, example, limits and prompt |
| `@svendowideit/zwift-coach` | `validate` | Validate an agent-authored PlanSpec into `validation-current` |
| `@svendowideit/zwift-coach` | `plan` | Generate `plan-current` weeks/sessions |
| `@svendowideit/zwift-coach` | `render` | Render `workout-*` + `render-current` ZWO |
| `@svendowideit/zwift-coach` | `preview` | Write `preview-current` markdown |
| `@svendowideit/zwift-coach` | `howto` | Log the guided commands for inspecting the result |
| `@svendowideit/zwift-coach` | `feedback` | Record enjoyment, boredom, RPE, cadence/recovery feedback |
| `@svendowideit/zwift-coach` | `review` | Compare planned vs actual, adapt future weeks, write `review-current` |
| `@svendowideit/zwift-coach` | `deliver` | Write local, sync or bundle output and record it |
| `@svendowideit/zwift-coach` | `record-delivery` | Record the SSH/fallback winner and attempts |

### Coach resources

- `fitness-current` — current/peak fitness, availability, weight, readiness,
  ride flavour and flags.
- `goal-current` — compiled targets, assumptions and warnings.
- `plan-current` — weeks and sessions (no XML).
- `workout-<session>` / `render-current` — rendered ZWO and its index.
- `preview-current` — human-readable markdown.
- `howto-current` — the guided reading list.
- `scaffold-current` — `GoalSpec`/`PlanSpec` schemas, examples, availability,
  safety limits and the agent prompt.
- `validation-current` — fail-closed `errors`, `warnings` and `suggestions`.
- `feedback-current` — post-session enjoyment/boredom/RPE/cadence feedback.
- `review-current` — weekly compliance, engagement, weight/readiness, changes
  and the diary-ready `summaryMarkdown`.
- `delivery-spec` — resolved destination, file list and delivery inputs.
- `delivery-current` — winning channel, every attempt, warnings and destination.

### Coach workflows

| Workflow | Purpose |
| --- | --- |
| `@svendowideit/zwift-coach-plan` | Built-in goal → plan → render → preview → deliver |
| `@svendowideit/zwift-coach-custom` | Custom GoalSpec or agent PlanSpec → plan → render → preview → deliver |
| `@svendowideit/zwift-coach-review` | Weekly planned-vs-actual review → adapt future weeks → render → deliver |
| `@svendowideit/zwift-coach-backfill` | Backfill history without planning |

### Program folders and Zwift's workout list

Delivery writes one folder per program:

```text
<workoutsDir>/<riderId>/zwift-coach/<program>/
```

The program slug comes from the goal metrics, for example
`custom-power60-power5-weight`. A 12-week program renders 36 workouts, so Zwift
shows it as roughly three pages of 12.

Workout names put the useful information first, because Zwift only shows the
first ~20 characters:

```text
W1 Torq 80rpm
W1 Cad 135rpm
W1 Z2 156W
W5 60s 100rpm
W4 Test
```

Delivery now:

- renders the current `plan-current` before staging, so SSH cannot ship a stale
  `render-current`;
- writes into the program folder;
- prunes only its own marked files in that folder when `prune=true` (default);
- removes the old flat coach files and the old `default` folder once, marker
  safe;
- deletes `<Workouts>/<riderId>/workouts.files` after an SSH install so Zwift
  rebuilds its workout index on the next start.

If Zwift still shows the old list after a restart, fully quit Zwift, run the
delivery again, then start Zwift. The stale `workouts.files` is removed by the
delivery workflow.

### Delivery workflows

| Workflow | Channel |
| --- | --- |
| `@svendowideit/zwift-coach-deliver` | Auto: SSH → local → sync → bundle |
| `@svendowideit/zwift-coach-deliver-ssh` | SSH/SCP via `@swamp/ssh` |
| `@svendowideit/zwift-coach-deliver-local` | Local/mounted Zwift workouts folder |
| `@svendowideit/zwift-coach-deliver-sync` | Synced folder |
| `@svendowideit/zwift-coach-deliver-bundle` | Portable bundle |

### Safety and limits

- Ramp defaults: under 40 → 5 CTL/week, 40–49 → 4, 50–59 → 3, 60+ → 2.5, with
  recovery weeks more frequent with age.
- Readiness (Garmin HRV/resting HR/sleep/training readiness) and a detraining
  gap adjust the plan; a stale FTP produces a benchmark warning.
- The plan is a suggestion, not medical advice. Weight tracking does not
  prescribe calories; rapid/unintentional loss is a stop flag.
- ZWO validation enforces ≤250 blocks, <64 KB and sane power/duration ranges.
- Delivery refuses to overwrite an existing `.zwo` that lacks the
  `generated by @svendowideit/zwift-coach` marker. Pruning removes only files
  with that marker, never your own workouts.
- SSH delivery checks the remote path and stages files before moving them into
  place. A host-key or permission failure stops that channel and falls through
  to the next one in the auto workflow.
