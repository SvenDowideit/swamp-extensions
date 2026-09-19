/**
 * @svendowideit/swamp-pulse — merge, rank and render swamp activity.
 *
 * Collectors (in the workflow) gather Lab issues, commits, releases and changed
 * documentation into model data. This model then:
 *
 *   1. `rank`   — joins releases↔commits↔PRs into one item per change, merges
 *      into a rolling store, computes the 24h / 7d / UTC-month windows, links
 *      documentation, and writes the `ranked` resource.
 *   2. `render` — writes five linked static HTML pages (docs summary,
 *      leaderboard, changes, releases + issues) as model files and to the
 *      configured output dir.
 *   3. `sync_manual_index` — caches the swamp-club manual sitemap so doc
 *      changes can link to their published page.
 *
 * Items are ranked **tier first, recency as the tie-break**: recency only
 * decides between items of equal significance.
 *
 * @module
 */

import { z } from "npm:zod@4";

import { celUnescapeDeep } from "./cel_text.ts";
import { CollectionSchema as ExtensionsCollectionSchema } from "./swamp_ext_registry.ts";
import { isDocPath } from "./doc_paths.ts";

export { isDocPath };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EXTENSION_NAME = "@svendowideit/swamp-pulse";

/** Registry page for this extension. */
const EXTENSION_URL = `https://swamp-club.com/extensions/${EXTENSION_NAME}`;

/** Calendar window half-lives (hours) used for within-tier ordering. */
const HALF_LIVES_HOURS: Record<string, number> = {
  "24h": 12,
  "7d": 72,
  month: 240,
};

/** Significance tier ordering, most significant first. */
const TIER_ORDER = ["S", "A", "B", "C"] as const;
type Tier = (typeof TIER_ORDER)[number];

/** Base importance per tier (display score only — never overrides tier order). */
const TIER_BASE: Record<Tier, number> = { S: 1000, A: 400, B: 150, C: 50 };

/** Conventional-commit type → tier, before issue/security escalation. */
const TYPE_TIER: Record<string, Tier> = {
  feat: "A",
  fix: "A",
  perf: "B",
  refactor: "B",
  chore: "B",
  docs: "C",
  test: "C",
  style: "C",
  build: "C",
  ci: "C",
};

/**
 * Explicit repository-path → manual-page map for documentation that maps
 * cleanly. Fuzzy slug matching (below) handles the rest, but these are pinned
 * because the published manual does not mirror the repository layout.
 */
const MANUAL_PATH_MAP: Record<string, string> = {
  "design/enablers/datastores.md": "/manual/reference/datastore-configuration",
  "design/enablers/access-control.md": "/manual/explanation/swamp-serve",
  "design/enablers/doctor-vaults.md": "/manual/reference/doctor",
  "design/enablers/doctor-secrets.md": "/manual/reference/doctor",
  "design/enablers/remote-execution.md": "/manual/explanation/remote-execution",
  "design/enablers/run-tracker.md": "/manual/explanation/the-run-tracker",
  "design/enablers/serve-audit.md": "/manual/explanation/the-audit-system",
  "design/enablers/expressions.md": "/manual/reference/cel-expressions",
  "design/enablers/data-query.md": "/manual/explanation/the-data-layer",
  "design/surfaces/audit-doctor.md": "/manual/explanation/the-audit-system",
  "design/architecture.md": "/manual/explanation/how-swamp-works",
  "design/operations.md": "/manual/reference/operational-commands",
  "design/primitives/workflows.md":
    "/manual/explanation/the-workflow-execution-model",
  "design/primitives/extensions.md": "/manual/reference/extensions",
  "design/primitives/vaults.md": "/manual/reference/vaults",
  "design/primitives/serve.md": "/manual/explanation/swamp-serve",
  "AGENTS.md": "/manual/explanation/ai-agent-integration",
  ".claude/skills/swamp/references/issue/guide.md":
    "/manual/reference/issue-commands",
  "README.md": "/manual",
};

/** Minimum fuzzy-match confidence before a manual link is emitted. */
const MANUAL_CONFIDENCE_THRESHOLD = 0.6;

// ---------------------------------------------------------------------------
// Global arguments
// ---------------------------------------------------------------------------

const GlobalArgsSchema = z.object({
  outputDir: z.string().default("~/.swamp/swamp-pulse").describe(
    "Directory to write the rendered HTML pages.",
  ),
  manualBaseUrl: z.string().default("https://swamp-club.com/manual").describe(
    "Base URL used to build published manual links.",
  ),
  windows: z.array(z.enum(["24h", "7d", "month"])).default([
    "24h",
    "7d",
    "month",
  ]).describe("Activity windows to compute and render."),
  storeRetentionDays: z.number().int().min(1).max(365).default(90).describe(
    "How many days of merged events to retain in the rolling store.",
  ),
  docPathPattern: z.string().default("").describe(
    "Optional extra regex; matching changed paths are treated as documentation.",
  ),
  serverPort: z.number().int().min(1).max(65535).default(8899).describe(
    "Port the pulse static server listens on (used by ensureServer).",
  ),
  serverServiceName: z.string().default("swamp-pulse-server").describe(
    "systemd user service name for the pulse static server.",
  ),
  serverScriptPath: z.string().optional().describe(
    "Override the path to the bundled pulse-server.ts script.",
  ),

  // --- Publishing configuration -------------------------------------------
  // These live on the model (not the trigger) so a user configures them once
  // on the instance and every scheduled run picks them up. The workflow reads
  // them into the `publishConfig` resource, because guards and assert steps
  // cannot read `model.*.input.globalArguments.*` directly.
  publishMode: z.enum(["false", "caddy", "github-pages"]).default("false")
    .describe(
      "Publishing mode. 'false' publishes nothing; 'caddy' serves locally via " +
        "@svendowideit/caddy; 'github-pages' commits to a GitHub Pages site.",
    ),
  pagesRepo: z.string().default("").describe(
    "Target repository (owner/name) for publishMode=github-pages.",
  ),
  pagesBranch: z.string().default("").describe(
    "Branch to publish the Pages site to (e.g. gh-pages).",
  ),
  pagesPath: z.enum(["/", "/docs"]).default("/").describe(
    "Directory within the repository Pages serves from.",
  ),
  pagesCname: z.string().default("").describe(
    "Optional custom domain to configure for the Pages site.",
  ),
  caddyHostname: z.string().default("").describe(
    "Public hostname to serve the pages on for publishMode=caddy.",
  ),
  caddyUpstream: z.string().default("127.0.0.1:8899").describe(
    "host:port the Caddy reverse proxy points at.",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const RefSchema = z.object({
  repo: z.string(),
  sha: z.string(),
  shortSha: z.string(),
  filename: z.string(),
  status: z.string(),
  additions: z.number(),
  deletions: z.number(),
  changes: z.number(),
}).strict();

const DocLinkSchema = z.object({
  filename: z.string(),
  sourceUrl: z.string(),
  manualUrl: z.string(),
  manualConfidence: z.number(),
}).strict();

const LabIssueRefSchema = z.object({
  number: z.number(),
  type: z.string(),
  status: z.string(),
  title: z.string(),
  author: z.string(),
  url: z.string(),
}).strict();

const MergedItemSchema = z.object({
  id: z.string(),
  kind: z.enum(["change", "issue"]),
  title: z.string(),
  summary: z.string(),
  repo: z.string(),
  type: z.string(),
  scope: z.string(),
  importance: z.enum(TIER_ORDER),
  score: z.number(),
  date: z.string(),
  rationale: z.string(),
  commitSha: z.string(),
  shortSha: z.string(),
  commitUrl: z.string(),
  releaseTag: z.string(),
  releaseUrl: z.string(),
  isPrerelease: z.boolean(),
  prNumbers: z.array(z.number()),
  issueNumbers: z.array(z.number()),
  labIssue: LabIssueRefSchema.nullable(),
  files: z.array(RefSchema),
  docLinks: z.array(DocLinkSchema),
}).strict();

const RankedSchema = z.object({
  windows: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      since: z.string(),
      until: z.string(),
      changes: z.number(),
      releases: z.number(),
      issues: z.number(),
      items: z.array(MergedItemSchema),
    }),
  ),
  totals: z.object({
    events: z.number(),
    commits: z.number(),
    releases: z.number(),
    issues: z.number(),
    docChanges: z.number(),
    byRepo: z.record(z.string(), z.number()),
  }),
  manualPages: z.number(),
  extensions: ExtensionsCollectionSchema.nullable(),
  generatedAt: z.string(),
}).strict();

const StoreSchema = z.object({
  events: z.array(MergedItemSchema),
  cursor: z.object({
    commitsSince: z.string(),
    releasesSince: z.string(),
    issuesSince: z.string(),
    updatedAt: z.string(),
  }),
  updatedAt: z.string(),
}).strict();

const ManualIndexSchema = z.object({
  pages: z.array(z.string()),
  count: z.number(),
  fetchedAt: z.string(),
}).strict();

/**
 * Resolved publishing configuration, written by `publishConfig` from the
 * model's own global arguments.
 *
 * It exists as a resource because workflow **guards and assert steps cannot
 * read `model.*.input.globalArguments.*`** — they can only read `data.latest`.
 * A `configure` step runs first, writes this, and every later guard reads it.
 */
const PublishConfigSchema = z.object({
  mode: z.enum(["false", "caddy", "github-pages"]).describe(
    "Requested publishing mode",
  ),
  enabled: z.boolean().describe("True unless mode is 'false'"),
  caddyHostname: z.string(),
  caddyUpstream: z.string(),
  pagesRepo: z.string(),
  pagesBranch: z.string(),
  pagesPath: z.string(),
  pagesCname: z.string(),
  configured: z.boolean().describe(
    "True when the selected mode has everything it needs to run",
  ),
  reason: z.string().describe(
    "Why publishing is disabled or misconfigured (empty when ready)",
  ),
  resolvedAt: z.string(),
}).strict();

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

type MethodContext = {
  globalArgs: GlobalArgs;
  repoDir: string;
  definition?: { name?: string };
  logger?: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warn: (msg: string, props?: Record<string, unknown>) => void;
  };
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
  ) => { writeText: (text: string) => Promise<{ name: string }> };
};

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/** Escape text for safe interpolation into HTML. */
export function escapeHtml(text: string): string {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Parse the Lab issue a change **resolves**, if it says so explicitly.
 *
 * A commit or release body often mentions a context issue before the one it
 * actually closes — e.g. "Verifying swamp-club#2254 turned on a code path…
 * Closes swamp-club#2266". Linking the first mention would point at the wrong
 * issue, so resolving references (`Closes/Fixes/Resolves lab#N`) are preferred
 * over incidental mentions.
 */
export function parseClosingIssues(text: string): number[] {
  const src = String(text ?? "");
  const found = new Set<number>();
  const pattern =
    /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:swamp-club|lab)#(\d+)/gi;
  for (const m of src.matchAll(pattern)) found.add(Number(m[1]));
  return [...found];
}

/**
 * Parse issue and PR references from free text.
 *
 * Issue and PR numbers are distinct namespaces on GitHub: `swamp-club#2254`
 * and `lab#2254` are Lab issues, while a bare `#2507` is a pull request. A bare
 * number is never treated as a Lab issue reference.
 */
export function parseRefs(text: string): {
  issues: number[];
  prs: number[];
} {
  const issues = new Set<number>();
  const prs = new Set<number>();
  const src = String(text ?? "");

  for (const m of src.matchAll(/\b(?:swamp-club|lab)#(\d+)/gi)) {
    issues.add(Number(m[1]));
  }
  for (const m of src.matchAll(/\(#(\d+)\)/g)) {
    prs.add(Number(m[1]));
  }
  for (const m of src.matchAll(/(?<![#\w])#(\d+)\b/g)) {
    const n = Number(m[1]);
    if (!issues.has(n)) prs.add(n);
  }

  return { issues: [...issues], prs: [...prs] };
}

/** Split a conventional-commit title into `{ type, scope, description }`. */
export function parseConventional(
  title: string,
): { type: string; scope: string; description: string } {
  const m = String(title ?? "").match(
    /^([a-zA-Z]+)(?:\(([^)]*)\))?(!)?:\s*(.*)$/,
  );
  if (!m) return { type: "", scope: "", description: String(title ?? "") };
  return {
    type: m[1].toLowerCase(),
    scope: m[2] ?? "",
    description: m[4] ?? "",
  };
}

/** Normalise a manual page path to its slug segments. */
function slugSegments(url: string): string[] {
  const path = url.replace(/^https?:\/\/[^/]+/, "").replace(/^\/manual/, "");
  return path.split("/").filter(Boolean).map((s) =>
    s.toLowerCase().replace(/[^a-z0-9]+/g, "-")
  );
}

/** Normalise a repo documentation path to comparable slug segments. */
function pathSegments(path: string): string[] {
  const base = path.replace(/\.[a-z0-9]+$/i, "");
  return base.split("/").filter(Boolean).map((s) =>
    s.toLowerCase().replace(/[^a-z0-9]+/g, "-")
  ).filter((s) => s !== "docs" && s !== "design" && s !== "enablers");
}

/**
 * Join a manual base URL with a page path, tolerating a base that already ends
 * in `/manual` and a path that also starts with `/manual` (which would
 * otherwise produce `/manual/manual/...`).
 */
function manualUrl(base: string, pagePath: string): string {
  if (pagePath.startsWith("http")) return pagePath;
  const b = base.replace(/\/+$/, "");
  const p = pagePath.replace(/^\/+/, "");
  if (p === "manual" || p.startsWith("manual/")) {
    // The path already carries the /manual prefix; drop it if the base has one.
    const stripped = p.slice("manual".length).replace(/^\/+/, "");
    return stripped ? `${b}/${stripped}` : b;
  }
  return `${b}/${p}`;
}

/** Resolve a changed documentation path to a published manual URL.
 *
 * Uses an explicit map first, then fuzzy slug similarity. Returns an empty URL
 * when no confident match exists — callers must never guess a manual page.
 */
export function resolveManualUrl(
  path: string,
  manualPages: string[],
  manualBaseUrl = "https://swamp-club.com/manual",
): { url: string; confidence: number } {
  const mapped = MANUAL_PATH_MAP[path];
  if (mapped) {
    return { url: manualUrl(manualBaseUrl, mapped), confidence: 1 };
  }

  const target = pathSegments(path);
  if (target.length === 0 || manualPages.length === 0) {
    return { url: "", confidence: 0 };
  }

  let best = { url: "", confidence: 0 };
  for (const page of manualPages) {
    const segs = slugSegments(page);
    if (segs.length === 0) continue;
    const overlap = target.filter((s) => segs.includes(s)).length;
    const denom = Math.max(target.length, Math.min(segs.length, target.length));
    const confidence = denom === 0 ? 0 : overlap / denom;
    if (confidence > best.confidence) {
      best = {
        url: manualUrl(manualBaseUrl, page),
        confidence,
      };
    }
  }

  if (best.confidence < MANUAL_CONFIDENCE_THRESHOLD) {
    return { url: "", confidence: best.confidence };
  }
  return best;
}

/** Classify a merged item into a significance tier. */
export function classifyImportance(item: {
  kind: "change" | "issue";
  type: string;
  scope?: string;
  issueType?: string;
  issueStatus?: string;
  title: string;
  summary: string;
  isPrerelease?: boolean;
}): { tier: Tier; rationale: string } {
  // Security is judged from the title, the conventional-commit scope, and the
  // linked issue's type — never the full release body. Release bodies are
  // auto-generated and mention "security"/"vulnerability scan" incidentally, so
  // scanning them marks ordinary fixes as security-critical. The `auth` scope
  // alone is deliberately NOT enough (it covers ordinary login/UX work); only an
  // explicit `security`/`secrets`/`crypto` scope, a security-labelled issue, a
  // CVE, or security wording in the title escalates to S.
  const scope = (item.scope ?? "").toLowerCase();
  const title = item.title.toLowerCase();
  const isSecurity = /\bsecurity\b|\bcve-\d|\bvulnerab/.test(title) ||
    /^(security|secrets?|crypto)$/.test(scope) ||
    item.issueType === "security";

  if (isSecurity) {
    return {
      tier: "S",
      rationale: item.issueType === "security"
        ? "Security issue"
        : "Security-related change",
    };
  }
  if (/\bbreaking change\b/.test(item.title)) {
    return { tier: "S", rationale: "Announces a breaking change" };
  }

  if (item.kind === "issue") {
    const status = item.issueStatus ?? "";
    const type = item.issueType ?? "";
    if (status === "shipped" && type === "bug") {
      return { tier: "A", rationale: "Shipped bug fix" };
    }
    if (status === "shipped" && type === "feature") {
      return { tier: "A", rationale: "Shipped feature" };
    }
    if (status === "in_progress" || status === "triaged") {
      return { tier: "B", rationale: `Issue ${status}` };
    }
    return { tier: "C", rationale: "Open issue" };
  }

  if (item.isPrerelease) {
    return { tier: "C", rationale: "Prerelease" };
  }
  const tier = TYPE_TIER[item.type] ?? "C";
  const rationale = item.type ? `\`${item.type}\` change` : "Change (untyped)";
  return { tier, rationale };
}

type CommitInput = {
  repo: string;
  sha: string;
  shortSha: string;
  message: string;
  author: string;
  date: string;
  url: string;
};
type ReleaseInput = {
  repo: string;
  tagName: string;
  name: string;
  body: string;
  publishedAt: string;
  isPrerelease: boolean;
  commitSha: string;
  url: string;
};
type IssueInput = {
  number: number;
  type: string;
  status: string;
  title: string;
  author: string;
  url: string;
  createdAt: string;
  updatedAt: string;
};
type FileInput = {
  repo: string;
  sha: string;
  shortSha: string;
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
};

/** Flatten a collector output (collection object or bare array) to a list. */
function flatten<T>(
  input: unknown,
  listKey: string,
  itemKey: string,
): T[] {
  if (!input) return [];
  if (Array.isArray(input)) return input as T[];
  const obj = input as Record<string, unknown>;
  if (Array.isArray(obj[listKey])) {
    const out: T[] = [];
    for (const group of obj[listKey] as Record<string, unknown>[]) {
      const items = group[itemKey];
      if (Array.isArray(items)) {
        for (const item of items) {
          out.push(
            { repo: String(group.repo ?? ""), ...(item as object) } as T,
          );
        }
      }
    }
    return out;
  }
  return [];
}

/** Flatten the four collector outputs into typed input lists. */
export function normalizeInputs(input: {
  commits?: unknown;
  releases?: unknown;
  docChanges?: unknown;
  labIssues?: unknown;
}): {
  commits: CommitInput[];
  releases: ReleaseInput[];
  issues: IssueInput[];
  files: FileInput[];
} {
  const commits = flatten<CommitInput>(input.commits, "repos", "commits");
  const releases = flatten<ReleaseInput>(input.releases, "repos", "releases");
  const files = flatten<FileInput>(input.docChanges, "repos", "files");
  const lab = input.labIssues as { issues?: unknown } | undefined;
  const issues = Array.isArray(lab?.issues)
    ? (lab!.issues as IssueInput[])
    : Array.isArray(input.labIssues)
    ? (input.labIssues as IssueInput[])
    : [];
  return { commits, releases, issues, files };
}

/**
 * Join the collected streams into one item per change.
 *
 * A release, its commit and its PR are the same event, so they are merged by
 * the commit SHA embedded in the release tag. Commits with no release become
 * their own items; PRs referenced by a release never appear separately.
 * Lab issues are separate items but corroborate matching changes.
 */
export function mergeEvents(
  input: {
    commits?: unknown;
    releases?: unknown;
    docChanges?: unknown;
    labIssues?: unknown;
  },
  opts: {
    manualPages?: string[];
    manualBaseUrl?: string;
    docPathPattern?: string;
  } = {},
): z.infer<typeof MergedItemSchema>[] {
  const { commits, releases, issues, files } = normalizeInputs(
    celUnescapeDeep(input),
  );
  const manualPages = opts.manualPages ?? [];
  const manualBaseUrl = opts.manualBaseUrl;
  const items: z.infer<typeof MergedItemSchema>[] = [];

  const issueByNumber = new Map<number, IssueInput>();
  for (const issue of issues) issueByNumber.set(issue.number, issue);

  const buildDocLinks = (repo: string, sha: string) => {
    const links: z.infer<typeof DocLinkSchema>[] = [];
    for (const f of files) {
      if (f.repo !== repo || f.sha !== sha) continue;
      if (!isDocPath(f.filename, opts.docPathPattern)) continue;

      const resolved = resolveManualUrl(f.filename, manualPages, manualBaseUrl);
      links.push({
        filename: f.filename,
        sourceUrl: `https://github.com/${repo}/blob/${sha}/${f.filename}`,
        manualUrl: resolved.url,
        manualConfidence: resolved.confidence,
      });
    }
    return links;
  };

  const filesFor = (repo: string, sha: string) =>
    files.filter((f) => f.repo === repo && f.sha === sha).map((f) => ({
      repo: f.repo,
      sha: f.sha,
      shortSha: f.shortSha,
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      changes: f.changes,
    }));

  const commitByRepoSha = new Map<string, CommitInput>();
  for (const c of commits) commitByRepoSha.set(`${c.repo}:${c.sha}`, c);

  // Release tags embed only a short SHA (e.g. `-sha.a3e60933`), so a release
  // is matched to its commit by SHA prefix, not exact equality.
  const lookupCommit = (repo: string, sha: string): CommitInput | undefined => {
    if (!sha) return undefined;
    const exact = commitByRepoSha.get(`${repo}:${sha}`);
    if (exact) return exact;
    for (const c of commits) {
      if (c.repo !== repo) continue;
      if (c.sha.startsWith(sha) || sha.startsWith(c.sha)) return c;
    }
    return undefined;
  };

  const consumed = new Set<string>();

  /**
   * Choose the Lab issue to attribute a change to.
   *
   * Prefer an explicitly resolved issue (`Closes lab#N`) over incidental
   * mentions, then fall back to the first mentioned issue that exists.
   */
  const pickLabIssue = (
    text: string,
    refs: { issues: number[] },
  ): IssueInput | null => {
    for (const n of parseClosingIssues(text)) {
      const issue = issueByNumber.get(n);
      if (issue) return issue;
    }
    return refs.issues
      .map((n) => issueByNumber.get(n))
      .find((i) => i !== undefined) ?? null;
  };

  for (const release of releases) {
    const commit = lookupCommit(release.repo, release.commitSha);
    if (commit) consumed.add(`${commit.repo}:${commit.sha}`);
    const fullSha = commit?.sha || release.commitSha;

    const title = release.name || release.tagName;
    const refText = `${release.body}\n${commit?.message ?? ""}\n${title}`;
    const refs = parseRefs(refText);
    const labIssue = pickLabIssue(refText, refs);

    const conv = parseConventional(commit?.message ?? title);
    const classified = classifyImportance({
      kind: "change",
      type: conv.type,
      scope: conv.scope,
      title: commit?.message ?? title,
      summary: release.body,
      isPrerelease: release.isPrerelease,
      issueType: labIssue?.type,
      issueStatus: labIssue?.status,
    });

    items.push({
      id: `release:${release.repo}:${release.tagName}`,
      kind: "change",
      title: conv.description || title,
      summary: release.body,
      repo: release.repo,
      type: conv.type,
      scope: conv.scope,
      importance: classified.tier,
      score: 0,
      date: release.publishedAt,
      rationale: classified.rationale,
      commitSha: fullSha,
      shortSha: fullSha.slice(0, 8),
      commitUrl: commit?.url ??
        (fullSha ? `https://github.com/${release.repo}/commit/${fullSha}` : ""),
      releaseTag: release.tagName,
      releaseUrl: release.url,
      isPrerelease: release.isPrerelease,
      prNumbers: refs.prs,
      issueNumbers: refs.issues,
      labIssue: labIssue
        ? {
          number: labIssue.number,
          type: labIssue.type,
          status: labIssue.status,
          title: labIssue.title,
          author: labIssue.author,
          url: labIssue.url,
        }
        : null,
      files: fullSha ? filesFor(release.repo, fullSha) : [],
      docLinks: fullSha ? buildDocLinks(release.repo, fullSha) : [],
    });
  }

  for (const commit of commits) {
    const key = `${commit.repo}:${commit.sha}`;
    if (consumed.has(key)) continue;

    const conv = parseConventional(commit.message);
    const refs = parseRefs(commit.message);
    const labIssue = pickLabIssue(commit.message, refs);
    const classified = classifyImportance({
      kind: "change",
      type: conv.type,
      title: commit.message,
      summary: commit.message,
      issueType: labIssue?.type,
      issueStatus: labIssue?.status,
    });

    items.push({
      id: `commit:${commit.repo}:${commit.sha}`,
      kind: "change",
      title: conv.description || commit.message,
      summary: commit.message,
      repo: commit.repo,
      type: conv.type,
      scope: conv.scope,
      importance: classified.tier,
      score: 0,
      date: commit.date,
      rationale: classified.rationale,
      commitSha: commit.sha,
      shortSha: commit.shortSha,
      commitUrl: commit.url,
      releaseTag: "",
      releaseUrl: "",
      isPrerelease: false,
      prNumbers: refs.prs,
      issueNumbers: refs.issues,
      labIssue: labIssue
        ? {
          number: labIssue.number,
          type: labIssue.type,
          status: labIssue.status,
          title: labIssue.title,
          author: labIssue.author,
          url: labIssue.url,
        }
        : null,
      files: filesFor(commit.repo, commit.sha),
      docLinks: buildDocLinks(commit.repo, commit.sha),
    });
  }

  for (const issue of issues) {
    const classified = classifyImportance({
      kind: "issue",
      type: "",
      title: issue.title,
      summary: "",
      issueType: issue.type,
      issueStatus: issue.status,
    });
    items.push({
      id: `issue:${issue.number}`,
      kind: "issue",
      title: issue.title,
      summary: "",
      repo: "",
      type: "",
      scope: "",
      importance: classified.tier,
      score: 0,
      date: issue.updatedAt || issue.createdAt,
      rationale: classified.rationale,
      commitSha: "",
      shortSha: "",
      commitUrl: "",
      releaseTag: "",
      releaseUrl: "",
      isPrerelease: false,
      prNumbers: [],
      issueNumbers: [issue.number],
      labIssue: {
        number: issue.number,
        type: issue.type,
        status: issue.status,
        title: issue.title,
        author: issue.author,
        url: issue.url,
      },
      files: [],
      docLinks: [],
    });
  }

  return dedupeById(items);
}

/** Keep the newest item for each id. */
function dedupeById(
  items: z.infer<typeof MergedItemSchema>[],
): z.infer<typeof MergedItemSchema>[] {
  const byId = new Map<string, z.infer<typeof MergedItemSchema>>();
  for (const item of items) {
    const existing = byId.get(item.id);
    if (!existing || Date.parse(item.date) > Date.parse(existing.date)) {
      byId.set(item.id, item);
    }
  }
  return [...byId.values()];
}

/** Merge fresh items into the rolling store, keyed by id, pruned by age. */
export function mergeStore(
  existing: z.infer<typeof MergedItemSchema>[],
  fresh: z.infer<typeof MergedItemSchema>[],
  retentionDays: number,
  now = new Date(),
): z.infer<typeof MergedItemSchema>[] {
  const byId = new Map<string, z.infer<typeof MergedItemSchema>>();
  for (const item of [...existing, ...fresh]) {
    const prev = byId.get(item.id);
    if (!prev || Date.parse(item.date) >= Date.parse(prev.date)) {
      byId.set(item.id, item);
    }
  }
  const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  return [...byId.values()]
    .filter((i) =>
      !Number.isFinite(Date.parse(i.date)) ||
      Date.parse(i.date) >= cutoff
    )
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
}

/** Compute the [since, until] bounds for a window key, UTC. */
export function windowBounds(
  key: string,
  now = new Date(),
): { since: Date; until: Date; label: string } {
  const until = now;
  if (key === "24h") {
    return {
      since: new Date(now.getTime() - 24 * 60 * 60 * 1000),
      until,
      label: "Last 24 hours",
    };
  }
  if (key === "7d") {
    return {
      since: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
      until,
      label: "Last 7 days",
    };
  }
  const monthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0),
  );
  return { since: monthStart, until, label: "This month" };
}

/** Rank items for one window: tier first, then recency, then score. */
export function rankItems(
  items: z.infer<typeof MergedItemSchema>[],
  windowKey: string,
  now = new Date(),
): z.infer<typeof MergedItemSchema>[] {
  const { since, until } = windowBounds(windowKey, now);
  const halfLife = HALF_LIVES_HOURS[windowKey] ?? 72;

  const inWindow = items.filter((item) => {
    const t = Date.parse(item.date);
    if (!Number.isFinite(t)) return false;
    return t >= since.getTime() && t <= until.getTime();
  });

  const scored = inWindow.map((item) => {
    const ageHours = Math.max(
      0,
      (until.getTime() - Date.parse(item.date)) / (60 * 60 * 1000),
    );
    const recency = Math.pow(0.5, ageHours / halfLife);
    const base = TIER_BASE[item.importance];
    const corroboration = item.labIssue ? 1.5 : 1;
    return { item, score: base * recency * corroboration, recency };
  });

  scored.sort((a, b) => {
    const tierDelta = TIER_ORDER.indexOf(a.item.importance) -
      TIER_ORDER.indexOf(b.item.importance);
    if (tierDelta !== 0) return tierDelta;
    if (b.item.date !== a.item.date) {
      return Date.parse(b.item.date) - Date.parse(a.item.date);
    }
    return b.score - a.score;
  });

  return scored.map(({ item, score }) => ({
    ...item,
    score: Math.round(score * 100) / 100,
  }));
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Minimal, safe markdown → HTML for release/issue bodies. */
export function renderMarkdownLite(markdown: string): string {
  const lines = String(markdown ?? "").split("\n");
  const out: string[] = [];
  let inList = false;
  const closeList = () => {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (/^\s*[-*]\s+/.test(line)) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${inlineMarkdown(line.replace(/^\s*[-*]\s+/, ""))}</li>`);
      continue;
    }
    closeList();
    if (line.trim() === "") continue;
    if (/^#{2,4}\s+/.test(line)) {
      out.push(
        `<h4 class="body-h">${
          inlineMarkdown(line.replace(/^#{2,4}\s+/, ""))
        }</h4>`,
      );
    } else {
      out.push(`<p>${inlineMarkdown(line)}</p>`);
    }
  }
  closeList();
  return out.join("\n");
}

/** Escape then apply inline markdown (code, bold, links). */
function inlineMarkdown(text: string): string {
  let html = escapeHtml(text);
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    '<a href="$2" rel="noopener">$1</a>',
  );
  html = html.replace(
    /(^|\s)(https?:\/\/[^\s<]+)/g,
    '$1<a href="$2" rel="noopener">$2</a>',
  );
  return html;
}

/**
 * Render an ISO timestamp as a `<time>` element.
 *
 * The server-rendered text is the raw ISO value so the page is readable
 * without JavaScript and correct for non-JS clients; the client script in
 * {@link LOCAL_TIME_SCRIPT} rewrites the visible text to the viewer's local
 * timezone using the `datetime` attribute.
 */
export function renderTime(
  iso: string,
  format: "datetime" | "date" = "datetime",
): string {
  const value = String(iso ?? "");
  if (!value) return "";
  const attr = format === "date" ? ' data-time-format="date"' : "";
  // Without JS the raw value is shown; for "date" the date part is clearer.
  const text = format === "date" ? value.slice(0, 10) : value;
  return `<time datetime="${escapeHtml(value)}"${attr}>${
    escapeHtml(text)
  }</time>`;
}

/**
 * Client script that rewrites every `<time datetime>` to the viewer's local
 * timezone. Runs on load and is idempotent, so a page re-render or a bfcache
 * restore stays correct.
 */
export const LOCAL_TIME_SCRIPT = `
(function () {
  var MINUTE = 60 * 1000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;

  // "just now", "15 mins ago", "1 hour ago", "4 hours ago".
  function relative(ms) {
    if (ms < MINUTE) return "just now";
    if (ms < HOUR) {
      var mins = Math.round(ms / MINUTE);
      return mins + (mins === 1 ? " min ago" : " mins ago");
    }
    var hours = Math.round(ms / HOUR);
    return hours + (hours === 1 ? " hour ago" : " hours ago");
  }

  function absolute(d, dateOnly) {
    var opts = dateOnly
      ? { year: "numeric", month: "short", day: "numeric" }
      : {
        year: "numeric", month: "short", day: "numeric",
        hour: "2-digit", minute: "2-digit"
      };
    return d.toLocaleString(undefined, opts);
  }

  function localize(root) {
    var nodes = (root || document).querySelectorAll("time[datetime]");
    var now = Date.now();
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var d = new Date(el.getAttribute("datetime"));
      if (isNaN(d.getTime())) continue;
      var dateOnly = el.getAttribute("data-time-format") === "date";
      var age = now - d.getTime();
      // Within the last 24 hours (and not in the future), prefer relative
      // wording; older values keep an absolute, localized date. A date-only
      // field stays a date — "15 mins ago" reads oddly in a date column.
      var text = (!dateOnly && age >= 0 && age < DAY)
        ? relative(age)
        : absolute(d, dateOnly);
      if (el.textContent !== text) el.textContent = text;
      // Keep the exact value discoverable on hover, in local time.
      el.title = d.toLocaleString();
      el.setAttribute("data-localized", "1");
    }
  }

  localize(document);
  window.addEventListener("pageshow", function () { localize(document); });
  // Refresh relative wording as time passes, so a page left open stays honest.
  setInterval(function () { localize(document); }, 60000);
})();
`;

const PAGE_CSS = `
:root{--bg:#0b0f0c;--panel:#111813;--ink:#d7f5dd;--dim:#7fa88a;--acc:#39ff14;--amber:#ffb000;--mag:#ff4dd2;--line:#1d2a20}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 "JetBrains Mono",ui-monospace,monospace}
a{color:var(--acc);text-decoration:none}a:hover{text-decoration:underline}
header.top{padding:18px 22px;border-bottom:1px solid var(--line);display:flex;gap:18px;align-items:baseline;flex-wrap:wrap}
header.top h1{margin:0;font-size:20px;letter-spacing:.06em}
nav.pages{display:flex;gap:14px;flex-wrap:wrap}
nav.pages a{color:var(--dim)}nav.pages a.active{color:var(--acc)}
.tabs{display:flex;gap:8px;padding:14px 22px;border-bottom:1px solid var(--line);flex-wrap:wrap}
.tab{padding:4px 10px;border:1px solid var(--line);border-radius:999px;color:var(--dim);font-size:13px}
.tab.active{border-color:var(--acc);color:var(--acc)}
main{padding:20px 22px 60px;max-width:1180px}
.layout{display:grid;grid-template-columns:250px 1fr;gap:26px}
@media(max-width:860px){.layout{grid-template-columns:1fr}.toc{display:none}}
.toc{position:sticky;top:12px;align-self:start;font-size:13px;border:1px solid var(--line);border-radius:8px;padding:12px;max-height:80vh;overflow:auto}
.toc h3{margin:0 0 8px;font-size:12px;color:var(--dim);letter-spacing:.1em}
.toc a{display:block;color:var(--dim);padding:2px 0}
.tier{display:inline-block;min-width:22px;text-align:center;border-radius:4px;padding:1px 6px;font-weight:700;font-size:12px;margin-right:8px}
.tier.S{background:#3a0d0d;color:#ff6b6b}.tier.A{background:#3a2c0d;color:var(--amber)}.tier.B{background:#12301a;color:var(--acc)}.tier.C{background:#182028;color:var(--dim)}
.item{border:1px solid var(--line);border-radius:10px;padding:16px;margin:0 0 14px;background:var(--panel)}
.item h2{margin:0 0 6px;font-size:16px;line-height:1.35}
.lede{color:var(--ink);margin:4px 0 10px}
.meta{color:var(--dim);font-size:12.5px;display:flex;gap:12px;flex-wrap:wrap;margin-bottom:10px}
pre{background:#0a0d0b;border:1px solid var(--line);border-radius:8px;padding:10px;overflow:auto;font-size:13px}
.body-h{margin:10px 0 4px;font-size:13px;color:var(--dim)}
.item ul{margin:6px 0 6px 18px;padding:0}.item li{margin:2px 0}
.refs{display:flex;gap:12px;flex-wrap:wrap;font-size:12.5px;color:var(--dim);margin-top:10px;border-top:1px dashed var(--line);padding-top:8px}
.docs{margin-top:10px;font-size:13px}
.docs a{display:inline-block;margin:2px 10px 2px 0}
table.board{width:100%;border-collapse:collapse;font-size:14px}
table.board th,table.board td{border-bottom:1px solid var(--line);padding:7px 8px;text-align:left}
table.board th{color:var(--dim);font-size:12px;letter-spacing:.08em}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:20px}
.card{border:1px solid var(--line);border-radius:10px;padding:14px;background:var(--panel)}
.card .n{font-size:26px;color:var(--acc);font-weight:700}.card .l{color:var(--dim);font-size:12px;letter-spacing:.08em}
.tail{margin-top:26px}.tail h2{font-size:15px;color:var(--dim);border-bottom:1px solid var(--line);padding-bottom:6px}
.empty{color:var(--dim);font-style:italic}
.page-title{margin:0 0 14px;font-size:18px;letter-spacing:.06em}
.dim{color:var(--dim)}
.doc-item .meta a{color:var(--acc)}
.ext-badge{display:inline-block;margin-right:8px;padding:1px 6px;border-radius:4px;font-size:11px;font-weight:700;vertical-align:middle}
.ext-badge.new{background:#12301a;color:var(--acc)}
.ext-badge.upd{background:#3a2c0d;color:var(--amber)}
.ext-badge.sig{background:#2a1030;color:var(--mag)}
.grade{font-weight:700}
.grade.g-A{color:var(--acc)}.grade.g-B{color:var(--amber)}.grade.g-C{color:var(--mag)}
.ext-labels{margin-top:8px;display:flex;gap:6px;flex-wrap:wrap}
.ext-label{border:1px solid var(--line);border-radius:999px;padding:1px 8px;font-size:11.5px;color:var(--dim)}
details.more{margin:14px 0}
details.more summary{cursor:pointer;color:var(--acc);padding:10px;border:1px dashed var(--line);border-radius:8px}
.doc-changes{list-style:none;margin:8px 0 0;padding:0}
.doc-change{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;padding:5px 0;border-top:1px dashed var(--line)}
.doc-date{color:var(--dim);font-size:12.5px;min-width:150px}
.doc-title{flex:1;min-width:220px}
.doc-change .refs{margin:0;border:0;padding:0}
footer{color:var(--dim);font-size:12px;padding:0 22px 40px;max-width:1180px}
footer .ver{color:var(--acc)}
.credit{color:var(--dim);font-size:12px;margin-top:4px}
`;

const PAGE_NAV = [
  { href: "index.html", label: "Summary" },
  { href: "leaderboard.html", label: "Leaderboard" },
  { href: "extensions.html", label: "Extensions" },
  { href: "changes.html", label: "Changes" },
  { href: "releases.html", label: "Releases" },
  { href: "issues.html", label: "Issues" },
];

/** Render the shared page shell with the leaderboard/tour aesthetic. */
function layout(
  title: string,
  active: string,
  body: string,
  extra = "",
  generatedAt = "",
): string {
  const nav = PAGE_NAV.map((p) =>
    `<a href="${p.href}"${
      p.href === active ? ' class="active"' : ""
    }>${p.label}</a>`
  ).join("");
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — Swamp Pulse</title>
<style>${PAGE_CSS}${extra}</style>
</head><body>
<header class="top"><h1>SWAMP PULSE</h1><nav class="pages">${nav}</nav></header>
${body}
<footer>
  <div>Generated by <a href="${EXTENSION_URL}" rel="noopener"><code>${
    escapeHtml(EXTENSION_NAME)
  }</code></a> <span class="ver">v${escapeHtml(EXTENSION_VERSION)}</span>${
    generatedAt ? ` · last run ${renderTime(generatedAt)}` : ""
  }</div>
  <div>Detail pages follow the interactive release-notes tour format popularised by the
  <a href="https://victoriametrics.com/blog/go-1-27/" rel="noopener">VictoriaMetrics Go 1.27 tour</a>
  and <a href="https://antonz.org/" rel="noopener">Anton Zhiyanov</a>.</div>
</footer>
<script>${LOCAL_TIME_SCRIPT}</script>
</body></html>`;
}

/** Render one merged item as a tour section. */
export function renderItem(item: z.infer<typeof MergedItemSchema>): string {
  const id = item.id.replace(/[^a-zA-Z0-9]+/g, "-");
  const refs: string[] = [];
  if (item.releaseTag) {
    refs.push(
      `𝗗 <a href="${item.releaseUrl}" rel="noopener">release ${
        escapeHtml(item.releaseTag)
      }</a>`,
    );
  }
  if (item.commitSha) {
    refs.push(
      `𝗖𝗟 <a href="${item.commitUrl}" rel="noopener">${
        escapeHtml(item.shortSha)
      }</a>`,
    );
  }
  for (const pr of item.prNumbers) {
    refs.push(
      `𝗣 <a href="https://github.com/${item.repo}/pull/${pr}" rel="noopener">#${pr}</a>`,
    );
  }
  if (item.labIssue) {
    refs.push(
      `𝗔 <a href="${item.labIssue.url}" rel="noopener">lab#${item.labIssue.number}</a>`,
    );
  }

  const docs = item.docLinks.length
    ? `<div class="docs"><span class="meta">Docs changed:</span> ${
      item.docLinks.map((d) =>
        `<a href="${d.sourceUrl}" rel="noopener">${escapeHtml(d.filename)}</a>`
      ).join(", ")
    }</div>`
    : "";

  const body = item.summary && item.summary !== item.title
    ? `<div class="body">${
      renderMarkdownLite(item.summary.slice(0, 1500))
    }</div>`
    : "";

  return `<article class="item" id="${id}">
<h2><span class="tier ${item.importance}">${item.importance}</span>${
    escapeHtml(item.title)
  }</h2>
<p class="lede">${escapeHtml(item.rationale)}${
    item.repo ? ` · ${escapeHtml(item.repo)}` : ""
  }</p>
<div class="meta"><span>${renderTime(item.date)}</span>${
    item.scope ? `<span>${escapeHtml(item.scope)}</span>` : ""
  }${item.type ? `<span>${escapeHtml(item.type)}</span>` : ""}</div>
${body}
${docs}
<div class="refs">${refs.join("")}</div>
</article>`;
}

/** Render a full tour page (sidebar ToC + sections + tail groups). */
export function renderTourPage(
  title: string,
  active: string,
  items: z.infer<typeof MergedItemSchema>[],
  opts: {
    emptyText: string;
    head?: string;
    promote?: number;
    generatedAt?: string;
  },
): string {
  if (items.length === 0) {
    return layout(
      title,
      active,
      `<main><p class="empty">${escapeHtml(opts.emptyText)}</p></main>`,
      "",
      opts.generatedAt,
    );
  }

  // Promote the most significant items into the main tour body; group the rest
  // into the tour's named tail sections, mirroring the reference format.
  const promote = opts.promote ?? 12;
  const highlighted = items.slice(0, promote);
  const tailItems = items.slice(promote);
  // Partition (not filter) so an item lands in exactly one tail group.
  const tooling: z.infer<typeof MergedItemSchema>[] = [];
  const other: z.infer<typeof MergedItemSchema>[] = [];
  const hidden: z.infer<typeof MergedItemSchema>[] = [];
  for (const item of tailItems) {
    if (item.scope === "ci" || item.scope === "build") tooling.push(item);
    else if (item.importance === "A" || item.importance === "B") {
      other.push(item);
    } else hidden.push(item);
  }
  const tailGroups: Array<[string, z.infer<typeof MergedItemSchema>[]]> = [
    ["Other notable changes", other],
    ["Tooling", tooling],
    ["Hidden gems", hidden],
  ];

  const itemId = (item: z.infer<typeof MergedItemSchema>) =>
    item.id.replace(/[^a-zA-Z0-9]+/g, "-");

  const toc = highlighted.map((item) =>
    `<a href="#${
      itemId(item)
    }"><span class="tier ${item.importance}">${item.importance}</span>${
      escapeHtml(item.title.slice(0, 60))
    }</a>`
  ).join("");

  const tail = tailGroups
    .filter(([, group]) => group.length > 0)
    .map(([label, group]) =>
      `<section class="tail"><h2>${escapeHtml(label)}</h2>${
        group.map(renderItem).join("\n")
      }</section>`
    ).join("\n");

  const thoughts = renderFinalThoughts(items);

  const body =
    `<main><div class="layout"><aside class="toc"><h3>ON THIS PAGE</h3>${toc}</aside><div>
${opts.head ?? ""}
${highlighted.map(renderItem).join("\n")}
${tail}
${thoughts}
</div></div></main>`;
  return layout(title, active, body, "", opts.generatedAt);
}

/** Render the closing "Final thoughts" summary for a window. */
export function renderFinalThoughts(
  items: z.infer<typeof MergedItemSchema>[],
): string {
  if (items.length === 0) return "";
  const byTier = (t: string) => items.filter((i) => i.importance === t).length;
  const byType = new Map<string, number>();
  for (const item of items) {
    const key = item.kind === "issue" ? "issues" : (item.type || "changes");
    byType.set(key, (byType.get(key) ?? 0) + 1);
  }
  const themes = [...byType.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([k, n]) => `<li><strong>${escapeHtml(k)}</strong> — ${n}</li>`)
    .join("");
  const repos = new Set(items.map((i) => i.repo).filter(Boolean));
  return `<section class="tail"><h2>Final thoughts</h2>
<p>${items.length} items across ${repos.size || 1} source(s) in this window:
${byTier("S")} critical, ${byTier("A")} notable, ${byTier("B")} routine,
${byTier("C")} minor.</p>
<ul>${themes}</ul></section>`;
}

/** Render the leaderboard-style summary page. */
/**
 * Render the summary page: documentation changes for the month.
 *
 * The activity leaderboard lives on its own page (`leaderboard.html`); the
 * summary is docs-only, so a reader who wants "what documentation moved this
 * month" gets exactly that and nothing else.
 */
export function renderIndexPage(
  ranked: z.infer<typeof RankedSchema>,
): string {
  const widest = ranked.windows[ranked.windows.length - 1];
  const label = widest?.label ?? "";
  const groups = widest ? groupDocChanges(widest.items) : [];
  const changeCount = groups.reduce((n, g) => n + g.changes.length, 0);

  const head = `<div class="cards">
<div class="card"><div class="n">${groups.length}</div><div class="l">FILES CHANGED</div></div>
<div class="card"><div class="n">${changeCount}</div><div class="l">CHANGES</div></div>
<div class="card"><div class="n">${
    groups.filter((g) => g.manualUrl).length
  }</div><div class="l">WITH MANUAL PAGE</div></div>
</div>
<p class="lede">Documentation changed in the ${
    escapeHtml(label)
  } window, newest first. The activity leaderboard is on the
<a href="leaderboard.html">Leaderboard</a> page.</p>`;

  const body = `<main>
<h2 class="page-title">Documentation changes — ${escapeHtml(label)}</h2>
${head}
${renderDocSection(ranked)}
</main>`;
  return layout("Summary", "index.html", body, "", ranked.generatedAt);
}

/** Render the leaderboard page: ranked activity for 24h / 7d / month. */
export function renderLeaderboardPage(
  ranked: z.infer<typeof RankedSchema>,
): string {
  const cards = `<div class="cards">
<div class="card"><div class="n">${ranked.totals.events}</div><div class="l">MERGED EVENTS</div></div>
<div class="card"><div class="n">${ranked.totals.commits}</div><div class="l">COMMITS</div></div>
<div class="card"><div class="n">${ranked.totals.releases}</div><div class="l">RELEASES</div></div>
<div class="card"><div class="n">${ranked.totals.issues}</div><div class="l">LAB ISSUES</div></div>
<div class="card"><div class="n">${ranked.totals.docChanges}</div><div class="l">DOC CHANGES</div></div>
</div>`;

  const sections = ranked.windows.map((w) => {
    const top = w.items.slice(0, 25);
    const rows = top.map((item, i) =>
      `<tr>
<td>${i + 1}</td>
<td><span class="tier ${item.importance}">${item.importance}</span></td>
<td>${escapeHtml(item.title.slice(0, 90))}</td>
<td>${escapeHtml(item.kind)}</td>
<td>${escapeHtml(item.repo || "lab")}</td>
<td>${renderTime(item.date, "date")}</td>
</tr>`
    ).join("");
    return `<section class="tail"><h2>${
      escapeHtml(w.label)
    } · ${w.items.length} items</h2>
<table class="board"><thead><tr><th>#</th><th></th><th>ITEM</th><th>KIND</th><th>SOURCE</th><th>DATE</th></tr></thead>
<tbody>${
      rows || `<tr><td colspan="6" class="empty">No activity.</td></tr>`
    }</tbody></table></section>`;
  }).join("\n");

  const body = `<main>
<h2 class="page-title">Activity leaderboard</h2>
${cards}
${sections}
</main>`;
  return layout(
    "Leaderboard",
    "leaderboard.html",
    body,
    "",
    ranked.generatedAt,
  );
}

/** Render the labelled reference row for a change (release/commit/PR/issue). */
export function renderRefs(item: z.infer<typeof MergedItemSchema>): string {
  const refs: string[] = [];
  if (item.releaseTag) {
    refs.push(
      `𝗗 <a href="${item.releaseUrl}" rel="noopener">release ${
        escapeHtml(item.releaseTag)
      }</a>`,
    );
  }
  if (item.commitSha) {
    refs.push(
      `𝗖𝗟 <a href="${item.commitUrl}" rel="noopener">${
        escapeHtml(item.shortSha)
      }</a>`,
    );
  }
  for (const pr of item.prNumbers) {
    refs.push(
      `𝗣 <a href="https://github.com/${item.repo}/pull/${pr}" rel="noopener">#${pr}</a>`,
    );
  }
  if (item.labIssue) {
    refs.push(
      `𝗔 <a href="${item.labIssue.url}" rel="noopener">lab#${item.labIssue.number}</a>`,
    );
  }
  return refs.join("") || '<span class="dim">no source refs</span>';
}

/** One documentation file and the changes that touched it in the window. */
export type DocFileGroup = {
  filename: string;
  repo: string;
  sourceUrl: string;
  manualUrl: string;
  manualConfidence: number;
  latestDate: string;
  changes: z.infer<typeof MergedItemSchema>[];
};

/**
 * Group documentation changes by file.
 *
 * A file is listed once, ordered by most recent change; the changes that
 * touched it within the window sit inside the group. Deduplication is by
 * filename, not by URL — the URL carries the commit SHA, so the same file
 * changed twice would otherwise appear twice.
 */
export function groupDocChanges(
  items: z.infer<typeof MergedItemSchema>[],
): DocFileGroup[] {
  const byFile = new Map<string, DocFileGroup>();
  for (const item of items) {
    for (const doc of item.docLinks) {
      let group = byFile.get(doc.filename);
      if (!group) {
        group = {
          filename: doc.filename,
          repo: item.repo,
          sourceUrl: doc.sourceUrl,
          manualUrl: doc.manualUrl,
          manualConfidence: doc.manualConfidence,
          latestDate: item.date,
          changes: [],
        };
        byFile.set(doc.filename, group);
      }
      if (!group.changes.some((c) => c.id === item.id)) {
        group.changes.push(item);
      }
      // Keep the newest source URL / manual match for the file header.
      if (Date.parse(item.date) >= Date.parse(group.latestDate)) {
        group.latestDate = item.date;
        group.sourceUrl = doc.sourceUrl;
        group.manualUrl = doc.manualUrl;
        group.manualConfidence = doc.manualConfidence;
        group.repo = item.repo || group.repo;
      }
    }
  }

  for (const group of byFile.values()) {
    group.changes.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
  }
  return [...byFile.values()].sort(
    (a, b) => Date.parse(b.latestDate) - Date.parse(a.latestDate),
  );
}

/** Render one documentation file and the changes that touched it. */
export function renderDocFileCard(group: DocFileGroup): string {
  const manual = group.manualUrl
    ? `<a href="${group.manualUrl}" rel="noopener">published manual</a>`
    : `<span class="dim">no published page</span>`;

  const changes = group.changes.map((change) =>
    `<li class="doc-change">
<span class="tier ${change.importance}">${change.importance}</span>
<span class="doc-date">${renderTime(change.date)}</span>
<span class="doc-title">${escapeHtml(change.title)}</span>
<span class="refs">${renderRefs(change)}</span>
</li>`
  ).join("\n");

  return `<article class="item doc-item">
<h2><a href="${group.sourceUrl}" rel="noopener">${
    escapeHtml(group.filename)
  }</a></h2>
<div class="meta">${
    group.repo ? `<span>${escapeHtml(group.repo)}</span>` : ""
  }<span>${group.changes.length} change${
    group.changes.length === 1 ? "" : "s"
  }</span><span>updated ${
    renderTime(group.latestDate)
  }</span><span>${manual}</span></div>
<ul class="doc-changes">${changes}</ul>
</article>`;
}

/** Render one registry extension as a compact card. */
export function renderExtensionCard(
  ext: z.infer<typeof ExtensionsCollectionSchema>["extensions"][number],
  kind: "new" | "updated" | "significant",
): string {
  const badge = kind === "new"
    ? '<span class="ext-badge new">NEW</span>'
    : kind === "updated"
    ? '<span class="ext-badge upd">UPDATED</span>'
    : '<span class="ext-badge sig">POPULAR</span>';

  const repo = ext.repository
    ? `<a href="${escapeHtml(ext.repository)}" rel="noopener">${
      escapeHtml(ext.repositoryHost || "source")
    }</a>`
    : '<span class="dim">no repository</span>';

  const version = ext.latestVersion
    ? `<span>v${escapeHtml(ext.latestVersion)}</span>`
    : "";
  const grade = ext.scoreGrade
    ? `<span class="grade g-${escapeHtml(ext.scoreGrade)}">${
      escapeHtml(ext.scoreGrade)
    }</span>`
    : "";
  const pulls = ext.pullCount > 0
    ? `<span>${ext.pullCount.toLocaleString("en-US")} pulls</span>`
    : "";
  const labels = ext.labels.length
    ? `<div class="ext-labels">${
      ext.labels.slice(0, 8).map((l) =>
        `<span class="ext-label">${escapeHtml(l)}</span>`
      ).join("")
    }</div>`
    : "";

  const dates = kind === "new"
    ? `<span>first published ${renderTime(ext.createdAt)}</span>`
    : `<span>updated ${renderTime(ext.updatedAt)}</span>`;

  return `<article class="item ext-item">
<h2>${badge}<a href="${escapeHtml(ext.registryUrl)}" rel="noopener">${
    escapeHtml(ext.name)
  }</a></h2>
<p class="lede">${escapeHtml(ext.description.split("\n")[0].slice(0, 240))}</p>
<div class="meta"><span>${escapeHtml(ext.author || ext.namespace)}</span>${
    version ? `<span>${version}</span>` : ""
  }${grade}${pulls}<span>${repo}</span>${dates}</div>
${labels}
</article>`;
}

/**
 * Render the extensions page: registry new / updated / most-pulled.
 *
 * Sections follow the order requested — new first, then updated, then the
 * all-time most pulled (which is not window-scoped, so it is labelled as such).
 */
export function renderExtensionsPage(
  ranked: z.infer<typeof RankedSchema>,
): string {
  const ext = ranked.extensions;
  if (!ext) {
    return layout(
      "Extensions",
      "extensions.html",
      `<main><p class="empty">No extension registry data collected. Add the collect-extensions workflow step.</p></main>`,
      "",
      ranked.generatedAt,
    );
  }

  const newestFirst = (
    a: typeof ext.extensions[number],
    b: typeof ext.extensions[number],
  ) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  const fresh = ext.extensions.filter((e) => e.isNew).sort(newestFirst);
  const updated = ext.extensions.filter((e) => e.isUpdated).sort(newestFirst);

  const section = (
    title: string,
    note: string,
    items: typeof ext.extensions,
    kind: "new" | "updated" | "significant",
    collapseAfter = Infinity,
  ) => {
    if (items.length === 0) {
      return `<section class="tail"><h2>${
        escapeHtml(title)
      } <span class="dim">· 0</span></h2><p class="dim">${
        escapeHtml(note)
      }</p><p class="empty">None.</p></section>`;
    }
    const shown = items.slice(0, collapseAfter);
    const rest = items.slice(collapseAfter);
    const body = rest.length === 0
      ? shown.map((e) => renderExtensionCard(e, kind)).join("\n")
      : `${shown.map((e) => renderExtensionCard(e, kind)).join("\n")}
<details class="more"><summary>Show ${rest.length} more ${
        escapeHtml(title.toLowerCase())
      }…</summary>
${rest.map((e) => renderExtensionCard(e, kind)).join("\n")}</details>`;
    return `<section class="tail"><h2>${
      escapeHtml(title)
    } <span class="dim">· ${items.length}</span></h2><p class="dim">${
      escapeHtml(note)
    }</p>${body}</section>`;
  };

  const cards = `<div class="cards">
<div class="card"><div class="n">${ext.newCount}</div><div class="l">NEW</div></div>
<div class="card"><div class="n">${ext.updatedCount}</div><div class="l">UPDATED</div></div>
<div class="card"><div class="n">${ext.totalRegistry}</div><div class="l">IN REGISTRY</div></div>
<div class="card"><div class="n">${ext.pagesFetched}</div><div class="l">PAGES READ</div></div>
</div>`;

  const body = `<main>
<h2 class="page-title">Extension registry — every new and changed extension, linked to its source repo</h2>
${cards}
${section("New extensions", "First published in this window.", fresh, "new")}
${
    section(
      "Updated extensions",
      "A new version published in this window.",
      updated,
      "updated",
      50,
    )
  }
${
    section(
      "Most pulled",
      "All-time pull counts, regardless of the window.",
      ext.significant,
      "significant",
    )
  }
</main>`;
  return layout(
    "Extensions",
    "extensions.html",
    body,
    "",
    ranked.generatedAt,
  );
}

/** Collect and render the documentation entries for the widest window. */
function renderDocSection(ranked: z.infer<typeof RankedSchema>): string {
  // The windows nest (24h ⊂ 7d ⊂ month), so read the widest one only — the
  // others are strict subsets and would duplicate every entry.
  const widest = ranked.windows[ranked.windows.length - 1];
  if (!widest) return `<p class="empty">No documentation changed.</p>`;

  const groups = groupDocChanges(widest.items);
  if (groups.length === 0) {
    return `<p class="empty">No documentation changed.</p>`;
  }
  return groups.slice(0, 200).map(renderDocFileCard).join("\n");
}

// ---------------------------------------------------------------------------
// Resource & file specs
// ---------------------------------------------------------------------------

const EmptyArgs = z.object({});

const RankArgsSchema = z.object({
  commits: z.unknown().optional().describe(
    "Output of @webframp/github collect_commits (wire via CEL).",
  ),
  releases: z.unknown().optional().describe(
    "Output of @webframp/github collect_releases (wire via CEL).",
  ),
  docChanges: z.unknown().optional().describe(
    "Output of @webframp/github collect_doc_changes (wire via CEL).",
  ),
  labIssues: z.unknown().optional().describe(
    "Output of @svendowideit/swamp-club search_lab_issues (wire via CEL).",
  ),
  extensions: z.unknown().optional().describe(
    "Output of @svendowideit/swamp-ext-registry collect_extensions (wire via CEL).",
  ),
  now: z.string().optional().describe(
    "Override the evaluation timestamp (ISO-8601); useful for tests.",
  ),
});

const RenderArgsSchema = z.object({
  outputDir: z.string().optional().describe(
    "Override the output directory for the rendered HTML.",
  ),
});

/**
 * Human-facing catalogue of the model's global arguments.
 *
 * A `setup` method needs more than the schema can express: valid values for an
 * enum, whether a setting is required for a given mode, and a plain-language
 * explanation. Zod 4 does not expose enum options or defaults conveniently, so
 * this table is the single place that knowledge lives and the schema is kept in
 * step with it by {@link SETUP_SPECS}.
 */
export type SetupSpec = {
  name: string;
  kind: "string" | "number" | "array" | "enum";
  values?: string[];
  default: string;
  /** Grouping used when printing help. */
  group: "general" | "serving" | "publishing";
  /** Required only when this returns true (evaluated against resolved config). */
  requiredWhen?: (cfg: ResolvedConfig) => boolean;
  description: string;
};

/** The global arguments resolved for one run, after overrides. */
export type ResolvedConfig = {
  mode: string;
  pagesRepo: string;
  pagesBranch: string;
  caddyHostname: string;
};

/** Every global argument, with the help a user needs to set it. */
export const SETUP_SPECS: SetupSpec[] = [
  {
    name: "outputDir",
    kind: "string",
    default: "~/.swamp/swamp-pulse",
    group: "general",
    description: "Directory the six rendered HTML pages are written to.",
  },
  {
    name: "windows",
    kind: "array",
    values: ["24h", "7d", "month"],
    default: '["24h","7d","month"]',
    group: "general",
    description: "Which activity windows to compute and render.",
  },
  {
    name: "storeRetentionDays",
    kind: "number",
    default: "90",
    group: "general",
    description: "How many days of merged events to keep in the rolling store.",
  },
  {
    name: "manualBaseUrl",
    kind: "string",
    default: "https://swamp-club.com/manual",
    group: "general",
    description: "Base URL used when linking changed docs to the manual.",
  },
  {
    name: "docPathPattern",
    kind: "string",
    default: '""',
    group: "general",
    description:
      "Extra regex; matching changed paths are treated as documentation.",
  },
  {
    name: "serverPort",
    kind: "number",
    default: "8899",
    group: "serving",
    description: "Port the pulse static server listens on.",
  },
  {
    name: "serverServiceName",
    kind: "string",
    default: "swamp-pulse-server",
    group: "serving",
    description: "systemd user service name for the pulse server.",
  },
  {
    name: "serverScriptPath",
    kind: "string",
    default: "(bundled script)",
    group: "serving",
    description: "Override the path to the bundled pulse-server.ts.",
  },
  {
    name: "publishMode",
    kind: "enum",
    values: ["false", "caddy", "github-pages"],
    default: "false",
    group: "publishing",
    description:
      "What publishing to do. false = nothing; caddy = serve on a hostname; github-pages = commit to a Pages branch.",
  },
  {
    name: "pagesRepo",
    kind: "string",
    default: '""',
    group: "publishing",
    requiredWhen: (c) => c.mode === "github-pages",
    description:
      "Target repository as owner/name. Required for publishMode=github-pages.",
  },
  {
    name: "pagesBranch",
    kind: "string",
    default: '""',
    group: "publishing",
    requiredWhen: (c) => c.mode === "github-pages",
    description:
      "Branch Pages serves from, e.g. gh-pages. Required for publishMode=github-pages.",
  },
  {
    name: "pagesPath",
    kind: "enum",
    values: ["/", "/docs"],
    default: "/",
    group: "publishing",
    description: "Directory within the repository that Pages serves.",
  },
  {
    name: "pagesCname",
    kind: "string",
    default: '""',
    group: "publishing",
    description: "Optional custom domain for the Pages site.",
  },
  {
    name: "caddyHostname",
    kind: "string",
    default: '""',
    group: "publishing",
    requiredWhen: (c) => c.mode === "caddy",
    description: "Public hostname to serve on. Required for publishMode=caddy.",
  },
  {
    name: "caddyUpstream",
    kind: "string",
    default: "127.0.0.1:8899",
    group: "publishing",
    description: "host:port the Caddy reverse proxy points at.",
  },
];

/** Expand a leading `~` to the user's home directory. */
export function expandHome(path: string): string {
  const h = Deno.env.get("HOME") ?? "/tmp";
  if (path === "~") return h;
  if (path.startsWith("~/")) return `${h}${path.slice(1)}`;
  return path;
}

/** Run a `swamp` CLI command and capture stdout/stderr/exit code. */
export async function runSwampCmd(
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

/**
 * Resolve the bundled `pulse-server.ts` path.
 *
 * Prefers the extension's own bundled file (available when the extension is
 * installed), falling back to the in-repo development path.
 */
export function resolveServerScript(
  context: MethodContext,
  override?: string,
): string {
  if (override) return override;
  if (context.globalArgs.serverScriptPath) {
    return context.globalArgs.serverScriptPath;
  }
  if (context.extensionFile) {
    return context.extensionFile("scripts/pulse-server.ts");
  }
  return `${
    context.repoDir ?? "."
  }/extensions/workflows/swamp-pulse/scripts/pulse-server.ts`;
}

/**
 * Idempotently ensure the pulse static server runs as a systemd user service
 * via `@svendowideit/systemd-service`.
 *
 * Degrades gracefully: if the extension is not installed, or if its CLI calls
 * fail, the method returns `{ running: false }` with a logged reason instead of
 * failing the surrounding workflow — the HTML pages are already on disk.
 */
export async function ensureServerService(
  context: MethodContext,
  opts: { port?: number; serviceName?: string; scriptPath?: string },
  run: typeof runSwampCmd = runSwampCmd,
): Promise<{ running: boolean; reason: string; serviceName: string }> {
  const ga = context.globalArgs;
  const port = opts.port ?? ga.serverPort;
  const serviceName = opts.serviceName ?? ga.serverServiceName;
  const scriptPath = resolveServerScript(context, opts.scriptPath);

  const probe = await run([
    "model",
    "type",
    "search",
    "@svendowideit/systemd-service",
    "--json",
  ]);
  const installed = probe.code === 0 &&
    probe.stdout.includes("@svendowideit/systemd-service");
  if (!installed) {
    const reason =
      "@svendowideit/systemd-service not installed — skipping pulse server service setup. Run `swamp extension pull @svendowideit/systemd-service` to enable it.";
    context.logger?.info?.(reason);
    return { running: false, reason, serviceName };
  }

  const denoPath = expandHome("~/.swamp/deno/deno");
  const outDir = expandHome(ga.outputDir || "~/.swamp/swamp-pulse");
  // PATH is pinned because systemd user services start with a minimal
  // environment; the server needs only deno and read access to outDir.
  const pathEnv = "/usr/local/bin:/usr/bin:/bin";
  const command =
    `${denoPath} run --allow-net --allow-read --allow-env ${scriptPath} --port ${port} --dir ${outDir}`;

  const create = await run([
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
    "description=Swamp Pulse static server",
    "--input",
    `environment=["PULSE_PORT=${port}", "PULSE_DIR=${outDir}", "PATH=${pathEnv}"]`,
    "--skip-reports",
  ]);
  if (create.code !== 0) {
    const reason = `createService failed (${create.code}): ${
      create.stderr || create.stdout
    }`;
    context.logger?.warn?.(reason);
    return { running: false, reason, serviceName };
  }

  const start = await run([
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
    const reason = `startService failed (${start.code}): ${
      start.stderr || start.stdout
    }`;
    context.logger?.warn?.(reason);
    return { running: false, reason, serviceName };
  }

  context.logger?.info?.(
    "Pulse server service {serviceName} is running on port {port} (dir {dir})",
    { serviceName, port, dir: outDir },
  );
  return { running: true, reason: "started", serviceName };
}

/** Model definition for Swamp Pulse. */
export const model = {
  type: "@svendowideit/swamp-pulse",
  // The version must be written as a literal right here. Swamp Club's
  // registry extractor parses this file statically; if it cannot read a
  // literal it skips the file and reports the model as removed from the
  // extension. The footer constant below derives from this value.
  version: "2026.09.18.15",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.09.18.3",
      description:
        "Add serverPort, serverServiceName and serverScriptPath for the ensureServer systemd user service",
      upgradeAttributes: (old: Record<string, unknown>) => ({
        ...old,
        serverPort: old.serverPort ?? 8899,
        serverServiceName: old.serverServiceName ?? "swamp-pulse-server",
      }),
    },
    {
      toVersion: "2026.09.18.4",
      description:
        "No schema changes — documentation entries rendered in tour format and attributed to the issue a change closes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.09.18.5",
      description:
        "No schema changes — docs-only summary, activity leaderboard on its own page, and all timestamps localized in the browser",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.09.18.6",
      description: "No schema changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.09.18.7",
      description:
        "No schema changes — page footer links the registry page and shows the generating version and last run time; adds the extension-registry page and its collector",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.09.18.8",
      description:
        "No schema changes — opt-in GitHub Pages publish step; guard polarity corrected on publish steps",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.09.18.9",
      description: "No schema changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.09.18.10",
      description:
        "No schema changes — publishing settings moved to model global arguments (publishMode, pagesRepo, pagesBranch, pagesPath, pagesCname, caddyHostname, caddyUpstream) with a publishConfig resource; restore an inline version literal so the registry indexes the model",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.09.18.11",
      description:
        "No schema changes — workflow publish inputs are no longer dead: configure feeds them to publishConfig as per-run overrides that take precedence over the model globals (empty means defer to the model)",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.09.18.12",
      description:
        "No schema changes — document publish configuration precedence (per-run input > model global > default)",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.09.18.13",
      description:
        "No schema changes — document how to configure publishing on the pulse instance (model create/edit, file location, precedence, resolved config)",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.09.18.14",
      description:
        "No schema changes — document how to configure publishing on the pulse instance (model create/edit, file location, precedence, resolved config)",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.09.18.15",
      description:
        "No schema changes — add a setup method that lists every setting with its valid values, default and current value, validates proposed values, and reports the resolved publishing config; fix logger.warning -> logger.warn so warnings are actually emitted",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    store: {
      description: "Rolling merged-event store with collection cursors",
      schema: StoreSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    ranked: {
      description: "Ranked merged events per activity window",
      schema: RankedSchema,
      lifetime: "30d",
      garbageCollection: 5,
    },
    publishConfig: {
      description:
        "Resolved publishing configuration derived from the model's globals",
      schema: PublishConfigSchema,
      lifetime: "30d" as const,
      garbageCollection: 5,
    },
    manualIndex: {
      description: "Cached swamp-club manual page index for doc linking",
      schema: ManualIndexSchema,
      lifetime: "7d",
      garbageCollection: 3,
    },
  },
  files: {
    summaryPage: {
      description: "Leaderboard-style summary page",
      contentType: "text/html",
      lifetime: "30d",
      garbageCollection: 5,
    },
    leaderboardPage: {
      description: "Activity leaderboard page (24h / 7d / month)",
      contentType: "text/html",
      lifetime: "30d",
      garbageCollection: 5,
    },
    extensionsPage: {
      description: "Extension registry page (new / updated / most pulled)",
      contentType: "text/html",
      lifetime: "30d",
      garbageCollection: 5,
    },
    changesPage: {
      description: "Commits and changes tour page",
      contentType: "text/html",
      lifetime: "30d",
      garbageCollection: 5,
    },
    releasesPage: {
      description: "Releases tour page",
      contentType: "text/html",
      lifetime: "30d",
      garbageCollection: 5,
    },
    issuesPage: {
      description: "Lab issues tour page",
      contentType: "text/html",
      lifetime: "30d",
      garbageCollection: 5,
    },
  },
  methods: {
    publishConfig: {
      description:
        "Resolve the model's publishing globals into a resource the workflow can guard on. Publishes nothing itself. Fails only when the selected mode is missing required settings.",
      arguments: z.object({
        // Per-run overrides. Any value supplied here wins over the model's
        // global argument, so `--input publish=...` works while a user can
        // still configure publishing once on the instance.
        mode: z.enum(["", "false", "caddy", "github-pages"]).optional()
          .describe(
            "Override publishMode for this run. Empty uses the model global.",
          ),
        pagesRepo: z.string().optional().describe(
          "Override the target repository (owner/name).",
        ),
        pagesBranch: z.string().optional().describe(
          "Override the Pages branch.",
        ),
        pagesPath: z.enum(["/", "/docs"]).optional().describe(
          "Override the Pages source path.",
        ),
        pagesCname: z.string().optional().describe(
          "Override the custom domain.",
        ),
        caddyHostname: z.string().optional().describe(
          "Override the Caddy hostname.",
        ),
        caddyUpstream: z.string().optional().describe(
          "Override the Caddy upstream.",
        ),
      }),
      execute: async (
        args: {
          mode?: "" | "false" | "caddy" | "github-pages";
          pagesRepo?: string;
          pagesBranch?: string;
          pagesPath?: "/" | "/docs";
          pagesCname?: string;
          caddyHostname?: string;
          caddyUpstream?: string;
        },
        context: MethodContext,
      ) => {
        const g = context.globalArgs;
        // Precedence: per-run input > model global argument > schema default.
        const pick = (override: string | undefined, base: string) =>
          (override ?? "").trim() !== "" ? override!.trim() : base;
        // An empty string means "not supplied" — fall through to the global.
        const mode = args.mode ? args.mode : g.publishMode;
        const pagesRepo = pick(args.pagesRepo, g.pagesRepo);
        const pagesBranch = pick(args.pagesBranch, g.pagesBranch);
        const pagesPath = args.pagesPath ?? g.pagesPath;
        const pagesCname = pick(args.pagesCname, g.pagesCname);
        const caddyHostname = pick(args.caddyHostname, g.caddyHostname);
        const caddyUpstream = pick(args.caddyUpstream, g.caddyUpstream);
        const isGithubPages = mode === "github-pages";
        const isCaddy = mode === "caddy";

        // Only the selected mode's requirements count. A half-filled
        // github-pages config in caddy mode is not an error.
        let reason = "";
        if (isGithubPages) {
          const missing: string[] = [];
          if (!pagesRepo) missing.push("pagesRepo");
          if (!pagesBranch) missing.push("pagesBranch");
          if (missing.length > 0) {
            reason = `publishMode=github-pages requires global argument(s): ${
              missing.join(", ")
            }`;
          }
        } else if (isCaddy) {
          if (!caddyHostname) {
            reason =
              "publishMode=caddy requires the caddyHostname global argument";
          }
        }

        const config = {
          mode,
          enabled: mode !== "false",
          caddyHostname,
          caddyUpstream,
          pagesRepo,
          pagesBranch,
          pagesPath,
          pagesCname,
          configured: reason === "",
          reason,
          resolvedAt: new Date().toISOString(),
        };

        const handle = await context.writeResource(
          "publishConfig",
          "publish-config",
          config,
        );
        if (reason) {
          context.logger?.warn?.(
            "Publishing is enabled but not fully configured: {reason}",
            { reason },
          );
        } else {
          context.logger?.info?.(
            "Publishing mode {mode} ({state})",
            { mode, state: config.enabled ? "enabled" : "disabled" },
          );
        }
        return { dataHandles: [handle] };
      },
    },

    setup: {
      description:
        "Configuration helper. Run with no inputs to print every setting with its valid values, default and current value; pass any of them as inputs to validate and see the exact command to persist the change. Also reports the resolved publishing config. Persists nothing itself.",
      arguments: z.object({
        publishMode: z.enum(["false", "caddy", "github-pages"]).optional()
          .describe("Publishing mode."),
        pagesRepo: z.string().optional().describe(
          "Target repository (owner/name) for github-pages.",
        ),
        pagesBranch: z.string().optional().describe(
          "Branch Pages serves from, e.g. gh-pages.",
        ),
        pagesPath: z.enum(["/", "/docs"]).optional().describe(
          "Directory Pages serves from.",
        ),
        pagesCname: z.string().optional().describe("Custom domain."),
        caddyHostname: z.string().optional().describe(
          "Public hostname for caddy mode.",
        ),
        caddyUpstream: z.string().optional().describe(
          "host:port the Caddy proxy points at.",
        ),
        serverPort: z.number().int().min(1).max(65535).optional().describe(
          "Port the pulse server listens on.",
        ),
        serverServiceName: z.string().optional().describe(
          "systemd user service name.",
        ),
        outputDir: z.string().optional().describe(
          "Where the HTML pages are written.",
        ),
      }),
      execute: (
        args: Record<string, unknown>,
        context: MethodContext,
      ) => {
        const g = context.globalArgs;
        const defName = context.definition?.name ?? "pulse";

        // Current values, redacted where needed, as display strings.
        const currentOf = (name: string): string => {
          const v = (g as Record<string, unknown>)[name];
          if (v === undefined) return "(unset)";
          if (Array.isArray(v)) return JSON.stringify(v);
          if (v === "") return '"" (empty)';
          return String(v);
        };

        // Coerce defensively: a missing global must never stringify to
        // "undefined".
        const str = (v: unknown, fallback = ""): string =>
          v === undefined || v === null ? fallback : String(v);
        const resolved: ResolvedConfig = {
          mode: str(
            (args.publishMode as string | undefined) ?? g.publishMode,
            "false",
          ),
          pagesRepo: str((args.pagesRepo as string | undefined) ?? g.pagesRepo),
          pagesBranch: str(
            (args.pagesBranch as string | undefined) ?? g.pagesBranch,
          ),
          caddyHostname: str(
            (args.caddyHostname as string | undefined) ?? g.caddyHostname,
          ),
        };

        // Swamp injects the model's resolved globals into `args`, so presence
        // alone is not intent. A value counts as supplied only when it differs
        // from the current global argument (or the setting is unset).
        const norm = (v: unknown) =>
          typeof v === "string" ? v : JSON.stringify(v);
        const provided = Object.keys(args).filter((k) => {
          if (args[k] === undefined) return false;
          const cur = (g as Record<string, unknown>)[k];
          if (cur === undefined) return true;
          return norm(args[k]) !== norm(cur);
        });

        // --- Validate provided values against the schema ------------------
        const issues: string[] = [];
        for (const key of provided) {
          const value = args[key];
          if (value === undefined) continue;
          const field =
            GlobalArgsSchema.shape[key as keyof typeof GlobalArgsSchema.shape];
          if (!field) {
            issues.push(`${key}: not a known setting`);
            continue;
          }
          const res = field.safeParse(value);
          if (!res.success) {
            issues.push(
              `${key}: ${res.error.issues.map((i) => i.message).join("; ")}`,
            );
          }
        }
        if (issues.length > 0) {
          for (const issue of issues) {
            context.logger?.warn?.("setup: {issue}", { issue });
          }
          throw new Error(
            `setup: ${issues.length} invalid value(s): ${issues.join(", ")}`,
          );
        }

        // --- No inputs: print the full reference --------------------------
        if (provided.length === 0) {
          context.logger?.info?.(
            "swamp-pulse setup — every setting, its valid values and current value",
            {},
          );
          let group = "";
          for (const spec of SETUP_SPECS) {
            if (spec.group !== group) {
              group = spec.group;
              context.logger?.info?.("--- {group} ---", { group });
            }
            const values = spec.values
              ? ` values=${spec.values.join("|")}`
              : "";
            const req = spec.requiredWhen?.(resolved)
              ? " [required for the current mode]"
              : "";
            context.logger?.info?.(
              "{name} [{kind}] default={default}{values} current={current}{req} — {description}",
              {
                name: spec.name,
                kind: spec.kind,
                default: spec.default,
                values,
                current: currentOf(spec.name),
                req,
                description: spec.description,
              },
            );
          }
          context.logger?.info?.(
            "Publishing resolves to: mode={mode} pagesRepo={repo} pagesBranch={branch} caddyHostname={caddy}",
            {
              mode: resolved.mode,
              repo: resolved.pagesRepo || "(unset)",
              branch: resolved.pagesBranch || "(unset)",
              caddy: resolved.caddyHostname || "(unset)",
            },
          );
          if (!resolved.mode || resolved.mode === "false") {
            context.logger?.info?.(
              "Publishing is off. To enable: --input publishMode=github-pages --input pagesRepo=owner/repo --input pagesBranch=gh-pages (or publishMode=caddy --input caddyHostname=host).",
              {},
            );
          } else {
            const missing = SETUP_SPECS.filter((sp) =>
              sp.requiredWhen?.(resolved)
            ).filter((sp) => currentOf(sp.name).startsWith('""'));
            if (missing.length > 0) {
              context.logger?.warn?.(
                "publishMode={mode} still needs: {missing}",
                {
                  mode: resolved.mode,
                  missing: missing.map((m) => m.name).join(", "),
                },
              );
            }
          }
          context.logger?.info?.(
            "These are the model's global arguments. To change them: swamp model edit {name} (opens $EDITOR), or create the instance with --global-arg. Passing them to this method validates only — it does not persist.",
            { name: defName },
          );
          return { dataHandles: [] };
        }

        // --- Inputs supplied: validate, summarise, print the edit command --
        context.logger?.info?.("Validated {n} setting(s) OK.", {
          n: provided.length,
        });
        const lines: string[] = [];
        for (const key of provided) {
          lines.push(`  ${key}: ${JSON.stringify(args[key])}`);
        }
        context.logger?.info?.(
          "Would set:\n{lines}",
          { lines: lines.join("\n") },
        );

        // Re-evaluate requirements with the proposed values applied.
        const after: ResolvedConfig = {
          mode: String(
            (args.publishMode as string | undefined) ?? g.publishMode,
          ),
          pagesRepo: String(
            (args.pagesRepo as string | undefined) ?? g.pagesRepo,
          ),
          pagesBranch: String(
            (args.pagesBranch as string | undefined) ?? g.pagesBranch,
          ),
          caddyHostname: String(
            (args.caddyHostname as string | undefined) ?? g.caddyHostname,
          ),
        };
        const stillMissing = SETUP_SPECS.filter((sp) =>
          sp.requiredWhen?.(after)
        ).filter((sp) => {
          const proposed = (args as Record<string, unknown>)[sp.name];
          const value = proposed !== undefined
            ? String(proposed)
            : String((g as Record<string, unknown>)[sp.name] ?? "");
          return value === "";
        });
        if (after.mode !== "false" && stillMissing.length > 0) {
          context.logger?.warn?.(
            "After this change publishMode={mode} would still be missing: {missing}",
            {
              mode: after.mode,
              missing: stillMissing.map((m) => m.name).join(", "),
            },
          );
        }

        context.logger?.info?.(
          "To persist, run `swamp model edit {name}` and set the values above in globalArguments:.",
          { name: defName },
        );
        context.logger?.info?.(
          "Non-interactive alternative: pipe the definition through — cat models/@svendowideit/swamp-pulse/{name}.yaml | swamp model edit {name} --json",
          { name: defName },
        );
        return { dataHandles: [] };
      },
    },

    sync_manual_index: {
      description:
        "Fetch and cache the swamp-club manual sitemap so documentation changes can link to their published page.",
      arguments: EmptyArgs,
      execute: async (
        _args: Record<string, never>,
        context: MethodContext,
      ) => {
        const base = context.globalArgs.manualBaseUrl.replace(/\/$/, "");
        const sitemapUrl = `${base.replace(/\/manual$/, "")}/sitemap.xml`;
        let pages: string[] = [];
        try {
          const res = await fetch(sitemapUrl, {
            signal: AbortSignal.timeout(15000),
          });
          if (res.ok) {
            const xml = await res.text();
            pages = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)]
              .map((m) => m[1].trim())
              .filter((u) => u.includes("/manual/"));
          }
        } catch (err) {
          context.logger?.warn?.("Manual sitemap fetch failed: {error}", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        const handle = await context.writeResource(
          "manualIndex",
          "manual-index",
          {
            pages,
            count: pages.length,
            fetchedAt: new Date().toISOString(),
          },
        );
        context.logger?.info?.("Cached {count} manual pages", {
          count: pages.length,
        });
        return { dataHandles: [handle] };
      },
    },

    rank: {
      description:
        "Join releases, commits and Lab issues into one item per change, merge into the rolling store, and rank by window.",
      arguments: RankArgsSchema,
      execute: async (
        args: z.infer<typeof RankArgsSchema>,
        context: MethodContext,
      ) => {
        const now = args.now ? new Date(args.now) : new Date();
        const manual = await context.readResource("manualIndex") as
          | z.infer<typeof ManualIndexSchema>
          | null;
        const manualPages = manual?.pages ?? [];

        const fresh = mergeEvents(
          {
            commits: args.commits,
            releases: args.releases,
            docChanges: args.docChanges,
            labIssues: args.labIssues,
          },
          {
            manualPages,
            manualBaseUrl: context.globalArgs.manualBaseUrl,
            docPathPattern: context.globalArgs.docPathPattern,
          },
        );

        const prior = await context.readResource("store") as
          | z.infer<typeof StoreSchema>
          | null;
        const events = mergeStore(
          prior?.events ?? [],
          fresh,
          context.globalArgs.storeRetentionDays,
          now,
        );

        const windows = context.globalArgs.windows.map((key) => {
          const items = rankItems(events, key, now);
          const bounds = windowBounds(key, now);
          return {
            key,
            label: bounds.label,
            since: bounds.since.toISOString(),
            until: bounds.until.toISOString(),
            changes: items.filter((i) => i.kind === "change").length,
            releases: items.filter((i) => i.kind === "change" && i.releaseTag)
              .length,
            issues: items.filter((i) => i.kind === "issue").length,
            items,
          };
        });

        const byRepo: Record<string, number> = {};
        for (const item of events) {
          if (!item.repo) continue;
          byRepo[item.repo] = (byRepo[item.repo] ?? 0) + 1;
        }

        // The registry collector output is optional: a failed or unwired
        // collector must not fail ranking, so parse defensively.
        const extParsed = ExtensionsCollectionSchema.safeParse(
          celUnescapeDeep(args.extensions ?? {}),
        );
        const extensions = extParsed.success ? extParsed.data : null;

        const ranked: z.infer<typeof RankedSchema> = {
          windows,
          totals: {
            events: events.length,
            commits: fresh.filter((i) => i.kind === "change" && i.commitSha)
              .length,
            releases: fresh.filter((i) => i.releaseTag).length,
            issues: events.filter((i) => i.kind === "issue").length,
            docChanges: events.reduce((n, i) => n + i.docLinks.length, 0),
            byRepo,
          },
          manualPages: manualPages.length,
          extensions,
          generatedAt: now.toISOString(),
        };

        const handle = await context.writeResource("ranked", "ranked", ranked);
        await context.writeResource("store", "store", {
          events,
          cursor: {
            commitsSince: now.toISOString(),
            releasesSince: now.toISOString(),
            issuesSince: now.toISOString(),
            updatedAt: now.toISOString(),
          },
          updatedAt: now.toISOString(),
        });
        context.logger?.info?.(
          "Ranked {events} events into {windows} windows",
          { events: events.length, windows: windows.length },
        );
        return { dataHandles: [handle] };
      },
    },

    render: {
      description:
        "Render the six linked HTML pages (docs summary, leaderboard, extensions, changes, releases, issues) from the ranked data.",
      arguments: RenderArgsSchema,
      execute: async (
        args: z.infer<typeof RenderArgsSchema>,
        context: MethodContext,
      ) => {
        const ranked = await context.readResource("ranked") as
          | z.infer<typeof RankedSchema>
          | null;
        if (!ranked) {
          throw new Error("No ranked data — run `rank` before `render`.");
        }

        const all = ranked.windows[ranked.windows.length - 1]?.items ?? [];
        const changes = all.filter((i) => i.kind === "change" && !i.releaseTag);
        const releases = all.filter((i) => i.releaseTag);
        const issues = all.filter((i) => i.kind === "issue");

        const pages: Record<string, string> = {
          index: renderIndexPage(ranked),
          leaderboard: renderLeaderboardPage(ranked),
          extensions: renderExtensionsPage(ranked),
          changes: renderTourPage(
            "Changes",
            "changes.html",
            changes,
            {
              emptyText: "No unreleased changes in this window.",
              generatedAt: ranked.generatedAt,
            },
          ),
          releases: renderTourPage(
            "Releases",
            "releases.html",
            releases,
            {
              emptyText: "No releases in this window.",
              generatedAt: ranked.generatedAt,
            },
          ),
          issues: renderTourPage(
            "Lab issues",
            "issues.html",
            issues,
            {
              emptyText: "No Lab issues in this window.",
              generatedAt: ranked.generatedAt,
            },
          ),
        };

        const fileSpecs: Array<[string, string, string]> = [
          ["summaryPage", "index", "index.html"],
          ["leaderboardPage", "leaderboard", "leaderboard.html"],
          ["extensionsPage", "extensions", "extensions.html"],
          ["changesPage", "changes", "changes.html"],
          ["releasesPage", "releases", "releases.html"],
          ["issuesPage", "issues", "issues.html"],
        ];
        const handles = [];
        const outDir = expandHome(
          args.outputDir?.trim() || context.globalArgs.outputDir ||
            "~/.swamp/swamp-pulse",
        );
        await Deno.mkdir(outDir, { recursive: true });

        for (const [spec, key, filename] of fileSpecs) {
          const html = pages[key] ?? "";
          const writer = context.createFileWriter(spec, filename);
          const handle = await writer.writeText(html);
          await Deno.writeTextFile(`${outDir}/${filename}`, html);
          handles.push(handle);
        }

        context.logger?.info?.("Rendered {count} pages to {dir}", {
          count: fileSpecs.length,
          dir: outDir,
        });
        return { dataHandles: handles };
      },
    },

    ensureServer: {
      description:
        "Idempotently ensure the pulse static server runs as a systemd user service (via @svendowideit/systemd-service) so the generated pages are always served. Resolves the bundled pulse-server.ts script, creates the unit, and starts it. Skips gracefully (with a log) if the systemd-service extension is not installed.",
      arguments: z.object({
        port: z.number().int().min(1).max(65535).optional().describe(
          "Port the server listens on (defaults to global serverPort).",
        ),
        serviceName: z.string().optional().describe(
          "systemd user service name (defaults to global serverServiceName).",
        ),
        scriptPath: z.string().optional().describe(
          "Override the path to the pulse-server.ts script.",
        ),
      }),
      execute: async (
        args: { port?: number; serviceName?: string; scriptPath?: string },
        context: MethodContext,
      ) => {
        await ensureServerService(context, args);
        return { dataHandles: [] };
      },
    },
  },
};

/**
 * Extension version for the page footer, derived from the model definition so
 * the two cannot drift. Declared after `model` because `model.version` is the
 * single source of truth (and must stay an inline literal for the registry).
 */
const EXTENSION_VERSION: string = model.version;

export { EXTENSION_NAME, EXTENSION_URL, EXTENSION_VERSION };
