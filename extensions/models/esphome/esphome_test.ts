import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  applySseEvents,
  buildHtml,
  caddyModelNames,
  compactDevices,
  deriveOutputFile,
  escapeHtml,
  expandCidr,
  intToIp,
  ipToInt,
  looksLikeEsphomeApiHello,
  looksLikeEsphomeWebRoot,
  mergeInto,
  normaliseMac,
  parseAvahiLine,
  parseCaddyModelFacts,
  parseEsphomeTxt,
  pickSourceCaddy,
  summarise,
} from "./esphome.ts";

const G = {
  scanCidr: "",
  apiPorts: [6053],
  webPorts: [80],
  scanTimeoutMs: 400,
  scanConcurrency: 8,
  mdnsPasses: 1,
  interrogateTimeoutMs: 100,
  outputDir: "~/.local/share/esphome",
  outputFile: "",
  pageTitle: "ESPHome fleet",
  pageHostname: "esphome.x1yoga.fi.gy",
  caddyModelName: "",
  caddyRouteHostname: "",
  caddyServeModel: "esphome-caddy",
};

type Dev = Parameters<typeof mergeInto>[1];

function device(over: Partial<Dev> = {}): Dev {
  return {
    mac: "",
    name: "",
    friendlyName: "",
    addresses: [],
    sources: [],
    board: "",
    platform: "",
    esphomeVersion: "",
    configHash: "",
    network: "",
    apiEncryption: "",
    mdnsEnabled: false,
    apiPort: 0,
    webServerPort: 0,
    entities: [],
    sensorCount: 0,
    actuatorCount: 0,
    interrogated: false,
    error: "",
    ...over,
  };
}

// ---------------------------------------------------------------- identity

Deno.test("normaliseMac accepts the forms ESPHome publishes", () => {
  assertEquals(normaliseMac("58e6c5105db8"), "58:e6:c5:10:5d:b8");
  assertEquals(normaliseMac("58:E6:C5:10:5D:B8"), "58:e6:c5:10:5d:b8");
  assertEquals(normaliseMac("58-e6-c5-10-5d-b8"), "58:e6:c5:10:5d:b8");
  assertEquals(normaliseMac(""), "");
  assertEquals(normaliseMac("not-a-mac"), "");
});

Deno.test("a DHCP move or rename updates one MAC-keyed entry", () => {
  const byMac = new Map<string, Dev>();
  mergeInto(
    byMac,
    device({
      mac: "58:e6:c5:10:5d:b8",
      name: "seeedstudio-2ch-em-4",
      addresses: ["10.10.10.145"],
      board: "esp32-c6-devkitc-1",
      esphomeVersion: "2026.4.5",
      mdnsEnabled: true,
    }),
  );
  // Same hardware, new lease, renamed hostname.
  mergeInto(
    byMac,
    device({
      mac: "58:e6:c5:10:5d:b8",
      name: "kitchen-energy",
      addresses: ["10.10.15.9"],
      sources: ["scan"],
      apiPort: 6053,
    }),
  );
  assertEquals(byMac.size, 1);
  const only = [...byMac.values()][0];
  assertEquals(only.esphomeVersion, "2026.4.5");
  assertEquals(only.board, "esp32-c6-devkitc-1");
  assertEquals(only.addresses.sort(), ["10.10.10.145", "10.10.15.9"]);
  assertEquals(only.apiPort, 6053);
});

Deno.test("a device without a MAC still keys on something stable", () => {
  const m = new Map<string, Dev>();
  mergeInto(m, device({ name: "nameless", addresses: ["10.0.0.2"] }));
  mergeInto(m, device({ name: "nameless", addresses: ["10.0.0.3"] }));
  assertEquals(m.size, 1);
});

Deno.test("a MAC-keyed record and a name-keyed twin merge into one", () => {
  const m = new Map<string, Dev>();
  // _esphomelib._tcp: carries the MAC and the facts.
  mergeInto(
    m,
    device({
      mac: "c4:4f:33:11:4a:31",
      name: "esp32-bedroom",
      friendlyName: "esp32-bedroom",
      addresses: ["10.10.3.137"],
      board: "esp32dev",
      platform: "ESP32",
      esphomeVersion: "2026.9.0",
      mdnsEnabled: true,
      apiPort: 6053,
    }),
  );
  // _http._tcp for the same box: name only, no MAC, different case.
  mergeInto(
    m,
    device({
      name: "ESP32-Bedroom",
      addresses: ["10.10.3.137"],
      sources: ["mdns-http"],
      mdnsEnabled: true,
      webServerPort: 80,
    }),
  );
  assertEquals(m.size, 1);
  const only = [...m.values()][0];
  assertEquals(only.mac, "c4:4f:33:11:4a:31");
  assertEquals(only.board, "esp32dev");
  assertEquals(only.webServerPort, 80);
});

Deno.test("compactDevices folds a duplicate that a late MAC created", () => {
  const merged = compactDevices([
    device({
      mac: "c4:4f:33:11:4a:31",
      name: "esp32-bedroom",
      board: "esp32dev",
      esphomeVersion: "2026.9.0",
      addresses: ["10.10.3.137"],
    }),
    device({ name: "esp32-bedroom", addresses: ["10.10.3.137"] }),
  ]);
  assertEquals(merged.length, 1);
  assertEquals(merged[0].board, "esp32dev");
});

Deno.test("nameless sweep devices stay separate", () => {
  // Both previously shared the key `name:` and collapsed into a single row.
  const m = new Map<string, Dev>();
  mergeInto(
    m,
    device({
      mac: "4c:11:ae:0d:d5:3a",
      addresses: ["10.10.15.147"],
      apiPort: 6053,
    }),
  );
  mergeInto(
    m,
    device({
      mac: "24:0a:c4:00:21:d4",
      addresses: ["10.10.15.148"],
      apiPort: 6053,
    }),
  );
  assertEquals(m.size, 2);
});

// ------------------------------------------------------------- mDNS parsing

Deno.test("parseEsphomeTxt keeps a friendly name containing spaces", () => {
  // The real Voice device: friendly_name itself has a space in it.
  const txt =
    "friendly_name=Voice Living Room version=2026.9.0 config_hash=b28bd23f " +
    "mac=20f83b09581f platform=ESP32 board=esp32-s3-devkitc-1 network=wifi " +
    "api_encryption=Noise_NNpsk0_25519_ChaChaPoly_SHA256";
  const out = parseEsphomeTxt(txt);
  assertEquals(out.friendly_name, "Voice Living Room");
  assertEquals(out.version, "2026.9.0");
  assertEquals(out.config_hash, "b28bd23f");
  assertEquals(out.board, "esp32-s3-devkitc-1");
  assertEquals(out.mac, "20f83b09581f");
  assertEquals(out.api_encryption, "Noise_NNpsk0_25519_ChaChaPoly_SHA256");
});

Deno.test("parseEsphomeTxt leaves absent keys absent", () => {
  const out = parseEsphomeTxt(
    "friendly_name=test version=2026.11.0 board=esp01_1m",
  );
  assertEquals(out.board, "esp01_1m");
  assertEquals(out.config_hash, undefined);
  assertEquals(out.api_encryption, undefined);
});

Deno.test("parseEsphomeTxt reads avahi's per-entry quoted TXT", () => {
  // The real avahi -p shape: each entry separately quoted. The old parser
  // assumed the flattened form, so the whole record landed in friendly_name
  // and version/board/platform/MAC all fell back to their defaults.
  const txt = '"friendly_name=esp32-bedroom" "version=2026.9.0" ' +
    '"config_hash=e40015d4" "mac=c44f33114a31" "platform=ESP32" ' +
    '"board=esp32dev" "network=wifi" ' +
    '"api_encryption=Noise_NNpsk0_25519_ChaChaPoly_SHA256"';
  const out = parseEsphomeTxt(txt);
  assertEquals(out.friendly_name, "esp32-bedroom");
  assertEquals(out.version, "2026.9.0");
  assertEquals(out.config_hash, "e40015d4");
  assertEquals(out.mac, "c44f33114a31");
  assertEquals(out.platform, "ESP32");
  assertEquals(out.board, "esp32dev");
  assertEquals(out.network, "wifi");
  assertEquals(out.api_encryption, "Noise_NNpsk0_25519_ChaChaPoly_SHA256");
  // The name must not swallow the rest of the record.
  assert(!out.friendly_name.includes('"'));
  assert(!out.friendly_name.includes("version="));
});

Deno.test("a quoted friendly name keeps its spaces", () => {
  const txt = '"friendly_name=Voice Living Room" "version=2026.9.0" ' +
    '"board=esp32-s3-devkitc-1"';
  const out = parseEsphomeTxt(txt);
  assertEquals(out.friendly_name, "Voice Living Room");
  assertEquals(out.board, "esp32-s3-devkitc-1");
});

Deno.test("parseAvahiLine keeps the quoted TXT for the parser", () => {
  const rec = parseAvahiLine(
    "=;wlp0s20f3;IPv4;esp32-bedroom;_esphomelib._tcp;local;" +
      "esp32-bedroom.local;10.10.3.137;6053;" +
      '"friendly_name=esp32-bedroom" "version=2026.9.0" "board=esp32dev";',
  );
  assert(rec !== null);
  const txt = parseEsphomeTxt(rec!.txt);
  assertEquals(txt.friendly_name, "esp32-bedroom");
  assertEquals(txt.version, "2026.9.0");
  assertEquals(txt.board, "esp32dev");
});

Deno.test("parseAvahiLine reads a resolved avahi-browse -p line", () => {
  const rec = parseAvahiLine(
    "=;wlp0s20f3;IPv4;seeedstudio-2ch-em-last;_esphomelib._tcp;local;" +
      "seeedstudio-2ch-em-last.local;10.10.3.251;6053;" +
      '"friendly_name=seeedstudio-2ch-em-last version=2026.4.5"',
  );
  assert(rec !== null);
  assertEquals(rec!.serviceName, "seeedstudio-2ch-em-last");
  assertEquals(rec!.address, "10.10.3.251");
  assertEquals(rec!.port, 6053);
  assertEquals(rec!.hostName, "seeedstudio-2ch-em-last.local");
});

Deno.test("parseAvahiLine ignores unresolved and malformed lines", () => {
  assertEquals(parseAvahiLine("+;wlp0s20f3;IPv4;name;_http._tcp;local"), null);
  assertEquals(parseAvahiLine("garbage"), null);
  assertEquals(parseAvahiLine(""), null);
});

// -------------------------------------------------------------- sweep maths

Deno.test("expandCidr enumerates usable hosts only", () => {
  const hosts = expandCidr("10.0.0.0/24");
  assertEquals(hosts.length, 254);
  assertEquals(hosts[0], "10.0.0.1");
  assertEquals(hosts[hosts.length - 1], "10.0.0.254");
  assert(!hosts.includes("10.0.0.0"));
  assert(!hosts.includes("10.0.0.255"));
});

Deno.test("expandCidr is capped so a typo cannot hang a run", () => {
  assertEquals(expandCidr("10.0.0.0/8", 100).length, 100);
  assertEquals(expandCidr("10.0.0.0/20").length, 4094);
});

Deno.test("expandCidr rejects nonsense instead of scanning everything", () => {
  assertEquals(expandCidr("not-a-cidr"), []);
  assertEquals(expandCidr("10.0.0.1"), []);
  assertEquals(expandCidr("10.0.0.0/33"), []);
});

Deno.test("ipToInt and intToIp round-trip", () => {
  assertEquals(ipToInt("10.10.3.251"), 168428539);
  assertEquals(intToIp(ipToInt("10.10.3.251")), "10.10.3.251");
  assertEquals(ipToInt("bad"), -1);
});

// ---------------------------------------------------------- SSRF/SSE parsing

Deno.test("first state event sets the catalogue, later deltas do not erase it", () => {
  const state = {
    title: "",
    entities: new Map<string, ReturnType<typeof Object>>(),
  };
  // deno-lint-ignore no-explicit-any
  const s = state as any;
  applySseEvents(s, [{
    event: "ping",
    data: JSON.stringify({ title: "test", ota: true, uptime: 11096 }),
  }]);
  assertEquals(s.title, "test");
  applySseEvents(s, [{
    event: "state",
    data: JSON.stringify({
      id: "light/NeoPixel Light",
      domain: "light",
      name: "NeoPixel Light",
      entity_category: 0,
      value: "ON",
      state: "ON",
      color_mode: "rgb",
      effects: ["None", "Color Wipe", "Scan", "Rainbow", "Fireworks"],
    }),
  }]);
  const entity = s.entities.get("light/NeoPixel Light");
  assertEquals(entity.domain, "light");
  assertEquals(entity.kind, "actuator");
  assertEquals(entity.name, "NeoPixel Light");
  assert(entity.capabilities.includes("Rainbow"));
  assert(entity.capabilities.includes("color_mode:rgb"));

  // A later delta carries only id/value/state - the catalogue must survive.
  applySseEvents(s, [{
    event: "state",
    data: JSON.stringify({
      id: "light/NeoPixel Light",
      value: "OFF",
      state: "OFF",
    }),
  }]);
  const after = s.entities.get("light/NeoPixel Light");
  assertEquals(after.state, "OFF");
  assertEquals(after.domain, "light");
  assertEquals(after.name, "NeoPixel Light");
  assertEquals(after.capabilities.length, 6);
});

Deno.test("diagnostic entities are classified apart from actuators", () => {
  // deno-lint-ignore no-explicit-any
  const s: any = { title: "", entities: new Map() };
  applySseEvents(s, [{
    event: "state",
    data: JSON.stringify({
      id: "sensor/wifi singnal strength",
      domain: "sensor",
      name: "wifi singnal strength",
      entity_category: 2,
      value: -64,
      state: "-64 dBm",
      uom: "dBm",
    }),
  }]);
  assertEquals(
    s.entities.get("sensor/wifi singnal strength").kind,
    "diagnostic",
  );
  assertEquals(s.entities.get("sensor/wifi singnal strength").uom, "dBm");
});

Deno.test("applySseEvents ignores malformed payloads", () => {
  // deno-lint-ignore no-explicit-any
  const s: any = { title: "", entities: new Map() };
  applySseEvents(s, [{ event: "state", data: "{not json" }, {
    event: "state",
    data: "",
  }]);
  assertEquals(s.entities.size, 0);
});

// ------------------------------------------------------------ report/HTML

Deno.test("summarise flags devices that hide from mDNS and cannot be read", () => {
  const summary = summarise(
    G,
    [
      device({
        mac: "4c:11:ae:0d:d5:3a",
        friendlyName: "test",
        addresses: ["10.10.15.147"],
        mdnsEnabled: false,
        board: "",
        webServerPort: 80,
        apiPort: 6053,
        interrogated: false,
      }),
      device({
        mac: "20:f8:3b:09:58:1f",
        name: "home-assistant-voice-09581f",
        addresses: ["10.10.8.53"],
        mdnsEnabled: true,
        board: "esp32-s3-devkitc-1",
        esphomeVersion: "2026.9.0",
        apiPort: 6053,
        apiEncryption: "Noise_NNpsk0",
        webServerPort: 0,
      }),
    ],
    4094,
    [],
  );

  assertEquals(summary.total, 2);
  assertEquals(summary.withoutMdns, 1);
  assertEquals(summary.withWebServer, 1);
  assertEquals(summary.versions, { unknown: 1, "2026.9.0": 1 });
  assert(
    summary.issues.some((i) => i.includes("test") && i.includes("no mDNS")),
  );
  assert(summary.issues.some((i) => i.includes("board")));
  // Encrypted API is NOT an issue; unencrypted is.
  assert(summary.issues.some((i) => i.includes("unencrypted native API")));
  assert(
    !summary.issues.some((i) =>
      i.includes("home-assistant-voice") && i.includes("unencrypted")
    ),
  );
});

Deno.test("buildHtml escapes untrusted device strings", () => {
  const html = buildHtml(
    summarise(
      G,
      [
        device({
          mac: "4c:11:ae:0d:d5:3a",
          friendlyName: "<img src=x onerror=alert(1)>",
          addresses: ["10.10.15.147"],
        }),
      ],
      0,
      [],
    ),
    "https://esphome.x1yoga.fi.gy",
  );
  assert(!html.includes("<img src=x"));
  assert(html.includes("&lt;img src=x"));
  assert(html.includes("MAC address"));
});

Deno.test("escapeHtml handles every dangerous character", () => {
  assertEquals(escapeHtml('<&>"'), "&lt;&amp;&gt;&quot;");
  assertEquals(escapeHtml(null), "");
});

Deno.test("deriveOutputFile honours an explicit file over outputDir", () => {
  assertEquals(
    deriveOutputFile(G).endsWith("/.local/share/esphome/site/index.html"),
    true,
  );
  assertEquals(
    deriveOutputFile({ ...G, outputFile: "/tmp/page.html" }),
    "/tmp/page.html",
  );
});

// ------------------------------------------------- content confirmation

Deno.test("the real ESPHome web_server shell is recognised", () => {
  // Byte-for-byte what web_server v2 returns on port 80.
  const body = "<!DOCTYPE html><html><head><meta charset=UTF-8>" +
    "<link rel=icon href=data:></head><body><esp-app></esp-app>" +
    '<script src="https://oi.esphome.io/v2/www.js"></script></body></html>';
  assert(looksLikeEsphomeWebRoot(body));
});

Deno.test("a printer or plain web server on port 80 is not ESPHome", () => {
  // Open port 80 is not evidence - this is exactly the false positive that
  // inflated the fleet to 26 devices.
  const octoprint = "<html><head><title>OctoPrint</title></head>" +
    "<body><div id=navbar></div></body></html>";
  const canon =
    "<html><title>Canon G6000 series</title><body>status</body></html>";
  assertEquals(looksLikeEsphomeWebRoot(octoprint), false);
  assertEquals(looksLikeEsphomeWebRoot(canon), false);
  assertEquals(looksLikeEsphomeWebRoot(""), false);
});

Deno.test("an ESPHome plaintext API hello is recognised", () => {
  // \x00 indicator, varint length, then a message carrying the name.
  const frame = new Uint8Array([
    0x00,
    0x0f,
    0x0a,
    0x04,
    0x74,
    0x65,
    0x73,
    0x74,
    0x10,
    0x01,
    0x18,
    0x02,
  ]);
  assert(looksLikeEsphomeApiHello(frame));
});

Deno.test("other listeners on 6053 are not mistaken for ESPHome", () => {
  // An HTTP listener answering on the port, a TLS ClientHello, and noise.
  const http = new TextEncoder().encode(
    "HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n",
  );
  const tls = new Uint8Array([0x16, 0x03, 0x01, 0x00, 0x05, 0x01, 0x00]);
  assertEquals(looksLikeEsphomeApiHello(http), false);
  assertEquals(looksLikeEsphomeApiHello(tls), false);
  assertEquals(looksLikeEsphomeApiHello(new Uint8Array([0x00])), false);
  assertEquals(looksLikeEsphomeApiHello(new Uint8Array()), false);
});

Deno.test("the page leads with a device summary table", () => {
  const html = buildHtml(
    summarise(
      G,
      [
        device({
          mac: "4c:11:ae:0d:d5:3a",
          friendlyName: "test",
          addresses: ["10.10.15.147"],
          board: "esp01_1m",
          platform: "ESP8266",
          esphomeVersion: "2026.11.0",
          configHash: "abc12345",
          webServerPort: 80,
          apiPort: 6053,
          sensorCount: 2,
          actuatorCount: 1,
        }),
      ],
      0,
      [],
    ),
  );
  for (
    const header of [
      "Device",
      "Version",
      "Board",
      "Chip",
      "MAC",
      "Config hash",
      "API crypto",
      "Sensors / Actuators",
    ]
  ) {
    assert(html.includes(`<th>${header}</th>`), `missing column: ${header}`);
  }
  assert(html.includes("esp01_1m"));
  assert(html.includes("2026.11.0"));
  assert(html.includes("4c:11:ae:0d:d5:3a"));
  assert(html.includes("abc12345"));
  assert(html.includes("2 / 1"));
  // It must lead: the table comes before the per-device detail cards.
  assert(html.indexOf("<h2>Summary</h2>") < html.indexOf("<h2>Devices</h2>"));
});

// -------------------------------------------------------------- caddy facts

Deno.test("parseCaddyModelFacts reads domain and picks the host record", () => {
  const facts = parseCaddyModelFacts("my-caddy", {
    globalArguments: {
      baseDomain: "x1yoga.fi.gy",
      serviceName: "caddy",
      dnsRecords: [
        { name: "x1yoga.fi.gy", type: "A", value: ["10.10.13.208"] },
      ],
    },
  }, "x1yoga");
  assertEquals(facts.baseDomain, "x1yoga.fi.gy");
  assertEquals(facts.hostFqdn, "x1yoga.fi.gy");
  assertEquals(facts.serviceName, "caddy");
});

Deno.test("caddyModelNames selects only caddy models", () => {
  const names = caddyModelNames(JSON.stringify({
    results: [
      { name: "my-caddy", type: "@svendowideit/caddy" },
      { name: "status-caddy", type: "@svendowideit/caddy" },
      { name: "fleet", type: "@svendowideit/fleet-inventory" },
    ],
  }));
  assertEquals(names, ["my-caddy", "status-caddy"]);
  assertEquals(caddyModelNames("not json"), []);
});

Deno.test("pickSourceCaddy prefers the model owning this machine", () => {
  const a = parseCaddyModelFacts("my-caddy", {
    globalArguments: {
      baseDomain: "x1yoga.fi.gy",
      dnsRecords: [{
        name: "x1yoga.fi.gy",
        type: "A",
        value: ["10.10.13.208"],
      }],
    },
  }, "x1yoga");
  const b = parseCaddyModelFacts("other-caddy", {
    globalArguments: {
      baseDomain: "example.test",
      dnsRecords: [{
        name: "other.example.test",
        type: "A",
        value: ["10.9.9.9"],
      }],
    },
  }, "x1yoga");
  assertEquals(pickSourceCaddy([a, b], "x1yoga"), a);
  assertEquals(pickSourceCaddy([b], "x1yoga"), b);
  assertEquals(pickSourceCaddy([], "x1yoga"), null);
});
