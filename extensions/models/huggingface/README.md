# @svendowideit/huggingface

Turn "what models will help me do <something>?" into a ranked, hardware-aware
shortlist from the Hugging Face Hub — then download the one you choose, at a
pinned revision, ready for an Ollama Modelfile to `FROM`.

It searches the Hub by a natural-language ask plus structured filters, inspects
each candidate's file tree, GGUF quants, context length and chat template, and
scores them against a real VRAM/RAM budget (typically read from
[`@svendowideit/gpu-facts`](../gpu-facts)). When more than one candidate fits it
does not guess — it emits a structured question with the trade-offs for the user
to answer, which a workflow collects with `wait_for_signal`.

## What it does

`recommend` is the heart: it searches, inspects the top hits, and ranks them by
fit — "fits GPU with 16 GB to spare", "runs on CPU", "exceeds this host". The
ranking is deterministic and stored as swamp data, so a workflow can gate on
`ambiguous`, ask the user, and proceed.

Side effects: outbound HTTPS reads to `huggingface.co` (the API and, for
`download`, the file `resolve` endpoints which return large binaries). `download`
writes the chosen files under `cacheDir`. Nothing is written to the host
otherwise, and no service is created.

## Install

```sh
swamp extension pull @svendowideit/huggingface
```

No dependencies. For gated/private repos, set the `token` global (stored in the
vault, marked sensitive) or export `HF_TOKEN`.

## Configuration

Every global argument can also be passed per call with `--input`.

| Argument | Type | Default | Description |
| -------- | ---- | ------- | ----------- |
| `name` | string | `""` | Model instance name (supplied by swamp). |
| `endpoint` | string | `https://huggingface.co` | Hub base URL. |
| `token` | string | `""` | Access token for gated/private repos. Marked sensitive — stored in the vault. Empty falls back to `tokenEnvVar`. |
| `tokenEnvVar` | string | `HF_TOKEN` | Environment variable the token is read from when `token` is empty. |
| `library` | string | `gguf` | Default `search` library filter (`gguf` for Ollama-usable models). Use `""` for any. |
| `timeoutSec` | number | `30` | Per-request HTTP timeout. |
| `cacheDir` | string | `~/.cache/huggingface` | Default download directory (`~` expanded). |

## Setup

`setup` resolves and persists this model's configuration so later runs (and
other extensions) reuse it instead of re-asking. It reads any existing `config`
resource back first, reports the endpoint and the token source (`global` /
`env:HF_TOKEN` / `anonymous`), and writes the effective config to the `config`
resource — including partial values. The token itself is never written to the
resource; only whether one is configured and where it came from. Run it once
after creating the model, then change any setting by re-running it with a new
`--input` (or `--global-arg`). Capabilities enable progressively: `search` and
`download` of public repos work anonymously; setting a token (vault `token` or
`HF_TOKEN`) enables gated/private repos, and `auth` verifies the Hub accepts it.

```sh
# Resolve and persist config (endpoint, library, token source). Run after
# creating the model, or whenever a setting changes.
swamp model @svendowideit/huggingface method run setup hf
```

## Examples

```sh
# Ask for models that fit a host, passing its VRAM/RAM budget (read from
# @svendowideit/gpu-facts) so the ranking reflects this machine. The result is
# the `recommendation` resource; `ambiguous: true` means a workflow should ask.
swamp model @svendowideit/huggingface method run recommend hf \
  --input ask="a local coding assistant" --input vramMiB=24564 --input ramMiB=128000

# See the raw search hits before ranking, e.g. to widen or narrow a query.
swamp model @svendowideit/huggingface method run search hf \
  --input ask="code completion" --input limit=10

# Inspect one repo: its GGUF quants, context length and chat template — the
# facts a Modelfile renderer needs.
swamp model @svendowideit/huggingface method run inspect hf \
  --input repo=Qwen/Qwen2.5-Coder-7B-Instruct-GGUF

# Download the chosen quant at a pinned revision, verifying it against the
# Hub's recorded SHA-256 (when sha256sum is available). Resumable and
# skip-if-complete, so re-running is safe and never re-downloads.
swamp model @svendowideit/huggingface method run download hf \
  --input repo=Qwen/Qwen2.5-Coder-7B-Instruct-GGUF --input quant=Q4_K_M \
  --input dest=~/.cache/huggingface

# A very large model: start a host-managed background transfer that outlives
# the run, then await and verify it. Safe to re-run; the transfer is
# independent of this process.
swamp model @svendowideit/huggingface method run download hf \
  --input repo=Hob-forge/Kolibri-1-GGUF --input quant=Q2_K --input detached=true
swamp model @svendowideit/huggingface method run downloadStatus hf \
  --input wait=true --input maxWaitSec=7200

# Check that a token is seen before pulling a gated model — reports the identity
# the Hub sees (or anonymous).
swamp model @svendowideit/huggingface method run auth hf

# Resolve the user's choice after a workflow asked them (see the flow below).
swamp model @svendowideit/huggingface method run clarify hf \
  --input answer="Qwen/Qwen2.5-Coder-7B-Instruct-GGUF#Q4_K_M"
```

**Asking the user when the choice is ambiguous.** `recommend` sets
`ambiguous: true` when more than one candidate fits. A workflow
then runs `clarify` (no `answer`), which writes the `clarification` question and
options, and pauses on a `wait_for_signal` step. The user answers:

```sh
# List the pending wait, then deliver the choice as JSON. (Non-secret values
# only — never send a token through a signal payload.)
swamp workflow waits
swamp workflow signal --workflow @svendowideit/ollama-model-factory \
  --key hf-choice --payload '{"answer":"Qwen/Qwen2.5-Coder-7B-Instruct-GGUF#Q4_K_M"}'
swamp workflow resume @svendowideit/ollama-model-factory
```

## Upgrade

This extension installs nothing on the host (no service, daemon or unit), so
there is no on-host state to reconcile — upgrade the code alone and re-run
`setup` to refresh the persisted config:

```sh
# Pull the newest published version, then refresh the persisted config.
swamp extension update @svendowideit/huggingface
swamp model @svendowideit/huggingface method run setup hf
```

## Details

### Model, methods and resources

The package ships one model type, `@svendowideit/huggingface`.

| Method | Arguments | Resource | Description |
| ------ | --------- | -------- | ----------- |
| `setup` | *(none)* | `config` | Resolve and persist config (endpoint, token source); read the existing config back first. |
| `auth` | *(none)* | `auth` | Resolve the token (vault `token` or `tokenEnvVar`) and report the identity. |
| `search` | `ask`, `limit`, `library`, `pipelineTag` | `search` | Search the Hub by ask + filters. |
| `inspect` | `repo`, `revision` | `model` | One repo's tree, GGUF quants, context length, chat template. |
| `recommend` | `ask`, `vramMiB`, `ramMiB`, `candidates`, `quant` | `recommendation` | Search + inspect + budget-score, ranked; sets `ambiguous`. |
| `clarify` | `answer` | `clarification`, `selection` | With no `answer`, emit the question + options; with `answer` (`repo#quant`), write the selection. |
| `download` | `repo`, `revision`, `quant`, `files`, `dest`, `verify`, `detached` | `download`, `transfer` | Fetch the chosen files. Resumable (HTTP Range; complete files skipped). With `detached=true` starts a host-managed background transfer that outlives the run (writes `transfer`). |
| `downloadStatus` | `wait`, `maxWaitSec`, `verify` | `download`, `transfer` | Await and verify a detached transfer; on completion writes the `download` resource. The transfer keeps running independently if it outlasts the wait. |
| `print` | *(none)* | `summary` | Log the last recommendation and download. |

The `recommendation` resource carries `ask`, `budget`, `candidates[]` (`repo`,
`quant`, `file`, `sizeBytes`, `sizeMiB`, `verdict` = `gpu`/`cpu`/`too-large`,
`headroomMiB`, `notes`), `ambiguous`, `question` and `options[]`. The
`clarification` resource carries `question`, `options[]`, `resolved`, `answer`.
The `download` resource carries `repo`, `revision`, `dest` and `files[]`
(`path`, `localPath`, `sizeBytes`, `expectedOid`, `verified`).

### Structure and extending

- `huggingface_shared.ts` — side-effect-free logic: API parsing
  (`parseHfModelSummary`, `parseHfModelList`, `parseHfTree`), GGUF quant
  detection (`detectGgufQuant`), config/chat-template extraction
  (`parseContextLength`, `parseChatTemplate`), URL building, and the scoring
  (`assessFit`, `rankCandidates`, `buildRecommendation`). Fully unit tested.
- `huggingface.ts` — the model. `getText` wraps `fetch` with a timeout and the
  Bearer token; `streamToFile` streams a download to disk; `runSearch` and
  `pickGguf` are the shared search/select helpers. `resolveToken` reads the vault
  global or `tokenEnvVar`.
- `huggingface_test.ts` / `huggingface_shared_test.ts` — pure tests plus
  execute-level tests with `fetch` stubbed (and a temp dir for `download`).

To change how candidates are ranked, edit `rankCandidates`/`assessFit` in
`huggingface_shared.ts`. To add a search filter (e.g. license or min/max size),
extend `SearchOptions`/`buildSearchUrl` and add a test. To support a new
ambiguity rule, extend `buildRecommendation`.

### Testing

```sh
~/.swamp/deno/deno test --allow-read --allow-write --allow-env --allow-run \
  extensions/models/huggingface/huggingface_shared_test.ts \
  extensions/models/huggingface/huggingface_test.ts

~/.swamp/deno/deno check \
  extensions/models/huggingface/huggingface_shared.ts \
  extensions/models/huggingface/huggingface.ts
```

### Caveats

- **The size budget is an estimate.** `assessFit` adds a fixed
  `RUNTIME_OVERHEAD_MIB` for context/overhead; a real `num_ctx` can need more on
  a long-context model. The `recommendation` records the estimate so the
  Modelfile renderer can tighten it.
- **Download verification needs `sha256sum`.** When it is absent, or the Hub did
  not record an LFS oid, `verified` is false — the field reports reality rather
  than claiming a check that did not run.
- **Gated models need a token.** `auth` reports whether the Hub accepts it;
  `download` of a gated repo fails with the HTTP status when it does not.

## License

MIT — see LICENSE.txt.
