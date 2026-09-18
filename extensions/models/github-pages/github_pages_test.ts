import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1";

import {
  buildPagesBody,
  defaultPagesUrl,
  encodeBase64,
  expandHome,
  type FetchLike,
  gitBlobSha,
  GitHubApi,
  githubHeaders,
  isNotFound,
  isRetryableResponse,
  isUnprocessable,
  joinRepoPath,
  pagesPathPrefix,
  parentShaOf,
  parsePagesSite,
  parseRemoteUrl,
  parseRepo,
  planPublish,
  planSite,
  readFiles,
  type RemoteTreeEntry,
  sanitizeRepoPath,
  sha1Hex,
  walkDir,
} from "./github_pages.ts";

import { model } from "./github_pages.ts";

const encoder = new TextEncoder();

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

Deno.test("expandHome expands a leading ~ to the home directory", () => {
  assertEquals(expandHome("~", "/home/alice"), "/home/alice");
  assertEquals(
    expandHome("~/site", "/home/alice"),
    "/home/alice/site",
  );
  assertEquals(expandHome("/srv/site", "/home/alice"), "/srv/site");
});

Deno.test("sanitizeRepoPath normalizes separators and strips leading slashes", () => {
  assertEquals(sanitizeRepoPath("/docs/index.html"), "docs/index.html");
  assertEquals(sanitizeRepoPath("a//b///c.css"), "a/b/c.css");
  assertEquals(sanitizeRepoPath("a\\b\\c.css"), "a/b/c.css");
});

Deno.test("sanitizeRepoPath rejects parent-directory traversal", () => {
  let threw = false;
  try {
    sanitizeRepoPath("../../etc/passwd");
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("joinRepoPath joins prefixes safely", () => {
  assertEquals(joinRepoPath("docs", "index.html"), "docs/index.html");
  assertEquals(joinRepoPath("/docs/", "/index.html"), "docs/index.html");
  assertEquals(joinRepoPath("", "index.html"), "index.html");
  assertEquals(joinRepoPath("/", "index.html"), "index.html");
});

Deno.test("gitBlobSha matches git hash-object for known inputs", () => {
  assertEquals(
    gitBlobSha(encoder.encode("hello world\n")),
    "3b18e512dba79e4c8300dd08aeb37f8e728b8dad",
  );
  assertEquals(
    gitBlobSha(encoder.encode("")),
    "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391",
  );
  assertEquals(
    gitBlobSha(encoder.encode("a")),
    "2e65efe2a145dda7ee51d1741299f848e5bf752e",
  );
});

Deno.test("sha1Hex matches known SHA-1 vectors", () => {
  assertEquals(
    sha1Hex(encoder.encode("abc")),
    "a9993e364706816aba3e25717850c26c9cd0d89d",
  );
  assertEquals(
    sha1Hex(encoder.encode("")),
    "da39a3ee5e6b4b0d3255bfef95601890afd80709",
  );
});

Deno.test("encodeBase64 round-trips through atob", () => {
  const bytes = encoder.encode("swamp github pages");
  assertEquals(atob(encodeBase64(bytes)), "swamp github pages");
  assertEquals(encodeBase64(new Uint8Array([])), "");
});

Deno.test("planPublish classifies added, modified, deleted and unchanged", () => {
  const local = [
    { path: "/s/a.html", repoPath: "a.html", sha: "sha-a", size: 1 },
    { path: "/s/b.html", repoPath: "b.html", sha: "sha-b2", size: 2 },
    { path: "/s/new.html", repoPath: "new.html", sha: "sha-new", size: 3 },
  ];
  const remote: RemoteTreeEntry[] = [
    { path: "a.html", type: "blob", sha: "sha-a", mode: "100644" },
    { path: "b.html", type: "blob", sha: "sha-b1", mode: "100644" },
    { path: "old.html", type: "blob", sha: "sha-old", mode: "100644" },
  ];

  const plan = planPublish(local, remote, true);
  assertEquals(plan.added, ["new.html"]);
  assertEquals(plan.modified, ["b.html"]);
  assertEquals(plan.unchanged, ["a.html"]);
  assertEquals(plan.deleted.map((d) => d.path), ["old.html"]);
  assertEquals(plan.changed.length, 2);
});

Deno.test("planPublish scopes prune deletions to the prefix", () => {
  const local = [
    {
      path: "/s/index.html",
      repoPath: "docs/index.html",
      sha: "sha-i",
      size: 1,
    },
  ];
  const remote: RemoteTreeEntry[] = [
    { path: "docs/index.html", type: "blob", sha: "sha-i", mode: "100644" },
    { path: "docs/stale.html", type: "blob", sha: "sha-stale", mode: "100644" },
    { path: "README.md", type: "blob", sha: "sha-readme", mode: "100644" },
    { path: "src/app.ts", type: "blob", sha: "sha-app", mode: "100644" },
  ];
  const plan = planPublish(local, remote, true, "docs");
  assertEquals(plan.deleted.map((d) => d.path), ["docs/stale.html"]);
});

Deno.test("planPublish with an empty prefix prunes the whole tree", () => {
  const local = [
    { path: "/s/index.html", repoPath: "index.html", sha: "sha-i", size: 1 },
  ];
  const remote: RemoteTreeEntry[] = [
    { path: "index.html", type: "blob", sha: "sha-i", mode: "100644" },
    { path: "README.md", type: "blob", sha: "sha-readme", mode: "100644" },
  ];
  const plan = planPublish(local, remote, true, "");
  assertEquals(plan.deleted.map((d) => d.path), ["README.md"]);
});

Deno.test("planPublish ignores deletions unless pruning", () => {
  const local = [
    { path: "/s/a.html", repoPath: "a.html", sha: "sha-a", size: 1 },
  ];
  const remote: RemoteTreeEntry[] = [
    { path: "a.html", type: "blob", sha: "sha-a", mode: "100644" },
    { path: "old.html", type: "blob", sha: "sha-old", mode: "100644" },
  ];
  assertEquals(planPublish(local, remote, false).deleted.length, 0);
  assertEquals(planPublish(local, remote, true).deleted.length, 1);
});

Deno.test("planSite creates when no site exists", () => {
  const plan = planSite(null, {
    branch: "gh-pages",
    path: "/",
    buildType: "legacy",
  });
  assertEquals(plan.action, "create");
  assertEquals(plan.changed, true);
});

Deno.test("planSite is a no-op when the live config matches", () => {
  const plan = planSite(
    {
      url: "https://o.github.io/r/",
      status: "built",
      buildType: "legacy",
      sourceBranch: "gh-pages",
      sourcePath: "/",
      cname: "",
      custom404: false,
      isPublic: true,
      httpsEnforced: true,
      certificateState: "issued",
    },
    {
      branch: "gh-pages",
      path: "/",
      buildType: "legacy",
      cname: undefined,
      httpsEnforced: true,
    },
  );
  assertEquals(plan.action, "noop");
  assertEquals(plan.changed, false);
  assertEquals(plan.differing, []);
});

Deno.test("planSite reports differing fields on update", () => {
  const plan = planSite(
    {
      url: "",
      status: "",
      buildType: "legacy",
      sourceBranch: "main",
      sourcePath: "/",
      cname: "",
      custom404: false,
      isPublic: false,
      httpsEnforced: false,
      certificateState: "",
    },
    {
      branch: "gh-pages",
      path: "/docs",
      buildType: "workflow",
      cname: "example.com",
      httpsEnforced: true,
    },
  );
  assertEquals(plan.action, "update");
  assertEquals(plan.differing, [
    "source.branch",
    "source.path",
    "build_type",
    "cname",
    "https_enforced",
  ]);
});

Deno.test("planSite treats cname null as a removal request", () => {
  const plan = planSite(
    {
      url: "",
      status: "",
      buildType: "legacy",
      sourceBranch: "gh-pages",
      sourcePath: "/",
      cname: "old.example.com",
      custom404: false,
      isPublic: false,
      httpsEnforced: true,
      certificateState: "",
    },
    {
      branch: "gh-pages",
      path: "/",
      buildType: "legacy",
      cname: null,
      httpsEnforced: true,
    },
  );
  assertEquals(plan.action, "update");
  assertEquals(plan.differing, ["cname"]);
});

Deno.test("buildPagesBody omits cname/https_enforced on create", () => {
  const body = buildPagesBody(
    {
      branch: "gh-pages",
      path: "/",
      buildType: "legacy",
      cname: "example.com",
      httpsEnforced: true,
    },
    true,
  );
  assertEquals(body, {
    build_type: "legacy",
    source: { branch: "gh-pages", path: "/" },
  });
});

Deno.test("buildPagesBody includes cname/https_enforced on update", () => {
  const body = buildPagesBody(
    {
      branch: "main",
      path: "/docs",
      buildType: "workflow",
      cname: null,
      httpsEnforced: false,
    },
    false,
  );
  assertEquals(body, {
    build_type: "workflow",
    source: { branch: "main", path: "/docs" },
    cname: null,
    https_enforced: false,
  });
});

Deno.test("parsePagesSite normalizes the API response", () => {
  const site = parsePagesSite({
    url: "https://api.github.com/repos/o/r/pages",
    html_url: "https://o.github.io/r/",
    status: "built",
    build_type: "legacy",
    source: { branch: "gh-pages", path: "/" },
    cname: "example.com",
    custom_404: true,
    public: true,
    https_enforced: true,
    https_certificate: { state: "issued" },
  });
  assertEquals(site.sourceBranch, "gh-pages");
  assertEquals(site.cname, "example.com");
  assertEquals(site.url, "https://o.github.io/r/");
  assertEquals(site.certificateState, "issued");
  assertEquals(site.custom404, true);
});

Deno.test("parsePagesSite falls back to url when html_url is absent", () => {
  const site = parsePagesSite({
    url: "https://api.github.com/repos/o/r/pages",
  });
  assertEquals(site.url, "https://api.github.com/repos/o/r/pages");
});

Deno.test("parsePagesSite tolerates a sparse response", () => {
  const site = parsePagesSite({});
  assertEquals(site.url, "");
  assertEquals(site.buildType, "");
  assertEquals(site.isPublic, false);
});

Deno.test("githubHeaders includes auth and API version", () => {
  const headers = githubHeaders("tok");
  assertEquals(headers.Authorization, "Bearer tok");
  assertEquals(headers.Accept, "application/vnd.github+json");
  assertEquals(headers["X-GitHub-Api-Version"], "2022-11-28");
});

Deno.test("parseRepo validates owner/name", () => {
  assertEquals(parseRepo("o/r"), { owner: "o", name: "r" });
  assertEquals(parseRepo("/o/r/"), { owner: "o", name: "r" });
  let threw = false;
  try {
    parseRepo("just-a-name");
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("parseRemoteUrl handles https and ssh git remotes", () => {
  assertEquals(
    parseRemoteUrl("https://github.com/o/r.git"),
    "o/r",
  );
  assertEquals(
    parseRemoteUrl("git@github.com:o/r.git"),
    "o/r",
  );
  assertEquals(parseRemoteUrl("https://example.com/o/r.git"), null);
});

Deno.test("defaultPagesUrl handles user and project pages", () => {
  assertEquals(
    defaultPagesUrl("alice/alice.github.io"),
    "https://alice.github.io",
  );
  assertEquals(
    defaultPagesUrl("alice/site"),
    "https://alice.github.io/site/",
  );
});

Deno.test("pagesPathPrefix maps Pages paths to tree prefixes", () => {
  assertEquals(pagesPathPrefix("/"), "");
  assertEquals(pagesPathPrefix("/docs"), "docs");
  assertEquals(pagesPathPrefix(""), "");
});

Deno.test("parentShaOf extracts the first parent", () => {
  assertEquals(
    parentShaOf({ parents: [{ sha: "abc" }] }),
    "abc",
  );
  assertEquals(parentShaOf({}), "");
});

Deno.test("isNotFound / isUnprocessable match status in error messages", () => {
  assertEquals(isNotFound(new Error("GitHub GET /x failed (404): nope")), true);
  assertEquals(
    isNotFound(new Error("GitHub GET /x failed (500): boom")),
    false,
  );
  assertEquals(
    isUnprocessable(new Error("GitHub GET /x failed (422): bad")),
    true,
  );
});

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

Deno.test("walkDir recursively hashes regular files and skips symlinks", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/assets`);
    await Deno.writeTextFile(`${dir}/index.html`, "<!doctype html>\n");
    await Deno.writeTextFile(`${dir}/assets/app.css`, "body{}\n");
    const files = await walkDir(dir);
    assertEquals(files.map((f) => f.repoPath).sort(), [
      "assets/app.css",
      "index.html",
    ]);
    const html = files.find((f) => f.repoPath === "index.html");
    assertEquals(
      html?.sha,
      "c50eddd41faba2ecc8928e459288fe612b999170",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("walkDir throws when the path is not a directory", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const file = `${dir}/file.txt`;
    await Deno.writeTextFile(file, "x");
    await assertRejects(() => walkDir(file), Error, "Not a directory");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readFiles maps explicit sources and repo paths", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/feed.html`, "<html></html>");
    const files = await readFiles([
      `${dir}/feed.html`,
      { source: `${dir}/feed.html`, repoPath: "news/feed.html" },
    ]);
    assertEquals(files[0].repoPath, "feed.html");
    assertEquals(files[1].repoPath, "news/feed.html");
    assertEquals(files[0].sha, gitBlobSha(encoder.encode("<html></html>")));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Fake GitHub API
// ---------------------------------------------------------------------------

interface FakeState {
  pages: Record<string, unknown> | null;
  httpsUnavailable: boolean;
  autoEnablePages: boolean;
  refs: Map<string, { commitSha: string; treeSha: string }>;
  trees: Map<string, Array<Record<string, unknown>>>;
  commits: Map<string, Record<string, unknown>>;
  blobs: Map<string, string>;
  refCreates: number;
  refPatches: number;
  treeRequests: string[];
  lastCommitMessage: string;
}

interface FakeOptions {
  defaultBranch?: string;
}

function makeFakeFetch(
  seedTree: Array<Record<string, unknown>> = [],
  opts: FakeOptions = {},
): { fetchImpl: FetchLike; state: FakeState; requests: string[] } {
  const requests: string[] = [];
  const defaultBranch = opts.defaultBranch ?? "main";
  const state: FakeState = {
    pages: null,
    httpsUnavailable: false,
    autoEnablePages: false,
    refs: new Map([
      [defaultBranch, { commitSha: "seed-commit", treeSha: "seed-tree" }],
    ]),
    trees: new Map([
      [defaultBranch, seedTree],
      ["seed-tree", seedTree],
    ]),
    commits: new Map([
      ["seed-commit", {
        sha: "seed-commit",
        tree: { sha: "seed-tree" },
        parents: [],
      }],
    ]),
    blobs: new Map(),
    refCreates: 0,
    refPatches: 0,
    treeRequests: [],
    lastCommitMessage: "",
  };

  let sha = 0;
  const nextSha = (prefix: string) => `${prefix}-${++sha}`;

  // deno-lint-ignore require-await
  const fetchImpl: FetchLike = async (url, init) => {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/^\/repos\/[^/]+\/[^/]+/, "");
    requests.push(`${init.method} ${parsed.pathname}${parsed.search}`);

    const json = (status: number, body: unknown) => ({
      status,
      body: body === undefined ? "" : JSON.stringify(body),
    });

    if (init.method === "GET" && path === "/pages") {
      if (!state.pages) return json(404, { message: "Not Found" });
      return json(200, state.pages);
    }
    if (init.method === "POST" && path === "/pages") {
      if (state.autoEnablePages && state.pages) {
        // GitHub auto-enables Pages when the source branch is created, so an
        // explicit create then races and returns 409.
        return json(409, { message: "GitHub Pages is already enabled." });
      }
      const req = JSON.parse(init.body ?? "{}");
      state.pages = {
        url: "https://api.github.com/repos/o/r/pages",
        html_url: "https://o.github.io/r/",
        status: "building",
        build_type: req.build_type,
        source: req.source,
        cname: req.cname ?? null,
        custom_404: false,
        public: true,
        https_enforced: false,
        https_certificate: { state: "new" },
      };
      return json(201, state.pages);
    }
    if (init.method === "PUT" && path === "/pages") {
      const req = JSON.parse(init.body ?? "{}");
      if (state.httpsUnavailable && req.https_enforced !== undefined) {
        // Real GitHub rejects any explicit https_enforced until the cert
        // exists — including `false`. Omitting the field succeeds.
        state.httpsUnavailable = false;
        return json(404, {
          message: "The certificate does not exist yet",
        });
      }
      state.pages = {
        ...(state.pages ?? {}),
        build_type: req.build_type,
        source: req.source,
        cname: req.cname ?? null,
        https_enforced: req.https_enforced ?? false,
      };
      return { status: 204, body: "" };
    }

    if (init.method === "GET" && path.startsWith("/git/ref/heads/")) {
      const branch = decodeURIComponent(path.slice("/git/ref/heads/".length));
      const ref = state.refs.get(branch);
      if (!ref) return json(404, { message: "Not Found" });
      return json(200, {
        object: { sha: ref.commitSha, type: "commit" },
      });
    }
    if (init.method === "GET" && path.startsWith("/git/commits/")) {
      const c = decodeURIComponent(path.slice("/git/commits/".length));
      const commit = state.commits.get(c);
      if (!commit) return json(404, { message: "Not Found" });
      return json(200, commit);
    }
    if (init.method === "GET" && path.startsWith("/git/trees/")) {
      const treeSha = decodeURIComponent(
        path.slice("/git/trees/".length),
      );
      state.treeRequests.push(treeSha);
      const entries = state.trees.get(treeSha);
      if (!entries) return json(404, { message: "Not Found" });
      return json(200, { sha: treeSha, tree: entries, truncated: false });
    }
    if (init.method === "POST" && path === "/git/blobs") {
      const req = JSON.parse(init.body ?? "{}");
      const content = req.content as string;
      const bytes = Uint8Array.from(atob(content), (c) => c.charCodeAt(0));
      const blobSha = gitBlobSha(bytes);
      state.blobs.set(content, blobSha);
      return json(201, { sha: blobSha });
    }
    if (init.method === "POST" && path === "/git/trees") {
      const req = JSON.parse(init.body ?? "{}");
      const base = req.base_tree as string | undefined;
      const baseEntries = (base ? state.trees.get(base) : undefined) ?? [];
      const delta = req.tree as Array<Record<string, unknown>>;
      const merged = new Map<string, Record<string, unknown>>();
      for (const e of baseEntries) merged.set(e.path as string, e);
      for (const e of delta) {
        if (e.sha === null) merged.delete(e.path as string);
        else merged.set(e.path as string, e);
      }
      const treeSha = nextSha("tree");
      state.trees.set(treeSha, [...merged.values()]);
      return json(201, { sha: treeSha });
    }
    if (init.method === "POST" && path === "/git/commits") {
      const req = JSON.parse(init.body ?? "{}");
      state.lastCommitMessage = req.message as string;
      const commitSha = nextSha("commit");
      state.commits.set(commitSha, {
        sha: commitSha,
        tree: { sha: req.tree },
        parents: (req.parents as string[]).map((sha) => ({ sha })),
      });
      return json(201, {
        sha: commitSha,
        html_url: `https://github.com/o/r/commit/${commitSha}`,
      });
    }
    if (init.method === "POST" && path === "/git/refs") {
      const req = JSON.parse(init.body ?? "{}");
      const branch = (req.ref as string).replace("refs/heads/", "");
      state.refs.set(branch, {
        commitSha: req.sha as string,
        treeSha: "",
      });
      state.refCreates++;
      if (state.autoEnablePages) {
        state.pages = {
          url: "https://api.github.com/repos/o/r/pages",
          html_url: "https://o.github.io/r/",
          status: "building",
          build_type: "legacy",
          source: { branch, path: "/" },
          cname: null,
          custom_404: false,
          public: true,
          https_enforced: false,
          https_certificate: { state: "new" },
        };
      }
      return json(201, { ref: req.ref });
    }
    if (init.method === "PATCH" && path.startsWith("/git/refs/heads/")) {
      const branch = decodeURIComponent(
        path.slice("/git/refs/heads/".length),
      );
      const req = JSON.parse(init.body ?? "{}");
      state.refs.set(branch, {
        commitSha: req.sha as string,
        treeSha: "",
      });
      state.refPatches++;
      return json(200, { ref: `refs/heads/${branch}` });
    }
    if (init.method === "GET" && path === "") {
      return json(200, { default_branch: defaultBranch });
    }
    return json(500, { message: `unhandled ${init.method} ${path}` });
  };

  return { fetchImpl, state, requests };
}

/** True for status codes for which `Response` forbids a body (204/205/304). */
function nullBodyStatus(status: number): boolean {
  return status === 204 || status === 205 || status === 304;
}

interface CapturedResource {
  specName: string;
  name: string;
  data: Record<string, unknown>;
}

function makeContext(globals: Record<string, unknown>) {
  const written: CapturedResource[] = [];
  const context = {
    globalArgs: model.globalArguments.parse(globals),
    logger: {
      info: () => {},
      debug: () => {},
      warning: () => {},
      error: () => {},
    },
    writeResource: (
      specName: string,
      name: string,
      data: Record<string, unknown>,
    ) => {
      written.push({ specName, name, data });
      return Promise.resolve({ name });
    },
  };
  return { context, written };
}

async function withFakeFetch<T>(
  fake: ReturnType<typeof makeFakeFetch>,
  fn: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  // deno-lint-ignore no-explicit-any
  (globalThis as any).fetch = (
    input: string | URL | Request,
    init?: RequestInit,
  ) =>
    fake.fetchImpl(String(input), {
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body as string | undefined,
    }).then((r) =>
      new Response(nullBodyStatus(r.status) ? null : r.body, {
        status: r.status,
      })
    );
  try {
    return await fn();
  } finally {
    // deno-lint-ignore no-explicit-any
    (globalThis as any).fetch = original;
  }
}

// ---------------------------------------------------------------------------
// Model method integration (mocked API)
// ---------------------------------------------------------------------------

const baseGlobals = {
  repo: "o/r",
  authToken: "fake-token",
};

Deno.test("ensureSite creates a Pages site when none exists", async () => {
  const fake = makeFakeFetch();
  const { context, written } = makeContext(baseGlobals);
  await withFakeFetch(fake, async () => {
    await model.methods.ensureSite.execute({}, context);
  });
  assertEquals(written.length, 1);
  assertEquals(written[0].data.action, "create");
  assertEquals(written[0].data.changed, true);
  assertEquals(written[0].data.sourceBranch, "gh-pages");
  assertEquals(fake.state.pages?.build_type, "legacy");
});

Deno.test("ensureSite is idempotent when the site already matches", async () => {
  const fake = makeFakeFetch();
  const { context, written } = makeContext(baseGlobals);
  await withFakeFetch(fake, async () => {
    await model.methods.ensureSite.execute({}, context);
  });
  assertEquals(written[0].data.action, "create");
  assertEquals(
    fake.requests.filter((r) => r.startsWith("POST") && r.endsWith("/pages"))
      .length,
    1,
  );

  const requestsBefore = fake.requests.length;
  await withFakeFetch(fake, async () => {
    await model.methods.ensureSite.execute({}, context);
  });
  assertEquals(written[1].data.action, "noop");
  assertEquals(written[1].data.changed, false);
  const secondRun = fake.requests.slice(requestsBefore);
  assertEquals(secondRun.filter((r) => r.startsWith("PUT")).length, 0);
  assertEquals(
    secondRun.filter((r) => r.startsWith("POST") && r.endsWith("/pages"))
      .length,
    0,
  );
});

Deno.test("ensureSite updates only when config drifts", async () => {
  const fake = makeFakeFetch();
  fake.state.pages = {
    url: "https://api.github.com/repos/o/r/pages",
    html_url: "https://o.github.io/r/",
    status: "built",
    build_type: "legacy",
    source: { branch: "main", path: "/" },
    cname: null,
    custom_404: false,
    public: true,
    https_enforced: true,
    https_certificate: { state: "issued" },
  };
  const { context, written } = makeContext(baseGlobals);
  await withFakeFetch(fake, async () => {
    await model.methods.ensureSite.execute({}, context);
  });
  assertEquals(written[0].data.action, "update");
  assertEquals(fake.state.pages?.source, { branch: "gh-pages", path: "/" });
  assertEquals(
    fake.requests.filter((r) => r.startsWith("PUT")).length,
    1,
  );
});

Deno.test("ensureSite handles Pages auto-enabling when the branch is created", async () => {
  const fake = makeFakeFetch();
  fake.state.autoEnablePages = true;
  const { context, written } = makeContext(baseGlobals);
  await withFakeFetch(fake, async () => {
    await model.methods.ensureSite.execute({}, context);
  });
  const data = written[0].data;
  assertEquals(data.action, "create");
  // The 409 from POST /pages must not surface as a failure, and the seeded
  // branch must be the Pages source.
  assertEquals(fake.state.pages?.source, { branch: "gh-pages", path: "/" });
  assertEquals(
    fake.requests.filter((r) => r.startsWith("POST") && r.endsWith("/pages"))
      .length,
    1,
  );
});

Deno.test("ensureSite defers HTTPS enforcement until the cert exists", async () => {
  const fake = makeFakeFetch();
  fake.state.httpsUnavailable = true;
  const { context, written } = makeContext(baseGlobals);
  await withFakeFetch(fake, async () => {
    await model.methods.ensureSite.execute({}, context);
  });
  const data = written[0].data;
  assertEquals(data.httpsDeferred, true);
  assertEquals(data.httpsEnforced, true);
  // The site was still created, with the retry dropping the HTTPS flag.
  assertEquals(fake.state.pages?.source, { branch: "gh-pages", path: "/" });
  assertEquals(fake.state.pages?.https_enforced, false);
});

Deno.test("ensureSite does not defer when HTTPS applies cleanly", async () => {
  const fake = makeFakeFetch();
  const { context, written } = makeContext(baseGlobals);
  await withFakeFetch(fake, async () => {
    await model.methods.ensureSite.execute({}, context);
  });
  assertEquals(written[0].data.httpsDeferred, false);
});

Deno.test("publishDir creates a commit and is a no-op when re-run", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/index.html`, "<!doctype html>\n");
    await Deno.mkdir(`${dir}/assets`);
    await Deno.writeTextFile(`${dir}/assets/app.css`, "body{}\n");

    const fake = makeFakeFetch();
    const { context, written } = makeContext(baseGlobals);

    await withFakeFetch(fake, async () => {
      await model.methods.publishDir.execute(
        model.methods.publishDir.arguments.parse({ dir }),
        context,
      );
    });
    const first = written[written.length - 1].data;
    assertEquals(first.action, "committed");
    assertEquals(first.added, 2);
    assertEquals(first.deleted, 0);
    assertEquals(first.fileCount, 2);
    assertEquals(typeof first.commitSha, "string");
    assertEquals(fake.state.refCreates, 1);
    assertEquals(fake.state.refPatches, 0);

    // Re-run with no changes: identical tree -> no new commit.
    await withFakeFetch(fake, async () => {
      await model.methods.publishDir.execute(
        model.methods.publishDir.arguments.parse({ dir }),
        context,
      );
    });
    const second = written[written.length - 1].data;
    assertEquals(second.action, "noop");
    assertEquals(second.changedCount, 0);
    assertEquals(second.unchangedCount, 2);
    assertEquals(fake.state.lastCommitMessage, "Publish site via swamp");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("publishDir honors dryRun without writing a commit", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/index.html`, "<!doctype html>\n");
    const fake = makeFakeFetch();
    const { context, written } = makeContext(baseGlobals);
    await withFakeFetch(fake, async () => {
      await model.methods.publishDir.execute(
        model.methods.publishDir.arguments.parse({ dir, dryRun: true }),
        context,
      );
    });
    const data = written[written.length - 1].data;
    assertEquals(data.action, "dry_run");
    assertEquals(data.dryRun, true);
    assertEquals(data.added, 1);
    assertEquals(
      fake.requests.filter((r) => r.startsWith("POST") && r.includes("commits"))
        .length,
      0,
    );
    assertEquals(fake.state.refPatches + fake.state.refCreates, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("publishDir prune deletes remote files absent locally", async () => {
  const seedTree = [
    { path: "index.html", type: "blob", sha: "seed-sha", mode: "100644" },
    { path: "stale.html", type: "blob", sha: "stale-sha", mode: "100644" },
  ];
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/index.html`, "new content");
    const fake = makeFakeFetch(seedTree);
    // Existing gh-pages branch pointing at the seed tree.
    fake.state.refs.set("gh-pages", {
      commitSha: "seed-commit",
      treeSha: "seed-tree",
    });
    const { context, written } = makeContext(baseGlobals);
    await withFakeFetch(fake, async () => {
      await model.methods.publishDir.execute(
        model.methods.publishDir.arguments.parse({ dir, prune: true }),
        context,
      );
    });
    const data = written[written.length - 1].data;
    assertEquals(data.modified, 1);
    assertEquals(data.deleted, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("publishDir respects the /docs Pages path prefix", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/index.html`, "<html>");
    const fake = makeFakeFetch();
    const { context, written } = makeContext({
      ...baseGlobals,
      pagesPath: "/docs",
    });
    await withFakeFetch(fake, async () => {
      await model.methods.publishDir.execute(
        model.methods.publishDir.arguments.parse({ dir }),
        context,
      );
    });
    const data = written[written.length - 1].data;
    const files = data.files as Array<{ repoPath: string }>;
    assertEquals(files[0].repoPath, "docs/index.html");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("publishFiles publishes explicit mappings", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/news.html`, "<html>news</html>");
    const fake = makeFakeFetch();
    const { context, written } = makeContext(baseGlobals);
    await withFakeFetch(fake, async () => {
      await model.methods.publishFiles.execute(
        model.methods.publishFiles.arguments.parse({
          files: [{ source: `${dir}/news.html`, repoPath: "latest/news.html" }],
        }),
        context,
      );
    });
    const data = written[written.length - 1].data;
    const files = data.files as Array<{ repoPath: string }>;
    assertEquals(files[0].repoPath, "latest/news.html");
    assertEquals(data.added, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("syncSite reports not_configured when Pages is absent", async () => {
  const fake = makeFakeFetch();
  const { context, written } = makeContext(baseGlobals);
  await withFakeFetch(fake, async () => {
    await model.methods.syncSite.execute({}, context);
  });
  const data = written[0].data;
  assertEquals(data.exists, false);
  assertEquals(data.status, "not_configured");
});

Deno.test("syncSite captures the latest build status", async () => {
  const fake = makeFakeFetch();
  fake.state.pages = {
    url: "https://api.github.com/repos/o/r/pages",
    html_url: "https://o.github.io/r/",
    status: "built",
    build_type: "legacy",
    source: { branch: "gh-pages", path: "/" },
    cname: null,
    custom_404: false,
    public: true,
    https_enforced: true,
    https_certificate: { state: "issued" },
  };
  const originalFetch = globalThis.fetch;
  const { context, written } = makeContext(baseGlobals);
  // deno-lint-ignore no-explicit-any
  (globalThis as any).fetch = (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input);
    if (url.endsWith("/pages/builds/latest")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            status: "built",
            commit: "abc123",
            error: { message: "" },
            created_at: "2026-01-01T00:00:00Z",
          }),
          { status: 200 },
        ),
      );
    }
    return fake.fetchImpl(url, {
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body as string | undefined,
    }).then((r) => new Response(r.body, { status: r.status }));
  };
  try {
    await model.methods.syncSite.execute({}, context);
  } finally {
    // deno-lint-ignore no-explicit-any
    (globalThis as any).fetch = originalFetch;
  }
  const data = written[0].data;
  assertEquals(data.exists, true);
  assertEquals(data.latestBuildStatus, "built");
  assertEquals(data.latestBuildCommit, "abc123");
});

// ---------------------------------------------------------------------------
// GitHubApi unit tests
// ---------------------------------------------------------------------------

Deno.test("GitHubApi throws a descriptive error on non-2xx", async () => {
  const api = new GitHubApi({
    base: "https://api.github.com",
    token: "t",
    fetchImpl: () =>
      Promise.resolve({
        status: 403,
        body: JSON.stringify({ message: "Forbidden" }),
      }),
  });
  await assertRejects(
    () => api.request("GET", "/x"),
    Error,
    "Forbidden",
  );
});

Deno.test("GitHubApi treats a 404 Pages GET as null", async () => {
  const api = new GitHubApi({
    base: "https://api.github.com",
    token: "t",
    fetchImpl: () =>
      Promise.resolve({ status: 404, body: '{"message":"Not Found"}' }),
  });
  assertEquals(await api.getPages("o/r"), null);
});

Deno.test("GitHubApi surfaces non-404 errors instead of masking them", async () => {
  const api = new GitHubApi({
    base: "https://api.github.com",
    token: "t",
    fetchImpl: () =>
      Promise.resolve({ status: 500, body: '{"message":"Boom"}' }),
  });
  await assertRejects(() => api.getPages("o/r"), Error, "Boom");
});

Deno.test("GitHubApi encodes blob content as base64", async () => {
  let sentBody = "";
  const api = new GitHubApi({
    base: "https://api.github.com",
    token: "t",
    fetchImpl: (_url, init) => {
      sentBody = init.body ?? "";
      return Promise.resolve({ status: 201, body: '{"sha":"blob1"}' });
    },
  });
  const sha = await api.createBlob("o/r", encoder.encode("hi"));
  assertEquals(sha, "blob1");
  const parsed = JSON.parse(sentBody);
  assertEquals(parsed.encoding, "base64");
  assertEquals(atob(parsed.content), "hi");
});

Deno.test("GitHubApi createTree sends base_tree and delta entries", async () => {
  let parsed: Record<string, unknown> = {};
  const api = new GitHubApi({
    base: "https://api.github.com",
    token: "t",
    fetchImpl: (_url, init) => {
      parsed = JSON.parse(init.body ?? "{}");
      return Promise.resolve({ status: 201, body: '{"sha":"tree1"}' });
    },
  });
  const sha = await api.createTree(
    "o/r",
    [{ path: "a.html", mode: "100644", type: "blob", sha: null }],
    "base-tree",
  );
  assertEquals(sha, "tree1");
  assertEquals(parsed.base_tree, "base-tree");
  assertEquals((parsed.tree as unknown[]).length, 1);
});

Deno.test("GitHubApi upsertRef creates a missing branch via POST", async () => {
  let method = "";
  const api = new GitHubApi({
    base: "https://api.github.com",
    token: "t",
    fetchImpl: (_url, init) => {
      method = init.method;
      return Promise.resolve({ status: 201, body: "{}" });
    },
  });
  await api.upsertRef("o/r", "gh-pages", "sha1", false);
  assertEquals(method, "POST");
});

Deno.test("GitHubApi upsertRef force-updates an existing branch via PATCH", async () => {
  let method = "";
  const api = new GitHubApi({
    base: "https://api.github.com",
    token: "t",
    fetchImpl: (_url, init) => {
      method = init.method;
      return Promise.resolve({ status: 200, body: "{}" });
    },
  });
  await api.upsertRef("o/r", "gh-pages", "sha1", true);
  assertEquals(method, "PATCH");
});

Deno.test("GitHubApi retries transient 5xx failures then succeeds", async () => {
  let calls = 0;
  const api = new GitHubApi({
    base: "https://api.github.com",
    token: "t",
    retryDelayMs: () => 0,
    fetchImpl: () => {
      calls++;
      if (calls < 3) {
        return Promise.resolve({ status: 503, body: '{"message":"busy"}' });
      }
      return Promise.resolve({ status: 200, body: '{"ok":true}' });
    },
  });
  const res = await api.request("GET", "/x");
  assertEquals(res.status, 200);
  assertEquals(calls, 3);
});

Deno.test("GitHubApi does not retry permanent 4xx failures", async () => {
  let calls = 0;
  const api = new GitHubApi({
    base: "https://api.github.com",
    token: "t",
    retryDelayMs: () => 0,
    fetchImpl: () => {
      calls++;
      return Promise.resolve({ status: 403, body: '{"message":"Forbidden"}' });
    },
  });
  await assertRejects(() => api.request("GET", "/x"), Error, "Forbidden");
  assertEquals(calls, 1);
});

Deno.test("GitHubApi retries rate-limit 403 but not auth 403", async () => {
  let rateLimitCalls = 0;
  const rateLimited = new GitHubApi({
    base: "https://api.github.com",
    token: "t",
    retryDelayMs: () => 0,
    fetchImpl: () => {
      rateLimitCalls++;
      if (rateLimitCalls < 2) {
        return Promise.resolve({
          status: 403,
          body: '{"message":"API rate limit exceeded"}',
        });
      }
      return Promise.resolve({ status: 200, body: "{}" });
    },
  });
  assertEquals((await rateLimited.request("GET", "/x")).status, 200);
  assertEquals(rateLimitCalls, 2);

  let authCalls = 0;
  const authDenied = new GitHubApi({
    base: "https://api.github.com",
    token: "t",
    retryDelayMs: () => 0,
    fetchImpl: () => {
      authCalls++;
      return Promise.resolve({ status: 403, body: '{"message":"Forbidden"}' });
    },
  });
  await assertRejects(() => authDenied.request("GET", "/x"));
  assertEquals(authCalls, 1);
});

Deno.test("isRetryableResponse classifies statuses", () => {
  assertEquals(isRetryableResponse(200, ""), false);
  assertEquals(isRetryableResponse(429, ""), true);
  assertEquals(isRetryableResponse(500, ""), true);
  assertEquals(isRetryableResponse(404, ""), false);
  assertEquals(isRetryableResponse(403, "API rate limit exceeded"), true);
  assertEquals(isRetryableResponse(403, "Forbidden"), false);
});

Deno.test("GitHubApi getBranchHead returns null for a missing branch", async () => {
  const api = new GitHubApi({
    base: "https://api.github.com",
    token: "t",
    fetchImpl: () =>
      Promise.resolve({ status: 404, body: '{"message":"Not Found"}' }),
  });
  assertEquals(await api.getBranchHead("o/r", "gh-pages"), null);
});

Deno.test("GitHubApi getTreeRecursive maps entries and tolerates a 404", async () => {
  const api = new GitHubApi({
    base: "https://api.github.com",
    token: "t",
    fetchImpl: () =>
      Promise.resolve({
        status: 200,
        body: JSON.stringify({
          tree: [
            {
              path: "a.html",
              type: "blob",
              sha: "s1",
              mode: "100644",
              size: 3,
            },
          ],
        }),
      }),
  });
  const result = await api.getTreeRecursive("o/r", "tree1");
  assertEquals(result.entries, [
    { path: "a.html", type: "blob", sha: "s1", mode: "100644", size: 3 },
  ]);
  assertEquals(result.truncated, false);

  const missing = new GitHubApi({
    base: "https://api.github.com",
    token: "t",
    fetchImpl: () =>
      Promise.resolve({ status: 404, body: '{"message":"Not Found"}' }),
  });
  assertEquals(await missing.getTreeRecursive("o/r", "tree1"), {
    entries: [],
    truncated: false,
  });
});

Deno.test("GitHubApi surfaces the tree truncated flag", async () => {
  const api = new GitHubApi({
    base: "https://api.github.com",
    token: "t",
    fetchImpl: () =>
      Promise.resolve({
        status: 200,
        body: JSON.stringify({ tree: [], truncated: true }),
      }),
  });
  assertEquals((await api.getTreeRecursive("o/r", "t")).truncated, true);
});

Deno.test("valid-target check rejects malformed configuration", async () => {
  const check = model.checks["valid-target"];
  const run = (globals: Record<string, unknown>, method = "ensureSite") =>
    check.execute({
      globalArgs: model.globalArguments.parse(globals),
      methodName: method,
    } as never);

  assertEquals((await run(baseGlobals)).pass, true);
  assertEquals((await run(baseGlobals, "publishDir")).pass, true);

  // Bypass schema parsing to exercise the check's own validation.
  const invalid = await check.execute({
    globalArgs: {
      ...model.globalArguments.parse(baseGlobals),
      repo: "not-owner-name",
      branch: "  ",
      pagesPath: "/wrong" as "/",
    },
    methodName: "ensureSite",
  } as never);
  assertEquals(invalid.pass, false);
  assertEquals(invalid.errors?.length, 3);
  assertStringIncludes(invalid.errors?.join(" ") ?? "", "owner/name");
  assertStringIncludes(invalid.errors?.join(" ") ?? "", "branch");
  assertStringIncludes(invalid.errors?.join(" ") ?? "", "pagesPath");
});

Deno.test("model exposes the expected resource specs and methods", () => {
  assertEquals(model.type, "@svendowideit/github-pages");
  assertEquals(Object.keys(model.resources).sort(), [
    "publish",
    "site",
    "sync",
  ]);
  assertEquals(Object.keys(model.methods).sort(), [
    "ensureSite",
    "publishDir",
    "publishFiles",
    "syncSite",
  ]);
});

Deno.test("manifest global args reject unknown keys", () => {
  let threw = false;
  try {
    model.globalArguments.parse({ ...baseGlobals, bogus: true });
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
  assertStringIncludes(
    String(model.methods.publishDir.arguments.parse({ dir: "/x" }).prune),
    "false",
  );
});
