/**
 * Unit tests for the vendored @svendowideit/swamp-club fork.
 *
 * Run: ~/.swamp/deno/deno test extensions/workflows/swamp-pulse/swamp_club_test.ts
 *
 * @module
 */

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  createModelTestContext,
  withMockedFetch,
} from "jsr:@swamp-club/swamp-testing@^0.3.0";
import { model } from "./swamp_club.ts";

const globalArgs = {
  host: "swamp-club.com",
  maxComments: 50,
  requestTimeoutMs: 15000,
};

/** Build a paginated issues response. */
function issuesResponse(
  issues: Record<string, unknown>[],
  total: number,
): Response {
  return new Response(JSON.stringify({ issues, total }), { status: 200 });
}

function issue(number: number, createdAt: string) {
  return {
    number,
    type: "bug",
    status: "open",
    title: `Issue ${number}`,
    authorUsername: "tester",
    source: "swamp",
    assignees: [],
    blocked: false,
    createdAt,
    updatedAt: createdAt,
  };
}

Deno.test("model is the vendored fork type", () => {
  assertEquals(model.type, "@svendowideit/swamp-club");
  assert("search_lab_issues" in model.methods);
  assert("get_lab_issue_context" in model.methods);
  assert("labIssues" in model.resources);
});

Deno.test("search_lab_issues works anonymously (no Authorization header)", async () => {
  let sawAuth = true;
  await withMockedFetch((req) => {
    sawAuth = req.headers.has("authorization");
    return issuesResponse([issue(1, "2026-09-17T00:00:00Z")], 1);
  }, async () => {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs,
      methodName: "search_lab_issues",
    });
    await model.methods.search_lab_issues.execute(
      {
        since: "2026-09-01T00:00:00Z",
        until: "2026-09-18T00:00:00Z",
        type: "all",
        status: "all",
        source: "",
        max: 100,
        pageSize: 200,
      },
      // deno-lint-ignore no-explicit-any
      context as any,
    );
    assertEquals(sawAuth, false, "anonymous request sent an auth header");
    const resource = getWrittenResources().find(
      (r) => r.specName === "labIssues",
    );
    assert(resource);
    const data = resource.data as {
      count: number;
      issues: { number: number }[];
    };
    assertEquals(data.count, 1);
    assertEquals(data.issues[0].number, 1);
  });
});

Deno.test("search_lab_issues sends bearer auth when apiKey is set", async () => {
  let auth = "";
  await withMockedFetch((req) => {
    auth = req.headers.get("authorization") ?? "";
    return issuesResponse([], 0);
  }, async () => {
    const { context } = createModelTestContext({
      globalArgs: { ...globalArgs, apiKey: "secret-key" },
      methodName: "search_lab_issues",
    });
    await model.methods.search_lab_issues.execute(
      { type: "all", status: "all", source: "", max: 10, pageSize: 200 },
      // deno-lint-ignore no-explicit-any
      context as any,
    );
    assertEquals(auth, "Bearer secret-key");
  });
});

Deno.test("search_lab_issues stops at the since boundary", async () => {
  let calls = 0;
  await withMockedFetch(() => {
    calls += 1;
    // Page 1 is inside the window; page 2 is entirely before it.
    if (calls === 1) {
      return issuesResponse(
        [issue(10, "2026-09-17T10:00:00Z"), issue(9, "2026-09-17T09:00:00Z")],
        4,
      );
    }
    return issuesResponse(
      [issue(1, "2026-08-01T00:00:00Z"), issue(0, "2026-07-01T00:00:00Z")],
      4,
    );
  }, async () => {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs,
      methodName: "search_lab_issues",
    });
    await model.methods.search_lab_issues.execute(
      {
        since: "2026-09-01T00:00:00Z",
        until: "2026-09-18T00:00:00Z",
        type: "all",
        status: "all",
        source: "",
        max: 100,
        pageSize: 2,
      },
      // deno-lint-ignore no-explicit-any
      context as any,
    );
    const data = getWrittenResources()[0].data as { count: number };
    assertEquals(data.count, 2, "collected issues past the window boundary");
    assertEquals(calls, 2);
  });
});

Deno.test("search_lab_issues marks truncation when capped by max", async () => {
  await withMockedFetch(() =>
    issuesResponse(
      [issue(5, "2026-09-17T05:00:00Z"), issue(4, "2026-09-17T04:00:00Z")],
      100,
    ), async () => {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs,
      methodName: "search_lab_issues",
    });
    await model.methods.search_lab_issues.execute(
      {
        since: "2026-09-01T00:00:00Z",
        until: "2026-09-18T00:00:00Z",
        type: "all",
        status: "all",
        source: "",
        max: 2,
        pageSize: 200,
      },
      // deno-lint-ignore no-explicit-any
      context as any,
    );
    const data = getWrittenResources()[0].data as { truncated: boolean };
    assertEquals(data.truncated, true);
  });
});

Deno.test("search_lab_issues surfaces HTTP errors with status and body", async () => {
  await withMockedFetch(
    () => new Response("boom", { status: 500 }),
    async () => {
      const { context } = createModelTestContext({
        globalArgs,
        methodName: "search_lab_issues",
      });
      let message = "";
      try {
        await model.methods.search_lab_issues.execute(
          { type: "all", status: "all", source: "", max: 10, pageSize: 200 },
          // deno-lint-ignore no-explicit-any
          context as any,
        );
      } catch (err) {
        message = String(err);
      }
      assertStringIncludes(message, "HTTP 500");
      assertStringIncludes(message, "boom");
    },
  );
});

Deno.test("search_lab_issues normalises assignees and builds lab URLs", async () => {
  await withMockedFetch(() =>
    issuesResponse(
      [{
        ...issue(7, "2026-09-17T00:00:00Z"),
        assignees: [{ username: "sven" }, { username: "stack72" }],
      }],
      1,
    ), async () => {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs,
      methodName: "search_lab_issues",
    });
    await model.methods.search_lab_issues.execute(
      {
        since: "2026-09-01T00:00:00Z",
        until: "2026-09-18T00:00:00Z",
        type: "all",
        status: "all",
        source: "",
        max: 10,
        pageSize: 200,
      },
      // deno-lint-ignore no-explicit-any
      context as any,
    );
    const data = getWrittenResources()[0].data as {
      issues: { assignees: string[]; url: string }[];
    };
    assertEquals(data.issues[0].assignees, ["sven", "stack72"]);
    assertStringIncludes(data.issues[0].url, "/lab/7");
  });
});
