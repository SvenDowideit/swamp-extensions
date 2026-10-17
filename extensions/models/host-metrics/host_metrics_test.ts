/**
 * Tests for `@svendowideit/host-metrics`: the /proc/net/dev parser, the delta
 * arithmetic, the filesystems reduction, endpoint selection and the OTLP
 * payload builders. All pure, so they run anywhere without touching a host.
 *
 * @module
 */
import { assertEquals } from "jsr:@std/assert@1";
import {
  buildNetwork,
  buildOtlpLogs,
  buildOtlpMetrics,
  type ContractEndpoint,
  type HostSample,
  model,
  parseNetDev,
  pickEndpoint,
  reduceFilesystems,
  sumNonLoopback,
} from "./host_metrics.ts";

const NET_DEV =
  `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 1000 10 0 0 0 0 0 0 1000 10 0 0 0 0 0 0
  eth0: 5000 50 0 0 0 0 0 0 3000 30 0 0 0 0 0 0
 wlan0: 2000 20 0 0 0 0 0 0 1500 15 0 0 0 0 0 0
`;

const SAMPLE: HostSample = {
  filesystems: {
    rootTotalBytes: 100,
    rootUsedBytes: 40,
    rootAvailBytes: 60,
    rootUsedPercent: 40,
    worstUsedPercent: 55,
    capturedAt: "2026-10-17T00:00:00.000Z",
  },
  load: { load1: 0.1, load5: 0.2, load15: 0.3, cores: 4, load5PerCore: 0.05 },
  memory: { totalBytes: 1000, availableBytes: 400, usedPercent: 60 },
  thermal: { maxCelsius: 55 },
  network: {
    totalRxBytes: 7000,
    totalTxBytes: 4500,
    totalRxBytesDelta: 1000,
    totalTxBytesDelta: 500,
    interfaces: [
      {
        name: "eth0",
        rxBytes: 5000,
        txBytes: 3000,
        rxBytesDelta: 1000,
        txBytesDelta: 500,
      },
    ],
  },
};

Deno.test("parseNetDev reads per-interface rx/tx bytes", () => {
  const got = parseNetDev(NET_DEV);
  assertEquals(got.length, 3);
  assertEquals(got[1], { name: "eth0", rxBytes: 5000, txBytes: 3000 });
  assertEquals(got[2], { name: "wlan0", rxBytes: 2000, txBytes: 1500 });
});

Deno.test("sumNonLoopback excludes loopback", () => {
  const ifaces = parseNetDev(NET_DEV);
  assertEquals(sumNonLoopback(ifaces, (i) => i.rxBytes), 7000);
  assertEquals(sumNonLoopback(ifaces, (i) => i.txBytes), 4500);
});

Deno.test("buildNetwork computes per-interface and total deltas", () => {
  const current = parseNetDev(NET_DEV);
  const previous = [
    { name: "lo", rxBytes: 900, txBytes: 900 },
    { name: "eth0", rxBytes: 4000, txBytes: 2500 },
    { name: "wlan0", rxBytes: 2000, txBytes: 1500 },
  ];
  const net = buildNetwork("miix", current, previous, "t");
  assertEquals(net.host, "miix");
  const eth0 = net.interfaces.find((i) => i.name === "eth0");
  assertEquals(eth0?.rxBytesDelta, 1000);
  assertEquals(eth0?.txBytesDelta, 500);
  const wlan0 = net.interfaces.find((i) => i.name === "wlan0");
  assertEquals(wlan0?.rxBytesDelta, 0);
  assertEquals(net.totalRxBytes, 7000);
  assertEquals(net.totalTxBytes, 4500);
  assertEquals(net.totalRxBytesDelta, 1000);
  assertEquals(net.totalTxBytesDelta, 500);
});

Deno.test("buildNetwork treats a counter reset as a zero delta", () => {
  const current = [{ name: "eth0", rxBytes: 100, txBytes: 100 }];
  const previous = [{ name: "eth0", rxBytes: 999, txBytes: 999 }];
  const net = buildNetwork("h", current, previous, "t");
  assertEquals(net.interfaces[0].rxBytesDelta, 0);
  assertEquals(net.interfaces[0].txBytesDelta, 0);
});

Deno.test("buildNetwork has zero deltas with no previous reading", () => {
  const net = buildNetwork("h", parseNetDev(NET_DEV), [], "t");
  assertEquals(net.totalRxBytesDelta, 0);
  assertEquals(net.totalTxBytesDelta, 0);
});

Deno.test("reduceFilesystems finds the / mount and hoists percents", () => {
  const view = reduceFilesystems({
    mounts: [
      { mountpoint: "/boot", totalBytes: 10, usedBytes: 5, availBytes: 5 },
      { mountpoint: "/", totalBytes: 100, usedBytes: 40, availBytes: 60 },
    ],
    rootUsedPercent: 40,
    worstUsedPercent: 55,
    capturedAt: "t",
  });
  assertEquals(view.rootAvailBytes, 60);
  assertEquals(view.rootUsedBytes, 40);
  assertEquals(view.rootUsedPercent, 40);
  assertEquals(view.worstUsedPercent, 55);
});

Deno.test("reduceFilesystems tolerates a missing / mount", () => {
  const view = reduceFilesystems({ mounts: [] });
  assertEquals(view.rootAvailBytes, null);
  assertEquals(view.rootUsedPercent, null);
});

Deno.test("pickEndpoint prefers an explicit override", () => {
  const endpoints: ContractEndpoint[] = [
    { mesh: "tailscale", otlp_http_url: "https://otlp.fi.gy" },
  ];
  assertEquals(
    pickEndpoint(endpoints, { override: "http://127.0.0.1:4318/" }).base,
    "http://127.0.0.1:4318",
  );
});

Deno.test("pickEndpoint selects the named mesh, else the first", () => {
  const endpoints: ContractEndpoint[] = [
    { mesh: "wireguard", otlp_http_url: "https://wg.fi.gy" },
    { mesh: "tailscale", otlp_http_url: "https://otlp.fi.gy" },
  ];
  assertEquals(
    pickEndpoint(endpoints, { mesh: "tailscale" }).base,
    "https://otlp.fi.gy",
  );
  assertEquals(pickEndpoint(endpoints, {}).base, "https://wg.fi.gy");
  assertEquals(pickEndpoint([], {}).base, "");
});

Deno.test("buildOtlpMetrics carries host identity and the key gauges", () => {
  const payload = buildOtlpMetrics(
    "miix",
    SAMPLE,
    { site: "home" },
    "2026-10-17T00:00:00.000Z",
    -10,
  ) as {
    resourceMetrics: Array<{
      resource: {
        attributes: Array<{ key: string; value: { stringValue: string } }>;
      };
      scopeMetrics: Array<{ metrics: Array<{ name: string }> }>;
    }>;
  };
  const resource = payload.resourceMetrics[0].resource.attributes;
  const byKey = new Map(resource.map((a) => [a.key, a.value.stringValue]));
  assertEquals(byKey.get("host.name"), "miix");
  assertEquals(byKey.get("service.name"), "host-metrics");
  assertEquals(byKey.get("site"), "home");
  const names = payload.resourceMetrics[0].scopeMetrics[0].metrics.map(
    (m) => m.name,
  );
  for (
    const expected of [
      "host.filesystem.avail_bytes",
      "host.filesystem.avail_change_bytes",
      "host.filesystem.used_percent",
      "host.load.5m",
      "host.memory.used_percent",
      "host.network.rx_bytes_total",
      "host.network.rx_bytes_interval",
      "host.thermal.max_celsius",
    ]
  ) {
    assertEquals(names.includes(expected), true, `missing ${expected}`);
  }
});

Deno.test("buildOtlpLogs summarises free space and its change", () => {
  const payload = buildOtlpLogs(
    "miix",
    SAMPLE,
    {},
    "2026-10-17T00:00:00.000Z",
    -10,
  ) as {
    resourceLogs: Array<{
      scopeLogs: Array<
        { logRecords: Array<{ body: { stringValue: string } }> }
      >;
    }>;
  };
  const body =
    payload.resourceLogs[0].scopeLogs[0].logRecords[0].body.stringValue;
  assertEquals(body.includes("miix"), true);
  assertEquals(body.includes("60 bytes free"), true);
  assertEquals(body.includes("Δ-10"), true);
});

Deno.test("model is a standalone host-metrics type with the fleet methods", () => {
  assertEquals(model.type, "@svendowideit/host-metrics");
  assertEquals(Object.keys(model.resources).sort(), [
    "emit",
    "network",
    "workers",
  ]);
  const methodNames = Object.keys(model.methods).sort();
  assertEquals(methodNames, ["emit", "listWorkers", "readNetwork"]);
});
