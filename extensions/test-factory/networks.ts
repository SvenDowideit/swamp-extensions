/**
 * IPv4 subnet allocation for test-factory's declared test-system networks.
 *
 * A candidate's `test-factory.yaml` may pin subnets (so a static `ipv4_address`
 * is valid). Two problems with using them verbatim:
 *
 *   - a leftover network from a crashed/kept run already holds the subnet, and
 *   - under parallel agents, two runs of the same suite want the same subnet.
 *
 * So we treat the declared subnet as a **preference**: use it when it is free,
 * otherwise draw a free one from a private pool. Docker is the single arbiter per
 * host — it rejects an overlapping `network create` — so if we ever race another
 * process we simply get a "Pool overlaps" error and the caller retries the next
 * candidate. `keepOnFailure` still leaves a kept run's networks in place; the next
 * run just allocates around them.
 *
 * All IPv4 math is done on unsigned 32-bit integers.
 *
 * @module
 */

/** A parsed CIDR block. */
export interface Cidr {
  /** The network address as an unsigned 32-bit integer. */
  net: number;
  /** The prefix length (0-32). */
  prefix: number;
}

/** Parse dotted-quad IPv4 into an unsigned 32-bit integer. */
export function ipToInt(ip: string): number {
  const parts = ip.trim().split(".");
  if (parts.length !== 4) throw new Error(`not an IPv4 address: ${ip}`);
  let n = 0;
  for (const p of parts) {
    const octet = Number(p);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) {
      throw new Error(`not an IPv4 address: ${ip}`);
    }
    n = (n * 256) + octet;
  }
  return n >>> 0;
}

/** Render an unsigned 32-bit integer as dotted-quad IPv4. */
export function intToIp(n: number): string {
  const u = n >>> 0;
  return [(u >>> 24) & 255, (u >>> 16) & 255, (u >>> 8) & 255, u & 255].join(
    ".",
  );
}

/** Parse a CIDR (`a.b.c.d/len`); throws on malformed input. */
export function parseCidr(cidr: string): Cidr {
  const [addr, len, ...rest] = cidr.trim().split("/");
  if (len === undefined || rest.length > 0) {
    throw new Error(`not a CIDR: ${cidr}`);
  }
  const prefix = Number(len);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    throw new Error(`not a CIDR: ${cidr}`);
  }
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return { net: (ipToInt(addr) & mask) >>> 0, prefix };
}

/** The last address (broadcast) of a CIDR, inclusive. */
function broadcast(c: Cidr): number {
  const mask = c.prefix === 0 ? 0 : (0xffffffff << (32 - c.prefix)) >>> 0;
  return ((c.net | (~mask >>> 0)) >>> 0);
}

/** Whether two CIDR blocks share any address. */
export function subnetsOverlap(a: Cidr, b: Cidr): boolean {
  return a.net <= broadcast(b) && b.net <= broadcast(a);
}

/** True when `cidr` overlaps any block in `others`; unparseable others are ignored. */
function overlapsAny(cidr: Cidr, others: Cidr[]): boolean {
  return others.some((o) => subnetsOverlap(cidr, o));
}

/** Best-effort parse of a list of CIDRs, dropping anything malformed. */
export function parseCidrs(cidrs: string[]): Cidr[] {
  const out: Cidr[] = [];
  for (const c of cidrs) {
    try {
      out.push(parseCidr(c));
    } catch {
      // Ignore anything we cannot parse — it cannot overlap a valid CIDR.
    }
  }
  return out;
}

/**
 * The private pool test-factory allocates from when a preferred subnet is taken.
 * A /16 carved into /24s gives 256 candidates — far more than a sane number of
 * parallel runs — and it is a private range unlikely to collide with a real
 * network on the host.
 */
export const POOL_BASE = "10.213.0.0/16";

/** Every /24 candidate in {@link POOL_BASE}, in order. */
export function poolCandidates(): string[] {
  const base = parseCidr(POOL_BASE);
  const out: string[] = [];
  for (let i = 0; i < 256; i++) {
    out.push(`${intToIp((base.net + i * 256) >>> 0)}/24`);
  }
  return out;
}

/**
 * Choose a subnet for a declared network.
 *
 * Returns `preferred` when it is set and does not overlap anything already in
 * use or reserved, else the first free /24 from {@link poolCandidates}. Throws
 * when the preferred subnet is unusable and the pool is exhausted (which would
 * mean 256+ concurrent runs — a real problem worth surfacing).
 */
export function allocateSubnet(
  preferred: string,
  used: Cidr[],
  reserved: Cidr[],
  pool: string[] = poolCandidates(),
): string {
  const taken = [...used, ...reserved];
  if (preferred) {
    const p = parseCidr(preferred);
    if (!overlapsAny(p, taken)) return preferred;
  }
  for (const candidate of pool) {
    const c = parseCidr(candidate);
    if (!overlapsAny(c, taken)) return candidate;
  }
  throw new Error(
    `no free subnet in the pool (${POOL_BASE}) — ${taken.length} subnet(s) in use; too many parallel runs?`,
  );
}

/**
 * Remap a static IP from a declared subnet onto an allocated subnet, preserving
 * its host offset (so `192.0.2.10` in `192.0.2.0/24` becomes `10.213.7.10` in
 * `10.213.7.0/24`).
 */
export function remapIp(ip: string, from: Cidr, to: Cidr): string {
  const offset = (ipToInt(ip) - from.net) >>> 0;
  return intToIp((to.net + offset) >>> 0);
}
