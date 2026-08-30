# Solar Energy Forecast & Charge Advisor — Plan

Predict hourly solar PV generation and home electricity consumption for the
coming day, then route energy across **EV / home battery / grid** to minimise
grid export while keeping the EV between **30–60%** state-of-charge most of the
time.

Location: **Stafford Heights, Brisbane, QLD** (approx. lat `-27.41`, lon `153.01`).

---

## 1. Objective

Every day (nightly), produce an hourly plan for the next 24 hours:

1. **Solar forecast** — expected PV output (W / Wh) per hour.
2. **Consumption forecast** — expected home load (W / Wh) per hour.
3. **Net position** — `solar − consumption` per hour.
4. **Routing decision** — for each hour, where energy flows:
   - surplus → charge **home battery** → charge **EV** (up to 60%) → **export** remainder
   - deficit → discharge **battery** → discharge **EV** (down to 30% floor) → draw **grid**

The EV SoC band (30–60%) is a hard constraint; export-minimisation is the
objective function.

---

## 2. Data Sources

| Source | Temporal | Granularity | Role | Auth |
|---|---|---|---|---|
| **SILO** (LongPaddock) | 1889 → yesterday | Daily | **Training** — historical temp/rain/solar-radiation/pressure | Email in vault |
| **Home Assistant** | Historical + live | Per-sensor | **Training + state** — usage history, battery/EV SoC (thin shim, fetched on demand) | HA token in vault |
| **forecast.solar** | Today + 7 days | 15/30/60 min | **Forecast** — hourly PV watts/Wh | None (public) |
| **Open-Meteo** | Historical + forecast | Hourly | **Forecast** — temp/cloud/rain/solar radiation | None |
| **BOM** | Now + 7 days | Hourly/daily | **Backup forecast** — fills gaps SILO can't cover (forecast + current obs) | None |
| **Himawari-8/9** (satellite) | Now | 10 min | **Nowcast** — cloud-cover fraction + motion for short-horizon solar correction (deferred Phase 6) | None (NOAA S3) |

### 2.1 SILO (LongPaddock) — historical training data

- **What:** Australian climate data 1889 → yesterday, daily, infilled, CC BY 4.0.
- **Why:** The consumption model needs *paired* historical weather to regress
  against HA usage history. SILO gives 130+ years of daily temp/rain/solar
  radiation/pressure at the grid point — the ideal training set.
- **Endpoint (grid point):**
  `https://www.longpaddock.qld.gov.au/cgi-bin/silo/DataDrillDataset.php?lat=-27.41&lon=153.01&start=YYYYMMDD&finish=YYYYMMDD&format=json&username=<email>`
- **Variables of interest** (`variable_code`): `max_temp`, `min_temp`, `rain`,
  `radiation` (solar, MJ/m²), `vp` (vapour pressure), `mslp` (pressure), `rh`.
- **Auth:** email address as `username` param (no key). Stored in vault as
  `SILO_EMAIL`.
- **Note:** daily only, up to yesterday — a *training* source, not a *prediction*
  source.

### 2.2 Home Assistant — thin shim (fetch on demand, no mirror)

- **What:** Current battery/EV SoC + a bounded recent window of consumption
  history, fetched from HA on demand each run.
- **Why:** Ground-truth usage for training the consumption model, and the
  current state (SoC) that the routing decision depends on.
- **Auth:** long-lived access token (`HA_TOKEN`) + base URL (`HA_BASE_URL`).
- **Entity IDs needed** (runtime inputs): home consumption sensor, battery SoC,
  EV SoC, battery capacity (kWh), EV capacity (kWh).

**Design: thin shim, not a datastore mirror.** HA is already the source of
truth and already stores its own history (recorder DB). The HA model does **not**
persist a growing copy of HA's history into swamp. Instead:

- **Fetch on demand** each run: current SoC (battery + EV), current consumption,
  and a **bounded recent window** of usage (e.g. last 30–90 days) for training.
- **Write one small snapshot** resource (current state + that window) so the
  predictor can reference it via `data.latest(...)` — this is the swamp data
  model working as intended, not a full mirror.
- **No long-term HA archive in swamp.** The `energy-predictor` reads the snapshot
  via CEL and does the regression in-memory.

**Training-window decision:**

| Approach | Trade-off |
|---|---|
| **Fetch training window from HA on demand** (thin shim) | Simplest; re-fetches the window each night. Fine if HA's history API is fast enough. |
| **Cache training data in a swamp datastore** | Faster re-training, but re-implements HA's recorder — only worth it if HA's history API is too slow for large windows. |

**Recommendation:** start with the thin shim (fetch the window on demand). Only
add a swamp datastore cache if HA's history API proves too slow for the training
window you need.

### 2.3 forecast.solar — solar PV forecast

- **What:** Weather-aware PV production estimate (W / Wh) for today + 7 days.
- **Why:** Primary solar curve — already accounts for cloud cover.
- **Endpoint (public, single plane, no key):**
  `https://api.forecast.solar/estimate/watts/:lat/:lon/:dec/:az/:kwp`
- **Response:** `result.watts`, `result.watt_hours`, `result.watt_hours_period`,
  `result.watt_hours_day`.
- **Rate limit:** 12 calls/hour (public tier). Forecasts update every 15 min —
  query no more often than that.
- **Inputs needed:** array declination (tilt), azimuth, installed kWp.
  - Azimuth convention: `-180`=N, `-90`=E, `0`=S, `90`=W, `180`=N (differs from
    Home Assistant's 0–360°).

### 2.4 Open-Meteo — hourly weather forecast

- **What:** Hourly temp, cloud cover, rain, solar radiation (GHI/DNI/DHI).
- **Why:** Hourly forecast inputs for the consumption model + cross-check of the
  solar curve.
- **Auth:** none (free, no key).

### 2.5 BOM — backup for what SILO can't provide

- **What:** Authoritative local observations + 7-day forecast (hourly/daily).
- **Why:** SILO is historical-only (up to yesterday) and daily-only. BOM fills
  the two gaps SILO cannot cover:
  1. **Forecast** — SILO has no future data; BOM provides the 7-day forecast.
  2. **Current observations** — SILO lags by a day; BOM provides near-real-time
     observations (temp, wind, rain, humidity, pressure).
- **Role:** backup/fallback for forecast and current-conditions inputs. When
  Open-Meteo is unavailable or needs cross-checking, BOM is the authoritative
  local source.
- **Auth:** none (public JSON/FTP endpoints).

### 2.6 Himawari-8/9 satellite — cloud-cover nowcast (deferred)

- **What:** Geostationary satellite imagery of the Australia region, every
  **10 minutes**.
- **Why:** The forecast models (forecast.solar, open-meteo) are coarse in time
  and space — a cloud bank 30 km away that will shade the roof in 40 minutes is
  invisible to them but obvious in a 10-minute image sequence. Satellite gives a
  **short-horizon nowcast (0–2h)** that corrects the near-term solar curve where
  model error is highest.
- **Sources (free, no key):**
  - **NOAA Big Data Program** — public S3 bucket `noaa-himawari8` (Australia
    sector, 10-min cadence). Most practical for a swamp model (plain HTTP/S3 GET).
  - **BOM** — Himawari imagery + derived products.
  - **NASA GIBS / Worldview** — public API.
- **Two uses:**
  1. **Cloud-motion nowcast** — track cloud features across consecutive frames,
     extrapolate their path, adjust the first 1–2 hours of the solar forecast.
  2. **Cloud-cover cross-check** — derive cloud-cover fraction from imagery and
     compare against open-meteo's forecast to flag likely model error.
- **Caveats:**
  - It's a *nowcast*, not a forecast — extrapolation is only reliable ~1–2h out;
    beyond that the numerical models win. So it's a **correction layer** on top
    of forecast.solar, not a replacement.
  - Image processing is non-trivial (cloud/clear classification via IR
    brightness-temperature thresholds + motion estimation).
  - Data volume — fetch a small Brisbane sector, downscaled, not full-disk.
- **Status:** deferred to **Phase 6** (highest effort, lowest certainty). Build
  the core pipeline (Phases 1–5) first.

---

## 3. Swamp Architecture

Single bundle `@svendowideit/solar` (mirrors the `@svendowideit/news` bundle
pattern — one manifest, multiple model/report/workflow files).

### 3.1 Directory layout

```
extensions/workflows/solar/
  manifest.yaml            # name: "@svendowideit/solar"
  silo_climate.ts          # type: "@svendowideit/silo-climate"
  home_assistant.ts        # type: "@svendowideit/home-assistant"
  forecast_solar.ts        # type: "@svendowideit/forecast-solar"
  open_meteo.ts            # type: "@svendowideit/open-meteo"
  bom_weather.ts           # type: "@svendowideit/bom-weather"
  himawari.ts              # type: "@svendowideit/himawari" (Phase 6)
  energy_predictor.ts      # type: "@svendowideit/energy-predictor"
  energy_recommendation.ts # report: "@svendowideit/energy-recommendation"
  energy-forecast.yaml     # workflow: "@svendowideit/energy-forecast"
  *_test.ts                # one test per model/report
  README.md
  LICENSE.txt
  docs/PLAN.md             # this file
```

### 3.2 Models

| Model type | Method | Purpose |
|---|---|---|
| `@svendowideit/silo-climate` | `history` | Daily historical climate for grid point (training) |
| `@svendowideit/home-assistant` | `history` | Fetch current SoC + bounded usage window (thin shim, no mirror) |
| `@svendowideit/forecast-solar` | `forecast` | Hourly PV watts/Wh |
| `@svendowideit/open-meteo` | `forecast` | Hourly weather + solar radiation |
| `@svendowideit/bom-weather` | `forecast` | Backup forecast + current observations |
| `@svendowideit/himawari` | `nowcast` | Cloud-cover fraction + motion → short-horizon solar correction (Phase 6) |
| `@svendowideit/energy-predictor` | `predict` | Join all → hourly consumption + solar + charge plan |
| `@svendowideit/energy-predictor` | `setup` | Report config/secrets state + guide user to fill gaps (interactive) |

Each model file declares its own `type:` (e.g. `@svendowideit/silo-climate`),
exactly as `news_reader.ts` declares `@svendowideit/news-reader` while living
under the `@svendowideit/news` manifest.

### 3.3 Vault

`energy-secrets` (repo-level, created via `swamp vault create`, **not** part of
the manifest):

| Key | Value |
|---|---|
| `HA_TOKEN` | Home Assistant long-lived access token |
| `HA_BASE_URL` | Home Assistant base URL (e.g. `http://homeassistant.local:8123`) |
| `SILO_EMAIL` | Email address used as SILO `username` param |

### 3.4 Workflow

`@svendowideit/energy-forecast` — nightly DAG:

```
silo-climate.history ────────┐
home-assistant.history ──────┤
forecast-solar.forecast ─────┼─→ energy-predictor.predict ─→ report
open-meteo.forecast ─────────┤
bom-weather.forecast ────────┘
```

- Fan-out fetches run in parallel (different models, so parallel steps are
  correct — not a per-model lock contention case).
- `trigger.schedule` for nightly runs (like `news.yaml`'s `0 */4 * * *`).
- Model instances auto-register on first run (same as news: no manual
  `swamp model create`).
- **BOM is a backup** — its step is `allowFailure: true` and the predictor
  treats its output as optional (falls back to Open-Meteo when BOM is missing).

### 3.5 Report

`@svendowideit/energy-recommendation` — hourly table + verdict (charge EV /
charge battery / export / draw grid), surfacing the 30–60% EV constraint and
export-minimisation logic.

### 3.6 Configurability (reusable by others)

The bundle must be usable by anyone, not just Stafford Heights. All
site-specific values are **runtime inputs / global arguments**, never
hard-coded:

| Config | Where | Default | Notes |
|---|---|---|---|
| `lat` / `lon` | workflow input | `-27.41` / `153.01` | Location for SILO, forecast.solar, open-meteo, BOM |
| `declination` (tilt) | forecast-solar global arg | — | Array tilt in degrees (0–90) |
| `azimuth` | forecast-solar global arg | — | Array azimuth (forecast.solar convention) |
| `kwp` | forecast-solar global arg | — | Installed module power (kW) |
| `HA_BASE_URL` | vault | — | Home Assistant base URL |
| `HA_TOKEN` | vault | — | Home Assistant long-lived token |
| `SILO_EMAIL` | vault | — | SILO `username` param |
| HA entity IDs | home-assistant global args | — | consumption, battery SoC, EV SoC sensors |
| battery/EV capacity (kWh) | energy-predictor global args | — | Routing constraints |
| EV SoC band (30–60%) | energy-predictor global args | `30` / `60` | Configurable floor/ceiling |

**Principle:** secrets → vault; site-specific physical/entity config → model
global arguments; per-run overrides → workflow inputs. Nothing about Stafford
Heights is baked into the extension source.

### 3.7 Setup method (configuration discovery + guidance)

A `setup` method on `@svendowideit/energy-predictor` (mirrors the news bundle's
`news-reader setup` pattern) that reports the **current configuration state** and
guides the user to fill gaps. It is the first thing a new user runs.

**What `setup` reports:**

1. **Secrets status** — for each vault key (`HA_TOKEN`, `HA_BASE_URL`,
   `SILO_EMAIL`): set or unset (never prints the value, only presence).
2. **Config values** — current lat/lon, declination, azimuth, kWp, HA entity
   IDs, battery/EV capacities, EV SoC band — with which are at defaults vs.
   explicitly set.
3. **Readiness verdict** — a checklist of what's missing before the workflow
   can run (e.g. "HA_TOKEN unset", "kwp not configured").

**How `setup` guides the user:**

- Prints the exact commands to set each missing value, e.g.:
  - `swamp vault put energy-secrets HA_TOKEN` (prompts for value)
  - `swamp model @svendowideit/forecast-solar method run setup solar --input kwp=6.6`
- **Interactive mode** (when run in a TTY): prompts for each missing value in
  turn, then writes them via the appropriate mechanism (vault `put` for secrets,
  global-arg update for config). Falls back to printed instructions when not
  interactive (CI, non-TTY).

**Design notes:**

- `setup` is **read-only + advisory** by default; it only mutates state when the
  user confirms in interactive mode.
- Secret values are never echoed or logged — only presence is reported.
- The method is idempotent: re-running it re-reports current state, so it doubles
  as a "show me my config" command.

---

## 4. Prediction Logic

### 4.1 Consumption model

Regress HA usage history against:
- SILO daily climate (temp/rain/radiation/pressure)
- Open-Meteo hourly weather (temp/cloud/rain)
- time-of-day / day-of-week features

→ predict next 24h hourly consumption.

### 4.2 Solar model

forecast.solar `watts` curve (already weather-aware) as the PV output.

### 4.3 Net position

`net[h] = solar[h] − consumption[h]` per hour.

### 4.4 Routing (greedy, export-minimising)

- **Surplus** (`net > 0`): charge home battery → charge EV (≤ 60%) → export.
- **Deficit** (`net < 0`): discharge battery → discharge EV (≥ 30%) → grid.
- EV SoC band 30–60% enforced as hard constraints.

---

## 5. Phased Delivery

| Phase | Scope | Deliverable |
|---|---|---|
| **1** | HA model + vault | Usage/SoC flowing into swamp |
| **2** | forecast.solar model | Hourly PV curve |
| **3** | SILO + open-meteo + BOM models | Training + forecast weather + backup |
| **4** | predictor + report + workflow | Full DAG, validate, run nightly |
| **5** | `setup` method | Config/secrets discovery + interactive guidance |
| **6** | Himawari satellite nowcast | Cloud-cover fraction + motion → short-horizon solar correction (deferred) |

Each phase is independently shippable and testable.

---

## 6. Runtime Inputs (needed during build)

- HA base URL + long-lived token
- Solar array declination / azimuth / kWp
- HA entity IDs: consumption, battery SoC, EV SoC, battery/EV capacities
- SILO email (goes in vault)

All of the above are **configurable** (see §3.6) — the defaults below are for
Stafford Heights only and are overridable by any other user of the bundle.

---

## 7. Open Questions / Decisions

- [ ] Confirm solar array declination, azimuth, kWp.
- [ ] Confirm HA entity IDs and capacities.
- [x] BOM integration: include as backup for forecast + current obs (SILO can't provide these).
- [ ] Consumption model: simple regression vs. more sophisticated approach?
