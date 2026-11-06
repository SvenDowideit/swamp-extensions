/**
 * Builds the guided "what to run next" report for a generated plan.
 *
 * Kept pure so a test can assert every emitted `swamp data query` command has
 * the flags needed to produce JSON (the original version omitted `--json` and
 * printed a table that `jq` could not parse).
 *
 * @module
 */

import type { Plan } from "./zwift_coach_types.ts";

export interface HowtoInput {
  coachName: string;
  plan?: Plan | null;
  render?: Record<string, unknown> | null;
}

/** Build the report shown/logged at the end of the plan workflow. */
export function buildHowtoReport(input: HowtoInput): string {
  const name = input.coachName || "zwift-coach";
  const plan = input.plan ?? null;
  const render = input.render ?? {};
  const workouts = Array.isArray(render.workouts)
    ? render.workouts as unknown[]
    : [];
  const summary = plan?.summary;
  const headline = plan && summary
    ? `Plan ${plan.id}: ${summary.weeks} weeks, ` +
      `${summary.totalHours} h, ${summary.totalTss} TSS, ` +
      `target CTL ${summary.targetCtl}.`
    : "Plan generated.";
  const firstWeek = plan?.weeks?.[0];
  const firstWeekLine = firstWeek
    ? `Week 1 — ${firstWeek.theme}: ${firstWeek.sessions.length} sessions, ` +
      `${firstWeek.weeklyTss} target / ${firstWeek.computedTss} actual TSS.`
    : "";
  return [
    headline,
    firstWeekLine,
    "",
    "START HERE — read the plan as a human, not JSON:",
    `  swamp data query 'behavior("${name}") && name == "preview-current"' --single --json --select content | jq -r '.markdown'`,
    "  Expect: one section per week; each session line has the date, title,",
    "  duration and TSS, with a one-line 'why'. Use this to check that the",
    "  plan looks sane and that the sessions fit your week before inspecting",
    "  raw data.",
    "",
    "THEN — inspect the structured week (load, phase, session targets):",
    `  swamp data query 'behavior("${name}") && name == "plan-current"' --single --json --select content | jq '.weeks[0]'`,
    "  Expect: phase, targetCtl, weeklyTss, computedTss and sessions[] with",
    "  type/targetTss/computedTss. Use this when you want to compare load,",
    "  edit the plan, or wire it into another workflow.",
    "",
    "WORKOUTS READY — the rendered .zwo files delivery will use:",
    `  swamp data query 'behavior("${name}") && name == "render-current"' --single --json --select content | jq '.workouts[] | {date,title,filename,size}'`,
    `  Expect: ${workouts.length} rows (one per workout in the render window),`,
    "  with a filename and size. These are the files delivery will use.",
    "",
    "ONLY IF SOMETHING LOOKS WRONG — data quality:",
    "  swamp data query 'modelType == \"@svendowideit/zwift-rider\" && name == \"training-history\"' --single --json --select content | jq '.dataQuality'",
    "  Expect: npRides/estimatedRides/missingRides/fitParsed/reusedRides.",
    "  If estimated or missing is high, run the coach backfill with",
    "  --input force=true or check that the Zwift FIT files are reachable.",
    "",
    "RE-PLAN — change goal or capacity without touching history:",
    "  swamp workflow run @svendowideit/zwift-coach-plan --input goal=regain",
    "  History is cached and reused; this is cheap unless new rides or",
    "  recent detail need refreshing.",
    "",
    "DELIVERED — check which channel won and where the files landed:",
    `  swamp data query 'behavior("${name}") && name == "delivery-current"' --single --json --select content | jq '{winner,destination,warnings,attempts}'`,
    "  Expect: a winner (ssh/local/sync/bundle), a destination, empty",
    "  warnings, and one attempt. If winner is bundle, the auto-delivery",
    "  could not reach Zwift and left a portable bundle instead.",
    "",
    "CHANGE THE CHANNEL — run one delivery workflow explicitly:",
    "  swamp workflow run @svendowideit/zwift-coach-deliver-local --input workoutsDir=$HOME/Documents/Zwift/Workouts --input riderId=123456",
    "  Use local when swamp can write the Zwift workouts folder directly.",
    "  swamp workflow run @svendowideit/zwift-coach-deliver-sync --input syncDir=~/Sync/zwift-coach",
    "  Use sync when Syncthing/Dropbox/Nextcloud mirrors that folder to the Zwift host.",
    "  swamp workflow run @svendowideit/zwift-coach-deliver-bundle --input bundleDir=~/.local/share/zwift-coach",
    "  Use bundle to get a portable folder you copy by hand; it always works.",
    "  swamp workflow run @svendowideit/zwift-coach-deliver-ssh --input sshAddress=macmini",
    "  Use SSH when the Zwift host is remote; only the address is required and",
    "  empty user/key use your current user and ssh config/agent.",
    "",
    "AUTO-DELIVERY — the plan workflow tries SSH, then local, then sync,",
    "then bundle. Give the plan workflow the channel inputs you have:",
    "  swamp workflow run @svendowideit/zwift-coach-plan --input workoutsDir=$HOME/Documents/Zwift/Workouts",
    "  swamp workflow run @svendowideit/zwift-coach-plan --input sshAddress=macmini",
    "  Set --input autoDeliver=false to render and preview only.",
  ].filter((line) => line !== "").join("\n");
}
