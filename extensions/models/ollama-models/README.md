# @svendowideit/ollama-models

Everything Ollama lets you do with a model, as swamp methods — and a Modelfile
generator that customises a model to this host's GPU and RAM, builds it, and
proves it loads.

It drives the Ollama HTTP API at `OLLAMA_HOST` (local, or a GPU host on the
LAN), so one repo can build models on every machine in the fleet.

## What it does

`renderModelfile` is the point of difference: it takes a GGUF path and the
model's chat template (from a Hugging Face download), derives `num_ctx` and
`num_gpu` from the GGUF size and the host's VRAM/RAM budget, and attaches your
`SYSTEM` instructions and parameters. `create` then builds the Ollama model and
`verify` runs it and asserts it actually loaded on the GPU (`size_vram > 0`)
rather than silently spilling to CPU.

Side effects: HTTP calls to the configured Ollama server (including large
`pull`/`push` payloads), and `renderModelfile` may write a `Modelfile` to a path
you choose. Models it creates live in Ollama's own store. No service is created.

## Install

```sh
swamp extension pull @svendowideit/ollama-models
```

No dependencies. Install Ollama itself with
[`@svendowideit/ollama`](../ollama) if the host does not have it yet.

## Configuration

Every global argument can also be passed per call with `--input`.

| Argument | Type | Default | Description |
| -------- | ---- | ------- | ----------- |
| `name` | string | `""` | Model instance name (supplied by swamp). |
| `host` | string | `http://127.0.0.1:11434` | Ollama server base URL. `127.0.0.1:11434` is accepted (`http://` is added). |
| `registry` | string | `""` | Default push registry host. Empty uses the server default. |
| `namespace` | string | `""` | Default push namespace. Empty pushes as-is. |
| `timeoutSec` | number | `120` | Per-request HTTP timeout (large pulls need a big value). |
| `keepAlive` | string | `5m` | Default `keep_alive` for inference (`run`/`chat`/`verify`) and `unload` — a runtime option, never written into a Modelfile (Ollama rejects it as an unknown parameter). |

## Setup

`setup` resolves and persists the server config: it reads any existing `config`
resource back first, probes `/api/version`, and records whether the host is
reachable — so later runs and other extensions reuse it instead of re-probing.
Run it after creating the model, or when `host` changes.

```sh
# Probe the server and persist config. Point host at a LAN GPU box to drive
# another machine.
swamp model @svendowideit/ollama-models method run setup om \
  --input host=127.0.0.1:11434
```

## Examples

```sh
# A Modelfile customised to this host: derive num_ctx/num_gpu from the GGUF
# size and the VRAM/RAM budget, attaching the chat template and instructions.
swamp model @svendowideit/ollama-models method run renderModelfile om \
  --input modelName=coder:latest --input from=/models/coder-Q4_K_M.gguf \
  --input template="{{ .Prompt }}" --input system="You are a coding assistant." \
  --input sizeBytes=4683071232 --input contextLength=32768 \
  --input vramMiB=24564 --input ramMiB=128000 --input outputPath=Modelfile

# Build the model from the last rendered Modelfile.
swamp model @svendowideit/ollama-models method run create om \
  --input model=coder:latest

# Prove it runs and loaded on the GPU (fails when size_vram is 0).
swamp model @svendowideit/ollama-models method run verify om \
  --input model=coder:latest

# Push the built model to your namespace on ollama.com (or a registry).
swamp model @svendowideit/ollama-models method run push om \
  --input model=coder:latest --input target=sven/coder:latest

# See what is loaded right now and how much VRAM it is using.
swamp model @svendowideit/ollama-models method run ps om

# List the local models, or pull one from a registry.
swamp model @svendowideit/ollama-models method run list om
swamp model @svendowideit/ollama-models method run pull om \
  --input model=qwen2.5-coder:7b

# Unload a model to free VRAM without deleting it.
swamp model @svendowideit/ollama-models method run unload om \
  --input model=coder:latest
```

## Upgrade

This extension installs nothing on the host (no service, daemon or unit), so
there is no on-host state to reconcile — upgrade the code alone and re-run
`setup`. Models already built in Ollama are untouched; re-run `renderModelfile`
and `create` to rebuild them with new settings.

```sh
# Pull the newest published version, then re-probe the server.
swamp extension update @svendowideit/ollama-models
swamp model @svendowideit/ollama-models method run setup om
```

## Details

### The `@svendowideit/ollama-model-factory` workflow

The package also ships one workflow that chains this model with
[`@svendowideit/gpu-facts`](../gpu-facts) and
[`@svendowideit/huggingface`](../huggingface) end to end:

```
facts → recommend → (clarify → wait-for-choice) → select → inspect →
download → render-modelfile → create → verify → (push)
```

Run it on the GPU host itself (or point `ollamaHost` at one on the LAN). When
more than one candidate fits, the run suspends and asks you:

```sh
# Start the factory for a natural-language ask.
swamp workflow run @svendowideit/ollama-model-factory \
  --input ask="a local coding assistant" --input modelName=coder:latest

# If it suspended, pick an option (non-secret values only), then resume.
swamp workflow signal --workflow @svendowideit/ollama-model-factory \
  --key hf-choice --payload '{"answer":"Qwen/Qwen2.5-Coder-7B-Instruct-GGUF#Q4_K_M"}'
swamp workflow resume @svendowideit/ollama-model-factory

# Push the verified model afterwards by re-running with push=true.
swamp workflow run @svendowideit/ollama-model-factory \
  --input ask="a local coding assistant" --input modelName=coder:latest \
  --input push=true --input pushTarget=sven/coder:latest
```

### Model, methods and resources

The package ships one model type, `@svendowideit/ollama-models`.

| Method | Arguments | Resource | Ollama API |
| ------ | --------- | -------- | ---------- |
| `setup` | *(none)* | `config` | `GET /api/version` |
| `sync` | *(none)* | `server`, `models` | `GET /api/version`, `/api/tags` |
| `list` | *(none)* | `models` | `GET /api/tags` |
| `show` | `model` | `model` | `POST /api/show` |
| `ps` | *(none)* | `running` | `GET /api/ps` |
| `pull` | `model`, `insecure` | `transfer` | `POST /api/pull` |
| `push` | `model`, `target`, `insecure` | `transfer` | `POST /api/push` |
| `copy` | `source`, `destination` | `transfer` | `POST /api/copy` |
| `delete` | `model` | `transfer` | `DELETE /api/delete` |
| `renderModelfile` | `modelName`, `from`, `adapter`, `template`, `system`, `license`, `parameters`, `quant`, `sizeBytes`, `contextLength`, `vramMiB`, `ramMiB`, `numCtx`, `numGpu`, `outputPath` | `modelfile` | — |
| `create` | `model`, `modelfile`, `from` | `create` | `POST /api/create` |
| `run` | `model`, `prompt`, `system`, `options`, `keepAlive` | `run` | `POST /api/generate` |
| `chat` | `model`, `messages`, `options`, `keepAlive` | `run` | `POST /api/chat` |
| `embed` | `model`, `input` | `run` | `POST /api/embed` |
| `unload` | `model` | `transfer` | `POST /api/generate` (`keep_alive:0`) |
| `verify` | `model`, `prompt`, `requireVram` | `verify` | `/api/generate` + `/api/ps` |
| `print` | *(none)* | `summary` | — |

The `modelfile` resource carries the `text`, the `parameters[]`, and the derived
`placement`/`numCtx`/`numGpu`. The `verify` resource carries `passed`,
`loadedOnGpu`, `sizeVramBytes`, `tokensPerSecond`, `response` and per-check
results.

### The fit maths

`renderModelfile` calls `deriveFitParameters` (in `ollama_models_shared.ts`):
it estimates KV cache as `KV_MIB_PER_1K` MiB per 1024 tokens, adds a fixed
`RUNTIME_OVERHEAD_MIB`, and then — in order — keeps full GPU offload
(`num_gpu: 999`) at the requested context; shrinks `num_ctx` to fit VRAM; falls
back to CPU (`num_gpu: 0`); or reports `too-large`. User-supplied `parameters`
always win over the derived ones.

### Structure and extending

- `ollama_models_shared.ts` — side-effect-free: `deriveFitParameters`,
  `mergeParameters`, `renderModelfile`, `parseModelfile`, `tokensPerSecond`.
  Fully unit tested.
- `ollama_models.ts` — the model. `apiRequest` wraps `fetch` with a timeout and
  JSON body; `serverVersion` / `latestRecord` are the shared reads;
  `normalizeHost` and `buildPushTarget` are the pure helpers.
- `ollama_models_test.ts` / `ollama_models_shared_test.ts` — pure tests plus
  execute-level tests with `fetch` stubbed (and a temp dir for `renderModelfile`).

To change the fit policy, edit `deriveFitParameters`. To change the Modelfile
shape, edit `renderModelfile`/`parseModelfile`. To add an Ollama endpoint, add a
method that calls `apiRequest` and writes a resource.

### Testing

```sh
~/.swamp/deno/deno test --allow-read --allow-write --allow-env --allow-run \
  extensions/models/ollama-models/ollama_models_shared_test.ts \
  extensions/models/ollama-models/ollama_models_test.ts

~/.swamp/deno/deno check \
  extensions/models/ollama-models/ollama_models_shared.ts \
  extensions/models/ollama-models/ollama_models.ts
```

### Caveats

- **The KV-cache estimate is coarse.** It is a per-1k-token constant, not a
  per-architecture calculation. `renderModelfile` records the derived values so
  a caller can override `numCtx`/`numGpu` when it knows better.
- **`verify` needs a reachable server and a buildable model.** It fails (and
  records why) when the model does not answer, or loaded entirely on the CPU
  under `requireVram: true`. Set `requireVram=false` to accept a CPU run — the
  `verify` resource still records `loadedOnGpu` truthfully. This matters on
  unified-memory hosts (NVIDIA GB10, Jetson, Apple Silicon, AMD APUs), where
  Ollama reports `size_vram: 0` even when the model is on the GPU, and on hosts
  whose Ollama is a CPU-only build (`ollama ps` shows `100% CPU`;
  `llama.cpp was compiled without GPU support`). The factory workflow exposes
  this as the `requireVram` input.
- **Pushing needs a login.** `push` fails with the HTTP status when the server
  is not authenticated for the target registry/namespace; log in with
  `ollama signin` (or your registry's equivalent) first.
- **`create` imports a GGUF by uploading it as a blob.** Ollama does not read
  the client's filesystem, so `create` streams the GGUF to `/api/blobs/<sha256>`
  (computing the digest with `sha256sum`) and creates the model with `files`.
  This works when the daemon runs as a different user (e.g. the `ollama` system
  user) and against a LAN host — but it means the GGUF is re-read and uploaded,
  so `sha256sum` must be available locally; when it is not, `create` falls back
  to sending the path as `from` (which only works when the server shares the
  filesystem).
- **Hugging Face Jinja chat templates are not Ollama templates.** Ollama's Go
  template engine does not define Jinja helpers like `bos_token`, so passing an
  HF `chat_template` verbatim makes `create` fail with
  `function "bos_token" not defined`. `renderModelfile` therefore omits
  `TEMPLATE` unless you supply one, and Ollama uses the chat template embedded
  in the GGUF metadata (present in most GGUF releases). Supply `template` only
  for a simple, Go-compatible template.

## License

MIT — see LICENSE.txt.
