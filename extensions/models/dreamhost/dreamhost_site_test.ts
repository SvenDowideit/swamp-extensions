import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1";

import {
  buildRsyncArgs,
  buildSshTransport,
  type CommandRunner,
  executeCheck,
  executeDeploy,
  executeInspect,
  expandHome,
  normalizeRemotePath,
  parseItemizedChanges,
  parseLsOutput,
  parseTransferredBytes,
  resolveRemotePath,
  type RsyncDeployOptions,
  shellQuote,
  summarizeChanges,
} from "./dreamhost_site.ts";

import { model } from "./dreamhost_site.ts";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

Deno.test("expandHome expands a leading ~", () => {
  assertEquals(expandHome("~", "/home/u"), "/home/u");
  assertEquals(expandHome("~/.ssh/id", "/home/u"), "/home/u/.ssh/id");
  assertEquals(expandHome("/abs/path", "/home/u"), "/abs/path");
});

Deno.test("shellQuote wraps and escapes single quotes", () => {
  assertEquals(shellQuote("simple"), "'simple'");
  assertEquals(shellQuote("a b"), "'a b'");
  assertEquals(shellQuote("it's"), `'it'\\''s'`);
  assertEquals(shellQuote("$HOME; rm -rf /"), "'$HOME; rm -rf /'");
});

Deno.test("normalizeRemotePath preserves a meaningful trailing slash", () => {
  assertEquals(normalizeRemotePath("~/example.com/"), "~/example.com/");
  assertEquals(normalizeRemotePath("  ~/example.com  "), "~/example.com");
  assertThrows(() => normalizeRemotePath("   "), Error, "must not be empty");
});

Deno.test("resolveRemotePath prefers the argument, then the global default", () => {
  assertEquals(resolveRemotePath("~/a/", "~/b/"), "~/a/");
  assertEquals(resolveRemotePath(undefined, "~/b/"), "~/b/");
  assertThrows(
    () => resolveRemotePath(undefined, undefined),
    Error,
    "No remote path",
  );
});

Deno.test("buildSshTransport builds an rsync -e transport string", () => {
  assertEquals(
    buildSshTransport({ host: "h", user: "u", port: 22, sshOptions: [] }),
    "ssh -p 22",
  );
  assertEquals(
    buildSshTransport({
      host: "h",
      user: "u",
      port: 2222,
      identityFile: "/k",
      sshOptions: ["StrictHostKeyChecking=accept-new"],
    }),
    "ssh -p 2222 -i /k -o StrictHostKeyChecking=accept-new",
  );
});

Deno.test("buildRsyncArgs produces archive, itemize, stats, exclusions, and target", () => {
  const opts: RsyncDeployOptions = {
    host: "example.com",
    user: "sven",
    port: 22,
    sshOptions: [],
    localPath: "/srv/site",
    remotePath: "~/example.com/",
    delete: true,
    dryRun: true,
    excludes: [".git/", "*.map"],
    rsyncArgs: ["--compress"],
    remoteCommand: "rsync",
  };
  const args = buildRsyncArgs(opts);
  assertEquals(args[0], "-a");
  assertEquals(args.includes("--itemize-changes"), true);
  assertEquals(args.includes("--stats"), true);
  assertEquals(args.includes("-n"), true);
  assertEquals(args.includes("--delete"), true);
  assertEquals(args.includes("--exclude=.git/"), true);
  assertEquals(args.includes("--exclude=*.map"), true);
  assertEquals(args.includes("--compress"), true);
  // Local path gets a trailing slash so contents (not the dir) are copied.
  assertEquals(args[args.length - 2], "/srv/site/");
  assertEquals(args[args.length - 1], "sven@example.com:~/example.com/");
});

Deno.test("buildRsyncArgs omits --delete and -n by default", () => {
  const args = buildRsyncArgs({
    host: "h",
    user: "u",
    port: 22,
    sshOptions: [],
    localPath: "./site",
    remotePath: "~/site/",
    delete: false,
    dryRun: false,
    excludes: [],
    rsyncArgs: [],
    remoteCommand: "rsync",
  });
  assertEquals(args.includes("--delete"), false);
  assertEquals(args.includes("-n"), false);
});

Deno.test("buildRsyncArgs adds --rsync-path only for a non-default remote binary", () => {
  const base = {
    host: "h",
    user: "u",
    port: 22,
    sshOptions: [],
    localPath: "./site",
    remotePath: "~/site/",
    delete: false,
    dryRun: false,
    excludes: [],
    rsyncArgs: [],
  };
  assertEquals(
    buildRsyncArgs({ ...base, remoteCommand: "rsync" }).includes(
      "--rsync-path",
    ),
    false,
  );
  const custom = buildRsyncArgs({ ...base, remoteCommand: "/opt/rsync" });
  const idx = custom.indexOf("--rsync-path");
  assertEquals(idx >= 0, true);
  assertEquals(custom[idx + 1], "/opt/rsync");
});

// ---------------------------------------------------------------------------
// rsync output parsing (vectors captured from real rsync 3.x)
// ---------------------------------------------------------------------------

Deno.test("parseItemizedChanges classifies real rsync itemize output", () => {
  const output = [
    ">f+++++++++ a.html",
    "cd+++++++++ sub/",
    ">f+++++++++ sub/b.css",
    ".d..t...... ./",
    ">f.s....... a.html",
    "*deleting   sub/b.css",
  ].join("\n");
  const items = parseItemizedChanges(output);
  assertEquals(items, [
    { action: "added", path: "a.html" },
    { action: "added", path: "sub/b.css" },
    { action: "modified", path: "a.html" },
    { action: "deleted", path: "sub/b.css" },
  ]);
  // Directory entries (cd..., .d...) are excluded.
  assertEquals(summarizeChanges(items), {
    added: 2,
    modified: 1,
    deleted: 1,
    unchanged: 0,
  });
});

Deno.test("parseItemizedChanges treats all-dot flags as unchanged", () => {
  const items = parseItemizedChanges(">f......... a.html\n");
  assertEquals(items, [{ action: "unchanged", path: "a.html" }]);
});

Deno.test("parseItemizedChanges ignores summaries, banners, and errors", () => {
  const output = [
    "",
    "sending incremental file list",
    "sent 130 bytes  received 13 bytes  286.00 bytes/sec",
    "total size is 12  speedup is 0.08",
    "rsync: connection unexpectedly closed",
  ].join("\n");
  assertEquals(parseItemizedChanges(output), []);
});

Deno.test("parseItemizedChanges handles CRLF and trailing whitespace", () => {
  const items = parseItemizedChanges(">f+++++++++ a.html   \r\n");
  assertEquals(items, [{ action: "added", path: "a.html" }]);
});

Deno.test("parseTransferredBytes sums sent and received", () => {
  assertEquals(
    parseTransferredBytes(
      "sent 1,234 bytes  received 56 bytes  100.00 bytes/sec",
    ),
    1290,
  );
  assertEquals(parseTransferredBytes("no stats here"), 0);
});

Deno.test("parseLsOutput extracts entries and totals regular-file bytes", () => {
  const output = [
    "total 12",
    "-rw-r--r-- 1 u g 1024 Jan  1 00:00 index.html",
    "drwxr-xr-x 2 u g 4096 Jan  1 00:00 assets",
    "-rw-r--r-- 1 u g  512 Jan  1 00:00 style.css",
  ].join("\n");
  const { entries, totalBytes } = parseLsOutput(output);
  assertEquals(entries.length, 3);
  assertEquals(totalBytes, 1536);
  assertEquals(entries[0], {
    mode: "-rw-r--r--",
    size: 1024,
    name: "index.html",
  });
  assertEquals(entries[1].mode.startsWith("d"), true);
});

// ---------------------------------------------------------------------------
// Method cores with an injected runner
// ---------------------------------------------------------------------------

function makeRunner(
  handler: (bin: string, args: string[]) => {
    stdout: string;
    stderr: string;
    code: number;
  },
) {
  const calls: Array<
    { bin: string; args: string[]; env?: Record<string, string> }
  > = [];
  const runner: CommandRunner = (bin, args, opts) => {
    calls.push({ bin, args, env: opts?.env });
    return Promise.resolve(handler(bin, args));
  };
  return { runner, calls };
}

const baseGlobals = model.globalArguments.parse({
  host: "example.com",
  user: "sven",
  remotePath: "~/example.com/",
});

Deno.test("executeDeploy parses changes and reports the outcome", async () => {
  const { runner, calls } = makeRunner(() => ({
    stdout: [
      ">f+++++++++ index.html",
      ">f.s....... style.css",
      "sent 900 bytes  received 30 bytes  100.00 bytes/sec",
    ].join("\n"),
    stderr: "",
    code: 0,
  }));
  const outcome = await executeDeploy(
    baseGlobals,
    model.methods.deploy.arguments.parse({ localPath: "./site" }),
    runner,
  );
  assertEquals(outcome.added, 1);
  assertEquals(outcome.modified, 1);
  assertEquals(outcome.changed, true);
  assertEquals(outcome.bytesTransferred, 930);
  assertEquals(outcome.remotePath, "~/example.com/");
  assertEquals(calls[0].bin, "rsync");
  assertEquals(
    calls[0].args[calls[0].args.length - 1],
    "sven@example.com:~/example.com/",
  );
});

Deno.test("executeDeploy throws a descriptive error on non-zero exit", async () => {
  const { runner } = makeRunner(() => ({
    stdout: "",
    stderr: 'rsync: [sender] change_dir "/missing" failed: No such file',
    code: 23,
  }));
  await assertRejects(
    () =>
      executeDeploy(
        baseGlobals,
        model.methods.deploy.arguments.parse({ localPath: "./site" }),
        runner,
      ),
    Error,
    "failed (23)",
  );
});

Deno.test("executeDeploy reports no change when nothing transfered", async () => {
  const { runner } = makeRunner(() => ({
    stdout: "sent 100 bytes  received 20 bytes  50.00 bytes/sec",
    stderr: "",
    code: 0,
  }));
  const outcome = await executeDeploy(
    baseGlobals,
    model.methods.deploy.arguments.parse({ localPath: "./site" }),
    runner,
  );
  assertEquals(outcome.changed, false);
  assertEquals(outcome.added + outcome.modified + outcome.deleted, 0);
});

Deno.test("executeDeploy passes sshpass when a password is configured", async () => {
  const g = model.globalArguments.parse({
    host: "example.com",
    user: "sven",
    remotePath: "~/example.com/",
    password: "s3cret",
  });
  const { runner, calls } = makeRunner(() => ({
    stdout: "",
    stderr: "",
    code: 0,
  }));
  await executeDeploy(
    g,
    model.methods.deploy.arguments.parse({ localPath: "./site" }),
    runner,
  );
  assertEquals(calls[0].bin, "sshpass");
  assertEquals(calls[0].args[0], "-e");
  assertEquals(calls[0].args[1], "rsync");
  assertEquals(calls[0].env?.SSHPASS, "s3cret");
});

Deno.test("executeCheck reports connectivity and path existence", async () => {
  const { runner, calls } = makeRunner(() => ({
    stdout: "HOME=/home/sven\nREMOTE_EXISTS\n",
    stderr: "",
    code: 0,
  }));
  const outcome = await executeCheck(
    baseGlobals,
    model.methods.check.arguments.parse({}),
    runner,
  );
  assertEquals(outcome.connected, true);
  assertEquals(outcome.remoteExists, true);
  assertEquals(outcome.remoteHome, "/home/sven");
  assertEquals(calls[0].bin, "ssh");
  assertEquals(calls[0].args[0], "-p");
});

Deno.test("executeCheck reports a missing remote path", async () => {
  const { runner } = makeRunner(() => ({
    stdout: "HOME=/home/sven\nREMOTE_MISSING\n",
    stderr: "",
    code: 0,
  }));
  const outcome = await executeCheck(
    baseGlobals,
    model.methods.check.arguments.parse({}),
    runner,
  );
  assertEquals(outcome.connected, true);
  assertEquals(outcome.remoteExists, false);
});

Deno.test("executeInspect counts files, directories, and bytes", async () => {
  const { runner } = makeRunner(() => ({
    stdout: [
      "-rw-r--r-- 1 u g 1024 Jan  1 00:00 index.html",
      "drwxr-xr-x 2 u g 4096 Jan  1 00:00 assets",
    ].join("\n"),
    stderr: "",
    code: 0,
  }));
  const outcome = await executeInspect(
    baseGlobals,
    model.methods.inspect.arguments.parse({}),
    runner,
  );
  assertEquals(outcome.exists, true);
  assertEquals(outcome.fileCount, 1);
  assertEquals(outcome.directoryCount, 1);
  assertEquals(outcome.totalBytes, 1024);
});

Deno.test("executeInspect reports a non-directory as not existing", async () => {
  const { runner } = makeRunner(() => ({
    stdout: "",
    stderr: "NOT_A_DIRECTORY",
    code: 2,
  }));
  const outcome = await executeInspect(
    baseGlobals,
    model.methods.inspect.arguments.parse({}),
    runner,
  );
  assertEquals(outcome.exists, false);
  assertEquals(outcome.fileCount, 0);
});

// ---------------------------------------------------------------------------
// Model wiring
// ---------------------------------------------------------------------------

Deno.test("model exposes the expected resource specs and methods", () => {
  assertEquals(model.type, "@svendowideit/dreamhost/site");
  assertEquals(Object.keys(model.resources).sort(), [
    "check",
    "deploy",
    "inspect",
  ]);
  assertEquals(Object.keys(model.methods).sort(), [
    "check",
    "deploy",
    "inspect",
  ]);
});

Deno.test("valid-target check rejects an empty host and user", () => {
  const result = model.checks["valid-target"].execute({
    globalArgs: model.globalArguments.parse({ host: "", user: "" }),
    methodName: "deploy",
  } as never);
  assertEquals(result.pass, false);
  assertStringIncludes(result.errors?.join(" ") ?? "", "host");
  assertStringIncludes(result.errors?.join(" ") ?? "", "user");
});

Deno.test("deploy requires a remote path", async () => {
  const g = model.globalArguments.parse({ host: "h", user: "u" });
  const { runner } = makeRunner(() => ({ stdout: "", stderr: "", code: 0 }));
  await assertRejects(
    () =>
      executeDeploy(
        g,
        model.methods.deploy.arguments.parse({ localPath: "./s" }),
        runner,
      ),
    Error,
    "No remote path",
  );
});

Deno.test("global args reject unknown keys", () => {
  assertThrows(
    () => model.globalArguments.parse({ host: "h", user: "u", bogus: true }),
    Error,
  );
});

Deno.test("deploy arguments default delete and dryRun to false", () => {
  const parsed = model.methods.deploy.arguments.parse({ localPath: "./s" });
  assertEquals(parsed.delete, false);
  assertEquals(parsed.dryRun, false);
});

// Mechanical check: every method's written payload must conform to its
// resource schema (schema-write conformance). The cores return the payload the
// method writes, so they can be validated directly.
Deno.test("every written payload conforms to its resource schema", async () => {
  const ok = () => ({
    stdout:
      ">f+++ index.html\nsent 100 bytes  received 10 bytes  1.0 bytes/sec",
    stderr: "",
    code: 0,
  });

  const deployPayload = await executeDeploy(
    baseGlobals,
    model.methods.deploy.arguments.parse({ localPath: "./site" }),
    makeRunner(ok).runner,
  );
  const checkPayload = await executeCheck(
    baseGlobals,
    model.methods.check.arguments.parse({}),
    makeRunner(() => ({
      stdout: "HOME=/h\nREMOTE_EXISTS\n",
      stderr: "",
      code: 0,
    })).runner,
  );
  const inspectPayload = await executeInspect(
    baseGlobals,
    model.methods.inspect.arguments.parse({}),
    makeRunner(() => ({
      stdout: "-rw-r--r-- 1 u g 10 Jan  1 00:00 a.html",
      stderr: "",
      code: 0,
    })).runner,
  );

  const payloads: Array<[keyof typeof model.resources, unknown]> = [
    ["deploy", deployPayload],
    ["check", checkPayload],
    ["inspect", inspectPayload],
  ];
  for (const [spec, payload] of payloads) {
    const schema = model.resources[spec].schema;
    const record = payload as Record<string, unknown>;
    assertEquals(
      Object.keys(record).sort(),
      Object.keys(schema.shape).sort(),
      `${spec} payload fields must match the schema exactly`,
    );
    const parsed = schema.strict().safeParse(payload);
    assertEquals(
      parsed.success,
      true,
      `${spec} payload failed schema: ${
        parsed.success ? "" : JSON.stringify(parsed.error.issues)
      }`,
    );
  }
});
