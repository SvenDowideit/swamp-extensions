import { assertEquals } from "jsr:@std/assert@1";
import {
  isEmptySystem,
  lintTestSystem,
  parseTestSystem,
  systemVariables,
} from "./services.ts";

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
