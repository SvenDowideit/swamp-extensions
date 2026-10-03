import { assert, assertEquals } from "jsr:@std/assert@1";

import {
  correlate,
  coveragePercent,
  expandCidr,
  expandHome,
  inferTier,
  type InventoryHost,
  mergeHosts,
  model,
  numberToIp,
  parseCidr,
  parseProbeFacts,
  renderProbeCommand,
  tally,
} from "./fleet_inventory.ts";

Deno.test("expandHome resolves ~ against HOME", () => {
  assertEquals(expandHome("~/x", "/home/u"), "/home/u/x");
  assertEquals(expandHome("/abs", "/home/u"), "/abs");
});

Deno.test("parseCidr and numberToIp round-trip", () => {
  const { base, bits } = parseCidr("192.168.1.0/24");
  assertEquals(bits, 24);
  assertEquals(numberToIp(base), "192.168.1.0");
  let threw = false;
  try {
    parseCidr("not-a-cidr");
  } catch {
    threw = true;
  }
  assert(threw);
});

Deno.test("expandCidr excludes network and broadcast", () => {
  const hosts = expandCidr("192.168.1.0/30").addresses;
  assertEquals(hosts, ["192.168.1.1", "192.168.1.2"]);
  const slash31 = expandCidr("10.0.0.0/31").addresses;
  assertEquals(slash31, ["10.0.0.0", "10.0.0.1"]);
});

Deno.test("expandCidr normalises a host address to its network", () => {
  // 10.10.15.255/20 and 10.10.0.5/20 are the same network (10.10.0.0/20).
  const a = expandCidr("10.10.15.255/20");
  const b = expandCidr("10.10.0.5/20");
  assertEquals(a.count, 4094);
  assertEquals(a.addresses[0], b.addresses[0]);
  assertEquals(a.addresses[0], "10.10.0.1");
});

Deno.test("expandCidr maxHosts 0 scans the whole range; >0 caps", () => {
  const whole = expandCidr("10.0.0.0/20");
  assertEquals(whole.addresses.length, 4094);
  assertEquals(whole.truncated, false);
  const capped = expandCidr("10.0.0.0/20", 10);
  assertEquals(capped.addresses.length, 10);
  assertEquals(capped.count, 4094);
  assertEquals(capped.truncated, true);
});

Deno.test("mergeHosts combines fields for the same hostname", () => {
  const merged = mergeHosts(
    [
      {
        name: "a",
        address: "10.0.0.1",
        mac: "",
        source: "nmap",
        tier: "",
        os: "",
        notes: "",
      },
      {
        name: "a",
        address: "",
        mac: "aa:bb",
        source: "dhcp",
        tier: "T1",
        os: "debian",
        notes: "",
      },
    ],
    "now",
  );
  assertEquals(merged.length, 1);
  assertEquals(merged[0].address, "10.0.0.1");
  assertEquals(merged[0].mac, "aa:bb");
  assertEquals(merged[0].tier, "T1");
  assertEquals(merged[0].os, "debian");
});

Deno.test("mergeHosts merges a scan IP with the probed hostname by machine id", () => {
  // discover saw only 10.0.0.1; probe saw hostname=core at that address with id.
  const merged = mergeHosts(
    [
      {
        name: "10.0.0.1",
        address: "10.0.0.1",
        mac: "",
        source: "scan",
        tier: "",
        os: "",
        notes: "",
      },
      {
        name: "core",
        address: "10.0.0.1",
        mac: "",
        machineId: "mid-1",
        source: "probe",
        tier: "T1",
        os: "debian",
        notes: "",
        probed: true,
      },
    ],
    "now",
  );
  assertEquals(merged.length, 1, "scan hit must merge into the probed host");
  assertEquals(merged[0].name, "core");
  assertEquals(merged[0].machineId, "mid-1");
  assertEquals(merged[0].probed, true);
});

Deno.test("mergeHosts merges a scan IP into a NAMELESS host via address", () => {
  // A host with a machine id but no hostname still absorbs its scan IP.
  const merged = mergeHosts(
    [
      {
        name: "10.0.0.5",
        address: "10.0.0.5",
        mac: "",
        source: "scan",
        tier: "",
        os: "",
        notes: "",
      },
      {
        name: "",
        address: "10.0.0.5",
        mac: "",
        machineId: "mid-2",
        source: "dhcp",
        tier: "",
        os: "",
        notes: "",
      },
    ],
    "now",
  );
  assertEquals(merged.length, 1);
  assertEquals(merged[0].machineId, "mid-2");
  assertEquals(merged[0].address, "10.0.0.5");
});

Deno.test("mergeHosts does NOT merge two named hosts sharing a MAC (roaming dock)", () => {
  const merged = mergeHosts(
    [
      {
        name: "laptop-a",
        address: "10.0.0.10",
        mac: "de:ad:be:ef:00:01",
        machineId: "mid-a",
        source: "probe",
        tier: "",
        os: "",
        notes: "",
      },
      {
        name: "laptop-b",
        address: "10.0.0.11",
        mac: "de:ad:be:ef:00:01",
        machineId: "mid-b",
        source: "probe",
        tier: "",
        os: "",
        notes: "",
      },
    ],
    "now",
  );
  assertEquals(
    merged.length,
    2,
    "shared dock MAC must not merge two strong hosts",
  );
});

Deno.test("mergeHosts accumulates all addresses of a multi-homed host", () => {
  const merged = mergeHosts(
    [
      {
        name: "core",
        address: "10.0.0.20",
        mac: "",
        machineId: "mid-core",
        hostnames: ["core"],
        addresses: ["10.0.0.20"],
        source: "probe",
        tier: "",
        os: "",
        notes: "",
      },
      {
        name: "core",
        address: "10.0.0.21",
        mac: "",
        machineId: "mid-core",
        hostnames: ["core"],
        addresses: ["10.0.0.21"],
        source: "feed",
        tier: "",
        os: "",
        notes: "",
      },
    ],
    "now",
  );
  assertEquals(merged.length, 1);
  assertEquals(merged[0].addresses.sort(), ["10.0.0.20", "10.0.0.21"]);
});

Deno.test("inferTier classifies containers, immutables, and memory", () => {
  assertEquals(inferTier({ isContainer: true }), "T0");
  assertEquals(inferTier({ immutable: true }), "T4");
  assertEquals(inferTier({ memTotalMiB: 2048 }), "T2");
  assertEquals(inferTier({ memTotalMiB: 16384 }), "T1");
  assertEquals(inferTier({}), "T1");
  // Unknown falls back to the supplied default, not a hardcoded T1.
  assertEquals(inferTier({}, "T3"), "T3");
});

Deno.test("mergeHosts preserves the probed flag across a correlate merge", () => {
  const merged = mergeHosts(
    [
      {
        name: "core",
        address: "10.0.0.1",
        mac: "",
        source: "probe",
        tier: "T1",
        os: "debian",
        notes: "",
        probed: true,
      },
    ],
    "now",
  );
  assertEquals(merged[0].probed, true);
});

Deno.test("parseProbeFacts parses the key=value probe output", () => {
  const out = [
    "hostname=core",
    "machine_id=abc123",
    "os=debian",
    "docker=1",
    "container=0",
    "mem_total_mib=8192",
    "immutable=0",
  ].join("\n");
  const facts = parseProbeFacts(out);
  assertEquals(facts.hostname, "core");
  assertEquals(facts.os, "debian");
  assertEquals(facts.docker, true);
  assertEquals(facts.isContainer, false);
  assertEquals(facts.memTotalMiB, 8192);
  assertEquals(facts.immutable, false);
});

Deno.test("renderProbeCommand emits every fact key and handles macOS", () => {
  const cmd = renderProbeCommand();
  for (
    const key of [
      "hostname",
      "machine_id",
      "os",
      "docker",
      "container",
      "mem_total_mib",
      "immutable",
    ]
  ) {
    assert(cmd.includes(`${key}=`), `missing ${key}`);
  }
  // macOS: IOPlatformUUID via ioreg (system_profiler fallback), hw.memsize.
  assert(cmd.includes("Darwin)"), "must branch on Darwin");
  assert(cmd.includes("IOPlatformUUID"), "macOS id via ioreg");
  assert(cmd.includes("system_profiler"), "system_profiler fallback");
  assert(cmd.includes("hw.memsize"), "macOS memory source");
});

Deno.test("parseProbeFacts parses a macOS-style output", () => {
  const out = [
    "hostname=mac-mini",
    "machine_id=UUID-1234-5678",
    "os=darwin",
    "mem_total_mib=16384",
    "docker=0",
    "container=0",
  ].join("\n");
  const f = parseProbeFacts(out);
  assertEquals(f.hostname, "mac-mini");
  assertEquals(f.machineId, "UUID-1234-5678");
  assertEquals(f.os, "darwin");
  assertEquals(f.memTotalMiB, 16384);
  assertEquals(f.immutable, false);
});

Deno.test("correlate marks non-reporting hosts silent", () => {
  const hosts: InventoryHost[] = [
    mk("core", true),
    mk("silent1", false),
    mk("10.0.0.9", false),
  ];
  const out = correlate(hosts, ["core", "10.0.0.9"], "now");
  assertEquals(out[0].reporting, true);
  assertEquals(out[0].silent, false);
  assertEquals(out[1].silent, true);
  assertEquals(out[2].reporting, true);
});

Deno.test("tally groups hosts by field", () => {
  const hosts = [mk("a", true, "T1"), mk("b", true, "T1"), mk("c", true, "T2")];
  assertEquals(tally(hosts, "tier"), { T1: 2, T2: 1 });
  assertEquals(tally(hosts, "os"), { "(unknown)": 3 });
});

Deno.test("coveragePercent rounds and guards divide-by-zero", () => {
  assertEquals(coveragePercent(0, 0), 0);
  assertEquals(coveragePercent(3, 2), 66.67);
  assertEquals(coveragePercent(4, 4), 100);
});

Deno.test("discover merges feeds and records a resource", async () => {
  let captured: Record<string, unknown> = {};
  const ctx = {
    globalArgs: { sshUser: "", defaultTier: "T1", outputDir: "/tmp/fi" },
    writeResource: (
      _spec: string,
      _name: string,
      data: Record<string, unknown>,
    ) => {
      captured = data;
      return Promise.resolve({ name: "discovery" });
    },
  };
  await model.methods.discover.execute(
    {
      cidr: "",
      ports: [22],
      feeds: [
        {
          name: "core",
          address: "10.0.0.1",
          mac: "",
          machineId: "",
          hostnames: [],
          addresses: [],
          source: "nmap",
          tier: "T1",
          os: "debian",
          notes: "",
        },
      ],
      timeoutMs: 100,
      maxHosts: 0,
    },
    ctx,
  );
  assertEquals(captured.scanned, 0);
  const discovered = captured.discovered as Array<{ name: string }>;
  assertEquals(discovered.length, 1);
  assertEquals(discovered[0].name, "core");
});

Deno.test("probe records a host even when SSH fails", async () => {
  let captured: Record<string, unknown> = {};
  const ctx = {
    globalArgs: { sshUser: "", defaultTier: "T2", outputDir: "/tmp/fi" },
    writeResource: (
      _spec: string,
      _name: string,
      data: Record<string, unknown>,
    ) => {
      captured = data;
      return Promise.resolve({ name: "probe" });
    },
  };
  await model.methods.probe.execute(
    { hosts: ["127.0.0.1"], sshUser: "nobody", timeoutMs: 500, refresh: false },
    ctx,
  );
  assertEquals(captured.probed, 0);
  const hosts = captured.hosts as Array<{ tier: string; probed: boolean }>;
  assertEquals(hosts[0].probed, false);
  assertEquals(hosts[0].tier, "T2");
});

Deno.test("probe with empty hosts probes the inventoried hosts", async () => {
  // No explicit hosts -> target the latest discovery's hosts.
  let captured: Record<string, unknown> = {};
  const discovered = [
    mk("127.0.0.1", false),
    mk("127.0.0.2", false),
  ];
  const ctx = {
    globalArgs: { sshUser: "", defaultTier: "T1", outputDir: "/tmp/fi" },
    readResource: (name: string) =>
      Promise.resolve(name === "discovery" ? { discovered } : null),
    writeResource: (
      _spec: string,
      _name: string,
      data: Record<string, unknown>,
    ) => {
      captured = data;
      return Promise.resolve({ name: "probe" });
    },
  };
  await model.methods.probe.execute(
    { hosts: [], sshUser: "nobody", timeoutMs: 200, refresh: false },
    ctx,
  );
  const hosts = captured.hosts as Array<{ address: string }>;
  assertEquals(hosts.length, 2, "should probe both inventoried hosts");
  assertEquals(hosts.map((h) => h.address).sort(), ["127.0.0.1", "127.0.0.2"]);
});

Deno.test("report reads the on-disk inventory and computes coverage", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const hosts: InventoryHost[] = [
      mk("a", true, "T1"),
      mk("b", false, "T2"),
    ];
    await Deno.writeTextFile(
      `${tmp}/inventory.json`,
      JSON.stringify({ hosts }),
    );
    let captured: Record<string, unknown> = {};
    const ctx = {
      globalArgs: { sshUser: "", defaultTier: "T1", outputDir: tmp },
      writeResource: (
        _spec: string,
        _name: string,
        data: Record<string, unknown>,
      ) => {
        captured = data;
        return Promise.resolve({ name: "report" });
      },
    };
    await model.methods.report.execute({}, ctx);
    assertEquals(captured.total, 2);
    assertEquals(captured.reporting, 1);
    assertEquals(captured.coveragePercent, 50);
    assertEquals(captured.silent, ["b"]);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

function mk(name: string, reporting: boolean, tier = "T1"): InventoryHost {
  return {
    name,
    address: name,
    mac: "",
    machineId: "",
    hostnames: [],
    addresses: [],
    macs: [],
    source: "test",
    tier,
    os: "",
    notes: "",
    probed: true,
    reporting,
    silent: !reporting,
    lastSeen: "now",
  };
}

Deno.test("correlate preserves probed facts from the probe resource", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    let captured: {
      hosts?: Array<{ name: string; probed: boolean; os: string }>;
    } = {};
    const probed = [
      {
        ...mk("core", false),
        address: "10.0.0.1",
        probed: true,
        os: "debian",
      },
    ];
    const ctx = {
      globalArgs: { sshUser: "", defaultTier: "T1", outputDir: tmp },
      readResource: (name: string) =>
        Promise.resolve(
          name === "probe" ? { hosts: probed } : { discovered: [] },
        ),
      writeResource: (
        _spec: string,
        _name: string,
        data: Record<string, unknown>,
      ) => {
        captured = data as typeof captured;
        return Promise.resolve({ name: "inventory" });
      },
    };
    await model.methods.correlate.execute({ reportingHosts: ["core"] }, ctx);
    assertEquals(
      captured.hosts?.[0].probed,
      true,
      "probed flag must survive correlate",
    );
    assertEquals(captured.hosts?.[0].os, "debian");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("discover accumulates previously discovered hosts", async () => {
  let captured: { discovered?: Array<{ name: string }> } = {};
  const previous = [mk("old-host", false)];
  const ctx = {
    globalArgs: { sshUser: "", defaultTier: "T1", outputDir: "/tmp/fi" },
    readResource: (name: string) =>
      Promise.resolve(name === "discovery" ? { discovered: previous } : null),
    writeResource: (
      _spec: string,
      _name: string,
      data: Record<string, unknown>,
    ) => {
      captured = data as typeof captured;
      return Promise.resolve({ name: "discovery" });
    },
  };
  await model.methods.discover.execute(
    {
      cidr: "",
      ports: [22],
      feeds: [
        {
          name: "new-host",
          address: "10.0.0.2",
          mac: "",
          machineId: "",
          hostnames: [],
          addresses: [],
          source: "nmap",
          tier: "",
          os: "",
          notes: "",
        },
      ],
      timeoutMs: 100,
      maxHosts: 0,
    },
    ctx,
  );
  const names = (captured.discovered ?? []).map((h) => h.name).sort();
  assertEquals(names, ["new-host", "old-host"], "must keep old and add new");
});

Deno.test("probe accumulates previously probed hosts", async () => {
  let captured: {
    hosts?: Array<{ name: string }>;
    known?: number;
    probed?: number;
  } = {};
  const previous = [
    { ...mk("old-probed", true), probed: true, machineId: "mid-old" },
  ];
  const ctx = {
    globalArgs: { sshUser: "", defaultTier: "T1", outputDir: "/tmp/fi" },
    readResource: (name: string) =>
      Promise.resolve(name === "probe" ? { hosts: previous } : null),
    writeResource: (
      _spec: string,
      _name: string,
      data: Record<string, unknown>,
    ) => {
      captured = data as typeof captured;
      return Promise.resolve({ name: "probe" });
    },
  };
  await model.methods.probe.execute(
    { hosts: ["127.0.0.1"], sshUser: "nobody", timeoutMs: 300, refresh: false },
    ctx,
  );
  // The previously-probed host must survive a new (here: unreachable) probe run.
  const names = (captured.hosts ?? []).map((h) => h.name).sort();
  assert(names.includes("old-probed"), "previously probed host must be kept");
  assertEquals(captured.known, 1, "one host known probed cumulatively");
  assertEquals(captured.probed, 0, "no host probed successfully this run");
});

Deno.test("probe skips already-probed hosts unless refresh is set", async () => {
  const prevProbed = { ...mk("127.0.0.1", true), probed: true };
  const mkCtx = () => {
    let captured: { attempted?: number; hosts?: unknown[] } = {};
    return {
      get captured() {
        return captured;
      },
      ctx: {
        globalArgs: { sshUser: "", defaultTier: "T1", outputDir: "/tmp/fi" },
        readResource: (name: string) =>
          Promise.resolve(
            name === "probe" ? { hosts: [prevProbed] } : {
              discovered: [mk("127.0.0.1", false), mk("127.0.0.2", false)],
            },
          ),
        writeResource: (
          _spec: string,
          _name: string,
          data: Record<string, unknown>,
        ) => {
          captured = data as typeof captured;
          return Promise.resolve({ name: "probe" });
        },
      },
    };
  };
  // Without refresh: 127.0.0.1 is already probed, so only .2 is attempted.
  const a = mkCtx();
  await model.methods.probe.execute(
    { hosts: [], sshUser: "nobody", timeoutMs: 200, refresh: false },
    a.ctx,
  );
  assertEquals(a.captured.attempted, 1, "already-probed host must be skipped");
  // With refresh: both hosts are (re)probed.
  const b = mkCtx();
  await model.methods.probe.execute(
    { hosts: [], sshUser: "nobody", timeoutMs: 200, refresh: true },
    b.ctx,
  );
  assertEquals(b.captured.attempted, 2, "refresh must re-probe the known host");
});
