import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  escapeHtml,
  renderHtmlReport,
  report,
  sha256Hex,
  slugify,
  writeHtmlFile,
} from "./test_factory_report_html.ts";

const RESULT: Record<string, unknown> = {
  scenario: "ubuntu-systemd-standalone",
  extension: "@acme/thing",
  extensionVersion: "2026.01.01.1",
  intent: "Prove @acme/thing installs and behaves.",
  distro: "ubuntu",
  systemd: true,
  topology: "standalone",
  workers: 0,
  expected: "pass",
  ok: true,
  status: "pass",
  swampVersion: "20261006.0-sha.abc",
  durationMs: 42_000,
  claims: [
    {
      phase: "smoke",
      claim: "swamp installs and doctor passes",
      commands: ["swamp --version", "swamp doctor extensions --json"],
    },
  ],
  phases: [
    { phase: "smoke", ok: true, detail: "doctor pass" },
    { phase: "tests", ok: true, detail: "3/3 tests" },
  ],
  definitions: [{ type: "@acme/thing", name: "thing", ok: true }],
  workflows: [],
  fixtures: [],
  tests: [
    {
      name: "check-prints-latest",
      confirms: "check prints the latest tag",
      cannot: "must not exit non-zero",
      ok: true,
      steps: [
        {
          name: "run",
          run: "swamp model @acme/thing method run check x --input repo=$REPO",
          ok: true,
          exitCode: 0,
          matched: ["exitCode == 0", "outputContains caddy_"],
          stdout: "caddy_v2.11.6 <script>alert(1)</script>",
          stderr: "",
        },
      ],
    },
  ],
  coverage: {
    testCount: 1,
    testCommands: ["swamp model @acme/thing method run check x"],
    documentedCommands: ["swamp model @acme/thing method run check x"],
    documentedCovered: ["swamp model @acme/thing method run check x"],
    uncoveredCommands: [],
    surface: {
      types: 1,
      methods: ["@acme/thing.check"],
      methodsCovered: ["@acme/thing.check"],
      workflows: [],
      workflowsCovered: [],
    },
  },
  errors: [],
  logs: "container log line",
  logsTruncated: false,
  checkedAt: "2026-10-11T00:00:00.000Z",
};

const SUMMARY: Record<string, unknown> = {
  manifest: "extensions/models/thing/manifest.yaml",
  extension: "@acme/thing",
  version: "2026.01.01.1",
  count: 2,
  passCount: 1,
  failCount: 1,
  errorCount: 0,
  testCount: 2,
  testsPassed: 1,
  results: [
    {
      scenario: "ubuntu-standalone",
      distro: "ubuntu",
      topology: "standalone",
      expected: "pass",
      ok: true,
      status: "pass",
    },
    {
      scenario: "alpine-standalone",
      distro: "alpine",
      topology: "standalone",
      expected: "fail",
      ok: false,
      status: "fail",
    },
  ],
  claims: [],
  checkedAt: "2026-10-11T00:00:00.000Z",
};

Deno.test("escapeHtml neutralises angle brackets and quotes", () => {
  assertEquals(
    escapeHtml(`<script>alert("x") & 'y'</script>`),
    "&lt;script&gt;alert(&quot;x&quot;) &amp; &#39;y&#39;&lt;/script&gt;",
  );
});

Deno.test("the result page shows the verdict and escapes user output", () => {
  const html = renderHtmlReport({
    results: [RESULT],
    summary: null,
    generatedAt: "2026-10-11T00:00:00.000Z",
    sourceHash: "a".repeat(64),
  });
  assertStringIncludes(html, "ubuntu-systemd-standalone");
  assertStringIncludes(html, "<!DOCTYPE html>");
  assertStringIncludes(html, "banner pass");
  assertStringIncludes(html, "PASS");
  // The documented test and its command are present...
  assertStringIncludes(html, "check-prints-latest");
  assertStringIncludes(html, "method run check x");
  // ...inside a collapsible section...
  assertStringIncludes(html, "<details");
  assertStringIncludes(html, "<summary>");
  // ...and the raw injected script is escaped, never live markup.
  assertStringIncludes(html, "&lt;script&gt;alert(1)&lt;/script&gt;");
  assertEquals(html.includes("<script>alert(1)</script>"), false);
  // The source hash is in the footer for verification.
  assertStringIncludes(html, "sha256:" + "a".repeat(64));
});

Deno.test("recorded evidence is shown as real commands, not the plan", () => {
  const withEvidence = {
    ...RESULT,
    evidence: [
      {
        phase: "smoke",
        cmd: "swamp --version",
        exitCode: 0,
        stdout: "swamp 1.2.3",
        stderr: "",
      },
      {
        phase: "definitions",
        cmd: "swamp model create '@acme/thing' tf-def-1",
        exitCode: 1,
        stdout: "",
        stderr: "Unknown model type",
      },
    ],
  };
  const html = renderHtmlReport({
    results: [withEvidence],
    summary: null,
    generatedAt: "2026-10-11T00:00:00.000Z",
    sourceHash: "d".repeat(64),
  });
  assertStringIncludes(html, "Evidence — commands actually run");
  assertStringIncludes(html, "swamp --version");
  assertStringIncludes(html, "Unknown model type");
  // The pass/fail rule is stated for the reader...
  assertStringIncludes(html, "doctor extensions");
  // ...and the plan is not passed off as evidence.
  assertEquals(html.includes("Planned commands"), false);
});

Deno.test("without evidence the plan is shown, clearly labelled", () => {
  const html = renderHtmlReport({
    results: [RESULT], // RESULT has no evidence
    summary: null,
    generatedAt: "2026-10-11T00:00:00.000Z",
    sourceHash: "e".repeat(64),
  });
  assertStringIncludes(html, "Planned commands");
  assertStringIncludes(html, "not evidence");
});

Deno.test("independent verification is foregrounded; swamp JSON is not proof", () => {
  const withIndependent = {
    ...RESULT,
    tests: [
      {
        name: "run-elevates-and-mutates-the-sandbox",
        confirms: "an ensureDirectory operation creates a root-owned dir",
        cannot: "must not fail to create the directory",
        ok: true,
        steps: [
          {
            name: "ensure-directory-via-elevation",
            run:
              "swamp model method run sudo-ops run --input operation=ensureDirectory --json",
            ok: true,
            exitCode: 0,
            matched: ['stdout omits "elevationFailed":true'],
            stdout: '{"status":"succeeded"}',
            stderr: "",
          },
          {
            name: "the-directory-exists-and-is-root-owned",
            run: "stat -c '%a %U' /opt/tf-proof",
            ok: true,
            exitCode: 0,
            matched: ['stdoutContains "750 root"'],
            stdout: "750 root",
            stderr: "",
          },
        ],
      },
      {
        name: "swamp-only-test",
        confirms: "swamp says ok",
        cannot: "must not error",
        ok: true,
        steps: [
          {
            name: "self-report",
            run: "swamp model @acme/thing method run check x --json",
            ok: true,
            exitCode: 0,
            matched: [],
            stdout: '{"status":"succeeded"}',
            stderr: "",
          },
        ],
      },
    ],
  };
  const html = renderHtmlReport({
    results: [withIndependent],
    summary: null,
    generatedAt: "2026-10-11T00:00:00.000Z",
    sourceHash: "f".repeat(64),
  });
  assertStringIncludes(html, "Should happen:");
  assertStringIncludes(html, "Should NOT happen:");
  // The exact commands are shown, copy-pasteable, with a reproduce block.
  assertStringIncludes(html, "Reproduce — the exact commands");
  assertStringIncludes(html, "Commands run inside the test environment");
  // The verification command is HTML-escaped, so match without the quotes.
  assertStringIncludes(html, "stat -c ");
  assertStringIncludes(html, "/opt/tf-proof");
  assertStringIncludes(html, "750 root");
  // Steps are labelled by role.
  assertStringIncludes(html, "independent verification");
  assertStringIncludes(html, "action under test");
  // A test with only swamp steps is flagged, not passed off as proof.
  assertStringIncludes(html, "No independent verification");
});

Deno.test("the summary page carries the roll-up counts and table", () => {
  const html = renderHtmlReport({
    results: [],
    summary: SUMMARY,
    generatedAt: "2026-10-11T00:00:00.000Z",
    sourceHash: "b".repeat(64),
  });
  assertStringIncludes(html, "Roll-up");
  assertStringIncludes(html, "1 failed, 0 errored");
  assertStringIncludes(html, "alpine-standalone");
  assertStringIncludes(html, "banner fail");
});

Deno.test("a single failing result renders a FAIL banner", () => {
  const failing = { ...RESULT, ok: false, status: "fail" };
  const html = renderHtmlReport({
    results: [failing],
    summary: null,
    generatedAt: "2026-10-11T00:00:00.000Z",
    sourceHash: "c".repeat(64),
  });
  assertStringIncludes(html, "banner fail");
  assertEquals(html.includes("banner pass"), false);
});

Deno.test("slugify produces a filesystem-safe name", () => {
  assertEquals(
    slugify("@svendowideit/test-factory"),
    "svendowideit-test-factory",
  );
  assertEquals(slugify("@acme/thing"), "acme-thing");
  assertEquals(slugify(""), "test-factory");
});

Deno.test("sha256Hex matches a known digest", async () => {
  assertEquals(
    await sha256Hex("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

Deno.test("report.execute writes the HTML and reports its path", async () => {
  const dir = await Deno.makeTempDir({ prefix: "tf-html-exec-" });
  const prev = Deno.env.get("SWAMP_TEST_FACTORY_HTML_DIR");
  Deno.env.set("SWAMP_TEST_FACTORY_HTML_DIR", dir);
  try {
    const payload = new TextEncoder().encode(JSON.stringify(RESULT));
    const context = {
      scope: "method" as const,
      modelType: "@svendowideit/test-factory",
      modelId: "m1",
      definition: { name: "tf" },
      methodName: "test",
      executionStatus: "succeeded" as const,
      dataHandles: [
        { name: "result-1", specName: "result", kind: "resource", version: 1 },
      ],
      dataRepository: { getContent: () => Promise.resolve(payload) },
      logger: { info: () => {} },
    };
    const out = await report.execute(context as never);
    const htmlPath = out.json.htmlPath as string;
    assertStringIncludes(htmlPath, dir);
    const html = await Deno.readTextFile(htmlPath);
    assertStringIncludes(html, "ubuntu-systemd-standalone");
    assertStringIncludes(html, "PASS");
    assertStringIncludes(out.markdown, htmlPath);
    assertEquals((out.json.sourceHash as string).length, 64);
  } finally {
    if (prev === undefined) Deno.env.delete("SWAMP_TEST_FACTORY_HTML_DIR");
    else Deno.env.set("SWAMP_TEST_FACTORY_HTML_DIR", prev);
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("report.execute no-ops when there is no result or summary", async () => {
  const context = {
    scope: "method" as const,
    modelType: "@svendowideit/test-factory",
    modelId: "m1",
    definition: { name: "tf" },
    methodName: "listScenarios",
    executionStatus: "succeeded" as const,
    dataHandles: [{
      name: "scenarios",
      specName: "scenarios",
      kind: "resource",
    }],
    dataRepository: { getContent: () => Promise.resolve(null) },
    logger: { info: () => {} },
  };
  const out = await report.execute(context as never);
  assertEquals(out.markdown, "");
  assertEquals(out.json, {});
});

Deno.test("writeHtmlFile writes the dated file and the latest alias", async () => {
  const dir = await Deno.makeTempDir({ prefix: "tf-html-test-" });
  try {
    const path = await writeHtmlFile(
      dir,
      "acme-thing",
      "2026-10-11T00-00-00-000Z",
      "<html>hi</html>",
    );
    // The reported path is the timestamped per-run file.
    assertEquals(path, `${dir}/acme-thing-2026-10-11T00-00-00-000Z.html`);
    assertEquals(await Deno.readTextFile(path), "<html>hi</html>");
    assertEquals(
      await Deno.readTextFile(`${dir}/acme-thing-latest.html`),
      "<html>hi</html>",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
