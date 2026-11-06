/**
 * Phase 4: custom goals and agent-authored plans.
 *
 * This module owns the two contracts the extension exposes to an external
 * agent:
 *
 * - `GoalSpec` — what the rider wants, parsed deterministically from common
 *   natural-language phrasing.
 * - `PlanSpec` — how to get there. The extension validates it fail-closed and
 *   converts it into the same `Plan` the built-in generator produces. Agents
 *   never write ZWO or bypass the safety rules.
 *
 * It also contains a deterministic custom-plan generator so the sprint example
 * works without an agent.
 *
 * @module
 */

import type {
  Fitness,
  Goal,
  GoalSpec,
  Plan,
  PlanSpec,
  PlanSpecPhase,
  PlanSpecSession,
  PlanValidation,
  Session,
  SessionType,
  Step,
  Target,
  Week,
} from "./zwift_coach_types.ts";
import {
  addDays,
  clamp,
  dateMs,
  dateString,
  daysBetween,
  hashString,
  round1,
  todayUtc,
} from "./zwift_coach_util.ts";
import { dayList, generatePlan, nextMonday } from "./zwift_coach_plan.ts";
import {
  averageIf,
  buildSession,
  totalMinutes,
  totalTss,
} from "./zwift_coach_workouts.ts";
import { rampDefaults } from "./zwift_coach_goal.ts";

export interface CustomGoalInput {
  description: string;
  startDate?: string;
  targetDate?: string;
  weeks?: number;
  daysPerWeek?: number;
  hoursPerWeek?: number;
  targetWeightKg?: number;
  overrideAvailability?: boolean;
  style?: "pyramidal" | "polarised" | "sprint";
  constraints?: {
    availableDays?: number[];
    maxSessionMinutes?: number;
    equipment?: string[];
    indoorOnly?: boolean;
    injuries?: string[];
  };
}

export interface Scaffold {
  goalId: string;
  generatedAt: string;
  goalSpecSchema: Record<string, unknown>;
  planSpecSchema: Record<string, unknown>;
  exampleGoalSpec: GoalSpec;
  examplePlanSpec: PlanSpec;
  fitnessSummary: Record<string, unknown>;
  availabilitySummary: Record<string, unknown>;
  sessionArchetypes: {
    type: SessionType;
    purpose: string;
    hard: boolean;
    defaultMinutes: number;
  }[];
  safetyLimits: Record<string, unknown>;
  promptTemplate: string;
  notes: string[];
}

const METRIC_RANK: Record<Target["metric"], number> = {
  power60: 0,
  power300: 1,
  ftp: 2,
  power15: 3,
  power5: 4,
  wkg: 5,
  ctl: 6,
  weight: 7,
  event: 8,
};

const HARD_TYPES = new Set<SessionType>([
  "sprint",
  "anaerobic",
  "vo2",
  "threshold",
  "overunder",
]);

const SPRINT_TYPES = new Set<SessionType>(["sprint"]);

function metricForSeconds(seconds: number): Target["metric"] | null {
  if (seconds <= 5) return "power5";
  if (seconds <= 15) return "power15";
  if (seconds <= 60) return "power60";
  if (seconds <= 300) return "power300";
  return null;
}

function addTarget(list: Target[], target: Target): void {
  if (list.some((t) => t.metric === target.metric)) return;
  list.push(target);
}

function isSprintGoal(spec: GoalSpec): boolean {
  return spec.preferences?.sprintFocus === true ||
    spec.primary.metric === "power5" ||
    spec.primary.metric === "power60";
}

function defaultEquipment(description: string, provided?: string[]): string[] {
  if (provided?.length) return [...new Set(provided)];
  const text = description.toLowerCase();
  const out = new Set<string>();
  if (/trainer|zwift|indoor/.test(text)) out.add("trainer");
  if (/power\s*meter|power meter/.test(text)) out.add("power_meter");
  if (/resistance|big gear|standing|sprint/.test(text)) {
    out.add("resistance");
  }
  if (/erg\b/.test(text)) out.add("erg");
  if (/gym/.test(text)) out.add("gym");
  if (out.size === 0) {
    out.add("trainer");
    out.add("power_meter");
    out.add("resistance");
  }
  return [...out];
}

/**
 * Parse the common goal phrasings deterministically.
 *
 * Unambiguous phrasing yields an empty `clarifyingQuestions`. Anything that
 * cannot be turned into a measurable target asks instead of inventing one.
 */
export function parseGoalDescription(
  description: string,
  fitness: Fitness,
  opts: Omit<CustomGoalInput, "description"> = {},
): GoalSpec {
  const text = description.trim();
  const lower = text.toLowerCase();
  const startDate = opts.startDate ?? todayUtc();
  const assumptions: string[] = [];
  const questions: string[] = [];
  const targets: Target[] = [];
  let weeks = opts.weeks && opts.weeks > 0 ? Math.round(opts.weeks) : 0;
  let targetDate = opts.targetDate ?? "";

  const weeksMatch = lower.match(/(\d+(?:\.\d+)?)\s*(week|weeks)/);
  const monthsMatch = lower.match(/(\d+(?:\.\d+)?)\s*(month|months)/);
  const yearsMatch = lower.match(/(\d+(?:\.\d+)?)\s*(year|years)/);
  const byDateMatch = text.match(/\bby\s+(\d{4}-\d{2}-\d{2})/i);
  if (!weeks && weeksMatch) weeks = Math.round(Number(weeksMatch[1]));
  if (!weeks && monthsMatch) {
    weeks = Math.round(Number(monthsMatch[1]) * 4);
    assumptions.push(
      `${monthsMatch[1]} months interpreted as ${weeks} weeks.`,
    );
  }
  if (!weeks && yearsMatch) weeks = Math.round(Number(yearsMatch[1]) * 52);
  if (byDateMatch) {
    targetDate = byDateMatch[1];
    weeks = Math.max(1, Math.round(daysBetween(startDate, targetDate) / 7));
  }
  if (!weeks) {
    weeks = 12;
    assumptions.push("No horizon found; defaulted to 12 weeks.");
  }
  weeks = clamp(weeks, 4, 24);
  if (!targetDate) targetDate = addDays(startDate, weeks * 7);

  // "<power> W for <duration>".
  for (
    const match of text.matchAll(
      /(\d+(?:\.\d+)?)\s*(?:w|watts?)\s*(?:for|over|in)\s*(\d+(?:\.\d+)?)\s*(?:s|sec|secs|seconds?)/gi,
    )
  ) {
    const watts = Number(match[1]);
    const seconds = Number(match[2]);
    const metric = metricForSeconds(seconds);
    if (metric && watts > 0) {
      addTarget(targets, {
        metric,
        target: watts,
        unit: "W",
        comparison: ">=",
      });
    }
  }

  // "hold 700 W" without an explicit duration is ambiguous.
  if (
    targets.length === 0 &&
    /(?:\d+(?:\.\d+)?)\s*(?:w|watts?)\b/.test(lower) &&
    !/ftp|w\/kg|weight|kg/.test(lower)
  ) {
    questions.push(
      "How long should that power be held (for example 60 seconds)?",
    );
  }

  // Max / peak wattage.
  for (
    const match of text.matchAll(
      /(?:max(?:imum)?|peak|sprint)\s*(?:wattage|power|watts?)?\D{0,24}?(\d+(?:\.\d+)?)\s*w?/gi,
    )
  ) {
    const watts = Number(match[1]);
    if (watts > 0) {
      addTarget(targets, {
        metric: "power5",
        target: watts,
        unit: "W",
        comparison: ">=",
      });
    }
  }

  const ftpMatch = text.match(/(?:ftp|threshold)\D{0,16}(\d+(?:\.\d+)?)\s*w/i);
  if (ftpMatch) {
    addTarget(targets, {
      metric: "ftp",
      target: Number(ftpMatch[1]),
      unit: "W",
      comparison: ">=",
    });
  }
  const wkgMatch = text.match(/(\d+(?:\.\d+)?)\s*w\s*\/\s*kg/i);
  if (wkgMatch) {
    addTarget(targets, {
      metric: "wkg",
      target: Number(wkgMatch[1]),
      unit: "W/kg",
      comparison: ">=",
    });
  }
  const ctlMatch = text.match(/(?:ctl|fitness)\D{0,16}(\d+(?:\.\d+)?)/i);
  if (ctlMatch) {
    addTarget(targets, {
      metric: "ctl",
      target: Number(ctlMatch[1]),
      unit: "TSS/day",
      comparison: ">=",
    });
  }
  for (const match of text.matchAll(/(\d+(?:\.\d+)?)\s*kg\b/gi)) {
    addTarget(targets, {
      metric: "weight",
      target: Number(match[1]),
      unit: "kg",
      comparison: "<=",
    });
  }
  if (opts.targetWeightKg && opts.targetWeightKg > 0) {
    addTarget(targets, {
      metric: "weight",
      target: opts.targetWeightKg,
      unit: "kg",
      comparison: "<=",
    });
  }

  if (targets.length === 0) {
    questions.push(
      "What measurable target should the plan aim for: power for a duration, FTP, w/kg, CTL, weight or an event?",
    );
  }

  const sorted = [...targets].sort(
    (a, b) => METRIC_RANK[a.metric] - METRIC_RANK[b.metric],
  );
  const primary = sorted[0] ?? {
    metric: "ctl" as const,
    target: round1(fitness.current.ctl),
    unit: "TSS/day" as const,
    comparison: ">=" as const,
  };
  const secondary = sorted.filter((t) => t !== primary);

  const daysMatch = lower.match(/(\d+)\s*days?\s*(?:a|per|\/)\s*week/);
  const hoursMatch = lower.match(
    /(\d+(?:\.\d+)?)\s*(?:hours?|hrs?)\s*(?:a|per|\/)\s*week/,
  );
  const sprintFocus = /sprint|max\s*(?:wattage|power)|neuromuscular/.test(
    lower,
  ) || primary.metric === "power5" || primary.metric === "power60";
  const style: "pyramidal" | "polarised" | "sprint" = opts.style ??
    (/polarised|polarized/.test(lower)
      ? "polarised"
      : sprintFocus
      ? "sprint"
      : "pyramidal");
  const recoveryEvery = fitness.athlete.age !== null &&
      fitness.athlete.age >= 40
    ? 3
    : 4;

  const tests: { week: number; protocol: string }[] = [];
  if (sprintFocus) {
    tests.push({ week: 0, protocol: "5 s peak + 60 s best" });
    for (let week = recoveryEvery; week < weeks; week += recoveryEvery) {
      tests.push({ week, protocol: "5 s peak + 60 s best" });
    }
    tests.push({ week: weeks, protocol: "5 s peak + 60 s best" });
  } else {
    tests.push({ week: 0, protocol: "20 min FTP test" });
    if (weeks >= 8) {
      tests.push({ week: Math.floor(weeks / 2), protocol: "20 min FTP test" });
    }
  }

  const spec: GoalSpec = {
    id: hashString(
      [text, primary.metric, String(primary.target), weeks, startDate].join(
        "|",
      ),
    ),
    description: text,
    horizonWeeks: weeks,
    startDate,
    targetDate,
    primary,
    secondary,
    constraints: {
      daysPerWeek: opts.daysPerWeek && opts.daysPerWeek > 0
        ? opts.daysPerWeek
        : daysMatch
        ? Number(daysMatch[1])
        : undefined,
      hoursPerWeek: opts.hoursPerWeek && opts.hoursPerWeek > 0
        ? opts.hoursPerWeek
        : hoursMatch
        ? Number(hoursMatch[1])
        : undefined,
      availableDays: opts.constraints?.availableDays,
      maxSessionMinutes: opts.constraints?.maxSessionMinutes,
      equipment: defaultEquipment(text, opts.constraints?.equipment),
      indoorOnly: opts.constraints?.indoorOnly ?? false,
      injuries: opts.constraints?.injuries ?? [],
      maxHardSessionsPerWeek: sprintFocus ? 3 : 2,
      recoveryEveryNWeeks: recoveryEvery,
      availabilitySource: "merged",
    },
    tests,
    baseline: {
      source: fitness.powerCurve.source,
      fetchedAt: fitness.powerCurve.fetchedAt,
      power5: fitness.powerCurve.best.power5,
      power15: fitness.powerCurve.best.power15,
      power60: fitness.powerCurve.best.power60,
      power300: fitness.powerCurve.best.power300,
      power1200: fitness.powerCurve.best.power1200,
    },
    preferences: {
      style,
      sprintFocus,
      funPreference: "auto",
    },
    assumptions,
    clarifyingQuestions: questions,
  };

  if (!spec.constraints.daysPerWeek) {
    assumptions.push(
      "Days/week is inferred from merged Zwift+Garmin history.",
    );
  }
  if (!spec.constraints.hoursPerWeek) {
    assumptions.push(
      "Hours/week is inferred from merged Zwift+Garmin history.",
    );
  }
  if (sprintFocus) {
    assumptions.push(
      "Targets are absolute watts from the rider's power-duration curve; " +
        "max and 60 s blocks use FreeRide/MaxEffort, not ERG percentages.",
    );
    assumptions.push(
      "Sprint work is low TSS; judge progress by the 5 s/60 s tests, not CTL.",
    );
    if (fitness.powerCurve.source === "missing") {
      questions.push(
        "No power-duration curve is available; run a 5 s and 60 s test before target-derived intensities.",
      );
    }
  }
  return spec;
}

/** Compile a parsed custom goal into the planner's `Goal` shape. */
export function compileCustomGoal(
  fitness: Fitness,
  input: CustomGoalInput,
): Goal {
  const spec = parseGoalDescription(input.description, fitness, input);
  const p80Days = fitness.availability.daysPerWeek.p80;
  const p80Hours = fitness.availability.hoursPerWeek.p80;
  const requestedDays = input.daysPerWeek && input.daysPerWeek > 0
    ? input.daysPerWeek
    : spec.constraints.daysPerWeek;
  const requestedHours = input.hoursPerWeek && input.hoursPerWeek > 0
    ? input.hoursPerWeek
    : spec.constraints.hoursPerWeek;
  const daysPerWeek = clamp(
    Math.round(requestedDays ?? (p80Days > 0 ? p80Days : 3)),
    2,
    6,
  );
  const hoursPerWeek = clamp(
    requestedHours ?? (p80Hours > 0 ? p80Hours : 6),
    2,
    20,
  );
  const maxWeeklyTss = hoursPerWeek * 70;
  const currentCtl = fitness.current.ctl;
  const sustained = fitness.peaks.sustainedCtl || fitness.peaks.ctl ||
    currentCtl;
  const sprintFocus = isSprintGoal(spec);
  const targetCtl = sprintFocus
    ? Math.max(currentCtl, Math.min(maxWeeklyTss / 7, currentCtl + 1))
    : Math.min(
      maxWeeklyTss / 7,
      Math.max(currentCtl * 1.05, 0.95 * sustained),
    );
  const currentFtp = fitness.current.ftpWatts ?? fitness.peaks.ftpWatts;
  const explicitFtp = [spec.primary, ...spec.secondary].find(
    (t) => t.metric === "ftp",
  );
  const targetFtp = explicitFtp && typeof explicitFtp.target === "number"
    ? explicitFtp.target
    : currentFtp;

  const warnings: string[] = [];
  if (fitness.flags.lowHistory) {
    warnings.push(
      "Less than 8 weeks of history: availability is provisional; refine " +
        "after 4–8 weeks.",
    );
  }
  if (fitness.flags.staleFtp) {
    warnings.push("No recent FTP; benchmark before hard intervals.");
  }
  if (fitness.flags.detrained) {
    warnings.push("Detrained or returning from a gap: re-entry weeks first.");
  }
  if (
    spec.constraints.equipment.includes("erg") &&
    !spec.constraints.equipment.includes("resistance") &&
    (spec.primary.metric === "power5" ||
      (spec.secondary.some((t) => t.metric === "power5")))
  ) {
    warnings.push(
      "ERG-only equipment cannot execute max-wattage sprints well; add " +
        "resistance mode or use torque/standing efforts.",
    );
  }
  if (spec.horizonWeeks < 8) {
    warnings.push(
      `Only ${spec.horizonWeeks} weeks: expect technique and pacing gains ` +
        "more than large physiological changes.",
    );
  }
  const baseline = spec.baseline;
  const targetOf = (metric: Target["metric"]) =>
    [spec.primary, ...spec.secondary].find((t) => t.metric === metric);
  for (
    const [metric, current, label] of [
      ["power60", baseline?.power60, "60 s"],
      ["power5", baseline?.power5, "5 s"],
    ] as const
  ) {
    const target = targetOf(metric);
    if (
      target && typeof target.target === "number" && current &&
      current > 0
    ) {
      const gapPct = (target.target - current) / current;
      if (gapPct > 0.15) {
        warnings.push(
          `${label} target ${target.target} W is ${
            Math.round(gapPct * 100)
          }% ` +
            `above the current best ${current} W; the plan will progress from ` +
            "the current best and may not reach the goal in this horizon.",
        );
      }
    }
  }
  if (
    spec.preferences?.sprintFocus &&
    fitness.powerCurve.source === "missing"
  ) {
    warnings.push(
      "Power-duration curve missing: the first block uses effort-based tests " +
        "and cannot prescribe target watts until the curve exists.",
    );
  }
  const weightTarget = [spec.primary, ...spec.secondary].find(
    (t) => t.metric === "weight",
  );
  if (weightTarget) {
    spec.assumptions.push(
      "Weight is a secondary target: Z2 volume and a weekly trend review are " +
        "the levers; sprint work is for power, not weight loss. No calorie " +
        "prescription.",
    );
  }
  if (
    weightTarget && typeof weightTarget.target === "number" &&
    fitness.weight.currentKg !== null
  ) {
    const drop = fitness.weight.currentKg - weightTarget.target;
    const rate = drop / Math.max(1, spec.horizonWeeks);
    if (rate > 0.5) {
      warnings.push(
        `Weight target implies ${round1(rate)} kg/week, above the ` +
          "0.5 kg/week guideline; the plan will not prescribe a deficit.",
      );
    }
  }

  return {
    id: spec.id,
    mode: "custom",
    description: spec.description,
    startDate: spec.startDate,
    targetDate: spec.targetDate ??
      addDays(spec.startDate, spec.horizonWeeks * 7),
    weeks: spec.horizonWeeks,
    primary: spec.primary,
    secondary: spec.secondary,
    constraints: {
      daysPerWeek,
      hoursPerWeek,
      availableDays: spec.constraints.availableDays?.length
        ? spec.constraints.availableDays
        : fitness.availability.preferredDays,
      maxSessionMinutes: spec.constraints.maxSessionMinutes ??
        (fitness.availability.sessionMinutes.p90 || 120),
      style: spec.preferences?.style ?? "pyramidal",
      equipment: spec.constraints.equipment,
      indoorOnly: spec.constraints.indoorOnly ?? false,
      injuries: spec.constraints.injuries ?? [],
      overrideAvailability: input.overrideAvailability === true,
    },
    targetCtl: round1(targetCtl),
    targetFtp,
    assumptions: spec.assumptions,
    warnings,
    goalSpec: spec,
    clarifyingQuestions: spec.clarifyingQuestions,
  };
}

function planPhase(
  week: number,
  weeks: number,
  recoveryEvery: number,
): Week["phase"] {
  if (week === weeks) return "taper";
  if (week > 1 && week % recoveryEvery === 0) return "recovery";
  const progress = (week - 1) / Math.max(1, weeks - 1);
  if (progress < 0.35) return "base";
  if (progress < 0.7) return "build";
  return "peak";
}

const SPRINT_COPY: Record<
  string,
  { title: string; hook: string; why: string; purpose: string }
> = {
  sprint: {
    title: "Sprint sharpening — custom",
    hook: "Big gear, full send, full recovery",
    why: "Recruitment and max wattage, not fatigue",
    purpose: "Neuromuscular power",
  },
  anaerobic: {
    title: "Anaerobic capacity — custom",
    hook: "Hold the gear longer than feels fair",
    why: "Builds the 60–90 s engine",
    purpose: "Anaerobic capacity",
  },
  endurance: {
    title: "Aerobic maintenance — custom",
    hook: "Steady Z2, enjoy the route",
    why: "Keeps the engine without dulling the sprint",
    purpose: "Aerobic maintenance",
  },
  recovery: {
    title: "Flush the legs — custom",
    hook: "Easy spinning, no heroics",
    why: "Blood flow without adding fatigue",
    purpose: "Recovery",
  },
  test: {
    title: "Sprint benchmark — 5 s + 60 s",
    hook: "Measure, do not guess",
    why: "Calibrates the next block and proves progress",
    purpose: "Test",
  },
};

function sprintTypesFor(
  phase: Week["phase"],
  days: number,
): { type: SessionType; test?: boolean; long?: boolean }[] {
  type Item = { type: SessionType; test?: boolean; long?: boolean };
  const pick = (items: Item[]) => items.slice(0, days);
  const list: Item[] = [];
  if (days <= 2) {
    if (phase === "recovery" || phase === "taper") {
      return pick([{ type: "sprint", test: true }, { type: "recovery" }]);
    }
    if (phase === "build") {
      return pick([
        { type: "anaerobic" },
        { type: "endurance", long: true },
      ]);
    }
    return pick([{ type: "sprint" }, { type: "endurance", long: true }]);
  }
  if (days === 3) {
    if (phase === "recovery" || phase === "taper") {
      return pick([
        { type: "sprint", test: true },
        { type: "recovery" },
        { type: "endurance", long: true },
      ]);
    }
    if (phase === "build") {
      return pick([
        { type: "anaerobic" },
        { type: "sprint" },
        { type: "endurance", long: true },
      ]);
    }
    return pick([
      { type: "sprint" },
      { type: "sprint" },
      { type: "endurance", long: true },
    ]);
  }
  if (phase === "recovery" || phase === "taper") {
    list.push({ type: "sprint", test: true });
    list.push({ type: "recovery" });
    list.push({ type: "endurance", long: true });
    list.push({ type: "recovery" });
    return list.slice(0, days);
  }
  if (phase === "base") {
    list.push({ type: "sprint" });
    list.push({ type: "sprint" });
  } else if (phase === "build") {
    list.push({ type: "anaerobic" });
    list.push({ type: "sprint" });
  } else {
    list.push({ type: "sprint" });
    list.push({ type: "sprint" });
  }
  list.push({ type: "endurance", long: true });
  list.push({ type: "recovery" });
  while (list.length < days) list.push({ type: "endurance" });
  return list.slice(0, days);
}

function allTargets(goal: Goal): Target[] {
  const spec = goal.goalSpec;
  return spec
    ? [spec.primary, ...spec.secondary]
    : [goal.primary, ...goal.secondary];
}

function targetWatts(goal: Goal, metric: Target["metric"]): number | null {
  const target = allTargets(goal).find((t) => t.metric === metric);
  return target && typeof target.target === "number" ? target.target : null;
}

function wattsText(
  label: string,
  target: number | null,
  current: number | null,
  cue: string,
): string {
  const bits: string[] = label ? [label] : [];
  if (target !== null && current !== null && target === current) {
    bits.push(`at current best ${current} W`);
  } else {
    if (target !== null) bits.push(`target ${target} W`);
    if (current !== null) bits.push(`current best ${current} W`);
  }
  bits.push(cue);
  return bits.join("; ");
}

type SprintStyle = "torque" | "cadence";

function cadenceProfile(fitness: Fitness): {
  max: number;
  at5s: number;
  at60s: number;
  typical: number;
} {
  const c = fitness.powerCurve.cadence;
  return {
    // Raw max cadence can include sensor/coast spikes; cap it to a usable
    // ceiling and use the 5 s/60 s best-window cadence as the real evidence.
    max: Math.min(c.max ?? 130, 140),
    at5s: Math.min(c.at5s ?? 110, 135),
    at60s: clamp(c.at60s ?? 95, 85, 100),
    typical: c.typical ?? 85,
  };
}

function warmupSteps(
  variant: number,
  cadence: ReturnType<typeof cadenceProfile>,
): Step[] {
  if (variant % 3 === 1) {
    return [
      {
        kind: "steady",
        minutes: 0.5,
        power: 0.55,
        cadence: 80,
        text: "easy spin",
      },
      {
        kind: "steady",
        minutes: 0.5,
        power: 0.6,
        cadence: 100,
        text: "100 rpm",
      },
      {
        kind: "steady",
        minutes: 0.5,
        power: 0.7,
        cadence: 115,
        text: "115 rpm",
      },
      { kind: "steady", minutes: 0.5, power: 0.5, cadence: 85 },
      {
        kind: "steady",
        minutes: 0.333,
        power: 0.75,
        cadence: 92,
        text: "20 s at 75%",
      },
      { kind: "steady", minutes: 0.667, power: 0.5, cadence: 85 },
      {
        kind: "steady",
        minutes: 0.333,
        power: 0.85,
        cadence: 95,
        text: "20 s at 85%",
      },
      { kind: "steady", minutes: 0.667, power: 0.5, cadence: 85 },
      {
        kind: "steady",
        minutes: 0.333,
        power: 0.95,
        cadence: 100,
        text: "20 s at 95%",
      },
      { kind: "steady", minutes: 0.667, power: 0.5, cadence: 85 },
      {
        kind: "steady",
        minutes: 1,
        power: 0.55,
        cadence: 85,
        text: "easy spin",
      },
    ];
  }
  if (variant % 3 === 2) {
    return [
      {
        kind: "steady",
        minutes: 2,
        power: 0.55,
        cadence: 85,
        text: "easy spin",
      },
      {
        kind: "steady",
        minutes: 0.083,
        power: 0.8,
        cadence: 95,
        text: "5 s opener",
      },
      { kind: "steady", minutes: 0.917, power: 0.5, cadence: 85 },
      {
        kind: "steady",
        minutes: 0.083,
        power: 0.85,
        cadence: 100,
        text: "5 s opener",
      },
      { kind: "steady", minutes: 0.917, power: 0.5, cadence: 85 },
      {
        kind: "steady",
        minutes: 0.083,
        power: 0.9,
        cadence: 105,
        text: "5 s opener",
      },
      { kind: "steady", minutes: 0.917, power: 0.5, cadence: 85 },
      {
        kind: "steady",
        minutes: 1,
        power: 0.55,
        cadence: 85,
        text: "easy spin",
      },
    ];
  }
  const high = Math.min(cadence.at5s, 120);
  return [
    { kind: "steady", minutes: 1, power: 0.55, cadence: 85, text: "easy spin" },
    {
      kind: "steady",
      minutes: 0.333,
      power: 0.6,
      cadence: 80,
      text: "cadence ladder: 80 rpm",
    },
    {
      kind: "steady",
      minutes: 0.333,
      power: 0.7,
      cadence: 100,
      text: "100 rpm",
    },
    {
      kind: "steady",
      minutes: 0.333,
      power: 0.8,
      cadence: high,
      text: `${high} rpm`,
    },
    { kind: "steady", minutes: 0.333, power: 0.5, cadence: 85 },
    { kind: "steady", minutes: 0.333, power: 0.6, cadence: 80, text: "80 rpm" },
    {
      kind: "steady",
      minutes: 0.333,
      power: 0.7,
      cadence: 100,
      text: "100 rpm",
    },
    {
      kind: "steady",
      minutes: 0.333,
      power: 0.8,
      cadence: high,
      text: `${high} rpm`,
    },
    { kind: "steady", minutes: 0.333, power: 0.5, cadence: 85 },
    { kind: "steady", minutes: 0.333, power: 0.6, cadence: 80, text: "80 rpm" },
    {
      kind: "steady",
      minutes: 0.333,
      power: 0.7,
      cadence: 100,
      text: "100 rpm",
    },
    {
      kind: "steady",
      minutes: 0.333,
      power: 0.8,
      cadence: high,
      text: `${high} rpm`,
    },
    { kind: "steady", minutes: 1, power: 0.55, cadence: 85, text: "easy spin" },
  ];
}

function cooldownSteps(): Step[] {
  return [{ kind: "cooldown", minutes: 4, powerLow: 0.65, powerHigh: 0.4 }];
}

function sprintEffort(
  style: SprintStyle,
  target: number | null,
  current: number | null,
  ftp: number | null,
  cadence: ReturnType<typeof cadenceProfile>,
): Step[] {
  if (style === "torque") {
    return [
      {
        kind: "ramp",
        minutes: 0.05,
        powerLow: 0.6,
        powerHigh: 0.9,
        cadenceLow: 70,
        cadenceHigh: 85,
        text: "wind up, big gear, stay seated or stand",
      },
      {
        kind: "maxeffort",
        minutes: 0.1,
        cadence: 80,
        text: `6 s torque sprint; ${
          wattsText("max effort", target, current, "70-90 rpm")
        }`,
        ...(target !== null && ftp && ftp > 0
          ? { targetPower: target / ftp }
          : {}),
      },
      {
        kind: "ramp",
        minutes: 0.167,
        powerLow: 0.9,
        powerHigh: 0.6,
        cadenceLow: 85,
        cadenceHigh: 75,
        text: "ramp down, stay in the gear",
      },
      { kind: "steady", minutes: 0.333, power: 0.5, cadence: 80 },
      { kind: "steady", minutes: 2.5, power: 0.45, cadence: 80 },
    ];
  }
  const high = Math.min(cadence.at5s, 135);
  return [
    {
      kind: "ramp",
      minutes: 0.05,
      powerLow: 0.6,
      powerHigh: 0.85,
      cadenceLow: 80,
      cadenceHigh: 100,
      text: "spin up smoothly",
    },
    {
      kind: "maxeffort",
      minutes: 0.133,
      cadence: high,
      text: `8 s cadence sprint; ${
        wattsText("max effort", target, current, `${high} rpm ceiling`)
      }`,
      ...(target !== null && ftp && ftp > 0
        ? { targetPower: target / ftp }
        : {}),
    },
    {
      kind: "ramp",
      minutes: 0.167,
      powerLow: 0.85,
      powerHigh: 0.6,
      cadenceLow: high,
      cadenceHigh: 90,
      text: "ramp down, keep spinning",
    },
    { kind: "steady", minutes: 0.333, power: 0.5, cadence: 85 },
    { kind: "steady", minutes: 2.5, power: 0.45, cadence: 85 },
  ];
}

function free60Effort(
  target: number | null,
  current: number | null,
  ftp: number | null,
  cadence: ReturnType<typeof cadenceProfile>,
): Step[] {
  const rpm = Math.round(cadence.at60s);
  return [
    {
      kind: "ramp",
      minutes: 0.083,
      powerLow: 0.7,
      powerHigh: 0.95,
      cadenceLow: 85,
      cadenceHigh: rpm,
      text: "build into the effort",
    },
    {
      kind: "free",
      minutes: 1,
      flatRoad: true,
      cadence: rpm,
      text: `60 s effort; ${
        wattsText("target", target, current, `about ${rpm} rpm, even split`)
      }`,
      ...(target !== null && ftp && ftp > 0
        ? { targetPower: target / ftp }
        : {}),
    },
    {
      kind: "ramp",
      minutes: 0.25,
      powerLow: 0.95,
      powerHigh: 0.6,
      cadenceLow: rpm,
      cadenceHigh: 85,
      text: "ramp down, do not coast",
    },
    { kind: "steady", minutes: 2, power: 0.45, cadence: 85 },
  ];
}

function sprintTestSteps(
  goal: Goal,
  fitness: Fitness,
  week: number,
): Step[] {
  const cadence = cadenceProfile(fitness);
  const target5 = targetWatts(goal, "power5");
  const current5 = goal.goalSpec?.baseline?.power5 ?? null;
  const target60 = targetWatts(goal, "power60");
  const current60 = goal.goalSpec?.baseline?.power60 ?? null;
  const ftp = fitness.current.ftpWatts ?? fitness.peaks.ftpWatts ?? null;
  const steps: Step[] = [...warmupSteps(week, cadence)];
  for (let i = 0; i < 3; i++) {
    steps.push(...sprintEffort("torque", target5, current5, ftp, cadence));
  }
  steps.push(...free60Effort(target60, current60, ftp, cadence));
  steps.push(...cooldownSteps());
  return steps;
}

function targetSprintSteps(
  phase: Week["phase"],
  type: SessionType,
  test: boolean,
  goal: Goal,
  fitness: Fitness,
  week: number,
  style: SprintStyle,
): Step[] | undefined {
  const spec = goal.goalSpec;
  if (!spec?.preferences?.sprintFocus) return undefined;
  const current5 = spec.baseline?.power5 ?? null;
  const current60 = spec.baseline?.power60 ?? null;
  const target5 = targetWatts(goal, "power5");
  const target60 = targetWatts(goal, "power60");
  const ftp = fitness.current.ftpWatts ?? fitness.peaks.ftpWatts ?? null;
  const cadence = cadenceProfile(fitness);
  if (test || phase === "recovery" || phase === "taper") {
    return sprintTestSteps(goal, fitness, week);
  }
  const steps: Step[] = [...warmupSteps(week, cadence)];
  if (type === "anaerobic") {
    const reps = phase === "build" ? 4 : 2;
    for (let i = 0; i < reps; i++) {
      steps.push(
        ...free60Effort(current60 ?? target60, current60, ftp, cadence),
      );
    }
    steps.push(...cooldownSteps());
    return steps;
  }
  if (type === "sprint") {
    if (phase === "peak") {
      const peak60 = target60 ?? current60;
      for (let i = 0; i < 2; i++) {
        steps.push(...free60Effort(peak60, current60, ftp, cadence));
      }
      for (let i = 0; i < 3; i++) {
        steps.push(...sprintEffort("torque", target5, current5, ftp, cadence));
      }
      steps.push(...cooldownSteps());
      return steps;
    }
    const reps = phase === "base" ? 6 : 6;
    const target = phase === "base" && current5 !== null
      ? Math.round(current5 * 0.9)
      : current5 ?? target5;
    for (let i = 0; i < reps; i++) {
      steps.push(...sprintEffort(style, target, current5, ftp, cadence));
    }
    steps.push(...cooldownSteps());
    return steps;
  }
  return undefined;
}

function describeSteps(steps: Step[], ftp: number | null): string {
  const total = Math.round(totalMinutes(steps));
  const firstWork = steps.findIndex((s) =>
    s.kind === "maxeffort" || s.kind === "free" || s.kind === "intervals"
  );
  const warmupMinutes = firstWork > 0
    ? Math.round(totalMinutes(steps.slice(0, firstWork)))
    : 0;
  const max = steps.filter((s) => s.kind === "maxeffort");
  const free = steps.filter((s) => s.kind === "free");
  const intervals = steps.filter((s) => s.kind === "intervals");
  const parts: string[] = [];
  if (warmupMinutes > 0) parts.push(`${warmupMinutes} min primer`);
  if (max.length > 0) {
    const step = max[0];
    const watts = step.targetPower && ftp
      ? ` at ~${Math.round(step.targetPower * ftp)} W`
      : "";
    const rpm = step.cadence ? `, ${step.cadence} rpm` : "";
    parts.push(
      `${max.length} × ${Math.round(step.minutes * 60)} s max${watts}${rpm}`,
    );
  }
  if (free.length > 0) {
    const step = free[0];
    const watts = step.targetPower && ftp
      ? ` at ~${Math.round(step.targetPower * ftp)} W`
      : "";
    const rpm = step.cadence ? `, ${step.cadence} rpm` : "";
    parts.push(
      `${free.length} × ${Math.round(step.minutes * 60)} s${watts}${rpm}`,
    );
  }
  if (intervals.length > 0) {
    const step = intervals[0];
    parts.push(`${step.repeat} × ${Math.round(step.onMinutes * 60)} s efforts`);
  }
  if (max.length === 0 && free.length === 0 && intervals.length === 0) {
    const steady = steps
      .filter((s) => s.kind === "steady")
      .sort((a, b) => b.minutes - a.minutes)[0];
    if (steady && steady.kind === "steady") {
      const watts = ftp ? ` at ~${Math.round(steady.power * ftp)} W` : "";
      const rpm = steady.cadence ? `, ${steady.cadence} rpm` : "";
      parts.push(`${Math.round(steady.minutes)} min steady${watts}${rpm}`);
    }
  } else {
    parts.push("easy spin between");
  }
  return `${total} min: ${parts.join("; ")}.`;
}

function sprintDuration(
  type: SessionType,
  phase: Week["phase"],
  test: boolean,
  long: boolean,
): number {
  if (test) return 35;
  if (type === "sprint") return phase === "peak" ? 34 : 32;
  if (type === "anaerobic") return 34;
  if (type === "recovery") return 30;
  return long ? 75 : 60;
}

/** Deterministic sprint/anaerobic plan for the worked 60 s example. */
export function generateCustomPlan(
  fitness: Fitness,
  goal: Goal,
  opts: { startDate?: string; weeks?: number; seed?: number } = {},
): Plan {
  if (!goal.goalSpec || !isSprintGoal(goal.goalSpec)) {
    return generatePlan(fitness, goal, opts);
  }
  const spec = goal.goalSpec;
  const weeks = clamp(opts.weeks ?? goal.weeks, 4, 24);
  const startDate = nextMonday(opts.startDate ?? goal.startDate);
  const ftp = fitness.current.ftpWatts ?? fitness.peaks.ftpWatts ?? null;
  const recoveryEvery = spec.constraints.recoveryEveryNWeeks ?? 4;
  const days = goal.constraints.daysPerWeek;
  const dayNumbers = dayList(goal);
  const weeksOut: Week[] = [];
  const dates = Array.from(
    { length: weeks },
    (_, i) => addDays(startDate, i * 7),
  );

  for (let i = 0; i < weeks; i++) {
    const weekNo = i + 1;
    const phase = planPhase(weekNo, weeks, recoveryEvery);
    let types = sprintTypesFor(phase, days);
    const weightTarget = allTargets(goal).some((t) => t.metric === "weight");
    if (weightTarget && !types.some((item) => item.type === "endurance")) {
      types = types.map((item) =>
        item.type === "recovery"
          ? { ...item, type: "endurance" as const, long: true }
          : item
      );
    }
    const desired = types.map((item) =>
      sprintDuration(item.type, phase, item.test === true, item.long === true)
    );
    const maxSession = goal.constraints.maxSessionMinutes;
    const weeklyBudget = goal.constraints.hoursPerWeek * 60;
    const capped = desired.map((minutes) => Math.min(minutes, maxSession));
    const desiredTotal = capped.reduce((sum, minutes) => sum + minutes, 0);
    const scale = desiredTotal > weeklyBudget ? weeklyBudget / desiredTotal : 1;
    const durations = capped.map((minutes) =>
      Math.max(20, Math.round((minutes * scale) / 5) * 5)
    );
    const sessions: Session[] = [];
    for (let s = 0; s < types.length; s++) {
      const item = types[s];
      const date = addDays(dates[i], (dayNumbers[s] ?? (s + 2)) - 1);
      const duration = durations[s];
      const copy = item.test
        ? SPRINT_COPY.test
        : SPRINT_COPY[item.type] ?? SPRINT_COPY.endurance;
      const fun = item.long === true && !sessions.some((x) => x.fun);
      const style: SprintStyle = s % 2 === 0 ? "torque" : "cadence";
      const overrideSteps = targetSprintSteps(
        phase,
        item.type,
        item.test === true,
        goal,
        fitness,
        weekNo,
        style,
      );
      const built = buildSession({
        id: `w${String(weekNo).padStart(2, "0")}-${date}`,
        week: weekNo,
        date,
        dayOfWeek: dayNumbers[s] ?? (s + 2),
        type: item.type,
        title: copy.title,
        hook: copy.hook,
        why: copy.why,
        purpose: copy.purpose,
        targetTss: 0,
        durationMinutes: duration,
        maxMinutes: duration,
        fun,
        zwiftSuggestion: fun
          ? "Pick a route badge, KOM or sprint hunt you enjoy."
          : undefined,
        progression: phase === "build"
          ? "Add one 60 s rep or 5 s to the effort; do not add both."
          : undefined,
        steps: overrideSteps,
      });
      built.targetTss = built.computedTss;
      built.brief = describeSteps(built.steps, ftp);
      sessions.push(built);
    }
    if (!sessions.some((x) => x.fun) && sessions.length > 0) {
      const last = sessions[sessions.length - 1];
      last.fun = true;
      last.zwiftSuggestion =
        "Pick a route badge, KOM or sprint hunt you enjoy.";
    }
    const weeklyTss = round1(
      sessions.reduce((sum, s) => sum + s.computedTss, 0),
    );
    weeksOut.push({
      index: weekNo,
      startDate: dates[i],
      phase,
      theme: phase === "base"
        ? "Neuromuscular base"
        : phase === "build"
        ? "Anaerobic capacity"
        : phase === "peak"
        ? "Peak power"
        : phase === "recovery"
        ? "Recovery + test"
        : "Taper + test",
      narrative: phase === "base"
        ? "Recruitment, technique and tendon tolerance."
        : phase === "build"
        ? "Extend the 30–45 s strength into a 60 s effort."
        : phase === "peak"
        ? "Express power with full recovery and less volume."
        : phase === "recovery"
        ? "Absorb the work and measure the 5 s/60 s best."
        : "Short, sharp, fresh — then test.",
      targetCtl: round1(weeklyTss / 7),
      weeklyTss,
      computedTss: weeklyTss,
      sessions,
    });
  }

  return {
    id: hashString([goal.id, startDate, weeks, opts.seed ?? 0].join("|")),
    generatedAt: new Date().toISOString(),
    goalId: goal.id,
    startDate,
    endDate: addDays(startDate, weeks * 7 - 1),
    weeks: weeksOut,
    summary: {
      weeks,
      totalHours: round1(
        weeksOut.reduce(
          (sum, w) =>
            sum + w.sessions.reduce((h, s) => h + s.durationMinutes, 0) / 60,
          0,
        ),
      ),
      totalTss: round1(
        weeksOut.reduce((sum, w) => sum + w.computedTss, 0),
      ),
      startingCtl: round1(fitness.current.ctl),
      targetCtl: round1(
        weeksOut.reduce((sum, week) => sum + week.targetCtl, 0) / weeks,
      ),
      targetFtp: goal.targetFtp,
      daysPerWeek: days,
      hoursPerWeek: round1(
        weeksOut.reduce(
          (sum, w) =>
            sum + w.sessions.reduce((h, s) => h + s.durationMinutes, 0) / 60,
          0,
        ) / weeks,
      ),
      focus: "custom sprint",
    },
  };
}

function phaseKind(name: string): Week["phase"] {
  const lower = name.toLowerCase();
  if (lower.includes("recovery") || lower.includes("deload")) {
    return "recovery";
  }
  if (lower.includes("taper")) return "taper";
  if (lower.includes("peak")) return "peak";
  if (lower.includes("build")) return "build";
  if (lower.includes("re-entry") || lower.includes("reentry")) {
    return "re-entry";
  }
  return "base";
}

function specPhaseFor(
  specs: PlanSpecPhase[],
  week: number,
): PlanSpecPhase | null {
  let cursor = 1;
  for (const phase of specs) {
    const end = cursor + Math.max(0, phase.weeks) - 1;
    if (week >= cursor && week <= end) return phase;
    cursor = end + 1;
  }
  return specs.length > 0 ? specs[specs.length - 1] : null;
}

function stepsFromSpec(steps: Step[]): Step[] {
  return steps.map((step) => ({ ...step }));
}

/** Convert a validated PlanSpec into the planner's `Plan` shape. */
export function planFromSpec(
  fitness: Fitness,
  goal: Goal,
  spec: PlanSpec,
  opts: { startDate?: string; seed?: number } = {},
): Plan {
  const weeks = clamp(
    Math.max(goal.weeks, ...spec.sessions.map((s) => s.week), 1),
    1,
    24,
  );
  const startDate = nextMonday(opts.startDate ?? goal.startDate);
  const ftp = fitness.current.ftpWatts ?? fitness.peaks.ftpWatts ?? null;
  const goalDays = dayList(goal);
  const sessionsByWeek = new Map<number, PlanSpecSession[]>();
  for (const session of spec.sessions) {
    const list = sessionsByWeek.get(session.week) ?? [];
    list.push(session);
    sessionsByWeek.set(session.week, list);
  }
  const weeksOut: Week[] = [];
  for (let weekNo = 1; weekNo <= weeks; weekNo++) {
    const phaseSpec = specPhaseFor(spec.phases, weekNo);
    const phase = phaseKind(phaseSpec?.name ?? "base");
    const weekStart = addDays(startDate, (weekNo - 1) * 7);
    const sessions: Session[] = [];
    const items = [...(sessionsByWeek.get(weekNo) ?? [])].sort(
      (a, b) => (a.dayOfWeek ?? 99) - (b.dayOfWeek ?? 99),
    );
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const dayOfWeek = item.dayOfWeek ?? goalDays[i] ?? (i + 2);
      const date = addDays(weekStart, dayOfWeek - 1);
      if (item.steps?.length) {
        const steps = stepsFromSpec(item.steps);
        const computed = totalTss(steps);
        sessions.push({
          id: item.id,
          week: weekNo,
          date,
          dayOfWeek,
          type: item.type,
          title: item.title,
          hook: item.hook,
          why: item.why,
          purpose: item.purpose,
          fun: item.fun ?? false,
          zwiftSuggestion: item.zwiftSuggestion,
          durationMinutes: Math.round(totalMinutes(steps)),
          targetTss: item.targetTss ?? computed,
          computedTss: computed,
          targetIf: averageIf(steps),
          steps,
          progression: item.progression,
          brief: describeSteps(steps, ftp),
        });
      } else {
        const built = buildSession({
          id: item.id,
          week: weekNo,
          date,
          dayOfWeek,
          type: item.type,
          title: item.title,
          hook: item.hook,
          why: item.why,
          purpose: item.purpose,
          targetTss: item.targetTss ?? 0,
          durationMinutes: item.durationMinutes,
          maxMinutes: Math.max(
            item.durationMinutes,
            goal.constraints.maxSessionMinutes,
          ),
          fun: item.fun,
          zwiftSuggestion: item.zwiftSuggestion,
          progression: item.progression,
          steps: targetSprintSteps(
            phase,
            item.type,
            false,
            goal,
            fitness,
            weekNo,
            i % 2 === 0 ? "torque" : "cadence",
          ),
        });
        if (built.targetTss <= 0) built.targetTss = built.computedTss;
        built.brief = item.progression && !built.brief
          ? built.brief
          : describeSteps(built.steps, ftp);
        sessions.push(built);
      }
    }
    const weeklyTss = round1(
      sessions.reduce((sum, s) => sum + s.computedTss, 0),
    );
    weeksOut.push({
      index: weekNo,
      startDate: weekStart,
      phase,
      theme: phaseSpec?.theme ?? "Custom block",
      narrative: phaseSpec?.narrative ?? "Agent-authored custom plan.",
      targetCtl: round1(weeklyTss / 7),
      weeklyTss,
      computedTss: weeklyTss,
      sessions,
    });
  }

  for (const week of weeksOut) {
    const hardDays = week.sessions
      .filter((session) => HARD_TYPES.has(session.type))
      .map((session) => session.dayOfWeek)
      .sort((a, b) => a - b);
    for (let i = 1; i < hardDays.length; i++) {
      if (hardDays[i] - hardDays[i - 1] === 1) {
        throw new Error(
          `PlanSpec places hard sessions on consecutive days in week ${week.index}; ` +
            "refusing to plan. Add a dayOfWeek or move one session.",
        );
      }
    }
  }

  return {
    id: hashString(
      [goal.id, spec.goalId, startDate, weeks, opts.seed ?? 0].join("|"),
    ),
    generatedAt: new Date().toISOString(),
    goalId: goal.id,
    startDate,
    endDate: addDays(startDate, weeks * 7 - 1),
    weeks: weeksOut,
    summary: {
      weeks,
      totalHours: round1(
        weeksOut.reduce(
          (sum, w) =>
            sum + w.sessions.reduce((h, s) => h + s.durationMinutes, 0) / 60,
          0,
        ),
      ),
      totalTss: round1(
        weeksOut.reduce((sum, w) => sum + w.computedTss, 0),
      ),
      startingCtl: round1(fitness.current.ctl),
      targetCtl: round1(
        weeksOut.reduce((sum, week) => sum + week.targetCtl, 0) / weeks,
      ),
      targetFtp: goal.targetFtp,
      daysPerWeek: goal.constraints.daysPerWeek,
      hoursPerWeek: round1(
        weeksOut.reduce(
          (sum, w) =>
            sum + w.sessions.reduce((h, s) => h + s.durationMinutes, 0) / 60,
          0,
        ) / weeks,
      ),
      focus: "custom",
    },
  };
}

/** Fail-closed safety and schema validation for an agent-authored PlanSpec. */
export function validatePlanSpec(
  spec: PlanSpec,
  goal: Goal,
  fitness: Fitness,
): PlanValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const suggestions: string[] = [];
  if (spec.goalId !== goal.id) {
    errors.push(
      `PlanSpec.goalId (${spec.goalId}) does not match goal-current.id (${goal.id}).`,
    );
  }
  if (!spec.rationale?.trim()) {
    errors.push("PlanSpec.rationale is required.");
  }
  if (!Array.isArray(spec.phases) || spec.phases.length === 0) {
    errors.push("PlanSpec.phases must contain at least one phase.");
  }
  const phaseWeeks = (spec.phases ?? []).reduce(
    (sum, phase) => sum + Math.max(0, Number(phase.weeks) || 0),
    0,
  );
  if (phaseWeeks !== goal.weeks) {
    errors.push(
      `PlanSpec phases cover ${phaseWeeks} weeks but the goal is ${goal.weeks} weeks.`,
    );
  }
  if (!Array.isArray(spec.sessions) || spec.sessions.length === 0) {
    errors.push("PlanSpec.sessions must contain at least one session.");
  }
  const allowedTypes = new Set<SessionType>([
    "recovery",
    "endurance",
    "sweetspot",
    "threshold",
    "vo2",
    "overunder",
    "sprint",
    "anaerobic",
    "ftp-test",
    "event",
  ]);
  const hardByWeek = new Map<number, PlanSpecSession[]>();
  const sprintDays: number[] = [];
  const sprintByWeek = new Map<number, number>();
  const anaerobicByWeek = new Map<number, number>();
  let hasRawXml = false;

  for (const session of spec.sessions ?? []) {
    if (!session.id || !session.title || !session.why || !session.purpose) {
      errors.push(
        `Session ${
          session.id || "(missing id)"
        } needs id, title, why and purpose.`,
      );
    }
    if (
      !Number.isInteger(session.week) || session.week < 1 ||
      session.week > goal.weeks
    ) {
      errors.push(
        `Session ${session.id} week ${session.week} is outside 1..${goal.weeks}.`,
      );
    }
    if (
      session.dayOfWeek !== undefined &&
      (!Number.isInteger(session.dayOfWeek) || session.dayOfWeek < 1 ||
        session.dayOfWeek > 7)
    ) {
      errors.push(`Session ${session.id} dayOfWeek must be 1..7.`);
    }
    if (!allowedTypes.has(session.type)) {
      errors.push(`Session ${session.id} has unknown type ${session.type}.`);
    }
    if (
      !Number.isFinite(session.durationMinutes) || session.durationMinutes <= 0
    ) {
      errors.push(`Session ${session.id} durationMinutes must be positive.`);
    } else if (
      session.durationMinutes > goal.constraints.maxSessionMinutes * 1.5
    ) {
      errors.push(
        `Session ${session.id} is ${session.durationMinutes} min, over 1.5x the ${goal.constraints.maxSessionMinutes} min cap.`,
      );
    } else if (session.durationMinutes > goal.constraints.maxSessionMinutes) {
      warnings.push(
        `Session ${session.id} is ${session.durationMinutes} min, over the ${goal.constraints.maxSessionMinutes} min inferred cap.`,
      );
    }
    if (session.steps) {
      for (const step of session.steps) {
        const record = step as unknown as Record<string, unknown>;
        if ("xml" in record || "rawXml" in record) hasRawXml = true;
        for (const value of Object.values(record)) {
          if (
            typeof value === "string" &&
            /<workout_file|<Warmup|<SteadyState/i.test(value)
          ) {
            hasRawXml = true;
          }
        }
      }
    }
    if (HARD_TYPES.has(session.type)) {
      const list = hardByWeek.get(session.week) ?? [];
      list.push(session);
      hardByWeek.set(session.week, list);
    }
    if (SPRINT_TYPES.has(session.type)) {
      const day = (session.week - 1) * 7 + (session.dayOfWeek ?? 3);
      sprintDays.push(day);
      sprintByWeek.set(
        session.week,
        (sprintByWeek.get(session.week) ?? 0) + 1,
      );
    }
    if (session.type === "anaerobic") {
      anaerobicByWeek.set(
        session.week,
        (anaerobicByWeek.get(session.week) ?? 0) + 1,
      );
    }
    if (
      goal.goalSpec?.preferences?.sprintFocus &&
      (session.type === "sprint" || session.type === "anaerobic")
    ) {
      if (!session.steps?.length) {
        warnings.push(
          `Session ${session.id} has no steps; the coach will fill target-derived MaxEffort/FreeRide blocks.`,
        );
      } else if (
        !session.steps.some((step) =>
          step.kind === "maxeffort" || step.kind === "free"
        )
      ) {
        errors.push(
          `Session ${session.id} uses only FTP-relative steps; absolute sprint/60 s goals need MaxEffort/FreeRide blocks with target watts.`,
        );
      }
    }
  }

  if (hasRawXml) {
    errors.push(
      "PlanSpec must use typed steps; raw ZWO/XML is forbidden.",
    );
  }

  for (const [week, list] of hardByWeek) {
    if (list.length > 3) {
      errors.push(
        `Week ${week} has ${list.length} hard sessions; the limit is 3.`,
      );
    }
    if (goal.goalSpec?.preferences?.sprintFocus && list.length > 3) {
      errors.push(
        `Week ${week} exceeds the sprint goal's 3 hard-session limit.`,
      );
    }
    const days = list
      .map((s) => s.dayOfWeek)
      .filter((d): d is number => d !== undefined)
      .sort((a, b) => a - b);
    for (let i = 1; i < days.length; i++) {
      if (days[i] - days[i - 1] === 1) {
        errors.push(
          `Week ${week} has consecutive hard days (${days[i - 1]} and ${
            days[i]
          }).`,
        );
      }
    }
  }
  for (const [week, count] of sprintByWeek) {
    if (count > 3) {
      errors.push(
        `Week ${week} has ${count} sprint sessions; the limit is 3.`,
      );
    }
  }
  for (const [week, count] of anaerobicByWeek) {
    if (count > 2) {
      errors.push(
        `Week ${week} has ${count} anaerobic sessions; the limit is 2.`,
      );
    }
  }
  const uniqueSprintDays = [...new Set(sprintDays)].sort((a, b) => a - b);
  for (let i = 1; i < uniqueSprintDays.length; i++) {
    if (uniqueSprintDays[i] - uniqueSprintDays[i - 1] < 2) {
      errors.push(
        `Sprint sessions on days ${uniqueSprintDays[i - 1]} and ${
          uniqueSprintDays[i]
        } need at least 48 h between them.`,
      );
    }
  }

  for (let week = 1; week <= goal.weeks; week++) {
    const sessions = (spec.sessions ?? []).filter((s) => s.week === week);
    const endurance = sessions.filter((s) =>
      s.type === "endurance" || s.type === "recovery"
    ).length;
    if (endurance === 0) {
      warnings.push(
        `Week ${week} has no endurance/recovery session; add Z2 maintenance.`,
      );
    }
    const hours = sessions.reduce(
      (sum, s) => sum + (Number(s.durationMinutes) || 0),
      0,
    ) / 60;
    if (hours > goal.constraints.hoursPerWeek * 1.2) {
      errors.push(
        `Week ${week} asks for ${
          round1(hours)
        } h, over 120% of the ${goal.constraints.hoursPerWeek} h constraint.`,
      );
    } else if (hours > goal.constraints.hoursPerWeek * 1.05) {
      warnings.push(
        `Week ${week} asks for ${
          round1(hours)
        } h, slightly over the ${goal.constraints.hoursPerWeek} h constraint.`,
      );
    }
  }

  const recoveryPhases = (spec.phases ?? []).filter((p) =>
    /recovery|deload/i.test(p.name)
  );
  const expectedRecovery = Math.floor(
    goal.weeks / (goal.goalSpec?.constraints.recoveryEveryNWeeks ?? 4),
  );
  if (
    recoveryPhases.length < Math.max(1, expectedRecovery - 1) && goal.weeks >= 8
  ) {
    warnings.push(
      "Fewer recovery weeks than the age/load rule expects; add a deload.",
    );
  }
  if (goal.weeks >= 8) {
    const every = goal.goalSpec?.constraints.recoveryEveryNWeeks ?? 4;
    const expected = [0];
    for (let week = every; week < goal.weeks; week += every) {
      expected.push(week);
    }
    expected.push(goal.weeks);
    for (const week of expected) {
      if (!spec.tests.some((t) => t.week === week)) {
        warnings.push(
          `No test at week ${week}; the sprint goal expects 5 s/60 s tests on the recovery/test cadence.`,
        );
      }
    }
  }
  if (
    goal.goalSpec?.constraints.equipment.includes("erg") &&
    !goal.goalSpec.constraints.equipment.includes("resistance") &&
    (goal.primary.metric === "power5" ||
      goal.secondary.some((t) => t.metric === "power5"))
  ) {
    warnings.push(
      "ERG-only equipment cannot execute max-wattage sprints well; add resistance mode or torque/standing efforts.",
    );
  }
  if (fitness.flags.staleFtp) {
    warnings.push("No recent FTP; benchmark before hard intervals.");
  }
  if (goal.clarifyingQuestions && goal.clarifyingQuestions.length > 0) {
    errors.push(
      `Answer the goal's clarifying questions before planning: ${
        goal.clarifyingQuestions.join(" ")
      }`,
    );
  }
  if (errors.length === 0) {
    suggestions.push(
      "PlanSpec passes structural and safety validation; render and preview before delivery.",
    );
  }
  return {
    goalId: goal.id,
    errors,
    warnings,
    suggestions,
    checkedAt: new Date().toISOString(),
  };
}

function stepSchema(): Record<string, unknown> {
  const duration = { type: "number", exclusiveMinimum: 0 };
  const power = { type: "number", minimum: 0.2, maximum: 2.5 };
  return {
    oneOf: [
      {
        type: "object",
        additionalProperties: false,
        required: ["kind", "minutes", "powerLow", "powerHigh"],
        properties: {
          kind: { const: "warmup" },
          minutes: duration,
          powerLow: power,
          powerHigh: power,
          cadence: { type: "number" },
          text: { type: "string" },
        },
      },
      {
        type: "object",
        additionalProperties: false,
        required: ["kind", "minutes", "power"],
        properties: {
          kind: { const: "steady" },
          minutes: duration,
          power,
          cadence: { type: "number" },
          text: { type: "string" },
        },
      },
      {
        type: "object",
        additionalProperties: false,
        required: ["kind", "minutes", "powerLow", "powerHigh"],
        properties: {
          kind: { const: "ramp" },
          minutes: duration,
          powerLow: power,
          powerHigh: power,
          cadence: { type: "number" },
          text: { type: "string" },
        },
      },
      {
        type: "object",
        additionalProperties: false,
        required: [
          "kind",
          "repeat",
          "onMinutes",
          "offMinutes",
          "onPower",
          "offPower",
        ],
        properties: {
          kind: { const: "intervals" },
          repeat: { type: "integer", minimum: 1 },
          onMinutes: duration,
          offMinutes: duration,
          onPower: power,
          offPower: power,
          cadence: { type: "number" },
          cadenceResting: { type: "number" },
          text: { type: "string" },
        },
      },
      {
        type: "object",
        additionalProperties: false,
        required: ["kind", "minutes"],
        properties: {
          kind: { const: "free" },
          minutes: duration,
          flatRoad: { type: "boolean" },
          text: { type: "string" },
        },
      },
      {
        type: "object",
        additionalProperties: false,
        required: ["kind", "minutes"],
        properties: {
          kind: { const: "maxeffort" },
          minutes: duration,
          text: { type: "string" },
        },
      },
      {
        type: "object",
        additionalProperties: false,
        required: ["kind", "minutes", "powerLow", "powerHigh"],
        properties: {
          kind: { const: "cooldown" },
          minutes: duration,
          powerLow: power,
          powerHigh: power,
          cadence: { type: "number" },
          text: { type: "string" },
        },
      },
    ],
  };
}

function planSpecSchema(): Record<string, unknown> {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    required: [
      "goalId",
      "rationale",
      "phases",
      "sessions",
      "progressionRules",
      "tests",
    ],
    properties: {
      goalId: { type: "string" },
      rationale: { type: "string" },
      phases: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "name",
            "weeks",
            "theme",
            "narrative",
            "focus",
            "keySessionTypes",
          ],
          properties: {
            name: { type: "string" },
            weeks: { type: "integer", minimum: 1 },
            theme: { type: "string" },
            narrative: { type: "string" },
            focus: { type: "string" },
            weeklyTssTarget: { type: "number" },
            keySessionTypes: {
              type: "array",
              items: { type: "string" },
            },
          },
        },
      },
      sessions: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "id",
            "week",
            "type",
            "title",
            "hook",
            "why",
            "purpose",
            "durationMinutes",
          ],
          properties: {
            id: { type: "string" },
            week: { type: "integer", minimum: 1 },
            dayOfWeek: { type: "integer", minimum: 1, maximum: 7 },
            type: {
              enum: [
                "recovery",
                "endurance",
                "sweetspot",
                "threshold",
                "vo2",
                "overunder",
                "sprint",
                "anaerobic",
                "ftp-test",
                "event",
              ],
            },
            title: { type: "string" },
            hook: { type: "string" },
            why: { type: "string" },
            purpose: { type: "string" },
            fun: { type: "boolean" },
            zwiftSuggestion: { type: "string" },
            durationMinutes: { type: "number", exclusiveMinimum: 0 },
            targetTss: { type: "number" },
            steps: { type: "array", items: stepSchema() },
            progression: { type: "string" },
          },
        },
      },
      progressionRules: {
        type: "array",
        items: { type: "string" },
      },
      tests: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["week", "protocol"],
          properties: {
            week: { type: "integer", minimum: 0 },
            protocol: { type: "string" },
          },
        },
      },
    },
  };
}

function goalSpecSchema(): Record<string, unknown> {
  const target = {
    type: "object",
    additionalProperties: false,
    required: ["metric", "target", "unit"],
    properties: {
      metric: {
        enum: [
          "power5",
          "power15",
          "power60",
          "power300",
          "ftp",
          "wkg",
          "ctl",
          "weight",
          "event",
        ],
      },
      target: { type: ["number", "string"] },
      unit: { enum: ["W", "W/kg", "kg", "TSS/day", "date"] },
      comparison: { enum: [">=", "<=", "="] },
      byDate: { type: "string" },
    },
  };
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    required: [
      "id",
      "description",
      "horizonWeeks",
      "startDate",
      "primary",
      "secondary",
      "constraints",
      "tests",
      "assumptions",
      "clarifyingQuestions",
    ],
    properties: {
      id: { type: "string" },
      description: { type: "string" },
      horizonWeeks: { type: "integer", minimum: 4, maximum: 24 },
      startDate: { type: "string" },
      targetDate: { type: "string" },
      primary: target,
      secondary: { type: "array", items: target },
      constraints: { type: "object" },
      tests: { type: "array", items: { type: "object" } },
      preferences: { type: "object" },
      assumptions: { type: "array", items: { type: "string" } },
      clarifyingQuestions: { type: "array", items: { type: "string" } },
    },
  };
}

function examplePlanSpec(goal: Goal): PlanSpec {
  const sprint = goal.goalSpec?.preferences?.sprintFocus === true;
  const sessions: PlanSpecSession[] = sprint
    ? [
      {
        id: "w01-sprint",
        week: 1,
        dayOfWeek: 2,
        type: "sprint",
        title: "Sprint 6 x 15 s",
        hook: "Big gear, full send, full recovery",
        why: "Recruitment and max wattage",
        purpose: "Neuromuscular power",
        durationMinutes: 60,
        targetTss: 45,
      },
      {
        id: "w01-anaerobic",
        week: 1,
        dayOfWeek: 4,
        type: "anaerobic",
        title: "4 x 90 s anaerobic",
        hook: "Hold the gear longer",
        why: "Builds the 60 s engine",
        purpose: "Anaerobic capacity",
        durationMinutes: 75,
        targetTss: 85,
      },
      {
        id: "w01-endurance",
        week: 1,
        dayOfWeek: 6,
        type: "endurance",
        title: "Z2 route badge",
        hook: "Fun and aerobic",
        why: "Maintains the engine",
        purpose: "Aerobic maintenance",
        fun: true,
        durationMinutes: 100,
        targetTss: 70,
      },
      {
        id: "w01-recovery",
        week: 1,
        dayOfWeek: 7,
        type: "recovery",
        title: "Flush the legs",
        hook: "Easy spinning",
        why: "Absorb the work",
        purpose: "Recovery",
        durationMinutes: 45,
        targetTss: 25,
      },
    ]
    : [
      {
        id: "w01-sweetspot",
        week: 1,
        dayOfWeek: 2,
        type: "sweetspot",
        title: "3 x 12 min sweet spot",
        hook: "Controlled pressure",
        why: "Raises FTP",
        purpose: "Aerobic + muscular endurance",
        durationMinutes: 75,
        targetTss: 85,
      },
      {
        id: "w01-endurance",
        week: 1,
        dayOfWeek: 6,
        type: "endurance",
        title: "Z2 route badge",
        hook: "Fun and aerobic",
        why: "Builds the base",
        purpose: "Endurance",
        fun: true,
        durationMinutes: 100,
        targetTss: 70,
      },
    ];
  return {
    goalId: goal.id,
    rationale: sprint
      ? "Sprint work is low TSS; pair max efforts with anaerobic capacity and Z2 maintenance."
      : "Build aerobic pressure with one fun endurance session.",
    phases: [
      {
        name: "Base",
        weeks: 1,
        theme: "Base",
        narrative: "Short example block.",
        focus: sprint ? "Neuromuscular + anaerobic" : "Aerobic",
        keySessionTypes: sprint
          ? ["sprint", "anaerobic", "endurance"]
          : ["sweetspot", "endurance"],
      },
    ],
    sessions,
    progressionRules: [
      "Add one rep or a few seconds, not both.",
      "Keep at least 48 h between sprint sessions.",
    ],
    tests: goal.goalSpec?.tests ?? [],
  };
}

/** Build the machine-readable scaffold an external agent consumes. */
export function buildScaffold(fitness: Fitness, goal: Goal): Scaffold {
  const spec = goal.goalSpec ?? buildExampleGoalSpec(fitness, goal);
  return {
    goalId: goal.id,
    generatedAt: new Date().toISOString(),
    goalSpecSchema: goalSpecSchema(),
    planSpecSchema: planSpecSchema(),
    exampleGoalSpec: spec,
    examplePlanSpec: examplePlanSpec(goal),
    fitnessSummary: {
      ftpWatts: fitness.current.ftpWatts,
      wPerKg: fitness.current.wPerKg,
      ctl: fitness.current.ctl,
      atl: fitness.current.atl,
      tsb: fitness.current.tsb,
      weightKg: fitness.current.weightKg,
      age: fitness.athlete.age,
      flags: fitness.flags,
      powerCurve: fitness.powerCurve.best,
      powerCurveSource: fitness.powerCurve.source,
      powerCurveFetchedAt: fitness.powerCurve.fetchedAt,
    },
    availabilitySummary: {
      daysPerWeek: fitness.availability.daysPerWeek,
      hoursPerWeek: fitness.availability.hoursPerWeek,
      preferredDays: fitness.availability.preferredDays,
      preferredHours: fitness.availability.preferredHours,
      sessionMinutes: fitness.availability.sessionMinutes,
      recent8w: fitness.availability.recent8w,
      lowHistory: fitness.availability.lowHistory,
    },
    sessionArchetypes: [
      {
        type: "recovery",
        purpose: "Blood flow without fatigue",
        hard: false,
        defaultMinutes: 45,
      },
      {
        type: "endurance",
        purpose: "Aerobic base",
        hard: false,
        defaultMinutes: 90,
      },
      {
        type: "sweetspot",
        purpose: "Aerobic + muscular endurance",
        hard: true,
        defaultMinutes: 75,
      },
      { type: "threshold", purpose: "FTP", hard: true, defaultMinutes: 75 },
      { type: "vo2", purpose: "VO2max", hard: true, defaultMinutes: 60 },
      {
        type: "overunder",
        purpose: "Threshold + race craft",
        hard: true,
        defaultMinutes: 75,
      },
      {
        type: "sprint",
        purpose: "Neuromuscular / max wattage",
        hard: true,
        defaultMinutes: 60,
      },
      {
        type: "anaerobic",
        purpose: "60–90 s capacity",
        hard: true,
        defaultMinutes: 75,
      },
      {
        type: "ftp-test",
        purpose: "Benchmark",
        hard: false,
        defaultMinutes: 75,
      },
      {
        type: "event",
        purpose: "Race/group practice",
        hard: true,
        defaultMinutes: 90,
      },
    ],
    safetyLimits: {
      maxHardSessionsPerWeek:
        goal.goalSpec?.constraints.maxHardSessionsPerWeek ?? 3,
      maxSprintSessionsPerWeek: 3,
      minHoursBetweenSprintSessions: 48,
      maxAnaerobicSessionsPerWeek: 2,
      minAnaerobicEffortSeconds: 30,
      maxAnaerobicEffortSeconds: 120,
      minAnaerobicRecoveryMinutes: 3,
      minEnduranceSessionsPerWeek: 1,
      maxWeeklyTssJumpPct: 20,
      recoveryEveryNWeeks: goal.goalSpec?.constraints.recoveryEveryNWeeks ?? 4,
      maxSessionMinutes: goal.constraints.maxSessionMinutes,
      hoursPerWeek: goal.constraints.hoursPerWeek,
      daysPerWeek: goal.constraints.daysPerWeek,
    },
    promptTemplate: [
      "You are a cycling coach. Design a plan for this rider.",
      "",
      "Goal: {{goal.description}}",
      "Fitness: {{fitness.summary}}",
      "Availability (from history, use these): {{availability.summary}}",
      "Constraints: {{goal.constraints}}",
      "Allowed session archetypes: {{scaffold.sessionArchetypes}}",
      "Safety limits: {{scaffold.safetyLimits}}",
      "",
      "Return ONE JSON object that validates against the PlanSpec schema below.",
      "Do not return XML. Do not add fields. Do not exceed the availability or the hard-session limits.",
      "Explain the phase structure in `rationale`.",
      "Make every session title/hook/why specific and interesting; include one `fun` session per week and vary the interval formats.",
      "Do not frame food or weight as punishment/reward.",
      "",
      "{{scaffold.planSpecSchema}}",
    ].join("\n"),
    notes: [
      "The extension never calls an LLM and never accepts raw ZWO.",
      "An external agent (for example opencode via @mgreten/cli-agent) may return this JSON; the workflow validates it before planning.",
      "If validation returns errors, fix the PlanSpec and re-submit; do not bypass validate.",
      "examplePlanSpec is illustrative; cover every week in the goal horizon before submitting.",
      "Use fitness.powerCurve.best for absolute 5 s/60 s targets; do not convert them from FTP.",
      "Max and absolute 60 s blocks must use FreeRide/MaxEffort steps with target watts in the text; raw XML is forbidden.",
    ],
  };
}

function buildExampleGoalSpec(fitness: Fitness, goal: Goal): GoalSpec {
  return {
    id: goal.id,
    description: goal.description,
    horizonWeeks: goal.weeks,
    startDate: goal.startDate,
    targetDate: goal.targetDate,
    primary: goal.primary,
    secondary: goal.secondary,
    constraints: {
      daysPerWeek: goal.constraints.daysPerWeek,
      hoursPerWeek: goal.constraints.hoursPerWeek,
      availableDays: goal.constraints.availableDays,
      maxSessionMinutes: goal.constraints.maxSessionMinutes,
      equipment: goal.constraints.equipment,
      indoorOnly: goal.constraints.indoorOnly,
      injuries: goal.constraints.injuries,
      maxHardSessionsPerWeek: 3,
      recoveryEveryNWeeks: rampDefaults(fitness.athlete.age).recoveryEvery,
      availabilitySource: "merged",
    },
    tests: goal.goalSpec?.tests ?? [],
    preferences: {
      style: goal.constraints.style,
      sprintFocus: goal.constraints.style === "sprint",
      funPreference: "auto",
    },
    assumptions: goal.assumptions,
    clarifyingQuestions: goal.clarifyingQuestions ?? [],
  };
}

/** Human-readable one-paragraph summary for logs and previews. */
export function customGoalSummary(goal: Goal): string {
  const primary = goal.primary;
  const secondary = goal.secondary
    .map((t) => `${t.metric} ${t.comparison ?? ">="} ${t.target} ${t.unit}`)
    .join(", ");
  return `${goal.description} (${goal.weeks} weeks; primary ${primary.metric} ` +
    `${primary.comparison ?? ">="} ${primary.target} ${primary.unit}` +
    `${secondary ? `; secondary ${secondary}` : ""})`;
}

/** Stable plan spec id for a custom goal; useful for examples and tests. */
export function goalSpecId(description: string): string {
  return hashString(description.trim().toLowerCase());
}

/** Format a date the same way PlanSpec sessions expect. */
export function sessionDate(
  startDate: string,
  week: number,
  dayOfWeek: number,
): string {
  return dateString(
    dateMs(startDate) + (week - 1) * 7 * 86_400_000 +
      (dayOfWeek - 1) * 86_400_000,
  );
}
