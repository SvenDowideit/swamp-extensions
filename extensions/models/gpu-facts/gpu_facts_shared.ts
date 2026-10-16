/**
 * Pure parsing + assembly helpers for the `@svendowideit/gpu-facts` model.
 *
 * Everything here is side-effect free: it takes command/JSON text and returns
 * typed structures, so the vendor-specific parsing (NVIDIA `nvidia-smi`, AMD
 * `rocm-smi`, Apple `system_profiler`) is fully unit-testable without a GPU.
 *
 * @module
 */

/** The vendor of a detected accelerator. */
export type GpuVendor = "nvidia" | "amd" | "apple" | "unknown";

/** The compute runtime a host can use for local inference. */
export type GpuRuntime = "cuda" | "rocm" | "metal" | "none";

/** One detected accelerator device. */
export interface GpuDevice {
  /** Zero-based index of the device within the host. */
  index: number;
  /** Detected vendor. */
  vendor: GpuVendor;
  /** Human-readable device name (e.g. `NVIDIA GeForce RTX 4090`). */
  name: string;
  /** Dedicated VRAM in MiB; 0 when unknown or unified (Apple Silicon). */
  vramMiB: number;
  /** Driver version string, or "". */
  driver: string;
  /** Compute capability (NVIDIA) or gfx arch (AMD), or "". */
  computeCapability: string;
}

/** The assembled accelerator facts for a host. */
export type GpuFacts = {
  /** Every detected device, in index order. */
  devices: GpuDevice[];
  /** Sum of `devices[].vramMiB`. */
  totalVramMiB: number;
  /** System RAM in MiB, or 0 when unknown. */
  ramMiB: number;
  /** Usable CPU cores, or 0 when unknown. */
  cpuCores: number;
  /** The runtime implied by the devices. */
  runtime: GpuRuntime;
  /** The primary vendor (first device), or `unknown` when none. */
  vendor: GpuVendor;
  /** When the facts were assembled (ISO 8601). */
  detectedAt: string;
};

/** Options for {@link buildGpuFacts}. */
export interface BuildGpuOptions {
  /** System RAM in MiB. */
  ramMiB?: number;
  /** Usable CPU cores. */
  cpuCores?: number;
  /** When the facts were read (ISO 8601); defaults to now. */
  now?: string;
}

/** Parse an integer, returning 0 for anything unparseable. */
export function toInt(value: string | undefined | null): number {
  if (value === undefined || value === null) return 0;
  const n = Number.parseInt(String(value).trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

/** Best-effort vendor from a device name. */
export function detectVendorFromName(name: string): GpuVendor {
  const n = name.toLowerCase();
  if (
    n.includes("nvidia") || n.includes("geforce") || n.includes("quadro") ||
    n.includes("tesla") || n.includes("rtx") || n.includes("gtx")
  ) return "nvidia";
  if (n.includes("amd") || n.includes("radeon") || n.includes("instinct")) {
    return "amd";
  }
  if (n.includes("apple")) return "apple";
  return "unknown";
}

/** JSON.parse into a record, or `null` on any failure. */
function tryJsonObject(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/** Narrow an unknown value to a plain record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse a human VRAM string like `16 GB` / `512 MB` into MiB (0 if unparseable). */
export function parseVramString(text: string): number {
  const m = text.match(/(\d+(?:\.\d+)?)\s*(GB|MB|TB)/i);
  if (!m) return 0;
  const n = Number.parseFloat(m[1]);
  const unit = m[2].toUpperCase();
  if (!Number.isFinite(n)) return 0;
  if (unit === "TB") return Math.round(n * 1024 * 1024);
  if (unit === "GB") return Math.round(n * 1024);
  return Math.round(n);
}

/**
 * Parse `nvidia-smi --query-gpu=index,name,memory.total,driver_version,compute_cap
 * --format=csv,noheader,nounits` output into devices.
 *
 * The device name is allowed to contain commas: the first field is the index,
 * the last three are memory/driver/compute, and everything between is the name.
 */
export function parseNvidiaSmi(csv: string): GpuDevice[] {
  const out: GpuDevice[] = [];
  for (const rawLine of csv.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split(",").map((p) => p.trim());
    if (parts.length < 5) continue;
    const cc = parts[parts.length - 1];
    out.push({
      index: toInt(parts[0]),
      vendor: "nvidia",
      name: parts.slice(1, parts.length - 3).join(", ").trim(),
      vramMiB: toInt(parts[parts.length - 3]),
      driver: parts[parts.length - 2],
      computeCapability: /^n\/?a$/i.test(cc) ? "" : cc,
    });
  }
  return out;
}

/**
 * Parse `rocm-smi --showmeminfo vram --json` (and optionally
 * `--showproductname --json`) into devices. Tolerant of rocm-smi's per-card
 * key naming; unparseable cards are skipped.
 */
export function parseRocmSmi(memJson: string, nameJson = ""): GpuDevice[] {
  const mem = tryJsonObject(memJson);
  if (!mem) return [];
  const names = tryJsonObject(nameJson);
  const out: GpuDevice[] = [];
  const keys = Object.keys(mem).filter((k) => /^card\d+$/i.test(k)).sort();
  let index = 0;
  for (const key of keys) {
    const entry = mem[key];
    if (!isRecord(entry)) continue;
    const bytes = toInt(String(entry["VRAM Total Memory (B)"] ?? "0"));
    const nameEntry = names && isRecord(names[key]) ? names[key] : null;
    const name = nameEntry
      ? String(
        nameEntry["Card series"] ?? nameEntry["Card model"] ??
          nameEntry["Card SKU"] ?? "AMD GPU",
      )
      : "AMD GPU";
    out.push({
      index: index++,
      vendor: "amd",
      name,
      vramMiB: bytes > 0 ? Math.round(bytes / 1048576) : 0,
      driver: "",
      computeCapability: "",
    });
  }
  return out;
}

/**
 * Parse `system_profiler SPDisplaysDataType -json` output into devices. Apple
 * Silicon reports unified memory, so `vramMiB` is 0 unless a dedicated
 * `spdisplays_vram` value is present.
 */
export function parseSystemProfiler(json: string): GpuDevice[] {
  const root = tryJsonObject(json);
  const arr = root?.["SPDisplaysDataType"];
  if (!Array.isArray(arr)) return [];
  const out: GpuDevice[] = [];
  let index = 0;
  for (const item of arr) {
    if (!isRecord(item)) continue;
    const name = String(item["sppci_model"] ?? item["_name"] ?? "Apple GPU");
    out.push({
      index: index++,
      vendor: "apple",
      name,
      vramMiB: parseVramString(String(item["spdisplays_vram"] ?? "")),
      driver: "",
      computeCapability: "",
    });
  }
  return out;
}

/** The runtime implied by the devices (first match wins). */
export function chooseRuntime(devices: GpuDevice[]): GpuRuntime {
  if (devices.some((d) => d.vendor === "nvidia")) return "cuda";
  if (devices.some((d) => d.vendor === "amd")) return "rocm";
  if (devices.some((d) => d.vendor === "apple")) return "metal";
  return "none";
}

/** The primary vendor: the first device's vendor, else `unknown`. */
export function primaryVendor(devices: GpuDevice[]): GpuVendor {
  return devices[0]?.vendor ?? "unknown";
}

/** Parse the `MemTotal:` line of `/proc/meminfo` into MiB (0 if absent). */
export function parseMeminfoTotal(text: string): number {
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^MemTotal:\s+(\d+)\s*kB/i);
    if (m) return Math.round(toInt(m[1]) / 1024);
  }
  return 0;
}

/** Keep only the selected device index, or all when `index` is negative. */
export function selectDevices(
  devices: GpuDevice[],
  index: number,
): GpuDevice[] {
  if (index < 0) return devices;
  return devices.filter((d) => d.index === index);
}

/**
 * Assemble the accelerator facts from detected devices and host resources.
 * Pure, so the field mapping is unit-testable without a GPU.
 */
export function buildGpuFacts(
  devices: GpuDevice[],
  opts: BuildGpuOptions = {},
): GpuFacts {
  const totalVramMiB = devices.reduce((sum, d) => sum + (d.vramMiB || 0), 0);
  return {
    devices,
    totalVramMiB,
    ramMiB: opts.ramMiB ?? 0,
    cpuCores: opts.cpuCores ?? 0,
    runtime: chooseRuntime(devices),
    vendor: primaryVendor(devices),
    detectedAt: opts.now ?? new Date().toISOString(),
  };
}
