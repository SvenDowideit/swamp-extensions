import { assertEquals } from "jsr:@std/assert@1";
import { generatePlan, nextMonday } from "./zwift_coach_plan.ts";
import { fitnessFixture, goalFixture } from "./zwift_coach_fixtures.ts";
import { renderZwo, validateZwo } from "./zwift_coach_workouts.ts";

Deno.test("generatePlan produces the requested weeks and sessions", () => {
  const plan = generatePlan(fitnessFixture(), goalFixture());
  assertEquals(plan.weeks.length, 12);
  assertEquals(plan.weeks[0].sessions.length, 4);
  assertEquals(plan.weeks.every((w) => w.sessions.length === 4), true);
  assertEquals(plan.summary.totalHours > 0, true);
  assertEquals(plan.summary.targetCtl, 57);
});

Deno.test("every week has one fun session", () => {
  const plan = generatePlan(fitnessFixture(), goalFixture());
  for (const week of plan.weeks) {
    assertEquals(
      week.sessions.filter((s) => s.fun).length,
      1,
      `week ${week.index}`,
    );
  }
});

Deno.test("recovery weeks are lower than the preceding work week", () => {
  const plan = generatePlan(fitnessFixture(), goalFixture());
  const recovery = plan.weeks.find((w) => w.phase === "recovery");
  assertEquals(recovery !== undefined, true);
  if (recovery) {
    const previous = plan.weeks[recovery.index - 2];
    assertEquals(recovery.weeklyTss < previous.weeklyTss, true);
  }
});

Deno.test("sessions render as valid ZWO", () => {
  const plan = generatePlan(fitnessFixture(), goalFixture());
  for (const session of plan.weeks[0].sessions) {
    const xml = renderZwo(session);
    assertEquals(validateZwo(xml), [], session.id);
  }
});

Deno.test("a 12-week plan includes base, build, peak, recovery and taper", () => {
  const plan = generatePlan(fitnessFixture(), goalFixture());
  const phases = new Set(plan.weeks.map((w) => w.phase));
  assertEquals(phases.has("base"), true);
  assertEquals(phases.has("build"), true);
  assertEquals(phases.has("peak"), true);
  assertEquals(phases.has("recovery"), true);
  assertEquals(phases.has("taper"), true);
});

Deno.test("nextMonday is idempotent on a Monday", () => {
  assertEquals(nextMonday("2026-05-04"), "2026-05-04");
  assertEquals(nextMonday("2026-05-06"), "2026-05-11");
});
