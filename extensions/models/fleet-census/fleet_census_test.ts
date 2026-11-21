/**
 * Tests for @svendowideit/fleet-census.
 *
 * Everything here is pure: parsing, classification and rendering. The scanner
 * itself is exercised by running it on a real host (see docs/fleet-census-plan.md
 * §18 / P1), never by these tests, so no test executes a discovered binary.
 */

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  applyProbeResults,
  buildFleet,
  buildFreshness,
  buildHost,
  buildItems,
  buildSoftwareIndex,
  buildSummary,
  classifyChannel,
  collapseToolchains,
  compareSemver,
  countItems,
  findDuplicates,
  identityOf,
  interfaceKind,
  managerOf,
  ownerOf,
  parseExecStart,
  parseNixStorePath,
  parseScan,
  parseSemver,
  probeCandidates,
  renderProbeScript,
  renderScanScript,
  resolveTargets,
  SWAMP_CATALOG,
  versionOf,
} from "./fleet_census.ts";
import {
  catalogEntryFor,
  managedByUnit,
  ownerForUnit,
} from "./owners_catalog.ts";

const HOME = "/home/sven";

// ---------------------------------------------------------------------------
// parseScan
// ---------------------------------------------------------------------------

Deno.test("parseScan splits records and skips blank lines", () => {
  const records = parseScan(
    "meta\thost\teieio\n\nbin\tollama\t/usr/local/bin/ollama\n",
  );
  assertEquals(records.length, 2);
  assertEquals(records[0].kind, "meta");
  assertEquals(records[0].fields, ["host", "eieio"]);
  assertEquals(records[1].kind, "bin");
  assertEquals(records[1].fields[0], "ollama");
});

// ---------------------------------------------------------------------------
// ExecStart
// ---------------------------------------------------------------------------

Deno.test("parseExecStart expands %h and strips the `@` prefix", () => {
  const p = parseExecStart("@%h/.local/bin/swamp worker connect", {
    home: HOME,
    user: "sven",
    uid: "1000",
  });
  assertEquals(p.command, `${HOME}/.local/bin/swamp`);
  assertEquals(p.args[0], "worker");
  assertEquals(p.wrapped, false);
});

Deno.test("parseExecStart handles ! and - prefixes", () => {
  assertEquals(
    parseExecStart("!/usr/lib/systemd/scripts/chronyd-starter.sh", {
      home: HOME,
      user: "sven",
      uid: "1000",
    }).command,
    "/usr/lib/systemd/scripts/chronyd-starter.sh",
  );
  assertEquals(
    parseExecStart("-/home/sven/.local/bin/tuios --serve", {
      home: HOME,
      user: "sven",
      uid: "1000",
    }).command,
    "/home/sven/.local/bin/tuios",
  );
});

Deno.test("parseExecStart marks a shell wrapper rather than trusting its first token", () => {
  const p = parseExecStart(
    "sh -c '/home/sven/src/coreander/coreander --port 80'",
    {
      home: HOME,
      user: "sven",
      uid: "1000",
    },
  );
  assertEquals(p.command, "sh");
  assertEquals(p.wrapped, true);
});

// ---------------------------------------------------------------------------
// interfaces and nix paths
// ---------------------------------------------------------------------------

Deno.test("interfaceKind separates physical, virtual and vpn interfaces", () => {
  assertEquals(interfaceKind("lo", ""), "loopback");
  assertEquals(interfaceKind("eno4", "aa:bb:cc:dd:ee:ff"), "ethernet");
  assertEquals(interfaceKind("wlP9s9", "aa:bb:cc:dd:ee:ff"), "wifi");
  assertEquals(interfaceKind("tailscale0", ""), "vpn");
  assertEquals(interfaceKind("docker0", ""), "software-bridge");
  assertEquals(interfaceKind("br-027d0bdcec77", ""), "software-bridge");
  assertEquals(interfaceKind("virbr0", ""), "software-bridge");
});

Deno.test("parseNixStorePath reads name and version out of the store path", () => {
  assertEquals(
    parseNixStorePath(
      "/nix/store/hinq0w2cd8rzw32hwz3pm3x0bvv0l0qa-nix-2.23.3/bin/nix-daemon",
    ),
    { name: "nix", version: "2.23.3" },
  );
  assertEquals(parseNixStorePath("/usr/local/bin/ollama"), null);
});

// ---------------------------------------------------------------------------
// identity, manager, version, owner
// ---------------------------------------------------------------------------

Deno.test("identityOf prefers the go module, then the nix store, then the name", () => {
  assertEquals(
    identityOf(
      {
        name: "tuios",
        cwd: "",
        path: "",
        gomod: "github.com/Gaurav-Gosain/tuios",
      } as never,
    ),
    { kind: "github", name: "Gaurav-Gosain/tuios" },
  );
  // a Go module on another host is NOT a GitHub repo (this produced 404s)
  assertEquals(
    identityOf({
      name: "helm",
      path: "/usr/local/bin/helm",
      gomod: "helm.sh/helm/v3",
    }),
    { kind: "go", name: "helm.sh/helm/v3" },
  );
  assertEquals(
    identityOf({
      name: "nix-daemon",
      path:
        "/nix/store/hinq0w2cd8rzw32hwz3pm3x0bvv0l0qa-nix-2.23.3/bin/nix-daemon",
      gomod: "",
    }),
    { kind: "name", name: "nix" },
  );
  assertEquals(
    identityOf({
      name: "portainer-v0.0.12",
      path: "/usr/local/bin/x",
      gomod: "",
    }),
    { kind: "name", name: "portainer" },
  );
});

Deno.test("managerOf classes the toolchains and never calls /usr/local/bin OS", () => {
  assertEquals(
    managerOf({ where: "nvm", name: "node", gomod: "", path: "/x" }),
    "nvm",
  );
  assertEquals(
    managerOf({ where: "cargo", name: "rustfmt", gomod: "", path: "/x" }),
    "rustup",
  );
  assertEquals(
    managerOf({ where: "cargo", name: "cargo-nextest", gomod: "", path: "/x" }),
    "cargo",
  );
  assertEquals(
    managerOf({
      where: "usr-local-bin",
      name: "blogwatcher",
      gomod: "",
      path: "/x",
    }),
    "none",
  );
  assertEquals(
    managerOf({
      where: "nix",
      name: "nix-daemon",
      gomod: "",
      path: "/nix/store/abc-nix-2.23.3/bin/x",
    }),
    "nix",
  );
});

Deno.test("versionOf ignores (devel) build info and falls back to filename or nix", () => {
  assertEquals(
    versionOf({
      name: "tuios",
      gomod: "github.com/x/tuios",
      gover: "v0.13.3",
      path: "/x",
    }),
    {
      version: "0.13.3",
      source: "build-info",
      evidence: "go build info: github.com/x/tuios v0.13.3",
    },
  );
  const devel = versionOf({
    name: "ollama",
    gomod: "github.com/ollama/ollama",
    gover: "(devel)",
    path: "/x",
  });
  assertEquals(devel.version, "");
  assertEquals(devel.source, "unknown");
  assertEquals(
    versionOf({ name: "portainer-v0.0.12", gomod: "", gover: "", path: "/x" })
      .version,
    "0.0.12",
  );
  assertEquals(
    versionOf({
      name: "nix-daemon",
      gomod: "",
      gover: "",
      path:
        "/nix/store/hinq0w2cd8rzw32hwz3pm3x0bvv0l0qa-nix-2.23.3/bin/nix-daemon",
    }),
    {
      version: "2.23.3",
      source: "nix-store",
      evidence: "nix store path: nix-2.23.3",
    },
  );
});

Deno.test("ownerOf only ever offers manageable or unknown — never managed", () => {
  const ollama = ownerOf("ollama", "ollama/ollama");
  assertEquals(ollama.class, "manageable");
  assertEquals(ollama.extension, "@svendowideit/ollama");
  assert(ollama.command.includes("ollama-install"));
  assertEquals(ownerOf("mystery-tool", "mystery-tool").class, "unknown");
  for (const entry of SWAMP_CATALOG) {
    assert(
      entry.command.startsWith("swamp "),
      `catalog command for ${entry.extension}`,
    );
  }
});

Deno.test("a bare curl-installed tuios on a host is NOT managed", () => {
  // The catalogue says an extension exists (manageable), it does not say this
  // copy is swamp-managed: that needs host evidence (Q1=B).
  assertEquals(ownerOf("tuios", "Gaurav-Gosain/tuios").class, "manageable");
});

// ---------------------------------------------------------------------------
// buildItems / buildHost / buildSummary over a synthetic scan
// ---------------------------------------------------------------------------

const TSV = [
  "meta\thost\teieio",
  "meta\tfqdn\teieio.home.org.au",
  "meta\tarch\taarch64",
  "meta\tos\tUbuntu 24.04.5 LTS",
  "meta\tmachineId\tf194a0a390b740ddb63a4f33887aa812",
  "meta\tscannedAt\t2026-11-21T00:00:00Z",
  "iface\tlo\t-",
  "iface\teno4\taa:bb:cc:dd:ee:ff",
  "iface\ttailscale0\t-",
  "addr\tlo\t127.0.0.1/8\thost",
  "addr\teno4\t10.10.10.123/20\tglobal",
  "addr\ttailscale0\t100.127.51.78/32\tglobal",
  "pathdir\t/usr/local/bin\tpath",
  "sysdir\t/usr/bin\t2000\tbash,coreutils,",
  "bin\tollama\t/usr/local/bin/ollama\t/usr/local/bin/ollama\t28627920\t1760000000\tabc123\t1\tusr-local-bin\tgithub.com/ollama/ollama\t(devel)\t-",
  "bin\ttuios\t/home/sven/.local/bin/tuios\t/home/sven/.local/bin/tuios\t49692832\t1760000000\tdef456\t1\thome-local-bin\tgithub.com/Gaurav-Gosain/tuios\tv0.13.3\t-",
  "bin\tswamp\t/home/sven/.local/bin/swamp\t/home/sven/.local/bin/swamp\t291705712\t1760000000\t-1\t1\thome-local-bin\t\t\t-",
  "bin\tswamp\t/usr/local/bin/swamp\t/usr/local/bin/swamp\t291705712\t1760000000\t-1\t1\tusr-local-bin\t\t\t-",
  "bin\tmystery\t/home/sven/.local/bin/mystery\t/home/sven/.local/bin/mystery\t4242\t1760000000\tccc42\t1\thome-local-bin\t\t\t-",
  "unit\tuser\tswamp-worker-figy\t%h/.local/bin/swamp worker connect\t/home/sven/.config/systemd/user/swamp-worker-figy.service",
  "unitstate\tuser\tswamp-worker-figy\tactive",
  "pipuser\tconnexion\t2.14.1\t1\t/home/sven/.local/lib/python3.12/site-packages/connexion-2.14.1.dist-info",
  "pipuser\tattrs\t22.2.0\t0\t/home/sven/.local/lib/python3.12/site-packages/attrs-22.2.0.dist-info",
  "venv\t/home/sven/src/esphome/venv\t3.14.4\t84\t39",
  "venvdist\t/home/sven/src/esphome/venv\tesphome\t2025.11.0",
  "npmglobal\tnpm\t10.9.7",
  "pkg\tsnap\tfirefox\t159.0.1-1",
  "image\tghcr.io/dependencytrack/apiserver:5.1.2\tsha256:aa\t2026-10-01 10:00:00 +1000 AEST",
  "image\tpublic.ecr.aws/zinclabs/openobserve:latest\tsha256:bb\t2026-10-01 10:00:00 +1000 AEST",
  "meta\tsysFiles\t2000",
  "meta\tunowned\t4",
  "meta\tdone\t2026-11-21T00:00:02Z",
].join("\n");

Deno.test("buildItems classifies provenance, manager, version and owner", () => {
  const records = parseScan(TSV);
  const items = buildItems(records, { home: HOME, user: "sven", uid: "1000" });

  const ollama = items.find((i) => i.name === "ollama")!;
  assertEquals(ollama.manager, "none");
  assertEquals(ollama.provenance, "hand-installed");
  assertEquals(ollama.version, "");
  assertEquals(ollama.owner.class, "manageable");
  assert(ollama.flags.includes("unknown-version"));
  // manageable is not "no manager": swamp has an owner, so the flag is wrong now
  assert(!ollama.flags.includes("no-manager"));
  // a genuinely unowned, unmanaged item still carries it
  const mystery = items.find((i) => i.name === "mystery")!;
  assertEquals(mystery.owner.class, "unknown");
  assert(mystery.flags.includes("no-manager"));

  const tuios = items.find((i) => i.name === "tuios")!;
  assertEquals(tuios.version, "0.13.3");
  assertEquals(tuios.identity, { kind: "github", name: "Gaurav-Gosain/tuios" });

  // the worker unit points at %h/.local/bin/swamp, so that copy carries usage evidence
  const swampLocal = items.find((i) =>
    i.installPath === `${HOME}/.local/bin/swamp`
  )!;
  assert(
    swampLocal.evidence.some((e) =>
      e.signal === "systemd-unit" && e.detail.includes("active")
    ),
    "unit evidence attached",
  );

  // pip dists without a console script are not software
  assert(items.some((i) => i.name === "connexion"));
  assert(!items.some((i) => i.name === "attrs"));

  // snap is a system package manager: managed, not "third party"
  const firefox = items.find((i) => i.name === "firefox")!;
  assertEquals(firefox.provenance, "os");
  assertEquals(firefox.owner.class, "managed");
  assertEquals(firefox.manager, "snap");

  // container tags: latest is a floating tag with no version
  const oobserve = items.find((i) =>
    i.identity.kind === "oci" && i.name === "openobserve"
  )!;
  assert(oobserve.flags.includes("floating-tag"));
  assertEquals(oobserve.version, "");
});

Deno.test("buildItems surfaces same-bytes duplicates (two swamp copies)", () => {
  const items = buildItems(parseScan(TSV), { home: HOME });
  const dupes = findDuplicates(items);
  const swamp = dupes.find((d) => d.identity === "swamp");
  assert(swamp, "swamp duplicate detected");
  assertEquals(swamp!.paths.length, 2);
});

Deno.test("buildHost records interfaces, addresses and the package-owned count", () => {
  const records = parseScan(TSV);
  const host = buildHost(records, {
    durationMs: 12,
    truncated: false,
    warnings: [],
  });
  assertEquals(host.hostname, "eieio");
  assertEquals(host.machineId, "f194a0a390b740ddb63a4f33887aa812");
  assertEquals(host.counts.osManagedExecutables, 2000);
  assertEquals(host.counts.unownedExecutables, 4);
  assertEquals(host.truncated, false);
  const eno4 = host.interfaces.find((i) => i.name === "eno4")!;
  assertEquals(eno4.kind, "ethernet");
  assertEquals(eno4.addresses, ["10.10.10.123/20"]);
  assert(host.addresses.includes("10.10.10.123"));
  assert(host.addresses.includes("100.127.51.78"));
  // loopback is kept per-interface but never in the drift list
  assert(!host.addresses.includes("127.0.0.1"));
  assertEquals(
    host.interfaces.find((i) => i.name === "lo")!.addresses,
    ["127.0.0.1/8"],
  );
});

Deno.test("buildSummary counts by owner and lists unknowns", () => {
  const records = parseScan(TSV);
  const items = buildItems(records, { home: HOME });
  const host = countItems(
    buildHost(records, { durationMs: 1, truncated: false, warnings: [] }),
    items,
  );
  const summary = buildSummary(host, items);
  assertEquals(summary.items, items.length);
  assert(summary.byOwner.manageable >= 2);
  assert(summary.byOwner.managed >= 1, "snap packages count as managed");
  assert(summary.unknownVersion.length >= 1);
  assert(summary.nextCommands.includes("fleet-census on eieio"));
});

// ---------------------------------------------------------------------------
// collapseToolchains
// ---------------------------------------------------------------------------

Deno.test("collapseToolchains folds nvm's per-version binaries under node", () => {
  const base = {
    versionSource: "unknown" as const,
    provenance: "language" as const,
    sizeBytes: 0,
    mtime: "",
    sha256: "",
    owner: {
      class: "unknown" as const,
      extension: "",
      command: "",
      confidence: 0,
    },
    evidence: [],
    flags: [],
    bundledWith: "",
  };
  const items = [
    {
      ...base,
      id: "n",
      name: "node",
      manager: "nvm",
      realPath: "/home/sven/.nvm/versions/node/v22.22.2/bin/node",
      installPath: "/x",
      identity: { kind: "name" as const, name: "node" },
      version: "22.22.2",
    },
    {
      ...base,
      id: "p",
      name: "npm",
      manager: "nvm",
      realPath: "/home/sven/.nvm/versions/node/v22.22.2/bin/npm",
      installPath: "/y",
      identity: { kind: "name" as const, name: "npm" },
      version: "",
    },
  ];
  const out = collapseToolchains(items);
  assertEquals(out.find((i) => i.id === "p")!.bundledWith, "node v22.22.2");
  assertEquals(out.find((i) => i.id === "n")!.bundledWith, "");
});

// ---------------------------------------------------------------------------
// scanner rendering
// ---------------------------------------------------------------------------

Deno.test("renderScanScript scans a superset of dirs and never executes a binary", () => {
  const script = renderScanScript({
    maxItems: 400,
    hashMaxBytes: 1024,
    knownDirs: true,
    extraDirs: ["/opt/thing"],
    collectAddresses: true,
  });
  assert(script.includes("$HOME/.local/bin"), "known user dirs are scanned");
  assert(script.includes("/opt/thing"), "extra dirs are scanned");
  assert(script.includes("dpkg -S"), "package DB ownership is used");
  assert(script.includes("go version -m"), "Go build info is used");
  for (
    const probe of ["$real --version", '"$real" --version', "$f --version"]
  ) {
    assert(!script.includes(probe), `no version probe: ${probe}`);
  }
  assert(!script.includes("exec "), "nothing is exec'd");
  assert(
    script.includes("<<EOF"),
    "counters survive: here-doc, not a piped while",
  );
  assert(
    script.includes("${PRETTY_NAME:-unknown}"),
    "shell expansions survived the template",
  );
  assert(!script.includes("@@"), "no placeholder left behind");
});

// ---------------------------------------------------------------------------
// Fleet index (P2)
// ---------------------------------------------------------------------------

function fleetItem(
  name: string,
  version: string,
  owner: "managed" | "manageable" | "unknown",
  manager = "none",
) {
  return {
    id: `${name}-${version}`,
    name,
    identity: { kind: "name" as const, name },
    version,
    versionSource: "build-info" as const,
    manager,
    provenance: "hand-installed" as const,
    installPath: `/usr/local/bin/${name}`,
    realPath: "",
    sizeBytes: 0,
    mtime: "",
    sha256: "",
    owner: { class: owner, extension: "", command: "", confidence: 0 },
    evidence: [],
    flags: [],
    bundledWith: "",
  };
}

Deno.test("buildSoftwareIndex records versions per host, skew and missing hosts", () => {
  const index = buildSoftwareIndex([
    {
      host: "a",
      ok: true,
      items: [
        fleetItem("ollama", "0.33.3", "manageable"),
        fleetItem("swamp", "1.0.0", "manageable"),
      ],
    },
    {
      host: "b",
      ok: true,
      items: [fleetItem("ollama", "0.35.0", "manageable")],
    },
    { host: "c", ok: false, items: [] },
  ]);
  const ollama = index.find((r) => r.name === "ollama")!;
  assertEquals(ollama.hosts.map((h) => h.host), ["a", "b"]);
  assertEquals(ollama.versions, ["0.33.3", "0.35.0"]);
  assertEquals(ollama.skewed, true);
  // c failed, so it is not "missing" it — it is unknown
  assertEquals(ollama.missingOn, []);

  const swamp = index.find((r) => r.name === "swamp")!;
  assertEquals(swamp.versions, ["1.0.0"]);
  assertEquals(swamp.skewed, false);
  assertEquals(swamp.missingOn, ["b"]);
});

Deno.test("buildSoftwareIndex separates managed from manageable hosts", () => {
  const index = buildSoftwareIndex([
    { host: "a", ok: true, items: [fleetItem("caddy", "2.11.9", "managed")] },
    {
      host: "b",
      ok: true,
      items: [fleetItem("caddy", "2.11.9", "manageable")],
    },
  ]);
  const caddy = index.find((r) => r.name === "caddy")!;
  assertEquals(caddy.managedOn, ["a"]);
  assertEquals(caddy.manageableOn, ["b"]);
  assertEquals(caddy.skewed, false);
});

Deno.test("buildFleet aggregates hosts, failures and owner totals", () => {
  const base = {
    reachedVia: "",
    error: "",
    scannedAt: "",
    durationMs: 1,
    items: 1,
    unowned: 1,
    osManaged: 10,
    os: "ubuntu",
    arch: "x86_64",
    addresses: [],
    searchDomains: [],
    byManager: {},
    byOwner: {},
  };
  const fleet = buildFleet(
    [
      {
        ...base,
        host: "a",
        ok: true,
        items: 3,
        unowned: 2,
        byOwner: { manageable: 2, unknown: 1 },
        byManager: { none: 3 },
      },
      { ...base, host: "b", ok: false, items: 0, unowned: 0, error: "timeout" },
    ],
    [],
    "2026-11-21T00:00:00Z",
  );
  assertEquals(fleet.summary.hosts, 2);
  assertEquals(fleet.summary.ok, 1);
  assertEquals(fleet.summary.failed, 1);
  assertEquals(fleet.summary.items, 3);
  assertEquals(fleet.summary.byOwner, { manageable: 2, unknown: 1 });
  assertEquals(fleet.summary.byManager, { none: 3 });
});

Deno.test("resolveTargets prefers addresses over names and dedupes the fleet", async () => {
  const inventory = {
    hosts: [
      {
        name: "xeon",
        address: "10.10.10.126",
        addresses: ["10.10.10.126"],
        hostnames: ["xeon", "xeon.home.org.au"],
      },
      {
        name: "p1gen4",
        address: "10.10.10.141",
        addresses: ["10.10.10.141", "10.10.10.165"],
        hostnames: ["p1gen4"],
      },
    ],
  };
  const ctx = {
    readModelData: (model: string, spec?: string) =>
      Promise.resolve(
        model === "fleet" && spec === "inventory"
          ? [{ version: 2, content: inventory }]
          : [],
      ),
  };
  const targets = await resolveTargets({ hosts: [], fleetModel: "fleet" }, ctx);
  assertEquals(targets.map((t) => t.label), ["xeon", "p1gen4"]);
  assertEquals(targets[0].candidates[0], "10.10.10.126");
  assertEquals(targets[0].candidates.includes("xeon.home.org.au"), true);

  const explicit = await resolveTargets({
    hosts: ["p1gen4"],
    fleetModel: "fleet",
  }, ctx);
  assertEquals(explicit[0].label, "p1gen4");
  assertEquals(explicit[0].candidates[0], "10.10.10.141");
});

// ---------------------------------------------------------------------------
// Ownership (P3)
// ---------------------------------------------------------------------------

Deno.test("catalogEntryFor matches a name or a resolved identity", () => {
  assertEquals(catalogEntryFor("ollama")?.extension, "@svendowideit/ollama");
  assertEquals(catalogEntryFor("tuios")?.extension, "@svendowideit/tuios");
  // a Go binary whose executable name differs from the project
  assertEquals(
    catalogEntryFor("hc", "herdr-core")?.extension,
    "@svendowideit/herdr-app",
  );
  assertEquals(catalogEntryFor("mystery"), null);
});

Deno.test("managedByUnit only matches a unit the owning extension installs", () => {
  const swamp = catalogEntryFor("swamp")!;
  assertEquals(
    managedByUnit(swamp, ["swamp-worker-figy"]),
    "swamp-worker-figy",
  );
  assertEquals(managedByUnit(swamp, ["swamp-serve"]), "swamp-serve");
  assertEquals(managedByUnit(swamp, ["my-own-swamp-thing"]), "");
  const ollama = catalogEntryFor("ollama")!;
  assertEquals(managedByUnit(ollama, ["ollama"]), "ollama");
  assertEquals(managedByUnit(ollama, ["caddy"]), "");
});

Deno.test("a hand-installed tuios is manageable, a unit-run one is managed", () => {
  const tsv = (unit: string) =>
    [
      "meta\thost\ttesthost",
      "pathdir\t/home/sven/.local/bin\tknown",
      "bin\ttuios\t/home/sven/.local/bin/tuios\t/home/sven/.local/bin/tuios\t49692832\t1760000000\tabc\t1\thome-local-bin\tgithub.com/Gaurav-Gosain/tuios\tv0.13.3\t-",
      `unit\tuser\t${unit}\t%h/.local/bin/tuios serve\t/home/sven/.config/systemd/user/${unit}.service`,
      `unitstate\tuser\t${unit}\tactive`,
      "meta\tdone\t2026-11-21T00:00:00Z",
    ].join("\n");

  const unmanaged = buildItems(parseScan(tsv("tuios-manual")), { home: HOME });
  const a = unmanaged.find((i) => i.name === "tuios")!;
  assertEquals(a.owner.class, "manageable");
  assertEquals(a.owner.extension, "@svendowideit/tuios");
  assert(a.owner.command.startsWith("swamp "));

  const managed = buildItems(parseScan(tsv("tuios")), { home: HOME });
  const b = managed.find((i) => i.name === "tuios")!;
  assertEquals(b.owner.class, "managed");
  assert(b.evidence.some((e) => e.signal === "managed-by"));
});

// ---------------------------------------------------------------------------
// Freshness (P4)
// ---------------------------------------------------------------------------

Deno.test("parseSemver and compareSemver agree on the usual shapes", () => {
  assertEquals(parseSemver("v0.33.3"), { major: 0, minor: 33, patch: 3 });
  assertEquals(parseSemver("2.11"), { major: 2, minor: 11, patch: 0 });
  assertEquals(parseSemver("nonsense"), null);
  assertEquals(compareSemver("0.33.3", "0.35.0"), -1);
  assertEquals(compareSemver("2.11.9", "2.11.9"), 0);
  assertEquals(compareSemver("3.0.0", "2.99.99"), 1);
});

Deno.test("classifyChannel names dev, lts, latest, behind", () => {
  const channels = {
    latest: { version: "4.0.0" },
    lts: { version: "3.5.0" },
    dev: { version: "4.1.0-rc1" },
  };
  assertEquals(classifyChannel("4.1.0-rc1", channels), "dev");
  assertEquals(classifyChannel("3.5.0", channels), "lts");
  assertEquals(classifyChannel("4.0.0", channels), "latest");
  assertEquals(classifyChannel("2.0.0", channels), "behind");
  assertEquals(classifyChannel("", channels), "unknown");
});

Deno.test("buildFreshness joins the index with release metadata", () => {
  const now = Date.parse("2026-11-21T00:00:00Z");
  const software = [
    {
      identity: "github:ollama/ollama",
      identities: [],
      name: "ollama",
      hosts: [
        {
          host: "a",
          version: "0.33.3",
          manager: "none",
          owner: "managed",
          flags: [],
          installs: 1,
          paths: [],
        },
        {
          host: "b",
          version: "0.35.0",
          manager: "none",
          owner: "managed",
          flags: [],
          installs: 1,
          paths: [],
        },
      ],
      versions: ["0.33.3", "0.35.0"],
      skewed: true,
      managedOn: ["a", "b"],
      manageableOn: [],
      extension: "",
      command: "",
      missingOn: [],
    },
  ];
  const releases = [{
    repo: "ollama/ollama",
    ok: true,
    archived: false,
    pushedAt: "2026-11-01T00:00:00Z",
    latest: { version: "0.36.0", publishedAt: "2026-11-10T00:00:00Z" },
    lts: null,
    dev: { version: "0.37.0-rc1", publishedAt: "2026-11-18T00:00:00Z" },
    tags: [
      {
        version: "0.33.3",
        publishedAt: "2026-06-01T00:00:00Z",
        prerelease: false,
      },
      {
        version: "0.35.0",
        publishedAt: "2026-10-01T00:00:00Z",
        prerelease: false,
      },
      {
        version: "0.36.0",
        publishedAt: "2026-11-10T00:00:00Z",
        prerelease: false,
      },
      {
        version: "0.37.0-rc1",
        publishedAt: "2026-11-18T00:00:00Z",
        prerelease: true,
      },
    ],
  }];
  const fresh = buildFreshness(software, releases, {
    now,
    generatedAt: "2026-11-21T00:00:00Z",
  });
  const row = fresh.rows[0];
  assertEquals(row.repo, "ollama/ollama");
  assertEquals(row.installed.map((i) => i.channel), ["behind", "behind"]);
  assertEquals(row.latest?.version, "0.36.0");
  assertEquals(row.upstreamIdleDays, 11);
  assertEquals(row.oldestInstalledDays, 173); // 0.33.3, published 2026-06-01
  assertEquals(row.flags.includes("behind"), true);
  assertEquals(fresh.summary.products, 1);
  assertEquals(fresh.summary.withUpstream, 1);
});

Deno.test("buildFreshness marks an archived or long-idle project abandoned", () => {
  const now = Date.parse("2026-11-21T00:00:00Z");
  const software = [{
    identity: "github:old/tool",
    identities: [],
    name: "old-tool",
    hosts: [{
      host: "a",
      version: "1.0.0",
      manager: "none",
      owner: "unknown",
      flags: [],
      installs: 1,
      paths: [],
    }],
    versions: ["1.0.0"],
    skewed: false,
    managedOn: [],
    manageableOn: [],
    extension: "",
    command: "",
    missingOn: [],
  }];
  const fresh = buildFreshness(software, [{
    repo: "old/tool",
    ok: true,
    archived: true,
    pushedAt: "2023-01-01T00:00:00Z",
    latest: { version: "1.0.0", publishedAt: "2023-01-01T00:00:00Z" },
    lts: null,
    dev: null,
    tags: [],
  }], { now, generatedAt: "2026-11-21T00:00:00Z" });
  assertEquals(fresh.rows[0].flags.includes("archived"), true);
  assertEquals(fresh.rows[0].flags.includes("upstream-idle-2y"), true);
  assertEquals(fresh.summary.abandoned, 1);
});

Deno.test("buildFreshness leaves non-GitHub identities out", () => {
  const fresh = buildFreshness(
    [{
      identity: "npm:left-pad",
      identities: [],
      name: "left-pad",
      hosts: [],
      versions: [],
      skewed: false,
      managedOn: [],
      manageableOn: [],
      extension: "",
      command: "",
      missingOn: [],
    }],
    [],
    { now: 0, generatedAt: "2026-11-21T00:00:00Z" },
  );
  assertEquals(fresh.rows.length, 0);
  assertEquals(fresh.summary.products, 0);
});

// ---------------------------------------------------------------------------
// Reports (P5)
// ---------------------------------------------------------------------------

import type { FleetData, FreshnessData, SoftwareRow } from "./census_report.ts";
import {
  escapeHtml,
  hostAttention,
  humanAge,
  renderHosts,
  renderIndex,
  renderJson,
  renderSoftware,
} from "./census_report.ts";

const fleetFixture: FleetData = {
  hosts: [
    {
      host: "a",
      ok: true,
      reachedVia: "10.0.0.1",
      error: "",
      scannedAt: "",
      durationMs: 1,
      items: 3,
      unowned: 2,
      osManaged: 100,
      os: "ubuntu",
      arch: "x86_64",
      addresses: ["10.0.0.1"],
      searchDomains: [],
      byManager: {},
      byOwner: { unknown: 2, manageable: 1 },
    },
    {
      host: "b",
      ok: false,
      reachedVia: "",
      error: "timeout",
      scannedAt: "",
      durationMs: 1,
      items: 0,
      unowned: 0,
      osManaged: 0,
      os: "",
      arch: "",
      addresses: [],
      searchDomains: [],
      byManager: {},
      byOwner: {},
    },
  ],
  software: [
    {
      identity: "github:ollama/ollama",
      identities: ["github:ollama/ollama"],
      name: "ollama",
      hosts: [{
        host: "a",
        version: "0.33.3",
        manager: "none",
        owner: "managed",
        flags: [],
        installs: 1,
        paths: [],
      }],
      versions: ["0.33.3"],
      skewed: false,
      managedOn: ["a"],
      manageableOn: [],
      extension: "@svendowideit/ollama",
      command: "swamp workflow run @svendowideit/ollama-install",
      missingOn: ["b"],
    },
    {
      identity: "github:old/tool",
      identities: ["github:old/tool"],
      name: "old-tool",
      hosts: [{
        host: "a",
        version: "1.0.0",
        manager: "none",
        owner: "unknown",
        flags: [],
        installs: 1,
        paths: [],
      }],
      versions: ["1.0.0"],
      skewed: false,
      managedOn: [],
      manageableOn: ["a"],
      extension: "@svendowideit/example",
      command: "swamp extension pull @svendowideit/example",
      missingOn: ["b"],
    },
  ],
  summary: {
    hosts: 2,
    ok: 1,
    failed: 1,
    items: 3,
    unowned: 2,
    skewed: 0,
    manageable: 1,
    unknown: 2,
    byOwner: { unknown: 2, manageable: 1 },
  },
  scannedAt: "2026-11-21T00:00:00Z",
};

const freshnessFixture: FreshnessData = {
  rows: [
    {
      name: "old-tool",
      repo: "old/tool",
      installed: [{ host: "a", version: "1.0.0", channel: "behind" }],
      latest: {
        version: "2.0.0",
        publishedAt: "2023-01-01T00:00:00Z",
        tag: "v2.0.0",
      },
      lts: null,
      dev: null,
      archived: true,
      upstreamIdleDays: 1400,
      oldestInstalledDays: 1500,
      behindMajor: 1,
      flags: ["archived", "upstream-idle-2y", "behind-major"],
      error: "",
    },
  ],
  summary: {},
  generatedAt: "2026-11-21T00:00:00Z",
};

Deno.test("escapeHtml neutralises tags and quotes", () => {
  assertEquals(escapeHtml(`<b>&"'`), "&lt;b&gt;&amp;&quot;&#39;");
  assertEquals(escapeHtml(undefined), "");
});

Deno.test("humanAge renders days, months and years", () => {
  assertEquals(humanAge(9), "9d");
  assertEquals(humanAge(90), "3mo");
  assertEquals(humanAge(800), "2y");
  assertEquals(humanAge(null), "");
});

Deno.test("hostAttention puts an unreachable host first and weights abandoned software", () => {
  const rows = hostAttention(fleetFixture, freshnessFixture);
  assertEquals(rows[0].host, "b"); // unreachable
  const a = rows.find((r) => r.host === "a")!;
  assertEquals(a.abandoned, 1);
  assertEquals(a.manageable, 1);
  assertEquals(a.unknown, 2);
  assert(a.score > 0);
  assertEquals(rows.find((r) => r.host === "b")!.score, 25);
});

Deno.test("renderSoftware shows a column per host, and distinguishes missing from unscanned", () => {
  const html = renderSoftware(fleetFixture, freshnessFixture, "now");
  assert(html.includes("<th>a</th>") && html.includes("<th>b</th>"));
  assert(html.includes("ollama"));
  // b was scanned and does not have it; the row lists it under "missing on"
  assert(html.includes(">b</td>")); // the missing-on cell
  // the unscanned case is a different marker from the missing one
  const unscanned = renderSoftware(
    { ...fleetFixture, hosts: [fleetFixture.hosts[0]] },
    null,
    "now",
  );
  assert(unscanned.includes("?"));
});

Deno.test("renderHosts ranks by attention and links the detail", () => {
  const html = renderHosts(fleetFixture, freshnessFixture, "now");
  assert(html.includes(">b<")); // unreachable host rendered first
  assert(html.includes("unreachable"));
  assert(html.includes("old-tool")); // its abandoned dependency, in the detail
  assert(html.indexOf(">b<") < html.indexOf(">a<"));
});

Deno.test("renderIndex summarises and links the two table pages", () => {
  const html = renderIndex(fleetFixture, freshnessFixture, "now");
  assert(html.includes("software.html") && html.includes("host.html"));
  assert(html.includes("Abandoned dependencies"));
  assert(html.includes("old-tool"));
  assert(html.includes("Conversion candidates"));
});

Deno.test("renderJson is valid JSON carrying the tables and the ranking", () => {
  const parsed = JSON.parse(renderJson(fleetFixture, freshnessFixture, "now"));
  assertEquals(parsed.software.length, 2);
  assertEquals(parsed.attention[0].host, "b");
  assertEquals(parsed.freshness[0].name, "old-tool");
});

// ---------------------------------------------------------------------------
// Links (actionable reports)
// ---------------------------------------------------------------------------

import { link, productLinks, whereInstalled } from "./census_report.ts";

Deno.test("productLinks derives the right upstream URL per registry", () => {
  const row = (identity: string, identities: string[] = []): SoftwareRow => ({
    identity,
    identities,
    name: "x",
    hosts: [],
    versions: [],
    skewed: false,
    managedOn: [],
    manageableOn: [],
    extension: "",
    command: "",
    missingOn: [],
  });
  assertEquals(productLinks(row("github:ollama/ollama")), {
    project: "https://github.com/ollama/ollama",
    releases: "https://github.com/ollama/ollama/releases",
  });
  // the strongest identity wins even when the row is keyed by name
  assertEquals(
    productLinks(row("name:tuios", ["github:Gaurav-Gosain/tuios"])).project,
    "https://github.com/Gaurav-Gosain/tuios",
  );
  assertEquals(
    productLinks(row("go:helm.sh/helm/v3")).project,
    "https://pkg.go.dev/helm.sh/helm/v3",
  );
  assertEquals(
    productLinks(row("pypi:requests")).project,
    "https://pypi.org/project/requests/",
  );
  assertEquals(
    productLinks(row("npm:@anthropic-ai/sdk")).project,
    "https://www.npmjs.com/package/@anthropic-ai/sdk",
  );
  assertEquals(
    productLinks(row("oci:postgres:18-alpine")).project,
    "https://hub.docker.com/r/postgres",
  );
  // no honest URL -> none invented
  assertEquals(productLinks(row("name:mystery")), {
    project: "",
    releases: "",
  });
  assertEquals(
    productLinks(row("oci:ghcr.io/org/pkg:1.2.3")).project,
    "",
  );
});

Deno.test("link escapes the URL and text, and degrades to text", () => {
  const html = link("https://example.com/?a=1&b=<2>", "a <b>");
  assert(html.includes('href="https://example.com/?a=1&amp;b=&lt;2&gt;"'));
  assert(html.includes("a &lt;b&gt;"));
  assert(html.includes('rel="noreferrer"'));
  assertEquals(link("", "plain"), "plain");
});

Deno.test("the reports contain clickable upstream links", () => {
  const software = renderSoftware(fleetFixture, freshnessFixture, "now");
  assert(software.includes('href="https://github.com/ollama/ollama"'));
  assert(software.includes("upstream ↗"));
  const index = renderIndex(fleetFixture, freshnessFixture, "now");
  assert(index.includes('href="https://github.com/old/tool"'));
  // the conversion command is shown next to the candidate
  assert(index.includes("swamp "));
});

// ---------------------------------------------------------------------------
// Behind upstream vs skew (they are different problems)
// ---------------------------------------------------------------------------

import { outdatedProducts } from "./census_report.ts";

Deno.test("outdatedProducts lists a consistent-but-old product, which skew does not", () => {
  const fleet = {
    hosts: [],
    software: [
      {
        identity: "github:swamp-club/swamp",
        identities: [],
        name: "swamp",
        // every host on the same version: NOT skewed, but behind upstream
        hosts: [
          {
            host: "a",
            version: "20261106.012700.0",
            manager: "none",
            owner: "managed",
            flags: [],
            installs: 1,
            paths: [],
          },
          {
            host: "b",
            version: "20261106.012700.0",
            manager: "none",
            owner: "managed",
            flags: [],
            installs: 1,
            paths: [],
          },
        ],
        versions: ["20261106.012700.0"],
        skewed: false,
        managedOn: ["a", "b"],
        manageableOn: [],
        extension: "@svendowideit/swamp-worker",
        command: "swamp extension pull @svendowideit/swamp-worker",
        missingOn: [],
      },
    ],
    summary: {},
    scannedAt: "",
  } as FleetData;
  const freshness = {
    rows: [
      {
        name: "swamp",
        repo: "swamp-club/swamp",
        installed: [
          { host: "a", version: "20261106.012700.0", channel: "behind" },
          { host: "b", version: "20261106.012700.0", channel: "behind" },
        ],
        latest: {
          version: "20261121.022312.0",
          publishedAt: "2026-11-21T00:00:00Z",
          tag: "v20261121.022312.0",
        },
        lts: null,
        dev: null,
        archived: false,
        upstreamIdleDays: 0,
        oldestInstalledDays: 15,
        behindMajor: 0,
        flags: ["behind"],
        error: "",
      },
    ],
    summary: {},
    generatedAt: "",
  } as FreshnessData;

  const out = outdatedProducts(fleet, freshness);
  assertEquals(out.length, 1);
  assertEquals(out[0].name, "swamp");
  assertEquals(out[0].hosts, ["a", "b"]);
  assertEquals(out[0].latest, "20261121.022312.0");
  assert(out[0].latestUrl.endsWith("/releases/tag/v20261121.022312.0"));

  // and the index renders it under "Behind upstream", not under skew
  const html = renderIndex(fleet, freshness, "now");
  assert(html.includes("Behind upstream (1)"));
  assert(html.includes("20261106.012700.0"));
  assert(html.includes("Version skew — hosts disagree"));
});

Deno.test("outdatedProducts ignores products that are current", () => {
  const fleet = {
    hosts: [],
    software: [],
    summary: {},
    scannedAt: "",
  } as FleetData;
  const freshness = {
    rows: [{
      name: "caddy",
      repo: "caddyserver/caddy",
      installed: [{ host: "a", version: "2.11.9", channel: "latest" }],
      latest: {
        version: "2.11.9",
        publishedAt: "2026-11-01T00:00:00Z",
        tag: "v2.11.9",
      },
      lts: null,
      dev: null,
      archived: false,
      upstreamIdleDays: 3,
      oldestInstalledDays: 3,
      behindMajor: 0,
      flags: [],
      error: "",
    }],
    summary: {},
    generatedAt: "",
  } as FreshnessData;
  assertEquals(outdatedProducts(fleet, freshness), []);
});

// ---------------------------------------------------------------------------
// Truncation honesty (adversarial review)
// ---------------------------------------------------------------------------

import { scanTruncated } from "./fleet_census.ts";

Deno.test("scanTruncated believes the scanner's own marker, not a guess", () => {
  assertEquals(
    scanTruncated(
      parseScan("meta\thost\th\nmeta\ttruncated\t0\nmeta\tdone\tnow"),
    ),
    false,
  );
  assertEquals(
    scanTruncated(
      parseScan("meta\thost\th\nmeta\ttruncated\t1\nmeta\tdone\tnow"),
    ),
    true,
  );
  // a run that never reached `meta done` was cut short
  assertEquals(
    scanTruncated(
      parseScan("meta\thost\th\nbin\tx\t/x\t/x\t1\t1\tabc\t1\tpath\t\t\t-"),
    ),
    true,
  );
});

Deno.test("the rendered scanner reports its cap instead of breaking silently", () => {
  const script = renderScanScript({
    maxItems: 5,
    hashMaxBytes: 1024,
    knownDirs: true,
    extraDirs: [],
    collectAddresses: false,
  });
  assert(script.includes("printf 'meta\\ttruncated\\t%s\\n' \"$TRUNC\""));
  assert(script.includes("TRUNC=1; break"));
});

Deno.test("resolveTargets scans machines, not raw scan hits, when the fleet has both", async () => {
  const inventory = {
    hosts: [
      // probed machine
      {
        name: "host-a",
        address: "192.0.2.10",
        addresses: ["192.0.2.10"],
        hostnames: ["host-a"],
        probed: true,
        machineId: "abc123",
      },
      // never probed: a scan hit with nothing but an address
      {
        name: "192.0.2.99",
        address: "192.0.2.99",
        addresses: ["192.0.2.99"],
        hostnames: [],
        probed: false,
        machineId: "",
      },
      {
        name: "192.0.2.98",
        address: "192.0.2.98",
        addresses: ["192.0.2.98"],
        hostnames: [],
        probed: false,
        machineId: "",
      },
    ],
  };
  const ctx = {
    readModelData: (model: string, spec?: string) =>
      Promise.resolve(
        model === "fleet" && spec === "inventory"
          ? [{ version: 2, content: inventory }]
          : [],
      ),
  };
  const targets = await resolveTargets({ hosts: [], fleetModel: "fleet" }, ctx);
  assertEquals(targets.map((t) => t.label), ["host-a"]);

  // if nothing has been probed yet, every known host is still a target
  const ctxNone = {
    readModelData: (model: string, spec?: string) =>
      Promise.resolve(
        model === "fleet" && spec === "inventory"
          ? [{
            version: 2,
            content: {
              hosts: inventory.hosts.map((h) => ({
                ...h,
                probed: false,
                machineId: "",
              })),
            },
          }]
          : [],
      ),
  };
  const all = await resolveTargets({ hosts: [], fleetModel: "fleet" }, ctxNone);
  assertEquals(all.length, 3);
});

// ---------------------------------------------------------------------------
// Deriving the site (no placeholder domain may ever be published)
// ---------------------------------------------------------------------------

import { deriveSite } from "./fleet_census.ts";

Deno.test("deriveSite reads the zone from the installed caddy models", async () => {
  const run = (argv: string[]) => {
    if (argv[1] === "list") {
      return Promise.resolve({
        code: 0,
        stdout: JSON.stringify({
          results: [
            { name: "some-other", type: "@svendowideit/other" },
            { name: "site-caddy", type: "@svendowideit/caddy" },
          ],
        }),
      });
    }
    return Promise.resolve({
      code: 0,
      stdout: JSON.stringify({
        globalArguments: { baseDomain: "example.com" },
      }),
    });
  };
  assertEquals(await deriveSite(run, "host-a.example.com"), {
    baseDomain: "example.com",
    hostname: "census.host-a.example.com",
  });
});

Deno.test("deriveSite returns null when no caddy model owns a zone", async () => {
  const run = (argv: string[]) =>
    Promise.resolve({
      code: 0,
      stdout: argv[1] === "list"
        ? JSON.stringify({
          results: [{ name: "x", type: "@svendowideit/caddy" }],
        })
        : JSON.stringify({ globalArguments: { baseDomain: "" } }),
    });
  assertEquals(await deriveSite(run, "host-a"), null);
});

Deno.test("deriveSite returns null when the CLI gives nothing", async () => {
  assertEquals(
    await deriveSite(() => Promise.resolve({ code: 1, stdout: "" }), "host-a"),
    null,
  );
});

// ---------------------------------------------------------------------------
// Version probes must run on the host that owns the binary
// ---------------------------------------------------------------------------

/** A software item shaped like the scanner's, with only the fields probes touch. */
function probeItem(over: Record<string, unknown> = {}) {
  return {
    id: "/home/sven/.local/bin/swamp",
    name: "swamp",
    identity: { kind: "github", name: "swamp-club/swamp" },
    version: "",
    versionSource: "unknown",
    manager: "none",
    provenance: "hand-installed",
    installPath: "/home/sven/.local/bin/swamp",
    realPath: "/home/sven/.local/bin/swamp",
    sizeBytes: 1,
    mtime: "",
    sha256: "",
    owner: { class: "manageable", extension: "", command: "", confidence: 0 },
    evidence: [],
    flags: ["unknown-version"],
    bundledWith: "",
    ...over,
  };
}

Deno.test("probeCandidates owes a probe only for a versionless catalogue product", () => {
  const versioned = probeItem({ version: "1.0.0", versionSource: "cli" });
  const relative = probeItem({ installPath: "swamp", id: "swamp" });
  const unknown = probeItem({
    name: "mystery",
    identity: { kind: "name", name: "mystery" },
    installPath: "/opt/mystery",
    id: "/opt/mystery",
  });
  const candidates = probeCandidates([
    probeItem() as never,
    versioned as never,
    relative as never,
    unknown as never,
  ]);
  assertEquals(candidates.length, 1);
  assertEquals(candidates[0].path, "/home/sven/.local/bin/swamp");
  assertEquals(candidates[0].args, ["--version"]);
});

Deno.test("renderProbeScript runs the probe on the host and cannot drift to another path", () => {
  const script = renderProbeScript(probeCandidates([probeItem() as never]));
  // the probe must name the host's own path, and the argv is the catalogue's
  assertEquals(
    script.includes("'/home/sven/.local/bin/swamp' '--version'"),
    true,
  );
  assertEquals(script.startsWith("#!/bin/sh"), true);
  // one line per candidate, so a silent binary cannot merge two results
  assertEquals(script.includes("printf '\\n'"), true);
});

Deno.test("renderProbeScript is empty when nothing is owed", () => {
  assertEquals(renderProbeScript([]), "");
});

Deno.test("applyProbeResults takes the version the host reported", () => {
  const item = probeItem();
  const candidates = probeCandidates([item as never]);
  const out = applyProbeResults(
    [item] as never,
    candidates,
    [
      "probe\t/home/sven/.local/bin/swamp\tswamp 20261121.085447.0-sha.e52c839b",
    ].join("\n"),
  );
  assertEquals(
    (out[0] as { version: string }).version,
    "20261121.085447.0-sha.e52c839b",
  );
  assertEquals((out[0] as { versionSource: string }).versionSource, "cli");
  assertEquals(
    (out[0] as { flags: string[] }).flags.includes("unknown-version"),
    false,
  );
});

Deno.test("applyProbeResults leaves the version unknown when the host said nothing", () => {
  const item = probeItem();
  const candidates = probeCandidates([item as never]);
  const out = applyProbeResults(
    [item] as never,
    candidates,
    "probe\t/home/sven/.local/bin/swamp\t",
  );
  assertEquals((out[0] as { version: string }).version, "");
  assertEquals((out[0] as { versionSource: string }).versionSource, "unknown");
});

Deno.test("applyProbeResults ignores a report for a different path", () => {
  const item = probeItem();
  const candidates = probeCandidates([item as never]);
  const out = applyProbeResults(
    [item] as never,
    candidates,
    [
      "probe\t/opt/elsewhere/swamp\tswamp 20260101.000000.0-sha.deadbeef",
    ].join("\n"),
  );
  assertEquals((out[0] as { version: string }).version, "");
});

// ---------------------------------------------------------------------------
// "Abandoned" is a claim about a file somewhere: say which file
// ---------------------------------------------------------------------------

Deno.test("buildSoftwareIndex records the install paths behind each host entry", () => {
  const items = [
    probeItem({
      name: "tuios",
      installPath: "/home/sven/.local/bin/tuios",
      id: "/home/sven/.local/bin/tuios",
    }),
    probeItem({
      name: "tuios",
      installPath: "/usr/local/bin/tuios",
      id: "/usr/local/bin/tuios",
    }),
  ];
  const rows = buildSoftwareIndex([{
    host: "host-a",
    ok: true,
    items: items as never,
  }]);
  assertEquals(rows.length, 1);
  assertEquals(rows[0].hosts[0].installs, 2);
  assertEquals(rows[0].hosts[0].paths, [
    "/home/sven/.local/bin/tuios",
    "/usr/local/bin/tuios",
  ]);
});

Deno.test("whereInstalled names every file, per host", () => {
  const row = {
    name: "tuios",
    hosts: [
      {
        host: "host-a",
        version: "1.2.3",
        manager: "none",
        owner: "unknown",
        flags: [],
        installs: 2,
        paths: ["/home/sven/.local/bin/tuios", "/usr/local/bin/tuios"],
      },
      {
        host: "host-b",
        version: "1.2.3",
        manager: "none",
        owner: "unknown",
        flags: [],
        installs: 1,
        paths: ["/usr/local/bin/tuios"],
      },
    ],
  } as never;
  const html = whereInstalled(row);
  assertEquals(html.includes("<b>host-a</b> 1.2.3"), true);
  assertEquals(html.includes("<code>/home/sven/.local/bin/tuios</code>"), true);
  assertEquals(html.includes("<code>/usr/local/bin/tuios</code>"), true);
  assertEquals(html.includes("<b>host-b</b>"), true);
});

Deno.test("whereInstalled is empty when the product is not in the index", () => {
  assertEquals(whereInstalled(undefined), "");
});

Deno.test("the abandoned table names the file, not just the host", () => {
  const row = {
    identity: "github:acme/tuios",
    identities: [],
    name: "tuios",
    hosts: [
      {
        host: "host-a",
        version: "1.2.3",
        manager: "none",
        owner: "unknown",
        flags: [],
        installs: 1,
        paths: ["/home/sven/.local/bin/tuios"],
      },
    ],
    versions: ["1.2.3"],
    skewed: false,
    managedOn: [],
    manageableOn: [],
    extension: "",
    command: "",
    missingOn: [],
  };
  const html = renderIndex(
    { hosts: [], software: [row], summary: {}, scannedAt: "" } as never,
    {
      rows: [{
        name: "tuios",
        repo: "acme/tuios",
        installed: [{ host: "host-a", version: "1.2.3", channel: "latest" }],
        latest: { version: "1.2.3", publishedAt: "", tag: "v1.2.3" },
        lts: null,
        dev: null,
        archived: false,
        upstreamIdleDays: 900,
        oldestInstalledDays: 90,
        behindMajor: 0,
        flags: ["abandoned", "upstream-idle-2y"],
        error: "",
      }],
      summary: {},
      generatedAt: "",
    } as never,
    "now",
  );
  assertEquals(html.includes("<code>/home/sven/.local/bin/tuios</code>"), true);
});

Deno.test("the matched unit decides which extension owns swamp", () => {
  const swamp = catalogEntryFor("swamp")!;
  assertEquals(ownerForUnit(swamp, "swamp-serve"), {
    extension: "@svendowideit/swamp-serve",
    command: "swamp extension pull @svendowideit/swamp-serve",
  });
  assertEquals(ownerForUnit(swamp, "swamp-worker-figy"), {
    extension: "@svendowideit/swamp-worker",
    command: "swamp extension pull @svendowideit/swamp-worker",
  });
  // an entry that does not distinguish by unit keeps its generic answer
  const ollama = catalogEntryFor("ollama")!;
  assertEquals(
    ownerForUnit(ollama, "ollama").extension,
    "@svendowideit/ollama",
  );
});

Deno.test("a symlink to a unit-run binary is managed, not a conversion candidate", () => {
  const tsv = [
    "meta\thost\tt440s",
    "pathdir\t/home/sven/.local/bin\tknown",
    "pathdir\t/usr/local/bin\tpath",
    // the same file reached two ways: the PATH symlink and the real binary
    "bin\tswamp\t/usr/local/bin/swamp\t/home/sven/.local/bin/swamp\t288404552\t1760000000\tdeadbeef\t1\tsystem\t-\t-\t20261121.085447.0-sha.e52c839b",
    "bin\tswamp\t/home/sven/.local/bin/swamp\t/home/sven/.local/bin/swamp\t288404552\t1760000000\tdeadbeef\t1\tsystem\t-\t-\t20261121.085447.0-sha.e52c839b",
    // the unit runs the real path; the symlink must inherit that evidence
    "unit\tuser\tswamp-serve\t%h/.local/bin/swamp serve --port 9090\t/home/sven/.config/systemd/user/swamp-serve.service",
    "unitstate\tuser\tswamp-serve\tactive",
    "meta\tdone\t2026-11-21T00:00:00Z",
  ].join("\n");
  const items = buildItems(parseScan(tsv), { home: "/home/sven" });
  const swampItems = items.filter((i) => i.name === "swamp");
  assertEquals(swampItems.length, 2);
  for (const item of swampItems) {
    assertEquals(item.owner.class, "managed");
    assertEquals(item.owner.extension, "@svendowideit/swamp-serve");
  }
});
