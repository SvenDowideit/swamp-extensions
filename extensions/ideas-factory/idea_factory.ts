/**
 * Idea factory — capture, classify, and route thoughts (Phase 0).
 *
 * A single model type (`@svendowideit/ideas-factory`) whose methods each write a
 * named data resource, mirroring the news stack's "one model, many methods"
 * pattern. All data lives in swamp model data resources:
 *
 *   - `inbox`          — raw captured thoughts
 *   - `classification` — classifyThought output (kind + confidence + reasoning)
 *   - `ideas`          — common ideas created by routeThought (new-idea kind)
 *   - `todos`          — action items created by routeThought (todo kind)
 *
 * Phase 0 methods:
 *   - `ingestThought`  — accept a raw thought into the inbox (deterministic).
 *   - `classifyThought`— classify unclassified thoughts (keyword matching,
 *                        deterministic; an OpenAI-compatible LLM can be added
 *                        later behind `allowFailure`, see `tryLlmClassify`).
 *   - `routeThought`   — route classified thoughts: new-idea -> idea, todo -> todo.
 *   - `renderBoard`    — render a static kanban HTML page over the store.
 *
 * @module
 */
import { z } from "npm:zod@4";

// ---------------------------------------------------------------------------
// Global args & method args
// ---------------------------------------------------------------------------

const GlobalArgsSchema = z.object({
  llmBaseUrl: z.string().url().optional().describe(
    "OpenAI-compatible base URL for optional LLM classification (Phase 1; unused in Phase 0)",
  ),
  llmModel: z.string().optional().describe(
    "Model name for optional LLM classification",
  ),
  llmApiKey: z.string().optional().describe(
    "Optional API key for the LLM (omit for local Ollama)",
  ),
  outputDir: z.string().optional().describe(
    "Directory where the kanban board HTML is written (default ~/.swamp/idea-factory)",
  ),
}).strict();

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const IngestArgsSchema = z.object({
  raw: z.string().min(1).describe("Raw thought text"),
  source: z.enum(["text", "wiki", "web-clip", "email", "api", "voice"]).default(
    "text",
  ).describe("Capture source"),
});

const ClassifyArgsSchema = z.object({}).strict();

const RouteArgsSchema = z.object({}).strict();

const RenderBoardArgsSchema = z.object({
  path: z.string().optional().describe("Explicit output path override"),
});

// ---------------------------------------------------------------------------
// Resource schemas
// ---------------------------------------------------------------------------

const CLASSIFICATION_KINDS = [
  "new-idea",
  "refinement",
  "minor-rethink",
  "major-rethink",
  "duplicate",
  "todo",
  "note",
  "noise",
] as const;
type ClassificationKind = (typeof CLASSIFICATION_KINDS)[number];

const ThoughtSchema = z.object({
  id: z.string(),
  raw: z.string(),
  source: z.string(),
  capturedAt: z.iso.datetime(),
  status: z.enum(["unclassified", "classified"]),
});

const InboxSchema = z.object({
  thoughts: z.array(ThoughtSchema),
});

const ClassificationSchema = z.object({
  thoughtId: z.string(),
  kind: z.enum(CLASSIFICATION_KINDS),
  confidence: z.number(),
  reasoning: z.string(),
  classifiedAt: z.iso.datetime(),
  routed: z.boolean().default(false),
});

const ClassificationsSchema = z.object({
  classifications: z.array(ClassificationSchema),
  classifiedAt: z.iso.datetime(),
});

const IdeaSchema = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string(),
  status: z.enum([
    "captured",
    "researching",
    "planned",
    "implementing",
    "implemented",
    "abandoned",
  ]),
  createdAt: z.iso.datetime(),
});

const IdeasSchema = z.object({
  ideas: z.array(IdeaSchema),
});

const TodoSchema = z.object({
  id: z.string(),
  title: z.string(),
  list: z.enum([
    "ideas",
    "shopping",
    "household",
    "appointments",
    "errands",
    "work",
    "custom",
  ]),
  status: z.enum(["open", "in-progress", "done", "cancelled", "deferred"]),
  createdAt: z.iso.datetime(),
});

const TodosSchema = z.object({
  todos: z.array(TodoSchema),
});

// ---------------------------------------------------------------------------
// Shared context type
// ---------------------------------------------------------------------------

type Thought = z.infer<typeof ThoughtSchema>;
type Classification = z.infer<typeof ClassificationSchema>;
type Idea = z.infer<typeof IdeaSchema>;
type Todo = z.infer<typeof TodoSchema>;

type MethodContext = {
  globalArgs: GlobalArgs;
  logger?: { info: (msg: string, props?: Record<string, unknown>) => void };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
  readResource: (
    instanceName: string,
    version?: number,
  ) => Promise<Record<string, unknown> | null>;
  createFileWriter: (
    specName: string,
    instanceName: string,
    overrides?: Record<string, unknown>,
  ) => Promise<{ writeText: (text: string) => Promise<{ name: string }> }>;
};

// ---------------------------------------------------------------------------
// Pure helpers (exported for testing)
// ---------------------------------------------------------------------------

/** Generate a unique id for an application-level record. */
export function genId(): string {
  return crypto.randomUUID();
}

/** Truncate freeform text to a one-line title. */
export function toTitle(raw: string, maxLen = 60): string {
  const oneLine = raw.trim().replace(/\s+/g, " ").replace(/[.。!?！？]$/, "");
  return oneLine.length > maxLen ? `${oneLine.slice(0, maxLen - 1)}…` : oneLine;
}

/** Keyword -> weight table per classification kind. */
const KIND_KEYWORDS: Record<ClassificationKind, [RegExp, number][]> = {
  "new-idea": [
    [
      /\b(build|make|create|design|idea|feature|refactor|rewrite|project|app|tool|system|service|module)\b/i,
      2,
    ],
    [/\b(should|could|would|could|worth|experiment|prototype|poc)\b/i, 1],
    [/\b(test|tests|testing|unit|integration|ci|deploy|pipeline)\b/i, 1],
  ],
  refinement: [
    [
      /\b(add|improve|extend|update|change|tweak|adjust|modify|instead|better)\b/i,
      2,
    ],
    [/\b(then|also|optionally|we could|we should)\b/i, 1],
  ],
  "minor-rethink": [
    [/\b(what if|consider|reconsider|instead of|swap|replace)\b/i, 2],
  ],
  "major-rethink": [
    [
      /\b(rethink|rethink\b|scrap|abandon|start over|fundamentally|completely rewrite)\b/i,
      3,
    ],
  ],
  duplicate: [
    [/\b(same as|already|as discussed|like we talked|ditto|again)\b/i, 2],
  ],
  todo: [
    [
      /\b(buy|call|email|remember|remind|todo|to-do|need to|should do|must|don't forget|pick up|fix|install|send|pay|book|schedule|make appointment)\b/i,
      2,
    ],
    [
      /\b(shopping|groceries|milk|dentist|doctor|haircut|submit|file|wash|clean)\b/i,
      2,
    ],
  ],
  note: [
    [
      /\b(note|note that|fyi|for reference|context|interesting|read|article|book)\b/i,
      2,
    ],
  ],
  noise: [
    [/^(hi|hello|ok|okay|thanks|thanks|test|testing 123|asdf|xyz)$/i, 3],
    [/^\s*$/i, 5],
  ],
};

/**
 * Classify a thought by keyword matching. Returns the best-matching kind.
 * Deterministic and offline — the Phase 0 default. LLM classification can
 * replace/subset this later.
 */
export function classifyByKeywords(raw: string): Classification {
  const text = raw;
  let best: ClassificationKind = "noise";
  let bestScore = 0;

  // Todo & note detection should outvote generic idea words when they appear.
  for (
    const [kind, rules] of Object.entries(KIND_KEYWORDS) as [
      ClassificationKind,
      [RegExp, number][],
    ][]
  ) {
    let score = 0;
    for (const [re, weight] of rules) {
      const m = text.match(re);
      if (m) score += weight;
    }
    if (score > bestScore) {
      bestScore = score;
      best = kind;
    }
  }

  // A thought that mentions building/testing something is a software idea even
  // if it has weak idea keywords; a pure command ("buy milk") is a todo.
  if (bestScore === 0) {
    best = text.trim().length === 0 ? "noise" : "note";
  }

  const confidence = bestScore === 0
    ? 0.4
    : Math.min(0.95, 0.5 + bestScore * 0.15);

  return {
    thoughtId: "",
    kind: best,
    confidence,
    reasoning: `keyword match (${best}, score ${bestScore})`,
    classifiedAt: new Date().toISOString(),
    routed: false,
  };
}

/** Pick a default todo list from keywords. */
export function inferTodoList(raw: string): Todo["list"] {
  const t = raw.toLowerCase();
  if (/(grocer|milk|food|buy|shop)/.test(t)) return "shopping";
  if (
    /(dentist|doctor|appointment|schedule|call .*bank|renter|barber|haircut)/
      .test(t)
  ) {
    return "appointments";
  }
  if (/(house|clean|wash|garden|dish|laundry|repair)/.test(t)) {
    return "household";
  }
  if (/(code|build|test|pr|deploy|feature|merge)/.test(t)) return "ideas";
  if (/(pick up|drop|post|errand)/.test(t)) return "errands";
  return "custom";
}

/**
 * Resolve where the kanban board should be written. An empty/blank `path`
 * (e.g. a workflow input left at its default `""`) falls back to
 * `defaultOutputDir/kanban.html`; a provided `path` is used as-is (its parent
 * becomes the output dir).
 */
export function resolveBoardPath(
  path: string | undefined,
  defaultOutputDir: string,
): { outputDir: string; outPath: string } {
  const hasPath = typeof path === "string" && path.trim() !== "";
  if (hasPath) {
    const dir = path!.split("/").slice(0, -1).join("/") || defaultOutputDir;
    return { outputDir: dir, outPath: path! };
  }
  const base = defaultOutputDir.replace(/\/+$/, "");
  return { outputDir: base, outPath: `${base}/kanban.html` };
}

// ---------------------------------------------------------------------------
// Model definition
// ---------------------------------------------------------------------------

export const model = {
  type: "@svendowideit/ideas-factory",
  version: "2026.09.07.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    inbox: {
      description: "Raw captured thoughts awaiting classification",
      schema: InboxSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    classification: {
      description: "Per-thought classification results",
      schema: ClassificationsSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    ideas: {
      description: "Common ideas created from new-idea thoughts",
      schema: IdeasSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    todos: {
      description: "Action items created from todo thoughts",
      schema: TodosSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
  },
  files: {
    board: {
      description: "Kanban board HTML (persisted copy of the rendered page)",
      contentType: "text/html",
      lifetime: "30d",
      garbageCollection: 5,
    },
  },
  methods: {
    ingestThought: {
      description:
        "Capture a raw thought into the inbox for later classification.",
      arguments: IngestArgsSchema,
      execute: async (
        args: z.infer<typeof IngestArgsSchema>,
        context: MethodContext,
      ) => {
        const inbox = (await context.readResource("inbox")) as
          | { thoughts: unknown[] }
          | null;
        const thoughts = inbox?.thoughts ?? [];
        const thought = {
          id: genId(),
          raw: args.raw,
          source: args.source,
          capturedAt: new Date().toISOString(),
          status: "unclassified",
        };
        thoughts.push(thought);
        const handle = await context.writeResource("inbox", "inbox", {
          thoughts,
        });
        context.logger?.info("Captured thought {id}", { id: thought.id });
        return {
          dataHandles: [handle],
          thoughtId: thought.id,
          raw: thought.raw,
        };
      },
    },

    classifyThought: {
      description:
        "Classify all unclassified thoughts in the inbox (keyword matching in Phase 0).",
      arguments: ClassifyArgsSchema,
      execute: async (
        _args: z.infer<typeof ClassifyArgsSchema>,
        context: MethodContext,
      ) => {
        const inbox = (await context.readResource("inbox")) as
          | { thoughts: Thought[] }
          | null;
        const thoughts = inbox?.thoughts ?? [];
        const unclassified = thoughts.filter((t) =>
          t.status === "unclassified"
        );
        if (unclassified.length === 0) {
          context.logger?.info("No unclassified thoughts to classify");
          return { dataHandles: [], classified: 0 };
        }

        const prev = (await context.readResource("classification")) as
          | { classifications: Classification[] }
          | null;
        const classifications = prev?.classifications ?? [];

        const now = new Date().toISOString();
        for (const t of unclassified) {
          const c = classifyByKeywords(t.raw);
          c.thoughtId = t.id;
          c.classifiedAt = now;
          classifications.push(c);
          t.status = "classified";
          context.logger?.info("Classified {id} as {kind}", {
            id: t.id,
            kind: c.kind,
          });
        }

        const inboxHandle = await context.writeResource("inbox", "inbox", {
          thoughts,
        });
        const classHandle = await context.writeResource(
          "classification",
          "classification",
          { classifications, classifiedAt: now },
        );

        return {
          dataHandles: [inboxHandle, classHandle],
          classified: unclassified.length,
        };
      },
    },

    routeThought: {
      description:
        "Route classified thoughts: new-idea -> common idea, todo -> todo. Other kinds park for later.",
      arguments: RouteArgsSchema,
      execute: async (
        _args: z.infer<typeof RouteArgsSchema>,
        context: MethodContext,
      ) => {
        const inbox = (await context.readResource("inbox")) as
          | { thoughts: Thought[] }
          | null;
        const thoughts = inbox?.thoughts ?? [];
        const classifications = ((await context.readResource(
          "classification",
        )) as { classifications: Classification[] } | null)
          ?.classifications ?? [];

        const ideasState = (await context.readResource("ideas")) as
          | { ideas: Idea[] }
          | null;
        const ideas = ideasState?.ideas ?? [];
        const todosState = (await context.readResource("todos")) as
          | { todos: Todo[] }
          | null;
        const todos = todosState?.todos ?? [];

        const now = new Date().toISOString();
        let createdIdeas = 0;
        let createdTodos = 0;
        let parked = 0;

        for (const c of classifications) {
          if (c.routed) continue;
          const thought = thoughts.find((t) => t.id === c.thoughtId);
          if (!thought || thought.status !== "classified") {
            c.routed = true; // unreachable target — don't revisit
            parked++;
            continue;
          }

          if (c.kind === "new-idea") {
            ideas.push({
              id: genId(),
              title: toTitle(thought.raw),
              body: thought.raw,
              status: "captured",
              createdAt: now,
            });
            createdIdeas++;
            c.routed = true;
          } else if (c.kind === "todo") {
            todos.push({
              id: genId(),
              title: toTitle(thought.raw),
              list: inferTodoList(thought.raw),
              status: "open",
              createdAt: now,
            });
            createdTodos++;
            c.routed = true;
          } else {
            // refinement / minor-rethink / major-rethink / duplicate / note / noise:
            // no Phase 0 routing target yet — they park in the classification resource.
            c.routed = true;
            parked++;
          }
        }

        await context.writeResource("ideas", "ideas", { ideas });
        await context.writeResource("todos", "todos", { todos });
        await context.writeResource("classification", "classification", {
          classifications,
          classifiedAt: now,
        });

        context.logger?.info(
          "Routed {ideas} new ideas, {todos} todos ({parked} parked)",
          { ideas: createdIdeas, todos: createdTodos, parked },
        );
        return {
          dataHandles: [],
          createdIdeas,
          createdTodos,
          parked,
        };
      },
    },

    renderBoard: {
      description:
        "Render a static kanban HTML page over the inbox, ideas, and todos. Writes to outputDir/kanban.html (default ~/.swamp/idea-factory/kanban.html).",
      arguments: RenderBoardArgsSchema,
      execute: async (
        args: z.infer<typeof RenderBoardArgsSchema>,
        context: MethodContext,
      ) => {
        const inbox = ((await context.readResource("inbox")) as
          | { thoughts: Thought[] }
          | null)?.thoughts ?? [];
        const classifications = ((await context.readResource(
          "classification",
        )) as { classifications: Classification[] } | null)
          ?.classifications ?? [];
        const ideas = ((await context.readResource("ideas")) as
          | { ideas: Idea[] }
          | null)?.ideas ?? [];
        const todos = ((await context.readResource("todos")) as
          | { todos: Todo[] }
          | null)?.todos ?? [];

        const html = renderKanban(
          { thoughts: inbox, classifications, ideas, todos },
          new Date().toISOString(),
        );

        const writer = await context.createFileWriter("board", "kanban");
        await writer.writeText(html);

        const { outputDir, outPath } = resolveBoardPath(
          args.path,
          context.globalArgs.outputDir ||
            `${Deno.env.get("HOME") ?? "/tmp"}/.swamp/ideas-factory`,
        );
        await Deno.mkdir(outputDir, { recursive: true });
        await Deno.writeTextFile(outPath, html);
        context.logger?.info("Board written to {path}", { path: outPath });

        return { dataHandles: [], path: outPath, ideas: ideas.length };
      },
    },
  },
  reports: ["@svendowideit/ideas-factory-summary"],
};

// ---------------------------------------------------------------------------
// Kanban renderer (pure, testable)
// ---------------------------------------------------------------------------

type BoardData = {
  thoughts: Thought[];
  classifications: Classification[];
  ideas: Idea[];
  todos: Todo[];
};

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Render a minimal kanban page. Columns: Thoughts, Ideas, Todos. */
export function renderKanban(d: BoardData, generatedAt: string): string {
  const classFor = (id: string) =>
    d.classifications.find((x) => x.thoughtId === id) ?? null;

  // Thoughts column shows thoughts that haven't yet become an idea or todo:
  // unclassified, in-flight (classified but not routed), or parked kinds.
  const openThoughts = d.thoughts.filter((t) => {
    const c = classFor(t.id);
    if (!c || !c.routed) return true;
    return c.kind !== "new-idea" && c.kind !== "todo";
  });

  const thoughtCards = openThoughts.map((t) => {
    const c = classFor(t.id);
    const meta = !c
      ? "unclassified"
      : c.routed
      ? `${c.kind} · parked`
      : c.kind;
    return `<div class="card thoughts-card"><div class="card-title">${
      esc(
        toTitle(t.raw),
      )
    }</div><div class="card-meta">${esc(meta)}</div><div class="card-body">${
      esc(t.raw)
    }</div></div>`;
  }).join("\n");

  const ideaCards = d.ideas.map((i) =>
    `<div class="card idea-card"><div class="card-title">${
      esc(
        i.title,
      )
    }</div><div class="card-meta">${
      esc(i.status)
    }</div><div class="card-body">${esc(i.body)}</div></div>`
  ).join("\n");

  const todoCards = d.todos.map((t) =>
    `<div class="card todo-card"><div class="card-title">${
      esc(
        t.title,
      )
    }</div><div class="card-meta">${esc(t.list)} · ${esc(t.status)}</div></div>`
  ).join("\n");

  const col = (name: string, cards: string) =>
    `<div class="column"><div class="column-head">${name} <span class="count">${
      cards ? cards.split("\n").filter(Boolean).length : 0
    }</span></div><div class="column-body">${
      cards || "<div class='empty'>—</div>"
    }</div></div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Idea Factory — Kanban</title>
<style>
  :root { --bg:#f5f5f4; --card:#fff; --line:#e5e5e5; --muted:#71717a; }
  * { box-sizing:border-box; }
  body { margin:0; font-family:ui-sans-serif,system-ui,-apple-system,sans-serif; background:var(--bg); color:#18181b; }
  header { padding:16px 20px; background:#fff; border-bottom:1px solid var(--line); display:flex; align-items:center; justify-content:space-between; }
  header h1 { font-size:18px; margin:0; }
  header .generated { font-size:12px; color:var(--muted); }
  .capture { padding:16px 20px; background:#fff; border-bottom:1px solid var(--line); }
  .capture form { display:flex; gap:8px; }
  .capture input[type=text] { flex:1; padding:10px 12px; border:1px solid var(--line); border-radius:8px; font-size:14px; }
  .capture button { padding:10px 16px; border:0; border-radius:8px; background:#18181b; color:#fff; font-size:14px; cursor:pointer; }
  .board { display:grid; grid-template-columns:repeat(3, 1fr); gap:14px; padding:20px; align-items:start; }
  @media (max-width:900px){ .board{ grid-template-columns:1fr; } }
  .column { background:var(--card); border:1px solid var(--line); border-radius:12px; overflow:hidden; }
  .column-head { padding:10px 14px; font-weight:600; font-size:13px; border-bottom:1px solid var(--line); background:#fafafa; display:flex; justify-content:space-between; }
  .count { color:var(--muted); font-weight:400; }
  .column-body { padding:10px; display:flex; flex-direction:column; gap:8px; min-height:120px; }
  .card { border:1px solid var(--line); border-radius:8px; padding:10px 12px; background:#fff; }
  .card-title { font-weight:600; font-size:14px; margin-bottom:2px; }
  .card-meta { font-size:11px; color:var(--muted); text-transform:capitalize; margin-bottom:4px; }
  .card-body { font-size:13px; color:#3f3f46; }
  .empty { color:var(--muted); font-size:12px; padding:8px; }
</style>
</head>
<body>
<header>
  <h1>🗂️ Idea Factory</h1>
  <span class="generated">generated <span data-generated="${
    esc(generatedAt)
  }"></span></span>
</header>
<section class="capture">
  <form action="/api/capture" method="post">
    <input type="text" name="raw" placeholder="A random thought…" autofocus autocomplete="off">
    <button type="submit">Capture</button>
  </form>
</section>
<main class="board">
  ${col("Thoughts", thoughtCards)}
  ${col("Ideas", ideaCards)}
  ${col("Todos", todoCards)}
</main>
<script>document.querySelectorAll('[data-generated]').forEach(function(el){var d=new Date(el.getAttribute('data-generated'));el.textContent=d.toLocaleString('en-GB');});</script>
</body>
</html>`;
}
