/**
 * Workout templates, TSS maths and the conservative ZWO renderer.
 *
 * Durations are minutes internally; the renderer converts to the seconds
 * Zwift's `.zwo` format expects, and powers stay decimal fractions of FTP.
 *
 * @module
 */

import type { Session, Step } from "./zwift_coach_types.ts";
import { clamp, round1 } from "./zwift_coach_util.ts";

/** Approximate TSS of one step, using the same IF² model as the PMC. */
export function stepTss(step: Step): number {
  switch (step.kind) {
    case "warmup":
    case "cooldown": {
      const avg = (step.powerLow + step.powerHigh) / 2;
      return (step.minutes / 60) * avg * avg * 100;
    }
    case "ramp": {
      const avg = (step.powerLow + step.powerHigh) / 2;
      return (step.minutes / 60) * avg * avg * 100;
    }
    case "steady":
      return (step.minutes / 60) * step.power * step.power * 100;
    case "intervals": {
      const on = (step.onMinutes / 60) * step.onPower * step.onPower * 100;
      const off = (step.offMinutes / 60) * step.offPower * step.offPower * 100;
      return step.repeat * (on + off);
    }
    case "free":
      return (step.minutes / 60) * 0.7 * 0.7 * 100;
    case "maxeffort":
      return (step.minutes / 60) * 1.2 * 1.2 * 100;
  }
}

/** Total TSS of a step list, one decimal place. */
export function totalTss(steps: Step[]): number {
  return round1(steps.reduce((sum, step) => sum + stepTss(step), 0));
}

/** Total duration in minutes. */
export function totalMinutes(steps: Step[]): number {
  return steps.reduce((sum, step) => {
    if (step.kind === "intervals") {
      return sum + step.repeat * (step.onMinutes + step.offMinutes);
    }
    return sum + step.minutes;
  }, 0);
}

/** Average intended intensity factor for a step list. */
export function averageIf(steps: Step[]): number {
  const minutes = totalMinutes(steps);
  if (minutes <= 0) return 0;
  const weighted = steps.reduce((sum, step) => {
    const duration = step.kind === "intervals"
      ? step.repeat * (step.onMinutes + step.offMinutes)
      : step.minutes;
    const avg = (() => {
      switch (step.kind) {
        case "warmup":
        case "cooldown":
        case "ramp":
          return (step.powerLow + step.powerHigh) / 2;
        case "steady":
          return step.power;
        case "intervals":
          return (step.onPower * step.onMinutes +
            step.offPower * step.offMinutes) /
            Math.max(0.01, step.onMinutes + step.offMinutes);
        case "free":
          return 0.7;
        case "maxeffort":
          return 1.2;
      }
    })();
    return sum + avg * duration;
  }, 0);
  return round1(weighted / minutes * 100) / 100;
}

/** Build the default steps for a session type. */
export function templateFor(
  type: Session["type"],
  durationMinutes: number,
): Step[] {
  switch (type) {
    case "recovery":
      return [
        { kind: "warmup", minutes: 10, powerLow: 0.45, powerHigh: 0.6 },
        {
          kind: "steady",
          minutes: Math.max(20, durationMinutes - 15),
          power: 0.55,
        },
        { kind: "cooldown", minutes: 5, powerLow: 0.6, powerHigh: 0.4 },
      ];
    case "endurance":
      return [
        { kind: "warmup", minutes: 10, powerLow: 0.5, powerHigh: 0.7 },
        {
          kind: "steady",
          minutes: Math.max(30, durationMinutes - 20),
          power: 0.68,
        },
        { kind: "cooldown", minutes: 10, powerLow: 0.65, powerHigh: 0.4 },
      ];
    case "sweetspot":
      return [
        { kind: "warmup", minutes: 15, powerLow: 0.5, powerHigh: 0.7 },
        {
          kind: "intervals",
          repeat: 3,
          onMinutes: 12,
          offMinutes: 5,
          onPower: 0.9,
          offPower: 0.55,
          cadence: 90,
          cadenceResting: 85,
          text: "3 x 12 min sweet spot",
        },
        { kind: "cooldown", minutes: 10, powerLow: 0.65, powerHigh: 0.4 },
      ];
    case "threshold":
      return [
        { kind: "warmup", minutes: 15, powerLow: 0.5, powerHigh: 0.7 },
        {
          kind: "intervals",
          repeat: 2,
          onMinutes: 20,
          offMinutes: 5,
          onPower: 0.98,
          offPower: 0.55,
          cadence: 90,
          text: "2 x 20 min threshold",
        },
        { kind: "cooldown", minutes: 10, powerLow: 0.65, powerHigh: 0.4 },
      ];
    case "vo2":
      return [
        { kind: "warmup", minutes: 15, powerLow: 0.5, powerHigh: 0.75 },
        {
          kind: "intervals",
          repeat: 5,
          onMinutes: 3,
          offMinutes: 3,
          onPower: 1.12,
          offPower: 0.5,
          cadence: 100,
          cadenceResting: 85,
          text: "5 x 3 min VO2",
        },
        { kind: "cooldown", minutes: 10, powerLow: 0.65, powerHigh: 0.4 },
      ];
    case "overunder":
      return [
        { kind: "warmup", minutes: 15, powerLow: 0.5, powerHigh: 0.7 },
        {
          kind: "intervals",
          repeat: 6,
          onMinutes: 1.5,
          offMinutes: 1.5,
          onPower: 0.95,
          offPower: 1.05,
          cadence: 90,
          text: "Over/under: 95% / 105%",
        },
        { kind: "steady", minutes: 5, power: 0.55 },
        { kind: "cooldown", minutes: 10, powerLow: 0.65, powerHigh: 0.4 },
      ];
    case "sprint":
      return [
        { kind: "warmup", minutes: 15, powerLow: 0.5, powerHigh: 0.75 },
        {
          kind: "intervals",
          repeat: 6,
          onMinutes: 0.25,
          offMinutes: 4,
          onPower: 1.7,
          offPower: 0.5,
          cadence: 110,
          cadenceResting: 80,
          text: "6 x 15 s all-out; full recovery",
        },
        { kind: "cooldown", minutes: 10, powerLow: 0.65, powerHigh: 0.4 },
      ];
    case "anaerobic":
      return [
        { kind: "warmup", minutes: 15, powerLow: 0.5, powerHigh: 0.75 },
        {
          kind: "intervals",
          repeat: 4,
          onMinutes: 1.5,
          offMinutes: 4,
          onPower: 1.1,
          offPower: 0.5,
          cadence: 95,
          cadenceResting: 80,
          text: "4 x 90 s anaerobic capacity",
        },
        { kind: "cooldown", minutes: 10, powerLow: 0.65, powerHigh: 0.4 },
      ];
    case "ftp-test":
      return [
        { kind: "warmup", minutes: 15, powerLow: 0.5, powerHigh: 0.7 },
        { kind: "steady", minutes: 5, power: 1.0, text: "Open up" },
        { kind: "steady", minutes: 5, power: 0.5, text: "Easy" },
        { kind: "maxeffort", minutes: 20, text: "20 min all-out FTP test" },
        { kind: "cooldown", minutes: 10, powerLow: 0.6, powerHigh: 0.35 },
      ];
    case "event":
      return [
        { kind: "warmup", minutes: 15, powerLow: 0.5, powerHigh: 0.7 },
        { kind: "free", minutes: durationMinutes, flatRoad: true },
        { kind: "cooldown", minutes: 10, powerLow: 0.6, powerHigh: 0.4 },
      ];
  }
}

/**
 * Scale the main work step so the session lands near `targetTss`.
 * Warmup/cooldown/recovery blocks are left alone.
 */
export function fitToTss(
  steps: Step[],
  targetTss: number,
  maxMinutes?: number,
): Step[] {
  if (targetTss <= 0 || steps.length === 0) return steps;
  const mainIndex = steps.findIndex((s) =>
    s.kind === "intervals" || s.kind === "steady" || s.kind === "maxeffort"
  );
  if (mainIndex < 0) return steps;
  const fixed = totalTss(
    steps.filter((_, i) => i !== mainIndex),
  );
  const currentMain = stepTss(steps[mainIndex]);
  if (currentMain <= 0) return steps;
  const desired = Math.max(5, targetTss - fixed);
  let ratio = clamp(desired / currentMain, 0.45, 2.2);
  if (maxMinutes !== undefined && maxMinutes > 0) {
    const fixedMinutes = totalMinutes(steps.filter((_, i) => i !== mainIndex));
    const mainMinutes = totalMinutes([steps[mainIndex]]);
    const maxRatio = (maxMinutes - fixedMinutes) / Math.max(1, mainMinutes);
    ratio = Math.min(ratio, Math.max(0.35, maxRatio));
  }
  const main = steps[mainIndex];
  let scaled: Step;
  if (main.kind === "intervals") {
    scaled = {
      ...main,
      onMinutes: Math.max(0.25, main.onMinutes * ratio),
      offMinutes: Math.max(0.25, main.offMinutes * ratio),
    };
  } else if (main.kind === "steady") {
    scaled = { ...main, minutes: Math.max(2, main.minutes * ratio) };
  } else if (main.kind === "maxeffort") {
    scaled = { ...main, minutes: Math.max(1, main.minutes * ratio) };
  } else {
    scaled = main;
  }
  return steps.map((s, i) => i === mainIndex ? scaled : s);
}

/** Build a complete session, including engagement text. */
export function buildSession(opts: {
  id: string;
  week: number;
  date: string;
  dayOfWeek: number;
  type: Session["type"];
  title: string;
  hook: string;
  why: string;
  purpose: string;
  targetTss: number;
  durationMinutes: number;
  fun?: boolean;
  zwiftSuggestion?: string;
  progression?: string;
  maxMinutes?: number;
}): Session {
  const steps = fitToTss(
    templateFor(opts.type, opts.durationMinutes),
    opts.targetTss,
    opts.maxMinutes ?? opts.durationMinutes,
  );
  return {
    id: opts.id,
    week: opts.week,
    date: opts.date,
    dayOfWeek: opts.dayOfWeek,
    type: opts.type,
    title: opts.title,
    hook: opts.hook,
    why: opts.why,
    purpose: opts.purpose,
    fun: opts.fun ?? false,
    zwiftSuggestion: opts.zwiftSuggestion,
    durationMinutes: Math.round(totalMinutes(steps)),
    targetTss: opts.targetTss,
    computedTss: totalTss(steps),
    targetIf: averageIf(steps),
    steps,
    progression: opts.progression,
  };
}

/** XML-escape text content and attribute values. */
export function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/** ASCII-safe workout name/slug. */
export function slug(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .toLowerCase() || "workout";
}

/** File name for a session. */
export function fileNameFor(session: Session): string {
  return `${session.date}_${slug(session.title)}.zwo`;
}

function seconds(minutes: number): number {
  return Math.max(1, Math.round(minutes * 60));
}

function power(value: number): string {
  return (Math.round(value * 1000) / 1000).toFixed(3);
}

function stepXml(step: Step): string {
  const text = step.kind !== "free" && step.kind !== "maxeffort" && step.text
    ? `<textevent message="${xmlEscape(step.text)}" duration="10"/>`
    : "";
  switch (step.kind) {
    case "warmup":
      return `<Warmup Duration="${seconds(step.minutes)}" PowerLow="${
        power(step.powerLow)
      }" PowerHigh="${power(step.powerHigh)}"${
        step.cadence ? ` Cadence="${step.cadence}"` : ""
      }>${text}</Warmup>`;
    case "cooldown":
      return `<Cooldown Duration="${seconds(step.minutes)}" PowerLow="${
        power(step.powerLow)
      }" PowerHigh="${power(step.powerHigh)}"${
        step.cadence ? ` Cadence="${step.cadence}"` : ""
      }>${text}</Cooldown>`;
    case "ramp":
      return `<Ramp Duration="${seconds(step.minutes)}" PowerLow="${
        power(step.powerLow)
      }" PowerHigh="${power(step.powerHigh)}"${
        step.cadence ? ` Cadence="${step.cadence}"` : ""
      }>${text}</Ramp>`;
    case "steady":
      return `<SteadyState Duration="${seconds(step.minutes)}" Power="${
        power(step.power)
      }"${
        step.cadence ? ` Cadence="${step.cadence}"` : ""
      }>${text}</SteadyState>`;
    case "intervals":
      return `<IntervalsT Repeat="${step.repeat}" OnDuration="${
        seconds(step.onMinutes)
      }" OffDuration="${seconds(step.offMinutes)}" OnPower="${
        power(step.onPower)
      }" OffPower="${power(step.offPower)}"${
        step.cadence ? ` Cadence="${step.cadence}"` : ""
      }${
        step.cadenceResting ? ` CadenceResting="${step.cadenceResting}"` : ""
      }>${text}</IntervalsT>`;
    case "free":
      return `<FreeRide Duration="${seconds(step.minutes)}" FlatRoad="1">${
        step.text
          ? `<textevent message="${xmlEscape(step.text)}" duration="10"/>`
          : ""
      }</FreeRide>`;
    case "maxeffort":
      return `<FreeRide Duration="${seconds(step.minutes)}" FlatRoad="1">${
        step.text
          ? `<textevent message="${xmlEscape(step.text)}" duration="10"/>`
          : ""
      }</FreeRide>`;
  }
}

/** Render one session as a conservative `.zwo` document. */
export function renderZwo(session: Session, planId = "unknown"): string {
  const body = session.steps.map(stepXml).join("\n    ");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- generated by @svendowideit/zwift-coach plan=${xmlEscape(planId)} session=${
    xmlEscape(session.id)
  } -->
<workout_file>
  <author>swamp zwift-coach</author>
  <name>${xmlEscape(session.title)}</name>
  <description>${
    xmlEscape(session.why)
  } Target ${session.targetTss} TSS.</description>
  <sportType>bike</sportType>
  <category>zwift-coach</category>
  <subcategory>Week ${session.week}</subcategory>
  <tags>
    <tag name="${session.type}"/>
    <tag name="zwift-coach"/>
  </tags>
  <workout>
    ${body}
  </workout>
</workout_file>
`;
}

/** Structural validation before a file is written or delivered. */
export function validateZwo(xml: string): string[] {
  const errors: string[] = [];
  if (!xml.startsWith("<?xml")) errors.push("missing XML declaration");
  if (!xml.includes("<workout_file>")) errors.push("missing workout_file");
  if (xml.length > 64 * 1024) errors.push("file is over 64 KB");
  const blocks = (xml.match(
    /<(Warmup|Cooldown|Ramp|SteadyState|IntervalsT|FreeRide|MaxEffort)\b/g,
  ) ?? []).length;
  if (blocks === 0) errors.push("no workout blocks");
  if (blocks > 250) errors.push("more than 250 workout blocks");
  for (const match of xml.matchAll(/Power(?:Low|High|On|Off)?="([0-9.]+)"/g)) {
    const value = Number(match[1]);
    if (!(value >= 0.3 && value <= 1.9)) {
      errors.push(`power out of range: ${value}`);
    }
  }
  for (const match of xml.matchAll(/Duration="([0-9.]+)"/g)) {
    if (!(Number(match[1]) > 0)) errors.push("non-positive duration");
  }
  return [...new Set(errors)];
}
