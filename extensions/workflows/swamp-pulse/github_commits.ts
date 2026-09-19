// SPDX-License-Identifier: MIT
/**
 * GitHub commit, release and documentation-change collectors, grafted onto
 * `@webframp/github`.
 *
 * Upstream `@webframp/github` covers repositories, PRs, issues, releases and
 * workflow runs, but has no commit methods and its release schema carries no
 * body (`tagName,name,publishedAt,isPrerelease,isDraft`, `--limit 10`). Swamp
 * Pulse needs commits, changed documentation files, and body-inclusive
 * releases, so this is an `export const extension` rather than a parallel `gh`
 * wrapper — it reuses the upstream type (and its `gh` auth).
 *
 * Each method is a **fan-out collector**: it takes a `repos` array and writes
 * one combined resource, so a run acquires the model lock once and the workflow
 * stays generic over however many repositories are configured.
 *
 * Method names avoid collisions with upstream: `list_releases` already exists
 * there, and a colliding extension method is silently skipped at registration,
 * so the body-inclusive method is named `collect_releases`.
 *
 * @module
 */

import { z } from "npm:zod@4";

import { celEscape } from "./cel_text.ts";
import { isDocPath } from "./doc_paths.ts";

const EXTENSION_NAME = "@svendowideit/swamp-pulse";

/** `owner/name` repository slug, matching the upstream argument's shape. */
const REPO_SLUG_RE = /^[\w.-]+\/[\w.-]+$/;
const reposArg = () =>
  z
    .array(
      z.string().regex(
        REPO_SLUG_RE,
        'Each repo must be in "owner/name" format (e.g. octocat/Hello-World)',
      ),
    )
    .min(1)
    .describe("Repositories in owner/name format.");

const CommitSchema = z.object({
  sha: z.string().describe("Full commit SHA"),
  shortSha: z.string().describe("Abbreviated commit SHA"),
  message: z.string().describe("First line of the commit message"),
  author: z.string().describe("Commit author name"),
  date: z.string().describe("Commit author timestamp (ISO-8601)"),
  url: z.string().describe("GitHub URL for the commit"),
}).strict();

const RepoCommitsSchema = z.object({
  repo: z.string().describe("Repository the commits belong to"),
  commits: z.array(CommitSchema).describe("Commits in the queried window"),
  count: z.number().describe("Number of commits returned"),
  truncated: z.boolean().describe(
    "True when the result was capped or the API reported more pages",
  ),
}).strict();

const CommitCollectionSchema = z.object({
  repos: z.array(RepoCommitsSchema).describe("Per-repository commit lists"),
  count: z.number().describe("Total commits across all repositories"),
  truncated: z.boolean().describe(
    "True when any repository's result was capped",
  ),
  since: z.string().describe("Lower bound used for the query"),
  until: z.string().describe("Upper bound used for the query"),
  fetchedAt: z.string().describe("Timestamp the collection was fetched"),
  durationMs: z.number().describe("Method execution duration in milliseconds"),
  collectedBy: z.string().describe("Extension that collected this data"),
}).strict();

const ChangedFileSchema = z.object({
  repo: z.string().describe("Repository the file belongs to"),
  sha: z.string().describe("Commit SHA that changed the file"),
  shortSha: z.string().describe("Abbreviated commit SHA"),
  filename: z.string().describe("Path of the changed file"),
  status: z.string().describe("Change status (added, modified, removed, …)"),
  additions: z.number().describe("Lines added"),
  deletions: z.number().describe("Lines deleted"),
  changes: z.number().describe("Total lines changed"),
}).strict();

const DocChangeSchema = z.object({
  repos: z.array(
    z.object({
      repo: z.string(),
      files: z.array(ChangedFileSchema),
      commitsInspected: z.number().describe(
        "Doc-suspect commits whose files were fetched",
      ),
      truncated: z.boolean(),
    }),
  ).describe("Per-repository changed documentation files"),
  count: z.number().describe("Total changed documentation files"),
  truncated: z.boolean().describe(
    "True when any repository's file fetch was capped",
  ),
  since: z.string().describe("Lower bound used for the query"),
  until: z.string().describe("Upper bound used for the query"),
  fetchedAt: z.string().describe("Timestamp the collection was fetched"),
  durationMs: z.number().describe("Method execution duration in milliseconds"),
  collectedBy: z.string().describe("Extension that collected this data"),
}).strict();

const ReleaseSchema = z.object({
  tagName: z.string().describe("Git tag associated with the release"),
  name: z.string().describe("Release title"),
  body: z.string().describe("Release notes body (may be empty)"),
  publishedAt: z.string().describe("Timestamp the release was published"),
  isPrerelease: z.boolean().describe("Whether the release is a prerelease"),
  isDraft: z.boolean().describe("Whether the release is a draft"),
  commitSha: z.string().describe(
    "Commit SHA parsed from the tag (empty when the tag has no -sha. suffix)",
  ),
  url: z.string().describe("GitHub URL for the release"),
}).strict();

const ReleaseCollectionSchema = z.object({
  repos: z.array(
    z.object({
      repo: z.string(),
      releases: z.array(ReleaseSchema),
      count: z.number(),
      truncated: z.boolean(),
    }),
  ).describe("Per-repository release lists"),
  count: z.number().describe("Total releases across all repositories"),
  truncated: z.boolean().describe(
    "True when any repository's result was capped",
  ),
  since: z.string().describe("Lower bound used for the query"),
  fetchedAt: z.string().describe("Timestamp the collection was fetched"),
  durationMs: z.number().describe("Method execution duration in milliseconds"),
  collectedBy: z.string().describe("Extension that collected this data"),
}).strict();

type Context = {
  globalArgs: Record<string, never>;
  writeResource: (
    spec: string,
    instance: string,
    data: unknown,
  ) => Promise<{ name: string }>;
  logger: {
    info: (msg: string, props: Record<string, unknown>) => void;
  };
};

/** Execute a `gh api` call and return its parsed JSON. */
async function ghApi(endpoint: string): Promise<unknown> {
  const cmd = new Deno.Command("gh", {
    args: ["api", endpoint],
    stdout: "piped",
    stderr: "piped",
  });
  let output: Deno.CommandOutput;
  try {
    output = await cmd.output();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `gh api ${endpoint} could not be executed (is the gh CLI installed?): ${message}`,
    );
  }
  if (!output.success) {
    const err = new TextDecoder().decode(output.stderr).trim();
    throw new Error(
      `gh api ${endpoint} failed (exit ${output.code}): ${
        err || "(no output)"
      }`,
    );
  }
  const stdout = new TextDecoder().decode(output.stdout);
  try {
    return JSON.parse(stdout);
  } catch (parseErr) {
    const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
    throw new Error(
      `gh api ${endpoint} returned output that could not be parsed as JSON: ${msg}`,
      { cause: parseErr },
    );
  }
}

/** Fetch commits for one repository in a window. */
async function fetchCommits(
  repo: string,
  since: string,
  until: string,
  max: number,
  pageSize: number,
): Promise<{ commits: z.infer<typeof CommitSchema>[]; truncated: boolean }> {
  const commits: z.infer<typeof CommitSchema>[] = [];
  let truncated = false;
  let page = 1;

  while (commits.length < max) {
    const endpoint = `repos/${repo}/commits?since=${
      encodeURIComponent(since)
    }&until=${encodeURIComponent(until)}&per_page=${pageSize}&page=${page}`;
    const data = await ghApi(endpoint);
    const rows = Array.isArray(data) ? data : [];
    if (rows.length === 0) break;

    for (const raw of rows) {
      const entry = raw as Record<string, unknown>;
      const commit = entry.commit as Record<string, unknown> | undefined;
      const commitAuthor = commit?.author as
        | Record<string, unknown>
        | undefined;
      const sha = String(entry.sha ?? "");
      commits.push({
        sha,
        shortSha: sha.slice(0, 8),
        message: celEscape(String(commit?.message ?? "").split("\n")[0]),
        author: String(commitAuthor?.name ?? "unknown"),
        date: String(commitAuthor?.date ?? ""),
        url: `https://github.com/${repo}/commit/${sha}`,
      });
      if (commits.length >= max) {
        truncated = true;
        break;
      }
    }

    if (rows.length < pageSize) break;
    page += 1;
  }

  return { commits, truncated };
}

/**
 * Collect every changed documentation file across a commit range.
 *
 * Uses the compare API for the file inventory (two calls for the whole range,
 * not one call per commit), then attributes each documentation file to the
 * newest commit that touched it via the commits-by-path endpoint — so a doc
 * change links back to the change it shipped with, even when the commit message
 * said nothing about docs.
 */
async function fetchRangeDocs(
  repo: string,
  since: string,
  until: string,
  maxCommits: number,
  maxFiles: number,
  extraPathPattern: string,
): Promise<{
  files: z.infer<typeof ChangedFileSchema>[];
  commitCount: number;
  truncated: boolean;
}> {
  const { commits, truncated: commitsTruncated } = await fetchCommits(
    repo,
    since,
    until,
    maxCommits,
    100,
  );
  if (commits.length === 0) {
    return { files: [], commitCount: 0, truncated: commitsTruncated };
  }

  const head = commits[0].sha;
  const oldest = commits[commits.length - 1].sha;
  const parentRaw = await ghApi(`repos/${repo}/commits/${oldest}`);
  const parent = (parentRaw as { parents?: { sha?: string }[] }).parents?.[0]
    ?.sha;
  const base = parent ?? oldest;

  const compare = await ghApi(
    `repos/${repo}/compare/${base}...${head}?per_page=100`,
  ) as { files?: Record<string, unknown>[]; total_commits?: number };

  const rows = Array.isArray(compare.files) ? compare.files : [];
  const docRows = rows.filter((f) =>
    isDocPath(
      String((f as Record<string, unknown>).filename ?? ""),
      extraPathPattern,
    )
  );

  const files: z.infer<typeof ChangedFileSchema>[] = [];
  for (const row of docRows) {
    if (files.length >= maxFiles) break;
    const entry = row as Record<string, unknown>;
    const filename = String(entry.filename ?? "");
    // Attribute to the newest in-window commit that touched this path.
    const owner = await fetchOwningCommit(repo, filename, since, until);
    files.push({
      repo,
      sha: owner?.sha ?? head,
      shortSha: (owner?.sha ?? head).slice(0, 8),
      filename,
      status: String(entry.status ?? "modified"),
      additions: Number(entry.additions ?? 0),
      deletions: Number(entry.deletions ?? 0),
      changes: Number(entry.changes ?? 0),
    });
  }

  return {
    files,
    commitCount: commits.length,
    truncated: commitsTruncated || files.length < docRows.length ||
      (compare.total_commits !== undefined &&
        compare.total_commits > commits.length),
  };
}

/** Find the newest commit in the window that changed a path. */
async function fetchOwningCommit(
  repo: string,
  path: string,
  since: string,
  until: string,
): Promise<{ sha: string } | null> {
  try {
    const data = await ghApi(
      `repos/${repo}/commits?path=${encodeURIComponent(path)}&since=${
        encodeURIComponent(since)
      }&until=${encodeURIComponent(until)}&per_page=1`,
    );
    const rows = Array.isArray(data) ? data : [];
    const sha = (rows[0] as { sha?: string } | undefined)?.sha;
    return sha ? { sha } : null;
  } catch {
    return null;
  }
}

/** Swamp Pulse GitHub collectors, attached to `@webframp/github`. */
export const extension = {
  type: "@webframp/github",
  resources: {
    commits: {
      description: "Commits for one or more repositories in a time window",
      schema: CommitCollectionSchema,
      lifetime: "1h" as const,
      garbageCollection: 10,
    },
    docChanges: {
      description: "Changed documentation files across repositories",
      schema: DocChangeSchema,
      lifetime: "7d" as const,
      garbageCollection: 20,
    },
    releasesFull: {
      description: "Releases with bodies for one or more repositories",
      schema: ReleaseCollectionSchema,
      lifetime: "1h" as const,
      garbageCollection: 10,
    },
  },
  methods: [
    {
      collect_commits: {
        description:
          "Collect commits for each repository in a time window, newest first.",
        arguments: z.object({
          repos: reposArg(),
          since: z.string().describe(
            "ISO-8601 lower bound on commit author date (inclusive).",
          ),
          until: z.string().optional().describe(
            "ISO-8601 upper bound on commit author date (inclusive). Defaults to now.",
          ),
          max: z.number().int().min(1).max(2000).default(500).describe(
            "Maximum commits per repository across pages.",
          ),
          pageSize: z.number().int().min(1).max(100).default(100).describe(
            "Commits requested per page (GitHub caps this at 100).",
          ),
        }).strict(),
        execute: async (
          args: {
            repos: string[];
            since: string;
            until?: string;
            max: number;
            pageSize: number;
          },
          context: Context,
        ) => {
          const startMs = Date.now();
          const until = args.until ?? new Date().toISOString();
          const since = args.since && args.since.trim()
            ? args.since
            : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
          const perRepo = [];
          let count = 0;
          let truncated = false;

          for (const repo of args.repos) {
            const result = await fetchCommits(
              repo,
              since,
              until,
              args.max,
              args.pageSize,
            );
            count += result.commits.length;
            truncated = truncated || result.truncated;
            perRepo.push({
              repo,
              commits: result.commits,
              count: result.commits.length,
              truncated: result.truncated,
            });
          }

          const handle = await context.writeResource("commits", "commits", {
            repos: perRepo,
            count,
            truncated,
            since,
            until,
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          });
          context.logger.info(
            "Collected {count} commits across {repos} repos",
            {
              count,
              repos: args.repos.length,
            },
          );
          return { dataHandles: [handle] };
        },
      },
    },
    {
      collect_releases: {
        description:
          "Collect releases with their full notes bodies for each repository. Uses the releases API (which returns bodies) and paginates.",
        arguments: z.object({
          repos: reposArg(),
          since: z.string().optional().describe(
            "ISO-8601 lower bound on publishedAt (inclusive). Defaults to 30 days ago.",
          ),
          max: z.number().int().min(1).max(500).default(300).describe(
            "Maximum releases per repository across pages.",
          ),
          pageSize: z.number().int().min(1).max(100).default(100).describe(
            "Releases requested per page (GitHub caps this at 100).",
          ),
        }).strict(),
        execute: async (
          args: {
            repos: string[];
            since?: string;
            max: number;
            pageSize: number;
          },
          context: Context,
        ) => {
          const startMs = Date.now();
          const since = args.since && args.since.trim()
            ? args.since
            : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
          const sinceMs = Date.parse(since);
          const perRepo = [];
          let count = 0;
          let truncated = false;

          for (const repo of args.repos) {
            const releases: z.infer<typeof ReleaseSchema>[] = [];
            let repoTruncated = false;
            let page = 1;

            while (releases.length < args.max) {
              const endpoint =
                `repos/${repo}/releases?per_page=${args.pageSize}&page=${page}`;
              const data = await ghApi(endpoint);
              const rows = Array.isArray(data) ? data : [];
              if (rows.length === 0) break;

              let pastWindow = false;
              for (const raw of rows) {
                const entry = raw as Record<string, unknown>;
                const publishedAt = String(entry.published_at ?? "");
                const publishedMs = Date.parse(publishedAt);
                if (Number.isFinite(publishedMs) && publishedMs < sinceMs) {
                  pastWindow = true;
                  break;
                }
                const tagName = String(entry.tag_name ?? "");
                releases.push({
                  tagName,
                  name: celEscape(String(entry.name ?? tagName)),
                  body: celEscape(String(entry.body ?? "")),
                  publishedAt,
                  isPrerelease: Boolean(entry.prerelease ?? false),
                  isDraft: Boolean(entry.draft ?? false),
                  commitSha: tagName.includes("-sha.")
                    ? tagName.split("-sha.")[1]
                    : "",
                  url: `https://github.com/${repo}/releases/tag/${tagName}`,
                });
                if (releases.length >= args.max) {
                  repoTruncated = true;
                  break;
                }
              }

              if (pastWindow || rows.length < args.pageSize) break;
              page += 1;
            }

            count += releases.length;
            truncated = truncated || repoTruncated;
            perRepo.push({
              repo,
              releases,
              count: releases.length,
              truncated: repoTruncated,
            });
          }

          const handle = await context.writeResource(
            "releasesFull",
            "releases",
            {
              repos: perRepo,
              count,
              truncated,
              since,
              fetchedAt: new Date().toISOString(),
              durationMs: Date.now() - startMs,
              collectedBy: EXTENSION_NAME,
            },
          );
          context.logger.info(
            "Collected {count} releases across {repos} repos",
            { count, repos: args.repos.length },
          );
          return { dataHandles: [handle] };
        },
      },
    },
    {
      collect_doc_changes: {
        description:
          "Find changed documentation files in a time window. Walks every commit in the range (not just ones with a doc-sounding message, since docs are often updated alongside code) and keeps only documentation paths.",
        arguments: z.object({
          repos: reposArg(),
          since: z.string().describe(
            "ISO-8601 lower bound on commit author date (inclusive).",
          ),
          until: z.string().optional().describe(
            "ISO-8601 upper bound on commit author date (inclusive). Defaults to now.",
          ),
          maxCommits: z.number().int().min(1).max(2000).default(500).describe(
            "Maximum commits to inspect per repository.",
          ),
          maxFiles: z.number().int().min(1).max(3000).default(1000).describe(
            "Maximum changed documentation files retained per repository.",
          ),
          extraPathPattern: z.string().default("").describe(
            "Optional extra regex; matching paths are treated as documentation.",
          ),
        }).strict(),
        execute: async (
          args: {
            repos: string[];
            since: string;
            until?: string;
            maxCommits: number;
            maxFiles: number;
            extraPathPattern: string;
          },
          context: Context,
        ) => {
          const startMs = Date.now();
          const until = args.until ?? new Date().toISOString();
          const since = args.since && args.since.trim()
            ? args.since
            : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
          const perRepo = [];
          let count = 0;
          let truncated = false;

          for (const repo of args.repos) {
            // Compare gives every file changed across the whole range in two
            // calls (commits + files), instead of one call per commit.
            const range = await fetchRangeDocs(
              repo,
              since,
              until,
              args.maxCommits,
              args.maxFiles,
              args.extraPathPattern,
            );
            const files = range.files;
            const repoTruncated = range.truncated;

            count += files.length;
            truncated = truncated || repoTruncated;
            perRepo.push({
              repo,
              files,
              commitsInspected: range.commitCount,
              truncated: repoTruncated,
            });
          }

          const handle = await context.writeResource("docChanges", "docs", {
            repos: perRepo,
            count,
            truncated,
            since,
            until,
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          });
          context.logger.info(
            "Collected {count} changed docs across {repos} repos",
            { count, repos: args.repos.length },
          );
          return { dataHandles: [handle] };
        },
      },
    },
  ],
};
