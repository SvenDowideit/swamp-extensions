import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  type ConfigLifecycleFile,
  hasConfigurableGlobals,
  lintConfigLifecycle,
  lintConfigLifecycles,
} from "./config-lifecycle-lint.ts";

const CONFIG_GLOBALS = `
const GlobalArgsSchema = z.object({
  path: z.string().default("."),
  verbose: z.boolean().default(false),
});
`;

const SETUP_PERSISTS_AND_READS = `
export const model = {
  type: "@me/tool",
  globalArguments: GlobalArgsSchema,
  resources: {
    config: { description: "Durable config", schema: ConfigSchema },
  },
  methods: {
    setup: {
      execute: async (args, context) => {
        const existing = await context.readResource("config");
        const peer = await context.readModelData("settings-server", "config");
        const merged = { ...peer, ...existing, ...args };
        return { dataHandles: [await context.writeResource("config", "config", merged)] };
      },
    },
  },
};
`;

Deno.test("a config extension with a compliant setup has no issues", () => {
  const source = CONFIG_GLOBALS + SETUP_PERSISTS_AND_READS;
  assertEquals(lintConfigLifecycle(source), []);
});

Deno.test("an extension with no config surface is skipped", () => {
  const source = `export const model = {
  type: "@me/tool",
  globalArguments: z.object({}),
  methods: { run: { execute: async () => ({ dataHandles: [] }) } },
};`;
  assertEquals(lintConfigLifecycle(source), []);
});

Deno.test("flags a config resource with no setup method", () => {
  const source = `export const model = {
  type: "@me/tool",
  globalArguments: z.object({ path: z.string() }),
  resources: { config: { schema: ConfigSchema } },
  methods: {},
};`;
  const issues = lintConfigLifecycle(source, "tool.ts");
  assertEquals(issues.length, 1);
  assertEquals(issues[0].rule, "setup-method-missing");
  assertEquals(issues[0].severity, "error");
  assertEquals(issues[0].path, "tool.ts");
});

Deno.test("warns when configurable globals have no setup method", () => {
  const source = `const GlobalArgsSchema = z.object({ path: z.string() });
export const model = {
  globalArguments: GlobalArgsSchema,
  methods: { run: { execute: async () => ({ dataHandles: [] }) } },
};`;
  const issues = lintConfigLifecycle(source);
  assertEquals(issues.length, 1);
  assertEquals(issues[0].rule, "setup-recommended");
  assertEquals(issues[0].severity, "warning");
});

Deno.test("flags a setup that never persists config", () => {
  const source = `const GlobalArgsSchema = z.object({ path: z.string() });
export const model = {
  globalArguments: GlobalArgsSchema,
  methods: {
    setup: {
      execute: async (args, context) => {
        context.logger?.info("settings", {});
        return { dataHandles: [] };
      },
    },
  },
};`;
  const rules = lintConfigLifecycle(source).map((i) => i.rule);
  assert(rules.includes("config-not-persisted"));
  assert(rules.includes("config-not-read-back"));
});

Deno.test("flags a setup that persists but never reads back", () => {
  const source = `const GlobalArgsSchema = z.object({ path: z.string() });
export const model = {
  globalArguments: GlobalArgsSchema,
  methods: {
    setup: {
      execute: async (args, context) => ({
        dataHandles: [await context.writeResource("config", "config", args)],
      }),
    },
  },
};`;
  const rules = lintConfigLifecycle(source).map((i) => i.rule);
  assert(!rules.includes("config-not-persisted"));
  assert(rules.includes("config-not-read-back"));
});

Deno.test("warns when a setup never reuses another model's config", () => {
  const source = `const GlobalArgsSchema = z.object({ path: z.string() });
export const model = {
  globalArguments: GlobalArgsSchema,
  methods: {
    setup: {
      execute: async (args, context) => {
        const existing = await context.readResource("config");
        return { dataHandles: [await context.writeResource("config", "config", { ...existing, ...args })] };
      },
    },
  },
};`;
  const warnings = lintConfigLifecycle(source).filter((i) =>
    i.severity === "warning"
  );
  assertEquals(warnings.map((i) => i.rule), ["config-not-reused"]);
});

Deno.test("a file-level ignore comment exempts every rule", () => {
  const source =
    `// meta-factory-ignore config-lifecycle: config is literal only
const GlobalArgsSchema = z.object({ path: z.string() });
export const model = { globalArguments: GlobalArgsSchema, methods: {
  setup: { execute: async () => ({ dataHandles: [] }) },
} };`;
  assertEquals(lintConfigLifecycle(source), []);
});

Deno.test("an ignore naming one rule exempts only that rule", () => {
  const source = `const GlobalArgsSchema = z.object({ path: z.string() });
export const model = { globalArguments: GlobalArgsSchema, methods: {
  // meta-factory-ignore config-lifecycle setup-recommended: tracked follow-up
  run: { execute: async () => ({ dataHandles: [] }) },
} };`;
  // The file has no setup; the rule is exempted by name.
  assertEquals(lintConfigLifecycle(source), []);
});

Deno.test("hasConfigurableGlobals handles inline and named schemas", () => {
  assertEquals(
    hasConfigurableGlobals(`globalArguments: z.object({ a: z.string() })`),
    true,
  );
  assertEquals(hasConfigurableGlobals(`globalArguments: z.object({})`), false);
  assertEquals(
    hasConfigurableGlobals(
      `const S = z.object({ a: z.string() });\nglobalArguments: S,`,
    ),
    true,
  );
});

Deno.test("comments about the rule are not linted", () => {
  const source = `// never call writeResource("config") without reading it first
export const model = { globalArguments: z.object({}), methods: {} };`;
  assertEquals(lintConfigLifecycle(source), []);
});

Deno.test("lintConfigLifecycles carries each file's path", () => {
  const files: ConfigLifecycleFile[] = [
    {
      path: "a.ts",
      source:
        `globalArguments: z.object({ p: z.string() }), methods: { setup: { execute: async () => ({}) } },`,
    },
    { path: "b.ts", source: `globalArguments: z.object({})` },
  ];
  const issues = lintConfigLifecycles(files);
  assert(issues.length > 0);
  assert(issues.every((i) => i.path === "a.ts"));
});
