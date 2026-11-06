/**
 * Shared shapes for the Zwift coach planner.
 *
 * These are deliberately plain interfaces (not Zod schemas) so the pure
 * analysis/goal/plan/render modules can be tested without a swamp runtime.
 *
 * @module
 */

/** One step in a workout. All durations are minutes; power is a fraction of FTP. */
export type Step =
  | {
    kind: "warmup";
    minutes: number;
    powerLow: number;
    powerHigh: number;
    cadence?: number;
    text?: string;
  }
  | {
    kind: "steady";
    minutes: number;
    power: number;
    cadence?: number;
    text?: string;
  }
  | {
    kind: "ramp";
    minutes: number;
    powerLow: number;
    powerHigh: number;
    cadence?: number;
    cadenceLow?: number;
    cadenceHigh?: number;
    text?: string;
  }
  | {
    kind: "intervals";
    repeat: number;
    onMinutes: number;
    offMinutes: number;
    onPower: number;
    offPower: number;
    cadence?: number;
    cadenceResting?: number;
    text?: string;
  }
  | {
    kind: "free";
    minutes: number;
    flatRoad?: boolean;
    text?: string;
    cadence?: number;
    /** FTP fraction used only for TSS/IF estimation; not rendered as Power. */
    targetPower?: number;
  }
  | {
    kind: "maxeffort";
    minutes: number;
    text?: string;
    cadence?: number;
    /** FTP fraction used only for TSS/IF estimation; not rendered as Power. */
    targetPower?: number;
  }
  | {
    kind: "cooldown";
    minutes: number;
    powerLow: number;
    powerHigh: number;
    cadence?: number;
    text?: string;
  };

/** Session types the built-in planner can generate. */
export type SessionType =
  | "recovery"
  | "endurance"
  | "sweetspot"
  | "threshold"
  | "vo2"
  | "overunder"
  | "sprint"
  | "anaerobic"
  | "ftp-test"
  | "event";

/** One planned workout. */
export interface Session {
  id: string;
  week: number;
  date: string;
  dayOfWeek: number;
  type: SessionType;
  title: string;
  hook: string;
  why: string;
  purpose: string;
  fun: boolean;
  zwiftSuggestion?: string;
  durationMinutes: number;
  targetTss: number;
  computedTss: number;
  targetIf: number;
  steps: Step[];
  progression?: string;
  /** Human-readable block summary with watts/cadence, for previews and ZWO. */
  brief?: string;
}

/** One plan week. */
export interface Week {
  index: number;
  startDate: string;
  phase: "re-entry" | "base" | "build" | "peak" | "recovery" | "taper";
  theme: string;
  narrative: string;
  targetCtl: number;
  weeklyTss: number;
  computedTss: number;
  sessions: Session[];
}

/** A generated plan. */
export interface Plan {
  id: string;
  generatedAt: string;
  goalId: string;
  startDate: string;
  endDate: string;
  weeks: Week[];
  summary: {
    weeks: number;
    totalHours: number;
    totalTss: number;
    startingCtl: number;
    targetCtl: number;
    targetFtp: number | null;
    daysPerWeek: number;
    hoursPerWeek: number;
    focus: string;
  };
}

/** Current/peak fitness facts used by the planner. */
export interface Fitness {
  generatedAt: string;
  current: {
    ctl: number;
    atl: number;
    tsb: number;
    weeklyTss: number;
    avg7dTss: number;
    avg28dTss: number;
    avg90dTss: number;
    ftpWatts: number | null;
    weightKg: number | null;
    wPerKg: number | null;
  };
  peaks: {
    ctl: number;
    ctlDate: string | null;
    sustainedCtl: number;
    sustainedCtlDate: string | null;
    ftpWatts: number | null;
    ftpDate: string | null;
    wPerKg: number | null;
  };
  years: {
    year: number;
    rides: number;
    hours: number;
    km: number;
    tss: number;
    peakCtl: number;
    maxFtp: number | null;
  }[];
  /** Rider best-power curve used for absolute sprint/anaerobic targets. */
  powerCurve: PowerCurve;
  availability: {
    source: "zwift" | "merged";
    daysPerWeek: { median: number; p80: number };
    hoursPerWeek: { median: number; p80: number };
    preferredDays: number[];
    preferredHours: number[];
    sessionMinutes: { p50: number; p90: number };
    recent8w: { daysPerWeek: number; hoursPerWeek: number };
    gapDays: number;
    lowHistory: boolean;
  };
  weight: {
    currentKg: number | null;
    trend7dKg: number | null;
    trend28dKg: number | null;
    bodyFatPercent: number | null;
    targetKg: number | null;
  };
  readiness: {
    hrv: number | null;
    hrvBaseline: number | null;
    restingHr: number | null;
    restingHrBaseline: number | null;
    sleepScore: number | null;
    trainingReadiness: number | null;
  };
  athlete: {
    age: number | null;
    ageSource: "garmin" | "user" | "unknown";
    fitnessAge: number | null;
    vo2max: number | null;
  };
  rideFlavor: {
    race: number;
    banded: number;
    group: number;
    workout: number;
    solo: number;
    confidence: number;
    funPreference: "race" | "banded" | "group" | "workout" | "solo";
  };
  flags: {
    detrained: boolean;
    staleFtp: boolean;
    lowHistory: boolean;
    estimated: boolean;
    overreaching: boolean;
    garminMissing: boolean;
    weightLossTooFast: boolean;
    weightStalled: boolean;
    readinessLow: boolean;
  };
  sources: Record<string, unknown>;
}

/** One goal target. */
export interface Target {
  metric:
    | "power5"
    | "power15"
    | "power60"
    | "power300"
    | "ftp"
    | "wkg"
    | "ctl"
    | "weight"
    | "event";
  target: number | string;
  unit: "W" | "W/kg" | "kg" | "TSS/day" | "date";
  comparison?: ">=" | "<=" | "=";
  byDate?: string;
}

/** One point on the rider's best-power curve. */
export interface PowerCurvePoint {
  seconds: number;
  watts: number;
  wPerKg?: number;
}

/** Rider power-duration profile from the data owner. */
export interface PowerCurve {
  source: "zwift-power-curve" | "fit-records" | "missing";
  fetchedAt: string;
  points: PowerCurvePoint[];
  best: {
    power5: number | null;
    power15: number | null;
    power60: number | null;
    power300: number | null;
    power1200: number | null;
  };
  cadence: {
    max: number | null;
    at5s: number | null;
    at60s: number | null;
    typical: number | null;
    source: "fit-records" | "detail" | "missing";
  };
}

/** Structured custom goal (Phase 4). */
export interface GoalSpec {
  id: string;
  description: string;
  horizonWeeks: number;
  startDate: string;
  targetDate?: string;
  primary: Target;
  secondary: Target[];
  constraints: {
    daysPerWeek?: number;
    hoursPerWeek?: number;
    availableDays?: number[];
    maxSessionMinutes?: number;
    equipment: string[];
    indoorOnly?: boolean;
    injuries?: string[];
    maxHardSessionsPerWeek?: number;
    recoveryEveryNWeeks?: number;
    availabilitySource?: "zwift" | "merged" | "user";
  };
  tests: { week: number; protocol: string }[];
  baseline?: {
    source: PowerCurve["source"];
    fetchedAt: string;
    power5: number | null;
    power15: number | null;
    power60: number | null;
    power300: number | null;
    power1200: number | null;
  };
  preferences?: {
    style?: "pyramidal" | "polarised" | "sprint";
    sprintFocus?: boolean;
    funPreference?: "race" | "banded" | "group" | "workout" | "solo" | "auto";
  };
  assumptions: string[];
  clarifyingQuestions: string[];
}

/** One phase in an agent-authored PlanSpec. */
export interface PlanSpecPhase {
  name: string;
  weeks: number;
  theme: string;
  narrative: string;
  focus: string;
  weeklyTssTarget?: number;
  keySessionTypes: string[];
}

/** One session in an agent-authored PlanSpec. */
export interface PlanSpecSession {
  id: string;
  week: number;
  dayOfWeek?: number;
  type: SessionType;
  title: string;
  hook: string;
  why: string;
  purpose: string;
  fun?: boolean;
  zwiftSuggestion?: string;
  durationMinutes: number;
  targetTss?: number;
  steps?: Step[];
  progression?: string;
}

/** Agent-authored plan specification. The extension validates this, never raw XML. */
export interface PlanSpec {
  goalId: string;
  rationale: string;
  phases: PlanSpecPhase[];
  sessions: PlanSpecSession[];
  progressionRules: string[];
  tests: { week: number; protocol: string }[];
}

/** Fail-closed validation result for a PlanSpec. */
export interface PlanValidation {
  goalId: string;
  errors: string[];
  warnings: string[];
  suggestions: string[];
  checkedAt: string;
}

/** Compiled goal. */
export interface Goal {
  id: string;
  mode: "regain" | "improve" | "event" | "custom";
  description: string;
  startDate: string;
  targetDate: string;
  weeks: number;
  primary: Target;
  secondary: Target[];
  constraints: {
    daysPerWeek: number;
    hoursPerWeek: number;
    availableDays: number[];
    maxSessionMinutes: number;
    style: "pyramidal" | "polarised" | "sprint";
    equipment: string[];
    indoorOnly: boolean;
    injuries: string[];
    overrideAvailability: boolean;
  };
  targetCtl: number;
  targetFtp: number | null;
  assumptions: string[];
  warnings: string[];
  /** Present for custom goals. */
  goalSpec?: GoalSpec;
  /** Empty when the goal is unambiguous. */
  clarifyingQuestions?: string[];
}

/** Weight/readiness input shapes from Garmin (permissive). */
export type LooseRecord = Record<string, unknown>;
