# @svendowideit/octoprint

Read-only health, version and webcam checks for one OctoPrint box, as swamp
resources.

## What it does

One model instance per OctoPrint/printer pair. It speaks OctoPrint's HTTP API
with an `X-Api-Key` header and records what it finds, so a workflow can answer
"is the printer working, and is everything around it current?":

| Method | Answers |
| --- | --- |
| `status` | reachable? printer state, temperatures, job progress, selected printer profile (the profile's `model` identifies the machine) |
| `version` | OctoPrint core version, API version, host it runs on |
| `plugins` | installed plugins, and the Software Update plugin's pending updates |
| `firmware` | the controller firmware string OctoPrint already holds, and which payload it came from |
| `webcam` | `/webcam/?action=snapshot` status, content type, byte count, JPEG magic |

Three deliberate non-features:

- **It never opens the printer's serial port.** OctoPrint owns `/dev/ttyACM0`;
  a second reader fights the running server for the device. Firmware is read
  from what OctoPrint already parsed at connect time — and `firmware` reports
  `detected: false` with `sourcesTried` when this OctoPrint version exposes no
  such string, rather than pretending.
- **Nothing mutates.** No start/pause/cancel, no restart, no update. Those are
  later, guarded methods. Firmware flashing stays a human action.
- **No secret in the definition.** The endpoint and API key are read from a
  swamp vault at run time through `ctx.vaultService`, not interpolated into the
  model YAML, so `swamp doctor secrets` stays quiet and a repo clone is safe.

Failures are data, not exceptions: an unreachable host gives `reachable: false`
plus an `errors` entry; a printer that is not connected gives `state: offline`
(OctoPrint's own 409) instead of a failed run. A run that *cannot* be configured
at all — no URL in the vault and no `baseUrl` — throws with the exact fix in the
message.

## Install

```sh
swamp extension pull @svendowideit/octoprint
```

No dependencies: Deno's built-in `fetch` plus swamp's vault reader. No `curl`,
no SSH, no separate Deno install.

## Configuration

Global arguments, set at instance creation (or edited later) with
`--global-arg key=value`:

| Argument | Default | Meaning |
| --- | --- | --- |
| `vaultName` | `octoprint-secrets` | Vault holding the endpoint and API key. Read at run time. |
| `urlRef` | `url` | Vault key holding the base URL. |
| `apiKeyRef` | `apiKey` | Vault key holding the API key, sent as `X-Api-Key`. |
| `baseUrl` | `""` | Base URL override (`http`/`https` only); empty reads it from the vault. |
| `requestTimeoutMs` | `30000` | Per-request timeout. The update check is slow on a Pi (4-7 s measured), so the default is generous. |
| `maxBodyBytes` | `262144` | Response bytes read per request. |
| `userAgent` | `swamp-octoprint/1.0` | User-Agent sent with every request. |
| `name` | `""` | Model instance name, supplied by swamp. |

Seeding the vault once is the whole setup:

```sh
# `vault put` prompts for the value, so no secret ever reaches your shell
# history. url and apiKey are the defaults the instance already looks for, so
# the model needs no arguments at all.
swamp vault put octoprint-secrets url
swamp vault put octoprint-secrets apiKey
swamp model create @svendowideit/octoprint mk2s
```

The API key comes from OctoPrint's *Settings -> API*: copy it there and paste it
at the `vault put` prompt. For `url`, give the printer's base URL, e.g.
`http://octopi.local` (the OctoPi image's mDNS default) or a static address.

## Examples

```sh
# Is it up, what is it doing, and which printer is this? Run first; the
# profile's `model` is what proves which machine answered.
swamp behavior run mk2s status

# Is OctoPrint itself current? Compare `octoprintVersion` against the release
# notes before planning an upgrade.
swamp behavior run mk2s version

# What is stale? Installed plugins plus the Software Update plugin's pending
# updates, core included. Report-only, so it is safe to run while idle.
swamp behavior run mk2s plugins

# Does the webcam still work? A dead daemon answers 200 with HTML, so this
# checks the content type and the JPEG magic, not just the status code.
swamp behavior run mk2s webcam

# Read the answers back out of the resources, e.g. in a report or workflow:
swamp data query 'modelName == "mk2s" && name == "status"' \
  --select content
```

A second printer is a second instance with its own vault — never a second copy
of the code:

```sh
swamp model create @svendowideit/octoprint mk4s \
  --global-arg vaultName=mk4s-secrets
```

## Details

### `@svendowideit/octoprint`

**Resources**

- `status` — `url`, `reachable`, `checkedAt`, `octoprintVersion`, `apiVersion`,
  `state` (`operational` | `printing` | `paused` | `error` | `offline` |
  `unknown`), `stateText`, `temperatures.tool0{actual,target}`,
  `temperatures.bed{actual,target}`,
  `job{file,progressPct,timeLeftSec,timeElapsedSec}`, `profile{id,name,model}`,
  `hostname`, `errors[]`.
- `version` — `url`, `reachable`, `octoprintVersion`, `apiVersion`, `hostname`,
  `os`, `python`, `errors[]`.
- `plugins` — `count`, `plugins[]{id,name,version,enabled}`,
  `softwareUpdatePresent`, `softwareUpdateEndpoint`,
  `updatesAvailable[]{id,installed,available}`, `errors[]`.
- `firmware` — `detected`, `value`, `source`, `printerModel`, `sourcesTried[]`,
  `errors[]`. `sourcesTried` is why a `detected: false` is diagnosable.
- `webcam` — `ok`, `status`, `contentType`, `bytes`, `looksLikeJpeg`,
  `streamUrl`, `errors[]`.

**Methods** — `status`, `version`, `plugins`, `firmware`, `webcam`. All five take
no arguments.

### Endpoints used

`GET /api/version`, `GET /api/printer`, `GET /api/job`,
`GET /api/printerprofiles`, `GET /api/system/info` (admin only; absent is
recorded, not fatal), `GET /api/settings`, the Software Update check
(`/api/plugin/softwareupdate/check`, falling back to
`/plugin/softwareupdate/check` on newer builds — whichever answers is recorded in
`softwareUpdateEndpoint`), and `GET /webcam/?action=snapshot`. `firmware`
searches the `/api/printer`, `/api/settings`, `/api/printerprofiles` and
Software Update payloads, in that order.

### Extending it

`octoprint.ts` keeps payload shapes in pure exported functions (`parseVersion`,
`parsePrinter`, `parseJob`, `parseCurrentProfile`, `parsePlugins`,
`parseSoftwareUpdateCheck`, `findFirmware`, `stateFromFlags`, `looksLikeJpeg`,
`normaliseBaseUrl`, `resolveCredentials`) and all I/O behind `createFetcher`, so
a new method is a parser plus a `getJson` call and its test needs no printer:

```sh
~/.swamp/deno/deno test --allow-all extensions/models/octoprint/
~/.swamp/deno/deno check extensions/models/octoprint/octoprint.ts
```

When adding a mutating method (start/pause/cancel, restart, apply updates), it
must take an explicit `confirm` argument and refuse while
`status.state == "printing"`; keep the read-only methods free of side effects.

A known gap, reported honestly rather than papered over: `firmware` searches
four payloads (`/api/printer`, `/api/settings`, `/api/printerprofiles` and the
Software Update check) and still finds nothing on an OctoPrint 1.9.3 + MK2S
pair, because the firmware-check plugin has no source for the MK2S's Rambo
board. It therefore reports `detected: false` with `sourcesTried` listing what
it looked at. The serial port stays closed by design — opening `/dev/ttyACM0`
would fight OctoPrint for the printer — so closing this gap means reading a
future OctoPrint/plugin field, not probing the board.

## Licence

MIT — see `LICENSE.txt`.
