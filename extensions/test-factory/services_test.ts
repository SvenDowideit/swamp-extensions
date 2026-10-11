import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  isEmptySystem,
  lintTestSystem,
  parseTestSystem,
  resolveSystemSubnets,
  sshdVariables,
  systemVariables,
} from "./services.ts";
import { parseCidrs } from "./networks.ts";

const SSH_YAML = `
harness:
  sshd: true
  runAs: tester
  sshdPort: 2222
`;

Deno.test("parseTestSystem reads harness.sshd and sshdPort", () => {
  const s = parseTestSystem(SSH_YAML);
  assertEquals(s.harness.sshd, true);
  assertEquals(s.harness.sshdPort, 2222);
  assertEquals(s.harness.runAs, "tester");
});

Deno.test("harness.sshd: true uses the default port 22", () => {
  const s = parseTestSystem("harness:\n  sshd: true\n");
  assertEquals(s.harness.sshd, true);
  assertEquals(s.harness.sshdPort, 22);
});

Deno.test("harness.sshd defaults off", () => {
  const s = parseTestSystem("harness: { dig: true }");
  assertEquals(s.harness.sshd, false);
});

Deno.test("sshdVariables exposes the loopback remote host", () => {
  assertEquals(sshdVariables(parseTestSystem(SSH_YAML)), {
    TF_SSH_HOST: "127.0.0.1",
    TF_SSH_PORT: "2222",
    TF_SSH_USER: "tester",
    TF_SSH_KEY: "/tf/ssh/id_ed25519",
    TF_SSH_KEY_PUB: "/tf/ssh/id_ed25519.pub",
    TF_SSH_KNOWN_HOSTS: "/tf/ssh/known_hosts",
  });
  assertEquals(sshdVariables(parseTestSystem("harness: { dig: true }")), {});
});

Deno.test("lintTestSystem rejects an invalid sshdPort", () => {
  const issues = lintTestSystem(
    parseTestSystem("harness:\n  sshd: true\n  sshdPort: 0\n"),
  );
  assert(issues.some((i) => i.includes("sshdPort")));
});

const SUBNET_YAML = `
networks:
  net1: { subnet: 192.0.2.0/24 }
harness:
  networks:
    net1: { ipv4_address: 192.0.2.10 }
services:
  bind:
    image: busybox
    networks: { net1: { ipv4_address: 192.0.2.11 } }
`;

Deno.test("resolveSystemSubnets keeps declared subnets when they are free", () => {
  const r = resolveSystemSubnets(parseTestSystem(SUBNET_YAML), []);
  assertEquals(r.networks[0].subnet, "192.0.2.0/24");
  assertEquals(r.harness.networks[0].ipv4Address, "192.0.2.10");
  assertEquals(r.services[0].networks[0].ipv4Address, "192.0.2.11");
});

Deno.test("resolveSystemSubnets allocates a free subnet and remaps static IPs", () => {
  const r = resolveSystemSubnets(
    parseTestSystem(SUBNET_YAML),
    parseCidrs(["192.0.2.0/24"]),
  );
  // The declared subnet is taken, so it moves to the pool and the static IPs
  // move with it (host offset preserved).
  assertEquals(r.networks[0].subnet, "10.213.0.0/24");
  assertEquals(r.harness.networks[0].ipv4Address, "10.213.0.10");
  assertEquals(r.services[0].networks[0].ipv4Address, "10.213.0.11");
});

const YAML = `
tests:
  - name: dns-resolves
    confirms: names resolve
    cannot: must not error
    steps:
      - name: dig
        run: dig @bind alpha.example.com

networks:
  net1:
    subnet: 172.31.240.0/24
  net2:
    subnet: 172.31.241.0/24

harness:
  networks:
    net1:
      ipv4_address: 172.31.240.10
    net2:
      ipv4_address: 172.31.241.10

services:
  bind:
    build: ./bind
    networks:
      net1:
        ipv4_address: 172.31.240.11
    healthcheck:
      command: ["dig", "+short", "@127.0.0.1", "example.com", "SOA"]
      intervalSeconds: 1
      retries: 10
  tools:
    image: alpine:3.20
    command: ["sleep", "infinity"]
    networks:
      net1:
`;

Deno.test("parseTestSystem reads networks, harness and services", () => {
  const sys = parseTestSystem(YAML);
  assertEquals(sys.networks.length, 2);
  assertEquals(sys.networks[0], { name: "net1", subnet: "172.31.240.0/24" });
  assertEquals(sys.harness.networks, [
    { network: "net1", ipv4Address: "172.31.240.10" },
    { network: "net2", ipv4Address: "172.31.241.10" },
  ]);
  assertEquals(sys.services.length, 2);
  const bind = sys.services.find((s) => s.name === "bind")!;
  assertEquals(bind.build, "./bind");
  assertEquals(bind.image, "");
  assertEquals(bind.networks, [
    { network: "net1", ipv4Address: "172.31.240.11" },
  ]);
  assertEquals(bind.healthcheck?.command[0], "dig");
  assertEquals(bind.healthcheck?.retries, 10);
  const tools = sys.services.find((s) => s.name === "tools")!;
  assertEquals(tools.image, "alpine:3.20");
  assertEquals(tools.command, ["sleep", "infinity"]);
  // A network with no value attaches dynamically.
  assertEquals(tools.networks, [{ network: "net1", ipv4Address: "" }]);
  assertEquals(isEmptySystem(sys), false);
});

Deno.test("parseTestSystem tolerates a file with only tests", () => {
  const sys = parseTestSystem(
    "tests:\n  - name: t\n    confirms: a\n    cannot: b\n    steps: []\n",
  );
  assertEquals(isEmptySystem(sys), true);
  assertEquals(systemVariables(sys), {});
});

Deno.test("parseTestSystem rejects a non-mapping document", () => {
  let threw = false;
  try {
    parseTestSystem("- just\n- a list\n");
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("systemVariables exposes harness and service addresses", () => {
  const sys = parseTestSystem(YAML);
  const vars = systemVariables(sys);
  assertEquals(vars.TF_HARNESS_IP_NET1, "172.31.240.10");
  assertEquals(vars.TF_HARNESS_IP_NET2, "172.31.241.10");
  assertEquals(vars.TF_BIND_IP, "172.31.240.11");
  assertEquals(vars.TF_BIND_IP_NET1, "172.31.240.11");
});

Deno.test("lintTestSystem accepts a sound system", () => {
  assertEquals(lintTestSystem(parseTestSystem(YAML)), []);
});

Deno.test("lintTestSystem flags unknown networks and bad addresses", () => {
  const sys = parseTestSystem(`
services:
  x:
    image: alpine
    networks:
      nope:
        ipv4_address: not-an-ip
`);
  const issues = lintTestSystem(sys);
  assertEquals(issues.some((i) => i.includes("unknown network")), true);
  assertEquals(issues.some((i) => i.includes("not an IPv4")), true);
});

Deno.test("lintTestSystem flags a service with neither image nor build", () => {
  const sys = parseTestSystem(`
services:
  x:
    networks: {}
`);
  assertEquals(
    lintTestSystem(sys).some((i) =>
      i.includes("needs an `image` or a `build`")
    ),
    true,
  );
});

Deno.test("parseTestSystem reads an extensions mapping", () => {
  const sys = parseTestSystem(`
extensions:
  caddy: extensions/models/caddy
  otel-gateway: extensions/models/otel-gateway
`);
  assertEquals(sys.extensions, [
    { name: "caddy", path: "extensions/models/caddy" },
    { name: "otel-gateway", path: "extensions/models/otel-gateway" },
  ]);
});

Deno.test("parseTestSystem reads a flat extensions list and derives names", () => {
  const sys = parseTestSystem(`
extensions:
  - extensions/models/openobserve
  - extensions/models/otel-settings
`);
  assertEquals(sys.extensions, [
    { name: "openobserve", path: "extensions/models/openobserve" },
    { name: "otel-settings", path: "extensions/models/otel-settings" },
  ]);
});

Deno.test("parseTestSystem accepts `dependencies` as an alias", () => {
  const sys = parseTestSystem(`
dependencies:
  caddy: extensions/models/caddy
`);
  assertEquals(sys.extensions, [
    { name: "caddy", path: "extensions/models/caddy" },
  ]);
});

Deno.test("lintTestSystem flags an extension with no path", () => {
  const sys = parseTestSystem(`
extensions:
  a: ""
`);
  assertEquals(
    lintTestSystem(sys).some((i) => i.includes("missing path")),
    true,
  );
});

Deno.test("lintTestSystem flags a duplicate extension source name", () => {
  // The flat list derives the name from the last path segment, so two dirs
  // both called `caddy` collide.
  const sys = parseTestSystem(`
extensions:
  - extensions/models/caddy
  - vendor/caddy
`);
  assertEquals(
    lintTestSystem(sys).some((i) => i.includes("duplicate extension source")),
    true,
  );
});

Deno.test("lintTestSystem flags a duplicate static address", () => {
  const sys = parseTestSystem(`
networks:
  net1:
    subnet: 172.31.240.0/24
harness:
  networks:
    net1:
      ipv4_address: 172.31.240.10
services:
  bind:
    image: alpine
    networks:
      net1:
        ipv4_address: 172.31.240.10
`);
  assertEquals(
    lintTestSystem(sys).some((i) => i.includes("used by both")),
    true,
  );
});

Deno.test("parseTestSystem reads harness.runAs (default root)", () => {
  const root = parseTestSystem("tests: []\n");
  assertEquals(root.harness.runAs, "root");
  const tester = parseTestSystem(`
harness:
  runAs: tester
`);
  assertEquals(tester.harness.runAs, "tester");
});

Deno.test("lintTestSystem flags an invalid runAs user name", () => {
  const sys = parseTestSystem(`
harness:
  runAs: "not a user"
`);
  assertEquals(
    lintTestSystem(sys).some((i) => i.includes("not a valid user name")),
    true,
  );
});

Deno.test("parseTestSystem reads grants, defaulting guest to harness", () => {
  const sys = parseTestSystem(`
grants:
  - { guest: harness, profile: sudo-nopasswd }
  - { profile: doas-nopasswd }
`);
  assertEquals(sys.grants, [
    { guest: "harness", profile: "sudo-nopasswd" },
    { guest: "harness", profile: "doas-nopasswd" },
  ]);
});

Deno.test("lintTestSystem flags an unknown grant profile", () => {
  const sys = parseTestSystem(`
grants:
  - { guest: harness, profile: no-such-profile }
`);
  assertEquals(
    lintTestSystem(sys).some((i) => i.includes("unknown profile")),
    true,
  );
});

Deno.test("parseTestSystem reads isolation checks", () => {
  const sys = parseTestSystem(`
isolation:
  - name: sudo-does-not-escape
    confirms: marker stays in the sandbox
    cannot: must not write on the host
    sandbox: "sudo -n sh -c 'echo x > /escaped-$TF_RUN_ID'"
    absentOnHost: ["/escaped-$TF_RUN_ID"]
  - name: caddy-port-not-published
    confirms: no host port
    cannot: no published binding
    noPublishedPorts: ["harness"]
`);
  assertEquals(sys.isolation.length, 2);
  assertEquals(sys.isolation[0].name, "sudo-does-not-escape");
  assertEquals(sys.isolation[0].absentOnHost, ["/escaped-$TF_RUN_ID"]);
  assertEquals(sys.isolation[1].noPublishedPorts, ["harness"]);
});

Deno.test("lintTestSystem flags an isolation check with no probe", () => {
  const sys = parseTestSystem(`
isolation:
  - name: proves-nothing
    confirms: a
    cannot: b
`);
  assertEquals(
    lintTestSystem(sys).some((i) => i.includes("declare at least one")),
    true,
  );
});

Deno.test("lintTestSystem flags an unknown noPublishedPorts role", () => {
  const sys = parseTestSystem(`
isolation:
  - name: bad-role
    confirms: a
    cannot: b
    noPublishedPorts: ["nope"]
`);
  assertEquals(
    lintTestSystem(sys).some((i) => i.includes("declared service")),
    true,
  );
});

Deno.test("the dependency-stub fixture is shipped and self-consistent", async () => {
  const dir = new URL("./test/stub/", import.meta.url);
  const dockerfile = await Deno.readTextFile(new URL("Dockerfile.txt", dir));
  // The Dockerfile must copy the server (which is stored with a `.txt` suffix
  // because extension additionalFiles only allow certain extensions).
  assertStringIncludes(dockerfile, "stub.py.txt");
  assertStringIncludes(dockerfile, "/stub.py");
  const server = await Deno.readTextFile(new URL("stub.py.txt", dir));
  // The control route is what a test toggles; the modes drive C2/C3/D6.
  assertStringIncludes(server, "/ctl");
  for (const mode of ["accept", "reject", "delay", "down"]) {
    assert(server.includes(mode), `stub supports mode ${mode}`);
  }
});
