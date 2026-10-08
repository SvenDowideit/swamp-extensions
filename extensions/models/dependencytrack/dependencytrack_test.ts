import { assertEquals, assertRejects } from "jsr:@std/assert@1";

import {
  basicAuth,
  containerNames,
  createApiKey,
  ensureTeam,
  generateAdminPassword,
  grantTeamPermission,
  isApiReadyStatus,
  jdbcUrl,
  login,
  loginWithRotation,
  resolveAdminBaseUrl,
  resolveBackendUrl,
  resolveFrontendUrl,
} from "./dependencytrack.ts";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

Deno.test("containerNames derives api/frontend/service names", () => {
  assertEquals(containerNames("", "dependencytrack"), {
    api: "dependencytrack-api",
    frontend: "dependencytrack-frontend",
    serviceModel: "dependencytrack-svc",
  });
  assertEquals(containerNames("dt", "ignored").api, "dt-api");
  assertEquals(containerNames("", "my dt").api, "my-dt-api");
});

Deno.test("resolveBackendUrl prefers the explicit public URL", () => {
  assertEquals(
    resolveBackendUrl({
      publicBackendUrl: "",
      bindAddress: "127.0.0.1",
      apiPort: 8080,
    }),
    "http://127.0.0.1:8080",
  );
  assertEquals(
    resolveBackendUrl({
      publicBackendUrl: "https://backend.dependencytrack.example",
      bindAddress: "127.0.0.1",
      apiPort: 8080,
    }),
    "https://backend.dependencytrack.example",
  );
});

Deno.test("resolveFrontendUrl prefers the explicit public URL", () => {
  assertEquals(
    resolveFrontendUrl({
      publicFrontendUrl: "",
      bindAddress: "127.0.0.1",
      uiPort: 8081,
    }),
    "http://127.0.0.1:8081",
  );
  assertEquals(
    resolveFrontendUrl({
      publicFrontendUrl: "https://dependencytrack.example",
      bindAddress: "127.0.0.1",
      uiPort: 8081,
    }),
    "https://dependencytrack.example",
  );
});

Deno.test("resolveAdminBaseUrl always uses the local bind address", () => {
  // Control-plane calls must never use the public URL: the proxy that serves it
  // is created after bootstrap (or may not exist at all).
  assertEquals(
    resolveAdminBaseUrl({ bindAddress: "127.0.0.1", apiPort: 8080 }),
    "http://127.0.0.1:8080",
  );
  assertEquals(
    resolveAdminBaseUrl({ bindAddress: "0.0.0.0", apiPort: 9000 }),
    "http://0.0.0.0:9000",
  );
});

Deno.test("jdbcUrl builds a v5 datasource URL", () => {
  assertEquals(
    jdbcUrl("postgres", 5432, "dtrack"),
    "jdbc:postgresql://postgres:5432/dtrack",
  );
});

Deno.test("isApiReadyStatus treats 2xx-4xx (but not 404) as up", () => {
  assertEquals(isApiReadyStatus(200), true);
  assertEquals(isApiReadyStatus(401), true);
  assertEquals(isApiReadyStatus(404), false);
  assertEquals(isApiReadyStatus(503), false);
});

Deno.test("basicAuth encodes user:password", () => {
  assertEquals(basicAuth("admin", "admin"), "Basic YWRtaW46YWRtaW4=");
});

Deno.test("generateAdminPassword is URL-safe and non-trivial", () => {
  const p = generateAdminPassword();
  assertEquals(/^[A-Za-z0-9_-]+$/.test(p), true);
  assertEquals(p.length >= 16, true);
});

// ---------------------------------------------------------------------------
// HTTP flows (mocked fetch)
// ---------------------------------------------------------------------------

const realFetch = globalThis.fetch;
function mockFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    return Promise.resolve(handler(url, init));
  }) as typeof fetch;
}
function restoreFetch() {
  globalThis.fetch = realFetch;
}

Deno.test("login returns the JWT on success", async () => {
  mockFetch((url, init) => {
    assertEquals(url.endsWith("/api/v1/user/login"), true);
    assertEquals(init?.method, "POST");
    return new Response("jwt-token", { status: 200 });
  });
  try {
    const r = await login("http://x", "admin", "pw");
    assertEquals(r.ok, true);
    assertEquals(r.token, "jwt-token");
  } finally {
    restoreFetch();
  }
});

Deno.test("loginWithRotation rotates the forced first password", async () => {
  const calls: string[] = [];
  mockFetch((url, init) => {
    calls.push(`${init?.method} ${url}`);
    if (url.endsWith("/user/login")) {
      const body = (init?.body as string) ?? "";
      if (body.includes("password=admin")) {
        return new Response("FORCE_PASSWORD_CHANGE", { status: 401 });
      }
      return new Response("new-jwt", { status: 200 });
    }
    if (url.endsWith("/user/forceChangePassword")) {
      return new Response("", { status: 200 });
    }
    return new Response("nope", { status: 500 });
  });
  try {
    const r = await loginWithRotation(
      "http://x",
      "admin",
      ["admin"],
      "newpassword1",
    );
    assertEquals(r.rotated, true);
    assertEquals(r.token, "new-jwt");
    assertEquals(
      calls.some((c) => c.includes("forceChangePassword")),
      true,
    );
  } finally {
    restoreFetch();
  }
});

Deno.test("loginWithRotation surfaces a hard failure", async () => {
  mockFetch(() => new Response("INVALID_CREDENTIALS", { status: 401 }));
  try {
    await assertRejects(
      () => loginWithRotation("http://x", "admin", ["wrong"], "newpassword1"),
      Error,
      "login failed",
    );
  } finally {
    restoreFetch();
  }
});

Deno.test("loginWithRotation falls back to a later password candidate", async () => {
  const tried: string[] = [];
  mockFetch((url, init) => {
    if (url.endsWith("/user/login")) {
      const body = (init?.body as string) ?? "";
      tried.push(body);
      if (body.includes("password=stale")) {
        return new Response("INVALID_CREDENTIALS", { status: 401 });
      }
      if (body.includes("password=admin")) {
        return new Response("FORCE_PASSWORD_CHANGE", { status: 401 });
      }
      return new Response("rotated-jwt", { status: 200 });
    }
    if (url.endsWith("/user/forceChangePassword")) {
      return new Response("", { status: 200 });
    }
    return new Response("nope", { status: 500 });
  });
  try {
    const r = await loginWithRotation(
      "http://x",
      "admin",
      ["stale", "admin"],
      "newpassword1",
    );
    assertEquals(r.rotated, true);
    assertEquals(r.usedPassword, "newpassword1");
    assertEquals(tried.length, 3);
  } finally {
    restoreFetch();
  }
});

Deno.test("ensureTeam returns an existing team without creating one", async () => {
  let created = false;
  mockFetch((_url, init) => {
    if (init?.method === "PUT") created = true;
    return new Response(JSON.stringify([{ uuid: "t1", name: "automation" }]), {
      status: 200,
    });
  });
  try {
    const t = await ensureTeam("http://x", "jwt", "automation");
    assertEquals(t, { uuid: "t1", name: "automation" });
    assertEquals(created, false);
  } finally {
    restoreFetch();
  }
});

Deno.test("ensureTeam creates a missing team", async () => {
  mockFetch((_url, init) => {
    if (init?.method === "PUT") {
      return new Response(JSON.stringify({ uuid: "t2", name: "automation" }), {
        status: 201,
      });
    }
    return new Response(JSON.stringify([]), { status: 200 });
  });
  try {
    const t = await ensureTeam("http://x", "jwt", "automation");
    assertEquals(t.uuid, "t2");
  } finally {
    restoreFetch();
  }
});

Deno.test("createApiKey returns the one-time key", async () => {
  mockFetch((url, init) => {
    assertEquals(url.endsWith("/api/v1/team/t1/key"), true);
    assertEquals(init?.method, "PUT");
    return new Response(JSON.stringify({ key: "odt_abc", publicId: "pid" }), {
      status: 201,
    });
  });
  try {
    const k = await createApiKey("http://x", "jwt", "t1");
    assertEquals(k.key, "odt_abc");
    assertEquals(k.publicId, "pid");
  } finally {
    restoreFetch();
  }
});

Deno.test("createApiKey throws when no key is returned", async () => {
  mockFetch(() => new Response(JSON.stringify({}), { status: 201 }));
  try {
    await assertRejects(
      () => createApiKey("http://x", "jwt", "t1"),
      Error,
      "no key",
    );
  } finally {
    restoreFetch();
  }
});

Deno.test("grantTeamPermission accepts 200 and 304", async () => {
  for (const status of [200, 304]) {
    mockFetch((url, init) => {
      assertEquals(url.endsWith("/api/v1/permission/BOM_UPLOAD/team/t1"), true);
      assertEquals(init?.method, "POST");
      return new Response(status === 304 ? null : "", { status });
    });
    try {
      await grantTeamPermission("http://x", "jwt", "t1", "BOM_UPLOAD");
    } finally {
      restoreFetch();
    }
  }
});
