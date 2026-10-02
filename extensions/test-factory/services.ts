/**
 * Container test-system description for the test factory.
 *
 * A candidate extension's `test-factory.yaml` may declare a small container
 * topology to run *around* the swamp harness — the services a real integration
 * needs but that swamp itself does not provide. The motivating case is
 * `@svendowideit/caddy`'s DNS tests: an authoritative BIND container that Caddy
 * writes A records into, plus a second network so one name resolves to several
 * addresses, all observed with `dig`/`curl` from the swamp container.
 *
 * This module is pure: it parses the `networks:` / `harness:` / `services:`
 * keys into typed specs and derives the shell variables the tests can reference.
 * All Docker work lives in `docker.ts`; orchestration in `test_factory.ts`.
 *
 * Backwards compatible by construction: a file with no `services:` (or no
 * `networks:`/`harness:`) parses to an empty {@link TestSystem}, and the model
 * behaves exactly as before.
 *
 * @module
 */
import { parse as parseYaml } from "jsr:@std/yaml@1";

/** A docker network the test system puts containers on. */
export interface NetworkSpec {
  /** Short catalog name used by `harness:`/`services:` attachments. */
  name: string;
  /** CIDR subnet to create the network with (empty = docker-chosen). */
  subnet: string;
}

/** One container-to-network attachment with an optional static address. */
export interface AttachSpec {
  /** Network catalog name. */
  network: string;
  /** Static IPv4 address on that network (empty = dynamic). */
  ipv4Address: string;
}

/** How to wait for a service to be ready before the tests run. */
export interface HealthcheckSpec {
  /** Command run inside the container; ready when it exits 0. */
  command: string[];
  /** Seconds between attempts. */
  intervalSeconds: number;
  /** Maximum attempts before giving up. */
  retries: number;
}

/** One auxiliary container the tests need (e.g. BIND). */
export interface ServiceSpec {
  /** Container name / network alias the harness reaches it by. */
  name: string;
  /** Prebuilt image to run (empty when `build` is set). */
  image: string;
  /** Build-context directory, relative to the extension manifest dir. */
  build: string;
  /** Dockerfile path relative to the build context (default `Dockerfile`). */
  dockerfile: string;
  /** Networks to attach it to. */
  networks: AttachSpec[];
  /** Run the container privileged. */
  privileged: boolean;
  /** Environment variables. */
  environment: Record<string, string>;
  /** Bind mounts (`hostPath:/containerPath[:ro]`); host paths are relative to the manifest dir. */
  mounts: string[];
  /** Override the container command. */
  command: string[];
  /** Readiness probe; absent means start and do not wait. */
  healthcheck?: HealthcheckSpec;
  /** Fixed seconds to sleep after start, used when no healthcheck is set. */
  waitForSeconds: number;
}

/** The swamp harness container's own declarations. */
export interface HarnessSpec {
  /** Networks the swamp container joins (static IPs prove multi-endpoint DNS). */
  networks: AttachSpec[];
  /** Install `dig` into the harness image (for DNS assertions). */
  dig: boolean;
}

/** The whole container test system described by a `test-factory.yaml`. */
export interface TestSystem {
  /** Networks to create. */
  networks: NetworkSpec[];
  /** The harness container's declarations. */
  harness: HarnessSpec;
  /** Auxiliary services to start. */
  services: ServiceSpec[];
}

/** True when the test system declares anything to provision. */
export function isEmptySystem(system: TestSystem): boolean {
  return system.networks.length === 0 && system.services.length === 0 &&
    system.harness.networks.length === 0 && !system.harness.dig;
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function strArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x));
  if (typeof v === "string" && v.length > 0) return [v];
  return [];
}

function record(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = String(val);
    }
  }
  return out;
}

/**
 * Parse a mapping of `networkName: { ipv4_address: ... }` (the docker-compose
 * shape) into attachments. A bare string value is treated as the address; a
 * `null` value attaches with a dynamic address.
 */
function parseAttachments(v: unknown): AttachSpec[] {
  const out: AttachSpec[] = [];
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [network, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "string") {
      out.push({ network, ipv4Address: val });
    } else if (val && typeof val === "object") {
      const o = val as Record<string, unknown>;
      out.push({ network, ipv4Address: str(o.ipv4_address ?? o.ipv4Address) });
    } else {
      out.push({ network, ipv4Address: "" });
    }
  }
  return out;
}

function parseNetworks(v: unknown): NetworkSpec[] {
  const out: NetworkSpec[] = [];
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [name, val] of Object.entries(v as Record<string, unknown>)) {
    const o = (val && typeof val === "object")
      ? val as Record<string, unknown>
      : {};
    out.push({ name, subnet: str(o.subnet ?? o.ipam_subnet) });
  }
  return out;
}

function parseHealthcheck(v: unknown): HealthcheckSpec | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const command = strArray(o.command ?? o.test);
  if (command.length === 0) return undefined;
  return {
    command,
    intervalSeconds: num(o.intervalSeconds ?? o.interval_seconds, 2),
    retries: num(o.retries, 30),
  };
}

function parseService(name: string, v: unknown): ServiceSpec {
  const o = (v && typeof v === "object" && !Array.isArray(v))
    ? v as Record<string, unknown>
    : {};
  return {
    name,
    image: str(o.image),
    build: str(o.build),
    dockerfile: str(o.dockerfile, "Dockerfile"),
    networks: parseAttachments(o.networks),
    privileged: o.privileged === true,
    environment: record(o.environment),
    mounts: strArray(o.mounts ?? o.volumes),
    command: strArray(o.command),
    healthcheck: parseHealthcheck(o.healthcheck),
    waitForSeconds: num(o.waitForSeconds ?? o.wait_for_seconds, 0),
  };
}

function parseHarness(v: unknown): HarnessSpec {
  const o = (v && typeof v === "object" && !Array.isArray(v))
    ? v as Record<string, unknown>
    : {};
  return { networks: parseAttachments(o.networks), dig: o.dig === true };
}

/** Parse a `test-factory.yaml` document into a {@link TestSystem}. */
export function parseTestSystem(text: string): TestSystem {
  const doc = parseYaml(text) as unknown;
  if (doc === null || doc === undefined) {
    return {
      networks: [],
      harness: { networks: [], dig: false },
      services: [],
    };
  }
  if (typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error(
      "test-factory.yaml: expected a mapping with a `tests:` key",
    );
  }
  const d = doc as Record<string, unknown>;
  const services: ServiceSpec[] = [];
  if (
    d.services && typeof d.services === "object" && !Array.isArray(d.services)
  ) {
    for (
      const [name, val] of Object.entries(d.services as Record<string, unknown>)
    ) {
      services.push(parseService(name, val));
    }
  }
  return {
    networks: parseNetworks(d.networks),
    harness: parseHarness(d.harness),
    services,
  };
}

/** The `TF_*`-prefixed shell variable name for a service + network. */
function varName(service: string, network?: string): string {
  const slug = service.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  return network
    ? `TF_${slug}_IP_${network.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`
    : `TF_${slug}_IP`;
}

/**
 * Derive the shell variables the tests can reference, so a test never has to
 * hard-code an address that the topology already declares.
 *
 * For every service it exposes `TF_<SERVICE>_IP` (its first attachment's
 * address) and `TF_<SERVICE>_IP_<NETWORK>` per network; for the harness it
 * exposes `TF_HARNESS_IP_<NETWORK>`. A service is reachable by its name as a
 * docker network alias, so `dig @<service>` works without an IP variable.
 */
export function systemVariables(system: TestSystem): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const a of system.harness.networks) {
    if (a.ipv4Address) {
      vars[
        `TF_HARNESS_IP_${a.network.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`
      ] = a.ipv4Address;
    }
  }
  for (const s of system.services) {
    s.networks.forEach((a, i) => {
      if (!a.ipv4Address) return;
      vars[varName(s.name, a.network)] = a.ipv4Address;
      if (i === 0) vars[varName(s.name)] = a.ipv4Address;
    });
  }
  return vars;
}

/** Validate a test system, returning human-readable issues (empty = sound). */
export function lintTestSystem(system: TestSystem): string[] {
  const issues: string[] = [];
  const netNames = new Set(system.networks.map((n) => n.name));
  const checkAttach = (label: string, a: AttachSpec) => {
    if (!netNames.has(a.network)) {
      issues.push(`${label}: attaches to unknown network "${a.network}"`);
    }
    if (a.ipv4Address && !/^\d{1,3}(\.\d{1,3}){3}$/.test(a.ipv4Address)) {
      issues.push(
        `${label}: ipv4_address "${a.ipv4Address}" is not an IPv4 address`,
      );
    }
  };
  for (const a of system.harness.networks) checkAttach("harness", a);
  for (const s of system.services) {
    if (!s.image && !s.build) {
      issues.push(
        `service "${s.name}": needs an \`image\` or a \`build\` context`,
      );
    }
    if (s.image && s.build) {
      issues.push(
        `service "${s.name}": set either \`image\` or \`build\`, not both`,
      );
    }
    for (const a of s.networks) checkAttach(`service "${s.name}"`, a);
    if (s.healthcheck && s.healthcheck.retries <= 0) {
      issues.push(`service "${s.name}": healthcheck.retries must be positive`);
    }
  }
  for (const n of system.networks) {
    if (n.subnet && !/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(n.subnet)) {
      issues.push(`network "${n.name}": subnet "${n.subnet}" is not a CIDR`);
    }
  }
  // Two containers cannot claim the same static address on one network.
  const seen = new Map<string, string>();
  const claim = (who: string, a: AttachSpec) => {
    if (!a.ipv4Address) return;
    const key = `${a.network}\u0000${a.ipv4Address}`;
    const other = seen.get(key);
    if (other) {
      issues.push(
        `network "${a.network}": address ${a.ipv4Address} used by both "${other}" and "${who}"`,
      );
    }
    seen.set(key, who);
  };
  system.harness.networks.forEach((a) => claim("harness", a));
  for (const s of system.services) {
    s.networks.forEach((a) => claim(s.name, a));
  }
  return issues;
}
