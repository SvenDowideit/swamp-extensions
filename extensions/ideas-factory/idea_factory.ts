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
    "OpenAI-compatible base URL for the LLM (default http://localhost:11434)",
  ),
  llmModel: z.string().optional().describe(
    "Model name for the LLM (default deepseek-v4-flash:cloud)",
  ),
  llmApiKey: z.string().optional().describe(
    "Optional API key for the LLM (omit for local Ollama)",
  ),
  llmTemperature: z.number().min(0).max(2).optional().describe(
    "LLM sampling temperature (default 0.1)",
  ),
  llmTimeoutSec: z.number().int().min(1).max(600).optional().describe(
    "Per-call LLM timeout in seconds (default 120)",
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

const ClassifyArgsSchema = z.object({});

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
  sourceThoughtIds: z.array(z.string()).default([]),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
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
  sourceThoughtId: z.string(),
  createdAt: z.iso.datetime(),
});

const TodosSchema = z.object({
  todos: z.array(TodoSchema),
});

// ---------------------------------------------------------------------------
// Phase 1: actions (the audit trail of what the LLM / user did) and questions
// ---------------------------------------------------------------------------

const ActionSchema = z.object({
  id: z.string(),
  step: z.enum(["cluster", "merge", "refine", "plan"]),
  actor: z.enum(["llm", "manual"]),
  inputIds: z.array(z.string()),
  outputId: z.string().nullable(),
  reasoning: z.string(),
  userPrompt: z.string().nullable(),
  llmResponse: z.string().nullable(),
  before: z.unknown().nullable(),
  status: z.enum(["applied", "reverted", "modified"]),
  appliedAt: z.iso.datetime(),
  revertedAt: z.iso.datetime().nullable(),
});

const ActionsSchema = z.object({
  actions: z.array(ActionSchema),
});

const QuestionSchema = z.object({
  id: z.string(),
  actionId: z.string().nullable(),
  ideaId: z.string().nullable(),
  text: z.string(),
  about: z.string(),
  askedAt: z.iso.datetime(),
  answer: z.string().nullable(),
  answeredAt: z.iso.datetime().nullable(),
});

const QuestionsSchema = z.object({
  questions: z.array(QuestionSchema),
});

// ---------------------------------------------------------------------------
// Phase 2: plans (task breakdown with acceptance criteria + test strategy)
// ---------------------------------------------------------------------------

const PlanTaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  acceptanceCriteria: z.array(z.string()),
  testStrategy: z.enum([
    "unit",
    "integration",
    "property",
    "golden",
    "contract",
    "manual",
  ]),
  dependencies: z.array(z.string()).default([]),
  effort: z.enum(["small", "medium", "large"]).default("medium"),
  status: z.enum(["ready", "in-progress", "verified", "unverified", "blocked"])
    .default("ready"),
});

const PlanSchema = z.object({
  id: z.string(),
  ideaId: z.string(),
  tasks: z.array(PlanTaskSchema),
  constraints: z.array(z.string()).default([]),
  assumptions: z.array(z.string()).default([]),
  unknowns: z.array(z.string()).default([]),
  status: z.enum(["draft", "active", "stale", "superseded"]).default("active"),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

const PlansSchema = z.object({
  plans: z.array(PlanSchema),
});

// ---------------------------------------------------------------------------
// Shared context type
// ---------------------------------------------------------------------------

type Thought = z.infer<typeof ThoughtSchema>;
type Classification = z.infer<typeof ClassificationSchema>;
type Idea = z.infer<typeof IdeaSchema>;
type Todo = z.infer<typeof TodoSchema>;
type Action = z.infer<typeof ActionSchema>;
type Question = z.infer<typeof QuestionSchema>;
type Plan = z.infer<typeof PlanSchema>;
type PlanTask = z.infer<typeof PlanTaskSchema>;

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
// LLM helpers (OpenAI-compatible /v1/chat/completions, works with Ollama)
// ---------------------------------------------------------------------------

type ChatMessage = { role: "system" | "user"; content: string };

/** Resolve LLM config from global args, applying defaults. */
export function llmConfig(globalArgs: GlobalArgs) {
  return {
    baseUrl: (globalArgs.llmBaseUrl ?? "http://localhost:11434").replace(
      /\/+$/,
      "",
    ),
    model: globalArgs.llmModel ?? "deepseek-v4-flash:cloud",
    apiKey: globalArgs.llmApiKey,
    temperature: globalArgs.llmTemperature ?? 0.1,
    timeoutSec: globalArgs.llmTimeoutSec ?? 120,
  };
}

/**
 * Call an OpenAI-compatible /v1/chat/completions endpoint. Returns the assistant
 * message content, or null when the LLM is unavailable (so callers can degrade
 * gracefully rather than throw).
 */
export async function chatCompletion(
  globalArgs: GlobalArgs,
  messages: ChatMessage[],
  opts?: { json?: boolean },
): Promise<string | null> {
  const cfg = llmConfig(globalArgs);
  const url = `${cfg.baseUrl}/v1/chat/completions`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  const body = {
    model: cfg.model,
    messages,
    temperature: cfg.temperature,
    stream: false,
    ...(opts?.json ? { response_format: { type: "json_object" } } : {}),
  };
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(cfg.timeoutSec * 1000),
    });
    if (!resp.ok) return null;
    const data = await resp.json() as {
      choices?: { message?: { content?: string } }[];
    };
    return data.choices?.[0]?.message?.content ?? null;
  } catch {
    return null;
  }
}

/** Parse a JSON object out of an LLM response, tolerating markdown fences. */
export function parseLlmJson<T>(text: string): T | null {
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    // Fall back to the first {...} block.
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]) as T;
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Phase 1 state helpers + LLM prompts
// ---------------------------------------------------------------------------

type FactoryState = {
  thoughts: Thought[];
  classifications: Classification[];
  ideas: Idea[];
  todos: Todo[];
  actions: Action[];
  questions: Question[];
  plans: Plan[];
};

async function readState(context: MethodContext): Promise<FactoryState> {
  const inbox = (await context.readResource("inbox")) as
    | { thoughts: Thought[] }
    | null;
  const classification = (await context.readResource("classification")) as
    | { classifications: Classification[] }
    | null;
  const ideas = (await context.readResource("ideas")) as
    | { ideas: Idea[] }
    | null;
  const todos = (await context.readResource("todos")) as
    | { todos: Todo[] }
    | null;
  const actions = (await context.readResource("actions")) as
    | { actions: Action[] }
    | null;
  const questions = (await context.readResource("questions")) as
    | { questions: Question[] }
    | null;
  const plans = (await context.readResource("plans")) as
    | { plans: Plan[] }
    | null;
  return {
    thoughts: inbox?.thoughts ?? [],
    classifications: classification?.classifications ?? [],
    ideas: ideas?.ideas ?? [],
    todos: todos?.todos ?? [],
    actions: actions?.actions ?? [],
    questions: questions?.questions ?? [],
    plans: plans?.plans ?? [],
  };
}

async function writeState(
  context: MethodContext,
  s: FactoryState,
): Promise<void> {
  await context.writeResource("inbox", "inbox", { thoughts: s.thoughts });
  await context.writeResource("classification", "classification", {
    classifications: s.classifications,
    classifiedAt: new Date().toISOString(),
  });
  await context.writeResource("ideas", "ideas", { ideas: s.ideas });
  await context.writeResource("todos", "todos", { todos: s.todos });
  await context.writeResource("actions", "actions", { actions: s.actions });
  await context.writeResource("questions", "questions", {
    questions: s.questions,
  });
  await context.writeResource("plans", "plans", { plans: s.plans });
}

const CLUSTER_SYSTEM =
  `You are an idea-clustering assistant. Group related thoughts into common ideas. ` +
  `Be conservative: only merge thoughts that are clearly the same idea. ` +
  `If you are unsure whether two thoughts belong together, or what a thought means, ` +
  `ask a clarifying question instead of guessing — prefer asking over guessing. ` +
  `Return JSON: {"ideas":[{"title":"...","body":"...","thoughtIds":["..."]}],"questions":[{"text":"...","about":"..."}]}.`;

const MERGE_SYSTEM =
  `You are an idea-merging assistant. Given a thought and existing ideas, decide which ` +
  `idea it belongs to (or whether it is a new idea), and merge it in. ` +
  `If ambiguous, ask a clarifying question instead of guessing. ` +
  `Return JSON: {"ideaId":"<existing id or null for new>","body":"<merged body>","questions":[{"text":"...","about":"..."}]}.`;

const REFINE_SYSTEM =
  `You are an idea-refinement assistant. Given a thought and an idea, refine the idea's ` +
  `body to incorporate the thought. If ambiguous, ask a clarifying question instead of guessing. ` +
  `Return JSON: {"body":"<refined body>","questions":[{"text":"...","about":"..."}]}.`;

function buildClusterPrompt(thoughts: Thought[], userPrompt?: string): string {
  const lines = thoughts.map((t) => `- [${t.id}] ${t.raw}`).join("\n");
  return `Thoughts:\n${lines || "(none)"}\n\n${
    userPrompt ? `User instruction: ${userPrompt}\n\n` : ""
  }Group these into common ideas.`;
}

function buildMergePrompt(
  thought: Thought,
  ideas: Idea[],
  userPrompt?: string,
): string {
  const lines = ideas.map((i) => `- [${i.id}] ${i.title}: ${i.body}`).join(
    "\n",
  );
  return `Thought: ${thought.raw}\n\nExisting ideas:\n${lines || "(none)"}\n\n${
    userPrompt ? `User instruction: ${userPrompt}\n\n` : ""
  }Which idea does this thought belong to?`;
}

function buildRefinePrompt(
  thought: Thought,
  idea: Idea,
  userPrompt?: string,
): string {
  return `Thought: ${thought.raw}\n\nIdea [${idea.id}] ${idea.title}:\n${idea.body}\n\n${
    userPrompt ? `User instruction: ${userPrompt}\n\n` : ""
  }Refine the idea to incorporate the thought.`;
}

const PLAN_SYSTEM =
  `You are a software-factory planning assistant. Given an idea, produce a testable ` +
  `implementation plan. Decompose the idea into concrete tasks. For each task give: ` +
  `title, description, acceptanceCriteria (specific, observable, testable statements), ` +
  `testStrategy (one of unit|integration|property|golden|contract|manual), dependencies ` +
  `(task titles it depends on), and effort (small|medium|large). Also identify: ` +
  `constraints (dependencies, limits, risks), assumptions (things you are assuming), and ` +
  `unknowns (things that are unclear and would improve the plan if resolved). ` +
  `If the idea is under-specified, ask clarifying questions instead of guessing — ` +
  `prefer asking over guessing, because a better-specified idea yields a better plan. ` +
  `Return JSON: {"tasks":[{"title":"...","description":"...","acceptanceCriteria":["..."],"testStrategy":"unit","dependencies":["..."],"effort":"medium"}],"constraints":["..."],"assumptions":["..."],"unknowns":["..."],"questions":[{"text":"...","about":"..."}]}.`;

function buildPlanPrompt(idea: Idea, userPrompt?: string): string {
  return `Idea [${idea.id}] ${idea.title}:\n${idea.body}\n\n${
    userPrompt ? `User instruction: ${userPrompt}\n\n` : ""
  }Produce a testable implementation plan for this idea.`;
}

/** Mark any non-superseded plan for an idea as stale (reversion guard). */
function markPlansStale(s: FactoryState, ideaId: string): void {
  for (const p of s.plans) {
    if (
      p.ideaId === ideaId && (p.status === "active" || p.status === "draft")
    ) {
      p.status = "stale";
      p.updatedAt = new Date().toISOString();
    }
  }
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
      description: "Common ideas produced from thoughts (Phase 1)",
      schema: IdeasSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    todos: {
      description: "Action items produced from thoughts (Phase 1)",
      schema: TodosSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    actions: {
      description: "Audit trail of cluster/merge/refine steps (LLM and manual)",
      schema: ActionsSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    questions: {
      description: "Clarifying questions the LLM asked, and their answers",
      schema: QuestionsSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    plans: {
      description:
        "Task breakdowns with acceptance criteria + test strategy (Phase 2)",
      schema: PlansSchema,
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

    routeTodos: {
      description:
        "Route todo-classified thoughts into the todos resource with the right list (deterministic; the todo lifecycle lives outside the factory).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: MethodContext,
      ) => {
        const s = await readState(context);
        const now = new Date().toISOString();
        let created = 0;
        for (const c of s.classifications) {
          if (c.kind !== "todo" || c.routed) continue;
          const thought = s.thoughts.find((t) => t.id === c.thoughtId);
          if (!thought) continue;
          s.todos.push({
            id: genId(),
            title: toTitle(thought.raw),
            list: inferTodoList(thought.raw),
            status: "open",
            sourceThoughtId: thought.id,
            createdAt: now,
          });
          c.routed = true;
          created++;
        }
        await writeState(context, s);
        context.logger?.info("Routed {n} todos", { n: created });
        return { dataHandles: [], createdTodos: created };
      },
    },

    // -----------------------------------------------------------------------
    // Phase 1: cluster / merge / refine (LLM + manual), revert, modify, answer
    // -----------------------------------------------------------------------

    clusterThoughts: {
      description:
        "Group related thoughts into common ideas. LLM mode (default) asks the LLM to cluster; manual mode applies explicit groups. Records an action for each idea.",
      arguments: z.object({
        userPrompt: z.string().optional().describe(
          "Extra instruction given to the LLM alongside the thoughts",
        ),
        mode: z.enum(["llm", "manual"]).default("llm"),
        groups: z.array(z.object({
          title: z.string(),
          body: z.string(),
          thoughtIds: z.array(z.string()),
        })).optional().describe("Explicit groups (manual mode)"),
      }),
      execute: async (
        args: {
          userPrompt?: string;
          mode: "llm" | "manual";
          groups?: { title: string; body: string; thoughtIds: string[] }[];
        },
        context: MethodContext,
      ) => {
        const s = await readState(context);
        const now = new Date().toISOString();
        const clusteredIds = new Set(
          s.ideas.flatMap((i) => i.sourceThoughtIds),
        );
        // Only cluster software-idea thoughts. Todo thoughts go to the todo
        // list (routeTodos); note/noise park in the Thoughts column.
        const ideaKinds = new Set([
          "new-idea",
          "refinement",
          "minor-rethink",
          "major-rethink",
          "duplicate",
        ]);
        const open = s.thoughts.filter((t) => {
          if (clusteredIds.has(t.id)) return false;
          const c = s.classifications.find((x) => x.thoughtId === t.id);
          return !c || ideaKinds.has(c.kind);
        });

        if (open.length === 0) {
          return { dataHandles: [], clustered: 0, skipped: "no open thoughts" };
        }

        let groups: { title: string; body: string; thoughtIds: string[] }[] =
          [];
        let llmResponse: string | null = null;
        let questions: { text: string; about: string }[] = [];

        if (args.mode === "manual") {
          groups = args.groups ?? [];
        } else {
          const prompt = buildClusterPrompt(open, args.userPrompt);
          const raw = await chatCompletion(context.globalArgs, [
            { role: "system", content: CLUSTER_SYSTEM },
            { role: "user", content: prompt },
          ], { json: true });
          llmResponse = raw;
          if (raw) {
            const parsed = parseLlmJson<{
              ideas?: { title: string; body: string; thoughtIds: string[] }[];
              questions?: { text: string; about: string }[];
            }>(raw);
            groups = parsed?.ideas ?? [];
            questions = parsed?.questions ?? [];
          }
        }

        const created: string[] = [];
        for (const g of groups) {
          const idea: Idea = {
            id: genId(),
            title: g.title,
            body: g.body,
            status: "captured",
            sourceThoughtIds: g.thoughtIds,
            createdAt: now,
            updatedAt: now,
          };
          s.ideas.push(idea);
          created.push(idea.id);
          s.actions.push({
            id: genId(),
            step: "cluster",
            actor: args.mode === "manual" ? "manual" : "llm",
            inputIds: g.thoughtIds,
            outputId: idea.id,
            reasoning: args.mode === "manual"
              ? "manual cluster"
              : "LLM cluster",
            userPrompt: args.userPrompt ?? null,
            llmResponse,
            before: null,
            status: "applied",
            appliedAt: now,
            revertedAt: null,
          });
        }
        for (const q of questions) {
          s.questions.push({
            id: genId(),
            actionId: null,
            ideaId: null,
            text: q.text,
            about: q.about,
            askedAt: now,
            answer: null,
            answeredAt: null,
          });
        }

        await writeState(context, s);
        context.logger?.info("Clustered {n} ideas, {q} questions", {
          n: created.length,
          q: questions.length,
        });
        return {
          dataHandles: [],
          createdIdeas: created.length,
          questions: questions.length,
        };
      },
    },

    mergeIntoIdea: {
      description:
        "Fold a thought into an existing idea (or create a new one). LLM mode decides the target; manual mode uses the given ideaId/body.",
      arguments: z.object({
        thoughtId: z.string(),
        ideaId: z.string().optional(),
        body: z.string().optional(),
        userPrompt: z.string().optional(),
        mode: z.enum(["llm", "manual"]).default("llm"),
      }),
      execute: async (
        args: {
          thoughtId: string;
          ideaId?: string;
          body?: string;
          userPrompt?: string;
          mode: "llm" | "manual";
        },
        context: MethodContext,
      ) => {
        const s = await readState(context);
        const now = new Date().toISOString();
        const thought = s.thoughts.find((t) => t.id === args.thoughtId);
        if (!thought) return { dataHandles: [], error: "thought not found" };

        let targetId = args.ideaId ?? null;
        let mergedBody = args.body ?? null;
        let llmResponse: string | null = null;
        let questions: { text: string; about: string }[] = [];

        if (args.mode === "llm") {
          const raw = await chatCompletion(context.globalArgs, [
            { role: "system", content: MERGE_SYSTEM },
            {
              role: "user",
              content: buildMergePrompt(thought, s.ideas, args.userPrompt),
            },
          ], { json: true });
          llmResponse = raw;
          if (raw) {
            const parsed = parseLlmJson<{
              ideaId?: string | null;
              title?: string;
              body?: string;
              questions?: { text: string; about: string }[];
            }>(raw);
            targetId = parsed?.ideaId ?? null;
            mergedBody = parsed?.body ?? null;
            questions = parsed?.questions ?? [];
          }
        }

        let idea: Idea | undefined = targetId
          ? s.ideas.find((i) => i.id === targetId)
          : undefined;
        const before = idea
          ? {
            ideaId: idea.id,
            body: idea.body,
            sourceThoughtIds: [...idea.sourceThoughtIds],
          }
          : null;

        if (!idea) {
          idea = {
            id: genId(),
            title: toTitle(thought.raw),
            body: mergedBody ?? thought.raw,
            status: "captured",
            sourceThoughtIds: [thought.id],
            createdAt: now,
            updatedAt: now,
          };
          s.ideas.push(idea);
        } else {
          if (mergedBody) idea.body = mergedBody;
          if (!idea.sourceThoughtIds.includes(thought.id)) {
            idea.sourceThoughtIds.push(thought.id);
          }
          idea.updatedAt = now;
        }
        markPlansStale(s, idea.id);

        s.actions.push({
          id: genId(),
          step: "merge",
          actor: args.mode === "manual" ? "manual" : "llm",
          inputIds: [thought.id],
          outputId: idea.id,
          reasoning: args.mode === "manual" ? "manual merge" : "LLM merge",
          userPrompt: args.userPrompt ?? null,
          llmResponse,
          before,
          status: "applied",
          appliedAt: now,
          revertedAt: null,
        });
        for (const q of questions) {
          s.questions.push({
            id: genId(),
            actionId: null,
            ideaId: idea.id,
            text: q.text,
            about: q.about,
            askedAt: now,
            answer: null,
            answeredAt: null,
          });
        }

        await writeState(context, s);
        return {
          dataHandles: [],
          ideaId: idea.id,
          questions: questions.length,
        };
      },
    },

    refineIdea: {
      description:
        "Update an idea's body from a thought. LLM mode refines; manual mode uses the given body.",
      arguments: z.object({
        thoughtId: z.string(),
        ideaId: z.string(),
        body: z.string().optional(),
        userPrompt: z.string().optional(),
        mode: z.enum(["llm", "manual"]).default("llm"),
      }),
      execute: async (
        args: {
          thoughtId: string;
          ideaId: string;
          body?: string;
          userPrompt?: string;
          mode: "llm" | "manual";
        },
        context: MethodContext,
      ) => {
        const s = await readState(context);
        const now = new Date().toISOString();
        const thought = s.thoughts.find((t) => t.id === args.thoughtId);
        const idea = s.ideas.find((i) => i.id === args.ideaId);
        if (!thought || !idea) {
          return { dataHandles: [], error: "thought or idea not found" };
        }

        let refinedBody = args.body ?? null;
        let llmResponse: string | null = null;
        let questions: { text: string; about: string }[] = [];

        if (args.mode === "llm") {
          const raw = await chatCompletion(context.globalArgs, [
            { role: "system", content: REFINE_SYSTEM },
            {
              role: "user",
              content: buildRefinePrompt(thought, idea, args.userPrompt),
            },
          ], { json: true });
          llmResponse = raw;
          if (raw) {
            const parsed = parseLlmJson<{
              body?: string;
              questions?: { text: string; about: string }[];
            }>(raw);
            refinedBody = parsed?.body ?? null;
            questions = parsed?.questions ?? [];
          }
        }

        const before = { ideaId: idea.id, body: idea.body };
        if (refinedBody) {
          idea.body = refinedBody;
          idea.updatedAt = now;
        }
        if (!idea.sourceThoughtIds.includes(thought.id)) {
          idea.sourceThoughtIds.push(thought.id);
        }
        markPlansStale(s, idea.id);

        s.actions.push({
          id: genId(),
          step: "refine",
          actor: args.mode === "manual" ? "manual" : "llm",
          inputIds: [thought.id],
          outputId: idea.id,
          reasoning: args.mode === "manual" ? "manual refine" : "LLM refine",
          userPrompt: args.userPrompt ?? null,
          llmResponse,
          before,
          status: "applied",
          appliedAt: now,
          revertedAt: null,
        });
        for (const q of questions) {
          s.questions.push({
            id: genId(),
            actionId: null,
            ideaId: idea.id,
            text: q.text,
            about: q.about,
            askedAt: now,
            answer: null,
            answeredAt: null,
          });
        }

        await writeState(context, s);
        return {
          dataHandles: [],
          ideaId: idea.id,
          questions: questions.length,
        };
      },
    },

    revertAction: {
      description:
        "Revert a cluster/merge/refine action, restoring the prior state.",
      arguments: z.object({ actionId: z.string() }),
      execute: async (
        args: { actionId: string },
        context: MethodContext,
      ) => {
        const s = await readState(context);
        const action = s.actions.find((a) => a.id === args.actionId);
        if (!action || action.status !== "applied") {
          return { dataHandles: [], error: "action not found or not applied" };
        }
        const now = new Date().toISOString();

        if (action.step === "cluster") {
          const idea = s.ideas.find((i) => i.id === action.outputId);
          if (idea) idea.status = "abandoned";
        } else if (action.before) {
          const b = action.before as {
            ideaId: string;
            body: string;
            sourceThoughtIds?: string[];
          };
          const idea = s.ideas.find((i) => i.id === b.ideaId);
          if (idea) {
            idea.body = b.body;
            if (b.sourceThoughtIds) idea.sourceThoughtIds = b.sourceThoughtIds;
            idea.updatedAt = now;
          }
        }

        action.status = "reverted";
        action.revertedAt = now;
        await writeState(context, s);
        return { dataHandles: [], reverted: action.id };
      },
    },

    modifyAction: {
      description:
        "Modify the result of an action (e.g. rewrite the idea body).",
      arguments: z.object({
        actionId: z.string(),
        title: z.string().optional(),
        body: z.string().optional(),
      }),
      execute: async (
        args: { actionId: string; title?: string; body?: string },
        context: MethodContext,
      ) => {
        const s = await readState(context);
        const action = s.actions.find((a) => a.id === args.actionId);
        if (!action || !action.outputId) {
          return { dataHandles: [], error: "action not found" };
        }
        const idea = s.ideas.find((i) => i.id === action.outputId);
        if (!idea) return { dataHandles: [], error: "idea not found" };
        if (args.title) idea.title = args.title;
        if (args.body) idea.body = args.body;
        idea.updatedAt = new Date().toISOString();
        action.status = "modified";
        await writeState(context, s);
        return { dataHandles: [], modified: idea.id };
      },
    },

    answerQuestion: {
      description: "Record the user's answer to an LLM question.",
      arguments: z.object({ questionId: z.string(), answer: z.string() }),
      execute: async (
        args: { questionId: string; answer: string },
        context: MethodContext,
      ) => {
        const s = await readState(context);
        const q = s.questions.find((x) => x.id === args.questionId);
        if (!q) return { dataHandles: [], error: "question not found" };
        q.answer = args.answer;
        q.answeredAt = new Date().toISOString();
        await writeState(context, s);
        return { dataHandles: [], answered: q.id };
      },
    },

    planIdea: {
      description:
        "Produce a testable implementation plan for an idea: tasks with acceptance criteria + test strategy, plus constraints/assumptions/unknowns. LLM mode (default) or manual mode (explicit tasks). Records an action and any clarifying questions.",
      arguments: z.object({
        ideaId: z.string(),
        userPrompt: z.string().optional(),
        mode: z.enum(["llm", "manual"]).default("llm"),
        tasks: z.array(z.object({
          title: z.string(),
          description: z.string(),
          acceptanceCriteria: z.array(z.string()),
          testStrategy: z.enum([
            "unit",
            "integration",
            "property",
            "golden",
            "contract",
            "manual",
          ]),
          dependencies: z.array(z.string()).optional(),
          effort: z.enum(["small", "medium", "large"]).optional(),
        })).optional(),
      }),
      execute: async (
        args: {
          ideaId: string;
          userPrompt?: string;
          mode: "llm" | "manual";
          tasks?: {
            title: string;
            description: string;
            acceptanceCriteria: string[];
            testStrategy: PlanTask["testStrategy"];
            dependencies?: string[];
            effort?: PlanTask["effort"];
          }[];
        },
        context: MethodContext,
      ) => {
        const s = await readState(context);
        const now = new Date().toISOString();
        const idea = s.ideas.find((i) => i.id === args.ideaId);
        if (!idea) return { dataHandles: [], error: "idea not found" };

        let tasks: PlanTask[] = [];
        let constraints: string[] = [];
        let assumptions: string[] = [];
        let unknowns: string[] = [];
        let llmResponse: string | null = null;
        let questions: { text: string; about: string }[] = [];

        if (args.mode === "manual") {
          tasks = (args.tasks ?? []).map((t) => ({
            id: genId(),
            title: t.title,
            description: t.description,
            acceptanceCriteria: t.acceptanceCriteria,
            testStrategy: t.testStrategy,
            dependencies: t.dependencies ?? [],
            effort: t.effort ?? "medium",
            status: "ready",
          }));
        } else {
          const raw = await chatCompletion(context.globalArgs, [
            { role: "system", content: PLAN_SYSTEM },
            { role: "user", content: buildPlanPrompt(idea, args.userPrompt) },
          ], { json: true });
          llmResponse = raw;
          if (raw) {
            const parsed = parseLlmJson<{
              tasks?: {
                title: string;
                description: string;
                acceptanceCriteria?: string[];
                testStrategy?: PlanTask["testStrategy"];
                dependencies?: string[];
                effort?: PlanTask["effort"];
              }[];
              constraints?: string[];
              assumptions?: string[];
              unknowns?: string[];
              questions?: { text: string; about: string }[];
            }>(raw);
            tasks = (parsed?.tasks ?? []).map((t) => ({
              id: genId(),
              title: t.title,
              description: t.description,
              acceptanceCriteria: t.acceptanceCriteria ?? [],
              testStrategy: t.testStrategy ?? "manual",
              dependencies: t.dependencies ?? [],
              effort: t.effort ?? "medium",
              status: "ready",
            }));
            constraints = parsed?.constraints ?? [];
            assumptions = parsed?.assumptions ?? [];
            unknowns = parsed?.unknowns ?? [];
            questions = parsed?.questions ?? [];
          }
        }

        // Re-planning supersedes any prior plan for this idea.
        for (const p of s.plans) {
          if (p.ideaId === idea.id && p.status !== "superseded") {
            p.status = "superseded";
          }
        }

        const plan: Plan = {
          id: genId(),
          ideaId: idea.id,
          tasks,
          constraints,
          assumptions,
          unknowns,
          status: unknowns.length > 0 ? "draft" : "active",
          createdAt: now,
          updatedAt: now,
        };
        s.plans.push(plan);

        s.actions.push({
          id: genId(),
          step: "plan",
          actor: args.mode === "manual" ? "manual" : "llm",
          inputIds: [idea.id],
          outputId: plan.id,
          reasoning: args.mode === "manual" ? "manual plan" : "LLM plan",
          userPrompt: args.userPrompt ?? null,
          llmResponse,
          before: null,
          status: "applied",
          appliedAt: now,
          revertedAt: null,
        });
        for (const q of questions) {
          s.questions.push({
            id: genId(),
            actionId: null,
            ideaId: idea.id,
            text: q.text,
            about: q.about,
            askedAt: now,
            answer: null,
            answeredAt: null,
          });
        }

        await writeState(context, s);
        context.logger?.info(
          "Planned idea {id}: {tasks} tasks, {unknowns} unknowns, {questions} questions",
          {
            id: idea.id,
            tasks: tasks.length,
            unknowns: unknowns.length,
            questions: questions.length,
          },
        );
        return {
          dataHandles: [],
          planId: plan.id,
          tasks: tasks.length,
          unknowns: unknowns.length,
          questions: questions.length,
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
        const actions = ((await context.readResource("actions")) as
          | { actions: Action[] }
          | null)?.actions ?? [];
        const questions = ((await context.readResource("questions")) as
          | { questions: Question[] }
          | null)?.questions ?? [];
        const plans = ((await context.readResource("plans")) as
          | { plans: Plan[] }
          | null)?.plans ?? [];

        const html = renderKanban(
          {
            thoughts: inbox,
            classifications,
            ideas,
            todos,
            actions,
            questions,
            plans,
          },
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
  actions: Action[];
  questions: Question[];
  plans: Plan[];
};

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Render a kanban page: Thoughts, Ideas, Todos, plus actions and questions. */
export function renderKanban(d: BoardData, generatedAt: string): string {
  const classFor = (id: string) =>
    d.classifications.find((x) => x.thoughtId === id) ?? null;

  const questionHtml = (q: Question) => {
    const answerHtml = q.answer
      ? `<div class="question-answer"><span class="qa-label">answer</span> ${
        esc(q.answer)
      }</div>`
      : `<form class="inline" action="/api/answer" method="post"><input type="hidden" name="questionId" value="${
        esc(q.id)
      }"><input type="text" name="answer" placeholder="Answer…"><button type="submit">answer</button></form>`;
    return `<div class="question ${
      q.answer ? "answered" : ""
    }"><div class="question-text">${esc(q.text)}</div>${answerHtml}</div>`;
  };

  // Cluster questions (no specific idea yet) live in the Thoughts column.
  const clusterQuestions = d.questions.filter((q) => !q.ideaId)
    .map(questionHtml).join("");

  const thoughtCards = d.thoughts.map((t) => {
    const c = classFor(t.id);
    const meta = c
      ? `${c.kind} · ${(c.confidence * 100).toFixed(0)}%`
      : "unclassified";
    return `<div class="card thoughts-card"><div class="card-title">${
      esc(toTitle(t.raw))
    }</div><div class="card-meta">${esc(meta)}</div><div class="card-body">${
      esc(t.raw)
    }</div></div>`;
  }).join("\n");

  const ideaCards = d.ideas.filter((i) => i.status !== "abandoned").map((i) => {
    const acts = d.actions.filter((a) => a.outputId === i.id);
    const actHtml = acts.map((a) =>
      `<div class="action ${esc(a.status)}"><span class="act-step">${
        esc(a.step)
      }</span> · <span class="act-actor">${esc(a.actor)}</span>${
        a.reasoning ? ` — ${esc(a.reasoning)}` : ""
      } <span class="act-status">${esc(a.status)}</span>${
        a.status === "applied"
          ? `<form class="inline" action="/api/revert" method="post"><input type="hidden" name="actionId" value="${
            esc(a.id)
          }"><button type="submit">revert</button></form>`
          : ""
      }</div>`
    ).join("");
    const qs = d.questions.filter((q) => q.ideaId === i.id);
    const qHtml = qs.length
      ? `<div class="questions-inline"><div class="questions-label">questions</div>${
        qs.map(questionHtml).join("")
      }</div>`
      : "";
    return `<div class="card idea-card"><div class="card-title">${
      esc(i.title)
    }</div><div class="card-meta">${
      esc(i.status)
    } · ${i.sourceThoughtIds.length} thought(s)</div><div class="card-body">${
      esc(i.body)
    }</div>${
      actHtml ? `<div class="actions">${actHtml}</div>` : ""
    }${qHtml}<form class="inline" action="/api/plan" method="post"><input type="hidden" name="ideaId" value="${
      esc(i.id)
    }"><input type="text" name="userPrompt" placeholder="Optional planning instruction…"><button type="submit">plan</button></form><form class="inline" action="/api/modify" method="post"><input type="hidden" name="actionId" value="${
      esc(acts[0]?.id ?? "")
    }"><input type="text" name="body" placeholder="Edit idea body…"><button type="submit">modify</button></form></div>`;
  }).join("\n");

  const planCards = d.plans.filter((p) => p.status !== "superseded").map(
    (p) => {
      const idea = d.ideas.find((i) => i.id === p.ideaId);
      const tasks = p.tasks.map((t) =>
        `<div class="task"><div class="task-title">${
          esc(t.title)
        } <span class="task-meta">${esc(t.testStrategy)} · ${
          esc(t.effort)
        }</span></div><ul class="criteria">${
          t.acceptanceCriteria.map((c) => `<li>${esc(c)}</li>`).join("")
        }</ul></div>`
      ).join("");
      const extras = [
        p.constraints.length
          ? `<div class="plan-extra"><b>constraints:</b> ${
            esc(p.constraints.join("; "))
          }</div>`
          : "",
        p.assumptions.length
          ? `<div class="plan-extra"><b>assumptions:</b> ${
            esc(p.assumptions.join("; "))
          }</div>`
          : "",
        p.unknowns.length
          ? `<div class="plan-extra unknown"><b>unknowns:</b> ${
            esc(p.unknowns.join("; "))
          }</div>`
          : "",
      ].join("");
      return `<div class="card plan-card"><div class="card-title">${
        esc(idea?.title ?? p.ideaId)
      }</div><div class="card-meta">plan · ${
        esc(p.status)
      } · ${p.tasks.length} task(s)</div>${tasks}${extras}</div>`;
    },
  ).join("\n");

  const todoCards = d.todos.map((t) =>
    `<div class="card todo-card"><div class="card-title">${
      esc(t.title)
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
  .capture, .process { padding:12px 20px; background:#fff; border-bottom:1px solid var(--line); }
  .capture form, .process form { display:flex; gap:8px; }
  .capture input[type=text], .process input[type=text] { flex:1; padding:10px 12px; border:1px solid var(--line); border-radius:8px; font-size:14px; }
  .capture button, .process button { padding:10px 16px; border:0; border-radius:8px; background:#18181b; color:#fff; font-size:14px; cursor:pointer; }
  .board { display:grid; grid-template-columns:repeat(4, 1fr); gap:14px; padding:20px; align-items:start; }
  @media (max-width:1100px){ .board{ grid-template-columns:repeat(2, 1fr); } }
  @media (max-width:700px){ .board{ grid-template-columns:1fr; } }
  .column { background:var(--card); border:1px solid var(--line); border-radius:12px; overflow:hidden; }
  .column-head { padding:10px 14px; font-weight:600; font-size:13px; border-bottom:1px solid var(--line); background:#fafafa; display:flex; justify-content:space-between; }
  .count { color:var(--muted); font-weight:400; }
  .column-body { padding:10px; display:flex; flex-direction:column; gap:8px; min-height:120px; }
  .card { border:1px solid var(--line); border-radius:8px; padding:10px 12px; background:#fff; }
  .card-title { font-weight:600; font-size:14px; margin-bottom:2px; }
  .card-meta { font-size:11px; color:var(--muted); text-transform:capitalize; margin-bottom:4px; }
  .card-body { font-size:13px; color:#3f3f46; }
  .empty { color:var(--muted); font-size:12px; padding:8px; }
  .actions { margin-top:8px; border-top:1px solid var(--line); padding-top:6px; }
  .action { font-size:11px; color:var(--muted); margin-bottom:4px; }
  .action .act-step { font-weight:600; color:#18181b; }
  .action .act-status { text-transform:uppercase; font-size:10px; }
  .action.reverted .act-status { color:#b91c1c; }
  .action.modified .act-status { color:#b45309; }
  .inline { display:flex; gap:6px; margin-top:6px; }
  .inline input[type=text] { flex:1; padding:6px 8px; border:1px solid var(--line); border-radius:6px; font-size:12px; }
  .inline button { padding:6px 10px; border:0; border-radius:6px; background:#e4e4e7; color:#18181b; font-size:12px; cursor:pointer; }
  .questions { padding:0 20px 20px; }
  .questions h2 { font-size:14px; margin:12px 0 8px; }
  .task { border-top:1px solid var(--line); padding-top:6px; margin-top:6px; }
  .task-title { font-weight:600; font-size:12px; }
  .task-meta { color:var(--muted); font-weight:400; font-size:10px; text-transform:capitalize; }
  .criteria { margin:4px 0 0 16px; padding:0; font-size:11px; color:#3f3f46; }
  .plan-extra { font-size:11px; color:var(--muted); margin-top:4px; }
  .plan-extra.unknown { color:#b45309; }
  .questions-inline { margin-top:8px; border-top:1px dashed var(--line); padding-top:6px; }
  .questions-label { font-size:10px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); margin-bottom:4px; }
  .question { background:#fef3c7; border:1px solid #fde68a; border-radius:6px; padding:6px 8px; margin:4px 0; }
  .question-text { font-size:12px; color:#78350f; margin-bottom:4px; }
  .question.answered { background:#ecfdf5; border-color:#a7f3d0; }
  .question.answered .question-text { color:#065f46; }
  .question-answer { font-size:12px; color:#065f46; }
  .qa-label { font-size:10px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); }
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
<section class="process">
  <form action="/api/cluster" method="post">
    <input type="text" name="userPrompt" placeholder="Optional instruction for the LLM (e.g. 'prefer merging over forking')…">
    <button type="submit">Cluster thoughts → ideas</button>
  </form>
</section>
<main class="board">
  ${col("Thoughts", clusterQuestions + thoughtCards)}
  ${col("Ideas", ideaCards)}
  ${col("Plans", planCards)}
  ${col("Todos", todoCards)}
</main>
<script>document.querySelectorAll('[data-generated]').forEach(function(el){var d=new Date(el.getAttribute('data-generated'));el.textContent=d.toLocaleString('en-GB');});</script>
</body>
</html>`;
}
