/**
 * GitHub Pages publishing via the GitHub REST API.
 *
 * A swamp model type (`@svendowideit/github-pages`) that idempotently
 * configures a repository's GitHub Pages site and publishes the contents of a
 * local directory (including subdirectories) to a branch that Pages serves.
 *
 * Methods:
 *   - `ensureSite`   — idempotently create or update the Pages site config
 *                      (source branch, source path, build type, custom domain,
 *                      HTTPS enforcement). Reconciles via GET then POST/PUT.
 *   - `publishDir`   — recursively walk a local directory and publish every
 *                      file to the configured branch as a single commit.
 *                      Unchanged files reuse their existing blob (no content
 *                      upload), identical trees produce no new commit, and a
 *                      `prune` option removes repository files absent locally.
 *   - `publishFiles` — the same publish path for an explicit list of files,
 *                      optionally mapped to explicit repository paths.
 *   - `syncSite`     — read the live Pages site + latest build and write a
 *                      drift snapshot resource.
 *
 * Authentication uses the `gh` CLI (`gh auth token`) by default, so no token
 * needs to be stored in the repository. Set `repo` explicitly, or leave it
 * unset and the repository is inferred from the current git checkout.
 *
 * Pure helpers (path sanitising, git blob hashing, directory walking, Pages
 * config reconciliation, API request building) are exported for unit testing
 * and take injected dependencies where they touch the filesystem.
 *
 * @module
 */
import { z } from "npm:zod@4";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const GlobalArgsSchema = z.object({
  repo: z.string().optional().describe(
    "GitHub repository as owner/name; defaults to the current git checkout",
  ),
  branch: z.string().default("gh-pages").describe(
    "Branch Pages serves the site from",
  ),
  pagesPath: z.enum(["/", "/docs"]).default("/").describe(
    "Directory within the repository Pages serves ('/' or '/docs')",
  ),
  buildType: z.enum(["legacy", "workflow"]).default("legacy").describe(
    "Pages build process; 'legacy' builds from the branch, 'workflow' via Actions",
  ),
  cname: z.string().optional().describe(
    "Custom domain to configure for the Pages site",
  ),
  httpsEnforced: z.boolean().default(true).describe(
    "Whether HTTPS should be enforced for the Pages site",
  ),
  apiBase: z.string().default("https://api.github.com").describe(
    "GitHub REST API base URL (override for GitHub Enterprise)",
  ),
  authToken: z.string().optional().meta({ sensitive: true }).describe(
    "GitHub token; when unset the token is read from `gh auth token`, " +
      "GH_TOKEN, or GITHUB_TOKEN",
  ),
  gitAuthorName: z.string().default("swamp-github-pages").describe(
    "Commit author name for published commits",
  ),
  gitAuthorEmail: z.string().default(
    "swamp-github-pages@users.noreply.github.com",
  )
    .describe("Commit author email for published commits"),
  commitMessage: z.string().default("Publish site via swamp").describe(
    "Commit message for published commits",
  ),
}).strict();

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const EnsureSiteArgsSchema = z.object({
  repo: z.string().optional().describe("Override the repository (owner/name)"),
  branch: z.string().optional().describe("Override the Pages source branch"),
  pagesPath: z.enum(["/", "/docs"]).optional().describe(
    "Override the Pages source path",
  ),
  buildType: z.enum(["legacy", "workflow"]).optional().describe(
    "Override the build type",
  ),
  cname: z.string().nullable().optional().describe(
    "Custom domain; pass null to remove an existing custom domain",
  ),
  httpsEnforced: z.boolean().optional().describe("Override HTTPS enforcement"),
});

const PublishDirArgsSchema = z.object({
  dir: z.string().describe("Local directory whose contents are published"),
  branch: z.string().optional().describe("Override the target branch"),
  repo: z.string().optional().describe("Override the repository (owner/name)"),
  message: z.string().optional().describe("Override the commit message"),
  prune: z.boolean().default(false).describe(
    "Delete repository files on the branch that are absent locally",
  ),
  dryRun: z.boolean().default(false).describe(
    "Compute what would change without creating a commit",
  ),
});

const FileMappingSchema = z.object({
  source: z.string().describe("Local file path"),
  repoPath: z.string().optional().describe(
    "Repository path; defaults to the file's basename",
  ),
});

const PublishFilesArgsSchema = z.object({
  files: z.array(z.union([z.string(), FileMappingSchema])).min(1).describe(
    "Files to publish, as paths or { source, repoPath } mappings",
  ),
  branch: z.string().optional().describe("Override the target branch"),
  repo: z.string().optional().describe("Override the repository (owner/name)"),
  message: z.string().optional().describe("Override the commit message"),
  prune: z.boolean().default(false).describe(
    "Delete repository files on the branch that are absent from the published set",
  ),
  dryRun: z.boolean().default(false).describe(
    "Compute what would change without creating a commit",
  ),
});

const SyncSiteArgsSchema = z.object({
  repo: z.string().optional().describe("Override the repository (owner/name)"),
});

// ---------------------------------------------------------------------------
// Resource output schemas
// ---------------------------------------------------------------------------

const SiteSchema = z.object({
  repo: z.string(),
  url: z.string(),
  status: z.string(),
  buildType: z.string(),
  sourceBranch: z.string(),
  sourcePath: z.string(),
  cname: z.string(),
  custom404: z.boolean(),
  public: z.boolean(),
  httpsEnforced: z.boolean(),
  httpsCertificateState: z.string(),
  httpsDeferred: z.boolean(),
  changed: z.boolean(),
  action: z.string(),
  ensuredAt: z.string(),
});

const PublishSchema = z.object({
  repo: z.string(),
  branch: z.string(),
  commitSha: z.string(),
  commitUrl: z.string(),
  parentSha: z.string(),
  action: z.string(),
  dryRun: z.boolean(),
  pruned: z.boolean(),
  truncated: z.boolean(),
  fileCount: z.number(),
  changedCount: z.number(),
  added: z.number(),
  modified: z.number(),
  deleted: z.number(),
  unchangedCount: z.number(),
  bytesUploaded: z.number(),
  files: z.array(z.object({
    path: z.string(),
    repoPath: z.string(),
    sha: z.string(),
    size: z.number(),
    status: z.string(),
  })),
  publishedAt: z.string(),
});

const SyncOutputSchema = z.object({
  repo: z.string(),
  exists: z.boolean(),
  url: z.string(),
  status: z.string(),
  buildType: z.string(),
  sourceBranch: z.string(),
  sourcePath: z.string(),
  cname: z.string(),
  httpsEnforced: z.boolean(),
  latestBuildStatus: z.string(),
  latestBuildCommit: z.string(),
  latestBuildError: z.string(),
  latestBuildCreatedAt: z.string(),
  syncedAt: z.string(),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A local file discovered for publishing, with its computed git blob hash. */
export interface LocalFile {
  /** Absolute or caller-relative path on disk. */
  path: string;
  /** Target path inside the repository (leading slash stripped). */
  repoPath: string;
  /** Git blob SHA-1 for the file content. */
  sha: string;
  /** File size in bytes. */
  size: number;
}

/** A git tree entry as returned by the GitHub Git Trees API. */
export interface RemoteTreeEntry {
  /** Repository-relative path. */
  path: string;
  /** Git object type ("blob" or "tree"). */
  type: string;
  /** Git object SHA. */
  sha: string;
  /** Git mode (e.g. "100644"). */
  mode: string;
  /** File size, when the API reports it. */
  size?: number;
}

/** The outcome of diffing local files against remote tree entries. */
export interface PublishPlan {
  /** Files whose content changed (adds and modifications). */
  changed: LocalFile[];
  /** Local repository paths that are new on the branch. */
  added: string[];
  /** Local repository paths that changed content. */
  modified: string[];
  /** Remote repository paths to delete (only when pruning). */
  deleted: RemoteTreeEntry[];
  /** Local repository paths already up to date. */
  unchanged: string[];
}

/** An uploaded git blob and its object SHA. */
export interface UploadedBlob {
  /** Repository path. */
  path: string;
  /** Blob object SHA. */
  sha: string;
  /** File size in bytes. */
  size: number;
}

/** The current configuration of a GitHub Pages site. */
export interface PagesSite {
  /** Pages site URL. */
  url: string;
  /** Build status (e.g. "built", "building"). */
  status: string;
  /** Build type ("legacy" or "workflow"). */
  buildType: string;
  /** Source branch. */
  sourceBranch: string;
  /** Source path ("/" or "/docs"). */
  sourcePath: string;
  /** Custom domain, or "" when unset. */
  cname: string;
  /** Whether a custom 404 page is configured. */
  custom404: boolean;
  /** Whether the site is public. */
  isPublic: boolean;
  /** Whether HTTPS is enforced. */
  httpsEnforced: boolean;
  /** HTTPS certificate state, or "" when unknown. */
  certificateState: string;
}

/** The fields of a Pages site that `ensureSite` reconciles. */
export interface PagesDesired {
  /** Desired source branch. */
  branch: string;
  /** Desired source path. */
  path: string;
  /** Desired build type. */
  buildType: string;
  /** Desired custom domain (undefined = leave as-is, null = remove). */
  cname?: string | null;
  /** Desired HTTPS enforcement (undefined = leave as-is). */
  httpsEnforced?: boolean;
}

/** The result of reconciling the desired Pages config against the live one. */
export interface PagesPlan {
  /** Whether a write is required. */
  changed: boolean;
  /** "create", "update", or "noop". */
  action: "create" | "update" | "noop";
  /** Fields that differ; used for logging. */
  differing: string[];
}

/** A minimal HTTP response abstraction used by the GitHub client. */
export interface HttpResponse {
  /** HTTP status code. */
  status: number;
  /** Raw response body. */
  body: string;
}

/** An injected HTTP transport, mirroring `fetch` for the subset used here. */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
  },
) => Promise<HttpResponse>;

/** An injected command runner returning stdout/stderr/exit code. */
export type CommandRunner = (
  bin: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string; code: number }>;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Expand a leading `~` to the user's home directory. */
export function expandHome(path: string, home?: string): string {
  const h = home ?? Deno.env.get("HOME") ?? "";
  if (path === "~") return h;
  if (path.startsWith("~/")) return `${h}${path.slice(1)}`;
  return path;
}

/** Strip a leading slash and collapse duplicate slashes in a repo path. */
export function sanitizeRepoPath(path: string): string {
  const collapsed = path.replace(/\\/g, "/").replace(/\/+/g, "/");
  const stripped = collapsed.replace(/^\/+/, "");
  if (stripped.split("/").some((segment) => segment === "..")) {
    throw new Error(`Unsafe repository path: ${path}`);
  }
  return stripped;
}

/** Join a repository directory prefix with a relative path. */
export function joinRepoPath(prefix: string, relative: string): string {
  const base = sanitizeRepoPath(prefix).replace(/\/+$/, "");
  const rel = sanitizeRepoPath(relative);
  if (!base || base === ".") return rel;
  if (!rel) return base;
  return `${base}/${rel}`;
}

/**
 * Compute the git blob SHA-1 for a byte sequence.
 *
 * Git hashes a blob as `sha1("blob <length>\0" + content)`. Computing it
 * locally lets `publishDir` skip uploading blobs that already exist remotely.
 */
export function gitBlobSha(bytes: Uint8Array): string {
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const combined = new Uint8Array(header.length + bytes.length);
  combined.set(header, 0);
  combined.set(bytes, header.length);
  return sha1Hex(combined);
}

/**
 * SHA-1 digest (hex) of arbitrary bytes.
 *
 * WebCrypto is async-only, so this synchronous implementation keeps
 * `gitBlobSha` pure and usable inside a tight per-file loop.
 */
export function sha1Hex(bytes: Uint8Array): string {
  const ml = bytes.length * 8;
  const withOne = new Uint8Array((((bytes.length + 8) >> 6) << 6) + 64);
  withOne.set(bytes);
  withOne[bytes.length] = 0x80;
  const view = new DataView(withOne.buffer);
  view.setUint32(withOne.length - 4, ml >>> 0, false);
  view.setUint32(withOne.length - 8, Math.floor(ml / 0x100000000), false);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);

  for (let i = 0; i < withOne.length; i += 64) {
    for (let j = 0; j < 16; j++) {
      w[j] = view.getUint32(i + j * 4, false);
    }
    for (let j = 16; j < 80; j++) {
      const v = w[j - 3] ^ w[j - 8] ^ w[j - 14] ^ w[j - 16];
      w[j] = (v << 1) | (v >>> 31);
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let j = 0; j < 80; j++) {
      let f: number;
      let k: number;
      if (j < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (j < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (j < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const temp = (((a << 5) | (a >>> 27)) + f + e + k + w[j]) >>> 0;
      e = d;
      d = c;
      c = (b << 30) | (b >>> 2);
      b = a;
      a = temp;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }

  return [h0, h1, h2, h3, h4]
    .map((h) => h.toString(16).padStart(8, "0"))
    .join("");
}

/**
 * Recursively walk a directory and return every regular file with its git blob
 * SHA and size.
 *
 * Symlinks are not followed (they are skipped) so a site directory cannot be
 * published outside its own tree. Paths are returned sorted for deterministic
 * commits.
 */
export async function walkDir(root: string): Promise<LocalFile[]> {
  const absRoot = expandHome(root);
  const files: LocalFile[] = [];

  async function visit(absDir: string, prefix: string): Promise<void> {
    const entries: Deno.DirEntry[] = [];
    for await (const entry of Deno.readDir(absDir)) {
      entries.push(entry);
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const abs = `${absDir}/${entry.name}`;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory) {
        await visit(abs, rel);
      } else if (entry.isFile) {
        const bytes = await Deno.readFile(abs);
        files.push({
          path: abs,
          repoPath: sanitizeRepoPath(rel),
          sha: gitBlobSha(bytes),
          size: bytes.length,
        });
      }
    }
  }

  const stat = await Deno.stat(absRoot).catch(() => null);
  if (!stat || !stat.isDirectory) {
    throw new Error(`Not a directory: ${root}`);
  }
  await visit(absRoot, "");
  return files;
}

/** Read a list of explicit files and compute their repository paths + hashes. */
export async function readFiles(
  files: Array<string | { source: string; repoPath?: string }>,
): Promise<LocalFile[]> {
  const out: LocalFile[] = [];
  for (const item of files) {
    const source = typeof item === "string" ? item : item.source;
    const abs = expandHome(source);
    const bytes = await Deno.readFile(abs).catch((err) => {
      throw new Error(
        `Cannot read file '${source}': ${(err as Error).message}`,
      );
    });
    const repoPath = typeof item === "string"
      ? sanitizeRepoPath(source.split("/").pop() ?? source)
      : sanitizeRepoPath(item.repoPath ?? source);
    out.push({
      path: abs,
      repoPath,
      sha: gitBlobSha(bytes),
      size: bytes.length,
    });
  }
  return out;
}

/** True when a repository path is inside a tree prefix ("" means the whole tree). */
function underPrefix(path: string, prefix: string): boolean {
  if (!prefix) return true;
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * Diff local files against remote tree entries.
 *
 * Returns the files that must be uploaded (content differs or is new), the
 * unchanged files, and — when pruning — the remote blobs to delete. Tree
 * entries with a type other than "blob" are ignored.
 *
 * `prefix` scopes deletions to the Pages source directory: publishing to
 * `main:/docs` with `prune` must never delete files outside `docs/`.
 */
export function planPublish(
  local: LocalFile[],
  remote: RemoteTreeEntry[],
  prune: boolean,
  prefix = "",
): PublishPlan {
  const remoteBlobs = new Map<string, RemoteTreeEntry>();
  for (const entry of remote) {
    if (entry.type === "blob") remoteBlobs.set(entry.path, entry);
  }

  const changed: LocalFile[] = [];
  const added: string[] = [];
  const modified: string[] = [];
  const unchanged: string[] = [];

  for (const file of local) {
    const existing = remoteBlobs.get(file.repoPath);
    if (!existing) {
      changed.push(file);
      added.push(file.repoPath);
    } else if (existing.sha !== file.sha) {
      changed.push(file);
      modified.push(file.repoPath);
    } else {
      unchanged.push(file.repoPath);
    }
  }

  const localPaths = new Set(local.map((f) => f.repoPath));
  const deleted = prune
    ? [...remoteBlobs.values()].filter((e) =>
      underPrefix(e.path, prefix) && !localPaths.has(e.path)
    )
    : [];

  return { changed, added, modified, deleted, unchanged };
}

/** Map a Pages site path ("/" or "/docs") to a repository tree prefix. */
export function pagesPathPrefix(pagesPath: string): string {
  return pagesPath === "/" || pagesPath === ""
    ? ""
    : sanitizeRepoPath(pagesPath);
}

/** Compare a desired Pages config with the live site state. */
export function planSite(
  current: PagesSite | null,
  desired: PagesDesired,
): PagesPlan {
  if (!current) {
    return { changed: true, action: "create", differing: ["site"] };
  }
  const differing: string[] = [];
  if (current.sourceBranch !== desired.branch) differing.push("source.branch");
  if (current.sourcePath !== desired.path) differing.push("source.path");
  if (current.buildType !== desired.buildType) differing.push("build_type");
  if (
    desired.cname !== undefined && desired.cname !== null &&
    current.cname !== desired.cname
  ) {
    differing.push("cname");
  }
  if (
    desired.cname === null && current.cname !== ""
  ) {
    differing.push("cname");
  }
  if (
    desired.httpsEnforced !== undefined &&
    current.httpsEnforced !== desired.httpsEnforced
  ) {
    differing.push("https_enforced");
  }
  return {
    changed: differing.length > 0,
    action: differing.length > 0 ? "update" : "noop",
    differing,
  };
}

/** Build the request body for creating or updating a Pages site. */
export function buildPagesBody(
  desired: PagesDesired,
  forCreate: boolean,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    build_type: desired.buildType,
    source: { branch: desired.branch, path: desired.path },
  };
  if (!forCreate) {
    if (desired.cname !== undefined) body.cname = desired.cname;
    if (desired.httpsEnforced !== undefined) {
      body.https_enforced = desired.httpsEnforced;
    }
  }
  return body;
}

/** Parse a Pages API response into the normalized PagesSite shape. */
export function parsePagesSite(
  raw: Record<string, unknown>,
): PagesSite {
  const source = (raw.source ?? {}) as Record<string, unknown>;
  const cert = (raw.https_certificate ?? {}) as Record<string, unknown>;
  return {
    // `url` is the REST API endpoint; `html_url` is the published site URL.
    url: typeof raw.html_url === "string"
      ? raw.html_url
      : (typeof raw.url === "string" ? raw.url : ""),
    status: typeof raw.status === "string" ? raw.status : "",
    buildType: typeof raw.build_type === "string" ? raw.build_type : "",
    sourceBranch: typeof source.branch === "string" ? source.branch : "",
    sourcePath: typeof source.path === "string" ? source.path : "",
    cname: typeof raw.cname === "string" ? raw.cname : "",
    custom404: raw.custom_404 === true,
    isPublic: raw.public === true,
    httpsEnforced: raw.https_enforced === true,
    certificateState: typeof cert.state === "string" ? cert.state : "",
  };
}

/** Build the HTTP headers for a GitHub REST API request. */
export function githubHeaders(token: string): Record<string, string> {
  return {
    "Accept": "application/vnd.github+json",
    "Authorization": `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "swamp-github-pages",
    "Content-Type": "application/json",
  };
}

/** Parse an `owner/name` repository string, throwing on malformed input. */
export function parseRepo(repo: string): { owner: string; name: string } {
  const parts = repo.trim().replace(/^\/+|\/+$/g, "").split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(
      `Invalid repository '${repo}': expected owner/name`,
    );
  }
  return { owner: parts[0], name: parts[1] };
}

/** Infer an `owner/name` repository from a git remote URL. */
export function parseRemoteUrl(url: string): string | null {
  const trimmed = url.trim();
  const match = trimmed.match(
    /(?:github\.com[/:])([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
  );
  if (!match) return null;
  return `${match[1]}/${match[2]}`;
}

/** Derive the HTTPS URL of a Pages site from the repository name. */
export function defaultPagesUrl(repo: string): string {
  const { owner, name } = parseRepo(repo);
  if (name.toLowerCase() === `${owner.toLowerCase()}.github.io`) {
    return `https://${owner.toLowerCase()}.github.io`;
  }
  return `https://${owner.toLowerCase()}.github.io/${name}/`;
}

// ---------------------------------------------------------------------------
// GitHub REST client
// ---------------------------------------------------------------------------

/** Options for constructing a {@link GitHubApi} client. */
export interface GitHubApiOptions {
  /** API base URL (override for GitHub Enterprise). */
  base: string;
  /** Bearer token. */
  token: string;
  /** Injected HTTP transport. */
  fetchImpl: FetchLike;
  /** Max attempts for transient failures (default 3). */
  maxAttempts?: number;
  /** Delay between retries in ms (default exponential backoff). */
  retryDelayMs?: (attempt: number) => number;
}

/** True when an HTTP response is worth retrying (rate limit or server error). */
export function isRetryableResponse(
  status: number,
  body: string,
): boolean {
  if (status === 429 || status >= 500) return true;
  if (status === 403 && /rate limit|secondary rate/i.test(body)) return true;
  return false;
}

/** Thin GitHub REST client over an injectable HTTP transport. */
export class GitHubApi {
  private readonly base: string;
  private readonly token: string;
  private readonly fetchImpl: FetchLike;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: (attempt: number) => number;

  /** Construct a client with an API base, token, and HTTP transport. */
  constructor(opts: GitHubApiOptions) {
    this.base = opts.base.replace(/\/+$/, "");
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl;
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.retryDelayMs = opts.retryDelayMs ??
      ((attempt) => Math.min(1000 * 2 ** attempt, 30_000));
  }

  /** Issue a request and return status + parsed JSON (or null for empty). */
  async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<
    { status: number; json: Record<string, unknown> | null; text: string }
  > {
    let res: HttpResponse = { status: 0, body: "" };
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      res = await this.fetchImpl(`${this.base}${path}`, {
        method,
        headers: githubHeaders(this.token),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (
        res.status >= 200 && res.status < 300 ||
        !isRetryableResponse(res.status, res.body)
      ) {
        break;
      }
      if (attempt < this.maxAttempts - 1) {
        await delay(this.retryDelayMs(attempt));
      }
    }
    return this.parseResponse(method, path, res);
  }

  /** Parse a completed response, throwing a descriptive error on non-2xx. */
  private parseResponse(
    method: string,
    path: string,
    res: HttpResponse,
  ): { status: number; json: Record<string, unknown> | null; text: string } {
    let json: Record<string, unknown> | null = null;
    if (res.body.trim()) {
      try {
        const parsed = JSON.parse(res.body);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          json = parsed as Record<string, unknown>;
        } else if (Array.isArray(parsed)) {
          json = { items: parsed } as Record<string, unknown>;
        }
      } catch {
        json = null;
      }
    }
    if (res.status < 200 || res.status >= 300) {
      const detail = json && typeof json.message === "string"
        ? json.message
        : res.body.slice(0, 300);
      throw new Error(
        `GitHub ${method} ${path} failed (${res.status}): ${detail}`,
      );
    }
    return { status: res.status, json, text: res.body };
  }

  /** Fetch the Pages site, or null when it has not been configured (404). */
  async getPages(repo: string): Promise<PagesSite | null> {
    const { owner, name } = parseRepo(repo);
    try {
      const res = await this.request("GET", `/repos/${owner}/${name}/pages`);
      return parsePagesSite(res.json ?? {});
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  /**
   * Create the Pages site (POST) and return the resulting state.
   *
   * Creating the source branch can itself enable Pages, so a 409 "already
   * enabled" is treated as success and the live state is read back.
   */
  async createPages(
    repo: string,
    desired: PagesDesired,
  ): Promise<PagesSite> {
    const { owner, name } = parseRepo(repo);
    try {
      const res = await this.request(
        "POST",
        `/repos/${owner}/${name}/pages`,
        buildPagesBody(desired, true),
      );
      return parsePagesSite(res.json ?? {});
    } catch (err) {
      if (isAlreadyEnabled(err)) {
        return await this.getPages(repo) ?? parsePagesSite({});
      }
      throw err;
    }
  }

  /**
   * Update the Pages site (PUT); the API returns 204 with no body.
   *
   * Enabling HTTPS before GitHub has provisioned a certificate fails with a
   * 404 ("The certificate does not exist yet"). That is a transient,
   * self-resolving condition, so the HTTPS flag is dropped and retried; the
   * other settings still apply and a later run enables HTTPS.
   */
  async updatePages(
    repo: string,
    desired: PagesDesired,
  ): Promise<{ httpsDeferred: boolean }> {
    const { owner, name } = parseRepo(repo);
    try {
      await this.request(
        "PUT",
        `/repos/${owner}/${name}/pages`,
        buildPagesBody(desired, false),
      );
      return { httpsDeferred: false };
    } catch (err) {
      if (desired.httpsEnforced === true && isCertificateNotReady(err)) {
        // GitHub rejects the update unless the HTTPS field is omitted
        // entirely — sending `false` fails the same way.
        const body = buildPagesBody(desired, false);
        delete body.https_enforced;
        await this.request("PUT", `/repos/${owner}/${name}/pages`, body);
        return { httpsDeferred: true };
      }
      throw err;
    }
  }

  /** Read the repository's default branch name. */
  async getDefaultBranch(repo: string): Promise<string> {
    const { owner, name } = parseRepo(repo);
    const res = await this.request("GET", `/repos/${owner}/${name}`);
    const branch = res.json?.default_branch;
    if (typeof branch !== "string" || !branch) {
      throw new Error(`Could not read default branch for ${repo}`);
    }
    return branch;
  }

  /** Read a branch head, or null when the branch does not exist. */
  async getBranchHead(repo: string, branch: string): Promise<
    {
      commitSha: string;
      treeSha: string;
      commit: Record<string, unknown>;
    } | null
  > {
    const { owner, name } = parseRepo(repo);
    try {
      const ref = await this.request(
        "GET",
        `/repos/${owner}/${name}/git/ref/heads/${encodeURIComponent(branch)}`,
      );
      const object = (ref.json?.object ?? {}) as Record<string, unknown>;
      const commitSha = typeof object.sha === "string" ? object.sha : "";
      if (!commitSha) {
        throw new Error(`Branch ${branch} has no commit object`);
      }
      const commit = await this.request(
        "GET",
        `/repos/${owner}/${name}/git/commits/${commitSha}`,
      );
      const tree = (commit.json?.tree ?? {}) as Record<string, unknown>;
      const treeSha = typeof tree.sha === "string" ? tree.sha : "";
      return { commitSha, treeSha, commit: commit.json ?? {} };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  /**
   * List every blob/tree entry under a tree, recursively.
   *
   * `truncated` mirrors the API's own flag: the response caps at ~100k
   * entries, so callers must not infer "absent" from a truncated listing.
   */
  async getTreeRecursive(
    repo: string,
    treeSha: string,
  ): Promise<{ entries: RemoteTreeEntry[]; truncated: boolean }> {
    const { owner, name } = parseRepo(repo);
    let res: { json: Record<string, unknown> | null; text: string };
    try {
      res = await this.request(
        "GET",
        `/repos/${owner}/${name}/git/trees/${treeSha}?recursive=1`,
      );
    } catch (err) {
      if (isNotFound(err) || isUnprocessable(err)) {
        return { entries: [], truncated: false };
      }
      throw err;
    }
    const raw = res.json ?? {};
    const items = Array.isArray(raw.tree)
      ? raw.tree as Record<string, unknown>[]
      : [];
    const entries: RemoteTreeEntry[] = [];
    for (const item of items) {
      const path = item.path;
      const type = item.type;
      const sha = item.sha;
      if (typeof path !== "string" || typeof sha !== "string") continue;
      entries.push({
        path,
        type: typeof type === "string" ? type : "blob",
        sha,
        mode: typeof item.mode === "string" ? item.mode : "100644",
        size: typeof item.size === "number" ? item.size : undefined,
      });
    }
    return { entries, truncated: raw.truncated === true };
  }

  /** Upload a blob and return its object SHA. */
  async createBlob(
    repo: string,
    content: Uint8Array,
  ): Promise<string> {
    const { owner, name } = parseRepo(repo);
    const res = await this.request(
      "POST",
      `/repos/${owner}/${name}/git/blobs`,
      { content: encodeBase64(content), encoding: "base64" },
    );
    const sha = res.json?.sha;
    if (typeof sha !== "string" || !sha) {
      throw new Error("GitHub did not return a blob SHA");
    }
    return sha;
  }

  /** Create a tree from base entries plus a delta. */
  async createTree(
    repo: string,
    entries: Array<
      { path: string; mode: string; type: string; sha: string | null }
    >,
    baseTree?: string,
  ): Promise<string> {
    const { owner, name } = parseRepo(repo);
    const body: Record<string, unknown> = { tree: entries };
    if (baseTree) body.base_tree = baseTree;
    const res = await this.request(
      "POST",
      `/repos/${owner}/${name}/git/trees`,
      body,
    );
    const sha = res.json?.sha;
    if (typeof sha !== "string" || !sha) {
      throw new Error("GitHub did not return a tree SHA");
    }
    return sha;
  }

  /** Create a commit; returns its SHA and URL. */
  async createCommit(
    repo: string,
    opts: {
      message: string;
      treeSha: string;
      parentShas: string[];
      authorName: string;
      authorEmail: string;
    },
  ): Promise<{ sha: string; url: string }> {
    const { owner, name } = parseRepo(repo);
    const body: Record<string, unknown> = {
      message: opts.message,
      tree: opts.treeSha,
      parents: opts.parentShas,
      author: {
        name: opts.authorName,
        email: opts.authorEmail,
        date: new Date().toISOString(),
      },
      committer: {
        name: opts.authorName,
        email: opts.authorEmail,
        date: new Date().toISOString(),
      },
    };
    const res = await this.request(
      "POST",
      `/repos/${owner}/${name}/git/commits`,
      body,
    );
    const sha = res.json?.sha;
    if (typeof sha !== "string" || !sha) {
      throw new Error("GitHub did not return a commit SHA");
    }
    return {
      sha,
      url: typeof res.json?.html_url === "string" ? res.json.html_url : "",
    };
  }

  /** Create or update a branch reference to point at a commit. */
  async upsertRef(
    repo: string,
    branch: string,
    commitSha: string,
    exists: boolean,
  ): Promise<void> {
    const { owner, name } = parseRepo(repo);
    if (exists) {
      await this.request(
        "PATCH",
        `/repos/${owner}/${name}/git/refs/heads/${encodeURIComponent(branch)}`,
        { sha: commitSha, force: true },
      );
    } else {
      await this.request(
        "POST",
        `/repos/${owner}/${name}/git/refs`,
        { ref: `refs/heads/${branch}`, sha: commitSha },
      );
    }
  }
}

/** Encode bytes as standard base64. */
export function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    const end = Math.min(i + chunk, bytes.length);
    for (let j = i; j < end; j++) {
      binary += String.fromCharCode(bytes[j]);
    }
  }
  return btoa(binary);
}

/** True when an error message reports an HTTP 404. */
export function isNotFound(err: unknown): boolean {
  return err instanceof Error && err.message.includes("(404)");
}

/** True when an error message reports an HTTP 422. */
export function isUnprocessable(err: unknown): boolean {
  return err instanceof Error && err.message.includes("(422)");
}

/** True when a Pages HTTPS update failed because the certificate isn't ready. */
export function isCertificateNotReady(err: unknown): boolean {
  return err instanceof Error &&
    /certificate does not exist yet/i.test(err.message);
}

/** True when creating a Pages site reports it is already enabled (409). */
export function isAlreadyEnabled(err: unknown): boolean {
  return err instanceof Error &&
    /\(409\)/.test(err.message) &&
    /already enabled/i.test(err.message);
}

/** Sleep for a number of milliseconds. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Command helpers
// ---------------------------------------------------------------------------

/** Run a command, capturing stdout/stderr (exit 127 on spawn failure). */
export async function runCmd(
  bin: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const proc = new Deno.Command(bin, {
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

/** Resolve a GitHub token from `gh auth token`, or "" when unavailable. */
export async function resolveGhToken(
  runner: CommandRunner,
  env: (key: string) => string | undefined,
): Promise<string> {
  const fromEnv = env("GH_TOKEN") ?? env("GITHUB_TOKEN");
  if (fromEnv) return fromEnv;
  const result = await runner("gh", ["auth", "token"]);
  if (result.code !== 0) return "";
  return result.stdout.trim();
}

/** Resolve the repository from explicit config, env, or the git remote. */
export async function resolveRepo(
  explicit: string | undefined,
  env: (key: string) => string | undefined,
  runner: CommandRunner,
): Promise<string> {
  if (explicit) return explicit;
  const fromEnv = env("GH_REPO");
  if (fromEnv) return fromEnv;
  const result = await runner("git", ["remote", "get-url", "origin"]);
  if (result.code === 0) {
    const parsed = parseRemoteUrl(result.stdout);
    if (parsed) return parsed;
  }
  throw new Error(
    "Could not determine repository — set the `repo` global argument " +
      "(owner/name), the GH_REPO environment variable, or run inside a git " +
      "checkout with an origin remote.",
  );
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

type MethodContext = {
  globalArgs: GlobalArgs;
  logger?: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    debug?: (msg: string, props?: Record<string, unknown>) => void;
    warning?: (msg: string, props?: Record<string, unknown>) => void;
    error?: (msg: string, props?: Record<string, unknown>) => void;
  };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
};

/** Build an API client that talks over the platform `fetch`. */
function buildClient(
  g: GlobalArgs,
  token: string,
): GitHubApi {
  return new GitHubApi({
    base: g.apiBase,
    token,
    fetchImpl: (url, init) =>
      fetch(url, init).then(async (r) => ({
        status: r.status,
        body: await r.text(),
      })),
  });
}

/** Resolve the API client, sourcing the token from args, gh, or the vault. */
async function buildApi(
  g: GlobalArgs,
): Promise<GitHubApi> {
  const token = g.authToken ??
    await resolveGhToken(runCmd, (k) => Deno.env.get(k));
  if (!token) {
    throw new Error(
      "No GitHub token — set the `authToken` global argument or " +
        "authenticate the gh CLI with `gh auth login`",
    );
  }
  return buildClient(g, token);
}

type CheckContext = {
  globalArgs: GlobalArgs;
  methodName: string;
};

/** Swamp model definition for GitHub Pages site configuration and publishing. */
export const model = {
  type: "@svendowideit/github-pages",
  version: "2026.09.25.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.09.25.1",
      description:
        "Documentation only: the manifest description is now the full user manual and the README uses the canonical sections. Global and method arguments are unchanged.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  checks: {
    "valid-target": {
      description:
        "Validate the repository, branch, and Pages source path are well-formed",
      labels: ["policy"],
      appliesTo: ["ensureSite", "publishDir", "publishFiles"],
      execute: (
        context: CheckContext,
      ): { pass: boolean; errors?: string[] } => {
        const errors: string[] = [];
        try {
          if (context.globalArgs.repo) parseRepo(context.globalArgs.repo);
        } catch (err) {
          errors.push((err as Error).message);
        }
        if (!context.globalArgs.branch.trim()) {
          errors.push("branch must not be empty");
        }
        if (
          context.globalArgs.pagesPath !== "/" &&
          context.globalArgs.pagesPath !== "/docs"
        ) {
          errors.push(
            `pagesPath must be "/" or "/docs", got ` +
              `"${context.globalArgs.pagesPath}"`,
          );
        }
        return errors.length > 0 ? { pass: false, errors } : { pass: true };
      },
    },
  },
  resources: {
    site: {
      description: "GitHub Pages site configuration state",
      schema: SiteSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    publish: {
      description: "Result of a directory/file publish operation",
      schema: PublishSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    sync: {
      description: "GitHub Pages site + latest build drift snapshot",
      schema: SyncOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    ensureSite: {
      description:
        "Idempotently create or update the GitHub Pages site configuration",
      arguments: EnsureSiteArgsSchema,
      execute: async (
        args: z.infer<typeof EnsureSiteArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const repo = await resolveRepo(
          args.repo ?? g.repo,
          (k) => Deno.env.get(k),
          runCmd,
        );
        const desired: PagesDesired = {
          branch: args.branch ?? g.branch,
          path: args.pagesPath ?? g.pagesPath,
          buildType: args.buildType ?? g.buildType,
          cname: args.cname !== undefined ? args.cname : g.cname,
          httpsEnforced: args.httpsEnforced ?? g.httpsEnforced,
        };
        if (desired.path !== "/" && desired.path !== "/docs") {
          throw new Error(`Invalid pagesPath '${desired.path}'`);
        }

        const api = await buildApi(g);

        const current = await api.getPages(repo);
        const plan = planSite(current, desired);

        context.logger?.info(
          "ensureSite {repo}: {action} (differing: {differing})",
          { repo, action: plan.action, differing: plan.differing.join(",") },
        );

        let httpsDeferred = false;
        let site: PagesSite;
        if (plan.action === "create") {
          // Pages `legacy` refuses to create a site whose source branch does
          // not exist yet. Ensure it (seeded from the default branch) first so
          // ensureSite converges on a fresh repository.
          if (desired.buildType === "legacy") {
            const { existed } = await ensureBranchHead(
              api,
              repo,
              desired.branch,
              true,
            );
            if (!existed) {
              context.logger?.info(
                "Created branch {branch} so Pages can build from it",
                { branch: desired.branch },
              );
            }
          }
          site = await api.createPages(repo, desired);
          // The create endpoint only accepts source + build_type; a follow-up
          // PUT applies the custom domain / HTTPS settings so a single call
          // converges instead of leaving drift for the next run.
          if (
            desired.cname !== undefined || desired.httpsEnforced !== undefined
          ) {
            const applied = await api.updatePages(repo, desired);
            if (applied.httpsDeferred) httpsDeferred = true;
            site = await api.getPages(repo) ?? site;
          }
        } else if (plan.action === "update") {
          const applied = await api.updatePages(repo, desired);
          if (applied.httpsDeferred) httpsDeferred = true;
          site = await api.getPages(repo) ?? current ?? parsePagesSite({});
        } else {
          site = current as PagesSite;
        }

        if (httpsDeferred) {
          context.logger?.warning?.(
            "HTTPS enforcement deferred for {repo}: GitHub has not issued a " +
              "certificate yet; re-run ensureSite after the site builds",
            { repo },
          );
        }

        context.logger?.info(
          "Pages site for {repo}: {action} ({url})",
          { repo, action: plan.action, url: site.url || defaultPagesUrl(repo) },
        );

        const handle = await context.writeResource("site", "site", {
          repo,
          url: site.url || defaultPagesUrl(repo),
          status: site.status,
          buildType: site.buildType || desired.buildType,
          sourceBranch: site.sourceBranch || desired.branch,
          sourcePath: site.sourcePath || desired.path,
          cname: desired.cname === null
            ? ""
            : (site.cname || desired.cname || ""),
          custom404: site.custom404,
          public: site.isPublic,
          httpsEnforced: desired.httpsEnforced ?? site.httpsEnforced,
          httpsCertificateState: site.certificateState,
          httpsDeferred,
          changed: plan.changed,
          action: plan.action,
          ensuredAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    publishDir: {
      description:
        "Publish a local directory (recursively) to the Pages branch as one commit",
      arguments: PublishDirArgsSchema,
      execute: async (
        args: z.infer<typeof PublishDirArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const repo = await resolveRepo(
          args.repo ?? g.repo,
          (k) => Deno.env.get(k),
          runCmd,
        );
        const branch = args.branch ?? g.branch;
        const prefix = pagesPathPrefix(g.pagesPath);

        context.logger?.info(
          "publishDir {dir} -> {repo}@{branch}{prefix}",
          { dir: args.dir, repo, branch, prefix: prefix ? `/${prefix}` : "/" },
        );

        const local = await walkDir(args.dir);
        const remapped = prefix
          ? local.map((f) => ({
            ...f,
            repoPath: joinRepoPath(prefix, f.repoPath),
          }))
          : local;

        const handle = await publishFiles({
          repo,
          branch,
          local: remapped,
          g,
          message: args.message ?? g.commitMessage,
          prune: args.prune,
          dryRun: args.dryRun,
          prefix,
          writeResource: context.writeResource,
          logger: context.logger,
        });
        return { dataHandles: [handle] };
      },
    },

    publishFiles: {
      description:
        "Publish an explicit list of files to the Pages branch as one commit",
      arguments: PublishFilesArgsSchema,
      execute: async (
        args: z.infer<typeof PublishFilesArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const repo = await resolveRepo(
          args.repo ?? g.repo,
          (k) => Deno.env.get(k),
          runCmd,
        );
        const branch = args.branch ?? g.branch;
        const prefix = pagesPathPrefix(g.pagesPath);

        const local = await readFiles(args.files);
        const remapped = prefix
          ? local.map((f) => ({
            ...f,
            repoPath: joinRepoPath(prefix, f.repoPath),
          }))
          : local;

        context.logger?.info(
          "publishFiles {count} file(s) -> {repo}@{branch}",
          { count: remapped.length, repo, branch },
        );

        const handle = await publishFiles({
          repo,
          branch,
          local: remapped,
          g,
          message: args.message ?? g.commitMessage,
          prune: args.prune,
          dryRun: args.dryRun,
          prefix,
          writeResource: context.writeResource,
          logger: context.logger,
        });
        return { dataHandles: [handle] };
      },
    },

    syncSite: {
      description:
        "Read the live Pages site and latest build into a drift snapshot",
      arguments: SyncSiteArgsSchema,
      execute: async (
        args: z.infer<typeof SyncSiteArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const repo = await resolveRepo(
          args.repo ?? g.repo,
          (k) => Deno.env.get(k),
          runCmd,
        );
        const api = await buildApi(g);
        const site = await api.getPages(repo);

        let latestBuildStatus = "";
        let latestBuildCommit = "";
        let latestBuildError = "";
        let latestBuildCreatedAt = "";
        if (site) {
          try {
            const { owner, name } = parseRepo(repo);
            const res = await api.request(
              "GET",
              `/repos/${owner}/${name}/pages/builds/latest`,
            );
            const raw = res.json ?? {};
            latestBuildStatus = typeof raw.status === "string"
              ? raw.status
              : "";
            latestBuildCommit = typeof raw.commit === "string"
              ? raw.commit
              : "";
            const errObj = (raw.error ?? {}) as Record<string, unknown>;
            latestBuildError = typeof errObj.message === "string"
              ? errObj.message
              : "";
            latestBuildCreatedAt = typeof raw.created_at === "string"
              ? raw.created_at
              : "";
          } catch (err) {
            if (!isNotFound(err)) throw err;
            context.logger?.warning?.(
              "No Pages build yet for {repo}",
              { repo },
            );
          }
        }

        context.logger?.info(
          "Synced {repo}: pages {status}, latest build {build}",
          {
            repo,
            status: site?.status ?? "not_configured",
            build: latestBuildStatus || "none",
          },
        );

        const handle = await context.writeResource("sync", "sync", {
          repo,
          exists: site !== null,
          url: site?.url ?? (site ? "" : defaultPagesUrl(repo)),
          status: site?.status ?? "not_configured",
          buildType: site?.buildType ?? "",
          sourceBranch: site?.sourceBranch ?? "",
          sourcePath: site?.sourcePath ?? "",
          cname: site?.cname ?? "",
          httpsEnforced: site?.httpsEnforced ?? false,
          latestBuildStatus,
          latestBuildCommit,
          latestBuildError,
          latestBuildCreatedAt,
          syncedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Shared publish implementation
// ---------------------------------------------------------------------------

interface PublishOptions {
  repo: string;
  branch: string;
  local: LocalFile[];
  g: GlobalArgs;
  message: string;
  prune: boolean;
  dryRun: boolean;
  /** Pages source prefix; scopes prune deletions ("" = whole branch). */
  prefix: string;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
  logger?: MethodContext["logger"];
}

/** Publish local files to a branch as a single commit (idempotent). */
async function publishFiles(
  opts: PublishOptions,
): Promise<{ name: string }> {
  const { repo, branch, local, g, message, prune, dryRun, prefix } = opts;
  const api = await buildApi(g);

  const { head, existed: branchExists } = await ensureBranchHead(
    api,
    repo,
    branch,
  );
  if (!branchExists) {
    opts.logger?.info(
      "Branch {branch} did not exist; seeded its history from the default branch",
      { branch },
    );
  }

  const { entries: remote, truncated } = await api.getTreeRecursive(
    repo,
    head.treeSha,
  );
  const effectivePrune = prune && !truncated;
  if (prune && truncated) {
    opts.logger?.warning?.(
      "Remote tree listing was truncated; skipping prune to avoid deleting " +
        "files the listing did not include",
      { repo, branch },
    );
  }
  const plan = planPublish(local, remote, effectivePrune, prefix);

  opts.logger?.info(
    "Plan: {changed} to upload, {deleted} to delete, {unchanged} unchanged",
    {
      changed: plan.changed.length,
      deleted: plan.deleted.length,
      unchanged: plan.unchanged.length,
    },
  );

  const now = new Date().toISOString();
  // Status per local repo path, so summary rows stay O(n).
  const added = new Set(plan.added);
  const modified = new Set(plan.modified);
  const unchanged = new Set(plan.unchanged);
  const localRows = local.map((f) => ({
    path: f.path,
    repoPath: f.repoPath,
    sha: f.sha,
    size: f.size,
    status: added.has(f.repoPath)
      ? "added"
      : modified.has(f.repoPath)
      ? "modified"
      : unchanged.has(f.repoPath)
      ? "unchanged"
      : "missing",
  }));
  const deletedRows = plan.deleted.map((d) => ({
    path: "",
    repoPath: d.path,
    sha: d.sha,
    size: d.size ?? 0,
    status: "deleted",
  }));

  if (!plan.changed.length && !plan.deleted.length) {
    opts.logger?.info("Nothing to publish — branch is already up to date", {
      repo,
      branch,
    });
    const handle = await opts.writeResource("publish", "publish", {
      repo,
      branch,
      commitSha: head.commitSha,
      commitUrl: "",
      parentSha: parentShaOf(head.commit),
      action: "noop",
      dryRun,
      pruned: effectivePrune,
      truncated,
      fileCount: local.length,
      changedCount: 0,
      added: 0,
      modified: 0,
      deleted: 0,
      unchangedCount: plan.unchanged.length,
      bytesUploaded: 0,
      files: localRows,
      publishedAt: now,
    });
    return handle;
  }

  if (dryRun) {
    opts.logger?.info("[dry-run] would create a commit on {branch}", {
      repo,
      branch,
      added: plan.added.length,
      modified: plan.modified.length,
      deleted: plan.deleted.length,
    });
    const handle = await opts.writeResource("publish", "publish", {
      repo,
      branch,
      commitSha: "",
      commitUrl: "",
      parentSha: head.commitSha,
      action: "dry_run",
      dryRun: true,
      pruned: effectivePrune,
      truncated,
      fileCount: local.length,
      changedCount: plan.changed.length,
      added: plan.added.length,
      modified: plan.modified.length,
      deleted: plan.deleted.length,
      unchangedCount: plan.unchanged.length,
      bytesUploaded: 0,
      files: [...localRows, ...deletedRows],
      publishedAt: now,
    });
    return handle;
  }

  const uploaded: UploadedBlob[] = [];
  let bytesUploaded = 0;
  const blobShas = new Map<string, string>();
  for (const f of plan.changed) {
    const bytes = await Deno.readFile(f.path);
    const sha = await api.createBlob(repo, bytes);
    uploaded.push({ path: f.repoPath, sha, size: f.size });
    blobShas.set(f.repoPath, sha);
    bytesUploaded += f.size;
  }

  const treeEntries = [
    ...uploaded.map((b) => ({
      path: b.path,
      mode: "100644",
      type: "blob",
      sha: b.sha as string | null,
    })),
    ...plan.deleted.map((d) => ({
      path: d.path,
      mode: d.mode || "100644",
      type: "blob",
      sha: null,
    })),
  ];
  const treeSha = await api.createTree(repo, treeEntries, head.treeSha);
  const commit = await api.createCommit(repo, {
    message,
    treeSha,
    parentShas: [head.commitSha],
    authorName: g.gitAuthorName,
    authorEmail: g.gitAuthorEmail,
  });
  await api.upsertRef(repo, branch, commit.sha, branchExists);

  opts.logger?.info(
    "Published commit {commit} to {repo}@{branch}",
    { commit: commit.sha, repo, branch },
  );

  const handle = await opts.writeResource("publish", "publish", {
    repo,
    branch,
    commitSha: commit.sha,
    commitUrl: commit.url,
    parentSha: head.commitSha,
    action: "committed",
    dryRun: false,
    pruned: effectivePrune,
    truncated,
    fileCount: local.length,
    changedCount: plan.changed.length,
    added: plan.added.length,
    modified: plan.modified.length,
    deleted: plan.deleted.length,
    unchangedCount: plan.unchanged.length,
    bytesUploaded,
    files: [
      ...localRows.map((row) => ({
        ...row,
        sha: blobShas.get(row.repoPath) ?? row.sha,
      })),
      ...deletedRows,
    ],
    publishedAt: now,
  });
  return handle;
}

/**
 * Resolve a branch head, seeding the branch from the repository's default
 * branch when it does not exist yet.
 *
 * Pages `legacy` builds require the source branch to exist before the site can
 * be created, so this is shared by `ensureSite` and the publish paths.
 */
export async function ensureBranchHead(
  api: GitHubApi,
  repo: string,
  branch: string,
  createIfMissing = false,
): Promise<
  {
    head: {
      commitSha: string;
      treeSha: string;
      commit: Record<string, unknown>;
    };
    /** True when the branch already existed; false when it was just seeded. */
    existed: boolean;
  }
> {
  const existing = await api.getBranchHead(repo, branch);
  if (existing) return { head: existing, existed: true };

  const defaultBranch = await api.getDefaultBranch(repo);
  const defaultHead = await api.getBranchHead(repo, defaultBranch);
  if (!defaultHead) {
    throw new Error(
      `Could not read ${repo}@${defaultBranch} to seed branch ${branch}`,
    );
  }
  // When requested, create the branch pointing at the default branch's head
  // immediately. Pages `legacy` requires the source branch to exist before the
  // site can be created. Publish paths leave creation to their commit step.
  if (createIfMissing) {
    await api.upsertRef(repo, branch, defaultHead.commitSha, false);
  }
  return {
    head: {
      commitSha: defaultHead.commitSha,
      treeSha: defaultHead.treeSha,
      commit: defaultHead.commit,
    },
    existed: false,
  };
}

/** Extract the first parent SHA from a commit API response. */
export function parentShaOf(commit: Record<string, unknown>): string {
  const parents = commit.parents;
  if (Array.isArray(parents) && parents.length > 0) {
    const first = parents[0] as Record<string, unknown>;
    if (typeof first.sha === "string") return first.sha;
  }
  return "";
}
