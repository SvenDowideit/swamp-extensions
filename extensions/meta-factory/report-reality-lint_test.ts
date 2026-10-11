import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  lintReportRealities,
  lintReportReality,
  type ReportRealityFile,
} from "./report-reality-lint.ts";

const VERIFIED_SETUP = `
const GlobalArgsSchema = z.object({ port: z.number() });

export const model = {
  type: "@me/tool",
  globalArguments: GlobalArgsSchema,
  methods: {
    setup: {
      execute: async (args, ctx) => {
        const bound = await probeBoundPorts();
        if (!bound.includes(443)) {
          throw new Error("cannot bind 443: no elevation route — stopped");
        }
        ctx.logger.info("verified serving on https://{host}", { host: args.host });
        ctx.logger.info("DNS may take up to 5 minutes to propagate");
        return { dataHandles: [] };
      },
    },
  },
};
`;

Deno.test("a setup that verifies and fails fast is clean", () => {
  assertEquals(lintReportReality(VERIFIED_SETUP, "tool.ts"), []);
});

Deno.test("flags a setup catch that continues past a failure", () => {
  const source = `
const GlobalArgsSchema = z.object({ port: z.number() });
export const model = {
  globalArguments: GlobalArgsSchema,
  methods: {
    setup: {
      execute: async (args, ctx) => {
        try {
          await grantCapability();
        } catch (err) {
          ctx.logger.warn("could not grant capability: {err}", { err });
        }
        return { dataHandles: [] };
      },
    },
  },
};
`;
  const issues = lintReportReality(source, "tool.ts");
  const rules = issues.map((i) => i.rule);
  assert(rules.includes("failure-swallowed"));
  assertEquals(
    issues.find((i) => i.rule === "failure-swallowed")!.severity,
    "error",
  );
});

Deno.test("a swallowed catch in a non-setup file is not flagged", () => {
  const source = `
export const model = {
  globalArguments: z.object({}),
  methods: {
    run: {
      execute: async (args, ctx) => {
        try { await optional(); } catch (err) { ctx.logger.warn("x", { err }); }
        return { dataHandles: [] };
      },
    },
  },
};
`;
  const rules = lintReportReality(source).map((i) => i.rule);
  assert(!rules.includes("failure-swallowed"));
});

Deno.test("warns on a success claim with no verification", () => {
  const source = `
const GlobalArgsSchema = z.object({ host: z.string() });
export const model = {
  globalArguments: GlobalArgsSchema,
  methods: {
    setup: {
      execute: async (args, ctx) => {
        ctx.logger.info("Caddy configured and serving on https://{h}", { h: args.host });
        return { dataHandles: [] };
      },
    },
  },
};
`;
  const warnings = lintReportReality(source).filter((i) =>
    i.rule === "claim-without-verification"
  );
  assertEquals(warnings.length, 1);
  assertEquals(warnings[0].severity, "warning");
});

Deno.test("warns when a long-lived change states no time-to-ready", () => {
  const source = `
const GlobalArgsSchema = z.object({ zone: z.string() });
export const model = {
  globalArguments: GlobalArgsSchema,
  methods: {
    setup: {
      execute: async (args, ctx) => {
        await writeDnsRecord(args.zone);
        const ok = await verifyRecord(args.zone);
        ctx.logger.info("DNS record applied: {ok}", { ok });
        return { dataHandles: [] };
      },
    },
  },
};
`;
  const rules = lintReportReality(source).map((i) => i.rule);
  assert(rules.includes("eta-missing"));
});

Deno.test("a file-level ignore exempts every rule", () => {
  const source =
    `// meta-factory-ignore report-reality: deliberate best-effort enrichment
const GlobalArgsSchema = z.object({ p: z.string() });
export const model = { globalArguments: GlobalArgsSchema, methods: {
  setup: { execute: async (a, ctx) => { try { await x(); } catch (e) { ctx.logger.warn("w", {}); } return {}; } },
} };`;
  assertEquals(lintReportReality(source), []);
});

Deno.test("an ignore naming one rule exempts only that rule", () => {
  const source =
    `// meta-factory-ignore report-reality failure-swallowed: optional step
const GlobalArgsSchema = z.object({ p: z.string() });
export const model = { globalArguments: GlobalArgsSchema, methods: {
  setup: { execute: async (a, ctx) => { try { await x(); } catch (e) { ctx.logger.warn("w", {}); } return {}; } },
} };`;
  assertEquals(
    lintReportReality(source).filter((i) => i.rule === "failure-swallowed"),
    [],
  );
});

const SETUP_WORKFLOW = `
name: "@me/tool-setup"
jobs:
  - name: setup
    steps:
      - name: install
        task: { type: model_method, methodName: installTool }
        allowFailure: false
        dependsOn: []
      - name: grant-capabilities
        task: { type: model_method, methodName: setCapabilities }
        allowFailure: true
        dependsOn:
          - step: install
            condition: { type: completed }
      - name: start-service
        task: { type: model_method, methodName: startService }
        allowFailure: true
        dependsOn:
          - step: grant-capabilities
            condition: { type: completed }
`;

Deno.test("flags an allowFailure prerequisite a later step depends on", () => {
  const issues = lintReportReality(SETUP_WORKFLOW, "tool-setup.yaml");
  const errs = issues.filter((i) => i.rule === "prerequisite-allow-failure");
  assertEquals(errs.length, 1);
  assertEquals(errs[0].severity, "error");
  assert(errs[0].message.includes("grant-capabilities"));
  assert(errs[0].message.includes("start-service"));
});

Deno.test("allows allowFailure when dependents require success", () => {
  const wf = SETUP_WORKFLOW.replaceAll(
    "condition: { type: completed }",
    "condition: { type: succeeded }",
  );
  assertEquals(
    lintReportReality(wf, "tool-setup.yaml").filter((i) =>
      i.rule === "prerequisite-allow-failure"
    ),
    [],
  );
});

Deno.test("a non-setup workflow is not linted for allowFailure", () => {
  const wf = SETUP_WORKFLOW.replace("@me/tool-setup", "@me/tool-sync").replace(
    /setup/g,
    "sync",
  );
  assertEquals(lintReportReality(wf, "tool-sync.yaml"), []);
});

Deno.test("lintReportRealities carries each file's path", () => {
  const files: ReportRealityFile[] = [
    {
      path: "a.ts",
      source: `export const model = { globalArguments: z.object({}), methods: {
        setup: { execute: async (a, ctx) => { try { await x(); } catch (e) { ctx.logger.warn("w", {}); } return {}; } },
      } };`,
    },
    {
      path: "b.ts",
      source: `export const model = { globalArguments: z.object({}) };`,
    },
  ];
  const issues = lintReportRealities(files);
  assert(issues.length > 0);
  assert(issues.every((i) => i.path === "a.ts"));
});
