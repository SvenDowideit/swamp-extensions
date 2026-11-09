import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.14";
import { buildAgentCommand } from "./obsidian_agent.ts";

Deno.test("pi runs headless with no session, the pinned model and the prompt", () => {
  const { binary, args } = buildAgentCommand(
    "pi",
    "/repo",
    "do the work",
    "system rules",
    "ollama-cloud/deepseek-v4.1-flash",
  );
  assertEquals(binary, "pi");
  assertStringIncludes(args.join(" "), "--print");
  assertStringIncludes(args.join(" "), "--no-session");
  assertStringIncludes(args.join(" "), "--model ollama-cloud/deepseek-v4.1-flash");
  assertStringIncludes(args.join(" "), "--system-prompt system rules");
  assertEquals(args[args.length - 1], "do the work");
  assertEquals(args[args.length - 2], "--");
});

Deno.test("claude and opencode receive the model", () => {
  const claude = buildAgentCommand("claude", "/repo", "p", "s", "m");
  assertEquals(claude.binary, "claude");
  assertStringIncludes(claude.args.join(" "), "--model m");
  const opencode = buildAgentCommand("opencode", "/repo", "p", "s", "m");
  assertEquals(opencode.binary, "opencode");
  assertStringIncludes(opencode.args.join(" "), "--system-prompt=s");
});

Deno.test("kilo runs with the workdir and prompt after --", () => {
  const { binary, args } = buildAgentCommand(
    "kilo",
    "/repo",
    "p",
    "s",
    "m",
  );
  assertEquals(binary, "kilo");
  assertStringIncludes(args.join(" "), "--dir /repo");
  assertEquals(args[args.length - 1], "s\n\np");
});
