import { assertEquals, assertFalse } from "jsr:@std/assert@1";
import {
  channelTriple,
  collectPairs,
  dedupeNamespaces,
  isChannel,
  normalizeHost,
  normalizeNamespace,
  normalizeRow,
  normalizeVersionRows,
  pairKey,
  parseTrustedCollectives,
  planEntries,
  type RegistryExtension,
  registryUrl,
  triplesEqual,
} from "./extension_releases.ts";

const HOST = "swamp-club.com";

function ext(overrides: Partial<RegistryExtension> = {}): RegistryExtension {
  return {
    name: "@svendowideit/caddy",
    namespace: "@svendowideit",
    author: "svendowideit",
    latestVersion: "2026.10.11.1",
    latestRc: "",
    latestBeta: "2026.10.10.19",
    updatedAt: "2026-10-12T06:50:06.293Z",
    url: "https://swamp-club.com/extensions/@svendowideit/caddy",
    ...overrides,
  };
}

Deno.test("normalizeHost strips scheme and trailing slashes", () => {
  assertEquals(normalizeHost("https://swamp-club.com/"), "swamp-club.com");
  assertEquals(normalizeHost("http://swamp.club"), "swamp.club");
  assertEquals(normalizeHost("swamp-club.com"), "swamp-club.com");
});

Deno.test("registryUrl builds the registry page", () => {
  assertEquals(
    registryUrl(HOST, "@svendowideit/caddy"),
    "https://swamp-club.com/extensions/@svendowideit/caddy",
  );
});

Deno.test("normalizeNamespace strips @ and whitespace", () => {
  assertEquals(normalizeNamespace(" @svendowideit "), "svendowideit");
  assertEquals(normalizeNamespace("figy"), "figy");
  assertEquals(normalizeNamespace(""), "");
});

Deno.test("dedupeNamespaces normalises, dedupes and drops blanks", () => {
  assertEquals(
    dedupeNamespaces(["@svendowideit", "svendowideit", "figy", " ", "figy"]),
    ["svendowideit", "figy"],
  );
});

Deno.test("pairKey and isChannel", () => {
  assertEquals(pairKey("1.0.0", "beta"), "1.0.0|beta");
  assertFalse(isChannel("nightly"));
  assertEquals(isChannel("stable"), true);
  assertEquals(isChannel("rc"), true);
});

Deno.test("channelTriple and triplesEqual", () => {
  const triple = channelTriple(ext());
  assertEquals(triple, {
    stable: "2026.10.11.1",
    rc: "",
    beta: "2026.10.10.19",
  });
  assertEquals(triplesEqual(triple, { ...triple }), true);
  assertEquals(triplesEqual(triple, { ...triple, beta: "x" }), false);
});

Deno.test("normalizeRow reads author, versions and url", () => {
  const row = normalizeRow({
    name: "@svendowideit/caddy",
    namespace: "@svendowideit",
    author: { username: "svendowideit" },
    latestVersion: "2026.10.11.1",
    latestRc: null,
    latestBeta: "2026.10.10.19",
    updatedAt: "2026-10-12T06:50:06.293Z",
  }, HOST);
  assertEquals(row.author, "svendowideit");
  assertEquals(row.latestRc, "");
  assertEquals(
    row.url,
    "https://swamp-club.com/extensions/@svendowideit/caddy",
  );
});

Deno.test("normalizeVersionRows lower-cases channels and skips nameless", () => {
  const rows = normalizeVersionRows({
    versions: [
      { version: "2026.10.11.1", channel: "STABLE", publishedAt: "t1" },
      { channel: "beta" },
      { version: "2026.10.10.19", channel: "beta", publishedAt: "t2" },
    ],
  });
  assertEquals(rows.length, 2);
  assertEquals(rows[0].channel, "stable");
  assertEquals(rows[1].version, "2026.10.10.19");
});

Deno.test("collectPairs keeps only known channels, deduped", () => {
  const pairs = collectPairs([
    { version: "1", channel: "beta", publishedAt: "" },
    { version: "1", channel: "beta", publishedAt: "" },
    { version: "1", channel: "stable", publishedAt: "" },
    { version: "1", channel: "nightly", publishedAt: "" },
  ]);
  assertEquals(pairs, ["1|beta", "1|stable"]);
});

Deno.test("planEntries records a first sighting as publish", () => {
  const entries = planEntries({
    extension: "@svendowideit/caddy",
    namespace: "@svendowideit",
    author: "svendowideit",
    url: "https://swamp-club.com/extensions/@svendowideit/caddy",
    versions: [
      { version: "2026.10.10.19", channel: "beta", publishedAt: "t-beta" },
    ],
    knownPairs: new Set(),
    bootstrapSinceMs: null,
    observedAt: "2026-10-13T09:00:00.000Z",
  });
  assertEquals(entries.length, 1);
  assertEquals(entries[0].event, "publish");
  assertEquals(entries[0].fromChannel, "");
  assertEquals(entries[0].channel, "beta");
  assertEquals(entries[0].publishedAt, "t-beta");
  assertEquals(
    entries[0].url,
    "https://swamp-club.com/extensions/@svendowideit/caddy",
  );
});

Deno.test("planEntries detects a promotion from a lower channel", () => {
  const entries = planEntries({
    extension: "@svendowideit/caddy",
    namespace: "@svendowideit",
    author: "svendowideit",
    url: "u",
    versions: [
      { version: "2026.10.11.1", channel: "stable", publishedAt: "t-stable" },
    ],
    knownPairs: new Set(["2026.10.11.1|beta"]),
    bootstrapSinceMs: null,
    observedAt: "2026-10-13T09:00:00.000Z",
  });
  assertEquals(entries.length, 1);
  assertEquals(entries[0].event, "promote");
  assertEquals(entries[0].fromChannel, "beta");
});

Deno.test("planEntries prefers the highest lower channel as the source", () => {
  const entries = planEntries({
    extension: "@svendowideit/caddy",
    namespace: "@svendowideit",
    author: "svendowideit",
    url: "u",
    versions: [{ version: "1", channel: "stable", publishedAt: "t" }],
    knownPairs: new Set(["1|beta", "1|rc"]),
    bootstrapSinceMs: null,
    observedAt: "now",
  });
  assertEquals(entries[0].fromChannel, "rc");
});

Deno.test("planEntries ignores pairs already in the snapshot", () => {
  const entries = planEntries({
    extension: "@svendowideit/caddy",
    namespace: "@svendowideit",
    author: "svendowideit",
    url: "u",
    versions: [{ version: "1", channel: "beta", publishedAt: "t" }],
    knownPairs: new Set(["1|beta"]),
    bootstrapSinceMs: null,
    observedAt: "now",
  });
  assertEquals(entries.length, 0);
});

Deno.test("planEntries suppresses old versions on the first run", () => {
  const old = new Date("2026-01-01T00:00:00.000Z").toISOString();
  const recent = new Date().toISOString();
  const entries = planEntries({
    extension: "@svendowideit/caddy",
    namespace: "@svendowideit",
    author: "svendowideit",
    url: "u",
    versions: [
      { version: "old", channel: "stable", publishedAt: old },
      { version: "new", channel: "beta", publishedAt: recent },
    ],
    knownPairs: new Set(),
    bootstrapSinceMs: Date.now() - 48 * 3_600_000,
    observedAt: recent,
  });
  assertEquals(entries.map((e) => e.version), ["new"]);
});

Deno.test("planEntries skips unknown channels and nameless versions", () => {
  const entries = planEntries({
    extension: "@svendowideit/caddy",
    namespace: "@svendowideit",
    author: "svendowideit",
    url: "u",
    versions: [
      { version: "1", channel: "nightly", publishedAt: "t" },
      { version: "", channel: "beta", publishedAt: "t" },
    ],
    knownPairs: new Set(),
    bootstrapSinceMs: null,
    observedAt: "now",
  });
  assertEquals(entries.length, 0);
});

Deno.test("parseTrustedCollectives reads only the one block", () => {
  const yaml = [
    "swampVersion: 1",
    "trustedCollectives:",
    "  - swamp",
    '  - "@svendowideit"',
    "  - figy",
    "vault:",
    "  - not-a-collective",
    "",
  ].join("\n");
  assertEquals(parseTrustedCollectives(yaml), [
    "swamp",
    "svendowideit",
    "figy",
  ]);
});

Deno.test("parseTrustedCollectives returns empty when the block is absent", () => {
  assertEquals(parseTrustedCollectives("swampVersion: 1\n"), []);
});

Deno.test("planEntries with bootstrapSinceMs zero logs everything recent", () => {
  const entries = planEntries({
    extension: "@a/b",
    namespace: "@a",
    author: "a",
    url: "u",
    versions: [{
      version: "1",
      channel: "stable",
      publishedAt: "2026-06-01T00:00:00.000Z",
    }],
    knownPairs: new Set(),
    bootstrapSinceMs: 0,
    observedAt: "now",
  });
  assertEquals(entries.length, 1);
});

Deno.test("planEntries throws nothing for an empty version list", () => {
  const entries = planEntries({
    extension: "@a/b",
    namespace: "@a",
    author: "a",
    url: "u",
    versions: [],
    knownPairs: new Set(),
    bootstrapSinceMs: null,
    observedAt: "now",
  });
  assertEquals(entries.length, 0);
});
