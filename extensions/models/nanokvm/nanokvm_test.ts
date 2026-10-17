/**
 * Unit tests for the pure helpers of `@svendowideit/nanokvm`.
 *
 * Nothing here touches a device or the network: the AES login construction is
 * checked by decrypting it, the health classifier is fed crafted samples, and
 * the OTLP builders are asserted structurally.
 *
 * @module
 */

import { assertEquals, assertStrictEquals } from "jsr:@std/assert@1";
import { createDecipheriv, createHash } from "node:crypto";
import {
  baseUrl,
  buildCertInstallerScript,
  buildOtlpLogs,
  buildOtlpMetrics,
  certDaysRemaining,
  classifyHealth,
  deviceFromDefinition,
  dnsNameFor,
  encryptPassword,
  expandHome,
  extractJpeg,
  type HealthSample,
  jpegSize,
  LOGIN_SECRET_KEY,
  loginEncodings,
  parseCertFields,
  parseEnvelope,
  pickEndpoint,
  sanitizeLabel,
  sessionToken,
  telemetryResource,
} from "./nanokvm.ts";

function baseSample(overrides: Partial<HealthSample> = {}): HealthSample {
  return {
    reachable: true,
    authenticated: true,
    passwordConfigured: true,
    authEncoding: "aes",
    loginMessage: "ok",
    appVersion: "2.4.0",
    appLatest: "2.4.0",
    hardware: "1.2",
    powerLed: true,
    hddLed: false,
    hidMode: "normal",
    mountedImage: "",
    hdmi: { enabled: true, signal: true, idleTimeout: 60 },
    ips: [],
    mdns: "nanokvm.local",
    macImage: "1.4.1",
    application: "2.4.0",
    responseMs: 42,
    hdmiSupported: true,
    ...overrides,
  };
}

/**
 * Decrypt a NanoKVM login payload the way the server does (`aes-everywhere`):
 * strip the `Salted__` header, re-derive the key/IV with EVP_BytesToKey(MD5),
 * and AES-256-CBC decrypt.
 */
function decryptPassword(encoded: string): string {
  const raw = Buffer.from(decodeURIComponent(encoded), "base64");
  assertEquals(raw.subarray(0, 8).toString("binary"), "Salted__");
  const salt = raw.subarray(8, 16);
  const ciphertext = raw.subarray(16);
  const pass = Buffer.from(LOGIN_SECRET_KEY, "utf8");
  let out: Uint8Array = new Uint8Array(0);
  let prev: Uint8Array = new Uint8Array(0);
  while (out.length < 48) {
    const hash = createHash("md5");
    hash.update(prev);
    hash.update(pass);
    hash.update(salt);
    prev = hash.digest();
    out = Buffer.concat([out, prev]);
  }
  const decipher = createDecipheriv(
    "aes-256-cbc",
    out.subarray(0, 32),
    out.subarray(32, 48),
  );
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
    .toString("utf8");
}

Deno.test("encryptPassword round-trips through the firmware key", () => {
  const encoded = encryptPassword("hunter2");
  // The OpenSSL/CryptoJS "Salted__" framing the server expects.
  assertEquals(
    Buffer.from(decodeURIComponent(encoded), "base64").subarray(0, 8)
      .toString("binary"),
    "Salted__",
  );
  assertEquals(decryptPassword(encoded), "hunter2");
});

Deno.test("encryptPassword URL-encodes the ciphertext", () => {
  const encoded = encryptPassword("a password with spaces & symbols");
  assertEquals(encoded.includes(" "), false);
  assertEquals(decryptPassword(encoded), "a password with spaces & symbols");
});

Deno.test("baseUrl omits the default port and keeps a custom one", () => {
  assertEquals(baseUrl("192.0.2.10", 443), "https://192.0.2.10");
  assertEquals(baseUrl("192.0.2.10", 8443), "https://192.0.2.10:8443");
  assertEquals(baseUrl("kvm.local/", 443), "https://kvm.local");
});

Deno.test("sanitizeLabel matches the curl request record naming", () => {
  assertEquals(sanitizeLabel("otel-logs"), "otel-logs");
  assertEquals(sanitizeLabel("192.0.2.10 power"), "192.0.2.10-power");
});

Deno.test("parseEnvelope reads code/msg/data and rejects non-envelopes", () => {
  assertEquals(
    parseEnvelope('{"code":0,"msg":"success","data":{"pwr":true}}'),
    {
      code: 0,
      msg: "success",
      data: { pwr: true },
    },
  );
  assertEquals(parseEnvelope('{"code":-2,"msg":"denied","data":null}'), {
    code: -2,
    msg: "denied",
    data: null,
  });
  assertStrictEquals(parseEnvelope("not json"), null);
  assertStrictEquals(parseEnvelope('{"msg":"no code"}'), null);
  assertStrictEquals(parseEnvelope("[]"), null);
});

Deno.test("loginEncodings tries both under auto and pins an explicit mode", () => {
  assertEquals(loginEncodings("auto"), ["plain", "aes"]);
  assertEquals(loginEncodings("plain"), ["plain"]);
  assertEquals(loginEncodings("aes"), ["aes"]);
});

Deno.test("sessionToken extracts a bearer token and is empty without one", () => {
  assertEquals(
    sessionToken({
      code: 0,
      msg: "success",
      data: { token: "eyJ.x.y", count: 0 },
    }),
    "eyJ.x.y",
  );
  assertEquals(sessionToken({ code: 0, msg: "success", data: null }), "");
  assertEquals(sessionToken({ code: -2, msg: "bad", data: null }), "");
  assertStrictEquals(sessionToken(null), "");
});

Deno.test("dnsNameFor joins a name and zone, tolerating stray dots", () => {
  assertEquals(dnsNameFor("nanokvm", "fi.gy"), "nanokvm.fi.gy");
  assertEquals(dnsNameFor("nanokvm", ".fi.gy."), "nanokvm.fi.gy");
  assertEquals(dnsNameFor("nanokvm", ""), "nanokvm");
});

Deno.test("deviceFromDefinition maps only nanokvm defs that have a host", () => {
  assertEquals(
    deviceFromDefinition({
      type: "@svendowideit/nanokvm",
      name: "nanokvm",
      globalArguments: { host: "192.0.2.10", port: 8443 },
    }, "fi.gy"),
    {
      name: "nanokvm",
      host: "192.0.2.10",
      port: 8443,
      dnsName: "nanokvm.fi.gy",
      source: "",
    },
  );
  // Missing port defaults to 443; a non-nanokvm type or a hostless def is null.
  assertEquals(
    deviceFromDefinition({
      type: "@svendowideit/nanokvm",
      name: "kvm2",
      globalArguments: { host: "10.0.0.2" },
    }, "fi.gy")?.port,
    443,
  );
  assertStrictEquals(
    deviceFromDefinition({
      type: "@svendowideit/caddy",
      name: "x",
      globalArguments: { host: "1.2.3.4" },
    }, "fi.gy"),
    null,
  );
  assertStrictEquals(
    deviceFromDefinition({
      type: "@svendowideit/nanokvm",
      name: "nohost",
      globalArguments: {},
    }, "fi.gy"),
    null,
  );
  assertStrictEquals(deviceFromDefinition(null, "fi.gy"), null);
});

Deno.test("expandHome expands a leading tilde only", () => {
  assertEquals(
    expandHome("~/.local/share/caddy", "/home/u"),
    "/home/u/.local/share/caddy",
  );
  assertEquals(expandHome("/abs/path", "/home/u"), "/abs/path");
});

Deno.test("parseCertFields reads subject/issuer/serial/notAfter/SAN", () => {
  const text = [
    "subject=CN = nanokvm.fi.gy",
    "issuer=C = US, O = Let's Encrypt, CN = R11",
    "serial=03:AB:CD",
    "notAfter=Jan  1 00:00:00 2027 GMT",
    "X509v3 Subject Alternative Name:",
    "    DNS:nanokvm.fi.gy, IP Address:10.10.12.230",
  ].join("\n");
  assertEquals(parseCertFields(text), {
    subject: "CN = nanokvm.fi.gy",
    issuer: "C = US, O = Let's Encrypt, CN = R11",
    serial: "03:AB:CD",
    notAfter: "Jan  1 00:00:00 2027 GMT",
    sans: ["nanokvm.fi.gy"],
  });
});

Deno.test("certDaysRemaining floors whole days and tolerates junk", () => {
  const now = Date.parse("2026-10-17T00:00:00Z");
  assertEquals(
    certDaysRemaining("Fri, 17 Oct 2026 12:00:00 GMT", now),
    0,
  );
  assertEquals(certDaysRemaining("Sun, 27 Oct 2026 00:00:00 GMT", now), 10);
  assertEquals(certDaysRemaining("not a date", now), 0);
});

Deno.test("buildCertInstallerScript embeds both PEMs and restarts", () => {
  const script = buildCertInstallerScript(
    "-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----",
    "-----BEGIN PRIVATE KEY-----\nBBB\n-----END PRIVATE KEY-----",
  );
  assertEquals(script.includes("/etc/kvm/server.crt"), true);
  assertEquals(script.includes("/etc/kvm/server.key"), true);
  assertEquals(script.includes("chmod 600 /etc/kvm/server.key"), true);
  assertEquals(script.includes("/etc/init.d/S95nanokvm restart"), true);
  assertEquals(script.includes("AAA"), true);
  assertEquals(script.includes("BBB"), true);
  // restart=false must not restart the server.
  assertEquals(
    buildCertInstallerScript("x", "y", false)
      .includes("/etc/init.d/S95nanokvm restart"),
    false,
  );
});

Deno.test("classifyHealth fails an unreachable device", () => {
  const { verdict, findings } = classifyHealth(
    baseSample({ reachable: false, authenticated: false }),
  );
  assertEquals(verdict, "fail");
  assertEquals(findings[0].code, "unreachable");
});

Deno.test("classifyHealth distinguishes 'reachable but unconfigured'", () => {
  const { verdict, findings } = classifyHealth(
    baseSample({
      authenticated: false,
      passwordConfigured: false,
      loginMessage: "no password configured",
    }),
  );
  assertEquals(verdict, "fail");
  assertEquals(findings[0].code, "not_configured");
});

Deno.test("classifyHealth fails an unauthenticated device", () => {
  const { verdict, findings } = classifyHealth(
    baseSample({ authenticated: false, loginMessage: "invalid password" }),
  );
  assertEquals(verdict, "fail");
  assertEquals(findings[0].code, "auth_failed");
});

Deno.test("classifyHealth passes a healthy device", () => {
  const { verdict, findings } = classifyHealth(baseSample());
  assertEquals(verdict, "pass");
  assertEquals(findings.length, 0);
});

Deno.test("classifyHealth warns on outdated firmware", () => {
  const { verdict, findings, firmwareOutdated } = classifyHealth(
    baseSample({ appVersion: "2.3.0", appLatest: "2.4.0" }),
  );
  assertEquals(verdict, "warn");
  assertEquals(firmwareOutdated, true);
  assertEquals(findings.some((f) => f.code === "firmware_update"), true);
});

Deno.test("classifyHealth warns on media left mounted and no HDMI signal", () => {
  const { verdict, findings } = classifyHealth(
    baseSample({
      mountedImage: "/data/ubuntu.iso",
      hdmi: { enabled: true, signal: false, idleTimeout: 60 },
    }),
  );
  assertEquals(verdict, "warn");
  assertEquals(
    findings.some((f) => f.code === "virtual_media_mounted"),
    true,
  );
  assertEquals(findings.some((f) => f.code === "hdmi_no_signal"), true);
});

Deno.test("classifyHealth notes unsupported HDMI as info only", () => {
  const { verdict, findings } = classifyHealth(
    baseSample({ hdmiSupported: false, hdmi: null }),
  );
  assertEquals(verdict, "pass");
  assertEquals(findings[0].code, "hdmi_unsupported");
  assertEquals(findings[0].severity, "info");
});

Deno.test("classifyHealth warns on a slow response", () => {
  const { verdict } = classifyHealth(
    baseSample({ responseMs: 5000 }),
    { maxClockSkewSeconds: 2 },
  );
  assertEquals(verdict, "warn");
});

Deno.test("extractJpeg trims the first complete frame", () => {
  const junk = new Uint8Array([0x00, 0x01, 0x02]);
  const frame = new Uint8Array([0xff, 0xd8, 0xaa, 0xbb, 0xff, 0xd9]);
  const tail = new Uint8Array([0x10, 0x11]);
  const buf = new Uint8Array([...junk, ...frame, ...tail]);
  const got = extractJpeg(buf);
  assertEquals(got, frame);
  assertStrictEquals(extractJpeg(junk), null);
});

Deno.test("jpegSize reads the SOF0 dimensions", () => {
  // SOI, SOF0 (len 17, precision 8, 480x640), then an EOI.
  const bytes = new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    0x01,
    0xe0,
    0x02,
    0x80,
    0x03,
    0x01,
    0x11,
    0x00,
    0x02,
    0x11,
    0x00,
    0x03,
    0x11,
    0x00,
    0xff,
    0xd9,
  ]);
  assertEquals(jpegSize(bytes), { width: 640, height: 480 });
  assertEquals(jpegSize(new Uint8Array([0xff, 0xd8])), { width: 0, height: 0 });
});

Deno.test("pickEndpoint prefers override, then mesh, then default, then first", () => {
  const endpoints = [
    { mesh: "tailscale", otlp_http: "otlp.fi.gy:4318" },
    { mesh: "wireguard", otlp_http: "otlp.wg.fi.gy:4318" },
  ];
  assertEquals(pickEndpoint(endpoints, { override: "http://127.0.0.1:4318" }), {
    base: "http://127.0.0.1:4318",
    mesh: "override",
  });
  assertEquals(
    pickEndpoint(endpoints, { mesh: "wireguard" }).mesh,
    "wireguard",
  );
  assertEquals(
    pickEndpoint(endpoints, { defaultMesh: "wireguard" }).mesh,
    "wireguard",
  );
  assertEquals(pickEndpoint(endpoints).base, "http://otlp.fi.gy:4318");
  assertEquals(pickEndpoint([], {}), { base: "", mesh: "" });
});

Deno.test("pickEndpoint can prefer the TLS url", () => {
  const endpoints = [{
    mesh: "tailscale",
    otlp_http: "otlp.fi.gy:4318",
    otlp_http_url: "https://otlp.fi.gy",
  }];
  assertEquals(
    pickEndpoint(endpoints, { preferUrl: true }).base,
    "https://otlp.fi.gy",
  );
});

Deno.test("telemetryResource carries identity and contract attributes", () => {
  const attrs = telemetryResource("192.0.2.10", {
    site: "home",
    owner: "sven",
  });
  const map = Object.fromEntries(
    attrs.map((a) => [a.key, a.value.stringValue]),
  );
  assertEquals(map["service.name"], "nanokvm");
  assertEquals(map["device.host"], "192.0.2.10");
  assertEquals(map.site, "home");
  assertEquals(map.owner, "sven");
});

Deno.test("buildOtlpLogs encodes the verdict and findings", () => {
  const payload = buildOtlpLogs(
    "192.0.2.10",
    {
      verdict: "warn",
      findings: [{ code: "firmware_update", severity: "warn", message: "old" }],
      appVersion: "2.3.0",
      checkedAt: "2026-10-17T00:00:00.000Z",
    },
    { site: "home" },
    "2026-10-17T00:00:00.000Z",
  );
  const resourceLogs = payload.resourceLogs as Array<Record<string, unknown>>;
  assertEquals(resourceLogs.length, 1);
  const scopeLogs = resourceLogs[0].scopeLogs as Array<Record<string, unknown>>;
  const records = scopeLogs[0].logRecords as Array<Record<string, unknown>>;
  assertEquals(records[0].severityText, "WARN");
  assertEquals(records[0].severityNumber, 13);
});

Deno.test("buildOtlpMetrics emits up/health/response gauges", () => {
  const payload = buildOtlpMetrics(
    "192.0.2.10",
    {
      verdict: "pass",
      reachable: true,
      responseMs: 12,
      powerLed: true,
      mountedImage: "",
      hdmi: { enabled: true, signal: true },
    },
    {},
    "2026-10-17T00:00:00.000Z",
  );
  const resourceMetrics = payload.resourceMetrics as Array<
    Record<string, unknown>
  >;
  const scopeMetrics = resourceMetrics[0].scopeMetrics as Array<
    Record<string, unknown>
  >;
  const metrics = scopeMetrics[0].metrics as Array<{ name: string }>;
  const names = metrics.map((m) => m.name);
  assertEquals(names.includes("nanokvm.up"), true);
  assertEquals(names.includes("nanokvm.health"), true);
  assertEquals(names.includes("nanokvm.response_time"), true);
  assertEquals(names.includes("nanokvm.power_on"), true);
  assertEquals(names.includes("nanokvm.hdmi_signal"), true);
});
