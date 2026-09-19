// SPDX-License-Identifier: Apache-2.0
/**
 * Vendored fork of `@webframp/swamp-club`, extended for Swamp Pulse.
 *
 * Upstream (Apache-2.0, Copyright 2026 Sean Escriva) is deliberately narrow:
 * it reads one Lab issue and posts an approved ripple. This fork keeps that
 * behaviour and adds the piece Swamp Pulse needs — listing and paginating the
 * Lab issue collection — while making authentication **optional** so the
 * public API can be read anonymously. See NOTICE for the full change list.
 *
 * @module
 */

import { z } from "npm:zod@4";

import { celEscape } from "./cel_text.ts";

const EXTENSION_NAME = "@svendowideit/swamp-club";

/**
 * Global configuration for the Lab adapter.
 *
 * `apiKey` is optional: the public Lab read endpoints work anonymously. When
 * set (via a vault reference) it is sent as a bearer token and lifts rate
 * limits.
 */
const GlobalArgs = z.object({
  host: z.string().min(1).default("swamp-club.com").describe(
    "Swamp Club host, with or without scheme (default swamp-club.com).",
  ),
  apiKey: z.string().min(1).optional().meta({ sensitive: true }).describe(
    "Optional Swamp Club API key, supplied from a vault. Anonymous when unset.",
  ),
  maxComments: z.number().int().min(1).max(100).default(50).describe(
    "Maximum number of recent comments to retain per issue.",
  ),
  requestTimeoutMs: z.number().int().min(1000).max(120000).default(15000)
    .describe("Per-request timeout in milliseconds."),
});

type GlobalArgs = z.infer<typeof GlobalArgs>;

const idempotencyKey = z.string().min(1).regex(
  /^[A-Za-z0-9._:-]+$/,
  "must contain only alphanumerics, dot, underscore, colon, or hyphen",
);

/** A single Lab issue with its bounded comment history. */
const Issue = z.object({
  number: z.number(),
  type: z.string(),
  status: z.string(),
  title: z.string(),
  body: z.string(),
  author: z.string(),
  comments: z.array(
    z.object({ author: z.string(), body: z.string(), createdAt: z.string() }),
  ),
  truncated: z.boolean(),
  fetchedAt: z.string(),
});

/** One row of the paginated Lab issue list. */
const IssueSummary = z.object({
  number: z.number(),
  type: z.string(),
  status: z.string(),
  title: z.string(),
  author: z.string(),
  source: z.string(),
  assignees: z.array(z.string()),
  blocked: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  url: z.string(),
});

/** A page-collected list of Lab issues for a time window. */
const IssueList = z.object({
  issues: z.array(IssueSummary),
  count: z.number(),
  total: z.number(),
  truncated: z.boolean(),
  filters: z.object({
    since: z.string(),
    until: z.string(),
    type: z.string(),
    status: z.string(),
    source: z.string(),
  }),
  fetchedAt: z.string(),
  durationMs: z.number(),
  collectedBy: z.string(),
});

type Context = {
  globalArgs: GlobalArgs;
  readResource: (name: string) => Promise<Record<string, unknown> | null>;
  writeResource: (
    spec: string,
    name: string,
    data: unknown,
  ) => Promise<{ name: string }>;
};

/** Build an absolute API URL from the configured host and a path. */
function url(host: string, path: string): string {
  return `https://${
    host.replace(/^https?:\/\//, "").replace(/\/+$/, "")
  }/api/v1${path}`;
}

/**
 * Issue an authenticated (or anonymous) request to the Lab API.
 *
 * Retries once on HTTP 429, honouring `Retry-After` when present. Throws a
 * descriptive error carrying the status and response body for every other
 * non-2xx response.
 */
async function request(
  ctx: Context,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json");
  if (ctx.globalArgs.apiKey) {
    headers.set("Authorization", `Bearer ${ctx.globalArgs.apiKey}`);
  }

  const send = () =>
    fetch(url(ctx.globalArgs.host, path), {
      ...init,
      headers,
      signal: AbortSignal.timeout(ctx.globalArgs.requestTimeoutMs),
    });

  let response: Response;
  try {
    response = await send();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Swamp Club request to ${path} failed: ${message}`,
    );
  }

  if (response.status === 429) {
    const retryAfter = Number(response.headers.get("retry-after") ?? "1");
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(retryAfter * 1000, 30_000)
      : 1000;
    await response.body?.cancel();
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    response = await send();
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Swamp Club API ${path} returned HTTP ${response.status}: ${body}`,
    );
  }
  return response;
}

/** Narrow Swamp Club Lab intake and approval-gated ripple adapter. */
export const model = {
  type: "@svendowideit/swamp-club",
  version: "2026.09.18.1",
  globalArguments: GlobalArgs,
  upgrades: [
    {
      toVersion: "2026.09.08.1",
      description: "Initial narrowly scoped Lab adapter (upstream lineage)",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.09.15.1",
      description: "No schema changes — dependency/license maintenance bump",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.09.18.1",
      description:
        "Fork: apiKey made optional for anonymous access; added search_lab_issues and a labIssues resource",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    labIssue: {
      description: "Bounded Lab issue context",
      schema: Issue,
      lifetime: "30m" as const,
      garbageCollection: 10,
    },
    labIssues: {
      description: "Paginated Lab issue list for a time window",
      schema: IssueList,
      lifetime: "1h" as const,
      garbageCollection: 10,
    },
    ripple: {
      description: "Posted preapproved Lab ripple evidence",
      schema: z.object({
        issueNumber: z.number(),
        commentId: z.string(),
        body: z.string(),
        postedAt: z.string(),
      }).strict(),
      lifetime: "30d" as const,
      garbageCollection: 20,
    },
  },
  methods: {
    get_lab_issue_context: {
      description:
        "Read one Lab issue and bounded activity without changing its lifecycle.",
      arguments: z.object({ issueNumber: z.number().int().positive() }),
      execute: async (
        { issueNumber }: { issueNumber: number },
        context: Context,
      ) => {
        const response = await request(context, `/lab/issues/${issueNumber}`);
        const data = await response.json() as {
          issue?: Record<string, unknown>;
        };
        const issue = data.issue;
        if (!issue) throw new Error(`Lab issue ${issueNumber} was not found`);
        const comments = Array.isArray(issue.comments)
          ? issue.comments.slice(-context.globalArgs.maxComments).map(
            (item) => {
              const c = item as Record<string, unknown>;
              return {
                author: String(c.authorUsername ?? c.author ?? "unknown"),
                body: String(c.body ?? ""),
                createdAt: String(c.createdAt ?? ""),
              };
            },
          )
          : [];
        const handle = await context.writeResource(
          "labIssue",
          String(issueNumber),
          {
            number: issueNumber,
            type: String(issue.type ?? "unknown"),
            status: String(issue.status ?? "unknown"),
            title: celEscape(String(issue.title ?? "")),
            body: celEscape(String(issue.body ?? "")),
            author: String(issue.authorUsername ?? "unknown"),
            comments,
            truncated: Array.isArray(issue.comments) &&
              issue.comments.length > comments.length,
            fetchedAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    search_lab_issues: {
      description:
        "List and paginate Lab issues, optionally filtered by a UTC time window, type, status or source. Works anonymously.",
      arguments: z.object({
        since: z.string().optional().describe(
          "ISO-8601 lower bound on createdAt (inclusive). Defaults to 30 days ago.",
        ),
        until: z.string().optional().describe(
          "ISO-8601 upper bound on updatedAt (inclusive). Defaults to now.",
        ),
        type: z.enum(["bug", "feature", "security", "all"]).default("all")
          .describe("Filter by issue type."),
        status: z
          .enum(["open", "triaged", "in_progress", "shipped", "closed", "all"])
          .default("all")
          .describe("Filter by issue status."),
        source: z.string().default("").describe(
          "Filter by source tag (exact match). Empty means no filter.",
        ),
        max: z.number().int().min(1).max(5000).default(2000).describe(
          "Maximum number of issues to collect across pages.",
        ),
        pageSize: z.number().int().min(1).max(200).default(200).describe(
          "Issues requested per page (the API caps this at 200).",
        ),
      }),
      execute: async (
        args: {
          since?: string;
          until?: string;
          type: string;
          status: string;
          source: string;
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
        const sinceMs = Date.parse(since);
        const untilMs = Date.parse(until);

        const collected: z.infer<typeof IssueSummary>[] = [];
        let total = 0;
        let offset = 0;
        let truncated = false;

        while (collected.length < args.max) {
          const params = new URLSearchParams({
            limit: String(args.pageSize),
            offset: String(offset),
          });
          if (args.type !== "all") params.set("type", args.type);
          if (args.status !== "all") params.set("status", args.status);

          const response = await request(
            context,
            `/lab/issues?${params.toString()}`,
          );
          const data = await response.json() as {
            issues?: Record<string, unknown>[];
            total?: number;
          };
          const page = Array.isArray(data.issues) ? data.issues : [];
          total = Number(data.total ?? page.length);

          if (page.length === 0) break;

          let reachedWindow = false;
          for (const raw of page) {
            const createdAt = String(raw.createdAt ?? "");
            const updatedAt = String(raw.updatedAt ?? createdAt);
            const createdMs = Date.parse(createdAt);
            if (Number.isFinite(createdMs) && createdMs < sinceMs) {
              reachedWindow = true;
              break;
            }
            const updatedMs = Date.parse(updatedAt);
            if (Number.isFinite(updatedMs) && updatedMs > untilMs) continue;
            if (args.source && String(raw.source ?? "") !== args.source) {
              continue;
            }
            collected.push({
              number: Number(raw.number ?? 0),
              type: String(raw.type ?? "unknown"),
              status: String(raw.status ?? "unknown"),
              title: celEscape(String(raw.title ?? "")),
              author: String(raw.authorUsername ?? "unknown"),
              source: String(raw.source ?? ""),
              assignees: Array.isArray(raw.assignees)
                ? raw.assignees.map((a) => {
                  const entry = a as Record<string, unknown>;
                  return String(entry.username ?? entry);
                })
                : [],
              blocked: Boolean(raw.blocked ?? false),
              createdAt,
              updatedAt,
              url: `https://${
                context.globalArgs.host.replace(/^https?:\/\//, "")
              }/lab/${raw.number}`,
            });
            if (collected.length >= args.max) {
              truncated = true;
              break;
            }
          }

          offset += page.length;
          if (reachedWindow || offset >= total) break;
        }

        if (collected.length < total && offset < total) truncated = true;

        const handle = await context.writeResource("labIssues", "issues", {
          issues: collected,
          count: collected.length,
          total,
          truncated,
          filters: {
            since,
            until,
            type: args.type,
            status: args.status,
            source: args.source,
          },
          fetchedAt: new Date().toISOString(),
          durationMs: Date.now() - startMs,
          collectedBy: EXTENSION_NAME,
        });
        return { dataHandles: [handle] };
      },
    },

    post_ripple: {
      description:
        "Post an explicitly approved, exact ripple and record its remote identifier.",
      arguments: z.object({
        issueNumber: z.number().int().positive(),
        body: z.string().min(1).max(20000),
        idempotencyKey,
      }),
      execute: async (
        { issueNumber, body, idempotencyKey }: {
          issueNumber: number;
          body: string;
          idempotencyKey: string;
        },
        context: Context,
      ) => {
        const resourceName = `${issueNumber}-${idempotencyKey}`;
        if (await context.readResource(resourceName)) {
          return { dataHandles: [{ name: resourceName }] };
        }
        const marked = `${body}\n\n<!-- triage:${idempotencyKey} -->`;
        const response = await request(
          context,
          `/lab/issues/${issueNumber}/comments`,
          { method: "POST", body: JSON.stringify({ body: marked }) },
        );
        const data = await response.json() as { comment?: { id?: string } };
        if (!data.comment?.id) {
          throw new Error("Swamp Club did not return a ripple identifier");
        }
        const handle = await context.writeResource("ripple", resourceName, {
          issueNumber,
          commentId: data.comment.id,
          body: marked,
          postedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
