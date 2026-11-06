/**
 * Phase 5: weekly review and engagement adaptation.
 *
 * This module is pure and testable. It compares the planned sessions with the
 * rides that actually happened, adds the rider's feedback, detects boredom and
 * adherence problems, and makes conservative changes to future weeks only.
 * It never rewrites the past and never adds load to punish a missed session.
 *
 * @module
 */

import type {
  Fitness,
  Goal,
  LooseRecord,
  Plan,
  Session,
  SessionType,
} from "./zwift_coach_types.ts";
import { addDays, hashString, round1, todayUtc } from "./zwift_coach_util.ts";
import {
  averageIf,
  buildSession,
  totalMinutes,
  totalTss,
  workoutNameFor,
} from "./zwift_coach_workouts.ts";
import { describeSteps } from "./zwift_coach_custom.ts";

export interface SessionFeedback {
  date: string;
  sessionId?: string;
  enjoyment?: number;
  bored?: boolean;
  rpe?: number;
  cadenceMaxed?: boolean;
  recoveryTooAbrupt?: boolean;
  wouldRepeat?: boolean;
  notes?: string;
  recordedAt?: string;
}

export interface SessionOutcome {
  sessionId: string;
  date: string;
  week: number;
  type: SessionType;
  title: string;
  fun: boolean;
  plannedMinutes: number;
  plannedTss: number;
  actualMinutes: number | null;
  actualTss: number | null;
  status: "completed" | "partial" | "skipped";
  rideId: string | null;
  rideName: string | null;
  dateDelta: number;
}

export interface ReviewMetrics {
  asOf: string;
  weeksReviewed: number;
  planned: number;
  completed: number;
  partial: number;
  skipped: number;
  completionRate: number;
  adherenceRate: number;
  funPlanned: number;
  funCompleted: number;
  funCompletionRate: number;
  averageEnjoyment: number | null;
  boredCount: number;
  wouldRepeatRate: number | null;
  feedbackCount: number;
  byType: Record<
    string,
    {
      planned: number;
      completed: number;
      partial: number;
      skipped: number;
      rate: number;
    }
  >;
  uniqueTypes: number;
  sameFun3: boolean;
  weight: {
    currentKg: number | null;
    trend7dKg: number | null;
    trend28dKg: number | null;
    targetKg: number | null;
    weeklyRateKg: number | null;
    status:
      | "fast"
      | "gaining"
      | "stalled"
      | "on-track"
      | "at-target"
      | "no-target";
  };
  readiness: {
    low: boolean;
    trainingReadiness: number | null;
  };
  load: {
    plannedTss: number;
    actualTss: number;
    ctl: number;
    atl: number;
    tsb: number;
  };
}

export interface EngagementSignal {
  id: string;
  severity: "info" | "warning" | "high";
  message: string;
  type?: SessionType;
}

export interface PlanChange {
  kind: string;
  message: string;
  weeks?: number[];
  sessions?: string[];
}

export interface ReviewResult {
  asOf: string;
  reviewedAt: string;
  previousPlanId: string;
  planId: string;
  metrics: ReviewMetrics;
  signals: EngagementSignal[];
  changes: PlanChange[];
  summaryMarkdown: string;
  adaptedPlan: Plan;
  changed: boolean;
}

export interface ReviewInput {
  plan: Plan;
  fitness: Fitness;
  rides: LooseRecord[];
  feedback?: SessionFeedback[];
  feedbackSince?: string;
  goal?: Goal;
  asOf?: string;
  autoAdapt?: boolean;
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function mean(values: number[]): number | null {
  return values.length === 0
    ? null
    : values.reduce((a, b) => a + b, 0) / values.length;
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function daysAgo(asOf: string, days: number): string {
  return addDays(asOf, -days);
}

function rideMinutes(ride: LooseRecord): number | null {
  const moving = num(ride.movingSeconds);
  const duration = num(ride.durationSeconds);
  const seconds = moving ?? duration;
  return seconds === null ? null : Math.round(seconds / 60);
}

function findRide(
  rides: LooseRecord[],
  date: string,
): { ride: LooseRecord; delta: number } | null {
  // Match the local date exactly. A ±1-day fallback can attach yesterday's
  // ride to today's short session and turn a skip into a false completion.
  const matches = rides.filter((r) => str(r.localDate) === date);
  if (matches.length === 0) return null;
  const ride = matches.sort(
    (a, b) => (rideMinutes(b) ?? 0) - (rideMinutes(a) ?? 0),
  )[0];
  return { ride, delta: 0 };
}

function outcomeFor(session: Session, rides: LooseRecord[]): SessionOutcome {
  const found = findRide(rides, session.date);
  const actualMinutes = found ? rideMinutes(found.ride) : null;
  const actualTss = found ? num(found.ride.tss) : null;
  let status: SessionOutcome["status"] = "skipped";
  if (
    actualMinutes !== null && actualMinutes >= session.durationMinutes * 0.7
  ) {
    status = "completed";
  } else if (actualMinutes !== null && actualMinutes > 0) {
    status = "partial";
  }
  return {
    sessionId: session.id,
    date: session.date,
    week: session.week,
    type: session.type,
    title: session.title,
    fun: session.fun,
    plannedMinutes: session.durationMinutes,
    plannedTss: session.targetTss,
    actualMinutes,
    actualTss,
    status,
    rideId: found ? str(found.ride.id) || null : null,
    rideName: found ? str(found.ride.name) || null : null,
    dateDelta: found?.delta ?? 0,
  };
}

export function sessionOutcomes(
  plan: Plan,
  rides: LooseRecord[],
  asOf: string,
): SessionOutcome[] {
  return plan.weeks
    .flatMap((w) => w.sessions)
    .filter((s) => s.date < asOf)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((s) => outcomeFor(s, rides));
}

export function computeMetrics(
  plan: Plan,
  outcomes: SessionOutcome[],
  fitness: Fitness,
  feedback: SessionFeedback[],
  asOf: string,
  goal?: Goal,
): ReviewMetrics {
  const planned = outcomes.length;
  const completed = outcomes.filter((o) => o.status === "completed").length;
  const partial = outcomes.filter((o) => o.status === "partial").length;
  const skipped = outcomes.filter((o) => o.status === "skipped").length;
  const fun = outcomes.filter((o) => o.fun);
  const funCompleted = fun.filter((o) => o.status === "completed").length;
  const byType: ReviewMetrics["byType"] = {};
  for (const outcome of outcomes) {
    const row = byType[outcome.type] ?? {
      planned: 0,
      completed: 0,
      partial: 0,
      skipped: 0,
      rate: 0,
    };
    row.planned++;
    row[outcome.status]++;
    byType[outcome.type] = row;
  }
  for (const row of Object.values(byType)) {
    row.rate = row.planned === 0
      ? 0
      : (row.completed + row.partial * 0.5) / row.planned;
  }
  const recentFeedback = feedback.filter((f) =>
    f.date >= daysAgo(asOf, 28) && f.date <= asOf
  );
  const ratings = recentFeedback
    .map((f) => f.enjoyment)
    .filter((n): n is number => typeof n === "number");
  const repeats = recentFeedback
    .map((f) => f.wouldRepeat)
    .filter((n): n is boolean => typeof n === "boolean");
  const funSessions = plan.weeks
    .flatMap((w) => w.sessions)
    .filter((s) => s.fun && s.date < asOf)
    .sort((a, b) => a.date.localeCompare(b.date));
  const lastFuns = funSessions.slice(-3);
  const sameFun3 = lastFuns.length === 3 &&
    new Set(lastFuns.map((s) => `${s.type}|${s.zwiftSuggestion ?? ""}`))
        .size === 1;
  const weight = fitness.weight;
  const weeklyRate = weight.trend7dKg;
  const goalWeight = goal?.secondary.find((t) => t.metric === "weight");
  const targetKg = typeof goalWeight?.target === "number"
    ? goalWeight.target
    : weight.targetKg;
  let weightStatus: ReviewMetrics["weight"]["status"] = "no-target";
  if (targetKg !== null && weight.currentKg !== null) {
    if (weight.currentKg <= targetKg + 0.5) {
      weightStatus = "at-target";
    } else if (weeklyRate !== null && weeklyRate < -0.5) {
      weightStatus = "fast";
    } else if (weeklyRate !== null && weeklyRate > 0.1) {
      weightStatus = "gaining";
    } else if (weeklyRate !== null && weeklyRate > -0.05) {
      weightStatus = "stalled";
    } else {
      weightStatus = "on-track";
    }
  }
  const weeksReviewed = new Set(outcomes.map((o) => o.week)).size;
  return {
    asOf,
    weeksReviewed,
    planned,
    completed,
    partial,
    skipped,
    completionRate: planned === 0 ? 0 : completed / planned,
    adherenceRate: planned === 0 ? 0 : (completed + partial * 0.5) / planned,
    funPlanned: fun.length,
    funCompleted,
    funCompletionRate: fun.length === 0 ? 0 : funCompleted / fun.length,
    averageEnjoyment: mean(ratings),
    boredCount: recentFeedback.filter((f) => f.bored === true).length,
    wouldRepeatRate: repeats.length === 0
      ? null
      : repeats.filter(Boolean).length / repeats.length,
    feedbackCount: recentFeedback.length,
    byType,
    uniqueTypes: Object.keys(byType).length,
    sameFun3,
    weight: {
      currentKg: weight.currentKg,
      trend7dKg: weight.trend7dKg,
      trend28dKg: weight.trend28dKg,
      targetKg,
      weeklyRateKg: weeklyRate,
      status: weightStatus,
    },
    readiness: {
      low: fitness.flags.readinessLow ||
        (fitness.readiness.trainingReadiness !== null &&
          fitness.readiness.trainingReadiness < 40),
      trainingReadiness: fitness.readiness.trainingReadiness,
    },
    load: {
      plannedTss: round1(outcomes.reduce((sum, o) => sum + o.plannedTss, 0)),
      actualTss: round1(
        outcomes.reduce((sum, o) => sum + (o.actualTss ?? 0), 0),
      ),
      ctl: fitness.current.ctl,
      atl: fitness.current.atl,
      tsb: fitness.current.tsb,
    },
  };
}

export function detectSignals(
  outcomes: SessionOutcome[],
  metrics: ReviewMetrics,
  feedback: SessionFeedback[],
): EngagementSignal[] {
  const signals: EngagementSignal[] = [];
  const asOf = metrics.asOf;
  const recent = feedback.filter((f) =>
    f.date >= daysAgo(asOf, 14) && f.date <= asOf
  );
  const recent21 = feedback.filter((f) =>
    f.date >= daysAgo(asOf, 21) && f.date <= asOf
  );
  if (recent.some((f) => f.bored === true)) {
    signals.push({
      id: "explicit-bored",
      severity: "warning",
      message:
        "The rider explicitly reported being bored in the last two weeks.",
    });
  }
  if (recent21.filter((f) => (f.enjoyment ?? 5) <= 2).length >= 2) {
    signals.push({
      id: "low-enjoyment",
      severity: "warning",
      message:
        "Two or more sessions were rated 2/5 or lower in the last three weeks.",
    });
  }
  const fun = outcomes.filter((o) => o.fun).sort((a, b) =>
    a.date.localeCompare(b.date)
  );
  if (
    fun.length >= 2 &&
    fun.slice(-2).every((o) => o.status === "skipped")
  ) {
    signals.push({
      id: "fun-skipped",
      severity: "high",
      message: "The last two fun sessions were skipped or replaced.",
    });
  }
  for (const [type, row] of Object.entries(metrics.byType)) {
    if (
      row.planned >= 2 && row.rate < 0.5 && metrics.adherenceRate >= 0.6
    ) {
      signals.push({
        id: "type-skipped",
        type: type as SessionType,
        severity: "warning",
        message: `${type} sessions are being skipped (${
          pct(row.rate)
        } completion) while overall adherence is ${
          pct(metrics.adherenceRate)
        }.`,
      });
    }
  }
  if (metrics.adherenceRate < 0.6 && metrics.planned > 0) {
    signals.push({
      id: "adherence-low",
      severity: "high",
      message: `Overall adherence is ${
        pct(metrics.adherenceRate)
      }; the plan is asking for more than the rider is doing.`,
    });
  }
  if (metrics.sameFun3) {
    signals.push({
      id: "same-fun-3w",
      severity: "warning",
      message:
        "The last three fun sessions were the same type; rotate the format.",
    });
  }
  if (recent.some((f) => f.cadenceMaxed === true)) {
    signals.push({
      id: "cadence-maxed",
      severity: "warning",
      message:
        "The rider maxed out cadence during a sprint; lower the cadence target or switch to torque.",
    });
  }
  if (recent.some((f) => f.recoveryTooAbrupt === true)) {
    signals.push({
      id: "recovery-abrupt",
      severity: "warning",
      message: "The rider had to coast in recovery; extend the ramp-down.",
    });
  }
  if (metrics.weight.status === "fast") {
    signals.push({
      id: "weight-fast",
      severity: "high",
      message:
        "Weight is dropping faster than 0.5 kg/week; do not add training load.",
    });
  }
  if (metrics.weight.status === "gaining") {
    signals.push({
      id: "weight-gaining",
      severity: "warning",
      message:
        "Weight is trending up; keep the Z2 habit but review fueling. Do not add training load to compensate.",
    });
  } else if (metrics.weight.status === "stalled" && !metrics.readiness.low) {
    signals.push({
      id: "weight-stalled",
      severity: "info",
      message:
        "Weight is stalled while readiness is okay; add easy Z2 duration, not intensity.",
    });
  }
  if (metrics.readiness.low) {
    signals.push({
      id: "readiness-low",
      severity: "high",
      message:
        "Readiness is low; downgrade the next hard session and protect recovery.",
    });
  }
  if (metrics.feedbackCount === 0 && metrics.planned > 0) {
    signals.push({
      id: "no-feedback",
      severity: "info",
      message:
        "No enjoyment/cadence feedback yet; this review uses completion only.",
    });
  }
  return signals;
}

const TYPE_SWAP: Record<string, SessionType | undefined> = {
  sweetspot: "overunder",
  threshold: "sweetspot",
  vo2: "overunder",
  overunder: "sweetspot",
};

function nextFunSuggestion(
  fitness: Fitness,
  current: string | undefined,
): string {
  const text = (current ?? "").toLowerCase();
  if (/race|tt/.test(text)) {
    return "Pick a banded group ride or a route badge this week instead of another race.";
  }
  if (/banded|group|fondo/.test(text)) {
    return "Pick a short race, TT or KOM hunt this week instead of another group ride.";
  }
  if (/route|badge|kom|sprint/.test(text)) {
    return "Pick a race or banded event this week instead of another route badge.";
  }
  switch (fitness.rideFlavor.funPreference) {
    case "race":
      return "Pick a different Zwift race or TT this week.";
    case "banded":
      return "Pick a banded group ride at your usual hour.";
    case "group":
      return "Pick a group ride or fondo that fits the session length.";
    case "workout":
      return "Use a Zwift workout or chase a different route badge.";
    default:
      return "Pick a KOM or sprint hunt you have not done recently.";
  }
}

function rebuildAerobic(
  session: Session,
  type: SessionType,
  durationMinutes: number,
  targetTss: number,
  ftp: number | null,
): Session {
  const built = buildSession({
    id: session.id,
    week: session.week,
    date: session.date,
    dayOfWeek: session.dayOfWeek,
    type,
    title: session.title,
    hook: session.hook,
    why: session.why,
    purpose: session.purpose,
    targetTss,
    durationMinutes,
    maxMinutes: durationMinutes,
    fun: session.fun,
    zwiftSuggestion: session.zwiftSuggestion,
    progression: session.progression,
  });
  if (built.targetTss <= 0) built.targetTss = built.computedTss;
  built.brief = describeSteps(built.steps, ftp);
  built.workoutName = workoutNameFor(built, ftp);
  return built;
}

function recomputeSession(session: Session, ftp: number | null): void {
  session.durationMinutes = Math.round(totalMinutes(session.steps));
  session.computedTss = totalTss(session.steps);
  session.targetIf = averageIf(session.steps);
  session.brief = describeSteps(session.steps, ftp);
  session.workoutName = workoutNameFor(session, ftp);
}

function recomputePlan(plan: Plan): void {
  for (const week of plan.weeks) {
    week.weeklyTss = round1(
      week.sessions.reduce((sum, s) => sum + s.targetTss, 0),
    );
    week.computedTss = round1(
      week.sessions.reduce((sum, s) => sum + s.computedTss, 0),
    );
    week.targetCtl = round1(week.weeklyTss / 7);
  }
  const weeks = plan.weeks.length || 1;
  plan.summary.totalHours = round1(
    plan.weeks.reduce(
      (sum, w) =>
        sum + w.sessions.reduce((h, s) => h + s.durationMinutes, 0) / 60,
      0,
    ),
  );
  plan.summary.totalTss = round1(
    plan.weeks.reduce((sum, w) => sum + w.computedTss, 0),
  );
  plan.summary.hoursPerWeek = round1(plan.summary.totalHours / weeks);
  plan.summary.daysPerWeek = Math.round(
    plan.weeks.reduce((sum, w) => sum + w.sessions.length, 0) / weeks,
  );
  plan.summary.targetCtl = round1(
    plan.weeks.reduce((sum, w) => sum + w.targetCtl, 0) / weeks,
  );
  plan.generatedAt = new Date().toISOString();
}

export function adaptPlan(
  plan: Plan,
  fitness: Fitness,
  metrics: ReviewMetrics,
  signals: EngagementSignal[],
  asOf: string,
): { plan: Plan; changes: PlanChange[] } {
  const adapted: Plan = JSON.parse(JSON.stringify(plan));
  const changes: PlanChange[] = [];
  const future = adapted.weeks
    .flatMap((w) => w.sessions)
    .filter((s) => s.date >= asOf)
    .sort((a, b) => a.date.localeCompare(b.date));
  const ftp = fitness.current.ftpWatts ?? fitness.peaks.ftpWatts ?? null;
  const signalIds = new Set(signals.map((s) => s.id));
  const alreadyApplied = new Set(adapted.reviewApplied ?? []);
  const applied = new Set(adapted.reviewApplied ?? []);
  const funSignal = signalIds.has("fun-skipped") ||
    signalIds.has("explicit-bored") || signalIds.has("low-enjoyment") ||
    signalIds.has("same-fun-3w");

  if (funSignal) {
    const fun = future.filter((s) => s.fun);
    for (const session of fun) {
      session.zwiftSuggestion = nextFunSuggestion(
        fitness,
        session.zwiftSuggestion,
      );
    }
    if (fun.length > 0) {
      changes.push({
        kind: "rotate-fun",
        message: "Changed the fun-session format to a different ride type.",
        weeks: [...new Set(fun.map((s) => s.week))],
        sessions: fun.map((s) => s.id),
      });
    }
  }

  for (const signal of signals.filter((s) => s.id === "type-skipped")) {
    const type = signal.type;
    if (!type) continue;
    const alt = TYPE_SWAP[type];
    if (!alt) continue;
    const targets = future.filter((s) => s.type === type && !s.fun);
    for (const session of targets) {
      const rebuilt = rebuildAerobic(
        session,
        alt,
        session.durationMinutes,
        session.targetTss,
        ftp,
      );
      Object.assign(session, rebuilt);
    }
    if (targets.length > 0) {
      changes.push({
        kind: "swap-boring-type",
        message:
          `Replaced future ${type} sessions with ${alt} to keep the same intent but change the format.`,
        weeks: [...new Set(targets.map((s) => s.week))],
        sessions: targets.map((s) => s.id),
      });
    }
  }

  if (signalIds.has("adherence-low") && !alreadyApplied.has("reduce-volume")) {
    const targets = future.filter((s) =>
      !s.fun && (s.type === "endurance" || s.type === "recovery")
    );
    for (const session of targets) {
      const duration = Math.max(20, Math.round(session.durationMinutes * 0.85));
      const tss = round1(session.targetTss * 0.85);
      Object.assign(
        session,
        rebuildAerobic(session, session.type, duration, tss, ftp),
      );
    }
    if (targets.length > 0) {
      changes.push({
        kind: "reduce-volume",
        message:
          "Shortened future Z2/recovery sessions by 15% because overall adherence was low.",
        weeks: [...new Set(targets.map((s) => s.week))],
        sessions: targets.map((s) => s.id),
      });
      applied.add("reduce-volume");
    }
  }

  if (signalIds.has("readiness-low")) {
    const hard = new Set<SessionType>([
      "sweetspot",
      "sprint",
      "anaerobic",
      "vo2",
      "threshold",
      "overunder",
    ]);
    const cutoff = addDays(asOf, 7);
    const target = future.find((s) => s.date <= cutoff && hard.has(s.type));
    if (target) {
      const duration = Math.max(20, Math.round(target.durationMinutes * 0.7));
      const tss = Math.round(target.targetTss * 0.6);
      Object.assign(
        target,
        rebuildAerobic(target, "recovery", duration, tss, ftp),
      );
      changes.push({
        kind: "protect-readiness",
        message:
          "Replaced the next hard session with recovery because readiness is low.",
        weeks: [target.week],
        sessions: [target.id],
      });
    }
  }

  if (metrics.weight.status === "fast" && !alreadyApplied.has("weight-fast")) {
    const targets = future.filter((s) => !s.fun && s.type === "endurance");
    for (const session of targets) {
      const duration = Math.max(20, Math.round(session.durationMinutes * 0.9));
      const tss = round1(session.targetTss * 0.9);
      Object.assign(
        session,
        rebuildAerobic(session, session.type, duration, tss, ftp),
      );
    }
    if (targets.length > 0) {
      changes.push({
        kind: "weight-fast",
        message:
          "Shortened future Z2 sessions by 10% because weight is dropping faster than 0.5 kg/week.",
        weeks: [...new Set(targets.map((s) => s.week))],
        sessions: targets.map((s) => s.id),
      });
      applied.add("weight-fast");
    }
  } else if (
    metrics.weight.status === "stalled" && !metrics.readiness.low &&
    !alreadyApplied.has("weight-stalled")
  ) {
    for (const week of adapted.weeks) {
      const long = week.sessions
        .filter((s) => s.type === "endurance")
        .sort((a, b) => b.durationMinutes - a.durationMinutes)[0];
      if (!long) continue;
      const duration = Math.min(180, long.durationMinutes + 10);
      const tss = round1(long.targetTss * (duration / long.durationMinutes));
      Object.assign(
        long,
        rebuildAerobic(long, long.type, duration, tss, ftp),
      );
    }
    changes.push({
      kind: "weight-stalled",
      message:
        "Added 10 minutes to the longest Z2 session each week; no intensity added.",
    });
    applied.add("weight-stalled");
  }

  if (signalIds.has("cadence-maxed")) {
    const targets = future.filter((s) =>
      s.type === "sprint" || s.type === "anaerobic"
    );
    for (const session of targets) {
      for (const step of session.steps) {
        if (
          (step.kind === "maxeffort" || step.kind === "free") &&
          step.cadence
        ) {
          step.cadence = Math.max(80, step.cadence - 5);
        }
      }
      recomputeSession(session, ftp);
    }
    if (targets.length > 0) {
      changes.push({
        kind: "cadence-adjust",
        message:
          "Lowered future sprint cadence targets by 5 rpm because the rider maxed out.",
        weeks: [...new Set(targets.map((s) => s.week))],
        sessions: targets.map((s) => s.id),
      });
    }
  }

  if (signalIds.has("recovery-abrupt")) {
    const targets = future.filter((s) =>
      s.type === "sprint" || s.type === "anaerobic"
    );
    for (const session of targets) {
      let afterWork = false;
      for (const step of session.steps) {
        if (step.kind === "maxeffort" || step.kind === "free") {
          afterWork = true;
        } else if (step.kind === "ramp" && afterWork) {
          continue;
        } else if (
          afterWork && step.kind === "steady" && step.power <= 0.5
        ) {
          step.minutes += 0.5;
          afterWork = false;
        }
      }
      recomputeSession(session, ftp);
    }
    if (targets.length > 0) {
      changes.push({
        kind: "recovery-extend",
        message:
          "Added 30 s to future sprint recovery blocks because the rider had to coast.",
        weeks: [...new Set(targets.map((s) => s.week))],
        sessions: targets.map((s) => s.id),
      });
    }
  }

  if (changes.length > 0) {
    recomputePlan(adapted);
    adapted.reviewApplied = [...applied];
    adapted.adaptedFrom = plan.id;
    adapted.id = hashString(
      [plan.id, asOf, changes.map((c) => c.kind).join(",")].join("|"),
    );
  }
  return { plan: adapted, changes };
}

function nextWeekSessions(plan: Plan, asOf: string): Session[] {
  const nextMonday = plan.weeks
    .map((w) => w)
    .find((w) => w.startDate >= asOf);
  return nextMonday?.sessions ?? [];
}

export function buildReviewMarkdown(
  plan: Plan,
  metrics: ReviewMetrics,
  signals: EngagementSignal[],
  changes: PlanChange[],
  asOf: string,
): string {
  const lines: string[] = [
    `# Weekly review — ${asOf}`,
    "",
    `Completed ${metrics.completed}/${metrics.planned} sessions (${
      pct(metrics.completionRate)
    }; ${pct(metrics.adherenceRate)} including partial).`,
    `Fun session: ${metrics.funCompleted}/${metrics.funPlanned} completed.`,
    `Enjoyment: ${
      metrics.averageEnjoyment === null
        ? "no rating yet"
        : `${
          round1(metrics.averageEnjoyment)
        }/5 from ${metrics.feedbackCount} rating(s)`
    }; ${metrics.boredCount} boredom flag(s).`,
    "",
    `Load: ${metrics.load.plannedTss} planned / ${metrics.load.actualTss} actual TSS over ${metrics.weeksReviewed} week(s). TSS is a load score; 100 is about one hour at FTP.`,
    `Weight: ${
      metrics.weight.currentKg === null
        ? "no weight data"
        : `${metrics.weight.currentKg} kg, 7-day trend ${
          metrics.weight.trend7dKg ?? "?"
        } kg, target ${
          metrics.weight.targetKg ?? "?"
        } kg, status ${metrics.weight.status}`
    }.`,
    `Readiness: ${metrics.readiness.low ? "low — protect recovery" : "okay"}${
      metrics.readiness.trainingReadiness === null
        ? ""
        : ` (${metrics.readiness.trainingReadiness}/100)`
    }.`,
    "",
  ];
  if (signals.length > 0) {
    lines.push("## What I noticed", "");
    for (const signal of signals) {
      lines.push(`- **${signal.severity}** ${signal.message}`);
    }
    lines.push("");
  }
  lines.push("## What changed", "");
  if (changes.length === 0) {
    lines.push("- No changes; the plan still fits the evidence.");
  } else {
    for (const change of changes) {
      lines.push(`- ${change.message}`);
    }
  }
  lines.push("", "## Next week", "");
  const next = nextWeekSessions(plan, asOf);
  if (next.length === 0) {
    lines.push("- No future sessions in this plan.");
  } else {
    for (const session of next) {
      lines.push(
        `- ${session.date} **${session.title}** (${session.durationMinutes} min): ${
          session.brief ?? session.why
        }`,
      );
    }
  }
  lines.push(
    "",
    "_TSS = training stress score (load); CTL = rolling fitness; ATL = fatigue; TSB = freshness; IF = intensity relative to FTP._",
  );
  return lines.join("\n");
}

export function reviewPlan(input: ReviewInput): ReviewResult {
  const asOf = input.asOf ?? todayUtc();
  const reviewedAt = new Date().toISOString();
  const allFeedback = input.feedback ?? [];
  const activeFeedback = input.feedbackSince
    ? allFeedback.filter((f) =>
      (f.recordedAt ?? f.date) > (input.feedbackSince as string)
    )
    : allFeedback;
  const outcomes = sessionOutcomes(input.plan, input.rides, asOf);
  const metrics = computeMetrics(
    input.plan,
    outcomes,
    input.fitness,
    allFeedback,
    asOf,
    input.goal,
  );
  const signals = detectSignals(
    outcomes,
    metrics,
    activeFeedback,
  );
  const { plan: adapted, changes } = adaptPlan(
    input.plan,
    input.fitness,
    metrics,
    signals,
    asOf,
  );
  const summaryMarkdown = buildReviewMarkdown(
    adapted,
    metrics,
    signals,
    changes,
    asOf,
  );
  return {
    asOf,
    reviewedAt,
    previousPlanId: input.plan.id,
    planId: adapted.id,
    metrics,
    signals,
    changes,
    summaryMarkdown,
    adaptedPlan: adapted,
    changed: changes.length > 0,
  };
}
