/** Tests for the swamp-ide capability policy. */
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  authorizationFromLease,
  blockedAuthorization,
  classifyCall,
  commandAlternatives,
  formatAuthorization,
  guardPlan,
  isBroadScope,
  isProtectedPath,
  isShellWrapper,
  leaseAllows,
  matchingFeature,
  notRequiredAuthorization,
  scopeCovers,
  writeInputProblem,
} from "./pi/swamp-ide-policy.ts";

const home = "/home/sven";
const cwd = "/home/sven/src/swamp-project";

Deno.test("protected paths cover the addin, guard, Herdr UI and state", () => {
  assert(isProtectedPath("/home/sven/.pi/agent/extensions/swamp-ide.ts", home));
  assert(
    isProtectedPath(
      "/home/sven/.config/herdr-app/mods/swamp-ide/main.js",
      home,
    ),
  );
  assert(
    isProtectedPath(
      "/home/sven/.config/herdr-app/layouts/swamp-ide.json",
      home,
    ),
  );
  assert(
    isProtectedPath("/home/sven/.local/state/swamp-agent-ide/lease.json", home),
  );
  assert(
    isProtectedPath(`${cwd}/extensions/models/swamp-ide/swamp_ide.ts`, home),
  );
  assert(!isProtectedPath(`${cwd}/src/app.ts`, home));
});

Deno.test("read-only calls do not require a lease", () => {
  assertEquals(
    classifyCall({ system: "herdr-core", method: "file-read", home }).mutating,
    false,
  );
  assertEquals(
    classifyCall({ system: "herdr-core", method: "search", home }).mutating,
    false,
  );
  assertEquals(
    classifyCall({ system: "vim", method: "read", home }).mutating,
    false,
  );
  assertEquals(
    classifyCall({ system: "swamp", model: "ide-pi", method: "status", home })
      .mutating,
    false,
  );
});

Deno.test("protected writes and lifecycle methods require exact scopes", () => {
  const write = classifyCall({
    system: "herdr-core",
    method: "file-write",
    input: { path: "/home/sven/.pi/agent/extensions/swamp-ide.ts" },
    canonicalPath: "/home/sven/.pi/agent/extensions/swamp-ide.ts",
    home,
  });
  assertEquals(write.mutating, true);
  assertEquals(
    write.scope,
    "protected:/home/sven/.pi/agent/extensions/swamp-ide.ts",
  );

  const lifecycle = classifyCall({
    system: "swamp",
    model: "ide-pi",
    method: "set",
    home,
  });
  assertEquals(lifecycle.mutating, true);
  assertEquals(lifecycle.scope, "swamp:ide-pi.set");

  const exec = classifyCall({
    system: "herdr-core",
    method: "exec",
    home,
    commandHash: "abc123",
  });
  assertEquals(exec.scope, "exec:abc123");

  const vim = classifyCall({ system: "vim", method: "edit", home });
  assertEquals(vim.scope, "vim:edit");

  const file = classifyCall({
    system: "herdr-core",
    method: "file-edit",
    input: { path: `${cwd}/AGENTS.md` },
    canonicalPath: `${cwd}/AGENTS.md`,
    home,
  });
  assertEquals(file.scope, `file:${cwd}/AGENTS.md`);
});

Deno.test("a missing tracker degrades to the baseline tools, never to none", () => {
  const plan = guardPlan(["read", "bash", "edit"]);
  assertEquals(plan.hasSwampIde, false);
  assertEquals(plan.enforcing, false);
  assertEquals(plan.activeTools, ["read", "bash", "edit"]);
  assert(plan.reason.includes("tracking off"));

  const empty = guardPlan([]);
  assertEquals(empty.enforcing, false);
  assertEquals(empty.activeTools, [], "caller must leave the tool set alone");
});

Deno.test("a registered tracker is enforced alone", () => {
  const plan = guardPlan(["read", "bash", "swamp_ide"]);
  assertEquals(plan.hasSwampIde, true);
  assertEquals(plan.enforcing, true);
  assertEquals(plan.activeTools, ["swamp_ide"]);
});

Deno.test("authorization records and text are stable", () => {
  const lease = {
    session: "s1",
    scopes: ["protected:/home/sven/.pi/agent/extensions/swamp-ide.ts"],
    scopeExpiry: {
      "protected:/home/sven/.pi/agent/extensions/swamp-ide.ts":
        "2099-01-01T00:00:00.000Z",
    },
    features: {
      "swamp-ide-dialog": {
        scopes: ["protected:/home/sven/.pi/agent/extensions/swamp-ide.ts"],
        expiresAt: "2099-01-01T00:00:00.000Z",
        purpose: "Edit the gate",
      },
    },
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
  assertEquals(
    matchingFeature(
      lease,
      "protected:/home/sven/.pi/agent/extensions/swamp-ide.ts",
    )
      ?.name,
    "swamp-ide-dialog",
  );
  assertEquals(
    formatAuthorization(
      authorizationFromLease(
        lease,
        "protected:/home/sven/.pi/agent/extensions/swamp-ide.ts",
        "lease",
      ),
    ),
    "Authorization: allowed by existing lease `swamp-ide-dialog` (until revoked); this exact scope was already covered.",
  );
  assertEquals(
    formatAuthorization(
      authorizationFromLease(
        lease,
        "protected:/home/sven/.pi/agent/extensions/swamp-ide.ts",
        "dialog",
        "approve",
      ),
    ),
    "Authorization: allowed because you approved the Herdr dialog; a lease now covers this exact scope `swamp-ide-dialog` (until revoked).",
  );
  assertEquals(
    formatAuthorization(notRequiredAuthorization("read-only herdr-core call")),
    "Authorization: not required; read-only herdr-core call.",
  );
  assertEquals(
    formatAuthorization(
      blockedAuthorization(
        "exec:abc",
        "timeout",
        "the Herdr dialog was not answered before the 120s timeout",
      ),
    ),
    "Authorization: blocked; the Herdr dialog was not answered before the 120s timeout.",
  );
});

Deno.test("the latest matching feature wins over an expired one", () => {
  const now = Date.now();
  const scope = "protected:/home/sven/.pi/agent/extensions/swamp-ide.ts";
  const lease = {
    session: "s1",
    scopes: [scope],
    features: {
      old: {
        scopes: [scope],
        expiresAt: new Date(now - 60_000).toISOString(),
      },
      fresh: {
        scopes: [scope],
        expiresAt: new Date(now + 60_000).toISOString(),
      },
    },
    expiresAt: new Date(now + 60_000).toISOString(),
  };
  assert(leaseAllows(lease, scope, "s1", now));
  assertEquals(matchingFeature(lease, scope)?.name, "fresh");
});

Deno.test("features are bound to their requesting session", () => {
  const now = Date.now();
  const scope = "file:/tmp/shared";
  const lease = {
    session: "session-a",
    scopes: [scope],
    scopeExpiry: { [scope]: "2099-01-01T00:00:00.000Z" },
    features: {
      a: {
        scopes: [scope],
        session: "session-a",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
      b: {
        scopes: [scope],
        session: "session-b",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    },
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
  assert(leaseAllows(lease, scope, "session-a", now));
  assert(leaseAllows(lease, scope, "session-b", now));
  assert(!leaseAllows(lease, scope, "session-c", now));
});

Deno.test("write methods require path, not paths", () => {
  assertEquals(
    writeInputProblem("herdr-core", "file-edit", { path: "/tmp/a" }),
    "",
  );
  assert(
    writeInputProblem("herdr-core", "file-edit", { paths: ["/tmp/a"] })
      .includes("single `path`"),
  );
  assert(
    writeInputProblem("herdr-core", "file-write", {
      path: "/tmp/a",
      paths: ["/tmp/a"],
    }).includes("both"),
  );
  assertEquals(
    writeInputProblem("herdr-core", "file-read", { paths: ["/tmp/a"] }),
    "",
  );
});

Deno.test("a directory grant covers files below it, not prefixes", () => {
  assert(scopeCovers(`dir:${cwd}`, `file:${cwd}/AGENTS.md`));
  assert(
    scopeCovers(
      `dir:${cwd}/src`,
      "file:/home/sven/src/swamp-project/src/nested/app.ts",
    ),
  );
  assert(
    !scopeCovers(`dir:${cwd}`, "file:/home/sven/src/swamp-project-other/x"),
  );
  assert(!scopeCovers("dir:/", `file:${cwd}/AGENTS.md`));
  assert(!scopeCovers(`dir:${cwd}`, `file:${cwd}`));
  assert(!scopeCovers(`dir:${cwd}`, "protected:/home/sven/.pi/x"));
});

Deno.test("a directory feature authorizes an exact file scope", () => {
  const now = Date.now();
  const scope = `file:${cwd}/AGENTS.md`;
  const directory = `dir:${cwd}`;
  const lease = {
    session: "s1",
    scopes: [directory],
    scopeExpiry: { [directory]: new Date(now + 60_000).toISOString() },
    features: {
      "approval:directory": {
        scopes: [directory],
        session: "s1",
        expiresAt: new Date(now + 60_000).toISOString(),
      },
    },
    expiresAt: new Date(now + 60_000).toISOString(),
  };
  assert(leaseAllows(lease, scope, "s1", now));
  assertEquals(matchingFeature(lease, scope)?.name, "approval:directory");
  assertEquals(
    authorizationFromLease(lease, scope, "lease").feature,
    "approval:directory",
  );
  assert(!leaseAllows(lease, "file:/tmp/elsewhere", "s1", now));
});

Deno.test("broad scopes are rejected as too broad", () => {
  assert(isBroadScope("file-edit"));
  assert(isBroadScope("protected"));
  assert(isBroadScope("all"));
  assert(isBroadScope("exec"));
  assert(isBroadScope("dir:/"));
  assert(!isBroadScope("file:/home/sven/src/swamp-project/AGENTS.md"));
  assert(
    !isBroadScope("protected:/home/sven/.pi/agent/extensions/swamp-ide.ts"),
  );
  assert(!isBroadScope("exec:abc123"));
});

Deno.test("known shell programs map to internal swamp_ide methods", () => {
  assertEquals(commandAlternatives(["rg", "pattern"])[0]?.method, "search");
  assertEquals(commandAlternatives(["cat", "file"])[0]?.method, "file-read");
  assertEquals(
    commandAlternatives(["sed", "-i", "s/a/b/", "file"])[0]?.method,
    "file-edit",
  );
  assertEquals(commandAlternatives(["git", "status"]).length, 0);
});

Deno.test("shell wrappers cannot hide commands", () => {
  assert(isShellWrapper(["sh", "-c", "echo hi"]));
  assert(isShellWrapper(["/bin/bash", "-c", "echo hi"]));
  assert(!isShellWrapper(["sh", "-x"]));
  assert(!isShellWrapper(["echo", "-c", "hi"]));
});

Deno.test("leases are scoped, session-bound and expiring", () => {
  const now = Date.now();
  const lease = {
    session: "s1",
    scope: "exec",
    expiresAt: new Date(now + 60_000).toISOString(),
  };
  assert(leaseAllows(lease, "exec", "s1", now));
  assert(!leaseAllows(lease, "exec", "s2", now));
  assert(!leaseAllows(lease, "run", "s1", now));
  assert(!leaseAllows(lease, "exec", "s1", now + 61_000));

  const broad = {
    session: "s1",
    scopes: ["protected"],
    expiresAt: new Date(now + 60_000).toISOString(),
  };
  assert(
    !leaseAllows(
      {
        session: "s1",
        scopes: ["protected"],
        expiresAt: new Date(now + 60_000).toISOString(),
      },
      "protected:/home/sven/.pi/agent/extensions/swamp-ide.ts",
      "s1",
      now,
    ),
  );
  assert(
    leaseAllows(
      {
        session: "s1",
        scopes: [`file:${cwd}/AGENTS.md`],
        expiresAt: new Date(now + 60_000).toISOString(),
      },
      `file:${cwd}/AGENTS.md`,
      "s1",
      now,
    ),
  );
  assert(!leaseAllows(broad, "exec", "s1", now));
});
