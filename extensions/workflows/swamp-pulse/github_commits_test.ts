/**
 * Unit tests for the @webframp/github extension (github_commits.ts).
 *
 * Run: ~/.swamp/deno/deno test extensions/workflows/swamp-pulse/github_commits_test.ts
 *
 * @module
 */

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  createModelTestContext,
  withMockedCommand,
} from "jsr:@swamp-club/swamp-testing@^0.3.0";
import { extension } from "./github_commits.ts";

/** Return a mocked `gh api` handler that dispatches on the endpoint. */
function ghHandler(
  routes: Array<
    { match: string; json: unknown; code?: number; stderr?: string }
  >,
) {
  return (_cmd: string, args: string[]) => {
    const endpoint = args.join(" ");
    for (const route of routes) {
      if (endpoint.includes(route.match)) {
        return {
          code: route.code ?? 0,
          stdout: route.code && route.code !== 0
            ? ""
            : JSON.stringify(route.json),
          stderr: route.stderr ?? "",
        };
      }
    }
    return { code: 1, stdout: "", stderr: `no mock route for: ${endpoint}` };
  };
}

const method = (name: string) => {
  for (const record of extension.methods) {
    if (name in record) {
      // deno-lint-ignore no-explicit-any
      return (record as any)[name];
    }
  }
  throw new Error(`method ${name} not found`);
};

Deno.test("extension targets @webframp/github and avoids colliding names", () => {
  assertEquals(extension.type, "@webframp/github");
  assert("commits" in extension.resources);
  assert("docChanges" in extension.resources);
  assert("releasesFull" in extension.resources);
  const names = extension.methods.flatMap((r) => Object.keys(r));
  for (
    const name of ["collect_commits", "collect_releases", "collect_doc_changes"]
  ) {
    assert(names.includes(name), `missing ${name}`);
  }
  // Must not shadow the upstream list_releases (collisions are silently skipped).
  assert(!names.includes("list_releases"));
});

Deno.test("collect_commits fans out over multiple repos", async () => {
  const routes = [
    {
      match: "repos/a/one/commits",
      json: [{
        sha: "1111111111111111111111111111111111111111",
        commit: {
          message: "feat: one",
          author: { name: "A", date: "2026-09-17T00:00:00Z" },
        },
      }],
    },
    {
      match: "repos/b/two/commits",
      json: [{
        sha: "2222222222222222222222222222222222222222",
        commit: {
          message: "fix: two",
          author: { name: "B", date: "2026-09-17T01:00:00Z" },
        },
      }],
    },
  ];
  await withMockedCommand(ghHandler(routes), async () => {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: {},
      methodName: "collect_commits",
    });
    await method("collect_commits").execute(
      {
        repos: ["a/one", "b/two"],
        since: "2026-09-16T00:00:00Z",
        until: "2026-09-18T00:00:00Z",
        max: 100,
        pageSize: 100,
      },
      // deno-lint-ignore no-explicit-any
      context as any,
    );
    const data = getWrittenResources()[0].data as {
      count: number;
      repos: { repo: string; count: number }[];
    };
    assertEquals(data.count, 2);
    assertEquals(data.repos.map((r) => r.repo), ["a/one", "b/two"]);
  });
});

Deno.test("collect_commits normalises fields and short SHA", async () => {
  await withMockedCommand(
    ghHandler([
      {
        match: "repos/a/one/commits",
        json: [{
          sha: "abcdef0123456789abcdef0123456789abcdef01",
          commit: {
            message: "fix(x): line one\n\nbody line",
            author: { name: "Sven", date: "2026-09-17T00:00:00Z" },
          },
        }],
      },
    ]),
    async () => {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: {},
        methodName: "collect_commits",
      });
      await method("collect_commits").execute(
        {
          repos: ["a/one"],
          since: "2026-09-16T00:00:00Z",
          until: "2026-09-18T00:00:00Z",
          max: 100,
          pageSize: 100,
        },
        // deno-lint-ignore no-explicit-any
        context as any,
      );
      const commit = (getWrittenResources()[0].data as {
        repos: { commits: Record<string, unknown>[] }[];
      }).repos[0].commits[0];
      assertEquals(commit.message, "fix(x): line one");
      assertEquals(commit.shortSha, "abcdef01");
      assertEquals(commit.author, "Sven");
      assertStringIncludes(String(commit.url), "/commit/abcdef01");
    },
  );
});

Deno.test("collect_commits surfaces gh failures descriptively", async () => {
  await withMockedCommand(
    ghHandler([
      { match: "commits", json: {}, code: 1, stderr: "HTTP 403: rate limit" },
    ]),
    async () => {
      const { context } = createModelTestContext({
        globalArgs: {},
        methodName: "collect_commits",
      });
      let message = "";
      try {
        await method("collect_commits").execute(
          {
            repos: ["a/one"],
            since: "2026-09-16T00:00:00Z",
            max: 10,
            pageSize: 100,
          },
          // deno-lint-ignore no-explicit-any
          context as any,
        );
      } catch (err) {
        message = String(err);
      }
      assertStringIncludes(message, "gh api");
      assertStringIncludes(message, "rate limit");
    },
  );
});

Deno.test("collect_releases parses bodies, prerelease flags and tag SHA", async () => {
  await withMockedCommand(
    ghHandler([
      {
        match: "/releases",
        json: [
          {
            tag_name: "v20260917.233703.0-sha.a3e60933",
            name: "swamp build",
            body: "* fix(workers): reap (swamp-club#2192) (#2509)",
            published_at: "2026-09-17T23:38:48Z",
            prerelease: false,
            draft: false,
          },
        ],
      },
    ]),
    async () => {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: {},
        methodName: "collect_releases",
      });
      await method("collect_releases").execute(
        {
          repos: ["swamp-club/swamp"],
          since: "2026-09-01T00:00:00Z",
          max: 100,
          pageSize: 100,
        },
        // deno-lint-ignore no-explicit-any
        context as any,
      );
      const release = (getWrittenResources()[0].data as {
        repos: { releases: Record<string, unknown>[] }[];
      }).repos[0].releases[0];
      assertEquals(release.commitSha, "a3e60933");
      assertEquals(release.isPrerelease, false);
      assertStringIncludes(String(release.body), "swamp-club#2192");
    },
  );
});

Deno.test("collect_releases stops at the since boundary", async () => {
  let call = 0;
  await withMockedCommand((_cmd, args) => {
    call += 1;
    const endpoint = args.join(" ");
    if (!endpoint.includes("page=2")) {
      return {
        code: 0,
        stdout: JSON.stringify([
          {
            tag_name: "v1-sha.aaa",
            name: "new",
            body: "",
            published_at: "2026-09-17T00:00:00Z",
            prerelease: false,
            draft: false,
          },
        ]),
        stderr: "",
      };
    }
    return {
      code: 0,
      stdout: JSON.stringify([
        {
          tag_name: "v0-sha.bbb",
          name: "old",
          body: "",
          published_at: "2026-08-01T00:00:00Z",
          prerelease: false,
          draft: false,
        },
      ]),
      stderr: "",
    };
  }, async () => {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: {},
      methodName: "collect_releases",
    });
    await method("collect_releases").execute(
      {
        repos: ["swamp-club/swamp"],
        since: "2026-09-01T00:00:00Z",
        max: 100,
        pageSize: 1,
      },
      // deno-lint-ignore no-explicit-any
      context as any,
    );
    const data = getWrittenResources()[0].data as {
      repos: { releases: unknown[] }[];
    };
    assertEquals(data.repos[0].releases.length, 1);
    assertEquals(call, 2);
  });
});

Deno.test("collect_doc_changes finds docs changed by a non-doc commit", async () => {
  // Regression: docs are usually updated alongside code, so a commit whose
  // message says nothing about docs must still contribute its .md files.
  const routes: Array<{ match: string; json: unknown }> = [];
  await withMockedCommand((_cmd, args) => {
    const endpoint = args.join(" ");
    if (endpoint.includes("compare/")) {
      return {
        code: 0,
        stdout: JSON.stringify({
          total_commits: 1,
          files: [
            {
              filename: "src/cli/mod.ts",
              status: "modified",
              additions: 9,
              deletions: 1,
              changes: 10,
            },
            {
              filename: "design/enablers/datastores.md",
              status: "modified",
              additions: 3,
              deletions: 0,
              changes: 3,
            },
            {
              filename: "README.md",
              status: "modified",
              additions: 1,
              deletions: 0,
              changes: 1,
            },
          ],
        }),
        stderr: "",
      };
    }
    if (endpoint.includes("path=")) {
      // commits-by-path attribution for each doc file
      return {
        code: 0,
        stdout: JSON.stringify([{
          sha: "1111111111111111111111111111111111111111",
        }]),
        stderr: "",
      };
    }
    if (endpoint.includes("/commits/")) {
      // parent of the oldest commit
      return {
        code: 0,
        stdout: JSON.stringify({
          parents: [{ sha: "0000000000000000000000000000000000000000" }],
        }),
        stderr: "",
      };
    }
    if (endpoint.includes("per_page")) {
      return {
        code: 0,
        stdout: JSON.stringify([{
          sha: "1111111111111111111111111111111111111111",
          commit: {
            message: "fix(workers): reap stale worker records (#2509)",
            author: { name: "A", date: "2026-09-17T00:00:00Z" },
          },
        }]),
        stderr: "",
      };
    }
    return { code: 0, stdout: JSON.stringify([]), stderr: "" };
  }, async () => {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: {},
      methodName: "collect_doc_changes",
    });
    await method("collect_doc_changes").execute(
      {
        repos: ["a/one"],
        since: "2026-09-16T00:00:00Z",
        until: "2026-09-18T00:00:00Z",
        maxCommits: 10,
        maxFiles: 100,
        extraPathPattern: "",
      },
      // deno-lint-ignore no-explicit-any
      context as any,
    );
    const data = getWrittenResources()[0].data as {
      count: number;
      repos: { files: { filename: string; sha: string }[] }[];
    };
    const names = data.repos[0].files.map((f) => f.filename).sort();
    assertEquals(names, ["README.md", "design/enablers/datastores.md"]);
    // src/cli/mod.ts is not documentation.
    assert(!names.some((n) => n.endsWith(".ts")));
    // Files are attributed to the commit that touched them.
    assertEquals(
      data.repos[0].files[0].sha,
      "1111111111111111111111111111111111111111",
    );
    routes.length;
  });
});

Deno.test("collect_doc_changes marks truncation when compare reports more commits", async () => {
  await withMockedCommand((_cmd, args) => {
    const endpoint = args.join(" ");
    if (endpoint.includes("compare/")) {
      return {
        code: 0,
        stdout: JSON.stringify({
          total_commits: 99,
          files: [{
            filename: "README.md",
            status: "modified",
            additions: 1,
            deletions: 0,
            changes: 1,
          }],
        }),
        stderr: "",
      };
    }
    if (endpoint.includes("path=")) {
      return {
        code: 0,
        stdout: JSON.stringify([{
          sha: "1111111111111111111111111111111111111111",
        }]),
        stderr: "",
      };
    }
    if (endpoint.includes("/commits/")) {
      return {
        code: 0,
        stdout: JSON.stringify({
          parents: [{ sha: "0000000000000000000000000000000000000000" }],
        }),
        stderr: "",
      };
    }
    if (endpoint.includes("per_page")) {
      return {
        code: 0,
        stdout: JSON.stringify([{
          sha: "1111111111111111111111111111111111111111",
          commit: {
            message: "fix: x",
            author: { name: "A", date: "2026-09-17T00:00:00Z" },
          },
        }]),
        stderr: "",
      };
    }
    return { code: 0, stdout: JSON.stringify([]), stderr: "" };
  }, async () => {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: {},
      methodName: "collect_doc_changes",
    });
    await method("collect_doc_changes").execute(
      {
        repos: ["a/one"],
        since: "2026-09-16T00:00:00Z",
        until: "2026-09-18T00:00:00Z",
        maxCommits: 1,
        maxFiles: 100,
        extraPathPattern: "",
      },
      // deno-lint-ignore no-explicit-any
      context as any,
    );
    const data = getWrittenResources()[0].data as { truncated: boolean };
    assertEquals(data.truncated, true);
  });
});

Deno.test("a missing gh binary produces an actionable error", async () => {
  await withMockedCommand(() => {
    throw new Error("spawn gh ENOENT");
  }, async () => {
    const { context } = createModelTestContext({
      globalArgs: {},
      methodName: "collect_commits",
    });
    let message = "";
    try {
      await method("collect_commits").execute(
        {
          repos: ["a/one"],
          since: "2026-09-16T00:00:00Z",
          max: 10,
          pageSize: 100,
        },
        // deno-lint-ignore no-explicit-any
        context as any,
      );
    } catch (err) {
      message = String(err);
    }
    assertStringIncludes(message, "gh CLI installed");
  });
});
