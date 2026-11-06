import { assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import type { Session } from "./zwift_coach_types.ts";
import {
  buildSession,
  fitToTss,
  renderZwo,
  slug,
  templateFor,
  totalTss,
  validateZwo,
} from "./zwift_coach_workouts.ts";

function session(overrides: Partial<Session> = {}): Session {
  const steps = templateFor("sweetspot", 75);
  return {
    id: "w01-2026-01-06",
    week: 1,
    date: "2026-01-06",
    dayOfWeek: 2,
    type: "sweetspot",
    title: "Sweet spot pressure",
    hook: "Controlled pressure",
    why: "Raises FTP",
    purpose: "Aerobic",
    fun: false,
    durationMinutes: 75,
    targetTss: 85,
    computedTss: totalTss(steps),
    targetIf: 0.9,
    steps,
    ...overrides,
  };
}

Deno.test("renderZwo produces valid conservative XML", () => {
  const xml = renderZwo(session());
  assertEquals(xml.includes("<workout_file>"), true);
  assertEquals(xml.includes("<category>zwift-coach</category>"), true);
  assertEquals(xml.includes("<IntervalsT"), true);
  assertEquals(validateZwo(xml), []);
});

Deno.test("fitToTss moves a template toward the target", () => {
  const steps = fitToTss(templateFor("sweetspot", 75), 110);
  const tss = totalTss(steps);
  assertNotEquals(tss, 0);
  assertEquals(Math.abs(tss - 110) < 30, true, `tss ${tss}`);
});

Deno.test("buildSession computes TSS and duration", () => {
  const s = buildSession({
    id: "w1",
    week: 1,
    date: "2026-01-06",
    dayOfWeek: 2,
    type: "threshold",
    title: "Threshold",
    hook: "Hold it",
    why: "FTP",
    purpose: "Threshold",
    targetTss: 95,
    durationMinutes: 75,
  });
  assertEquals(s.computedTss > 0, true);
  assertEquals(s.durationMinutes > 0, true);
  assertEquals(s.targetIf > 0, true);
});

Deno.test("slug is ASCII-safe", () => {
  assertEquals(slug("Bridge to 60s — 3x12"), "bridge-to-60s-3x12");
});
