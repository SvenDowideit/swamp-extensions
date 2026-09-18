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

/** Message patterns that mark a commit as likely to touch documentation. */
const DOC_SUSPECT_RE = /(^|\W)(docs?|readme|manual|design|docs?\/|\.md\b)/i;

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

/** Fetch the changed files for one commit. */
async function fetchCommitFiles(
  repo: string,
  sha: string,
  maxFiles: number,
): Promise<{ files: z.infer<typeof ChangedFileSchema>[]; truncated: boolean }> {
  const data = await ghApi(`repos/${repo}/commits/${sha}`);
  const raw = data as Record<string, unknown>;
  const rows = Array.isArray(raw.files) ? raw.files : [];
  const files = rows.slice(0, maxFiles).map((f) => {
    const entry = f as Record<string, unknown>;
    return {
      repo,
      sha,
      shortSha: sha.slice(0, 8),
      filename: String(entry.filename ?? ""),
      status: String(entry.status ?? "modified"),
      additions: Number(entry.additions ?? 0),
      deletions: Number(entry.deletions ?? 0),
      changes: Number(entry.changes ?? 0),
    };
  });
  return { files, truncated: rows.length > files.length };
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
          const perRepo = [];
          let count = 0;
          let truncated = false;

          for (const repo of args.repos) {
            const result = await fetchCommits(
              repo,
              args.since,
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
            since: args.since,
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
          const since = args.since ??
            new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
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
          "Find changed documentation files in a time window. Filters commits to doc-suspect ones by message, then fetches their changed files — bounded per repository.",
        arguments: z.object({
          repos: reposArg(),
          since: z.string().describe(
            "ISO-8601 lower bound on commit author date (inclusive).",
          ),
          until: z.string().optional().describe(
            "ISO-8601 upper bound on commit author date (inclusive). Defaults to now.",
          ),
          maxCommits: z.number().int().min(1).max(200).default(40).describe(
            "Maximum doc-suspect commits to inspect per repository.",
          ),
          maxFiles: z.number().int().min(1).max(3000).default(500).describe(
            "Maximum changed files retained per repository.",
          ),
        }).strict(),
        execute: async (
          args: {
            repos: string[];
            since: string;
            until?: string;
            maxCommits: number;
            maxFiles: number;
          },
          context: Context,
        ) => {
          const startMs = Date.now();
          const until = args.until ?? new Date().toISOString();
          const perRepo = [];
          let count = 0;
          let truncated = false;

          for (const repo of args.repos) {
            const { commits } = await fetchCommits(
              repo,
              args.since,
              until,
              args.maxCommits * 5,
              100,
            );
            const suspects = commits
              .filter((c) => DOC_SUSPECT_RE.test(c.message))
              .slice(0, args.maxCommits);

            const files: z.infer<typeof ChangedFileSchema>[] = [];
            let repoTruncated = commits.length > suspects.length;
            for (const commit of suspects) {
              if (files.length >= args.maxFiles) {
                repoTruncated = true;
                break;
              }
              const result = await fetchCommitFiles(
                repo,
                commit.sha,
                args.maxFiles - files.length,
              );
              files.push(...result.files);
              if (result.truncated) repoTruncated = true;
            }

            count += files.length;
            truncated = truncated || repoTruncated;
            perRepo.push({
              repo,
              files,
              commitsInspected: suspects.length,
              truncated: repoTruncated,
            });
          }

          const handle = await context.writeResource("docChanges", "docs", {
            repos: perRepo,
            count,
            truncated,
            since: args.since,
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
