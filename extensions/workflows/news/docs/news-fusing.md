# News Fusing — Design & Implementation Plan

**Status:** research / proposal · **Owner:** news reader pipeline
**Scope:** a persistent, provenance-retaining fusion step that combines related articles
into living "story objects", keeping long-running stories alive across filter windows.

---

## 1. Why fuse (and why it's not summarising)

Three distinct operations, often conflated:

| Operation | Input | Output | State | Provenance | Conflicts |
|---|---|---|---|---|---|
| **Summarise** | 1 article | shorter version | stateless | drops source | n/a |
| **Synthesise** | N articles | 1 merged piece | stateless | averaged away | smoothed away |
| **Fuse** | N articles (same story) | enriched story object | **persistent** | per-claim kept | **surfaced** |

Fusing is the only one that solves the actual problem here: **recurring stories
spanning longer than the filter window**. Today `filterArticlesByAge` (news_reader.ts:47)
drops anything older than `maxAgeMs` — which severs the thread of a long-running
story (trial, war, scandal, product saga). Fusion keeps a *story object* that
accumulates across runs instead of recomputing from scratch each cycle.

Defining traits of fusion (all four must hold or it degrades into synthesis):

1. **Entity/time-anchored** — "this is the same story across feeds and days"
2. **Provenance retained** — every claim tagged to its source article
3. **Conflict surfaced, not smoothed** — differing figures stay visible
4. **Incremental delta** — "what's new since last run", not a re-summary
5. **Persistent state** — the story lives across windows

---

## 2. Failure modes and mitigations

These are the primary risks. Each is paired with a concrete mitigation; the design
in §4 is built around them.

| # | Failure mode | Mitigation |
|---|---|---|
| 1 | **False merging** — two unrelated articles joined into one story (same name, different people/strikes/events) | Match on extracted **entities + canonical URLs + dates**, not title similarity. Explicit "same story?" gate with a *low* merge threshold; **default to not merging** when uncertain. |
| 2 | **Contradiction smoothing** — conflicting figures reconciled into one number, losing the disagreement (often the news itself) | Never reconcile. Represent `claimA (source X) vs claimB (source Y)`, render a dedicated **conflicts** section. |
| 3 | **Provenance loss** — fused piece reads as one authoritative voice | Every claim carries `source: [url]`; render per-claim citations. This is what separates fusion from a fancy summary. |
| 4 | **Topic drift** — "protests" accretes into "elections" via loose linking | Freeze the story **identity** at seed time (canonical topic + entities + first article). New articles must match the *identity*, not just be "related". Cap scope; allow splitting on drift. |
| 5 | **Compounding stale errors** — an error in run N persists and is reinforced in runs N+1… | Periodically **regenerate** the story from raw source articles (full re-fusion) to flush drift. Keep raw articles in the snapshot. |
| 6 | **Recency bias** — trivial updates bury the still-relevant core | Separate **stable core facts** from a **latest-update delta**; render both. |
| 7 | **Nuance / hedging loss** — "reportedly", "alleged" dropped for brevity | Preserve uncertainty markers; per-claim `status: confirmed \| reported \| alleged`. |
| 8 | **Entity resolution errors** — same name, different entity | Key on canonical IDs (URL, feed origin, real entity IDs); disambiguate with context (dates/org/location). |
| 9 | **Old fact re-reported looks new** — same fact re-run by different outlets on different days | Dedup by **claim/embedding similarity against the existing story body**, not by article URL. |
| 10 | **Cost / latency explosion** — fusing every story every cycle | Cheap clustering first; LLM fusion only on matched groups (N≥2 articles or significant delta); tiered. |
| 11 | **Unverifiable deltas** — wrong "what changed" output | For the delta, prefer **extraction / verbatim quoting** over rewriting; only mark "new" if not contradicted by existing core. |
| 12 | **No ground truth for quality** | Provenance makes every claim checkable; log every fusion decision (merged, new, conflicting) for spot-checks. |

### Design consequences
- Fusion is **opt-in**: one-off articles stay as normal summaries. Only trigger when a
  story object exists or a cluster forms (prevents over-fusion / forced narratives).
- **Age-filter citations, never core facts.** A story's core survives the window; only
  individual article citations age out after a retention period.
- **Conservative by default.** A failed merge is more harmful than a missed one; prefer
  leaving two stories separate over joining two wrongly.

---

## 3. Data model

### Story object (persistent, stored in vault/datastore)

```ts
interface Story {
  id: string;                 // stable, e.g. hash of (canonical topic + entities)
  identity: {
    topic: string;            // frozen at seed
    entities: EntityRef[];    // canonical IDs, not bare names
    seedArticleIds: string[]; // first articles that established identity
  };
  core: Claim[];              // stable established facts
  updates: Claim[];           // delta since last run, newest first
  conflicts: Conflict[];      // unresolved disagreements
  status: "confirmed" | "reported" | "alleged" | "unresolved";
  citations: ArticleRef[];    // age-managed; core never dropped
  createdAt: string;          // ISO
  lastUpdatedAt: string;      // ISO
  lastRegenAt: string;        // last full re-fusion from raw snapshot
}
```

### Claim (the atomic unit — every fact, not every article)

```ts
interface Claim {
  text: string;               // verbatim-ish, uncertainty markers preserved
  sources: string[];          // article URLs that support it
  status: "confirmed" | "reported" | "alleged" | "conflicting";
  isDelta: boolean;           // introduced since last run
  embedding?: number[];       // for claim-level dedup vs existing body
  addedAt: string;
}
```

### Conflict

```ts
interface Conflict {
  claimA: Claim;
  claimB: Claim;
  note: string;               // e.g. "death toll discrepancy between sources"
  resolvedAt?: string;
}
```

---

## 4. Pipeline design

```
fetch
  ↓
dedup (URL-level, existing news-feed-catalog logic)
  ↓
cluster by story identity        ← cheap: entities + canonical URL + date
  ↓
for each cluster:
  no story object?
    → seed: identity + core facts + provenance
  story exists?
    → diff new articles vs core
    → extract delta (verbatim/quote-first)
    → conflict-check vs core + other deltas
    → append claims with provenance
  ↓
render: core + updates + conflicts + citations
  ↓
persist story object
  ↓
periodically: regenerate from raw snapshot (flush drift)
```

### Step details

1. **Cluster** (cheap, every cycle, no LLM): group articles by extracted entities,
   canonical URLs, feed origin, and date proximity. Threshold on entity overlap; keep
   conservative. Articles that match no existing cluster are left as ordinary summaries.
2. **Gate** (cheap-to-cheap, LLM only when cheap match is ambiguous): "same story?"
   — a *low-confidence* merge decision (default: no). Rejects false merges (#1).
3. **Delta** (LLM): compare new cluster articles against `story.core`. Extract only
   genuinely new claims; **quote-first**, rewrite-last (#11). Reject claims already
   present via embedding similarity (#9).
4. **Conflict-check** (cheap): a new claim that contradicts a core claim creates a
   `Conflict` instead of overwriting (#2). Never reconcile.
5. **Regen** (LLM, throttled — e.g. every 10 cycles or when `updates.length` passes a
   threshold): re-fuse from the raw snapshot into a fresh story, diff against the old
   one, keep the better (#5).

### Rendering
```
[Story: <topic>]
CORE:
  • claim (source A, B)
  • claim (source C) [reported]
CONFLICTS:
  ⚠ claimA (A) vs claimB (B)
UPDATES (since <lastRun>):
  • new claim (source D)
  • new claim (source E) [alleged]
CITATIONS: [A] [B] [C] [D] [E]
```

---

## 5. Integration with the current code

- `filterArticlesByAge` (news_reader.ts:47): change so it drops **citations** by
  retention, never core facts. Story objects bypass the window entirely.
- `duplicate` / `duplicateOf` / `duplicateCount` (feed_catalog.ts): keep as the
  URL-level pre-dedup feeding the clusterer; fusion adds *claim-level* dedup on top.
- `feed-snapshot` / `filteredSnapshot` resources (news_reader.ts:1094): these already
  retain raw articles — the source for regeneration and provenance.
- Storage: story objects go in the existing vault/datastore, keyed by `story.id`.

### Suggested API surface

```ts
clusterArticles(articles: Article[], existing: Story[]): StoryCluster[]
fuseStory(cluster: StoryCluster, existing?: Story): FuseResult   // delta
seedStory(cluster: StoryCluster): Story
regenStory(storyId: string, rawSnapshot: Article[]): Story
renderStory(story: Story): string   // html/md block for the page
```

---

## 6. Evaluation

No clean ground truth exists (#12), so use a combination:

- **Provenance checks** — every claim has sources; spot-check that a claim is actually
  supported by its cited article.
- **Decision log** — log each merge/new/conflict decision; audit for false merges and
  missed deltas.
- **Conflict preservation rate** — count of real disagreements surfaced vs smoothed.
- **Drift audit** — on regeneration, measure identity drift (topic/entities change).
- **Cost budget** — % of cycles where LLM fusion ran; keep tiered gate cheap.

---

## 7. Rollout (phased)

1. **P0 — cluster + seed + render + persist.** Story objects exist, core survives the
   window. No LLM delta yet; just provenance-tagged clustering of the current day.
2. **P1 — delta.** Incremental updates with quote-first extraction + claim dedup.
3. **P2 — conflicts + status.** Surface disagreements; uncertainty markers preserved.
4. **P3 — regeneration + drift controls.** Throttled full re-fusion; splitting on drift.
5. **P4 — evaluation dashboards + cost tiering.**

P0 alone already fixes the headline problem (stories surviving the filter window);
each later phase adds fidelity without reworking the core.

---

## 8. Open questions

- Retention policy for citations (how long old article refs live before pruning).
- Threshold tuning for entity-overlap clustering (per-domain? per-feed-class?).
- When does a story "end"? (no new delta for N cycles → archive, don't delete).
- Regeneration frequency vs cost; adaptive trigger (e.g. on detected contradiction).
- Whether to fuse *across* feeds (same story from BBC + Reuters) vs within-feed only.
