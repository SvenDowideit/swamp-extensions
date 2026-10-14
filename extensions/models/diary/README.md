# @svendowideit/diary

Turn a day of synced Garmin, Zwift, (optionally) BOM weather data and
(optionally) swamp extension releases into one Obsidian daily note, and merge it
into a note you may already have edited — without re-fetching anything or
clobbering your own words and ticked boxes.

This is an **extension of `@magistr/obsidian/vault`**: pulling it adds three
methods and three resources to that model type, plus a daily workflow. It
deliberately does not write files itself — `publish` composes the vault model's
`read` and `create` methods, so the vault model stays the single writer of note
files and all its safety (path resolution, atomic writes, `.obsidian` blocking)
still applies.

## What it does

`collect` reads a day's data from the fitness models swamp already holds:
Garmin activities (from `garmin-activities`), the Garmin daily wellness roll-up
(from `garmin-health`) — sleep duration and score, steps, resting HR, stress and
body battery — the Garmin weigh-in (from `garmin-body`) — weight plus whatever
body composition your scale measured: body fat %, muscle mass, BMI and metabolic
age — the ranked Zwift picks (from `zwift-recommender`, linked back to
`zwift-events`), and, optionally, the day's weather forecast (from a
`@svendowideit/bom-weather` instance). It writes one `collect` resource.
`render` turns that into the markdown page and writes a `page` resource so you
can inspect it. `publish` renders the page, merges it into any existing note
between two HTML comment markers, and writes it via the vault model. The page
has a `## Health` section (sleep, steps, weight) and a `## Activities` section
listing the day's Garmin activities.

When a weigh-in exists for the day, a `- **Weight:** 81.2 kg · body fat 21%`
line is added to `## Health`; on a weight-only scale it degrades to
`- **Weight:** 81.2 kg`. Garmin body data is optional: if the `garmin-body`
instance is absent, has not synced, or holds no weigh-in matching the date, the
line is simply omitted and `garmin-body/range` is listed in
`collect.attributes.missing`.

When a BOM forecast exists for the day, a one-line header is placed at the top
of the managed block, e.g.
`Stafford Heights: min 16°C max 27°C; Mostly clear.; 5% chance`. BOM is
optional: if the `bom` instance is absent, has not synced, or holds no day
matching the date, the line is simply omitted and `bom/forecast` is listed in
`collect.attributes.missing`.

When an `@svendowideit/extension-releases` instance (`releasesModel`, default
`extension-releases`) holds a log entry for the day, a `## Extensions published`
section lists each extension with a link to its swamp-club registry page and a
sub-list of the versions and channels released or promoted that day, e.g.
`- **2026.10.11.1** → stable (promoted from beta) · 19:14`. An entry is dated by
when it actually happened — the registry publish time for a release, the first
observation for a promotion — so a release only ever appears on its real day,
never on the day a later poll or a first-run backfill noticed it. Releases are
optional: if the model is absent or the day has none, the section says so and
`extension-releases/log` is listed in `collect.attributes.missing`.

The bundled `@svendowideit/diary-daily` workflow chains these — assert sources,
then `build` (collect + publish in one call) — and is scheduled hourly at :45
local under `swamp serve`, a quarter-hour after the
`@svendowideit/fitness-refresh` run it consumes. Each pass rebuilds the last four
days (today and the three before), so the pages stay current as new activities
and weigh-ins land, including one recorded after a page was first written.

Because `collect` only reads stored data, a diary run is cheap and safe: it
cannot rate-limit Garmin or duplicate a Zwift fetch. If a source has not synced,
the day is still produced and the missing sources are listed in
`collect.attributes.missing`.

## Install

```sh
swamp extension pull @svendowideit/diary
```

`@magistr/obsidian-vault` and `@svendowideit/extension-releases` are declared as
dependencies and pulled by the same command.

## Configuration

### Global arguments

This extension adds no global arguments of its own. Configure the vault through
the `@magistr/obsidian/vault` model it extends:

| Argument | Type | Default | Meaning |
| --- | --- | --- | --- |
| `vault` | string | — | Registered Obsidian vault name (CLI backend) |
| `vaultRoot` | string | — | Absolute vault path; enables the headless `fs` backend |
| `backend` | `auto` \| `cli` \| `fs` | `auto` | `fs` when `vaultRoot` is set, else `cli` |
| `blockDotObsidian` | boolean | `true` | Refuse access inside `.obsidian` unless allowed per call |
| `defaultFileMode` | number | `0644` | Mode for files the `fs` backend creates |
| `defaultDirectoryMode` | number | `0755` | Mode for directories the `fs` backend creates |

### Method arguments

| Method | Argument | Type | Default | Meaning |
| --- | --- | --- | --- | --- |
| `collect` | `timezone` | string | `Australia/Brisbane` | IANA zone that defines "today" and buckets picks |
| `collect` | `date` | string? | today | Calendar day `YYYY-MM-DD` to collect |
| `collect` | `days` | integer | `1` | Days to collect ending on `date`/today, most recent first (the bundled workflow passes `4`) |
| `collect` | `activitiesModel` | string | `garmin-activities` | Instance holding the Garmin activity list |
| `collect` | `healthModel` | string | `garmin-health` | Instance holding Garmin daily wellness |
| `collect` | `bodyModel` | string | `garmin-body` | Optional `@svendowideit/garmin-body` instance for the weight line |
| `collect` | `recommenderModel` | string | `zwift-recommender` | Instance holding ranked picks |
| `collect` | `eventsModel` | string | `zwift-events` | Instance holding the schedule (for links) |
| `collect` | `bomModel` | string | `bom` | Optional `@svendowideit/bom-weather` instance for the forecast line |
| `collect` | `releasesModel` | string | `extension-releases` | Optional `@svendowideit/extension-releases` instance for the Extensions published section |
| `collect` | `topN` | integer | `5` | Maximum suggested rides on the page |
| `render` | `timezone` / `date` | | | As `collect` |
| `render` | `collectName` | string? | `daily-<date>` | Collect resource to render |
| `publish` | `timezone` / `date` / `days` | | | As `collect` |
| `publish` | `collectName` | string? | `daily-<date>` | Collect resource to publish |
| `publish` | `vaultModel` | string | `obsidian-vault` | Vault instance to write through |
| `publish` | `folder` | string | `daily` | Vault folder for the note |
| `publish` | `noteName` | string? | `<date>.md` | File name override |
| `publish` | `allowDotObsidian` | boolean? | — | Passed through to the vault model |
| `build` | — | | | `collect`'s arguments plus the `publish` fields (`vaultModel`, `folder`, `noteName`, `allowDotObsidian`); collects and publishes in one call |

### Workflow arguments

The bundled `@svendowideit/diary-daily` workflow exposes the same names as
`--input` (`vaultModel`, `activitiesModel`, `healthModel`, `bodyModel`,
`recommenderModel`, `eventsModel`, `bomModel`, `releasesModel`, `timezone`,
`date`, `days`, `folder`, `topN`), and is scheduled hourly at :45 local. Each
run rebuilds the last `days` days (default 4 — today and the three before), so a
weigh-in or activity that arrives after a page was first written still updates
that page.

| Input | Type | Default | Meaning |
| --- | --- | --- | --- |
| `vaultModel` | string | `obsidian-vault` | Vault instance to write into |
| `activitiesModel` | string | `garmin-activities` | Garmin activity list to read |
| `healthModel` | string | `garmin-health` | Garmin daily wellness to read |
| `bodyModel` | string | `garmin-body` | Optional `@svendowideit/garmin-body` instance for the weight line |
| `recommenderModel` | string | `zwift-recommender` | Ranked Zwift picks to read |
| `eventsModel` | string | `zwift-events` | Zwift schedule, used for links |
| `bomModel` | string | `bom` | Optional BOM instance for the forecast line |
| `releasesModel` | string | `extension-releases` | Optional releases instance for the Extensions published section |
| `timezone` | string | `Australia/Brisbane` | IANA zone that defines "today" |
| `date` | string | `""` (today) | Explicit day `YYYY-MM-DD` |
| `days` | integer | `4` | Days to rebuild, ending on the date (today + the three before) |
| `folder` | string | `daily` | Vault folder for the note |
| `topN` | integer | `5` | Maximum suggested rides |

### Adding a weather forecast (optional)

The header forecast line comes from a `@svendowideit/bom-weather` instance whose
data `collect` reads — the diary never calls BOM itself. Create the instance for
your location and sync it once so data exists immediately:

```sh
# Create a BOM instance for your suburb. Name it `bom` to match the default
# `bomModel` and the instance the bundled BOM workflow syncs (see below).
swamp model create @svendowideit/bom-weather bom \
  --global-arg name=Stafford --global-arg state=QLD

# Sync once to seed today's forecast without waiting for the next scheduled
# poll. Pass the location too — the workflow's trigger/inputs default to
# Penrith/NSW and would otherwise override the instance.
swamp workflow run @svendowideit/bom-weather \
  --input name=Stafford --input state=QLD

# Confirm the data landed (the resolved place and today's day entries), and that
# the instance exists.
swamp data get bom forecast --json
swamp model get bom --json
```

`bomModel` defaults to `bom`, so with the instance above the diary picks the
forecast up with no further configuration.

If you prefer a distinct instance name such as `obsidian-daily-bom-forecast`,
create it and point the diary at it:

```sh
swamp model create @svendowideit/bom-weather obsidian-daily-bom-forecast \
  --global-arg name=Stafford --global-arg state=QLD

# One-off sync of that named instance (the bundled BOM workflow syncs `bom`).
swamp model @svendowideit/bom-weather method run sync \
  obsidian-daily-bom-forecast

# Tell the diary (and the workflow) which instance to read.
swamp model method run obsidian-vault collect \
  --input bomModel=obsidian-daily-bom-forecast
swamp workflow run @svendowideit/diary-daily \
  --input bomModel=obsidian-daily-bom-forecast
```

**Keeping it fresh.** The bundled `@svendowideit/bom-weather` workflow already
polls four times daily (00:30/06:30/12:30/18:30 host-local) under `swamp serve`,
so a `bom`-named instance stays current for the hourly diary run on its own —
provided the trigger carries **your** location, not the built-in Penrith/NSW
defaults. Set the override once (it replaces the whole entry, so restate the
schedule and inputs):

```sh
# Keep the built-in 4x-daily cadence but poll your location.
swamp workflow trigger set @svendowideit/bom-weather \
  --schedule "30 6,12,18,0 * * *" \
  --input name=Stafford --input state=QLD

# Or poll only at 03:00 host-local.
swamp workflow trigger set @svendowideit/bom-weather \
  --schedule "0 3 * * *" \
  --input name=Stafford --input state=QLD

# Inspect built-in vs override vs effective, then apply it with `swamp serve
# reload` (needs --hot-reload) or a serve restart.
swamp workflow trigger get @svendowideit/bom-weather
```

A differently-named instance is *not* covered by the bundled workflow — its
steps hardcode `modelName: bom` — so keep the default name, or run the sync on
your own schedule.

## Examples

```sh
# One-time: point the vault model at the mounted Obsidian directory. The fs
# backend needs no running Obsidian app, so this works on a server.
swamp model create @magistr/obsidian/vault obsidian-vault \
  --global-arg vaultRoot=$HOME/Obsidian/Vault

# Collect today's data and inspect the raw payload (rides, wellness, weight,
# picks, and which sources were missing). collect writes to the 'collect' spec.
swamp model method run obsidian-vault collect
swamp data get obsidian-vault daily-$(date +%F) --json

# Read a different Garmin weigh-in instance — run this when your body model is
# named something other than the `garmin-body` default. The weight line is then
# sourced from that instance.
swamp model method run obsidian-vault collect \
  --input bodyModel=garmin-body-scale

# Render the markdown and read it before publishing — useful when changing the
# page layout or checking a source model's field names. render writes the
# markdown to the 'page' spec named page-<date>, not the collect resource.
swamp model method run obsidian-vault render
swamp data get obsidian-vault page-$(date +%F) --json | jq -r '.content.markdown'

# Publish into daily/<date>.md. Re-running is safe: only the region between the
# markers is rewritten, so your headings, prose and ticked boxes survive.
swamp model method run obsidian-vault publish

# Or run the whole collect→publish chain as one scheduled job, and inspect the
# run afterwards. This is what runs hourly at :45 under 'swamp serve'.
swamp workflow run @svendowideit/diary-daily
swamp workflow history get @svendowideit/diary-daily --json

# Backfill a past day, or read a different set of fitness models.
swamp workflow run @svendowideit/diary-daily \
  --input date=2026-09-30 --input topN=8 --input folder=diary

# Rebuild a wider trailing window — useful after a late weigh-in or a missed
# run, since the default only refreshes the last four days (capped at 7).
swamp workflow run @svendowideit/diary-daily --input days=5
```

## Upgrade

The diary installs nothing on the host — no services or daemons — and ships no
model of its own; it adds methods to the `@magistr/obsidian/vault` model you
already use. There is therefore no in-place rebuild to run: upgrade by updating
the extension.

```sh
# Apply the new diary version; its methods attach to the existing vault model.
swamp extension update @svendowideit/diary
```

The new version takes effect automatically on the next `@svendowideit/diary-daily`
run. Because `publish` only rewrites the managed region between the markers, an
upgrade never disturbs your own prose or ticked boxes.

## Details

### Model type

`@svendowideit/diary` is registered as an **extension** of
`@magistr/obsidian/vault` (`export const extension`), so create or reuse a
vault model instance and call these methods on it:

```sh
swamp model create @magistr/obsidian/vault obsidian-vault \
  --global-arg vaultRoot=$HOME/Obsidian/Vault
```

### Methods

- **`collect`** — reads `garmin-activities`/`list`, `garmin-health`/`daily`,
  `garmin-body`/`range`, `zwift-recommender`/`recommendations`,
  `zwift-events`/`schedule`, (optionally) `<bomModel>`/`forecast` and
  `<releasesModel>`/`log` via `context.readModelData`, filters to each day in
  the `days` window, attaches Zwift event URLs from the schedule, picks each
  day's weather with `selectWeather`, picks each day's weigh-in with
  `selectWeight`, picks the day's releases with `selectReleases`, and writes a
  `collect` resource named `daily-<date>` per day. Arguments: `timezone`,
  `date`, `days`, `activitiesModel`, `healthModel`, `bodyModel`,
  `recommenderModel`, `eventsModel`, `bomModel`, `releasesModel`, `topN`.
- **`render`** — reads the collect resource and writes a `page` resource named
  `daily-<date>` with the markdown. Arguments: `timezone`, `date`,
  `collectName`.
- **`publish`** — for each day in the `days` window, reads the collect resource,
  renders the managed section, reads any existing note through the vault model,
  merges, and writes it with `overwrite=true`. Arguments: `timezone`, `date`,
  `days`, `batch`, `collectName`, `vaultModel`, `folder`, `noteName`,
  `allowDotObsidian`. Writes a `publish` resource per day recording the file and
  whether it was created or merged.
- **`build`** — `collect` + `publish` in one call: it writes each day's
  `collect` (and the `daily-batch`) then renders and merges each note from the
  payloads it just built in memory. The bundled workflow uses this because a
  workflow run reads a run-start data snapshot, so a separate later `publish`
  step reading this run's collect would render an earlier run's data. Arguments:
  the `collect` arguments plus `vaultModel`, `folder`, `noteName`,
  `allowDotObsidian`.

### Resources

| Spec | Name | Shape |
| --- | --- | --- |
| `collect` | `daily-<date>` | `date`, `generatedAt`, `timezone`, `rides[]`, `totals`, `wellness`, `weight`, `weather`, `suggested[]`, `releases[]`, `truncated`, `missing[]` |
| `batch` | `daily-batch` | `generatedAt`, `timezone`, `dates[]`, `days[]` — the whole window in one resource |
| `page` | `page-<date>` | `date`, `markdown`, `timestamp` |
| `publish` | `publish-<date>` | `date`, `file`, `action`, `merged`, `timestamp` |

### Workflow

`diary-daily.yaml` (name `@svendowideit/diary-daily`) is a single job with two
steps:

1. **assert-sources** — fails fast (severity high) when neither
   `garmin-activities`/`activity-list` nor `zwift-recommender`/`current` exists,
   so there is nothing to build from. Missing wellness or schedule alone is fine.
2. **build** — calls the `build` method, which collects every day in the `days`
   window and publishes each note in one execution (see `build` above).

It registers one cron trigger (`45 * * * *`, host-local) while `swamp serve`
runs. Override any input with `--input` for a manual or backfill run; set
`--input days=3` (or more, up to 7) to rebuild a wider trailing window.

### The managed region

`publish` writes the machine-owned block between two HTML comments:

```markdown
<!-- swamp:diary:begin -->

Stafford Heights: min 16°C max 27°C; Mostly clear.; 5% chance

## Health
- **Sleep:** 8h 16m (score 82)
- **Steps:** 5,112 of 5,960
- **Weight:** 81.2 kg · body fat 21%

## Activities
- Zwift - ... (virtual_ride) — 48m · 25.0 km · 151 W avg · 139 bpm

## Suggested rides today
- [ ] ... → [Zwift](https://www.zwift.com/events/view/111)

## Extensions published
- [@svendowideit/caddy](https://swamp-club.com/extensions/@svendowideit/caddy)
  - **2026.10.11.1** → stable (promoted from beta) · 19:14
<!-- swamp:diary:end -->
```

Everything outside those markers is preserved verbatim. When a note has no
markers, the block is inserted after the first heading. This is what makes it
safe to tick boxes and write prose on a phone and still let the daily job rewrite
the page.

### Prerequisites

- The Garmin and Zwift syncs must have run at least once so the source models
  hold data. Missing sources are reported in `collect.missing` rather than
  failing the run.
- The weight line is optional. When a `@svendowideit/garmin-body` instance
  (`bodyModel`, default `garmin-body`) has synced and holds a weigh-in for the
  date, the line is added; otherwise it is omitted and `garmin-body/range` is
  reported in `collect.missing`. Body composition (fat %, muscle, BMI) only
  appears when a compatible scale is paired; a weight-only scale reports weight
  alone.
- The weather header is optional. When a `@svendowideit/bom-weather` instance
  (`bomModel`, default `bom`) has synced and holds a day matching the date, the
  line is added; otherwise it is omitted and `bom/forecast` is reported in
  `collect.missing`.
- The Extensions published section is optional. When an
  `@svendowideit/extension-releases` instance (`releasesModel`, default
  `extension-releases`) holds a log entry for the day, the section lists them;
  otherwise it says no releases were logged and `extension-releases/log` is
  reported in `collect.missing`. That model is pulled with this extension, but
  its `collect` method must have run to populate the log.
- The vault model must be able to reach the vault: set `vaultRoot` for the
  headless `fs` backend, or leave `vault` set for the CLI backend with the
  Obsidian desktop app running.

### Structure and testing

`diary.ts` is one file with the pure helpers (`calendarDate`,
`filterActivities`, `summariseRides`, `selectSuggestions`, `selectWeather`,
`selectWeight`, `formatForecastLine`, `formatWeightLine`,
`renderManagedSection`, `mergeManagedSection`, …) exported
for unit testing, plus the three `execute`
functions. `diary_test.ts` tests the helpers without any swamp runtime; the
`execute` functions are covered by seeding a context via
`@swamp-club/swamp-testing`.

```sh
~/.swamp/deno/deno test extensions/models/diary/diary_test.ts
~/.swamp/deno/deno check extensions/models/diary/diary.ts
```

### Extending it

The obvious next status sections — swamp runs, ollama/LLM, opencode, git/GitHub
— each become one more read in `executeCollect` and one more block in
`renderManagedSection`, with `missing` already covering an absent source. Keep
new writes inside the managed markers.

## License

MIT — see LICENSE.txt.
