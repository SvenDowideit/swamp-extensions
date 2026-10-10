/**
 * Host capability probe — the single source of truth for whether the KVM
 * backend can run here.
 *
 * The plan (§16.6) requires that KVM availability is decided in **one** place,
 * used by both lint and the backend, and that the KVM probe actually attempts a
 * minimal accelerator init rather than merely `open()`ing `/dev/kvm` (the device
 * node can exist while nested virtualisation is disabled). This module is pure
 * apart from one injectable runner, so it is unit-testable with a stub.
 *
 * At the container tier (M0–T1) the KVM fields are informational: a candidate
 * that needs KVM is reported `skipped (kvm backend pending)` regardless. The
 * probe exists now so the KVM phase (milestone 8) has its gate already written.
 *
 * @module
 */
import { type CmdResult, type RunFn } from "./docker.ts";

/** What a host must provide for each backend to run. */
export interface HostCapabilities {
  /** A reachable container runtime (docker/podman CLI + daemon). */
  container: boolean;
  /** `/dev/kvm` is present **and** a minimal accelerator init succeeds. */
  kvm: boolean;
  /** `/dev/net/tun` is present. */
  tun: boolean;
  /** `CAP_NET_ADMIN` (needed to build the guest fabric). */
  netAdmin: boolean;
  /** Runtime server version, or empty. */
  runtimeVersion: string;
  /** Human-readable detail per capability, for an actionable diagnostic. */
  detail: Record<string, string>;
}

/** The capability names, in report order. */
export const CAPABILITY_KEYS = [
  "container",
  "kvm",
  "tun",
  "netAdmin",
] as const;

/** A host-capability field name. */
export type CapabilityKey = typeof CAPABILITY_KEYS[number];

/**
 * The pure decision: can the KVM backend run on this host at all?
 *
 * Requires the container runtime (to hold the hypervisor image) **and** KVM.
 * TUN/NET_ADMIN are additionally required to build the guest fabric (§8); they
 * are reported separately so a single-guest T2 can be distinguished from the
 * multi-guest T3 that needs the bridge.
 */
export function kvmBackendAvailable(caps: HostCapabilities): boolean {
  return caps.container && caps.kvm;
}

/** Whether the host can build the multi-guest fabric (needs TUN + NET_ADMIN). */
export function fabricAvailable(caps: HostCapabilities): boolean {
  return kvmBackendAvailable(caps) && caps.tun && caps.netAdmin;
}

/**
 * A one-line, actionable explanation of what is missing for the KVM backend.
 *
 * Returns `""` when KVM is available, so a caller can `if (msg) report(msg)`.
 */
export function kvmUnavailableReason(caps: HostCapabilities): string {
  if (kvmBackendAvailable(caps)) return "";
  const missing: string[] = [];
  if (!caps.container) {
    missing.push(
      `no container runtime (${caps.detail.container ?? "unknown"})`,
    );
  }
  if (!caps.kvm) {
    missing.push(`KVM unavailable (${caps.detail.kvm ?? "unknown"})`);
  }
  return `KVM backend requires ${missing.join(" and ")}. The KVM tier ` +
    `(plan §7.1) needs /dev/kvm with working nested virtualisation; on a host ` +
    `without it a \`vm\` candidate is skipped, never silently passed.`;
}

/**
 * The commands the KVM probe runs to attempt a **real** accelerator init.
 *
 * `open()` alone is insufficient: the device node can exist while KVM is
 * disabled. `kvm-ok`/`qemu-system-x86_64 -accel kvm -nodefaults -display none`
 * actually exercise the ioctl path. Kept as constants so the generated probe
 * and the recorded mechanics stay in lockstep.
 */
export const KVM_ACCEL_INIT_CMD = "qemu-system-x86_64";

/** Args for the minimal accelerator init (boot nothing, then exit). */
export const KVM_ACCEL_INIT_ARGS = [
  "-accel",
  "kvm",
  "-nodefaults",
  "-display",
  "none",
  "-no-user-config",
  "-S",
  "-machine",
  "none",
];

/**
 * Interpret the raw probe results into a {@link HostCapabilities}.
 *
 * Pure: given the captured command results it makes the decision, so the
 * decision is unit-testable without a host.
 */
export function interpretCapabilities(input: {
  docker: CmdResult;
  kvmDevice: CmdResult;
  accelInit: CmdResult;
  tunDevice: CmdResult;
  netAdmin: CmdResult;
}): HostCapabilities {
  const container = input.docker.code === 0;
  // A device node that exists but cannot be initialised is still not usable.
  const kvm = input.kvmDevice.code === 0 && input.accelInit.code === 0;
  const tun = input.tunDevice.code === 0;
  const netAdmin = input.netAdmin.code === 0;
  const detail: Record<string, string> = {
    container: container
      ? `runtime ${input.docker.stdout.trim() || "present"}`
      : input.docker.stderr.trim() || "no container runtime",
    kvm: kvm
      ? "accelerator init ok"
      : input.kvmDevice.code !== 0
      ? "/dev/kvm not readable"
      : `accelerator init failed: ${
        input.accelInit.stderr.trim() || "kvm unavailable"
      }`,
    tun: tun ? "/dev/net/tun present" : "/dev/net/tun absent",
    netAdmin: netAdmin ? "CAP_NET_ADMIN held" : "no CAP_NET_ADMIN",
  };
  return {
    container,
    kvm,
    tun,
    netAdmin,
    runtimeVersion: container ? input.docker.stdout.trim() : "",
    detail,
  };
}

/** Default wall-clock budget for a capability probe command. */
const PROBE_TIMEOUT_MS = 30_000;

/**
 * Probe the host's capabilities through the injectable runner.
 *
 * Every probe is a shell command; the results are fed to
 * {@link interpretCapabilities}. A probe that cannot run is simply `false`, so
 * an unreachable host degrades to "no capability" rather than throwing.
 */
export async function probeHostCapabilities(
  runFn: RunFn,
  opts: {
    dockerBinary?: string;
    /**
     * Command used to attempt the KVM accelerator init. On a bare host this is
     * `qemu-system-x86_64`, which is absent by design (qemu ships in the
     * hypervisor image, plan §7.1/§21.2), so a bare host reports `kvm: false`
     * conservatively. At the KVM phase (milestone 8) the caller points this at
     * the hypervisor container (`docker run --device /dev/kvm …`), which is the
     * only place the accelerator init can actually be exercised.
     */
    kvmInitCmd?: string;
  } = {},
): Promise<HostCapabilities> {
  const docker = opts.dockerBinary ?? "docker";
  const kvmInit = opts.kvmInitCmd ?? KVM_ACCEL_INIT_CMD;
  const t = { timeoutMs: PROBE_TIMEOUT_MS };

  const [dockerRes, kvmDevice, accelInit, tunDevice, netAdmin] = await Promise
    .all([
      runFn(docker, ["version", "--format", "{{.Server.Version}}"], t),
      runFn("sh", ["-c", "test -r /dev/kvm"], t),
      runFn(kvmInit, KVM_ACCEL_INIT_ARGS, t),
      runFn("sh", ["-c", "test -e /dev/net/tun"], t),
      // A throwaway netns is the cheapest real check that the process may
      // manipulate links (the fabric needs this).
      runFn("sh", [
        "-c",
        "ip netns add tf-cap-probe && ip netns del tf-cap-probe",
      ], t),
    ]);

  return interpretCapabilities({
    docker: dockerRes,
    kvmDevice,
    accelInit,
    tunDevice,
    netAdmin,
  });
}

/**
 * Render the capabilities as the audit/report block (§16.6 capability matrix).
 *
 * Records each capability and the exact detail, so a reader can see why a
 * backend was or was not available on a host.
 */
export function capabilityMatrix(caps: HostCapabilities): Array<{
  capability: string;
  available: boolean;
  detail: string;
}> {
  return CAPABILITY_KEYS.map((key) => ({
    capability: key,
    available: caps[key],
    detail: caps.detail[key] ?? "",
  }));
}
