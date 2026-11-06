# @svendowideit/zwift-coach

Turn your own Zwift and Garmin history into a periodised training plan and
validated `.zwo` workouts, then deliver the workouts to Zwift over SSH, a local
workouts folder, a sync folder or a portable bundle.

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

### Delivery inputs

These are accepted by the plan workflow and by the explicit delivery
workflows.

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
| `@svendowideit/zwift-coach` | `goal` | Compile `regain`/`improve`/`event` into `goal-current` |
| `@svendowideit/zwift-coach` | `plan` | Generate `plan-current` weeks/sessions |
| `@svendowideit/zwift-coach` | `render` | Render `workout-*` + `render-current` ZWO |
| `@svendowideit/zwift-coach` | `preview` | Write `preview-current` markdown |
| `@svendowideit/zwift-coach` | `howto` | Log the guided commands for inspecting the result |
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
- `delivery-spec` — resolved destination, file list and delivery inputs.
- `delivery-current` — winning channel, every attempt, warnings and destination.

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
