import { assertEquals } from "jsr:@std/assert@1";
import { fitnessFixture, goalFixture } from "./zwift_coach_fixtures.ts";
import { generatePlan } from "./zwift_coach_plan.ts";
import { compileCustomGoal, generateCustomPlan } from "./zwift_coach_custom.ts";
import { reviewPlan, sessionOutcomes } from "./zwift_coach_review.ts";
import type { Plan, Session } from "./zwift_coach_types.ts";
import { addDays } from "./zwift_coach_util.ts";

function rideFor(session: Session, minutes = session.durationMinutes) {
  return {
    id: `ride-${session.id}`,
    localDate: session.date,
    durationSeconds: minutes * 60,
    movingSeconds: minutes * 60,
    tss: session.computedTss,
    name: `Did ${session.title}`,
  };
}

function sessionsBefore(plan: Plan, asOf: string): Session[] {
  return plan.weeks
    .flatMap((w) => w.sessions)
    .filter((s) => s.date < asOf)
    .sort((a, b) => a.date.localeCompare(b.date));
}

Deno.test("review compares completed, partial and skipped sessions", () => {
  const plan = generatePlan(fitnessFixture(), goalFixture());
  const asOf = addDays(plan.startDate, 21);
  const planned = sessionsBefore(plan, asOf);
  const rides = planned.slice(0, 2).map((s) => rideFor(s));
  rides.push(rideFor(planned[2], Math.round(planned[2].durationMinutes * 0.4)));
  const outcomes = sessionOutcomes(plan, rides, asOf);
  assertEquals(outcomes.length, planned.length);
  assertEquals(outcomes.filter((o) => o.status === "completed").length, 2);
  assertEquals(outcomes.filter((o) => o.status === "partial").length, 1);
  assertEquals(
    outcomes.filter((o) => o.status === "skipped").length,
    planned.length - 3,
  );
});

Deno.test("review detects boredom and fun-session skipping", () => {
  const plan = generatePlan(fitnessFixture(), goalFixture());
  const asOf = addDays(plan.startDate, 21);
  const planned = sessionsBefore(plan, asOf);
  const rides = planned
    .filter((s) => !s.fun)
    .map((s) => rideFor(s));
  const feedback = [
    { date: addDays(asOf, -2), enjoyment: 1, bored: true, wouldRepeat: false },
    { date: addDays(asOf, -3), enjoyment: 2, wouldRepeat: false },
  ];
  const result = reviewPlan({
    plan,
    fitness: fitnessFixture(),
    rides,
    feedback,
    asOf,
  });
  assertEquals(result.signals.some((s) => s.id === "explicit-bored"), true);
  assertEquals(result.signals.some((s) => s.id === "low-enjoyment"), true);
  assertEquals(result.signals.some((s) => s.id === "fun-skipped"), true);
  assertEquals(result.changes.some((c) => c.kind === "rotate-fun"), true);
  assertEquals(result.summaryMarkdown.includes("Weekly review"), true);
  assertEquals(result.summaryMarkdown.includes("What changed"), true);
  assertEquals(result.summaryMarkdown.includes("Next week"), true);
});

Deno.test("review swaps a consistently skipped type without changing the past", () => {
  const goal = goalFixture();
  goal.constraints = { ...goal.constraints, daysPerWeek: 5 };
  const plan = generatePlan(fitnessFixture(), goal);
  const asOf = addDays(plan.startDate, 14);
  const planned = sessionsBefore(plan, asOf);
  const rides = planned
    .filter((s) => s.type !== "sweetspot")
    .map((s) => rideFor(s));
  const before = plan.weeks.slice(0, 2).flatMap((w) => w.sessions).map(
    (s) => `${s.id}|${s.type}|${s.date}`,
  );
  const result = reviewPlan({
    plan,
    fitness: fitnessFixture(),
    rides,
    feedback: [{ date: planned[0].date, enjoyment: 3 }],
    asOf,
  });
  assertEquals(
    result.signals.some((s) =>
      s.id === "type-skipped" && s.type === "sweetspot"
    ),
    true,
  );
  assertEquals(
    result.changes.some((c) => c.kind === "swap-boring-type"),
    true,
  );
  const future = result.adaptedPlan.weeks
    .flatMap((w) => w.sessions)
    .filter((s) => s.date >= asOf);
  assertEquals(future.some((s) => s.type === "overunder"), true);
  const afterPast = result.adaptedPlan.weeks.slice(0, 2)
    .flatMap((w) => w.sessions)
    .map((s) => `${s.id}|${s.type}|${s.date}`);
  assertEquals(afterPast, before);
});

Deno.test("review shortens future easy work when adherence is low", () => {
  const plan = generatePlan(fitnessFixture(), goalFixture());
  const asOf = addDays(plan.startDate, 21);
  const planned = sessionsBefore(plan, asOf);
  const rides = [rideFor(planned[0])];
  const before = plan.weeks
    .flatMap((w) => w.sessions)
    .filter((s) => s.date >= asOf && s.type === "endurance")
    .map((s) => s.durationMinutes);
  const result = reviewPlan({
    plan,
    fitness: fitnessFixture(),
    rides,
    feedback: [],
    asOf,
  });
  assertEquals(result.signals.some((s) => s.id === "adherence-low"), true);
  assertEquals(result.changes.some((c) => c.kind === "reduce-volume"), true);
  const after = result.adaptedPlan.weeks
    .flatMap((w) => w.sessions)
    .filter((s) => s.date >= asOf && s.type === "endurance")
    .map((s) => s.durationMinutes);
  assertEquals(after.some((n, i) => n < before[i]), true);
});

Deno.test("volume reduction is applied once per plan", () => {
  const plan = generatePlan(fitnessFixture(), goalFixture());
  const asOf = addDays(plan.startDate, 21);
  const planned = sessionsBefore(plan, asOf);
  const rides = [rideFor(planned[0])];
  const first = reviewPlan({
    plan,
    fitness: fitnessFixture(),
    rides,
    feedback: [],
    asOf,
  });
  assertEquals(
    first.changes.some((c) => c.kind === "reduce-volume"),
    true,
  );
  const before = first.adaptedPlan.weeks
    .flatMap((w) => w.sessions)
    .filter((s) => s.date >= asOf && s.type === "endurance")
    .map((s) => s.durationMinutes);
  const second = reviewPlan({
    plan: first.adaptedPlan,
    fitness: fitnessFixture(),
    rides,
    feedback: [],
    asOf,
  });
  assertEquals(
    second.changes.some((c) => c.kind === "reduce-volume"),
    false,
  );
  const after = second.adaptedPlan.weeks
    .flatMap((w) => w.sessions)
    .filter((s) => s.date >= asOf && s.type === "endurance")
    .map((s) => s.durationMinutes);
  assertEquals(after, before);
});

Deno.test("review protects readiness by replacing the next hard session", () => {
  const plan = generatePlan(fitnessFixture(), goalFixture());
  const fitness = fitnessFixture();
  fitness.flags.readinessLow = true;
  const asOf = plan.startDate;
  const result = reviewPlan({
    plan,
    fitness,
    rides: [],
    feedback: [],
    asOf,
  });
  assertEquals(result.signals.some((s) => s.id === "readiness-low"), true);
  assertEquals(
    result.changes.some((c) => c.kind === "protect-readiness"),
    true,
  );
  const changed = result.adaptedPlan.weeks
    .flatMap((w) => w.sessions)
    .find((s) => s.date >= asOf);
  assertEquals(
    changed?.type === "recovery" || changed?.type === "endurance",
    true,
  );
});

Deno.test("feedback is acted on once, not every review", () => {
  const goal = compileCustomGoal(fitnessFixture(), {
    description:
      "In 3 months, hold >=700W for 60s, raise max wattage above 1300W, and move toward 65kg",
    weeks: 12,
  });
  const plan = generateCustomPlan(fitnessFixture(), goal);
  const asOf = addDays(plan.startDate, 7);
  const feedback = [{
    date: addDays(asOf, -1),
    recordedAt: "2026-11-18T10:00:00.000Z",
    cadenceMaxed: true,
    recoveryTooAbrupt: true,
  }];
  const first = reviewPlan({
    plan,
    fitness: fitnessFixture(),
    rides: [],
    feedback,
    asOf,
  });
  const second = reviewPlan({
    plan: first.adaptedPlan,
    fitness: fitnessFixture(),
    rides: [],
    feedback,
    feedbackSince: "2026-11-19T00:00:00.000Z",
    asOf,
  });
  assertEquals(
    first.changes.some((c) => c.kind === "cadence-adjust"),
    true,
  );
  assertEquals(
    second.changes.some((c) => c.kind === "cadence-adjust"),
    false,
  );
});

Deno.test("review uses the goal weight target and does not add load when gaining", () => {
  const plan = generatePlan(fitnessFixture(), goalFixture());
  const fitness = fitnessFixture();
  fitness.weight.currentKg = 88;
  fitness.weight.trend7dKg = 0.2;
  fitness.weight.targetKg = null;
  const result = reviewPlan({
    plan,
    fitness,
    goal: goalFixture(),
    rides: [],
    feedback: [],
    asOf: plan.startDate,
  });
  assertEquals(result.metrics.weight.targetKg, 65);
  assertEquals(result.metrics.weight.status, "gaining");
  assertEquals(
    result.signals.some((s) => s.id === "weight-gaining"),
    true,
  );
  assertEquals(
    result.changes.some((c) => c.kind === "weight-stalled"),
    false,
  );
});

Deno.test("review adjusts future sprint cadence and recovery from feedback", () => {
  const goal = compileCustomGoal(fitnessFixture(), {
    description:
      "In 3 months, hold >=700W for 60s, raise max wattage above 1300W, and move toward 65kg",
    weeks: 12,
  });
  const plan = generateCustomPlan(fitnessFixture(), goal);
  const asOf = addDays(plan.startDate, 7);
  const feedback = [
    {
      date: addDays(asOf, -1),
      cadenceMaxed: true,
      recoveryTooAbrupt: true,
      enjoyment: 2,
    },
  ];
  const beforeCadence = plan.weeks
    .flatMap((w) => w.sessions)
    .filter((s) =>
      s.date >= asOf && (s.type === "sprint" || s.type === "anaerobic")
    )
    .flatMap((s) => s.steps)
    .filter((s) => (s.kind === "maxeffort" || s.kind === "free") && s.cadence)
    .map((s) => s.cadence as number);
  const result = reviewPlan({
    plan,
    fitness: fitnessFixture(),
    rides: [],
    feedback,
    asOf,
  });
  assertEquals(result.signals.some((s) => s.id === "cadence-maxed"), true);
  assertEquals(result.signals.some((s) => s.id === "recovery-abrupt"), true);
  assertEquals(
    result.changes.some((c) => c.kind === "cadence-adjust"),
    true,
  );
  assertEquals(
    result.changes.some((c) => c.kind === "recovery-extend"),
    true,
  );
  const afterCadence = result.adaptedPlan.weeks
    .flatMap((w) => w.sessions)
    .filter((s) =>
      s.date >= asOf && (s.type === "sprint" || s.type === "anaerobic")
    )
    .flatMap((s) => s.steps)
    .filter((s) => (s.kind === "maxeffort" || s.kind === "free") && s.cadence)
    .map((s) => s.cadence as number);
  assertEquals(afterCadence.every((n, i) => n <= beforeCadence[i]), true);
  assertEquals(afterCadence.some((n, i) => n < beforeCadence[i]), true);
  assertEquals(result.summaryMarkdown.includes("130 rpm"), true);
  assertEquals(result.summaryMarkdown.includes("135 rpm"), false);
});
