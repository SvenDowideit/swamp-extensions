import { assert, assertEquals } from "jsr:@std/assert@1";
import { resolveSsh } from "./fleet_inventory.ts";

Deno.test("resolveSsh puts the run input first, then the host, then the global", () => {
  const global = { sshUser: "sven", sshPort: 0 };
  const host = { sshUser: "pi", sshPort: 2222 };
  // An operator sweeping as another user means it, even over a host that
  // declares its own.
  assertEquals(resolveSsh(host, { sshUser: "root", sshPort: 2022 }, global), {
    user: "root",
    port: 2022,
  });
  // Otherwise the host's own identity beats the model global.
  assertEquals(resolveSsh(host, {}, global), { user: "pi", port: 2222 });
  // A host that declares nothing inherits the global.
  assertEquals(resolveSsh({}, {}, global), { user: "sven", port: 0 });
  // An EMPTY global is a deliberate choice to require every host to carry its
  // own user: a host without one is left to ssh, never guessed.
  assertEquals(resolveSsh({}, {}, { sshUser: "", sshPort: 0 }), {
    user: "",
    port: 0,
  });
  assertEquals(resolveSsh(undefined, undefined, undefined), {
    user: "",
    port: 0,
  });
});

Deno.test("a per-host ssh identity survives the merge with a scan record", () => {
  const merged = mergeHosts([
    {
      name: "mk2s",
      address: "10.10.3.253",
      mac: "",
      source: "manual",
      tier: "T1",
      os: "raspbian",
      notes: "",
      sshUser: "pi",
      sshPort: 2222,
    },
    {
      name: "10.10.3.253",
      address: "10.10.3.253",
      mac: "",
      source: "scan",
      tier: "",
      os: "",
      notes: "",
    },
  ], "2026-01-01T00:00:00.000Z");
  assertEquals(merged.length, 1);
  assertEquals(merged[0].sshUser, "pi");
  assertEquals(merged[0].sshPort, 2222);
});

import {
  addressKindFor,
  addressKindsOf,
  applyFingerprints,
  buildNetwork,
  collapseDomains,
  correlate,
  coveragePercent,
  dnsEntriesFor,
  expandCidr,
  expandHome,
  inferTier,
  type InventoryHost,
  mergeHosts,
  mergeInterfaces,
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
    interfaces: [],
    addressKinds: {},
    addressDrift: [],
    searchDomains: [],
    reachedVia: "",
    source: "test",
    tier,
    os: "",
    deviceClass: "",
    vendor: "",
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

Deno.test("applyFingerprints matches by name and address", () => {
  const hosts = [mk("core", false), mk("10.0.0.9", false)];
  const out = applyFingerprints(hosts, [
    { host: "core", deviceClass: "unifi", vendor: "Ubiquiti" },
    { host: "10.0.0.9", deviceClass: "esphome", vendor: "Espressif" },
  ]);
  assertEquals(out[0].deviceClass, "unifi");
  assertEquals(out[0].vendor, "Ubiquiti");
  assertEquals(out[1].deviceClass, "esphome");
});

// ---------------------------------------------------------------------------
// Network uplift: interfaces, address kinds, MAC moves, DNS
// ---------------------------------------------------------------------------

const FACTS = [
  "hostname=xeon",
  "fqdn=xeon.home.org.au",
  "machine_id=6576f07b106c4bfeb93798b912992bb6",
  "os=ubuntu",
  "docker=1",
  "container=0",
  "mem_total_mib=128000",
  "immutable=0",
  "default_route=eno4",
  "iface=lo|00:00:00:00:00:00|0|loopback|unknown",
  "iface=eno4|aa:bb:cc:dd:ee:ff|1|ethernet|manual",
  "iface=tailscale0||0|vpn|unknown",
  "iface=br-027d0bdcec77|02:42:aa:bb:cc:dd|0|bridge|unknown",
  "addrline=lo|127.0.0.1/8",
  "addrline=eno4|10.10.10.123/20",
  "addrline=tailscale0|100.127.51.78/32",
  "addrline=br-027d0bdcec77|172.24.0.1/16",
].join("\n");

Deno.test("parseProbeFacts joins iface and addrline records into interfaces", () => {
  const facts = parseProbeFacts(FACTS);
  assertEquals(facts.fqdn, "xeon.home.org.au");
  assertEquals(facts.defaultRoute, "eno4");
  assertEquals(facts.interfaces.length, 4);
  const eno4 = facts.interfaces.find((i) => i.name === "eno4")!;
  assertEquals(eno4.mac, "aa:bb:cc:dd:ee:ff");
  assertEquals(eno4.physical, true);
  assertEquals(eno4.kind, "ethernet");
  assertEquals(eno4.method, "manual");
  assertEquals(eno4.addresses, ["10.10.10.123/20"]);
  const ts = facts.interfaces.find((i) => i.name === "tailscale0")!;
  assertEquals(ts.kind, "vpn");
  assertEquals(ts.mac, "");
});

Deno.test("parseProbeFacts keeps working for the old scalar facts", () => {
  const facts = parseProbeFacts("hostname=h\nmachine_id=m\nos=debian\n");
  assertEquals(facts.hostname, "h");
  assertEquals(facts.machineId, "m");
  assertEquals(facts.interfaces, []);
});

Deno.test("addressKindFor maps configuration methods to census kinds", () => {
  assertEquals(addressKindFor("manual"), "static");
  assertEquals(addressKindFor("auto"), "dhcp");
  assertEquals(addressKindFor("disabled"), "unknown");
  assertEquals(addressKindFor(""), "unknown");
});

Deno.test("mergeInterfaces unions addresses and prefers the better observation", () => {
  const merged = mergeInterfaces([
    {
      name: "eno4",
      mac: "",
      physical: false,
      kind: "unknown",
      method: "",
      addresses: ["10.0.0.1/24"],
    },
    {
      name: "eno4",
      mac: "aa:bb:cc:dd:ee:ff",
      physical: true,
      kind: "ethernet",
      method: "manual",
      addresses: ["10.0.0.1/24", "10.0.0.2/24"],
    },
  ]);
  assertEquals(merged.length, 1);
  assertEquals(merged[0].mac, "aa:bb:cc:dd:ee:ff");
  assertEquals(merged[0].physical, true);
  assertEquals(merged[0].kind, "ethernet");
  assertEquals(merged[0].addresses.sort(), ["10.0.0.1/24", "10.0.0.2/24"]);
});

Deno.test("addressKindsOf strips the CIDR and keys by address", () => {
  assertEquals(
    addressKindsOf([
      {
        name: "eno4",
        mac: "",
        physical: true,
        kind: "ethernet",
        method: "manual",
        addresses: ["10.10.10.123/20"],
      },
      {
        name: "wlp0s20f3",
        mac: "",
        physical: true,
        kind: "wifi",
        method: "auto",
        addresses: ["10.10.13.208/20"],
      },
    ]),
    { "10.10.10.123": "static", "10.10.13.208": "dhcp" },
  );
});

/** Minimal InventoryHost with the network fields filled. */
function host(
  name: string,
  interfaces: Array<
    {
      name: string;
      mac: string;
      physical: boolean;
      kind: string;
      method: string;
      addresses: string[];
    }
  >,
  extra: Partial<InventoryHost> = {},
): InventoryHost {
  const reported = interfaces.flatMap((i) =>
    i.addresses.map((a) => a.split("/")[0])
  );
  return {
    name,
    address: reported[0] ?? "",
    mac: interfaces.find((i) => i.mac)?.mac ?? "",
    machineId: "",
    hostnames: [name],
    addresses: reported,
    macs: interfaces.map((i) => i.mac).filter(Boolean),
    interfaces,
    addressKinds: addressKindsOf(interfaces),
    addressDrift: [],
    searchDomains: [],
    reachedVia: "",
    source: "probe",
    tier: "T1",
    os: "ubuntu",
    deviceClass: "",
    vendor: "",
    notes: "",
    probed: true,
    reporting: false,
    silent: false,
    lastSeen: "2026-11-21T00:00:00Z",
    ...extra,
  };
}

Deno.test("buildNetwork separates static, pinned and dynamic DHCP across sweeps", () => {
  const ifaces = (addr: string, method = "auto") => [{
    name: "eno4",
    mac: "aa:bb:cc:dd:ee:ff",
    physical: true,
    kind: "ethernet",
    method,
    addresses: [`${addr}/20`],
  }];

  const first = buildNetwork([host("xeon", ifaces("10.10.10.123"))], null, {
    timestamp: "2026-11-21T00:00:00Z",
  });
  assertEquals(first.addresses[0].kind, "dhcp");

  const pinned = buildNetwork([host("xeon", ifaces("10.10.10.123"))], {
    addresses: first.addresses,
  }, { timestamp: "2026-11-22T00:00:00Z" });
  assertEquals(
    pinned.addresses.find((a) => a.address === "10.10.10.123")!.kind,
    "dhcp-pinned",
  );

  const moved = buildNetwork([host("xeon", ifaces("10.10.10.200"))], {
    addresses: first.addresses,
  }, { timestamp: "2026-11-22T00:00:00Z" });
  assertEquals(
    moved.addresses.find((a) => a.address === "10.10.10.200")!.kind,
    "dhcp-dynamic",
  );

  const staticIp = buildNetwork(
    [host("xeon", ifaces("10.10.10.123", "manual"))],
    null,
    {
      timestamp: "2026-11-21T00:00:00Z",
    },
  );
  assertEquals(staticIp.addresses[0].kind, "static");
});

Deno.test("buildNetwork flags a MAC that moved to another host and counts NICs", () => {
  const dock = (addr: string) => [{
    name: "enp0s31f6",
    mac: "de:ad:be:ef:00:01",
    physical: true,
    kind: "ethernet",
    method: "auto",
    addresses: [`${addr}/24`],
  }];

  const before = buildNetwork([host("laptop", dock("10.0.0.5"))], null, {
    timestamp: "2026-11-21T00:00:00Z",
  });
  assertEquals(before.summary.movedMacs, 0);

  const after = buildNetwork(
    [
      host("laptop", [{
        name: "wlp0s20f3",
        mac: "aa:aa:aa:aa:aa:aa",
        physical: true,
        kind: "wifi",
        method: "auto",
        addresses: ["10.0.0.9/24"],
      }]),
      host("desktop", dock("10.0.0.6")),
    ],
    { macs: before.macs, addresses: before.addresses },
    { timestamp: "2026-11-22T00:00:00Z" },
  );
  const moved = after.macs.find((m) => m.mac === "de:ad:be:ef:00:01")!;
  assertEquals(moved.moved, true);
  assertEquals(moved.hosts.sort(), ["desktop", "laptop"]);
  assertEquals(after.summary.movedMacs, 1);
  assertEquals(after.summary.physicalNics, 2);
});

Deno.test("buildNetwork counts software interfaces apart from physical NICs", () => {
  const out = buildNetwork(
    [host("xeon", [
      {
        name: "eno4",
        mac: "aa:bb:cc:dd:ee:ff",
        physical: true,
        kind: "ethernet",
        method: "manual",
        addresses: ["10.0.0.1/24"],
      },
      {
        name: "tailscale0",
        mac: "",
        physical: false,
        kind: "vpn",
        method: "",
        addresses: ["100.64.0.1/32"],
      },
      {
        name: "docker0",
        mac: "02:42:00:00:00:01",
        physical: false,
        kind: "bridge",
        method: "",
        addresses: ["172.17.0.1/16"],
      },
      {
        name: "lo",
        mac: "00:00:00:00:00:00",
        physical: false,
        kind: "loopback",
        method: "",
        addresses: ["127.0.0.1/8"],
      },
    ])],
    null,
    { timestamp: "2026-11-21T00:00:00Z" },
  );
  assertEquals(out.hosts[0].physicalNics, 1);
  assertEquals(out.hosts[0].softwareInterfaces, 2);
});

Deno.test("buildNetwork ignores loopback for MACs, addresses and DNS", () => {
  const out = buildNetwork(
    [host("a", [
      {
        name: "lo",
        mac: "00:00:00:00:00:00",
        physical: false,
        kind: "loopback",
        method: "",
        addresses: ["127.0.0.1/8", "::1/128"],
      },
      {
        name: "eno1",
        mac: "aa:aa:aa:aa:aa:aa",
        physical: true,
        kind: "ethernet",
        method: "manual",
        addresses: ["10.0.0.1/24"],
      },
    ])],
    null,
    {
      timestamp: "2026-11-21T00:00:00Z",
      // a hosts-file loopback answer is not a DNS disagreement
      dns: { a: ["127.0.1.1"] },
    },
  );
  assertEquals(out.macs.map((m) => m.mac), ["aa:aa:aa:aa:aa:aa"]);
  assertEquals(out.macs[0].moved, false);
  assertEquals(out.addresses.map((a) => a.address), ["10.0.0.1"]);
  assertEquals(out.summary.dnsMismatches, 0);
});

Deno.test("buildNetwork finds a DNS name that resolves away from the host's addresses", () => {
  const out = buildNetwork(
    [host(
      "xeon",
      [{
        name: "eno4",
        mac: "",
        physical: true,
        kind: "ethernet",
        method: "manual",
        addresses: ["10.10.10.123/20"],
      }],
      { hostnames: ["xeon", "xeon.home.org.au"] },
    )],
    null,
    {
      timestamp: "2026-11-21T00:00:00Z",
      dns: { "xeon": ["10.10.10.126"], "xeon.home.org.au": ["10.10.10.123"] },
    },
  );
  assertEquals(out.summary.dnsMismatches, 1);
  assertEquals(out.dnsMismatches[0].name, "xeon");
  assertEquals(out.dnsMismatches[0].resolved, ["10.10.10.126"]);
  // dnsAddresses is DNS's view of the host (union of every name's A records)
  assertEquals(out.hosts[0].dnsAddresses, ["10.10.10.123", "10.10.10.126"]);
});

Deno.test("correlate records address drift when the host did not report a stored address", () => {
  const h = host("xeon", [{
    name: "eno4",
    mac: "",
    physical: true,
    kind: "ethernet",
    method: "manual",
    addresses: ["10.10.10.123/20"],
  }], {
    addresses: ["10.10.10.123", "10.10.10.126"],
  });
  const [out] = correlate([h], [], "2026-11-21T00:00:00Z");
  assertEquals(out.addressDrift, ["10.10.10.126"]);
  assertEquals(out.addressKinds["10.10.10.123"], "static");
});

Deno.test("dnsEntriesFor looks a host up in every configured domain", () => {
  const h = host("xeon", [{
    name: "eno4",
    mac: "",
    physical: true,
    kind: "ethernet",
    method: "manual",
    addresses: ["10.10.10.123/20"],
  }]);
  const entries = dnsEntriesFor(
    h,
    [
      { domain: "home.org.au", swampManaged: false, source: "dhcp" },
      { domain: "fi.gy", swampManaged: true, source: "swamp" },
    ],
    {
      "xeon": ["100.127.51.78"],
      "xeon.home.org.au": ["10.10.10.123"],
      "xeon.fi.gy": [],
    },
    new Set(["10.10.10.123", "100.127.51.78"]),
  );
  const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
  // the bare name resolves (to a tailnet address) and does reach the host
  assertEquals(byName["xeon"].matchesHost, true);
  assertEquals(byName["xeon"].swampManaged, false);
  // home.org.au is the right address, not swamp-managed
  assertEquals(byName["xeon.home.org.au"].matchesHost, true);
  assertEquals(byName["xeon.home.org.au"].swampManaged, false);
  // fi.gy has no record for the host: present as data, no addresses
  assertEquals(byName["xeon.fi.gy"].addresses, []);
  assertEquals(byName["xeon.fi.gy"].swampManaged, true);
  // a name that resolves elsewhere is stale, not silent
  const stale = dnsEntriesFor(
    h,
    [{ domain: "home.org.au", swampManaged: false, source: "dhcp" }],
    { "xeon.home.org.au": ["10.10.10.126"] },
    new Set(["10.10.10.123"]),
  );
  assertEquals(stale[0].matchesHost, false);
});

Deno.test("buildNetwork reports per-domain dns, no-DNS hosts and stale names", () => {
  const out = buildNetwork(
    [
      host("xeon", [{
        name: "eno4",
        mac: "",
        physical: true,
        kind: "ethernet",
        method: "manual",
        addresses: ["10.10.10.123/20"],
      }]),
      host("ghost", [{
        name: "eno1",
        mac: "",
        physical: true,
        kind: "ethernet",
        method: "manual",
        addresses: ["10.0.0.2/24"],
      }]),
    ],
    null,
    {
      timestamp: "2026-11-21T00:00:00Z",
      domains: [{ domain: "home.org.au", swampManaged: false, source: "dhcp" }],
      dns: {
        "xeon": [],
        "xeon.home.org.au": ["10.10.10.123"],
        "ghost": [],
        "ghost.home.org.au": ["10.0.0.99"],
      },
    },
  );
  const xeon = out.hosts.find((h) => h.host === "xeon")!;
  assertEquals(
    xeon.dns.find((d) => d.name === "xeon.home.org.au")!.matchesHost,
    true,
  );
  const ghost = out.hosts.find((h) => h.host === "ghost")!;
  assertEquals(
    ghost.dns.find((d) => d.name === "ghost.home.org.au")!.matchesHost,
    false,
  );
  assertEquals(out.summary.staleNames, 1); // ghost.home.org.au -> 10.0.0.99
  assertEquals(out.summary.hostsWithNoDns, 0);
  assertEquals(out.domains, [
    { domain: "home.org.au", swampManaged: false, source: "dhcp" },
  ]);
});

Deno.test("collapseDomains keeps the widest zone and marks it swamp-managed", () => {
  const kept = collapseDomains([
    { domain: "home.org.au", swampManaged: false, source: "dhcp" },
    { domain: "eieio.fi.gy", swampManaged: true, source: "swamp" },
    { domain: "fi.gy", swampManaged: false, source: "configured" },
    { domain: "otel.fi.gy", swampManaged: true, source: "swamp" },
  ]);
  assertEquals(kept.map((d) => d.domain).sort(), ["fi.gy", "home.org.au"]);
  // the widest zone inherits the strongest provenance: swamp serves fi.gy
  assertEquals(kept.find((d) => d.domain === "fi.gy")!.swampManaged, true);
  assertEquals(kept.find((d) => d.domain === "fi.gy")!.source, "swamp");
  assertEquals(kept.find((d) => d.domain === "home.org.au")!.source, "dhcp");
});

Deno.test("parseProbeFacts collects the DHCP search domain and per-link domains", () => {
  const facts = parseProbeFacts([
    "hostname=p1gen4",
    "search_domain=home.org.au",
    "iface=wlp9s0|aa:bb:cc:dd:ee:ff|1|wifi|auto|0|home.org.au",
    "iface=enx083a8861a2d7|11:22:33:44:55:66|1|ethernet|auto|0|home.org.au,corp.example",
    "iface=lo|00:00:00:00:00:00|0|loopback||0|",
    "addrline=wlp9s0|10.0.0.5/24|1",
  ].join("\n"));
  assertEquals(facts.searchDomains.sort(), ["corp.example", "home.org.au"]);
});

Deno.test("buildNetwork does not call a rotating IPv6 privacy address dynamic", () => {
  const iface = (addr: string) => [{
    name: "wlp9s0",
    mac: "aa:bb:cc:dd:ee:ff",
    physical: true,
    kind: "wifi",
    method: "auto",
    addresses: [`${addr}/128`],
  }];
  const first = buildNetwork([host("p1gen4", iface("fd35::1111"))], null, {
    timestamp: "2026-11-21T00:00:00Z",
  });
  const second = buildNetwork([host("p1gen4", iface("fd35::2222"))], {
    addresses: first.addresses,
  }, { timestamp: "2026-11-22T00:00:00Z" });
  // IPv6 stays plain dhcp; only IPv4 gains pinned/dynamic
  assertEquals(
    second.addresses.find((a) => a.address === "fd35::2222")!.kind,
    "dhcp",
  );
});
