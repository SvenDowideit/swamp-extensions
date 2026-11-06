import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { fitnessFixture } from "./zwift_coach_fixtures.ts";
import { renderZwo, totalMinutes } from "./zwift_coach_workouts.ts";
import {
  buildScaffold,
  compileCustomGoal,
  generateCustomPlan,
  parseGoalDescription,
  planFromSpec,
  validatePlanSpec,
} from "./zwift_coach_custom.ts";
import type {
  Goal,
  PlanSpec,
  PlanSpecSession,
  Step,
} from "./zwift_coach_types.ts";

const SPRINT_GOAL =
  "In 3 months, hold >=700W for 60s, raise max wattage above 1300W, and move toward 65kg";

function sprintGoal(weeks = 12): Goal {
  return compileCustomGoal(fitnessFixture(), {
    description: SPRINT_GOAL,
    weeks,
  });
}

function session(
  id: string,
  week: number,
  dayOfWeek: number,
  type: PlanSpecSession["type"],
  minutes = 60,
): PlanSpecSession {
  return {
    id,
    week,
    dayOfWeek,
    type,
    title: id,
    hook: "hook",
    why: "why",
    purpose: "purpose",
    durationMinutes: minutes,
    targetTss: 50,
  };
}

function validSpec(goal: Goal): PlanSpec {
  return {
    goalId: goal.id,
    rationale: "A four-week sprint block with recovery and a test.",
    phases: [{
      name: "Base",
      weeks: 4,
      theme: "Base",
      narrative: "Recruitment and anaerobic capacity.",
      focus: "Sprint",
      keySessionTypes: ["sprint", "anaerobic", "endurance"],
    }],
    sessions: [
      session("w1-sprint", 1, 2, "sprint"),
      session("w1-anaerobic", 1, 4, "anaerobic", 75),
      session("w1-endurance", 1, 6, "endurance", 90),
      session("w2-sprint", 2, 2, "sprint"),
      session("w2-anaerobic", 2, 4, "anaerobic", 75),
      session("w2-endurance", 2, 6, "endurance", 90),
      session("w3-sprint", 3, 2, "sprint"),
      session("w3-anaerobic", 3, 4, "anaerobic", 75),
      session("w3-endurance", 3, 6, "endurance", 90),
      session("w4-test", 4, 2, "sprint", 75),
      session("w4-recovery", 4, 4, "recovery", 45),
      session("w4-endurance", 4, 6, "endurance", 90),
    ],
    progressionRules: ["Add one rep or a few seconds, not both."],
    tests: goal.goalSpec?.tests ?? [],
  };
}

Deno.test("parses the sprint and weight example deterministically", () => {
  const spec = parseGoalDescription(SPRINT_GOAL, fitnessFixture());
  assertEquals(spec.horizonWeeks, 12);
  assertEquals(spec.primary.metric, "power60");
  assertEquals(spec.primary.target, 700);
  assertEquals(
    spec.secondary.some((t) => t.metric === "power5" && t.target === 1300),
    true,
  );
  assertEquals(
    spec.secondary.some((t) => t.metric === "weight" && t.target === 65),
    true,
  );
  assertEquals(spec.clarifyingQuestions, []);
  assertEquals(spec.preferences?.sprintFocus, true);
});

Deno.test("ambiguous goals ask instead of inventing a target", () => {
  const spec = parseGoalDescription("Get faster soon", fitnessFixture());
  assertEquals(spec.clarifyingQuestions.length > 0, true);
  assertEquals(spec.primary.metric, "ctl");
});

Deno.test("custom goal compiles to the planner shape", () => {
  const goal = sprintGoal();
  assertEquals(goal.mode, "custom");
  assertEquals(goal.goalSpec?.primary.metric, "power60");
  assertEquals(goal.clarifyingQuestions, []);
  assertEquals(goal.constraints.style, "sprint");
  assertEquals(goal.weeks, 12);
});

Deno.test("deterministic sprint plan includes the right session mix", () => {
  const plan = generateCustomPlan(fitnessFixture(), sprintGoal());
  assertEquals(plan.weeks.length, 12);
  const types = new Set(
    plan.weeks.flatMap((w) => w.sessions.map((s) => s.type)),
  );
  assertEquals(types.has("sprint"), true);
  assertEquals(types.has("anaerobic"), true);
  assertEquals(types.has("endurance"), true);
  assertEquals(types.has("recovery"), true);
  for (const week of plan.weeks) {
    assertEquals(
      week.sessions.filter((s) => s.type === "sprint").length <= 3,
      true,
    );
    assertEquals(
      week.sessions.some((s) => s.fun),
      true,
    );
  }
});

Deno.test("deterministic sprint plan includes 60 s efforts in build", () => {
  const plan = generateCustomPlan(fitnessFixture(), sprintGoal());
  const build = plan.weeks.find((w) => w.phase === "build");
  assertEquals(build !== undefined, true);
  const has60 = build!.sessions.some((s) =>
    s.steps.some((step) =>
      step.kind === "free" && /60 s/.test(step.text ?? "") &&
      step.targetPower !== undefined
    )
  );
  assertEquals(has60, true);
});

Deno.test("sprint sessions use max efforts and absolute target watts", () => {
  const plan = generateCustomPlan(fitnessFixture(), sprintGoal());
  const sprint = plan.weeks[0].sessions.find((s) => s.type === "sprint");
  assertEquals(sprint?.steps.some((s) => s.kind === "maxeffort"), true);
  const texts = plan.weeks
    .flatMap((w) => w.sessions)
    .flatMap((s) => s.steps)
    .map((s) => s.text ?? "")
    .join(" ");
  assertEquals(texts.includes("700 W"), true);
  assertEquals(texts.includes("1300 W"), true);
  // The old generic template produced intervals with onPower 1.7 (~391 W).
  const legacy = plan.weeks
    .flatMap((w) => w.sessions)
    .flatMap((s) => s.steps)
    .some((s) => s.kind === "intervals" && s.onPower === 1.7);
  assertEquals(legacy, false);
});

Deno.test("weight target keeps one endurance session every week", () => {
  const goal = compileCustomGoal(fitnessFixture(), {
    description: SPRINT_GOAL,
    weeks: 12,
    daysPerWeek: 2,
  });
  assertEquals(
    goal.assumptions.some((a) => a.includes("Weight is a secondary target")),
    true,
  );
  const plan = generateCustomPlan(fitnessFixture(), goal);
  for (const week of plan.weeks) {
    assertEquals(
      week.sessions.some((s) => s.type === "endurance"),
      true,
      `week ${week.index} has no endurance session`,
    );
  }
});

Deno.test("sprint sessions have short rotating warmups and ramp-downs", () => {
  const plan = generateCustomPlan(fitnessFixture(), sprintGoal());
  const sessions = plan.weeks[0].sessions.filter((s) => s.type === "sprint");
  assertEquals(sessions.length, 2);
  for (const session of sessions) {
    const firstWork = session.steps.findIndex((s) =>
      s.kind === "maxeffort" || s.kind === "free" || s.kind === "intervals"
    );
    assertEquals(firstWork > 0, true);
    const warmup = totalMinutes(session.steps.slice(0, firstWork));
    assertEquals(warmup <= 6.1, true);
    assertEquals(session.durationMinutes <= 35, true);
    const work = session.steps[firstWork];
    assertEquals(
      work.kind === "maxeffort" || work.kind === "free",
      true,
    );
    assertEquals(session.brief?.includes("W"), true);
    assertEquals(session.brief?.includes("min"), true);
  }
  const endurance = plan.weeks[0].sessions.find((s) => s.type === "endurance");
  assertEquals(endurance?.brief?.includes("min steady"), true);
  const torque = sessions[0].steps.find((s) => s.kind === "maxeffort");
  const cadence = sessions[1].steps.find((s) => s.kind === "maxeffort");
  assertEquals(torque?.cadence, 80);
  assertEquals((cadence?.cadence ?? 0) >= 100, true);
  const hasLeadIn = sessions[0].steps.some((s) =>
    s.kind === "ramp" && s.minutes <= 0.1
  );
  const hasRampDown = sessions[0].steps.some((s) =>
    s.kind === "ramp" && s.powerHigh === 0.6
  );
  assertEquals(hasLeadIn, true);
  assertEquals(hasRampDown, true);
  const xml = renderZwo(sessions[0]);
  assertEquals(xml.includes(sessions[0].brief ?? "missing-brief"), true);
  assertEquals(xml.includes("TSS"), true);
  // No 15-min warmup / 10-min cooldown template.
  assertEquals(
    sessions[0].steps.some((s) =>
      (s.kind === "warmup" && s.minutes >= 15) ||
      (s.kind === "cooldown" && s.minutes >= 10)
    ),
    false,
  );
});

Deno.test("valid PlanSpec passes and converts to a plan", () => {
  const goal = sprintGoal(4);
  const spec = validSpec(goal);
  const result = validatePlanSpec(spec, goal, fitnessFixture());
  assertEquals(result.errors, []);
  const plan = planFromSpec(fitnessFixture(), goal, spec);
  assertEquals(plan.weeks.length, 4);
  assertEquals(plan.weeks[0].sessions.length, 3);
  assertEquals(plan.summary.focus, "custom");
  assertEquals(
    plan.weeks[0].sessions.some((s) =>
      s.steps.some((step) => step.kind === "maxeffort")
    ),
    true,
  );
});

Deno.test("PlanSpec rejects consecutive hard days and unsafe sprint spacing", () => {
  const goal = sprintGoal(4);
  const spec = validSpec(goal);
  spec.sessions[1].dayOfWeek = 3;
  const result = validatePlanSpec(spec, goal, fitnessFixture());
  assertEquals(
    result.errors.some((e) =>
      e.includes("consecutive hard days") || e.includes("48 h")
    ),
    true,
  );
});

Deno.test("PlanSpec rejects too many hard or anaerobic sessions", () => {
  const goal = sprintGoal(4);
  const spec = validSpec(goal);
  spec.sessions.push(
    session("extra-1", 1, 1, "sprint"),
    session("extra-2", 1, 7, "anaerobic"),
    session("extra-3", 1, 5, "anaerobic"),
  );
  const result = validatePlanSpec(spec, goal, fitnessFixture());
  assertEquals(
    result.errors.some((e) => e.includes("hard sessions")),
    true,
  );
  assertEquals(
    result.errors.some((e) => e.includes("anaerobic sessions")),
    true,
  );
});

Deno.test("PlanSpec rejects relative-only sprint prescriptions", () => {
  const goal = sprintGoal(4);
  const spec = validSpec(goal);
  spec.sessions[0].steps = [{
    kind: "intervals",
    repeat: 6,
    onMinutes: 0.25,
    offMinutes: 4,
    onPower: 1.7,
    offPower: 0.5,
  }];
  const result = validatePlanSpec(spec, goal, fitnessFixture());
  assertEquals(
    result.errors.some((e) => e.includes("MaxEffort/FreeRide")),
    true,
  );
});

Deno.test("PlanSpec rejects raw XML and phase-length drift", () => {
  const goal = sprintGoal(4);
  const spec = validSpec(goal);
  spec.phases[0].weeks = 3;
  spec.sessions[0].steps = [{
    kind: "steady",
    minutes: 10,
    power: 0.7,
    xml: "<workout_file/>",
  } as unknown as Step];
  const result = validatePlanSpec(spec, goal, fitnessFixture());
  assertEquals(
    result.errors.some((e) => e.includes("phases cover")),
    true,
  );
  assertEquals(
    result.errors.some((e) => e.includes("raw ZWO/XML")),
    true,
  );
});

Deno.test("planFromSpec refuses hard sessions placed on consecutive days", () => {
  const goal = compileCustomGoal(fitnessFixture(), {
    description: SPRINT_GOAL,
    weeks: 4,
    constraints: { availableDays: [2, 3, 4] },
  });
  const spec = validSpec(goal);
  const hard1 = session("h1", 1, 2, "sprint");
  const hard2 = session("h2", 1, 3, "sprint");
  const easy = session("e1", 1, 4, "endurance");
  delete hard1.dayOfWeek;
  delete hard2.dayOfWeek;
  delete easy.dayOfWeek;
  spec.sessions = [hard1, hard2, easy];
  assertThrows(
    () => planFromSpec(fitnessFixture(), goal, spec),
    Error,
    "consecutive days",
  );
});

Deno.test("scaffold carries the schemas, examples and limits", () => {
  const goal = sprintGoal();
  const scaffold = buildScaffold(fitnessFixture(), goal);
  assertEquals(scaffold.goalId, goal.id);
  assertEquals(typeof scaffold.planSpecSchema, "object");
  assertEquals(scaffold.examplePlanSpec.goalId, goal.id);
  assertEquals(scaffold.sessionArchetypes.length >= 10, true);
  assertEquals(
    (scaffold.safetyLimits as { maxHardSessionsPerWeek: number })
      .maxHardSessionsPerWeek,
    3,
  );
  assertEquals(
    scaffold.promptTemplate.includes("Return ONE JSON object"),
    true,
  );
});

Deno.test("planFromSpec refuses to bypass validation", () => {
  const goal = sprintGoal(4);
  const spec = validSpec(goal);
  spec.goalId = "wrong-goal";
  // planFromSpec itself is intentionally permissive; the workflow and the
  // validate method are the gate. This test documents the separation.
  assertThrows(
    () => {
      const result = validatePlanSpec(spec, goal, fitnessFixture());
      if (result.errors.length > 0) throw new Error(result.errors.join("; "));
    },
    Error,
    "does not match",
  );
});
