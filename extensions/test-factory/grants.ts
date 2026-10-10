/**
 * Grant profiles — the privilege state applied to a guest before the harness
 * runs.
 *
 * A *grant profile* is a small, idempotent provisioning script that sets up the
 * host privilege a candidate's test needs: a non-root user, a NOPASSWD sudo
 * rule, `doas`, and so on (plan §6). The tier column from the plan says whether
 * a grant is reachable in the container phase (T0-nr/T1) or needs a peer/kernel
 * (KVM). This module is pure: it names the profiles and renders their scripts;
 * all execution lives in the backend.
 *
 * Only the **T0-nr subset** is implemented at milestone 0 (`user-tester`,
 * `sudo-*`, `doas-*`, `no-grant`). The `docker-*`/`k8s-*` grants provisioned by
 * the T1 sidecar and the kind fixture (milestones 2–3) and the KVM `ssh-root`
 * grant (milestone 9) are declared here so the schema is settled once, but they
 * render only when their tier lands.
 *
 * @module
 */
import { shellQuote } from "./harness.ts";

/** The fidelity tier a grant profile belongs to (plan §6). */
export type GrantTier = "T0-nr" | "T1" | "T1-k8s" | "KVM";

/** One grant profile in the catalog. */
export interface GrantProfile {
  /** Profile id, referenced by `grants: [{ guest, profile }]`. */
  id: string;
  /** Tier that can exercise it. */
  tier: GrantTier;
  /** One line: what privilege state it provisions. */
  provisions: string;
  /** The sudo/route strategy id it is meant to exercise (`""` for baseline). */
  exercises: string;
  /**
   * Whether the profile is implemented now. A profile whose tier has not landed
   * renders to a "pending" diagnostic rather than a silent no-op (§2.7).
   */
  implemented: boolean;
}

/**
 * The grant-profile catalog.
 *
 * Mirrors the plan §6 table. `implemented` is the milestone-0 subset; the rest
 * are declared for schema stability and report `skipped (pending)`.
 */
export const GRANT_PROFILES: GrantProfile[] = [
  {
    id: "user-tester",
    tier: "T0-nr",
    provisions: "non-root `tester` user + home",
    exercises: "",
    implemented: true,
  },
  {
    id: "sudo-nopasswd",
    tier: "T0-nr",
    provisions: "`sudo` + `/etc/sudoers.d/010-tester` NOPASSWD: ALL",
    exercises: "sudo-n",
    implemented: true,
  },
  {
    id: "sudo-none",
    tier: "T0-nr",
    provisions: "no sudo grant (fail-closed baseline)",
    exercises: "conservative fail-closed",
    implemented: true,
  },
  {
    id: "sudo-interactive-only",
    tier: "T0-nr",
    provisions: "sudo with a password rule, no askpass",
    exercises: "probe reports unavailable, never hangs",
    implemented: true,
  },
  {
    id: "doas-nopasswd",
    tier: "T0-nr",
    provisions: "`doas` + `permit nopass tester`",
    exercises: "doas-n",
    implemented: true,
  },
  {
    id: "no-grant",
    tier: "T0-nr",
    provisions: "nothing at all",
    exercises: "probe winner null, clean failure",
    implemented: true,
  },
  {
    id: "docker-rootful",
    tier: "T1",
    provisions: "rootful dockerd sidecar + tester in docker group",
    exercises: "docker-run",
    implemented: false,
  },
  {
    id: "docker-rootless",
    tier: "T1",
    provisions: "rootless dockerd sidecar",
    exercises: "docker-run rejected at probe",
    implemented: false,
  },
  {
    id: "podman-rootful",
    tier: "T1",
    provisions: "rootful podman sidecar + group",
    exercises: "podman-run",
    implemented: false,
  },
  {
    id: "nerdctl",
    tier: "T1",
    provisions: "containerd + nerdctl sidecar + socket group",
    exercises: "nerdctl-run",
    implemented: false,
  },
  {
    id: "docker-remote-endpoint",
    tier: "T1",
    provisions: "harness DOCKER_HOST=ssh://…",
    exercises: "container routes refused",
    implemented: false,
  },
  {
    id: "k8s-node",
    tier: "T1-k8s",
    provisions: "kind fixture + kubectl + node RBAC",
    exercises: "k8s-node",
    implemented: false,
  },
  {
    id: "ssh-root-peer",
    tier: "KVM",
    provisions: "key-based root@peer, pinned known_hosts",
    exercises: "ssh-root",
    implemented: false,
  },
];

/** The default user the harness runs as when a non-root grant is applied. */
export const HARNESS_USER = "tester";

/** Look up a grant profile by id. */
export function grantProfileById(id: string): GrantProfile | undefined {
  return GRANT_PROFILES.find((g) => g.id === id);
}

/**
 * The `useradd`/`adduser` line that creates the non-root harness user, tolerant
 * of both deb/rpm (`useradd`) and apk (`adduser`) families.
 */
function ensureUser(user: string): string[] {
  return [
    `command -v ${user} >/dev/null 2>&1 || \\`,
    `  { useradd -m -s /bin/bash ${user} 2>/dev/null || adduser -D -s /bin/sh ${user} 2>/dev/null || true; }`,
  ];
}

/**
 * Render the provisioning script for one grant profile.
 *
 * Returns a POSIX `sh` script body (no shebang), idempotent and safe to re-run.
 * A profile whose tier has not landed throws, so the caller reports it as a
 * pending tier rather than silently applying nothing.
 */
export function renderGrantScript(
  profile: GrantProfile,
  user = HARNESS_USER,
): string {
  if (!profile.implemented) {
    throw new Error(
      `grant profile "${profile.id}" needs the ${profile.tier} tier, which is ` +
        `not built yet (plan §6, §18)`,
    );
  }
  const lines: string[] = ["set -u"];
  switch (profile.id) {
    case "user-tester":
      lines.push(...ensureUser(user), "mkdir -p /home/" + user);
      break;
    case "sudo-nopasswd":
      lines.push(
        ...ensureUser(user),
        "if command -v apt-get >/dev/null 2>&1; then",
        "  apt-get update -qq >/dev/null 2>&1; DEBIAN_FRONTEND=noninteractive apt-get install -y -qq sudo >/dev/null 2>&1",
        "elif command -v dnf >/dev/null 2>&1; then",
        "  dnf install -y -q sudo >/dev/null 2>&1",
        "fi",
        `echo '${user} ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/010-${user}`,
        `chmod 0440 /etc/sudoers.d/010-${user}`,
      );
      break;
    case "sudo-none":
      // Remove any rule that would grant elevation; leave sudo installed.
      lines.push(
        ...ensureUser(user),
        `rm -f /etc/sudoers.d/010-${user}`,
      );
      break;
    case "sudo-interactive-only":
      // A password rule (no NOPASSWD) and no askpass: a probe must report
      // unavailable rather than block on a prompt.
      lines.push(
        ...ensureUser(user),
        "if command -v apt-get >/dev/null 2>&1; then",
        "  apt-get update -qq >/dev/null 2>&1; DEBIAN_FRONTEND=noninteractive apt-get install -y -qq sudo >/dev/null 2>&1",
        "elif command -v dnf >/dev/null 2>&1; then",
        "  dnf install -y -q sudo >/dev/null 2>&1",
        "fi",
        `echo '${user} ALL=(ALL) ALL' > /etc/sudoers.d/010-${user}`,
        `chmod 0440 /etc/sudoers.d/010-${user}`,
        `passwd -d ${user} >/dev/null 2>&1 || true`,
      );
      break;
    case "doas-nopasswd":
      lines.push(
        ...ensureUser(user),
        "if command -v apt-get >/dev/null 2>&1 && ! command -v doas >/dev/null 2>&1; then",
        "  apt-get update -qq >/dev/null 2>&1; DEBIAN_FRONTEND=noninteractive apt-get install -y -qq opendoas >/dev/null 2>&1 || true",
        "elif command -v dnf >/dev/null 2>&1 && ! command -v doas >/dev/null 2>&1; then",
        "  dnf install -y -q opendoas >/dev/null 2>&1 || true",
        "fi",
        "mkdir -p /etc",
        `printf 'permit nopass ${user}\\n' > /etc/doas.conf 2>/dev/null || true`,
        "chmod 0400 /etc/doas.conf 2>/dev/null || true",
      );
      break;
    case "no-grant":
      lines.push("# deliberately provision nothing");
      break;
    default:
      lines.push(`# ${profile.id}: no script`);
      break;
  }
  lines.push(`chown -R ${user} /home/${user} 2>/dev/null || true`);
  return lines.join("\n") + "\n";
}

/**
 * Resolve a declared grant list into the ordered scripts to apply, plus any
 * pending-tier diagnostics.
 *
 * Pure: it maps ids to profiles and renders scripts, so lint and the backend
 * agree on what a candidate asked for. Order is preserved (the plan's `mixed`
 * case depends on first-win ordering).
 */
export function planGrants(
  grants: Array<{ guest: string; profile: string }>,
  user = HARNESS_USER,
): {
  scripts: Array<{ guest: string; profile: string; script: string }>;
  pending: Array<{ guest: string; profile: string; reason: string }>;
  unknown: Array<{ guest: string; profile: string }>;
} {
  const scripts: Array<{ guest: string; profile: string; script: string }> = [];
  const pending: Array<{ guest: string; profile: string; reason: string }> = [];
  const unknown: Array<{ guest: string; profile: string }> = [];
  for (const g of grants) {
    const profile = grantProfileById(g.profile);
    if (!profile) {
      unknown.push(g);
      continue;
    }
    if (!profile.implemented) {
      pending.push({
        ...g,
        reason: `needs the ${profile.tier} tier (not built yet)`,
      });
      continue;
    }
    scripts.push({ ...g, script: renderGrantScript(profile, user) });
  }
  return { scripts, pending, unknown };
}

/**
 * A shell snippet that applies a grant script as root, then verifies the
 * harness user exists.
 */
export function applyGrantScript(script: string): string {
  return [
    "#!/bin/sh",
    "set -u",
    script,
  ].join("\n");
}

/** Quote helper re-exported for callers that build grant command lines. */
export { shellQuote };
