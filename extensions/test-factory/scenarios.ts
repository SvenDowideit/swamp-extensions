/**
 * Test-factory scenario catalog.
 *
 * A *scenario* is one distro + one swamp deployment topology, run in
 * containers. This module is pure: it describes the catalog, resolves a
 * user's filter into a concrete scenario list, and validates a user-supplied
 * scenario file. The filesystem and subprocess work lives in `docker.ts` and
 * `test_factory.ts`.
 *
 * @module
 */

/** A Linux distribution the factory can boot in a container. */
export interface Distro {
  /** Short catalog name used in scenario names and filters. */
  name: string;
  /** Base container image. */
  image: string;
  /** Package family — drives how prerequisites are installed. */
  family: "debian" | "rpm" | "apk";
  /** Package manager command used to install prerequisites. */
  packageManager: "apt" | "dnf" | "apk";
  /** Whether systemd can be installed and run as PID 1. */
  systemd: boolean;
  /**
   * Whether the published swamp binary can execute here. swamp ships a
   * glibc-linked binary, so musl-only distros (Alpine) cannot run it; those
   * scenarios are still exercised to confirm the failure is diagnosed.
   */
  runnable: boolean;
  /** Why the distro is interesting, shown in `listScenarios`. */
  notes: string;
}

/**
 * The built-in distro catalog.
 *
 * Covers the three package families the request called out — apk (Alpine,
 * Wolfi), deb (Debian, Ubuntu) and rpm (Fedora, Rocky) — plus systemd and
 * non-systemd variants.
 */
export const DISTROS: Distro[] = [
  {
    name: "alpine",
    image: "alpine:3.20",
    family: "apk",
    packageManager: "apk",
    systemd: false,
    runnable: false,
    notes:
      "musl-only — swamp's glibc binary cannot run (expected diagnostic failure)",
  },
  {
    name: "wolfi",
    image: "cgr.dev/chainguard/wolfi-base:latest",
    family: "apk",
    packageManager: "apk",
    systemd: false,
    runnable: true,
    notes: "apk-based but glibc — swamp runs without systemd",
  },
  {
    name: "debian",
    image: "debian:bookworm-slim",
    family: "debian",
    packageManager: "apt",
    systemd: true,
    runnable: true,
    notes: "glibc baseline, systemd-capable",
  },
  {
    name: "ubuntu",
    image: "ubuntu:24.04",
    family: "debian",
    packageManager: "apt",
    systemd: true,
    runnable: true,
    notes: "glibc, systemd-capable, the common production host",
  },
  {
    name: "fedora",
    image: "fedora:40",
    family: "rpm",
    packageManager: "dnf",
    systemd: true,
    runnable: true,
    notes: "rpm family, systemd as PID 1",
  },
  {
    name: "rocky",
    image: "rockylinux:9",
    family: "rpm",
    packageManager: "dnf",
    systemd: true,
    runnable: true,
    notes: "rpm family (RHEL-compatible), systemd as PID 1",
  },
];

/** Index the catalog by name for O(1) lookups. */
export function distroByName(name: string): Distro | undefined {
  return DISTROS.find((d) => d.name === name);
}

/** How swamp is deployed across the container(s) in a scenario. */
export type Topology = "standalone" | "serve" | "fleet";

/** A concrete, runnable test scenario. */
export interface Scenario {
  /** Unique catalog name, e.g. `ubuntu-systemd-fleet-2`. */
  name: string;
  /** Distro catalog name. */
  distro: string;
  /** Run systemd as PID 1 (requires `distro.systemd`). */
  systemd: boolean;
  /** swamp deployment topology. */
  topology: Topology;
  /** Worker count for the `fleet` topology; ignored otherwise. */
  workers: number;
  /** Pin a specific swamp release tag; empty means the resolved latest. */
  swampVersion?: string;
  /**
   * Expected outcome. `fail` marks a scenario that is known not to work (for
   * example Alpine/musl) so a diagnosed failure counts as a pass.
   */
  expected: "pass" | "fail";
  /** Human-readable rationale, surfaced in the report. */
  note?: string;
}

/**
 * The built-in named scenarios.
 *
 * These are the "one click" entry points; any field can be overridden per run.
 */
export function catalog(): Scenario[] {
  return [
    {
      name: "alpine-standalone",
      distro: "alpine",
      systemd: false,
      topology: "standalone",
      workers: 0,
      expected: "fail",
      note:
        "Alpine is musl-only; swamp's glibc binary fails to load. Confirms the harness detects and explains the failure.",
    },
    {
      name: "wolfi-standalone",
      distro: "wolfi",
      systemd: false,
      topology: "standalone",
      workers: 0,
      expected: "pass",
    },
    {
      name: "debian-standalone",
      distro: "debian",
      systemd: false,
      topology: "standalone",
      workers: 0,
      expected: "pass",
    },
    {
      name: "ubuntu-standalone",
      distro: "ubuntu",
      systemd: false,
      topology: "standalone",
      workers: 0,
      expected: "pass",
    },
    {
      name: "ubuntu-systemd-standalone",
      distro: "ubuntu",
      systemd: true,
      topology: "standalone",
      workers: 0,
      expected: "pass",
    },
    {
      name: "fedora-standalone",
      distro: "fedora",
      systemd: false,
      topology: "standalone",
      workers: 0,
      expected: "pass",
    },
    {
      name: "fedora-systemd-standalone",
      distro: "fedora",
      systemd: true,
      topology: "standalone",
      workers: 0,
      expected: "pass",
    },
    {
      name: "rocky-standalone",
      distro: "rocky",
      systemd: false,
      topology: "standalone",
      workers: 0,
      expected: "pass",
    },
    {
      name: "rocky-systemd-standalone",
      distro: "rocky",
      systemd: true,
      topology: "standalone",
      workers: 0,
      expected: "pass",
    },
    {
      name: "ubuntu-serve",
      distro: "ubuntu",
      systemd: false,
      topology: "serve",
      workers: 0,
      expected: "pass",
    },
    {
      name: "ubuntu-fleet-2",
      distro: "ubuntu",
      systemd: false,
      topology: "fleet",
      workers: 2,
      expected: "pass",
    },
    {
      name: "ubuntu-systemd-fleet-2",
      distro: "ubuntu",
      systemd: true,
      topology: "fleet",
      workers: 2,
      expected: "pass",
    },
    {
      name: "rocky-systemd-fleet-2",
      distro: "rocky",
      systemd: true,
      topology: "fleet",
      workers: 2,
      expected: "pass",
    },
  ];
}

/** Filter understood by {@link resolveScenarios}. */
export interface ScenarioFilter {
  /** Named scenarios to run verbatim (each may still be overridden). */
  scenario?: string;
  /** Distro names to include. */
  distro?: string;
  /** Topologies to include. */
  topology?: string;
  /** `true`/`false` to require a systemd or non-systemd host. */
  systemd?: boolean;
  /** Worker count override for fleet scenarios. */
  workers?: number;
  /** Pin the swamp release tag for every scenario. */
  swampVersion?: string;
}

/** Split a comma/space separated filter value into trimmed tokens. */
export function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Resolve a filter into concrete scenarios.
 *
 * Precedence:
 *  1. `scenario` names (comma separated) select exact catalog entries; unknown
 *     names raise an error listing the catalog.
 *  2. `distro` / `topology` / `systemd` / `workers` narrow the catalog.
 *  3. With no filter at all, the default set is every *runnable* standalone
 *     distro scenario — the fast, dependency-free smoke matrix.
 *
 * Any `systemd`/`workers`/`swampVersion` override is applied to the selection.
 */
export function resolveScenarios(
  filter: ScenarioFilter = {},
  cat: Scenario[] = catalog(),
): Scenario[] {
  const names = splitList(filter.scenario);
  const distros = splitList(filter.distro);
  const topologies = splitList(filter.topology);

  let selected: Scenario[];
  if (names.length > 0) {
    const byName = new Map(cat.map((s) => [s.name, s]));
    const unknown = names.filter((n) => !byName.has(n));
    if (unknown.length > 0) {
      throw new Error(
        `Unknown scenario(s): ${unknown.join(", ")}. ` +
          `Available: ${cat.map((s) => s.name).join(", ")}`,
      );
    }
    selected = names.map((n) => ({ ...byName.get(n)! }));
  } else if (
    distros.length > 0 || topologies.length > 0 || filter.systemd !== undefined
  ) {
    if (distros.length > 0) {
      const unknown = distros.filter((d) => !distroByName(d));
      if (unknown.length > 0) {
        throw new Error(
          `Unknown distro(s): ${unknown.join(", ")}. ` +
            `Available: ${DISTROS.map((d) => d.name).join(", ")}`,
        );
      }
    }
    // Requesting systemd on a distro that cannot run it is a configuration
    // error — surface it rather than silently matching nothing.
    if (filter.systemd === true) {
      const incapable = distros.filter((d) => !distroByName(d)?.systemd);
      if (incapable.length > 0) {
        throw new Error(
          `Cannot request systemd for distro(s): ${incapable.join(", ")}`,
        );
      }
    }
    selected = cat.filter((s) => {
      if (distros.length > 0 && !distros.includes(s.distro)) return false;
      if (topologies.length > 0 && !topologies.includes(s.topology)) {
        return false;
      }
      if (filter.systemd !== undefined && s.systemd !== filter.systemd) {
        return false;
      }
      return true;
    }).map((s) => ({ ...s }));
  } else {
    selected = cat.filter(
      (s) =>
        s.topology === "standalone" &&
        s.expected === "pass" &&
        (distroByName(s.distro)?.runnable ?? false),
    ).map((s) => ({ ...s }));
  }

  return selected.map((s) => applyOverrides(s, filter, cat));
}

/** Apply per-run overrides onto a selected scenario. */
function applyOverrides(
  scenario: Scenario,
  filter: ScenarioFilter,
  cat: Scenario[],
): Scenario {
  const out: Scenario = { ...scenario };
  if (filter.systemd !== undefined) out.systemd = filter.systemd;
  if (filter.workers !== undefined && out.topology === "fleet") {
    out.workers = filter.workers;
  }
  if (filter.swampVersion) out.swampVersion = filter.swampVersion;
  // A `systemd: true` override on a distro that cannot run systemd is a
  // configuration error, not a silent downgrade.
  if (out.systemd && !distroByName(out.distro)?.systemd) {
    throw new Error(
      `Scenario ${out.name}: distro "${out.distro}" cannot run systemd`,
    );
  }
  // Keep the name honest when an override changes the shape.
  if (
    filter.systemd !== undefined ||
    filter.workers !== undefined ||
    (filter.swampVersion && !scenario.swampVersion)
  ) {
    const base = cat.find((s) => s.name === scenario.name);
    out.name = base ? deriveName(out, base) : `${out.name}`;
  }
  return out;
}

/** Build a deterministic scenario name from its shape. */
export function deriveName(s: Scenario, base?: Scenario): string {
  const parts = [s.distro];
  if (s.systemd) parts.push("systemd");
  if (s.topology === "standalone") {
    parts.push("standalone");
  } else if (s.topology === "serve") {
    parts.push("serve");
  } else {
    parts.push(`fleet-${s.workers}`);
  }
  const name = parts.join("-");
  // If the shape is unchanged from the catalog entry, prefer its stable name.
  if (
    base &&
    base.topology === s.topology &&
    base.workers === s.workers &&
    base.systemd === s.systemd
  ) {
    return base.name;
  }
  return name;
}

/**
 * Parse a user-supplied scenario file (JSON or a small YAML subset).
 *
 * Deliberately dependency-free: the file is a JSON array of scenario objects,
 * or a YAML list using `- key: value` lines. `resolveScenarios` is then run
 * over the result so overrides and validation still apply.
 */
export function parseScenarioFile(text: string): Scenario[] {
  const trimmed = text.trim();
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as Partial<Scenario>[];
    return parsed.map(normalizeScenario);
  }
  const scenarios: Partial<Scenario>[] = [];
  let current: Partial<Scenario> | null = null;
  for (const raw of trimmed.split("\n")) {
    const line = raw.replace(/\s+#.*$/, "");
    if (!line.trim()) continue;
    const item = /^\s*-\s+(\w+):\s*(.*)$/.exec(line);
    if (item) {
      current = {};
      scenarios.push(current);
      assign(current, item[1], item[2]);
      continue;
    }
    const kv = /^\s+(\w+):\s*(.*)$/.exec(line);
    if (kv && current) {
      assign(current, kv[1], kv[2]);
    }
  }
  return scenarios.map(normalizeScenario);
}

/** Assign a scalar parsed from YAML-ish text onto a scenario field. */
function assign(target: Partial<Scenario>, key: string, raw: string): void {
  const value = raw.replace(/^["']|["']$/g, "");
  switch (key) {
    case "workers":
      target.workers = Number(value);
      break;
    case "systemd":
      target.systemd = value === "true";
      break;
    case "name":
    case "distro":
    case "topology":
    case "swampVersion":
      (target as Record<string, unknown>)[key] = value;
      break;
    case "expected":
      target.expected = value === "fail" ? "fail" : "pass";
      break;
    case "note":
      target.note = value;
      break;
    default:
      break;
  }
}

/** Fill in defaults for a partial scenario from a file. */
export function normalizeScenario(s: Partial<Scenario>): Scenario {
  const distro = s.distro ?? "ubuntu";
  const topology = (s.topology ?? "standalone") as Topology;
  const workers = s.workers ?? (topology === "fleet" ? 2 : 0);
  const systemd = s.systemd ?? false;
  return {
    name: s.name ??
      deriveName({ distro, topology, workers, systemd } as Scenario),
    distro,
    systemd,
    topology,
    workers,
    swampVersion: s.swampVersion,
    expected: s.expected ?? "pass",
    note: s.note,
  };
}

/**
 * Build a scenario id usable as a resource instance name and docker label.
 *
 * Docker labels allow `[a-zA-Z0-9_.-]`; swamp instance names allow
 * `[a-z0-9_-]`. We keep the swamp-safe subset.
 */
export function scenarioSlug(s: Scenario): string {
  return s.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(
    /^-+|-+$/g,
    "",
  );
}
