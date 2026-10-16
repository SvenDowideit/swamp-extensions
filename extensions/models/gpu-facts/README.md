# @svendowideit/gpu-facts

This host's accelerators as swamp data: every detected GPU (vendor, name, VRAM,
driver, compute capability), the total VRAM, system RAM, usable CPU cores and
the compute runtime (`cuda` / `rocm` / `metal` / `none`) — read straight off the
machine with no network and no SSH.

It is the hardware-budget half of "can this model run here?". A consumer — a
Hugging Face recommender choosing a quantisation, or an Ollama Modelfile
renderer setting `num_gpu` and `num_ctx` — reads the `gpu` resource instead of
hard-coding sizes, so one workflow adapts to a 4090 box, a Jetson, or a Mac.

## What it does

One `collect` method probes the local machine and writes a single `gpu`
resource:

- **Devices.** NVIDIA via `nvidia-smi --query-gpu=…`, AMD via `rocm-smi
  --showmeminfo vram --json` (plus `--showproductname`), Apple via
  `system_profiler SPDisplaysDataType -json`. Each device records `index`,
  `vendor`, `name`, `vramMiB`, `driver` and `computeCapability`.
- **Budget.** `totalVramMiB` (sum of the devices), `ramMiB` (Deno's
  `systemMemoryInfo`, falling back to Linux `/proc/meminfo`, macOS
  `sysctl -n hw.memsize`, then `free -m`) and `cpuCores`
  (`navigator.hardwareConcurrency`, else `nproc`).
- **Runtime.** The inferred `runtime` (`cuda` when an NVIDIA device is present,
  `rocm` for AMD, `metal` for Apple, else `none`) and the primary `vendor`.

It is deliberately aligned with
[`@svendowideit/host-facts`](../host-facts) and
[`@svendowideit/fleet-inventory`](../fleet-inventory) where the fields overlap
(`os`/`arch` live in `host-facts`; this carries the accelerator and
resource-budget fields those have no equivalent of).

A `status` method reports whether a `gpu` record already exists, without
re-reading the host.

Side effects: none beyond running local probe binaries and reading local files.
No network, no SSH, no credentials, nothing written to the host.

## Install

```sh
swamp extension pull @svendowideit/gpu-facts
```

No dependencies.

## Configuration

Every global argument can also be passed per call with `--input`.

| Argument | Type | Default | Description |
| -------- | ---- | ------- | ----------- |
| `name` | string | `""` | Model instance name (supplied by swamp; `status` uses it to read its own record). |
| `vendorOverride` | `auto` \| `nvidia` \| `amd` \| `apple` \| `none` | `auto` | Which probe to run. `auto` tries NVIDIA, then AMD, then Apple. `none` records only RAM/CPU (a host with no GPU). |
| `deviceIndex` | number | `-1` | Keep only this 0-based device index. Negative keeps every device. |

## Examples

```sh
# Detect this host's accelerators and record them. Run once per host; the
# `gpu` resource is what a recommender or Modelfile renderer reads.
swamp model @svendowideit/gpu-facts method run collect gpu-host

# Force a vendor probe on a host where auto-detection is ambiguous (e.g. a box
# with both an NVIDIA and an AMD card), keeping device 0 only.
swamp model @svendowideit/gpu-facts method run collect gpu-host \
  --input vendorOverride=nvidia --input deviceIndex=0

# Record only RAM/CPU budget for a host with no GPU (so a workflow still has a
# RAM figure to plan against).
swamp model @svendowideit/gpu-facts method run collect gpu-host \
  --input vendorOverride=none

# Read the recorded total VRAM back — the field a quantisation chooser wants.
swamp data query 'model("gpu-host") && name == "gpu"' --select content

# Gate before collecting: report whether a gpu record already exists, without
# re-reading the host. Useful in a workflow to skip a redundant probe.
swamp model @svendowideit/gpu-facts method run status gpu-host
```

## Upgrade

This extension installs nothing on the host (no service, daemon or unit), so
there is no on-host state to reconcile — upgrade the code alone:

```sh
# Pull the newest published version. `collect` then records the current facts
# again on its next run; no other step is required.
swamp extension update @svendowideit/gpu-facts
```

## Details

### Model, methods and resources

The package ships one model type, `@svendowideit/gpu-facts`.

| Method | Arguments | Resource | Description |
| ------ | --------- | -------- | ----------- |
| `collect` | *(none)* | `gpu` | Detect accelerators, RAM and CPU cores; write the `gpu` record. |
| `status` | *(none)* | `status` | Report whether a `gpu` record exists, without re-reading the host. |

The `gpu` resource carries `devices[]` (`index`, `vendor`, `name`, `vramMiB`,
`driver`, `computeCapability`), `totalVramMiB`, `ramMiB`, `cpuCores`, `runtime`,
`vendor` and `detectedAt`. The `status` resource carries `present`, `vendor`,
`runtime`, `deviceCount` and `checkedAt`.

### Structure and extending

- `gpu_facts_shared.ts` — side-effect-free parsing and assembly: the NVIDIA CSV
  parser (tolerant of commas in the device name), the tolerant ROCm JSON
  parser, the Apple `system_profiler` parser, `parseVramString`, and
  `buildGpuFacts` / `chooseRuntime` / `selectDevices`. No command or file
  access, so it is fully unit tested.
- `gpu_facts.ts` — the model. `detectGpus` picks the probe (NVIDIA → AMD →
  Apple under `auto`) and `readRamMiB` / `readCpuCores` read the resource
  budget; `collect` assembles and writes, `status` reads its own record.
- `gpu_facts_test.ts` — pure-parser tests plus an execute-level `collect` test
  through `createModelTestContext` with the probe commands mocked by
  `withMockedCommand`, so it runs the same on any machine.

To support a new vendor, add a parser to `gpu_facts_shared.ts`, wire it into
`detectGpus` and `chooseRuntime`, and add a case to the test. To add a field
(e.g. GPU temperature or power draw), extend the query and the `GpuDevice`
shape — the `buildGpuFacts` assembly stays the single mapping point.

### Testing

```sh
~/.swamp/deno/deno test --allow-read --allow-write --allow-env --allow-run \
  extensions/models/gpu-facts/gpu_facts_test.ts

~/.swamp/deno/deno check \
  extensions/models/gpu-facts/gpu_facts_shared.ts \
  extensions/models/gpu-facts/gpu_facts.ts
```

### Caveats

- **Apple unified memory reports `vramMiB: 0`.** Apple Silicon has no dedicated
  VRAM; when `system_profiler` reports a `spdisplays_vram` value it is used, but
  on unified-memory Macs a consumer should fall back to `ramMiB` and
  `runtime: metal`.
- **ROCm output varies.** `rocm-smi`'s JSON keys differ across versions; the
  parser reads the common `VRAM Total Memory (B)` / `Card series` keys and skips
  cards it cannot parse rather than failing.
- **A missing probe is not an error.** A host with no `nvidia-smi` simply
  records `runtime: none` (or whatever was detected) — useful for planning the
  RAM budget of a CPU-only machine. Note that a *broken* `nvidia-smi` (e.g. an
  NVIDIA driver/library version mismatch that needs a reboot) reads the same as
  no GPU: `totalVramMiB` is 0 even though CUDA may still work for Ollama. Pass
  an explicit `vramMiB` budget to a consumer in that case.
- **RAM needs no `/proc`.** `ramMiB` prefers `Deno.systemMemoryInfo()` so it
  works under swamp's method sandbox, where reading `/proc` may be restricted.

## License

MIT — see LICENSE.txt.
