/**
 * `@svendowideit/zwift-coach` — read-only planning engine.
 *
 * Phase 1/2: analyse merged Zwift+Garmin history, compile a built-in goal,
 * generate a periodised plan and render `.zwo` workouts. Delivery is a later
 * phase (and delegates SSH/SCP to `@swamp/ssh`).
 *
 * @module
 */

import { z } from "npm:zod@4";
import { analyzeFitness } from "./zwift_coach_analysis.ts";
import { compileGoal } from "./zwift_coach_goal.ts";
import { generatePlan } from "./zwift_coach_plan.ts";
import type { Fitness, Goal, Plan } from "./zwift_coach_types.ts";
import { fileNameFor, renderZwo, validateZwo } from "./zwift_coach_workouts.ts";
import { hashString } from "./zwift_coach_util.ts";
import { buildHowtoReport } from "./zwift_coach_howto.ts";
import {
  buildSshTransport,
  deliverWorkouts,
  type DeliveryMode,
  type RenderWorkout,
} from "./zwift_coach_delivery.ts";

const LooseSchema = z.record(z.string(), z.unknown());

const GlobalArgsSchema = z.object({
  timezone: z.string().default("").describe(
    "IANA timezone used for reporting; empty uses the host local zone",
  ),
}).strict();

const SetupArgsSchema = z.object({});

const HowtoArgsSchema = z.object({
  coachName: z.string().default("zwift-coach"),
  plan: LooseSchema.optional(),
  render: LooseSchema.optional(),
});

const DeliverArgsSchema = z.object({
  render: LooseSchema,
  plan: LooseSchema.optional(),
  mode: z.enum(["local", "sync", "bundle"]),
  workoutsDir: z.string().optional(),
  riderId: z.string().optional(),
  subfolder: z.string().default("zwift-coach"),
  syncDir: z.string().optional(),
  bundleDir: z.string().optional(),
  prune: z.boolean().default(false),
  dryRun: z.boolean().default(false),
});

const RecordDeliveryArgsSchema = z.object({
  planId: z.string(),
  winner: z.string(),
  attempts: z.array(z.record(z.string(), z.unknown())).default([]),
  warnings: z.array(z.string()).default([]),
  destination: z.string().optional(),
});

const SshTransportArgsSchema = z.object({
  sshUser: z.string().default(""),
  sshKey: z.string().default(""),
  sshPort: z.number().int().positive().default(22),
  sshHostKeyChecking: z.enum(["yes", "accept-new", "no", "off"]).default(
    "accept-new",
  ),
});

const AnalyzeArgsSchema = z.object({
  profile: LooseSchema,
  ability: LooseSchema,
  loadDaily: LooseSchema,
  historyYears: LooseSchema,
  availability: LooseSchema,
  trainingHistory: LooseSchema.nullable().optional(),
  bodyRange: LooseSchema.nullable().optional(),
  healthRange: LooseSchema.nullable().optional(),
  performanceRange: LooseSchema.nullable().optional(),
  timezone: z.string().optional(),
  age: z.number().int().min(0).optional(),
});

const GoalArgsSchema = z.object({
  fitness: LooseSchema,
  mode: z.enum(["regain", "improve", "event", "custom"]),
  description: z.string().optional(),
  targetDate: z.string().optional(),
  targetFtpPct: z.number().positive().max(0.2).optional(),
  targetWkg: z.number().positive().optional(),
  targetWeightKg: z.number().positive().optional(),
  eventType: z.string().optional(),
  weeks: z.number().int().min(0).max(24).optional(),
  daysPerWeek: z.number().int().min(0).max(6).optional(),
  hoursPerWeek: z.number().min(0).max(20).optional(),
  overrideAvailability: z.boolean().optional(),
  age: z.number().int().min(0).optional(),
  style: z.enum(["pyramidal", "polarised", "sprint"]).optional(),
  constraints: z.object({
    availableDays: z.array(z.number().int().min(1).max(7)).optional(),
    maxSessionMinutes: z.number().positive().optional(),
    equipment: z.array(z.string()).optional(),
    indoorOnly: z.boolean().optional(),
    injuries: z.array(z.string()).optional(),
  }).optional(),
});

const PlanArgsSchema = z.object({
  fitness: LooseSchema,
  goal: LooseSchema,
  startDate: z.string().optional(),
  weeks: z.number().int().min(0).max(24).optional(),
  seed: z.number().int().optional(),
});

const RenderArgsSchema = z.object({
  plan: LooseSchema,
  horizonStart: z.string().optional(),
  horizonDays: z.number().int().positive().max(365).optional(),
  ftpWatts: z.number().positive().optional(),
});

const PreviewArgsSchema = z.object({
  plan: LooseSchema,
  render: LooseSchema.optional(),
});

const SetupSchema = z.object({ report: z.string() });

const HowtoSchema = z.object({ report: z.string() });

const FitnessSchema = z.object({
  generatedAt: z.string(),
  current: z.record(z.string(), z.unknown()),
  peaks: z.record(z.string(), z.unknown()),
  years: z.array(z.record(z.string(), z.unknown())),
  availability: z.record(z.string(), z.unknown()),
  weight: z.record(z.string(), z.unknown()),
  readiness: z.record(z.string(), z.unknown()),
  athlete: z.record(z.string(), z.unknown()),
  rideFlavor: z.record(z.string(), z.unknown()),
  flags: z.record(z.string(), z.unknown()),
  sources: z.record(z.string(), z.unknown()),
}).passthrough();

const GoalSchema = z.object({
  id: z.string(),
  mode: z.enum(["regain", "improve", "event", "custom"]),
  description: z.string(),
  startDate: z.string(),
  targetDate: z.string(),
  weeks: z.number(),
  primary: z.record(z.string(), z.unknown()),
  secondary: z.array(z.record(z.string(), z.unknown())),
  constraints: z.record(z.string(), z.unknown()),
  targetCtl: z.number(),
  targetFtp: z.number().nullable(),
  assumptions: z.array(z.string()),
  warnings: z.array(z.string()),
}).passthrough();

const SessionSchema = z.object({
  id: z.string(),
  week: z.number(),
  date: z.string(),
  dayOfWeek: z.number(),
  type: z.string(),
  title: z.string(),
  hook: z.string(),
  why: z.string(),
  purpose: z.string(),
  fun: z.boolean(),
  zwiftSuggestion: z.string().optional(),
  durationMinutes: z.number(),
  targetTss: z.number(),
  computedTss: z.number(),
  targetIf: z.number(),
  steps: z.array(z.record(z.string(), z.unknown())),
  progression: z.string().optional(),
}).passthrough();

const WeekSchema = z.object({
  index: z.number(),
  startDate: z.string(),
  phase: z.string(),
  theme: z.string(),
  narrative: z.string(),
  targetCtl: z.number(),
  weeklyTss: z.number(),
  computedTss: z.number(),
  sessions: z.array(SessionSchema),
}).passthrough();

const PlanSchema = z.object({
  id: z.string(),
  generatedAt: z.string(),
  goalId: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  weeks: z.array(WeekSchema),
  summary: z.record(z.string(), z.unknown()),
}).passthrough();

const WorkoutSchema = z.object({
  id: z.string(),
  date: z.string(),
  week: z.number(),
  title: z.string(),
  type: z.string(),
  filename: z.string(),
  xml: z.string(),
  size: z.number(),
  hash: z.string(),
  errors: z.array(z.string()),
}).passthrough();

const RenderSchema = z.object({
  planId: z.string(),
  generatedAt: z.string(),
  workouts: z.array(WorkoutSchema),
  errors: z.array(z.string()),
}).passthrough();

const PreviewSchema = z.object({
  planId: z.string(),
  generatedAt: z.string(),
  markdown: z.string(),
}).passthrough();

const DeliverySpecSchema = z.object({
  planId: z.string(),
  generatedAt: z.string(),
  mode: z.enum(["local", "sync", "bundle", "ssh"]),
  destination: z.string(),
  riderId: z.string().nullable(),
  subfolder: z.string(),
  workouts: z.array(WorkoutSchema),
  bundlePath: z.string().nullable(),
  keepFiles: z.string(),
  dryRun: z.boolean(),
}).passthrough();

const DeliverySchema = z.object({
  planId: z.string(),
  generatedAt: z.string(),
  winner: z.string(),
  attempts: z.array(z.record(z.string(), z.unknown())),
  warnings: z.array(z.string()),
  destination: z.string().nullable(),
}).passthrough();

const TransportSchema = z.object({
  transport: z.record(z.string(), z.unknown()),
}).passthrough();

type Ctx = {
  globalArgs: z.infer<typeof GlobalArgsSchema>;
  logger: {
    info(msg: string, ...args: unknown[]): void;
    debug(msg: string, ...args: unknown[]): void;
    warning(msg: string, ...args: unknown[]): void;
  };
  writeResource: (
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
};

function asFitness(value: Record<string, unknown>): Fitness {
  return value as unknown as Fitness;
}

function asGoal(value: Record<string, unknown>): Goal {
  return value as unknown as Goal;
}

function asPlan(value: Record<string, unknown>): Plan {
  return value as unknown as Plan;
}

/** The model definition. */
export const model = {
  type: "@svendowideit/zwift-coach",
  version: "2026.11.06.1",
  upgrades: [],
  globalArguments: GlobalArgsSchema,
  resources: {
    fitness: {
      description: "Current/peak fitness, availability, weight and readiness",
      schema: FitnessSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    goal: {
      description: "Compiled built-in goal with targets and assumptions",
      schema: GoalSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    plan: {
      description: "Periodised weeks and sessions (no XML)",
      schema: PlanSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    workout: {
      description: "One rendered ZWO workout keyed by session id",
      schema: WorkoutSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    render: {
      description: "Index of the rendered workouts for a delivery window",
      schema: RenderSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    preview: {
      description: "Human-readable plan/next-week preview",
      schema: PreviewSchema,
      lifetime: "30d",
      garbageCollection: 10,
    },
    setup: {
      description: "Read-only readiness report",
      schema: SetupSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    howto: {
      description:
        "Guided commands for inspecting the plan, preview and rendered workouts",
      schema: HowtoSchema,
      lifetime: "30d",
      garbageCollection: 10,
    },
    deliverySpec: {
      description: "Resolved delivery destination and file list",
      schema: DeliverySpecSchema,
      lifetime: "30d",
      garbageCollection: 10,
    },
    delivery: {
      description: "Outcome of the last delivery attempt(s)",
      schema: DeliverySchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    transportSpec: {
      description:
        "Transport object for @swamp/ssh, with unset optional fields omitted",
      schema: TransportSchema,
      lifetime: "30d",
      garbageCollection: 10,
    },
  },
  methods: {
    // meta-factory-ignore config-lifecycle: setup is a read-only readiness
    // report; configuration comes from workflow inputs and is persisted in
    // plan/render/delivery resources, not in a separate setup config.
    setup: {
      description:
        "Report the resources the coach expects. Read-only; no network.",
      arguments: SetupArgsSchema,
      execute: async (
        _args: z.infer<typeof SetupArgsSchema>,
        ctx: Ctx,
      ) => {
        const report = [
          "Zwift coach configuration",
          "  inputs expected:",
          "    @svendowideit/zwift-rider profile-current, ability-current",
          "    @svendowideit/zwift-rider load-daily, history-years,",
          "      availability-current, training-history",
          "  Garmin (optional):",
          "    @svendowideit/garmin-body body-range",
          "    @svendowideit/garmin-health health-range",
          "    @svendowideit/garmin-performance performance-range",
          "  methods: analyze, goal, plan, render, preview, howto, deliver,",
          "    record-delivery, ssh-transport",
          "  delivery: SSH via @swamp/ssh, or local workoutsDir / syncDir /",
          "    bundleDir; see @svendowideit/zwift-coach-deliver",
          "  next: swamp workflow run @svendowideit/zwift-coach-plan",
        ].join("\n");
        const handle = await ctx.writeResource("setup", "report", { report });
        ctx.logger.info(report);
        return { dataHandles: [handle] };
      },
    },
    howto: {
      description:
        "Log a guided reading list for the generated plan: what to run first, " +
        "what each command returns, and why you would choose it.",
      arguments: HowtoArgsSchema,
      execute: async (
        args: z.infer<typeof HowtoArgsSchema>,
        ctx: Ctx,
      ) => {
        const name = args.coachName || "zwift-coach";
        const report = buildHowtoReport({
          coachName: name,
          plan: args.plan ? asPlan(args.plan) : null,
          render: args.render as Record<string, unknown> | undefined,
        });
        const handle = await ctx.writeResource("howto", "howto-current", {
          report,
        });
        ctx.logger.info(report);
        return { dataHandles: [handle] };
      },
    },
    analyze: {
      description:
        "Build the fitness snapshot from the data-owner resources and " +
        "optional Garmin body/health/performance data.",
      arguments: AnalyzeArgsSchema,
      execute: async (
        args: z.infer<typeof AnalyzeArgsSchema>,
        ctx: Ctx,
      ) => {
        const fitness = analyzeFitness({
          ...args,
          age: args.age && args.age > 0 ? args.age : undefined,
          timezone: args.timezone ?? ctx.globalArgs.timezone,
        });
        const handle = await ctx.writeResource(
          "fitness",
          "fitness-current",
          fitness as unknown as Record<string, unknown>,
        );
        ctx.logger.info(
          "Fitness: CTL {ctl}, FTP {ftp}, {days} days available/week",
          {
            ctl: fitness.current.ctl,
            ftp: fitness.current.ftpWatts,
            days: fitness.availability.daysPerWeek.p80,
          },
        );
        return { dataHandles: [handle] };
      },
    },
    goal: {
      description:
        "Compile a built-in regain/improve/event goal. Availability defaults " +
        "to the history-derived p80; explicit values are an override.",
      arguments: GoalArgsSchema,
      execute: async (
        args: z.infer<typeof GoalArgsSchema>,
        ctx: Ctx,
      ) => {
        const goal = compileGoal({
          ...args,
          fitness: asFitness(args.fitness),
          daysPerWeek: args.daysPerWeek && args.daysPerWeek >= 2
            ? args.daysPerWeek
            : undefined,
          hoursPerWeek: args.hoursPerWeek && args.hoursPerWeek > 0
            ? args.hoursPerWeek
            : undefined,
          age: args.age && args.age > 0 ? args.age : undefined,
        });
        const handle = await ctx.writeResource(
          "goal",
          "goal-current",
          goal as unknown as Record<string, unknown>,
        );
        ctx.logger.info(
          "Goal: {mode}, target CTL {ctl}, target FTP {ftp}, {weeks} weeks",
          {
            mode: goal.mode,
            ctl: goal.targetCtl,
            ftp: goal.targetFtp,
            weeks: goal.weeks,
          },
        );
        return { dataHandles: [handle] };
      },
    },
    plan: {
      description:
        "Generate the periodised weeks and sessions from the fitness and goal.",
      arguments: PlanArgsSchema,
      execute: async (
        args: z.infer<typeof PlanArgsSchema>,
        ctx: Ctx,
      ) => {
        const plan = generatePlan(asFitness(args.fitness), asGoal(args.goal), {
          startDate: args.startDate?.trim() || undefined,
          weeks: args.weeks && args.weeks > 0 ? args.weeks : undefined,
          seed: args.seed,
        });
        const handle = await ctx.writeResource(
          "plan",
          "plan-current",
          plan as unknown as Record<string, unknown>,
        );
        ctx.logger.info(
          "Plan: {weeks} weeks, {hours} h, {tss} TSS, id {id}",
          {
            weeks: plan.summary.weeks,
            hours: plan.summary.totalHours,
            tss: plan.summary.totalTss,
            id: plan.id,
          },
        );
        return { dataHandles: [handle] };
      },
    },
    render: {
      description:
        "Render the next N days (or the whole plan) as `.zwo` workouts.",
      arguments: RenderArgsSchema,
      execute: async (
        args: z.infer<typeof RenderArgsSchema>,
        ctx: Ctx,
      ) => {
        const plan = asPlan(args.plan);
        const start = args.horizonStart ?? plan.startDate;
        const end = args.horizonDays
          ? new Date(
            Date.parse(`${start}T00:00:00Z`) +
              (args.horizonDays - 1) * 86_400_000,
          ).toISOString().slice(0, 10)
          : plan.endDate;
        const selected = plan.weeks
          .flatMap((w) => w.sessions)
          .filter((s) => s.date >= start && s.date <= end);
        const errors: string[] = [];
        const workouts = [];
        for (const session of selected) {
          const xml = renderZwo(session, plan.id);
          const validation = validateZwo(xml);
          errors.push(...validation.map((e) => `${session.id}: ${e}`));
          workouts.push({
            id: session.id,
            date: session.date,
            week: session.week,
            title: session.title,
            type: session.type,
            filename: fileNameFor(session),
            xml,
            size: xml.length,
            hash: hashString(xml),
            errors: validation,
          });
        }
        const handles = [];
        for (const workout of workouts) {
          handles.push(
            await ctx.writeResource(
              "workout",
              `workout-${workout.id}`,
              workout,
            ),
          );
        }
        const handle = await ctx.writeResource("render", "render-current", {
          planId: plan.id,
          generatedAt: new Date().toISOString(),
          workouts,
          errors,
        });
        ctx.logger.info("Rendered {n} workouts ({errors} validation errors)", {
          n: workouts.length,
          errors: errors.length,
        });
        return { dataHandles: [handle, ...handles] };
      },
    },
    preview: {
      description:
        "Render a human-readable week-by-week preview with titles/hooks/why.",
      arguments: PreviewArgsSchema,
      execute: async (
        args: z.infer<typeof PreviewArgsSchema>,
        ctx: Ctx,
      ) => {
        const plan = asPlan(args.plan);
        const lines: string[] = [
          `# ${plan.summary.focus} plan (${plan.summary.weeks} weeks)`,
          "",
          `Start ${plan.startDate} · ${plan.summary.daysPerWeek} days/week · ` +
          `${plan.summary.hoursPerWeek} h/week · target CTL ${plan.summary.targetCtl}`,
          "",
        ];
        for (const week of plan.weeks) {
          lines.push(
            `## Week ${week.index} — ${week.theme} ` +
              `(${week.weeklyTss} target / ${week.computedTss} actual TSS)`,
            "",
          );
          for (const session of week.sessions) {
            lines.push(
              `- **${session.date} ${session.title}** — ${session.hook} ` +
                `(${session.durationMinutes} min, ~${session.computedTss} TSS)`,
              `  ${session.why}`,
            );
            if (session.zwiftSuggestion) {
              lines.push(`  Fun: ${session.zwiftSuggestion}`);
            }
          }
          lines.push("");
        }
        const handle = await ctx.writeResource("preview", "preview-current", {
          planId: plan.id,
          generatedAt: new Date().toISOString(),
          markdown: lines.join("\n"),
        });
        return { dataHandles: [handle] };
      },
    },
    deliver: {
      description:
        "Deliver rendered workouts to a local Zwift folder, a sync folder or " +
        "a portable bundle. SSH is a separate workflow using @swamp/ssh.",
      arguments: DeliverArgsSchema,
      execute: async (
        args: z.infer<typeof DeliverArgsSchema>,
        ctx: Ctx,
      ) => {
        const render = args.render as {
          planId?: string;
          workouts?: unknown[];
        };
        if (!render.planId || !Array.isArray(render.workouts)) {
          throw new Error(
            "deliver needs render-current with planId and workouts",
          );
        }
        const workouts = render.workouts as unknown as RenderWorkout[];
        const result = await deliverWorkouts(workouts, {
          mode: args.mode as DeliveryMode,
          planId: render.planId,
          plan: args.plan ? asPlan(args.plan) : null,
          riderId: args.riderId,
          subfolder: args.subfolder,
          workoutsDir: args.workoutsDir,
          syncDir: args.syncDir,
          bundleDir: args.bundleDir,
          prune: args.prune,
          dryRun: args.dryRun,
        });
        const generatedAt = new Date().toISOString();
        const specHandle = await ctx.writeResource(
          "deliverySpec",
          "delivery-spec",
          {
            planId: render.planId,
            generatedAt,
            mode: args.mode,
            destination: result.destination,
            riderId: args.riderId ?? null,
            subfolder: args.subfolder,
            workouts,
            bundlePath: result.mode === "bundle" ? result.destination : null,
            keepFiles: workouts.map((w) => w.filename).join(","),
            dryRun: args.dryRun,
          } as unknown as Record<string, unknown>,
        );
        const deliveryHandle = await ctx.writeResource(
          "delivery",
          "delivery-current",
          {
            planId: render.planId,
            generatedAt,
            winner: result.mode,
            attempts: [{
              mode: result.mode,
              status: args.dryRun ? "dry-run" : "succeeded",
              destination: result.destination,
              wrote: result.written.length,
            }],
            warnings: args.dryRun
              ? [...result.warnings, "dry run only; no files were written"]
              : result.warnings,
            destination: result.destination,
          },
        );
        if (args.dryRun) {
          ctx.logger.info(
            "Dry run {mode} -> {dest}: {written} would be written, {skipped} already present, {pruned} would be pruned",
            {
              mode: result.mode,
              dest: result.destination,
              written: result.written.length,
              skipped: result.skipped.length,
              pruned: result.pruned.length,
            },
          );
        } else {
          ctx.logger.info(
            "Delivered {mode} to {dest}: {written} written, {skipped} already present, {pruned} pruned",
            {
              mode: result.mode,
              dest: result.destination,
              written: result.written.length,
              skipped: result.skipped.length,
              pruned: result.pruned.length,
            },
          );
        }
        return { dataHandles: [specHandle, deliveryHandle] };
      },
    },
    "ssh-transport": {
      description:
        "Build the @swamp/ssh transport from optional user/key overrides. " +
        "Empty user/key are omitted so ssh uses the current user and agent.",
      arguments: SshTransportArgsSchema,
      execute: async (
        args: z.infer<typeof SshTransportArgsSchema>,
        ctx: Ctx,
      ) => {
        const transport = buildSshTransport({
          user: args.sshUser,
          key: args.sshKey,
          port: args.sshPort,
          hostKeyChecking: args.sshHostKeyChecking,
        });
        const handle = await ctx.writeResource(
          "transportSpec",
          "transport-current",
          { transport },
        );
        ctx.logger.info(
          "SSH transport: user={user}, key={key}, port={port}",
          {
            user: args.sshUser || "(ssh default)",
            key: args.sshKey || "(ssh default)",
            port: args.sshPort,
          },
        );
        return { dataHandles: [handle] };
      },
    },
    "record-delivery": {
      description:
        "Record the winning delivery attempt and all attempts for a workflow " +
        "(used by the SSH/fallback workflows).",
      arguments: RecordDeliveryArgsSchema,
      execute: async (
        args: z.infer<typeof RecordDeliveryArgsSchema>,
        ctx: Ctx,
      ) => {
        const handle = await ctx.writeResource("delivery", "delivery-current", {
          planId: args.planId,
          generatedAt: new Date().toISOString(),
          winner: args.winner,
          attempts: args.attempts,
          warnings: args.warnings,
          destination: args.destination ?? null,
        });
        ctx.logger.info(
          "Delivery recorded: {winner}, {n} attempt(s)",
          { winner: args.winner, n: args.attempts.length },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
