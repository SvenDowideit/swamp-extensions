/**
 * @svendowideit/ssh-key-inventory
 * @module
 */
import { z } from "npm:zod@4";

const HostTargetSchema = z.object({
  user: z.string().min(1),
  host: z.string().min(1),
  port: z.number().int().positive().default(22),
});
const GlobalArgsSchema = z.object({
  sshUser: z.string().default(""),
  outputDir: z.string().default("~/.local/share/ssh-key-inventory"),
  connectTimeoutSec: z.number().int().positive().default(10),
  keyPaths: z.array(z.string()).default(["~/.ssh"]),
  includeLocal: z.boolean().default(true),
}).strict();
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;
const AddHostsArgsSchema = z.object({
  hosts: z.array(z.string().min(1)).min(1),
});
const InventoryArgsSchema = z.object({
  hosts: z.array(z.string().min(1)).default([]),
  includeLocal: z.boolean().default(true),
});
const UpgradeArgsSchema = z.object({
  hosts: z.union([z.array(z.string().min(1)), z.string().min(1)]),
  newPrivateKeyPath: z.string().min(1).meta({ sensitive: true }),
  oldFingerprint: z.string().default(""),
  testCommand: z.string().default("true"),
  removeOld: z.boolean().default(true),
});
const ReportArgsSchema = z.object({ outputPath: z.string().default("") });
const PrivateKeySchema = z.object({
  path: z.string(),
  fingerprint: z.string(),
  algorithm: z.string().default(""),
  bits: z.number().nullable().default(null),
  comment: z.string().default(""),
  perms: z.string().default(""),
  mtime: z.number().nullable().default(null),
  size: z.number().nullable().default(null),
  encrypted: z.boolean().nullable().default(null),
  authorized: z.boolean().default(false),
  authorizedFiles: z.array(z.string()).default([]),
});
const HostInventorySchema = z.object({
  target: z.string(),
  user: z.string(),
  host: z.string(),
  port: z.number(),
  ok: z.boolean(),
  error: z.string().default(""),
  privateKeys: z.array(PrivateKeySchema),
  authorizedKeys: z.array(
    z.object({ file: z.string(), fingerprint: z.string(), line: z.string() }),
  ),
  collectedAt: z.string(),
});
const KeyFindingSchema = z.object({
  fingerprint: z.string(),
  algorithm: z.string(),
  bits: z.number().nullable(),
  comment: z.string(),
  occurrences: z.number(),
  systems: z.array(z.string()),
  paths: z.array(z.string()),
  encryptedCount: z.number(),
  unencryptedCount: z.number(),
  oldestMtime: z.number().nullable(),
  authorizedSystems: z.array(z.string()),
  severity: z.enum(["low", "medium", "high", "critical"]),
  issues: z.array(z.string()),
  advice: z.array(z.string()),
});
const InventoryOutputSchema = z.object({
  generatedAt: z.string(),
  totalHosts: z.number(),
  reachableHosts: z.number(),
  privateKeys: z.number(),
  uniqueKeys: z.number(),
  hosts: z.array(HostInventorySchema),
  keys: z.array(KeyFindingSchema),
});
const UpgradeHostResultSchema = z.object({
  target: z.string(),
  backedUp: z.boolean(),
  appended: z.boolean(),
  tested: z.boolean(),
  removedOld: z.boolean(),
  error: z.string().default(""),
  rolledBack: z.boolean().default(false),
});
const UpgradeOutputSchema = z.object({
  generatedAt: z.string(),
  newPublicKey: z.string(),
  results: z.array(UpgradeHostResultSchema),
});
const HostListOutputSchema = z.object({
  hosts: z.array(HostTargetSchema.extend({ addedAt: z.string() })),
  updatedAt: z.string(),
});

/** HostTarget. */
export interface HostTarget {
  user: string;
  host: string;
  port: number;
}
/** PrivateKeyFinding. */
export interface PrivateKeyFinding {
  path: string;
  fingerprint: string;
  algorithm: string;
  bits: number | null;
  comment: string;
  perms: string;
  mtime: number | null;
  size: number | null;
  encrypted: boolean | null;
  authorized: boolean;
  authorizedFiles: string[];
}
/** HostInventory. */
export interface HostInventory {
  target: string;
  user: string;
  host: string;
  port: number;
  ok: boolean;
  error: string;
  privateKeys: PrivateKeyFinding[];
  authorizedKeys: { file: string; fingerprint: string; line: string }[];
  collectedAt: string;
}
/** KeyFinding. */
export interface KeyFinding {
  fingerprint: string;
  algorithm: string;
  bits: number | null;
  comment: string;
  occurrences: number;
  systems: string[];
  paths: string[];
  encryptedCount: number;
  unencryptedCount: number;
  oldestMtime: number | null;
  authorizedSystems: string[];
  severity: "low" | "medium" | "high" | "critical";
  issues: string[];
  advice: string[];
}
/** InventoryOutput. */
export interface InventoryOutput {
  generatedAt: string;
  totalHosts: number;
  reachableHosts: number;
  privateKeys: number;
  uniqueKeys: number;
  hosts: HostInventory[];
  keys: KeyFinding[];
}
/** UpgradeResult. */
export interface UpgradeResult {
  target: string;
  backedUp: boolean;
  appended: boolean;
  tested: boolean;
  removedOld: boolean;
  error: string;
  rolledBack: boolean;
}
/** UpgradeOutput. */
export interface UpgradeOutput {
  generatedAt: string;
  newPublicKey: string;
  results: UpgradeResult[];
}
/** HostList. */
export interface HostList {
  hosts: (HostTarget & { addedAt: string })[];
  updatedAt: string;
}

/** expandHome. */
export function expandHome(path: string, home?: string): string {
  const h = home ?? Deno.env.get("HOME") ?? "";
  if (path === "~") return h;
  if (path.startsWith("~/")) return `${h}${path.slice(1)}`;
  return path;
}

/** parseHostTarget. */
export function parseHostTarget(raw: string, defaultUser?: string): HostTarget {
  const trimmed = raw.trim();
  let user = defaultUser?.trim() || "";
  let hostPart = trimmed;
  const atIndex = trimmed.lastIndexOf("@");
  if (atIndex > 0) {
    user = trimmed.slice(0, atIndex);
    hostPart = trimmed.slice(atIndex + 1);
  }
  let host = hostPart;
  let port = 22;
  if (host.startsWith("[")) {
    const close = host.indexOf("]");
    if (close > 0) {
      host = host.slice(1, close);
      const rest = hostPart.slice(close + 1);
      if (rest.startsWith(":")) {
        const parsed = Number.parseInt(rest.slice(1), 10);
        if (!Number.isNaN(parsed)) port = parsed;
      }
    }
  } else {
    const colonCount = (host.match(/:/g) ?? []).length;
    if (colonCount === 1) {
      const [h, p] = host.split(":");
      const parsed = Number.parseInt(p ?? "", 10);
      if (h && !Number.isNaN(parsed)) {
        host = h;
        port = parsed;
      }
    }
  }
  if (!user) user = Deno.env.get("USER") || Deno.env.get("LOGNAME") || "root";
  if (!host) throw new Error(`Invalid host target '${raw}'`);
  return { user, host, port };
}

/** normalizeHostTargets. */
export function normalizeHostTargets(
  rawHosts: string[],
  defaultUser?: string,
): HostTarget[] {
  const seen = new Set<string>();
  const out: HostTarget[] = [];
  for (const raw of rawHosts) {
    const t = parseHostTarget(raw, defaultUser);
    const key = `${t.user}@${t.host}:${t.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

/** targetString. */
export function targetString(t: HostTarget): string {
  return t.port === 22
    ? `${t.user}@${t.host}`
    : `${t.user}@${t.host}:${t.port}`;
}
/** extractFingerprint. */
export function extractFingerprint(text: string): string {
  const m = text.match(/SHA256:[A-Za-z0-9+/=]+|MD5:[0-9a-fA-F:]+/);
  return m?.[0] ?? text.trim();
}
/** parseKeygenLine. */
export function parseKeygenLine(
  line: string,
): {
  bits: number | null;
  fingerprint: string;
  comment: string;
  algorithm: string;
} {
  const trimmed = line.trim();
  const m = trimmed.match(/^(\d+)\s+(\S+)\s*(.*)\(([^)]+)\)\s*$/);
  if (m) {
    return {
      bits: Number.parseInt(m[1], 10),
      fingerprint: m[2],
      comment: m[3].trim(),
      algorithm: m[4].toUpperCase(),
    };
  }
  const m2 = trimmed.match(/^(\d+)\s+(\S+)\s*(.*)$/);
  if (m2) {
    return {
      bits: Number.parseInt(m2[1], 10),
      fingerprint: extractFingerprint(trimmed),
      comment: m2[3].trim(),
      algorithm: "",
    };
  }
  return {
    bits: null,
    fingerprint: extractFingerprint(trimmed),
    comment: "",
    algorithm: "",
  };
}

/** assessKey. */
export function assessKey(
  algorithm: string,
  bits: number | null,
  encrypted: boolean | null,
  perms: string,
  ageYears: number | null,
  occurrences: number,
): { severity: KeyFinding["severity"]; issues: string[]; advice: string[] } {
  const algo = (algorithm || "").toUpperCase();
  const issues: string[] = [];
  const advice: string[] = [];
  let severity: KeyFinding["severity"] = "low";
  const raise = (s: KeyFinding["severity"]) => {
    const order = ["low", "medium", "high", "critical"];
    if (order.indexOf(s) > order.indexOf(severity)) severity = s;
  };
  if (algo === "DSA") {
    issues.push("DSA keys are weak and deprecated.");
    advice.push("Replace DSA keys with ed25519.");
    raise("critical");
  }
  if (algo === "RSA") {
    if (!bits || bits < 2048) {
      issues.push(`RSA key is only ${bits ?? "unknown"} bits.`);
      advice.push("Use at least 2048-bit RSA, preferably 3072 or 4096.");
      raise("critical");
    } else if (bits < 3072) {
      issues.push("RSA key is 2048 bits (minimum; below modern guidance).");
      advice.push("Prefer ed25519, or 3072/4096-bit RSA.");
      raise("medium");
    }
  }
  if (algo === "ECDSA") {
    advice.push("ECDSA is acceptable; ed25519 is simpler and preferred.");
    raise("low");
  }
  if (encrypted === false) {
    issues.push("Private key is unencrypted.");
    advice.push(
      "Encrypt private keys at rest (ssh-keygen -p) or use a hardware-backed key/agent.",
    );
    raise("high");
  }
  if (perms && !["600", "400", "700"].includes(perms)) {
    issues.push(`Private key mode is ${perms}, expected 600/400.`);
    advice.push("chmod 600 the private key and 700 the ~/.ssh directory.");
    raise("high");
  }
  if (ageYears !== null) {
    if (ageYears >= 3) {
      issues.push(`Key is ${ageYears.toFixed(1)} years old.`);
      advice.push(
        "Rotate keys older than 1 year; retire keys older than 3 years.",
      );
      raise("high");
    } else if (ageYears >= 1) {
      issues.push(`Key is ${ageYears.toFixed(1)} years old.`);
      advice.push("Rotate keys annually or after personnel changes.");
      raise("medium");
    }
  }
  if (occurrences > 1) {
    issues.push(`Same private key appears on ${occurrences} hosts/paths.`);
    advice.push(
      "Stop sharing one private key across hosts; use per-host or per-user keys or an SSH certificate.",
    );
    raise("medium");
  }
  if (issues.length === 0) {
    advice.push(
      "No obvious issues detected; continue annual rotation and keep keys encrypted.",
    );
  }
  advice.push(
    "Prefer SSH certificates/agent forwarding controls over long-lived authorized_keys where possible.",
  );
  return { severity, issues, advice: [...new Set(advice)] };
}

/** computeAgeYears. */
export function computeAgeYears(
  mtimeEpoch: number | null,
  now = Date.now(),
): number | null {
  if (!mtimeEpoch) return null;
  const ms = now - mtimeEpoch * 1000;
  if (ms < 0) return 0;
  return ms / (365.25 * 24 * 60 * 60 * 1000);
}

/** buildUniqueKeys. */
export function buildUniqueKeys(
  hosts: HostInventory[],
  _now = Date.now(),
): KeyFinding[] {
  const groups = new Map<
    string,
    {
      fingerprint: string;
      algorithm: string;
      bits: number | null;
      comment: string;
      systems: Set<string>;
      paths: Set<string>;
      encryptedCount: number;
      unencryptedCount: number;
      oldestMtime: number | null;
      authorizedSystems: Set<string>;
      occurrences: number;
    }
  >();
  for (const h of hosts) {
    if (!h.ok) continue;
    const authByFp = new Map<string, string[]>();
    for (const a of h.authorizedKeys) {
      const list = authByFp.get(a.fingerprint) ?? [];
      list.push(a.file);
      authByFp.set(a.fingerprint, list);
    }
    for (const pk of h.privateKeys) {
      const fp = pk.fingerprint || `${h.target}:${pk.path}`;
      const g = groups.get(fp) ?? {
        fingerprint: fp,
        algorithm: pk.algorithm,
        bits: pk.bits,
        comment: pk.comment,
        systems: new Set<string>(),
        paths: new Set<string>(),
        encryptedCount: 0,
        unencryptedCount: 0,
        oldestMtime: null,
        authorizedSystems: new Set<string>(),
        occurrences: 0,
      };
      g.occurrences += 1;
      g.systems.add(h.target);
      g.paths.add(`${h.target}:${pk.path}`);
      if (pk.encrypted === true) g.encryptedCount += 1;
      if (pk.encrypted === false) g.unencryptedCount += 1;
      if (pk.mtime !== null) {
        g.oldestMtime = g.oldestMtime === null
          ? pk.mtime
          : Math.min(g.oldestMtime, pk.mtime);
      }
      if (authByFp.has(fp)) g.authorizedSystems.add(h.target);
      if (!g.algorithm && pk.algorithm) g.algorithm = pk.algorithm;
      if (g.bits === null && pk.bits !== null) g.bits = pk.bits;
      if (!g.comment && pk.comment) g.comment = pk.comment;
      groups.set(fp, g);
    }
  }
  const out: KeyFinding[] = [];
  for (const g of groups.values()) {
    const age = computeAgeYears(g.oldestMtime, _now);
    const encState = g.unencryptedCount > 0
      ? (g.encryptedCount > 0 ? null : false)
      : (g.encryptedCount > 0 ? true : null);
    const assessed = assessKey(
      g.algorithm,
      g.bits,
      encState,
      "",
      age,
      g.occurrences,
    );
    out.push({
      fingerprint: g.fingerprint,
      algorithm: g.algorithm || "unknown",
      bits: g.bits,
      comment: g.comment,
      occurrences: g.occurrences,
      systems: [...g.systems].sort(),
      paths: [...g.paths].sort(),
      encryptedCount: g.encryptedCount,
      unencryptedCount: g.unencryptedCount,
      oldestMtime: g.oldestMtime,
      authorizedSystems: [...g.authorizedSystems].sort(),
      severity: assessed.severity,
      issues: assessed.issues,
      advice: assessed.advice,
    });
  }
  return out.sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
}

/** escapeHtml. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** renderHtmlReport. */
export function renderHtmlReport(inv: InventoryOutput): string {
  const rows = inv.keys.map((k) =>
    `<tr><td>${escapeHtml(k.fingerprint)}</td><td>${escapeHtml(k.algorithm)} ${
      k.bits ?? ""
    }</td><td>${k.encryptedCount}/${k.occurrences}</td><td>${
      k.oldestMtime
        ? new Date(k.oldestMtime * 1000).toISOString().slice(0, 10)
        : ""
    }</td><td>${escapeHtml(k.systems.join(", "))}</td><td>${
      escapeHtml(k.authorizedSystems.join(", "))
    }</td><td class="${k.severity}">${k.severity}</td><td>${
      escapeHtml(k.issues.join("; "))
    }</td></tr>`
  ).join("\n");
  const hostRows = inv.hosts.map((h) =>
    `<tr><td>${escapeHtml(h.target)}</td><td>${
      h.ok ? "ok" : escapeHtml(h.error)
    }</td><td>${h.privateKeys.length}</td><td>${h.authorizedKeys.length}</td></tr>`
  ).join("\n");
  const advice = [
    "Use ed25519 keys for new access; avoid DSA and short RSA.",
    "Encrypt every private key at rest and use ssh-agent or a hardware key.",
    "Do not copy one private key to many hosts; use per-host or per-user keys or SSH certificates.",
    "Remove unused authorized_keys entries and rotate keys on personnel changes.",
    "Keep ~/.ssh at 700 and private keys at 600.",
  ];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>SSH Key Inventory</title>
<style>body{font-family:system-ui,sans-serif;margin:2rem}table{border-collapse:collapse;width:100%;margin:1rem 0}th,td{border:1px solid #ddd;padding:.4rem;font-size:.9rem;vertical-align:top}th{background:#f4f4f4}.critical{color:#900;font-weight:700}.high{color:#c30;font-weight:700}.medium{color:#a60}.low{color:#060}.summary{display:flex;gap:1rem;flex-wrap:wrap;margin:1rem 0}.card{border:1px solid #ddd;padding:.8rem 1rem;border-radius:.5rem}</style>
</head>
<body>
<h1>SSH Key Inventory</h1>
<p>Generated ${
    escapeHtml(
      inv.generatedAt,
    )
  } — ${inv.totalHosts} hosts, ${inv.reachableHosts} reachable, ${inv.privateKeys} private key files, ${inv.uniqueKeys} unique keys.</p>
<div class="summary">
<div class="card">Hosts<br>
<strong>${inv.totalHosts}</strong>
</div>
<div class="card">Reachable<br>
<strong>${inv.reachableHosts}</strong>
</div>
<div class="card">Private keys<br>
<strong>${inv.privateKeys}</strong>
</div>
<div class="card">Unique keys<br>
<strong>${inv.uniqueKeys}</strong>
</div>
</div>
<h2>Unique private keys</h2>
<table>
<thead>
<tr>
<th>Fingerprint</th>
<th>Algorithm</th>
<th>Encrypted</th>
<th>Oldest mtime</th>
<th>Systems</th>
<th>Authorized on</th>
<th>Severity</th>
<th>Issues</th>
</tr>
</thead>
<tbody>${rows}</tbody>
</table>
<h2>Hosts</h2>
<table>
<thead>
<tr>
<th>Host</th>
<th>Status</th>
<th>Private keys</th>
<th>Authorized entries</th>
</tr>
</thead>
<tbody>${hostRows}</tbody>
</table>
<h2>Key management advice</h2>
<ul>${advice.map((a) => `<li>${escapeHtml(a)}</li>`).join("")}</ul>${
    inv.keys.map((k) =>
      `<h3>${escapeHtml(k.fingerprint)} — ${escapeHtml(k.algorithm)}${
        k.bits ? " " + k.bits + "-bit" : ""
      } (${k.severity})</h3><p>Systems: ${
        escapeHtml(k.systems.join(", ")) || "none"
      }. Paths: ${escapeHtml(k.paths.join("; ")) || "none"}. Authorized on: ${
        escapeHtml(k.authorizedSystems.join(", ")) || "none"
      }.</p>${
        k.issues.length
          ? `<ul>${
            k.issues.map((i) => `<li>${escapeHtml(i)}</li>`).join("")
          }</ul>`
          : ""
      }<ul>${k.advice.map((a) => `<li>${escapeHtml(a)}</li>`).join("")}</ul>`
    ).join("")
  }</body></html>`;
}

async function runSsh(
  user: string,
  host: string,
  port: number,
  script: string,
  timeoutSec: number,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);
  try {
    const child = new Deno.Command("ssh", {
      args: [
        "-o",
        "BatchMode=yes",
        "-o",
        `ConnectTimeout=${timeoutSec}`,
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-p",
        String(port),
        `${user}@${host}`,
        "sh",
        "-s",
      ],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
      signal: controller.signal,
    });
    const process = child.spawn();
    const writer = process.stdin.getWriter();
    await writer.write(new TextEncoder().encode(script));
    await writer.close();
    const status = await process.status;
    const out = await process.output();
    return {
      code: status.code,
      stdout: new TextDecoder().decode(out.stdout),
      stderr: new TextDecoder().decode(out.stderr),
    };
  } catch (e) {
    return { code: 124, stdout: "", stderr: String(e) };
  } finally {
    clearTimeout(timer);
  }
}

async function runLocal(
  script: string,
  timeoutSec: number,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);
  try {
    const child = new Deno.Command("sh", {
      args: ["-s"],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
      signal: controller.signal,
    });
    const process = child.spawn();
    const writer = process.stdin.getWriter();
    await writer.write(new TextEncoder().encode(script));
    await writer.close();
    const status = await process.status;
    const out = await process.output();
    return {
      code: status.code,
      stdout: new TextDecoder().decode(out.stdout),
      stderr: new TextDecoder().decode(out.stderr),
    };
  } catch (e) {
    return { code: 124, stdout: "", stderr: String(e) };
  } finally {
    clearTimeout(timer);
  }
}

function remoteInventoryScript(keyPaths: string[]): string {
  const roots = keyPaths.map((p) => expandHome(p)).join(" ");
  return [
    `echo "KEYPATHS=${roots}"`,
    'echo "PRIVATE_START"',
    `find ${roots} -type f ! -name '*.pub' 2>/dev/null | while IFS= read -r f; do`,
    '  m=$(stat -c "%a %Y %s" "$f" 2>/dev/null || stat -f "%Lp %m %z" "$f" 2>/dev/null || echo "   ")',
    '  info=""',
    '  if [ -f "$f.pub" ]; then info=$(ssh-keygen -lf "$f.pub" 2>/dev/null); fi',
    '  if [ -z "$info" ]; then info=$(ssh-keygen -lf "$f" 2>/dev/null); fi',
    '  if [ -z "$info" ]; then continue; fi',
    '  enc="unknown"',
    '  if grep -q "ENCRYPTED" "$f" 2>/dev/null; then enc="encrypted"; else enc="unencrypted-or-unknown"; fi',
    '  printf "PRIVATE\\t%s\\t%s\\t%s\\t%s\\n" "$f" "$m" "$info" "$enc"',
    "done",
    'echo "AUTHORIZED_START"',
    "for f in ~/.ssh/authorized_keys /root/.ssh/authorized_keys /etc/ssh/authorized_keys /etc/ssh/authorized_keys2; do",
    '  if [ -r "$f" ]; then',
    "    while IFS= read -r line; do",
    '      case "$line" in ""|\\#*) continue ;; esac',
    '      fp=$(printf "%s\\n" "$line" | ssh-keygen -lf - 2>/dev/null || echo "unreadable")',
    '      printf "AUTHORIZED\\t%s\\t%s\\t%s\\n" "$f" "$fp" "$line"',
    '    done < "$f"',
    "  fi",
    "done",
    'echo "END"',
  ].join("\n");
}

function parsePrivateLine(line: string): PrivateKeyFinding | null {
  const parts = line.split("\t");
  if (parts.length < 5 || parts[0] !== "PRIVATE") return null;
  const path = parts[1];
  const statParts = (parts[2] || "").trim().split(/\s+/);
  const perms = statParts[0] || "";
  const mtimeRaw = statParts[1];
  const sizeRaw = statParts[2];
  const mtime = mtimeRaw ? Number.parseInt(mtimeRaw, 10) : null;
  const size = sizeRaw ? Number.parseInt(sizeRaw, 10) : null;
  const parsed = parseKeygenLine(parts[3] || "");
  const encRaw = parts[4] || "";
  const encrypted = encRaw.startsWith("encrypted")
    ? true
    : (encRaw.includes("unencrypted") ? false : null);
  return {
    path,
    fingerprint: parsed.fingerprint || parts[3] || path,
    algorithm: parsed.algorithm,
    bits: parsed.bits,
    comment: parsed.comment,
    perms,
    mtime: Number.isNaN(mtime as number) ? null : mtime,
    size: Number.isNaN(size as number) ? null : size,
    encrypted,
    authorized: false,
    authorizedFiles: [],
  };
}

function parseHostOutput(
  target: string,
  user: string,
  host: string,
  port: number,
  stdout: string,
  stderr: string,
  code: number,
): HostInventory {
  const inv: HostInventory = {
    target,
    user,
    host,
    port,
    ok: code === 0,
    error: code === 0 ? "" : (stderr.trim() || `ssh exited ${code}`),
    privateKeys: [],
    authorizedKeys: [],
    collectedAt: new Date().toISOString(),
  };
  if (code !== 0) return inv;
  const pkLines: string[] = [];
  const authLines: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith("AUTHORIZED\t")) authLines.push(line);
    else if (line.startsWith("PRIVATE\t")) pkLines.push(line);
  }
  const authorizedKeys: HostInventory["authorizedKeys"] = [];
  const authByFp = new Map<string, string[]>();
  for (const line of authLines) {
    const parts = line.split("\t");
    const fp = extractFingerprint(parts[2] || "");
    authorizedKeys.push({
      file: parts[1] || "",
      fingerprint: fp,
      line: parts.slice(3).join("\t"),
    });
    const list = authByFp.get(fp) ?? [];
    list.push(parts[1] || "");
    authByFp.set(fp, list);
  }
  inv.authorizedKeys = authorizedKeys;
  for (const line of pkLines) {
    const pk = parsePrivateLine(line);
    if (pk) {
      pk.authorizedFiles = authByFp.get(pk.fingerprint) ?? [];
      pk.authorized = pk.authorizedFiles.length > 0;
      inv.privateKeys.push(pk);
    }
  }
  return inv;
}

type ReadResourceFn = (name: string) => Promise<unknown>;
type WriteResourceFn = (
  specName: string,
  name: string,
  data: Record<string, unknown>,
) => Promise<{ name: string }>;

async function readHostList(
  context: { readResource?: ReadResourceFn },
): Promise<HostList> {
  if (!context.readResource) {
    return { hosts: [], updatedAt: new Date().toISOString() };
  }
  try {
    const raw = await context.readResource("hosts");
    if (!raw) return { hosts: [], updatedAt: new Date().toISOString() };
    const anyRaw = raw as Record<string, unknown>;
    const r = (anyRaw.content ?? anyRaw) as HostList;
    if (r && Array.isArray(r.hosts)) return r;
  } catch { /* ignore */ }
  return { hosts: [], updatedAt: new Date().toISOString() };
}

/** model. */
export const model = {
  type: "@svendowideit/ssh-key-inventory",
  version: "2026.10.24.2",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.10.24.2",
      description:
        "Add local ~/.ssh inventory (local host appears in hosts and unique keys) and fix resource handle reporting.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    hosts: {
      description: "Additive list of user@host targets",
      schema: HostListOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    inventory: {
      description: "SSH key inventory output",
      schema: InventoryOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    upgrade: {
      description: "SSH key upgrade result",
      schema: UpgradeOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    "add-hosts": {
      description: "Add user@host targets to the cumulative known hosts list",
      arguments: AddHostsArgsSchema,
      execute: async (
        args: { hosts: string[] },
        context: {
          globalArgs: GlobalArgs;
          logger?: { info: (m: string, p?: Record<string, unknown>) => void };
          readResource?: ReadResourceFn;
          writeResource?: WriteResourceFn;
        },
      ) => {
        const existing = await readHostList(context);
        const seen = new Set(
          existing.hosts.map((h) => `${h.user}@${h.host}:${h.port}`),
        );
        const now = new Date().toISOString();
        const merged = [...existing.hosts];
        for (const raw of args.hosts) {
          const t = parseHostTarget(raw, context.globalArgs.sshUser);
          const key = `${t.user}@${t.host}:${t.port}`;
          if (seen.has(key)) continue;
          seen.add(key);
          merged.push({ ...t, addedAt: now });
        }
        const out: HostList = { hosts: merged, updatedAt: now };
        let hostsHandle: { name: string } = { name: "hosts" };
        if (context.writeResource) {
          hostsHandle = await context.writeResource(
            "hosts",
            "hosts",
            out as unknown as Record<string, unknown>,
          );
        }
        if (context.logger) {
          context.logger.info(`Known hosts: ${merged.length}`);
        }
        return { dataHandles: [hostsHandle] };
      },
    },
    hosts: {
      description: "Show the known (additive) host list",
      arguments: z.object({}),
      execute: async (
        _args: unknown,
        context: { readResource?: ReadResourceFn },
      ) => {
        await readHostList(context);
        return { dataHandles: [{ name: "hosts" }] };
      },
    },
    inventory: {
      description:
        "Inventory SSH private keys across known (or supplied) hosts",
      arguments: InventoryArgsSchema,
      execute: async (
        args: { hosts: string[]; includeLocal?: boolean },
        context: {
          globalArgs: GlobalArgs;
          logger?: { info: (m: string, p?: Record<string, unknown>) => void };
          readResource?: ReadResourceFn;
          writeResource?: WriteResourceFn;
        },
      ) => {
        let targets: HostTarget[] = [];
        if (args.hosts.length > 0) {
          targets = normalizeHostTargets(
            args.hosts,
            context.globalArgs.sshUser,
          );
        } else {
          const list = await readHostList(context);
          targets = list.hosts.map((h) => ({
            user: h.user,
            host: h.host,
            port: h.port,
          }));
        }
        const collected: HostInventory[] = [];
        for (const t of targets) {
          const script = remoteInventoryScript(context.globalArgs.keyPaths);
          const res = await runSsh(
            t.user,
            t.host,
            t.port,
            script,
            context.globalArgs.connectTimeoutSec,
          );
          const target = targetString(t);
          const inv: HostInventory = {
            target,
            user: t.user,
            host: t.host,
            port: t.port,
            ok: res.code === 0,
            error: res.code === 0
              ? ""
              : (res.stderr.trim() || `ssh exited ${res.code}`),
            privateKeys: [],
            authorizedKeys: [],
            collectedAt: new Date().toISOString(),
          };
          if (res.code === 0) {
            const pkLines: string[] = [];
            const authLines: string[] = [];
            for (const line of res.stdout.split(/\r?\n/)) {
              if (line.startsWith("AUTHORIZED\t")) authLines.push(line);
              else if (line.startsWith("PRIVATE\t")) pkLines.push(line);
            }
            const authorizedKeys: HostInventory["authorizedKeys"] = [];
            const authByFp = new Map<string, string[]>();
            for (const line of authLines) {
              const parts = line.split("\t");
              const fp = extractFingerprint(parts[2] || "");
              authorizedKeys.push({
                file: parts[1] || "",
                fingerprint: fp,
                line: parts.slice(3).join("\t"),
              });
              const list = authByFp.get(fp) ?? [];
              list.push(parts[1] || "");
              authByFp.set(fp, list);
            }
            inv.authorizedKeys = authorizedKeys;
            for (const line of pkLines) {
              const pk = parsePrivateLine(line);
              if (pk) {
                pk.authorizedFiles = authByFp.get(pk.fingerprint) ?? [];
                pk.authorized = pk.authorizedFiles.length > 0;
                inv.privateKeys.push(pk);
              }
            }
          }
          collected.push(inv);
          if (context.logger) {
            context.logger.info(
              `${target}: ${
                inv.ok ? inv.privateKeys.length + " keys" : inv.error
              }`,
            );
          }
        }
        const includeLocal = args.includeLocal !== false &&
          context.globalArgs.includeLocal !== false;
        if (includeLocal) {
          const user = Deno.env.get("USER") || Deno.env.get("LOGNAME") ||
            "local";
          const target = `${user}@localhost`;
          const res = await runLocal(
            remoteInventoryScript(context.globalArgs.keyPaths),
            context.globalArgs.connectTimeoutSec,
          );
          const localInv = parseHostOutput(
            target,
            user,
            "localhost",
            0,
            res.stdout,
            res.stderr,
            res.code,
          );
          collected.push(localInv);
          if (context.logger) {
            context.logger.info(
              `${target}: ${
                localInv.ok
                  ? localInv.privateKeys.length + " keys"
                  : localInv.error
              }`,
            );
          }
        }
        const uniqueKeys = buildUniqueKeys(collected);
        const out: InventoryOutput = {
          generatedAt: new Date().toISOString(),
          totalHosts: collected.length,
          reachableHosts: collected.filter((h) => h.ok).length,
          privateKeys: collected.reduce((n, h) => n + h.privateKeys.length, 0),
          uniqueKeys: uniqueKeys.length,
          hosts: collected,
          keys: uniqueKeys.map((k) => {
            const age = computeAgeYears(k.oldestMtime);
            const encState = k.unencryptedCount > 0
              ? (k.encryptedCount > 0 ? null : false)
              : (k.encryptedCount > 0 ? true : null);
            const a = assessKey(
              k.algorithm,
              k.bits,
              encState,
              "",
              age,
              k.occurrences,
            );
            return {
              ...k,
              severity: a.severity,
              issues: a.issues,
              advice: a.advice,
            };
          }),
        };
        let inventoryHandle: { name: string } = { name: "inventory" };
        if (context.writeResource) {
          inventoryHandle = await context.writeResource(
            "inventory",
            "inventory",
            out as unknown as Record<string, unknown>,
          );
        }
        return { dataHandles: [inventoryHandle] };
      },
    },
    report: {
      description: "Render the inventory to an HTML report file",
      arguments: ReportArgsSchema,
      execute: async (
        args: { outputPath: string },
        context: {
          globalArgs: GlobalArgs;
          logger?: { info: (m: string, p?: Record<string, unknown>) => void };
          readResource?: ReadResourceFn;
          writeResource?: WriteResourceFn;
        },
      ) => {
        if (!context.readResource) {
          throw new Error("No inventory data. Run inventory first.");
        }
        const invRaw = await context.readResource("inventory");
        const anyRaw = invRaw as Record<string, unknown>;
        const inv = (anyRaw?.content ?? anyRaw) as InventoryOutput | null;
        if (!inv) throw new Error("No inventory data. Run inventory first.");
        const outputPath = args.outputPath
          ? expandHome(args.outputPath)
          : `${
            expandHome(context.globalArgs.outputDir)
          }/ssh-key-inventory.html`;
        await Deno.mkdir(expandHome(context.globalArgs.outputDir), {
          recursive: true,
        }).catch(() => {});
        const html = renderHtmlReport(inv);
        await Deno.writeTextFile(outputPath, html);
        if (context.logger) context.logger.info(`Wrote ${outputPath}`);
        return { dataHandles: [] as unknown as [{ name: string }] };
      },
    },
    upgrade: {
      description: "Add the specified key, test it, then remove the old key",
      arguments: UpgradeArgsSchema,
      execute: async (
        args: {
          hosts: string[] | string;
          newPrivateKeyPath: string;
          oldFingerprint: string;
          testCommand: string;
          removeOld: boolean;
        },
        context: {
          globalArgs: GlobalArgs;
          logger?: { info: (m: string, p?: Record<string, unknown>) => void };
          readResource?: ReadResourceFn;
          writeResource?: WriteResourceFn;
        },
      ) => {
        const now = new Date().toISOString();
        let hostList: string[] = [];
        if (
          typeof args.hosts === "string" && args.hosts.toLowerCase() === "all"
        ) {
          const list = await readHostList(context);
          hostList = list.hosts.map((h) => `${h.user}@${h.host}`);
        } else if (typeof args.hosts === "string") hostList = [args.hosts];
        else hostList = args.hosts;
        const targets = normalizeHostTargets(
          hostList,
          context.globalArgs.sshUser,
        );
        let pubLine = "";
        try {
          const txt = await Deno.readTextFile(args.newPrivateKeyPath + ".pub");
          pubLine = txt.trim().split(/\r?\n/).find((l) =>
            l.startsWith("ssh-") || l.startsWith("ecdsa-")
          ) || txt.trim();
        } catch {
          try {
            const txt = await Deno.readTextFile(args.newPrivateKeyPath);
            pubLine = txt.trim().split(/\r?\n/).find((l) =>
              l.startsWith("ssh-") || l.startsWith("ecdsa-")
            ) || txt.trim();
          } catch {
            pubLine = "";
          }
        }
        const results: UpgradeResult[] = [];
        for (const t of targets) {
          const target = targetString(t);
          const r: UpgradeResult = {
            target,
            backedUp: false,
            appended: false,
            tested: false,
            removedOld: false,
            error: "",
            rolledBack: false,
          };
          try {
            const ts = Date.now();
            await runSsh(
              t.user,
              t.host,
              t.port,
              `cp -a ~/.ssh/authorized_keys ~/.ssh/authorized_keys.swamp-backup-${ts} 2>/dev/null || true`,
              context.globalArgs.connectTimeoutSec,
            );
            r.backedUp = true;
            const escaped = pubLine.replace(/'/g, "'\\''");
            const appendScript =
              `mkdir -p ~/.ssh && chmod 700 ~/.ssh; grep -qF '${escaped}' ~/.ssh/authorized_keys 2>/dev/null || printf '%s\\n' '${escaped}' >> ~/.ssh/authorized_keys; chmod 600 ~/.ssh/authorized_keys`;
            const ares = await runSsh(
              t.user,
              t.host,
              t.port,
              appendScript,
              context.globalArgs.connectTimeoutSec,
            );
            if (ares.code !== 0) {
              throw new Error(ares.stderr || "append failed");
            }
            r.appended = true;
            const test = new Deno.Command("ssh", {
              args: [
                "-i",
                args.newPrivateKeyPath,
                "-o",
                "BatchMode=yes",
                "-o",
                `ConnectTimeout=${context.globalArgs.connectTimeoutSec}`,
                "-p",
                String(t.port),
                `${t.user}@${t.host}`,
                args.testCommand,
              ],
              stdout: "piped",
              stderr: "piped",
            });
            const tres = await test.output();
            if (tres.code !== 0) {
              throw new Error(
                new TextDecoder().decode(tres.stderr) || "ssh test failed",
              );
            }
            r.tested = true;
            if (args.removeOld && args.oldFingerprint) {
              const fp = args.oldFingerprint.replace(/'/g, "");
              const removeScript =
                `tmp=$(mktemp); grep -vF '${fp}' ~/.ssh/authorized_keys > "$tmp" 2>/dev/null || true; mv "$tmp" ~/.ssh/authorized_keys; chmod 600 ~/.ssh/authorized_keys`;
              const rres = await runSsh(
                t.user,
                t.host,
                t.port,
                removeScript,
                context.globalArgs.connectTimeoutSec,
              );
              if (rres.code !== 0) {
                throw new Error(rres.stderr || "remove failed");
              }
              r.removedOld = true;
            }
          } catch (e) {
            r.error = String(e);
            const rb = await runSsh(
              t.user,
              t.host,
              t.port,
              "ls ~/.ssh/authorized_keys.swamp-backup-* 2>/dev/null | sort | tail -1 | xargs -r -I{} cp {} ~/.ssh/authorized_keys",
              context.globalArgs.connectTimeoutSec,
            );
            r.rolledBack = rb.code === 0;
          }
          results.push(r);
          if (context.logger) {
            context.logger.info(`${target}: ${r.error || "ok"}`);
          }
        }
        const out: UpgradeOutput = {
          generatedAt: now,
          newPublicKey: pubLine,
          results,
        };
        let upgradeHandle: { name: string } = { name: "upgrade" };
        if (context.writeResource) {
          upgradeHandle = await context.writeResource(
            "upgrade",
            "upgrade",
            out as unknown as Record<string, unknown>,
          );
        }
        return { dataHandles: [upgradeHandle] };
      },
    },
  },
};
