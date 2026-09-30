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
  renderServiceUnit,
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
