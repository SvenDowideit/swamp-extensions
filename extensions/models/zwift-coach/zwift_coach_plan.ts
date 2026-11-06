/**
 * Built-in plan generator: weekly TSS trajectory, phases, session templates,
 * placement on the rider's historical days, engagement copy and one fun
 * session per week.
 *
 * @module
 */

import type {
  Fitness,
  Goal,
  Plan,
  Session,
  SessionType,
  Week,
} from "./zwift_coach_types.ts";
import {
  addDays,
  clamp,
  dateMs,
  dateString,
  hashString,
  round1,
  sessionMinutes,
} from "./zwift_coach_util.ts";
import { rampDefaults } from "./zwift_coach_goal.ts";
import { buildSession, fileNameFor } from "./zwift_coach_workouts.ts";

const TYPE_IF: Record<SessionType, number> = {
  recovery: 0.55,
  endurance: 0.68,
  sweetspot: 0.9,
  threshold: 0.98,
  vo2: 1.12,
  overunder: 1.0,
  sprint: 1.6,
  anaerobic: 1.1,
  "ftp-test": 1.0,
  event: 0.75,
};

const COPY: Record<
  SessionType,
  { title: string; hook: string; why: string; purpose: string }
> = {
  recovery: {
    title: "Flush the legs",
    hook: "Easy spinning, no heroics",
    why: "Blood flow without adding fatigue",
    purpose: "Recovery",
  },
  endurance: {
    title: "Build the engine",
    hook: "Steady Z2, enjoy the route",
    why: "Aerobic base and fat oxidation",
    purpose: "Endurance",
  },
  sweetspot: {
    title: "Sweet spot pressure",
    hook: "Hard enough to matter, controlled enough to repeat",
    why: "Raises FTP without burying you",
    purpose: "Aerobic + muscular endurance",
  },
  threshold: {
    title: "Threshold blocks",
    hook: "Settle in at the edge of sustainable",
    why: "Raises the ceiling you can hold",
    purpose: "FTP",
  },
  vo2: {
    title: "VO2 wake-up",
    hook: "Short, sharp, fully recovered",
    why: "Lifts the aerobic ceiling",
    purpose: "VO2max",
  },
  overunder: {
    title: "Over/under",
    hook: "Surge, settle, repeat",
    why: "Teaches you to clear lactate and keep going",
    purpose: "Threshold + race craft",
  },
  sprint: {
    title: "Sprint sharpening",
    hook: "Big gear, full send, full recovery",
    why: "Neuromuscular recruitment and max power",
    purpose: "Sprint",
  },
  anaerobic: {
    title: "Anaerobic capacity",
    hook: "Hold the gear longer than feels fair",
    why: "Builds the 60–90 s engine",
    purpose: "Anaerobic capacity",
  },
  "ftp-test": {
    title: "Benchmark day",
    hook: "One clean 20-minute effort",
    why: "Calibrates every zone for the next block",
    purpose: "Test",
  },
  event: {
    title: "Event day",
    hook: "Race or group ride — go play",
    why: "Practice pacing and pack skills",
    purpose: "Event",
  },
};

/** Monday on or after `date`. */
export function nextMonday(date: string): string {
  const ms = dateMs(date);
  const dow = new Date(ms).getUTCDay(); // 0=Sun
  const delta = dow === 1 ? 0 : (8 - dow) % 7;
  return dateString(ms + delta * 86_400_000);
}

function phaseFor(
  week: number,
  weeks: number,
  reEntry: number,
  recoveryEvery: number,
): Week["phase"] {
  if (week <= reEntry) return "re-entry";
  const taperWeeks = weeks >= 8 ? 2 : 1;
  if (week > weeks - taperWeeks) return "taper";
  const buildWeek = week - reEntry;
  if (buildWeek > 0 && buildWeek % recoveryEvery === 0) return "recovery";
  const workWeeks = weeks - reEntry - taperWeeks;
  const baseWeeks = Math.max(2, Math.round(workWeeks * 0.45));
  const buildWeeks = Math.max(0, workWeeks - baseWeeks);
  const peakWeeks = buildWeeks >= 2
    ? Math.min(2, Math.round(buildWeeks * 0.25))
    : 0;
  if (peakWeeks > 0 && buildWeek > workWeeks - peakWeeks) return "peak";
  return buildWeek <= baseWeeks ? "base" : "build";
}

function phaseCopy(phase: Week["phase"]): { theme: string; narrative: string } {
  switch (phase) {
    case "re-entry":
      return {
        theme: "Re-entry",
        narrative: "Rebuild the habit and let the legs remember.",
      };
    case "base":
      return {
        theme: "Build the base",
        narrative: "Aerobic work and sweet spot; consistency beats heroics.",
      };
    case "build":
      return {
        theme: "Build the ceiling",
        narrative: "Threshold and VO2 work, with recovery protected.",
      };
    case "peak":
      return {
        theme: "Peak",
        narrative: "Sharpen the top end and keep the volume controlled.",
      };
    case "recovery":
      return {
        theme: "Recovery week",
        narrative: "Absorb the work; keep the legs moving.",
      };
    case "taper":
      return {
        theme: "Taper",
        narrative: "Short, sharp, fresh — arrive ready.",
      };
  }
}

function sessionTypesFor(
  phase: Week["phase"],
  days: number,
): { type: SessionType; long: boolean }[] {
  if (phase === "re-entry" || phase === "recovery") {
    return Array.from({ length: days }, (_, i) => ({
      type: i === 0 ? "recovery" : "endurance",
      long: i === days - 1 && days > 1,
    }));
  }
  if (phase === "taper") {
    return Array.from({ length: days }, (_, i) => ({
      type: i === 0 ? "vo2" : i === 1 ? "recovery" : "endurance",
      long: false,
    }));
  }
  const key: SessionType[] = phase === "build" || phase === "peak"
    ? ["threshold", "vo2"]
    : ["sweetspot", "sweetspot"];
  const recovery = (): { type: SessionType; long: boolean } => ({
    type: "recovery",
    long: false,
  });
  const endurance = (long = false): { type: SessionType; long: boolean } => ({
    type: "endurance",
    long,
  });
  if (days === 2) {
    return [{ type: key[0], long: false }, endurance(true)];
  }
  if (days === 3) {
    return [{ type: key[0], long: false }, endurance(true), recovery()];
  }
  if (days === 4) {
    return [
      { type: key[0], long: false },
      { type: key[1], long: false },
      endurance(true),
      recovery(),
    ];
  }
  if (days === 5) {
    return [
      { type: key[0], long: false },
      { type: key[1], long: false },
      endurance(),
      endurance(true),
      recovery(),
    ];
  }
  return [
    { type: key[0], long: false },
    { type: key[1], long: false },
    endurance(),
    endurance(),
    endurance(true),
    recovery(),
  ];
}

function weightsFor(types: { type: SessionType; long: boolean }[]): number[] {
  if (types.length === 2) return [0.45, 0.55];
  if (types.length === 3) return [0.45, 0.47, 0.08];
  const weights = types.map((t) => {
    if (t.type === "recovery") return 0.05;
    if (t.long) return 0.35;
    if (t.type === "sweetspot" || t.type === "threshold" || t.type === "vo2") {
      return 0.2;
    }
    return 0.18;
  });
  const total = weights.reduce((a, b) => a + b, 0);
  return weights.map((w) => w / total);
}

function funSuggestion(flavor: Fitness["rideFlavor"]["funPreference"]): string {
  switch (flavor) {
    case "race":
      return "Pick a Zwift race or TT that fits your usual start time.";
    case "banded":
      return "Pick a banded group ride/event at your usual hour.";
    case "group":
      return "Pick a group ride or fondo that matches the session length.";
    case "workout":
      return "Use a Zwift workout or chase a route badge.";
    case "solo":
      return "Pick a route badge, KOM or sprint hunt you enjoy.";
  }
}

export function dayList(goal: Goal): number[] {
  const preferred = [...new Set(goal.constraints.availableDays)]
    .filter((d) => d >= 1 && d <= 7)
    .sort((a, b) => a - b);
  const fallback = [2, 4, 6, 7, 3, 5, 1];
  const out = preferred.length >= goal.constraints.daysPerWeek
    ? preferred.slice(0, goal.constraints.daysPerWeek)
    : [...preferred];
  for (const day of fallback) {
    if (out.length >= goal.constraints.daysPerWeek) break;
    if (!out.includes(day)) out.push(day);
  }
  return out.sort((a, b) => a - b);
}

/** Generate the plan for a compiled goal. */
export function generatePlan(
  fitness: Fitness,
  goal: Goal,
  opts: { startDate?: string; weeks?: number; seed?: number } = {},
): Plan {
  const weeks = clamp(opts.weeks ?? goal.weeks, 4, 24);
  const startDate = nextMonday(opts.startDate ?? goal.startDate);
  const age = fitness.athlete.age;
  const { rampPerWeek, recoveryEvery } = rampDefaults(age);
  const currentCtl = fitness.current.ctl;
  const targetCtl = Math.max(goal.targetCtl, currentCtl);
  const maxWeeklyTss = goal.constraints.hoursPerWeek * 70;
  const reEntry = fitness.flags.detrained ? 2 : 0;
  const days = goal.constraints.daysPerWeek;
  const dayNumbers = dayList(goal);
  const dates = Array.from(
    { length: weeks },
    (_, i) => addDays(startDate, i * 7),
  );

  let buildTarget = Math.max(
    currentCtl * 7,
    goal.constraints.hoursPerWeek * 35,
  );
  let lastNonRecovery = buildTarget;
  const weekRows: Week[] = [];
  for (let i = 0; i < weeks; i++) {
    const weekNo = i + 1;
    const phase = phaseFor(weekNo, weeks, reEntry, recoveryEvery);
    let weeklyTss: number;
    if (phase === "re-entry") {
      weeklyTss = currentCtl * 7 * 0.7;
    } else if (phase === "recovery") {
      weeklyTss = lastNonRecovery * 0.65;
    } else if (phase === "taper") {
      weeklyTss = Math.max(
        0,
        lastNonRecovery * (weekNo === weeks ? 0.6 : 0.75),
      );
    } else {
      buildTarget = Math.min(
        maxWeeklyTss,
        Math.min(targetCtl * 7, buildTarget + rampPerWeek * 7),
      );
      weeklyTss = buildTarget;
      lastNonRecovery = buildTarget;
    }
    const types = sessionTypesFor(phase, days);
    const weights = weightsFor(types);
    const hourBudget = goal.constraints.hoursPerWeek * 60;
    const budgets = weights.map((w) =>
      Math.min(goal.constraints.maxSessionMinutes, hourBudget * w)
    );
    const atBudget = budgets.map((minutes, i) =>
      (minutes / 60) * TYPE_IF[types[i].type] * TYPE_IF[types[i].type] * 100
    );
    const atBudgetTotal = atBudget.reduce((a, b) => a + b, 0);
    const scale = atBudgetTotal > weeklyTss
      ? weeklyTss / Math.max(1, atBudgetTotal)
      : 1;
    const sessions: Session[] = [];
    for (let s = 0; s < types.length; s++) {
      const item = types[s];
      const date = addDays(dates[i], (dayNumbers[s] ?? (s + 2)) - 1);
      const budgetMinutes = budgets[s] * scale;
      const ifValue = TYPE_IF[item.type];
      const targetTss = round1(
        (budgetMinutes / 60) * ifValue * ifValue * 100,
      );
      const durationMinutes = sessionMinutes(budgetMinutes);
      const copy = COPY[item.type];
      const fun = item.long && !sessions.some((x) => x.fun);
      const built = buildSession({
        id: `w${String(weekNo).padStart(2, "0")}-${date}`,
        week: weekNo,
        date,
        dayOfWeek: dayNumbers[s] ?? (s + 2),
        type: item.type,
        title: `${copy.title} — ${goal.mode}`,
        hook: copy.hook,
        why: copy.why,
        purpose: copy.purpose,
        targetTss,
        durationMinutes,
        maxMinutes: durationMinutes,
        fun,
        zwiftSuggestion: fun
          ? funSuggestion(fitness.rideFlavor.funPreference)
          : undefined,
        progression: phase === "build"
          ? "Add a rep or a few minutes next week; do not add both."
          : undefined,
      });
      // The template cannot always absorb the full TSS allocation within the
      // session cap; report the achievable number rather than a target the
      // rider cannot hit.
      if (built.computedTss < built.targetTss * 0.9) {
        built.targetTss = built.computedTss;
      }
      sessions.push(built);
    }
    if (!sessions.some((x) => x.fun) && sessions.length > 0) {
      const last = sessions[sessions.length - 1];
      last.fun = true;
      last.zwiftSuggestion = funSuggestion(fitness.rideFlavor.funPreference);
    }
    const pc = phaseCopy(phase);
    weekRows.push({
      index: weekNo,
      startDate: dates[i],
      phase,
      theme: pc.theme,
      narrative: pc.narrative,
      targetCtl: round1(weeklyTss / 7),
      weeklyTss: round1(weeklyTss),
      computedTss: round1(
        sessions.reduce((sum, session) => sum + session.computedTss, 0),
      ),
      sessions,
    });
  }

  const plan: Plan = {
    id: hashString(
      [goal.id, startDate, weeks, opts.seed ?? 0].join("|"),
    ),
    generatedAt: new Date().toISOString(),
    goalId: goal.id,
    startDate,
    endDate: addDays(startDate, weeks * 7 - 1),
    weeks: weekRows,
    summary: {
      weeks,
      totalHours: round1(
        weekRows.reduce(
          (sum, w) =>
            sum +
            w.sessions.reduce((h, s) => h + s.durationMinutes, 0) / 60,
          0,
        ),
      ),
      totalTss: round1(
        weekRows.reduce(
          (sum, w) => sum + w.sessions.reduce((t, s) => t + s.computedTss, 0),
          0,
        ),
      ),
      startingCtl: round1(currentCtl),
      targetCtl: round1(targetCtl),
      targetFtp: goal.targetFtp,
      daysPerWeek: days,
      hoursPerWeek: round1(
        weekRows.reduce(
          (sum, w) =>
            sum +
            w.sessions.reduce((h, s) => h + s.durationMinutes, 0) / 60,
          0,
        ) / weeks,
      ),
      focus: goal.mode,
    },
  };
  return plan;
}

/** File names for the rendered workouts in a plan. */
export function planFileNames(plan: Plan): string[] {
  return plan.weeks.flatMap((w) => w.sessions.map(fileNameFor));
}
