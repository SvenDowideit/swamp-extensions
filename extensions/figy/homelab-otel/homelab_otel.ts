/**
 * @figy/homelab-otel
 *
 * The site catalog for the fi.gy homelab observability deployment. It encodes
 * the private facts the generic @svendowideit models must not know: the
 * `otel.fi.gy` sub-zone, the per-mesh gateway endpoints, the DNS record set, and
 * the hosts' role/tier assignments. Other models and workflows reference the
 * emitted `topology` resource via CEL instead of hardcoding names.
 *
 * @module
 */
import { z } from "npm:zod@4";

// ---------------------------------------------------------------------------
// Global args
// ---------------------------------------------------------------------------

const GlobalArgsSchema = z.object({
  deploymentEnvironment: z.enum(["dev", "uat", "prod"]).default("dev").describe(
    "Which environment this catalog describes",
  ),
}).strict();

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

// ---------------------------------------------------------------------------
// Output schemas
// ---------------------------------------------------------------------------

const RecordSchema = z.object({
  name: z.string(),
  type: z.string(),
  target: z.string(),
  purpose: z.string(),
});

const HostSchema = z.object({
  name: z.string(),
  role: z.string(),
  tier: z.string(),
  mesh: z.string(),
  os: z.string(),
});

const TopologyOutputSchema = z.object({
  zone: z.string(),
  settingsHostname: z.string(),
  storeHostname: z.string(),
  certificate: z.string(),
  records: z.array(RecordSchema),
  endpoints: z.array(
    z.object({
      mesh: z.string(),
      otlp_grpc: z.string(),
      otlp_http: z.string(),
    }),
  ),
  hosts: z.array(HostSchema),
  deploymentEnvironment: z.string(),
  generatedAt: z.string(),
});

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/** A DNS record in the `otel.fi.gy` sub-zone. */
export interface DnsRecord {
  /** Record name (FQDN). */
  name: string;
  /** Record type (A/AAAA, SRV, …). */
  type: string;
  /** Record target. */
  target: string;
  /** Why the record exists. */
  purpose: string;
}

/** A host in the homelab and its role. */
export interface Host {
  /** Human host name. */
  name: string;
  /** Role in the fleet. */
  role: string;
  /** Device tier. */
  tier: string;
  /** Mesh it joins. */
  mesh: string;
  /** Operating system family. */
  os: string;
}

/** A gateway endpoint per mesh. */
export interface Endpoint {
  /** Mesh name. */
  mesh: string;
  /** OTLP gRPC host:port. */
  otlp_grpc: string;
  /** OTLP HTTP host:port. */
  otlp_http: string;
}

/** The fi.gy observability topology. */
export interface Topology {
  /** The dedicated sub-zone. */
  zone: string;
  /** Settings hostname. */
  settingsHostname: string;
  /** OpenObserve store hostname. */
  storeHostname: string;
  /** Wildcard certificate subject. */
  certificate: string;
  /** DNS records. */
  records: DnsRecord[];
  /** Gateway endpoints. */
  endpoints: Endpoint[];
  /** Homelab hosts. */
  hosts: Host[];
  /** Environment this catalog describes. */
  deploymentEnvironment: string;
  /** Generation timestamp. */
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// The site definition (the whole point of this extension)
// ---------------------------------------------------------------------------

/** DNS records for the `otel.fi.gy` sub-zone. */
export const OTEL_RECORDS: DnsRecord[] = [
  {
    name: "otel.fi.gy",
    type: "A/AAAA",
    target: "core node",
    purpose: "Zone apex; the store name",
  },
  {
    name: "otlp.fi.gy",
    type: "A/AAAA",
    target: "otel-gateway",
    purpose: "OTLP ingest (tailscale)",
  },
  {
    name: "otlp.wg.otel.fi.gy",
    type: "A/AAAA",
    target: "otel-gateway",
    purpose: "OTLP ingest (wireguard)",
  },
  {
    name: "obs.otel.fi.gy",
    type: "A/AAAA",
    target: "openobserve",
    purpose: "OpenObserve UI/API (obs.fi.gy is reserved for video)",
  },
  {
    name: "settings.otel.fi.gy",
    type: "A/AAAA",
    target: "caddy",
    purpose: "HTTP settings contract",
  },
  {
    name: "*.otel.fi.gy",
    type: "A/AAAA",
    target: "core node",
    purpose: "Wildcard for managed hosts",
  },
  {
    name: "_otlp-http._tcp.otel.fi.gy",
    type: "SRV",
    target: "otlp.fi.gy:4318",
    purpose: "Service discovery",
  },
];

/** Gateway endpoints per mesh. */
export const OTEL_ENDPOINTS: Endpoint[] = [
  {
    mesh: "tailscale",
    otlp_grpc: "otlp.fi.gy:4317",
    otlp_http: "otlp.fi.gy:4318",
  },
  {
    mesh: "wireguard",
    otlp_grpc: "otlp.wg.otel.fi.gy:4317",
    otlp_http: "otlp.wg.otel.fi.gy:4318",
  },
];

/** The homelab hosts and their roles/tiers. */
export const OTEL_HOSTS: Host[] = [
  {
    name: "dev (this machine)",
    role: "authoring + dev e2e",
    tier: "T1",
    mesh: "tailscale",
    os: "linux",
  },
  {
    name: "x1yoga",
    role: "workstation",
    tier: "T1",
    mesh: "tailscale",
    os: "linux",
  },
  {
    name: "t440s",
    role: "UAT core node",
    tier: "T1",
    mesh: "tailscale",
    os: "linux",
  },
  {
    name: "xeon",
    role: "prod core node + storage",
    tier: "T1",
    mesh: "tailscale",
    os: "linux",
  },
];

/** The dedicated observability sub-zone. */
export const OTEL_ZONE = "otel.fi.gy";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Build the topology object from the global args. */
export function buildTopology(
  deploymentEnvironment: string,
): Topology {
  return {
    zone: OTEL_ZONE,
    settingsHostname: `settings.${OTEL_ZONE}`,
    storeHostname: `obs.${OTEL_ZONE}`,
    certificate: `*.${OTEL_ZONE}`,
    records: OTEL_RECORDS,
    endpoints: OTEL_ENDPOINTS,
    hosts: OTEL_HOSTS,
    deploymentEnvironment,
    generatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

/** The swamp model definition for `@figy/homelab-otel`. */
export const model = {
  type: "@figy/homelab-otel",
  version: "2026.10.03.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.10.03.1",
      description:
        "Initial release: emit the fi.gy otel.fi.gy topology (zone, records, per-mesh endpoints, hosts) as a typed resource for other models and workflows to reference via CEL.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    topology: {
      description: "The fi.gy observability topology",
      schema: TopologyOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    describe: {
      description:
        "Emit the site topology (zone, DNS records, endpoints, hosts) as a resource",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: {
          globalArgs: GlobalArgs;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const topology = buildTopology(
          context.globalArgs.deploymentEnvironment,
        );
        const handle = await context.writeResource(
          "topology",
          "current",
          topology as unknown as Record<string, unknown>,
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
