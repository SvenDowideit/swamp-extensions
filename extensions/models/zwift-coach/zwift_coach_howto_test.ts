import { assertEquals } from "jsr:@std/assert@1";
import { buildHowtoReport } from "./zwift_coach_howto.ts";
import { fitnessFixture, goalFixture } from "./zwift_coach_fixtures.ts";
import { generatePlan } from "./zwift_coach_plan.ts";

Deno.test("every documented data query asks for JSON", () => {
  const plan = generatePlan(fitnessFixture(), goalFixture());
  const report = buildHowtoReport({
    coachName: "zwift-coach",
    plan,
    render: { workouts: new Array(6).fill({}) },
  });
  const commandLines = report
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("swamp data query"));
  assertEquals(commandLines.length >= 4, true);
  for (const line of commandLines) {
    assertEquals(line.includes("--single --json --select content"), true, line);
  }
});

Deno.test("howto report includes the plan headline and guidance", () => {
  const plan = generatePlan(fitnessFixture(), goalFixture());
  const report = buildHowtoReport({
    coachName: "zwift-coach",
    plan,
    render: { workouts: new Array(2).fill({}) },
  });
  assertEquals(report.includes(`Plan ${plan.id}:`), true);
  assertEquals(report.includes("START HERE"), true);
  assertEquals(report.includes("Expect: 2 rows"), true);
});
