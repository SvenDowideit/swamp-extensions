/**
 * Tests for the documentation command-hygiene lint.
 *
 * The rule exists because a command that cannot be pasted is as broken as a
 * wrong one: `swamp model <name> …` never runs, and a 300-character line is
 * wrapped by whatever displays it, so the reader copies two broken fragments.
 */

import { assertEquals } from "jsr:@std/assert@1";
import { lintCommandText, MAX_COMMAND_LINE } from "./user-guidance-lint.ts";

Deno.test("flags the argv order that cannot run, naming the canonical form", () => {
  const issues = lintCommandText(
    "swamp model fleet method run discover --input cidr=10.0.0.0/24",
  );
  assertEquals(issues.length, 1);
  assertEquals(issues[0].rule, "invalid-argv");
  assertEquals(issues[0].severity, "error");
  assertEquals(issues[0].line, 1);
  // The message must teach the working form, not just complain.
  assertEquals(issues[0].message.includes("swamp behavior run fleet"), true);
});

Deno.test("accepts the canonical and legacy forms, and model subcommands", () => {
  const text = [
    "swamp behavior run fleet discover",
    "swamp model method run fleet discover",
    "swamp model create @svendowideit/fleet-inventory fleet",
    "swamp model get fleet --json",
  ].join("\n");
  assertEquals(lintCommandText(text), []);
});

Deno.test("catches the stray `method` word the wrong form taught", () => {
  const issues = lintCommandText("swamp behavior run fleet method discover");
  assertEquals(issues.length, 1);
  assertEquals(issues[0].rule, "invalid-argv");
});

Deno.test("a line past the pasteable width is reported, but only as a warning", () => {
  const long = "swamp behavior run fleet discover " +
    `--input 'feeds:json=[{"name":"mk2s",` +
    `"hostnames":["mk2s.fi.gy","mk2s"]}]'`;
  assertEquals(long.length > MAX_COMMAND_LINE, true);
  const issues = lintCommandText(long);
  assertEquals(issues.length, 1);
  assertEquals(issues[0].rule, "unpasteable-line");
  assertEquals(issues[0].severity, "warning");
});

Deno.test("a wrap without a trailing backslash is a broken continuation", () => {
  const issues = lintCommandText(
    "swamp behavior run fleet probe\n  --input 'hosts:json=[\"10.10.3.253\"]'",
  );
  assertEquals(issues.length, 1);
  assertEquals(issues[0].rule, "broken-continuation");
  assertEquals(issues[0].severity, "error");
});

Deno.test("prose that starts with the word swamp is not a command", () => {
  const prose =
    "swamp vault at run time through `ctx.vaultService`, not interpolated " +
    "into the definition, and never logged.";
  assertEquals(lintCommandText(prose), []);
});

Deno.test("a quote split across lines is an error; a legal wrap is not", () => {
  const balanced = lintCommandText(
    `swamp behavior run fleet discover --input 'feeds:json=[{"name":"mk2s"}]'`,
  );
  assertEquals(balanced, []);
  const unbalanced = lintCommandText(
    "swamp behavior run fleet discover --input 'feeds:json=[\n",
  );
  assertEquals(unbalanced.length, 1);
  assertEquals(unbalanced[0].rule, "split-quote");
  const legal = lintCommandText(
    "swamp behavior run fleet discover \\\n  --input 'feeds:json=[]'\n",
  );
  assertEquals(legal, []);
});
