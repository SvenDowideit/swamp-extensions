import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";

import {
  advertisementUnitName,
  classifyService,
  expandHome,
  listAdvertiseUnits,
  model,
  parseAvahiBrowse,
  parseTxt,
  renderAdvertiseArgs,
  renderAdvertiseUnit,
  renderBrowseArgs,
  shellQuote,
  unescapeAvahi,
  validateAdvertise,
} from "./mdns.ts";

Deno.test("classifyService maps known service types and TXT hints", () => {
  assertEquals(classifyService("_esphomelib._tcp", {}), {
    deviceClass: "esphome",
    vendor: "Espressif",
  });
  assertEquals(classifyService("_shelly._tcp", {}).deviceClass, "shelly");
  assertEquals(
    classifyService("_ihsp._tcp", { type: "DIRIGERA" }).deviceClass,
    "ikea-dirigera",
  );
  // Unknown type but ESPHome-style TXT -> esphome.
  assertEquals(
    classifyService("_unknown._tcp", { platform: "ESP32" }).deviceClass,
    "esphome",
  );
  assertEquals(classifyService("_nothing._tcp", {}), {
    deviceClass: "",
    vendor: "",
  });
  // Caller override wins.
  assertEquals(
    classifyService("_mykvm._tcp", {}, {
      "_mykvm._tcp": { deviceClass: "kvm", vendor: "GL.iNet" },
    }).deviceClass,
    "kvm",
  );
});

Deno.test("advertisementUnitName is unique per instance", () => {
  assertEquals(
    advertisementUnitName("mdns", "otel-gateway"),
    "mdns-otel-gateway",
  );
  assertEquals(
    advertisementUnitName("otel-mdns", "gw grpc"),
    "otel-mdns-gw-grpc",
  );
});

Deno.test("listAdvertiseUnits finds only this model's units", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${tmp}/mdns-a.service`, "x");
    await Deno.writeTextFile(`${tmp}/mdns-b.service`, "x");
    await Deno.writeTextFile(`${tmp}/other-c.service`, "x"); // different prefix
    await Deno.writeTextFile(`${tmp}/mdns-d.txt`, "x"); // not a unit
    const units = await listAdvertiseUnits(tmp, "mdns");
    assertEquals(units.map((u) => u.instance), ["a", "b"]);
    assertEquals(units[0].unitName, "mdns-a");
    assertEquals(await listAdvertiseUnits(`${tmp}/nope`, "mdns"), []);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("expandHome resolves ~ against HOME", () => {
  assertEquals(expandHome("~/x", "/home/u"), "/home/u/x");
  assertEquals(expandHome("/abs", "/home/u"), "/abs");
});

Deno.test("renderAdvertiseArgs renders name/type/port and TXT", () => {
  const args = renderAdvertiseArgs({
    serviceName: "otel-gateway",
    serviceType: "_otlp-http._tcp",
    port: 4318,
    hostName: "otel.local",
    txt: { path: "/v1", env: "dev" },
  });
  assertEquals(args, [
    "-H",
    "otel.local",
    "otel-gateway",
    "_otlp-http._tcp",
    "4318",
    "path=/v1",
    "env=dev",
  ]);
});

Deno.test("shellQuote quotes only when needed", () => {
  assertEquals(shellQuote("simple-1"), "simple-1");
  assertEquals(shellQuote("has space"), '"has space"');
});

Deno.test("renderAdvertiseUnit produces a valid systemd unit", () => {
  const unit = renderAdvertiseUnit({
    serviceName: "otel-gateway",
    serviceType: "_otlp-http._tcp",
    port: 4318,
    hostName: "otel.local",
    txt: { path: "/v1" },
  });
  assertStringIncludes(unit, "[Service]");
  assertStringIncludes(unit, "ExecStart=avahi-publish-service");
  assertStringIncludes(unit, "otel-gateway _otlp-http._tcp 4318");
  assertStringIncludes(unit, "WantedBy=default.target");
});

Deno.test("renderBrowseArgs uses parseable recursive output", () => {
  assertEquals(renderBrowseArgs("_otlp-http._tcp"), [
    "-ptr",
    "_otlp-http._tcp",
  ]);
});

Deno.test("unescapeAvahi decodes decimal escapes", () => {
  assertEquals(unescapeAvahi("hello\\032world"), "hello world");
});

Deno.test("parseTxt parses key=value pairs", () => {
  assertEquals(parseTxt('"path=/v1" "env=dev"'), { path: "/v1", env: "dev" });
  assertEquals(parseTxt(""), {});
});

Deno.test("parseAvahiBrowse parses resolved records", () => {
  const out = [
    "+;eth0;IPv4;otel-gateway;_otlp-http._tcp;local",
    '=;eth0;IPv4;otel-gateway;_otlp-http._tcp;local;core.otel.fi.gy;192.0.2.10;4318;"path=/v1"',
    "=;eth0;IPv4;other;_otel._tcp;local;other.local;192.0.2.11;4317;",
  ].join("\n");
  const services = parseAvahiBrowse(out);
  assertEquals(services.length, 2);
  assertEquals(services[0].serviceName, "otel-gateway");
  assertEquals(services[0].hostName, "core.otel.fi.gy");
  assertEquals(services[0].address, "192.0.2.10");
  assertEquals(services[0].port, 4318);
  assertEquals(services[0].txt, { path: "/v1" });
  assertEquals(services[1].port, 4317);
});

Deno.test("validateAdvertise rejects bad input", () => {
  assertEquals(
    validateAdvertise({
      serviceName: "g",
      serviceType: "_otlp-http._tcp",
      port: 4318,
    }),
    [],
  );
  const bad = validateAdvertise({
    serviceName: "",
    serviceType: "otlp",
    port: 0,
  });
  assertEquals(bad.length, 3);
});

Deno.test("advertise writes one unit per instance and a resource", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const captured: Array<Record<string, unknown>> = [];
    const ctx = {
      globalArgs: {
        serviceName: "mdns",
        serviceType: "_otlp-http._tcp",
        hostName: "",
        unitDir: tmp,
        advertiseArgs: [],
        deviceClasses: {},
      },
      writeResource: (
        _spec: string,
        _name: string,
        data: Record<string, unknown>,
      ) => {
        captured.push(data);
        return Promise.resolve({ name: "advertise" });
      },
    };
    await model.methods.advertise.execute(
      {
        instance: "otel-http",
        serviceType: "_otlp-http._tcp",
        port: 4318,
        hostName: "",
        txt: { path: "/v1" },
      },
      ctx,
    );
    await model.methods.advertise.execute(
      {
        instance: "otel-grpc",
        serviceType: "_otel._tcp",
        port: 4317,
        hostName: "",
        txt: {},
      },
      ctx,
    );
    assertEquals(captured[0].unitName, "mdns-otel-http");
    assertEquals(captured[1].unitName, "mdns-otel-grpc");
    // A custom unitDir is staged only (not systemd's), so nothing is started.
    assertEquals(captured[0].started, false);
    assertStringIncludes(
      String(captured[0].detail),
      "not systemd's user unit dir",
    );
    const httpUnit = await Deno.readTextFile(`${tmp}/mdns-otel-http.service`);
    const grpcUnit = await Deno.readTextFile(`${tmp}/mdns-otel-grpc.service`);
    assertStringIncludes(httpUnit, "otel-http _otlp-http._tcp 4318");
    assertStringIncludes(grpcUnit, "otel-grpc _otel._tcp 4317");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("advertise throws on invalid input", async () => {
  const ctx = {
    globalArgs: {
      serviceName: "mdns",
      serviceType: "_otlp-http._tcp",
      hostName: "",
      unitDir: "/tmp",
      advertiseArgs: [],
      deviceClasses: {},
    },
    writeResource: () => Promise.resolve({ name: "x" }),
  };
  let threw = false;
  try {
    await model.methods.advertise.execute(
      { instance: "", serviceType: "bad", port: 0, hostName: "", txt: {} },
      ctx,
    );
  } catch {
    threw = true;
  }
  assert(threw);
});

Deno.test("remove deletes one instance's unit, leaving the others", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    let captured: Record<string, unknown> = {};
    const ctx = {
      globalArgs: {
        serviceName: "mdns",
        serviceType: "_otlp-http._tcp",
        hostName: "",
        unitDir: tmp,
        advertiseArgs: [],
        deviceClasses: {},
      },
      writeResource: (
        _spec: string,
        _name: string,
        data: Record<string, unknown>,
      ) => {
        captured = data;
        return Promise.resolve({ name: "status" });
      },
    };
    await Deno.writeTextFile(`${tmp}/mdns-a.service`, "# a\n");
    await Deno.writeTextFile(`${tmp}/mdns-b.service`, "# b\n");
    await model.methods.remove.execute({ instance: "a" }, ctx);
    let aGone = false;
    try {
      await Deno.stat(`${tmp}/mdns-a.service`);
    } catch {
      aGone = true;
    }
    assert(aGone, "mdns-a should be removed");
    await Deno.stat(`${tmp}/mdns-b.service`); // must not throw
    // deno-lint-ignore no-explicit-any
    assertEquals((captured.advertisements as any[]).map((x) => x.instance), [
      "b",
    ]);

    await model.methods.remove.execute({ instance: "" }, ctx);
    // deno-lint-ignore no-explicit-any
    assertEquals((captured.advertisements as any[]).length, 0);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("status lists each advertisement with its active state", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    let captured: Record<string, unknown> = {};
    const ctx = {
      globalArgs: {
        serviceName: "mdns",
        serviceType: "_otlp-http._tcp",
        hostName: "",
        unitDir: tmp,
        advertiseArgs: [],
        deviceClasses: {},
      },
      writeResource: (
        _spec: string,
        _name: string,
        data: Record<string, unknown>,
      ) => {
        captured = data;
        return Promise.resolve({ name: "status" });
      },
    };
    await Deno.writeTextFile(`${tmp}/mdns-a.service`, "# a\n");
    await model.methods.status.execute({}, ctx);
    // deno-lint-ignore no-explicit-any
    const ads = captured.advertisements as any[];
    assertEquals(ads.length, 1);
    assertEquals(ads[0].instance, "a");
    assertEquals(captured.serviceNamePrefix, "mdns");
    assertEquals(typeof captured.avahiAvailable, "boolean");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});
