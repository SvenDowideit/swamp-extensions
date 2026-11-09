/**
 * Pure prose extraction for the Obsidian factory dialog.
 *
 * This file deliberately has no Obsidian imports so it can be unit-tested in
 * Deno and shared by the plugin bundle.
 */

export interface ReadableCard {
  title: string;
  brief: string;
  summary: string;
  plan: string;
}

/** Remove a leading YAML frontmatter block. */
export function stripFrontmatter(raw: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(raw);
  return match ? raw.slice(match[0].length) : raw;
}

/** Remove swamp managed markers and entry comments. */
export function stripManagedMarkers(text: string): string {
  return text
    .replace(
      /<!--\s*swamp:(summary|plan|definition|activity):begin\s*-->/gi,
      "",
    )
    .replace(/<!--\s*swamp:(summary|plan|definition|activity):end\s*-->/gi, "")
    .replace(/<!--\s*swamp:entry[^>]*-->/gi, "")
    .replace(/<!--\s*swamp:entry:end\s*-->/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Extract one Markdown section, including its heading. */
export function section(text: string, heading: string): string {
  const lines = text.split(/\r?\n/);
  const wanted = heading.trim().toLowerCase();
  const start = lines.findIndex((line) => {
    const match = /^(#{1,6})\s+(.*)$/.exec(line);
    return match !== null && match[2].trim().toLowerCase() === wanted;
  });
  if (start < 0) return "";
  const level = /^(#{1,6})/.exec(lines[start])![1].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const match = /^(#{1,6})\s+/.exec(lines[i]);
    if (match && match[1].length <= level) {
      end = i;
      break;
    }
  }
  return stripManagedMarkers(lines.slice(start, end).join("\n"));
}

/** Remove a managed block by its begin/end markers. */
function managedBlock(text: string, name: string): string {
  const pattern = new RegExp(
    `<!--\\s*swamp:${name}:begin\\s*-->[\\s\\S]*?<!--\\s*swamp:${name}:end\\s*-->`,
    "i",
  );
  const match = pattern.exec(text);
  return match ? match[0] : "";
}

/** Remove a managed block by its begin/end markers from the body. */
function withoutManagedBlock(text: string, name: string): string {
  const pattern = new RegExp(
    `<!--\\s*swamp:${name}:begin\\s*-->[\\s\\S]*?<!--\\s*swamp:${name}:end\\s*-->`,
    "gi",
  );
  return text.replace(pattern, "");
}

/** Best-effort inert Markdown: no scripts, frames, objects or event handlers. */
export function sanitizeMarkdown(markdown: string): string {
  return markdown
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<iframe\b[\s\S]*?<\/iframe>/gi, "")
    .replace(/<object\b[\s\S]*?<\/object>/gi, "")
    .replace(/<embed\b[^>]*>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "")
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, "")
    .replace(/javascript\s*:/gi, "");
}

/** The board's columns in flow order. */
export const STATUSES = [
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

/** Read the status from a frontmatter object without assuming its shape. */
export function statusFromFrontmatter(frontmatter: unknown): string {
  if (
    frontmatter && typeof frontmatter === "object" &&
    "status" in frontmatter &&
    typeof (frontmatter as { status?: unknown }).status === "string"
  ) {
    return (frontmatter as { status: string }).status;
  }
  return "";
}

/** True when a wikilink path points at a factory card. */
export function shouldInterceptCardOpen(
  linktext: string,
  newLeaf: boolean,
): boolean {
  return !newLeaf && isCardPath(linktext);
}

/** True when a path is the factory's Board page, the note with the capture box. */
export function isBoardPath(path: string, folder = "Factory"): boolean {
  const normalized = folder.replace(/^\/+|\/+$/g, "");
  return path.replace(/^\/+/, "") === `${normalized}/Board.md`;
}

export function isCardPath(path: string, folder = "Factory/Cards"): boolean {
  let decoded = path;
  try {
    decoded = decodeURIComponent(path).replace(/^\/+/, "");
  } catch {
    decoded = path.replace(/^\/+/, "");
  }
  const normalized = folder.replace(/^\/+|\/+$/g, "");
  return decoded.startsWith(`${normalized}/`) && decoded.endsWith(".md");
}

/**
 * The dialog's readable contents: title, brief, At a glance and Plan.
 * Frontmatter, Definition, Activity, Questions/Feedback/Ideas and markers are
 * deliberately excluded; Open in editor is the path to the rest.
 */
export function readableCard(raw: string): ReadableCard {
  const withoutFrontmatter = stripFrontmatter(raw);
  const titleMatch = /^#\s+(.+)$/m.exec(withoutFrontmatter);
  const title = titleMatch ? titleMatch[1].trim() : "";
  const summaryBlock = managedBlock(withoutFrontmatter, "summary");
  const planBlock = managedBlock(withoutFrontmatter, "plan");
  const body = withoutManagedBlock(
    withoutManagedBlock(
      withoutManagedBlock(
        withoutManagedBlock(withoutFrontmatter, "summary"),
        "plan",
      ),
      "definition",
    ),
    "activity",
  );
  const briefSection = section(body, "Brief");
  const firstHeading = body.search(/^#{1,6}\s+/m);
  const intro = (firstHeading >= 0 ? body.slice(0, firstHeading) : body)
    .replace(/^#\s+.+$/m, "")
    .trim();
  const brief = (briefSection || stripManagedMarkers(intro))
    .replace(/^#{1,6}\s+Brief\s*\n+/i, "")
    .trim();
  return {
    title,
    brief,
    summary: stripManagedMarkers(summaryBlock),
    plan: stripManagedMarkers(planBlock),
  };
}

// ---------------------------------------------------------------------------
// The card face: the fields that matter for the current column
// ---------------------------------------------------------------------------

/** One labelled row on the kanban card face. */
export interface CardField {
  label: string;
  value: string;
}

/** One Bases property the column block replaces, by key and shipped label. */
export interface SupersededProperty {
  key: string;
  label: string;
}

/**
 * The four Bases property rows the column block replaces. They are read from
 * the card's frontmatter, which the table views, the dialog and Open in editor
 * still show; only the kanban card face drops them.
 */
const SUPERSEDED_PROPERTIES: readonly SupersededProperty[] = [
  { key: "kind", label: "Kind" },
  { key: "project", label: "Project" },
  { key: "source", label: "Source" },
  { key: "updated", label: "Updated" },
];

/** The four rows the card face replaces, as a fresh copy. */
export function supersededCardProperties(): SupersededProperty[] {
  return SUPERSEDED_PROPERTIES.map((property) => ({ ...property }));
}

/** The Bases modifier class a property row carries, e.g. `mod-kind`. */
export function propertyKeyClass(key: string): string {
  return `mod-${key.trim().toLowerCase()}`;
}

/**
 * True when a property row is one of the four superseded rows.
 *
 * The key class is the stable match; the shipped label is the fallback for a
 * Bases build that does not put the key on the row.
 */
export function isSupersededPropertyRow(
  classes: readonly string[],
  label = "",
): boolean {
  const wanted = label.trim().toLowerCase();
  return SUPERSEDED_PROPERTIES.some((property) =>
    classes.includes(propertyKeyClass(property.key)) ||
    (wanted !== "" && wanted === property.label.toLowerCase())
  );
}

/** True when a line is a managed placeholder such as `_Nothing recorded yet._`. */
export function isPlaceholderText(text: string): boolean {
  const trimmed = text.trim();
  return trimmed === "" || /^_.*_$/.test(trimmed);
}

/** The bullet items under a bold label line such as `**Needs your input**`. */
export function labelledBullets(markdown: string, label: string): string[] {
  const wanted = label.trim().toLowerCase();
  const bullets: string[] = [];
  let inside = false;
  for (const line of markdown.split(/\r?\n/)) {
    const bold = /^\*\*(.+?):?\*\*\s*$/.exec(line.trim());
    if (bold) {
      inside = bold[1].trim().toLowerCase() === wanted;
      continue;
    }
    if (!inside) continue;
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      bullets.push(bullet[1].trim());
      continue;
    }
    if (line.trim() !== "") inside = false;
  }
  return bullets;
}

/** The value of an inline label such as `**Next:** Do the thing`. */
export function labelledValue(markdown: string, label: string): string {
  const pattern = new RegExp(
    `\\*\\*${
      label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    }\\s*:?\\*\\*\\s*(.*)$`,
    "im",
  );
  const match = pattern.exec(markdown);
  return match ? match[1].trim() : "";
}

/** The plan status word from the managed summary's `**Plan:** ...` line. */
export function summaryPlanStatus(markdown: string): string {
  const match = /\*\*Plan:\*\*\s*([A-Za-z]+)/i.exec(markdown);
  return match ? match[1].toLowerCase() : "";
}

/** How many checklist items one plan heading holds. */
export interface PlanChecklist {
  done: number;
  total: number;
}

/** Count the checklist under one plan heading, ignoring placeholders. */
export function planChecklist(
  plan: string,
  heading: string,
): PlanChecklist {
  const wanted = heading.trim().toLowerCase();
  const counts = { done: 0, total: 0 };
  let inside = false;
  for (const line of plan.split(/\r?\n/)) {
    const headingMatch = /^#{1,6}\s+(.*)$/.exec(line);
    if (headingMatch) {
      inside = headingMatch[1].trim().toLowerCase() === wanted;
      continue;
    }
    if (!inside) continue;
    const box = /^\s*- \[( |x|X)\]\s+(.*)$/.exec(line);
    if (!box) continue;
    if (isPlaceholderText(box[2])) continue;
    counts.total++;
    if (box[1].toLowerCase() === "x") counts.done++;
  }
  return counts;
}

/** True when a known line reports a check, such as `Checks: ... passed`. */
function reportsChecks(text: string): boolean {
  return /^(the\s+)?(release\s+)?(checks?|tests?)\b/i.test(text.trim());
}

/** The columns whose decision is a plan: the plan status and its progress. */
const PLAN_COLUMNS: readonly string[] = [
  "Please Plan",
  "Work Planned",
  "Please Implement",
  "Please Test",
  "User Acceptance",
  "Please Release",
];

/** The columns where the project path decides where the work lands. */
const PROJECT_COLUMNS: readonly string[] = ["Proposed", ...PLAN_COLUMNS];

/** The columns whose decision is a check run. */
const CHECK_COLUMNS: readonly string[] = ["Please Test", "Please Release"];

/** `3 of 6 left`, or `all 6 done` when nothing is left. */
function remaining(counts: PlanChecklist): string {
  const left = counts.total - counts.done;
  if (left === 0) return `all ${counts.total} done`;
  return `${left} of ${counts.total} left`;
}

/**
 * The fields that matter for one card in one column.
 *
 * It reads only the card's managed At a glance and Plan (the person's prose is
 * theirs) plus the project path, which is frontmatter. It invents nothing: a
 * missing value renders no row, a managed placeholder is not a value, and a
 * status outside the board renders no fields at all.
 */
export function columnFields(
  status: string,
  raw: string,
  project = "",
): CardField[] {
  const column = status.trim();
  if (!(STATUSES as readonly string[]).includes(column)) return [];
  const body = stripFrontmatter(raw);
  const summary = managedBlock(body, "summary");
  const plan = managedBlock(body, "plan");
  // A card with no managed At a glance and no managed Plan has nothing for
  // this block to read, so it renders nothing rather than a bare path.
  if (summary === "" && plan === "") return [];
  const fields: CardField[] = [];
  const needs = labelledBullets(summary, "Needs your input")
    .filter((item) => !isPlaceholderText(item));
  if (needs.length > 0) {
    fields.push({
      label: "Needs your input",
      value: needs.length === 1
        ? needs[0]
        : `${needs[0]} (+${needs.length - 1} more)`,
    });
  }
  const next = labelledValue(summary, "Next");
  if (next !== "" && !isPlaceholderText(next)) {
    fields.push({ label: "Next", value: next });
  }
  if (PLAN_COLUMNS.includes(column)) {
    const planStatus = summaryPlanStatus(summary);
    if (planStatus !== "") {
      fields.push({ label: "Plan", value: planStatus });
    }
    const tasks = planChecklist(plan, "Tasks");
    if (tasks.total > 0) {
      fields.push({ label: "Tasks", value: remaining(tasks) });
    }
    const tests = planChecklist(plan, "Tests");
    if (tests.total > 0) {
      fields.push({ label: "Tests", value: remaining(tests) });
    }
  }
  if (CHECK_COLUMNS.includes(column)) {
    const checks = labelledBullets(summary, "Known")
      .filter((item) => !isPlaceholderText(item) && reportsChecks(item));
    if (checks.length > 0) {
      fields.push({ label: "Checks", value: checks.join(" · ") });
    }
  }
  if (PROJECT_COLUMNS.includes(column) && project.trim() !== "") {
    fields.push({ label: "Project", value: project.trim() });
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

/** The line the capture box shows while it is empty. */
export const CAPTURE_PLACEHOLDER = "Add an idea to the inbox...";

/** What is wrong with one captured thought, or "" when it can be sent. */
export function captureTextProblem(text: string): string {
  if (text.trim() === "") {
    return "Write the thought before adding it to the inbox.";
  }
  return "";
}

/** The request the plugin sends: the text as typed, without edge whitespace. */
export function captureRequestBody(text: string): { text: string } {
  return { text: text.trim() };
}

// ---------------------------------------------------------------------------
// Archive
// ---------------------------------------------------------------------------

/** The outcomes an archived factory card may record. */
export const ARCHIVE_OUTCOMES = ["done", "deleted", "duplicate"] as const;
export type ArchiveOutcome = typeof ARCHIVE_OUTCOMES[number];

/** True when a path is a card still on the active board, so it can be archived. */
export function isArchivablePath(path: string, folder = "Factory"): boolean {
  const normalized = folder.replace(/^\/+|\/+$/g, "");
  return isCardPath(path, `${normalized}/Cards`);
}

/** True when a path is an archived card, so it can be restored. */
export function isArchivedPath(path: string, folder = "Factory"): boolean {
  const normalized = folder.replace(/^\/+|\/+$/g, "");
  return isCardPath(path, `${normalized}/Archive`);
}

/** What is wrong with an archive request, or "" when it is ready to send. */
export function archiveRequestProblem(
  outcome: string,
  reason: string,
): string {
  if (!(ARCHIVE_OUTCOMES as readonly string[]).includes(outcome)) {
    return `Pick an outcome: ${ARCHIVE_OUTCOMES.join(", ")}`;
  }
  if (reason.trim() === "") return "Say why this card is finished.";
  return "";
}

/** The JSON body the archive webhook and the archive workflow both take. */
export interface ArchiveRequestBody {
  id: string;
  outcome: ArchiveOutcome;
  reason: string;
  detail: string;
}

export function archiveRequestBody(
  id: string,
  outcome: ArchiveOutcome,
  reason: string,
  detail = "",
): ArchiveRequestBody {
  return {
    id: id.trim(),
    outcome,
    reason: reason.trim(),
    detail: detail.trim(),
  };
}
