# @svendowideit/otel-agent

Install an OTLP-native OpenTelemetry Collector agent across a fleet of hosts
over SSH, configuring each host from the published settings contract.

## What it does

This is the "make every host report" half of an OTel fleet. It is **OTLP-native**
(the agent pushes to the collector gateway; it is not the VictoriaMetrics/Vector
pull lane) and it is **config-from-network**: it never hardcodes a collector
config. For each host it:

1. probes the host over SSH (arch, OS, memory, existing agent version, systemd),
2. picks the tier (`T1` full, `T2` reduced — from the host's memory, or an
   explicit `tier` in the host entry),
3. fetches `install/<os>-<arch>.json` and `agent-config/<tier>.yaml` from
   `@svendowideit/otel-settings`,
4. downloads the checksum-verified collector from the settings mirror,
5. writes the config and a `0600` env file holding the gateway token (read from
   a swamp vault on the control node — never inlined in the config),
6. installs and restarts a systemd user service.

Because the config comes from the contract, changing `otel-settings` and
re-running `configure` reconfigures the whole fleet with no per-host editing.

It is a **single fan-out method** over a host set (bounded parallelism, one
resource per host), so onboarding many hosts is one call rather than N serial
runs — which matters at hundreds of hosts.

## Install

```sh
swamp extension pull @svendowideit/otel-agent
```

You also need SSH access to the target hosts and a running settings server; store
the gateway OTLP token in a swamp vault.

## Configuration

Global arguments set at creation:

| Argument | Type | Default | Meaning |
| --- | --- | --- | --- |
| `settingsUrl` | string | `https://settings.otel.fi.gy` | Base URL of the published settings contract. |
| `sshUser` | string | `""` | Default SSH user (a host entry may override). |
| `installDir` | string | `~/.local/share/otel-agent` | Host directory for the binary, config, and env file. |
| `serviceName` | string | `otel-agent` | systemd unit name on each host. |
| `gatewayServiceName` | string | `otel-gateway` | Unit whose presence marks a host as a gateway host (gets no agent). |
| `removeAgentOnGateway` | boolean | `true` | Stop/remove any agent found on a gateway host. |
| `defaultTier` | string | `T1` | Tier used when a host's tier cannot be inferred. |
| `vaultName` | string | `""` | Vault holding the gateway bearer token (empty = unauthenticated). |
| `authRef` | string | `OTEL_EXPORTER_OTLP_TOKEN` | Vault key for the token. |
| `concurrency` | integer | `8` | Maximum hosts operated on in parallel. |
| `sshTimeoutMs` | integer | `15000` | SSH connect timeout, per host. |
| `installTimeoutMs` | integer | `120000` | Maximum time a single host's install may take. |

Methods: `install`, `configure`, `status`, `remove`. Each takes a `hosts` array
of `{name, address, user?, tier?, port?}`. `install`/`configure` take `force`;
`remove` takes `removeInstallDir`.

**A gateway host is not an agent host.** A host that already runs an
`otel-gateway` is the collector for its own telemetry and must not also run an
agent — the gateway and the agent both bind the standard OTLP ports
(`4317`/`4318`) and the collector metrics port (`8888`), so whichever starts
second fails to bind (`address already in use`) and crash-loops. The probe
reports whether a gateway unit is present on a host; `install` refuses such a
host, and when `removeAgentOnGateway` is true it stops and removes any agent
already installed there. `gatewayServiceName` names the unit to look for when a
site runs its gateway under a non-default name.

## Examples

Store the gateway token once, then create the model pointed at the settings URL
and the token vault — the token stays on the control node and is delivered to
each host over SSH, never into the model definition:

```sh
swamp vault put otel-otlp-token OTEL_EXPORTER_OTLP_TOKEN
swamp model create @svendowideit/otel-agent agents \
  --global-arg settingsUrl=https://settings.otel.fi.gy \
  --global-arg sshUser=sven \
  --global-arg vaultName=otel-otlp-token
```

Onboard one host at a time and check it reports — the tier and the asset are
chosen from the contract, not passed in:

```sh
swamp model method run agents install \
  --input 'hosts=[{"name":"host1","address":"10.0.0.11"}]'
swamp model method run agents status \
  --input 'hosts=[{"name":"host1","address":"10.0.0.11"}]'
swamp data get agents status-host1 --json | jq '.content | {installed, active, version}'
```

After changing the observability contract, push the new config to the hosts you
already onboarded, in one fan-out call:

```sh
swamp model method run agents configure \
  --input 'hosts=[{"name":"host1","address":"10.0.0.11"},{"name":"host2","address":"10.0.0.12"}]'
```

Decommission an agent (stop, disable, remove the unit; optionally delete its
files):

```sh
# Stop + disable + remove the unit; removeInstallDir also deletes the binary,
# config, and env file on the host.
swamp model method run agents remove \
  --input 'hosts=[{"name":"host1","address":"10.0.0.11"}]' \
  --input removeInstallDir=true
```

## Details

- **Model type:** `@svendowideit/otel-agent` (a single model, `otel_agent.ts`).
- **Methods:** `install`, `configure`, `status`, `remove`. Each writes one
  `fanOut` resource per host (`<op>-<host>`) plus a `<op>-summary`.
- **Config-from-network:** `fetchInstallManifest` reads
  `settingsUrl/install/<os>-<arch>.json`; `fetchAgentConfig` reads
  `settingsUrl/agent-config/<tier>.yaml`. Nothing about the collector config is
  hardcoded here.
- **Secrets:** the token is read from `vaultName` via the model's vault service
  and written to `<installDir>/agent.env` (mode `0600`); the systemd unit uses
  `EnvironmentFile=-…` so the collector reads it at runtime.
- **Idempotency:** the install script skips the download when the installed
  binary already runs the manifest's version (unless `force`); the config, env,
  and unit are always rewritten and the service restarted, so a re-run converges.
- **Verification:** the checksum served by the settings mirror is checked with
  `sha256sum -c` before the binary is trusted.
- **Tiers:** `inferTier` uses host memory (≤4 GiB → `T2`), mirroring
  `fleet-inventory`; an explicit `tier` on a host entry wins.
- **Checks:** `sane-config` rejects an invalid service name, a non-http
  settingsUrl, and an installDir containing spaces.
- **Platforms:** Linux (systemd user services). macOS lacks `systemctl --user`
  and is reported as "no systemd user manager" rather than failing opaquely.
- **Publishing:** generic — no site-specific values — so it lives in
  `@svendowideit`.

### Development

```sh
~/.swamp/deno/deno check extensions/models/otel-agent/otel_agent.ts
~/.swamp/deno/deno test -A extensions/models/otel-agent/otel_agent_test.ts
swamp extension fmt extensions/models/otel-agent/manifest.yaml --check
swamp extension quality extensions/models/otel-agent/manifest.yaml --json
```
