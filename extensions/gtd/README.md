# @svendowideit/gtd

A native **Getting Things Done (GTD)** model for swamp. One model, many
methods, all data in swamp model data resources. Implements the five GTD
steps — **capture → clarify → organize → reflect → engage** — and ships a
responsive web UI generated as static HTML with **htmx** for dynamics, served
by a small Deno API service.

## Model type

`@svendowideit/gtd` — one type, methods, all data in resources:

| Method          | Writes to                          | GTD step |
| --------------- | ---------------------------------- | -------- |
| `capture`       | `inbox`                            | Capture  |
| `clarify`       | `next-actions`, `projects`, `waiting-for`, `someday-maybe`, `calendar`, `reference` | Clarify |
| `organize`      | any list                           | Organize |
| `complete`      | `completed`                        | Engage   |
| `delegate`      | `waiting-for`                      | Clarify  |
| `defer`         | `calendar` / `someday-maybe`       | Clarify  |
| `revert`        | `inbox`                            | Reflect  |
| `engage`        | (read)                             | Engage   |
| `weeklyReview`  | `review-log`                       | Reflect  |
| `dailyReview`   | `review-log`                       | Reflect  |
| `renderBoard`   | `board` (file)                     | —        |
| `ensureServer`  | (systemd user service)             | —        |

Resources: `inbox`, `next-actions`, `projects`, `waiting-for`, `someday-maybe`,
`calendar`, `reference`, `contexts`, `completed`, `review-log`.

## Usage

```bash
# Capture an item
swamp model method run gtd capture --input 'raw=Buy milk @errands'

# Clarify the inbox (deterministic prefix routing)
swamp workflow run @svendowideit/gtd

# Explicit routing
swamp model method run gtd clarify --input itemId=<id> --input kind=waiting-for --input delegatee=Jane

# Engage — what can I do right now?
swamp model method run gtd engage --input context=@phone --input time=15 --input energy=low

# Complete / defer / revert
swamp model method run gtd complete --input itemId=<id> --input list=next-actions
swamp model method run gtd defer --input itemId=<id>
swamp model method run gtd revert --input itemId=<id> --input list=next-actions

# Reviews
swamp workflow run @svendowideit/gtd-daily-review
swamp workflow run @svendowideit/gtd-weekly-review
```

### Clarify routing hints

`clarify` routes each inbox item deterministically. You can pass an explicit
`kind`, or use GTD-style prefixes in the captured text:

| Prefix            | Routes to        |
| ----------------- | ---------------- |
| `someday:` / `maybe:` | `someday-maybe` |
| `ref:` / `reference:` | `reference`    |
| `wait:` / `delegate:` | `waiting-for`  |
| `calendar:` / `on …`  | `calendar`     |
| `project:`         | `projects`       |
| `trash:`           | discarded        |
| `@<context>`       | `next-actions` with that context |
| *(default)*        | `next-actions`   |

## Web UI

The board is generated as static HTML with htmx. The GTD workflows
(`@svendowideit/gtd`, `@svendowideit/gtd-daily-review`,
`@svendowideit/gtd-weekly-review`) each include an **`ensure-server`** step that
idempotently stands up the web UI server as a **systemd user service** via
`@svendowideit/systemd-service` — no manual `deno run` needed. It resolves the
bundled `scripts/gtd-server.ts`, creates the unit with `createService`, and
starts it with `startService`. If `@svendowideit/systemd-service` is not
installed, the step skips gracefully (with a log) and the workflow still
completes.

```bash
# Run the workflow — this also ensures the web UI server is running
swamp workflow run @svendowideit/gtd
# → http://127.0.0.1:8878
```

The service is named `gtd-server` (override with the `serverServiceName` global
arg) and listens on port `8878` (`serverPort`). The board path it serves is
`<outputDir>/board.html` (override with `boardPath`).

- **Large screen:** full dashboard — inbox clarify queue, next actions by
  context, projects, waiting-for, someday/maybe, calendar, reference, plus a
  "do now" panel.
- **Small screen:** focused view — the "do now" panel and today's calendar
  first, with the lists stacked below; a prominent capture bar.

Every action (capture, clarify, complete, defer, revert, engage, reviews) is an
htmx `hx-post` that swaps only the affected column — no full page reload.

## Reports

`@svendowideit/gtd-summary` prints a short summary after each method run.

## Tests

```bash
~/.swamp/deno/deno test extensions/gtd/gtd_test.ts
```
