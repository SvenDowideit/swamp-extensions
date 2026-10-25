import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  buildHtml,
  buildRemoteScript,
  caddyModelNames,
  escapeHtml,
  type HostResult,
  matchCves,
  normalizeHosts,
  parseAptSimulation,
  parseCaddyModelFacts,
  parseDebsecanDetail,
  parseHostOutput,
  parseProSecurity,
  parseSections,
  pickSourceCaddy,
  statusRouteHostname,
  type Summary,
} from "./network_status.ts";

const APT =
  `Inst openssl [3.0.1-1] (3.0.2-1 Ubuntu:24.04/noble-security, Ubuntu:24.04/noble-updates [amd64]) []
Inst tzdata [2024a-1] (2024b-1 Ubuntu:24.04/noble-updates [all]) []
Inst libssl3 [3.0.1-1] (3.0.2-1 Debian-Security:13/stable-security [amd64]) []
`;

const PRO = JSON.stringify({
  summary: {
    num_standard_security_updates: 2,
    num_esm_apps_updates: 3,
    num_esm_infra_updates: 0,
    ua: {
      attached: false,
      enabled_services: [],
    },
  },
  packages: [
    {
      package: "openssl",
      version: "3.0.2-1",
      service_name: "standard-security",
      status: "upgrade_available",
      origin: "ports.ubuntu.com",
    },
    {
      package: "gh",
      version: "2.0",
      service_name: "esm-apps",
      status: "pending_attach",
      origin: "esm.ubuntu.com",
    },
  ],
});

const DEBSECAN = `CVE-2025-1234 (fixed)
  installed: openssl 3.0.1-1
  fixed on branch:   bookworm 3.0.2-1
  fix is available for the selected suite (bookworm)

CVE-2025-9999
  installed: tzdata 2024a-1
  fixed on branch:   bookworm 2024b-1
`;

const OUTPUT = `###ID
ubuntu
###ID_LIKE
debian
###VERSION_ID
24.04
###VERSION_CODENAME
noble
###PRETTY_NAME
Ubuntu 24.04 LTS
###HOSTNAME
eieio
###UNAME
aarch64
###APT_EXIT
0
###APT
${APT}###ENDAPT
###PRO
${PRO}
###DEBSECAN
${DEBSECAN}
###END
`;

Deno.test("parseSections splits the remote audit markers", () => {
  const sections = parseSections(OUTPUT);
  assertEquals(sections.get("ID"), "ubuntu");
  assertEquals(sections.get("HOSTNAME"), "eieio");
  assert(sections.get("APT")?.includes("Inst openssl"));
});

Deno.test("parseAptSimulation classifies security by origin", () => {
  const updates = parseAptSimulation(APT, "-security");
  assertEquals(updates.length, 3);
  const openssl = updates.find((u) => u.name === "openssl");
  assert(openssl?.isSecurity);
  assertEquals(openssl?.currentVersion, "3.0.1-1");
  assertEquals(openssl?.candidateVersion, "3.0.2-1");
  const tzdata = updates.find((u) => u.name === "tzdata");
  assertEquals(tzdata?.isSecurity, false);
});

Deno.test("parseAptSimulation trusts Ubuntu Pro standard-security packages", () => {
  const updates = parseAptSimulation(APT, "-security", new Set(["tzdata"]));
  assertEquals(updates.find((u) => u.name === "tzdata")?.isSecurity, true);
});

Deno.test("parseProSecurity reads the summary and package list", () => {
  const pro = parseProSecurity(PRO);
  assert(pro.available);
  assertEquals(pro.standardSecurityUpdates, 2);
  assertEquals(pro.esmAppsUpdates, 3);
  assertEquals(pro.attached, false);
  assertEquals(pro.packages.length, 2);
  assertEquals(pro.packages[0].service, "standard-security");
});

Deno.test("parseProSecurity treats missing output as unavailable", () => {
  assertEquals(parseProSecurity("__MISSING__").available, false);
  assertEquals(parseProSecurity("not json").available, false);
});

Deno.test("parseDebsecanDetail extracts CVEs, fixes and suite availability", () => {
  const cves = parseDebsecanDetail(DEBSECAN);
  assertEquals(cves.length, 2);
  assertEquals(cves[0].cve, "CVE-2025-1234");
  assertEquals(cves[0].fixedVersions, ["3.0.2-1"]);
  assertEquals(cves[0].fixAvailableInSuite, true);
  assertEquals(cves[1].fixAvailableInSuite, false);
});

Deno.test("matchCves attaches CVEs to the matching package update", () => {
  const cves = parseDebsecanDetail(DEBSECAN);
  const updates = matchCves(parseAptSimulation(APT, "-security"), cves);
  assertEquals(updates.find((u) => u.name === "openssl")?.cves, [
    "CVE-2025-1234",
  ]);
  assertEquals(updates.find((u) => u.name === "tzdata")?.cves, [
    "CVE-2025-9999",
  ]);
});

Deno.test("normalizeHosts accepts strings and objects and removes duplicates", () => {
  const hosts = normalizeHosts([
    "sven@10.0.0.1:2222",
    {
      name: "eieio",
      address: "10.0.0.2",
      user: "sven",
      port: 22,
      os: "ubuntu",
      local: false,
    },
    "sven@10.0.0.1:2222",
    "localhost",
  ], "sven");
  assertEquals(hosts.length, 3);
  assertEquals(hosts[0].address, "10.0.0.1");
  assertEquals(hosts[0].port, 2222);
  assertEquals(hosts[2].local, true);
});

Deno.test("parseHostOutput combines package, Pro and debsecan data", () => {
  const host = parseHostOutput(
    {
      name: "eieio",
      address: "10.10.1.77",
      user: "sven",
      port: 22,
      os: "ubuntu",
      local: false,
    },
    { code: 0, stdout: OUTPUT, stderr: "" },
    "-security",
    "2026-10-25T00:00:00.000Z",
    2,
    true,
    Date.parse("2026-10-25T00:10:00.000Z"),
  );
  assert(host.ok);
  assert(host.debian);
  assertEquals(host.os, "ubuntu");
  assertEquals(host.updateCount, 3);
  assertEquals(host.securityCount, 2);
  assertEquals(host.esmCount, 0);
  assertEquals(host.pro.standardSecurityUpdates, 2);
  assertEquals(host.cveCount, 2);
  assertEquals(host.actionableCveCount, 1);
  assertEquals(host.stale, false);
});

Deno.test("parseHostOutput marks a non-Debian host as skipped", () => {
  const host = parseHostOutput(
    {
      name: "mac",
      address: "10.10.15.140",
      user: "sven",
      port: 22,
      os: "darwin",
      local: false,
    },
    { code: 0, stdout: "###NOT_DEBIAN\n###END\n", stderr: "" },
    "-security",
    "2026-10-25T00:00:00.000Z",
    2,
  );
  assertEquals(host.ok, false);
  assertEquals(host.debian, false);
  assertEquals(host.error, "not a Debian-based host");
});

Deno.test("parseHostOutput marks an old result stale", () => {
  const host = parseHostOutput(
    {
      name: "eieio",
      address: "10.10.1.77",
      user: "sven",
      port: 22,
      os: "ubuntu",
      local: false,
    },
    { code: 0, stdout: OUTPUT, stderr: "" },
    "-security",
    "2026-10-25T00:00:00.000Z",
    2,
    true,
    Date.parse("2026-10-25T03:00:00.000Z"),
  );
  assertEquals(host.stale, true);
});

Deno.test("escapeHtml escapes every HTML-significant character", () => {
  assertEquals(
    escapeHtml(`<script>"x" & 'y'</script>`),
    "&lt;script&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/script&gt;",
  );
});

function summary(host: HostResult): Summary {
  return {
    generatedAt: "2026-10-25T00:10:00.000Z",
    pageTitle: "Status",
    statusHostname: "status.example.test",
    outputFile: "/tmp/network-status/site/index.html",
    tasksFile: "/tmp/network-status/tasks.json",
    staleAfterHours: 2,
    totals: {
      hosts: 1,
      debianHosts: 1,
      reachable: 1,
      unreachable: 0,
      updates: host.updateCount,
      securityUpdates: host.securityCount,
      esmUpdates: host.esmCount,
      cves: host.cveCount,
      actionableCves: host.actionableCveCount,
      hostsWithSecurity: host.securityCount > 0 ? 1 : 0,
      hostsWithUpdates: host.updateCount > 0 ? 1 : 0,
    },
    hosts: [host],
    tasks: [
      {
        id: "rotate-key",
        title: "Rotate the old SSH key",
        detail: "Replace it on every host.",
        severity: "high",
        link: "",
        source: "manual",
        due: "",
        addedAt: "2026-10-25T00:00:00.000Z",
      },
    ],
    errors: [],
  };
}

Deno.test("buildHtml renders the page, security rows and tasks", () => {
  const host = parseHostOutput(
    {
      name: "eieio",
      address: "10.10.1.77",
      user: "sven",
      port: 22,
      os: "ubuntu",
      local: false,
    },
    { code: 0, stdout: OUTPUT, stderr: "" },
    "-security",
    "2026-10-25T00:00:00.000Z",
    2,
    true,
    Date.parse("2026-10-25T00:10:00.000Z"),
  );
  const html = buildHtml(summary(host), "https://status.example.test");
  assert(html.startsWith("<!doctype html>"));
  assert(html.includes("Debian-family package and security audit"));
  assert(html.includes("Rotate the old SSH key"));
  assert(html.includes("security-row"));
  assert(html.includes("CVE-2025-1234"));
  assert(html.includes("https://status.example.test"));
});

Deno.test("buildHtml escapes hostile data", () => {
  const host = parseHostOutput(
    {
      name: "<img src=x onerror=alert(1)>",
      address: "10.0.0.1",
      user: "sven",
      port: 22,
      os: "ubuntu",
      local: false,
    },
    { code: 0, stdout: OUTPUT, stderr: "" },
    "-security",
    "2026-10-25T00:00:00.000Z",
    2,
  );
  const html = buildHtml(summary(host));
  assert(!html.includes("<img src=x"));
  assert(html.includes("&lt;img src=x"));
});

Deno.test("buildRemoteScript is a complete Debian-family probe", () => {
  const script = buildRemoteScript();
  assert(script.includes("/etc/os-release"));
  assert(script.includes("apt-get -s -qq dist-upgrade"));
  assert(script.includes("pro security-status --format json"));
  assert(script.includes("debsecan"));
  assert(script.includes("###END"));
});

Deno.test("parseCaddyModelFacts reads the source model's base domain and host", () => {
  const facts = parseCaddyModelFacts(
    "my-caddy",
    {
      globalArguments: {
        baseDomain: "fi.gy",
        serviceName: "caddy",
        dnsRecords: [
          { name: "x1yoga.fi.gy", type: "A", value: ["10.10.13.208"] },
        ],
      },
    },
    "x1yoga",
  );
  assertEquals(facts.baseDomain, "fi.gy");
  assertEquals(facts.hostFqdn, "x1yoga.fi.gy");
  assertEquals(facts.serviceName, "caddy");
});

Deno.test("pickSourceCaddy prefers the model whose host matches this machine", () => {
  const facts = [
    {
      modelName: "my-caddy",
      baseDomain: "fi.gy",
      hostFqdn: "x1yoga.fi.gy",
      serviceName: "caddy",
      target: "",
    },
    {
      modelName: "otel-caddy",
      baseDomain: "otel.fi.gy",
      hostFqdn: "otel.fi.gy",
      serviceName: "caddy",
      target: "",
    },
  ];
  assertEquals(pickSourceCaddy(facts, "x1yoga")?.modelName, "my-caddy");
  assertEquals(pickSourceCaddy(facts, "t440s"), null);
});

Deno.test("caddyModelNames filters a model list to caddy models", () => {
  const names = caddyModelNames(
    JSON.stringify({
      results: [
        { name: "my-caddy", type: "@svendowideit/caddy" },
        { name: "status", type: "@svendowideit/network-status" },
      ],
    }),
  );
  assertEquals(names, ["my-caddy"]);
});

Deno.test("statusRouteHostname builds status.<host>.<zone>", () => {
  assertEquals(statusRouteHostname("x1yoga.fi.gy"), "status.x1yoga.fi.gy");
  assertEquals(
    statusRouteHostname("status.x1yoga.fi.gy"),
    "status.x1yoga.fi.gy",
  );
  assertEquals(statusRouteHostname(""), "");
});
