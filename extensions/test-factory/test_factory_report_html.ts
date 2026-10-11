/**
 * HTML report for `@svendowideit/test-factory` — renders a scenario result or
 * the fan-out rollup as a **single self-contained HTML page** a human can read
 * and verify.
 *
 * It is the human-facing companion to `@svendowideit/test-factory-report`: that
 * report emits Markdown/JSON, this one writes a `.html` file (and still returns
 * Markdown/JSON) with:
 *
 *   - a summary header (candidate, distro/topology, swamp version, verdict and
 *     pass/fail/error counts),
 *   - a results matrix,
 *   - collapsible `<details>` sections per documented test, each expanding to the
 *     exact commands that ran and their captured stdout/stderr,
 *   - a coverage block, and
 *   - a footer carrying a hash of the source JSON the page was rendered from, so
 *     a reader can confirm the page matches the stored data.
 *
 * The page uses inline CSS only — no external assets, CDN or JS framework — so it
 * opens offline, archives cleanly and diffs readably. All captured output is
 * HTML-escaped and shown verbatim.
 *
 * Output location: `$SWAMP_TEST_FACTORY_HTML_DIR`, else
 * `~/.local/share/test-factory-report/`. A stable `<slug>-latest.html` is written
 * alongside each timestamped file. The absolute path is returned in the JSON so a
 * workflow or CI can publish it.
 *
 * @module
 */

const REPORT_NAME = "@svendowideit/test-factory-report-html";

type DataHandle = {
  name: string;
  specName: string;
  kind: string;
  version?: number;
};

type MethodReportContext = {
  scope: "method";
  modelType: string;
  modelId: string;
  definition: { name: string };
  methodName: string;
  executionStatus: "succeeded" | "failed";
  errorMessage?: string;
  dataHandles: DataHandle[];
  globalArgs?: Record<string, unknown>;
  dataRepository: {
    getContent: (
      type: string,
      modelId: string,
      dataName: string,
      version?: number,
    ) => Promise<Uint8Array | null>;
  };
  logger: { info: (msg: string, props?: Record<string, unknown>) => void };
};

type Rec = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Small coercions (defensive — the resource shapes are broad)
// ---------------------------------------------------------------------------

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function rec(v: unknown): Rec | null {
  return v && typeof v === "object" && !Array.isArray(v) ? v as Rec : null;
}

// ---------------------------------------------------------------------------
// HTML building blocks
// ---------------------------------------------------------------------------

/** Escape text for safe insertion into HTML (element content and attributes). */
export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** A status pill. `kind` is one of pass|fail|error|skip|info. */
function badge(kind: string, label?: string): string {
  const k = ["pass", "fail", "error", "skip", "info"].includes(kind)
    ? kind
    : "info";
  const text = label ?? k.toUpperCase();
  return `<span class="badge ${k}">${escapeHtml(text)}</span>`;
}

/** The badge for a boolean outcome (PASS/FAIL). */
function okBadge(ok: unknown): string {
  return ok === true ? badge("pass") : badge("fail");
}

/** A `<pre>` block, escaped, with an optional caption. */
function pre(text: unknown, caption?: string): string {
  const body = str(text);
  if (!body) return "";
  const cap = caption ? `<div class="cap">${escapeHtml(caption)}</div>` : "";
  return `${cap}<pre>${escapeHtml(body)}</pre>`;
}

/** A `<details>` wrapper, open by default when `open` is true. */
function details(
  summaryHtml: string,
  bodyHtml: string,
  open = false,
): string {
  return `<details${
    open ? " open" : ""
  }><summary>${summaryHtml}</summary><div class="dbody">${bodyHtml}</div></details>`;
}

/** Render a plain table from headers and already-escaped cell rows. */
function table(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return "";
  const head = headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("");
  const body = rows
    .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
    .join("");
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function claimText(c: Rec): string {
  return `${str(c.phase)}`;
}

/** "What this run proves" + "How it was proved" — the literal commands. */
function claimsHtml(claims: Rec[], hasEvidence: boolean): string {
  if (claims.length === 0) return "";
  const list = claims
    .map((c) =>
      `<li><b>${escapeHtml(claimText(c))}</b> — ${escapeHtml(c.claim)}</li>`
    )
    .join("");
  const out = `<h3>What this run proves</h3><ul class="claims">${list}</ul>`;
  if (hasEvidence) return out;
  const blocks = claims.map((c) =>
    details(
      `<span class="mono">${escapeHtml(claimText(c))}</span>`,
      `<div class="cap">Planned commands</div><pre>${
        escapeHtml(arr(c.commands).map((x) => str(x)).join("\n"))
      }</pre>`,
    )
  ).join("");
  return out +
    `<h3>Planned commands</h3><p class="muted">The harness script's commands from the plan. This run recorded no captured output, so these are the plan, not evidence.</p>${blocks}`;
}

/** The pass/fail rule behind each phase, so a reader knows what decided it. */
const PHASE_BASIS: Record<string, string> = {
  smoke:
    "PASS when the swamp binary installs and runs and `swamp doctor extensions` reports `pass`.",
  load:
    "PASS when every model type the manifest declares is registered (none missing).",
  definitions:
    "PASS when every `swamp model create` and `swamp workflow validate` succeeds.",
  fixtures:
    "PASS when every caller-supplied method run succeeds (and prints its expected substring, when one is given).",
  tests:
    "PASS when every documented test step meets its exit-code and output assertions.",
};

/**
 * "Evidence" — the commands the harness actually ran, grouped by phase, each
 * expandable to its real exit code and captured stdout/stderr. This is the
 * record behind each phase's pass/fail; the rule is stated per phase.
 */
function evidenceHtml(r: Rec): string {
  const ev = arr(r.evidence) as Rec[];
  if (ev.length === 0) return "";
  const byPhase = new Map<string, Rec[]>();
  for (const e of ev) {
    const p = str(e.phase, "—");
    if (!byPhase.has(p)) byPhase.set(p, []);
    byPhase.get(p)!.push(e);
  }
  const sections: string[] = [];
  for (const [phase, steps] of byPhase) {
    const basis = PHASE_BASIS[phase];
    const rows = steps.map((s) => [
      `<span class="mono">${escapeHtml(s.cmd)}</span>`,
      Number(s.exitCode) === 0
        ? badge("pass", "exit 0")
        : badge("fail", `exit ${escapeHtml(num(s.exitCode))}`),
    ]);
    const blocks = steps.map((s) => {
      const ok = Number(s.exitCode) === 0;
      const body = pre(s.cmd, "Command") +
        pre(s.stdout, "stdout") +
        pre(s.stderr, "stderr");
      return details(
        `${ok ? badge("pass") : badge("fail")} <span class="mono">${
          escapeHtml(s.cmd)
        }</span> <span class="muted">exit ${
          escapeHtml(num(s.exitCode))
        }</span>`,
        body,
      );
    }).join("");
    sections.push(
      `<h4 class="phase">${escapeHtml(phase)}</h4>` +
        (basis ? `<p class="muted basis">${escapeHtml(basis)}</p>` : "") +
        table(["Command", "Exit"], rows) +
        blocks,
    );
  }
  return `<h3>Evidence — commands actually run</h3><p class="muted">Each command expands to its real exit code and captured output. This is the record the phases were judged on.</p>${
    sections.join("")
  }`;
}

/** Documented acceptance tests, each an expandable section with commands+output. */
/**
 * Classify a step by what it does, so the reader knows the role of each
 * command: `setup` (`swamp init`/`model create`/`source add`), the `action
 * under test` (any other `swamp …`), or `independent verification` (a non-swamp
 * command — `stat`, `find`, a host probe — whose output is the real evidence).
 */
function stepRole(cmd: string): { label: string; cls: string } {
  const c = cmd.trim();
  if (/^swamp\s+(init|model\s+create|extension\s+source\s+add)\b/.test(c)) {
    return { label: "setup", cls: "setup" };
  }
  if (/^swamp(\s|$)/.test(c)) {
    return { label: "action under test", cls: "action" };
  }
  return { label: "independent verification", cls: "verify" };
}

/**
 * Documented tests, written so a reader can reproduce them. Each test shows:
 * the environment it ran in, the contract (should / should not happen), a
 * copy-paste block of the exact commands, and then every command with its real
 * stdout/stderr, exit code and the assertions that were checked. Steps are
 * labelled `setup` / `action under test` / `independent verification`; a test
 * with no independent verification is flagged.
 */
function testsHtml(tests: Rec[], result: Rec): string {
  if (tests.length === 0) return "";
  const passed = tests.filter((t) => t.ok === true).length;
  const iso = rec(result.harnessIsolation);
  const ctx = [
    `scenario <b>${escapeHtml(str(result.scenario))}</b>`,
    `<b>${escapeHtml(str(result.distro))}${
      result.systemd ? " + systemd" : ""
    }</b>`,
    iso && str(iso.whoami)
      ? `run as <b>${escapeHtml(str(iso.whoami))}</b>${
        str(iso.uid) ? ` (uid ${escapeHtml(str(iso.uid))})` : ""
      }`
      : "",
    `repo at <code>/work/repo</code>`,
  ].filter((x) => x !== "").join(" · ");

  const rows = tests.map((t) => {
    const steps = arr(t.steps) as Rec[];
    const okSteps = steps.filter((s) => s.ok === true).length;
    const indep = steps.filter((s) => stepRole(str(s.run)).cls === "verify")
      .length;
    return [
      `<span class="mono">${escapeHtml(t.name)}</span>`,
      okBadge(t.ok),
      `${okSteps}/${steps.length}`,
      indep > 0 ? `${indep}` : `<span class="warn">0</span>`,
    ];
  });

  const cards = tests.map((t) => {
    const steps = arr(t.steps) as Rec[];
    const okSteps = steps.filter((s) => s.ok === true).length;
    const indep = steps.filter((s) => stepRole(str(s.run)).cls === "verify")
      .length;

    const contract = `<div class="contract">` +
      `<p class="should"><b>Should happen:</b> ${escapeHtml(t.confirms)}</p>` +
      `<p class="should-not"><b>Should NOT happen:</b> ${
        escapeHtml(t.cannot)
      }</p></div>`;

    const repro = `<h5>Reproduce — the exact commands</h5>` +
      `<p class="muted">These are the literal commands the test ran in the scenario container (${ctx}). The action and verification commands are copy-pasteable; the verification commands work on your own system once the action has run there.</p>` +
      `<pre>${escapeHtml(steps.map((s) => str(s.run)).join("\n"))}</pre>`;

    const detail =
      `<h5>Commands run inside the test environment — with output</h5>` +
      `<ol class="cmdlist">` +
      steps.map((s, i) => {
        const role = stepRole(str(s.run));
        const matched = arr(s.matched).map((m) => str(m));
        const assertions = matched.length > 0
          ? `<div class="cap">Checked</div><ul class="assertions">${
            matched.map((m) => `<li>${escapeHtml(m)}</li>`).join("")
          }</ul>`
          : "";
        return `<li><div class="stephead">` +
          `<span class="tag ${role.cls}">${role.label}</span> ` +
          `${okBadge(s.ok)} <span class="mono">${escapeHtml(s.name)}</span> ` +
          `<span class="muted">step ${i + 1} · exit ${
            escapeHtml(num(s.exitCode))
          }</span></div>` +
          pre(s.run, "Command") +
          pre(s.stdout, "stdout") +
          pre(s.stderr, "stderr") +
          assertions +
          `</li>`;
      }).join("") +
      `</ol>`;

    const indepNote = indep === 0
      ? `<p class="warn">No independent verification — every step is a swamp command, so this test only confirms swamp reported success; it does not independently show the effect.</p>`
      : "";

    const summaryHtml =
      `${okBadge(t.ok)} <span class="mono">${escapeHtml(t.name)}</span> ` +
      `<span class="muted">${okSteps}/${steps.length} steps · ${indep} independent</span>`;
    return `<details class="test" open><summary>${summaryHtml}</summary>` +
      `<div class="dbody"><div class="ctx">${ctx}</div>${contract}${indepNote}${repro}${detail}</div>` +
      `</details>`;
  }).join("");

  return `<h3>Documented tests — ${passed}/${tests.length} passed</h3>` +
    table(["Test", "Result", "Steps", "Independent checks"], rows) +
    `<p class="muted">Each test states what <b>should</b> and <b>should not</b> happen, then shows the exact commands run in the test environment with their real output. <b>Independent verification</b> steps run a non-swamp command (<code>stat</code>, <code>find</code>, a host-side probe, …) whose output proves the effect — that is the evidence; <b>action under test</b> steps are the swamp commands being exercised. A test with 0 independent checks proves only that swamp reported success.</p>` +
    cards;
}

/** Coverage of the documented/shipped surface. */
function coverageHtml(cov: Rec | null): string {
  if (!cov) return "";
  const surface = rec(cov.surface) ?? {};
  const testCommands = arr(cov.testCommands).map((c) => str(c));
  const documented = arr(cov.documentedCommands).map((c) => str(c));
  const documentedCovered = arr(cov.documentedCovered).map((c) => str(c));
  const uncoveredCommands = arr(cov.uncoveredCommands).map((c) => str(c));
  const methods = arr(surface.methods).map((c) => str(c));
  const methodsCovered = arr(surface.methodsCovered).map((c) => str(c));
  const workflows = arr(surface.workflows).map((c) => str(c));
  const workflowsCovered = arr(surface.workflowsCovered).map((c) => str(c));
  const pct = (part: number, whole: number) =>
    whole > 0 ? `${Math.round((part / whole) * 100)}%` : "0%";

  const rows = [
    [
      "Documented tests",
      `${num(cov.testCount)}`,
      "in the candidate's test-factory.yaml",
    ],
    [
      "Distinct `swamp …` commands run by tests",
      `${testCommands.length}`,
      "",
    ],
    [
      "Commands in the manifest description covered",
      `${documentedCovered.length}/${documented.length} (${
        pct(documentedCovered.length, documented.length)
      })`,
      "",
    ],
    [
      "Methods run by a test",
      `${methodsCovered.length}/${methods.length} (${
        pct(methodsCovered.length, methods.length)
      })`,
      "",
    ],
    [
      "Workflows run by a test",
      `${workflowsCovered.length}/${workflows.length} (${
        pct(workflowsCovered.length, workflows.length)
      })`,
      "",
    ],
  ];

  const listBlock = (heading: string, items: string[]) => {
    if (items.length === 0) return "";
    const capped = items.slice(0, 40);
    const more = items.length > 40
      ? `<li class="muted">… and ${items.length - 40} more</li>`
      : "";
    return `<div class="cap">${escapeHtml(heading)} (${items.length})</div>` +
      `<ul class="cmds">${
        capped.map((i) => `<li><code>${escapeHtml(i)}</code></li>`).join("")
      }${more}</ul>`;
  };

  const lists = listBlock("Commands run by the tests", testCommands) +
    listBlock("Documented commands a test runs", documentedCovered) +
    listBlock("Documented commands NO test runs", uncoveredCommands) +
    listBlock(
      "Declared methods NO test runs",
      methods.filter((m) => !methodsCovered.includes(m)),
    ) +
    listBlock(
      "Declared workflows NO test runs",
      workflows.filter((w) => !workflowsCovered.includes(w)),
    );

  return `<h3>Test coverage</h3>` +
    table(["Metric", "Value", "Note"], rows) +
    (lists
      ? details('<span class="mono">Full coverage lists</span>', lists)
      : "");
}

/** One scenario `result` as a card. */
function resultCard(r: Rec): string {
  const ok = r.ok === true;
  const ext = str(r.extension);
  const version = str(r.extensionVersion);
  const meta = [
    `${escapeHtml(str(r.distro))}${r.systemd ? " + systemd" : ""}`,
    `topology ${escapeHtml(str(r.topology))}`,
    num(r.workers) > 0 ? `${escapeHtml(num(r.workers))} workers` : "",
    `expected ${escapeHtml(str(r.expected))}`,
    `status ${escapeHtml(str(r.status))}`,
    num(r.durationMs) > 0 ? `${(num(r.durationMs) / 1000).toFixed(1)}s` : "",
    str(r.swampVersion) ? `swamp ${escapeHtml(str(r.swampVersion))}` : "",
  ].filter(Boolean).map((x) => `<span class="chip">${x}</span>`).join(" ");

  const header =
    `<h2>${escapeHtml(str(r.scenario, "scenario"))} ${okBadge(r.ok)}</h2>` +
    (ext
      ? `<div class="muted">${escapeHtml(ext)}${
        version ? `@${escapeHtml(version)}` : ""
      }</div>`
      : "") +
    (str(r.intent)
      ? `<p class="intent">${escapeHtml(str(r.intent))}</p>`
      : "") +
    `<div class="chips">${meta}</div>`;

  // Topology summary (fleet/serve scenarios).
  let topo = "";
  const t = rec(r.topologyResult);
  if (t) {
    topo = `<div class="topo">` +
      `serve ${
        t.serveReady === true
          ? badge("pass", "ready")
          : badge("fail", "not ready")
      } · ` +
      `workers ${escapeHtml(num(t.workersEnrolled))}/${
        escapeHtml(num(t.workersRequested))
      } · ` +
      `dispatch ${
        t.dispatchOk === true ? badge("pass", "ok") : badge("fail", "failed")
      }` +
      `</div>` +
      (str(t.detail) ? pre(t.detail, "Topology detail") : "");
  }

  // Phases.
  const phases = arr(r.phases) as Rec[];
  let phasesHtml = "";
  if (phases.length > 0) {
    const rows = phases.map((p) => [
      `<span class="mono">${escapeHtml(str(p.phase))}</span>`,
      okBadge(p.ok),
      escapeHtml(str(p.detail)),
    ]);
    phasesHtml = `<h3>Phases</h3>${table(["Phase", "Result", "Detail"], rows)}`;
  }

  // Definitions.
  const defs = arr(r.definitions) as Rec[];
  let defsHtml = "";
  if (defs.length > 0) {
    const rows = defs.map((d) => [
      `<span class="mono">${escapeHtml(str(d.type))}</span>`,
      okBadge(d.ok),
      escapeHtml(str(d.error) || str(d.name)),
    ]);
    defsHtml = `<h3>Definitions</h3>${
      table(["Type", "Result", "Detail"], rows)
    }`;
  }

  // Workflows.
  const wfs = arr(r.workflows) as Rec[];
  let wfsHtml = "";
  if (wfs.length > 0) {
    const rows = wfs.map((w) => [
      `<span class="mono">${escapeHtml(str(w.name))}</span>`,
      okBadge(w.ok),
      escapeHtml(str(w.status)),
    ]);
    wfsHtml = `<h3>Workflows</h3>${
      table(["Workflow", "Result", "Status"], rows)
    }`;
  }

  // Fixtures.
  const fixtures = arr(r.fixtures) as Rec[];
  let fixturesHtml = "";
  if (fixtures.length > 0) {
    const rows = fixtures.map((f) => [
      `<span class="mono">${escapeHtml(str(f.type))}/${
        escapeHtml(str(f.method))
      }</span>`,
      okBadge(f.ok),
      escapeHtml(num(f.code)),
    ]);
    fixturesHtml = `<h3>Fixtures</h3>${
      table(["Fixture", "Result", "Exit"], rows)
    }`;
  }

  // Tests + coverage.
  const testsHtmlBlock = testsHtml(arr(r.tests) as Rec[], r);
  const coverageHtmlBlock = coverageHtml(rec(r.coverage));

  // Errors.
  const errors = arr(r.errors).map((e) => str(e)).filter(Boolean);
  const errorsHtml = errors.length > 0
    ? `<h3>Errors</h3><ul class="errors">${
      errors.map((e) => `<li>${escapeHtml(e)}</li>`).join("")
    }</ul>`
    : "";

  // Logs (collapsed).
  const logs = str(r.logs);
  const logsHtml = logs
    ? details(
      `<span class="mono">Container logs${
        r.logsTruncated === true ? " (tail)" : ""
      }</span>`,
      pre(logs),
    )
    : "";

  const hasEvidence = arr(r.evidence).length > 0;
  return `<article class="card verdict ${
    ok ? "pass" : "fail"
  }">${header}${topo}${claimsHtml(arr(r.claims) as Rec[], hasEvidence)}${
    evidenceHtml(r)
  }${phasesHtml}${defsHtml}${wfsHtml}${testsHtmlBlock}${coverageHtmlBlock}${fixturesHtml}${errorsHtml}${logsHtml}</article>`;
}

/** The fan-out roll-up table. */
function summaryHtml(s: Rec): string {
  const rows = (arr(s.results) as Rec[]).map((r) => [
    `<span class="mono">${escapeHtml(str(r.scenario))}</span>`,
    escapeHtml(str(r.distro)),
    escapeHtml(str(r.topology)),
    escapeHtml(str(r.expected)),
    `${okBadge(r.ok)} <span class="muted">${escapeHtml(str(r.status))}</span>`,
  ]);
  const tests = num(s.testCount) > 0
    ? `<p>Documented tests: <b>${escapeHtml(num(s.testsPassed))}/${
      escapeHtml(num(s.testCount))
    }</b> passed (each test runs once per scenario).</p>`
    : "";
  return `<section class="rollup">
    <h2>Roll-up — ${escapeHtml(str(s.extension, "extension"))}${
    str(s.version) ? `@${escapeHtml(str(s.version))}` : ""
  }</h2>
    ${tests}
    <h3>Scenarios</h3>
    ${table(["Scenario", "Distro", "Topology", "Expected", "Result"], rows)}
    ${coverageHtml(rec(s.coverage))}
    ${claimsHtml(arr(s.claims) as Rec[], false)}
  </section>`;
}

// ---------------------------------------------------------------------------
// Whole-document assembly
// ---------------------------------------------------------------------------

export type HtmlReportInput = {
  results: Rec[];
  summary: Rec | null;
  generatedAt: string;
  sourceHash: string;
  outputPath?: string;
};

/** Build the complete, self-contained HTML document. */
export function renderHtmlReport(input: HtmlReportInput): string {
  const { results, summary, generatedAt, sourceHash, outputPath } = input;

  // Verdict + counts come from the summary when present, else the single result.
  let extension = "";
  let version = "";
  let total = 0;
  let passed = 0;
  let failed = 0;
  let errored = 0;
  let testsPassed = 0;
  let testCount = 0;

  if (summary) {
    extension = str(summary.extension);
    version = str(summary.version);
    total = num(summary.count);
    passed = num(summary.passCount);
    failed = num(summary.failCount);
    errored = num(summary.errorCount);
    testsPassed = num(summary.testsPassed);
    testCount = num(summary.testCount);
  } else if (results.length > 0) {
    // Use the first result's identity; average over results for the counts.
    extension = str(results[0].extension);
    version = str(results[0].extensionVersion);
    total = results.length;
    for (const r of results) {
      const status = str(r.status);
      if (r.ok === true) passed++;
      else if (status === "error") errored++;
      else failed++;
      for (const t of arr(r.tests) as Rec[]) {
        testCount++;
        if (t.ok === true) testsPassed++;
      }
    }
  }

  const overallPass = failed === 0 && errored === 0 && total > 0;
  const verdictText = total === 0
    ? "no scenarios"
    : overallPass
    ? "all scenarios passed"
    : `${failed} failed, ${errored} errored`;

  const stat = (label: string, value: string, cls = "") =>
    `<div class="stat ${cls}"><div class="stat-v">${
      escapeHtml(value)
    }</div><div class="stat-l">${escapeHtml(label)}</div></div>`;

  const stats = `<div class="stats">
    ${stat("scenarios", `${total}`)}
    ${stat("passed", `${passed}`, "pass")}
    ${stat("failed", `${failed}`, failed > 0 ? "fail" : "")}
    ${stat("errored", `${errored}`, errored > 0 ? "error" : "")}
    ${testCount > 0 ? stat("tests passed", `${testsPassed}/${testCount}`) : ""}
  </div>`;

  const rollup = summary ? summaryHtml(summary) : "";
  const cards = results.map(resultCard).join("\n");

  const hashShort = sourceHash.slice(0, 16);
  const title = `Test factory report — ${extension || "run"}${
    version ? `@${version}` : ""
  }`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; background: #f6f8fa; color: #1b1f23;
  font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
.wrap { max-width: 1100px; margin: 0 auto; padding: 24px 20px 64px; }
h1 { font-size: 22px; margin: 0 0 4px; }
h2 { font-size: 18px; margin: 24px 0 6px; }
h3 { font-size: 14px; text-transform: uppercase; letter-spacing: .04em;
  color: #57606a; margin: 20px 0 8px; }
h4.phase { font-size: 13px; margin: 14px 0 2px; }
p.basis { margin: 0 0 6px; }
h5 { font-size: 12.5px; text-transform: uppercase; letter-spacing: .04em;
  color: #57606a; margin: 14px 0 4px; }
.contract { border-left: 4px solid #6e7781; background: #f6f8fa;
  padding: 8px 12px; border-radius: 6px; margin: 6px 0; }
.contract p { margin: 3px 0; }
.contract .should { color: #0f5323; }
.contract .should-not { color: #82071e; }
.ctx { background: #eef2f6; border-radius: 6px; padding: 6px 10px;
  margin: 4px 0 8px; font-size: 13px; }
.cmdlist { margin: 4px 0; padding-left: 22px; }
.cmdlist > li { margin: 10px 0; padding-left: 4px; }
.tag { display: inline-block; font-size: 11px; font-weight: 700; padding: 1px 7px;
  border-radius: 4px; margin-right: 6px; }
.tag.setup { background: #ddf4ff; color: #0a3069; }
.tag.action { background: #eee; color: #24292f; }
.tag.verify { background: #dafbe1; color: #0f5323; }
.stephead { font-weight: 600; margin: 4px 0 2px; }
.warn { color: #9a6700; font-weight: 600; }
a { color: #0969da; }
.muted { color: #57606a; }
.mono, code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; }
.chip { display: inline-block; background: #eaeef2; color: #24292f; border-radius: 999px;
  padding: 1px 9px; margin: 2px 4px 2px 0; font-size: 12.5px; }
.badge { display: inline-block; font-weight: 700; font-size: 11.5px; letter-spacing: .03em;
  padding: 2px 8px; border-radius: 999px; color: #fff; background: #6e7781; }
.badge.pass { background: #1a7f37; }
.badge.fail { background: #cf222e; }
.badge.error { background: #9a6700; }
.badge.skip { background: #6e7781; }
.stats { display: flex; gap: 12px; flex-wrap: wrap; margin: 16px 0 8px; }
.stat { background: #fff; border: 1px solid #d0d7de; border-radius: 10px; padding: 12px 16px; min-width: 108px; }
.stat-v { font-size: 24px; font-weight: 700; line-height: 1.1; }
.stat-l { color: #57606a; font-size: 12.5px; }
.stat.pass .stat-v { color: #1a7f37; }
.stat.fail .stat-v { color: #cf222e; }
.stat.error .stat-v { color: #9a6700; }
.banner { border-radius: 8px; padding: 10px 14px; margin: 12px 0; font-weight: 600; }
.banner.pass { background: #dafbe1; color: #0f5323; border: 1px solid #aceebb; }
.banner.fail { background: #ffebe9; color: #82071e; border: 1px solid #ffcecb; }
.card, .rollup { background: #fff; border: 1px solid #d0d7de; border-radius: 10px;
  padding: 16px 18px; margin: 16px 0; }
.card.verdict.pass { border-left: 6px solid #1a7f37; }
.card.verdict.fail { border-left: 6px solid #cf222e; }
.chips { margin: 8px 0 4px; }
.intent { color: #24292f; }
.topo { margin: 10px 0; }
table { border-collapse: collapse; width: 100%; margin: 6px 0; font-size: 14px; }
th, td { border: 1px solid #d0d7de; padding: 5px 8px; text-align: left; vertical-align: top; }
th { background: #f6f8fa; font-size: 12.5px; }
pre { background: #0d1117; color: #e6edf3; padding: 10px 12px; border-radius: 6px;
  overflow: auto; font-size: 12.5px; line-height: 1.45; margin: 4px 0 10px; }
.cap { font-size: 12px; color: #57606a; margin-top: 6px; }
details { background: #fff; border: 1px solid #d0d7de; border-radius: 8px; margin: 8px 0; }
details > summary { cursor: pointer; padding: 8px 12px; font-weight: 600; }
details[open] > summary { border-bottom: 1px solid #d0d7de; }
.dbody { padding: 8px 12px 12px; }
details details { background: #f6f8fa; }
.claims li, .assertions li, .errors li { margin: 2px 0; }
ul.cmds { columns: 2; font-size: 12.5px; }
ul.cmds code { word-break: break-all; }
.footer { margin-top: 32px; padding-top: 12px; border-top: 1px solid #d0d7de;
  color: #57606a; font-size: 12.5px; }
</style>
</head>
<body>
<div class="wrap">
<header>
  <h1>${escapeHtml(extension || "Test factory")}${
    version ? `<span class="muted">@${escapeHtml(version)}</span>` : ""
  }</h1>
  <div class="muted">Test factory report · generated ${
    escapeHtml(generatedAt)
  }</div>
</header>
<div class="banner ${overallPass ? "pass" : "fail"}">${
    overallPass ? "PASS" : "FAIL"
  } — ${escapeHtml(verdictText)}</div>
${stats}
${
    outputPath
      ? `<div class="muted">Output: <code>${
        escapeHtml(outputPath)
      }</code></div>`
      : ""
  }
${rollup}
${cards}
<div class="footer">
  Source data: <code>sha256:${escapeHtml(sourceHash)}</code> (${
    escapeHtml(hashShort)
  }…) —
  the hash of the stored result/summary JSON this page was rendered from, so the
  page can be verified against the data.
  <br>Generated by <code>${escapeHtml(REPORT_NAME)}</code> at ${
    escapeHtml(generatedAt)
  }.
</div>
</div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// File output
// ---------------------------------------------------------------------------

/** Sanitise an extension name into a filesystem-safe slug. */
export function slugify(name: string): string {
  return (name || "test-factory")
    .replace(/^@/, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "test-factory";
}

/** Directory the HTML reports are written to. */
export function htmlDir(env: (k: string) => string | undefined): string {
  const override = env("SWAMP_TEST_FACTORY_HTML_DIR");
  if (override) return override;
  const home = env("HOME") ?? ".";
  return `${home}/.local/share/test-factory-report`;
}

/**
 * Write the HTML to `dir` and return the **timestamped, per-run** path — each
 * run's report is a distinct, immutable record (the source hash in the page
 * ties it to the run's data). A `<slug>-latest.html` alias is also written as a
 * stable convenience link; it is not the reported path.
 */
export async function writeHtmlFile(
  dir: string,
  slug: string,
  stamp: string,
  html: string,
): Promise<string> {
  await Deno.mkdir(dir, { recursive: true });
  const dated = `${dir}/${slug}-${stamp}.html`;
  await Deno.writeTextFile(dated, html);
  try {
    await Deno.writeTextFile(`${dir}/${slug}-latest.html`, html);
  } catch {
    // The stable alias is a convenience; the timestamped file is the record.
  }
  return dated;
}

/** ISO timestamp safe for use in a filename. */
export function fileStamp(d: Date): string {
  return d.toISOString().replace(/[:.]/g, "-");
}

/** SHA-256 of a string, hex-encoded. */
export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---------------------------------------------------------------------------
// Report entrypoint
// ---------------------------------------------------------------------------

/** Report definition: render a scenario result or the fan-out rollup as HTML. */
export const report = {
  name: REPORT_NAME,
  description:
    "Render test-factory scenario results and the fan-out rollup as a self-contained HTML page",
  scope: "method",
  labels: ["test-factory", "containers", "testing", "html"],
  execute: async (
    context: MethodReportContext,
  ): Promise<{ markdown: string; json: Record<string, unknown> }> => {
    if (context.executionStatus === "failed") {
      return {
        markdown: `### HTML report skipped\n\nMethod failed: ${
          context.errorMessage ?? "unknown error"
        }`,
        json: {
          error: true,
          reportName: REPORT_NAME,
          method: context.methodName,
        },
      };
    }

    const resultHandles = context.dataHandles.filter(
      (h) => h.specName === "result",
    );
    const summaryHandle = context.dataHandles.find(
      (h) => h.specName === "summary",
    );
    if (resultHandles.length === 0 && !summaryHandle) {
      // Not a scenario run (e.g. listScenarios/cleanup) — nothing to render.
      return { markdown: "", json: {} };
    }

    const readJson = async (h: DataHandle): Promise<Rec | null> => {
      const bytes = await context.dataRepository.getContent(
        context.modelType,
        context.modelId,
        h.name,
        h.version,
      );
      if (!bytes) return null;
      try {
        return JSON.parse(new TextDecoder().decode(bytes)) as Rec;
      } catch {
        return null;
      }
    };

    // The `test`/`testAll` methods generate the HTML themselves and record its
    // path in an `htmlReport` resource, so the run output already points at the
    // file. Prefer that record and return a pointer — no duplicate file.
    const htmlHandle = context.dataHandles.find(
      (h) => h.specName === "htmlReport",
    );
    if (htmlHandle) {
      const pointer = await readJson(htmlHandle);
      if (pointer && typeof pointer.path === "string" && pointer.path) {
        return {
          markdown:
            `### Test factory HTML report\n\n${str(pointer.extension)} — ` +
            `${num(pointer.passCount)} passed, ${
              num(pointer.failCount)
            } failed, ` +
            `${num(pointer.errorCount)} errored of ${num(pointer.count)}.\n\n` +
            `**HTML report**: [\`${str(pointer.path)}\`](${
              str(pointer.path)
            })\n\n` +
            `_Source data_ \`sha256:${str(pointer.sourceHash)}\` · generated ${
              str(pointer.generatedAt)
            }.`,
          json: pointer,
        };
      }
    }

    const results: Rec[] = [];
    for (const h of resultHandles) {
      const data = await readJson(h);
      if (data) results.push(data);
    }
    const summary = summaryHandle ? await readJson(summaryHandle) : null;

    if (results.length === 0 && !summary) {
      return { markdown: "", json: {} };
    }

    const generatedAt = new Date().toISOString();
    // The page is rendered from exactly this payload; its hash goes in the footer.
    const sourceHash = await sha256Hex(
      JSON.stringify({ summary, results }),
    );

    const extension = summary
      ? str(summary.extension)
      : results.length > 0
      ? str(results[0].extension)
      : "";
    const slug = slugify(
      extension || context.definition?.name || "test-factory",
    );
    const stamp = fileStamp(new Date());

    const dir = htmlDir((k) => Deno.env.get(k));
    let outputPath = "";
    let writeError = "";
    const html = renderHtmlReport({
      results,
      summary,
      generatedAt,
      sourceHash,
    });
    try {
      outputPath = await writeHtmlFile(dir, slug, stamp, html);
    } catch (err) {
      writeError = err instanceof Error ? err.message : String(err);
    }

    const counts = summary
      ? `${num(summary.passCount)} passed, ${num(summary.failCount)} failed, ${
        num(summary.errorCount)
      } errored of ${num(summary.count)}`
      : `${results.length} scenario result(s)`;
    const link = outputPath
      ? `\n\n**HTML report**: [\`${outputPath}\`](${outputPath})`
      : writeError
      ? `\n\n_HTML report could not be written: ${writeError}_`
      : "";
    const markdown =
      `### Test factory HTML report\n\n${
        extension ? `${extension} — ` : ""
      }${counts}.` +
      `${link}\n\n_Source data_ \`sha256:${sourceHash}\` · generated ${generatedAt}.`;

    context.logger?.info(
      outputPath
        ? "Wrote test-factory HTML report to {path}"
        : "Test-factory HTML report not written: {error}",
      outputPath ? { path: outputPath } : { error: writeError || "no data" },
    );

    return {
      markdown,
      json: {
        htmlPath: outputPath || null,
        writeError: writeError || null,
        sourceHash,
        generatedAt,
        scenarioCount: summary ? num(summary.count) : results.length,
        passCount: summary ? num(summary.passCount) : undefined,
        failCount: summary ? num(summary.failCount) : undefined,
        errorCount: summary ? num(summary.errorCount) : undefined,
      },
    };
  },
};
