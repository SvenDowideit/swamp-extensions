# Idea Factory — Design & Research

> **Authoritative plan:** this document explores the full design space. The
> buildable, practical plan is [The Practical System](#the-practical-system-authoritative-plan)
> below — read that first, and treat the rest as design rationale.

## Vision

A self-hosting idea-to-implementation factory loop. You speak (or type) a
random *thought* with no context, and the factory catches it: it drops the
thought into the inbox, classifies it, files it into the right idea group —
and when it isn't sure, it *thinks about it* and asks you questions to sharpen
the thought or its classification. It then tells you what that thought means
for your existing ideas, and whether it should do anything about it yet. From
there the system clusters, researches, critiques, helps you implement parts,
records what worked and what didn't, and feeds everything back into the next
cycle. The system is built using itself — the first iteration bootstraps the
scaffolding, then each cycle improves the factory.

## The Practical System (authoritative plan)

The rest of this document explores the full design space — speech, federated
wiki, adversarial critique, external datastores. This section is the
*authoritative, achievable* plan. The system is a *thought-classification
system* first: every thought comes in, gets classified, and is routed to a
branch. The **software factory is one branch** — the branch that turns software
thoughts into working, tested code. Where this section conflicts with earlier
sections, this section wins. Read this first; treat the rest as design
rationale.

### Scope: all thoughts in, classified, routed to branches

Every thought enters the same inbox and is classified. Classification routes it
to a branch:

- **Software idea** → the software factory branch (plan → implement → verify →
  record).
- **Todo** → the appropriate list (shopping, household, appointments, work,
  per-idea). The factory's job ends at routing: the todo's *lifecycle*
  (completion, recurrence, reminders) is handled outside the factory, by the
  list system. The factory does not manage the todo's life; it just files it.
- **Note** → attach to the nearest idea, or store as a note.
- **Noise / ambiguous** → the review queue.

The software factory is one branch of this system, not the whole system. The
todo branch is deliberately simple: classify → route to list → done. Its
lifecycle lives elsewhere.

### The MVP loop

The minimum viable system is one swamp model plus one workflow that closes the
classification loop and drives the software branch:

```
thought → classify → route
   ├─ software idea → plan (tasks + acceptance criteria) → implement (code)
   │                → verify (run tests) → record (post-mortem)
   └─ todo → file to list (lifecycle outside the factory)
```

The MVP deliberately keeps **no LLM in the critical path**. Classification
starts as keyword/tag matching; planning can be manual task entry; the only
step that genuinely needs an LLM is `implementTask`, and it is
`allowFailure: true` so a flaky model degrades to "task marked unverified"
rather than killing the loop. Todo routing is deterministic from the start.

### The loop is a loop: reversion at any stage

The workflow is not a one-way pipeline. It is a loop, and at any stage a new
input can pull an idea back to an earlier phase. A refinement thought arrives
mid-implementation → the idea reverts to `planned` (or `critiqued`). New
research invalidates a critique → back to `researching`. A rethink changes the
intent → back to `captured`/`researching`, possibly spawning a child idea.

Mechanically this is cheap because of the design already in place:

- **Status is a label, not a lifecycle.** Reverting is just changing the
  `status` label; the history (prior versions, lineage edges) is preserved per
  the immutability principle. Nothing is lost by going backward.
- **Guards make re-runs incremental.** When an idea reverts, its status (or
  `contentHash`) changes, so the guards that gate `researchIdea` /
  `critiqueIdea` / `planIdea` / `implementTask` re-fire and re-run only the
  steps the revert invalidates. The loop re-enters the earlier phase without
  redoing everything.
- **`assessImpact` is the trigger.** Every thought that touches an idea already
  produces a suggested action. When that action is `re-think` or higher, the
  impact step sets the idea's status back to the appropriate earlier phase
  instead of only proposing it. The human gate (default-accept) confirms; the
  revert is logged.

The rule: **any stage can be re-entered from any later stage.** The DAG is a
state machine, not a pipeline. This is what makes the loop a *loop* rather
than a one-way conveyor.

### The software core (the part that makes it a *software* factory)

`implementTask` is the heart. It works against a real repo on the filesystem:

- **Scaffold** — create a project from a template (or reuse an existing repo).
- **Implement** — write the code for one task from the plan.
- **Run tests** — execute the repo's actual test suite (`deno test`, `npm
  test`, etc.).
- **Verify** — `verifyImplementation` records pass/fail per acceptance
  criterion, not "does it look right."
- **Fix** — `fixFailures` (LLM, `allowFailure`) iterates on failing tests.

The repo is the implementation artifact; the factory's output is a repo with
passing tests. This mirrors the news stack's proven pattern (one model, many
methods, chained by a workflow with guards) but pointed at code instead of
feeds.

### Build order (achievable, in order)

> Detailed, phase-by-phase version, including the concrete model methods,
> resources, workflow DAG, and per-phase definitions of done: see
> [Initial Build: The Swamp-Owned Factory](#initial-build-the-swamp-owned-factory-implementation-plan).

1. **`@svendowideit/idea-factory` model** — deterministic core first:
   `ingestThought`, `classifyThought` (keyword/tag), `createIdea`,
   `createTodo`, `linkLineage`, `applyClassification`. No LLM. This closes
   capture→classify→route.
2. **`idea-factory` workflow** — the DAG with guards. Run manually first, then
   add the cron trigger.
3. **`@svendowideit/idea-wiki` report** — render the store to HTML.
4. **The software core** — `planIdea`, `implementTask`, `runTests`,
   `verifyImplementation`, `fixFailures`. This is what makes it a software
   factory.
5. **LLM methods** — `thinkAboutIt`, `assessImpact`, `researchIdea`,
   `critiqueIdea`, `refineIdea`, `recordPostMortem`, `surfaceInsights` — each
   `allowFailure: true`, each with a guard.
6. **Eval & health reports** — `@svendowideit/idea-factory-eval` and
   `@svendowideit/idea-factory-health` (see "Verifiability, Testability &
   Sustainability").
7. **Dogfood** — import this document as the first idea, run the loop, watch
   it plan, implement, and verify.

### Practical gates: default-accept, review in batch

The earlier design gates nearly every step behind `manual_approval`
(askQuestions, review-ambiguous, approve-idea, approve-refinement,
approve-implementation, approve-postmortem, approve-merge) — seven places a
personal factory can stall. The practical rule:

- **Default-accept with logging** for everything reversible: classification,
  refinement, research, critique, post-mortem. The human reviews these in
  batch on the wiki, not one-by-one in the loop.
- **Require approval only for destructive or irreversible actions**: merge,
  supersede, delete, and "mark implemented." Everything else proceeds and is
  logged.

This keeps the loop running while preserving the human's veto where it matters.

### Deferred (explicitly out of the first iterations)

- Speech / voice capture and dialogue
- Federated wiki, public idea garden, multi-repo sync
- External datastore (Option E) and per-item parallelism
- Blockchain / verifiable-claim provenance
- Adversarial debate agents (critique starts as a single red-team pass)

The todo branch is *not* deferred — it is in scope from the start, but only as
classify → route to list. What is deferred is the todo *lifecycle* (calendar
sync, reminders, geolocation), which lives outside the factory.

Each deferred item is a clean later addition because the resource names and DAG
shape are stable; deferring them now is what makes the MVP achievable.

## Initial Build: The Swamp-Owned Factory (implementation plan)

This is the concrete plan for the *first* working factory. It is the direct
implementation of "The Practical System" above, with one decision locked in:

**Everything is stored in swamp model data resources** (Option A, swamp-native).
Thoughts, classifications, ideas, lineage, plans, artifacts, and outcomes are
all named data resources on a single model type — versioned and queryable via
`data.latest()`, so the immutability principle is native (append-only versions,
nothing deleted) and workflow guards read the store with zero sync. No files,
no external DB for the first build. The `postgres-datastore` in this repo
already exists as a future backend swap — the model calls `readResource` /
`writeResource`, so only the datastore changes later, never the model code.

### Shape: one model type, many methods (the news-stack pattern)

One `@svendowideit/idea-factory` extension, one model type, every step a
method that writes a named resource. This mirrors `@svendowideit/news-reader`,
giving us CEL wiring for free and a single lock (fine for a personal factory).

```
@svendowideit/idea-factory   (one model type — everything in swamp resources)
  methods:                                    resource (data):
    ingestThought        →  "inbox"          (raw thoughts + source)
    classifyThought      →  "classification" (kind + confidence + reasoning)   [A]
    clusterThoughts      →  "ideas"          (thoughts → common ideas)         [A]
    mergeIntoIdea        →  "ideas"          (fold a thought into an idea)     [A]
    refineIdea           →  "ideas"          (new thought updates idea body)   [A]
    planIdea             →  "plans"          (tasks + acceptance criteria)     [A]
    implementPlan        →  "artifacts"      (docs + tests + files written)    [A]
    runTests             →  "verification"   (pass/fail per criterion)         [D]
    recordOutcome        →  "outcomes"       (what worked / what didn't)       [A]
    surfaceInsights      →  "insights"       (cross-idea patterns)             [A]
    createTodo           →  "todos"          (the todo branch)
```

`[D]` = deterministic, `[A]` = LLM with `allowFailure: true` (a flaky local
Ollama degrades to "skipped/unverified", never kills the loop).

### The workflow DAG (one workflow, cron-triggered)

```
ingestThought → classifyThought → clusterThoughts → createIdea/mergeIntoIdea
   └─ todo → createTodo (lifecycle outside the factory)
refineIdea → [planable?] → planIdea → implementPlan → runTests → recordOutcome
          ↑        └─ (not planable) → recordOutcome
surfaceInsights → (insights become new thoughts) → ingestThought   ← the loop
```

It is a *loop*, not a pipeline: any step can be re-entered from a later one
(per "The loop is a loop"). Each step carries a CEL guard so the cron is
incremental — re-running only processes new/unprocessed items. Reversion is
free: a refinement thought sets an idea's status back to an earlier phase and
the guards re-fire only the steps it invalidates.

### The simple web UI: a kanban board

A small, read-oriented kanban over the store, plus a capture form. This is how
thoughts get in and how the whole pipeline is seen at a glance.

**Columns** are the factory states (an item's `status` label decides its column):

| Column         | Shows                                           |
| -------------- | ----------------------------------------------- |
| **Thoughts**   | the inbox — raw and classified thoughts         |
| **Ideas**      | common ideas (body, lineage, refined)           |
| **Plans**      | planned ideas (tasks + acceptance criteria)     |
| **Implementation** | docs / tests / artifacts + verification per criterion |
| **Feedback**   | recorded outcomes and insights                  |

Each column reads one resource (`data.latest("idea-factory", "<resource>")`),
so the board is a *projection* of the store. Because status is a label, a card
moves forward when its idea advances and **back** when a new thought reverts it
(the loop — reversion is just a status change, visible on the board).

**Capture.** A single textarea at the top. Submitting it POSTs to a small
write-back service (the same pattern as the news stack's `feedback-server.ts`)
which calls `ingestThought` → the thought lands in the `inbox` resource and the
next workflow run classifies it. This is the near-zero-friction front door.

**Implementation notes.** The board is a report extension
(`@svendowideit/idea-factory-board`) that renders one static HTML page from the
model's resources, regenerated after each workflow run. The write-back service
is a tiny always-on server (Node/Deno) exposing a POST endpoint for capture and,
optionally, simple endpoints to move a card between columns (which advances or
reverts the idea's status). Minimal and read-first: viewing is free; editing
happens through the write-back service.

### Build order

Build in five phases. Each has a concrete deliverable and a definition of done
so progress is verifiable.

**Phase 0 — Capture & classify (the first working loop).**
- `swamp extension search idea-factory` and `swamp model type search idea` first
  (per the repo rule: search before build — confirm no existing type to extend).
- Scaffold `@svendowideit/ideas-factory` extension.
- Implement `ingestThought` → `inbox` and `classifyThought` → `classification`.
  **Keyword/tag matching** (no LLM) so the loop runs offline; the LLM classifier
  is a later, `allowFailure` addition.
- First workflow `ideas-factory.yaml`: ingest → **classify**. **No routing.**
  Routing a thought into an idea/todo requires the processing step (clustering
  thoughts into common ideas), which does not exist until Phase 1 — so a
  classified thought *stays in the Thoughts column*. Nothing appears in Ideas or
  Todos until that processing is built.
- **The kanban web UI** — renders the kanban from the store; a small write-back
  service exposes the capture form (POST → `ingestThought`), then the workflow
  re-classifies and re-renders.
- **Done (definition of done):** a thought can be captured *through the web UI*,
  classified into a swamp resource, and **seen in the kanban's Thoughts column
  (classified, still a thought)**. Dogfood: import this document as the first
  thought. Ideas/Todos columns are present but empty — that is the correct,
  honest Phase 0 state (nothing processed).

**Phase 1 — Common ideas & iteration.**
- `clusterThoughts` (LLM) → `ideas`: group related thoughts into *common ideas*,
  propose duplicates. 
- `createIdea` / `mergeIntoIdea`: materialize a common idea or fold a thought
  into an existing one (dedupe).
- `refineIdea`: a new thought updates an existing idea's body (iterate).
- **Done:** several thoughts become one common idea, or refine an existing one;
  lineage recorded.

**Phase 2 — Plan (where appropriate).**
- `planIdea` (LLM) → `plans`: decompose a planable idea into tasks, each with
  `acceptanceCriteria` + `testStrategy`. A gate decides *which* ideas get a plan
  (effort `medium`+ or high value); trivial ideas skip to `recordOutcome`.
- Reversion guard: a refinement of a planned idea sets its plan `stale` → re-plan.
- **Done:** a planable idea has a task breakdown with testable criteria.

**Phase 3 — Action the plan (docs + tests).**
- `implementPlan` (LLM, `allowFailure`) → `artifacts`: for each task, write
  markdown docs and test files into the repo.
- `runTests` (deterministic) → `verification`: run the repo's test suite
  (`deno test` etc.), record pass/fail per acceptance criterion.
- `fixFailures` (LLM, `allowFailure`): iterate on failing tests.
- **Done:** a plan is actioned as docs + tests in the repo, and `verification`
  shows per-criterion results. Human approval (`manual_approval`) only on
  "mark implemented" (irreversible).

**Phase 4 — Feedback loops (make it a loop).**
- `recordOutcome` → `outcomes`: what worked / what didn't, per idea.
- `surfaceInsights` → `insights`: patterns across outcomes; insights are fed
  back as new thoughts (→ `ingestThought`).
- `@svendowideit/idea-factory-health` and `-eval` reports: classification
  accuracy over a corpus + degradation (stuck thoughts, allowedFailures, aging).
- Cron trigger: the workflow fires periodically; guards make it incremental.
- Classifier overrides feed the eval corpus (feedback into the classifier).
- **Done:** a completed idea's outcome generates insights that seed new
  thoughts, closing the loop.

### Definition of done (the initial factory)

Capture a random thought → LLM classify → cluster into a common idea → iterate
(refine) → plan where appropriate → action the plan (docs + tests) → `runTests`
verifies → record the outcome → insights feed back — all with data in swamp
model resources, one workflow, idempotent guards, and a cron trigger. The whole
pipeline is visible and capturable through the kanban web UI.

### Deferred for the initial build

Speech, federated wiki, external datastore / per-item parallelism, adversarial
debate agents, todo lifecycle. Keep the resource names and DAG shape stable so
each remains a cheap later addition.

## The Inbox: Thought Classification

Before anything else, the factory needs a place to receive *thoughts* — raw,
unstructured fragments that arrive with no preconceived shape. A thought might
be a half-sentence tapped into a phone, a voice note while walking, a paragraph
pasted from an article, or a stray line that doesn't yet know whether it's an
idea, a refinement, or a reminder to buy milk.

The inbox is the zero-friction front door. Its only job is to accept thoughts
and route them correctly. Capture must be near-zero friction; classification
happens after, not before.

**The ideal UX is conversational, not form-filling.** You speak a random
thought into a microphone with no context and walk away. The factory takes it
from there: it files the thought into the inbox, classifies it, and files it
into the right idea group. When the thought is ambiguous — which is most of
the time, because a stray thought is by nature under-specified — the factory
*thinks about it* and comes back with questions rather than guesses. It might
ask "do you mean this refines the caching-layer idea, or is it a new idea
altogether?" or "is this a thing to do now, or a thing to think about?" Once
you answer, it re-classifies and files accordingly.

Classification is therefore a *dialogue*, not a single pass. The factory forms
a hypothesis, asks a clarifying question, and the human's answer narrows the
routing. Only when the thought is unambiguous does classification complete in
one pass with no human in the loop.

### Data model: The Thought

```yaml
Thought:
  id: uuid
  raw: string                  # verbatim text/transcript as captured
  source: enum                 # text | speech | wiki | web-clip | email | api
  capturedAt: iso-datetime
  status: enum                 # unclassified | classified | discarded | parked
  classification:              # set once the classifier has run
    kind: enum                 # new-idea | refinement | minor-rethink | major-rethink | duplicate | todo | note | noise
    confidence: float          # 0..1 — how sure the classifier is
    targetIdeaId: uuid|null    # for refinement/rethink/duplicate — which idea it maps to
    reasoning: string          # one line: why this classification
    alternativeKinds: [enum]   # runner-up classifications, for the human to override
  questions:                   # the factory's clarifying questions, when it isn't sure
    - text: string             # the question asked of the human
      about: enum              # what it's trying to disambiguate: kind | target | todo-list | priority | due
      askedAt: iso-datetime
      answer: string|null      # the human's reply, when given
  impact:                      # set when the thought touches existing ideas
    ideaId: uuid               # which idea is affected
    summary: string            # one line: what this thought means for that idea
    suggestedAction: enum      # none | refine | research | critique | plan | implement | re-think
    acted: bool                # whether the factory already did something
  todo:                        # set when kind == todo
    title: string
    list: enum                 # ideas | shopping | household | appointments | errands | work | custom
    due: iso-datetime|null
    context: string|null       # "while doing X" or "for project Y"
    linkedIdeaId: uuid|null    # for todos that arise from an idea
  parentIdeaId: uuid|null      # if this thought was captured *inside* an idea's context
```

### Classification kinds

The classifier assigns one of the following to every thought. These are
deliberately few and mutually exclusive — if a thought is ambiguous, the
classifier surfaces the ambiguity rather than guessing.

| Kind              | Meaning                                                                 | Default action                                    |
| ----------------- | ----------------------------------------------------------------------- | ------------------------------------------------- |
| `new-idea`        | A genuinely new concept, not covered by any existing idea               | Create a draft idea, route to capture approval     |
| `refinement`      | Improves an existing idea without changing its direction                | Attach to `targetIdeaId`, route to refine          |
| `minor-rethink`   | Changes one assumption or component of an existing idea                 | Attach to `targetIdeaId`, flag for human review    |
| `major-rethink`   | Reorients an idea enough to warrant a new branch or replacement         | Propose `superseded` / new child idea              |
| `duplicate`       | Already captured elsewhere (same idea, different words)                 | Propose merge with `targetIdeaId`                  |
| `todo`            | An action item, not an idea                                             | Route to the todo system (see below)               |
| `note`            | Reference material, observation, or context — neither idea nor action   | Attach to nearest idea, or store as a note         |
| `noise`           | Unclassifiable, ephemeral, or empty                                      | Park in a review queue rather than discard          |

The key distinction between `refinement`, `minor-rethink`, and
`major-rethink` is *scope of change*:

- **Refinement** sharpens the *expression* of an idea — better wording, a
  clarifying example, a new tag. The idea stays the same idea.
- **Minor re-think** changes a *part* — one assumption, one component, one
  design choice — while the idea's intent survives.
- **Major re-think** changes the *intent itself*. This should spawn a child
  idea (a fork) or mark the original `superseded`, preserving lineage rather
  than silently rewriting history.

This mirrors the lineage edge types already in the system: refinements are
`refined` edges, major re-thinks are `superseded`/`spawned` edges.

### The Todo system

`todo` is the catch-all for *anything that needs doing* — whether it grew out
of an idea or out of ordinary life. Todos live alongside ideas but are a
separate first-class type, because they have different semantics: an idea is
*explored*, a todo is *done*.

```yaml
Todo:
  id: uuid
  title: string
  list: enum                 # ideas | shopping | household | appointments | errands | work | custom
  status: enum               # open | in-progress | done | cancelled | deferred
  due: iso-datetime|null
  priority: enum             # now | next | later | someday
  context: string|null       # freeform: where/why this matters
  linkedIdeaId: uuid|null    # the idea this todo belongs to, if any
  sourceThoughtId: uuid|null # which thought produced this todo
  createdAt: iso-datetime
  completedAt: iso-datetime|null
  recurrence: string|null    # "daily", "every monday", "monthly" — cron-like
```

**Lists** are just a grouping dimension, not a wall between domains. A single
inbox can hold "buy milk", "call the dentist", and "write the caching layer's
write-through test" together — the `list` field lets the dashboard split them
into a shopping list, a calendar, and an idea kanban, but they all arrive the
same way: as thoughts, classified as todos.

**Idea-todos vs. life-todos.** When a todo has a `linkedIdeaId`, it's part of
an idea's implementation plan and should appear on that idea's page. When it
doesn't, it's a life/ambient todo and appears only in the todo dashboard. The
classifier sets this link when a thought like "I should really test the
caching layer before launch" arrives while an idea about the caching layer is
already in progress.

**Recurrence.** Appointments and chores repeat. `recurrence` keeps them as a
single todo that re-opens on schedule rather than forcing re-capture every
time — "water the plants" is captured once, marked done, and reappears
tomorrow.

### Classification workflow

Classification is a workflow job that runs on every new thought, and
re-runs when the idea store changes (a new idea may turn yesterday's
"unclassified" thought into today's "duplicate").

```
Job: classify
  [D] ingest-thought       — accept raw text/speech/wiki into the inbox
  [A] classify-thought     — LLM assigns a kind + confidence + target
  [A] match-existing       — semantic search over ideas AND todos for overlap
  [A] think-about-it       — if confidence is low, reason over the idea graph
                             and draft clarifying questions
  [H] ask-questions        — surface questions to the human, collect answers
  [A] re-classify          — re-run classification using the answers
  [A] assess-impact        — what does this thought mean for existing ideas?
  [D] apply-classification — route the thought to idea, todo, or review queue
  [H] review-ambiguous     — human confirms low-confidence or multi-match cases
```

The loop is not strictly linear. `think-about-it` → `ask-questions` →
`re-classify` is a small *dialogue* cycle that can iterate until the human
answers enough questions that the classifier's confidence crosses a threshold,
or until the human says "just file it as X". Classification is a conversation
when it needs to be, and a single pass when it doesn't.

**Matching** is the crux. `classify-thought` decides the *kind*;
`match-existing` decides the *target*. Together they answer the two questions
every thought needs answered:

1. *Is this new, or does it belong to something that already exists?*
2. *If it belongs somewhere, is it a small change or a big one?*

When a thought matches nothing (or only with low confidence), it seeds a new
idea. When it matches strongly and is just re-saying the same thing, it's a
duplicate. When it matches strongly and *adds* something, it's a refinement or
re-think depending on how much it adds.

### Impact assessment

After classification, the factory asks a second question: *so what?* A thought
that refines an idea isn't neutral — it may invalidate that idea's current
plan, open a new research thread, or bump an idea's priority. The
`assess-impact` step produces, for each idea a thought touches, a one-line
summary and a *suggested action* (refine, research, critique, plan, implement,
re-think, or none).

The human is then prompted — not with a form, but with a question like "this
changes the caching-layer idea's write-through assumption; want me to re-run
its critique?" The factory *proposes* the action and *waits*; it does not act
on an idea until told to. This keeps the factory's enthusiasm in check: a
stray thought should rarely trigger heavy agentic work on its own, but it
should *surface* the option.

### Ambiguity and the human

The classifier never throws anything away. Low-confidence thoughts, thoughts
that straddle two kinds, and `noise` all go to a review queue the human can
skim quickly — because the cheapest wrong decision in a factory like this is
*premature dismissal*, and the second-cheapest is *misclassification that
silently rewrites an idea*. Every classification is a suggestion, reversible
and recorded; the human is the final router, and the classifier learns from
corrections by logging `kind` overrides as training signal for the next cycle.

Where ambiguity *can* be resolved cheaply, the factory prefers a question over
a queue. A thought that is "probably a refinement of the caching idea, or
maybe a new idea" prompts a single clarifying question rather than languishing
in review. The queue is the fallback for thoughts that are genuinely
unclassifiable or that the human chooses to park; the question is the fast
path for thoughts that are merely *under-specified*. The two together keep
the human's attention where it pays off: disambiguating, not filing.

## Research: Prior Art & Influences

### Idea management systems
- **Zettelkasten** (Luhmann) — atomic notes, dense linking, emergent structure.
  Key insight: the value is in the links, not the notes. Each idea card is small
  enough to be composable.
- **Roam Research / Logseq** — bidirectional links, block references, daily
  notes as an ingestion funnel. Key insight: capture friction must be near-zero.
- **Notion / Confluence** — structured databases + freeform pages. Key insight:
  structured metadata (status, lineage, tags) enables filtering and dashboards.
- **Foam / Obsidian** — local-first markdown graphs. Key insight: plain-text
  durability; the graph is a view, not the source of truth.

### Feedback loops
- **OODA loop** (Boyd) — Observe, Orient, Decide, Act. The factory loop is an
  OODA loop where "Act" produces artifacts and "Observe" ingests usage data.
- **PDCA / Deming cycle** — Plan, Do, Check, Act. The factory's critique and
  post-mortem steps are the "Check" phase.
- **Build-Measure-Learn** (Lean Startup) — the factory's implement→use→record
  cycle is build-measure-learn applied to ideas themselves.

### Agentic critique systems
- **Debate / adversarial collaboration** — two agents argue opposite sides of a
  proposal, surfacing blind spots. The factory's critique step should use this.
- **Red-teaming** — dedicated agent finds failure modes. The factory's
  "poke holes" step is red-teaming.
- **Constitutional AI** — critique against a set of principles. The factory
  should maintain a living constitution of design principles.

### Lineage & provenance
- **Git** — DAG of commits, each with parent(s), author, timestamp, message.
  Ideas should have the same: an idea is a node in a DAG, with `parentIdeas`,
  `childIdeas`, `relatedIdeas`, and `influencedBy` (external references).
- **Nix / Guix** — content-addressed derivations. Every artifact knows exactly
  what produced it. The factory should content-address research outputs.
- **Blockchain / verifiable claims** — not the consensus part, but the idea
  that every claim has a cryptographically verifiable provenance chain.

### Wiki + speech interfaces
- **Federated wiki** (Ward Cunningham) — the smallest federated wiki. Each page
  is a JSON object you can fork. Key insight: ideas should be portable,
  forkable, mergeable.
- **Voice notes → structured data** — Whisper + LLM extraction. Speech is the
  lowest-friction capture; the factory transcribes and extracts structured
  idea cards.
- **Incremental reading** (SuperMemo) — interleaved reading and flashcard
  creation. Key insight: research is not a batch step; it's interleaved with
  capture and refinement.

## Architecture

### Swamp primitives used

| Primitive  | Role                                                    |
| ---------- | ------------------------------------------------------- |
| **Model**  | Thought inbox (capture, classification, routing)         |
| **Model**  | Todo store (lists, recurrence, completion)               |
| **Model**  | Idea store (CRUD, lineage, clustering, search)          |
| **Model**  | Research agent (web search, paper lookup, summarization) |
| **Model**  | Critique agent (adversarial review, red-teaming)         |
| **Model**  | Implementation scaffold (code gen, project init)         |
| **Model**  | Post-mortem recorder (structured failure/success logs)   |
| **Model**  | Speech-to-idea (Whisper transcription → structured card) |
| **Workflow** | The factory loop — deterministic steps + agentic steps |
| **Report** | Post-mortem summaries, lineage graphs, research digests  |
| **Vault**  | API keys for LLM, search, speech-to-text                 |

### Data model: The Idea

```yaml
Idea:
  id: uuid                    # immutable
  title: string               # one-line summary
  body: markdown              # full description
  status: enum                # captured | researching | critiqued | planned | implementing | implemented | abandoned | superseded
                              # a position in a loop, not a one-way lifecycle — any stage can revert to an earlier one
  parentIdeas: [uuid]         # lineage — what ideas spawned this one
  childIdeas: [uuid]          # what ideas this one spawned
  relatedIdeas: [uuid]        # non-hierarchical links
  influencedBy:               # external references
    - url: string
      title: string
      excerpt: string
      relevance: string       # why this reference matters
  tags: [string]
  priority: enum              # now | next | later | someday
  effort: enum                # small | medium | large | epic
  hypothesis: string          # testable claim this idea makes
  successMetric: string       # how "implemented" is validated
  createdAt: iso-datetime
  updatedAt: iso-datetime
  researchNotes: markdown     # agentic research output
  critiqueNotes: markdown     # adversarial review output
  implementationArtifacts:    # links to what was built
    - type: enum              # repo | file | PR | deployment
      url: string
      description: string
  postMortem:                 # recorded after implementation
    outcome: enum             # success | partial | failure | abandoned
    whatWorked: [string]
    whatDidnt: [string]
    lessonsLearned: [string]
    wouldDoDifferently: [string]
```

### The Factory Loop (Workflow)

```
┌─────────────────────────────────────────────────────────┐
│                    IDEA FACTORY LOOP                     │
│                                                         │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐           │
│  │ CAPTURE  │───▶│ CLUSTER  │───▶│ RESEARCH │           │
│  │ (speech, │    │ (find    │    │ (agentic │           │
│  │  wiki,   │    │  similar │    │  web +   │           │
│  │  text)   │    │  ideas)  │    │  paper)  │           │
│  └──────────┘    └──────────┘    └──────────┘           │
│       ▲                                │                │
│       │                                ▼                │
│       │         ┌──────────┐    ┌──────────┐           │
│       │         │ CRITIQUE │◀───│ REFINE   │           │
│       │         │ (advers- │    │ (update  │           │
│       │         │  arial)  │    │  idea)   │           │
│       │         └──────────┘    └──────────┘           │
│       │              │               │                  │
│       │              ▼               ▼                  │
│       │         ┌──────────┐    ┌──────────┐           │
│       │         │   PLAN   │───▶│IMPLEMENT │           │
│       │         │ (break   │    │ (build   │           │
│       │         │  down)   │    │  parts)  │           │
│       │         └──────────┘    └──────────┘           │
│       │                               │                │
│       │                               ▼                │
│       │         ┌──────────┐    ┌──────────┐           │
│       └─────────│ RECORD   │◀───│  REVIEW  │           │
│   (new ideas    │(post-    │    │ (post-   │           │
│    from usage)  │ mortem)  │    │  impl)   │           │
│                 └──────────┘    └──────────┘           │
│                                                         │
│  ┌──────────────────────────────────────────────────┐   │
│  │              CONTINUOUS FEEDBACK                  │   │
│  │  Usage data → new ideas → capture → loop again    │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

### Workflow steps (deterministic + agentic)

Each step is a swamp workflow step. Steps marked `[A]` are agentic (LLM-driven).
Steps marked `[D]` are deterministic. Steps marked `[H]` require human input
(manual_approval).

```
Job: capture
  [D] ingest-speech       — transcribe voice note → draft idea card
  [D] ingest-wiki         — poll wiki for new/edited pages → draft idea card
  [D] ingest-text         — accept direct text input → draft idea card
  [A] extract-idea        — LLM extracts structured Idea from raw text
  [H] approve-idea        — human reviews and approves the extracted idea

Job: classify
  [D] ingest-thought      — accept raw text/speech/wiki into the inbox
  [A] classify-thought    — LLM assigns kind + confidence + target
  [A] match-existing      — semantic search over ideas AND todos for overlap
  [A] think-about-it      — reason over the idea graph, draft clarifying questions
  [H] ask-questions       — surface questions to the human, collect answers
  [A] re-classify         — re-run classification using the answers
  [A] assess-impact       — what does this thought mean for existing ideas?
  [D] apply-classification — route thought to idea, todo, or review queue
  [H] review-ambiguous    — human confirms low-confidence or multi-match cases

```
Note: `capture` and `classify` are deliberately separate paths. `capture` is
the explicit, idea-shaped path — when the human already knows "this is an
idea", they skip the inbox and feed straight into `extract-idea`. `classify`
is the general, conversational path — a random thought with no context enters
the inbox and is routed by the dialogue loop above. The distinction is about
the human's *intent at the moment of capture*: did they say "here's an idea"
or did they just say something and let the factory figure out what it is?
Both eventually converge on the same downstream jobs (cluster, research,
critique), but the front door is different.

Job: cluster
  [A] find-similar        — semantic search for overlapping ideas
  [A] suggest-merge       — propose merging duplicate/similar ideas
  [H] approve-merge       — human approves or rejects merge proposals
  [D] update-lineage      — update parentIdeas/childIdeas/relatedIdeas

Job: research
  [A] web-search          — search web for each idea cluster
  [A] paper-search        — search academic papers (arXiv, Semantic Scholar)
  [A] summarize-findings  — synthesize research into structured notes
  [A] extract-references  — extract influencedBy entries from research
  [D] update-research     — write researchNotes + influencedBy to idea

Job: critique
  [A] adversarial-review  — agent argues against the idea
  [A] red-team            — agent finds failure modes, edge cases
  [A] principle-check     — check idea against living design principles
  [A] synthesize-critique — merge all critique into structured notes
  [D] update-critique     — write critiqueNotes to idea

Job: refine
  [A] incorporate-feedback — LLM updates idea body based on research + critique
  [H] approve-refinement   — human reviews refined idea
  [D] update-idea          — write refined body, bump version

Job: plan
  [A] break-down          — LLM decomposes idea into implementable tasks
  [A] estimate-effort     — estimate effort for each task
  [A] identify-blockers   — find dependencies and blockers
  [D] create-plan         — write structured plan to idea

Job: implement
  [A] scaffold            — generate project scaffold, boilerplate
  [A] implement-task      — implement one task from the plan
  [D] run-tests           — run test suite
  [A] fix-failures        — LLM fixes test failures
  [D] record-artifact     — link implementation artifacts to idea

Job: review
  [A] review-implementation — agent reviews what was built vs. the plan
  [A] compare-to-idea      — does the implementation match the idea?
  [H] approve-implementation — human sign-off

Job: record
  [A] draft-postmortem    — LLM drafts post-mortem from implementation results
  [H] approve-postmortem  — human reviews and edits post-mortem
  [D] update-postmortem   — write postMortem to idea
  [D] extract-new-ideas   — scan post-mortem for new idea seeds → capture

Job: continue
  [A] surface-insights    — find patterns across post-mortems
  [A] suggest-next        — recommend which idea to work on next
  [D] update-priorities   — adjust idea priorities based on insights
```

### Wiki interface

The wiki is a static site generated from the idea store, served locally:

- **Idea pages** — one page per idea, showing full lineage graph, research
  notes, critique, implementation status, post-mortem.
- **Dashboard** — kanban-style board: Now / Next / Later / Someday.
- **Todo dashboard** — lists split by domain (shopping, household, errands,
  appointments/calendar, work, per-idea todos), with due dates and recurrence.
- **Inbox** — the review queue for unclassified/ambiguous thoughts, with
  one-click routing ("this is a new idea", "this refines X", "this is a todo").
  Also the home of the clarifying-question dialogue: a thought that needs
  disambiguation shows its open questions inline, with tappable answers.
- **Lineage graph** — interactive D3/vis.js graph showing idea ancestry.
- **Capture form** — a single textarea + file upload for voice notes, routing
  into the inbox (not straight to ideas — classification happens after).
- **Search** — full-text + semantic search across all ideas, thoughts, and todos.
- **Daily note** — today's capture funnel, interleaved with research snippets
  and the day's todos.

The wiki is generated by a swamp report extension (like the news HTML report),
reading from the idea store model's data resources.

### Speech interface

- **Voice note → thought → classification**: A swamp model wraps Whisper (local
  or API) for transcription; the resulting thought enters the inbox and is
  classified (idea, refinement, todo, etc.) rather than assumed to be an idea.
- **Voice query**: "What am I working on?" → reads current in-progress ideas
  and open todos.
- **Voice capture**: "Note to self: the caching layer should use write-through"
  → classified as a refinement against the current implementation idea; "Add
  eggs to the shopping list" → classified as a `todo` in the `shopping` list.
- **Voice dialogue**: The clarifying questions above are *spoken back* — the
  factory says "did you mean this refines the caching layer, or is it a new
  idea?" and the human answers out loud. The microphone is the primary surface
  for the whole classify loop, not just for capture; text is the fallback.

### Lineage tracking

Every idea is a node in a DAG:

```
        ┌──────────┐
        │ Idea A   │ (original concept)
        └────┬─────┘
             │ spawns
    ┌────────┼────────┐
    ▼        ▼        ▼
┌──────┐ ┌──────┐ ┌──────┐
│Idea B│ │Idea C│ │Idea D│  (refinements, sub-ideas)
└──┬───┘ └──────┘ └──┬───┘
   │                  │
   │ merges into      │ superseded by
   ▼                  ▼
┌──────┐          ┌──────┐
│Idea E│          │Idea F│  (synthesis, replacement)
└──────┘          └──────┘
```

Edges have types:
- `spawned` — one idea naturally led to another
- `refined` — same idea, improved
- `merged` — two ideas combined
- `superseded` — new idea replaces old
- `influenced` — external reference shaped the idea
- `implemented-as` — idea → implementation artifact

### Post-mortem system

Post-mortems are first-class data, not just a field on an idea:

```yaml
PostMortem:
  id: uuid
  ideaId: uuid
  outcome: success | partial | failure | abandoned
  timeline:            # what happened when
    - date: iso-datetime
      event: string
  whatWorked: [string]
  whatDidnt: [string]
  rootCauses: [string] # 5-whys analysis
  lessonsLearned: [string]
  wouldDoDifferently: [string]
  spawnedIdeas: [uuid] # new ideas that emerged from the failure/success
  relatedPostMortems: [uuid] # cross-reference similar outcomes
```

The post-mortem report extension aggregates across post-mortems to surface
patterns: "You've had 3 ideas fail because of premature optimization" or
"Your successful ideas all share this pattern."

## Immutability: Nothing Is Ever Removed

A foundational principle that shapes everything else: **thoughts and ideas are
never removed when they are processed.** Processing does not consume or destroy
its input — it *derives* from it. A thought is classified but remains. An idea
is planned but remains. A plan is implemented but remains. The "next level" is
a *new* artifact that points back at its inputs, never a replacement that
erases them.

### The fusion/synthesis ladder

The factory moves material *up* a ladder by fusing and synthesizing, not by
deleting:

```
thoughts ──fuse──► ideas ──synthesize──► plans ──implement──► artifacts
   │                  │                      │
   └── (each remains, └── (each remains,     └── (each remains,
        with edges to       with edges to         with edges to
        the ideas they      the plans they        the artifacts they
        became)             became)               produced)
```

- **thoughts → ideas**: several thoughts classified as refinements of the same
  idea are *fused* into that idea's body. The idea is the synthesis; the
  thoughts remain as its provenance (via `parentIdeaId` / lineage edges).
- **ideas → plans**: an idea is *synthesized* into a plan (a task breakdown).
  The plan is a new node; the idea remains as its parent.
- **plans → artifacts**: a plan is *implemented* into artifacts (code, PRs,
  deployments). The plan remains; the artifacts link back to it.

At every rung, the lower level is preserved. The upper level is a *derived
view* of the lower, and the derivation is recorded as an edge.

### Why this matters

The point is not archival purity for its own sake. It is that **the raw
material must still be there later, for reviews we cannot yet name.** Two
kinds of review are already anticipated:

1. **Post-mortem with historical considerations.** A post-mortem is only as
   good as the history it can inspect. If the intermediate thoughts and the
   superseded idea versions were deleted, a post-mortem could only see the
   *final* state — it could not reconstruct *why* the idea took the shape it
   did, which refinements were rejected, or what was tried and abandoned. The
   `timeline` and `rootCauses` fields in the post-mortem schema are only
   meaningful if the history they point at still exists.

2. **Not-yet-known concepts, steps, and workflows.** The factory is explicitly
   designed to be extended by future steps we haven't imagined. A future
   "synthesis review" (did the fusion of these five thoughts lose anything?),
   a "drift analysis" (how far has this idea wandered from its original
   thought?), or a "lineage audit" (which ideas trace back to which thoughts)
   all require the full history to be intact. Deleting processed inputs
   *forecloses* these futures; preserving them keeps every future review
   possible.

The principle is: **the factory may add, link, mark, and supersede — but it
never deletes.** "Abandoned" and "superseded" are *labels* on a node, not
removals. A superseded idea is still in the graph, still queryable, still
part of the lineage — it is just no longer the *current* idea.

### What this means for the data model

- **`status` is a label, not a lifecycle that removes.** `abandoned` and
  `superseded` mark a node as no-longer-current; they do not delete it. The
  "current" view (the dashboard, the kanban) is a *projection* that filters on
  status; the store itself keeps everything.
- **Lineage edges are the record of derivation.** The existing edge types
  (`spawned`, `refined`, `merged`, `superseded`, `influenced`,
  `implemented-as`) are exactly the fusion/synthesis record. Every derived
  node carries edges back to its inputs, so the derivation is reconstructable.
- **Versioning is the mechanism.** This aligns with swamp's data model, which
  is already append-only: every `writeResource` produces a *new version* of a
  resource, and prior versions remain queryable. The factory's "never remove"
  principle is not a new mechanism to build — it is a *discipline* to honor
  the versioning that already exists, and to resist the temptation to
  overwrite-in-place or delete when a thought is "done with."

### The one thing to be careful about

"Never remove" is a principle, not a storage guarantee. It is easy to
*accidentally* violate it by overwriting a resource in place (writing the
"current" idea body over the old one) instead of appending a new version. The
discipline is: **every transformation writes a new node or a new version, and
links back — it never mutates the old one in place.** The `refineIdea` method,
for example, must not rewrite the idea's `body` field; it must create a new
version (or a child idea) and record a `refined` edge. If a method ever
overwrites in place, the history is silently lost and the whole principle
collapses.

## Implementation Plan

### Phase 0: Bootstrap (this document → first model)

**Goal**: Get the idea store model working so we can capture ideas and track
lineage. This document itself becomes the first idea in the system.

1. **Create the thought-inbox model extension** (`@svendowideit/thought-inbox`)
   - CRUD methods: `create`, `update`, `get`, `list`, `search`, `delete`
   - Classification methods: `classify`, `matchExisting`, `applyClassification`
   - Dialogue methods: `thinkAboutIt`, `askQuestions`, `reclassify`
   - Impact methods: `assessImpact`
   - Data resources: `current` (all thoughts), `reviewQueue` (ambiguous/noise),
     `questions` (open clarifying questions), `impacts` (pending impact prompts)

2. **Create the todo-store model extension** (`@svendowideit/todo-store`)
   - CRUD methods: `create`, `update`, `get`, `list`, `search`, `delete`
   - List methods: `addToList`, `complete`, `reopen`, `recurrence` handling
   - Data resources: `current` (all todos), `byList` (grouped)

3. **Create the idea-store model extension** (`@svendowideit/idea-store`)
   - CRUD methods: `create`, `update`, `get`, `list`, `search`, `delete`
   - Lineage methods: `link`, `unlink`, `getLineage` (returns DAG)
   - Status transitions: `advance` (captured→researching→...→implemented)
   - Data resources: `current` (all ideas), `lineage` (graph edges)

4. **Create the classify workflow** (minimal)
   - `ingest-thought` → `classify-thought` [A] → `match-existing` [A] →
     `think-about-it` [A] → `ask-questions` [H] → `re-classify` [A] →
     `assess-impact` [A] → `apply-classification` → `review-ambiguous` [H]
   - Keep `capture` (explicit idea path) separate for now

5. **Create the wiki report extension** (`@svendowideit/idea-wiki`)
   - Generates static HTML from the thought inbox, todo store, and idea store
   - Idea pages with lineage graph
   - Dashboard with status columns + todo lists + inbox review queue
   - Capture form (routes into the inbox)

6. **Dogfood**: Import this document as the first thought, run the classify
   workflow, watch it become the first idea, view it in the wiki.

### Phase 1: Research & Critique

**Goal**: Add agentic research and adversarial critique to the loop.

1. **Create the research-agent model** (`@svendowideit/research-agent`)
   - Methods: `webSearch`, `paperSearch`, `summarizeFindings`
   - Uses LLM + web search APIs
   - Outputs structured research notes + references

2. **Create the critique-agent model** (`@svendowideit/critique-agent`)
   - Methods: `adversarialReview`, `redTeam`, `principleCheck`
   - Uses LLM with adversarial prompting
   - Outputs structured critique notes

3. **Extend the factory workflow** with research and critique jobs

### Phase 2: Implementation & Post-Mortem

**Goal**: Close the loop — implement ideas and record outcomes.

1. **Create the implementation-agent model** (`@svendowideit/impl-agent`)
   - Methods: `scaffold`, `implementTask`, `runTests`, `fixFailures`
   - Integrates with the local filesystem and swamp itself

2. **Create the post-mortem model** (`@svendowideit/postmortem-store`)
   - CRUD for structured post-mortems
   - Cross-reference and pattern detection

3. **Create the post-mortem report** — aggregates and surfaces patterns

4. **Extend the factory workflow** with implement, review, and record jobs

### Phase 3: Speech & Continuous Loop

**Goal**: Add speech capture and make the loop self-sustaining.

1. **Create the speech-ingest model** (`@svendowideit/speech-ingest`)
   - Whisper transcription → LLM extraction → idea card

2. **Add scheduled trigger** to the factory workflow (cron)
   - Runs periodically to process new captures, research, critique

3. **Add the "continue" job** — surface insights, suggest next actions

4. **Self-improvement**: Use the factory to improve the factory. Post-mortems
   on the factory's own performance feed back into factory improvements.

### Phase 4: Federation & Sharing

**Goal**: Make ideas portable and shareable.

1. **Federated wiki protocol** — export/import ideas as JSON objects
2. **Multi-repo sync** — share idea stores across repos
3. **Public idea garden** — publish selected ideas as a static site

## The Swamp Factory: Mapping the Loop to Primitives

This section is the concrete build plan — how the
thought → idea → plan → iterate → implement → review → continue loop becomes a
swamp factory. It supersedes the phase-by-phase sketch above with a
primitive-by-primitive mapping, grounded in the patterns already proven in this
repo (the `@svendowideit/news` stack: one model type with many methods, chained
by a workflow with guards, `allowFailure`, and a `trigger.schedule`).

### The core insight: one model type, many methods

The news stack is the template. It is a *single* model type
(`@svendowideit/news-reader`) exposing many methods (`fetch`, `dedupeArticles`,
`filterByAge`, `generate`, `gatherFeedback`), each writing a named data
resource. A workflow chains those methods with CEL guards and `allowFailure`.
The idea factory should follow the same shape rather than the "one model per
agent" sketch in the primitives table above — that table was aspirational; this
is the buildable version.

```
@svendowideit/idea-factory        (one model type)
  methods:
    ingestThought        → resource "inbox"        (raw thoughts)
    classifyThought      → resource "classification" (kind + confidence + target)
    matchExisting        → resource "matches"       (semantic overlap)
    thinkAboutIt         → resource "questions"     (clarifying questions)
    assessImpact         → resource "impacts"       (what this means for ideas)
    applyClassification  → resource "routing"       (thought → idea/todo/queue)
    createIdea           → resource "ideas"         (the idea store)
    linkLineage          → resource "lineage"       (DAG edges)
    researchIdea         → resource "research"      (web/paper notes)
    critiqueIdea         → resource "critique"      (adversarial review)
    refineIdea           → resource "refinements"   (updated body)
    planIdea             → resource "plans"         (task breakdown + acceptance criteria)
    implementTask        → resource "artifacts"     (code/PR links)
    verifyImplementation → resource "verification"  (per-criterion pass/fail)
    linkTraceability     → resource "traceability"  (idea→task→test→artifact)
    flagPlanStale        → resource "plans"         (mark plan stale on idea change)
    assessRisk           → resource "risks"         (persisted risk register)
    ageBacklog           → resource "hygiene"       (stale items surfaced)
    reviewImplementation → resource "reviews"       (plan vs. built)
    recordPostMortem     → resource "postmortems"   (outcomes)
    surfaceInsights      → resource "insights"      (cross-idea patterns)
    createTodo           → resource "todos"         (the todo store)
```

Every method writes a named resource; every resource is versioned and queryable
via `data.latest()`. The idea store, todo store, and inbox are not three
separate models — they are three *resources* on one model, which is what makes
the CEL wiring between them trivial (no cross-model data chaining needed).

### The workflow: one DAG, not many jobs

The phase plan above split the loop into many jobs (`capture`, `classify`,
`cluster`, `research`, `critique`, `refine`, `plan`, `implement`, `review`,
`record`, `continue`). In swamp those are *steps in one workflow*, not separate
workflows. The loop is a single DAG:

```
ingestThought
   │
   ▼
classifyThought ──► matchExisting ──► thinkAboutIt ──► [askQuestions: manual_approval]
   │                                                       │
   │◄────────────────────── re-classify ◄──────────────────┘
   ▼
assessImpact ──► applyClassification
   │                  │
   │        ┌─────────┼──────────────┐
   │        ▼         ▼              ▼
   │   createIdea  createTodo   [review-ambiguous: manual_approval]
   │        │         │
   │        ▼         ▼
   │   linkLineage  (done)
   │        │
   │        ▼
   │   researchIdea ──► critiqueIdea ──► refineIdea ──► planIdea
   │                                                       │
   │                                                       ▼
   │                                                 implementTask
   │                                                       │
   │                                                       ▼
   │                                              verifyImplementation
   │                                                       │
   │                                                       ▼
   │                                              reviewImplementation
   │                                                       │
   │                                                       ▼
   │                                              recordPostMortem
   │                                                       │
   └───────────────────────────────────────────────────────┘
                                                          ▼
                                                  surfaceInsights
```

The DAG above shows only the *forward* edges. The loop also has **backward
edges**: any step can be re-entered from a later one when new input arrives
(see "The loop is a loop" in the practical plan). A refinement mid-implementation
reverts the idea to `planned`; the guards below then re-fire only the steps the
revert invalidates. The DAG is a state machine, not a one-way pipeline.

**Guards make it idempotent and incremental.** Each step carries a CEL guard so
re-running the workflow (or the cron trigger firing) only processes *new*
thoughts and *changed* ideas:

- `ingestThought` — guard: no unprocessed thoughts in the inbox.
- `classifyThought` — guard: `data.latest("idea-factory", "classification")`
  already covers the newest inbox entry.
- `researchIdea` — guard: idea's `contentHash` unchanged since last research.
- `implementTask` — guard: task already has an artifact recorded.

This is the same guard pattern the news workflow uses to skip `fetch` when the
feed snapshot is fresh. The factory loop becomes a *continuous* loop: the cron
trigger fires, guards skip everything already done, and only the delta is
processed.

**`allowFailure` keeps the loop alive.** LLM steps (`classifyThought`,
`researchIdea`, `critiqueIdea`) are marked `allowFailure: true` so a flaky
local Ollama doesn't kill the whole run — the same degradation the news
workflow uses. Deterministic steps (`applyClassification`, `linkLineage`,
`createTodo`) fail hard, because a half-routed thought is worse than a skipped
one.

**`manual_approval` is the human gate.** Two steps suspend the workflow and
wait for the human:

- `askQuestions` — the clarifying-question dialogue. The workflow suspends,
  the human answers (via `swamp workflow approve` or the wiki), and the run
  resumes into `re-classify`.
- `review-ambiguous` — the fallback queue for thoughts the classifier can't
  place. The human routes them by hand.

This is the swamp-native answer to "the factory asks questions and prompts me
about impact": the workflow *suspends* at a `manual_approval` step, and the
human's answer is the resume input. No separate chat server needed for the
first iteration — the CLI `approve`/`resume` flow is enough, and the wiki can
wrap it later.

### The trigger: the loop is a cron

The whole factory is one workflow with a `trigger.schedule`. It fires
periodically (say every 15 minutes), ingests any new thoughts, classifies them,
and — where guards allow — advances ideas through research/critique/plan/
implement. The human's role is to answer the `manual_approval` steps that
suspend the run; everything else is automatic.

```
trigger:
  schedule: "*/15 * * * *"
```

The "continue-to-refine" tail of the loop is just the same workflow re-firing:
`surfaceInsights` runs at the end of every cycle, and its output feeds the
*next* cycle's `classifyThought` (a new insight is itself a thought that enters
the inbox). The loop closes without a separate "continue" job — the workflow
*is* the loop.

### The report: the wiki is a report extension

The wiki is a `report` extension (like `@svendowideit/news-html-report`), not a
separate service. It reads the model's resources — `ideas`, `lineage`,
`todos`, `inbox`, `questions`, `impacts` — and renders static HTML: idea pages,
the kanban dashboard, the todo lists, and the inbox review queue. It runs
automatically after the workflow, so the wiki is always a fresh projection of
the store.

### The vault: LLM + speech keys

One vault holds the LLM base URL/model/API key and (later) the speech-to-text
key. The model's `globalArguments` reference them via `vault.get()`, exactly as
`local-news` references its Ollama config today.

### What this changes about the earlier plan

- **One model, not many.** The primitives table's "thought inbox / todo store /
  idea store / research agent / critique agent / impl agent" collapse into one
  `@svendowideit/idea-factory` model type with many methods. Separate models
  only make sense if a method needs a different lock or lifecycle — none of
  these do.
- **One workflow, not many jobs.** The `capture`/`classify`/`cluster`/… jobs
  become steps in a single DAG. The `capture` vs `classify` distinction from
  earlier survives as two *entry points* into the same DAG (an explicit
  `createIdea` step vs. the full `classifyThought` path), not two workflows.
- **The loop is a cron, not a manual sequence.** The "continue" job is the
  trigger re-firing; `surfaceInsights` is the last step, not a separate
  workflow.
- **The human gate is `manual_approval`, not a chat server.** The
  clarifying-question dialogue and the impact prompt are both `manual_approval`
  steps that suspend the run. The wiki wraps them later; the CLI works first.

### Tradeoffs, made explicit

The design above makes several choices that each have a real cost. These are
the consequences to understand before committing — none are fatal, but each
shapes what the factory can and can't do later.

#### 1. One model type vs. many models

**The choice:** collapse the inbox, todo store, idea store, and all the
"agents" (research, critique, impl) into a single `@svendowideit/idea-factory`
model type with many methods.

**Why it's attractive:** swamp serializes method runs against a model's lock.
If research and critique were separate models, they could run *concurrently*;
as methods on one model, they queue behind each other. For a single-user
factory this is fine — and it's actually a *feature*, because it means the
idea store can't be mutated by two methods at once. It also makes CEL wiring
trivial: everything is `data.latest("idea-factory", "<resource>")`, no
cross-model data chaining.

**The cost you're accepting:**

- **No independent cadence.** You can't run research every hour while critique
  runs daily — they're steps in one workflow, so they run together (or not at
  all). If you later want research to be a slow background job and critique to
  be a fast gate, you'll need to split them into separate models.
- **One lock = one bottleneck.** A long-running `researchIdea` (web search +
  LLM summarization can take minutes) blocks `ingestThought` from running
  against the same model. New thoughts wait behind research. For a personal
  factory this is acceptable; for a shared one it's a queue.
- **One failure domain.** A bug in any method is a bug in the one model. You
  can't redeploy "just the critique agent" — you redeploy the whole factory.

**The signal to split later:** when you want two methods to run at different
cadences, or when one method's runtime starts blocking others, promote that
method to its own model type. The resource names stay the same, so the
workflow's CEL expressions barely change — the split is cheap *if* you keep the
resource names stable now.

#### 2. One workflow vs. many workflows

**The choice:** the whole loop is a single DAG, not a set of independently
runnable workflows.

**Why it's attractive:** one trigger, one place to see the whole loop, guards
make re-runs cheap. The "continue" tail is just the trigger re-firing.

**The cost you're accepting:**

- **All-or-nothing scheduling.** You can't run "just the classify job" without
  running the whole DAG (guards will skip the rest, but the workflow still
  *evaluates* every step). If you want to manually poke "re-research this one
  idea" without touching anything else, you either run the whole workflow and
  rely on guards, or you call the model method directly (`swamp model method
  run idea-factory researchIdea`) — which bypasses the workflow's guard logic.
- **A suspended run blocks the loop.** When the workflow suspends at
  `askQuestions` or `review-ambiguous`, the *entire* run is parked until you
  answer. New thoughts that arrive while it's suspended wait for the next
  trigger fire. If you leave a question unanswered for a day, the factory
  stalls for a day. (Mitigation: the cron's overlap-prevention means a
  suspended run doesn't block the *next* scheduled fire — but that next fire
  is a fresh run that will re-encounter the same unanswered question.)
- **Debugging is coarser.** A failure anywhere in the DAG is a failure of "the
  factory", and you have to read the step logs to find which method broke.

**The signal to split later:** when you want to run classify on a fast cadence
and research on a slow one, or when a suspended approval is blocking unrelated
work. Split into `classify` and `advance` workflows (or similar), each with its
own trigger.

#### 3. The loop is a cron, not an event-driven pipeline

**The choice:** a `trigger.schedule` fires the workflow every N minutes; guards
make it incremental.

**Why it's attractive:** dead simple, no event bus, no webhooks, no queue. The
news stack already proves it works.

**The cost you're accepting:**

- **Latency is bounded by the cron interval.** A thought you speak now isn't
  classified until the next fire (up to 15 minutes later). For a personal
  idea factory this is fine; for a "speak and it responds" UX it's a visible
  delay. The `manual_approval` dialogue is *not* real-time — it's
  "the workflow fired, asked a question, and is now waiting for you to notice."
- **No push.** The factory can't proactively interrupt you ("your thought
  changes the caching idea — want me to re-critique it?"). It can only *leave
  a question parked* and wait for you to check the wiki or run
  `swamp workflow approvals`. The "prompts me about impact" UX from the vision
  is, in this design, a *pull* (you check), not a *push* (it tells you).
- **Missed fires are lost.** If the machine is off at the scheduled time, the
  fire is skipped (no catch-up). For a personal factory that's fine; for
  anything time-sensitive it's a gap.

**The signal to change later:** when you want real-time capture or push
notifications, add a webhook trigger (swamp supports `trigger` webhooks) or a
small always-on service that calls `swamp workflow run` on demand. The
workflow itself doesn't change — only how it's *invoked*.

#### 4. `manual_approval` as the human gate vs. a chat/voice interface

**The choice:** the clarifying-question dialogue and the impact prompt are
`manual_approval` steps that suspend the run; the human answers via CLI or the
wiki.

**Why it's attractive:** it's the swamp-native primitive, zero extra
infrastructure, and it's auditable (the run record captures the answer).

**The cost you're accepting:**

- **It's not conversational.** The vision described a back-and-forth ("did you
  mean this refines X, or is it new?"). A `manual_approval` step is a single
  suspend-and-answer, not a multi-turn dialogue. To get the multi-turn
  `think → ask → re-classify` loop, each turn is a *separate* workflow run
  (or a `resume` with new inputs), which is clunky compared to a chat.
- **Voice is a stretch.** `manual_approval` is answered by typing a value or
  approving a prompt. The "speak the answer out loud" UX from the vision needs
  a speech-to-text front end that isn't part of this design yet — it would
  wrap the approval step, not replace it.
- **The human is the bottleneck.** Every ambiguous thought parks the run until
  you answer. If you capture 20 thoughts in a day and 15 are ambiguous, you
  have 15 parked runs to triage. The review queue is the pressure valve, but
  it's still *your* time.

**The signal to change later:** when the CLI/wikis approval flow feels too
clunky, build a thin chat or voice service that *drives* the same workflow
(answering `manual_approval` steps programmatically). The workflow and model
don't change — the front end does.

#### 5. The wiki is a report, not a live app

**The choice:** the wiki is a `report` extension that renders static HTML after
each run.

**Why it's attractive:** same as the news HTML report — no server, no state,
always a fresh projection.

**The cost you're accepting:**

- **Read-only.** You can't edit an idea or answer a question *in* the wiki and
  have it write back — the wiki is a snapshot. Answering a `manual_approval`
  step still happens via CLI (or a future write-back service). The "one-click
  routing" in the inbox is a *future* feature that needs a write path, not
  something the report gives you for free.
- **Regenerated, not updated.** Every run rewrites the whole HTML. Fine for
  hundreds of ideas; a problem at thousands (render time grows). The news
  stack lives with this; so can the factory, for now.

**The signal to change later:** when you want in-wiki editing or answering,
add a small write-back service (like the news stack's `feedback-server.ts`)
that accepts POSTs and calls the model methods.

#### 6. LLM steps are advisory (`allowFailure`), not authoritative

**The choice:** `classifyThought`, `researchIdea`, `critiqueIdea`, etc. are
`allowFailure: true`, so a flaky local Ollama degrades gracefully.

**Why it's attractive:** the loop never dies because the LLM is down; the
deterministic steps still run.

**The cost you're accepting:**

- **Silent gaps.** If `classifyThought` fails, the thought sits unclassified
  until the next fire — and if the LLM stays down, it sits forever, with no
  loud signal that classification is broken. You need to *notice* the
  `allowedFailure` in the run output, or the factory quietly stops classifying.
- **Half-processed ideas.** If `researchIdea` fails but `critiqueIdea`
  succeeds, the critique runs against *stale or missing* research. The guards
  need to encode "critique only runs if research succeeded" (via `dependsOn:
  succeeded`), or you get critique of nothing.

**The signal to change later:** add a `surfaceInsights`-style health check
that counts recent `allowedFailure`s and surfaces "classification has been
failing for 3 days" as its own insight — turning silent degradation into a
visible signal.

### The one tradeoff that matters most

If you remember one thing from this section: **the design optimizes for a
single-user, personal, low-volume factory, and it pays for that with
serialization, pull-not-push, and a non-conversational human gate.** Every
"signal to change later" above is the same underlying move — *split the model,
split the workflow, or add a front-end service* — and each is cheap to do
later *if* the resource names and the DAG shape stay stable now. The risk is
not the tradeoffs themselves; it's committing to a shape that makes the later
split expensive. The shape above is chosen to keep the later split cheap.

### 7. External storage and per-item parallelism (a consideration, not a change)

A refinement worth holding in mind: the serialization in tradeoff #1 comes
from *two* things — the per-model lock, and the fact that all data lives in
one model's resources. If the data instead lived in an external system (a
database, or Obsidian-style files), each thought/idea/plan would be an
individual item with its own identity, and could carry its own lock. Then
items could be processed in parallel, each advancing independently, rather
than queuing behind a single model lock.

**The nuance that matters:** moving the data external does *not* by itself
remove swamp's per-model lock. A swamp model still serializes its own method
runs even when its data is stored in a Postgres datastore. What external
storage *enables* is the *split* — you can now run many model instances (or
many models), each with its own lock, all pointing at the same external store,
because the store's item-level locking (a database row lock, a file lock)
prevents two writers from corrupting the same item. The parallelism comes from
splitting the model; the external store is what makes the split *safe*.

This is the same move as tradeoff #1's "signal to split later", but with a
different trigger: instead of splitting when a method's runtime blocks others,
you split when you want *per-item* concurrency — many ideas being researched,
critiqued, and planned at once, each on its own timeline.

**Why it's attractive:**

- **True parallelism.** A long `researchIdea` on idea A no longer blocks
  `ingestThought` or `critiqueIdea` on idea B. Each item is its own unit of
  work with its own lock.
- **Finer-grained locking.** Item-level locks mean two methods can touch
  *different* ideas simultaneously, and only contend when they touch the
  *same* idea. This is the natural granularity for a factory — ideas are
  mostly independent.
- **Adhoc, not batch.** With per-item identity you can trigger processing on a
  single item ("re-research *this* idea now") without running the whole DAG.
  The cron loop becomes optional; items advance on demand.

**The cost you're accepting:**

- **You lose the "one lock = no concurrent mutation" safety net.** With one
  model, two methods can never corrupt the idea store because they can't run
  at once. With per-item locks, you must now reason about *concurrent writes
  to the same item* — what happens if `refineIdea` and `critiqueIdea` both
  touch idea A at the same time? The external store's locking prevents
  corruption, but it doesn't prevent *logical* races (critique running against
  a body that refine just rewrote). You inherit distributed-systems thinking
  you didn't need before.
- **CEL wiring gets harder.** `data.latest("idea-factory", "ideas")` assumes
  all ideas are in one resource on one model. If ideas are spread across many
  instances (or live in an external store), guards and expressions must query
  the external store directly, and `data.latest()` no longer gives you the
  whole picture in one call.
- **The datastore is the heaviest lift.** This is Option E from the next
  section — building a `DatastoreProvider` that implements locking, versioning,
  and the data-resource lifecycle on top of the external system. It's the most
  expensive piece of the whole design, and it becomes critical infrastructure.
- **Guards become stale or external.** A guard that checks "has this idea been
  researched?" now has to hit the external store (or a cached projection),
  because the answer isn't in a swamp resource anymore.

**The signal to move here:** when you actually feel the serialization — a
research call blocking capture, or wanting to advance several ideas in
parallel — *and* you have a long-lived external system you won't abandon (an
Obsidian vault, a database). It's the endgame, not the starting point.

### Migration path: serialized → fully adhoc

The current plan (one model, one workflow, cron, swamp-owned data) is the
*serialized* starting point. The fully-adhoc endgame (external store, per-item
locks, event-driven, parallel) is reached in stages, and each stage is cheap
*only if* the resource names and the DAG shape stay stable. Here is the path:

**Stage 0 — Serialized (the current plan).** One `@svendowideit/idea-factory`
model, one workflow, cron trigger, all data in swamp resources. Everything
queues behind one lock. This is where you start, because it's the cheapest
thing that closes the loop and it stabilizes the schema.

**Stage 1 — External datastore, still one model (Option E).** Move the data
out of swamp's built-in datastore into files or a database via a custom
`DatastoreProvider`. The model's methods are unchanged — they still call
`context.writeResource` / `context.readResource`; only the backend swaps. You
gain plain-text durability and editor access, but *not* parallelism — the
model lock is still there. This stage is about durability and portability, not
concurrency.

**Stage 2 — Split the model into per-item instances.** Now that the data is
external and item-level locking exists, split the single model into many
instances — one per idea (or per idea-cluster), each with its own lock. The
workflow's `forEach` (or a fan-out method) dispatches one instance per item.
This is where parallelism actually arrives: idea A's research and idea B's
critique run concurrently, contending only when they touch the same item. The
resource names stay the same; what changes is that "ideas" is no longer one
resource on one model, but a resource on *many* models, all backed by the same
external store.

**Stage 3 — Fully adhoc, event-driven.** Drop the cron. Each thought triggers
its own processing pipeline on demand — a webhook, or a small always-on
service that calls `swamp workflow run` (or the model method directly) per
item. Items advance independently, in parallel, each with its own lock. The
"loop" is no longer a scheduled batch; it's a per-item state machine that
advances whenever something changes.

**What makes the migration cheap:** the *concepts* — `inbox`, `ideas`,
`lineage`, `todos`, `classification`, `questions`, `impacts` — are stable
across all four stages. What changes is *where they're stored* (swamp resource
→ external file/row) and *how they're locked* (model lock → item lock). If the
resource names and the DAG shape are chosen now to be storage-agnostic, each
stage is a storage/locking change, not a schema change. The risk is the
opposite: if Stage 0 bakes swamp-specific assumptions into the schema (e.g. a
guard that only works against `data.latest()` on one model), the migration
becomes a rewrite.

**The honest caveat:** Stage 2 and Stage 3 are speculative. You may never feel
the serialization — a single-user factory with a few hundred ideas and a
15-minute cron may never queue long enough to matter. The value of writing
this down is not to commit to it, but to make sure Stage 0 doesn't *foreclose*
it. The cheapest insurance is: keep the resource names stable, and don't write
guards that assume all data is in one swamp resource.

### Build order (revised)

> **Superseded by** [The Practical System](#the-practical-system-authoritative-plan).
> This earlier ordering is kept for rationale; the practical plan above is what
> gets built.

1. **`@svendowideit/idea-factory` model** — start with `ingestThought`,
   `classifyThought`, `matchExisting`, `applyClassification`, `createIdea`,
   `createTodo`, `linkLineage`. These close the capture→classify→route loop
   with no LLM (classification can start as keyword/tag matching, LLM added
   later).
2. **`idea-factory` workflow** — the DAG above, with guards and
   `manual_approval` steps. Run it manually first, then add the cron trigger.
3. **`@svendowideit/idea-wiki` report** — render the store to HTML.
4. **Add the LLM methods** — `thinkAboutIt`, `assessImpact`, `researchIdea`,
   `critiqueIdea`, `refineIdea`, `planIdea`, `implementTask`,
   `reviewImplementation`, `recordPostMortem`, `surfaceInsights` — each behind
   `allowFailure: true`, each with a guard.
5. **Add the verification & traceability methods** — `verifyImplementation`,
   `linkTraceability`, `flagPlanStale`, `assessRisk`, `ageBacklog` — and wire
   `verifyImplementation` into the DAG between `implementTask` and
   `reviewImplementation`, guarded with `dependsOn: succeeded`.
6. **Add the eval & health reports** — `@svendowideit/idea-factory-eval`
   (classification accuracy over a golden corpus) and
   `@svendowideit/idea-factory-health` (degradation + aging). Both are
   read-only; they cost nothing at runtime and pay off when you need to improve
   or debug the factory.
7. **Dogfood** — import this document as the first thought, run the workflow,
   watch it classify, route, and render.

## Verifiability, Testability & Sustainability

The loop above closes the thought→idea→plan→implement→record cycle, but it
does not yet make the *plan* objectively verifiable, nor the *factory* itself
measurable. `planIdea` produces a task breakdown; `reviewImplementation`
"compares what was built vs. the plan" — but nothing makes that comparison
objective, and nothing lets us tell whether the factory is getting better or
quietly degrading. This section adds the processes and systems that close those
gaps. They are deliberately additive: each is a new method/resource or report on
the same `@svendowideit/idea-factory` model, so the DAG shape and resource names
stay stable.

### 1. Verifiable: the plan is a first-class, testable artifact

A plan you can verify is not a list of tasks — it is a set of tasks each
carrying its own definition of done, with traceability back to the idea.

**Acceptance criteria + test strategy per task.** Every plan task carries:

```yaml
PlanTask:
  id: uuid
  ideaId: uuid
  title: string
  description: string
  acceptanceCriteria: [string]   # testable, observable statements
  testStrategy: enum             # unit | integration | property | golden | contract | manual
  dependencies: [uuid]
  effort: enum                   # small | medium | large
  status: enum                   # ready | in-progress | verified | unverified | blocked
```

`planIdea` refuses to mark a task `ready` without both `acceptanceCriteria` and
`testStrategy`. This forces the plan to be testable *by construction* rather than
hoping tests get written later. A task without criteria is marked `unverified`,
not blocked, so the loop keeps moving in early phases.

**Traceability matrix (idea → task → test → artifact).** A `traceability`
resource links each idea requirement to the tasks satisfying it and the tests
verifying it. `reviewImplementation` then becomes a *coverage check*, not a
vibe check: every acceptance criterion has a passing test, every test maps to a
criterion, nothing is orphaned. This is the verifiable backbone — the same idea
as the lineage DAG, but for the implementation path instead of the idea
ancestry.

**A verification gate between implement and review.** A `verifyImplementation`
step runs the plan's test strategy and records pass/fail *per acceptance
criterion* into a `verification` resource. `reviewImplementation` compares
against that record rather than "does it look right," and is guarded with
`dependsOn: succeeded` so review only runs on a passing verification. This also
fixes the tradeoff-#6 hazard of reviewing against stale or missing work.

**Plan drift detection.** When a thought refines or rethinks an idea *after* it
has been planned, the current design re-runs critique but never asks "is the
plan still valid?" A `flagPlanStale` step marks the plan `stale` on idea-body
change and requires re-planning before further implementation. Without this, a
mid-implementation refinement silently invalidates the plan while the loop keeps
implementing against it. Re-planning creates a *new* plan version linked to the
old (per the immutability principle), preserving the derivation. This is the
specific case of the general reversion rule — any stage can be re-entered from
any later stage (see "The loop is a loop" in the practical plan).

### 2. Testable: the factory itself is measurable

"Self-improvement" is aspirational until the factory can be measured. Two
additions make it regression-testable and improvable.

**Classification golden corpus + eval harness.** A labeled corpus of thoughts
with expected classifications, run through `classifyThought` by an
`@svendowideit/idea-factory-eval` report that emits accuracy and a confusion
matrix. This is what makes the classifier *regression-testable* — you can change
the prompt and know whether it got better. It also gives open question #8
("log overrides as training signal") a real target: overrides accumulate into
the corpus, and the eval measures whether the next prompt change helps.

**Factory test suite.** The deterministic steps (routing, lineage, guards,
`applyClassification`) get unit tests; the workflow gets integration tests
against a fixture store. The factory is a thing to *test*, not just a thing to
dogfood.

### 3. Sustainable: observability, hygiene, and hypothesis framing

**Factory health report.** An `@svendowideit/idea-factory-health` report
aggregates: `allowedFailure` counts over time, thoughts stuck unclassified,
ideas stuck in a state, time-in-state, abandoned rate, and classification-
accuracy trend. This turns silent degradation (a flaky Ollama quietly stopping
classification) into a visible signal — the difference between a system that
runs and a system that *sustains*.

**Backlog hygiene / aging process.** An `ageBacklog` step surfaces stale items —
ideas in `captured` > N days, overdue todos, `stale` plans — for triage. Not
auto-deleting (immutability forbids it), just surfacing. Without this, a
personal factory accumulates a graveyard of half-finished ideas and the loop
loses signal.

**Hypothesis + success metric per idea.** Each idea carries `hypothesis` and
`successMetric`, so "implemented" is validated against a measurable outcome
rather than "the code ran." This operationalizes the Build-Measure-Learn loop
the design cites but never wires in, and it gives the post-mortem a real
yardstick for `outcome: success|partial|failure` instead of a guess.

**Risk register.** The critique step finds failure modes but discards them.
`assessRisk` persists them as a tracked list (risk, likelihood, impact,
mitigation, status) revisited at plan and review time. Critique is a moment; a
risk register is a living thing.

### The tradeoff, made explicit

Adding acceptance criteria and a verification gate makes the loop heavier and
more human-gated, which cuts against the "low-friction, single-user"
optimization. The mitigation is to make criteria *optional-but-flagged* in early
phases: a task without criteria is marked `unverified`, not blocked, so you get
the traceability without stalling the loop. The eval and health reports are pure
read-only additions — they cost nothing at runtime and only pay off when you
need to improve or debug the factory.

## Architectural Tension: Swamp-Native vs. External System of Record

A fundamental question: does swamp *own* the ideas, or does it *process* ideas
that live elsewhere?

### Option A: Swamp as system of record

All idea data lives in swamp data resources. The wiki is generated read-only
HTML. Capture happens through swamp CLI, speech ingest, or the wiki's capture
form (which writes to swamp via a model method).

**Pros**: Single source of truth. Swamp's versioning, lineage queries, CEL
expressions, and data chaining work natively. No sync. No drift. Workflow
guards can check `data.latest("idea-store", "current")` directly.

**Cons**: Lock-in. Can't use Obsidian/Logseq/VSCode to browse and edit ideas
as plain files. Harder to share outside swamp. If swamp is down, ideas are
inaccessible. The wiki is a read-only view — you can't just open a markdown
file and type.

### Option B: External system as source of truth

Ideas live as markdown files in a directory (e.g. `ideas/`), an Obsidian
vault, a Logseq graph, or a Notion database. Swamp models *sync* from the
external system — reading files, parsing frontmatter, building the lineage
graph in memory — then run the factory loop and *write back* changes (updated
frontmatter, new files, research notes as sidecar files).

**Pros**: Plain-text durability. Use any editor. Git-friendly. Portable.
Works offline without swamp. The external system is the canonical store;
swamp is "just" the processing pipeline.

**Cons**: Swamp's data model is a projection — it must re-sync before each
workflow run. Bidirectional sync is hard (what if you edit a file while
swamp is processing it?). Swamp can't use `data.latest()` as a guard because
the data is stale until synced. Two systems to maintain, two schemas to keep
aligned. Frontmatter is a weak schema.

### Option E: External system owns everything, swamp datastore bridges it ★

The external system (filesystem, Obsidian vault, Logseq graph, Notion, a git
repo) is the sole source of truth. A custom swamp **datastore** is built that
implements the `DatastoreProvider` interface — `createLock`, `createVerifier`,
`resolveDatastorePath` — and maps swamp's data resource reads/writes directly
onto the external system's native storage. Swamp models don't sync or cache;
they read and write through the datastore on every method call.

```
┌──────────────────────────────────────────────────┐
│  External system (source of truth)                │
│  ideas/                                           │
│    2026-08-14-idea-factory.md                     │
│    2026-08-15-caching-layer.md                    │
│  .idea-factory/          ← swamp metadata stored  │
│    lineage.json            alongside the ideas    │
│    postmortems/                                   │
│    research/                                      │
└──────────────┬───────────────────────────────────┘
               │  native read/write
┌──────────────▼───────────────────────────────────┐
│  @svendowideit/idea-datastore                     │
│  (implements DatastoreProvider)                   │
│                                                   │
│  createLock(path) → file lock on ideas/           │
│  createVerifier()  → checks ideas/ is writable    │
│  resolveDatastorePath() → ./ideas/                │
│                                                   │
│  Swamp's data layer reads/writes directly         │
│  through this — no sync, no cache, no projection  │
└──────────────┬───────────────────────────────────┘
               │  swamp data API
┌──────────────▼───────────────────────────────────┐
│  Swamp models (idea-store, research-agent, etc.)  │
│  context.writeResource("current", ...)            │
│  context.readResource("current")                  │
│                                                   │
│  These calls go through the datastore →           │
│  directly to the filesystem. Swamp's data         │
│  versioning, locking, and CEL queries all         │
│  work natively against the external store.        │
└──────────────────────────────────────────────────┘
```

**Pros**: Single source of truth (the external system). No sync — swamp reads
and writes natively through the datastore. Swamp's full data model works:
`data.latest()`, versioning, locking, CEL queries, workflow guards. The
external system is always current because swamp writes directly to it. You
can edit ideas in any editor; swamp sees the changes immediately on next
read. The datastore is a clean abstraction — swap the backend (filesystem →
Postgres → Notion API) without changing any model code.

**Cons**: Building a datastore is the heaviest lift of all options — it must
implement locking, versioning, and the full data resource lifecycle on top of
the external system's primitives. The external system's storage model may not
map cleanly to swamp's (e.g., Notion's API has rate limits and a block-based
model; a filesystem datastore needs to invent a versioning scheme). The
datastore becomes a critical piece of infrastructure — if it has bugs, all
models that depend on it break. Harder to debug than Option A (where swamp's
built-in datastore is well-tested).

**When to choose this**: When you have a strong existing system you won't
abandon (an Obsidian vault you've used for years, a team Confluence, a
Logseq graph), and you want swamp's processing pipeline to work *directly*
against it without duplication. The datastore is an investment that pays off
if the external system is long-lived and the idea volume is high.

### Option C: Hybrid — swamp owns structure, filesystem owns content

Swamp owns the structured metadata (lineage edges, status, post-mortems,
research notes, critique notes, tags, priorities). The idea *body* lives as
a markdown file. Swamp stores a content hash + file path; the body is read
from disk on demand. The wiki generates HTML from swamp metadata + file
content.

```
ideas/                        ← filesystem (git-tracked, editor-friendly)
  2026-08-14-idea-factory.md  ← body: freeform markdown
  2026-08-15-caching-layer.md
  2026-08-15-speech-ux.md

swamp idea-store data:        ← swamp (structured metadata, lineage, processing)
  current:
    - id: uuid-1
      filePath: ideas/2026-08-14-idea-factory.md
      contentHash: sha256:abc123
      status: implementing
      parentIdeas: []
      tags: [meta, swamp, design]
      researchNotes: ...
      postMortem: null
    - id: uuid-2
      filePath: ideas/2026-08-15-caching-layer.md
      contentHash: sha256:def456
      status: captured
      parentIdeas: [uuid-1]
      ...
```

**Pros**: Best of both. Files are plain markdown — edit anywhere, git-track,
portable. Swamp owns the structured processing layer — lineage, research,
critique, post-mortems, workflow state. The wiki can render both. Swamp can
detect file changes via content hash and trigger re-processing. No
bidirectional sync — the file is the body, swamp is everything else.

**Cons**: Two places to look for a complete picture of an idea. The wiki
must merge data from two sources. If a file is deleted, swamp's metadata
becomes orphaned. Content hash checking adds a step to every read.

### Option D: Swamp-native with filesystem export

Swamp owns everything, but a sync step exports ideas as markdown files
(one-way: swamp → filesystem). The filesystem is a *readable mirror*, not
the source of truth. You can browse and search with any tool, but edits
must go through swamp.

**Pros**: Single source of truth (swamp). Filesystem is always a consistent
snapshot. No sync conflicts. You get plain-text browsing for free.

**Cons**: Can't edit files directly (or edits get overwritten on next
export). The mirror is a second copy — disk usage, staleness window.

### Decision Matrix

| Option | Source of truth | Swamp data API works? | Edit anywhere? | Implementation effort | Best for |
|--------|----------------|----------------------|----------------|----------------------|----------|
| **A** (swamp-native) | swamp | Yes, natively | No | Low | Greenfield, full swamp commitment |
| **B** (external + sync) | external | Stale between syncs | Yes | Medium | Simple external stores, low write volume |
| **C** (hybrid) | split: body=files, meta=swamp | Yes, for metadata | Yes (body only) | Low-Medium | Quick start, editor-friendly |
| **D** (swamp + export) | swamp | Yes, natively | Read-only mirror | Low | Swamp-native with browsing convenience |
| **E** (datastore bridge) ★ | external | Yes, natively | Yes | **High** | Long-lived external system, high volume |

### Recommendation: Start with C, target E

**Phase 0-1: Option C (hybrid).** The idea body is a markdown file. Swamp
owns everything else. This gives maximum flexibility during early iteration
— you can edit ideas in your editor, git-track them, and still have swamp's
processing pipeline. The content hash lets swamp detect when a file changed
and re-trigger research/critique. Low implementation cost — no datastore to
build, just a model that reads files and writes metadata.

**Phase 2+: Build the datastore (Option E).** Once the idea volume grows and
the hybrid split becomes annoying (two places to look, content-hash checks,
orphaned metadata on file delete), build `@svendowideit/idea-datastore`. The
datastore maps swamp's data resource API directly onto the `ideas/` directory
— markdown files for bodies, JSON sidecar files for metadata, a simple
content-addressed versioning scheme. All models (idea-store, research-agent,
critique-agent) work unchanged — they already use `context.writeResource` and
`context.readResource`; the datastore swap is transparent.

**Why not start with E?** Building a datastore before the data model is
stable is premature. The idea schema will evolve rapidly in phase 0-1 as we
learn what metadata matters. Changing a datastore's storage format is
expensive; changing a swamp model's resource schema is cheap. Stabilize the
schema first, then build the datastore to match.

**Why not stay with C forever?** The split source of truth is a permanent
source of subtle bugs — content hash mismatches, orphaned metadata, the wiki
needing to merge two data sources. Option E eliminates the split: the
filesystem *is* the swamp data store. You get plain-text editing *and*
native swamp data API. It's the endgame.

### What this means for the data model

The Idea schema gains a `filePath` and `contentHash` field. The `body` field
becomes *derived* — read from the file at `filePath` when needed, cached in
swamp data for querying. The `create` method accepts either a `body` string
(writes a new file) or a `filePath` (imports an existing file).

```yaml
Idea:
  id: uuid
  filePath: string            # relative path to markdown file
  contentHash: string         # sha256 of file content at last sync
  title: string               # extracted from first h1 or frontmatter
  body: string                # cached from file, refreshed on contentHash mismatch
  status: enum
  parentIdeas: [uuid]
  childIdeas: [uuid]
  relatedIdeas: [uuid]
  influencedBy: [{url, title, excerpt, relevance}]
  tags: [string]
  priority: enum
  effort: enum
  hypothesis: string          # testable claim this idea makes
  successMetric: string       # how "implemented" is validated
  createdAt: iso-datetime
  updatedAt: iso-datetime
  researchNotes: markdown     # swamp-owned
  critiqueNotes: markdown     # swamp-owned
  implementationArtifacts: [{type, url, description}]
  postMortem: {...}           # swamp-owned
```

### Precedent in this repo

The news workflow already demonstrates a similar pattern: the feed-catalog
is swamp-native (feeds are stored in swamp data resources), but the HTML
output is external files (`news.html`, `feeds.html`). The feedback server
is an external HTTP service that swamp *reads from* (via `gatherFeedback`,
`gatherPages`, `gatherFeedState`). The factory would extend this: swamp
reads idea bodies from markdown files, processes them, writes structured
results back to swamp data, and generates the wiki as external HTML.

## Open Questions

1. **Wiki storage**: Should the wiki be purely generated (read-only HTML from
   the idea store) or should it support editing that writes back to the store?
   Leaning toward: generated HTML for viewing, swamp CLI + speech for capture.

2. **LLM provider**: The news workflow uses Ollama (local). Should the idea
   factory also default to local, or support cloud providers? Leaning toward:
   same pattern — configurable LLM base URL, default to local Ollama.

3. **Human-in-the-loop gates**: How many approval steps are too many? The news
   workflow uses `allowFailure: true` for LLM steps so the loop degrades
   gracefully. Same pattern here — LLM steps are advisory, human gates are
   for destructive or high-stakes decisions.

4. **Idea store backend**: The feed-catalog uses swamp's built-in data
   resources (JSON blobs). For the idea store, this works for hundreds of
   ideas. At thousands, we'd want a proper database. Start with built-in,
   migrate to Postgres (via `@svendowideit/postgres-model`) when needed.

5. **Speech interface UX**: Continuous dictation vs. push-to-talk? Local
   Whisper vs. API? Start with file upload (record on phone, upload to wiki),
   iterate toward real-time.

6. **Todo system boundaries**: How far should the todo system reach into
   "ordinary life"? Shopping lists and appointments are clear wins, but do we
   also want calendar sync (ICS), reminders (push/email), or geolocation-aware
   errands? Leaning toward: start with lists + recurrence + due dates, add
   calendar sync as a later integration rather than building a calendar
   ourselves.

7. **Classification granularity**: Is the refinement/minor-rethink/major-rethink
   split too fine? In practice the human might only want to answer "new,
   duplicate, or refines something existing?" and let the *degree* of re-think
   emerge later in the refine job. Leaning toward: keep all three in the data
   model, but have the human-facing review surface collapse them to the three
   core decisions.

8. **Classifier feedback loop**: Should human classification overrides feed
   back into the classifier's prompts/examples, or just be logged for
   inspection? Leaning toward: log everything, and periodically curate a few
   canonical examples into the classify prompt by hand — no auto-retraining
   yet.

9. **Question budget**: How many clarifying questions is too many before the
   dialogue becomes annoying? A thought should never take more than 2–3
   questions to route, and the factory should always offer an "I'll decide
   later" escape hatch that parks the thought in the review queue. Leaning
   toward: cap at 3 questions, then park.

10. **Impact-prompt aggressiveness**: Should the factory *proactively* prompt
    about a thought's impact, or only when the human asks? A thought that
    refines an idea mid-implementation could invalidate work; a stray
    "write-through is a good idea" probably shouldn't interrupt anything.
    Leaning toward: prompt only when the suggested action is `re-think` or
    higher-severity; log lower-severity impacts for the human to see on the
    idea's page without an active nudge.

## First Step

```bash
# Create the idea-store model extension
swamp extension init idea-store

# Create the first factory workflow (capture only)
swamp workflow create idea-factory

# Import this document as the first idea
swamp model create @svendowideit/idea-store idea-store
swamp model method run idea-store create \
  --input title="Idea Factory System" \
  --input body="$(cat docs/idea-factory.md)" \
  --input tags:json='["meta","swamp","design"]' \
  --input status="implementing"
```

## References

- Luhmann, N. "Communicating with Slip Boxes" (1981)
- Boyd, J. "The Essence of Winning and Losing" (1995)
- Cunningham, W. "Federated Wiki" (2011)
- Christian, B. "The Alignment Problem" (2020) — chapter on debate and
  adversarial collaboration
- swamp architecture: `design/workflow.md`, `design/models.md`,
  `design/reports.md`
