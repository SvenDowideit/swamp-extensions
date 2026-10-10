# Caddy setup/upgrade — 36-hour issue log and test-factory plan

Scope: every defect hit while setting up a **new** Caddy and while **upgrading**
an existing one, from the first quality-gate failure through the post-setcap
"empty page" report. For each issue: the symptom, the root cause, the fix
(and the version it shipped in), and the `test-factory` test that proves it
stays fixed.

Versions referenced are `@svendowideit/caddy` (all `2026.10.10.x`).

---

## 1. Issue log

### A. Version / metadata

| # | Symptom | Root cause | Fix (version) |
| - | ------- | ---------- | ------------- |
| A1 | `swamp extension quality` failed a `upgrade-chain` gate: last `toVersion "2026.10.11.1"` ≠ model version. | Upgrade chain didn't terminate at the current model version. | Chain terminates at the model version (`2026.10.10.15`+). |
| A2 | Status page showed the **model's** version as the extension version. | `extensionVersion: model.version` — the model type/schema version is not the package version. | Read the extension version from the bundled `manifest.yaml` at run time (`findManifestPath` → `extensionVersionOf`). |
| A3 | Assumed manifest and model versions must be lock-step. | They are independent in swamp. | Documented; a meta-factory `version-source` rule forbids using the model/instance version as the extension version. |
| A4 | `ctx.extensionFile("manifest.yaml")` threw for a **pulled** extension. | Pulled assets live under `<ext>/files/`; the manifest is one level up. | Anchor on a shipped asset (`README.md`/`LICENSE.txt`) or the files root (`""`) and walk up to `manifest.yaml`. |
| A5 | `content-collectives` gate failure on workflow names. | Stale repo `workflows/workflow-caddy-setup.yaml` / `-caddy-ensure-proxy.yaml` used names without the collective. | Removed the stale repo copies; the extension ships `@svendowideit/caddy-setup`. |

### B. Elevation / capability

| # | Symptom | Root cause | Fix (version) |
| - | ------- | ---------- | ------------- |
| B1 | Caddy called `sudo`/`setcap` directly, and printed a "run this by hand" command when sudo was unavailable. | No integration with `@svendowideit/sudo`. | All privileged work delegates to `@svendowideit/sudo`'s `setcap` operation (`runModel`, `sudoInstanceKey`, manifest `dependencies`). |
| B2 | `setcap` was attempted **twice** per run (double password prompt). | `installCaddy` granted it **and** a separate workflow step re-granted it. | Removed the duplicate `set-capabilities` step from `caddy-setup` and `caddy-upgrade`. |
| B3 | `setcap` reported success but `:443` still gave `bind: permission denied`. | A file capability applies at **exec()** time; the running service was never restarted. | `installCaddy` restarts a running service whenever it replaces the binary **or** (re)grants the capability; the setup workflow restarts after writing the unit; `upgradeCheck` reports a `capability-not-in-effect` gap. |
| B4 | An automated run prompted for a **root password** (polkit/run0 route). | `@svendowideit/sudo` route probing invoked an interactive route. | **Open** — belongs to `@svendowideit/sudo` (its contract is "never hangs on a prompt"). |

### C. Config / reconcile

| # | Symptom | Root cause | Fix (version) |
| - | ------- | ---------- | ------------- |
| C1 | A config that binds `:443` was **rejected** wholesale → nothing served. | `buildReconciledConfig` emitted the desired `:443`/`:80` even when the binary couldn't bind them. | `effectiveServeSettings` degrades to `:8080`/`:8443` plain HTTP ("never reject"); desired settings kept and reapplied once it can bind. |
| C2 | Reconcile threw `dnsRecords require a DNS provider` → the whole config (status page included) was never applied. | `writeDnsRecords` threw when records had no provider. | Skip the `dns_records` app, keep the records **wanted**; they apply on a later reconcile once `configureTls` sets a provider. |
| C3 | `configureStatusPage` failed with an opaque Caddy `500` (permission denied). | C1. | C1 + the measured capability gap below. |
| C4 | `http://localhost/` returned **200 with an empty body**; status page never written. | Existing model's stored `desired` had `statusPage: null`, so reconcile never added the route; Caddy's unrouted default is 200-empty. | Status page is now the default for **every** model (stored `null`/absent ≈ "never chose"); only an explicit `{enabled:false}` disables it. |
| C5 | Health contract gave `404` for `/` but Caddy's unrouted default was `200`-empty, masking "no routes". | Status page + health routes absent. | Always emit the status page + health routes (C4). |

### D. Ordering / workflow

| # | Symptom | Root cause | Fix (version) |
| - | ------- | ---------- | ------------- |
| D1 | Manifest/README told users to run **non-shipped** workflows (`caddy-setup`, `caddy-ensure-proxy`). | Docs referenced workflows the extension doesn't ship. | Ship `@svendowideit/caddy-setup` (fresh install, correct order); use the `ensureDnsProxy` method for routes. |
| D2 | Upgrade workflow ran `dns` **before** `tls` → records failed. | Step order. | `tls` runs before `dns`. |
| D3 | `tls` step was skipped unless `--input dnsProvider=…`. | Guard. | `tls` runs always (single-target) and **infers** the provider. |
| D4 | `configureTls` required repeating the DNS provider + credential map. | No inference. | Infer provider from `plugins` and the field→env-var map from `environmentFile`. |
| D5 | Failures were swallowed (`allowFailure`), run "succeeded" with an empty config. | Ordering (D2/D3) + `allowFailure`. | Fixed order + the closing measured gap report surfaces what is still missing. |
| D6 | `startService` reported the admin API unreachable though the service was up → status page skipped. | Single immediate check raced Caddy's start. | `waitForAdminApi` polls up to 10 s. |

### E. Reporting honesty

| # | Symptom | Root cause | Fix (version) |
| - | ------- | ---------- | ------------- |
| E1 | Report claimed `https://<host>` on `:443` while actually serving `http` on `:8080`. | Built from the **desired** settings, not the running config. | `upgradeCheck` reports only **measured** facts (`liveServeSummary`/`localhostUrl`); unreachable admin API ⇒ claim nothing. |
| E2 | Report said "ready — nothing blocks" while serving plain HTTP. | Capability check looked only at the binary. | New measured `capability-not-in-effect` gap. |
| E3 | Status page's "Installed" table showed a **stale** capability/version/plugins snapshot. | Re-rendered from facts stored when `configureStatusPage` last ran. | Re-measure facts from the binary on **every** reconcile (`gatherInstallFacts`). |
| E4 | A fabricated `http(s)://localhost` endpoint (wrong port/scheme). | Derived from desired scheme/listens. | `localhostUrl(measuredScheme, measuredListens)`. |

### F. UX / docs (minor)

| # | Symptom | Root cause | Fix |
| - | ------- | ---------- | --- |
| F1 | Manifest quickstart omitted the mandatory `setcap` step. | Stale docs. | Rewritten to `@svendowideit/caddy-setup`. |
| F2 | `caddy-setup` discovery prints "upgrade it: … caddy-upgrade". | Reuses `upgradeTargets`, whose message is upgrade-shaped. | **Open** (cosmetic). |
| F3 | `swamp model create` naming churn / bad email pre-flight. | User input, not a defect. | n/a |

---

## 2. Existing test-factory coverage

`extensions/models/caddy/test-factory.yaml` (scenario
`ubuntu-systemd-standalone`, root harness) already proves:

- the binary installs with the `rfc2136` provider compiled in, a systemd user
  service is created/started, the admin API comes up;
- the health contract (`/`→200, `/teapot`→418, other→404) is served;
- A/AAAA/CNAME records are written into an authoritative BIND over TSIG, and
  pruned/changed/removed on reconcile.

**It deliberately bypasses the whole class of issues above**: it creates the
model with `autoHttps=off`, `listenAddrs=[":80"]`, and `installCaddy
--input setCapabilities=false`. So no capability is needed and no `:443` bind is
attempted — which is exactly why none of A–E were caught.

---

## 3. Test-factory plan

### 3.1 Topology, grants, scenarios

Reuse the existing BIND + two-network harness. The tests fall into two privilege
groups:

- **positive** — a granted route (`sudo-nopasswd`), `runAs: tester`: proves the
  capability is really granted via `@svendowideit/sudo` and `:443` binds;
- **degrade** — no route (`sudo-none`), `runAs: tester`: proves the failure is
  handled and reported honestly.

`test-factory` applies `harness.runAs` and `grants:` **once per candidate file**,
and there is no per-test override or file-selection input today. Two files would
be run into one container, so both grants cannot apply. **Enabling change
required in `@svendowideit/test-factory` (additive):**

- allow a per-test override: `tests[].runAs` and `tests[].grants` (falling back
  to the file-level values);
- group tests by their resolved grant, and run each group in a freshly
  provisioned container (a grant is a pre-harness root script, so it cannot be
  swapped mid-container).

With that, all tests below live in the one existing `test-factory.yaml`, tagged:

```yaml
tests:
  - name: install-grants-capability-and-binds-443
    runAs: tester
    grants: [{ guest: harness, profile: sudo-nopasswd }]
    ...
  - name: no-elevation-route-degrades-and-never-lies
    runAs: tester
    grants: [{ guest: harness, profile: sudo-none }]
    ...
```

Until that lands, the degrade tests can be run as a separate manual invocation
against a container the factory leaves up (or simply deferred); the positive
tests need no test-factory change.

### 3.2 New tests

Each is a new `tests:` entry. Sketch shows the decisive steps/assertions.

#### T1 — `extension-version-comes-from-manifest` (A2, A4)
confirms: the status page reports the **extension** version from `manifest.yaml`
(proving the pulled layout is located); cannot: report the model's type version.
```yaml
- name: status-page-version-is-the-manifest-version
  run: |
    curl -s http://localhost:2019/config/ \
      | jq -r '.apps.http.servers.srv0.routes[]
               | select(.["@id"]|endswith(":status"))
               | .handle[0].body' > /tmp/page.html
    grep -oE '@svendowideit/caddy</code>( <span class="muted">[0-9.]+)' /tmp/page.html
  expect: { outputMatches: "20[0-9]{2}\\.[0-9]+\\.[0-9]+\\.[0-9]+" }
```
(plus a negative: the body must **not** contain the model's `typeVersion` when
the two are deliberately made different via `configureStatusPage` / a decoupled
model schema version). The pulled-layout half is implicit: the harness runs the
**pulled** extension, so a passing test proves `extensionVersionOf` resolved the
`<ext>/files/` → `<ext>/manifest.yaml` walk-up.

#### T2 — `install-grants-capability-and-binds-443` (B1, B3, C1)
confirms: with a granted route, installCaddy grants `cap_net_bind_service`
**through `@svendowideit/sudo`**, restarts, and Caddy binds `:443` and serves
the status page over HTTPS; cannot: leave the service without the capability, or
serve on a high port.
```yaml
- name: create-model
  run: swamp model create @svendowideit/caddy e2e-caddy --global-arg baseDomain=example.com --global-arg letsEncryptEmail=admin@example.com --global-arg 'plugins:json=["github.com/caddy-dns/rfc2136"]'
  expect: { exitCode: 0 }
- name: setup
  run: swamp workflow run @svendowideit/caddy-setup --input model=e2e-caddy
  expect: { exitCode: 0 }
  timeoutSeconds: 600
- name: binary-has-the-capability
  run: getcap /home/tester/.local/bin/caddy
  expect: { stdoutContains: ["cap_net_bind_service"] }
- name: live-config-binds-443
  run: curl -s http://localhost:2019/config/ | jq -c '[.apps.http.servers[].listen[]]'
  expect: { stdoutContains: [":443"] }
- name: status-page-served-over-https
  run: curl -sk -o /dev/null -w '%{http_code}' https://localhost/
  expect: { stdoutContains: ["200"], stdoutNotContains: ["000"] }
```

#### T3 — `no-elevation-route-degrades-and-never-lies` (B4, C1, E1, E2, E4) — uses `grants: [sudo-none]`
confirms: with **no** elevation route the setup still succeeds, Caddy serves the
status page + health on `:8080`/`:8443` over plain HTTP, and the report states
**only measured facts**; cannot: print a fabricated `https://…` URL, claim
`nothing blocks`, or fail the whole run.
```yaml
- name: setup-without-elevation
  run: swamp workflow run @svendowideit/caddy-setup --input model=e2e-caddy
  expect:
    exitCode: 0
    outputNotContains: ["https://e2e-caddy", "https://localhost"]   # no fabricated https
    outputContains: ["plain HTTP", "80/443 not bound"]
  timeoutSeconds: 600
- name: status-page-still-served
  run: curl -s -o /dev/null -w '%{http_code}' http://localhost:8080/
  expect: { stdoutContains: ["200"] }
- name: report-is-measured-not-desired
  run: |
    swamp model method run e2e-caddy upgradeCheck 2>&1 | tee /tmp/check.txt
    # the reported listen set must equal the live config's, and no gap may be silently absent
    grep -q 'capability-not-in-effect\|cannot bind ports 80/443' /tmp/check.txt
  expect: { exitCode: 0, outputNotContains: ["ready — nothing blocks"] }
```

#### T4 — `dns-records-without-provider-do-not-reject` (C2, D4)
confirms: declaring `dnsRecords` before any provider makes reconcile **skip**
the records and still serve the status page; once `configureTls` sets the
provider (here inferred from `plugins` + `environmentFile`), the records appear;
cannot: reject the config or throw `dnsRecords require a DNS provider` during
reconcile.
```yaml
- name: declare-records-no-provider
  run: |
    swamp model get e2e-caddy --json \
      | jq '.globalArguments.dnsRecords=[{"name":"alpha.example.com","type":"A","value":["192.0.2.10"],"zone":"example.com"}] | {name,version,tags,globalArguments}' \
      | swamp model edit e2e-caddy --json
  expect: { exitCode: 0 }
- name: reconcile-does-not-reject
  run: swamp model method run e2e-caddy configureStatusPage
  expect: { exitCode: 0, outputNotContains: ["dnsRecords require a DNS provider"] }
- name: no-dns-app-yet
  run: curl -s http://localhost:2019/config/ | jq 'has("apps") and (.apps|has("dns_records"))'
  expect: { stdoutContains: ["false"] }
- name: infer-and-apply
  run: |
    swamp model method run e2e-caddy configureTls --input email=admin@example.com   # provider inferred from plugins + env file
    swamp model method run e2e-caddy applyDnsRecords
  expect: { exitCode: 0, outputContains: ["gandi", "rfc2136"] }   # whichever the plugins/env imply
- name: record-present
  run: dig +short @bind alpha.example.com A
  expect: { stdoutContains: ["192.0.2.10"] }
```

#### T5 — `status-page-is-default-including-existing-models` (C4, C5)
confirms: a mutating method that never calls `configureStatusPage` still writes
the status page + health routes, so `/` returns the HTML (`200` with a body),
not Caddy's unrouted empty `200`; an existing model whose stored `desired`
carries `statusPage: null` gains the page on the next reconcile; cannot: leave
`/` unrouted.
```yaml
- name: reconcile-without-configureStatusPage
  run: swamp model method run e2e-caddy ensureDnsProxy --input hostname=app.example.com --input upstream=127.0.0.1:9000
  expect: { exitCode: 0 }
- name: root-returns-html-not-empty
  run: |
    body=$(curl -s --resolve app.example.com:80:$TF_HARNESS_IP_NET1 http://app.example.com/ 2>/dev/null || true)
    echo "$body" | grep -c '<!doctype html>'
  expect: { stdoutContains: ["1"] }
- name: status-route-present
  run: curl -s http://localhost:2019/config/ | jq -r '[.apps.http.servers[].routes[]["@id"]|select(.|endswith(":status"))]|length'
  expect: { stdoutContains: ["1"] }
```
(Simulating a pre-existing `statusPage: null` is done by editing the `desired`
resource to `statusPage:null` via `swamp data` before the reconcile — a step that
then asserts the page reappears.)

#### T6 — `report-matches-the-live-config` (E1, E2, E3)
confirms: the reported listen set/scheme equal the running config's, and the
status page's "Privileged ports" line equals `getcap`; cannot: disagree with the
live config.
```yaml
- name: live-listens
  run: curl -s http://localhost:2019/config/ | jq -r '[.apps.http.servers[].listen[]]|sort|join(",")'
  expect: { stdoutContains: [":443,:80"] }              # or ":8080,:8443" in the sudo-none group
- name: report-listens-match
  run: |
    swamp model method run e2e-caddy upgradeCheck 2>&1 | grep 'measured from the running config' > /tmp/r.txt
    cat /tmp/r.txt
  expect: { outputContains: [":443", ":80"] }
- name: status-page-capability-line-matches-getcap
  run: |
    gets=$(getcap /home/tester/.local/bin/caddy | grep -c cap_net_bind_service)
    pages=$(curl -sk https://localhost/ | grep -c 'CAP_NET_BIND_SERVICE set')
    test "$gets" = "$pages"
  expect: { exitCode: 0 }
```

#### T7 — `tls-runs-before-dns-and-infers-the-provider` (D2, D3, D4)
confirms: the upgrade workflow configures TLS **before** applying records, and
infers the provider from `plugins` + `environmentFile` with **no**
`--input dnsProvider`; cannot: skip the `tls` step, or fail `dns` for a missing
provider.
```yaml
- name: configure-provider-in-model-only
  run: |
    swamp model get e2e-caddy --json \
      | jq '.globalArguments.plugins=["github.com/caddy-dns/rfc2136"] | .globalArguments.environmentFile="/home/tester/.config/caddy/dns.env"' \
      | swamp model edit e2e-caddy --json
  expect: { exitCode: 0 }
- name: upgrade-without-dnsProvider-input
  run: swamp workflow run @svendowideit/caddy-upgrade --input model=e2e-caddy
  expect:
    exitCode: 0
    outputNotContains: ["dnsRecords require a DNS provider", "skipped tls"]
    outputContains: ["Inferred DNS provider"]
```

#### T8 — `setcap-is-attempted-once` (B2)
confirms: a setup run performs exactly one `setcap` through the sudo model;
cannot: attempt it twice.
```yaml
- name: one-setcap-record
  run: |
    swamp data query 'modelName == "sudo-e2e" && name == "run"' --select content \
      | jq -s '[.[]|select(.operation=="setcap")]|length'
  expect: { stdoutContains: ["1"] }
```
(Requires `sudoInstanceKey=e2e` on the caddy model so the sudo instance name is
deterministic; asserts there is no second `setcap` run from a duplicated step.)

#### T9 — `docs-reference-only-shipped-workflows` (D1, F1) — doc lint
A test that greps the shipped `manifest.yaml`/`README.md`:
```yaml
- name: no-dangling-workflow-references
  run: |
    ! grep -nE '(swamp workflow run )?(caddy-setup|caddy-ensure-proxy)( |$)' README.md manifest.yaml \
      | grep -v '@svendowideit/'
  expect: { exitCode: 0 }
```

### 3.3 Isolation (boundary negative controls)

Add (positive group):
```yaml
isolation:
  - name: setcap-elevation-stays-in-the-sandbox
    confirms: a root-only `setcap` through the sudo ladder writes only in the sandbox
    cannot: must not create the marker on the host
    sandbox: "sudo -n sh -c 'cp /tmp/x /host-probe-$TF_RUN_ID 2>/dev/null || touch /sandbox-probe-$TF_RUN_ID'"
    absentOnHost: ["/host-probe-$TF_RUN_ID"]
```
(Plus the existing `noPublishedPorts: ["harness"]` control, kept.)

---

## 4. Issue → test map

| Issue | Test |
| ----- | ---- |
| A1 | meta-factory `upgrade-chain` gate (already) + T1 builds on it |
| A2, A4 | T1 |
| A3 | meta-factory `version-source` rule (already) |
| A5 | T9 + quality gate |
| B1 | T2 |
| B2 | T8 |
| B3 | T2, T3 |
| B4 | T3 (asserts no interactive prompt in the log) + upstream sudo fix |
| C1 | T2, T3 |
| C2 | T4 |
| C3 | T3, T6 |
| C4, C5 | T5 |
| D1 | T9 |
| D2, D3 | T7 |
| D4 | T4, T7 |
| D5 | T3, T7 |
| D6 | T2 (status page present implies admin API was reachable) |
| E1, E2, E4 | T3, T6 |
| E3 | T6 |
| F2 | (cosmetic — fix the shared message or accept) |

---

## 5. test-factory capability notes

- **Enabling change:** per-test `runAs`/`grants` (see §3.1) so one candidate file
  can carry both the positive and the degrade paths, with the harness provisioning
  one container per grant group. Until then, only the positive path is
  auto-runnable.
- **`continueOnFailure` + `expect.exitCode` as a list** are used where a step may
  legitimately return several codes (e.g. a `curl` that is expected to fail the
  cert check without `-k`).
- **Counting** the `setcap` calls (T8) relies on the sudo model's `run` data with
  a deterministic `sudoInstanceKey`; keep that key stable in the test model
  (`--global-arg sudoInstanceKey=e2e` → sudo model `sudo-e2e`).

---

## 6. Running

```sh
# Positive path (capability granted via @svendowideit/sudo). The harness runs as
# a plain user with a NOPASSWD sudo grant (harness.runAs + grants in the file):
swamp model @svendowideit/test-factory method run test tf \
  --input manifest=extensions/models/caddy/manifest.yaml \
  --input scenario=ubuntu-systemd-standalone
```

Gate CI on it:
```sh
swamp workflow run @svendowideit/test-factory \
  --input manifest=extensions/models/caddy/manifest.yaml \
  --input scenario=ubuntu-systemd-standalone
```

The degrade path (T3) becomes part of the same invocation once per-test grants
land; before that, run it by hand against a `sudo-none` container.
