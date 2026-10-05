import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import type { ExtensionRecord } from "./graph.ts";
import {
  adviseChannel,
  buildGraph,
  buildPlan,
  compareCalVer,
  highestPublished,
  needsPublish,
  topologicalOrder,
} from "./graph.ts";

function record(
  partial: Partial<ExtensionRecord> & { name: string },
): ExtensionRecord {
  return {
    manifestPath: `extensions/models/${partial.name}/manifest.yaml`,
    dir: `extensions/models/${partial.name}`,
    onDiskVersion: "",
    modelVersion: "",
    upgradesTo: "",
    dependencies: [],
    published: { stable: "", rc: "", beta: "" },
    installed: { version: "", channel: "" },
    dirtyFiles: [],
    reviewState: "ok",
    docsScore: null,
    hygieneFailures: [],
    ...partial,
  };
}

Deno.test("compareCalVer orders numerically, not lexically", () => {
  assertEquals(compareCalVer("2026.10.05.1", "2026.10.05.2") < 0, true);
  assertEquals(compareCalVer("2026.10.05.10", "2026.10.05.9") > 0, true);
  assertEquals(compareCalVer("2026.9.1.1", "2026.10.1.1") < 0, true);
  assertEquals(compareCalVer("2026.10.05.1", "2026.10.05.1"), 0);
  assertEquals(compareCalVer("", "2026.10.05.1") < 0, true);
});

Deno.test("highestPublished picks the newest channel version", () => {
  assertEquals(
    highestPublished({ stable: "2026.09.01.1", rc: "", beta: "2026.10.02.6" }),
    { version: "2026.10.02.6", channel: "beta" },
  );
  assertEquals(highestPublished({ stable: "", rc: "", beta: "" }), {
    version: "",
    channel: "",
  });
});

Deno.test("needsPublish is version-based, not dirtiness-based", () => {
  const ahead = record({
    name: "@a/ahead",
    onDiskVersion: "2026.10.05.1",
    published: { stable: "", rc: "", beta: "2026.10.02.1" },
  });
  assertEquals(needsPublish(ahead), true);

  const already = record({
    name: "@a/already",
    onDiskVersion: "2026.10.05.1",
    published: { stable: "2026.10.05.1", rc: "", beta: "" },
    dirtyFiles: ["x.ts"],
  });
  assertEquals(needsPublish(already), false);
});

Deno.test("adviseChannel: never-published is beta", () => {
  const r = adviseChannel(record({ name: "@a/new", onDiskVersion: "1.0.0" }));
  assertEquals(r.channel, "beta");
  assertEquals(r.confidence, "high");
});

Deno.test("adviseChannel: failing docs stays on beta", () => {
  const r = adviseChannel(record({
    name: "@a/bad",
    onDiskVersion: "2026.10.05.1",
    docsScore: 40,
    published: { stable: "", rc: "", beta: "2026.10.01.1" },
  }));
  assertEquals(r.channel, "beta");
  assertEquals(r.reason.includes("below threshold"), true);
});

Deno.test("adviseChannel: stable line continues on stable", () => {
  const r = adviseChannel(record({
    name: "@a/solid",
    onDiskVersion: "2026.10.05.1",
    docsScore: 95,
    published: { stable: "2026.10.04.1", rc: "", beta: "2026.10.02.1" },
  }));
  assertEquals(r.channel, "stable");
});

Deno.test("adviseChannel: rc line continues on rc", () => {
  const r = adviseChannel(record({
    name: "@a/rc",
    onDiskVersion: "2026.10.05.1",
    docsScore: 95,
    published: { stable: "", rc: "2026.10.04.1", beta: "2026.10.02.1" },
  }));
  assertEquals(r.channel, "rc");
});

Deno.test("adviseChannel: beta-only stays on beta", () => {
  const r = adviseChannel(record({
    name: "@a/beta",
    onDiskVersion: "2026.10.05.1",
    docsScore: 95,
    published: { stable: "", rc: "", beta: "2026.10.02.1" },
  }));
  assertEquals(r.channel, "beta");
  assertEquals(r.reason.includes("existing trend"), true);
});

Deno.test("topologicalOrder puts dependencies first", () => {
  const deps = new Map<string, string[]>([
    ["@a/app", ["@a/lib"]],
    ["@a/lib", ["@a/base"]],
    ["@a/base", []],
  ]);
  const { order, cycle } = topologicalOrder(
    ["@a/app", "@a/lib", "@a/base"],
    deps,
  );
  assertEquals(order, ["@a/base", "@a/lib", "@a/app"]);
  assertEquals(cycle, []);
});

Deno.test("topologicalOrder breaks a cycle deterministically", () => {
  const deps = new Map<string, string[]>([
    ["@a/x", ["@a/y"]],
    ["@a/y", ["@a/x"]],
  ]);
  const { order, cycle } = topologicalOrder(["@a/x", "@a/y"], deps);
  assertEquals(order.length, 2);
  assertEquals(cycle, ["@a/x", "@a/y"]);
});

Deno.test("buildGraph marks blockers and external edges", () => {
  const records = [
    record({
      name: "@a/lib",
      onDiskVersion: "2026.10.05.1",
      published: { stable: "", rc: "", beta: "2026.10.01.1" },
    }),
    record({
      name: "@a/app",
      onDiskVersion: "2026.10.05.1",
      published: { stable: "", rc: "", beta: "" },
      dependencies: ["@a/lib", "@external/thing"],
    }),
  ];
  const graph = buildGraph(records);
  const app = graph.nodes.find((n) => n.name === "@a/app");
  const lib = graph.nodes.find((n) => n.name === "@a/lib");
  assertEquals(lib?.publishState, "needs-publish");
  assertEquals(app?.publishState, "blocked");
  assertEquals(graph.externalNodes.map((n) => n.name), ["@external/thing"]);
  assertEquals(
    graph.edges.find((e) => e.from === "@a/app" && e.to === "@external/thing")
      ?.external,
    true,
  );
  assertEquals(
    graph.publishOrder.indexOf("@a/lib") < graph.publishOrder.indexOf("@a/app"),
    true,
  );
});

Deno.test("buildGraph marks an up-to-date extension", () => {
  const records = [
    record({
      name: "@a/done",
      onDiskVersion: "2026.09.01.1",
      published: { stable: "2026.09.01.1", rc: "", beta: "" },
    }),
  ];
  const graph = buildGraph(records);
  assertEquals(graph.nodes[0].publishState, "up-to-date");
});

Deno.test("buildPlan orders dependencies first and blocks dependents", () => {
  const records = [
    record({
      name: "@a/lib",
      onDiskVersion: "2026.10.05.1",
      published: { stable: "", rc: "", beta: "2026.10.01.1" },
    }),
    record({
      name: "@a/app",
      onDiskVersion: "2026.10.05.1",
      published: { stable: "", rc: "", beta: "" },
      dependencies: ["@a/lib"],
    }),
  ];
  const graph = buildGraph(records);
  const plan = buildPlan(records, graph);
  assertEquals(plan.map((s) => s.name), ["@a/lib", "@a/app"]);
  assertEquals(plan[0].state, "ready");
  assertEquals(plan[0].targetChannel, "beta");
  assertEquals(
    plan[0].command,
    "swamp extension push extensions/models/@a/lib/manifest.yaml --channel beta",
  );
  assertEquals(plan[1].state, "blocked");
  assertEquals(plan[1].blockers, ["@a/lib"]);
});

Deno.test("buildPlan omits up-to-date extensions", () => {
  const records = [
    record({
      name: "@a/done",
      onDiskVersion: "2026.09.01.1",
      published: { stable: "2026.09.01.1", rc: "", beta: "" },
    }),
  ];
  assertEquals(buildPlan(records, buildGraph(records)), []);
});

Deno.test("needsPublish treats an installed version as published", () => {
  // Registry unreachable (published all empty), but the lockfile proves
  // 2026.10.05.1 was published and pulled. On-disk is the same version, so it
  // must NOT be flagged for publishing.
  const r = record({
    name: "@a/pulled",
    onDiskVersion: "2026.10.05.1",
    published: { stable: "", rc: "", beta: "" },
    installed: { version: "2026.10.05.1", channel: "" },
    registryKnown: false,
  });
  assertEquals(needsPublish(r), false);
});

Deno.test("buildGraph marks unknown when registry is unreachable", () => {
  const r = record({
    name: "@a/new",
    onDiskVersion: "2026.10.05.1",
    published: { stable: "", rc: "", beta: "" },
    installed: { version: "", channel: "" },
    registryKnown: false,
  });
  const graph = buildGraph([r]);
  assertEquals(graph.nodes[0].publishState, "unknown");
  assertEquals(graph.nodes[0].channelAdvice.confidence, "low");
  assertStringIncludes(
    graph.nodes[0].channelAdvice.reason,
    "registry unreachable",
  );
});

Deno.test("adviseChannel: unknown does not claim 'never published'", () => {
  const r = record({
    name: "@a/unknown",
    onDiskVersion: "2026.10.05.1",
    published: { stable: "", rc: "", beta: "" },
    registryKnown: false,
  });
  const advice = adviseChannel(r);
  assertEquals(advice.confidence, "low");
  assertStringIncludes(advice.reason, "unknown");
});
