# Caddy extension — behavioural scenario test matrix

Goal: a catalogue of tests that show `@svendowideit/caddy` **copes correctly
with every user and configuration situation** — not just that past bugs stay
fixed. Each scenario states the situation, what the extension must do, the
**measured** observable outcome, and how a `test-factory` test expresses it.

Three invariants must hold in *every* row below:

- **I1 — never lose intent.** Desired state (routes, TLS, DNS records, port/TLS
  preferences, status page) is persisted regardless of whether it can be applied
  right now.
- **I2 — always serve something.** Reconcile never rejects the whole config; it
  applies as much as the host allows (degrading ports when necessary).
- **I3 — never lie.** Every reported fact (listens, scheme, hostnames,
  capability, certs issued, service state) is **measured**, never derived from
  desired settings; when it cannot measure, it says so.

Legend: **TF** = expressible in `test-factory` today (given the per-test
`runAs`/`grants` enhancement from the companion plan); **TF+** = needs a new
test-factory capability noted in §14.

---

## 1. Elevation availability — install and upgrade

| # | Given | Action | Expected (measured) | TF |
| - | ----- | ------ | ------------------- | -- |
| E1 | harness user, `sudo-nopasswd` | `caddy-setup` | setcap via `sudo-n`; **service restarted**; `getcap` shows the cap; live listens `:443,:80`; `curl -k https://localhost/` = status HTML | TF |
| E2 | `doas-nopasswd` | `caddy-setup` | setcap via the `doas` route; same result | TF |
| E3 | `sudo-interactive-only` | `caddy-setup` | **no prompt / no hang**; setcap fails closed; degrade to `:8080/:8443` plain HTTP; report names the tried routes and the fix; exit 0 | TF |
| E4 | `sudo-none` | `caddy-setup` | as E3 (fail-closed), and the report **never** prints an `https://…` URL for the public host | TF |
| E5 | harness `root` | `caddy-setup` | cap applied (root/held-capability route); `:443` binds | TF |
| E6 | binary pre-granted (`getcap` set) before the run | `caddy-setup` | sudo extension's held-capability route is selected; no elevation needed | TF |
| E7 | existing install with cap; edit `plugins` | `installCaddy` | rebuilds; **re-grants cap**; restarts; `:443` still binds | TF |
| E8 | existing install with cap; replace binary, no route | `upgradeCaddy` | cap dropped → re-grant fails → degrade applied; report says capability absent, not "ready" | TF |
| E9 | any | `caddy-setup` | exactly **one** `setcap` through the sudo model (`swamp data query` on `sudo-<key>/run` counts 1) | TF |
| E10 | service already running, cap newly granted | `setCapabilities` | the **running** process is restarted so the cap takes effect (assert via a live `:443` connect, not just `getcap`) | TF |
| E11 | `sudo-none`, then grant `sudo-nopasswd` and re-run | `setCapabilities` → `normalizeServingSettings` | ports move up to `:443,:80`; a live `:443` connect succeeds | TF |

## 2. Partial configuration

| # | Given | Action | Expected (measured) | TF |
| - | ----- | ------ | ------------------- | -- |
| P1 | only `baseDomain` | `caddy-setup` | status page on localhost; gap report: ACME email missing; no cert claimed | TF |
| P2 | only `letsEncryptEmail` | `caddy-setup` | gap report: base domain missing; status page on localhost | TF |
| P3 | neither domain nor email | any mutate | status page + health on localhost; "no hostnames configured" | TF |
| P4 | `plugins` DNS driver, no `environmentFile` | `configureTls` | provider inferred; report names the env file to create; no false success | TF |
| P5 | `dnsRecords` declared, no provider | `configureStatusPage` | reconcile **skips** records (no `dns_records` app), status page still served, exit 0 | TF |
| P6 | then provider configured | `applyDnsRecords` | records appear in BIND (`dig`) | TF |
| P7 | `subjects` given, host behind NAT (HTTP-01 impossible) | `configureTls` | TLS configured; cert **not** issued; report says configured-not-issued | TF+ |
| P8 | `subjects` include the base-domain apex | `configureTls` | apex pruned; wildcard/subdomains kept | TF |
| P9 | a route under `baseDomain`, defaults on | `ensureDnsProxy` | subject derived; A record derived (pointing at `routeIp`/existing) | TF |
| P10 | `autoRouteTls=false`, `autoRouteDns=false` | `ensureDnsProxy` | route added, **no** subject/record derived | TF |
| P11 | invalid `letsEncryptEmail` | any checked method | pre-flight `valid-config` fails with the field named | TF |

## 3. Configuration mismatch / drift

| # | Given | Action | Expected (measured) | TF |
| - | ----- | ------ | ------------------- | -- |
| M1 | model `listenAddrs` edited | next mutate | live listens change; `plan` drift clears | TF |
| M2 | `autoHttps` on→off | next mutate | live server reflects it; report scheme flips | TF |
| M3 | a swamp route deleted from the live config by hand | `audit`/`plan`, then mutate | drift reported (onlyActual/onlyDesired); mutate restores it | TF |
| M4 | model `plugins` gains a module | `installCaddy` | rebuild detected (`missingPluginsBeforeBuild`), binary rebuilt, service restarted | TF |
| M5 | desired TLS email/provider changed | `configureTls` | applied to the live `tls` app | TF |
| M6 | two models, same host, different upstream | any mutate/`audit` | **conflict reported naming both models**, not silently resolved | TF |
| M7 | two models, differing TLS email/provider | any mutate | conflict reported naming both models | TF |
| M8 | second model with a different `serviceName` | `caddy-setup` | separate Caddy; no merge | TF |
| M9 | an `audit`/`plan` scratch instance exists | `upgradeTargets` | scratch instances never listed as real models | TF |
| M10 | `serviceName` collides with a non-swamp service | any mutate | clear error, existing service untouched | TF+ |

## 4. Non-swamp-managed config injection

| # | Given | Action | Expected (measured) | TF |
| - | ----- | ------ | ------------------- | -- |
| F1 | a hand-added (untagged) route in the live config | any mutate | preserved; swamp routes tagged `@id`, foreign kept | TF |
| F2 | hand-edited `Caddyfile` with a site block | `createService`+`startService` | the foreign site is preserved through reconcile | TF |
| F3 | `autosave.json` holding foreign config | restart then mutate | Caddy resumes it; reconcile merges without clobbering | TF |
| F4 | foreign listener (e.g. a hand-added server) | any mutate | untouched | TF+ |
| F5 | a swamp route removed by hand | mutate | restored (tagged), not duplicated | TF |
| F6 | an **older-version** status route (no `@id`) | mutate | recognised as generated; not duplicated | TF |

## 5. DNS reconciliation and timing

| # | Given | Action | Expected (measured) | TF |
| - | ----- | ------ | ------------------- | -- |
| D1 | provider + records | `applyDnsRecords` | A/AAAA/CNAME written via rfc2136; `dig @bind` proves | TF |
| D2 | edit/prune/remove records | `applyDnsRecords` | RRset replaced exactly; removals delete the RRset | TF |
| D3 | `dnsTtl` set | `applyDnsRecords` | TTL applied (assert `dig` TTL) | TF |
| D4 | no provider | `applyDnsRecords` (explicit) | clear error naming `configureTls`; reconcile path never rejects | TF |
| D5 | wrong TSIG/token | `applyDnsRecords` | **enriched, actionable** credential error (not an opaque 500) | TF |
| D6 | record written, zone not yet propagated | `audit` | reports authoritative value vs public propagation; **no** false "reachable" | TF+ |
| D7 | record exists with a different value | `applyDnsRecords` | replaced (Caddy owns the name+type RRset) | TF |
| D8 | `dnsRemovals` for an absent record | `applyDnsRecords` | no-op, exit 0 | TF |
| D9 | `plugins`+`environmentFile`, no `dnsProvider` passed | `configureTls` | provider + field map inferred (`Inferred DNS provider`); records then apply | TF |
| D10 | multi-field provider (key_name/key_alg/server/…) | `configureTls` | all fields mapped from env var names | TF |

## 6. Certificate reconciliation and timing

| # | Given | Action | Expected (measured) | TF |
| - | ----- | ------ | ------------------- | -- |
| C1 | `issuer=internal` | `configureTls` + request | local CA issues synchronously; `curl -k https://host/` serves TLS | TF |
| C2 | ACME DNS-01, but ACME unreachable | `configureTls` + request | **cert not issued**; report distinguishes "configured" from "issued" (reads Caddy's cert dir) | TF+ |
| C3 | issuance is asynchronous | request, then poll | before issuance: "not yet"; after the challenge completes: "issued" (the transition is reported, not assumed) | TF+ |
| C4 | HTTP-01 host unreachable from the internet | `configureTls` | report: HTTP-01 cannot succeed here; DNS-01 (or internal) required | TF+ |
| C5 | wildcard `*.domain` | `configureTls` | report: wildcard requires DNS-01; HTTP-01 is impossible | TF |
| C6 | a subject with no route/record | `configureTls` | report: Caddy won't request it (only names in a route match get certs) | TF |

## 7. Bind / port modes

| # | Given | Action | Expected (measured) | TF |
| - | ----- | ------ | ------------------- | -- |
| B1 | cap present, `autoHttps=on` | mutate | listens `:443,:80`; HTTPS | TF |
| B2 | no cap | mutate | listens `:8080,:8443`, plain HTTP; status page still served; report measured | TF |
| B3 | cap granted after degrade | `setCapabilities`→`normalizeServingSettings` | moves up to `:443,:80`; live `:443` connect succeeds | TF |
| B4 | foreign process already bound to `:80` | mutate | cannot bind → degrade applied (or clear error); report measured, no crash | TF+ |
| B5 | `autoHttps=off`, high ports | mutate | plain HTTP by design; report says so | TF |
| B6 | `adminApiAddr=unix//run/user/…` | mutate/`checkHealth` | admin via unix socket; status page links the socket correctly | TF |

## 8. Service lifecycle

| # | Given | Action | Expected (measured) | TF |
| - | ----- | ------ | ------------------- | -- |
| S1 | no unit written yet | `startService` | clear error (run `createService` first), not a hang | TF |
| S2 | unit written, not started | `startService` | starts, **waits for the admin API** (no false "unreachable") | TF |
| S3 | active, config unchanged | any mutate | no-op; `changed=false` | TF |
| S4 | stopped | `startService`; `upgradeCheck` | starts; gap report lists `service-inactive` with the fix | TF |
| S5 | stale `autosave.json` (crash-loop) | `installCaddy`/`upgradeCaddy` | does **not** claim success; prints the `journalctl` + autosave hint | TF |
| S6 | unit regenerated (`environmentFile` changed) | `createService`+restart | the running process loads the new unit/env file | TF |
| S7 | service down | `upgradeCheck` | "could not measure the running config …", **no** serving claim | TF |

## 9. Multiple models / instances

| # | Given | Action | Expected (measured) | TF |
| - | ----- | ------ | ------------------- | -- |
| X1 | two models, same target | mutate either | routes **union**; neither loses the other's routes | TF |
| X2 | second model, other `serviceName` | mutate | independent Caddy | TF |
| X3 | `target=remote` | mutate | separate identity; no merge with the local one | TF+ |
| X4 | `reconcile=false` | mutate | only this model's config written | TF |

## 10. Workflows

| # | Given | Action | Expected (measured) | TF |
| - | ----- | ------ | ------------------- | -- |
| W1 | one model | `caddy-setup` | one-command setup, correct order, exit 0 | TF |
| W2 | one model | `caddy-upgrade` | auto-discovers; runs without `--input model` | TF |
| W3 | several models | `caddy-upgrade` | lists them, **changes nothing**, prints per-model command | TF |
| W4 | already up to date | `caddy-upgrade` | no approval gate; reports DONE; no mutation | TF |
| W5 | not up to date | `caddy-upgrade` | suspends at the gate; reject leaves it unchanged | TF |
| W6 | any | re-run twice | second run is a genuine no-op | TF |

## 11. Reporting honesty (cross-cutting — assert in each of the above)

| # | Check | Expected |
| - | ----- | -------- |
| R1 | degraded run | output contains **no** `https://<public-host>` claim |
| R2 | any run | reported listen set/scheme == `curl localhost:2019/config` |
| R3 | any run | status-page "Privileged ports" line == `getcap` result |
| R4 | any run | status-page version/plugins == the binary's (`caddy version`, `list-modules`) |
| R5 | gap report | "ready — nothing blocks" printed **only** when the live config is actually serving as desired |
| R6 | admin API down | no serving section at all; an explicit "could not measure" |

## 12. Idempotency and retry

| # | Given | Action | Expected |
| - | ----- | ------ | -------- |
| I1 | any settled model | run every method a second time | no live-config change (`changed=false`) |
| I2 | install interrupted mid-way | re-run `caddy-setup` | converges to the same end state |
| I3 | DNS/cert not yet converged | re-run reconcile after the delay | converges; report updates from measured facts |

---

## 13. Mapping to test-factory files

- **Positive group** (`sudo-nopasswd`, `runAs: tester`): E1, E2, E5, E6, E7,
  E9, E10, E11, P1–P6, P8–P11, M1–M5, M7–M9, F1–F3, F5, F6, D1–D5, D7–D10,
  C1, B1, B3, B5, B6, S1–S4, S6, X1, X2, X4, W1–W6, I1, I2.
- **Degrade group** (`sudo-none`, `runAs: tester`): E3, E4, E8, B2, S7, and R1/R5.
- **External-ACME / timing group** (needs §14): C2–C6, D6, P7, B4, M10, X3.

## 14. test-factory capabilities this matrix needs

1. **Per-test `runAs`/`grants`** (from the companion plan) so the positive and
   degrade groups coexist in one candidate file.
2. **Fault injection steps** — already expressible with `curl` against the admin
   API (`POST/DELETE /config/…`), the systemd unit (`systemctl --user`), and
   `getcap`/`setcap`; no change needed.
3. **A controllable ACME/DNS endpoint** for C2/C3/C4/D6 — the harness needs a
   stub ACME server (or a DNS-01 provider whose zone is the local BIND with a
   *deliberately delayed* dynamic-update acceptance) so "not yet issued" and
   "issued" are both observable in a test. Proposal: a `test/acme-stub` service
   in the topology that can be toggled to accept/reject/delay a challenge.
4. **A pre-bound port fixture** (B4): a step that starts a listener on `:80`
   before `startService`.
5. **`unix`-socket admin** (B6): supported already; assert with
   `curl --unix-socket`.

## 15. Priority order (highest-value first)

1. E1 (capability path end-to-end), E3/E4 (no-route fail-closed), E10 (cap takes
   effect), I2 (interrupted install) — the failures that actually bit.
2. P5/P6 (partial DNS), M3/M6 (drift + conflict), F1/F3 (foreign config) — the
   everyday user situations.
3. R1–R6 (honesty) — asserted across all rows.
4. C2/C3/D6 (async timing) — require the ACME stub (§14.3).
