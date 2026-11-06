/**
 * Compile a built-in goal (regain/improve/event) into a concrete target and
 * planning constraints. Availability defaults to the history-derived p80.
 *
 * @module
 */

import type { Fitness, Goal, Target } from "./zwift_coach_types.ts";
import {
  addDays,
  clamp,
  daysBetween,
  hashString,
  round1,
  todayUtc,
} from "./zwift_coach_util.ts";

export interface GoalInput {
  fitness: Fitness;
  mode: "regain" | "improve" | "event" | "custom";
  description?: string;
  targetDate?: string;
  targetFtpPct?: number;
  targetWkg?: number;
  targetWeightKg?: number;
  eventType?: string;
  weeks?: number;
  daysPerWeek?: number;
  hoursPerWeek?: number;
  overrideAvailability?: boolean;
  age?: number;
  style?: "pyramidal" | "polarised" | "sprint";
  constraints?: {
    availableDays?: number[];
    maxSessionMinutes?: number;
    equipment?: string[];
    indoorOnly?: boolean;
    injuries?: string[];
  };
}

/** Ramp/recovery defaults by age band. */
export function rampDefaults(age: number | null): {
  rampPerWeek: number;
  recoveryEvery: number;
} {
  if (age === null) return { rampPerWeek: 4, recoveryEvery: 3 };
  if (age >= 60) return { rampPerWeek: 2.5, recoveryEvery: 2 };
  if (age >= 50) return { rampPerWeek: 3, recoveryEvery: 3 };
  if (age >= 40) return { rampPerWeek: 4, recoveryEvery: 3 };
  return { rampPerWeek: 5, recoveryEvery: 4 };
}

/** Compile the goal and attach explicit assumptions/warnings. */
export function compileGoal(input: GoalInput): Goal {
  if (input.mode === "custom") {
    throw new Error(
      "Custom goals are Phase 4. Use regain/improve/event for now.",
    );
  }
  const f = input.fitness;
  const startDate = todayUtc();
  const age = input.age ?? f.athlete.age;
  const { rampPerWeek, recoveryEvery } = rampDefaults(age);
  const p80Days = f.availability.daysPerWeek.p80;
  const p80Hours = f.availability.hoursPerWeek.p80;
  const override = input.overrideAvailability === true;
  const daysPerWeek = clamp(
    Math.round(input.daysPerWeek ?? (p80Days > 0 ? p80Days : 3)),
    2,
    6,
  );
  const hoursPerWeek = clamp(
    input.hoursPerWeek ?? (p80Hours > 0 ? p80Hours : 6),
    2,
    20,
  );
  const maxWeeklyTss = hoursPerWeek * 70;
  const availableDays = input.constraints?.availableDays?.length
    ? input.constraints.availableDays
    : f.availability.preferredDays;
  const maxSessionMinutes = input.constraints?.maxSessionMinutes ??
    (f.availability.sessionMinutes.p90 || 120);
  const currentCtl = f.current.ctl;
  const sustained = f.peaks.sustainedCtl || f.peaks.ctl || currentCtl;
  const currentFtp = f.current.ftpWatts ?? f.peaks.ftpWatts;
  const peakFtp = f.peaks.ftpWatts ?? currentFtp;

  let targetCtl = currentCtl;
  let targetFtp = currentFtp;
  let weeks = input.weeks ?? 12;
  let primary: Target = { metric: "ctl", target: 0, unit: "TSS/day" };
  const secondary: Target[] = [];
  const assumptions: string[] = [];
  const warnings: string[] = [];

  if (input.mode === "regain") {
    targetCtl = Math.max(
      currentCtl,
      Math.min(sustained, Math.max(currentCtl + 3, 0.925 * sustained)),
    );
    targetFtp = currentFtp === null ? null : Math.max(
      currentFtp,
      Math.min(peakFtp ?? currentFtp, currentFtp * 1.05),
    );
    primary = {
      metric: "ctl",
      target: round1(targetCtl),
      unit: "TSS/day",
      comparison: ">=",
    };
    if (targetFtp !== null) {
      secondary.push({
        metric: "ftp",
        target: round1(targetFtp),
        unit: "W",
        comparison: ">=",
      });
    }
    assumptions.push(
      "Regain target is 92.5% of the sustained peak CTL, capped at the peak.",
    );
  } else if (input.mode === "improve") {
    const pct = clamp(input.targetFtpPct ?? 0.05, 0.01, 0.1);
    targetFtp = currentFtp === null ? null : round1(currentFtp * (1 + pct));
    if (targetFtp !== null && input.targetWkg !== undefined) {
      const weight = f.weight.currentKg ?? f.current.weightKg;
      if (weight !== null && weight > 0) {
        targetFtp = round1(input.targetWkg * weight);
      }
    }
    targetCtl = Math.min(
      maxWeeklyTss / 7,
      Math.max(currentCtl * 1.1, 0.95 * sustained),
    );
    weeks = clamp(input.weeks ?? 12, 8, 24);
    primary = {
      metric: "ftp",
      target: targetFtp ?? 0,
      unit: "W",
      comparison: ">=",
    };
    assumptions.push(`FTP target is +${Math.round(pct * 100)}% over current.`);
  } else {
    if (!input.targetDate) {
      throw new Error("Event goals need a targetDate (YYYY-MM-DD).");
    }
    weeks = Math.max(
      1,
      Math.floor(daysBetween(startDate, input.targetDate) / 7),
    );
    targetCtl = Math.min(
      maxWeeklyTss / 7,
      Math.max(currentCtl, 0.95 * sustained),
    );
    primary = {
      metric: "event",
      target: input.targetDate,
      unit: "date",
      byDate: input.targetDate,
    };
    assumptions.push(
      `Event on ${input.targetDate} (${input.eventType ?? "general"}); ` +
        `${weeks} weeks available.`,
    );
  }

  if (targetFtp !== null && primary.metric !== "ftp") {
    secondary.push({
      metric: "ftp",
      target: round1(targetFtp),
      unit: "W",
      comparison: ">=",
    });
  }
  if (input.targetWeightKg !== undefined) {
    secondary.push({
      metric: "weight",
      target: round1(input.targetWeightKg),
      unit: "kg",
      comparison: "<=",
    });
  }

  const effectiveRamp = rampPerWeek * (recoveryEvery - 1) / recoveryEvery;
  const neededWeeks = Math.ceil(
    Math.max(0, targetCtl - currentCtl) / Math.max(0.1, effectiveRamp),
  );
  if (input.mode === "regain" && input.weeks === undefined) {
    weeks = clamp(neededWeeks || 12, 6, 24);
  }
  if (weeks < neededWeeks) {
    warnings.push(
      `Requested ${weeks} weeks but the ramp cap needs ~${neededWeeks}; ` +
        "the plan will use the ramp cap and may not reach the target.",
    );
  }
  if (
    override && input.daysPerWeek !== undefined && p80Days > 0 &&
    input.daysPerWeek > p80Days * 1.2
  ) {
    warnings.push(
      `Override ${input.daysPerWeek} days/week is above the historical ` +
        `p80 (${p80Days}); recovery may suffer.`,
    );
  }
  if (
    override && input.hoursPerWeek !== undefined && p80Hours > 0 &&
    input.hoursPerWeek > p80Hours * 1.2
  ) {
    warnings.push(
      `Override ${input.hoursPerWeek} h/week is above the historical ` +
        `p80 (${p80Hours}); the plan will protect recovery.`,
    );
  }
  if (f.flags.lowHistory) {
    warnings.push(
      "Less than 8 weeks of history: availability is provisional; refine " +
        "after 4–8 weeks.",
    );
  }
  if (f.flags.staleFtp) {
    warnings.push("No recent FTP; benchmark before hard intervals.");
  }
  if (f.flags.detrained) {
    warnings.push("Detrained or returning from a gap: re-entry weeks first.");
  }

  const targetDate = input.targetDate ?? addDays(startDate, weeks * 7);
  const goal: Goal = {
    id: hashString(
      [
        input.mode,
        startDate,
        weeks,
        targetCtl,
        targetFtp,
        daysPerWeek,
        hoursPerWeek,
      ]
        .join("|"),
    ),
    mode: input.mode,
    description: input.description ?? `${input.mode} goal`,
    startDate,
    targetDate,
    weeks,
    primary,
    secondary,
    constraints: {
      daysPerWeek,
      hoursPerWeek,
      availableDays,
      maxSessionMinutes,
      style: input.style ?? "pyramidal",
      equipment: input.constraints?.equipment ?? [
        "trainer",
        "power_meter",
        "resistance",
      ],
      indoorOnly: input.constraints?.indoorOnly ?? false,
      injuries: input.constraints?.injuries ?? [],
      overrideAvailability: override,
    },
    targetCtl: round1(targetCtl),
    targetFtp,
    assumptions,
    warnings,
  };
  return goal;
}
