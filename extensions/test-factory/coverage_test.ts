import { assertEquals } from "jsr:@std/assert@1";
import {
  computeCoverage,
  documentationKey,
  extractCommands,
  normalizeName,
  parseSwampCommand,
  testCommandKeys,
  tokenize,
} from "./coverage.ts";
import type { TestSpec } from "./tests.ts";

/** Build a minimal test with a single step running `run`. */
function testWithRun(name: string, run: string): TestSpec {
  return {
    name,
    confirms: "does a thing",
    cannot: "must not fail",
    variables: {},
    steps: [{
      name: "s",
      run,
      timeoutSeconds: 30,
      continueOnFailure: false,
      expect: { exitCode: 0 },
    }],
  };
}

Deno.test("tokenize honours quotes", () => {
  assertEquals(tokenize(`swamp model method run x installCaddy`), [
    "swamp",
    "model",
    "method",
    "run",
    "x",
    "installCaddy",
  ]);
  assertEquals(
    tokenize(`swamp model create @a/b x --global-arg 'listen:json=[":80"]'`),
    [
      "swamp",
      "model",
      "create",
      "@a/b",
      "x",
      "--global-arg",
      'listen:json=[":80"]',
    ],
  );
});

Deno.test("parseSwampCommand reads a documented model method run", () => {
  const ref = parseSwampCommand("swamp model method run my-caddy installCaddy");
  assertEquals(ref?.group, "model");
  assertEquals(ref?.verb, "method");
  assertEquals(ref?.method, "installCaddy");
  assertEquals(ref?.instance, "my-caddy");
});

Deno.test("parseSwampCommand skips an explicit type before method", () => {
  const ref = parseSwampCommand(
    "swamp model @svendowideit/test-factory method run test tf --input distro=rocky",
  );
  assertEquals(ref?.type, "@svendowideit/test-factory");
  assertEquals(ref?.method, "test");
  assertEquals(ref?.instance, "tf");
});

Deno.test("parseSwampCommand reads model create with and without --type", () => {
  const typed = parseSwampCommand(
    `swamp model create @svendowideit/caddy my-caddy --global-arg baseDomain=x`,
  );
  assertEquals(typed?.verb, "create");
  assertEquals(typed?.type, "@svendowideit/caddy");
  assertEquals(typed?.instance, "my-caddy");

  const flag = parseSwampCommand(
    `swamp model create servers --type "@svendowideit/postgres-model"`,
  );
  assertEquals(flag?.verb, "create");
  assertEquals(flag?.instance, "servers");
  assertEquals(flag?.type, "@svendowideit/postgres-model");
});

Deno.test("parseSwampCommand reads workflow run", () => {
  const ref = parseSwampCommand("swamp workflow run @svendowideit/gtd");
  assertEquals(ref?.group, "workflow");
  assertEquals(ref?.verb, "run");
  assertEquals(ref?.workflow, "@svendowideit/gtd");
});

Deno.test("parseSwampCommand ignores prose and non-swamp lines", () => {
  assertEquals(parseSwampCommand("Run: swamp workflow run x"), null);
  assertEquals(parseSwampCommand("the swamp model becomes a table"), null);
  assertEquals(parseSwampCommand("   # a comment"), null);
});

Deno.test("parseSwampCommand accepts a leading prompt", () => {
  const ref = parseSwampCommand("$ swamp model get my-caddy --json");
  assertEquals(ref?.group, "model");
  assertEquals(ref?.verb, "get");
  assertEquals(ref?.instance, "my-caddy");
});

Deno.test("documentationKey collapses the instance name", () => {
  const documented = parseSwampCommand(
    "swamp model method run my-caddy installCaddy",
  )!;
  const tested = parseSwampCommand(
    "swamp model method run e2e-caddy installCaddy",
  )!;
  assertEquals(documentationKey(documented), documentationKey(tested));
  assertEquals(documentationKey(documented), "model.method.installcaddy");
});

Deno.test("extractCommands deduplicates and skips non-commands", () => {
  const text = [
    "WHAT IT DOES",
    "",
    "  swamp model create @a/b one",
    "  swamp model method run one go",
    "  swamp model method run one go --input x=1",
    "not a command: swamp model",
  ].join("\n");
  const cmds = extractCommands(text);
  assertEquals(cmds.length, 2);
  assertEquals(cmds.map((c) => c.verb), ["create", "method"]);
});

Deno.test("testCommandKeys extracts distinct command keys from steps", () => {
  const tests = [
    testWithRun(
      "t1",
      "swamp model method run e2e-caddy installCaddy\nswamp model create @a/b x",
    ),
    testWithRun("t2", "swamp model method run e2e-caddy installCaddy"),
  ];
  assertEquals(testCommandKeys(tests), [
    "model.create",
    "model.method.installcaddy",
  ]);
});

Deno.test("computeCoverage measures documented and shipped-surface coverage", () => {
  const description = [
    "RUN",
    "",
    "  swamp model create @acme/thing my-thing",
    "  swamp model method run my-thing installCaddy",
    "  swamp model method run my-thing createService",
    "  swamp workflow run @acme/thing-thing",
  ].join("\n");
  const tests = [
    testWithRun("t", "swamp model method run e2e installCaddy"),
  ];
  const report = computeCoverage({
    description,
    tests,
    typeMethods: [
      {
        type: "@acme/thing",
        methods: ["installCaddy", "createService", "startService"],
      },
    ],
    workflows: ["@acme/thing-thing"],
  });

  assertEquals(report.testCount, 1);
  // The literal test command, as written.
  assertEquals(report.testCommands, [
    "swamp model method run e2e installCaddy",
  ]);
  // Every command shown in the description, as written.
  assertEquals(report.documentedCommands.length, 4);
  assertEquals(report.documentedCovered, [
    "swamp model method run my-thing installCaddy",
  ]);
  assertEquals(report.uncoveredCommands, [
    "swamp model create @acme/thing my-thing",
    "swamp model method run my-thing createService",
    "swamp workflow run @acme/thing-thing",
  ]);
  // Surface: 3 methods, only installCaddy covered.
  assertEquals(report.surface.methods, [
    "@acme/thing.createService",
    "@acme/thing.installCaddy",
    "@acme/thing.startService",
  ]);
  assertEquals(report.surface.methodsCovered, [
    "@acme/thing.installCaddy",
  ]);
  assertEquals(report.surface.workflows, ["@acme/thing-thing"]);
  assertEquals(report.surface.workflowsCovered, []);
});

Deno.test("computeCoverage reports full coverage when tests exercise everything", () => {
  const description =
    "  swamp model method run x installCaddy\n  swamp workflow run flow-one";
  const tests = [
    testWithRun(
      "t",
      "swamp model method run e2e installCaddy\nswamp workflow run flow-one",
    ),
  ];
  const report = computeCoverage({
    description,
    tests,
    typeMethods: [{ type: "@a/b", methods: ["installCaddy"] }],
    workflows: ["flow-one"],
  });
  assertEquals(report.documentedCovered, report.documentedCommands);
  assertEquals(report.surface.methodsCovered, ["@a/b.installCaddy"]);
  assertEquals(report.surface.workflowsCovered, ["flow-one"]);
  assertEquals(report.uncoveredCommands, []);
});

Deno.test("computeCoverage credits an untyped method run to any type", () => {
  // `swamp model method run <instance> <method>` names no type, so the method
  // name alone is the evidence — it covers every declared type's same method.
  const report = computeCoverage({
    description: "",
    tests: [testWithRun("t", "swamp model method run e2e sync")],
    typeMethods: [
      { type: "@collective/alpha", methods: ["sync"] },
      { type: "@collective/beta", methods: ["sync"] },
    ],
    workflows: [],
  });
  assertEquals(report.surface.methodsCovered, [
    "@collective/alpha.sync",
    "@collective/beta.sync",
  ]);
});

Deno.test("computeCoverage does not credit a typed method run to another type", () => {
  const report = computeCoverage({
    description: "",
    tests: [
      testWithRun(
        "t",
        "swamp model @collective/alpha method run sync alpha-i",
      ),
    ],
    typeMethods: [
      { type: "@collective/alpha", methods: ["sync"] },
      { type: "@collective/beta", methods: ["sync"] },
    ],
    workflows: [],
  });
  assertEquals(report.surface.methodsCovered, ["@collective/alpha.sync"]);
});

Deno.test("normalizeName lower-cases and strips quotes", () => {
  assertEquals(normalizeName("InstallCaddy"), "installcaddy");
  assertEquals(normalizeName(`"@acme/thing"`), "@acme/thing");
});
