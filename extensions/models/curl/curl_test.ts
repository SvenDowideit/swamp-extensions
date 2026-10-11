import {
  assertEquals,
  assertNotEquals,
  assertRejects,
} from "jsr:@std/assert@1";

import {
  buildCurlArgs,
  buildUrl,
  collectRedirects,
  collectSetCookies,
  cookieMatches,
  decodeCapped,
  expandHome,
  fnv1a,
  hasHeader,
  model,
  parseCookieJar,
  parseHeader,
  parseHeaderBlocks,
  parseSetCookie,
  parseWriteOut,
  redactArgv,
  redactValue,
  requestInstanceName,
  resolveCookieJar,
  resolveMethod,
  secondsToCurl,
  statusTextOf,
} from "./curl.ts";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

Deno.test("fnv1a is deterministic and non-empty", () => {
  assertEquals(fnv1a("hello"), fnv1a("hello"));
  assertNotEquals(fnv1a("hello"), fnv1a("world"));
  assertEquals(fnv1a("hello").length, 8);
});

Deno.test("expandHome expands a leading tilde", () => {
  const home = Deno.env.get("HOME") ?? "";
  if (!home) return;
  assertEquals(expandHome("~"), home);
  assertEquals(expandHome("~/x/y"), `${home}/x/y`);
  assertEquals(expandHome("/abs/path"), "/abs/path");
});

Deno.test("parseHeader splits a well-formed line and rejects junk", () => {
  assertEquals(parseHeader("Content-Type: application/json"), [
    "Content-Type",
    "application/json",
  ]);
  assertEquals(parseHeader("X-Api-Key:abc"), ["X-Api-Key", "abc"]);
  assertEquals(parseHeader("no-colon"), null);
  assertEquals(parseHeader(": empty"), null);
});

Deno.test("hasHeader is case-insensitive", () => {
  const headers: [string, string][] = [["User-Agent", "u"]];
  assertEquals(hasHeader(headers, "user-agent"), true);
  assertEquals(hasHeader(headers, "Authorization"), false);
});

Deno.test("buildUrl appends query parameters, preserving existing ones", () => {
  assertEquals(
    buildUrl("https://e.com/a?x=1", { y: "2" }),
    "https://e.com/a?x=1&y=2",
  );
  assertEquals(buildUrl("https://e.com/a", {}), "https://e.com/a");
  assertEquals(buildUrl("not a url", { y: "2" }), "not a url");
});

Deno.test("resolveMethod picks auto, explicit and case handling", () => {
  assertEquals(resolveMethod("", false), "GET");
  assertEquals(resolveMethod("", true), "POST");
  assertEquals(resolveMethod("put", false), "PUT");
  assertEquals(resolveMethod("DELETE", true), "DELETE");
});

Deno.test("resolveCookieJar honors explicit paths and derives per-model ones", () => {
  assertEquals(
    resolveCookieJar(
      { cookieJar: "/tmp/jar.txt", stateDir: "~/.swamp/curl" },
      "m",
    ),
    "/tmp/jar.txt",
  );
  const derived = resolveCookieJar(
    { cookieJar: "", stateDir: "/state" },
    "my model",
  );
  assertEquals(derived, "/state/my-model/cookies.txt");
});

Deno.test("requestInstanceName prefers a sanitized label", () => {
  assertEquals(
    requestInstanceName("submit sbom", "POST", "u", "t"),
    "submit-sbom",
  );
  const generated = requestInstanceName("", "GET", "https://e.com", "t");
  assertEquals(generated.startsWith("req-"), true);
});

Deno.test("redactValue masks only redacted names", () => {
  const set = new Set(["authorization"]);
  assertEquals(redactValue("Authorization", "Bearer x", set), "***");
  assertEquals(redactValue("Accept", "json", set), "json");
});

Deno.test("secondsToCurl converts milliseconds to seconds", () => {
  assertEquals(secondsToCurl(30000), "30");
  assertEquals(secondsToCurl(500), "0.5");
});

// ---------------------------------------------------------------------------
// Header parsing
// ---------------------------------------------------------------------------

Deno.test("parseHeaderBlocks parses a single response", () => {
  const raw =
    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nX-Trace: a\r\n\r\n";
  const blocks = parseHeaderBlocks(raw);
  assertEquals(blocks.length, 1);
  assertEquals(blocks[0].status, 200);
  assertEquals(blocks[0].headers["content-type"], "application/json");
  assertEquals(blocks[0].headers["x-trace"], "a");
});

Deno.test("parseHeaderBlocks joins repeated headers and keeps blocks", () => {
  const raw = [
    "HTTP/1.1 301 Moved Permanently",
    "Location: https://e.com/b",
    "",
    "HTTP/1.1 200 OK",
    "Set-Cookie: a=1",
    "Set-Cookie: b=2",
    "",
  ].join("\r\n");
  const blocks = parseHeaderBlocks(raw);
  assertEquals(blocks.length, 2);
  assertEquals(blocks[1].headers["set-cookie"], "a=1, b=2");
  assertEquals(statusTextOf(blocks[0].statusLine), "Moved Permanently");
});

Deno.test("collectSetCookies and collectRedirects read the chain", () => {
  const raw = [
    "HTTP/1.1 302 Found",
    "Location: https://e.com/final",
    "",
    "HTTP/1.1 200 OK",
    "Set-Cookie: sid=abc; Path=/; HttpOnly; Secure",
    "Set-Cookie: theme=dark",
    "",
  ].join("\r\n");
  const blocks = parseHeaderBlocks(raw);
  const cookies = collectSetCookies(blocks, "e.com");
  assertEquals(cookies.length, 2);
  assertEquals(cookies[0].name, "sid");
  assertEquals(cookies[0].httpOnly, true);
  assertEquals(cookies[0].secure, true);
  assertEquals(cookies[1].value, "dark");
  const redirects = collectRedirects(blocks);
  assertEquals(redirects.length, 1);
  assertEquals(redirects[0].status, 302);
  assertEquals(redirects[0].location, "https://e.com/final");
});

Deno.test("parseSetCookie reads Domain and rejects malformed values", () => {
  const cookie = parseSetCookie("t=1; Domain=.example.com; Path=/x", "e.com");
  assertEquals(cookie?.domain, "example.com");
  assertEquals(cookie?.path, "/x");
  assertEquals(parseSetCookie("=nope", "e.com"), null);
});

// ---------------------------------------------------------------------------
// Cookie jar
// ---------------------------------------------------------------------------

Deno.test("parseCookieJar reads Netscape lines and HttpOnly entries", () => {
  const raw = [
    "# Netscape HTTP Cookie File",
    "",
    "e.com\tTRUE\t/\tFALSE\t0\tsid\tabc",
    "#HttpOnly_e.com\tTRUE\t/\tTRUE\t0\ttoken\txyz",
    "garbage line",
  ].join("\n");
  const cookies = parseCookieJar(raw);
  assertEquals(cookies.length, 2);
  assertEquals(cookies[0].name, "sid");
  assertEquals(cookies[0].secure, false);
  assertEquals(cookies[1].name, "token");
  assertEquals(cookies[1].httpOnly, true);
  assertEquals(cookies[1].secure, true);
});

Deno.test("cookieMatches respects domain, path and expiry", () => {
  const future = String(Math.floor(Date.now() / 1000) + 3600);
  const past = String(Math.floor(Date.now() / 1000) - 3600);
  const base = {
    name: "a",
    value: "b",
    domain: ".e.com",
    path: "/",
    expires: future,
  };
  assertEquals(cookieMatches(base, "e.com", "/x"), true);
  assertEquals(cookieMatches(base, "sub.e.com", "/x"), true);
  assertEquals(cookieMatches(base, "other.com", "/x"), false);
  assertEquals(cookieMatches({ ...base, path: "/api" }, "e.com", "/x"), false);
  assertEquals(cookieMatches({ ...base, expires: past }, "e.com", "/"), false);
});

Deno.test("cookieMatches rejects an empty domain", () => {
  assertEquals(
    cookieMatches({ name: "a", value: "b" }, "e.com", "/"),
    false,
  );
});

// ---------------------------------------------------------------------------
// curl invocation
// ---------------------------------------------------------------------------

Deno.test("buildCurlArgs assembles the tracked invocation", () => {
  const argv = buildCurlArgs({
    url: "https://e.com/x",
    method: "POST",
    headers: [["Content-Type", "application/json"]],
    headerFile: "/tmp/h",
    bodyFile: "/tmp/b",
    cookieJar: "/tmp/jar",
    reuseCookies: true,
    explicitCookies: "a=b",
    dataFile: "/tmp/body",
    multipart: [],
    files: [],
    user: "u:p",
    followRedirects: true,
    maxRedirects: 5,
    insecure: false,
    timeoutMs: 30000,
    connectTimeoutMs: 10000,
    extraArgs: [],
  });
  assertEquals(argv.includes("--dump-header"), true);
  assertEquals(argv.includes("--write-out"), true);
  assertEquals(argv[argv.indexOf("--max-redirs") + 1], "5");
  assertEquals(argv[argv.indexOf("--cookie") + 1], "/tmp/jar");
  assertEquals(argv[argv.indexOf("--cookie-jar") + 1], "/tmp/jar");
  assertEquals(argv[argv.indexOf("--data-binary") + 1], "@/tmp/body");
  assertEquals(argv[argv.indexOf("--user") + 1], "u:p");
  assertEquals(argv[argv.length - 1], "https://e.com/x");
  assertEquals(argv.includes("--insecure"), false);
});

Deno.test("buildCurlArgs omits the jar and follows the no-redirect path", () => {
  const argv = buildCurlArgs({
    url: "https://e.com",
    method: "GET",
    headers: [],
    headerFile: "/tmp/h",
    bodyFile: "/tmp/b",
    cookieJar: "",
    reuseCookies: false,
    explicitCookies: "",
    multipart: [],
    files: [],
    followRedirects: false,
    maxRedirects: 10,
    insecure: true,
    timeoutMs: 0,
    connectTimeoutMs: 0,
    extraArgs: [],
  });
  assertEquals(argv.includes("--cookie"), false);
  assertEquals(argv.includes("--cookie-jar"), false);
  assertEquals(argv.includes("--no-location"), true);
  assertEquals(argv.includes("--insecure"), true);
  assertEquals(argv.includes("--max-time"), false);
});

Deno.test("redactArgv masks user, cookie and redacted headers", () => {
  const set = new Set(["x-api-key"]);
  const out = redactArgv(
    [
      "curl",
      "--user",
      "u:p",
      "--cookie",
      "sid=abc",
      "--cookie",
      "/home/me/.swamp/curl/http/cookies.txt",
      "--header",
      "X-Api-Key: sec",
      "--header",
      "Accept: json",
    ],
    set,
  );
  assertEquals(out[out.indexOf("--user") + 1], "***");
  assertEquals(out.includes("sid=abc"), false);
  assertEquals(out.includes("/home/me/.swamp/curl/http/cookies.txt"), true);
  assertEquals(out.includes("X-Api-Key: ***"), true);
  assertEquals(out.includes("X-Api-Key: sec"), false);
  assertEquals(out.includes("Accept: json"), true);
});

// ---------------------------------------------------------------------------
// Process output helpers
// ---------------------------------------------------------------------------

Deno.test("parseWriteOut parses the %{json} block and tolerates junk", () => {
  assertEquals(parseWriteOut('{"http_code":204,"size_download":0}'), {
    http_code: 204,
    size_download: 0,
  });
  assertEquals(parseWriteOut("not json"), {});
  assertEquals(parseWriteOut(""), {});
});

Deno.test("decodeCapped truncates at the cap and reports it", () => {
  const bytes = new TextEncoder().encode("hello world");
  assertEquals(decodeCapped(bytes, 5), { text: "hello", truncated: true });
  assertEquals(decodeCapped(bytes, 100), {
    text: "hello world",
    truncated: false,
  });
  assertEquals(decodeCapped(bytes, 0), { text: "", truncated: true });
});

// ---------------------------------------------------------------------------
// Integration (real curl against a local server)
// ---------------------------------------------------------------------------

interface Captured {
  specName: string;
  name: string;
  data: Record<string, unknown>;
}

function makeContext(
  globals: Record<string, unknown>,
  modelName = "curl",
) {
  const written: Captured[] = [];
  const files: Record<string, Uint8Array> = {};
  const context = {
    globalArgs: model.globalArguments.parse(globals),
    definition: { id: "test", name: modelName, version: "1" },
    logger: { info: () => {}, warn: () => {} },
    writeResource: (
      specName: string,
      name: string,
      data: Record<string, unknown>,
    ) => {
      written.push({ specName, name, data });
      return Promise.resolve({ name });
    },
    createFileWriter: (specName: string, name: string) => ({
      writeAll: (bytes: Uint8Array) => {
        files[name] = bytes;
        written.push({ specName, name, data: { bytes: bytes.byteLength } });
        return Promise.resolve({ name });
      },
    }),
  };
  return { context, written, files };
}

async function withServer<T>(
  handler: (
    req: Request,
    info: Deno.ServeHandlerInfo,
  ) => Response | Promise<Response>,
  fn: (base: string) => Promise<T>,
): Promise<T> {
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    handler,
  );
  const { port } = server.addr;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await server.shutdown();
  }
}

async function newStateDir(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "curl-test-" });
}

function fastGlobals(stateDir: string, extra: Record<string, unknown> = {}) {
  return { stateDir, timeoutMs: 15000, connectTimeoutMs: 5000, ...extra };
}

/** Parse `request`/`get`/`post` args the way swamp does (applying defaults). */
function reqArgs(partial: Record<string, unknown>) {
  return model.methods.request.arguments.parse(partial);
}

/** Parse `cookie-jar` args the way swamp does. */
function jarArgs(partial: Record<string, unknown>) {
  return model.methods["cookie-jar"].arguments.parse(partial);
}

Deno.test("request performs a GET and records headers, body and status", async () => {
  const dir = await newStateDir();
  try {
    const { context, written } = makeContext(fastGlobals(dir));
    await withServer((req) => {
      const url = new URL(req.url);
      return new Response(
        JSON.stringify({ path: url.pathname, q: url.search }),
        {
          headers: { "content-type": "application/json", "x-served": "yes" },
        },
      );
    }, async (base) => {
      await model.methods.request.execute(
        reqArgs({
          url: `${base}/hello`,
          method: "GET",
          headers: ["X-Api-Key: supersecret"],
          query: { a: "1" },
          label: "probe",
        }),
        context,
      );
    });
    const rec = written.find((w) => w.specName === "request")!.data;
    assertEquals(rec.status, 200);
    assertEquals(rec.ok, true);
    assertEquals(rec.label, "probe");
    assertEquals((rec.body as string).includes("/hello"), true);
    const headers = rec.requestHeaders as string[];
    assertEquals(headers.some((l) => l.startsWith("User-Agent:")), true);
    assertEquals(headers.includes("X-Api-Key: ***"), true);
    const respHeaders = rec.responseHeaders as Record<string, string>;
    assertEquals(respHeaders["x-served"], "yes");
    const command = rec.command as string[];
    assertEquals(command.some((c) => c === "X-Api-Key: ***"), true);
    assertEquals(command.includes("supersecret"), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("request persists cookies in the jar and reuses them", async () => {
  const dir = await newStateDir();
  try {
    const { context, written } = makeContext(fastGlobals(dir));
    await withServer((req) => {
      const url = new URL(req.url);
      if (url.pathname === "/set") {
        return new Response("ok", {
          headers: { "set-cookie": "sid=abc123; Path=/" },
        });
      }
      return new Response(`cookie=${req.headers.get("cookie") ?? ""}`);
    }, async (base) => {
      await model.methods.get.execute(
        reqArgs({ url: `${base}/set`, label: "one" }),
        context,
      );
      await model.methods.get.execute(
        reqArgs({ url: `${base}/read`, label: "two" }),
        context,
      );
    });
    const first = written.find((w) => w.name === "one")!.data;
    const second = written.find((w) => w.name === "two")!.data;
    const received = first.cookiesReceived as Record<string, unknown>[];
    assertEquals(received.some((c) => c.name === "sid"), true);
    const sent = second.cookiesSent as Record<string, unknown>[];
    assertEquals(
      sent.some((c) => c.name === "sid" && c.source === "jar"),
      true,
    );
    assertEquals((second.body as string).includes("sid=abc123"), true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("request records a redirect chain", async () => {
  const dir = await newStateDir();
  try {
    const { context, written } = makeContext(fastGlobals(dir));
    await withServer((req) => {
      const url = new URL(req.url);
      if (url.pathname === "/start") {
        return Response.redirect(`${url.origin}/end`, 302);
      }
      return new Response("arrived");
    }, async (base) => {
      await model.methods.get.execute(
        reqArgs({ url: `${base}/start`, label: "redir" }),
        context,
      );
    });
    const rec = written.find((w) => w.name === "redir")!.data;
    const redirects = rec.redirects as Record<string, unknown>[];
    assertEquals(redirects.length, 1);
    assertEquals(redirects[0].status, 302);
    assertEquals((redirects[0].location as string).endsWith("/end"), true);
    assertEquals(rec.status, 200);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("request saves the body as a file resource when asked", async () => {
  const dir = await newStateDir();
  try {
    const { context, written, files } = makeContext(fastGlobals(dir));
    await withServer(() => new Response("binary-ish payload"), async (base) => {
      await model.methods.get.execute(
        reqArgs({ url: `${base}/body`, label: "saved", saveBody: true }),
        context,
      );
    });
    assertEquals(written.some((w) => w.specName === "body"), true);
    const bytes = files["body-saved"];
    assertEquals(new TextDecoder().decode(bytes), "binary-ish payload");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("request writes the record then throws when failOnHttpError is set", async () => {
  const dir = await newStateDir();
  try {
    const { context, written } = makeContext(fastGlobals(dir));
    await withServer(
      () => new Response("boom", { status: 500 }),
      async (base) => {
        await assertRejects(
          () =>
            model.methods.get.execute(
              reqArgs({
                url: `${base}/boom`,
                label: "fail",
                failOnHttpError: true,
              }),
              context,
            ),
          Error,
          "HTTP 500",
        );
      },
    );
    const rec = written.find((w) => w.name === "fail")!.data;
    assertEquals(rec.status, 500);
    assertEquals(rec.ok, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("cookie-jar reports and clears the jar", async () => {
  const dir = await newStateDir();
  try {
    const { context, written } = makeContext(fastGlobals(dir));
    await withServer(() => {
      return new Response("ok", { headers: { "set-cookie": "a=1; Path=/" } });
    }, async (base) => {
      await model.methods.get.execute(reqArgs({ url: `${base}/x` }), context);
    });
    await model.methods["cookie-jar"].execute(
      jarArgs({ clear: false, raw: false }),
      context,
    );
    const info = written.find((w) => w.specName === "cookieJar")!.data;
    assertEquals(info.exists, true);
    assertEquals(info.count, 1);
    await model.methods["cookie-jar"].execute(
      jarArgs({ clear: true, raw: false }),
      context,
    );
    const cleared = written.filter((w) => w.specName === "cookieJar").at(-1)!
      .data;
    assertEquals(cleared.cleared, true);
    const afterClear = await model.methods["cookie-jar"].execute(
      jarArgs({ clear: false, raw: false }),
      context,
    );
    assertEquals(afterClear.dataHandles.length, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("request rejects multiple body sources", async () => {
  const dir = await newStateDir();
  try {
    const { context } = makeContext(fastGlobals(dir));
    await assertRejects(
      () =>
        model.methods.post.execute(
          reqArgs({
            url: "http://127.0.0.1:1/x",
            data: "a",
            dataJson: { b: 1 },
          }),
          context,
        ),
      Error,
      "only one request body source",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("get and post defaults pick the right method", async () => {
  const dir = await newStateDir();
  try {
    const { context, written } = makeContext(fastGlobals(dir));
    await withServer((req) => new Response(req.method), async (base) => {
      await model.methods.get.execute(
        reqArgs({ url: `${base}/g`, label: "g" }),
        context,
      );
      await model.methods.post.execute(
        reqArgs({ url: `${base}/p`, label: "p" }),
        context,
      );
    });
    assertEquals(written.find((w) => w.name === "g")!.data.method, "GET");
    assertEquals(written.find((w) => w.name === "p")!.data.method, "POST");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("request records a non-2xx response without failing by default", async () => {
  const dir = await newStateDir();
  try {
    const { context, written } = makeContext(fastGlobals(dir));
    await withServer(
      () => new Response("nope", { status: 404 }),
      async (base) => {
        await model.methods.get.execute(
          reqArgs({ url: `${base}/missing`, label: "404" }),
          context,
        );
      },
    );
    const rec = written.find((w) => w.name === "404")!.data;
    assertEquals(rec.status, 404);
    assertEquals(rec.ok, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Multipart (form-data) requests
// ---------------------------------------------------------------------------

Deno.test("buildCurlArgs emits multipart fields and file uploads", () => {
  const argv = buildCurlArgs({
    url: "https://dt.example/api/v1/bom",
    method: "POST",
    headers: [],
    headerFile: "/tmp/h",
    bodyFile: "/tmp/b",
    cookieJar: "",
    reuseCookies: false,
    explicitCookies: "",
    multipart: [["autoCreate", "true"], ["projectName", "host"]],
    files: [["bom", "/tmp/sbom.json"]],
    followRedirects: true,
    maxRedirects: 10,
    insecure: false,
    timeoutMs: 0,
    connectTimeoutMs: 0,
    extraArgs: [],
  });
  assertEquals(argv.filter((a) => a === "--form").length, 3);
  assertEquals(argv.includes("autoCreate=true"), true);
  assertEquals(argv.includes("projectName=host"), true);
  assertEquals(argv.includes("bom=@/tmp/sbom.json"), true);
});

Deno.test("redactArgv masks redacted --form values but keeps file paths", () => {
  const set = new Set(["authorization"]);
  const out = redactArgv(
    ["curl", "--form", "authorization=secret", "--form", "bom=@/tmp/x"],
    set,
  );
  assertEquals(out.includes("authorization=***"), true);
  assertEquals(out.includes("authorization=secret"), false);
  assertEquals(out.includes("bom=@/tmp/x"), true);
});

Deno.test("request sends a multipart/form-data upload and records it", async () => {
  const dir = await newStateDir();
  try {
    const { context, written } = makeContext(fastGlobals(dir));
    const file = `${dir}/sbom.json`;
    await Deno.writeTextFile(file, '{"x":1}');
    await withServer(async (req) => {
      const form = await req.formData();
      const bom = form.get("bom");
      const size = bom instanceof File ? bom.size : 0;
      return new Response(
        JSON.stringify({ autoCreate: form.get("autoCreate"), bomBytes: size }),
        { headers: { "content-type": "application/json" } },
      );
    }, async (base) => {
      await model.methods.post.execute(
        reqArgs({
          url: `${base}/api/v1/bom`,
          label: "upload",
          multipart: { autoCreate: "true", projectName: "host" },
          files: { bom: file },
        }),
        context,
      );
    });
    const rec = written.find((w) => w.name === "upload")!.data;
    assertEquals(rec.status, 200);
    const body = JSON.parse(rec.body as string);
    assertEquals(body.autoCreate, "true");
    assertEquals(body.bomBytes, 7);
    const fields = rec.multipartFields as Record<string, unknown>[];
    assertEquals(
      fields.some((f) => f.name === "projectName" && f.value === "host"),
      true,
    );
    const uploads = rec.uploadFiles as Record<string, unknown>[];
    assertEquals(uploads.some((f) => f.name === "bom" && f.bytes === 7), true);
    assertEquals((rec.command as string[]).includes(`bom=@${file}`), true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("request records a redacted multipart field value", async () => {
  const dir = await newStateDir();
  try {
    const { context, written } = makeContext(fastGlobals(dir));
    await withServer(() => new Response("ok"), async (base) => {
      await model.methods.post.execute(
        reqArgs({
          url: `${base}/x`,
          label: "masked",
          multipart: { authorization: "supersecret" },
        }),
        context,
      );
    });
    const rec = written.find((w) => w.name === "masked")!.data;
    const fields = rec.multipartFields as Record<string, unknown>[];
    assertEquals(fields[0].value, "***");
    const command = rec.command as string[];
    assertEquals(command.includes("authorization=***"), true);
    assertEquals(command.includes("authorization=supersecret"), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
