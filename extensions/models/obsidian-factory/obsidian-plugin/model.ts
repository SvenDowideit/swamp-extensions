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
