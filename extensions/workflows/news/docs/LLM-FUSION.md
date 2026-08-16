# LLM Story Fusion — Design & Efficiency Analysis

## Overview

The news workflow has an optional LLM-driven fusion pipeline that groups
related articles into persistent **Story** objects, tracks evolving claims,
detects conflicting reports, and renders them as inline HTML on the news page.

The fusion chain runs as four sequential steps inside the main workflow job:

```
fetch → dedupe-articles → filter → cluster → fuse → seed → render → generate
                                  ↑        ↑       ↑       ↑
                              (no LLM)  (LLM)   (LLM)  (no LLM)
```

Fusion is **opt-in**: set `globalArguments.llmModel` + `llmBaseUrl` on the
`local-news` model instance to enable it. Without an LLM model configured,
`fuseStories` and `seedStories` are no-ops (they pass through the existing
stories unchanged).

---

## Data Model

### Story (persistent, survives across runs)

```typescript
interface Story {
  id: string;                    // stable key from cluster topic + entities
  identity: {
    topic: string;               // canonical topic phrase
    entities: EntityRef[];       // key named entities (person/org/place/product)
    seedArticleIds: string[];    // article IDs that originally seeded this story
  };
  core: Claim[];                 // confirmed core facts (survive age filtering)
  updates: Claim[];              // recent delta claims (may age out)
  conflicts: Conflict[];         // contradictory claims across sources
  status: "confirmed" | "reported" | "alleged" | "unresolved";
  citations: ArticleRef[];      // all articles ever fused into this story
  createdAt: string;
  lastUpdatedAt: string;
  lastRegenAt: string;
}
```

Stories are stored in the `stories-current` resource and persist across
workflow runs. Core claims survive the 3-day age filter window — a story
about an event from last week still appears if it has ongoing citations.

### StoryCluster (ephemeral, per-run)

```typescript
interface StoryCluster {
  topic: string;                 // first article title (truncated to 120 chars)
  entities: EntityRef[];        // extracted from first article
  articles: Article[];           // grouped articles (max 40)
  needsGate: boolean;            // ambiguous grouping (LLM "same story?" check)
  key: string;                  // stable hash of topic + entities
}
```

Clusters are ephemeral — recreated every run from the current filtered
articles. The `key` field is a stable hash that links clusters to persistent
stories across runs.

---

## Step-by-step: What Each Fusion Method Does

### 1. `clusterArticles` (no LLM, ~3s for 892 articles)

**Inputs:** reads `filtered-snapshot` (articles after age filter) and
`stories-current` (existing persistent stories).

**Algorithm — two-phase conservative clustering:**

**Phase 1 — Absorb into existing stories.** For each article, check if it
matches any existing story:
- Entity overlap ≥ 2 (e.g. both mention "OpenAI" and "Sam Altman")
- OR canonical URL already cited by the story

Matches are marked as `absorbable` — they'll be fused into the existing
story by `fuseStories` later.

**Phase 2 — Group leftovers into fresh clusters.** Remaining articles are
grouped by:
- Entity overlap ≥ 2 → same cluster
- Entity overlap = 1 + same calendar day → same cluster
- Canonical URL match → same cluster
- Entity overlap = 1 + within 48 hours → flagged `needsGate` (ambiguous)

Each cluster gets a stable `key` (hash of topic + entities) and a `topic`
(from the first article's title).

**Output:** writes `clusters-current` containing `{ clusters: StoryCluster[],
absorbable: Article[] }`.

**Cost:** O(articles × existing_stories) for phase 1, O(articles²) for phase 2.
Entity extraction runs once per article.

---

### 2. `fuseStories` (LLM, 1 call per matched cluster + 1 per absorbable article)

**Inputs:** reads `stories-current` and `clusters-current`.

**Algorithm — delta pass, two sub-phases:**

**Sub-phase A — Fuse clusters into existing stories.** For each cluster whose
`key` matches an existing story's `id` (or whose topic+entities hash matches):
1. Calls `fuseStory()` — sends the story's existing core claims + the
   cluster's new articles to the LLM.
2. The LLM extracts **only genuinely new claims** (not repeats of existing
   core facts) and detects **conflicts** (contradictory figures/claims).
3. New claims are appended to `story.core`; conflicts are appended to
   `story.conflicts`; new articles are appended to `story.citations`.

**Sub-phase B — Absorb individual articles.** For each `absorbable` article:
1. Re-extracts entities from the article title+summary.
2. Finds the best-matching existing story (entity overlap ≥ 2).
3. Calls `fuseStory()` with that single article.

**LLM prompt (fuseStory):** sends existing core claims + new article
summaries, asks for `{ newClaims, conflicts, status }` as JSON. The LLM is
instructed to be conservative — don't repeat existing claims, don't invent
facts, preserve uncertainty markers.

**Output:** writes updated `stories-current` with fused stories.

**Cost:** 1 LLM call per cluster that matches an existing story + 1 LLM call
per absorbable article. With 472 clusters and ~184 absorbable articles, this
could be hundreds of LLM calls. Each call is ~2-10 seconds depending on the
model.

**Idempotency concern:** If the same cluster is re-fused with identical
articles, the LLM may produce duplicate claims. The code has a basic
case-insensitive dedup (`coreTexts` set), but semantically identical claims
with different wording will slip through.

---

### 3. `seedStories` (LLM, 1 call per genuinely new cluster)

**Inputs:** reads `clusters-current` and `stories-current`.

**Algorithm:**
1. Iterates all clusters.
2. Skips clusters whose `key` already matches an existing story (those were
   handled by `fuseStories`).
3. Skips clusters with fewer than `minClusterSize` articles (default: 2).
4. For each remaining cluster, calls `seedStory()` — sends all cluster
   articles to the LLM and asks it to extract a canonical topic, entities,
   core claims, and status.
5. Creates a new `Story` object with the LLM's output.

**LLM prompt (seedStory):** sends all cluster articles, asks for
`{ topic, entities, claims, status }` as JSON. The LLM is instructed to
extract core facts supported by the articles, preserve uncertainty markers,
and not invent facts.

**Output:** appends new stories to `stories-current`.

**Cost:** 1 LLM call per genuinely new cluster (not matching any existing
story). On a typical run with 472 clusters, most already have stories, so
only a handful of new stories are seeded. This is the cheapest LLM step.

---

### 4. `renderStories` (no LLM, near-instant)

**Inputs:** reads `stories-current`.

**Algorithm:**
1. Ages out citations older than `citationRetentionDays` (default: 30 days).
   Core facts are never dropped — only the citation links age out.
2. Renders each story as an HTML `<div class="story">` with topic heading,
   status badge, conflicts section, core claims list, and citation links.

**Output:** writes `stories-html-current` containing `{ html: string }`.

The `generate` step reads `stories-html-current` and injects it into the
main news page between the scored articles and the feedback section.

---

### 5. `regenStories` (LLM, NOT in the workflow pipeline)

A maintenance method for full story regeneration. Sends every story's
**entire citation list** to the LLM and asks it to re-extract consolidated
core claims and conflicts. This is expensive (1 LLM call per story, for
potentially hundreds of stories) and is designed to run periodically (e.g.
weekly) to flush accumulated drift from incremental delta passes.

---

## Efficiency Analysis

### What runs every time (even when nothing changed)

| Step | Repeats work? | Why |
|------|--------------|-----|
| `dedupeArticles` | Yes | Re-processes ALL articles in feed-snapshot, even if only 5 new articles were fetched |
| `filterByAge` | Yes | Re-filters ALL articles every run |
| `clusterArticles` | Yes | Re-extracts entities for ALL articles, re-checks ALL articles against ALL existing stories, re-clusters ALL leftovers |
| `fuseStories` | **Yes — most expensive waste** | Re-fuses clusters whose article IDs haven't changed since last run. The LLM is called again with the same input, producing near-identical output |
| `seedStories` | Partially | Iterates all clusters but only calls LLM for genuinely new ones. The iteration itself is cheap |
| `renderStories` | Yes (cheap) | Re-renders HTML from stories. Near-instant, not a concern |

### Growth over time

As the story corpus grows (hundreds of stories after weeks of runs):

1. **`clusterArticles` phase 1** gets linearly slower — every new article is
   checked against every existing story. With 892 articles × 500 stories =
   446,000 entity comparisons per run.

2. **`fuseStories` absorb phase** re-extracts entities for every absorbable
   article and re-scans all stories for entity overlap. This is
   O(absorbable × stories).

3. **`fuseStories` cluster phase** calls the LLM for every cluster that
   matches an existing story, even if the cluster's articles are identical
   to the previous run. This is the single biggest source of wasted LLM
   calls.

4. **Story citations grow unbounded.** `fuseStory()` appends new article
   refs to `story.citations` on every run. Over weeks, a popular story
   accumulates hundreds of citations. The `regenStory()` prompt includes
   all of them, making it progressively more expensive.

### Where the time goes (approximate, from logs)

| Step | Duration | LLM calls | Notes |
|------|----------|-----------|-------|
| fetch | 30-60s | 0 | Network-bound, parallel feed fetching |
| dedupe-articles | 4m40s | 0 | CPU-bound, O(n) over all articles |
| filter | <1s | 0 | Trivial |
| cluster | ~3s | 0 | O(n×stories), grows over time |
| fuse | 10s-10min | 1 per matched cluster + absorbable | Dominated by LLM latency |
| seed | 2-30s | 1 per new cluster | Usually few new clusters |
| render | <100ms | 0 | Trivial |
| generate | 1-3s | 0 | Scoring + HTML generation |

---

## Optimization Opportunities

### High Impact / Low Effort

1. **Parallelize LLM calls in `fuseStories` and `seedStories`.**
   Currently the `for...of` loops are sequential — each LLM call waits for
   the previous one to complete. With a concurrency limit of 5-10, the
   fusion step could complete 5-10× faster. The LLM server (Ollama) can
   handle concurrent requests.

2. **Skip `fuseStories` for unchanged clusters.**
   Before calling `fuseStory()`, compare the cluster's article IDs to the
   previous run's cluster article IDs. If identical, skip the LLM call.
   This requires storing a fingerprint (e.g. sorted article ID list) per
   cluster in the `clusters-current` resource, or comparing against the
   story's existing citations.

3. **Cache entity extraction.**
   `extractEntities()` is called for every article in `clusterArticles` and
   again for absorbable articles in `fuseStories`. Store extracted entities
   on the article object during the first extraction so downstream steps
   can reuse them.

### Medium Impact / Medium Effort

4. **Incremental clustering — only process new articles.**
   Track which article IDs have already been assigned to stories (via
   `story.citations` and `story.identity.seedArticleIds`). In
   `clusterArticles`, skip articles that are already cited by an existing
   story. Only cluster genuinely new articles. This makes `clusterArticles`
   O(new_articles × stories) instead of O(all_articles × stories).

5. **Decouple fusion schedule from fetch schedule.**
   The workflow currently runs fetch + fusion together every 4 hours. But
   stories don't change meaningfully in 4 hours — most new articles just
   add citations to existing stories. Consider:
   - **Fast path (every 4h):** fetch → dedupe-articles → filter → generate
     (no fusion). The news page shows scored articles without stories.
   - **Slow path (every 12-24h):** cluster → fuse → seed → render. Runs
     less frequently, when enough new articles have accumulated to make
     re-fusion worthwhile.
   
   This could be implemented as two separate workflows, or as a single
   workflow with a guard on the cluster step that checks elapsed time since
   the last fusion run.

6. **Cap story citations.**
   `fuseStory()` appends new citations on every run without bound. Add a
   maximum citation count per story (e.g. 100) and drop the oldest when
   exceeded. This keeps `regenStory()` prompts manageable and prevents
   unbounded memory growth.

### Lower Impact / Higher Effort

7. **`regenStories` as a separate maintenance workflow.**
   Create a weekly scheduled workflow that runs `regenStories` to flush
   accumulated drift from incremental delta passes. This keeps the main
   pipeline fast while still getting periodic full-regeneration quality.

8. **Cluster fingerprinting for full skip.**
   Store a hash of the filtered article IDs in `clusters-current`. On the
   next run, if the hash matches, skip the entire fusion chain
   (cluster → fuse → seed → render) because no new articles arrived. This
   is the nuclear option — zero work when nothing changed.

9. **Batch LLM calls for absorbable articles.**
   Instead of one LLM call per absorbable article, batch multiple
   absorbable articles for the same story into a single `fuseStory()` call.
   This reduces LLM round-trips at the cost of a larger prompt.

---

## Architectural Changes

### A. Separate fusion workflow

Split the current monolithic workflow into two independent workflows that
share data through the persistent `stories-current` resource:

**Workflow 1 — `@svendowideit/news-fetch` (fast, every 4h)**

```
gather-feedback → dedupe → gather-feed-state → fetch → dedupe-articles
  → filter → generate → generate-feeds-html → discover → upsert-feed
```

This is the existing pipeline minus the fusion chain. It fetches feeds,
filters by age, scores by preferences, and generates the HTML page. No LLM
calls. Runs on the current 4-hour schedule.

**Workflow 2 — `@svendowideit/news-fusion` (slow, every 12-24h)**

```
cluster → fuse → seed → render
```

Reads `filtered-snapshot` and `stories-current` from the datastore (written
by workflow 1), runs the full fusion chain, and writes back updated
`stories-current` and `stories-html-current`. The next run of workflow 1
picks up the updated stories HTML automatically via `generate` reading
`stories-html-current`.

**Benefits:**
- The fast path (fetch + generate) never waits for LLM calls. A 4-hour run
  that previously took 5-15 minutes (with fusion) now takes ~5 minutes.
- Fusion can run at its own cadence — 12-hourly or daily — when enough new
  articles have accumulated to make re-fusion worthwhile.
- If the LLM server is down, the news page still updates on schedule.
- Each workflow is simpler to debug and resume independently.

**Implementation notes:**
- Workflow 2 needs a `trigger.schedule` (e.g. `0 */12 * * *`) independent
  of workflow 1.
- Workflow 2's `cluster` step reads `filtered-snapshot` — this resource is
  written by workflow 1's `filter` step. No direct dependency between
  workflows; they communicate through the datastore.
- If workflow 2 runs while workflow 1 is mid-execution, it reads the
  previous run's `filtered-snapshot`. This is acceptable — fusion is
  intentionally a batch process that lags slightly behind the fast path.
- The `generate` step in workflow 1 already reads `stories-html-current`
  (written by `renderStories` in workflow 2). If workflow 2 hasn't run yet,
  `generate` falls back to showing the page without fused stories.

### B. Batched LLM processing

Instead of processing all clusters in a single monolithic `fuseStories` or
`seedStories` call, process them in smaller batches across multiple workflow
runs. This prevents any single run from blocking on hundreds of sequential
LLM calls.

**Design — cursor-based batching:**

Add a `fusionCursor` resource that tracks which clusters have been
processed. Each fusion run processes a fixed-size window (e.g. 20 clusters),
then stops. The next scheduled run picks up where it left off.

```
fusionCursor: {
  lastProcessedKey: string | null,   // cluster key of last fully processed cluster
  processedCount: number,            // total clusters processed this cycle
  cycleStartedAt: string,            // when this processing cycle began
}
```

**`fuseStories` batched algorithm:**

1. Read `clusters-current` and `stories-current`.
2. Read `fusionCursor`. If `lastProcessedKey` is null, start from the
   beginning. Otherwise, skip clusters until the one after
   `lastProcessedKey`.
3. Process up to `batchSize` (e.g. 20) clusters — only those that match
   existing stories.
4. Write updated `stories-current` and updated `fusionCursor`.
5. If more clusters remain, the next scheduled run continues.

**`seedStories` batched algorithm:**

Same cursor approach, but for genuinely new clusters (those not matching
any existing story). Process up to `batchSize` new clusters per run.

**Benefits:**
- A single fusion run takes ~2-5 minutes (20 clusters × 5-10s each with
  parallel LLM calls) instead of 10+ minutes for 200+ clusters.
- The LLM server (especially a local Ollama instance) isn't saturated by
  hundreds of back-to-back requests.
- If a run fails mid-batch, the cursor ensures it resumes from where it
  left off — no duplicate LLM calls.
- The cursor naturally handles the case where new articles arrive during a
  processing cycle: new clusters are appended to the end and will be
  processed when the cursor reaches them.

**Cursor lifecycle:**
- When the cursor reaches the end of the cluster list, reset
  `lastProcessedKey` to null and bump `cycleStartedAt`. The next run starts
  a fresh cycle.
- A cycle typically completes in 2-3 runs (at 12-hour intervals, that's
  24-36 hours). This is acceptable because fusion is a quality
  improvement, not a real-time requirement.

**Combined with separate workflow:**

Workflow 2 (`@svendowideit/news-fusion`) runs every 12 hours and processes
one batch per run:

```
cluster → fuse (batch of 20) → seed (batch of 20) → render
```

If the batch size is tuned so that a full cycle completes in 2-3 runs, the
stories are fully up-to-date within 24-36 hours of new articles arriving.
The fast-path news page (workflow 1) still shows scored articles immediately
— fusion is a background enrichment.

### C. Separate feed curation workflow

The current workflow bundles feed catalog management (discovery, deduplication,
state sync) into the same run as fetch → filter → generate. These are
conceptually distinct concerns with different cadences and failure modes.

**What "feed curation" includes:**

| Step | What it does | Cadence need |
|------|-------------|-------------|
| `gather-feedback` | Poll feedback queue, import user preferences | Every run (feeds scoring) |
| `dedupe` | Fetch each catalog feed, group by content identity, mark duplicates | Daily (feeds don't duplicate hourly) |
| `gather-feed-state` | Apply enabled/disabled state from feedback server to catalog | Every run (user toggles) |
| `discover` | Crawl article URLs for new RSS feeds | Daily (new feeds appear slowly) |
| `upsert-feed` | Add discovered feeds to catalog | After discovery |
| `gather-pages` | Poll pages queue for user-submitted URLs | Every run |
| `analyze-pages` | Analyze queued pages for feed links | After gather-pages |
| `upsert-page` | Add page-discovered feeds to catalog | After analysis |

**Proposed split — three workflows:**

**Workflow 1 — `@svendowideit/news-fetch` (fast, every 4h)**

```
gather-feedback → fetch → dedupe-articles → filter → generate → generate-feeds-html
```

The core news pipeline. Fetches feeds, filters by age, scores by preferences,
generates the HTML page. `gather-feedback` stays here because it directly
affects article scoring. `generate-feeds-html` stays because it renders the
current catalog state for the feeds.html page.

**Workflow 2 — `@svendowideit/news-fusion` (slow, every 12-24h)**

```
cluster → fuse (batch of 20) → seed (batch of 20) → render
```

LLM story fusion. Runs independently, reads `filtered-snapshot` from the
datastore. See section B above.

**Workflow 3 — `@svendowideit/news-curation` (daily)**

```
dedupe → gather-feed-state → discover → upsert-feed → gather-pages → analyze-pages → upsert-page
```

Feed catalog maintenance. Runs once daily — feed duplication detection,
discovering new feeds from article URLs, processing user-submitted page URLs
for feed discovery, and syncing enabled/disabled state from the feedback
server.

**Benefits of splitting out curation:**

- **Faster news page updates.** The 4-hourly news workflow no longer waits
  for feed deduplication (which fetches every catalog feed to compare
  content), feed discovery (which crawls external sites), or page analysis.
  The news page is generated in ~5 minutes instead of 10-15.

- **Independent failure isolation.** If feed discovery hits a broken site or
  the dedupe step times out on a slow feed, the news page still updates on
  schedule. Conversely, if the news fetch fails, feed curation still runs
  and keeps the catalog healthy.

- **Appropriate cadences.** Feed deduplication and discovery don't need to
  run every 4 hours — feeds don't duplicate or appear that quickly. Running
  them daily saves network requests and CPU while producing the same result.

- **Simpler debugging.** When the news page is stale, you know to check
  workflow 1. When the catalog has duplicates, you check workflow 3. No
  more tracing through a 20-step monolithic run to find which unrelated
  step failed.

- **`gather-feed-state` stays in curation** because it syncs catalog
  enabled/disabled flags — a catalog management concern. The `fetch` step
  in workflow 1 already reads the catalog's current state (enabled feeds
  only) via `data.latest("news-feed-catalog", "current")`, so it automatically
  picks up changes from the curation workflow.

**Data flow between workflows:**

```
[news-curation, daily]          [news, every 4h]           [news-fusion, every 12h]
       │                              │                            │
       │ writes news-feed-catalog          │ reads news-feed-catalog         │
       │   (enabled/disabled,         │   (enabled feeds)          │
       │    new feeds, deduped)       │                            │
       │                              │ writes feed-snapshot       │ reads feed-snapshot
       │                              │ writes filtered-snapshot ──┤ reads filtered-snapshot
       │                              │                            │ writes stories-current
       │                              │ reads stories-html ────────┤ writes stories-html
       │                              │                            │
       ▼                              ▼                            ▼
   news-feed-catalog                   news.html                    stories-current
   (shared resource)              feeds.html                   stories-html-current
```

All three workflows communicate through swamp datastore resources — no
direct workflow-to-workflow dependencies. Each reads what the others wrote
on their last run.

**Migration path:**

1. Create `@svendowideit/news-curation` with the curation steps.
2. Create `@svendowideit/news-fusion` with the fusion steps.
3. Strip curation and fusion steps from `@svendowideit/news-fetch`, leaving only
   the fast path.
4. Set schedules: news every 4h, fusion every 12h, curation daily.
5. The existing `stories-current` and `news-feed-catalog` data is already in the
   datastore — no data migration needed.

---

## Summary

The fusion pipeline is architecturally sound — the separation of cheap
clustering from expensive LLM calls, the delta-pass design (only extract
new claims, don't re-extract everything), and the persistent story model are
all good choices.

The primary efficiency issues are:

1. **`fuseStories` re-fuses unchanged clusters** — the single biggest source
   of wasted LLM calls. Fix with cluster fingerprint comparison.
2. **Sequential LLM calls** — parallelizing would give an immediate 5-10×
   speedup with no code changes to the LLM prompts.
3. **`clusterArticles` re-clusters everything** — incremental clustering
   would make it O(new) instead of O(all).
4. **Fusion runs at fetch cadence** — decoupling the schedules would avoid
   re-fusing stories when only a handful of new articles arrived.
