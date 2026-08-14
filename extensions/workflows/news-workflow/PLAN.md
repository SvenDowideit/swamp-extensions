# Fusion Optimisation Plan

Ordered by impact (speedup × frequency of benefit), with prerequisites noted.
Each phase is self-contained — you can stop after any phase and have a working
system that's better than before.

---

## Adversarial Review (pre-mortem)

These findings are incorporated into the plan below. Key issues found:

| # | Finding | Severity | Resolution |
|---|---------|----------|------------|
| 1 | `withConcurrency` using `queue.shift()` is not thread-safe — multiple workers can grab the same item | **Bug** | Use index-based atomic increment instead |
| 2 | Ollama with MLX models (gemma4:e4b-mlx) may serialize concurrent requests server-side, reducing parallel speedup | **Over-estimate** | Lower expected speedup to 2-4×, add `llmConcurrency` config so user can tune |
| 3 | Parallel `seedStories` has a race condition — two seeds could produce stories with the same key | **Bug** | Pre-compute which clusters need seeding before firing any LLM calls |
| 4 | Entity cache via `(a as any)._entities` won't survive JSON serialization between `writeResource`/`readResource` | **Broken** | Add optional `entities?: string[]` to the `Article` type, populate in `clusterArticles`, serialize it |
| 5 | Cluster fingerprint comparison needs the PREVIOUS run's clusters, but `fuseStories` reads the CURRENT run's `clusters-current` | **Missing data** | Write a `clusters-previous` resource at end of `fuseStories`, read it on next run |
| 6 | Fingerprint should also factor in `llmModel` + `llmTemperature` — user changing model config should trigger re-fusion | **Missing check** | Include config hash in fingerprint |
| 7 | `dedupe-articles` takes 4m40s and no optimisation addresses it | **Gap** | Added Phase 1.4: incremental dedupe |
| 8 | `regenStories` processes ALL stories sequentially — could take hours with hundreds of stories | **Unbounded** | Added batching requirement to Phase 4.2 |
| 9 | `regenStories` has no rollback — LLM hallucination corrupts all stories | **Data loss risk** | Write to `stories-regen` first, swap atomically after validation |
| 10 | After split, `fetch` step's `dependsOn` references steps that moved to curation — needs updating | **Broken ref** | Documented in Phase 2.1 implementation notes |
| 11 | Fusion workflow's `cluster` step fails if `filtered-snapshot` doesn't exist (news workflow hasn't run yet) | **Startup race** | Add guard on `cluster` step |
| 12 | Cursor batching means stories are partially updated mid-cycle — HTML shows mix of fresh and stale | **UX note** | Acceptable (eventual consistency), documented |
| 13 | New articles arriving mid-cycle overwrite `clusters-current`, invalidating cursor's `lastProcessedKey` | **Cursor invalidation** | Handle missing cluster keys gracefully (skip, don't crash) |
| 14 | Citation capping drops seed articles — loses story origin context for `regenStory` | **Quality loss** | Always preserve seed article citations, cap the rest |

---

## Status

| Phase | Item | Status | Tests |
|-------|------|--------|-------|
| 1.1 | Parallelize LLM calls | ✅ Done | `withConcurrency` is private — exercised indirectly via `seedStories`/`fuseStories` integration |
| 1.2 | Skip unchanged clusters | ✅ Done | 5 tests for `shouldSkipCluster`, 7 for `computeClusterFingerprint` |
| 1.3 | Cache entity extraction | ✅ Done | 1 test: `clusterStories caches entities on articles` |
| 1.4 | Incremental dedupe-articles | ✅ Done | 7 tests for `dedupeArticlesIncremental` |
| 1.5 | Incremental feed dedupe | ✅ Done | **No tests** — `dedupe-cache` resource logic is untested |
| 2.1 | Fast news workflow | ⬜ Not started | — |
| 2.2 | Fusion workflow | ⬜ Not started | — |
| 2.3 | Curation workflow | ⬜ Not started | — |
| 2.4 | Strip old workflow | ⬜ Not started | — |
| 3.1 | Batched fuseStories | ⬜ Not started | — |
| 3.2 | Batched seedStories | ⬜ Not started | — |
| 3.3 | Incremental clustering | ⬜ Not started | — |
| 4.1 | Cap story citations | ⬜ Not started | — |
| 4.2 | regenStories workflow | ⬜ Not started | — |
| 4.3 | Full fusion skip guard | ⬜ Not started | — |
| 4.4 | Batch absorbable articles | ⬜ Not started | — |

**Test coverage summary:** 184 test cases across 2 files (`news_reader_test.ts`: 138 tests, `feed_catalog_test.ts`: 46 tests). Key gap: `dedupe-cache` incremental feed dedupe logic in `feed_catalog.ts` has zero test coverage.

**Testing requirement for all future phases:** Each new function, resource, or workflow change must include corresponding tests. When existing tests break due to refactoring, update them — don't delete them. As edge cases are discovered during implementation, add tests for them.

---

## Phase 1 — Quick Wins (no architectural changes) ✅ COMPLETE

These are pure code changes to `news_reader.ts` and `feed_catalog.ts`. No workflow YAML changes, no
new models, no data migration. Each is independently shippable.

### 1.1 Parallelize LLM calls ✅

**Impact:** 2-4× speedup on `fuseStories` and `seedStories` (revised down
from 5-10× — Ollama with MLX models may serialize at the server level).
Currently the `for...of` loops are sequential — each LLM call waits for the
previous one. With a concurrency limit of 3-5, 200 clusters process in
~50-70 sequential slots instead of 200.

**Effort:** ~25 lines. Replace `for...of` with a concurrency-limited helper,
add `llmConcurrency` to `GlobalArgsSchema`.

**Risk:** Medium. Ollama may queue or serialize concurrent requests depending
on the model backend (MLX, CUDA, CPU). Start with concurrency 1 and tune up.
Add `llmConcurrency` as a global argument so the user can adjust per model.

**Implementation sketch:**

```typescript
// Use index-based atomic increment — queue.shift() is not thread-safe
// when multiple workers run concurrently.
async function withConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const idx = nextIndex++;
      await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
}
```

Add to `GlobalArgsSchema`:
```typescript
llmConcurrency: z.number().int().min(1).max(20).default(3)
```

Apply to the cluster loop in `fuseStories` and the cluster loop in
`seedStories`. The absorbable-article loop in `fuseStories` can also use it.

**Verification:** Run the workflow with `llmConcurrency: 1` (baseline), then
`llmConcurrency: 3`. `fuse` step duration should drop proportionally. If it
doesn't, the LLM server is serializing — try a different model or server.

---

### 1.2 Skip `fuseStories` for unchanged clusters ✅

**Impact:** Eliminates the single biggest source of wasted LLM calls. On a
typical run, 80-90% of clusters have the same article IDs as the previous
run. Each skipped cluster saves one LLM call (~5-10s).

**Effort:** ~40 lines. Store a fingerprint per cluster in `clusters-current`,
compare against `clusters-previous` on next run. Include config hash so
changing `llmModel` or `llmTemperature` triggers re-fusion.

**Risk:** Low. The comparison is deterministic. The config hash ensures
model/temperature changes aren't silently ignored.

**Implementation sketch:**

In `clusterArticles`, after building each cluster, compute a fingerprint:

```typescript
const articleIds = cluster.articles.map(a => a.id).sort();
const configFingerprint = `${ga.llmModel}:${ga.llmTemperature}`;
const fingerprint = await hashId(articleIds.join(",") + "|" + configFingerprint);
cluster.fingerprint = fingerprint;
```

In `fuseStories`, read `clusters-previous` (written at end of previous run)
and compare:

```typescript
const prevClusters = (await context.readResource("clusters-previous") as
  | { clusters: StoryCluster[] }
  | null)?.clusters ?? [];
const prevByKey = new Map(prevClusters.map(c => [c.key, c]));

for (const c of clusters) {
  const prev = prevByKey.get(c.key);
  if (prev && prev.fingerprint === c.fingerprint) {
    logger?.info("Skipping unchanged cluster '{topic}'", { topic: c.topic });
    continue;
  }
  // ... fuse as normal
}
```

At the end of `fuseStories`, write `clusters-previous` for the next run:

```typescript
await context.writeResource("clusters", "clusters-previous",
  { clusters } as unknown as Record<string, unknown>);
```

Requires adding `fingerprint?: string` to the `StoryCluster` type.

**Verification:** Run the workflow twice with no new articles and same config.
Second run should show "Skipping unchanged cluster" for every cluster. Change
`llmTemperature` and re-run — all clusters should be re-fused.

---

### 1.3 Cache entity extraction ✅

**Impact:** `extractEntities()` is called once per article in
`clusterArticles` and again for every absorbable article in `fuseStories`.
With 892 articles, that's ~1,800 regex scans. Caching eliminates the second
pass entirely.

**Effort:** ~15 lines. Add optional `entities?: string[]` to the `Article`
type. Populate in `clusterArticles`, serialize it through
`writeResource`/`readResource`, read it back in `fuseStories`.

**Risk:** None. Entities are deterministic for a given title+summary.

**Important:** The original sketch used `(a as any)._entities` — this won't
survive JSON serialization between `writeResource` and `readResource`. The
entities must be a real field on the `Article` type.

**Implementation sketch:**

Add to the `Article` type:
```typescript
entities?: string[];
```

In `clusterArticles`, after extracting entities for an article, store them:
```typescript
(a as Article & { entities: string[] }).entities = entities;
```

In `fuseStories` absorb phase, read them back:
```typescript
const aEntities = a.entities ?? extractEntities(a.title, a.summary ?? "");
```

**Verification:** No behavioral change. `cluster` and `fuse` steps produce
identical output, just faster.

---

### 1.4 Incremental `dedupe-articles` ✅

**Impact:** `dedupe-articles` currently takes 4m40s — the single slowest
non-LLM step. It re-processes ALL articles in `feed-snapshot` every run,
even though only ~50 new articles arrive per 4-hour cycle. Incremental
dedupe makes it O(new_articles) instead of O(all_articles).

**Effort:** ~30 lines. Track previously seen article URLs in a
`deduped-urls` resource, only process new URLs.

**Implementation sketch:**

```typescript
// Read previously deduped URLs
const prevDeduped = (await context.readResource("deduped-urls") as
  | { urls: string[] }
  | null)?.urls ?? [];
const prevUrlSet = new Set(prevDeduped);

// Only process new URLs
const newArticles = articles.filter(a => !prevUrlSet.has(a.url));
const existingDeduped = articles.filter(a => prevUrlSet.has(a.url));

// Dedupe only the new ones, then merge
const deduped = [...dedupeNew(newArticles), ...existingDeduped];

// Update the URL set
const allUrls = deduped.map(a => a.url);
await context.writeResource("deduped-urls", "deduped-urls-current",
  { urls: allUrls } as unknown as Record<string, unknown>);
```

**Verification:** First run processes all articles (4m40s). Second run with
only 50 new articles should take ~15s.

---

## Phase 1.5 — Incremental Feed Deduplication ✅

This is a code change to `feed_catalog.ts` (not `news_reader.ts`). It applies
the same incremental pattern as 1.4 to the catalog's `dedupe` method, which
fetches every feed's XML to compute a content identity hash.

### 1.5 Incremental `dedupe` (feed-catalog)

**Impact:** The `dedupe` step in the curation workflow fetches every catalog
feed to compute content identity hashes. With 50+ feeds, that's 50+ HTTP
requests per run. After this change, only **new feeds** (not yet cached) and
**stale feeds** (last checked > N days ago) are re-fetched. On a typical
daily curation run with 0-2 new feeds, the step drops from minutes to
seconds.

**Effort:** ~40 lines in `feed_catalog.ts`. New `dedupe-cache` resource
tracking `{ url, identity, score, lastCheckedAt }` per feed. New
`dedupeStalenessDays` global argument.

**Risk:** Low. A feed's content identity can change over time (publisher
changes format, feed moves to new domain). The staleness threshold ensures
all feeds are periodically re-checked. Default: 7 days — so every feed gets
a fresh identity check weekly, but daily runs only re-check new additions.

**Implementation sketch:**

Add to `GlobalArgsSchema` in `feed_catalog.ts`:
```typescript
dedupeStalenessDays: z.number().int().min(1).default(7)
```

In the `dedupe` method:

```typescript
const ga = context.globalArgs;
const stalenessMs = (ga.dedupeStalenessDays ?? 7) * 24 * 3600 * 1000;
const now = Date.now();

// Read previous cache: { url, identity, score, lastCheckedAt }[]
const cache = (await context.readResource("dedupe-cache") as
  | { entries: Array<{ url: string; identity: string; score: number; lastCheckedAt: string }> }
  | null)?.entries ?? [];
const cacheByUrl = new Map(cache.map(e => [e.url, e]));

for (const feed of catalogData.feeds) {
  if (feed.invalid === true) { processed++; continue; }

  const cached = cacheByUrl.get(feed.url);
  const isStale = cached
    ? (now - new Date(cached.lastCheckedAt).getTime()) > stalenessMs
    : true;

  if (!isStale) {
    // Reuse cached identity — no HTTP fetch needed.
    const group = groups.get(cached.identity) ?? [];
    group.push({ ...feed, score: cached.score });
    groups.set(cached.identity, group);
    processed++;
    continue;
  }

  // Fetch and compute identity as before...
  const { identity, score } = feedIdentity(xml);
  // ... update cache entry
  cacheByUrl.set(feed.url, { url: feed.url, identity, score, lastCheckedAt: new Date().toISOString() });
}

// Persist updated cache at end of method.
await context.writeResource("dedupe-cache", "dedupe-cache-current",
  { entries: [...cacheByUrl.values()] } as unknown as Record<string, unknown>);
```

**Verification:** Run dedupe twice with no new feeds. Second run should show
all feeds reusing cached identities (no HTTP requests). Add a new feed, run
again — only the new feed is fetched. Wait 7 days, run — all feeds are
re-fetched.

**Interaction with Phase 2:** After the curation workflow is split out
(Phase 2.3), this optimisation makes the daily curation run nearly instant
when no new feeds were added — just a cache lookup per feed.

---

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
3. **Fix `fetch`'s `dependsOn`:** currently depends on `dedupe` and
   `gather-feed-state` — both moved to curation. Change to depend on nothing
   (or depend on `gather-feedback` succeeded). The `fetch` step reads the
   catalog's current state via `data.latest("feed-catalog", "current")` —
   it doesn't need dedupe/gather-feed-state to have run in the same
   workflow invocation.
4. **Fix `generate-feeds-html`'s `dependsOn`:** currently depends on
   `filter` — keep this, it's still in the workflow.
5. Set `trigger.schedule: 0 */4 * * *`.
6. Validate with `swamp workflow validate`.

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
6. **Add guard on `cluster` step:** the news workflow might not have run
   yet, so `filtered-snapshot` may not exist. Guard:
   ```yaml
   guard: ${{ data.latest("news-reader", "filtered-snapshot") == null }}
   ```
   This skips the entire fusion chain when there's no data to cluster.
7. Validate.

**Data flow:** Reads `filtered-snapshot` (written by news workflow's
`filter` step). Writes `stories-current` and `stories-html-current` (read
by news workflow's `generate` step).

**UX note:** Stories are eventually consistent. After a news run produces
new `filtered-snapshot`, it may take up to 12 hours before fusion processes
it. The news page shows scored articles immediately; fused stories appear
on the next fusion run. This is acceptable — fusion is enrichment, not a
real-time requirement.

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
in `fuseStories`, `fusionBatchSize` global argument.

**Implementation:**
1. Add `fusionBatchSize: z.number().int().min(1).default(20)` to
   `GlobalArgsSchema`.
2. In `fuseStories`, read `fusionCursor` resource.
3. Skip clusters until after `lastProcessedKey`.
4. Process up to `batchSize` clusters.
5. Write updated `fusionCursor` with new `lastProcessedKey`.
6. If all clusters processed, reset cursor for next cycle.

**Cursor invalidation handling:** If the news workflow runs and produces a
new `filtered-snapshot` mid-cycle, the next fusion run will have a new
`clusters-current` with different cluster keys. The cursor's
`lastProcessedKey` may not exist in the new cluster list. Handle this
gracefully: if `lastProcessedKey` is not found, start from the beginning
of the new cluster list. This means some clusters may be re-processed, but
no clusters are silently skipped.

**Verification:** Run fusion workflow. First run processes clusters 1-20.
Second run processes 21-40. After all clusters processed, cursor resets.
Run news workflow to produce new articles, then run fusion — cursor resets
and processes from the start of the new cluster list.

---

### 3.2 Cursor-based batching for `seedStories`

**Impact:** Same as above, but for seeding new stories. Usually fewer new
clusters, so this is less critical — but keeps the pattern consistent.

**Effort:** ~30 lines. Same cursor pattern, separate cursor or shared cursor
with a phase field.

**Race condition fix:** Parallel `seedStories` calls could produce two
stories with the same key if two clusters have the same topic+entities.
Pre-compute which clusters need seeding (those whose key doesn't match any
existing story) BEFORE firing any LLM calls. Then seed only those, with
deduplication by key within the batch.

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

**Effort:** ~20 lines. Add `maxCitations: z.number().int().min(10).default(100)`
to `GlobalArgsSchema`. In `fuseStory()`, after appending new citations,
slice to `maxCitations` (keep newest).

**Preserve seed articles:** The seed articles (`story.identity.seedArticleIds`)
are the story's origin — they should never be dropped. When capping, always
keep citations whose article ID is in `seedArticleIds`, then fill the
remaining slots with the newest non-seed citations.

```typescript
const seedIds = new Set(story.identity.seedArticleIds);
const seedCitations = citations.filter(c => seedIds.has(/* article id */));
const otherCitations = citations.filter(c => !seedIds.has(/* article id */));
const capped = [...seedCitations, ...otherCitations.slice(-(maxCitations - seedCitations.length))];
```

---

### 4.2 `regenStories` maintenance workflow

**Impact:** Periodic full regeneration flushes accumulated drift from
incremental delta passes. Without this, stories gradually accumulate
near-duplicate claims and stale conflicts.

**Effort:** New workflow YAML + schedule + model changes. The `regenStories`
method already exists but needs batching and atomic swap.

**Critical issues with current `regenStories`:**
1. **Unbounded runtime:** processes ALL stories sequentially. With 500
   stories × 5s per LLM call = 40+ minutes. Must be batched.
2. **No rollback:** writes directly to `stories-current`. If the LLM
   hallucinates mid-run, all stories are corrupted with no way to revert.

**Implementation:**
1. Add `regenBatchSize: z.number().int().min(1).default(10)` to
   `GlobalArgsSchema`.
2. Add cursor-based batching to `regenStories` (same pattern as 3.1).
3. **Atomic swap:** write regenerated stories to `stories-regen` resource
   during processing. Only when ALL batches complete, atomically swap
   `stories-regen` → `stories-current`. If a batch fails, the original
   `stories-current` is untouched.
4. `swamp workflow create news-regen --json`
5. Single step: `regen` calling `local-news.regenStories`.
6. `trigger.schedule: 0 2 * * 0` (weekly, Sunday 2am).
7. `allowFailure: true`.

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
| 1.1 | Parallelize LLM calls | 2-4× faster fuse/seed | ~25 lines | None |
| 1.2 | Skip unchanged clusters | Eliminates 80-90% of LLM calls | ~40 lines | None |
| 1.3 | Cache entity extraction | ~2× faster cluster+fuse | ~15 lines | None |
| 1.4 | Incremental dedupe-articles | 4m40s → ~15s on typical run | ~30 lines | None |
| 1.5 | Incremental feed dedupe | Minutes → seconds on daily run | ~40 lines | None |
| 2.1 | Fast news workflow | News page in ~5min (was 10-15) | New workflow YAML | None |
| 2.2 | Fusion workflow | LLM runs at own cadence | New workflow YAML | None |
| 2.3 | Curation workflow | Catalog maint. doesn't block news | New workflow YAML | None |
| 3.1 | Batched fuseStories | 2min/run instead of 10min+ | ~60 lines TS | Phase 2.2 |
| 3.2 | Batched seedStories | Consistent batching pattern | ~30 lines TS | Phase 2.2 |
| 3.3 | Incremental clustering | ~18× faster clustering | ~40 lines TS | Phase 2.2 |
| 4.1 | Cap story citations | Bounded memory, preserves seeds | ~20 lines TS | None |
| 4.2 | regenStories workflow | Periodic quality flush, atomic swap | New workflow + ~40 lines TS | None |
| 4.3 | Full fusion skip guard | Zero work when idle | ~20 lines TS | Phase 2.2 |
| 4.4 | Batch absorbable articles | Fewer LLM round-trips | ~30 lines TS | None |

## Recommended Start

**Do Phase 1 first** — it's ~110 lines of TypeScript, no workflow changes, and
gives immediate speedups on the three slowest steps (dedupe-articles: 4m40s →
~15s, fuseStories: 80-90% fewer LLM calls, cluster: 2× faster). You can ship
it in one sitting and see the difference on the next workflow run.

**Then Phase 2** — the three-way split is the architectural foundation for
everything else. It's mostly YAML editing. Once split, each workflow is
independently debuggable and optimisable.

**Phase 3 and 4** can be done incrementally as needed. The system is already
fast and maintainable after Phase 2.
