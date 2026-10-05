/**
 * Test-factory harness: what to run inside a container, and how to read the
 * result.
 *
 * This module is pure. `buildHarnessScript` turns a typed {@link HarnessPlan}
 * into a POSIX `sh` script that installs swamp, registers the candidate
 * extension, and runs the requested phases; `parseHarnessResult` reads the JSON
 * the script leaves behind. The script is generated with each step written out
 * literally — the plan is known at build time — so the shell stays simple and
 * the interesting decisions are unit-testable.
 *
 * @module
 */
import { buildTestsPhaseScript } from "./tests.ts";
import type {
  Expectation,
  HarnessTest,
  StepResult,
  TestSpec,
  TestStep,
} from "./tests.ts";

// Re-exported so the public `HarnessPlan`/`HarnessResult` shapes (and the types
// nested inside them) can be named without a `private-type-ref` slow-type
// diagnostic.
export type { Expectation, HarnessTest, StepResult, TestSpec, TestStep };

/** One fixture-driven method invocation. */
export interface FixtureRun {
  /** Model type to run, e.g. `@svendowideit/github-release-install`. */
  type: string;
  /** Method name, e.g. `check`. */
  method: string;
  /** Model instance name (auto-created on first use). */
  instance: string;
  /** Method/global inputs. */
  inputs: Record<string, string>;
  /** Continue even when this run fails. */
  allowFailure: boolean;
  /** When set, stdout/stderr must contain this substring to count as matched. */
  expectContains?: string;
}

/** Everything the in-container script needs to know. */
export interface HarnessPlan {
  /** swamp release tag, or empty/`latest` to resolve the latest release. */
  swampVersion: string;
  /** Repo path inside the container. */
  repoDir: string;
  /** Where the candidate extension is mounted (read-only). */
  extensionMount: string;
  /** Directory name to copy the extension into under `<repo>/extensions`. */
  extensionName: string;
  /** Declared model types from the extension manifest. */
  modelTypes: string[];
  /** Declared workflow names from the extension manifest. */
  workflows: string[];
  /** Phases to run, in order. */
  phases: HarnessPhase[];
  /** Fixture-driven method runs (only when `fixtures` is in `phases`). */
  fixtures: FixtureRun[];
  /** Declarative acceptance tests (only when `tests` is in `phases`). */
  tests: TestSpec[];
  /** Base URL for release downloads (overridable for mirrors). */
  releaseBaseUrl: string;
  /** When true, assert systemd is running as PID 1 (`systemctl` works). */
  expectSystemd: boolean;
  /**
   * Extra shell variables exported before every test step, e.g. the addresses
   * of the candidate's declared service networks (`TF_BIND_IP`). Lets a test
   * reference the topology instead of hard-coding an address.
   */
  variables?: Record<string, string>;
  /** Install `dig`/`nslookup` in the container before the tests run. */
  dnsTools?: boolean;
  /**
   * Sibling local extensions the candidate calls at runtime, copied into the
   * harness repo and registered as extension sources before the candidate, so
   * model types from other working copies (`@svendowideit/caddy`,
   * `@svendowideit/otel-gateway`, …) exist. `mount` is the in-container path
   * the source is bind-mounted at.
   */
  extensionSources?: Array<{ name: string; mount: string }>;
}

/** A named phase of the in-container test. */
export type HarnessPhase =
  | "smoke"
  | "load"
  | "definitions"
  | "tests"
  | "fixtures";

/** Default GitHub releases base URL. */
export const DEFAULT_RELEASE_BASE =
  "https://github.com/swamp-club/swamp/releases";

/** The path the script writes its JSON result to. */
export const RESULT_PATH = "/tf/result.json";

/**
 * The script's completion marker.
 *
 * The result file is written incrementally, so its mere existence does not mean
 * the run finished. This sentinel is written last (on both the success and the
 * install-failure path) and is what the caller waits for.
 */
export const DONE_PATH = "/tf/done";

/** Quote a value for safe interpolation into a POSIX shell single-quoted word. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The release asset URL the harness downloads swamp from.
 *
 * `$SWAMP_ARCH` is left literal: the in-container script resolves it from
 * `uname -m`. Building the URL in one place keeps the generated script and the
 * recorded mechanics (below) in lockstep.
 */
export function releaseAssetUrl(base: string, version: string): string {
  const v = version && version !== "latest" ? version : "latest";
  const path = v === "latest" ? "latest/download" : `download/${v}`;
  return `${base}/${path}/swamp-linux-$SWAMP_ARCH`;
}

/**
 * What one phase proves, and the exact commands that prove it.
 *
 * This is the audit record: a phase's `claim` is the assertion a PASS stands
 * for, and `commands` are the literal command lines the generated harness runs
 * to establish it. {@link phaseClaims} and {@link buildHarnessScript} are built
 * from the same {@link HarnessPlan}, so the recorded mechanics always match the
 * script that ran.
 */
export interface PhaseClaim {
  /** Phase name (`smoke`, `load`, `definitions`, `fixtures`). */
  phase: string;
  /** The assertion a PASS on this phase demonstrates. */
  claim: string;
  /** The literal command lines the harness runs for this phase. */
  commands: string[];
}

/**
 * Describe what each requested phase proves and the commands it runs.
 *
 * Only the phases present in `plan.phases` are returned, in canonical order.
 */
export function phaseClaims(plan: HarnessPlan): PhaseClaim[] {
  const want = (p: HarnessPhase) => plan.phases.includes(p);
  const out: PhaseClaim[] = [];
  const version = plan.swampVersion && plan.swampVersion !== "latest"
    ? plan.swampVersion
    : "latest";

  if (want("smoke")) {
    const label = version === "latest"
      ? "the latest release"
      : `release ${version}`;
    out.push({
      phase: "smoke",
      claim:
        `swamp (${label}) installs and runs on the host, the candidate is ` +
        `registered as an extension source, and \`swamp doctor extensions\` ` +
        `reports pass`,
      commands: [
        `curl -fsSL -o /usr/local/bin/swamp ${
          releaseAssetUrl(plan.releaseBaseUrl, plan.swampVersion)
        }`,
        "swamp --version",
        "swamp init --tool none",
        `swamp extension source add <repo>/extensions/${plan.extensionName}`,
        "swamp doctor extensions --json",
      ],
    });
  }

  if (want("load")) {
    const types = plan.modelTypes.length > 0
      ? plan.modelTypes.join(", ")
      : "(none declared)";
    out.push({
      phase: "load",
      claim: `every model type the manifest declares is registered and ` +
        `discoverable — ${types}`,
      commands: ["swamp model type search --json"],
    });
  }

  if (want("definitions")) {
    const commands = [
      ...plan.modelTypes.map((t, i) =>
        `swamp model create ${shellQuote(t)} ${shellQuote(`tf-def-${i + 1}`)}`
      ),
      ...plan.workflows.map((w) => `swamp workflow validate ${shellQuote(w)}`),
    ];
    out.push({
      phase: "definitions",
      claim: `\`swamp model create\` succeeds for each of the ` +
        `${plan.modelTypes.length} declared model type(s), and each declared ` +
        `workflow (${plan.workflows.length}) validates as a DAG`,
      commands: commands.length > 0
        ? commands
        : ["(no model types or workflows declared)"],
    });
  }

  if (want("tests")) {
    const commands = plan.tests.flatMap((t) =>
      t.steps.map((s) => `${s.run}   # test ${t.name} · step ${s.name}`)
    );
    const names = plan.tests.map((t) => t.name).join(", ");
    out.push({
      phase: "tests",
      claim: plan.tests.length > 0
        ? `the ${plan.tests.length} documented acceptance test(s) pass — ` +
          `each step meets its exit-code and output assertions — proving: ` +
          `${names}`
        : "no test-factory.yaml tests were supplied, so this phase proves " +
          "nothing beyond what the other phases already checked",
      commands: commands.length > 0 ? commands : ["(no tests supplied)"],
    });
  }

  if (want("fixtures")) {
    const commands = plan.fixtures.map((f) => {
      const args = Object.entries(f.inputs)
        .map(([k, v]) => `--input ${k}=${v}`)
        .join(" ");
      const expect = f.expectContains
        ? `   # expects output containing ${shellQuote(f.expectContains)}`
        : "";
      return `swamp model ${shellQuote(f.type)} method run ${
        shellQuote(f.method)
      } ${shellQuote(f.instance)}${args ? " " + args : ""}${expect}`;
    });
    out.push({
      phase: "fixtures",
      claim: plan.fixtures.length > 0
        ? `the ${plan.fixtures.length} caller-supplied method run(s) execute ` +
          `and, where an expectation is given, print the expected output`
        : "no fixtures were supplied, so this phase proves nothing beyond " +
          "what the other phases already checked",
      commands: commands.length > 0 ? commands : ["(no fixtures supplied)"],
    });
  }

  return out;
}

/**
 * Build the in-container `sh` script.
 *
 * The script records failures into the result JSON instead of aborting, so a
 * run always yields a report. Only installing swamp can make later phases
 * meaningless; when it fails the script writes a diagnosis and stops.
 */
export function buildHarnessScript(plan: HarnessPlan): string {
  const want = (p: HarnessPhase) => plan.phases.includes(p);
  const lines: string[] = [];
  const push = (...l: string[]) => lines.push(...l);

  push(
    "#!/bin/sh",
    "# Generated by @svendowideit/test-factory — do not edit.",
    "set -u",
    "export SWAMP_TELEMETRY_DISABLED=1",
    'export PATH="/usr/local/bin:$PATH"',
    // On a systemd host, point `systemctl --user` (used by models such as
    // @svendowideit/caddy) at root's user-manager bus. Guarded so a non-systemd
    // host is unaffected.
    "[ -d /run/user/0 ] && export XDG_RUNTIME_DIR=/run/user/0",
    "mkdir -p /tf /usr/local/bin",
    `RESULT=${shellQuote(RESULT_PATH)}`,
    `DONE=${shellQuote(DONE_PATH)}`,
    `rm -f "$DONE"`,
    `echo '{}' > "$RESULT"`,
    'log() { echo "[tf] $*" >&2; }',
    "",
    "# append a JSON value at a dotted path is overkill: each step merges a key.",
    "record() { # record <key> <json>",
    '  jq -c --arg k "$1" --argjson v "$2" \'.[$k] = $v\' "$RESULT" > /tf/r.tmp && mv /tf/r.tmp "$RESULT"',
    "}",
    "append() { # append <key> <json>  (to an array at <key>)",
    '  jq -c --arg k "$1" --argjson v "$2" \'.[$k] = ((.[$k] // []) + [$v])\' "$RESULT" > /tf/r.tmp && mv /tf/r.tmp "$RESULT"',
    "}",
    "",
  );

  // --- 1. install swamp -----------------------------------------------------
  push(
    "# --- 1. install swamp ---------------------------------------------------",
    "ARCH=$(uname -m)",
    'case "$ARCH" in',
    "  x86_64|amd64) SWAMP_ARCH=x86_64 ;;",
    "  aarch64|arm64) SWAMP_ARCH=aarch64 ;;",
    '  *) SWAMP_ARCH="$ARCH" ;;',
    "esac",
  );
  const url = releaseAssetUrl(plan.releaseBaseUrl, plan.swampVersion);
  push(
    `SWAMP_URL="${url}"`,
    'log "downloading swamp from $SWAMP_URL"',
    'if curl -fsSL -o /usr/local/bin/swamp "$SWAMP_URL"; then',
    "  chmod +x /usr/local/bin/swamp",
    "  swamp --version >/tmp/swamp-version.txt 2>/tmp/swamp-version.err",
    "  INSTALL_CODE=$?",
    "else",
    "  INSTALL_CODE=1",
    "  echo 'download failed' >/tmp/swamp-version.err",
    "fi",
    "SWAMP_VERSION_OUT=$(cat /tmp/swamp-version.txt 2>/dev/null || echo '')",
    'if [ "$INSTALL_CODE" -ne 0 ]; then',
    "  ERR=$(cat /tmp/swamp-version.err 2>/dev/null)",
    "  if [ -f /usr/local/bin/swamp ]; then",
    "    case \"$ERR\" in *'not found'*|'')",
    '      ERR="binary downloaded but cannot execute (the swamp binary is glibc-linked, so a musl-only distro such as Alpine cannot run it): $ERR" ;;',
    "    esac",
    "  fi",
    '  jq -n --arg e "$ERR" --arg v "$SWAMP_VERSION_OUT" \'{installOk:false, installError:$e, swampVersion:$v}\' > "$RESULT"',
    '  touch "$DONE"',
    '  log "swamp failed to install: $ERR"',
    "  exit 0",
    "fi",
    'record swampVersion "$(jq -Rn --arg v "$SWAMP_VERSION_OUT" \'$v\')"',
    "record installOk true",
    "",
  );

  if (plan.expectSystemd) {
    push(
      "# --- systemd check ------------------------------------------------------",
      "if command -v systemctl >/dev/null 2>&1 && systemctl is-system-running >/dev/null 2>&1; then",
      "  SYSTEMD_STATE=$(systemctl is-system-running 2>/dev/null || echo unknown)",
      '  record systemd "$(jq -Rn --arg v "$SYSTEMD_STATE" \'$v\')"',
      '  log "systemd=$SYSTEMD_STATE"',
      "else",
      '  record systemd "\\"not-running\\""',
      '  log "systemd is not running"',
      "fi",
      "",
    );
  }
  // A model may drive a systemd *user* service (e.g. @svendowideit/caddy runs
  // `systemctl --user`). Inside a container that needs root's user manager
  // running and XDG_RUNTIME_DIR pointing at it; enable linger and wait for the
  // bus before any phase runs, so `systemctl --user` works. Guarded on
  // systemd+loginctl so other hosts are unaffected.
  if (plan.expectSystemd) {
    push(
      "# --- systemd user manager (for `systemctl --user`) ----------------------",
      "if command -v loginctl >/dev/null 2>&1; then",
      "  loginctl enable-linger root >/dev/null 2>&1 || true",
      "  i=0",
      '  while [ "$i" -lt 30 ]; do',
      "    [ -S /run/user/0/systemd/private ] && break",
      "    i=$((i+1)); sleep 1",
      "  done",
      "  [ -d /run/user/0 ] && export XDG_RUNTIME_DIR=/run/user/0",
      "  # A systemd *user* service does not inherit the container environment.",
      "  # Models that run swamp under such a service (e.g. @svendowideit/swamp-serve",
      "  # running `swamp serve`) need the account key the factory exported into the",
      "  # container, or swamp refuses to run with 'requires a swamp-club.com",
      "  # account'. Import the relevant vars into the user manager so units see them.",
      "  for V in SWAMP_API_KEY SWAMP_SIGNIN_TOKEN; do",
      '    [ -n "$(printenv "$V" 2>/dev/null)" ] && systemctl --user import-environment "$V" >/dev/null 2>&1 || true',
      "  done",
      "fi",
      "",
    );
  }

  // --- 2. init repo + register the extension --------------------------------
  const sources = plan.extensionSources ?? [];
  push(
    "# --- 2. init repo + register the extension ------------------------------",
    `REPO=${shellQuote(plan.repoDir)}`,
    `EXT_MOUNT=${shellQuote(plan.extensionMount)}`,
    `EXT_NAME=${shellQuote(plan.extensionName)}`,
    'mkdir -p "$REPO/extensions"',
    'cd "$REPO" || exit 1',
    "swamp init --tool none >/tmp/init.log 2>&1",
  );
  // Register sibling local extensions the candidate calls, so their model types
  // resolve. They are copied in (not symlinked) exactly like the candidate.
  sources.forEach((s, i) => {
    const mount = `EXT_${i + 1}_MOUNT`;
    push(
      `${mount}=${shellQuote(s.mount)}`,
      `rm -rf "$REPO/extensions/${s.name}"`,
      `cp -r "$${mount}" "$REPO/extensions/${s.name}"`,
    );
  });
  push(
    'rm -rf "$REPO/extensions/$EXT_NAME"',
    'cp -r "$EXT_MOUNT" "$REPO/extensions/$EXT_NAME"',
    "",
  );
  if (want("smoke")) {
    push(
      "SOURCE_ADD_OK=0",
    );
    for (const s of sources) {
      push(
        `swamp extension source add "$REPO/extensions/${s.name}" >/tmp/source-${s.name}.log 2>&1 || SOURCE_ADD_OK=$?`,
      );
    }
    push(
      'swamp extension source add "$REPO/extensions/$EXT_NAME" >/tmp/source-add.log 2>&1 || SOURCE_ADD_OK=$?',
      'if [ "$SOURCE_ADD_OK" -eq 0 ]; then record sourceAddOk true; else record sourceAddOk false; fi',
      "swamp doctor extensions --json >/tmp/doctor.json 2>/tmp/doctor.err",
      "DOCTOR_STATUS=$(jq -r '.overallStatus // \"unknown\"' /tmp/doctor.json 2>/dev/null || echo 'unparseable')",
      "DOCTOR_STATES=$(jq -c '[.aggregateState.aggregates[].stateDistribution] | add // {}' /tmp/doctor.json 2>/dev/null || echo '{}')",
      'record doctorStatus "$(jq -Rn --arg v "$DOCTOR_STATUS" \'$v\')"',
      'record doctorStates "$DOCTOR_STATES"',
      'log "doctor=$DOCTOR_STATUS"',
      "",
    );
  }
  if (want("load")) {
    push(
      "swamp model type search --json >/tmp/types.json 2>/dev/null || echo '{\"results\":[]}' >/tmp/types.json",
      "REGISTERED=$(jq -c '[.results[].normalized]' /tmp/types.json 2>/dev/null || echo '[]')",
      'record registeredTypes "$REGISTERED"',
      "",
    );
  }
  const modelTypesJson = JSON.stringify(plan.modelTypes);
  push(
    `MODEL_TYPES=${shellQuote(modelTypesJson)}`,
    'record modelTypes "$MODEL_TYPES"',
  );
  if (want("load")) {
    push(
      "MISSING='[]'",
      "for T in $(echo \"$MODEL_TYPES\" | jq -r '.[]'); do",
      // `printf '%s'` (not `echo`) because the container /bin/sh is dash, whose
      // builtin `echo` interprets backslash escapes and would corrupt JSON.
      "  if ! printf '%s' \"$REGISTERED\" | jq -e --arg t \"$T\" 'index($t)' >/dev/null 2>&1; then",
      "    MISSING=$(printf '%s' \"$MISSING\" | jq -c --arg t \"$T\" '. + [$t]')",
      "  fi",
      "done",
      'record missingTypes "$MISSING"',
      "",
    );
  }

  // --- 3. definitions -------------------------------------------------------
  if (want("definitions")) {
    push(
      "# --- 3. definitions -----------------------------------------------------",
    );
    let idx = 0;
    for (const type of plan.modelTypes) {
      idx++;
      const name = `tf-def-${idx}`;
      push(
        `swamp model create ${shellQuote(type)} ${
          shellQuote(name)
        } >/tmp/def-${idx}.log 2>&1`,
        `if [ $? -eq 0 ]; then`,
        `  append definitions "$(jq -cn --arg t ${shellQuote(type)} --arg n ${
          shellQuote(name)
        } '{type:$t,name:$n,ok:true}')"`,
        `else`,
        `  append definitions "$(jq -cn --arg t ${shellQuote(type)} --arg n ${
          shellQuote(name)
        } --rawfile e /tmp/def-${idx}.log '{type:$t,name:$n,ok:false,error:($e|.[0:500])}')"`,
        `fi`,
      );
    }
    for (const wf of plan.workflows) {
      const slug = wf.replace(/[^a-zA-Z0-9]+/g, "_");
      push(
        `swamp workflow validate ${shellQuote(wf)} >/tmp/wf-${slug}.log 2>&1`,
        `if [ $? -eq 0 ]; then`,
        `  append workflows "$(jq -cn --arg w ${
          shellQuote(wf)
        } '{name:$w,ok:true,status:"valid"}')"`,
        `elif grep -qi "not found\\|No workflow" /tmp/wf-${slug}.log; then`,
        `  append workflows "$(jq -cn --arg w ${
          shellQuote(wf)
        } '{name:$w,ok:true,status:"absent"}')"`,
        `else`,
        `  append workflows "$(jq -cn --arg w ${
          shellQuote(wf)
        } --rawfile e /tmp/wf-${slug}.log '{name:$w,ok:false,status:"invalid",error:($e|.[0:500])}')"`,
        `fi`,
      );
    }
    push("");
  }

  // --- 4. tests -------------------------------------------------------------
  if (want("tests")) {
    if (plan.dnsTools) {
      // The test asserts DNS records with `dig`, which the base harness image
      // does not carry. Install it here (best-effort, once per container) so a
      // candidate can request DNS tooling without a whole new image variant.
      push(
        "# --- dns tooling (dig) --------------------------------------------------",
        "if ! command -v dig >/dev/null 2>&1; then",
        "  if command -v apt-get >/dev/null 2>&1; then",
        "    apt-get update -qq >/dev/null 2>&1; DEBIAN_FRONTEND=noninteractive apt-get install -y -qq dnsutils >/dev/null 2>&1",
        "  elif command -v dnf >/dev/null 2>&1; then",
        "    dnf install -y -q bind-utils >/dev/null 2>&1",
        "  elif command -v apk >/dev/null 2>&1; then",
        "    apk add --no-cache bind-tools >/dev/null 2>&1",
        "  fi",
        "fi",
        "",
      );
    }
    push(...buildTestsPhaseScript(plan.tests, plan.variables ?? {}));
  }

  // --- 5. fixtures ----------------------------------------------------------
  if (want("fixtures")) {
    push(
      "# --- 5. fixtures ---------------------------------------------------------",
    );
    plan.fixtures.forEach((f, i) => {
      const args = Object.entries(f.inputs)
        .map(([k, v]) => `--input ${shellQuote(`${k}=${v}`)}`)
        .join(" ");
      push(
        `swamp model ${shellQuote(f.type)} method run ${shellQuote(f.method)} ${
          shellQuote(f.instance)
        } ${args} >/tmp/fix-${i}.out 2>/tmp/fix-${i}.err`,
        `FIX_CODE=$?`,
        `FIX_OK=false`,
        `[ "$FIX_CODE" -eq 0 ] && FIX_OK=true`,
        `FIX_MATCHED=null`,
      );
      if (f.expectContains) {
        push(
          `if grep -qF -- ${
            shellQuote(f.expectContains)
          } /tmp/fix-${i}.out /tmp/fix-${i}.err 2>/dev/null; then`,
          `  FIX_MATCHED=true`,
          `else`,
          `  FIX_MATCHED=false`,
          `  FIX_OK=false`,
          `fi`,
        );
      }
      push(
        `[ ${shellQuote(String(f.allowFailure))} = "true" ] && FIX_OK=true`,
        `append fixtures "$(jq -cn --arg t ${shellQuote(f.type)} --arg m ${
          shellQuote(f.method)
        } --arg i ${
          shellQuote(f.instance)
        } --argjson c "$FIX_CODE" --argjson ok "$FIX_OK" --argjson mt "$FIX_MATCHED" --rawfile o /tmp/fix-${i}.out --rawfile e /tmp/fix-${i}.err '{type:$t,method:$m,instance:$i,code:$c,ok:$ok,matched:$mt,output:(($o+$e)|.[0:2000])}')"`,
      );
    });
    push("");
  }

  push('touch "$DONE"', 'log "done"', "exit 0", "");
  return lines.join("\n");
}

/** Parsed outcome of a harness run. */
export interface HarnessResult {
  /** Whether swamp downloaded and ran. */
  installOk: boolean;
  /** Why the install failed, when it did. */
  installError?: string;
  /** The swamp version string the container reported. */
  swampVersion: string;
  /** `swamp doctor extensions` overall status (`pass`, `fail`, …). */
  doctorStatus: string;
  /** Per-kind catalog state counts from `doctor extensions --json`. */
  doctorStates: Record<string, number>;
  /** `systemctl is-system-running` output when systemd was expected. */
  systemd?: string;
  /** Whether the extension source was added successfully. */
  sourceAddOk: boolean;
  /** Model types `swamp model type search` reported as registered. */
  registeredTypes: string[];
  /** Model types the candidate manifest declares. */
  modelTypes: string[];
  /** Declared types that did not register. */
  missingTypes: string[];
  /** Per-type `swamp model create` outcomes. */
  definitions: Array<{
    /** Declared model type. */
    type: string;
    /** Instance name the create used. */
    name: string;
    /** Whether the create succeeded. */
    ok: boolean;
    /** Captured error output when it failed. */
    error?: string;
  }>;
  /** Per-workflow `swamp workflow validate` outcomes. */
  workflows: Array<{
    /** Workflow name. */
    name: string;
    /** Whether validation succeeded. */
    ok: boolean;
    /** `valid`, `absent`, or `invalid`. */
    status: string;
    /** Captured error output when invalid. */
    error?: string;
  }>;
  /** Fixture-driven method-run outcomes. */
  fixtures: Array<{
    /** Model type. */
    type: string;
    /** Method name. */
    method: string;
    /** Model instance name. */
    instance: string;
    /** Process exit code. */
    code: number;
    /** Whether the run met its expectation. */
    ok: boolean;
    /** Whether the expected substring was found (`null` when none required). */
    matched: boolean | null;
    /** Combined stdout/stderr (tail-capped). */
    output: string;
  }>;
  /** Declarative acceptance test outcomes (no prose — merged later). */
  tests: HarnessTest[];
}

/** Parse the JSON result the harness script wrote. */
export function parseHarnessResult(text: string): HarnessResult {
  const parsed = JSON.parse(text) as Partial<HarnessResult>;
  return {
    installOk: parsed.installOk ?? false,
    installError: parsed.installError,
    swampVersion: parsed.swampVersion ?? "",
    doctorStatus: parsed.doctorStatus ?? "unknown",
    doctorStates: parsed.doctorStates ?? {},
    systemd: parsed.systemd,
    sourceAddOk: parsed.sourceAddOk ?? false,
    registeredTypes: parsed.registeredTypes ?? [],
    modelTypes: parsed.modelTypes ?? [],
    missingTypes: parsed.missingTypes ?? [],
    definitions: parsed.definitions ?? [],
    workflows: parsed.workflows ?? [],
    fixtures: parsed.fixtures ?? [],
    tests: parsed.tests ?? [],
  };
}

/**
 * Parse a fixtures file into {@link FixtureRun} entries.
 *
 * Accepts a JSON array, or a small YAML list where per-run inputs use a flat
 * `input.<key>: <value>` form (keeps the parser dependency-free):
 *
 * ```yaml
 * - type: "@acme/thing"
 *   method: check
 *   instance: fix-one
 *   input.repo: owner/name
 *   expectContains: ok
 * ```
 */
export function parseFixtures(text: string): FixtureRun[] {
  const trimmed = text.trim();
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as Partial<FixtureRun>[];
    return parsed.map(normalizeFixture);
  }
  const runs: Array<Partial<FixtureRun> & { inputs?: Record<string, string> }> =
    [];
  let current:
    | (Partial<FixtureRun> & { inputs?: Record<string, string> })
    | null = null;
  for (const raw of trimmed.split("\n")) {
    const line = raw.replace(/\s+#.*$/, "");
    if (!line.trim()) continue;
    const item = /^\s*-\s+(.+)$/.exec(line);
    if (item) {
      current = { inputs: {} };
      runs.push(current);
      assignFixture(current, item[1]);
      continue;
    }
    const kv = /^\s+(.+)$/.exec(line);
    if (kv && current) assignFixture(current, kv[1]);
  }
  return runs.map(normalizeFixture);
}

/** Assign one `key: value` line onto a fixture being built. */
function assignFixture(
  target: Partial<FixtureRun> & { inputs?: Record<string, string> },
  line: string,
): void {
  const m = /^([\w.]+):\s*(.*)$/.exec(line);
  if (!m) return;
  const [, key, raw] = m;
  const value = raw.replace(/^["']|["']$/g, "");
  if (key.startsWith("input.")) {
    target.inputs = target.inputs ?? {};
    target.inputs[key.slice("input.".length)] = value;
  } else if (key === "allowFailure") {
    target.allowFailure = value === "true";
  } else if (key === "type" || key === "method" || key === "instance") {
    target[key] = value;
  } else if (key === "expectContains") {
    target.expectContains = value;
  }
}

/** Fill defaults for a partial fixture from a file. */
export function normalizeFixture(
  f: Partial<FixtureRun> & { inputs?: Record<string, string> },
): FixtureRun {
  return {
    type: f.type ?? "",
    method: f.method ?? "",
    instance: f.instance ?? "tf-fixture",
    inputs: f.inputs ?? {},
    allowFailure: f.allowFailure ?? false,
    expectContains: f.expectContains,
  };
}

const PHASE_ORDER: HarnessPhase[] = [
  "smoke",
  "load",
  "definitions",
  "tests",
  "fixtures",
];

/** Human-readable phase labels, in order. */
export function phaseLabel(phase: HarnessPhase): string {
  switch (phase) {
    case "smoke":
      return "smoke (install + doctor)";
    case "load":
      return "load (types register)";
    case "definitions":
      return "definitions (create + validate)";
    case "tests":
      return "tests (documented outcomes)";
    case "fixtures":
      return "fixtures (run methods)";
  }
}

/** Phase labels in canonical order. */
export function allPhaseLabels(): string[] {
  return PHASE_ORDER.map(phaseLabel);
}

/**
 * Evaluate a harness result against the phases a scenario requested.
 *
 * Returns a per-phase `ok` map plus the failing phases, so the report can show
 * exactly which layer broke (doctor, type registration, definition creation, or
 * a method run) rather than a single opaque pass/fail. A scenario marked
 * `expected: fail` passes precisely when the run does not succeed.
 */
export function evaluateResult(
  result: HarnessResult,
  phases: HarnessPhase[],
  expected: "pass" | "fail",
  expectSystemd = false,
): {
  phases: Array<{ phase: string; ok: boolean; detail: string }>;
  ok: boolean;
  errors: string[];
} {
  const out: Array<{ phase: string; ok: boolean; detail: string }> = [];
  const errors: string[] = [];
  const want = (p: HarnessPhase) => phases.includes(p);
  const expectPass = expected === "pass";

  let systemdOk = true;
  if (expectSystemd && result.installOk) {
    const state = result.systemd ?? "not-running";
    systemdOk = state === "running" || state === "degraded";
    out.push({ phase: "systemd", ok: systemdOk, detail: `systemd: ${state}` });
    if (!systemdOk && expectPass) errors.push(`systemd not running: ${state}`);
  }

  if (!result.installOk) {
    const detail = result.installError?.trim() ||
      "swamp could not be installed";
    // A scenario that *expects* failure passes when swamp is un-runnable.
    out.push({ phase: "smoke", ok: !expectPass, detail: `install: ${detail}` });
    if (want("smoke") && expectPass) errors.push(`install: ${detail}`);
    return { phases: out, ok: !expectPass, errors };
  }

  const smokeOk = result.sourceAddOk && result.doctorStatus === "pass";
  out.push({
    phase: "smoke",
    ok: smokeOk,
    detail: result.sourceAddOk
      ? `doctor: ${result.doctorStatus}`
      : "extension source could not be added",
  });
  if (want("smoke") && !smokeOk && expectPass) {
    errors.push(`smoke: doctor=${result.doctorStatus}`);
  }

  const loadOk = result.missingTypes.length === 0;
  out.push({
    phase: "load",
    ok: loadOk,
    detail: loadOk
      ? `${result.modelTypes.length} type(s) registered`
      : `missing types: ${result.missingTypes.join(", ")}`,
  });
  if (want("load") && !loadOk && expectPass) {
    errors.push(`load: missing ${result.missingTypes.join(", ")}`);
  }

  const failedDefs = result.definitions.filter((d) => !d.ok);
  const invalidWfs = result.workflows.filter((w) => !w.ok);
  const defsOk = failedDefs.length === 0 && invalidWfs.length === 0;
  out.push({
    phase: "definitions",
    ok: defsOk,
    detail: defsOk
      ? `${result.definitions.length} definition(s), ${result.workflows.length} workflow(s)`
      : [
        ...failedDefs.map((d) => `create ${d.type}: ${d.error ?? "failed"}`),
        ...invalidWfs.map((w) => `workflow ${w.name}: ${w.error ?? "invalid"}`),
      ].join("; "),
  });
  if (want("definitions") && !defsOk && expectPass) {
    errors.push(`definitions: ${out[out.length - 1].detail}`);
  }

  if (want("tests")) {
    const failedTests = result.tests.filter((t) => !t.ok);
    const testsOk = failedTests.length === 0 && result.tests.length > 0;
    const detail = result.tests.length === 0
      ? "no test-factory.yaml tests supplied"
      : testsOk
      ? `${result.tests.length} documented test(s) passed`
      : failedTests.map((t) => {
        const bad = t.steps.find((s) => !s.ok);
        return `${t.name}: step "${bad?.name ?? "?"}" failed`;
      }).join("; ");
    out.push({ phase: "tests", ok: testsOk, detail });
    if (want("tests") && !testsOk && expectPass) {
      errors.push(`tests: ${detail}`);
    }
  }

  if (want("fixtures")) {
    const failedFix = result.fixtures.filter((f) => !f.ok);
    const fixOk = failedFix.length === 0 && result.fixtures.length > 0;
    const detail = result.fixtures.length === 0
      ? "no fixtures declared"
      : fixOk
      ? `${result.fixtures.length} fixture(s) ran`
      : failedFix.map((f) => `${f.type}/${f.method}: exit ${f.code}`).join(
        "; ",
      );
    out.push({ phase: "fixtures", ok: fixOk, detail });
    if (!fixOk && expectPass) errors.push(`fixtures: ${detail}`);
  }

  const ran = out.every((p) => p.ok);
  const ok = expectPass ? ran : !ran;
  return { phases: out, ok, errors };
}
