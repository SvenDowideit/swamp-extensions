# @svendowideit/llama-cpp

Run GGUF models that need a **customised llama.cpp kernel** — the ones stock
llama.cpp (and therefore Ollama) cannot load — by installing a patched build,
serving them with `llama-server`, and verifying they answer.

Where [`@svendowideit/ollama-models`](../ollama-models) covers everything Ollama
can do, this covers the models Ollama *can't* yet run: those whose architecture
needs a patched llama.cpp (e.g. Aleph-Alpha **Kolibri-1**'s `kolibri1` MoE, which
requires `kolibri1-llama.cpp.patch` on top of upstream llama.cpp).

## What it does

A built-in **kernel registry** maps a model architecture to a concrete prebuilt
patched build for each OS/architecture/accelerator. The methods then:

- `plan` — resolve this host's platform and pick the build asset (with a CPU
  fallback), recording the exact release repo/tag and download URL;
- `download` — fetch that asset (streamed, reused unless `force`);
- `install` — verify the checksum (when given) and extract it, locating the
  `llama-server`/`llama-cli` binaries;
- **`build`/`buildStatus`** — when no prebuilt asset matches the host (e.g. an
  `aarch64`+CUDA build that is not published), `plan` falls back to a **source
  build**: `build` clones llama.cpp at the kernel's pinned commit, applies the
  kernel patch (`git am`), cmake-configures for the accelerator and builds, as a
  host-managed background job that outlives the run; `buildStatus` awaits it and
  records the `install` resource;
- `renderService` — render (and optionally write) a systemd **user** unit that
  runs `llama-server` for a chosen GGUF;
- `serve`/`stop`/`status` — start, stop, and report the unit and its `/health`;
- `run`/`verify` — a one-shot `llama-cli` completion, and a smoke test that
  asserts the model answered (and, when asked, that it offloaded to the GPU).
- `ensure-caddy-proxy` — when `@svendowideit/caddy` is installed, auto-detect
  the Caddy model for this host and declare a reverse-proxy route from
  `<serviceName>.<host>.<domain>` to `127.0.0.1:<port>`; skips with a notice when
  caddy is absent.

Side effects: it downloads the kernel build from GitHub, extracts it under
`installDir`, stages the archive under `downloadDir`, and (for a served model)
writes a systemd user unit. It does not touch Ollama or any other extension's
files.

## Install

```sh
swamp extension pull @svendowideit/llama-cpp
```

No dependencies for the methods. The bundled workflow also uses
`@svendowideit/gpu-facts` and `@svendowideit/huggingface` (declared as
dependencies).

## Quick start

Run this **on the host that will serve the model** — like the Ollama factory,
the workflow acts on the machine where `swamp` runs (it detects the platform,
extracts the build into `installDir`, and writes a systemd **user** unit there).

```sh
# See what custom kernels are available (today: kolibri1).
swamp model @svendowideit/llama-cpp method run kernels lc

# Find a GGUF, install the patched kernel for this host, serve it, and prove
# it answers — the whole loop in one run.
swamp workflow run @svendowideit/llama-cpp-model-factory \
  --input kernel=kolibri1 --input ask="Aleph-Alpha Kolibri German reasoning model"
```

If more than one GGUF fits, the run suspends and asks you to choose:

```sh
swamp workflow waits
swamp workflow signal --workflow @svendowideit/llama-cpp-model-factory \
  --key hf-choice --payload '{"answer":"Hob-forge/Kolibri-1-GGUF#Q2_K"}'
swamp workflow resume @svendowideit/llama-cpp-model-factory
```

Prefer the individual methods? Run `setup` → `plan` → `download` → `install` →
`renderService` → `serve` → `verify` (see [Examples](#examples)). On an aarch64
host `plan` selects the CPU build (there is no aarch64 GPU build today), so leave
`verify`'s `expectVram` at `false`.

## Configuration

Every global argument can also be passed per call with `--input`.

| Argument | Type | Default | Description |
| -------- | ---- | ------- | ----------- |
| `name` | string | `""` | Model instance name (supplied by swamp). |
| `installDir` | string | `~/.local/llama-cpp` | Where the kernel build is extracted (`~` expanded). |
| `downloadDir` | string | `~/.cache/llama-cpp` | Where the kernel archive is staged. |
| `host` | string | `127.0.0.1` | `llama-server` bind host. |
| `port` | number | `8080` | `llama-server` bind port. |
| `serviceName` | string | `llama-cpp` | systemd unit name (without `.service`). |
| `serviceScope` | `user` \| `system` | `user` | `user` needs no root; `system` needs root/sudo. |
| `unitDir` | string | `""` | Override the unit directory (advanced/testing). |
| `ctx` | number | `4096` | Default context window (`-c`). |
| `ngl` | number | `-1` | Default GPU layers (`-ngl`); `-1` derives (0 on cpu, 999 otherwise). |
| `threads` | number | `0` | CPU threads (`-t`); 0 = server default. |
| `keepAliveSec` | number | `3600` | Keep-alive: idle seconds after which the served model sleeps (freeing GPU/RAM) and wakes on the next request (`--sleep-idle-seconds`). 0 never sleeps. |
| `extraArgs` | string | `""` | Extra raw `llama-server` arguments. |
| `sudo` | string | `sudo` | Escalation command for system scope. |
| `releaseRepo` | string | `""` | Override the kernel release repository. Empty uses the kernel's. |
| `releaseTag` | string | `""` | Override the kernel release tag. Empty uses the kernel's. |

## Setup

`setup` resolves and persists the config (dirs, host/port, service, ctx/ngl),
reading any existing `config` resource back first so later runs reuse it. Run it
once after creating the model; change a setting by re-running it with a new
`--input`.

```sh
swamp model @svendowideit/llama-cpp method run setup lc
```

## Examples

```sh
# Which model architectures need a patched kernel, and where each comes from.
swamp model @svendowideit/llama-cpp method run kernels lc

# Resolve the build asset for this host (kolibri1 shown; the tool picks the
# right asset for this OS/arch/accelerator).
swamp model @svendowideit/llama-cpp method run plan lc --input kernel=kolibri1

# Serve a downloaded GGUF with the installed kernel, then prove it answers.
swamp model @svendowideit/llama-cpp method run renderService lc \
  --input model=/models/kolibri-Q2_K.gguf --input write=true
swamp model @svendowideit/llama-cpp method run serve lc
swamp model @svendowideit/llama-cpp method run verify lc \
  --input model=/models/kolibri-Q2_K.gguf

# The whole loop: find a GGUF, install the kernel, serve and verify it.
swamp workflow run @svendowideit/llama-cpp-model-factory \
  --input kernel=kolibri1 --input ask="a German reasoning model"

# Check what is running and whether the endpoint is healthy.
swamp model @svendowideit/llama-cpp method run status lc
```

## Upgrade

This extension installs nothing until you run `install`; upgrade the code alone
and re-run `install` to pick up a newer kernel build:

```sh
swamp extension update @svendowideit/llama-cpp
```

## Details

### Model, methods and resources

The package ships one model type, `@svendowideit/llama-cpp`, and one workflow.

| Method | Arguments | Resource | Description |
| ------ | --------- | -------- | ----------- |
| `setup` | *(none)* | `config` | Resolve and persist config; read the existing config back first. |
| `kernels` | *(none)* | `kernels` | List the custom-kernel registry. |
| `plan` | `kernel`, `os`, `arch`, `accel` | `plan` | Resolve the platform and the build asset. |
| `download` | `url`, `dir`, `force` | `download` | Download the kernel build archive. |
| `install` | `archivePath`, `archiveName`, `checksum`, `version`, `installDir`, `force` | `install` | Extract a downloaded build; locate binaries. |
| `build` | `sourceDir`, `jobs`, `force` | `build` | Build the kernel from source (clone llama.cpp at the pinned commit, `git am` the patch, cmake for the accelerator); host-managed background job. |
| `buildStatus` | `wait`, `maxWaitSec` | `install`, `build` | Await the source build; on completion record the `install` resource. |
| `renderService` | `model`, `ctx`, `ngl`, `host`, `port`, `threads`, `keepAliveSec`, `extraArgs`, `write` | `service` | Render (and write) the systemd user unit. `keepAliveSec` (default 3600) adds `--sleep-idle-seconds`, so the model sleeps after idle and wakes on request. |
| `serve` | `enable` | `server` | Place the unit, reload, start/restart. |
| `stop` | `disable` | `server` | Stop (and optionally disable) the unit. |
| `status` | *(none)* | `status` | Unit active/enabled + `/health`. |
| `run` | `model`, `prompt`, `numPredict`, `ctx`, `ngl`, `threads` | `run` | One-shot `llama-cli` completion. |
| `verify` | `run` args + `expectVram` | `verify` | Smoke prompt; assert an answer (± GPU). |
| `print` | *(none)* | `summary` | Log a summary. |

### The kernel registry

`llama_cpp_shared.ts` holds `KERNELS`: each entry names a model architecture, the
patched build's `releaseRepo`/`releaseTag`, and an asset per
`os`/`arch`/`accel`. `plan` calls `resolveAsset` (exact match → CPU fallback).
Adding a kernel is one registry entry plus a test. Today it ships `kolibri1`
(Aleph-Alpha Kolibri-1) built from
[`Seraphiel102/llama.cpp` release `hob-b11434`](https://github.com/Seraphiel102/llama.cpp).

### The factory workflow

`@svendowideit/llama-cpp-model-factory` mirrors the Ollama factory:
`facts → recommend → (clarify → wait-for-choice) → select → inspect → download →
plan → download-kernel → install → render-service → serve → verify → print`.
When more than one GGUF fits it suspends and asks (answer with
`swamp workflow signal --workflow @svendowideit/llama-cpp-model-factory --key
hf-choice --payload '{"answer":"<repo>#<quant>"}'`, then resume).

### Structure and extending

- `llama_cpp_shared.ts` — the registry, normalisers, asset selection, server
  args and unit rendering. Fully unit tested.
- `llama_cpp.ts` — the model. `runCommand`/`runSystemctl`/`findBinaries` are the
  process helpers; `parseTokensPerSecond` reads llama.cpp's timings.
- `llama_cpp_test.ts` / `llama_cpp_shared_test.ts` — pure tests plus
  execute-level tests with commands mocked and a real `tar.gz` fixture.

### Testing

```sh
~/.swamp/deno/deno test --allow-read --allow-write --allow-env --allow-run --allow-net \
  extensions/models/llama-cpp/llama_cpp_shared_test.ts \
  extensions/models/llama-cpp/llama_cpp_test.ts

~/.swamp/deno/deno check \
  extensions/models/llama-cpp/llama_cpp_shared.ts \
  extensions/models/llama-cpp/llama_cpp.ts
```

### Caveats

- **The build must exist for your platform.** `plan.supported` is false and
  `resolveAsset` returns null when a kernel has no asset for the host (e.g. no
  `darwin/aarch64` build). Today most kernels have no GPU build for aarch64 —
  Linux/arm64 runs CPU-only.
- **A kernel is a third-party artifact.** The registry pins a specific release
  repo/tag; you are trusting that publisher. Inspect the release before use.
- **`verify` checks a CLI completion, not the served endpoint.** It runs
  `llama-cli` with the installed kernel; `status` reports the running unit's
  `/health` separately.
- **`serve`/`stop` use systemd.** On a host without systemd, use `run`/`verify`
  (one-shot) instead of the service methods.

## License

MIT — see LICENSE.txt.
