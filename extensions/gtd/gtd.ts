/**
 * @svendowideit/gtd — a native Getting Things Done (GTD) model for swamp.
 *
 * One model, many methods, all data in model data resources. Implements the
 * five GTD steps:
 *   capture → clarify → organize → reflect (weekly/daily review) → engage
 *
 * The web UI is generated as static HTML with htmx for dynamics and served by
 * scripts/gtd-server.ts. The board is responsive: a full dashboard on large
 * screens, a focused "now" view on small screens.
 *
 * @module
 */

import { z } from "npm:zod@4";

// ---------------------------------------------------------------------------
// Global arguments
// ---------------------------------------------------------------------------

const GlobalArgsSchema = z.object({
  outputDir: z.string().optional().describe(
    "Directory to write the rendered board HTML (default ~/.swamp/gtd)",
  ),
  llmBaseUrl: z.string().default("http://localhost:11434").describe(
    "OpenAI-compatible /v1/chat/completions endpoint for LLM assist steps",
  ),
  llmModel: z.string().default("deepseek-v4-flash:cloud").describe(
    "Model name for LLM assist steps",
  ),
  serverPort: z.number().default(8878).describe(
    "Port the GTD web UI server listens on (GTD_PORT).",
  ),
  serveUrl: z.string().default("ws://127.0.0.1:9090").describe(
    "URL of a 'swamp serve' instance the GTD web UI uses as a fast path (SWAMP_SERVE_URL). Optional: the UI falls back to the swamp CLI when unreachable.",
  ),
  serverServiceName: z.string().default("gtd-server").describe(
    "systemd user service name for the GTD web UI server.",
  ),
  serverScriptPath: z.string().optional().describe(
    "Override the path to the gtd-server.ts script (defaults to the bundled script).",
  ),
  boardPath: z.string().optional().describe(
    "Absolute path to the board HTML the server serves (defaults to <outputDir>/board.html).",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

// ---------------------------------------------------------------------------
// Resource schemas
// ---------------------------------------------------------------------------

const InboxItemSchema = z.object({
  id: z.string(),
  raw: z.string(),
  source: z.string().default("manual"),
  capturedAt: z.iso.datetime(),
  status: z.enum(["unprocessed", "processed"]).default("unprocessed"),
});

const InboxSchema = z.object({
  items: z.array(InboxItemSchema),
});

const NextActionSchema = z.object({
  id: z.string(),
  title: z.string(),
  context: z.string().default("@anywhere"),
  priority: z.enum(["low", "medium", "high", "urgent"]).default("medium"),
  energy: z.enum(["low", "medium", "high"]).default("medium"),
  due: z.iso.datetime().nullable().default(null),
  projectId: z.string().nullable().default(null),
  status: z.enum(["open", "in-progress", "done", "cancelled"]).default("open"),
  notes: z.string().default(""),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

const NextActionsSchema = z.object({
  items: z.array(NextActionSchema),
});

const ProjectSchema = z.object({
  id: z.string(),
  title: z.string(),
  outcome: z.string().default(""),
  status: z.enum(["active", "on-hold", "done", "cancelled"]).default("active"),
  nextActionId: z.string().nullable().default(null),
  createdAt: z.iso.datetime(),
});

const ProjectsSchema = z.object({
  items: z.array(ProjectSchema),
});

const WaitingForSchema = z.object({
  id: z.string(),
  title: z.string(),
  delegatee: z.string().default(""),
  expectedBy: z.iso.datetime().nullable().default(null),
  status: z.enum(["waiting", "received", "cancelled"]).default("waiting"),
  createdAt: z.iso.datetime(),
});

const WaitingForSchemaList = z.object({
  items: z.array(WaitingForSchema),
});

const SomedayMaybeSchema = z.object({
  id: z.string(),
  title: z.string(),
  notes: z.string().default(""),
  status: z.enum(["open", "done", "cancelled"]).default("open"),
  createdAt: z.iso.datetime(),
});

const SomedayMaybeListSchema = z.object({
  items: z.array(SomedayMaybeSchema),
});

const CalendarItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  when: z.iso.datetime(),
  duration: z.number().default(30).describe("Duration in minutes"),
  status: z.enum(["scheduled", "done", "cancelled"]).default("scheduled"),
  createdAt: z.iso.datetime(),
});

const CalendarSchema = z.object({
  items: z.array(CalendarItemSchema),
});

const ReferenceSchema = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string().default(""),
  area: z.string().default("reference").describe(
    "PARA area: projects | areas | resources | archives",
  ),
  createdAt: z.iso.datetime(),
});

const ReferenceListSchema = z.object({
  items: z.array(ReferenceSchema),
});

const ContextSchema = z.object({
  name: z.string(),
  label: z.string(),
  icon: z.string().default("📍"),
});

const ContextsSchema = z.object({
  contexts: z.array(ContextSchema),
});

const CompletedSchema = z.object({
  id: z.string(),
  title: z.string(),
  list: z.string(),
  completedAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
});

const CompletedListSchema = z.object({
  items: z.array(CompletedSchema),
});

const ReviewSchema = z.object({
  type: z.enum(["daily", "weekly"]),
  at: z.iso.datetime(),
  inboxCount: z.number(),
  completedCount: z.number(),
  notes: z.string().default(""),
});

const ReviewLogSchema = z.object({
  reviews: z.array(ReviewSchema),
});

// ---------------------------------------------------------------------------
// Method argument schemas
// ---------------------------------------------------------------------------

const CaptureArgsSchema = z.object({
  raw: z.string().describe("The thought / task / idea to capture"),
  source: z.string().optional().describe(
    "Where it came from (email, voice, …)",
  ),
});

const ClarifyArgsSchema = z.object({
  itemId: z.string().optional().describe(
    "Process a single inbox item; omit to process all unprocessed items",
  ),
  kind: z.enum([
    "next-action",
    "project",
    "waiting-for",
    "someday-maybe",
    "calendar",
    "reference",
    "trash",
  ]).optional().describe(
    "Explicit routing; if omitted, infer from the raw text prefixes",
  ),
  context: z.string().optional().describe("Context for a next-action"),
  priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
  due: z.iso.datetime().optional(),
  delegatee: z.string().optional(),
  when: z.iso.datetime().optional(),
  area: z.string().optional(),
});

const OrganizeArgsSchema = z.object({
  itemId: z.string(),
  from: z.string().describe("Source list name"),
  to: z.string().describe("Destination list name"),
  context: z.string().optional(),
  priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
  due: z.iso.datetime().optional(),
  delegatee: z.string().optional(),
  when: z.iso.datetime().optional(),
  area: z.string().optional(),
});

const CompleteArgsSchema = z.object({
  itemId: z.string(),
  list: z.string().describe("List the item currently lives in"),
});

const DelegateArgsSchema = z.object({
  itemId: z.string(),
  delegatee: z.string(),
  expectedBy: z.iso.datetime().optional(),
});

const DeferArgsSchema = z.object({
  itemId: z.string(),
  when: z.iso.datetime().optional().describe(
    "If set, move to calendar; otherwise move to someday-maybe",
  ),
});

const RevertArgsSchema = z.object({
  itemId: z.string(),
  list: z.string().describe("List the item currently lives in"),
});

const EngageArgsSchema = z.object({
  context: z.string().optional().describe("Current context, e.g. @home"),
  time: z.number().optional().describe("Minutes available"),
  energy: z.enum(["low", "medium", "high"]).optional(),
  limit: z.number().default(5).describe("How many suggestions to return"),
});

const RenderBoardArgsSchema = z.object({
  path: z.string().optional().describe(
    "Absolute path to write the board HTML (default ~/.swamp/gtd/board.html)",
  ),
});

// ---------------------------------------------------------------------------
// Shared context type
// ---------------------------------------------------------------------------

type InboxItem = z.infer<typeof InboxItemSchema>;
type NextAction = z.infer<typeof NextActionSchema>;
type Project = z.infer<typeof ProjectSchema>;
type WaitingFor = z.infer<typeof WaitingForSchema>;
type SomedayMaybe = z.infer<typeof SomedayMaybeSchema>;
type CalendarItem = z.infer<typeof CalendarItemSchema>;
type Reference = z.infer<typeof ReferenceSchema>;
type Context = z.infer<typeof ContextSchema>;
type Completed = z.infer<typeof CompletedSchema>;
type Review = z.infer<typeof ReviewSchema>;

type MethodContext = {
  globalArgs: GlobalArgs;
  repoDir: string;
  logger?: { info: (msg: string, props?: Record<string, unknown>) => void };
  extensionFile?: (relPath: string) => string;
  writeResource: (
    specName: string,
    dataName: string,
    data: unknown,
  ) => Promise<{ version: number }>;
  readResource: (
    specName: string,
    dataName?: string,
  ) => Promise<unknown | null>;
  createFileWriter: (
    specName: string,
    dataName: string,
  ) => Promise<{ writeText: (text: string) => Promise<void> }>;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

function newId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

/** Expand a leading `~` to the user's home directory. */
function expandHome(path: string): string {
  const h = Deno.env.get("HOME") ?? "/tmp";
  if (path === "~") return h;
  if (path.startsWith("~/")) return `${h}${path.slice(1)}`;
  return path;
}

/** Run a `swamp` CLI command and capture stdout/stderr/exit code. */
async function runSwampCmd(
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const proc = new Deno.Command("swamp", {
      args,
      stdout: "piped",
      stderr: "piped",
    });
    const out = await proc.output();
    return {
      stdout: new TextDecoder().decode(out.stdout),
      stderr: new TextDecoder().decode(out.stderr),
      code: out.code,
    };
  } catch (err) {
    return {
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
      code: 127,
    };
  }
}

/** Resolve the directory containing the `swamp` binary (for systemd PATH). */
async function resolveSwampDir(): Promise<string> {
  try {
    const proc = new Deno.Command("which", { args: ["swamp"] });
    const out = await proc.output();
    if (out.code === 0) {
      const p = new TextDecoder().decode(out.stdout).trim();
      if (p) return p.slice(0, p.lastIndexOf("/"));
    }
  } catch {
    // fall through to the common install location
  }
  return expandHome("~/.local/bin");
}

async function readList<T>(
  context: MethodContext,
  spec: string,
  fallback: T,
): Promise<T> {
  const v = await context.readResource(spec);
  return (v as T | null) ?? fallback;
}

async function writeList(
  context: MethodContext,
  spec: string,
  data: unknown,
): Promise<void> {
  await context.writeResource(spec, spec, data);
}

const DEFAULT_CONTEXTS: Context[] = [
  { name: "@anywhere", label: "Anywhere", icon: "🌐" },
  { name: "@home", label: "Home", icon: "🏠" },
  { name: "@work", label: "Work", icon: "💼" },
  { name: "@errands", label: "Errands", icon: "🛒" },
  { name: "@phone", label: "Phone", icon: "📞" },
  { name: "@computer", label: "Computer", icon: "💻" },
  { name: "@online", label: "Online", icon: "🌍" },
];

/** The clarify routing kinds, each with an icon and tooltip label. */
const CLARIFY_KINDS: { kind: string; icon: string; label: string }[] = [
  { kind: "next-action", icon: "✅", label: "Next action" },
  // U+FE0E forces text presentation so 🗂/🗄/🗑 render as solid black glyphs
  // (matching the column headings) instead of pale/outlined emoji.
  { kind: "project", icon: "🗂\uFE0E", label: "Project" },
  { kind: "waiting-for", icon: "⏳", label: "Waiting for" },
  { kind: "someday-maybe", icon: "💭", label: "Someday/Maybe" },
  { kind: "calendar", icon: "📅", label: "Calendar" },
  { kind: "reference", icon: "🗄\uFE0E", label: "Reference" },
  { kind: "trash", icon: "🗑\uFE0E", label: "Trash" },
];

/** Infer a routing kind from the raw text using GTD-style prefixes. */
function inferKind(raw: string): {
  kind: NonNullable<z.infer<typeof ClarifyArgsSchema>["kind"]>;
  context?: string;
  delegatee?: string;
  area?: string;
} {
  const t = raw.trim();
  if (/^(someday|maybe)\b/i.test(t)) return { kind: "someday-maybe" };
  if (/^(ref|reference)\b/i.test(t)) {
    const m = t.match(/^(?:ref|reference)\s*:\s*(.*)$/i);
    return { kind: "reference", area: m?.[1] || "resources" };
  }
  if (/^(wait|delegate)\b/i.test(t)) {
    const m = t.match(/^(?:wait|delegate)\s*:\s*(.*)$/i);
    return { kind: "waiting-for", delegatee: m?.[1] || "" };
  }
  if (/^(calendar|on)\b/i.test(t)) return { kind: "calendar" };
  if (/^project\b/i.test(t)) return { kind: "project" };
  if (/^trash\b/i.test(t)) return { kind: "trash" };
  const ctx = t.match(/@(\w+)/)?.[1];
  return { kind: "next-action", context: ctx ? `@${ctx}` : undefined };
}

// ---------------------------------------------------------------------------
// Model definition
// ---------------------------------------------------------------------------

/**
 * The @svendowideit/gtd model type — one model, many methods, all data in
 * model data resources. Implements the five GTD steps (capture, clarify,
 * organize, reflect, engage) and renders a responsive htmx board.
 */
export const model = {
  type: "@svendowideit/gtd",
  version: "2026.09.11.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    inbox: {
      description: "Captured items awaiting clarify",
      schema: InboxSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    "next-actions": {
      description: "Actionable next actions, tagged with context/priority/due",
      schema: NextActionsSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    projects: {
      description: "Outcomes requiring multiple actions",
      schema: ProjectsSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    "waiting-for": {
      description: "Delegated items awaiting someone else",
      schema: WaitingForSchemaList,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    "someday-maybe": {
      description: "Non-committed, maybe-later items",
      schema: SomedayMaybeListSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    calendar: {
      description: "Hard-landscape, time-specific items",
      schema: CalendarSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    reference: {
      description: "Non-actionable reference material (PARA areas)",
      schema: ReferenceListSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    contexts: {
      description: "The context definitions used to tag next actions",
      schema: ContextsSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    completed: {
      description: "Done log for reports",
      schema: CompletedListSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    "review-log": {
      description: "Weekly/daily review history",
      schema: ReviewLogSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
  },
  files: {
    board: {
      description: "GTD board HTML (persisted copy of the rendered page)",
      contentType: "text/html",
      lifetime: "30d",
      garbageCollection: 5,
    },
  },
  methods: {
    capture: {
      description: "Capture a raw item into the inbox for later clarify.",
      arguments: CaptureArgsSchema,
      execute: async (
        args: z.infer<typeof CaptureArgsSchema>,
        context: MethodContext,
      ) => {
        const inbox = await readList<{ items: InboxItem[] }>(
          context,
          "inbox",
          { items: [] },
        );
        const item: InboxItem = {
          id: newId("in"),
          raw: args.raw,
          source: args.source ?? "manual",
          capturedAt: nowIso(),
          status: "unprocessed",
        };
        inbox.items.push(item);
        await writeList(context, "inbox", inbox);
        context.logger?.info("Captured {id}", { id: item.id });
        return {
          dataHandles: [],
          itemId: item.id,
          inboxCount: inbox.items.length,
        };
      },
    },

    clarify: {
      description:
        "Process inbox items: route each to the right GTD list (deterministic prefix routing, optional explicit kind).",
      arguments: ClarifyArgsSchema,
      execute: async (
        args: z.infer<typeof ClarifyArgsSchema>,
        context: MethodContext,
      ) => {
        const inbox = await readList<{ items: InboxItem[] }>(
          context,
          "inbox",
          { items: [] },
        );
        const targets = args.itemId
          ? inbox.items.filter((i) => i.id === args.itemId)
          : inbox.items.filter((i) => i.status === "unprocessed");

        const routed: { itemId: string; to: string }[] = [];

        for (const item of targets) {
          const hint = args.kind
            ? {
              kind: args.kind,
              context: args.context,
              delegatee: args.delegatee,
              area: args.area,
            }
            : inferKind(item.raw);
          const to = await routeItem(context, item, hint, args);
          routed.push({ itemId: item.id, to });
        }

        // Clarify empties the inbox: remove the processed items entirely so
        // they don't linger in the inbox column.
        const processedIds = new Set(targets.map((i) => i.id));
        inbox.items = inbox.items.filter((i) => !processedIds.has(i.id));
        await writeList(context, "inbox", inbox);
        context.logger?.info("Clarified {n} item(s)", { n: routed.length });
        return { dataHandles: [], routed, processed: routed.length };
      },
    },

    organize: {
      description: "Manually move an item between GTD lists.",
      arguments: OrganizeArgsSchema,
      execute: async (
        args: z.infer<typeof OrganizeArgsSchema>,
        context: MethodContext,
      ) => {
        const item = await takeFromList(context, args.from, args.itemId);
        if (!item) {
          throw new Error(`Item ${args.itemId} not found in ${args.from}`);
        }
        const to = await putIntoList(context, args.to, item, {
          context: args.context,
          priority: args.priority,
          due: args.due,
          delegatee: args.delegatee,
          when: args.when,
          area: args.area,
        });
        context.logger?.info("Organized {id} {from} → {to}", {
          id: args.itemId,
          from: args.from,
          to,
        });
        return { dataHandles: [], itemId: args.itemId, from: args.from, to };
      },
    },

    complete: {
      description: "Mark an item done and move it to the completed log.",
      arguments: CompleteArgsSchema,
      execute: async (
        args: z.infer<typeof CompleteArgsSchema>,
        context: MethodContext,
      ) => {
        const item = await takeFromList(context, args.list, args.itemId);
        if (!item) {
          throw new Error(`Item ${args.itemId} not found in ${args.list}`);
        }
        const completed = await readList<{ items: Completed[] }>(
          context,
          "completed",
          { items: [] },
        );
        completed.items.push({
          id: item.id,
          title: item.title,
          list: args.list,
          completedAt: nowIso(),
          createdAt: item.createdAt,
        });
        await writeList(context, "completed", completed);
        context.logger?.info("Completed {id}", { id: args.itemId });
        return { dataHandles: [], itemId: args.itemId, list: args.list };
      },
    },

    delegate: {
      description: "Move an item to waiting-for with a delegatee.",
      arguments: DelegateArgsSchema,
      execute: async (
        args: z.infer<typeof DelegateArgsSchema>,
        context: MethodContext,
      ) => {
        const item = await takeFromList(context, "next-actions", args.itemId);
        if (!item) {
          throw new Error(`Item ${args.itemId} not found in next-actions`);
        }
        const wf = await readList<{ items: WaitingFor[] }>(
          context,
          "waiting-for",
          { items: [] },
        );
        wf.items.push({
          id: item.id,
          title: item.title,
          delegatee: args.delegatee,
          expectedBy: args.expectedBy ?? null,
          status: "waiting",
          createdAt: item.createdAt,
        });
        await writeList(context, "waiting-for", wf);
        context.logger?.info("Delegated {id} to {delegatee}", {
          id: args.itemId,
          delegatee: args.delegatee,
        });
        return {
          dataHandles: [],
          itemId: args.itemId,
          delegatee: args.delegatee,
        };
      },
    },

    defer: {
      description:
        "Defer an item: to the calendar if a time is given, otherwise to someday-maybe.",
      arguments: DeferArgsSchema,
      execute: async (
        args: z.infer<typeof DeferArgsSchema>,
        context: MethodContext,
      ) => {
        const item = await takeFromList(context, "next-actions", args.itemId);
        if (!item) {
          throw new Error(`Item ${args.itemId} not found in next-actions`);
        }
        if (args.when) {
          const cal = await readList<{ items: CalendarItem[] }>(
            context,
            "calendar",
            { items: [] },
          );
          cal.items.push({
            id: item.id,
            title: item.title,
            when: args.when,
            duration: 30,
            status: "scheduled",
            createdAt: item.createdAt,
          });
          await writeList(context, "calendar", cal);
        } else {
          const sm = await readList<{ items: SomedayMaybe[] }>(
            context,
            "someday-maybe",
            { items: [] },
          );
          sm.items.push({
            id: item.id,
            title: item.title,
            notes: "",
            status: "open",
            createdAt: item.createdAt,
          });
          await writeList(context, "someday-maybe", sm);
        }
        context.logger?.info("Deferred {id}", { id: args.itemId });
        return {
          dataHandles: [],
          itemId: args.itemId,
          when: args.when ?? null,
        };
      },
    },

    revert: {
      description: "Move an item back to the inbox for re-clarify.",
      arguments: RevertArgsSchema,
      execute: async (
        args: z.infer<typeof RevertArgsSchema>,
        context: MethodContext,
      ) => {
        const item = await takeFromList(context, args.list, args.itemId);
        if (!item) {
          throw new Error(`Item ${args.itemId} not found in ${args.list}`);
        }
        const inbox = await readList<{ items: InboxItem[] }>(
          context,
          "inbox",
          { items: [] },
        );
        inbox.items.push({
          id: item.id,
          raw: item.title,
          source: "revert",
          capturedAt: nowIso(),
          status: "unprocessed",
        });
        await writeList(context, "inbox", inbox);
        context.logger?.info("Reverted {id} to inbox", { id: args.itemId });
        return { dataHandles: [], itemId: args.itemId, to: "inbox" };
      },
    },

    engage: {
      description:
        "Pick the best next actions for right now, filtered by context, time, and energy.",
      arguments: EngageArgsSchema,
      execute: async (
        args: z.infer<typeof EngageArgsSchema>,
        context: MethodContext,
      ) => {
        const na = await readList<{ items: NextAction[] }>(
          context,
          "next-actions",
          { items: [] },
        );
        const open = na.items.filter((a) =>
          a.status === "open" || a.status === "in-progress"
        );
        const ctx = args.context ?? "@anywhere";
        const inContext = open.filter((a) =>
          a.context === ctx || a.context === "@anywhere"
        );
        const pool = inContext.length ? inContext : open;
        const scored = pool.map((a) => {
          let s = 0;
          if (a.priority === "urgent") s += 100;
          else if (a.priority === "high") s += 60;
          else if (a.priority === "medium") s += 30;
          if (args.energy && a.energy === args.energy) s += 20;
          if (a.due) {
            const days = (new Date(a.due).getTime() - Date.now()) / 86400000;
            if (days < 0) s += 80;
            else if (days < 1) s += 50;
            else if (days < 3) s += 20;
          }
          if (a.status === "in-progress") s += 15;
          return { action: a, score: s };
        });
        scored.sort((a, b) => b.score - a.score);
        const picks = scored.slice(0, args.limit).map((x) => x.action);
        context.logger?.info("Engage: {n} suggestion(s) for {ctx}", {
          n: picks.length,
          ctx,
        });
        return { dataHandles: [], suggestions: picks, context: ctx };
      },
    },

    weeklyReview: {
      description:
        "Run the GTD weekly review: empty the inbox, review projects, next actions, someday-maybe, and waiting-for, then log the review.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: MethodContext,
      ) => {
        const inbox = await readList<{ items: InboxItem[] }>(
          context,
          "inbox",
          { items: [] },
        );
        const unprocessed = inbox.items.filter((i) =>
          i.status === "unprocessed"
        );
        const completed = await readList<{ items: Completed[] }>(
          context,
          "completed",
          { items: [] },
        );
        const log = await readList<{ reviews: Review[] }>(
          context,
          "review-log",
          { reviews: [] },
        );
        log.reviews.push({
          type: "weekly",
          at: nowIso(),
          inboxCount: unprocessed.length,
          completedCount: completed.items.length,
          notes:
            `Weekly review: ${unprocessed.length} unprocessed in inbox, ${completed.items.length} completed total.`,
        });
        await writeList(context, "review-log", log);
        context.logger?.info("Weekly review logged");
        return {
          dataHandles: [],
          unprocessedInbox: unprocessed.length,
          completedTotal: completed.items.length,
        };
      },
    },

    dailyReview: {
      description:
        "Run the GTD daily review: surface today's calendar and top next actions, then log the review.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: MethodContext,
      ) => {
        const cal = await readList<{ items: CalendarItem[] }>(
          context,
          "calendar",
          { items: [] },
        );
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);
        const todayItems = cal.items.filter((c) => {
          const d = new Date(c.when);
          return d >= today && d < tomorrow && c.status === "scheduled";
        });
        const log = await readList<{ reviews: Review[] }>(
          context,
          "review-log",
          { reviews: [] },
        );
        log.reviews.push({
          type: "daily",
          at: nowIso(),
          inboxCount: 0,
          completedCount: 0,
          notes:
            `Daily review: ${todayItems.length} item(s) on today's calendar.`,
        });
        await writeList(context, "review-log", log);
        context.logger?.info("Daily review logged");
        return { dataHandles: [], todayCount: todayItems.length };
      },
    },

    ensureServer: {
      description:
        "Idempotently ensure the GTD web UI server runs as a systemd user service (via @svendowideit/systemd-service). Resolves the bundled gtd-server.ts script path, creates the unit, and starts it. Skips gracefully (with a log) if the systemd-service extension is not installed.",
      arguments: z.object({
        port: z.number().int().min(1).max(65535).optional().describe(
          "Port the GTD server listens on (defaults to global serverPort).",
        ),
        serviceName: z.string().optional().describe(
          "systemd user service name (defaults to global serverServiceName).",
        ),
        scriptPath: z.string().optional().describe(
          "Override the path to the gtd-server.ts script (defaults to the bundled script).",
        ),
        boardPath: z.string().optional().describe(
          "Absolute path to the board HTML the server serves (defaults to <outputDir>/board.html).",
        ),
      }).describe("Arguments for the ensureServer method"),
      execute: async (
        args: {
          port?: number;
          serviceName?: string;
          scriptPath?: string;
          boardPath?: string;
        },
        context: MethodContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const logger = context.logger;
        const ga = context.globalArgs as GlobalArgs;
        const port = args.port ?? ga.serverPort;
        const serviceName = args.serviceName ?? ga.serverServiceName;
        const boardPath = args.boardPath ?? ga.boardPath ??
          `${
            ga.outputDir ?? `${Deno.env.get("HOME") ?? "/tmp"}/.swamp/gtd`
          }/board.html`;

        // Resolve the bundled gtd-server.ts script path.
        let scriptPath = args.scriptPath ?? ga.serverScriptPath;
        if (!scriptPath) {
          if (context.extensionFile) {
            scriptPath = context.extensionFile("scripts/gtd-server.ts");
          } else {
            scriptPath = `${
              context.repoDir ?? "."
            }/extensions/gtd/scripts/gtd-server.ts`;
          }
        }

        // Check whether the systemd-service extension is installed.
        const probe = await runSwampCmd([
          "model",
          "type",
          "search",
          "@svendowideit/systemd-service",
          "--json",
        ]);
        const installed = probe.code === 0 &&
          probe.stdout.includes("@svendowideit/systemd-service");
        if (!installed) {
          logger?.info(
            "@svendowideit/systemd-service not installed — skipping GTD server service setup. Run `swamp extension pull @svendowideit/systemd-service` to enable it.",
          );
          return { dataHandles: [] };
        }

        const denoPath = expandHome("~/.swamp/deno/deno");
        const command =
          `${denoPath} run --allow-net --allow-read --allow-write --allow-env --allow-run ${scriptPath}`;

        // The server shells out to `swamp`; systemd user services run with a
        // minimal PATH and a default working directory, so add the swamp
        // binary's directory to the unit env and pin the working directory to
        // the repo (swamp resolves the repo from the current directory).
        const swampDir = await resolveSwampDir();
        const pathEnv = `${swampDir}:/usr/local/bin:/usr/bin:/bin`;
        const workingDir = context.repoDir ?? ".";
        const serveUrl = ga.serveUrl ?? "ws://127.0.0.1:9090";

        // Idempotently create the unit (createService is a no-op if unchanged).
        const create = await runSwampCmd([
          "model",
          "@svendowideit/systemd-service",
          "method",
          "run",
          "createService",
          serviceName,
          "--input",
          `serviceName=${serviceName}`,
          "--input",
          `command=${command}`,
          "--input",
          "description=GTD web UI server",
          "--input",
          `workingDirectory=${workingDir}`,
          "--input",
          `environment=["GTD_PORT=${port}", "GTD_BOARD=${boardPath}", "SWAMP_SERVE_URL=${serveUrl}", "PATH=${pathEnv}"]`,
          "--skip-reports",
        ]);
        if (create.code !== 0) {
          throw new Error(
            `createService failed (${create.code}): ${
              create.stderr || create.stdout
            }`,
          );
        }

        // Start it (idempotent — enable --now is safe to re-run).
        const start = await runSwampCmd([
          "model",
          "@svendowideit/systemd-service",
          "method",
          "run",
          "startService",
          serviceName,
          "--input",
          `serviceName=${serviceName}`,
          "--skip-reports",
        ]);
        if (start.code !== 0) {
          throw new Error(
            `startService failed (${start.code}): ${
              start.stderr || start.stdout
            }`,
          );
        }

        logger?.info(
          "GTD server service {serviceName} is running on port {port} (script {scriptPath}, board {boardPath}, serveUrl {serveUrl})",
          { serviceName, port, scriptPath, boardPath, serveUrl },
        );
        return { dataHandles: [] };
      },
    },

    renderBoard: {
      description: "Render the responsive GTD board HTML (with htmx).",
      arguments: RenderBoardArgsSchema,
      execute: async (
        args: z.infer<typeof RenderBoardArgsSchema>,
        context: MethodContext,
      ) => {
        const data = await loadBoardData(context);
        const html = renderBoard(data, new Date().toISOString());

        const writer = await context.createFileWriter("board", "board");
        await writer.writeText(html);

        const outDir = args.path
          ? args.path.substring(0, args.path.lastIndexOf("/"))
          : context.globalArgs.outputDir ||
            `${Deno.env.get("HOME") ?? "/tmp"}/.swamp/gtd`;
        const outPath = args.path || `${outDir}/board.html`;
        await Deno.mkdir(outDir, { recursive: true });
        await Deno.writeTextFile(outPath, html);
        context.logger?.info("Board written to {path}", { path: outPath });

        return { dataHandles: [], path: outPath };
      },
    },
  },
  reports: ["@svendowideit/gtd-summary"],
};

// ---------------------------------------------------------------------------
// Routing helpers
// ---------------------------------------------------------------------------

type RouteHint = {
  kind: NonNullable<z.infer<typeof ClarifyArgsSchema>["kind"]>;
  context?: string;
  delegatee?: string;
  area?: string;
};

async function routeItem(
  context: MethodContext,
  item: InboxItem,
  hint: RouteHint,
  args: z.infer<typeof ClarifyArgsSchema>,
): Promise<string> {
  const title = item.raw.replace(
    /^(someday|maybe|ref|reference|wait|delegate|calendar|on|project|trash)\b\s*:?\s*/i,
    "",
  ).trim() || item.raw.trim();

  switch (hint.kind) {
    case "trash":
      return "trash";
    case "someday-maybe": {
      const sm = await readList<{ items: SomedayMaybe[] }>(
        context,
        "someday-maybe",
        { items: [] },
      );
      sm.items.push({
        id: item.id,
        title,
        notes: "",
        status: "open",
        createdAt: item.capturedAt,
      });
      await writeList(context, "someday-maybe", sm);
      return "someday-maybe";
    }
    case "reference": {
      const ref = await readList<{ items: Reference[] }>(
        context,
        "reference",
        { items: [] },
      );
      ref.items.push({
        id: item.id,
        title,
        body: item.raw,
        area: hint.area ?? args.area ?? "resources",
        createdAt: item.capturedAt,
      });
      await writeList(context, "reference", ref);
      return "reference";
    }
    case "waiting-for": {
      const wf = await readList<{ items: WaitingFor[] }>(
        context,
        "waiting-for",
        { items: [] },
      );
      wf.items.push({
        id: item.id,
        title,
        delegatee: hint.delegatee ?? args.delegatee ?? "",
        expectedBy: args.due ?? null,
        status: "waiting",
        createdAt: item.capturedAt,
      });
      await writeList(context, "waiting-for", wf);
      return "waiting-for";
    }
    case "calendar": {
      const cal = await readList<{ items: CalendarItem[] }>(
        context,
        "calendar",
        { items: [] },
      );
      cal.items.push({
        id: item.id,
        title,
        when: args.when ?? new Date(Date.now() + 86400000).toISOString(),
        duration: 30,
        status: "scheduled",
        createdAt: item.capturedAt,
      });
      await writeList(context, "calendar", cal);
      return "calendar";
    }
    case "project": {
      const proj = await readList<{ items: Project[] }>(
        context,
        "projects",
        { items: [] },
      );
      proj.items.push({
        id: item.id,
        title,
        outcome: "",
        status: "active",
        nextActionId: null,
        createdAt: item.capturedAt,
      });
      await writeList(context, "projects", proj);
      return "project";
    }
    case "next-action":
    default: {
      const na = await readList<{ items: NextAction[] }>(
        context,
        "next-actions",
        { items: [] },
      );
      na.items.push({
        id: item.id,
        title,
        context: hint.context ?? args.context ?? "@anywhere",
        priority: args.priority ?? "medium",
        energy: "medium",
        due: args.due ?? null,
        projectId: null,
        status: "open",
        notes: "",
        createdAt: item.capturedAt,
        updatedAt: item.capturedAt,
      });
      await writeList(context, "next-actions", na);
      return "next-actions";
    }
  }
}

/** Remove an item from a list by id, returning it (or null). */
async function takeFromList(
  context: MethodContext,
  list: string,
  itemId: string,
): Promise<{ id: string; title: string; createdAt: string } | null> {
  switch (list) {
    case "next-actions": {
      const na = await readList<{ items: NextAction[] }>(
        context,
        "next-actions",
        { items: [] },
      );
      const idx = na.items.findIndex((i) => i.id === itemId);
      if (idx < 0) return null;
      const [item] = na.items.splice(idx, 1);
      await writeList(context, "next-actions", na);
      return { id: item.id, title: item.title, createdAt: item.createdAt };
    }
    case "projects": {
      const p = await readList<{ items: Project[] }>(context, "projects", {
        items: [],
      });
      const idx = p.items.findIndex((i) => i.id === itemId);
      if (idx < 0) return null;
      const [item] = p.items.splice(idx, 1);
      await writeList(context, "projects", p);
      return { id: item.id, title: item.title, createdAt: item.createdAt };
    }
    case "waiting-for": {
      const w = await readList<{ items: WaitingFor[] }>(
        context,
        "waiting-for",
        { items: [] },
      );
      const idx = w.items.findIndex((i) => i.id === itemId);
      if (idx < 0) return null;
      const [item] = w.items.splice(idx, 1);
      await writeList(context, "waiting-for", w);
      return { id: item.id, title: item.title, createdAt: item.createdAt };
    }
    case "someday-maybe": {
      const s = await readList<{ items: SomedayMaybe[] }>(
        context,
        "someday-maybe",
        { items: [] },
      );
      const idx = s.items.findIndex((i) => i.id === itemId);
      if (idx < 0) return null;
      const [item] = s.items.splice(idx, 1);
      await writeList(context, "someday-maybe", s);
      return { id: item.id, title: item.title, createdAt: item.createdAt };
    }
    case "calendar": {
      const c = await readList<{ items: CalendarItem[] }>(
        context,
        "calendar",
        { items: [] },
      );
      const idx = c.items.findIndex((i) => i.id === itemId);
      if (idx < 0) return null;
      const [item] = c.items.splice(idx, 1);
      await writeList(context, "calendar", c);
      return { id: item.id, title: item.title, createdAt: item.createdAt };
    }
    case "reference": {
      const r = await readList<{ items: Reference[] }>(
        context,
        "reference",
        { items: [] },
      );
      const idx = r.items.findIndex((i) => i.id === itemId);
      if (idx < 0) return null;
      const [item] = r.items.splice(idx, 1);
      await writeList(context, "reference", r);
      return { id: item.id, title: item.title, createdAt: item.createdAt };
    }
    default:
      return null;
  }
}

/** Insert an item into a list, returning the destination list name. */
async function putIntoList(
  context: MethodContext,
  list: string,
  item: { id: string; title: string; createdAt: string },
  opts: {
    context?: string;
    priority?: z.infer<typeof OrganizeArgsSchema>["priority"];
    due?: string;
    delegatee?: string;
    when?: string;
    area?: string;
  },
): Promise<string> {
  switch (list) {
    case "next-actions": {
      const na = await readList<{ items: NextAction[] }>(
        context,
        "next-actions",
        { items: [] },
      );
      na.items.push({
        id: item.id,
        title: item.title,
        context: opts.context ?? "@anywhere",
        priority: opts.priority ?? "medium",
        energy: "medium",
        due: opts.due ?? null,
        projectId: null,
        status: "open",
        notes: "",
        createdAt: item.createdAt,
        updatedAt: nowIso(),
      });
      await writeList(context, "next-actions", na);
      return "next-actions";
    }
    case "projects": {
      const p = await readList<{ items: Project[] }>(context, "projects", {
        items: [],
      });
      p.items.push({
        id: item.id,
        title: item.title,
        outcome: "",
        status: "active",
        nextActionId: null,
        createdAt: item.createdAt,
      });
      await writeList(context, "projects", p);
      return "projects";
    }
    case "waiting-for": {
      const w = await readList<{ items: WaitingFor[] }>(
        context,
        "waiting-for",
        { items: [] },
      );
      w.items.push({
        id: item.id,
        title: item.title,
        delegatee: opts.delegatee ?? "",
        expectedBy: opts.due ?? null,
        status: "waiting",
        createdAt: item.createdAt,
      });
      await writeList(context, "waiting-for", w);
      return "waiting-for";
    }
    case "someday-maybe": {
      const s = await readList<{ items: SomedayMaybe[] }>(
        context,
        "someday-maybe",
        { items: [] },
      );
      s.items.push({
        id: item.id,
        title: item.title,
        notes: "",
        status: "open",
        createdAt: item.createdAt,
      });
      await writeList(context, "someday-maybe", s);
      return "someday-maybe";
    }
    case "calendar": {
      const c = await readList<{ items: CalendarItem[] }>(
        context,
        "calendar",
        { items: [] },
      );
      c.items.push({
        id: item.id,
        title: item.title,
        when: opts.when ?? new Date(Date.now() + 86400000).toISOString(),
        duration: 30,
        status: "scheduled",
        createdAt: item.createdAt,
      });
      await writeList(context, "calendar", c);
      return "calendar";
    }
    case "reference": {
      const r = await readList<{ items: Reference[] }>(
        context,
        "reference",
        { items: [] },
      );
      r.items.push({
        id: item.id,
        title: item.title,
        body: item.title,
        area: opts.area ?? "resources",
        createdAt: item.createdAt,
      });
      await writeList(context, "reference", r);
      return "reference";
    }
    default:
      throw new Error(`Unknown list: ${list}`);
  }
}

// ---------------------------------------------------------------------------
// Board data + renderer
// ---------------------------------------------------------------------------

type BoardData = {
  inbox: InboxItem[];
  nextActions: NextAction[];
  projects: Project[];
  waitingFor: WaitingFor[];
  somedayMaybe: SomedayMaybe[];
  calendar: CalendarItem[];
  reference: Reference[];
  contexts: Context[];
  completed: Completed[];
  reviews: Review[];
};

async function loadBoardData(context: MethodContext): Promise<BoardData> {
  const inbox = (await readList<{ items: InboxItem[] }>(context, "inbox", {
    items: [],
  })).items;
  const nextActions = (await readList<{ items: NextAction[] }>(
    context,
    "next-actions",
    { items: [] },
  )).items;
  const projects = (await readList<{ items: Project[] }>(context, "projects", {
    items: [],
  })).items;
  const waitingFor = (await readList<{ items: WaitingFor[] }>(
    context,
    "waiting-for",
    { items: [] },
  )).items;
  const somedayMaybe = (await readList<{ items: SomedayMaybe[] }>(
    context,
    "someday-maybe",
    { items: [] },
  )).items;
  const calendar = (await readList<{ items: CalendarItem[] }>(
    context,
    "calendar",
    { items: [] },
  )).items;
  const reference = (await readList<{ items: Reference[] }>(
    context,
    "reference",
    { items: [] },
  )).items;
  const contexts = (await readList<{ contexts: Context[] }>(
    context,
    "contexts",
    { contexts: DEFAULT_CONTEXTS },
  )).contexts;
  const completed = (await readList<{ items: Completed[] }>(
    context,
    "completed",
    { items: [] },
  )).items;
  const reviews = (await readList<{ reviews: Review[] }>(
    context,
    "review-log",
    { reviews: [] },
  )).reviews;
  return {
    inbox,
    nextActions,
    projects,
    waitingFor,
    somedayMaybe,
    calendar,
    reference,
    contexts,
    completed,
    reviews,
  };
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtDay(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "2-digit",
    month: "short",
  });
}

/** Render a single column fragment (used by both the full page and htmx swaps). */
export function renderColumn(name: string, d: BoardData): string {
  switch (name) {
    case "inbox":
      return col(
        "inbox",
        "📥 Inbox",
        d.inbox.map((i) => `
        <div class="card">
          <div class="card-title">${esc(i.raw)}</div>
          <div class="card-meta">${esc(i.source)} · ${
          fmtDate(i.capturedAt)
        }</div>
          <form class="clarify" hx-post="/api/clarify" hx-target="#board-container" hx-swap="outerHTML">
            <input type="hidden" name="itemId" value="${esc(i.id)}">
            ${
          CLARIFY_KINDS.map((k) =>
            `<button type="submit" name="kind" value="${k.kind}" title="${k.label}">${k.icon}</button>`
          ).join("")
        }
          </form>
        </div>`).join(""),
      );
    case "next-actions":
      return col(
        "next-actions",
        "✅ Next Actions",
        d.nextActions
          .filter((a) => a.status !== "done" && a.status !== "cancelled")
          .map((a) => `
        <div class="card">
          <div class="card-title">${esc(a.title)}</div>
          <div class="card-meta">${esc(a.context)} · ${esc(a.priority)}${
            a.due ? ` · due ${fmtDate(a.due)}` : ""
          }</div>
          <div class="row-actions">
            <form hx-post="/api/complete" hx-target="#board-container" hx-swap="outerHTML">
              <input type="hidden" name="itemId" value="${esc(a.id)}">
              <input type="hidden" name="list" value="next-actions">
              <button type="submit" title="done">✓</button>
            </form>
            <form hx-post="/api/defer" hx-target="#board-container" hx-swap="outerHTML">
              <input type="hidden" name="itemId" value="${esc(a.id)}">
              <button type="submit" title="defer">⏸</button>
            </form>
            <form hx-post="/api/revert" hx-target="#board-container" hx-swap="outerHTML">
              <input type="hidden" name="itemId" value="${esc(a.id)}">
              <input type="hidden" name="list" value="next-actions">
              <button type="submit" title="revert to inbox">↩</button>
            </form>
          </div>
        </div>`).join(""),
      );
    case "projects":
      return col(
        "projects",
        "🗂 Projects",
        d.projects
          .filter((p) => p.status !== "done" && p.status !== "cancelled")
          .map((p) => `
        <div class="card">
          <div class="card-title">${esc(p.title)}</div>
          <div class="card-meta">${esc(p.status)}</div>
        </div>`).join(""),
      );
    case "waiting-for":
      return col(
        "waiting-for",
        "⏳ Waiting For",
        d.waitingFor
          .filter((w) => w.status === "waiting")
          .map((w) => `
        <div class="card">
          <div class="card-title">${esc(w.title)}</div>
          <div class="card-meta">→ ${esc(w.delegatee)}${
            w.expectedBy ? ` · by ${fmtDate(w.expectedBy)}` : ""
          }</div>
        </div>`).join(""),
      );
    case "someday-maybe":
      return col(
        "someday-maybe",
        "💭 Someday/Maybe",
        d.somedayMaybe
          .filter((s) => s.status === "open")
          .map((s) => `
        <div class="card">
          <div class="card-title">${esc(s.title)}</div>
        </div>`).join(""),
      );
    case "calendar":
      return col(
        "calendar",
        "📅 Calendar",
        d.calendar
          .filter((c) => c.status === "scheduled")
          .sort((a, b) =>
            new Date(a.when).getTime() - new Date(b.when).getTime()
          )
          .map((c) => `
        <div class="card">
          <div class="card-title">${esc(c.title)}</div>
          <div class="card-meta">${fmtDay(c.when)} · ${c.duration} min</div>
        </div>`).join(""),
      );
    case "reference":
      return col(
        "reference",
        "🗄 Reference",
        d.reference.map((r) => `
        <div class="card">
          <div class="card-title">${esc(r.title)}</div>
          <div class="card-meta">${esc(r.area)}</div>
        </div>`).join(""),
      );
    default:
      return "";
  }
}

function col(name: string, title: string, cards: string): string {
  const count = cards
    ? cards.split("\n").filter((l) => l.includes("card-title")).length
    : 0;
  return `<section id="col-${name}" class="column">
    <div class="column-head">${title} <span class="count">${count}</span></div>
    <div class="column-body">${cards || "<div class='empty'>—</div>"}</div>
  </section>`;
}

/** Render the "now" panel: recommended next actions + today's calendar. */
function renderNow(d: BoardData): string {
  const open = d.nextActions.filter((a) =>
    a.status === "open" || a.status === "in-progress"
  );
  const scored = open.map((a) => {
    let s = 0;
    if (a.priority === "urgent") s += 100;
    else if (a.priority === "high") s += 60;
    else if (a.priority === "medium") s += 30;
    if (a.due) {
      const days = (new Date(a.due).getTime() - Date.now()) / 86400000;
      if (days < 0) s += 80;
      else if (days < 1) s += 50;
      else if (days < 3) s += 20;
    }
    return { a, s };
  }).sort((x, y) => y.s - x.s).slice(0, 5);

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const todayCal = d.calendar.filter((c) => {
    const t = new Date(c.when);
    return t >= today && t < tomorrow && c.status === "scheduled";
  });

  const picks = scored.map(({ a }) => `
    <div class="now-item">
      <span class="now-priority ${esc(a.priority)}">${esc(a.priority)}</span>
      <span class="now-title">${esc(a.title)}</span>
      <span class="now-ctx">${esc(a.context)}</span>
    </div>`).join("") ||
    "<div class='empty'>Nothing on your plate — capture something or enjoy the space.</div>";

  const calHtml = todayCal.map((c) => `
    <div class="now-item"><span class="now-time">${
    fmtDate(c.when)
  }</span><span class="now-title">${esc(c.title)}</span></div>`).join("") ||
    "<div class='empty'>No hard landscape today.</div>";

  return `<section id="now-panel" class="now-panel">
    <div class="now-block">
      <div class="now-head">🎯 Do now</div>
      ${picks}
    </div>
    <div class="now-block">
      <div class="now-head">📅 Today</div>
      ${calHtml}
    </div>
  </section>`;
}

/** Render the now-panel + board wrapped in the htmx-swappable container. */
export function renderBoardContainer(d: BoardData): string {
  const columns = [
    renderColumn("inbox", d),
    renderColumn("next-actions", d),
    renderColumn("projects", d),
    renderColumn("waiting-for", d),
    renderColumn("someday-maybe", d),
    renderColumn("calendar", d),
    renderColumn("reference", d),
  ].join("\n");
  return `<div id="board-container">
${renderNow(d)}
<main class="board">
  ${columns}
</main>
</div>`;
}

/** Render the full responsive GTD board page (with htmx). */
export function renderBoard(d: BoardData, generatedAt: string): string {
  const container = renderBoardContainer(d);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GTD — Getting Things Done</title>
<script src="https://unpkg.com/htmx.org@2.0.4" defer></script>
<style>
  :root { --bg:#f5f5f4; --card:#fff; --line:#e5e5e5; --muted:#71717a; --accent:#2563eb; }
  * { box-sizing:border-box; }
  body { margin:0; font-family:ui-sans-serif,system-ui,-apple-system,sans-serif; background:var(--bg); color:#18181b; }
  header { padding:14px 20px; background:#fff; border-bottom:1px solid var(--line); display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; }
  header h1 { font-size:18px; margin:0; }
  header .generated { font-size:12px; color:var(--muted); }
  .capture { padding:12px 20px; background:#fff; border-bottom:1px solid var(--line); }
  .capture form { display:flex; gap:8px; }
  .capture input[type=text] { flex:1; padding:10px 12px; border:1px solid var(--line); border-radius:8px; font-size:14px; }
  .capture button { padding:10px 16px; border:0; border-radius:8px; background:var(--accent); color:#fff; font-size:14px; cursor:pointer; }
  .now-panel { display:grid; grid-template-columns:1fr 1fr; gap:14px; padding:16px 20px 0; }
  .now-block { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:12px 14px; }
  .now-head { font-weight:700; font-size:13px; margin-bottom:8px; }
  .now-item { display:flex; align-items:center; gap:8px; padding:6px 0; border-bottom:1px dashed var(--line); font-size:13px; }
  .now-item:last-child { border-bottom:0; }
  .now-priority { font-size:10px; text-transform:uppercase; padding:1px 6px; border-radius:4px; }
  .now-priority.urgent { background:#fef2f2; color:#991b1b; }
  .now-priority.high { background:#fef3c7; color:#92400e; }
  .now-priority.medium { background:#eff6ff; color:#1d4ed8; }
  .now-priority.low { background:#f4f4f5; color:#52525b; }
  .now-ctx { color:var(--muted); font-size:11px; margin-left:auto; }
  .now-time { color:var(--muted); font-size:11px; min-width:70px; }
  .board { display:grid; grid-template-columns:repeat(4, 1fr); gap:14px; padding:16px 20px 20px; align-items:start; }
  @media (max-width:1200px){ .board{ grid-template-columns:repeat(3, 1fr); } }
  @media (max-width:900px){ .board{ grid-template-columns:repeat(2, 1fr); } }
  @media (max-width:640px){
    .board{ grid-template-columns:1fr; }
    .now-panel{ grid-template-columns:1fr; }
    .capture input[type=text]{ font-size:16px; }
  }
  .column { background:var(--card); border:1px solid var(--line); border-radius:12px; overflow:hidden; }
  .column-head { padding:10px 14px; font-weight:600; font-size:13px; border-bottom:1px solid var(--line); background:#fafafa; display:flex; justify-content:space-between; }
  .count { color:var(--muted); font-weight:400; }
  .column-body { padding:10px; display:flex; flex-direction:column; gap:8px; min-height:80px; }
  .card { border:1px solid var(--line); border-radius:8px; padding:10px 12px; background:#fff; }
  .card-title { font-weight:600; font-size:14px; margin-bottom:2px; }
  .card-meta { font-size:11px; color:var(--muted); margin-bottom:6px; }
  .empty { color:var(--muted); font-size:12px; padding:8px; }
  .row-actions { display:flex; gap:6px; }
  .row-actions form { margin:0; }
  .row-actions button { padding:4px 8px; border:1px solid var(--line); border-radius:6px; background:#f4f4f5; color:#18181b; font-size:12px; cursor:pointer; }
  .row-actions button:hover { background:#e4e4e7; }
  .card form { display:flex; gap:6px; margin-top:6px; }
  .card select { flex:1; padding:6px 8px; border:1px solid var(--line); border-radius:6px; font-size:12px; }
  .card form button { padding:6px 10px; border:0; border-radius:6px; background:var(--accent); color:#fff; font-size:12px; cursor:pointer; }
  .card form.clarify { display:flex; gap:4px; margin-top:6px; }
  .card form.clarify button { padding:4px 6px; border:1px solid var(--line); border-radius:6px; background:#f4f4f5; color:#18181b; font-size:14px; line-height:1; cursor:pointer; }
  .card form.clarify button:hover { background:#e4e4e7; }
  .htmx-request { opacity:.5; pointer-events:none; }
</style>
</head>
<body>
<header>
  <h1>✅ GTD</h1>
  <span class="generated">generated <span data-generated="${
    esc(generatedAt)
  }"></span></span>
</header>
<section class="capture">
  <form hx-post="/api/capture" hx-target="#board-container" hx-swap="outerHTML">
    <input type="text" name="raw" placeholder="Capture a thought, task, or idea…" autofocus autocomplete="off">
    <button type="submit">Capture</button>
  </form>
</section>
${container}
<script>
document.querySelectorAll('[data-generated]').forEach(function(el){var d=new Date(el.getAttribute('data-generated'));el.textContent=d.toLocaleString('en-GB');});
</script>
</body>
</html>`;
}
