# @svendowideit/bom-weather

Get the Australian Bureau of Meteorology's 9-day forecast for any suburb or
town, plus current observations, a 72-hour hourly forecast and active warnings.
The model reads the Bureau's public location weather API and preserves each
response's own cadence metadata (`issue_time` / `next_issue_time` /
`observation_time`), so a scheduled workflow polls on the Bureau's real cadence
rather than a guessed interval.

## What it does

- **Resolves a location from any of five selectors** — `name`, `postcode`,
  `state`, `geohash` or `id` — so you can ask for "Penrith", "2750",
  "Penrith-r650hv8" or the bare geohash and get the same place.
- **Returns a 9-day daily forecast** — min/max temperature, rain chance and
  range, UV category and index, fire danger, sunrise/sunset, and the précis
  text for each day.
- **Returns a 72-hour hourly forecast** — temperature, feels-like, dew point,
  humidity, wind, gusts, UV and rain chance per hour.
- **Returns current observations** — the nearest station's temperature,
  feels-like, humidity, wind, gust, rain since 9am, and today's max/min.
- **Returns active warnings** — location-scoped or national, optionally with
  each warning's full HTML message text.
- **Captures the issue cadence** — `issue_time` / `next_issue_time` are read
  from the upstream responses and stored, so downstream steps and schedules can
  react to a genuinely new forecast instead of re-fetching blindly.
- **Prints a today/tomorrow summary** — the bundled workflow's final step logs
  today and tomorrow plus the issue metadata.

Side effects: outbound HTTPS GETs to `api.weather.bom.gov.au`. No files,
services or webhooks are written to the host.

## Install

```sh
swamp extension pull @svendowideit/bom-weather
```

## Configuration

Every selector can be set two ways:

- **As a model global argument** — the default the model uses on every run.
  Set it with `--global-arg` at creation.
- **As a method input** (`--input`) — overrides the global for that call only.

Resolution order is `geohash` > `id` > `postcode` > `name`, with `state`
narrowing a search. A non-empty input always wins over the global default.

```sh
# Create the model with Penrith, NSW as its default location.
swamp model create @svendowideit/bom-weather bom \
  --global-arg name=Penrith --global-arg state=NSW

# Every later run uses that default, with no selector arguments:
swamp model @svendowideit/bom-weather method run sync bom

# Override just for this call — the stored default is unchanged:
swamp model @svendowideit/bom-weather method run sync bom \
  --input name=Bathurst --input state=NSW

# Change the stored default: edit the model definition's globalArguments
# (models/<collective>/bom-weather/bom.yaml), then re-run with no selector.
swamp model edit bom
```

| Argument | Type | Default | Description |
| -------- | ---- | ------- | ----------- |
| `apiUrl` (global) | string | `https://api.weather.bom.gov.au/v1` | BOM API base URL. |
| `userAgent` (global) | string | `swamp-bom-weather/1.0` | `User-Agent` header. |
| `name` (global or `--input`) | string | `""` | Suburb/town name to search for, e.g. `Penrith`. |
| `postcode` (global or `--input`) | string | `""` | Australian postcode, e.g. `2750`. |
| `state` (global or `--input`) | string | `""` | State/territory code (`NSW`, `VIC`, `QLD`, `SA`, `WA`, `TAS`, `NT`, `ACT`) to narrow a name/postcode and disambiguate. |
| `geohash` (global or `--input`) | string | `""` | BOM geohash, e.g. `r650hv8`. Highest precedence. |
| `id` (global or `--input`) | string | `""` | BOM location id, e.g. `Penrith-r650hv8`. Geohash derived from it. |
| `force` (`--input`, `sync`) | boolean | `false` | Write a snapshot even when `issue_time` is unchanged. |
| `dataName` (`--input`, `print`) | string | `forecast` | Resource instance whose `forecast` block to print. |
| `hourlyHours` (`--input`, `print`) | number | `12` | Hourly rows to log (`0` = all 72). |
| `warningsDetail` (`--input`, `print`) | boolean | `false` | Also log each warning's full message text. |
| `scope` (`--input`, `warnings`) | `location` \| `national` | `location` | Warnings for just the resolved place, or nationwide. |
| `state` (`--input`, `warnings`) | string | `""` | Client-side state filter for a national listing. |
| `detail` (`--input`, `warnings`) | boolean | `false` | Store each warning's full message text. |

Workflow inputs mirror the selectors plus `warningScope`, `hourlyHours` and
`warningsDetail`, so one workflow can be re-pointed at a new location without
editing the model:

```sh
# Forecast Bathurst instead of the model's default, for this run only.
swamp workflow run @svendowideit/bom-weather \
  --input name=Bathurst --input state=NSW
```

## Examples

```sh
# 1. End-to-end: daily forecast + observations + hourly + warnings, then print
#    today/tomorrow plus the issue_time / next_issue_time. On the bundled cron.
swamp workflow run @svendowideit/bom-weather \
  --input name=Penrith --input state=NSW

# 2. Resolve an ambiguous name first, to see which place a search selects.
swamp model @svendowideit/bom-weather method run resolve bom --input name=Richmond

# 3. Point at a place by postcode, and fetch its forecast directly.
swamp model @svendowideit/bom-weather method run sync bom --input postcode=2750

# 4. Use a geohash or full id when you already know the exact location.
swamp model @svendowideit/bom-weather method run sync bom --input geohash=r1r0fup
swamp model @svendowideit/bom-weather method run sync bom --input id=Melbourne-r1r0fup

# 5. Current conditions at the nearest station.
swamp model @svendowideit/bom-weather method run observe bom --input name=Penrith

# 6. The next 72 hours, hour by hour.
swamp model @svendowideit/bom-weather method run sync-hourly bom \
  --input name=Penrith --input state=NSW

# 7. Every active warning nationally, filtered to one state, with full text.
swamp model @svendowideit/bom-weather method run warnings bom \
  --input scope=national --input state=NSW --input detail=true

# 8. Print a consolidated view stored by the last run (reads every resource).
swamp model @svendowideit/bom-weather method run print bom

# 9. Inspect the stored snapshots directly.
swamp data get bom forecast
swamp data get bom hourly
swamp data get bom observation
swamp data get bom warnings
```

### Sample `print` output

`print` logs every source it finds, in blocks — the forecast always prints;
each of the others prints only if its method ran earlier in the same workflow:

```text
Location: Penrith, NSW (r650hv8)
Issue time:      2026-09-23T06:48:31Z
Next issue time: 2026-09-23T18:15:00Z

Today:    Wednesday 2026-09-23: max 23°C; Possible shower.; 60% chance, 1–3 mm
Tomorrow: Thursday 2026-09-24: 15–27°C; Partly cloudy.; 30% chance, 0–1 mm

Observed:
  19.7°C (feels like 19.5°C), humidity 73%, rain since 9am 0 mm
  Wind 9 km/h SE, gust 13 km/h
  Today max 24.6°C, min 13.3°C — Penrith (435 m away)
  Observation time: 2026-09-23T07:40:00Z

Hourly (next 12 of 73h, issued 2026-09-23T06:48:25Z):
  17:00 2026-09-23: 21°C (feels 20°C); shower; wind 11km/h ESE gust 24; rain 30%
  ...
  04:00 2026-09-24: 15°C (feels 15°C); fog; wind 7km/h SW gust 13; rain 5%

Warnings (this location): none
```

Control the last two blocks with `--input hourlyHours=0` (all 72 hours) and
`--input warningsDetail=true` (log each warning's message text).

## Accessing the data

Every method writes a named resource you can read back, query, and reference
from other models and workflow steps.

### Read a snapshot at the CLI

```sh
# Latest forecast (all 9 days, today/tomorrow, issue cadence).
swamp data get bom forecast

# Current observations, next 72 hours, active warnings.
swamp data get bom observation
swamp data get bom hourly
swamp data get bom warnings

# Just the warnings list, as JSON.
swamp data query bom 'attributes.warnings' --json
```

### Reference from another model or workflow step (CEL)

Use `data.latest("<model>", "<dataName>").attributes.<field>`:

```yaml
# Today's maximum from the daily forecast.
${{ data.latest("bom", "forecast").attributes.today.tempMax }}

# The current observed temperature.
${{ data.latest("bom", "observation").attributes.temp }}

# The next hour's forecast temperature.
${{ data.latest("bom", "hourly").attributes.entries[0].temp }}

# How many active warnings there are right now.
${{ data.latest("bom", "warnings").attributes.count }}

# Guard a step so it only runs when a warning is active.
guard: ${{ data.latest("bom", "warnings").attributes.count > 0 }}
```

Every field is nullable when the upstream source omits it, so guard optional
reads with `.?` and a fallback:

```yaml
${{ data.latest("bom", "observation").attributes.?temp.orValue(0) }}
```

### Resource fields

| Resource | Key fields |
| -------- | ---------- |
| `location` | `place` (`name`, `state`, `postcode`, `geohash`, `timezone`, `latitude`, `longitude`), `candidates`, `sourceUrl` |
| `forecast` | `place`, `issueTime`, `nextIssueTime`, `forecastRegion`, `forecastType`, `unchanged`, `days[]`, `today`, `tomorrow` |
| `hourly` | `place`, `issueTime`, `entries[]` (`time`, `localTime`, `date`, `temp`, `tempFeelsLike`, `dewPoint`, `relativeHumidity`, `windSpeedKmh`, `windDirection`, `gustSpeedKmh`, `uvIndex`, `rainChance`, `rainMin`, `rainMax`, `isNight`, `icon`) |
| `observation` | `place`, `observationTime`, `issueTime`, `temp`, `tempFeelsLike`, `humidity`, `rainSince9am`, `windSpeedKmh`, `windDirection`, `gustSpeedKmh`, `maxGustKmh`, `maxTemp`, `minTemp`, `stationId`, `stationName`, `stationDistanceMetres` |
| `warnings` | `scope`, `stateFilter`, `count`, `fetchedAt`, `sourceUrl`, `warnings[]` (`id`, `areaId`, `type`, `title`, `shortTitle`, `state`, `states`, `groupType`, `issueTime`, `expiryTime`, `phase`, `message`) |
| `summary` | `printed`, `issueTime`, `nextIssueTime`, `location`, `today`, `tomorrow`, `lines[]`, `observed`, `hourly`, `warnings` |

Each `days[]` / `today` / `tomorrow` entry carries `date`, `weekday`, `tempMin`,
`tempMax`, `rainChance`, `rainMin`, `rainMax`, `shortText`, `icon`,
`uvCategory`, `uvMaxIndex`, `fireDanger`, `sunrise`, `sunset`.

## Details

### Model: `@svendowideit/bom-weather`

| Method | Arguments | Produces |
| ------ | --------- | -------- |
| `resolve` | selector args (`name`, `postcode`, `state`, `geohash`, `id`) | `location` resource — the resolved place, candidate list and detail URL. |
| `sync` | selector args + `force` | `forecast` resource — the 9-day daily forecast, `today`, `tomorrow`, `issueTime`, `nextIssueTime`, `unchanged`. |
| `sync-hourly` | selector args | `hourly` resource — 72 hourly entries plus `issueTime`. |
| `observe` | selector args | `observation` resource — latest station conditions. |
| `warnings` | selector args + `scope`, `state`, `detail` | `warnings` resource — the warning list. |
| `print` | `dataName` + `hourlyHours`, `warningsDetail` | `summary` resource — logs and stores the consolidated view (forecast + observation + hourly + warnings). |

Selector resolution:

| Selector | Behaviour |
| -------- | --------- |
| `geohash` | Used directly; no search call. |
| `id` | Trailing geohash extracted (`Penrith-r650hv8` → `r650hv8`). |
| `postcode` | Search by postcode; best candidate (state-filtered if given). |
| `name` (+ `state`) | Search by name; `state` picks the matching state, else the first (most relevant) result. |

**Geohash precision.** The `daily` and `warnings` endpoints accept a 6- or
7-character geohash; `hourly` and `observations` **require** 6 characters (they
400 on 7). The model stores whatever `daily` returns and truncates to 6
characters (`geohash6`) for those two endpoints.

### Endpoints used

| Method | Endpoint | Cadence |
| ------ | -------- | ------- |
| `resolve` | `locations?search=` + `locations/{geohash}` | static |
| `sync` | `locations/{geohash}/forecasts/daily` | ~6 h (`next_issue_time`) |
| `sync-hourly` | `locations/{geohash6}/forecasts/hourly` | ~3 h (`issue_time`) |
| `observe` | `locations/{geohash6}/observations` | ~10 min (`observation_time`) |
| `warnings` | `locations/{geohash6}/warnings` or `warnings` (+ `warnings/{id}` for detail) | event-driven |

### Workflow: `@svendowideit/bom-weather`

`sync` → `observe`, `sync-hourly`, `warnings` (all three `allowFailure: true`) →
`print`. The workflow's `trigger.schedule` is `30 6,12,18,0 * * *` — four times
daily, ~30 minutes after each of the Bureau's routine daily issues (~06:30,
12:30, 18:30, 00:30 local). Trigger inputs hold the default location
(`name: Penrith`, `state: NSW`); override them with `--input` on a manual run.
The print step waits for all four sources and logs a consolidated view, so a
poll that finds no new issue still reports the current forecast. The three
supplementary steps are non-fatal: a warnings or observations outage must not
suppress the print.

`issue_time` and `next_issue_time` come straight from the API response metadata
(`forecast_region`, `forecast_type` are captured too). `sync` marks a result
`unchanged: true` when the new `issue_time` matches the previously stored one,
letting callers detect a no-op poll.

`issue_time` and `next_issue_time` come straight from the API response metadata
(`forecast_region`, `forecast_type` are captured too). `sync` marks a result
`unchanged: true` when the new `issue_time` matches the previously stored one,
letting callers detect a no-op poll.

### Structure and extending

- `bom_weather.ts` — the model. Pure helpers (`geohashFromId`, `geohash6`,
  `pickCandidate`, `mergeSelectors`, `parseDay`, `parseDaily`, `parseHour`,
  `parseHourly`, `parseObservations`, `parseWarning`, `filterWarningsByState`,
  `formatDay`, `formatSummary`, URL builders) are exported for testing; network
  access is confined to `getJson` and `resolvePlace`.
- `bom_weather_test.ts` — unit tests: pure-helper cases plus execute-path cases
  for every method with a fake `fetch` (no network).
- `bom-weather.yaml` — the bundled workflow (created with `swamp workflow
  create`; do not hand-edit its `id`).

### Testing

```sh
# Unit tests (no network):
~/.swamp/deno/deno test --allow-read --allow-env \
  extensions/models/bom-weather/bom_weather_test.ts

# Type-check:
~/.swamp/deno/deno check extensions/models/bom-weather/bom_weather.ts
```

### Caveats

The BOM app API's own metadata states the API is owned by the Bureau and must
not be copied or shared; the free anonymous-FTP précis XML
(`https://reg.bom.gov.au/fwo/IDN11060.xml` and siblings) is the published feed
if you need a redistribution-licensed source.

The national warnings endpoint ignores query filters (`?state=`, `?type=`,
`?warning_group_type=` all return the same list), so state filtering is applied
client-side.

## License

MIT — see LICENSE.txt.
