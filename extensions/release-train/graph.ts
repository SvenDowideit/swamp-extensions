/**
 * Pure graph and release-status logic for release-train.
 *
 * Turns a list of per-extension records (on-disk version, published versions,
 * dependencies, dirty files, review state) into a dependency graph, a
 * topological publish order, per-extension publish state, an advisory target
 * channel, and an ordered publish plan. No I/O: every function here is a pure
 * transformation, unit-tested directly.
 *
 * @module
 */
import type { ReviewState } from "./introspect.ts";

/** Latest published version per release channel (`""` when none). */
export interface ChannelVersions {
  /** Latest stable version, or `""`. */
  stable: string;
  /** Latest release-candidate version, or `""`. */
  rc: string;
  /** Latest beta version, or `""`. */
  beta: string;
}

/** Version and channel actually pulled, from the lockfile. */
export interface InstalledInfo {
  /** Installed version, or `""` when not pulled. */
  version: string;
  /** Channel the installed version came from, or `""` (stable). */
  channel: string;
}

/** Everything graph.ts needs to know about one extension on disk. */
export interface ExtensionRecord {
  /** Fully-qualified name, e.g. `@svendowideit/caddy`. */
  name: string;
  /** Manifest path relative to the repo root. */
  manifestPath: string;
  /** Extension directory relative to the repo root. */
  dir: string;
  /** Version from the manifest. */
  onDiskVersion: string;
  /** Version declared by the exported model(s). */
  modelVersion: string;
  /** Highest `upgrades[].toVersion`, or `""`. */
  upgradesTo: string;
  /** Declared dependencies (may be external). */
  dependencies: string[];
  /** Latest published version per channel. */
  published: ChannelVersions;
  /** Installed version/channel from the lockfile. */
  installed: InstalledInfo;
  /** Paths reported dirty by `git status` under this extension's dir. */
  dirtyFiles: string[];
  /** Adversarial-review readiness for the current content hash. */
  reviewState: ReviewState;
  /** Documentation score from meta-factory, or `null`. */
  docsScore: number | null;
  /** Human-readable hygiene failures (empty = clean). */
  hygieneFailures: string[];
  /**
   * Where {@link published} came from, which decides how far it can be trusted.
   *
   * - `registry` — authoritative, this run queried swamp-club.
   * - `cache` — a previous run's registry answer, possibly out of date.
   * - `lockfile` — only the installed version, which is a *lower bound*: it
   *   proves a version was published, but its absence does **not** prove an
   *   extension is unpublished.
   * - `none` — no published information at all.
   *
   * Ignorance (`lockfile`/`none`) must never be rendered as "needs publishing".
   */
  publishedSource?: PublishedSource;
  /** ISO timestamp the cached registry answer was observed (for `cache`). */
  publishedAsOf?: string;
}

/** Where an extension's published-channel versions were learned from. */
export type PublishedSource = "registry" | "cache" | "lockfile" | "none";

/** True when the published versions are authoritative enough to classify on. */
export function publishedResolved(record: ExtensionRecord): boolean {
  return record.publishedSource === "registry" ||
    record.publishedSource === "cache";
}

/** Publish state derived for one local extension. */
export type PublishState =
  | "up-to-date"
  | "needs-publish"
  | "blocked"
  | "external"
  | "unknown";

/** Advisory target channel (never auto-applied). */
export interface ChannelAdvice {
  /** Suggested channel, or `""` when there is nothing to publish. */
  channel: "beta" | "rc" | "stable" | "";
  /** Why this channel was suggested. */
  reason: string;
  /** How strongly the trend supports the advice. */
  confidence: "high" | "medium" | "low";
}

/** One node in the rendered graph. */
export interface GraphNode {
  /** Fully-qualified extension name. */
  name: string;
  /** On-disk version from the manifest. */
  onDiskVersion: string;
  /** Derived publish state. */
  publishState: PublishState;
  /** Advisory target channel. */
  channelAdvice: ChannelAdvice;
}

/** A dependency edge: `from` depends on `to`. */
export interface GraphEdge {
  /** Dependent extension name. */
  from: string;
  /** Dependency name (local or external). */
  to: string;
  /** True when `to` is not one of this repo's extensions. */
  external: boolean;
}

/** An extension not present in this repo but depended upon. */
export interface ExternalNode {
  /** Fully-qualified extension name. */
  name: string;
  /** Latest published stable version, or `""`. */
  publishedStable: string;
  /** Latest published beta version, or `""`. */
  publishedBeta: string;
}

/** The assembled graph. */
export interface Graph {
  /** One node per local extension. */
  nodes: GraphNode[];
  /** Dependency edges, local and external. */
  edges: GraphEdge[];
  /** Dependencies external to this repo. */
  externalNodes: ExternalNode[];
  /** Topological order, dependencies first. */
  publishOrder: string[];
  /** Members of a dependency cycle, when one exists (deterministic break). */
  cycle: string[];
}

/** Compare two CalVer strings numerically; `<0`, `0`, `>0`. */
export function compareCalVer(a: string, b: string): number {
  if (a === b) return 0;
  if (a === "") return -1;
  if (b === "") return 1;
  const pa = a.split(".");
  const pb = b.split(".");
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = Number(pa[i] ?? "0");
    const nb = Number(pb[i] ?? "0");
    if (Number.isFinite(na) && Number.isFinite(nb)) {
      if (na !== nb) return na < nb ? -1 : 1;
    } else {
      const sa = pa[i] ?? "";
      const sb = pb[i] ?? "";
      if (sa !== sb) return sa < sb ? -1 : 1;
    }
  }
  return 0;
}

/** The highest published version across all channels, with its channel. */
export function highestPublished(
  published: ChannelVersions,
): { version: string; channel: string } {
  const channels: Array<["stable" | "rc" | "beta", string]> = [
    ["stable", published.stable],
    ["rc", published.rc],
    ["beta", published.beta],
  ];
  let best = { version: "", channel: "" };
  for (const [channel, version] of channels) {
    if (version && compareCalVer(version, best.version) > 0) {
      best = { version, channel };
    }
  }
  return best;
}

/** True when the extension has never been published on any channel. */
export function neverPublished(published: ChannelVersions): boolean {
  return !published.stable && !published.rc && !published.beta;
}

/**
 * The highest version we can prove has been published, from the registry or the
 * lockfile.
 *
 * The lockfile is a lower bound: if a version is installed, it was published,
 * even when the registry could not be reached. Taking the max of the two means
 * a reachable registry always wins, but a lockfile-only run still classifies an
 * already-pulled version as `up-to-date` rather than falsely `needs-publish`.
 */
export function highestKnownVersion(
  record: ExtensionRecord,
): { version: string; channel: string } {
  const top = highestPublished(record.published);
  if (compareCalVer(record.installed.version, top.version) > 0) {
    return {
      version: record.installed.version,
      channel: record.installed.channel || "unknown",
    };
  }
  return top;
}

/**
 * True when the on-disk version is ahead of everything we can prove published.
 *
 * Being ahead of the *lockfile* only proves the local version is newer than
 * what this machine pulled — not that no newer version was published elsewhere.
 * So this is "possibly needs publishing"; {@link needsPublish} narrows it to a
 * confirmed need using only authoritative (`registry`/`cache`) data.
 */
export function isAheadOfKnown(record: ExtensionRecord): boolean {
  if (!record.onDiskVersion) return false;
  return compareCalVer(
    record.onDiskVersion,
    highestKnownVersion(record).version,
  ) >
    0;
}

/**
 * True when the on-disk version is confirmed ahead of what is published.
 *
 * Only authoritative published data (`registry`, or a previous online run's
 * `cache`) can confirm this. When all we have is the lockfile lower bound,
 * "ahead" means "unknown", not "needs publishing" — a lack of knowledge must
 * never be presented as a requirement to publish.
 */
export function needsPublish(record: ExtensionRecord): boolean {
  return isAheadOfKnown(record) && publishedResolved(record);
}

/**
 * True when the extension is ahead of everything known but the published state
 * was not authoritative this run, so we cannot say whether it needs publishing.
 */
export function needsPublishUnknown(record: ExtensionRecord): boolean {
  return isAheadOfKnown(record) && !publishedResolved(record);
}

/** A short human note explaining where the published state came from. */
function sourceNote(record: ExtensionRecord): string {
  switch (record.publishedSource) {
    case "cache":
      return record.publishedAsOf
        ? `Published state from a previous run (${record.publishedAsOf}); may be out of date — re-run online to confirm`
        : "Published state from a previous run; may be out of date — re-run online to confirm";
    case "lockfile":
      return "Published state unknown — only the lockfile is available (offline); re-run online to confirm";
    default:
      return "Published state unknown — no registry or lockfile data; re-run online to confirm";
  }
}

/**
 * Advise a target channel from the published trend and check health.
 *
 * Reports all channels separately; this is only a recommendation. The ladder is
 * deliberately conservative and follows the repo's existing beta-first trend:
 * never-published or unclean extensions go to `beta`; an extension that already
 * has an advanced line keeps feeding it; otherwise the current trend continues.
 */
export function adviseChannel(
  record: ExtensionRecord,
  threshold = 75,
): ChannelAdvice {
  if (!record.onDiskVersion) {
    return {
      channel: "",
      reason: "No on-disk version to publish",
      confidence: "low",
    };
  }
  const docsFail = record.docsScore !== null && record.docsScore < threshold;
  const unhealthy = record.hygieneFailures.length > 0 || docsFail;
  // If the published state was not authoritative this run, `published` is only
  // a lower bound; do not claim the extension was never published.
  if (!publishedResolved(record)) {
    return {
      channel: "beta",
      reason: sourceNote(record),
      confidence: "low",
    };
  }
  if (neverPublished(record.published)) {
    return {
      channel: "beta",
      reason: "Never published — prove it on beta first",
      confidence: "high",
    };
  }
  if (unhealthy) {
    return {
      channel: "beta",
      reason: docsFail
        ? `Docs score ${record.docsScore} below threshold ${threshold} — stay on beta`
        : "Hygiene checks failing — stay on beta",
      confidence: "high",
    };
  }
  if (record.published.stable) {
    return {
      channel: "stable",
      reason: "Has a stable line and checks pass — continue on stable",
      confidence: "medium",
    };
  }
  if (record.published.rc) {
    return {
      channel: "rc",
      reason: "Has an rc line and checks pass — continue on rc",
      confidence: "medium",
    };
  }
  return {
    channel: "beta",
    reason: "Published on beta only — existing trend is beta",
    confidence: "medium",
  };
}

/** True when the extension has any dirty path. */
export function isDirty(record: ExtensionRecord): boolean {
  return record.dirtyFiles.length > 0;
}

/** Build the dependency edges for a set of local extension names. */
export function buildEdges(
  records: ExtensionRecord[],
  localNames: Set<string>,
): GraphEdge[] {
  const edges: GraphEdge[] = [];
  for (const record of records) {
    for (const dep of record.dependencies) {
      if (dep === record.name) continue; // ignore a self-edge
      edges.push({
        from: record.name,
        to: dep,
        external: !localNames.has(dep),
      });
    }
  }
  return edges;
}

/**
 * Topologically order local extension names, dependencies first.
 *
 * Kahn's algorithm over the dependency relation. On a cycle the remaining nodes
 * are appended in sorted order so the output is deterministic, and their names
 * are returned in `cycle`.
 */
export function topologicalOrder(
  names: string[],
  dependencies: Map<string, string[]>,
): { order: string[]; cycle: string[] } {
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const name of names) indegree.set(name, 0);
  for (const name of names) {
    for (const dep of dependencies.get(name) ?? []) {
      if (!indegree.has(dep)) continue; // external — not part of the order
      indegree.set(name, (indegree.get(name) ?? 0) + 1);
      const list = dependents.get(dep) ?? [];
      list.push(name);
      dependents.set(dep, list);
    }
  }
  const queue = names
    .filter((n) => (indegree.get(n) ?? 0) === 0)
    .sort((a, b) => a.localeCompare(b));
  const order: string[] = [];
  while (queue.length) {
    const name = queue.shift() as string;
    order.push(name);
    for (const dependent of dependents.get(name) ?? []) {
      const next = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, next);
      if (next === 0) {
        queue.push(dependent);
        queue.sort((a, b) => a.localeCompare(b));
      }
    }
  }
  let cycle: string[] = [];
  if (order.length < names.length) {
    cycle = names.filter((n) => !order.includes(n)).sort((a, b) =>
      a.localeCompare(b)
    );
    order.push(...cycle);
  }
  return { order, cycle };
}

/**
 * Assemble the graph from records: edges, external nodes, topological order,
 * and per-node publish state (blocked when a dependency must ship first).
 */
export function buildGraph(records: ExtensionRecord[]): Graph {
  const localNames = new Set(records.map((r) => r.name));
  const byName = new Map(records.map((r) => [r.name, r]));
  const edges = buildEdges(records, localNames);

  const dependencies = new Map<string, string[]>();
  for (const record of records) {
    dependencies.set(
      record.name,
      record.dependencies.filter((d) => d !== record.name),
    );
  }
  const { order, cycle } = topologicalOrder(
    records.map((r) => r.name),
    dependencies,
  );

  // `needs-publish` requires authoritative published data. `unknown` covers an
  // on-disk version ahead of a non-authoritative lower bound (offline/lockfile);
  // it is ignorance, never a claim that publishing is required.
  const publishable = new Set(
    records.filter((r) => needsPublish(r)).map((r) => r.name),
  );
  const unknown = new Set(
    records.filter((r) => needsPublishUnknown(r)).map((r) => r.name),
  );
  const publishState = new Map<string, PublishState>();
  for (const name of order) {
    const localDeps = (dependencies.get(name) ?? []).filter((d) =>
      localNames.has(d)
    );
    // `blocked` is only claimed on a *confirmed* pending dependency; an unknown
    // dependency does not justify claiming the dependent is blocked.
    const blocked = localDeps.some((d) => {
      const s = publishState.get(d);
      return s === "needs-publish" || s === "blocked";
    });
    if (blocked) publishState.set(name, "blocked");
    else if (unknown.has(name)) publishState.set(name, "unknown");
    else if (publishable.has(name)) publishState.set(name, "needs-publish");
    else publishState.set(name, "up-to-date");
  }

  const externalNames = new Set<string>();
  for (const edge of edges) {
    if (edge.external) externalNames.add(edge.to);
  }

  const nodes: GraphNode[] = order.map((name) => {
    const record = byName.get(name) as ExtensionRecord;
    return {
      name,
      onDiskVersion: record.onDiskVersion,
      publishState: publishState.get(name) ?? "up-to-date",
      channelAdvice: adviseChannel(record),
    };
  });

  const externalNodes: ExternalNode[] = [...externalNames]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({
      name,
      publishedStable: "",
      publishedBeta: "",
    }));

  return { nodes, edges, externalNodes, publishOrder: order, cycle };
}

/** One ordered step in the publish plan. */
export interface PlanStep {
  /** 1-based position in the publish order. */
  order: number;
  /** Extension to publish. */
  name: string;
  /** Ready, or blocked on a dependency that must publish first. */
  state: "ready" | "blocked";
  /** Dependencies that must publish before this one. */
  blockers: string[];
  /** Advised channel. */
  targetChannel: string;
  /** Why that channel was advised. */
  channelReason: string;
  /** Exact `swamp extension push` command. */
  command: string;
  /** Hygiene failures to fix first (empty = clean). */
  hygieneFailures: string[];
}

/**
 * Build the ordered publish plan from records and their graph.
 *
 * Only extensions that need publishing (or are blocked by one that does) appear.
 * A step is `blocked` while any local dependency is itself pending, so the plan
 * always lists dependencies first.
 */
export function buildPlan(
  records: ExtensionRecord[],
  graph: Graph,
): PlanStep[] {
  const byName = new Map(records.map((r) => [r.name, r]));
  const state = new Map(graph.nodes.map((n) => [n.name, n.publishState]));
  const steps: PlanStep[] = [];
  let order = 0;
  for (const name of graph.publishOrder) {
    const nodeState = state.get(name);
    if (nodeState !== "needs-publish" && nodeState !== "blocked") continue;
    const record = byName.get(name) as ExtensionRecord;
    const blockers = record.dependencies.filter((d) => {
      const s = state.get(d);
      return s === "needs-publish" || s === "blocked";
    });
    const advice = adviseChannel(record);
    steps.push({
      order: ++order,
      name,
      state: nodeState === "blocked" ? "blocked" : "ready",
      blockers,
      targetChannel: advice.channel,
      channelReason: advice.reason,
      command: advice.channel
        ? `swamp extension push ${record.manifestPath} --channel ${advice.channel}`
        : "",
      hygieneFailures: record.hygieneFailures,
    });
  }
  return steps;
}
