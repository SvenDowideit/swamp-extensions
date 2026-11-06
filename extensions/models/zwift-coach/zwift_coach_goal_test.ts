import { assertEquals } from "jsr:@std/assert@1";
import { compileGoal, rampDefaults } from "./zwift_coach_goal.ts";
import { fitnessFixture } from "./zwift_coach_fixtures.ts";

Deno.test("regain targets 92.5% of sustained peak", () => {
  const goal = compileGoal({ fitness: fitnessFixture(), mode: "regain" });
  assertEquals(goal.targetCtl > 52, true);
  assertEquals(goal.targetCtl <= 66, true);
  assertEquals(goal.constraints.daysPerWeek, 4);
  assertEquals(goal.constraints.hoursPerWeek, 7);
});

Deno.test("improve adds 5% FTP by default", () => {
  const goal = compileGoal({ fitness: fitnessFixture(), mode: "improve" });
  assertEquals(goal.targetFtp, 262.5);
  assertEquals(goal.weeks, 12);
});

Deno.test("event goal derives weeks from the target date", () => {
  const goal = compileGoal({
    fitness: fitnessFixture(),
    mode: "event",
    targetDate: "2027-02-01",
    eventType: "climb",
  });
  assertEquals(goal.weeks > 4, true);
  assertEquals(goal.mode, "event");
});

Deno.test("overriding availability above p80 warns", () => {
  const goal = compileGoal({
    fitness: fitnessFixture(),
    mode: "improve",
    daysPerWeek: 6,
    hoursPerWeek: 10,
    overrideAvailability: true,
  });
  assertEquals(goal.warnings.length > 0, true);
});

Deno.test("ramp defaults get more conservative with age", () => {
  assertEquals(rampDefaults(30).rampPerWeek, 5);
  assertEquals(rampDefaults(48).rampPerWeek, 4);
  assertEquals(rampDefaults(62).rampPerWeek, 2.5);
});

Deno.test("custom goals are explicitly out of Phase 2", () => {
  let failed = false;
  try {
    compileGoal({ fitness: fitnessFixture(), mode: "custom" });
  } catch {
    failed = true;
  }
  assertEquals(failed, true);
});
