import { assertEquals } from "jsr:@std/assert@1";

import { assessKey, buildUniqueKeys, computeAgeYears, escapeHtml, parseHostTarget, parseKeygenLine, renderHtmlReport } from "./ssh_key_inventory.ts";

Deno.test("parseHostTarget handles user@host:port", () => {
  assertEquals(parseHostTarget("alice@example.com:2222"), { user: "alice", host: "example.com", port: 2222 });
  assertEquals(parseHostTarget("example.com", "bob"), { user: "bob", host: "example.com", port: 22 });
});

Deno.test("parseKeygenLine parses ssh-keygen -l output", () => {
  const r = parseKeygenLine("256 SHA256:abc123 comment (ED25519)");
  assertEquals(r.bits, 256);
  assertEquals(r.fingerprint, "SHA256:abc123");
  assertEquals(r.algorithm, "ED25519");
});

Deno.test("assessKey flags weak and unencrypted keys", () => {
  const r = assessKey("RSA", 1024, false, "644", 4, 2);
  assertEquals(r.severity, "critical");
});

Deno.test("computeAgeYears returns null for no mtime", () => {
  assertEquals(computeAgeYears(null), null);
});

Deno.test("buildUniqueKeys aggregates fingerprints", () => {
  const hosts: any = [{
    target: "a@h", user: "a", host: "h", port: 22, ok: true, error: "", collectedAt: "x",
    privateKeys: [{ path: "/.ssh/id_rsa", fingerprint: "SHA256:x", algorithm: "RSA", bits: 2048, comment: "c", perms: "600", mtime: 1000, size: 10, encrypted: true, authorized: true, authorizedFiles: ["/home/a/.ssh/authorized_keys"] }],
    authorizedKeys: [{ file: "/home/a/.ssh/authorized_keys", fingerprint: "SHA256:x", line: "ssh-rsa AAAA" }],
  }];
  const keys = buildUniqueKeys(hosts, Date.parse("2026-01-01T00:00:00Z"));
  assertEquals(keys.length, 1);
  assertEquals(keys[0].occurrences, 1);
  assertEquals(keys[0].authorizedSystems, ["a@h"]);
});

Deno.test("escapeHtml and renderHtmlReport produce html", () => {
  const html = renderHtmlReport({ generatedAt: "2026-01-01T00:00:00.000Z", totalHosts: 0, reachableHosts: 0, privateKeys: 0, uniqueKeys: 0, hosts: [], keys: [] });
  if (!html.includes("<!doctype html>")) throw new Error("bad html");
});
