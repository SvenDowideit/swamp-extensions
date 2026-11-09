/**
 * Headless agent runner for the Obsidian factory tick.
 *
 * This is a separate behavior from `obsidian-board` on purpose. The board owns
 * the per-instance lock while a method runs; if the agent ran as a board
 * method, every nested `swamp` command the agent needs would wait on the
 * board lock until the agent exits. Running from this behavior leaves the
 * board free for the agent's `readCard`, `setSummary`, claim and publish
 * commands, while still passing the swamp process environment (PATH, API
 * keys, HOME) through to the agent.
 *
 * @module
 */

import { z } from "npm:zod@4";

const AgentRunSchema = z.object({
  agent: z.string(),
  binary: z.string(),
  model: z.string(),
  workdir: z.string(),
  startedAt: z.string(),
  finishedAt: z.string(),
  durationMs: z.number(),
  exitCode: z.number(),
  success: z.boolean(),
  stdout: z.string(),
  stderr: z.string(),
});

type Context = {
  logger: {
    info: (message: string, props?: Record<string, unknown>) => void;
  };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
};

/** Build the headless-agent command. */
export function buildAgentCommand(
  agent: string,
  workdir: string,
  prompt: string,
  systemPrompt: string,
  model: string,
): { binary: string; args: string[] } {
  const full = systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
  const modelArgs = model.trim() ? ["--model", model.trim()] : [];
  switch (agent) {
    case "claude":
      return {
        binary: "claude",
        args: [
          "-p",
          "--dangerously-skip-permissions",
          ...modelArgs,
          full,
        ],
      };
    case "codex":
      return {
        binary: "codex",
        args: [
          "exec",
          "--dangerously-bypass-approvals-and-sandbox",
          ...modelArgs,
          full,
        ],
      };
    case "opencode":
      return {
        binary: "opencode",
        args: [
          ...modelArgs,
          prompt,
          `--system-prompt=${systemPrompt}`,
        ],
      };
    case "kilo":
      return {
        binary: "kilo",
        args: [
          "run",
          "--auto",
          "--dir",
          workdir,
          ...modelArgs,
          "--",
          full,
        ],
      };
    case "pi":
    default:
      return {
        binary: "pi",
        args: [
          "--print",
          "--mode",
          "text",
          "--no-session",
          ...modelArgs,
          ...(systemPrompt ? ["--system-prompt", systemPrompt] : []),
          "--approve",
          "--",
          prompt,
        ],
      };
  }
}

async function executeRun(
  args: {
    workdir: string;
    agent: string;
    model: string;
    systemPrompt: string;
    prompt: string;
  },
  context: Context,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const startedAt = new Date().toISOString();
  const { binary, args: argv } = buildAgentCommand(
    args.agent,
    args.workdir,
    args.prompt,
    args.systemPrompt,
    args.model,
  );
  context.logger.info("Running {binary} in {workdir} (model {model})", {
    binary,
    workdir: args.workdir,
    model: args.model || "(default)",
  });
  let stdout = "";
  let stderr = "";
  let exitCode = 1;
  try {
    // swamp-quality-ignore deno-command: launching the chosen agent is this behavior's purpose; the binary comes from the closed enum and the arguments are built here, never taken as a raw shell string.
    const command = new Deno.Command(binary, {
      args: argv,
      cwd: args.workdir,
      env: Deno.env.toObject(),
      stdout: "piped",
      stderr: "piped",
    });
    const output = await command.output();
    stdout = new TextDecoder().decode(output.stdout);
    stderr = new TextDecoder().decode(output.stderr);
    exitCode = output.code;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      stderr = `${binary}: command not found`;
      exitCode = 127;
    } else {
      stderr = error instanceof Error ? error.message : String(error);
    }
  }
  const finishedAt = new Date().toISOString();
  const handle = await context.writeResource("agent-run", `run-${args.agent}`, {
    agent: args.agent,
    binary,
    model: args.model,
    workdir: args.workdir,
    startedAt,
    finishedAt,
    durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
    exitCode,
    success: exitCode === 0,
    stdout,
    stderr,
  });
  return { dataHandles: [handle] };
}

export const model = {
  type: "@svendowideit/obsidian-agent",
  version: "2026.11.09.3",
  globalArguments: z.object({}),
  upgrades: [
    {
      toVersion: "2026.11.09.1",
      description: "Released with the board's title-only card filenames; no " +
        "global-argument or resource schema changes.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.11.09.2",
      description: "Released with the Board-note capture box; no " +
        "global-argument or resource schema changes.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.11.09.3",
      description: "Released with the idempotent Board-note capture box; no " +
        "global-argument or resource schema changes.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    "agent-run": {
      description:
        "One headless agent tick: command, environment, output and exit code",
      schema: AgentRunSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    run: {
      description:
        "Run one headless agent with the swamp process environment intact, capture its output and record the result. Used by the tick workflow from a behavior that does not hold the board lock.",
      arguments: z.object({
        workdir: z.string().min(1),
        agent: z.enum(["claude", "codex", "opencode", "kilo", "pi"]).default(
          "pi",
        ),
        model: z.string().default(""),
        systemPrompt: z.string().default(""),
        prompt: z.string().min(1),
      }),
      execute: executeRun,
    },
  },
};
