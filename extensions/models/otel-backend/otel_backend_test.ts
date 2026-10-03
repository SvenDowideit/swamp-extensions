import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1";

import {
  base64Encode,
  basicAuthHeader,
  buildRunArgs,
  containerNameFor,
  desiredHashFor,
  expandHome,
  fnv1aHex,
  healthSummary,
  ingestCurl,
  model,
  normaliseEmail,
  OPENOBSERVE_PROFILE,
  parseContainerState,
  PROFILES,
  resolveEndpoints,
  resolveProfile,
} from "./otel_backend.ts";

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

Deno.test("resolveProfile returns the openobserve profile", () => {
  const profile = resolveProfile("openobserve");
  assertEquals(profile.name, "openobserve");
  assertStringIncludes(profile.image, "openobserve");
});

Deno.test("resolveProfile rejects an unknown profile with the known list", () => {
  const err = assertThrows(() => resolveProfile("clickhouse")) as Error;
  assertStringIncludes(err.message, "unknown backend profile 'clickhouse'");
  assertStringIncludes(err.message, "openobserve");
});

Deno.test("PROFILES is keyed by profile name", () => {
  assertEquals(Object.keys(PROFILES), ["openobserve"]);
  assertEquals(PROFILES[OPENOBSERVE_PROFILE.name], OPENOBSERVE_PROFILE);
});

Deno.test("openobserve OTLP HTTP base path has no trailing slash and is org-scoped", () => {
  assertEquals(
    OPENOBSERVE_PROFILE.otlpHttpBasePath("default"),
    "/api/default",
  );
  assert(!OPENOBSERVE_PROFILE.otlpHttpBasePath("default").endsWith("/"));
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

Deno.test("expandHome expands a leading tilde", () => {
  assertEquals(expandHome("~", "/home/u"), "/home/u");
  assertEquals(expandHome("~/x/y", "/home/u"), "/home/u/x/y");
  assertEquals(expandHome("/abs/path", "/home/u"), "/abs/path");
  assertEquals(expandHome("relative", "/home/u"), "relative");
});

Deno.test("containerNameFor derives a docker-safe name and honours an override", () => {
  assertEquals(
    containerNameFor("otel-backend", ""),
    "otel-backend-otel-backend",
  );
  assertEquals(containerNameFor("My Backend!", ""), "otel-backend-my-backend-");
  assertEquals(containerNameFor("otel-backend", "  custom  "), "custom");
});

Deno.test("resolveEndpoints builds UI, OTLP/HTTP, and gRPC URLs", () => {
  const ep = resolveEndpoints({
    host: "127.0.0.1",
    port: 5080,
    grpcPort: 5081,
    organization: "default",
    profile: OPENOBSERVE_PROFILE,
  });
  assertEquals(ep.ui, "http://127.0.0.1:5080");
  assertEquals(ep.otlpHttp, "http://127.0.0.1:5080/api/default");
  assertEquals(ep.otlpGrpc, "127.0.0.1:5081");
  assertEquals(ep.organization, "default");
});

Deno.test("buildRunArgs renders a deterministic docker run vector", () => {
  const args = buildRunArgs({
    profile: OPENOBSERVE_PROFILE,
    image: "img:1",
    containerName: "otel-backend-x",
    modelName: "x",
    bindAddress: "127.0.0.1",
    port: 5080,
    grpcPort: 5081,
    dataDir: "/data/dir",
    restartPolicy: "unless-stopped",
    desiredHash: "abcd1234",
    env: {
      ZO_DATA_DIR: "/data",
      ZO_ORG: "default",
      ZO_ROOT_USER_PASSWORD: "secret",
    },
  });
  assertEquals(args[0], "run");
  assert(args.includes("-d"));
  assert(args.includes("--name"));
  assert(args.includes("otel-backend-x"));
  assert(args.includes("127.0.0.1:5080:5080"));
  assert(args.includes("127.0.0.1:5081:5081"));
  assert(args.includes("/data/dir:/data"));
  assert(args.includes("swamp.model=x"));
  assert(args.includes("swamp.desired=abcd1234"));
  assert(args.includes("ZO_ROOT_USER_PASSWORD=secret"));
  assertEquals(args[args.length - 1], "img:1");
});

Deno.test("buildRunArgs omits empty-valued env vars", () => {
  const args = buildRunArgs({
    profile: OPENOBSERVE_PROFILE,
    image: "img:1",
    containerName: "c",
    modelName: "m",
    bindAddress: "127.0.0.1",
    port: 1,
    grpcPort: 2,
    dataDir: "/d",
    restartPolicy: "no",
    desiredHash: "h",
    env: { A: "", B: "set" },
  });
  assert(!args.some((a) => a.startsWith("A=")));
  assert(args.includes("B=set"));
});

Deno.test("desiredHashFor is stable and sensitive to each field", () => {
  const base = {
    image: "img:1",
    port: 5080,
    grpcPort: 5081,
    bindAddress: "127.0.0.1",
    dataDir: "/d",
    restartPolicy: "unless-stopped",
    envKeys: ["B", "A"],
  };
  const a = desiredHashFor(base);
  const b = desiredHashFor({ ...base, envKeys: ["A", "B"] });
  assertEquals(a, b, "env key order must not matter");
  assert(a !== desiredHashFor({ ...base, image: "img:2" }));
  assert(a !== desiredHashFor({ ...base, port: 5082 }));
  assert(a !== desiredHashFor({ ...base, bindAddress: "0.0.0.0" }));
  assert(a !== desiredHashFor({ ...base, dataDir: "/other" }));
  assert(a !== desiredHashFor({ ...base, restartPolicy: "always" }));
});

Deno.test("desiredHashFor does not include secret values", () => {
  // The hash is computed from env *keys*, so a password can never leak into it.
  const hash = desiredHashFor({
    image: "i",
    port: 1,
    grpcPort: 2,
    bindAddress: "127.0.0.1",
    dataDir: "/d",
    restartPolicy: "no",
    envKeys: ["ZO_ROOT_USER_PASSWORD"],
  });
  assertEquals(hash.length, 8);
  assert(!hash.includes("ZO_ROOT_USER_PASSWORD"));
});

Deno.test("fnv1aHex is deterministic", () => {
  assertEquals(fnv1aHex("hello"), fnv1aHex("hello"));
  assertEquals(fnv1aHex("").length, 8);
  assert(fnv1aHex("a") !== fnv1aHex("b"));
});

Deno.test("base64Encode handles ASCII and multibyte input", () => {
  assertEquals(
    base64Encode("root@example.com:pass"),
    btoa("root@example.com:pass"),
  );
  // Multibyte must be UTF-8 encoded, not char-code truncated.
  assertEquals(base64Encode("é"), btoa(String.fromCharCode(0xc3, 0xa9)));
});

Deno.test("basicAuthHeader renders the OpenObserve Authorization value", () => {
  assertEquals(
    basicAuthHeader("root@example.com", "Complexpass#123"),
    `Basic ${btoa("root@example.com:Complexpass#123")}`,
  );
});

Deno.test("parseContainerState reads a running container and its labels", () => {
  const inspect = JSON.stringify([
    {
      State: { Running: true, Status: "running" },
      Config: { Labels: { "swamp.desired": "deadbeef" } },
    },
  ]);
  assertEquals(parseContainerState(inspect), {
    exists: true,
    running: true,
    status: "running",
    desiredHash: "deadbeef",
  });
});

Deno.test("parseContainerState handles a stopped or absent container", () => {
  assertEquals(parseContainerState(""), {
    exists: false,
    running: false,
    status: "",
    desiredHash: "",
  });
  assertEquals(parseContainerState("[]"), {
    exists: false,
    running: false,
    status: "",
    desiredHash: "",
  });
  assertEquals(
    parseContainerState(
      JSON.stringify({ State: { Running: false, Status: "exited" } }),
    ),
    {
      exists: true,
      running: false,
      status: "exited",
      desiredHash: "",
    },
  );
});

Deno.test("the openobserve password policy matches its documented rules", () => {
  const policy = OPENOBSERVE_PROFILE.rootPasswordPolicy!;
  assert(policy.test("Abcdef1!"), "a compliant password passes");
  assert(!policy.test("alllowercase1!"), "needs an uppercase letter");
  assert(!policy.test("ALLUPPERCASE1!"), "needs a lowercase letter");
  assert(!policy.test("NoDigits!!aA"), "needs a digit");
  assert(!policy.test("NoSpecial1aA"), "needs a special character");
  assert(!policy.test("Aa1!"), "needs 8 characters");
  assert(policy.test("Aa1!".repeat(30)), "long passwords (<=128) pass");
  assert(!policy.test("Aa1!".repeat(40)), "passwords >128 are rejected");
});

Deno.test("normaliseEmail lowercases but preserves the address", () => {
  assertEquals(
    normaliseEmail("SvenDowideit@home.org.au"),
    "svendowideit@home.org.au",
  );
  assertEquals(normaliseEmail("  root@example.com  "), "root@example.com");
  assertEquals(normaliseEmail(""), "");
});

Deno.test("normaliseEmail warns when the address contains uppercase", () => {
  const warnings: string[] = [];
  const ctx = {
    logger: {
      warn: (msg: string) => {
        warnings.push(msg);
      },
    },
  };
  normaliseEmail("Root@Example.com", ctx);
  assertEquals(warnings.length, 1);
  assertStringIncludes(warnings[0], "uppercase");
  warnings.length = 0;
  normaliseEmail("root@example.com", ctx);
  assertEquals(warnings.length, 0);
});

Deno.test("healthSummary distinguishes healthy, refused, and non-2xx", () => {
  assertStringIncludes(
    healthSummary({ healthy: true, statusCode: 200, attempts: 3 }),
    "healthy",
  );
  assertStringIncludes(
    healthSummary({ healthy: false, statusCode: 0, attempts: 5 }),
    "no response",
  );
  assertStringIncludes(
    healthSummary({ healthy: false, statusCode: 503, attempts: 5 }),
    "HTTP 503",
  );
});

Deno.test("ingestCurl names the stream and OTLP logs path", () => {
  const ep = resolveEndpoints({
    host: "127.0.0.1",
    port: 5080,
    grpcPort: 5081,
    organization: "default",
    profile: OPENOBSERVE_PROFILE,
  });
  const curl = ingestCurl(ep, "smoke");
  assertStringIncludes(curl, "http://127.0.0.1:5080/api/default/v1/logs");
  assertStringIncludes(curl, "stream-name: smoke");
});

// ---------------------------------------------------------------------------
// Model definition
// ---------------------------------------------------------------------------

Deno.test("model exposes the expected methods", () => {
  assertEquals(model.type, "@svendowideit/otel-backend");
  const methods = Object.keys(model.methods).sort();
  assertEquals(methods, [
    "configure",
    "install",
    "profile",
    "remove",
    "status",
    "upgrade",
  ]);
});

Deno.test("model global args default to the openobserve profile", () => {
  const parsed = model.globalArguments.parse({});
  assertEquals(parsed.profile, "openobserve");
  assertEquals(parsed.port, 5080);
  assertEquals(parsed.grpcPort, 5081);
  assertEquals(parsed.bindAddress, "127.0.0.1");
  assertEquals(parsed.organization, "default");
});

Deno.test("model global args are strict", () => {
  assertThrows(() => model.globalArguments.parse({ nonsense: true }));
});
