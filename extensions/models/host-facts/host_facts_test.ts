/**
 * Tests for the `@svendowideit/host-facts` model: the pure field mapping (which
 * is where the fleet-inventory alignment lives) and the host read, with the
 * commands faked so the test is independent of the machine it runs on.
 *
 * @module
 */
import { assertEquals } from "jsr:@std/assert@1";
import {
  createModelTestContext,
  withMockedCommand,
} from "jsr:@swamp-club/swamp-testing@^0.3.0";
import {
  buildHostFacts,
  chooseFqdn,
  type CollectDeps,
  detectRaw,
  model,
  parseMachineId,
  parseOsRelease,
  uniqueNonEmpty,
} from "./host_facts.ts";

const GLOBALS = {
  name: "host",
  fqdnOverride: "",
  hostnameOverride: "",
  domain: "",
};

Deno.test("parseOsRelease reads the ID, ignoring other keys and quotes", () => {
  assertEquals(
    parseOsRelease('NAME="Ubuntu"\nID=ubuntu\nVERSION_ID="24.04"\n'),
    "ubuntu",
  );
  assertEquals(parseOsRelease('ID="debian"\n'), "debian");
  assertEquals(parseOsRelease("NAME=Arch\n"), "");
});

Deno.test("parseMachineId returns the first non-empty trimmed line", () => {
  assertEquals(parseMachineId("\n  abc123def456  \n"), "abc123def456");
  assertEquals(parseMachineId(""), "");
});

Deno.test("uniqueNonEmpty trims, drops blanks, de-dupes case-insensitively", () => {
  assertEquals(
    uniqueNonEmpty(["a", " A ", "", "b", "A", "c"]),
    ["a", "b", "c"],
  );
});

Deno.test("chooseFqdn prefers the override, then a dotted detection, then short.domain", () => {
  assertEquals(chooseFqdn("h.fi.gy", "h", "example.org"), "example.org");
  // A real dotted FQDN from `hostname -f` is used and not re-qualified.
  assertEquals(chooseFqdn("h.fi.gy", "h", "", "fi.gy"), "h.fi.gy");
  assertEquals(chooseFqdn("h.fi.gy", "h"), "h.fi.gy");
  // A short/`localhost` detection gets the site domain appended.
  assertEquals(chooseFqdn("x1yoga", "x1yoga", "", "fi.gy"), "x1yoga.fi.gy");
  assertEquals(chooseFqdn("localhost", "x1yoga", "", "fi.gy"), "x1yoga.fi.gy");
  // No domain → the short name.
  assertEquals(chooseFqdn("localhost", "h"), "h");
  assertEquals(chooseFqdn("", "h"), "h");
});

Deno.test("buildHostFacts aligns with fleet-inventory's host vocabulary", () => {
  const facts = buildHostFacts(
    {
      fqdn: "x1yoga.fi.gy",
      short: "x1yoga",
      aliases: ["x1yoga.fi.gy", "x1yoga.local"],
      os: "Ubuntu",
      arch: "x86_64",
      machineId: "abc123",
      addresses: ["10.10.13.208", "10.10.13.208", "100.64.0.5"],
    },
    { now: "2026-10-11T00:00:00Z" },
  );
  // FQDN is the primary name and is exposed explicitly too.
  assertEquals(facts.name, "x1yoga.fi.gy");
  assertEquals(facts.fqdn, "x1yoga.fi.gy");
  assertEquals(facts.hostname, "x1yoga");
  // Every name once, FQDN-first (aliases align with fleet-inventory).
  assertEquals(facts.hostnames, ["x1yoga.fi.gy", "x1yoga", "x1yoga.local"]);
  // Addresses ordered, de-duplicated; primary is the first.
  assertEquals(facts.addresses, ["10.10.13.208", "100.64.0.5"]);
  assertEquals(facts.address, "10.10.13.208");
  // Aligned identity/classification fields.
  assertEquals(facts.machineId, "abc123");
  assertEquals(facts.os, "ubuntu");
  assertEquals(facts.source, "self");
  assertEquals(facts.probed, true);
  assertEquals(facts.tier, "");
  assertEquals(facts.lastSeen, "2026-10-11T00:00:00Z");
  // Empty-by-design fields are present, not absent (schema alignment).
  assertEquals(facts.mac, "");
  assertEquals(facts.macs, []);
});

Deno.test("buildHostFacts applies overrides", () => {
  const facts = buildHostFacts(
    {
      fqdn: "",
      short: "ignored",
      aliases: [],
      os: "",
      arch: "",
      machineId: "",
      addresses: [],
    },
    { fqdnOverride: "worker-1.svc", hostnameOverride: "worker-1" },
  );
  assertEquals(facts.fqdn, "worker-1.svc");
  assertEquals(facts.hostname, "worker-1");
  assertEquals(facts.name, "worker-1.svc");
});

Deno.test("buildHostFacts composes the FQDN from the site domain", () => {
  const facts = buildHostFacts(
    {
      fqdn: "x1yoga",
      short: "x1yoga",
      aliases: [],
      os: "ubuntu",
      arch: "x86_64",
      machineId: "m",
      addresses: ["10.0.0.1"],
    },
    { domain: "fi.gy" },
  );
  assertEquals(facts.fqdn, "x1yoga.fi.gy");
  assertEquals(facts.name, "x1yoga.fi.gy");
  assertEquals(facts.hostname, "x1yoga");
});

/** Fake host commands for the read test. */
function hostHandler() {
  return (command: string, args: string[]) => {
    if (command === "hostname") {
      switch (args[0]) {
        case "-f":
          return { stdout: "x1yoga.fi.gy\n", code: 0 };
        case "-s":
          return { stdout: "x1yoga\n", code: 0 };
        case "-A":
          return { stdout: "x1yoga.fi.gy x1yoga\n", code: 0 };
        case "-I":
          return { stdout: "10.10.13.208 100.64.0.5\n", code: 0 };
        default:
          return { stdout: "x1yoga\n", code: 0 };
      }
    }
    if (command === "uname" && args[0] === "-s") {
      return { stdout: "Linux\n", code: 0 };
    }
    if (command === "uname" && args[0] === "-m") {
      return { stdout: "x86_64\n", code: 0 };
    }
    return { stdout: "", code: 1 };
  };
}

Deno.test("detectRaw assembles the raw facts from the host commands", async () => {
  const handler = hostHandler();
  const deps: CollectDeps = {
    run: (bin, args) => {
      const r = handler(bin, args);
      return Promise.resolve(r.code === 0 ? r.stdout.trim() : "");
    },
    readFile: (path) =>
      Promise.resolve(
        path === "/etc/os-release" ? "ID=ubuntu\n" : "machine-abc\n",
      ),
    uname: "",
  };
  const raw = await detectRaw(deps);
  assertEquals(raw.fqdn, "x1yoga.fi.gy");
  assertEquals(raw.short, "x1yoga");
  assertEquals(raw.aliases, ["x1yoga.fi.gy", "x1yoga"]);
  assertEquals(raw.os, "ubuntu");
  assertEquals(raw.arch, "x86_64");
  assertEquals(raw.machineId, "machine-abc");
  assertEquals(raw.addresses, ["10.10.13.208", "100.64.0.5"]);
});

Deno.test("collect writes the aligned host record", async () => {
  const ctx = createModelTestContext({
    globalArgs: GLOBALS,
    methodName: "collect",
  });
  await withMockedCommand(hostHandler(), async () => {
    await (model.methods.collect.execute as unknown as (
      a: Record<string, unknown>,
      c: unknown,
    ) => Promise<unknown>)({}, ctx.context);
  });
  const written = ctx.getWrittenResources();
  assertEquals(written.length, 1);
  assertEquals(written[0].specName, "facts");
  assertEquals(written[0].name, "host");
  const d = written[0].data as Record<string, unknown>;
  assertEquals(d.fqdn, "x1yoga.fi.gy");
  assertEquals(d.hostname, "x1yoga");
  assertEquals(d.name, "x1yoga.fi.gy");
  assertEquals(d.arch, "x86_64");
  assertEquals(d.source, "self");
  assertEquals(d.probed, true);
  assertEquals(d.addresses, ["10.10.13.208", "100.64.0.5"]);
  assertEquals(typeof d.os, "string");
});
