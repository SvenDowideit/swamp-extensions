import { assertEquals } from "jsr:@std/assert@1";
import { model } from "./zwift_coach.ts";
import { compileCustomGoal, generateCustomPlan } from "./zwift_coach_custom.ts";
import { fitnessFixture } from "./zwift_coach_fixtures.ts";

const SPRINT_GOAL =
  "In 3 months, hold >=700W for 60s, raise max wattage above 1300W, and move toward 65kg";

type Writes = {
  resource: string;
  name: string;
  value: Record<string, unknown>;
};

function mockCtx(): { ctx: unknown; writes: Writes[] } {
  const writes: Writes[] = [];
  return {
    writes,
    ctx: {
      globalArgs: { timezone: "" },
      logger: { info() {} },
      writeResource: (
        resource: string,
        name: string,
        value: Record<string, unknown>,
      ) => {
        writes.push({ resource, name, value });
        return Promise.resolve({ resource, name });
      },
      readResource: () => Promise.resolve(null),
      readModelData: () => Promise.resolve(null),
    },
  };
}

type Executable = {
  execute: (
    args: Record<string, unknown>,
    ctx: unknown,
  ) => Promise<{ dataHandles: unknown[] }>;
};

const methods = model.methods as unknown as Record<string, Executable>;

Deno.test("model goal custom writes a custom GoalSpec", async () => {
  const { ctx, writes } = mockCtx();
  await methods.goal.execute({
    fitness: fitnessFixture(),
    mode: "custom",
    description: SPRINT_GOAL,
  }, ctx);
  const value = writes.find((w) => w.name === "goal-current")?.value;
  assertEquals(value?.mode, "custom");
  assertEquals((value?.primary as { metric: string }).metric, "power60");
  assertEquals(
    (value?.goalSpec as { clarifyingQuestions: string[] }).clarifyingQuestions,
    [],
  );
});

Deno.test("model ssh-transport omits empty overrides", async () => {
  const { ctx, writes } = mockCtx();
  await methods["ssh-transport"].execute({
    sshUser: "",
    sshKey: "",
    sshPort: 22,
    sshHostKeyChecking: "accept-new",
  }, ctx);
  const value = writes.find((w) => w.name === "transport-current")?.value;
  assertEquals(value?.transport, {
    kind: "ssh",
    port: 22,
    strictHostKeyChecking: "accept-new",
  });
});

Deno.test("preview explains TSS/CTL and includes watts/cadence briefs", async () => {
  const { ctx, writes } = mockCtx();
  const goal = compileCustomGoal(fitnessFixture(), {
    description: SPRINT_GOAL,
  });
  const plan = generateCustomPlan(fitnessFixture(), goal);
  await methods.preview.execute({
    plan: plan as unknown as Record<string, unknown>,
    render: {},
  }, ctx);
  const markdown = writes.find((w) => w.name === "preview-current")?.value
    .markdown as string;
  assertEquals(markdown.includes("What the numbers mean"), true);
  assertEquals(markdown.includes("TSS (training stress score)"), true);
  assertEquals(markdown.includes("CTL (chronic training load)"), true);
  assertEquals(markdown.includes("rpm"), true);
  assertEquals(markdown.includes("W"), true);
});

Deno.test("model validate writes fail-closed errors", async () => {
  const { ctx, writes } = mockCtx();
  const goal = compileCustomGoal(fitnessFixture(), {
    description: SPRINT_GOAL,
    weeks: 4,
  });
  await methods.validate.execute({
    fitness: fitnessFixture(),
    goal: goal as unknown as Record<string, unknown>,
    planSpec: {
      goalId: "wrong",
      rationale: "bad",
      phases: [{
        name: "Base",
        weeks: 2,
        theme: "",
        narrative: "",
        focus: "",
        keySessionTypes: [],
      }],
      sessions: [],
      progressionRules: [],
      tests: [],
    },
  }, ctx);
  const value = writes.find((w) => w.name === "validation-current")?.value;
  const errors = value?.errors as string[];
  assertEquals(errors.length > 0, true);
  assertEquals(errors.some((e) => e.includes("does not match")), true);
});
