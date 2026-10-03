import { assertEquals } from "jsr:@std/assert@1";

import {
  classifyHttp,
  extractTitle,
  parseCert,
  parseHeader,
  parseStatus,
} from "./http_fingerprint.ts";

Deno.test("parseHeader finds a header case-insensitively", () => {
  const head = "HTTP 200\nServer: SHIP 2.0\nContent-Type: text/html\n";
  assertEquals(parseHeader(head, "server"), "SHIP 2.0");
  assertEquals(parseHeader(head, "SERVER"), "SHIP 2.0");
  assertEquals(parseHeader(head, "missing"), "");
  assertEquals(parseStatus(head), 200);
});

Deno.test("extractTitle pulls the first title", () => {
  assertEquals(
    extractTitle("<html><head><title>NanoKVM</title></head>"),
    "NanoKVM",
  );
  assertEquals(extractTitle("<html></html>"), "");
});

Deno.test("parseCert reads subject/issuer", () => {
  const out = "subject=CN=unifi.local\nissuer=CN=unifi.local\n";
  assertEquals(parseCert(out), {
    subject: "CN=unifi.local",
    issuer: "CN=unifi.local",
  });
});

Deno.test("classifyHttp recognises UniFi by cert and by banner", () => {
  assertEquals(
    classifyHttp({
      server: "",
      title: "",
      certSubject: "CN=unifi.local",
      certIssuer: "CN=unifi.local",
    }),
    { deviceClass: "unifi", vendor: "Ubiquiti" },
  );
  assertEquals(
    classifyHttp({
      server: "one-two-three",
      title: "",
      certSubject: "",
      certIssuer: "",
    }).deviceClass,
    "unifi",
  );
});

Deno.test("classifyHttp recognises NanoKVM and GL.iNet", () => {
  assertEquals(
    classifyHttp({
      server: "",
      title: "NanoKVM",
      certSubject: "",
      certIssuer: "",
    }),
    { deviceClass: "nanokvm", vendor: "Sipeed" },
  );
  assertEquals(
    classifyHttp({
      server: "glinet",
      title: "",
      certSubject: "",
      certIssuer: "",
    }).deviceClass,
    "glinet",
  );
});

Deno.test("classifyHttp honours caller overrides and reports generic devices", () => {
  assertEquals(
    classifyHttp(
      {
        server: "MikroTik-RouterOS",
        title: "",
        certSubject: "",
        certIssuer: "",
      },
      { mikrotik: { deviceClass: "router", vendor: "MikroTik" } },
    ),
    { deviceClass: "router", vendor: "MikroTik" },
  );
  assertEquals(
    classifyHttp({
      server: "Caddy",
      title: "",
      certSubject: "",
      certIssuer: "",
    }).deviceClass,
    "web-server",
  );
  assertEquals(
    classifyHttp({ server: "", title: "", certSubject: "", certIssuer: "" }),
    { deviceClass: "", vendor: "" },
  );
});
