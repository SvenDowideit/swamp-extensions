import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1";

import {
  assertSafeName,
  buildServiceCreateArgv,
  desiredServiceHash,
  expandHome,
  fnv1a,
  parseContainerHealth,
  parseContainerImage,
  parseContainerPorts,
  parseContainerState,
  renderDockerUnit,
  renderQuadlet,
  runContainerExec,
  runNetwork,
  runService,
  runServiceStatus,
  type ServiceContext,
  type ServiceGlobalArgs,
} from "./_lib/service.ts";
import {
  type ExecRequest,
  type ExecResult,
  resetCommandExecutor,
  setCommandExecutor,
} from "./_lib/runner.ts";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

Deno.test("expandHome expands leading tilde", () => {
  const home = Deno.env.get("HOME") ?? "";
  if (home) {
    assertEquals(expandHome("~"), home);
    assertEquals(expandHome("~/x/y"), `${home}/x/y`);
  }
  assertEquals(expandHome("/abs/path"), "/abs/path");
});

Deno.test("assertSafeName accepts normal names and rejects unsafe ones", () => {
  assertSafeName("dtrack");
  assertSafeName("postgres-18.alpine_v1");
  assertThrows(() => assertSafeName(""), Error);
  assertThrows(() => assertSafeName("a/b"), Error);
  assertThrows(() => assertSafeName("-leading"), Error);
  assertThrows(() => assertSafeName("has space"), Error);
});

Deno.test("desiredServiceHash ignores secret env values but tracks names", () => {
  const base = {
    containerName: "c",
    action: "ensure" as const,
    image: "img:1",
  };
  const a = desiredServiceHash({ ...base, env: { PASSWORD: "one" } });
  const b = desiredServiceHash({ ...base, env: { PASSWORD: "two" } });
  const c = desiredServiceHash({ ...base, env: { PASSWORD: "one", X: "1" } });
  assertEquals(a, b);
  assert(a !== c);
});

Deno.test("desiredServiceHash changes when the image changes", () => {
  const x = desiredServiceHash({
    containerName: "c",
    action: "ensure",
    image: "img:1",
  });
  const y = desiredServiceHash({
    containerName: "c",
    action: "ensure",
    image: "img:2",
  });
  assert(x !== y);
});

Deno.test("fnv1a is stable and 8 hex chars", () => {
  assertEquals(fnv1a("hello"), fnv1a("hello"));
  assertEquals(fnv1a("hello").length, 8);
});

Deno.test("buildServiceCreateArgv includes name, restart, ports, env, label", () => {
  const argv = buildServiceCreateArgv("docker", {
    containerName: "dtrack",
    action: "ensure",
    image: "postgres:18-alpine",
    restart: "unless-stopped",
    ports: ["127.0.0.1:5432:5432"],
    volumes: ["pgdata:/var/lib/postgresql/data"],
    env: { POSTGRES_PASSWORD: "x" },
    network: "swamp-net",
  });
  assertEquals(argv.slice(0, 2), ["docker", "create"]);
  assertStringIncludes(argv.join(" "), "--name dtrack");
  assertStringIncludes(argv.join(" "), "--restart unless-stopped");
  assertStringIncludes(argv.join(" "), "-p 127.0.0.1:5432:5432");
  assertStringIncludes(argv.join(" "), "--network swamp-net");
  assert(argv.some((a: string) => a.startsWith("swamp.desired=")));
  assertEquals(argv[argv.length - 1], "postgres:18-alpine");
});

Deno.test("renderDockerUnit attaches and uses docker start/stop", () => {
  const unit = renderDockerUnit(
    { containerName: "dtrack", action: "ensure", image: "img" },
    "docker",
  );
  assertStringIncludes(unit, "[Unit]");
  assertStringIncludes(unit, "ExecStart=docker start -a dtrack");
  assertStringIncludes(unit, "ExecStop=docker stop dtrack");
  assertStringIncludes(unit, "Restart=always");
  assertStringIncludes(unit, "WantedBy=default.target");
});

Deno.test("renderQuadlet emits a [Container] section with image", () => {
  const q = renderQuadlet({
    containerName: "dtrack",
    action: "ensure",
    image: "postgres:18-alpine",
    ports: ["5432:5432"],
    volumes: ["pgdata:/var/lib/postgresql/data"],
    env: { POSTGRES_PASSWORD: "x" },
    network: "swamp-net",
  });
  assertStringIncludes(q, "[Container]");
  assertStringIncludes(q, "Image=postgres:18-alpine");
  assertStringIncludes(q, "ContainerName=dtrack");
  assertStringIncludes(q, "PublishPort=5432:5432");
  assertStringIncludes(q, "Volume=pgdata:/var/lib/postgresql/data");
  assertStringIncludes(q, "Environment=POSTGRES_PASSWORD=x");
  assertStringIncludes(q, "Network=swamp-net");
});

Deno.test("parse helpers handle inspect/port output", () => {
  assertEquals(parseContainerState("running\n"), "running");
  assertEquals(parseContainerHealth("healthy\n"), "healthy");
  assertEquals(parseContainerHealth("\n"), undefined);
  assertEquals(parseContainerImage('"img:1"\n'), "img:1");
  assertEquals(parseContainerPorts("5432/tcp -> 127.0.0.1:5432\n"), [
    "5432/tcp -> 127.0.0.1:5432",
  ]);
});

// ---------------------------------------------------------------------------
// Fake runtime
// ---------------------------------------------------------------------------

interface FakeContainer {
  state: string;
  label: string;
  image: string;
  ports: string;
  health?: string;
}

function makeFakeRuntime() {
  const containers = new Map<string, FakeContainer>();
  const networks = new Set<string>();
  const calls: string[][] = [];

  const executor = (req: ExecRequest): Promise<ExecResult> => {
    calls.push([req.bin, ...req.args]);
    const args = req.args;
    const ok = (stdout = ""): ExecResult => ({
      exitCode: 0,
      stdout,
      stderr: "",
    });
    const fail = (stderr = ""): ExecResult => ({
      exitCode: 1,
      stdout: "",
      stderr,
    });

    if (req.bin === "systemctl") {
      return Promise.resolve(ok("active\n"));
    }
    if (req.bin !== "docker") return Promise.resolve(fail("unexpected bin"));

    const sub = args[0];
    if (sub === "network") {
      const netCmd = args[1];
      const netName = args[args.length - 1];
      if (netCmd === "inspect") {
        return Promise.resolve(
          networks.has(netName) ? ok("{}") : fail("no such network"),
        );
      }
      if (netCmd === "create") {
        networks.add(netName);
        return Promise.resolve(ok(`${netName}\n`));
      }
      if (netCmd === "rm") {
        networks.delete(netName);
        return Promise.resolve(ok(`${netName}\n`));
      }
      return Promise.resolve(ok(""));
    }
    if (sub === "inspect") {
      // docker inspect [--format FMT] NAME
      let name: string;
      let fmt = "";
      if (args[1] === "--format") {
        fmt = args[2];
        name = args[3];
      } else {
        name = args[1];
      }
      const c = containers.get(name);
      if (!c) return Promise.resolve(fail("no such container"));
      if (fmt.includes("State.Status")) {
        return Promise.resolve(ok(`${c.state}\n`));
      }
      if (fmt.includes("swamp.desired")) {
        return Promise.resolve(ok(`${c.label}\n`));
      }
      if (fmt.includes("Config.Image")) {
        return Promise.resolve(ok(`"${c.image}"\n`));
      }
      if (fmt.includes("State.Health")) {
        return Promise.resolve(ok(`${c.health ?? ""}\n`));
      }
      return Promise.resolve(ok(""));
    }
    if (sub === "create") {
      const name = args[args.indexOf("--name") + 1];
      const labelArg = args.find((a: string) =>
        a.startsWith("swamp.desired=")
      ) ?? "";
      const image = args[args.length - 1];
      containers.set(name, {
        state: "created",
        label: labelArg.replace("swamp.desired=", ""),
        image,
        ports: "5432/tcp -> 127.0.0.1:5432",
      });
      return Promise.resolve(ok("id\n"));
    }
    if (sub === "start") {
      const name = args[1];
      const c = containers.get(name);
      if (!c) return Promise.resolve(fail("no such container"));
      c.state = "running";
      return Promise.resolve(ok(`${name}\n`));
    }
    if (sub === "stop") {
      const c = containers.get(args[1]);
      if (c) c.state = "exited";
      return Promise.resolve(ok(""));
    }
    if (sub === "rm") {
      containers.delete(args[args.length - 1]);
      return Promise.resolve(ok(""));
    }
    if (sub === "pull") return Promise.resolve(ok(""));
    if (sub === "port") {
      const c = containers.get(args[1]);
      return Promise.resolve(ok(c ? `${c.ports}\n` : ""));
    }
    if (sub === "logs") return Promise.resolve(ok("log line\n"));
    if (sub === "exec") {
      const c = containers.get(args[1]);
      if (c && c.state === "running") return Promise.resolve(ok(""));
      return Promise.resolve(fail("not running"));
    }
    return Promise.resolve(ok(""));
  };

  return { containers, networks, calls, executor };
}
const GLOBAL: ServiceGlobalArgs = {
  name: "svc",
  binary: "docker",
  serviceBackend: "direct",
  systemdUnitDir: "/tmp/opencode/container-service-test/systemd",
  quadletDir: "/tmp/opencode/container-service-test/quadlet",
};

function makeCtx(): ServiceContext {
  return {
    signal: new AbortController().signal,
    globalArgs: GLOBAL as unknown as Record<string, unknown>,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    writeResource: () => Promise.resolve({ name: "svc" }),
  };
}

// ---------------------------------------------------------------------------
// direct backend lifecycle
// ---------------------------------------------------------------------------

Deno.test("direct ensure creates and starts a container", async () => {
  const fake = makeFakeRuntime();
  setCommandExecutor(fake.executor);
  try {
    const out = await runService(
      { containerName: "dtrack", action: "ensure", image: "img:1" },
      GLOBAL,
      makeCtx(),
    );
    assertEquals(out.running, true);
    assertEquals(out.changed, true);
    assertEquals(fake.containers.get("dtrack")?.state, "running");
  } finally {
    resetCommandExecutor();
  }
});

Deno.test("direct ensure is a no-op when desired state is unchanged", async () => {
  const fake = makeFakeRuntime();
  setCommandExecutor(fake.executor);
  try {
    const args = {
      containerName: "dtrack",
      action: "ensure" as const,
      image: "img:1",
    };
    await runService(args, GLOBAL, makeCtx());
    const before = fake.calls.filter((c) =>
      c[0] === "docker" && c[1] === "create"
    ).length;
    const second = await runService(args, GLOBAL, makeCtx());
    const after = fake.calls.filter((c) =>
      c[0] === "docker" && c[1] === "create"
    ).length;
    assertEquals(second.changed, false);
    assertEquals(before, after);
  } finally {
    resetCommandExecutor();
  }
});

Deno.test("direct ensure recreates when the image changes", async () => {
  const fake = makeFakeRuntime();
  setCommandExecutor(fake.executor);
  try {
    await runService(
      { containerName: "dtrack", action: "ensure", image: "img:1" },
      GLOBAL,
      makeCtx(),
    );
    const out = await runService(
      { containerName: "dtrack", action: "ensure", image: "img:2" },
      GLOBAL,
      makeCtx(),
    );
    assertEquals(out.changed, true);
    assertEquals(fake.containers.get("dtrack")?.image, "img:2");
  } finally {
    resetCommandExecutor();
  }
});

Deno.test("direct stop and remove", async () => {
  const fake = makeFakeRuntime();
  setCommandExecutor(fake.executor);
  try {
    await runService(
      { containerName: "dtrack", action: "ensure", image: "img:1" },
      GLOBAL,
      makeCtx(),
    );
    const stopped = await runService(
      { containerName: "dtrack", action: "stop" },
      GLOBAL,
      makeCtx(),
    );
    assertEquals(stopped.running, false);
    const removed = await runService(
      { containerName: "dtrack", action: "remove" },
      GLOBAL,
      makeCtx(),
    );
    assertEquals(removed.state, "removed");
    assertEquals(fake.containers.has("dtrack"), false);
  } finally {
    resetCommandExecutor();
  }
});

Deno.test("direct ensure waits on health and throws with logs on failure", async () => {
  const fake = makeFakeRuntime();
  setCommandExecutor(fake.executor);
  try {
    const out = await runService(
      {
        containerName: "dtrack",
        action: "ensure",
        image: "img:1",
        healthCommand: ["true"],
        healthTimeoutMs: 2000,
      },
      GLOBAL,
      makeCtx(),
    );
    assertEquals(out.healthOk, true);
  } finally {
    resetCommandExecutor();
  }
});

// ---------------------------------------------------------------------------
// systemd backend
// ---------------------------------------------------------------------------

Deno.test("systemd docker backend writes a unit and enables it", async () => {
  const fake = makeFakeRuntime();
  setCommandExecutor(fake.executor);
  const dir = `/tmp/opencode/container-service-test/${crypto.randomUUID()}`;
  try {
    const g2 = {
      ...GLOBAL,
      serviceBackend: "systemd" as const,
      systemdUnitDir: dir,
    };
    const out = await runService(
      { containerName: "dtrack", action: "ensure", image: "img:1" },
      g2,
      makeCtx(),
    );
    assertStringIncludes(out.unitPath ?? "", `${dir}/dtrack.service`);
    const unit = await Deno.readTextFile(`${dir}/dtrack.service`);
    assertStringIncludes(unit, "ExecStart=docker start -a dtrack");
    const enabled = fake.calls.some((c) =>
      c[0] === "systemctl" && c.includes("enable") && c.includes("dtrack")
    );
    assert(enabled);
    assertEquals(out.running, true);
  } finally {
    resetCommandExecutor();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("systemd backend rejects Apple Containers", async () => {
  setCommandExecutor(makeFakeRuntime().executor);
  try {
    const g2 = {
      ...GLOBAL,
      binary: "container" as const,
      serviceBackend: "systemd" as const,
    };
    await assertRejects(
      () =>
        runService(
          { containerName: "dtrack", action: "ensure", image: "img:1" },
          g2,
          makeCtx(),
        ),
      Error,
      "not supported with Apple Containers",
    );
  } finally {
    resetCommandExecutor();
  }
});

// ---------------------------------------------------------------------------
// serviceStatus
// ---------------------------------------------------------------------------

Deno.test("serviceStatus reports running state, image, and ports", async () => {
  const fake = makeFakeRuntime();
  setCommandExecutor(fake.executor);
  try {
    await runService(
      { containerName: "dtrack", action: "ensure", image: "img:1" },
      GLOBAL,
      makeCtx(),
    );
    const status = await runServiceStatus(
      { containerName: "dtrack" },
      GLOBAL,
      makeCtx(),
    );
    assertEquals(status.exists, true);
    assertEquals(status.running, true);
    assertEquals(status.image, "img:1");
    assertEquals(status.ports.length, 1);
  } finally {
    resetCommandExecutor();
  }
});

Deno.test("serviceStatus reports absent for a missing container", async () => {
  const fake = makeFakeRuntime();
  setCommandExecutor(fake.executor);
  try {
    const status = await runServiceStatus(
      { containerName: "nope" },
      GLOBAL,
      makeCtx(),
    );
    assertEquals(status.exists, false);
    assertEquals(status.state, "absent");
  } finally {
    resetCommandExecutor();
  }
});

Deno.test("exec runs an argv inside a running container", async () => {
  const fake = makeFakeRuntime();
  setCommandExecutor(fake.executor);
  try {
    await runService(
      { containerName: "postgres", action: "ensure", image: "img:1" },
      GLOBAL,
      makeCtx(),
    );
    const out = await runContainerExec(
      { containerName: "postgres", command: ["pg_isready", "-U", "dtrack"] },
      GLOBAL,
      makeCtx(),
    );
    assertEquals(out.exitCode, 0);
    assert(
      fake.calls.some((c) =>
        c.join(" ") === "docker exec postgres pg_isready -U dtrack"
      ),
    );
  } finally {
    resetCommandExecutor();
  }
});

Deno.test("network ensure creates once then is a no-op", async () => {
  const fake = makeFakeRuntime();
  setCommandExecutor(fake.executor);
  try {
    const first = await runNetwork(
      { networkName: "swamp-net" },
      GLOBAL,
      makeCtx(),
    );
    assertEquals(first.changed, true);
    assertEquals(first.exists, true);
    const second = await runNetwork(
      { networkName: "swamp-net" },
      GLOBAL,
      makeCtx(),
    );
    assertEquals(second.changed, false);
    const removed = await runNetwork(
      { networkName: "swamp-net", action: "remove" },
      GLOBAL,
      makeCtx(),
    );
    assertEquals(removed.exists, false);
    assertEquals(fake.networks.has("swamp-net"), false);
  } finally {
    resetCommandExecutor();
  }
});
