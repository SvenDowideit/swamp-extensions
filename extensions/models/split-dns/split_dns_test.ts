import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1";
import {
  chooseUpstream,
  dedupe,
  discoverAuthoritativeNameservers,
  type DnsResolver,
  fromBase64,
  type HostFacts,
  isIpAddress,
  isLoopbackAddress,
  mergeZoneRules,
  normalizeHosts,
  normalizeZone,
  parseHostFacts,
  parseNmcliDns,
  parseResolvConf,
  parseResolvectlDns,
  parseSections,
  parseState,
  parseVerifyOutput,
  renderApplyScript,
  renderClientResolvConf,
  renderDnsmasqConfig,
  renderNixosModule,
  renderRemoveScript,
  renderRollbackScript,
  renderSystemdUnit,
  resolveExplicitNameservers,
  shellQuote,
  stateFingerprint,
  toBase64,
  usableUpstream,
  type ZoneRule,
} from "./split_dns.ts";

const MARK = "###SPLITDNS:";

function section(name: string, value: string): string {
  return `${MARK}${name}\n${value}\n###SPLITDNS:END`;
}

function b64Section(name: string, value: string): string {
  return section(name, toBase64(value));
}

function facts(overrides: Partial<HostFacts> = {}): HostFacts {
  return {
    osId: "ubuntu",
    osName: "Ubuntu 26.04 LTS",
    hostname: "eieio",
    nixos: false,
    resolvedActive: true,
    nmActive: true,
    resolvconfPresent: false,
    dnsmasqPath: "/usr/sbin/dnsmasq",
    digPresent: true,
    resolvectlPresent: true,
    getentPresent: true,
    serviceActive: false,
    serviceEnabled: false,
    resolvConf: "nameserver 127.0.0.53\n",
    resolvIsSymlink: true,
    resolvTarget: "../run/systemd/resolve/stub-resolv.conf",
    upstreamResolvConf: "nameserver 10.0.0.1\n",
    nmResolvConf: "",
    stateText: "",
    configText: "",
    upstreamConfigText: "",
    unitText: "",
    nmConfText: "",
    resolvconfHeadText: "",
    nixosModuleText: "",
    nixosWrapperText: "",
    resolvectlDns: "Link 3 (eth0): 10.0.0.1\n",
    nmcliDns: "IP4.DNS[1]:10.0.0.1\n",
    backupDirs: [],
    ...overrides,
  };
}

Deno.test("normalizeZone trims, lowercases and rejects unsafe labels", () => {
  assertEquals(normalizeZone("  Dev.Fi.GY. "), "dev.fi.gy");
  assertThrows(() => normalizeZone(""));
  assertThrows(() => normalizeZone("bad_zone.example"));
  assertThrows(() => normalizeZone("a..b"));
  assertThrows(() => normalizeZone("line\nbreak"));
});

Deno.test("parseResolvConf reads nameservers, search and options", () => {
  const parsed = parseResolvConf(
    "# comment\nnameserver 10.0.0.1\nnameserver 10.0.0.1\n" +
      "search fi.gy home.arpa\noptions edns0 trust-ad\n",
  );
  assertEquals(parsed.nameservers, ["10.0.0.1"]);
  assertEquals(parsed.search, ["fi.gy", "home.arpa"]);
  assertEquals(parsed.options, ["edns0", "trust-ad"]);
});

Deno.test("resolver output parsers extract only IP tokens", () => {
  assertEquals(
    parseResolvectlDns(
      "Global:\nLink 3 (wlp0s20f3): 10.10.10.1 2001:db8::1\nLink 4: 100.100.100.100\n",
    ),
    ["10.10.10.1", "2001:db8::1", "100.100.100.100"],
  );
  assertEquals(
    parseNmcliDns(
      "IP4.DNS[1]:10.10.10.1\nIP6.DNS[1]:2001:db8::53\nGENERAL.DEVICE:eth0\n",
    ),
    ["10.10.10.1", "2001:db8::53"],
  );
});

Deno.test("usableUpstream drops loopback and the local listener", () => {
  assertEquals(
    usableUpstream(
      ["127.0.0.1", "127.0.0.53", "::1", "10.0.0.1", "10.0.0.1"],
      "127.0.0.1",
    ),
    ["10.0.0.1"],
  );
  assert(isLoopbackAddress("127.0.0.53"));
  assert(isIpAddress("10.0.0.1"));
  assert(isIpAddress("2001:db8::1"));
  assert(!isIpAddress("ns1.example.net"));
});

Deno.test("normalizeHosts accepts local, user@host:port, IPv6 and objects", () => {
  assertEquals(normalizeHosts([], ""), [{
    name: "local",
    address: "localhost",
    user: "",
    port: 22,
    local: true,
  }]);
  const hosts = normalizeHosts([
    "eieio",
    "sven@blue:2222",
    "local",
    "[2001:db8::1]:2200",
    { name: "pi", address: "10.0.0.5", user: "admin", port: 22, local: false },
  ], "deploy");
  assertEquals(hosts[0], {
    name: "eieio",
    address: "eieio",
    user: "deploy",
    port: 22,
    local: false,
  });
  assertEquals(hosts[1], {
    name: "blue",
    address: "blue",
    user: "sven",
    port: 2222,
    local: false,
  });
  assertEquals(hosts[3], {
    name: "2001:db8::1",
    address: "2001:db8::1",
    user: "deploy",
    port: 2200,
    local: false,
  });
  assertThrows(() => normalizeHosts(["bad host"], ""));
  assertThrows(() => normalizeHosts(["a@b@c"], ""));
});

Deno.test("mergeZoneRules merges, replaces and removes without losing others", () => {
  const a: ZoneRule = {
    zone: "a.example",
    nameservers: ["1.1.1.1"],
    source: "explicit",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const b: ZoneRule = {
    zone: "b.example",
    nameservers: ["2.2.2.2"],
    source: "authoritative",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const bNew: ZoneRule = {
    zone: "b.example",
    nameservers: ["3.3.3.3"],
    source: "explicit",
    updatedAt: "2026-02-01T00:00:00.000Z",
  };
  const merged = mergeZoneRules([a, b], [bNew]);
  assertEquals(merged.map((r) => r.zone), ["a.example", "b.example"]);
  assertEquals(merged[1].nameservers, ["3.3.3.3"]);

  assertEquals(mergeZoneRules([a, b], [bNew], { replace: true }), [bNew]);
  assertEquals(
    mergeZoneRules([a, b], [bNew], { remove: true }).map((r) => r.zone),
    ["a.example"],
  );
});

Deno.test("renderDnsmasqConfig uses DHCP defaults and per-zone servers", () => {
  const zones: ZoneRule[] = [{
    zone: "dev.fi.gy",
    nameservers: ["192.0.2.53", "192.0.2.54"],
    source: "authoritative",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }];
  const live = renderDnsmasqConfig({
    zones,
    upstream: [],
    upstreamFile: "/run/systemd/resolve/resolv.conf",
    listenAddress: "127.0.0.1",
    listenPort: 53,
  });
  assert(live.includes("resolv-file=/run/systemd/resolve/resolv.conf"));
  assert(live.includes("server=/dev.fi.gy/192.0.2.53"));
  assert(live.includes("server=/dev.fi.gy/192.0.2.54"));
  assert(!live.includes("no-resolv"));

  const captured = renderDnsmasqConfig({
    zones,
    upstream: ["10.0.0.1"],
    listenAddress: "127.0.0.1",
    listenPort: 5353,
  });
  assert(captured.includes("no-resolv"));
  assert(captured.includes("server=10.0.0.1"));
  assert(captured.includes("port=5353"));
});

Deno.test("client resolv.conf and systemd unit carry the managed marker", () => {
  const resolv = renderClientResolvConf("127.0.0.1", ["fi.gy"], ["edns0"]);
  assert(resolv.includes("nameserver 127.0.0.1"));
  assert(resolv.includes("search fi.gy"));
  assert(resolv.includes("options edns0"));

  const unit = renderSystemdUnit(
    "/usr/sbin/dnsmasq",
    "/etc/split-dns/dnsmasq.conf",
  );
  assert(unit.includes("ExecStart=/usr/sbin/dnsmasq"));
  assert(unit.includes("--conf-file=/etc/split-dns/dnsmasq.conf"));
  assert(unit.includes("WantedBy=multi-user.target"));
});

Deno.test("NixOS module only overrides resolv.conf when asked", () => {
  const enforcing = renderNixosModule({
    listenAddress: "127.0.0.1",
    configPath: "/etc/split-dns/dnsmasq.conf",
    search: ["fi.gy"],
    manageResolver: true,
  });
  assert(enforcing.includes('environment.etc."resolv.conf"'));
  assert(
    enforcing.includes('networking.nameservers = lib.mkForce [ "127.0.0.1" ]'),
  );
  assert(enforcing.includes("pkgs.dnsmasq"));

  const passive = renderNixosModule({
    listenAddress: "127.0.0.1",
    configPath: "/etc/split-dns/dnsmasq.conf",
    search: [],
    manageResolver: false,
  });
  assert(!passive.includes('environment.etc."resolv.conf"'));
  assert(passive.includes("systemd.services.split-dns"));
});

Deno.test("stateFingerprint ignores timestamps but catches real changes", () => {
  const one = JSON.stringify({
    version: 1,
    managedBy: "@svendowideit/split-dns",
    os: "ubuntu",
    resolverMode: "networkmanager",
    listenAddress: "127.0.0.1",
    listenPort: 53,
    upstreamSource: "/run/systemd/resolve/resolv.conf",
    zones: [{
      zone: "dev.fi.gy",
      nameservers: ["192.0.2.53"],
      source: "authoritative",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }],
    appliedAt: "2026-01-01T00:00:00.000Z",
  });
  const two = JSON.stringify({
    version: 1,
    managedBy: "@svendowideit/split-dns",
    os: "ubuntu",
    resolverMode: "networkmanager",
    listenAddress: "127.0.0.1",
    listenPort: 53,
    upstreamSource: "/run/systemd/resolve/resolv.conf",
    zones: [{
      zone: "dev.fi.gy",
      nameservers: ["192.0.2.53"],
      source: "authoritative",
      updatedAt: "2026-02-02T00:00:00.000Z",
    }],
    appliedAt: "2026-02-02T00:00:00.000Z",
  });
  assertEquals(stateFingerprint(one), stateFingerprint(two));

  const changed = one.replace("192.0.2.53", "192.0.2.99");
  assert(stateFingerprint(one) !== stateFingerprint(changed));
  assertEquals(parseState("{not json"), null);
  assertEquals(parseState(one)?.listenPort, 53);
});

Deno.test("base64 and shell quoting round-trip", () => {
  const text = "line one\nline 'two'\n";
  assertEquals(fromBase64(toBase64(text)), text);
  assertEquals(shellQuote("a'b"), `'a'"'"'b'`);
  assertEquals(dedupe(["a", "b", "a"]), ["a", "b"]);
});

Deno.test("parseHostFacts reads the sectioned inspect output", () => {
  const stdout = [
    section("OS_ID", "ubuntu"),
    section("OS_NAME", "Ubuntu 26.04 LTS"),
    section("HOSTNAME", "eieio"),
    section("NIXOS", "no"),
    section("RESOLVED_ACTIVE", "yes"),
    section("NM_ACTIVE", "yes"),
    section("RESOLVCONF_PRESENT", "no"),
    section("DNSMASQ_BIN", "/usr/sbin/dnsmasq"),
    section("DIG_PRESENT", "yes"),
    section("RESOLVECTL_PRESENT", "yes"),
    section("GETENT_PRESENT", "yes"),
    section("SERVICE_ACTIVE", "active"),
    section("SERVICE_ENABLED", "enabled"),
    b64Section("RESOLV_CONF", "nameserver 127.0.0.53\n"),
    section("RESOLV_IS_SYMLINK", "yes"),
    section("RESOLV_TARGET", "../run/systemd/resolve/stub-resolv.conf"),
    b64Section("UPSTREAM_RESOLV_CONF", "nameserver 10.0.0.1\n"),
    b64Section("NM_RESOLV_CONF", "nameserver 10.0.0.2\n"),
    b64Section("STATE", "{}"),
    b64Section("CONFIG", "port=53\n"),
    b64Section("UPSTREAM_CONFIG", ""),
    b64Section("UNIT", "[Unit]\n"),
    b64Section("NM_CONF", ""),
    b64Section("RESOLVCONF_HEAD", ""),
    b64Section("NIXOS_MODULE", ""),
    b64Section("NIXOS_WRAPPER", ""),
    section("RESOLVECTL_DNS", "Link 3 (eth0): 10.0.0.1"),
    section("NMCLI_DNS", "IP4.DNS[1]:10.0.0.1"),
    section(
      "BACKUP_DIRS",
      "/etc/split-dns/backups/a/\n/etc/split-dns/backups/b/",
    ),
  ].join("\n");
  const parsed = parseHostFacts(stdout);
  assertEquals(parsed.osId, "ubuntu");
  assertEquals(parsed.osName, "Ubuntu 26.04 LTS");
  assertEquals(parsed.hostname, "eieio");
  assertEquals(parsed.nixos, false);
  assertEquals(parsed.resolvedActive, true);
  assertEquals(parsed.nmActive, true);
  assertEquals(parsed.dnsmasqPath, "/usr/sbin/dnsmasq");
  assertEquals(parsed.digPresent, true);
  assertEquals(parsed.serviceActive, true);
  assertEquals(parsed.resolvConf, "nameserver 127.0.0.53\n");
  assertEquals(parsed.upstreamResolvConf, "nameserver 10.0.0.1\n");
  assertEquals(parsed.nmResolvConf, "nameserver 10.0.0.2\n");
  assertEquals(parsed.backupDirs.length, 2);
});

Deno.test("chooseUpstream prefers the live DHCP view then falls back safely", () => {
  const live = chooseUpstream(facts(), "127.0.0.1");
  assertEquals(live.upstreamFile, "/run/systemd/resolve/resolv.conf");
  assertEquals(live.nameservers, ["10.0.0.1"]);

  const captured = chooseUpstream(
    facts({
      upstreamResolvConf: "",
      resolvConf: "nameserver 192.168.1.1\n",
    }),
    "127.0.0.1",
  );
  assertEquals(captured.upstreamFile, "");
  assertEquals(captured.nameservers, ["192.168.1.1"]);

  const networkManager = chooseUpstream(
    facts({
      upstreamResolvConf: "",
      nmResolvConf: "nameserver 192.168.1.1\n",
      resolvConf: "nameserver 127.0.0.1\n",
    }),
    "127.0.0.1",
  );
  assertEquals(
    networkManager.upstreamFile,
    "/run/NetworkManager/resolv.conf",
  );
  assertEquals(networkManager.nameservers, ["192.168.1.1"]);

  const snapshot = chooseUpstream(
    facts({
      upstreamResolvConf: "",
      nmResolvConf: "",
      resolvConf: "nameserver 127.0.0.1\n",
      resolvectlDns: "",
      nmcliDns: "",
      upstreamConfigText: "nameserver 203.0.113.53\n",
    }),
    "127.0.0.1",
  );
  assertEquals(snapshot.source, "managed upstream snapshot");
  assertEquals(snapshot.nameservers, ["203.0.113.53"]);
});

Deno.test("parseVerifyOutput distinguishes success, failure and resolvectl fallback", () => {
  const success = parseVerifyOutput(
    [
      section("SERVICE_ACTIVE", "active"),
      section("CONFIG_TEST", "dnsmasq: syntax check OK.\nEXIT:0"),
      section(
        "LOCAL_ZONE",
        "ns1.example. hostmaster.example. 1 7200 3600 1209600 3600",
      ),
      section("LOCAL_CONTROL", "93.184.216.34"),
      section(
        "SYSTEM_ZONE",
        "ns1.example. hostmaster.example. 1 7200 3600 1209600 3600",
      ),
      section("SYSTEM_CONTROL", "93.184.216.34"),
      section("SERVICE_STATUS", "active (running)"),
    ].join("\n"),
    {
      digPresent: true,
      resolvectlPresent: true,
      manageResolver: true,
      zone: "dev.fi.gy",
      controlName: "example.com",
      testName: "",
    },
  );
  assertEquals(success.serviceActive, true);
  assertEquals(success.configTest, true);
  assertEquals(success.localZone.status, "passed");
  assertEquals(success.systemControl.status, "passed");

  const failed = parseVerifyOutput(
    [
      section("SERVICE_ACTIVE", "failed"),
      section("CONFIG_TEST", "bad address at line 1\nEXIT:1"),
      section("SYSTEM_CONTROL", "not found"),
    ].join("\n"),
    {
      digPresent: true,
      resolvectlPresent: false,
      manageResolver: true,
      zone: "dev.fi.gy",
      controlName: "example.com",
      testName: "",
    },
  );
  assertEquals(failed.configTest, false);
  assertEquals(failed.localZone.status, "failed");
  assertEquals(failed.systemControl.status, "failed");

  const fallback = parseVerifyOutput(
    [
      section("SERVICE_ACTIVE", "active"),
      section("CONFIG_TEST", "OK\nEXIT:0"),
      section("RESOLVECTL_CONTROL", "example.com: 93.184.216.34"),
    ].join("\n"),
    {
      digPresent: false,
      resolvectlPresent: true,
      manageResolver: true,
      zone: "dev.fi.gy",
      controlName: "example.com",
      testName: "",
    },
  );
  assertEquals(fallback.localZone.status, "skipped");
  assertEquals(fallback.systemControl.status, "passed");
});

Deno.test("discoverAuthoritativeNameservers resolves NS hostnames", async () => {
  const answers: Record<string, string[]> = {
    "dev.fi.gy:NS": ["ns1.example.", "ns2.example."],
    "ns1.example:A": ["192.0.2.53"],
    "ns2.example:A": ["192.0.2.54"],
    "ns1.example:AAAA": [],
    "ns2.example:AAAA": [],
  };
  const resolver: DnsResolver = {
    resolve: (name, type) => Promise.resolve(answers[`${name}:${type}`] ?? []),
  };
  assertEquals(
    await discoverAuthoritativeNameservers("dev.fi.gy", resolver),
    ["192.0.2.53", "192.0.2.54"],
  );

  const throwing: DnsResolver = {
    resolve: () => Promise.reject(new Error("NXDOMAIN")),
  };
  await assertRejects(
    () => discoverAuthoritativeNameservers("dev.fi.gy", throwing),
    Error,
    "could not read NS records",
  );
});

Deno.test("resolveExplicitNameservers accepts IPs and resolves hostnames", async () => {
  const resolver: DnsResolver = {
    resolve: (name, type) =>
      Promise.resolve(
        name === "ns1.example" && type === "A" ? ["192.0.2.53"] : [],
      ),
  };
  assertEquals(
    await resolveExplicitNameservers(["192.0.2.1", "ns1.example"], resolver),
    ["192.0.2.1", "192.0.2.53"],
  );
  await assertRejects(
    () => resolveExplicitNameservers([], resolver),
    Error,
    "no usable nameservers",
  );
});

Deno.test("parseSections tolerates empty sections", () => {
  const sections = parseSections(
    `${MARK}A\nvalue\n###SPLITDNS:END\n${MARK}B\n\n###SPLITDNS:END`,
  );
  assertEquals(sections.get("A"), "value");
  assertEquals(sections.get("B"), "");
});

async function assertShellSyntax(script: string): Promise<void> {
  // swamp-quality-ignore deno-command
  const proc = new Deno.Command("sh", {
    args: ["-n"],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = proc.stdin.getWriter();
  await writer.write(new TextEncoder().encode(script));
  await writer.close();
  const output = await proc.output();
  const err = new TextDecoder().decode(output.stderr);
  assertEquals(output.code, 0, `shell syntax error: ${err}\n${script}`);
}

Deno.test("generated apply/rollback/remove scripts are valid shell", async () => {
  const debian = facts({
    osId: "debian",
    osName: "Debian GNU/Linux 13",
    resolvconfPresent: true,
    nmActive: false,
    upstreamResolvConf: "",
    resolvConf: "nameserver 10.0.0.1\nsearch fi.gy\n",
  });
  await assertShellSyntax(renderApplyScript(debian, { manageResolver: true }));
  await assertShellSyntax(renderRollbackScript(debian));
  await assertShellSyntax(renderRemoveScript(debian));

  const nixos = facts({
    osId: "nixos",
    osName: "NixOS 26.05",
    nixos: true,
    nmActive: false,
    resolvconfPresent: false,
    dnsmasqPath: "",
    upstreamResolvConf: "nameserver 10.0.0.1\n",
  });
  await assertShellSyntax(renderApplyScript(nixos, { manageResolver: true }));
  await assertShellSyntax(renderRollbackScript(nixos));
  await assertShellSyntax(renderRemoveScript(nixos));
});
