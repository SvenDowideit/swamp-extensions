/**
 * Obsidian factory board: a stagecraft tracker whose tickets are notes in an
 * Obsidian vault, plus the board operations that install and read the Bases
 * Kanban board.
 *
 * The only writer of vault files is `@magistr/obsidian/vault`, called through
 * `context.runModel`. This behavior owns the *card schema* and the stagecraft
 * tracker contract; it never writes a note itself.
 *
 * @module
 */
import {
  parse as parseYaml,
  stringify as stringifyYaml,
} from "jsr:@std/yaml@1.0.0";
import { z } from "npm:zod@4";

/** The columns the board shows, in order. */
export const DEFAULT_STATUSES = [
  "Uncharacterised",
  "Category",
  "Proposed",
  "Please Plan",
  "Work Planned",
  "Please Implement",
  "Please Test",
  "User Acceptance",
  "Please Release",
  "Done",
] as const;

/** How a card's kind chooses its first column. */
export const DEFAULT_STATUS_FOR_KIND: Record<string, string> = {
  inbox: "Uncharacterised",
  category: "Category",
  action: "Proposed",
};

/** The column each stagecraft stage publishes to, for `queue`. */
export const DEFAULT_STAGE_COLUMNS: Record<string, string> = {
  route: "",
  triage: "Uncharacterised",
  triaged: "",
  propose: "Category",
  "category-idle": "",
  proposed: "Proposed",
  plan: "Please Plan",
  "plan-review": "Please Plan",
  "plan-cleanup": "Please Plan",
  "work-planned": "Work Planned",
  implement: "Please Implement",
  test: "Please Test",
  acceptance: "User Acceptance",
  release: "Please Release",
  done: "Done",
  abandoned: "Done",
};

/** The card kinds the board understands. */
export const CARD_KINDS = ["inbox", "category", "action"] as const;
export type CardKind = typeof CARD_KINDS[number];

/**
 * The outcome an archived card records. Every archive has exactly one of
 * these plus a free-text reason; an optional detail line says more.
 */
export const ARCHIVE_OUTCOMES = ["done", "deleted", "duplicate"] as const;
export type ArchiveOutcome = typeof ARCHIVE_OUTCOMES[number];

/** One relation, as the tracker contract defines it. */
export interface Relation {
  type: "parent_of" | "blocked_by" | "related_to" | "duplicate_of";
  issue: string;
}

/** One activity entry on a card. */
export interface ActivityEntry {
  kind: "comment" | "entry";
  id: string;
  body: string;
  author?: string;
  at: string;
  step?: string;
  targetStatus?: string;
  summary?: string;
  emoji?: string;
  payload?: Record<string, unknown>;
  isVerbose?: boolean;
}

/** A parsed card note. */
export interface Card {
  path: string;
  frontmatter: Record<string, unknown> & {
    id: string;
    title: string;
    kind: CardKind;
    type?: string;
    status: string;
    description?: string;
    created?: string;
    updated?: string;
  };
  body: string;
  raw: string;
}

/** A card summary, as `scan` writes it. */
export interface CardSummary {
  id: string;
  display: string;
  title: string;
  kind: CardKind;
  status: string;
  path: string;
  updated: string;
  project: string;
  ideaCount: number;
  openQuestions: number;
  moves: string[];
  body?: string;
}

const RELATION_TYPES = [
  "parent_of",
  "blocked_by",
  "related_to",
  "duplicate_of",
] as const;

const ACTIVITY_BEGIN = "<!-- swamp:activity:begin -->";
const ACTIVITY_END = "<!-- swamp:activity:end -->";
const SUMMARY_BEGIN = "<!-- swamp:summary:begin -->";
const SUMMARY_END = "<!-- swamp:summary:end -->";
const PLAN_BEGIN = "<!-- swamp:plan:begin -->";
const PLAN_END = "<!-- swamp:plan:end -->";
const DEFINITION_BEGIN = "<!-- swamp:definition:begin -->";
const DEFINITION_END = "<!-- swamp:definition:end -->";
const PLAN_HEADINGS = ["Definition", "Activity"];
const DEFINITION_HEADINGS = ["Activity"];
const ENTRY_PREFIX = "<!-- swamp:entry ";
const ENTRY_SUFFIX = " -->";
const ENTRY_END = "<!-- swamp:entry:end -->";

const GlobalArgsSchema = z.object({
  vaultModel: z.string().min(1).default("obsidian-vault").describe(
    "The @magistr/obsidian/vault model instance this tracker writes through",
  ),
  folder: z.string().min(1).default("Factory").describe(
    "Vault folder that holds Board.base, Cards/ and Templates/",
  ),
  prefix: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).default("fac").describe(
    "Prefix for ticket ids (fac-1, fac-2)",
  ),
  trackerName: z.string().regex(/^[a-z][a-z0-9-]*$/).default("obsidian")
    .describe("Tracker name the factory definition names in tracker.kind"),
  types: z.array(z.string().min(1)).default(["inbox", "category", "action"])
    .describe(
      "Ticket types the tracker accepts; a type that is also a card kind sets that kind",
    ),
  statuses: z.array(z.string().min(1)).default([...DEFAULT_STATUSES]).describe(
    "Every status name a card may have",
  ),
  statusForKind: z.record(z.string(), z.string()).default(
    { ...DEFAULT_STATUS_FOR_KIND },
  ).describe("The status a new card starts in, by kind"),
  stageColumns: z.record(z.string(), z.string()).default(
    { ...DEFAULT_STAGE_COLUMNS },
  ).describe("The board column each factory stage publishes to, for queue"),
  factory: z.string().min(1).default("obsidian-idea-factory").describe(
    "The stagecraft factory instance queue reports work items for",
  ),
  allowDotObsidian: z.boolean().default(false),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const DescriptionSchema = z.object({
  tracker: z.string(),
  contract: z.literal(1),
  origin: z.literal("snapshot"),
  capabilities: z.object({
    history: z.boolean(),
    assign: z.boolean(),
    pullRequests: z.boolean(),
  }),
  closesDuplicates: z.boolean(),
  assignee: z.string().optional(),
});

const AnswerSchema = z.object({
  operation: z.string(),
  run: z.string(),
  ok: z.boolean(),
  kind: z.string().optional(),
  detail: z.string().optional(),
  result: z.unknown().optional(),
  timestamp: z.string(),
});

const CardSummarySchema = z.object({
  id: z.string(),
  display: z.string(),
  title: z.string(),
  kind: z.enum(CARD_KINDS),
  status: z.string(),
  path: z.string(),
  updated: z.string(),
  project: z.string(),
  ideaCount: z.number(),
  openQuestions: z.number(),
  moves: z.array(z.string()),
  body: z.string().optional(),
});

const BoardSchema = z.object({
  cards: z.array(CardSummarySchema),
  count: z.number(),
  statuses: z.array(z.string()),
  timestamp: z.string(),
});

const QueueCardSchema = z.object({
  id: z.string(),
  display: z.string(),
  title: z.string(),
  kind: z.enum(CARD_KINDS),
  column: z.string(),
  path: z.string(),
  project: z.string(),
  key: z.string(),
  stage: z.string(),
  cycle: z.number(),
  era: z.string(),
  terminal: z.boolean(),
  moves: z.array(z.string()),
  action: z.enum(["claim", "work", "reconcile", "done", "wait"]),
});

const QueueSchema = z.object({
  cards: z.array(QueueCardSchema),
  counts: z.object({
    claim: z.number(),
    work: z.number(),
    reconcile: z.number(),
    done: z.number(),
    wait: z.number(),
  }),
  factory: z.string(),
  statuses: z.array(z.string()),
  timestamp: z.string(),
});

const BriefSchema = z.object({
  prompt: z.string(),
  systemPrompt: z.string(),
  board: z.array(QueueCardSchema),
  counts: z.object({
    claim: z.number(),
    work: z.number(),
    reconcile: z.number(),
    done: z.number(),
    wait: z.number(),
  }),
  repo: z.string(),
  timestamp: z.string(),
});

const TickSchema = z.object({
  board: z.array(QueueCardSchema),
  counts: z.object({
    claim: z.number(),
    work: z.number(),
    reconcile: z.number(),
    done: z.number(),
    wait: z.number(),
  }),
  plugin: z.object({
    path: z.string(),
    repoPath: z.string(),
    changed: z.boolean(),
  }),
  cli: z.object({
    status: z.enum([
      "already",
      "configured",
      "would-configure",
      "missing",
      "error",
    ]),
    path: z.string(),
    restartRequired: z.boolean(),
    detail: z.string().optional(),
  }),
  css: z.object({
    snippet: z.string(),
    appearance: z.string(),
    enabled: z.boolean(),
  }),
  migrated: z.number(),
  repinned: z.array(z.string()),
  pinned: z.array(z.string()),
  errors: z.array(z.string()),
  factoryDefinition: z.string(),
  dryRun: z.boolean(),
  timestamp: z.string(),
});

const CardSchema = z.object({
  id: z.string(),
  display: z.string(),
  title: z.string(),
  kind: z.enum(CARD_KINDS),
  status: z.string(),
  path: z.string(),
  updated: z.string(),
  project: z.string(),
  body: z.string(),
  relations: z.array(z.object({
    type: z.enum(RELATION_TYPES),
    issue: z.string(),
  })),
  timestamp: z.string(),
});

const InstallSchema = z.object({
  files: z.array(z.object({
    path: z.string(),
    action: z.enum(["created", "unchanged", "updated"]),
  })),
  folder: z.string(),
  timestamp: z.string(),
});

const OperationSchema = z.object({
  operation: z.string(),
  id: z.string(),
  path: z.string(),
  changed: z.boolean(),
  detail: z.string().optional(),
  outcome: z.string().optional(),
  reason: z.string().optional(),
  previousStatus: z.string().optional(),
  timestamp: z.string(),
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** True when a value is a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Split a note into parsed YAML frontmatter and its body. */
export function splitFrontmatter(
  raw: string,
): { frontmatter: Record<string, unknown>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!match) return { frontmatter: {}, body: raw };
  let frontmatter: Record<string, unknown> = {};
  try {
    const parsed = parseYaml(match[1]);
    if (isRecord(parsed)) frontmatter = parsed;
  } catch {
    frontmatter = {};
  }
  return {
    frontmatter,
    body: raw.slice(match[0].length).replace(/^\r?\n/, ""),
  };
}

/** Make a note from frontmatter and a body. */
export function composeNote(
  frontmatter: Record<string, unknown>,
  body: string,
): string {
  const yaml = stringifyYaml(frontmatter).trimEnd();
  return `---\n${yaml}\n---\n\n${body.trim()}\n`;
}

/** Parse a card note. Returns null when the note is not a card. */
export function parseCard(path: string, raw: string): Card | null {
  const { frontmatter, body } = splitFrontmatter(raw);
  const id = typeof frontmatter.id === "string" ? frontmatter.id : "";
  if (!id) return null;
  const kind = frontmatter.kind;
  if (kind !== "inbox" && kind !== "category" && kind !== "action") {
    return null;
  }
  return {
    path,
    raw,
    body,
    frontmatter: frontmatter as Card["frontmatter"],
  };
}

/**
 * Collapse repeated headings with the same level and text. Content under a
 * later duplicate is merged into the first occurrence, so a person's words are
 * never dropped; an empty duplicate heading simply disappears.
 */
export function collapseDuplicateHeadings(body: string): string {
  const lines = body.split(/\r?\n/);
  const preamble: string[] = [];
  interface Section {
    heading: string;
    name: string;
    content: string[];
  }
  const sections: Section[] = [];
  let current: Section | null = null;
  for (const line of lines) {
    const match = /^(#{1,6})\s+(.*)$/.exec(line);
    if (match) {
      current = {
        heading: line,
        name: `${match[1].length}|${match[2].trim().toLowerCase()}`,
        content: [],
      };
      sections.push(current);
    } else if (current) {
      current.content.push(line);
    } else {
      preamble.push(line);
    }
  }
  const order: Section[] = [];
  const byName = new Map<string, Section>();
  for (const section of sections) {
    const existing = byName.get(section.name);
    if (!existing) {
      byName.set(section.name, section);
      order.push(section);
      continue;
    }
    const content = section.content.join("\n").trim();
    if (content) {
      if (existing.content.some((line) => line.trim() !== "")) {
        existing.content.push("");
      }
      existing.content.push(...section.content);
    }
  }
  return [
    ...preamble,
    ...order.flatMap((section) => [section.heading, ...section.content]),
  ].join("\n");
}

/** A file-name-safe slug. */
export function slugify(value: string): string {
  const slug = value.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "card";
}

/** The id part of a status name (`Please Plan` -> `please-plan`). */
export function statusId(name: string): string {
  return slugify(name);
}

/**
 * What the factory should do, decided by the card's column alone. The work
 * item's stage is an execution ledger and never overrides the card.
 */
export function queueActionFor(
  column: string,
  hasRun: boolean,
  terminal: boolean,
  newInput: boolean,
  releasePrepared = false,
): "claim" | "work" | "wait" | "done" {
  if (column === "Please Release" && releasePrepared) return "wait";
  if (column === "Done") return "done";
  if (column === "Uncharacterised" || column === "Category") {
    if (!hasRun) return "claim";
    if (terminal) return newInput ? "claim" : "wait";
    return "work";
  }
  if (
    column === "Proposed" || column === "Work Planned" ||
    column === "User Acceptance"
  ) {
    return "wait";
  }
  if (
    column === "Please Plan" || column === "Please Implement" ||
    column === "Please Test" || column === "Please Release"
  ) {
    return hasRun && !terminal ? "work" : "claim";
  }
  return "wait";
}

/** Merge the repo default into the plugin's data.json without clobbering settings. */
export function mergePluginSettings(
  raw: string | null,
  repoPath: string,
): { json: string; changed: boolean } {
  let data: Record<string, unknown> = {};
  if (raw !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("plugin data.json is not valid JSON");
    }
    if (!isRecord(parsed)) throw new Error("plugin data.json is not an object");
    data = parsed;
  }
  let changed = false;
  if (
    typeof data.repoPath !== "string" || data.repoPath.trim() === ""
  ) {
    data.repoPath = repoPath;
    changed = true;
  }
  const defaults: Record<string, string> = {
    swampBinary: "swamp",
    agent: "pi",
    model: "",
    archiveWebhookUrl: "",
    archiveWebhookToken: "",
  };
  for (const [key, value] of Object.entries(defaults)) {
    if (typeof data[key] !== "string") {
      data[key] = value;
      changed = true;
    }
  }
  return {
    json: changed ? `${JSON.stringify(data, null, 2)}\n` : raw ?? "",
    changed,
  };
}

/** Add a plugin id to Obsidian's enabled community-plugin list. */
export function addEnabledPlugin(
  raw: string,
  id: string,
): { json: string; changed: boolean } {
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    throw new Error("community-plugins.json is not valid JSON");
  }
  if (
    !Array.isArray(list) ||
    !list.every((item): item is string => typeof item === "string")
  ) {
    throw new Error("community-plugins.json is not a string array");
  }
  if (list.includes(id)) return { json: raw, changed: false };
  return { json: `${JSON.stringify([...list, id], null, 2)}\n`, changed: true };
}

/** The documented normal moves from one column to another. */
export function movesForStatus(status: string): string[] {
  switch (status) {
    case "Proposed":
      return ["Please Plan"];
    case "Please Plan":
      return ["Work Planned"];
    case "Work Planned":
      return ["Please Plan", "Please Implement"];
    case "Please Implement":
      return ["Please Test"];
    case "Please Test":
      return ["Please Implement", "User Acceptance"];
    case "User Acceptance":
      return [
        "Please Plan",
        "Please Implement",
        "Please Test",
        "Please Release",
      ];
    case "Please Release":
      return ["User Acceptance", "Done"];
    default:
      return [];
  }
}

/** The next id for a prefix, from the cards already on the board. */
export function nextId(prefix: string, ids: string[]): string {
  const pattern = new RegExp(`^${prefix}-(\\d+)$`);
  let highest = 0;
  for (const id of ids) {
    const match = pattern.exec(id.toLowerCase());
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `${prefix}-${highest + 1}`;
}

/** A card's display id: the id uppercased, or its frontmatter display. */
export function cardDisplay(card: Card): string {
  const display = card.frontmatter.display;
  return typeof display === "string" && display.length > 0
    ? display
    : card.frontmatter.id.toUpperCase();
}

/** Whether a user-supplied id names this card (case-insensitive). */
export function cardMatches(card: Card, needle: string): boolean {
  const wanted = needle.trim().toLowerCase();
  if (!wanted) return false;
  return card.frontmatter.id.toLowerCase() === wanted ||
    cardDisplay(card).toLowerCase() === wanted ||
    card.path.toLowerCase() === wanted;
}

/** Strip the managed activity block from a card body. */
export function stripActivity(body: string): string {
  const begin = body.indexOf(ACTIVITY_BEGIN);
  const end = body.indexOf(ACTIVITY_END);
  const before = begin < 0 ? body : body.slice(0, begin);
  const after = end < 0 ? "" : body.slice(end + ACTIVITY_END.length);
  const content = after.trim() === "" ? before : `${before}\n\n${after}`;
  return content.replace(/\n*##\s+Activity\s*$/i, "").trim();
}

/** Parse every managed activity entry from a card body. */
export function parseActivity(body: string): ActivityEntry[] {
  const entries: ActivityEntry[] = [];
  let cursor = 0;
  while (true) {
    const start = body.indexOf(ENTRY_PREFIX, cursor);
    if (start < 0) break;
    const headerEnd = body.indexOf(ENTRY_SUFFIX, start + ENTRY_PREFIX.length);
    if (headerEnd < 0) break;
    const header = body.slice(start + ENTRY_PREFIX.length, headerEnd);
    const end = body.indexOf(ENTRY_END, headerEnd + ENTRY_SUFFIX.length);
    if (end < 0) break;
    const content = body.slice(headerEnd + ENTRY_SUFFIX.length, end).trim();
    try {
      const parsed = JSON.parse(header) as Record<string, unknown>;
      if (typeof parsed.id === "string" && typeof parsed.at === "string") {
        const entry: ActivityEntry = {
          kind: parsed.kind === "entry" ? "entry" : "comment",
          id: parsed.id,
          at: parsed.at,
          body: content,
        };
        if (typeof parsed.author === "string") entry.author = parsed.author;
        if (typeof parsed.step === "string") entry.step = parsed.step;
        if (typeof parsed.targetStatus === "string") {
          entry.targetStatus = parsed.targetStatus;
        }
        if (typeof parsed.summary === "string") entry.summary = parsed.summary;
        if (typeof parsed.emoji === "string") entry.emoji = parsed.emoji;
        if (isRecord(parsed.payload)) entry.payload = parsed.payload;
        if (typeof parsed.isVerbose === "boolean") {
          entry.isVerbose = parsed.isVerbose;
        }
        entries.push(entry);
      }
    } catch {
      // A malformed entry is skipped; the rest of the activity still reads.
    }
    cursor = end + ENTRY_END.length;
  }
  return entries;
}

/** Render the activity section with one new entry added. */
export function appendActivity(
  body: string,
  entry: ActivityEntry,
): string {
  const content = stripActivity(body);
  const entries = parseActivity(body);
  entries.push(entry);
  const rendered = entries.map((item) => {
    const header = JSON.stringify({
      id: item.id,
      kind: item.kind,
      at: item.at,
      ...(item.author ? { author: item.author } : {}),
      ...(item.step ? { step: item.step } : {}),
      ...(item.targetStatus ? { targetStatus: item.targetStatus } : {}),
      ...(item.summary ? { summary: item.summary } : {}),
      ...(item.emoji ? { emoji: item.emoji } : {}),
      ...(item.payload ? { payload: item.payload } : {}),
      ...(item.isVerbose !== undefined ? { isVerbose: item.isVerbose } : {}),
    });
    return `${ENTRY_PREFIX}${header}${ENTRY_SUFFIX}\n${item.body.trim()}\n${ENTRY_END}`;
  }).join("\n\n");
  return `${content}\n\n## Activity\n\n${ACTIVITY_BEGIN}\n\n${rendered}\n\n${ACTIVITY_END}\n`;
}

/** The next lifecycle-entry id on a card. */
export function nextEntryId(entries: ActivityEntry[]): string {
  let highest = 0;
  for (const entry of entries) {
    const match = /^e-(\d+)$/.exec(entry.id);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `e-${highest + 1}`;
}

/** The next comment id on a card. */
export function nextCommentId(entries: ActivityEntry[]): string {
  let highest = 0;
  for (const entry of entries) {
    const match = /^c-(\d+)$/.exec(entry.id);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `c-${highest + 1}`;
}

/** Whether a plan is absent, a draft, or the final plan. */
export type PlanStatus = "none" | "draft" | "final";

/** What the card's At a glance section says. */
export interface SummaryInput {
  stage: string;
  planStatus: PlanStatus;
  needsInput?: string[];
  known: string[];
  unknown: string[];
  next: string;
  updatedAt?: string;
}

/** One checkbox task in the plan section. */
export interface PlanTaskInput {
  description: string;
  files?: string[];
  done?: boolean;
}

/** One checkbox test in the plan section. */
export interface PlanTestInput {
  name: string;
  kind: "completeness" | "correctness";
  covers: string;
  done?: boolean;
}

/** What the card's Plan section says. */
export interface PlanInput {
  status: PlanStatus;
  summary: string;
  tasks: PlanTaskInput[];
  tests: PlanTestInput[];
  existing: string[];
  added: string[];
  removed: string[];
  known: string[];
  unknown: string[];
  updatedAt?: string;
}

function renderBullets(items: string[], empty: string): string {
  return items.length > 0
    ? items.map((item) => `- ${item}`).join("\n")
    : `- _${empty}_`;
}

/** SHA-256 of a managed section, used to detect a person's edits. */
export async function hashText(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * Return the current section when a person edited it since the factory last
 * wrote it. A missing stored hash also counts as edited: the first write after
 * this protection lands must be reviewed, not forced.
 */
export async function managedEditProblem(
  current: string | null,
  storedHash: unknown,
): Promise<string | null> {
  if (!current) return null;
  const hash = await hashText(current);
  return typeof storedHash === "string" && storedHash === hash ? null : current;
}

/** Render the human-readable At a glance section. */
export function renderSummarySection(input: SummaryInput): string {
  const at = input.updatedAt ?? nowIso();
  const needsInput = input.needsInput ?? [];
  // The top questions are the person's decisions; do not repeat them in the
  // Unknown list below, which is for technical unknowns.
  const unknown = input.unknown.filter((item) => !needsInput.includes(item));
  return `${SUMMARY_BEGIN}
## At a glance

**Stage:** ${input.stage} · **Plan:** ${input.planStatus} · **Updated:** ${at}

**Needs your input**

${
    renderBullets(
      needsInput,
      "Nothing right now — add notes anywhere on this page.",
    )
  }

**Next:** ${input.next}

**Known**

${renderBullets(input.known, "Nothing recorded yet.")}

**Unknown**

${renderBullets(unknown, "Nothing outstanding.")}
${SUMMARY_END}`;
}

/** What the card's Definition section says about its pinned factory definition. */
export interface DefinitionInput {
  status: "current" | "pinned" | "repinned" | "finished" | "unknown";
  note: string;
  updatedAt?: string;
}

/** Render the small Definition section. */
export function renderDefinitionSection(input: DefinitionInput): string {
  const at = input.updatedAt ?? nowIso();
  return `${DEFINITION_BEGIN}
## Definition

**Status:** ${input.status} · **Updated:** ${at}

${input.note}
${DEFINITION_END}`;
}

/** Tick or untick Plan task/test checkboxes by matching text. */
export function updatePlanCheckboxes(
  block: string,
  updates: {
    tasks?: Array<{ match: string; done: boolean }>;
    tests?: Array<{ match: string; done: boolean }>;
  },
): { block: string; changed: number; unmatched: string[] } {
  const lines = block.split(/\r?\n/);
  const remaining = new Map<string, number>();
  for (const update of [...(updates.tasks ?? []), ...(updates.tests ?? [])]) {
    remaining.set(update.match, (remaining.get(update.match) ?? 0) + 1);
  }
  let section: "task" | "test" | "" = "";
  let changed = 0;
  for (let i = 0; i < lines.length; i++) {
    const heading = /^#{1,6}\s+(.*)$/.exec(lines[i]);
    if (heading) {
      const name = heading[1].trim().toLowerCase();
      section = name === "tasks" ? "task" : name === "tests" ? "test" : "";
      continue;
    }
    const checkbox = /^(\s*)- \[( |x|X)\]\s+(.*)$/.exec(lines[i]);
    if (!checkbox || section === "") continue;
    const text = checkbox[3];
    const list = section === "task"
      ? (updates.tasks ?? [])
      : (updates.tests ?? []);
    const update = list.find((item) =>
      text.toLowerCase().includes(item.match.toLowerCase())
    );
    if (!update) continue;
    const mark = update.done ? "x" : " ";
    if (checkbox[2].toLowerCase() !== mark) changed++;
    lines[i] = `${checkbox[1]}- [${mark}] ${text}`;
    remaining.set(
      update.match,
      Math.max(0, (remaining.get(update.match) ?? 1) - 1),
    );
  }
  return {
    block: lines.join("\n"),
    changed,
    unmatched: [...remaining.entries()]
      .filter(([, count]) => count > 0)
      .map(([match]) => match),
  };
}

/** Render the human-readable, checkbox-tracked Plan section. */
export function renderPlanSection(input: PlanInput): string {
  const at = input.updatedAt ?? nowIso();
  const tasks = input.tasks.length > 0
    ? input.tasks.map((task) => {
      const files = task.files && task.files.length > 0
        ? ` (${task.files.join(", ")})`
        : "";
      return `- [${task.done ? "x" : " "}] ${task.description}${files}`;
    }).join("\n")
    : "- [ ] _No tasks recorded yet._";
  const tests = input.tests.length > 0
    ? input.tests.map((test) =>
      `- [${
        test.done ? "x" : " "
      }] **${test.kind}**: ${test.name} — covers ${test.covers}`
    ).join("\n")
    : "- [ ] _No tests recorded yet._";
  return `${PLAN_BEGIN}
## Plan

**Status:** ${input.status} · **Updated:** ${at}

**Summary:** ${input.summary}

### Tasks

${tasks}

### Tests

${tests}

### Existing functionality changing

${renderBullets(input.existing, "None identified.")}

### Functionality added

${renderBullets(input.added, "None identified.")}

### Functionality removed

${renderBullets(input.removed, "None identified.")}

### Known / Unknown

**Known**

${renderBullets(input.known, "Nothing recorded yet.")}

**Unknown**

${renderBullets(input.unknown, "Nothing outstanding.")}
${PLAN_END}`;
}

/** Extract one managed block, including its markers. */
export function extractManaged(
  body: string,
  begin: string,
  end: string,
): string | null {
  const start = body.indexOf(begin);
  if (start < 0) return null;
  const stop = body.indexOf(end, start);
  if (stop < 0) return null;
  return body.slice(start, stop + end.length);
}

/** Remove one managed block. */
export function stripManaged(body: string, begin: string, end: string): string {
  let next = body;
  while (true) {
    const block = extractManaged(next, begin, end);
    if (!block) break;
    next = next.replace(block, "");
  }
  return next.replace(/\n{3,}/g, "\n\n").trim();
}

/** Insert a block before the first heading with one of these names. */
/** Put a block immediately after the first H1, so it is the first thing read. */
export function insertAfterTitle(body: string, block: string): string {
  const lines = body.split(/\r?\n/);
  const title = lines.findIndex((line) => /^#\s+/.test(line));
  const text = block.trim();
  if (title < 0) return `${text}\n\n${body.trimStart()}`.trimEnd() + "\n";
  const before = lines.slice(0, title + 1).join("\n");
  const after = lines.slice(title + 1).join("\n").replace(/^\n+/, "").trimEnd();
  return `${before}\n\n${text}${after ? `\n\n${after}` : ""}\n`;
}

/** Replace a managed block with one placed immediately after the title. */
export function upsertAfterTitle(
  body: string,
  begin: string,
  end: string,
  block: string,
): string {
  return insertAfterTitle(stripManaged(body, begin, end), block);
}

export function insertBeforeHeading(
  body: string,
  headings: string[],
  block: string,
): string {
  const lines = body.split(/\r?\n/);
  const wanted = headings.map((heading) => heading.toLowerCase());
  for (let i = 0; i < lines.length; i++) {
    const match = /^(#{1,6})\s+(.*)$/.exec(lines[i]);
    if (!match) continue;
    if (!wanted.includes(match[2].trim().toLowerCase())) continue;
    const before = lines.slice(0, i).join("\n").trimEnd();
    const after = lines.slice(i).join("\n");
    return `${before}\n\n${block.trim()}\n\n${after}`.replace(
      /\n{3,}/g,
      "\n\n",
    );
  }
  return `${body.trimEnd()}\n\n${block.trim()}\n`;
}

/** Replace a managed block, or insert it before the given headings. */
export function upsertManaged(
  body: string,
  begin: string,
  end: string,
  block: string,
  headings: string[],
): string {
  return insertBeforeHeading(stripManaged(body, begin, end), headings, block);
}

/** Pull the managed summary, plan and activity blocks out of a body. */
export function extractManagedSections(body: string): {
  summary: string | null;
  plan: string | null;
  definition: string | null;
  activity: string | null;
} {
  return {
    summary: extractManaged(body, SUMMARY_BEGIN, SUMMARY_END),
    plan: extractManaged(body, PLAN_BEGIN, PLAN_END),
    definition: extractManaged(body, DEFINITION_BEGIN, DEFINITION_END),
    activity: extractManaged(body, ACTIVITY_BEGIN, ACTIVITY_END),
  };
}

/** Re-apply preserved managed blocks to an edited body. */
export function applyManagedSections(
  body: string,
  sections: ReturnType<typeof extractManagedSections>,
): string {
  let next = stripManaged(body, SUMMARY_BEGIN, SUMMARY_END);
  next = stripManaged(next, PLAN_BEGIN, PLAN_END);
  next = stripManaged(next, DEFINITION_BEGIN, DEFINITION_END);
  next = stripManaged(next, ACTIVITY_BEGIN, ACTIVITY_END);
  if (sections.summary) {
    next = insertAfterTitle(next, sections.summary);
  }
  if (sections.plan) {
    next = insertBeforeHeading(next, PLAN_HEADINGS, sections.plan);
  }
  if (sections.definition) {
    next = insertBeforeHeading(next, DEFINITION_HEADINGS, sections.definition);
  }
  if (sections.activity) {
    next = `${next.trimEnd()}\n\n${sections.activity}\n`;
  }
  return `${next.replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

/** The bullet lines under a heading (case-insensitive), without the marker. */
export function sectionBullets(body: string, heading: string): string[] {
  const lines = stripActivity(body).split(/\r?\n/);
  const wanted = heading.trim().toLowerCase();
  const bullets: string[] = [];
  let inside = false;
  for (const line of lines) {
    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(line);
    if (headingMatch) {
      inside = headingMatch[2].trim().toLowerCase() === wanted;
      continue;
    }
    if (!inside) continue;
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) bullets.push(bullet[1].trim());
  }
  return bullets;
}

/** Count bullets under one or more headings. */
export function countBullets(body: string, headings: string[]): number {
  return headings.reduce(
    (sum, heading) => sum + sectionBullets(body, heading).length,
    0,
  );
}

/** Remove the first bullet whose text contains `needle`.
 *
 * With `heading`, only bullets under that heading are considered, so moving an
 * idea cannot delete a matching line from another section. */
export function removeBullet(
  body: string,
  needle: string,
  heading?: string,
): {
  body: string;
  removed: string | null;
} {
  const lines = body.split(/\r?\n/);
  const wanted = needle.trim().toLowerCase();
  let start = 0;
  let end = lines.length;
  if (heading !== undefined) {
    const target = heading.trim().toLowerCase();
    start = -1;
    for (let i = 0; i < lines.length; i++) {
      const match = /^(#{1,6})\s+(.*)$/.exec(lines[i]);
      if (!match) continue;
      if (start >= 0) {
        end = i;
        break;
      }
      if (match[2].trim().toLowerCase() === target) start = i + 1;
    }
    if (start < 0) return { body, removed: null };
  }
  for (let i = start; i < end; i++) {
    const bullet = /^\s*[-*]\s+(.*)$/.exec(lines[i]);
    if (!bullet) continue;
    if (!bullet[1].toLowerCase().includes(wanted)) continue;
    const removed = bullet[1].trim();
    lines.splice(i, 1);
    return { body: lines.join("\n"), removed };
  }
  return { body, removed: null };
}

/** Append a bullet under a heading, creating the heading when absent. */
export function appendBullet(
  body: string,
  heading: string,
  text: string,
): string {
  const lines = body.split(/\r?\n/);
  const wanted = heading.trim().toLowerCase();
  const bullet = `- ${text.trim()}`;
  let inside = false;
  let sectionStart = -1;
  let lastBullet = -1;
  for (let i = 0; i < lines.length; i++) {
    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(lines[i]);
    if (headingMatch) {
      if (inside) break;
      if (headingMatch[2].trim().toLowerCase() === wanted) {
        inside = true;
        sectionStart = i;
      }
    } else if (inside && /^\s*[-*]\s+/.test(lines[i])) {
      lastBullet = i;
    }
  }
  if (sectionStart < 0) {
    return `${body.trimEnd()}\n\n## ${heading}\n\n${bullet}\n`;
  }
  // Insert after the last existing bullet in the section. Never skip over a
  // managed marker or prose line: a marker such as swamp:plan:begin belongs
  // to the next section, and a bullet inserted after it would be rewritten.
  let at = lastBullet >= 0 ? lastBullet + 1 : sectionStart + 1;
  if (lastBullet < 0 && at < lines.length && lines[at].trim() === "") at++;
  lines.splice(at, 0, bullet);
  return lines.join("\n");
}

/** Whether a terminal work item should be reopened for new card input. */
export function shouldReopenTerminal(card: Card, column: string): boolean {
  const kind = card.frontmatter.kind;
  if (kind === "inbox") {
    return sectionBullets(card.body, "Thoughts").length > 0;
  }
  if (kind === "category") {
    const current = countBullets(card.body, ["Ideas"]);
    const marker = card.frontmatter.lastProposedIdeaCount;
    const covered = typeof marker === "number" ? marker : 0;
    return current > covered;
  }
  return column === "Proposed";
}

/** A summary of a card, for the board resource. */
export function cardSummary(card: Card, includeBody = false): CardSummary {
  const kind = card.frontmatter.kind;
  const headings = kind === "inbox"
    ? ["Thoughts", "Ideas"]
    : ["Ideas", "Proposed"];
  return {
    id: card.frontmatter.id,
    display: cardDisplay(card),
    title: typeof card.frontmatter.title === "string"
      ? card.frontmatter.title
      : card.frontmatter.id,
    kind,
    status: typeof card.frontmatter.status === "string"
      ? card.frontmatter.status
      : "",
    path: card.path,
    updated: typeof card.frontmatter.updated === "string"
      ? card.frontmatter.updated
      : "",
    project: typeof card.frontmatter.project === "string"
      ? card.frontmatter.project
      : "",
    ideaCount: countBullets(card.body, headings),
    openQuestions: countBullets(card.body, ["Questions"]),
    moves: movesForStatus(
      typeof card.frontmatter.status === "string"
        ? card.frontmatter.status
        : "",
    ),
    ...(includeBody ? { body: stripActivity(card.body) } : {}),
  };
}

/** Relations on a card, normalised. */
export function relationsOf(card: Card): Relation[] {
  const raw = card.frontmatter.relations;
  if (!Array.isArray(raw)) return [];
  const relations: Relation[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const type = item.type;
    const issue = item.issue;
    if (typeof type !== "string" || typeof issue !== "string") continue;
    if (!(RELATION_TYPES as readonly string[]).includes(type)) continue;
    relations.push({ type: type as Relation["type"], issue });
  }
  return relations;
}

/** Incoming relations to `id`, from every card on the board. */
export function incomingRelations(
  cards: Card[],
  id: string,
): Array<{ type: Relation["type"]; issue: string; display: string }> {
  const wanted = id.toLowerCase();
  const found: Array<
    { type: Relation["type"]; issue: string; display: string }
  > = [];
  for (const card of cards) {
    if (card.frontmatter.id.toLowerCase() === wanted) continue;
    for (const relation of relationsOf(card)) {
      if (relation.issue.toLowerCase() !== wanted) continue;
      found.push({
        type: relation.type,
        issue: card.frontmatter.id,
        display: cardDisplay(card),
      });
    }
  }
  return found;
}

/** Validate a proposed relation. Returns a reason, or null when it is fine. */
export function validateRelation(
  cards: Card[],
  issue: string,
  type: Relation["type"],
  to: string,
): string | null {
  if (issue.toLowerCase() === to.toLowerCase()) {
    return "a ticket cannot be related to itself";
  }
  const from = cards.find((card) =>
    card.frontmatter.id.toLowerCase() === issue.toLowerCase()
  );
  const target = cards.find((card) =>
    card.frontmatter.id.toLowerCase() === to.toLowerCase()
  );
  if (!from) return `no ticket '${issue}'`;
  if (!target) return `no ticket '${to}'`;
  const existing = relationsOf(from);
  if (
    existing.some((relation) =>
      relation.type === type &&
      relation.issue.toLowerCase() === to.toLowerCase()
    )
  ) {
    return null;
  }
  if (type === "parent_of") {
    const targetParents = incomingRelations(cards, target.frontmatter.id)
      .filter((relation) => relation.type === "parent_of");
    if (targetParents.length > 0) return "that ticket already has a parent";
    // Walk up from `from`; if we reach the target, the new edge would loop.
    let cursor: Card | undefined = from;
    for (let depth = 0; depth < 10 && cursor; depth++) {
      const parent:
        | { type: Relation["type"]; issue: string; display: string }
        | undefined = incomingRelations(cards, cursor.frontmatter.id)
          .find((relation) => relation.type === "parent_of");
      if (!parent) break;
      if (parent.issue.toLowerCase() === target.frontmatter.id.toLowerCase()) {
        return "that relation would make a parent cycle";
      }
      cursor = cards.find((card) =>
        card.frontmatter.id.toLowerCase() === parent.issue.toLowerCase()
      );
    }
  }
  if (type === "duplicate_of") {
    if (
      relationsOf(from).some((relation) => relation.type === "duplicate_of")
    ) {
      return "a ticket can be a duplicate of only one ticket";
    }
    if (
      relationsOf(target).some((relation) => relation.type === "duplicate_of")
    ) {
      return "a duplicate's primary cannot itself be a duplicate";
    }
    if (
      incomingRelations(cards, from.frontmatter.id)
        .some((relation) => relation.type === "duplicate_of")
    ) {
      return "a ticket with duplicates cannot become one";
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

interface RunModelResult {
  ok: boolean;
  resources?: Array<{ name?: string }>;
  error?: { message?: string };
}

interface DataRecord {
  name: string;
  version: number;
  attributes: Record<string, unknown>;
}

export interface FactoryContext {
  globalArgs: GlobalArgs;
  logger: {
    info: (message: string, props?: Record<string, unknown>) => void;
    warn?: (message: string, props?: Record<string, unknown>) => void;
  };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
  readResource?: (
    name: string,
  ) => Promise<Record<string, unknown> | null>;
  readModelData?: (
    modelName: string,
    specName?: string,
  ) => Promise<DataRecord[]>;
  runModel?: (options: {
    definition: string;
    method: string;
    arguments?: Record<string, unknown>;
  }) => Promise<RunModelResult>;
  extensionFile?: (path: string) => string;
}

// ---------------------------------------------------------------------------
// Vault access through @magistr/obsidian/vault
// ---------------------------------------------------------------------------

function requireRunModel(
  context: FactoryContext,
): NonNullable<FactoryContext["runModel"]> {
  if (!context.runModel) {
    throw new Error(
      "context.runModel is unavailable; this tracker needs @magistr/obsidian-vault",
    );
  }
  return context.runModel;
}

function resultDataName(result: RunModelResult): string | null {
  const name = result.resources?.[0]?.name;
  return typeof name === "string" && name.length > 0 ? name : null;
}

async function readVaultData(
  context: FactoryContext,
  specName: string,
  dataName: string,
): Promise<Record<string, unknown> | null> {
  if (!context.readModelData) return null;
  const records = await context.readModelData(
    context.globalArgs.vaultModel,
    specName,
  );
  const match = records.find((record) => record.name === dataName);
  return match ? match.attributes : null;
}

/** Read a note through the vault model; null when it does not exist. */
async function readNote(
  context: FactoryContext,
  file: string,
  allowDotObsidian = context.globalArgs.allowDotObsidian,
): Promise<string | null> {
  const runModel = requireRunModel(context);
  const result = await runModel({
    definition: context.globalArgs.vaultModel,
    method: "read",
    arguments: { file, allowDotObsidian },
  });
  if (!result.ok) {
    const message = result.error?.message ?? "";
    if (
      /not ?found|no such file|does not exist|os error 2|enoent|\bmissing\b/i
        .test(message)
    ) {
      return null;
    }
    throw new Error(`vault read failed for '${file}': ${message}`);
  }
  const name = resultDataName(result);
  if (!name) return null;
  const data = await readVaultData(context, "note", name);
  return typeof data?.content === "string" ? data.content : null;
}

/** Whether a note exists (a read is enough; missing is normal). */
async function noteExists(
  context: FactoryContext,
  file: string,
  allowDotObsidian = context.globalArgs.allowDotObsidian,
): Promise<boolean> {
  return (await readNote(context, file, allowDotObsidian)) !== null;
}

/** Write a note through the vault model. */
async function writeNote(
  context: FactoryContext,
  file: string,
  content: string,
  allowDotObsidian = context.globalArgs.allowDotObsidian,
): Promise<void> {
  const runModel = requireRunModel(context);
  const result = await runModel({
    definition: context.globalArgs.vaultModel,
    method: "create",
    arguments: {
      name: file,
      content,
      overwrite: true,
      allowDotObsidian,
    },
  });
  if (!result.ok) {
    throw new Error(
      `vault write failed for '${file}': ${result.error?.message ?? ""}`,
    );
  }
}

/** List notes under a folder through the vault model. */
async function listNotes(
  context: FactoryContext,
  folder: string,
): Promise<string[]> {
  const runModel = requireRunModel(context);
  const result = await runModel({
    definition: context.globalArgs.vaultModel,
    method: "list",
    arguments: {
      folder,
      ext: "md",
      recursive: true,
      allowDotObsidian: context.globalArgs.allowDotObsidian,
    },
  });
  if (!result.ok) {
    throw new Error(`vault list failed: ${result.error?.message ?? ""}`);
  }
  const name = resultDataName(result);
  if (!name) return [];
  const data = await readVaultData(context, "notes", name);
  const files = data?.files;
  if (!Array.isArray(files)) return [];
  return files.filter((file): file is string => typeof file === "string");
}

/** Read an extension asset. */
async function readAsset(
  context: FactoryContext,
  path: string,
): Promise<string> {
  if (!context.extensionFile) {
    throw new Error("context.extensionFile is unavailable");
  }
  return await Deno.readTextFile(context.extensionFile(path));
}

function cardsFolder(context: FactoryContext): string {
  return `${context.globalArgs.folder.replace(/\/+$/, "")}/Cards`;
}

/** The folder archived cards move to. */
export function archiveFolder(folder: string): string {
  return `${folder.replace(/\/+$/, "")}/Archive`;
}

/**
 * Where an archived copy of a card lives: the same file name, in the Archive
 * folder. Keeping the name makes unarchive a copy back, not a rename guess.
 */
export function archivePathFor(folder: string, cardPath: string): string {
  const name = cardPath.split("/").pop() ?? "card.md";
  return `${archiveFolder(folder)}/${name}`;
}

/** The archive fields an archived copy records, on top of the card's own. */
export interface ArchiveRecord {
  outcome: ArchiveOutcome;
  reason: string;
  detail?: string;
  archivedAt: string;
}

/**
 * The frontmatter of an archived copy: the card's own frontmatter, the archive
 * outcome, reason, optional detail and timestamp, and the column to return to.
 * The card's prose and managed sections are untouched; unarchive clears these
 * fields again, so a round trip is lossless.
 */
export function archivedFrontmatter(
  frontmatter: Record<string, unknown>,
  record: ArchiveRecord,
): Record<string, unknown> {
  const previousStatus = typeof frontmatter.status === "string"
    ? frontmatter.status
    : "";
  const detail = record.detail?.trim() ?? "";
  return {
    ...frontmatter,
    archiveStatus: record.outcome,
    archiveReason: record.reason.trim(),
    ...(detail ? { archiveDetail: detail } : {}),
    archivedAt: record.archivedAt,
    ...(previousStatus ? { previousStatus } : {}),
    updated: record.archivedAt,
  };
}

/**
 * The column an archived card returns to: the one it left, or Proposed when
 * that column is unknown or no longer a board column.
 */
export function restoredStatus(
  frontmatter: Record<string, unknown>,
  statuses: string[],
): string {
  const previous = typeof frontmatter.previousStatus === "string"
    ? frontmatter.previousStatus
    : "";
  return statuses.includes(previous) ? previous : "Proposed";
}

/** The frontmatter of an unarchived card: archive fields cleared, column back. */
export function unarchivedFrontmatter(
  frontmatter: Record<string, unknown>,
  statuses: string[],
  updatedAt: string,
): Record<string, unknown> {
  const {
    archiveStatus: _archiveStatus,
    archiveReason: _archiveReason,
    archiveDetail: _archiveDetail,
    archivedAt: _archivedAt,
    previousStatus: _previousStatus,
    ...rest
  } = frontmatter;
  return {
    ...rest,
    status: restoredStatus(frontmatter, statuses),
    updated: updatedAt,
  };
}

/**
 * Whether a read-back archive copy holds what was written. Compared in full;
 * only trailing whitespace is ignored, because an Obsidian CLI read may drop
 * the final newline that a filesystem read keeps.
 */
export function notesMatch(written: string, readBack: string | null): boolean {
  if (readBack === null) return false;
  return readBack === written || readBack.trimEnd() === written.trimEnd();
}

function notePath(context: FactoryContext, id: string, title: string): string {
  return `${cardsFolder(context)}/${id.toUpperCase()} ${slugify(title)}.md`;
}

/** Read and parse every card in the Cards folder. */
async function readAllCards(context: FactoryContext): Promise<Card[]> {
  const files = await listNotes(context, cardsFolder(context));
  const cards: Card[] = [];
  for (const file of files) {
    const raw = await readNote(context, file);
    if (raw === null) continue;
    const card = parseCard(file, raw);
    if (card) cards.push(card);
  }
  cards.sort((a, b) =>
    String(b.frontmatter.updated ?? "").localeCompare(
      String(a.frontmatter.updated ?? ""),
    )
  );
  return cards;
}

/** Find one card by id, display id or path. */
async function findCard(
  context: FactoryContext,
  needle: string,
): Promise<Card | null> {
  const cards = await readAllCards(context);
  return cards.find((card) => cardMatches(card, needle)) ?? null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function frontmatterFor(
  context: FactoryContext,
  id: string,
  title: string,
  kind: CardKind,
  body: string,
  extra: Record<string, unknown> = {},
): Card {
  // `description` is the ticket body stagecraft reads. The note body is the
  // human-readable page: title, description and the standard sections.
  const description = typeof extra.description === "string"
    ? extra.description
    : body;
  const status = context.globalArgs.statusForKind[kind] ??
    context.globalArgs.statuses[0] ?? "Uncharacterised";
  const frontmatter: Card["frontmatter"] = {
    id,
    display: id.toUpperCase(),
    title,
    kind,
    type: kind,
    status,
    created: nowIso(),
    updated: nowIso(),
    relations: [],
    description,
    cssclasses: ["factory-card"],
    ...extra,
  };
  return {
    path: notePath(context, id, title),
    frontmatter,
    body,
    raw: "",
  };
}

function cardBody(kind: CardKind, title: string, body: string): string {
  const heading = kind === "inbox"
    ? "Thoughts"
    : kind === "category"
    ? "Ideas"
    : "Brief";
  const summary = renderSummarySection({
    stage: "Not started",
    planStatus: "none",
    needsInput: kind === "inbox"
      ? ["Add thoughts under ## Thoughts, then tick the board."]
      : ["Add anything the factory should know, then tick the board."],
    known: [],
    unknown: [
      kind === "inbox"
        ? "The factory has not triaged this inbox yet."
        : "The factory has not looked at this card yet.",
    ],
    next: kind === "inbox"
      ? "Add thoughts, then tick the board."
      : "The factory will refine this card.",
  });
  const plan = renderPlanSection({
    status: "none",
    summary: "The factory has not written a plan for this card yet.",
    tasks: [],
    tests: [],
    existing: [],
    added: [],
    removed: [],
    known: [],
    unknown: [],
  });
  return `# ${title}\n\n${summary}\n\n${body.trim()}\n\n## ${heading}\n\n## Questions\n\n## Feedback\n\n${plan}\n`;
}

function writeCardNote(context: FactoryContext, card: Card): Promise<void> {
  const frontmatter = { ...card.frontmatter, updated: nowIso() };
  card.frontmatter = frontmatter as Card["frontmatter"];
  card.body = collapseDuplicateHeadings(card.body);
  return writeNote(context, card.path, composeNote(frontmatter, card.body));
}

async function createCard(
  context: FactoryContext,
  kind: CardKind,
  title: string,
  body: string,
  extra: Record<string, unknown> = {},
): Promise<Card> {
  const ids = (await readAllCards(context)).map((card) => card.frontmatter.id);
  const id = nextId(context.globalArgs.prefix, ids);
  const card = frontmatterFor(
    context,
    id,
    title,
    kind,
    cardBody(kind, title, body),
    { description: body, ...extra },
  );
  await writeNote(context, card.path, composeNote(card.frontmatter, card.body));
  return card;
}

// ---------------------------------------------------------------------------
// Archive: leave the active board, keep the history readable
// ---------------------------------------------------------------------------

/** Move a note to the vault's trash (never a permanent delete). */
async function trashNote(
  context: FactoryContext,
  file: string,
): Promise<void> {
  const runModel = requireRunModel(context);
  const result = await runModel({
    definition: context.globalArgs.vaultModel,
    method: "delete",
    arguments: {
      file,
      permanent: false,
      allowDotObsidian: context.globalArgs.allowDotObsidian,
    },
  });
  if (!result.ok) {
    throw new Error(
      `vault trash failed for '${file}': ${result.error?.message ?? ""}`,
    );
  }
}

/** Read and parse every archived card in the Archive folder. */
export async function readArchivedCards(
  context: FactoryContext,
): Promise<Card[]> {
  const files = await listNotes(
    context,
    archiveFolder(context.globalArgs.folder),
  );
  const cards: Card[] = [];
  for (const file of files) {
    const raw = await readNote(context, file);
    if (raw === null) continue;
    const card = parseCard(file, raw);
    if (card) cards.push(card);
  }
  return cards;
}

/** The outcome, reason and detail an archive records. */
export interface ArchiveCardArgs {
  id: string;
  outcome: ArchiveOutcome;
  reason: string;
  detail?: string;
  dryRun?: boolean;
}

/** What an archive or unarchive operation reports. */
export interface ArchiveResult {
  operation: "archiveCard" | "unarchiveCard";
  id: string;
  path: string;
  changed: boolean;
  detail: string;
  outcome?: string;
  reason?: string;
  previousStatus?: string;
}

/**
 * Archive one card: write a verified copy to the Archive folder, then trash the
 * original. Nothing is lost: the copy is read back and compared before the
 * original moves, and a mismatch or a failed trash keeps the original.
 */
export async function archiveCard(
  context: FactoryContext,
  args: ArchiveCardArgs,
): Promise<ArchiveResult> {
  const card = await findCard(context, args.id);
  if (!card) throw new Error(`no card '${args.id}'`);
  if (card.frontmatter.kind === "inbox") {
    throw new Error(
      "refusing to archive the inbox card: it is the person's inbox, not a card to finish",
    );
  }
  if (!(ARCHIVE_OUTCOMES as readonly string[]).includes(args.outcome)) {
    throw new Error(
      `no archive outcome '${args.outcome}': ${ARCHIVE_OUTCOMES.join(", ")}`,
    );
  }
  const reason = args.reason.trim();
  if (!reason) {
    throw new Error(
      "archiveCard needs a reason: say why this card is finished",
    );
  }
  const target = archivePathFor(context.globalArgs.folder, card.path);
  const existing = await readNote(context, target);
  if (existing !== null) {
    const parsed = parseCard(target, existing);
    if (!parsed || parsed.frontmatter.id !== card.frontmatter.id) {
      throw new Error(
        `an archive note already exists at '${target}'; move or unarchive it first`,
      );
    }
  }
  const archivedAt = nowIso();
  const detail = args.detail?.trim() ?? "";
  const frontmatter = archivedFrontmatter(card.frontmatter, {
    outcome: args.outcome,
    reason,
    detail,
    archivedAt,
  });
  const body = appendActivity(card.body, {
    kind: "entry",
    id: nextEntryId(parseActivity(card.body)),
    at: archivedAt,
    step: "archive",
    targetStatus: "Archive",
    summary: `Archived as ${args.outcome}: ${reason}`,
    emoji: "🗄️",
    body: `🗄️ Archived as **${args.outcome}**: ${reason}${
      detail ? `\n\n${detail}` : ""
    }`,
    payload: {
      outcome: args.outcome,
      reason,
      ...(detail ? { detail } : {}),
    },
  });
  const previousStatus = typeof card.frontmatter.status === "string"
    ? card.frontmatter.status
    : "";
  if (args.dryRun === true) {
    return {
      operation: "archiveCard",
      id: card.frontmatter.id,
      path: target,
      changed: false,
      detail: `dry run: would archive to '${target}'`,
      outcome: args.outcome,
      reason,
      previousStatus,
    };
  }
  const content = composeNote(frontmatter, body);
  await writeNote(context, target, content);
  const readBack = await readNote(context, target);
  if (!notesMatch(content, readBack)) {
    await trashNote(context, target).catch(() => {});
    throw new Error(
      `the archived copy at '${target}' did not read back unchanged; the original '${card.path}' is untouched`,
    );
  }
  try {
    await trashNote(context, card.path);
  } catch (error) {
    throw new Error(
      `archived copy kept at '${target}'; the original '${card.path}' could not be trashed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return {
    operation: "archiveCard",
    id: card.frontmatter.id,
    path: target,
    changed: true,
    detail: `archived as ${args.outcome}`,
    outcome: args.outcome,
    reason,
    previousStatus,
  };
}

/**
 * Unarchive one card: write it back to the Cards folder in the column it left
 * (Proposed when that column is gone), clear the archive fields, and only then
 * trash the archive copy. A card already at that path is never overwritten.
 */
export async function unarchiveCard(
  context: FactoryContext,
  args: { id: string; dryRun?: boolean },
): Promise<ArchiveResult> {
  const archived = await readArchivedCards(context);
  const card = archived.find((item) => cardMatches(item, args.id));
  if (!card) throw new Error(`no archived card '${args.id}'`);
  const name = card.path.split("/").pop() ?? `${card.frontmatter.id}.md`;
  const target = `${cardsFolder(context)}/${name}`;
  if (await noteExists(context, target)) {
    throw new Error(
      `a card already exists at '${target}'; unarchive would overwrite it`,
    );
  }
  const status = restoredStatus(
    card.frontmatter,
    context.globalArgs.statuses,
  );
  const restoredAt = nowIso();
  const frontmatter = unarchivedFrontmatter(
    card.frontmatter,
    context.globalArgs.statuses,
    restoredAt,
  );
  const body = appendActivity(card.body, {
    kind: "entry",
    id: nextEntryId(parseActivity(card.body)),
    at: restoredAt,
    step: "unarchive",
    targetStatus: status,
    summary: `Restored to ${status}`,
    emoji: "♻️",
    body: `♻️ Restored to **${status}**.`,
  });
  if (args.dryRun === true) {
    return {
      operation: "unarchiveCard",
      id: card.frontmatter.id,
      path: target,
      changed: false,
      detail: `dry run: would restore to '${target}'`,
      previousStatus: status,
    };
  }
  const content = composeNote(frontmatter, body);
  await writeNote(context, target, content);
  const readBack = await readNote(context, target);
  if (!notesMatch(content, readBack)) {
    await trashNote(context, target).catch(() => {});
    throw new Error(
      `the restored card at '${target}' did not read back unchanged; the archive copy '${card.path}' is untouched`,
    );
  }
  try {
    await trashNote(context, card.path);
  } catch (error) {
    throw new Error(
      `restored card kept at '${target}'; the archive copy '${card.path}' could not be trashed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return {
    operation: "unarchiveCard",
    id: card.frontmatter.id,
    path: target,
    changed: true,
    detail: `restored to ${status}`,
    previousStatus: status,
  };
}

function ticketOf(
  card: Card,
  allCards: Card[],
): Record<string, unknown> {
  const relations = relationsOf(card).map((relation) => ({
    type: relation.type,
    direction: "outgoing",
    issue: relation.issue,
    display:
      allCards.find((item) =>
          item.frontmatter.id.toLowerCase() === relation.issue.toLowerCase()
        )
        ? cardDisplay(
          allCards.find((item) =>
            item.frontmatter.id.toLowerCase() === relation.issue.toLowerCase()
          )!,
        )
        : relation.issue,
  }));
  for (const incoming of incomingRelations(allCards, card.frontmatter.id)) {
    relations.push({
      type: incoming.type,
      direction: "incoming",
      issue: incoming.issue,
      display: incoming.display,
    });
  }
  const status = typeof card.frontmatter.status === "string"
    ? card.frontmatter.status
    : "";
  const activity = parseActivity(card.body).map((entry) => ({
    kind: entry.kind,
    id: entry.id,
    body: entry.body,
    at: entry.at,
    ...(entry.author ? { author: entry.author } : {}),
    ...(entry.step ? { step: entry.step } : {}),
    ...(entry.targetStatus ? { targetStatus: entry.targetStatus } : {}),
    ...(entry.summary ? { summary: entry.summary } : {}),
    ...(entry.emoji ? { emoji: entry.emoji } : {}),
    ...(entry.payload ? { payload: entry.payload } : {}),
    ...(entry.isVerbose !== undefined ? { isVerbose: entry.isVerbose } : {}),
  }));
  return {
    id: card.frontmatter.id,
    display: cardDisplay(card),
    title: typeof card.frontmatter.title === "string"
      ? card.frontmatter.title
      : card.frontmatter.id,
    status: { id: statusId(status), name: status },
    description: typeof card.frontmatter.description === "string"
      ? card.frontmatter.description
      : stripActivity(card.body),
    labels: [
      typeof card.frontmatter.type === "string"
        ? card.frontmatter.type
        : card.frontmatter.kind,
    ],
    assignees: [],
    createdAt: typeof card.frontmatter.created === "string"
      ? card.frontmatter.created
      : nowIso(),
    updatedAt: typeof card.frontmatter.updated === "string"
      ? card.frontmatter.updated
      : nowIso(),
    relations,
    activity,
  };
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

interface OperationFailure {
  ok: false;
  kind: "auth" | "not_found" | "rate_limited" | "invalid" | "upstream";
  detail: string;
}

function failure(
  kind: OperationFailure["kind"],
  detail: string,
): OperationFailure {
  return { ok: false, kind, detail };
}

/** A request the tracker refuses as it stands; `operate` answers invalid. */
export class InvalidRequestError extends Error {}

function parseRequest(
  request: unknown,
): Record<string, unknown> {
  if (typeof request === "string") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(request);
    } catch {
      throw new InvalidRequestError("request is not valid JSON");
    }
    if (!isRecord(parsed)) {
      throw new InvalidRequestError("request must be a JSON object");
    }
    return parsed;
  }
  if (!isRecord(request)) {
    throw new InvalidRequestError("request must be an object");
  }
  return request;
}

function str(request: Record<string, unknown>, key: string): string {
  const value = request[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidRequestError(
      `request.${key} must be a non-empty string`,
    );
  }
  return value;
}

/** Run one tracker operation. */
async function runOperation(
  context: FactoryContext,
  operation: string,
  request: Record<string, unknown>,
): Promise<{ ok: true; result: unknown } | OperationFailure> {
  switch (operation) {
    case "fetch_issue": {
      const issue = str(request, "issue");
      const cards = await readAllCards(context);
      const card = cards.find((item) => cardMatches(item, issue));
      if (!card) return failure("not_found", `no ticket '${issue}'`);
      return { ok: true, result: ticketOf(card, cards) };
    }
    case "create": {
      const title = str(request, "title");
      const body = typeof request.body === "string" ? request.body : "";
      const type = str(request, "type");
      if (!context.globalArgs.types.includes(type)) {
        return failure(
          "invalid",
          `no type '${type}': ${context.globalArgs.types.join(", ")}`,
        );
      }
      const kind: CardKind = (CARD_KINDS as readonly string[]).includes(type)
        ? type as CardKind
        : "action";
      const card = await createCard(context, kind, title, body, {
        type,
        ...(typeof request.project === "string"
          ? { project: request.project }
          : {}),
      });
      const all = await readAllCards(context);
      return { ok: true, result: ticketOf(card, all) };
    }
    case "comment": {
      const issue = str(request, "issue");
      const body = str(request, "body");
      const card = await findCard(context, issue);
      if (!card) return failure("not_found", `no ticket '${issue}'`);
      const entries = parseActivity(card.body);
      const id = nextCommentId(entries);
      card.body = appendActivity(card.body, {
        kind: "comment",
        id,
        body,
        at: nowIso(),
      });
      await writeCardNote(context, card);
      return { ok: true, result: { id } };
    }
    case "set_status": {
      const issue = str(request, "issue");
      const status = str(request, "status");
      if (!context.globalArgs.statuses.includes(status)) {
        return failure(
          "invalid",
          `no status '${status}': ${context.globalArgs.statuses.join(", ")}`,
        );
      }
      const card = await findCard(context, issue);
      if (!card) return failure("not_found", `no ticket '${issue}'`);
      const current = typeof card.frontmatter.status === "string"
        ? card.frontmatter.status
        : "";
      if (current === status) {
        return {
          ok: true,
          result: {
            changed: false,
            status: { id: statusId(status), name: status },
          },
        };
      }
      card.frontmatter.status = status;
      await writeCardNote(context, card);
      return {
        ok: true,
        result: {
          changed: true,
          status: { id: statusId(status), name: status },
        },
      };
    }
    case "relate": {
      const issue = str(request, "issue");
      const type = str(request, "type") as Relation["type"];
      const to = str(request, "to");
      if (!(RELATION_TYPES as readonly string[]).includes(type)) {
        return failure("invalid", `unknown relation type '${type}'`);
      }
      const cards = await readAllCards(context);
      const card = cards.find((item) => cardMatches(item, issue));
      if (!card) return failure("not_found", `no ticket '${issue}'`);
      const target = cards.find((item) => cardMatches(item, to));
      if (!target) return failure("not_found", `no ticket '${to}'`);
      const problem = validateRelation(cards, issue, type, to);
      if (problem) return failure("invalid", problem);
      const relations = relationsOf(card);
      if (
        relations.some((relation) =>
          relation.type === type &&
          relation.issue.toLowerCase() === to.toLowerCase()
        )
      ) {
        return { ok: true, result: { changed: false } };
      }
      relations.push({ type, issue: to });
      card.frontmatter.relations = relations;
      await writeCardNote(context, card);
      return { ok: true, result: { changed: true } };
    }
    case "unrelate": {
      const issue = str(request, "issue");
      const type = str(request, "type") as Relation["type"];
      const to = str(request, "to");
      const card = await findCard(context, issue);
      if (!card) return failure("not_found", `no ticket '${issue}'`);
      if (!(await findCard(context, to))) {
        return failure("not_found", `no ticket '${to}'`);
      }
      const relations = relationsOf(card);
      const kept = relations.filter((relation) =>
        !(relation.type === type &&
          relation.issue.toLowerCase() === to.toLowerCase())
      );
      if (kept.length === relations.length) {
        return { ok: true, result: { changed: false } };
      }
      card.frontmatter.relations = kept;
      await writeCardNote(context, card);
      return { ok: true, result: { changed: true } };
    }
    case "post_entry": {
      const issue = str(request, "issue");
      const raw = request.entry;
      if (!isRecord(raw)) {
        return failure("invalid", "request.entry must be an object");
      }
      const step = typeof raw.step === "string" ? raw.step : "";
      const summary = typeof raw.summary === "string" ? raw.summary : "";
      const emoji = typeof raw.emoji === "string" ? raw.emoji : "";
      const targetStatus = typeof raw.targetStatus === "string"
        ? raw.targetStatus
        : "";
      if (!step || !summary || !targetStatus) {
        return failure(
          "invalid",
          "request.entry needs step, summary and targetStatus",
        );
      }
      const card = await findCard(context, issue);
      if (!card) return failure("not_found", `no ticket '${issue}'`);
      const entries = parseActivity(card.body);
      const id = nextEntryId(entries);
      card.body = appendActivity(card.body, {
        kind: "entry",
        id,
        body: `${emoji} ${summary}`.trim(),
        at: nowIso(),
        step,
        targetStatus,
        summary,
        emoji,
        payload: isRecord(raw.payload) ? raw.payload : {},
        isVerbose: raw.isVerbose === true,
      });
      await writeCardNote(context, card);
      return { ok: true, result: { id } };
    }
    case "set_type": {
      const issue = str(request, "issue");
      const type = str(request, "type");
      if (!context.globalArgs.types.includes(type)) {
        return failure(
          "invalid",
          `no type '${type}': ${context.globalArgs.types.join(", ")}`,
        );
      }
      const card = await findCard(context, issue);
      if (!card) return failure("not_found", `no ticket '${issue}'`);
      const current = typeof card.frontmatter.type === "string"
        ? card.frontmatter.type
        : card.frontmatter.kind;
      if (current === type) {
        return { ok: true, result: { changed: false, type } };
      }
      card.frontmatter.type = type;
      await writeCardNote(context, card);
      return { ok: true, result: { changed: true, type } };
    }
    case "assign":
    case "link_pr":
      return failure("invalid", `operation '${operation}' is not offered`);
    default:
      return failure("invalid", `unknown operation '${operation}'`);
  }
}

// ---------------------------------------------------------------------------
// Methods
// ---------------------------------------------------------------------------

async function executeDescribe(
  _args: Record<string, never>,
  context: FactoryContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  context.logger.info("Describing tracker {tracker}", {
    tracker: context.globalArgs.trackerName,
  });
  const handle = await context.writeResource("description", "description", {
    tracker: context.globalArgs.trackerName,
    contract: 1,
    origin: "snapshot",
    capabilities: { history: true, assign: false, pullRequests: false },
    closesDuplicates: false,
  });
  return { dataHandles: [handle] };
}

async function executeOperate(
  args: {
    operation: string;
    request: Record<string, unknown> | string;
    answer: string;
    run: string;
  },
  context: FactoryContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  context.logger.info("Tracker operation {operation}", {
    operation: args.operation,
  });
  if (context.readResource) {
    const existing = await context.readResource(args.answer);
    if (existing && existing.ok === true) {
      return { dataHandles: [] };
    }
  }
  let answer: Record<string, unknown>;
  try {
    const request = parseRequest(args.request);
    const outcome = await runOperation(context, args.operation, request);
    answer = outcome.ok
      ? {
        operation: args.operation,
        run: args.run,
        ok: true,
        result: outcome.result,
        timestamp: nowIso(),
      }
      : {
        operation: args.operation,
        run: args.run,
        ok: false,
        kind: outcome.kind,
        detail: outcome.detail,
        timestamp: nowIso(),
      };
  } catch (error) {
    answer = {
      operation: args.operation,
      run: args.run,
      ok: false,
      kind: error instanceof InvalidRequestError ? "invalid" : "upstream",
      detail: error instanceof Error ? error.message : String(error),
      timestamp: nowIso(),
    };
  }
  const handle = await context.writeResource("answer", args.answer, answer);
  return { dataHandles: [handle] };
}

async function ensureBoardFile(
  context: FactoryContext,
  path: string,
  content: string,
  force: boolean,
): Promise<"created" | "unchanged" | "updated"> {
  const existing = await readNote(context, path);
  if (existing === null) {
    await writeNote(context, path, content);
    return "created";
  }
  if (force && existing !== content) {
    await writeNote(context, path, content);
    return "updated";
  }
  return "unchanged";
}

async function executeInstallBoard(
  args: { force?: boolean },
  context: FactoryContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  context.logger.info("Installing the board in {folder}", {
    folder: context.globalArgs.folder,
  });
  const folder = context.globalArgs.folder.replace(/\/+$/, "");
  const force = args.force === true;
  const files: Array<
    { path: string; action: "created" | "unchanged" | "updated" }
  > = [];
  const assets: Array<[string, string]> = [
    [`${folder}/Board.base`, "assets/board.base.yaml"],
    [`${folder}/Board.md`, "assets/board.md"],
    [`${folder}/Archive.base`, "assets/archive.base.yaml"],
    [`${folder}/Archive.md`, "assets/archive.md"],
    [`${folder}/Guide.md`, "assets/guide.md"],
    [`${folder}/Templates/Card.md`, "assets/card-template.md"],
    [`${folder}/Templates/Category.md`, "assets/category-template.md"],
    [`${folder}/Templates/Action.md`, "assets/action-template.md"],
  ];
  for (const [path, asset] of assets) {
    const content = (await readAsset(context, asset)).replaceAll(
      "{{folder}}",
      folder,
    );
    files.push({
      path,
      action: await ensureBoardFile(context, path, content, force),
    });
  }
  // The one uncharacterised card. Never overwritten: it is the person's inbox.
  const inboxPath = `${cardsFolder(context)}/INBOX Uncharacterised.md`;
  if (!(await noteExists(context, inboxPath))) {
    const card = frontmatterFor(
      context,
      "inbox",
      "Uncharacterised",
      "inbox",
      cardBody(
        "inbox",
        "Uncharacterised",
        "Drop raw thoughts here. Each bullet is one thought.",
      ),
    );
    card.path = inboxPath;
    await writeNote(
      context,
      card.path,
      composeNote(card.frontmatter, card.body),
    );
    files.push({ path: card.path, action: "created" });
  } else {
    files.push({ path: inboxPath, action: "unchanged" });
  }
  const handle = await context.writeResource("install", "install", {
    files,
    folder,
    timestamp: nowIso(),
  });
  return { dataHandles: [handle] };
}

async function ensurePluginData(
  context: FactoryContext,
  dryRun = false,
): Promise<{ path: string; repoPath: string; changed: boolean }> {
  const path = ".obsidian/plugins/obsidian-factory/data.json";
  const repoPath = (Deno.env.get("SWAMP_REPO_DIR") ?? Deno.cwd()).trim();
  const existing = await readNote(context, path, true);
  const merged = mergePluginSettings(existing, repoPath);
  if (merged.changed && !dryRun) {
    if (existing !== null) {
      await writeNote(
        context,
        `${path}.bak-obsidian-factory`,
        existing,
        true,
      );
    }
    await writeNote(context, path, merged.json, true);
  }
  return { path, repoPath, changed: merged.changed };
}

async function executeInstallBoardPlugin(
  args: { enable?: boolean },
  context: FactoryContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  context.logger.info("Installing the optional board plugin");
  const base = ".obsidian/plugins/obsidian-factory";
  const bundle = await readAsset(context, "obsidian-plugin/main.js");
  const expected = (await readAsset(
    context,
    "obsidian-plugin/main.js.sha256.txt",
  )).trim();
  const actual = await hashText(bundle);
  if (actual !== expected) {
    throw new Error(
      `plugin hash mismatch: expected ${expected}, got ${actual}; rebuild obsidian-plugin/main.js`,
    );
  }
  const files: Array<{ name: string; asset: string }> = [
    { name: "main.js", asset: "obsidian-plugin/main.js" },
    { name: "manifest.json", asset: "obsidian-plugin/manifest.json" },
    { name: "styles.css", asset: "obsidian-plugin/styles.css.txt" },
  ];
  const written: string[] = [];
  const backedUp: string[] = [];
  for (const file of files) {
    const content = await readAsset(context, file.asset);
    const path = `${base}/${file.name}`;
    const existing = await readNote(context, path, true);
    if (existing !== null && existing !== content) {
      const backup = `${path}.bak-obsidian-factory`;
      await writeNote(context, backup, existing, true);
      backedUp.push(backup);
    }
    if (existing !== content) {
      await writeNote(context, path, content, true);
      written.push(path);
    }
  }

  let enabled = false;
  let enableChanged = false;
  const enable = args.enable !== false;
  if (enable) {
    const pluginsPath = ".obsidian/community-plugins.json";
    const existing = await readNote(context, pluginsPath, true);
    if (existing === null) {
      await writeNote(
        context,
        pluginsPath,
        `${JSON.stringify(["obsidian-factory"], null, 2)}\n`,
        true,
      );
      enabled = true;
      enableChanged = true;
    } else {
      const updated = addEnabledPlugin(existing, "obsidian-factory");
      enabled = true;
      if (updated.changed) {
        const backup = ".obsidian/community-plugins.json.bak-obsidian-factory";
        await writeNote(context, backup, existing, true);
        await writeNote(context, pluginsPath, updated.json, true);
        enableChanged = true;
        backedUp.push(backup);
      }
    }
  }

  const settings = await ensurePluginData(context);

  const handle = await context.writeResource(
    "operation",
    `operation-${crypto.randomUUID()}`,
    {
      operation: "installBoardPlugin",
      id: base,
      path: base,
      changed: written.length > 0 || enableChanged || settings.changed,
      detail: `written: ${written.join(", ") || "none"}; backed up: ${
        backedUp.join(", ") || "none"
      }; enabled: ${
        enabled ? "yes" : "no"
      }; repoPath default: ${settings.repoPath}. ${
        enableChanged ? "The enabled list changed. " : ""
      }Restart Obsidian once to load the plugin bundle; enabling in Settings lists it immediately but a replaced main.js is only loaded on reload.`,
      timestamp: nowIso(),
    },
  );
  return { dataHandles: [handle] };
}

async function executeCapture(
  args: { text: string; source?: string },
  context: FactoryContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  context.logger.info("Capturing one thought");
  const cards = await readAllCards(context);
  let card = cards.find((item) => item.frontmatter.kind === "inbox");
  if (!card) {
    card = await createCard(
      context,
      "inbox",
      "Uncharacterised",
      "Drop raw thoughts here. Each bullet is one thought.",
    );
  }
  const stamp = nowIso();
  const source = args.source ? ` (${args.source})` : "";
  card.body = appendBullet(
    card.body,
    "Thoughts",
    `${stamp}${source} ${args.text}`,
  );
  await writeCardNote(context, card);
  const handle = await context.writeResource(
    "operation",
    `operation-${crypto.randomUUID()}`,
    {
      operation: "capture",
      id: card.frontmatter.id,
      path: card.path,
      changed: true,
      timestamp: stamp,
    },
  );
  return { dataHandles: [handle] };
}

async function executeScan(
  args: { status?: string; kind?: CardKind; includeBody?: boolean },
  context: FactoryContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  context.logger.info("Scanning the board");
  let cards = await readAllCards(context);
  if (args.status) {
    cards = cards.filter((card) => card.frontmatter.status === args.status);
  }
  if (args.kind) {
    cards = cards.filter((card) => card.frontmatter.kind === args.kind);
  }
  const summaries = cards.map((card) =>
    cardSummary(card, args.includeBody === true)
  );
  const handle = await context.writeResource("board", "board", {
    cards: summaries,
    count: summaries.length,
    statuses: context.globalArgs.statuses,
    timestamp: nowIso(),
  });
  return { dataHandles: [handle] };
}

async function executeReadCard(
  args: { id: string },
  context: FactoryContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  context.logger.info("Reading card {id}", { id: args.id });
  const cards = await readAllCards(context);
  const card = cards.find((item) => cardMatches(item, args.id));
  if (!card) throw new Error(`no card '${args.id}'`);
  const handle = await context.writeResource(
    "card",
    `card-${card.frontmatter.id}`,
    {
      id: card.frontmatter.id,
      display: cardDisplay(card),
      title: String(card.frontmatter.title ?? ""),
      kind: card.frontmatter.kind,
      status: String(card.frontmatter.status ?? ""),
      path: card.path,
      updated: String(card.frontmatter.updated ?? ""),
      project: String(card.frontmatter.project ?? ""),
      body: stripActivity(card.body),
      relations: relationsOf(card),
      timestamp: nowIso(),
    },
  );
  return { dataHandles: [handle] };
}

async function executeUpdateCard(
  args: {
    id: string;
    title?: string;
    body?: string;
    status?: string;
    project?: string;
  },
  context: FactoryContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  context.logger.info("Updating card {id}", { id: args.id });
  const card = await findCard(context, args.id);
  if (!card) throw new Error(`no card '${args.id}'`);
  if (args.title !== undefined) card.frontmatter.title = args.title;
  if (args.project !== undefined) card.frontmatter.project = args.project;
  if (args.status !== undefined) {
    if (!context.globalArgs.statuses.includes(args.status)) {
      throw new Error(`no status '${args.status}'`);
    }
    card.frontmatter.status = args.status;
  }
  if (args.body !== undefined) {
    const preserved = extractManagedSections(card.body);
    card.frontmatter.description = args.body;
    card.body = applyManagedSections(args.body, preserved);
  }
  await writeCardNote(context, card);
  const handle = await context.writeResource(
    "operation",
    `operation-${crypto.randomUUID()}`,
    {
      operation: "updateCard",
      id: card.frontmatter.id,
      path: card.path,
      changed: true,
      timestamp: nowIso(),
    },
  );
  return { dataHandles: [handle] };
}

async function executeDeleteCard(
  args: {
    id: string;
    confirm: "delete";
    permanent?: boolean;
    dryRun?: boolean;
  },
  context: FactoryContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  context.logger.info("Deleting card {id}", { id: args.id });
  const card = await findCard(context, args.id);
  if (!card) throw new Error(`no card '${args.id}'`);
  const runModel = requireRunModel(context);
  const result = await runModel({
    definition: context.globalArgs.vaultModel,
    method: "delete",
    arguments: {
      file: card.path,
      permanent: args.permanent === true,
      dryRun: args.dryRun === true,
      allowDotObsidian: context.globalArgs.allowDotObsidian,
    },
  });
  if (!result.ok) {
    throw new Error(
      `vault delete failed for '${card.path}': ${result.error?.message ?? ""}`,
    );
  }
  const handle = await context.writeResource(
    "operation",
    `operation-${crypto.randomUUID()}`,
    {
      operation: "deleteCard",
      id: card.frontmatter.id,
      path: card.path,
      changed: args.dryRun !== true,
      detail: args.dryRun === true ? "dry run" : "deleted",
      timestamp: nowIso(),
    },
  );
  return { dataHandles: [handle] };
}

async function executeArchiveCard(
  args: {
    id: string;
    outcome: ArchiveOutcome;
    reason: string;
    detail?: string;
    dryRun?: boolean;
  },
  context: FactoryContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  context.logger.info("Archiving card {id} as {outcome}", {
    id: args.id,
    outcome: args.outcome,
  });
  const result = await archiveCard(context, args);
  const handle = await context.writeResource(
    "operation",
    `operation-${crypto.randomUUID()}`,
    { ...result, timestamp: nowIso() },
  );
  return { dataHandles: [handle] };
}

async function executeUnarchiveCard(
  args: { id: string; dryRun?: boolean },
  context: FactoryContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  context.logger.info("Unarchiving card {id}", { id: args.id });
  const result = await unarchiveCard(context, args);
  const handle = await context.writeResource(
    "operation",
    `operation-${crypto.randomUUID()}`,
    { ...result, timestamp: nowIso() },
  );
  return { dataHandles: [handle] };
}

async function executeCreateCategory(
  args: { name: string; summary?: string; ideas?: string[] },
  context: FactoryContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  context.logger.info("Creating a category card");
  const card = await createCard(
    context,
    "category",
    args.name,
    args.summary ?? "",
  );
  for (const idea of args.ideas ?? []) {
    card.body = appendBullet(card.body, "Ideas", idea);
  }
  await writeCardNote(context, card);
  const handle = await context.writeResource(
    "operation",
    `operation-${crypto.randomUUID()}`,
    {
      operation: "createCategory",
      id: card.frontmatter.id,
      path: card.path,
      changed: true,
      timestamp: nowIso(),
    },
  );
  return { dataHandles: [handle] };
}

async function executeCreateAction(
  args: {
    title: string;
    brief?: string;
    source?: string;
    ideas?: string[];
    project?: string;
  },
  context: FactoryContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  context.logger.info("Creating an action card");
  const card = await createCard(
    context,
    "action",
    args.title,
    args.brief ?? "",
    {
      ...(args.source ? { source: args.source } : {}),
      ...(args.project ? { project: args.project } : {}),
    },
  );
  for (const idea of args.ideas ?? []) {
    card.body = appendBullet(card.body, "Ideas", idea);
  }
  await writeCardNote(context, card);
  if (args.source) {
    const source = await findCard(context, args.source);
    if (source) {
      source.frontmatter.lastProposedIdeaCount = countBullets(source.body, [
        "Ideas",
      ]);
      source.frontmatter.lastProposedAt = nowIso();
      await writeCardNote(context, source);
    }
  }
  const handle = await context.writeResource(
    "operation",
    `operation-${crypto.randomUUID()}`,
    {
      operation: "createAction",
      id: card.frontmatter.id,
      path: card.path,
      changed: true,
      timestamp: nowIso(),
    },
  );
  return { dataHandles: [handle] };
}

async function executeMoveIdea(
  args: {
    from: string;
    idea: string;
    to?: string;
    newCategory?: string;
    newCategorySummary?: string;
  },
  context: FactoryContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  context.logger.info("Moving an idea from {from}", { from: args.from });
  const source = await findCard(context, args.from);
  if (!source) throw new Error(`no card '${args.from}'`);
  const headings = source.frontmatter.kind === "inbox"
    ? ["Thoughts", "Ideas"]
    : ["Ideas", "Thoughts"];
  let result: { body: string; removed: string | null } = {
    body: source.body,
    removed: null,
  };
  for (const heading of headings) {
    result = removeBullet(source.body, args.idea, heading);
    if (result.removed !== null) break;
  }
  const removed = result.removed;
  if (removed === null) {
    throw new Error(`no bullet matching '${args.idea}' on '${args.from}'`);
  }
  source.body = result.body;
  let target: Card | null = null;
  if (args.to) {
    target = await findCard(context, args.to);
    if (!target) throw new Error(`no card '${args.to}'`);
  } else {
    if (!args.newCategory) {
      throw new Error("moveIdea needs `to` or `newCategory`");
    }
    target = await createCard(
      context,
      "category",
      args.newCategory,
      args.newCategorySummary ?? "",
    );
  }
  target.body = appendBullet(target.body, "Ideas", removed);
  await writeCardNote(context, source);
  await writeCardNote(context, target);
  const handle = await context.writeResource(
    "operation",
    `operation-${crypto.randomUUID()}`,
    {
      operation: "moveIdea",
      id: target.frontmatter.id,
      path: target.path,
      changed: true,
      detail: `moved from ${source.frontmatter.id}`,
      timestamp: nowIso(),
    },
  );
  return { dataHandles: [handle] };
}

/** The CSS snippet that hides the raw frontmatter block on factory cards. */
const CARD_CSS = `/* Hide Obsidian's raw frontmatter block on factory cards.
   The variables are Obsidian's supported way to hide Properties in reading
   view and live preview; the selectors are a fallback for themes that render
   the metadata container directly. Every rule is scoped to .factory-card, so
   no other note is affected. Source mode still shows the YAML. */
.factory-card {
  --metadata-display-reading: none;
  --metadata-display-editing: none;
}

.factory-card .metadata-container,
.factory-card .frontmatter,
.factory-card .metadata-properties {
  display: none !important;
}
`;

async function executeSetSummary(
  args: {
    id: string;
    stage: string;
    planStatus: PlanStatus;
    needsInput?: string[];
    known?: string[];
    unknown?: string[];
    next: string;
    acceptEdits?: boolean;
  },
  context: FactoryContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  context.logger.info("Summarising card {id}", { id: args.id });
  const card = await findCard(context, args.id);
  if (!card) throw new Error(`no card '${args.id}'`);
  if (args.acceptEdits !== true) {
    const current = extractManaged(card.body, SUMMARY_BEGIN, SUMMARY_END);
    const problem = await managedEditProblem(
      current,
      card.frontmatter.swampSummaryHash,
    );
    if (problem) {
      throw new Error(
        "managed section 'summary' was edited by a person; read the current " +
          "section, copy the changed words into the stage feedback or plan, " +
          "then retry with acceptEdits=true. Current section:\n" + problem,
      );
    }
  }
  const block = renderSummarySection({
    stage: args.stage,
    planStatus: args.planStatus,
    needsInput: args.needsInput ?? [],
    known: args.known ?? [],
    unknown: args.unknown ?? [],
    next: args.next,
  });
  card.frontmatter.swampSummaryHash = await hashText(block);
  card.body = upsertAfterTitle(card.body, SUMMARY_BEGIN, SUMMARY_END, block);
  await writeCardNote(context, card);
  const handle = await context.writeResource(
    "operation",
    `operation-${crypto.randomUUID()}`,
    {
      operation: "setSummary",
      id: card.frontmatter.id,
      path: card.path,
      changed: true,
      timestamp: nowIso(),
    },
  );
  return { dataHandles: [handle] };
}

async function executeMarkPlanProgress(
  args: {
    id: string;
    tasks?: Array<{ match: string; done: boolean }>;
    tests?: Array<{ match: string; done: boolean }>;
    acceptEdits?: boolean;
  },
  context: FactoryContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  context.logger.info("Updating plan progress on {id}", { id: args.id });
  const card = await findCard(context, args.id);
  if (!card) throw new Error(`no card '${args.id}'`);
  const block = extractManaged(card.body, PLAN_BEGIN, PLAN_END);
  if (block === null) throw new Error(`card '${args.id}' has no Plan section`);
  if (args.acceptEdits !== true) {
    const problem = await managedEditProblem(
      block,
      card.frontmatter.swampPlanHash,
    );
    if (problem) {
      throw new Error(
        "managed section 'plan' was edited by a person; read the current " +
          "section, copy the changed words into the stage feedback, then retry " +
          "with acceptEdits=true. Current section:\n" + problem,
      );
    }
  }
  const updated = updatePlanCheckboxes(block, {
    tasks: args.tasks ?? [],
    tests: args.tests ?? [],
  });
  if (updated.changed > 0) {
    card.frontmatter.swampPlanHash = await hashText(updated.block);
    card.body = upsertManaged(
      card.body,
      PLAN_BEGIN,
      PLAN_END,
      updated.block,
      PLAN_HEADINGS,
    );
    await writeCardNote(context, card);
  }
  const handle = await context.writeResource(
    "operation",
    `operation-${crypto.randomUUID()}`,
    {
      operation: "markPlanProgress",
      id: card.frontmatter.id,
      path: card.path,
      changed: updated.changed > 0,
      detail: updated.unmatched.length > 0
        ? `unmatched: ${updated.unmatched.join(", ")}`
        : undefined,
      timestamp: nowIso(),
    },
  );
  return { dataHandles: [handle] };
}

async function executeSetPlan(
  args: {
    id: string;
    status: PlanStatus;
    summary: string;
    tasks?: PlanTaskInput[];
    tests?: PlanTestInput[];
    existing?: string[];
    added?: string[];
    removed?: string[];
    known?: string[];
    unknown?: string[];
    acceptEdits?: boolean;
  },
  context: FactoryContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  context.logger.info("Writing the plan section on {id}", { id: args.id });
  const card = await findCard(context, args.id);
  if (!card) throw new Error(`no card '${args.id}'`);
  if (args.acceptEdits !== true) {
    const current = extractManaged(card.body, PLAN_BEGIN, PLAN_END);
    const problem = await managedEditProblem(
      current,
      card.frontmatter.swampPlanHash,
    );
    if (problem) {
      throw new Error(
        "managed section 'plan' was edited by a person; read the current " +
          "section, copy the changed words into the plan feedbackIncorporated " +
          "or the stage feedback, then retry with acceptEdits=true. Current " +
          "section:\n" + problem,
      );
    }
  }
  const block = renderPlanSection({
    status: args.status,
    summary: args.summary,
    tasks: args.tasks ?? [],
    tests: args.tests ?? [],
    existing: args.existing ?? [],
    added: args.added ?? [],
    removed: args.removed ?? [],
    known: args.known ?? [],
    unknown: args.unknown ?? [],
  });
  card.frontmatter.swampPlanHash = await hashText(block);
  card.body = upsertManaged(
    card.body,
    PLAN_BEGIN,
    PLAN_END,
    block,
    PLAN_HEADINGS,
  );
  await writeCardNote(context, card);
  const handle = await context.writeResource(
    "operation",
    `operation-${crypto.randomUUID()}`,
    {
      operation: "setPlan",
      id: card.frontmatter.id,
      path: card.path,
      changed: true,
      timestamp: nowIso(),
    },
  );
  return { dataHandles: [handle] };
}

async function executeInstallCardCss(
  args: { force?: boolean },
  context: FactoryContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  context.logger.info("Installing the factory-card CSS snippet");
  const path = ".obsidian/snippets/obsidian-factory.css";
  const existing = await readNote(context, path, true);
  let action: "created" | "unchanged" | "updated" = "unchanged";
  if (existing === null) {
    await writeNote(context, path, CARD_CSS, true);
    action = "created";
  } else if (args.force === true && existing !== CARD_CSS) {
    await writeNote(context, path, CARD_CSS, true);
    action = "updated";
  }
  const handle = await context.writeResource(
    "operation",
    `operation-${crypto.randomUUID()}`,
    {
      operation: "installCardCss",
      id: "css",
      path,
      changed: action !== "unchanged",
      detail:
        `${action}; enable the snippet in Settings -> Appearance -> CSS snippets`,
      timestamp: nowIso(),
    },
  );
  return { dataHandles: [handle] };
}

async function migrateCardsInternal(
  context: FactoryContext,
  dryRun = false,
): Promise<number> {
  const cards = await readAllCards(context);
  let changed = 0;
  for (const card of cards) {
    let touched = false;
    const classes = Array.isArray(card.frontmatter.cssclasses)
      ? card.frontmatter.cssclasses as string[]
      : [];
    if (!classes.includes("factory-card")) {
      card.frontmatter.cssclasses = [...classes, "factory-card"];
      touched = true;
    }
    const sections = extractManagedSections(card.body);
    const stage = typeof card.frontmatter.status === "string"
      ? card.frontmatter.status
      : "Unknown";
    const summary = sections.summary ??
      renderSummarySection({
        stage,
        planStatus: "none",
        needsInput: [],
        known: [],
        unknown: ["The factory has not summarised this card yet."],
        next: "Waiting for the factory to update this card.",
      });
    const plan = sections.plan ??
      renderPlanSection({
        status: "none",
        summary: "The factory has not written a plan for this card yet.",
        tasks: [],
        tests: [],
        existing: [],
        added: [],
        removed: [],
        known: [],
        unknown: [],
      });
    const definition = sections.definition ??
      renderDefinitionSection({
        status: "unknown",
        note:
          "The factory has not recorded which definition this card uses yet; the next tick will set it.",
      });
    const ordered = collapseDuplicateHeadings(
      applyManagedSections(card.body, {
        summary,
        plan,
        definition,
        activity: sections.activity,
      }),
    );
    if (ordered !== card.body) {
      card.body = ordered;
      touched = true;
    }
    if (touched) {
      if (!dryRun) await writeCardNote(context, card);
      changed++;
    }
  }
  return changed;
}

async function executeMigrateCards(
  _args: Record<string, never>,
  context: FactoryContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  context.logger.info("Migrating cards to the readable card layout");
  const changed = await migrateCardsInternal(context);
  const handle = await context.writeResource(
    "operation",
    `operation-${crypto.randomUUID()}`,
    {
      operation: "migrateCards",
      id: "all",
      path: cardsFolder(context),
      changed: changed > 0,
      detail: `${changed} card(s) updated`,
      timestamp: nowIso(),
    },
  );
  return { dataHandles: [handle] };
}

async function executeSetDefinition(
  args: {
    id: string;
    status: DefinitionInput["status"];
    note: string;
  },
  context: FactoryContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  context.logger.info("Recording the definition status on {id}", {
    id: args.id,
  });
  const card = await findCard(context, args.id);
  if (!card) throw new Error(`no card '${args.id}'`);
  card.body = upsertManaged(
    card.body,
    DEFINITION_BEGIN,
    DEFINITION_END,
    renderDefinitionSection({ status: args.status, note: args.note }),
    DEFINITION_HEADINGS,
  );
  await writeCardNote(context, card);
  const handle = await context.writeResource(
    "operation",
    `operation-${crypto.randomUUID()}`,
    {
      operation: "setDefinition",
      id: card.frontmatter.id,
      path: card.path,
      changed: true,
      timestamp: nowIso(),
    },
  );
  return { dataHandles: [handle] };
}

/** The global Obsidian config path for this platform. */
export function obsidianConfigPath(): string | null {
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE");
  if (!home) return null;
  if (Deno.build.os === "darwin") {
    return `${home}/Library/Application Support/obsidian/obsidian.json`;
  }
  if (Deno.build.os === "windows") {
    const appData = Deno.env.get("APPDATA");
    return appData ? `${appData}\\obsidian\\obsidian.json` : null;
  }
  const configHome = Deno.env.get("XDG_CONFIG_HOME") ?? `${home}/.config`;
  return `${configHome}/obsidian/obsidian.json`;
}

/** Idempotently set the global Obsidian "cli" flag. */
async function enableObsidianCli(
  dryRun: boolean,
): Promise<{
  status: "already" | "configured" | "would-configure" | "missing" | "error";
  path: string;
  restartRequired: boolean;
  detail?: string;
}> {
  const path = obsidianConfigPath();
  if (!path) {
    return {
      status: "missing",
      path: "",
      restartRequired: false,
      detail: "no home directory",
    };
  }
  let raw: string;
  try {
    raw = await Deno.readTextFile(path);
  } catch (error) {
    return {
      status: "missing",
      path,
      restartRequired: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  let data: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)) throw new Error("config is not an object");
    data = parsed;
  } catch (error) {
    return {
      status: "error",
      path,
      restartRequired: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  const configured = data.cli === true;
  if (configured) {
    return {
      status: "already",
      path,
      restartRequired: true,
      detail:
        "cli is true in the global config; the running Obsidian still needs a restart/reload to start the CLI",
    };
  }
  if (dryRun) {
    return {
      status: "would-configure",
      path,
      restartRequired: true,
      detail: "would set cli=true in the global Obsidian config",
    };
  }
  const backup = `${path}.bak-obsidian-factory`;
  try {
    await Deno.stat(backup);
  } catch {
    await Deno.writeTextFile(backup, raw);
  }
  data.cli = true;
  const temp = `${path}.tmp-${crypto.randomUUID()}`;
  await Deno.writeTextFile(temp, JSON.stringify(data));
  await Deno.rename(temp, path);
  return {
    status: "configured",
    path,
    restartRequired: true,
    detail: "cli=true written; restart/reload Obsidian once to start the CLI",
  };
}

/** Install the snippet and add it to Obsidian's enabled snippets. */
async function ensureCardCss(
  context: FactoryContext,
  dryRun: boolean,
): Promise<{ snippet: string; appearance: string; enabled: boolean }> {
  const snippetPath = ".obsidian/snippets/obsidian-factory.css";
  const appearancePath = ".obsidian/appearance.json";
  let snippet = "unchanged";
  const existingSnippet = await readNote(context, snippetPath, true);
  if (existingSnippet === null) {
    if (!dryRun) await writeNote(context, snippetPath, CARD_CSS, true);
    snippet = dryRun ? "would-create" : "created";
  } else if (existingSnippet !== CARD_CSS) {
    // The snippet is extension-managed: keep it current on every tick. Back up
    // the previous content once so a person's edit is not lost.
    const backupPath = `${snippetPath}.bak-obsidian-factory`;
    if (!dryRun) {
      if ((await readNote(context, backupPath, true)) === null) {
        await writeNote(context, backupPath, existingSnippet, true);
      }
      await writeNote(context, snippetPath, CARD_CSS, true);
    }
    snippet = dryRun ? "would-update" : "updated";
  }

  const raw = await readNote(context, appearancePath, true);
  let parsed: Record<string, unknown> = {};
  if (raw !== null) {
    try {
      const value = JSON.parse(raw);
      if (!isRecord(value)) {
        return { snippet, appearance: "invalid", enabled: false };
      }
      parsed = value;
    } catch {
      return { snippet, appearance: "invalid", enabled: false };
    }
  }
  const list = Array.isArray(parsed.enabledCssSnippets)
    ? parsed.enabledCssSnippets.filter((item): item is string =>
      typeof item === "string"
    )
    : [];
  if (list.includes("obsidian-factory")) {
    return { snippet, appearance: "unchanged", enabled: true };
  }
  if (dryRun) {
    return { snippet, appearance: "would-enable", enabled: false };
  }
  const backupPath = `${appearancePath}.bak-obsidian-factory`;
  if ((await readNote(context, backupPath, true)) === null) {
    await writeNote(context, backupPath, raw ?? "{}\n", true);
  }
  parsed.enabledCssSnippets = [...list, "obsidian-factory"];
  await writeNote(
    context,
    appearancePath,
    `${JSON.stringify(parsed, null, 2)}\n`,
    true,
  );
  return {
    snippet,
    appearance: raw === null ? "created" : "updated",
    enabled: true,
  };
}

/** Repin cards that have no recorded work; mark the rest as pinned. */
async function upgradeDefinitions(
  context: FactoryContext,
  factoryDefinition: string,
  dryRun: boolean,
): Promise<{ repinned: string[]; pinned: string[]; errors: string[] }> {
  const repinned: string[] = [];
  const pinned: string[] = [];
  const errors: string[] = [];
  if (!factoryDefinition) {
    return {
      repinned,
      pinned,
      errors: ["no factoryDefinition supplied; definition upgrade skipped"],
    };
  }
  if (!context.readModelData) {
    return {
      repinned,
      pinned,
      errors: [
        "context.readModelData is unavailable; definition upgrade skipped",
      ],
    };
  }
  const cards = await readAllCards(context);
  for (const card of cards) {
    const key = card.frontmatter.id.toLowerCase();
    const runs = await context.readModelData(key, "run");
    const run = runs.length > 0 ? runs[0].attributes : null;
    const known = card.frontmatter.factoryDefinition === factoryDefinition;
    let status: DefinitionInput["status"] = "unknown";
    let note = "";
    let touched = false;

    if (!run) {
      status = "current";
      note =
        "No work item yet; a new work item will use the current factory definition.";
      if (!known) {
        card.frontmatter.factoryDefinition = factoryDefinition;
        touched = true;
      }
    } else if (run.status === "terminal") {
      status = "finished";
      note =
        "Finished on its pinned definition; a new work item will use the current definition.";
      if (!known) {
        card.frontmatter.factoryDefinition = factoryDefinition;
        touched = true;
      }
    } else if (known) {
      // This tick already recorded the version; leave it alone.
      continue;
    } else {
      const products = isRecord(run.products) ? run.products : {};
      const artifacts = isRecord(products.artifacts)
        ? Object.keys(products.artifacts)
        : [];
      const evidence = isRecord(products.evidence)
        ? Object.keys(products.evidence)
        : [];
      const approvals = Array.isArray(run.approvals) ? run.approvals : [];
      const column = typeof card.frontmatter.status === "string"
        ? card.frontmatter.status
        : "";
      const prePlan = ["Uncharacterised", "Category", "Proposed"].includes(
        column,
      );
      // `card-kind` is the route artifact; recomputing it loses nothing. Any
      // other product, any approval, or a card the person has already moved on
      // to Please Plan or later is not safe to restart.
      const onlyRouteProduct = artifacts.every((name) => name === "card-kind");
      const safe = prePlan && onlyRouteProduct && evidence.length === 0 &&
        approvals.length === 0;
      if (safe) {
        if (!context.runModel) {
          errors.push(`${key}: context.runModel is unavailable`);
          continue;
        }
        if (dryRun) {
          repinned.push(key);
          status = "repinned";
          note = "Would be repinned to the current definition by this tick.";
        } else {
          const stage = typeof run.stage === "string" ? run.stage : "route";
          const entries = isRecord(run.entries) ? run.entries : {};
          const cycle = typeof entries[stage] === "number" ? entries[stage] : 1;
          const era = typeof run.era === "string" ? run.era : "";
          const result = await context.runModel!({
            definition: key,
            method: "reset",
            arguments: {
              confirm: "reset",
              repin: "true",
              expectedStage: stage,
              expectedCycle: cycle,
              expectedEra: era,
            },
          });
          if (result.ok) {
            repinned.push(key);
            status = "repinned";
            note =
              "Repinned to the current factory definition by this tick; the work item starts again at route.";
            card.frontmatter.factoryDefinition = factoryDefinition;
          } else {
            errors.push(`${key}: ${result.error?.message ?? "reset failed"}`);
            status = "pinned";
            note = `Could not repin: ${
              result.error?.message ?? "reset failed"
            }. It stays on its pinned definition.`;
          }
          touched = true;
        }
      } else {
        pinned.push(key);
        status = "pinned";
        note =
          "Pinned to the definition it started with; it will use the current definition when it finishes or is reopened.";
        card.frontmatter.factoryDefinition = factoryDefinition;
        touched = true;
      }
    }

    if (touched && !dryRun) {
      card.body = upsertManaged(
        card.body,
        DEFINITION_BEGIN,
        DEFINITION_END,
        renderDefinitionSection({ status, note }),
        DEFINITION_HEADINGS,
      );
      await writeCardNote(context, card);
    }
  }
  return { repinned, pinned, errors };
}

async function executeTick(
  args: {
    factoryDefinition?: string;
    upgradeDefinitions?: boolean;
    dryRun?: boolean;
  },
  context: FactoryContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  context.logger.info("Ticking the Obsidian factory");
  // Board first: read the actual columns before any housekeeping or work.
  // A card's column is the person's instruction; the work item must follow it.
  const queue = await executeQueue({}, context);
  context.logger.info("Board at tick start: {board}", {
    board: queue.cards.map((card) =>
      `${card.id} [${card.column}] ${card.action}`
    ).join(" | "),
  });
  const dryRun = args.dryRun === true;
  const plugin = await ensurePluginData(context, dryRun);
  const cli = await enableObsidianCli(dryRun);
  const css = await ensureCardCss(context, dryRun);
  const migrated = await migrateCardsInternal(context, dryRun);
  const upgrade = args.upgradeDefinitions === false
    ? { repinned: [], pinned: [], errors: ["definition upgrade disabled"] }
    : await upgradeDefinitions(
      context,
      args.factoryDefinition ?? "",
      dryRun,
    );
  const handle = await context.writeResource("tick", "tick", {
    board: queue.cards,
    counts: queue.counts,
    plugin,
    cli,
    css,
    migrated,
    repinned: upgrade.repinned,
    pinned: upgrade.pinned,
    errors: upgrade.errors,
    factoryDefinition: args.factoryDefinition ?? "",
    dryRun,
    timestamp: nowIso(),
  });
  return { dataHandles: [handle] };
}

/** Build the self-contained prompt the tick agent receives. */
export function buildTickPrompt(
  repo: string,
  cards: Array<z.infer<typeof QueueCardSchema>>,
  counts: z.infer<typeof QueueSchema>["counts"],
): { prompt: string; systemPrompt: string } {
  const work = cards.filter((card) =>
    card.action === "work" || card.action === "claim"
  );
  const board = cards.map((card) =>
    `- ${card.id} [${card.column}] action=${card.action} ` +
    `stage=${card.stage || "-"} cycle=${card.cycle} ` +
    `title=${JSON.stringify(card.title)}`
  ).join("\n");
  const workLines = work.length === 0
    ? "- (none: every card is waiting on the person or is done)"
    : work.map((card) =>
      `- ${card.id} [${card.column}] action=${card.action} ` +
      `stage=${card.stage || "-"} cycle=${card.cycle} ` +
      `title=${JSON.stringify(card.title)} path=${card.path}`
    ).join("\n");
  const prompt = [
    "You are the Obsidian factory tick agent. Work ONLY on the board in this",
    "repository; do not work on any other project task.",
    "",
    `Repository: ${repo || "(the current working directory)"}`,
    `Board snapshot: ${cards.length} cards ` +
    `(${counts.work} work, ${counts.claim} claim, ${counts.wait} wait, ` +
    `${counts.done} done).`,
    "",
    "Every card and its action:",
    board || "- (the board is empty)",
    "",
    "Cards you must act on now:",
    workLines,
    "",
    "RULES:",
    "1. Your FIRST action is to read `.agents/skills/obsidian-factory/SKILL.md`",
    "   in this repository and follow it. Load the stagecraft skill it names.",
    "2. Do NOT read context.md, BLOG_PLAN.md, TODO.md, release-train.md, or",
    "   any other project task/context file. They describe unrelated work.",
    "   Do NOT use /testbed.",
    "3. Act only on rows with action work or claim. wait and done are the",
    "   person's columns: leave them untouched.",
    "4. For each work row: read the card, do the column's work, use the",
    "   obsidian-board behavior (never edit the vault by hand), record the",
    "   stage artifact, update At a glance and Plan, and tick the Plan tasks",
    "   and tests as you complete them.",
    "5. A card move is the person's decision: do not reset, pause or ask for",
    "   a legal transition. If the ledger disagrees with the column, the card",
    "   wins.",
    "6. Stop at Proposed, Work Planned and User Acceptance. Never publish.",
    "7. At the end, print a short `Factory tick result` section naming every",
    "   card you touched and what changed. If you could not do a card, say why.",
    "",
    "The queue is also available with:",
    '  swamp data query \'behaviorName == "obsidian-board" && name == "queue"\' --select content --single --json',
  ].join("\n");
  const systemPrompt = [
    "You are the Obsidian factory tick agent. Read",
    "`.agents/skills/obsidian-factory/SKILL.md` first and follow it. The card",
    "column is the only truth; the work item is an internal ledger. Do not read",
    "context.md or unrelated project task files. Do not publish. Stop at the",
    "person's columns.",
  ].join("\n");
  return { prompt, systemPrompt };
}

/** Read the board, write the queue and write the self-contained tick brief. */
async function executeBrief(
  args: { repo: string },
  context: FactoryContext,
): Promise<{
  dataHandles: Array<{ name: string }>;
  prompt: string;
}> {
  const queue = await executeQueue({}, context);
  const { prompt, systemPrompt } = buildTickPrompt(
    args.repo,
    queue.cards,
    queue.counts,
  );
  const handle = await context.writeResource("brief", "brief", {
    prompt,
    systemPrompt,
    board: queue.cards,
    counts: queue.counts,
    repo: args.repo,
    timestamp: nowIso(),
  });
  context.logger.info("Wrote tick brief for {count} cards ({work} to work)", {
    count: queue.cards.length,
    work: queue.counts.work + queue.counts.claim,
  });
  return { dataHandles: [handle], prompt };
}

async function executeQueue(
  args: { status?: string; kind?: CardKind },
  context: FactoryContext,
): Promise<{
  dataHandles: Array<{ name: string }>;
  cards: Array<z.infer<typeof QueueCardSchema>>;
  counts: {
    claim: number;
    work: number;
    reconcile: number;
    done: number;
    wait: number;
  };
}> {
  context.logger.info("Queueing the board for {factory}", {
    factory: context.globalArgs.factory,
  });
  if (!context.readModelData) {
    throw new Error(
      "context.readModelData is unavailable; queue needs stagecraft work-item data",
    );
  }
  let cards = await readAllCards(context);
  if (args.status) {
    cards = cards.filter((card) => card.frontmatter.status === args.status);
  }
  if (args.kind) {
    cards = cards.filter((card) => card.frontmatter.kind === args.kind);
  }
  const rows: Array<z.infer<typeof QueueCardSchema>> = [];
  const counts = { claim: 0, work: 0, reconcile: 0, done: 0, wait: 0 };
  for (const card of cards) {
    const key = card.frontmatter.id.toLowerCase();
    const runs = await context.readModelData(key, "run");
    const run = runs.length > 0 ? runs[0].attributes : null;
    const column = typeof card.frontmatter.status === "string"
      ? card.frontmatter.status
      : "";
    let stage = "";
    let cycle = 0;
    let era = "";
    let terminal = false;
    if (run) {
      stage = typeof run.stage === "string" ? run.stage : "";
      const entries = isRecord(run.entries) ? run.entries : {};
      const count = entries[stage];
      cycle = typeof count === "number" ? count : 0;
      era = typeof run.era === "string" ? run.era : "";
      terminal = run.status === "terminal";
    }
    // The card's column decides the work. The work item's stage/cycle is a
    // ledger and is never consulted for the action; if it disagrees, the card
    // wins. Only an inbox/category needs the new-input check for reopening.
    const newInput = terminal ? shouldReopenTerminal(card, column) : true;
    let releasePrepared = false;
    if (column === "Please Release" && run) {
      const evidence = await context.readModelData(key, "evidence");
      const find = (name: string) =>
        evidence.find((item) => item.name === name);
      const checks = find("evidence-release-checks");
      const reports = find("evidence-release-report");
      const releases = find("evidence-release");
      const check = checks ? checks.attributes : null;
      const payload = isRecord(check) && isRecord(check.payload)
        ? check.payload
        : null;
      const passed = (isRecord(check) && check.status === "passed") ||
        (payload !== null && payload.status === "passed");
      releasePrepared = reports !== undefined && releases === undefined &&
        passed;
    }
    const action = queueActionFor(
      column,
      Boolean(run),
      terminal,
      newInput,
      releasePrepared,
    );
    counts[action]++;
    rows.push({
      id: card.frontmatter.id,
      display: cardDisplay(card),
      title: typeof card.frontmatter.title === "string"
        ? card.frontmatter.title
        : card.frontmatter.id,
      kind: card.frontmatter.kind,
      column,
      path: card.path,
      project: typeof card.frontmatter.project === "string"
        ? card.frontmatter.project
        : "",
      key,
      stage,
      cycle,
      era,
      terminal,
      moves: movesForStatus(column),
      action,
    });
  }
  const handle = await context.writeResource("queue", "queue", {
    cards: rows,
    counts,
    factory: context.globalArgs.factory,
    statuses: context.globalArgs.statuses,
    timestamp: nowIso(),
  });
  return { dataHandles: [handle], cards: rows, counts };
}

/** The tracker: stagecraft's contract 1 over an Obsidian board. */
export const model = {
  type: "@svendowideit/obsidian-factory",
  version: "2026.11.08.27",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.11.08.1",
      description:
        "Add the readable At a glance and Plan card sections (setSummary, " +
        "setPlan), the factory-card CSS class and snippet (installCardCss, " +
        "migrateCards). No global-argument or resource schema changes.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.11.08.2",
      description:
        "Add the idempotent tick (automatic CSS snippet enablement, card " +
        "migration, safe definition repin) and the Definition card section. " +
        "No global-argument or resource schema changes.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.11.08.3",
      description:
        "Fix the card metadata hiding: the tick now keeps the snippet content " +
        "current and the snippet uses Obsidian's supported " +
        "--metadata-display-reading/editing variables, with the previous " +
        "snippet backed up. No global-argument or resource schema changes.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.11.08.4",
      description:
        "Add idempotent Obsidian CLI enablement to the tick: set cli=true in " +
        "the global obsidian.json with a backup, and report the restart " +
        "requirement. No global-argument or resource schema changes.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.11.08.5",
      description:
        "Fix appendBullet so a new idea stays under its section heading: it " +
        "now inserts after the last bullet instead of after a managed marker " +
        "or prose line. This repairs moveIdea/createAction placement. No " +
        "global-argument or resource schema changes.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.11.08.6",
      description:
        "Teach the bundled skill that a person may edit any part of a card, " +
        "not only ## Feedback: every stage reads the whole card and treats " +
        "new or changed words as feedback. No global-argument or resource " +
        "schema changes.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.11.08.7",
      description:
        "Make the card top-heavy: At a glance now sits directly under the " +
        "title and shows Needs your input first; Questions and Feedback sit " +
        "above the Plan; Definition and Activity move to the bottom. setSummary " +
        "takes a needsInput list. The tick re-lays out existing cards.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.11.08.8",
      description:
        "Protect managed sections from silent overwrites: setSummary and " +
        "setPlan store a hash and refuse when a person edited the section, " +
        "with acceptEdits=true only after the edits are captured. This is the " +
        "fix for answers typed into Needs your input being lost.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.11.08.9",
      description:
        "Collapse an empty duplicated heading (for example two ## Questions " +
        "in a row) on every card write and during migration. No global " +
        "argument or resource schema changes.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.11.08.10",
      description:
        "Board first on every tick: read the actual card columns and queue " +
        "actions before any housekeeping, and report them in the tick data and " +
        "log. The tick no longer assumes the work item stage is the board.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.11.08.11",
      description:
        "Derive the queue action from the card column, not the work item " +
        "stage. The card is the only source of truth; stagecraft is an " +
        "internal ledger. A card in Work Planned, Proposed or User Acceptance " +
        "waits; a card in Please Plan, Please Implement, Please Test or Please " +
        "Release works. No reset or pause for a card move.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.11.08.12",
      description:
        "Add the optional Obsidian Factory board plugin and installBoardPlugin: " +
        "a read-only card dialog opened from the native Kanban, with a verified " +
        "bundle hash and per-file backups. The plugin is never auto-enabled.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.11.08.13",
      description:
        "Spell out the after-install step: enable Obsidian Factory in Settings -> " +
        "Community plugins; if it is not listed, reload or restart Obsidian once. " +
        "Enabling loads the plugin immediately; no second restart.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.11.08.14",
      description:
        "installBoardPlugin takes enable (default true): add obsidian-factory to " +
        "community-plugins.json with a backup, and report the required restart. " +
        "The plugin now intercepts workspace.openLinkText for card paths, so " +
        "clicking a Bases Kanban card opens the dialog instead of navigating.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.11.08.15",
      description:
        "Add markPlanProgress: tick or untick Plan task/test checkboxes by a " +
        "unique text match, update the plan hash, and refuse a person-edited " +
        "plan unless acceptEdits=true. The implement/test/release prompts use it.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.11.08.16",
      description:
        "Fix stripManaged to remove every copy of a managed block, not only " +
        "the first. Repeated setPlan calls had left duplicate Plan blocks and " +
        "duplicated task/test lines.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.11.08.17",
      description:
        "A prepared Please Release card now waits for the human publish. Once " +
        "release-checks passed and a release-report exists, the queue action " +
        "is wait instead of rerunning the release checks. The factory never " +
        "runs git push or swamp extension push.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.11.08.18",
      description:
        "Add documented normal-move data to scan/board/queue and move buttons " +
        "to the plugin: on the Bases kanban card face, in the card dialog, and " +
        "in the command palette. A move writes the card's status.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.11.08.19",
      description:
        "Put the move buttons and Open in editor at the top of the card face " +
        "and the dialog, in one action row, as the person asked.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.11.08.20",
      description:
        "Fix the prepared-release wait: stagecraft evidence lives under the " +
        "'evidence' spec, so look up evidence-release-checks/report/release " +
        "by data name. A prepared Please Release card now waits for the human " +
        "publish instead of rerunning checks.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.11.08.21",
      description:
        "Add the tick workflow and the plugin Tick action: housekeeping, " +
        "queue, then one @maphew/agent-task run. The plugin gets settings for " +
        "repo path, swamp binary, agent and model, plus a ribbon/command.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.11.08.22",
      description:
        "The tick and installBoardPlugin idempotently write the plugin's " +
        "data.json repoPath default (and missing swampBinary/agent/model " +
        "defaults), preserving any existing settings. The plugin reloads " +
        "settings on each Tick click.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.11.08.23",
      description:
        "Add a persistent Obsidian status bar for the tick (ticking Ns, done, " +
        "failed) and a live factory tick log modal, opened by the status bar " +
        "or the Show factory tick log command; failures open the log.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.11.08.24",
      description:
        "Give the spawned tick a PATH that includes ~/.pi/agent/bin, " +
        "~/.local/bin, ~/.opencode/bin and the nvm Node bins. This fixes the " +
        "agent exiting 127 because pi's #!/usr/bin/env node could not find node " +
        "under Obsidian's minimal PATH.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.11.08.25",
      description:
        "Add the brief method and resource: the tick hands the agent a " +
        "self-contained board/queue snapshot and hard rules (read the factory " +
        "skill, do not read unrelated project context, act only on work/claim " +
        "rows). Add a workflow-scope tick report with board, queue and agent " +
        "output; make the card and tick-log dialogs selectable and copyable.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.11.08.26",
      description:
        "The plugin resolves pi's configured default provider/model when its " +
        "model setting is empty and passes it explicitly to the tick, so pi " +
        "cannot drift onto a weak last-used local model. The agent output " +
        "now shows the pinned model in the tick report.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.11.08.27",
      description:
        "Add archiveCard and unarchiveCard: a verified copy into the Archive " +
        "folder with outcome, reason, optional detail, archive date and the " +
        "column the card left, then the original moves to the vault's trash. " +
        "Add Archive.base and Archive.md to installBoard, the archive and " +
        "unarchive workflows, the plugin's Archive and Unarchive commands and " +
        "dialog button with optional webhook settings. No global-argument or " +
        "resource schema changes.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    description: {
      description: "What this tracker is, for stagecraft's tracker binding",
      schema: DescriptionSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    answer: {
      description: "One tracker operation's answer, or its failure",
      schema: AnswerSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    board: {
      description: "Every card on the Obsidian board, as a summary",
      schema: BoardSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    queue: {
      description:
        "Every card with its board column, stagecraft stage and the next action",
      schema: QueueSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    brief: {
      description:
        "The self-contained prompt and board/queue snapshot handed to the tick agent",
      schema: BriefSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    tick: {
      description:
        "One factory tick's CSS, card migration and definition-upgrade report",
      schema: TickSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    card: {
      description: "One card's body, status and relations",
      schema: CardSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    install: {
      description: "What installBoard wrote, and what it left alone",
      schema: InstallSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    operation: {
      description: "A board operation's result",
      schema: OperationSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  methods: {
    describe: {
      description:
        "Describe this tracker to stagecraft: contract 1, snapshot origin, no history/assign/pull-request capability",
      arguments: z.object({}),
      execute: executeDescribe,
    },
    operate: {
      description:
        "Make one stagecraft tracker operation against the Obsidian board, and write its answer",
      arguments: z.object({
        operation: z.string(),
        request: z.union([z.record(z.string(), z.unknown()), z.string()]),
        answer: z.string().min(1),
        run: z.string().min(1),
      }),
      execute: executeOperate,
    },
    installBoard: {
      description:
        "Create the Bases Kanban board, page, card templates and the one uncharacterised inbox card in the vault",
      arguments: z.object({
        force: z.boolean().default(false).describe(
          "Rewrite Board.base, Board.md, Guide.md and the templates even when they exist",
        ),
      }),
      execute: executeInstallBoard,
    },
    installBoardPlugin: {
      description:
        "Install the optional Obsidian Factory plugin into .obsidian/plugins/obsidian-factory: verify the bundle hash, back up changed files to *.bak-obsidian-factory, and by default add obsidian-factory to .obsidian/community-plugins.json with a backup. Restart Obsidian once to load the bundle.",
      arguments: z.object({
        enable: z.boolean().default(true).describe(
          "Add obsidian-factory to .obsidian/community-plugins.json; restart Obsidian once to load it",
        ),
      }),
      execute: executeInstallBoardPlugin,
    },
    capture: {
      description:
        "Append one raw thought to the uncharacterised inbox card (creating it when absent)",
      arguments: z.object({
        text: z.string().min(1),
        source: z.string().optional(),
      }),
      execute: executeCapture,
    },
    scan: {
      description:
        "Read every card on the board and write a summary list, optionally filtered by status or kind",
      arguments: z.object({
        status: z.string().optional(),
        kind: z.enum(CARD_KINDS).optional(),
        includeBody: z.boolean().default(false),
      }),
      execute: executeScan,
    },
    queue: {
      description:
        "Join every card to its stagecraft run and say whether it needs a claim, work, a person's move reconciled, or nothing",
      arguments: z.object({
        status: z.string().optional(),
        kind: z.enum(CARD_KINDS).optional(),
      }),
      execute: executeQueue,
    },
    brief: {
      description:
        "Write the self-contained tick brief: the board snapshot, the exact queue, and the rules for the agent. Replaces a generic prompt the agent can misread.",
      arguments: z.object({
        repo: z.string().default("").describe(
          "Absolute path to the swamp repository the agent must work in",
        ),
      }),
      execute: executeBrief,
    },
    tick: {
      description:
        "Run the idempotent factory tick: install/enable the card CSS snippet, migrate readable sections, progressively repin safe cards to the current factory definition, and refresh the queue",
      arguments: z.object({
        factoryDefinition: z.string().default("").describe(
          "The current factory definition version or digest, e.g. a sha256 of the factory model file; empty skips definition upgrades",
        ),
        upgradeDefinitions: z.boolean().default(true),
        dryRun: z.boolean().default(false),
      }),
      execute: executeTick,
    },
    markPlanProgress: {
      description:
        "Tick or untick Plan task/test checkboxes by matching text, and update the stored plan hash. Refuses a person-edited plan unless acceptEdits=true.",
      arguments: z.object({
        id: z.string().min(1),
        tasks: z.array(z.object({
          match: z.string().min(1),
          done: z.boolean(),
        })).default([]),
        tests: z.array(z.object({
          match: z.string().min(1),
          done: z.boolean(),
        })).default([]),
        acceptEdits: z.boolean().default(false),
      }),
      execute: executeMarkPlanProgress,
    },
    setDefinition: {
      description:
        "Write the card's Definition section: current, pinned, repinned, finished or unknown",
      arguments: z.object({
        id: z.string().min(1),
        status: z.enum([
          "current",
          "pinned",
          "repinned",
          "finished",
          "unknown",
        ]),
        note: z.string().min(1),
      }),
      execute: executeSetDefinition,
    },
    readCard: {
      description: "Read one card's body, status and relations",
      arguments: z.object({ id: z.string().min(1) }),
      execute: executeReadCard,
    },
    setSummary: {
      description:
        "Write the card's human-readable At a glance section at the top of the note: stage, plan status, what needs the person's input, known, unknown and next",
      arguments: z.object({
        id: z.string().min(1),
        stage: z.string().min(1),
        planStatus: z.enum(["none", "draft", "final"]),
        needsInput: z.array(z.string()).default([]),
        known: z.array(z.string()).default([]),
        unknown: z.array(z.string()).default([]),
        next: z.string().min(1),
        acceptEdits: z.boolean().default(false).describe(
          "Overwrite a summary a person edited; only after copying the edits into the stage feedback",
        ),
      }),
      execute: executeSetSummary,
    },
    setPlan: {
      description:
        "Write the card's human-readable Plan section: checkbox tasks, tests, existing changes, added/removed functionality, and known/unknown",
      arguments: z.object({
        id: z.string().min(1),
        status: z.enum(["none", "draft", "final"]),
        summary: z.string().min(1),
        tasks: z.array(z.object({
          description: z.string().min(1),
          files: z.array(z.string()).default([]),
          done: z.boolean().default(false),
        })).default([]),
        tests: z.array(z.object({
          name: z.string().min(1),
          kind: z.enum(["completeness", "correctness"]),
          covers: z.string().min(1),
          done: z.boolean().default(false),
        })).default([]),
        existing: z.array(z.string()).default([]),
        added: z.array(z.string()).default([]),
        removed: z.array(z.string()).default([]),
        known: z.array(z.string()).default([]),
        unknown: z.array(z.string()).default([]),
        acceptEdits: z.boolean().default(false).describe(
          "Overwrite a plan a person edited; only after copying the edits into feedbackIncorporated or the stage feedback",
        ),
      }),
      execute: executeSetPlan,
    },
    installCardCss: {
      description:
        "Write the Obsidian CSS snippet that hides the raw frontmatter block on factory cards; the user enables it in Appearance",
      arguments: z.object({
        force: z.boolean().default(false),
      }),
      execute: executeInstallCardCss,
    },
    migrateCards: {
      description:
        "Add the factory-card CSS class and the readable At a glance / Plan sections to every existing card, without overwriting an existing summary or plan",
      arguments: z.object({}),
      execute: executeMigrateCards,
    },
    updateCard: {
      description:
        "Update a card's title, body, status or project path; the summary, plan and activity sections are preserved",
      arguments: z.object({
        id: z.string().min(1),
        title: z.string().optional(),
        body: z.string().optional(),
        status: z.string().optional(),
        project: z.string().optional(),
      }),
      execute: executeUpdateCard,
    },
    deleteCard: {
      description:
        "Delete a card through the vault model (trash by default); requires confirm=delete",
      arguments: z.object({
        id: z.string().min(1),
        confirm: z.literal("delete"),
        permanent: z.boolean().default(false),
        dryRun: z.boolean().default(false),
      }),
      execute: executeDeleteCard,
    },
    archiveCard: {
      description:
        "Archive a finished action or category card: write a verified copy to the Archive folder with its outcome (done, deleted, duplicate), reason and optional detail, then trash the original. Refuses the inbox and keeps the original on any mismatch or trash failure. The archived copy keeps the whole card, including At a glance, the Plan and the Activity log.",
      arguments: z.object({
        id: z.string().min(1),
        outcome: z.enum(ARCHIVE_OUTCOMES).describe(
          "done, deleted or duplicate",
        ),
        reason: z.string().min(1).describe(
          "Why the card is finished; recorded on the archived card",
        ),
        detail: z.string().optional().describe(
          "Optional longer note, recorded as archiveDetail",
        ),
        dryRun: z.boolean().default(false),
      }),
      execute: executeArchiveCard,
    },
    unarchiveCard: {
      description:
        "Unarchive a card: restore it to the column it left (Proposed when that column is gone), clear the archive fields and trash the archive copy",
      arguments: z.object({
        id: z.string().min(1),
        dryRun: z.boolean().default(false),
      }),
      execute: executeUnarchiveCard,
    },
    createCategory: {
      description:
        "Create a Category card, optionally with its first ideas, in the Category column",
      arguments: z.object({
        name: z.string().min(1),
        summary: z.string().optional(),
        ideas: z.array(z.string()).default([]),
      }),
      execute: executeCreateCategory,
    },
    createAction: {
      description:
        "Create an action card in the Proposed column, optionally linked to the category card it came from",
      arguments: z.object({
        title: z.string().min(1),
        brief: z.string().optional(),
        source: z.string().optional(),
        ideas: z.array(z.string()).default([]),
        project: z.string().optional(),
      }),
      execute: executeCreateAction,
    },
    moveIdea: {
      description:
        "Move one idea bullet from the inbox or a category card into an existing or new category card",
      arguments: z.object({
        from: z.string().min(1),
        idea: z.string().min(1),
        to: z.string().optional(),
        newCategory: z.string().optional(),
        newCategorySummary: z.string().optional(),
      }),
      execute: executeMoveIdea,
    },
  },
};
