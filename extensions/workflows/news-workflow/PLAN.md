# Fusion Optimisation Plan

Ordered by impact (speedup × frequency of benefit), with prerequisites noted.
Each phase is self-contained — you can stop after any phase and have a working
system that's better than before.

---

## Phase 1 — Quick Wins (no architectural changes)

These are pure code changes to `news_reader.ts`. No workflow YAML changes, no
new models, no data migration. Each is independently shippable.

### 1.1 Parallelize LLM calls

**Impact:** 5-10× speedup on `fuseStories` and `seedStories`. Currently the
`for...of` loops are sequential — each LLM call waits for the previous one.
With a concurrency limit of 5, 200 clusters process in ~40 sequential slots
instead of 200.

**Effort:** ~20 lines changed. Replace `for...of` with a concurrency-limited
`Promise.all` helper.

**Risk:** Low. The LLM server (Ollama) handles concurrent requests natively.
The only concern is memory if all prompts are built at once — mitigate by
using a semaphore pattern that only fires N requests at a time.

**Implementation sketch:**

```typescript
async function withConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const item = queue.shift()!;
      await fn(item);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
}
```

Apply to the cluster loop in `fuseStories` and the cluster loop in
`seedStories`. The absorbable-article loop in `fuseStories` can also use it.

**Verification:** Run the workflow. `fuse` step duration should drop from
minutes to tens of seconds.

---

### 1.2 Skip `fuseStories` for unchanged clusters

**Impact:** Eliminates the single biggest source of wasted LLM calls. On a
typical run, 80-90% of clusters have the same article IDs as the previous
run. Each skipped cluster saves one LLM call (~5-10s).

**Effort:** ~30 lines. Store a fingerprint per cluster in `clusters-current`,
compare on next run.

**Risk:** Low. The comparison is deterministic (sorted article ID list). If
the fingerprint matches, the LLM would produce identical output — skipping
is safe.

**Implementation sketch:**

In `clusterArticles`, after building each cluster, compute a fingerprint:

```typescript
const articleIds = cluster.articles.map(a => a.id).sort();
const fingerprint = await hashId(articleIds.join(","));
cluster.fingerprint = fingerprint;
```

In `fuseStories`, before calling `fuseStory()`, compare:

```typescript
const prevCluster = previousClusters?.find(c => c.key === cluster.key);
if (prevCluster && prevCluster.fingerprint === cluster.fingerprint) {
  logger?.info("Skipping unchanged cluster '{topic}'", { topic: cluster.topic });
  continue;
}
```

Requires adding `fingerprint?: string` to the `StoryCluster` type and
storing it in `clusters-current`.

**Verification:** Run the workflow twice with no new articles. Second run
should show "Skipping unchanged cluster" for every cluster, and `fuse` step
duration should be near-zero.

---

### 1.3 Cache entity extraction

**Impact:** `extractEntities()` is called once per article in
`clusterArticles` and again for every absorbable article in `fuseStories`.
With 892 articles, that's ~1,800 regex scans. Caching eliminates the second
pass entirely.

**Effort:** ~10 lines. Store extracted entities on the article object during
`clusterArticles`, read them back in `fuseStories`.

**Risk:** None. Entities are deterministic for a given title+summary.

**Implementation sketch:**

In `clusterArticles`, after extracting entities for an article, attach them:

```typescript
(a as any)._entities = entities;
```

In `fuseStories` absorb phase, read them back instead of re-extracting:

```typescript
const aEntities = (a as any)._entities ?? extractEntities(a.title, a.summary ?? "");
```

**Verification:** No behavioral change. `cluster` and `fuse` steps produce
identical output, just faster.

---

## Phase 2 — Structural Split (three workflows)

This is the architectural foundation that enables all further cadence-based
optimisations. It requires creating new workflow YAML files and editing the
existing one.

### 2.1 Create `@svendowideit/news` (fast path, every 4h)

**Impact:** The news page updates in ~5 minutes instead of 10-15. No LLM
calls, no catalog maintenance, no feed discovery. Just fetch → filter →
score → render.

**Steps:**

```
gather-feedback → fetch → dedupe-articles → filter → generate → generate-feeds-html
```

**What moves out:**
- `cluster`, `fuse`, `seed`, `render` → move to fusion workflow
- `dedupe`, `gather-feed-state`, `discover`, `upsert-feed`, `gather-pages`,
  `analyze-pages`, `upsert-page` → move to curation workflow

**What stays:**
- `gather-feedback` — directly affects article scoring
- `fetch` — core function
- `dedupe-articles` — needed for clean article list
- `filter` — needed for age window
- `generate` — produces news.html
- `generate-feeds-html` — produces feeds.html (reads catalog, not modified
  by this workflow)

**Implementation:**
1. Copy the existing workflow YAML.
2. Delete the fusion and curation steps.
3. Remove the `trigger.schedule` (or keep at `0 */4 * * *`).
4. Validate with `swamp workflow validate`.

---

### 2.2 Create `@svendowideit/news-fusion` (LLM, every 12h)

**Impact:** Fusion runs at its own cadence. The LLM server isn't hit every
4 hours. Stories update when enough new articles have accumulated.

**Steps:**

```
cluster → fuse → seed → render
```

**Implementation:**
1. `swamp workflow create news-fusion --json`
2. Add steps for `cluster`, `fuse`, `seed`, `render` — all targeting
   `modelIdOrName: local-news`.
3. Set `trigger.schedule: 0 */12 * * *`.
4. Dependencies: `cluster` depends on nothing (reads `filtered-snapshot`
   from datastore). `fuse` depends on `cluster` succeeded. `seed` depends
   on `fuse` or(succeeded, skipped). `render` depends on `seed`
   or(succeeded, skipped).
5. All steps `allowFailure: true` — fusion is best-effort enrichment.
6. Validate.

**Data flow:** Reads `filtered-snapshot` (written by news workflow's
`filter` step). Writes `stories-current` and `stories-html-current` (read
by news workflow's `generate` step).

---

### 2.3 Create `@svendowideit/news-curation` (daily)

**Impact:** Feed catalog maintenance no longer blocks the news page.
Deduplication, discovery, and page analysis run once daily instead of every
4 hours — saving network requests and CPU.

**Steps:**

```
dedupe → gather-feed-state → discover → upsert-feed → gather-pages → analyze-pages → upsert-page
```

**Implementation:**
1. `swamp workflow create news-curation --json`
2. Add all curation steps. `dedupe` and `gather-feed-state` target
   `feed-catalog`. `discover` targets `feed-discovery`. `upsert-feed` and
   `upsert-page` target `feed-catalog` (with forEach). `gather-pages`
   targets `local-news`. `analyze-pages` targets `feed-analysis`.
3. Set `trigger.schedule: 0 3 * * *` (daily at 3am).
4. Dependencies: `gather-feed-state` depends on `dedupe` or(succeeded,
   failed). `discover` depends on `gather-feed-state` succeeded. `upsert-feed`
   depends on `discover` succeeded. `gather-pages` and `analyze-pages` and
   `upsert-page` are an independent sub-chain.
5. Validate.

---

### 2.4 Strip old workflow

Once all three workflows are validated and running, the original monolithic
workflow can be deprecated or deleted. Keep it around for one cycle to
verify the new workflows produce identical results.

---

## Phase 3 — Batched Processing (builds on Phase 2)

These require the fusion workflow to exist separately, since batching
depends on running fusion multiple times per cycle.

### 3.1 Cursor-based batching for `fuseStories`

**Impact:** A single fusion run processes 20 clusters in ~2 minutes instead
of 200+ clusters in 10+ minutes. The LLM server isn't saturated. Failed runs
resume from where they left off.

**Effort:** ~60 lines. New `fusionCursor` resource, cursor read/write logic
in `fuseStories`, `batchSize` global argument.

**Implementation:**
1. Add `fusionBatchSize: z.number().int().min(1).default(20)` to
   `GlobalArgsSchema`.
2. In `fuseStories`, read `fusionCursor` resource.
3. Skip clusters until after `lastProcessedKey`.
4. Process up to `batchSize` clusters.
5. Write updated `fusionCursor` with new `lastProcessedKey`.
6. If all clusters processed, reset cursor for next cycle.

**Verification:** Run fusion workflow. First run processes clusters 1-20.
Second run processes 21-40. After all clusters processed, cursor resets.

---

### 3.2 Cursor-based batching for `seedStories`

**Impact:** Same as above, but for seeding new stories. Usually fewer new
clusters, so this is less critical — but keeps the pattern consistent.

**Effort:** ~30 lines. Same cursor pattern, separate cursor or shared cursor
with a phase field.

---

### 3.3 Incremental clustering

**Impact:** `clusterArticles` becomes O(new_articles × stories) instead of
O(all_articles × stories). With 892 articles and only ~50 new per run, this
is a ~18× speedup on the clustering step.

**Effort:** ~40 lines. Track which article IDs are already cited by existing
stories, skip them in phase 1.

**Implementation:**
1. Build a `Set<string>` of all article IDs already cited by any existing
   story (`story.citations` and `story.identity.seedArticleIds`).
2. In `clusterArticles`, skip articles in that set — they're already
   assigned to a story.
3. Only cluster genuinely new articles.

**Risk:** Medium. If an article was cited by a story but new information
about the same event appears under a different article, the new article
still gets clustered (different ID). The risk is that an article already
cited by story A should actually be in new story B — but this is rare and
the existing story already has it.

---

## Phase 4 — Maintenance & Polish

Lower urgency. These prevent degradation over time and handle edge cases.

### 4.1 Cap story citations

**Impact:** Prevents unbounded memory growth. A popular story that gets 10
new citations per run would have 1,400 citations after a week of 4-hourly
runs. Capping at 100 keeps prompts manageable and storage bounded.

**Effort:** ~15 lines. Add `maxCitations: z.number().int().min(10).default(100)`
to `GlobalArgsSchema`. In `fuseStory()`, after appending new citations,
slice to `maxCitations` (keep newest).

---

### 4.2 `regenStories` maintenance workflow

**Impact:** Periodic full regeneration flushes accumulated drift from
incremental delta passes. Without this, stories gradually accumulate
near-duplicate claims and stale conflicts.

**Effort:** New workflow YAML + schedule. The `regenStories` method already
exists in the model.

**Implementation:**
1. `swamp workflow create news-regen --json`
2. Single step: `regen` calling `local-news.regenStories`.
3. `trigger.schedule: 0 2 * * 0` (weekly, Sunday 2am).
4. `allowFailure: true`.

---

### 4.3 Cluster fingerprinting for full fusion skip

**Impact:** If no new articles arrived since the last fusion run, skip the
entire fusion chain. Zero work when nothing changed.

**Effort:** ~20 lines. Store a hash of all filtered article IDs in
`clusters-current`. In the fusion workflow, add a guard on the `cluster`
step that compares the current filtered-snapshot article hash to the
previous one.

---

### 4.4 Batch absorbable articles

**Impact:** Instead of one LLM call per absorbable article, batch all
absorbable articles for the same story into a single `fuseStory()` call.
Reduces LLM round-trips for the absorb phase.

**Effort:** ~30 lines. Group absorbable articles by matched story ID, call
`fuseStory()` once per group with all articles.

---

## Summary Table

| Phase | Item | Impact | Effort | Prerequisite |
|-------|------|--------|--------|-------------|
| 1.1 | Parallelize LLM calls | 5-10× faster fuse/seed | ~20 lines | None |
| 1.2 | Skip unchanged clusters | Eliminates 80-90% of LLM calls | ~30 lines | None |
| 1.3 | Cache entity extraction | ~2× faster cluster+fuse | ~10 lines | None |
| 2.1 | Fast news workflow | News page in ~5min (was 10-15) | New workflow YAML | None |
| 2.2 | Fusion workflow | LLM runs at own cadence | New workflow YAML | None |
| 2.3 | Curation workflow | Catalog maint. doesn't block news | New workflow YAML | None |
| 3.1 | Batched fuseStories | 2min/run instead of 10min+ | ~60 lines TS | Phase 2.2 |
| 3.2 | Batched seedStories | Consistent batching pattern | ~30 lines TS | Phase 2.2 |
| 3.3 | Incremental clustering | ~18× faster clustering | ~40 lines TS | Phase 2.2 |
| 4.1 | Cap story citations | Bounded memory growth | ~15 lines TS | None |
| 4.2 | regenStories workflow | Periodic quality flush | New workflow YAML | None |
| 4.3 | Full fusion skip guard | Zero work when idle | ~20 lines TS | Phase 2.2 |
| 4.4 | Batch absorbable articles | Fewer LLM round-trips | ~30 lines TS | None |

## Recommended Start

**Do Phase 1 first** — it's ~60 lines of TypeScript, no workflow changes, and
gives an immediate 5-10× speedup on the slowest step. You can ship it in one
sitting and see the difference on the next workflow run.

**Then Phase 2** — the three-way split is the architectural foundation for
everything else. It's mostly YAML editing. Once split, each workflow is
independently debuggable and optimisable.

**Phase 3 and 4** can be done incrementally as needed. The system is already
fast and maintainable after Phase 2.
