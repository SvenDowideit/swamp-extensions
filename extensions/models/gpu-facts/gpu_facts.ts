/**
 * @svendowideit/gpu-facts
 *
 * This host's accelerators, as one `gpu` resource: every detected device
 * (vendor, name, VRAM, driver, compute capability), the total VRAM, the system
 * RAM and usable CPU cores, and the compute runtime (CUDA / ROCm / Metal /
 * none). Read straight off the machine with no network and no SSH.
 *
 * It is the hardware-budget half of "can this model run here?": a consumer
 * (e.g. an Ollama Modelfile renderer or a Hugging Face recommender) reads
 * `totalVramMiB`, `ramMiB` and `cpuCores` to choose a quantisation and set
 * `num_gpu` / `num_ctx`, instead of guessing. Field vocabulary aligns with
 * {@link @svendowideit/host-facts} and `@svendowideit/fleet-inventory` where
 * they overlap (`os`/`arch` live in host-facts; this carries the accelerator
 * and resource-budget fields host-facts has no equivalent of).
 *
 * Methods:
 *   - `collect`  detect the host's accelerators and write the `gpu` resource
 *   - `status`   report whether a `gpu` resource exists (no re-read)
 *
 * @module
 */

import { z } from "npm:zod@4";
import {
  buildGpuFacts,
  type GpuDevice,
  parseMeminfoTotal,
  parseNvidiaSmi,
  parseRocmSmi,
  parseSystemProfiler,
  selectDevices,
  toInt,
} from "./gpu_facts_shared.ts";

/** The model type name. */
export const GPU_FACTS_TYPE = "@svendowideit/gpu-facts";

// ---------------------------------------------------------------------------
// Global arguments
// ---------------------------------------------------------------------------

const GlobalArgsSchema = z.object({
  name: z.string().default("").describe(
    "Model instance name (supplied by swamp; used by status to read its record).",
  ),
  vendorOverride: z.enum(["auto", "nvidia", "amd", "apple", "none"]).default(
    "auto",
  ).describe(
    "Which probe to run. `auto` tries NVIDIA, then AMD, then Apple. `none` " +
      "records only RAM/CPU (a host with no GPU).",
  ),
  deviceIndex: z.number().int().default(-1).describe(
    "Keep only this device index (0-based). Negative keeps every device.",
  ),
}).strict();

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

// ---------------------------------------------------------------------------
// Method arguments
// ---------------------------------------------------------------------------

const CollectArgsSchema = z.object({});
const StatusArgsSchema = z.object({});

type CollectArgs = z.infer<typeof CollectArgsSchema>;
type StatusArgs = z.infer<typeof StatusArgsSchema>;

// ---------------------------------------------------------------------------
// Output schema
// ---------------------------------------------------------------------------

const GpuDeviceSchema = z.object({
  index: z.number().int(),
  vendor: z.string(),
  name: z.string(),
  vramMiB: z.number().int(),
  driver: z.string().default(""),
  computeCapability: z.string().default(""),
});

const GpuSchema = z.object({
  /** Every detected device, in index order. */
  devices: z.array(GpuDeviceSchema).default([]),
  /** Sum of `devices[].vramMiB`. */
  totalVramMiB: z.number().int().default(0),
  /** System RAM in MiB, or 0 when unknown. */
  ramMiB: z.number().int().default(0),
  /** Usable CPU cores, or 0 when unknown. */
  cpuCores: z.number().int().default(0),
  /** `cuda` | `rocm` | `metal` | `none`. */
  runtime: z.string().default("none"),
  /** Primary vendor (first device), or `unknown`. */
  vendor: z.string().default("unknown"),
  /** When the facts were read (ISO 8601). */
  detectedAt: z.string(),
});

const StatusOutputSchema = z.object({
  present: z.boolean(),
  vendor: z.string(),
  runtime: z.string(),
  deviceCount: z.number().int(),
  checkedAt: z.string(),
});

// ---------------------------------------------------------------------------
// Platform reads
// ---------------------------------------------------------------------------

/** The outcome of running a probe command. */
export interface RunResult {
  /** Process exit code (`-1` when the binary is missing). */
  code: number;
  /** Raw stdout. */
  stdout: string;
}

/** The injectable side effects of reading the host, so tests can fake them. */
export interface GpuDeps {
  /** Run a command, returning its exit code and stdout. */
  run: (bin: string, args: string[]) => Promise<RunResult>;
  /** Read a text file, returning "" when absent or unreadable. */
  readFile: (path: string) => Promise<string>;
  /** The platform token from `uname -s` (e.g. `Linux`, `Darwin`). */
  uname: string;
  /** `navigator.hardwareConcurrency`, or 0 when unavailable. */
  hardwareConcurrency: number;
}

/** The real dependencies: `Deno.Command` and `Deno.readTextFile`. */
export function defaultGpuDeps(uname = ""): GpuDeps {
  return {
    run: async (bin, args) => {
      try {
        const out = await new Deno.Command(bin, {
          args,
          stdin: "null",
          stdout: "piped",
          stderr: "null",
        }).output();
        return { code: out.code, stdout: new TextDecoder().decode(out.stdout) };
      } catch {
        return { code: -1, stdout: "" };
      }
    },
    readFile: async (path) => {
      try {
        return await Deno.readTextFile(path);
      } catch {
        return "";
      }
    },
    uname,
    hardwareConcurrency: navigator.hardwareConcurrency ?? 0,
  };
}

/**
 * Detect the host's accelerators. With `vendor` set to a concrete vendor only
 * that probe runs; with `auto` the probes are tried NVIDIA → AMD → Apple.
 */
export async function detectGpus(
  deps: GpuDeps,
  vendor: "auto" | "nvidia" | "amd" | "apple" | "none" = "auto",
): Promise<GpuDevice[]> {
  if (vendor === "none") return [];
  if (vendor === "auto" || vendor === "nvidia") {
    const out = await deps.run("nvidia-smi", [
      "--query-gpu=index,name,memory.total,driver_version,compute_cap",
      "--format=csv,noheader,nounits",
    ]);
    if (out.code === 0 && out.stdout.trim()) return parseNvidiaSmi(out.stdout);
  }
  if (vendor === "auto" || vendor === "amd") {
    const mem = await deps.run("rocm-smi", [
      "--showmeminfo",
      "vram",
      "--json",
    ]);
    if (mem.code === 0 && mem.stdout.trim()) {
      const prod = await deps.run("rocm-smi", [
        "--showproductname",
        "--json",
      ]);
      return parseRocmSmi(mem.stdout, prod.stdout);
    }
  }
  if (vendor === "auto" || vendor === "apple") {
    const out = await deps.run("system_profiler", [
      "SPDisplaysDataType",
      "-json",
    ]);
    if (out.code === 0 && out.stdout.trim()) {
      return parseSystemProfiler(out.stdout);
    }
  }
  return [];
}

/** Read system RAM in MiB for the current platform, or 0. */
export async function readRamMiB(deps: GpuDeps): Promise<number> {
  // Deno's own sysinfo avoids /proc and works under the method sandbox when
  // --allow-sys is granted. Prefer it, then fall back to platform reads.
  try {
    const sys = Deno.systemMemoryInfo?.();
    if (sys && typeof sys.total === "number" && sys.total > 0) {
      return Math.round(sys.total / 1048576);
    }
  } catch {
    // not permitted — fall through to platform reads.
  }
  if (deps.uname.toLowerCase().startsWith("linux")) {
    const fromProc = parseMeminfoTotal(await deps.readFile("/proc/meminfo"));
    if (fromProc > 0) return fromProc;
  }
  if (deps.uname.toLowerCase().startsWith("darwin")) {
    const out = await deps.run("sysctl", ["-n", "hw.memsize"]);
    const bytes = toInt(out.stdout.trim());
    if (bytes > 0) return Math.round(bytes / 1048576);
  }
  const out = await deps.run("free", ["-m"]);
  const m = out.stdout.match(/^Mem:\s+(\d+)/m);
  return m ? toInt(m[1]) : 0;
}

/** Read the usable CPU-core count, or 0. */
export async function readCpuCores(deps: GpuDeps): Promise<number> {
  if (deps.hardwareConcurrency > 0) return deps.hardwareConcurrency;
  const out = await deps.run("nproc", []);
  return toInt(out.stdout.trim());
}

// ---------------------------------------------------------------------------
// Model definition
// ---------------------------------------------------------------------------

interface MethodContext {
  globalArgs: GlobalArgs;
  logger?: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warn: (msg: string, props?: Record<string, unknown>) => void;
  };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
  readResource?: (
    instanceName: string,
    version?: number,
  ) => Promise<Record<string, unknown> | null>;
}

/** A model that reports the local machine's accelerator facts. */
export const model = {
  type: GPU_FACTS_TYPE,
  version: "2026.10.16.4",
  globalArguments: GlobalArgsSchema,

  upgrades: [
    {
      toVersion: "2026.10.16.4",
      description:
        "Initial release: detect the host's accelerators (NVIDIA via " +
        "nvidia-smi, AMD via rocm-smi, Apple via system_profiler), plus system " +
        "RAM and CPU cores, and write them as one `gpu` resource with the " +
        "runtime (cuda/rocm/metal/none) and total VRAM. `collect` reads and " +
        "records; `status` reports whether a record exists. RAM is read via " +
        "Deno's systemMemoryInfo first (works under swamp's method sandbox), " +
        "falling back to /proc/meminfo, sysctl and free.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],

  resources: {
    gpu: {
      description:
        "This host's accelerators: devices, total VRAM, RAM, CPU cores, runtime.",
      schema: GpuSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    status: {
      description: "Whether a gpu record exists, without re-reading.",
      schema: StatusOutputSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
  },

  methods: {
    collect: {
      description:
        "Detect this host's accelerators (NVIDIA/AMD/Apple), system RAM and " +
        "CPU cores, and write them as the `gpu` resource. No network, no SSH.",
      arguments: CollectArgsSchema,
      execute: async (
        _args: CollectArgs,
        ctx: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = ctx.globalArgs;
        const base = defaultGpuDeps();
        const uname = (await base.run("uname", ["-s"])).stdout.trim();
        const deps: GpuDeps = { ...base, uname };
        const devices = selectDevices(
          await detectGpus(deps, g.vendorOverride),
          g.deviceIndex,
        );
        const facts = buildGpuFacts(devices, {
          ramMiB: await readRamMiB(deps),
          cpuCores: await readCpuCores(deps),
        });
        const handle = await ctx.writeResource("gpu", "gpu", facts);
        ctx.logger?.info(
          "gpu-facts: {runtime} - {count} device(s) - {vram} MiB VRAM - {ram} MiB RAM - {cpu} cores",
          {
            runtime: facts.runtime,
            count: facts.devices.length,
            vram: facts.totalVramMiB,
            ram: facts.ramMiB,
            cpu: facts.cpuCores,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    status: {
      description:
        "Report whether a `gpu` record already exists, without re-reading the " +
        "host. Useful as a gate before `collect`.",
      arguments: StatusArgsSchema,
      execute: async (
        _args: StatusArgs,
        ctx: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        let present = false;
        let vendor = "";
        let runtime = "";
        let deviceCount = 0;
        if (ctx.readResource) {
          try {
            const value = await ctx.readResource("gpu");
            if (value) {
              present = true;
              vendor = String(value["vendor"] ?? "");
              runtime = String(value["runtime"] ?? "");
              const devices = value["devices"];
              deviceCount = Array.isArray(devices) ? devices.length : 0;
            }
          } catch {
            // no record readable — stays absent.
          }
        }
        const record = {
          present,
          vendor,
          runtime,
          deviceCount,
          checkedAt: new Date().toISOString(),
        };
        const handle = await ctx.writeResource("status", "status", record);
        ctx.logger?.info("gpu-facts: {state}", {
          state: present
            ? `present (${vendor || "unknown"} / ${runtime || "none"})`
            : "not collected yet",
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
