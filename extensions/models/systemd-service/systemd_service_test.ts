import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1";
import {
  createModelTestContext,
  withMockedCommand,
} from "jsr:@swamp-club/swamp-testing@^0.3.0";

import {
  assertNoNewlines,
  assertValidServiceName,
  expandHome,
  isAlreadyStopped,
  model,
  parseCgroupPids,
  parseDeclaredPorts,
  parseSsListeners,
  renderAuditTable,
  renderServiceUnit,
  resolveCgroupRoot,
  stateFor,
} from "./systemd_service.ts";

Deno.test("expandHome expands a leading ~ to the home directory", () => {
  assertEquals(expandHome("~", "/home/alice"), "/home/alice");
  assertEquals(
    expandHome("~/.config/systemd/user", "/home/alice"),
    "/home/alice/.config/systemd/user",
  );
  assertEquals(
    expandHome("/usr/lib/systemd/user", "/home/alice"),
    "/usr/lib/systemd/user",
  );
});

Deno.test("renderServiceUnit renders a minimal unit with defaults", () => {
  const unit = renderServiceUnit({
    serviceName: "feedback-server",
    command: "~/.swamp/deno/deno run --allow-net scripts/feedback-server.ts",
    environment: [],
    restart: "on-failure",
    restartSec: "5",
    after: ["network-online.target"],
    wants: ["network-online.target"],
  });
  assertStringIncludes(unit, "[Unit]");
  assertStringIncludes(unit, "Description=feedback-server");
  assertStringIncludes(unit, "After=network-online.target");
  assertStringIncludes(unit, "Wants=network-online.target");
  assertStringIncludes(unit, "[Service]");
  assertStringIncludes(
    unit,
    "ExecStart=~/.swamp/deno/deno run --allow-net scripts/feedback-server.ts",
  );
  assertStringIncludes(unit, "Restart=on-failure");
  assertStringIncludes(unit, "RestartSec=5");
  assertStringIncludes(unit, "WantedBy=default.target");
});

Deno.test("renderServiceUnit includes description, working dir, and env", () => {
  const unit = renderServiceUnit({
    serviceName: "api",
    command: "/usr/bin/api --port 8080",
    description: "My API server",
    workingDirectory: "/srv/api",
    environment: ["PORT=8080", "LOG_LEVEL=info"],
    restart: "always",
    restartSec: "2",
    after: ["network-online.target", "multi-user.target"],
    wants: ["network-online.target"],
  });
  assertStringIncludes(unit, "Description=My API server");
  assertStringIncludes(unit, "WorkingDirectory=/srv/api");
  assertStringIncludes(unit, "Environment=PORT=8080");
  assertStringIncludes(unit, "Environment=LOG_LEVEL=info");
  assertStringIncludes(unit, "Restart=always");
  assertStringIncludes(unit, "RestartSec=2");
  assertStringIncludes(unit, "After=multi-user.target");
});

Deno.test("assertValidServiceName accepts ordinary unit names", () => {
  for (const n of ["feedback-server", "api", "my.service", "app_1"]) {
    assertValidServiceName(n);
  }
});

Deno.test("assertValidServiceName rejects path traversal and separators", () => {
  for (const n of ["../../escape", "a/b", "a\\b", "..", ".hidden", "x y", ""]) {
    let threw = false;
    try {
      assertValidServiceName(n);
    } catch {
      threw = true;
    }
    assertEquals(threw, true, `expected ${JSON.stringify(n)} to be rejected`);
  }
});

Deno.test("assertNoNewlines rejects directive injection", () => {
  for (const v of ["ok", "KEY=VALUE", "/srv/api"]) {
    assertNoNewlines("field", v);
  }
  for (const v of ["a\nb", "a\rb", "echo hi\nRunAsUser=root"]) {
    let threw = false;
    try {
      assertNoNewlines("field", v);
    } catch {
      threw = true;
    }
    assertEquals(threw, true, `expected ${JSON.stringify(v)} to be rejected`);
  }
});

Deno.test("renderServiceUnit rejects injected directives in every field", () => {
  const base = {
    serviceName: "svc",
    command: "echo hi",
    environment: [] as string[],
    restart: "no",
    restartSec: "5",
    after: [] as string[],
    wants: [] as string[],
  };
  const badInputs: Record<string, unknown>[] = [
    { ...base, command: "echo hi\nRunAsUser=root" },
    { ...base, description: "d\nUser=root" },
    { ...base, workingDirectory: "/tmp\nExecStart=/bin/sh" },
    { ...base, environment: ["A=1\nExecStartPre=/bin/evil"] },
    { ...base, after: ["network-online.target\nUser=root"] },
    { ...base, wants: ["network-online.target\nUser=root"] },
  ];
  for (const opts of badInputs) {
    let threw = false;
    try {
      // deno-lint-ignore no-explicit-any
      renderServiceUnit(opts as any);
    } catch {
      threw = true;
    }
    assertEquals(threw, true);
  }
});

Deno.test("renderServiceUnit rejects a traversal service name", () => {
  let threw = false;
  try {
    renderServiceUnit({
      serviceName: "../../escape",
      command: "echo hi",
      environment: [],
      restart: "no",
      restartSec: "5",
      after: [],
      wants: [],
    });
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("isAlreadyStopped treats a clean stop and an unloaded unit as success", () => {
  // Success.
  assertEquals(isAlreadyStopped({ stdout: "", stderr: "", code: 0 }), true);
  // "Unit … not loaded" (exit 5) is idempotent success.
  assertEquals(
    isAlreadyStopped({
      stdout: "",
      stderr: "Failed to stop x.service: Unit x.service not loaded.",
      code: 5,
    }),
    true,
  );
  // A genuine failure must still be reported.
  assertEquals(
    isAlreadyStopped({
      stdout: "",
      stderr: "Failed to connect to bus: No such file or directory",
      code: 1,
    }),
    false,
  );
  // Exit 5 but a different reason is not "already stopped".
  assertEquals(
    isAlreadyStopped({ stdout: "", stderr: "Access denied", code: 5 }),
    false,
  );
});

Deno.test("restartService restarts the unit and verifies it is active", async () => {
  const ctx = createModelTestContext({
    globalArgs: {
      denoPath: "~/.swamp/deno/deno",
      unitDir: "~/.config/systemd/user",
    },
    methodName: "restartService",
  });
  const calls: string[] = [];
  await withMockedCommand((command, args) => {
    calls.push([command, ...args].join(" "));
    if (args.includes("is-active") || args.includes("is-enabled")) {
      return { stdout: "active\n", code: 0 };
    }
    if (args.includes("restart")) return { stdout: "", code: 0 };
    return { stdout: "", code: 0 };
  }, async () => {
    await model.methods.restartService.execute(
      { serviceName: "tuios" },
      ctx.context as never,
    );
  });
  assertEquals(calls.some((c) => c.includes("--user restart tuios")), true);
  const written = ctx.getWrittenResources();
  assertEquals(written.length, 1);
  assertEquals(written[0].specName, "service");
  assertEquals(written[0].data.active, true);
});

Deno.test("restartService throws when the service is not active afterwards", async () => {
  const ctx = createModelTestContext({
    globalArgs: {
      denoPath: "~/.swamp/deno/deno",
      unitDir: "~/.config/systemd/user",
    },
    methodName: "restartService",
  });
  await withMockedCommand((_command, args) => {
    if (args.includes("restart")) return { stdout: "", code: 0 };
    if (args.includes("is-active")) {
      return { stdout: "failed\n", code: 3 };
    }
    return { stdout: "", code: 0 };
  }, async () => {
    await assertRejects(
      () =>
        model.methods.restartService.execute(
          { serviceName: "tuios" },
          ctx.context as never,
        ),
      Error,
      "not active",
    );
  });
});

Deno.test("parseDeclaredPorts finds flags, env vars, and host:port", () => {
  assertEquals(
    parseDeclaredPorts([
      "ExecStart=/x --host 127.0.0.1 --port 8765",
      "Environment=FEEDBACK_PORT=8765",
    ]),
    [8765],
  );
  assertEquals(
    parseDeclaredPorts(["ExecStart=/usr/bin/api --port=8080"]),
    [8080],
  );
  assertEquals(parseDeclaredPorts(["ExecStart=/x -p 9090"]), [9090]);
  assertEquals(parseDeclaredPorts(["Environment=PORT=3000"]), [3000]);
  assertEquals(
    parseDeclaredPorts(["Environment=GTD_PORT=8878"]),
    [8878],
  );
  // A PATH value must not be mistaken for a port.
  assertEquals(
    parseDeclaredPorts(["Environment=PATH=/usr/local/bin:/usr/bin:/bin"]),
    [],
  );
  // Out-of-range values are dropped.
  assertEquals(parseDeclaredPorts(["ExecStart=/x --port 99999"]), []);
});

Deno.test("parseDeclaredPorts sorts and dedupes", () => {
  assertEquals(
    parseDeclaredPorts([
      "ExecStart=/x --port 9000",
      "ExecStart=/x --port 8000",
      "Environment=PORT=9000",
    ]),
    [8000, 9000],
  );
});

Deno.test("parseSsListeners reads IPv4, IPv6, and process owners", () => {
  const output = [
    'LISTEN 0      511   127.0.0.1:8765   0.0.0.0:*    users:(("deno",pid=2121,fd=20))',
    "LISTEN 0      4096  [::1]%lo:64315      [::]:*",
    "LISTEN 0      4096  0.0.0.0:22        0.0.0.0:*",
    'LISTEN 0      511   [::]:9090         [::]:*     users:(("swamp",pid=751571,fd=23))',
  ].join("\n");
  const listeners = parseSsListeners(output);
  assertEquals(listeners.length, 4);
  assertEquals(listeners[0], {
    protocol: "tcp",
    localAddress: "127.0.0.1",
    port: 8765,
    process: "deno",
    pid: 2121,
  });
  assertEquals(listeners[1].localAddress, "[::1]");
  assertEquals(listeners[1].port, 64315);
  assertEquals(listeners[1].pid, 0);
  assertEquals(listeners[3].localAddress, "[::]");
  assertEquals(listeners[3].pid, 751571);
});

Deno.test("parseSsListeners ignores non-listen lines and junk", () => {
  assertEquals(
    parseSsListeners("State Recv-Q\nESTAB 0 0 1.2.3.4:22 5.6.7.8:9\n\n"),
    [],
  );
});

Deno.test("parseCgroupPids reads one pid per line and ignores junk", () => {
  assertEquals(parseCgroupPids("2121\n2122\n"), [2121, 2122]);
  assertEquals(parseCgroupPids("2121\n\nnot-a-pid\n"), [2121]);
  assertEquals(parseCgroupPids(""), []);
});

Deno.test("resolveCgroupRoot trims slashes and falls back", () => {
  assertEquals(resolveCgroupRoot("/sys/fs/cgroup/"), "/sys/fs/cgroup");
  assertEquals(resolveCgroupRoot(""), "/sys/fs/cgroup");
});

Deno.test("renderAuditTable aligns columns and shows ports/drift", () => {
  const table = renderAuditTable([
    {
      modelName: "feedback-server",
      serviceName: "feedback-server",
      state: "running",
      unitFileState: "enabled",
      declaredPorts: [8765],
      listeningPorts: [8765],
      drift: false,
    },
    {
      modelName: "tuios-daemon",
      serviceName: "tuios",
      state: "restarting",
      unitFileState: "enabled",
      declaredPorts: [],
      listeningPorts: [],
      drift: true,
    },
  ]);
  const lines = table.split("\n");
  assertEquals(lines.length, 3);
  assertEquals(lines[0].startsWith("MODEL"), true);
  assertEquals(lines[0].includes("DECLARED"), true);
  assertEquals(lines[0].includes("LISTENING"), true);
  assertEquals(lines[0].includes("DRIFT"), true);
  // Every body line has the same width as the header.
  assertEquals(lines[1].length, lines[0].length);
  assertEquals(lines[2].length, lines[0].length);
  assertEquals(lines[1].includes("[8765]"), true);
  assertEquals(lines[2].includes("!"), true);
});

Deno.test("stateFor maps systemctl properties to a compact state", () => {
  assertEquals(
    stateFor({ LoadState: "not-found", ActiveState: "inactive" }),
    "not-found",
  );
  assertEquals(
    stateFor({ LoadState: "loaded", ActiveState: "active" }),
    "running",
  );
  assertEquals(
    stateFor({
      LoadState: "loaded",
      ActiveState: "activating",
      SubState: "auto-restart",
    }),
    "restarting",
  );
  assertEquals(
    stateFor({ LoadState: "loaded", ActiveState: "activating" }),
    "starting",
  );
  assertEquals(
    stateFor({ LoadState: "loaded", ActiveState: "failed" }),
    "failed",
  );
  assertEquals(
    stateFor({ LoadState: "loaded", ActiveState: "deactivating" }),
    "stopping",
  );
});

Deno.test("audit writes a service row per model from the definition repo", async () => {
  const ctx = createModelTestContext({
    globalArgs: {
      denoPath: "~/.swamp/deno/deno",
      unitDir: "/tmp/swamp-audit-test-missing",
      cgroupRoot: "/sys/fs/cgroup",
    },
    definition: { name: "auditor" },
    methodName: "audit",
  });
  // Inject the cross-model APIs the production context provides.
  const c = ctx.context as unknown as Record<string, unknown>;
  c.definitionRepository = {
    findAllGlobal: () =>
      Promise.resolve([
        {
          definition: { id: "1", name: "svc-a" },
          type: { raw: "@svendowideit/systemd-service" },
        },
        {
          definition: { id: "2", name: "svc-b" },
          type: { raw: "@svendowideit/systemd-service" },
        },
        {
          definition: { id: "3", name: "other" },
          type: { raw: "@svendowideit/caddy" },
        },
      ]),
  };
  c.queryData = (predicate: string) => {
    if (!predicate.includes("@svendowideit/systemd-service")) {
      return Promise.resolve([]);
    }
    return Promise.resolve([
      {
        modelName: "svc-a",
        specName: "service",
        attributes: {
          serviceName: "svc-a",
          active: true,
          enabled: true,
          checkedAt: "2026-10-01T00:00:00.000Z",
        },
      },
    ]);
  };

  await withMockedCommand((command, args) => {
    if (command === "ss") {
      return {
        stdout:
          'LISTEN 0 511 127.0.0.1:7000 0.0.0.0:* users:(("deno",pid=100,fd=20))\n',
        code: 0,
      };
    }
    if (command === "systemctl") {
      const name = args[2] ?? "";
      if (name === "svc-a") {
        return {
          stdout: [
            "LoadState=loaded",
            "ActiveState=active",
            "SubState=running",
            "UnitFileState=enabled",
            "MainPID=100",
            "ControlGroup=/user.slice/svc-a.service",
          ].join("\n"),
          code: 0,
        };
      }
      if (args.includes("ControlGroup") || args.includes("show")) {
        return {
          stdout: [
            "LoadState=not-found",
            "ActiveState=inactive",
            "SubState=dead",
            "UnitFileState=",
            "MainPID=0",
            "ControlGroup=",
          ].join("\n"),
          code: 0,
        };
      }
      return { stdout: "", code: 0 };
    }
    return { stdout: "", code: 0 };
  }, async () => {
    await model.methods.audit.execute(
      { serviceName: "all" },
      ctx.context as never,
    );
  });

  const written = ctx.getWrittenResources();
  assertEquals(written.length, 1);
  assertEquals(written[0].specName, "audit");
  const data = written[0].data as Record<string, unknown>;
  const services = data.services as Array<Record<string, unknown>>;
  // Both systemd-service models are listed; the caddy model is not.
  assertEquals(services.length, 2);
  assertEquals(services.map((s) => s.modelName), ["svc-a", "svc-b"]);
  assertEquals(data.modelCount, 2);
  assertEquals(data.runningCount, 1);
  assertEquals(data.absentCount, 1);
  const a = services[0];
  assertEquals(a.exists, true);
  assertEquals(a.state, "running");
  // svc-a has no unit file in this fixture, so nothing is declared; the live
  // port is still attributed via MainPID.
  assertEquals(a.declaredPorts, []);
  assertEquals(
    (a.listeningPorts as Array<Record<string, unknown>>)[0].port,
    7000,
  );
  assertEquals(a.drift, false);
  const b = services[1];
  assertEquals(b.exists, false);
  assertEquals(b.state, "not-found");
});

Deno.test("audit flags drift when the stored state disagrees with systemd", async () => {
  const ctx = createModelTestContext({
    globalArgs: {
      unitDir: "/tmp/swamp-audit-test-missing",
      cgroupRoot: "/sys/fs/cgroup",
    },
    definition: { name: "auditor" },
    methodName: "audit",
  });
  const c = ctx.context as unknown as Record<string, unknown>;
  c.definitionRepository = {
    findAllGlobal: () =>
      Promise.resolve([
        {
          definition: { id: "1", name: "svc-a" },
          type: { raw: "@svendowideit/systemd-service" },
        },
      ]),
  };
  // The stored snapshot claims active, but systemd reports the unit absent.
  c.queryData = () =>
    Promise.resolve([
      {
        modelName: "svc-a",
        specName: "service",
        attributes: {
          serviceName: "svc-a",
          active: true,
          enabled: true,
          checkedAt: "2026-10-01T00:00:00.000Z",
        },
      },
    ]);
  await withMockedCommand((command) => {
    if (command === "ss") return { stdout: "", code: 0 };
    return {
      stdout: [
        "LoadState=not-found",
        "ActiveState=inactive",
        "SubState=dead",
        "UnitFileState=",
        "MainPID=0",
        "ControlGroup=",
      ].join("\n"),
      code: 0,
    };
  }, async () => {
    await model.methods.audit.execute(
      { serviceName: "all" },
      ctx.context as never,
    );
  });
  const data = ctx.getWrittenResources()[0].data as Record<string, unknown>;
  const services = data.services as Array<Record<string, unknown>>;
  assertEquals(services[0].drift, true);
  assertEquals(services[0].reportedActive, true);
});

/** Shared fixture: two systemd-service models for scoped-audit tests. */
function auditScopeContext() {
  const ctx = createModelTestContext({
    globalArgs: {
      unitDir: "/tmp/swamp-audit-test-missing",
      cgroupRoot: "/sys/fs/cgroup",
    },
    definition: { name: "auditor" },
    methodName: "audit",
  });
  const c = ctx.context as unknown as Record<string, unknown>;
  c.definitionRepository = {
    findAllGlobal: () =>
      Promise.resolve([
        {
          definition: { id: "1", name: "svc-a" },
          type: { raw: "@svendowideit/systemd-service" },
        },
        {
          definition: { id: "2", name: "tuios-daemon" },
          type: { raw: "@svendowideit/systemd-service" },
        },
      ]),
  };
  c.queryData = () =>
    Promise.resolve([
      {
        modelName: "tuios-daemon",
        specName: "service",
        attributes: {
          serviceName: "tuios",
          active: true,
          enabled: true,
          checkedAt: "2026-10-01T00:00:00.000Z",
        },
      },
    ]);
  return ctx;
}

const auditCommands = (command: string) =>
  command === "ss" ? { stdout: "", code: 0 } : {
    stdout: [
      "LoadState=loaded",
      "ActiveState=active",
      "SubState=running",
      "UnitFileState=enabled",
      "MainPID=0",
      "ControlGroup=",
    ].join("\n"),
    code: 0,
  };

Deno.test("audit scope 'all' reports every model", async () => {
  const ctx = auditScopeContext();
  await withMockedCommand(auditCommands, async () => {
    await model.methods.audit.execute(
      { serviceName: "all" },
      ctx.context as never,
    );
  });
  const data = ctx.getWrittenResources()[0].data as Record<string, unknown>;
  assertEquals(data.scope, "all");
  assertEquals(data.modelCount, 2);
  assertEquals(
    (data.services as Array<Record<string, unknown>>).map((s) => s.modelName),
    ["svc-a", "tuios-daemon"],
  );
});

Deno.test("audit scope narrows to the model matching the managed unit name", async () => {
  const ctx = auditScopeContext();
  // "tuios" is the unit name, not the model name ("tuios-daemon"); it must
  // still match via the reported serviceName.
  await withMockedCommand(auditCommands, async () => {
    await model.methods.audit.execute(
      { serviceName: "tuios" },
      ctx.context as never,
    );
  });
  const data = ctx.getWrittenResources()[0].data as Record<string, unknown>;
  assertEquals(data.scope, "tuios");
  assertEquals(data.modelCount, 1);
  const services = data.services as Array<Record<string, unknown>>;
  assertEquals(services.length, 1);
  assertEquals(services[0].modelName, "tuios-daemon");
});

Deno.test("audit scope errors when no model matches", async () => {
  const ctx = auditScopeContext();
  await withMockedCommand(auditCommands, async () => {
    await assertRejects(
      () =>
        model.methods.audit.execute(
          { serviceName: "does-not-exist" },
          ctx.context as never,
        ),
      Error,
      "No systemd-service model found matching 'does-not-exist'",
    );
  });
});
