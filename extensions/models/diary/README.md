# @svendowideit/diary

Turn a day of synced Garmin and Zwift data into one Obsidian daily note, and
merge it into a note you may already have edited — without re-fetching anything
or clobbering your own words and ticked boxes.

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
body battery — and the ranked Zwift picks (from `zwift-recommender`, linked back
to `zwift-events`). It writes one `collect` resource. `render` turns that into
the markdown page and writes a `page` resource so you can inspect it. `publish`
renders the page, merges it into any existing note between two HTML comment
markers, and writes it via the vault model. The page has a `## Health` section
(sleep, steps) and a `## Activities` section listing the day's Garmin
activities.

The bundled `@svendowideit/diary-daily` workflow chains these — assert sources,
`collect`, `publish` — and is scheduled daily at 07:00 local under `swamp serve`,
after the Garmin morning syncs and the Zwift recommend pass.

Because `collect` only reads stored data, a diary run is cheap and safe: it
cannot rate-limit Garmin or duplicate a Zwift fetch. If a source has not synced,
the day is still produced and the missing sources are listed in
`collect.attributes.missing`.

## Install

```sh
swamp extension pull @svendowideit/diary
```

`@magistr/obsidian-vault` is declared as a dependency and pulled by the same
command.

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
| `collect` | `activitiesModel` | string | `garmin-activities` | Instance holding the Garmin activity list |
| `collect` | `healthModel` | string | `garmin-health` | Instance holding Garmin daily wellness |
| `collect` | `recommenderModel` | string | `zwift-recommender` | Instance holding ranked picks |
| `collect` | `eventsModel` | string | `zwift-events` | Instance holding the schedule (for links) |
| `collect` | `topN` | integer | `5` | Maximum suggested rides on the page |
| `render` | `timezone` / `date` | | | As `collect` |
| `render` | `collectName` | string? | `daily-<date>` | Collect resource to render |
| `publish` | `timezone` / `date` | | | As `collect` |
| `publish` | `collectName` | string? | `daily-<date>` | Collect resource to publish |
| `publish` | `vaultModel` | string | `obsidian-vault` | Vault instance to write through |
| `publish` | `folder` | string | `daily` | Vault folder for the note |
| `publish` | `noteName` | string? | `<date>.md` | File name override |
| `publish` | `allowDotObsidian` | boolean? | — | Passed through to the vault model |

### Workflow arguments

The bundled `@svendowideit/diary-daily` workflow exposes the same names as
`--input` (`vaultModel`, `activitiesModel`, `healthModel`, `recommenderModel`,
`eventsModel`, `timezone`, `date`, `folder`, `topN`), and is scheduled daily at
07:00 local.

| Input | Type | Default | Meaning |
| --- | --- | --- | --- |
| `vaultModel` | string | `obsidian-vault` | Vault instance to write into |
| `activitiesModel` | string | `garmin-activities` | Garmin activity list to read |
| `healthModel` | string | `garmin-health` | Garmin daily wellness to read |
| `recommenderModel` | string | `zwift-recommender` | Ranked Zwift picks to read |
| `eventsModel` | string | `zwift-events` | Zwift schedule, used for links |
| `timezone` | string | `Australia/Brisbane` | IANA zone that defines "today" |
| `date` | string | `""` (today) | Explicit day `YYYY-MM-DD` |
| `folder` | string | `daily` | Vault folder for the note |
| `topN` | integer | `5` | Maximum suggested rides |

## Examples

```sh
# One-time: point the vault model at the mounted Obsidian directory. The fs
# backend needs no running Obsidian app, so this works on a server.
swamp model create @magistr/obsidian/vault obsidian-vault \
  --global-arg vaultRoot=$HOME/Obsidian/Vault

# Collect today's data and inspect the raw payload (rides, wellness, picks,
# and which sources were missing).
swamp model @svendowideit/diary method run collect obsidian-vault
swamp data get obsidian-vault daily-$(date +%F) --json

# Render the markdown and read it before publishing — useful when changing the
# page layout or checking a source model's field names.
swamp model @svendowideit/diary method run render obsidian-vault
swamp data get obsidian-vault daily-$(date +%F) --json | jq -r '.content.markdown'

# Publish into daily/<date>.md. Re-running is safe: only the region between the
# markers is rewritten, so your headings, prose and ticked boxes survive.
swamp model @svendowideit/diary method run publish obsidian-vault

# Or run the whole collect→publish chain as one scheduled job, and inspect the
# run afterwards. This is what runs at 07:00 under 'swamp serve'.
swamp workflow run @svendowideit/diary-daily
swamp workflow history get @svendowideit/diary-daily --json

# Backfill a past day, or read a different set of fitness models.
swamp workflow run @svendowideit/diary-daily \
  --input date=2026-09-30 --input topN=8 --input folder=diary
```

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
  `zwift-recommender`/`recommendations` and `zwift-events`/`schedule` via
  `context.readModelData`, filters to `date`, attaches Zwift event URLs from the
  schedule, and writes a `collect` resource named `daily-<date>`. Arguments:
  `timezone`, `date`, `activitiesModel`, `healthModel`, `recommenderModel`,
  `eventsModel`, `topN`.
- **`render`** — reads the collect resource and writes a `page` resource named
  `daily-<date>` with the markdown. Arguments: `timezone`, `date`,
  `collectName`.
- **`publish`** — reads the collect resource, renders the managed section, reads
  any existing note through the vault model, merges, and writes it with
  `overwrite=true`. Arguments: `timezone`, `date`, `collectName`, `vaultModel`,
  `folder`, `noteName`, `allowDotObsidian`. Writes a `publish` resource
  recording the file and whether it was created or merged.

### Resources

| Spec | Name | Shape |
| --- | --- | --- |
| `collect` | `daily-<date>` | `date`, `generatedAt`, `timezone`, `rides[]`, `totals`, `wellness`, `suggested[]`, `truncated`, `missing[]` |
| `page` | `page-<date>` | `date`, `markdown`, `timestamp` |
| `publish` | `publish-<date>` | `date`, `file`, `action`, `merged`, `timestamp` |

### Workflow

`diary-daily.yaml` (name `@svendowideit/diary-daily`) is a single job with three
steps:

1. **assert-sources** — fails fast (severity high) when neither
   `garmin-activities`/`activity-list` nor `zwift-recommender`/`current` exists,
   so there is nothing to build from. Missing wellness or schedule alone is fine.
2. **collect** — calls the `collect` method with the workflow inputs.
3. **publish** — calls the `publish` method to merge and write the note.

It registers one cron trigger (`0 7 * * *`, host-local) while `swamp serve`
runs. Override any input with `--input` for a manual or backfill run.

### The managed region

`publish` writes the machine-owned block between two HTML comments:

```markdown
<!-- swamp:diary:begin -->
## Health
- **Sleep:** 8h 16m (score 82)
- **Steps:** 5,112 of 5,960

## Activities
- Zwift - ... (virtual_ride) — 48m · 25.0 km · 151 W avg · 139 bpm

## Suggested rides today
- [ ] ... → [Zwift](https://www.zwift.com/events/view/111)
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
- The vault model must be able to reach the vault: set `vaultRoot` for the
  headless `fs` backend, or leave `vault` set for the CLI backend with the
  Obsidian desktop app running.

### Structure and testing

`diary.ts` is one file with the pure helpers (`calendarDate`,
`filterActivities`, `summariseRides`, `selectSuggestions`, `renderManagedSection`,
`mergeManagedSection`, …) exported for unit testing, plus the three `execute`
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
