/**
 * Tests for the pure parsers and assembly in `gpu_facts_shared.ts` — the part
 * that must be right on every platform. No host access: the vendor output is
 * supplied as literal strings.
 *
 * @module
 */
import { assertEquals } from "jsr:@std/assert@1";
import {
  buildGpuFacts,
  chooseRuntime,
  detectVendorFromName,
  type GpuDevice,
  parseMeminfoTotal,
  parseNvidiaSmi,
  parseRocmSmi,
  parseSystemProfiler,
  parseVramString,
  primaryVendor,
  selectDevices,
  toInt,
} from "./gpu_facts_shared.ts";

Deno.test("toInt parses integers, defaulting to 0", () => {
  assertEquals(toInt("24564"), 24564);
  assertEquals(toInt(" 16 "), 16);
  assertEquals(toInt("N/A"), 0);
  assertEquals(toInt(undefined), 0);
});

Deno.test("detectVendorFromName recognises the common vendor names", () => {
  assertEquals(detectVendorFromName("NVIDIA GeForce RTX 4090"), "nvidia");
  assertEquals(detectVendorFromName("Tesla T4"), "nvidia");
  assertEquals(detectVendorFromName("AMD Radeon RX 7900 XTX"), "amd");
  assertEquals(detectVendorFromName("Apple M2 Pro"), "apple");
  assertEquals(detectVendorFromName("Mystery"), "unknown");
});

Deno.test("parseNvidiaSmi reads CSV, tolerating commas in the name", () => {
  const csv = [
    "0, NVIDIA GeForce RTX 4090, 24564, 550.54.14, 8.9",
    "1, NVIDIA RTX A6000, Ada, 49140, 550.54.14, 8.6",
  ].join("\n");
  const d = parseNvidiaSmi(csv);
  assertEquals(d.length, 2);
  assertEquals(d[0], {
    index: 0,
    vendor: "nvidia",
    name: "NVIDIA GeForce RTX 4090",
    vramMiB: 24564,
    driver: "550.54.14",
    computeCapability: "8.9",
  });
  // A comma inside the name is joined back.
  assertEquals(d[1].name, "NVIDIA RTX A6000, Ada");
  assertEquals(d[1].vramMiB, 49140);
});

Deno.test("parseNvidiaSmi treats N/A compute capability as empty", () => {
  const d = parseNvidiaSmi("0, Tesla T4, 15360, 535.104.05, N/A");
  assertEquals(d[0].computeCapability, "");
});

Deno.test("parseRocmSmi reads per-card VRAM bytes into MiB", () => {
  const mem = JSON.stringify({
    card0: { "VRAM Total Memory (B)": "17163091968" },
  });
  const names = JSON.stringify({
    card0: { "Card series": "Radeon RX 7900 XTX" },
  });
  const d = parseRocmSmi(mem, names);
  assertEquals(d.length, 1);
  assertEquals(d[0].vendor, "amd");
  assertEquals(d[0].name, "Radeon RX 7900 XTX");
  assertEquals(d[0].vramMiB, 16368);
});

Deno.test("parseRocmSmi tolerates unusable input", () => {
  assertEquals(parseRocmSmi("not json"), []);
});

Deno.test("parseSystemProfiler reads Apple GPUs; unified memory gives 0", () => {
  const json = JSON.stringify({
    SPDisplaysDataType: [
      { sppci_model: "Apple M2 Pro" },
      { sppci_model: "Radeon Pro 5500M", spdisplays_vram: "8 GB" },
    ],
  });
  const d = parseSystemProfiler(json);
  assertEquals(d.length, 2);
  assertEquals(d[0], {
    index: 0,
    vendor: "apple",
    name: "Apple M2 Pro",
    vramMiB: 0,
    driver: "",
    computeCapability: "",
  });
  assertEquals(d[1].vramMiB, 8192);
});

Deno.test("parseVramString converts GB/MB/TB to MiB", () => {
  assertEquals(parseVramString("16 GB"), 16384);
  assertEquals(parseVramString("512 MB"), 512);
  assertEquals(parseVramString("2 TB"), 2097152);
  assertEquals(parseVramString("unknown"), 0);
});

Deno.test("parseMeminfoTotal reads MemTotal in MiB", () => {
  assertEquals(parseMeminfoTotal("MemTotal:       65761232 kB\n"), 64220);
  assertEquals(parseMeminfoTotal("no meminfo"), 0);
});

Deno.test("chooseRuntime and primaryVendor reflect the first devices", () => {
  const nvidia: GpuDevice[] = [{
    index: 0,
    vendor: "nvidia",
    name: "RTX 4090",
    vramMiB: 24564,
    driver: "",
    computeCapability: "",
  }];
  assertEquals(chooseRuntime(nvidia), "cuda");
  assertEquals(primaryVendor(nvidia), "nvidia");
  assertEquals(chooseRuntime([{ ...nvidia[0], vendor: "amd" }]), "rocm");
  assertEquals(chooseRuntime([{ ...nvidia[0], vendor: "apple" }]), "metal");
  assertEquals(chooseRuntime([]), "none");
  assertEquals(primaryVendor([]), "unknown");
});

Deno.test("buildGpuFacts sums VRAM and carries RAM/CPU", () => {
  const devices: GpuDevice[] = [
    {
      index: 0,
      vendor: "nvidia",
      name: "RTX 4090",
      vramMiB: 24564,
      driver: "550",
      computeCapability: "8.9",
    },
    {
      index: 1,
      vendor: "nvidia",
      name: "RTX 4090",
      vramMiB: 24564,
      driver: "550",
      computeCapability: "8.9",
    },
  ];
  const facts = buildGpuFacts(devices, {
    ramMiB: 128000,
    cpuCores: 32,
    now: "2026-10-16T00:00:00Z",
  });
  assertEquals(facts.totalVramMiB, 49128);
  assertEquals(facts.ramMiB, 128000);
  assertEquals(facts.cpuCores, 32);
  assertEquals(facts.runtime, "cuda");
  assertEquals(facts.detectedAt, "2026-10-16T00:00:00Z");
});

Deno.test("selectDevices keeps one index or all", () => {
  const devices: GpuDevice[] = [
    {
      index: 0,
      vendor: "nvidia",
      name: "a",
      vramMiB: 1,
      driver: "",
      computeCapability: "",
    },
    {
      index: 1,
      vendor: "nvidia",
      name: "b",
      vramMiB: 2,
      driver: "",
      computeCapability: "",
    },
  ];
  assertEquals(selectDevices(devices, -1).length, 2);
  assertEquals(selectDevices(devices, 1).map((d) => d.name), ["b"]);
});
