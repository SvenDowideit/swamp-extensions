/**
 * Tests for the user-guidance (copy-paste ready) lint.
 *
 * @module
 */
import { assertEquals } from "jsr:@std/assert@1";
import { lintUserGuidance, lintUserGuidances } from "./user-guidance-lint.ts";

Deno.test("flags a backticked command with an angle-bracket placeholder", () => {
  const source = `
    throw new Error(
      "Cannot verify /hooks/linkdrop: fetch failed. " +
        "Check \`systemctl --user status <serve-unit>\` and its logs.",
    );
  `;
  const issues = lintUserGuidance(source, "linkdrop.ts");
  assertEquals(issues.length, 1);
  assertEquals(issues[0].rule, "substitution-placeholder");
  assertEquals(issues[0].placeholder, "<serve-unit>");
  assertEquals(issues[0].line, 4);
  assertEquals(issues[0].command, "systemctl --user status <serve-unit>");
});

Deno.test("flags plain 'run:' instructions with a placeholder", () => {
  const issues = lintUserGuidance(
    `logger.info("Please run: some-cli <value-you-know>");`,
    "tool.ts",
  );
  assertEquals(issues.length, 1);
  assertEquals(issues[0].placeholder, "<value-you-know>");
});

Deno.test("ignores a placeholder in an --input value the user supplies", () => {
  const issues = lintUserGuidance(
    'logger.info("run `swamp workflow run @me/setup --input dnsName=<zone>`");',
    "tool.ts",
  );
  assertEquals(issues, []);
});

Deno.test("flags a workflow command/message value with a placeholder", () => {
  const workflow = `jobs:
  - name: setup
    steps:
      - name: hint
        message: "Please run: some-cli <zone>"
`;
  const issues = lintUserGuidance(workflow, "setup.yaml");
  assertEquals(issues.length, 1);
  assertEquals(issues[0].placeholder, "<zone>");
});

Deno.test("counts every occurrence per file", () => {
  const issues = lintUserGuidance(
    [
      'logger.info("run some-cli <one>");',
      'logger.info("run some-cli <two>");',
    ].join("\n"),
    "tool.ts",
  );
  assertEquals(issues.length, 2);
  assertEquals(issues.map((i) => i.placeholder), ["<one>", "<two>"]);
});

Deno.test("ignores HTML tags in template literals", () => {
  const source = `
    const html = \`<html><head><title>Links</title></head>
      <body><script>alert("hi")</script><div>ok</div></body></html>\`;
  `;
  assertEquals(lintUserGuidance(source, "page.ts"), []);
});

Deno.test("ignores TypeScript generics and comparisons", () => {
  const source = `
    function pick<T>(items: T[]): T | undefined {
      if (items.length < 2) return undefined;
      return items[0];
    }
  `;
  assertEquals(lintUserGuidance(source, "tool.ts"), []);
});

Deno.test("ignores plain prose placeholders that are not commands", () => {
  const workflow = `description: >
  Register the webhook and expose it at linkdrop.<zone> through Caddy.
`;
  assertEquals(lintUserGuidance(workflow, "workflow.yaml"), []);
});

Deno.test("ignores placeholders in comments", () => {
  const source = `
    // To debug, run: systemctl --user status <serve-unit>
    const ok = true;
  `;
  assertEquals(lintUserGuidance(source, "tool.ts"), []);
});

Deno.test("file-level ignore exempts the whole file", () => {
  const source = `
    // meta-factory-ignore user-guidance: the unit name is deliberately open
    log("run \`systemctl --user status <serve-unit>\`");
  `;
  assertEquals(lintUserGuidance(source, "tool.ts"), []);
});

Deno.test("lintUserGuidances collects issues from every file", () => {
  const issues = lintUserGuidances([
    {
      path: "tool.ts",
      source: 'logger.info("run some-cli <one>");',
    },
    { path: "workflow.yaml", source: "message: run `curl <host>`" },
  ]);
  assertEquals(issues.length, 2);
  assertEquals(issues.map((i) => i.path), ["tool.ts", "workflow.yaml"]);
});
