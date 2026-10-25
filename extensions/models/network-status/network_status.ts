import { z } from "npm:zod@4";

const HostSpecSchema = z.object({
  name: z.string().min(1),
  address: z.string().min(1),
  user: z.string().default(""),
  port: z.number().int().positive().default(22),
  os: z.string().default(""),
  local: z.boolean().default(false),
}).strict();

const TaskSchema = z.object({
  id: z.string().default(""),
  title: z.string().min(1),
  detail: z.string().default(""),
  severity: z.enum(["info", "low", "medium", "high", "critical"]).default(
    "info",
  ),
  link: z.string().default(""),
  source: z.string().default(""),
  due: z.string().default(""),
  addedAt: z.string().default(""),
});

const PackageUpdateSchema = z.object({
  name: z.string(),
  currentVersion: z.string().nullable(),
  candidateVersion: z.string(),
  origin: z.string(),
  isSecurity: z.boolean(),
  isEsm: z.boolean().default(false),
  cves: z.array(z.string()).default([]),
});

const CveSchema = z.object({
  cve: z.string(),
  package: z.string(),
  installedVersion: z.string(),
  fixedVersions: z.array(z.string()).default([]),
  fixAvailableInSuite: z.boolean().default(false),
});

const ProPackageSchema = z.object({
  package: z.string(),
  version: z.string().default(""),
  service: z.string().default(""),
  status: z.string().default(""),
  origin: z.string().default(""),
});

const ProSecuritySchema = z.object({
  available: z.boolean().default(false),
  standardSecurityUpdates: z.number().default(0),
  esmAppsUpdates: z.number().default(0),
  esmInfraUpdates: z.number().default(0),
  attached: z.boolean().default(false),
  enabledServices: z.array(z.string()).default([]),
  packages: z.array(ProPackageSchema).default([]),
});

const HostResultSchema = z.object({
  name: z.string(),
  address: z.string(),
  user: z.string(),
  port: z.number(),
  local: z.boolean(),
  ok: z.boolean(),
  debian: z.boolean(),
  error: z.string().default(""),
  os: z.string().default(""),
  osLike: z.string().default(""),
  versionId: z.string().default(""),
  codename: z.string().default(""),
  prettyName: z.string().default(""),
  hostname: z.string().default(""),
  arch: z.string().default(""),
  aptExit: z.number().default(0),
  aptError: z.string().default(""),
  updateCount: z.number().default(0),
  securityCount: z.number().default(0),
  esmCount: z.number().default(0),
  cveCount: z.number().default(0),
  actionableCveCount: z.number().default(0),
  debsecanAvailable: z.boolean().default(false),
  updates: z.array(PackageUpdateSchema).default([]),
  cves: z.array(CveSchema).default([]),
  pro: ProSecuritySchema.default(() => ({
    available: false,
    standardSecurityUpdates: 0,
    esmAppsUpdates: 0,
    esmInfraUpdates: 0,
    attached: false,
    enabledServices: [],
    packages: [],
  })),
  checkedAt: z.string(),
  stale: z.boolean().default(false),
});

const TotalsSchema = z.object({
  hosts: z.number(),
  debianHosts: z.number(),
  reachable: z.number(),
  unreachable: z.number(),
  updates: z.number(),
  securityUpdates: z.number(),
  esmUpdates: z.number(),
  cves: z.number(),
  actionableCves: z.number(),
  hostsWithSecurity: z.number(),
  hostsWithUpdates: z.number(),
});

const SummarySchema = z.object({
  generatedAt: z.string(),
  pageTitle: z.string(),
  statusHostname: z.string(),
  outputFile: z.string(),
  tasksFile: z.string(),
  staleAfterHours: z.number(),
  totals: TotalsSchema,
  hosts: z.array(HostResultSchema),
  tasks: z.array(TaskSchema),
  errors: z.array(z.string()).default([]),
});

const TasksSchema = z.object({
  tasks: z.array(TaskSchema),
  updatedAt: z.string(),
});

const CaddyServeSchema = z.object({
  hostname: z.string(),
  root: z.string(),
  serveModel: z.string(),
  sourceModel: z.string(),
  baseDomain: z.string(),
  changed: z.boolean().default(false),
  servedAt: z.string(),
});

const EnsureCaddyServeArgsSchema = z.object({
  model: z.string().default(""),
  hostname: z.string().default(""),
  serveRoot: z.string().default(""),
  serveModel: z.string().default(""),
});

const GlobalArgsSchema = z.object({
  hosts: z.array(z.union([z.string(), HostSpecSchema])).default([]),
  sshUser: z.string().default(""),
  identityFile: z.string().default(""),
  connectTimeoutSec: z.number().int().positive().default(10),
  commandTimeoutSec: z.number().int().positive().default(240),
  parallel: z.number().int().positive().default(8),
  securityOrigin: z.string().default("-security"),
  outputDir: z.string().default("~/.local/share/network-status"),
  outputFile: z.string().default(""),
  tasksFile: z.string().default(""),
  pageTitle: z.string().default("Network status"),
  statusHostname: z.string().default(""),
  staleAfterHours: z.number().positive().default(2),
  cveCheck: z.boolean().default(true),
  tasks: z.array(TaskSchema).default([]),
  caddyModelName: z.string().default(""),
  caddyRouteHostname: z.string().default(""),
  caddyServeModel: z.string().default("status-caddy"),
}).strict();

const AuditArgsSchema = z.object({
  hosts: z.array(z.union([z.string(), HostSpecSchema])).default([]),
  cveCheck: z.boolean().optional(),
  parallel: z.number().int().positive().optional(),
});

const RenderArgsSchema = z.object({});

const AddTaskArgsSchema = z.object({
  id: z.string().default(""),
  title: z.string().min(1),
  detail: z.string().default(""),
  severity: z.enum(["info", "low", "medium", "high", "critical"]).default(
    "info",
  ),
  link: z.string().default(""),
  source: z.string().default(""),
  due: z.string().default(""),
});

const RemoveTaskArgsSchema = z.object({
  id: z.string().min(1),
});

const ClearTasksArgsSchema = z.object({
  confirm: z.boolean().default(false),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;
type HostSpec = z.infer<typeof HostSpecSchema>;
type Task = z.infer<typeof TaskSchema>;
type PackageUpdate = z.infer<typeof PackageUpdateSchema>;
type Cve = z.infer<typeof CveSchema>;
type ProSecurity = z.infer<typeof ProSecuritySchema>;
export type HostResult = z.infer<typeof HostResultSchema>;
export type Summary = z.infer<typeof SummarySchema>;

type WriteResource = (
  specName: string,
  name: string,
  data: Record<string, unknown>,
) => Promise<{ name: string }>;

type ReadResource = (name: string) => Promise<unknown>;

interface MethodContext {
  globalArgs: GlobalArgs;
  writeResource: WriteResource;
  readResource?: ReadResource;
  logger?: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warn?: (msg: string, props?: Record<string, unknown>) => void;
  };
}

export function expandHome(path: string, home?: string): string {
  const h = home ?? Deno.env.get("HOME") ?? "";
  if (path === "~") return h;
  if (path.startsWith("~/")) return `${h}${path.slice(1)}`;
  return path;
}

export function sanitizeName(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe || "host";
}

export function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(
    /^-+|-+$/g,
    "",
  );
}

export function parseHostTarget(raw: string, defaultUser = ""): HostSpec {
  const trimmed = raw.trim();
  let user = defaultUser.trim();
  let hostPart = trimmed;
  const at = trimmed.lastIndexOf("@");
  if (at > 0) {
    user = trimmed.slice(0, at);
    hostPart = trimmed.slice(at + 1);
  }
  let address = hostPart;
  let port = 22;
  if (address.startsWith("[")) {
    const close = address.indexOf("]");
    if (close > 0) {
      const rest = address.slice(close + 1);
      address = address.slice(1, close);
      if (rest.startsWith(":")) {
        const parsed = Number.parseInt(rest.slice(1), 10);
        if (!Number.isNaN(parsed)) port = parsed;
      }
    }
  } else {
    const colonCount = (address.match(/:/g) ?? []).length;
    if (colonCount === 1) {
      const [h, p] = address.split(":");
      const parsed = Number.parseInt(p ?? "", 10);
      if (h && !Number.isNaN(parsed)) {
        address = h;
        port = parsed;
      }
    }
  }
  if (!address) throw new Error(`Invalid host target '${raw}'`);
  return { name: address, address, user, port, os: "", local: false };
}

export function normalizeHosts(
  raw: Array<string | HostSpec> | undefined,
  defaultUser = "",
): HostSpec[] {
  const out: HostSpec[] = [];
  const seen = new Set<string>();
  for (const item of raw ?? []) {
    let spec: HostSpec;
    if (typeof item === "string") {
      spec = parseHostTarget(item, defaultUser);
    } else {
      spec = {
        name: item.name || item.address,
        address: item.address,
        user: item.user || defaultUser,
        port: item.port || 22,
        os: item.os || "",
        local: item.local === true ||
          item.address === "localhost" ||
          item.address === "127.0.0.1" ||
          item.address === "::1",
      };
    }
    if (!spec.name) spec.name = spec.address;
    if (
      spec.address === "localhost" ||
      spec.address === "127.0.0.1" ||
      spec.address === "::1"
    ) {
      spec.local = true;
    }
    const key = `${
      spec.local ? "local" : spec.user || defaultUser
    }@${spec.address}:${spec.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(spec);
  }
  return out;
}

export function parseSections(stdout: string): Map<string, string> {
  const sections = new Map<string, string>();
  let current = "";
  let buffer: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith("###") && line.trim().length > 3) {
      if (current) sections.set(current, buffer.join("\n"));
      current = line.slice(3).trim();
      buffer = [];
    } else {
      buffer.push(line);
    }
  }
  if (current) sections.set(current, buffer.join("\n"));
  return sections;
}

export function parseAptSimulation(
  stdout: string,
  securityOrigin: string,
  securityPackages: Set<string> = new Set(),
  esmPackages: Set<string> = new Set(),
): PackageUpdate[] {
  const results: PackageUpdate[] = [];
  const instLineRe = /^Inst (\S+) (?:\[([^\]]+)\] )?\(([^)]+)\)/;
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("Inst ")) continue;
    const match = instLineRe.exec(line);
    if (!match) continue;
    const [, name, currentVersion, parenContents] = match;
    const archBracketMatch = /^(.*?)\s*\[[^\]]*\]$/.exec(parenContents);
    const withoutArch = archBracketMatch ? archBracketMatch[1] : parenContents;
    const firstSpace = withoutArch.indexOf(" ");
    const candidateVersion = firstSpace === -1
      ? withoutArch
      : withoutArch.slice(0, firstSpace);
    const origin = firstSpace === -1
      ? ""
      : withoutArch.slice(firstSpace + 1).trim();
    const isEsm = esmPackages.has(name) ||
      origin.includes("esm.ubuntu.com") ||
      origin.includes("esm-apps") ||
      origin.includes("esm-infra");
    results.push({
      name,
      currentVersion: currentVersion ?? null,
      candidateVersion,
      origin,
      isSecurity: securityOrigin.length > 0 && origin.includes(securityOrigin),
      isEsm,
      cves: [],
    });
  }
  for (const update of results) {
    if (securityPackages.has(update.name)) update.isSecurity = true;
  }
  return results;
}

export function parseDebsecanDetail(stdout: string): Cve[] {
  const results: Cve[] = [];
  for (const block of stdout.split("\n\n")) {
    const cveMatch = /^(CVE-\S+)/.exec(block);
    const installedMatch = /^ {2}installed: (\S+) (\S+)/m.exec(block);
    if (!cveMatch || !installedMatch) continue;
    const [, cve] = cveMatch;
    const [, pkg, installedVersion] = installedMatch;
    const fixedVersions = [
      ...block.matchAll(/^ {2}fixed on branch:\s+\S+ (\S+)/gm),
    ].map((m) => m[1]);
    const fixAvailableInSuite = /^ {2}fix is available for the selected suite/m
      .test(block);
    results.push({
      cve,
      package: pkg,
      installedVersion,
      fixedVersions,
      fixAvailableInSuite,
    });
  }
  return results;
}

export function parseProSecurity(json: string): ProSecurity {
  const empty: ProSecurity = {
    available: false,
    standardSecurityUpdates: 0,
    esmAppsUpdates: 0,
    esmInfraUpdates: 0,
    attached: false,
    enabledServices: [],
    packages: [],
  };
  const trimmed = json.trim();
  if (!trimmed.startsWith("{")) return empty;
  try {
    const data = JSON.parse(trimmed) as Record<string, unknown>;
    const summary = (data.summary ?? {}) as Record<string, unknown>;
    const ua = (summary.ua ?? {}) as Record<string, unknown>;
    const packages = Array.isArray(data.packages) ? data.packages : [];
    return {
      available: true,
      standardSecurityUpdates:
        Number(summary.num_standard_security_updates ?? 0) || 0,
      esmAppsUpdates: Number(summary.num_esm_apps_updates ?? 0) || 0,
      esmInfraUpdates: Number(summary.num_esm_infra_updates ?? 0) || 0,
      attached: ua.attached === true,
      enabledServices: Array.isArray(ua.enabled_services)
        ? ua.enabled_services.map(String)
        : [],
      packages: packages.map((p) => {
        const row = p as Record<string, unknown>;
        return {
          package: String(row.package ?? ""),
          version: String(row.version ?? ""),
          service: String(row.service_name ?? ""),
          status: String(row.status ?? ""),
          origin: String(row.origin ?? ""),
        };
      }).filter((p) => p.package.length > 0),
    };
  } catch {
    return empty;
  }
}

export function matchCves(
  updates: PackageUpdate[],
  cves: Cve[],
): PackageUpdate[] {
  return updates.map((update) => ({
    ...update,
    cves: [
      ...new Set(
        cves.filter((c) => c.package === update.name).map((c) => c.cve),
      ),
    ].sort(),
  }));
}

export function buildRemoteScript(): string {
  return [
    "set -u",
    ". /etc/os-release 2>/dev/null || true",
    'printf "###ID\\n%s\\n" "${ID:-}"',
    'printf "###ID_LIKE\\n%s\\n" "${ID_LIKE:-}"',
    'printf "###VERSION_ID\\n%s\\n" "${VERSION_ID:-}"',
    'printf "###VERSION_CODENAME\\n%s\\n" "${VERSION_CODENAME:-}"',
    'printf "###PRETTY_NAME\\n%s\\n" "${PRETTY_NAME:-}"',
    'printf "###HOSTNAME\\n"',
    "hostname 2>/dev/null || true",
    'printf "###UNAME\\n"',
    "uname -m 2>/dev/null || true",
    "if ! command -v apt-get >/dev/null 2>&1; then printf '###NOT_DEBIAN\\n'; exit 0; fi",
    'case " ${ID:-} ${ID_LIKE:-} " in',
    "  *debian*|*ubuntu*|*raspbian*) ;;",
    "  *) printf '###NOT_DEBIAN\\n'; exit 0 ;;",
    "esac",
    "APT_OUT=$(apt-get -s -qq dist-upgrade 2>&1)",
    "APT_EXIT=$?",
    'printf "###APT_EXIT\\n%s\\n###APT\\n%s\\n###ENDAPT\\n" "$APT_EXIT" "$APT_OUT"',
    'printf "###PRO\\n"',
    "if command -v pro >/dev/null 2>&1; then",
    "  pro security-status --format json 2>/dev/null || true",
    "else",
    '  printf "__MISSING__\\n"',
    "fi",
    'printf "###DEBSECAN\\n"',
    "if command -v debsecan >/dev/null 2>&1; then",
    '  debsecan --suite "${VERSION_CODENAME:-stable}" --format detail 2>/dev/null || true',
    "else",
    '  printf "__MISSING__\\n"',
    "fi",
    'printf "###END\\n"',
  ].join("\n");
}

async function runCommand(
  cmd: "sh" | "ssh",
  args: string[],
  script: string,
  timeoutSec: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);
  try {
    // swamp-quality-ignore deno-command: only ssh/sh are used, args come from the typed host config, and the probe is piped via stdin rather than interpolated into a command string — see README.
    const child = new Deno.Command(cmd, {
      args,
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
    const output = await process.output();
    return {
      code: status.code,
      stdout: new TextDecoder().decode(output.stdout),
      stderr: new TextDecoder().decode(output.stderr),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { code: 124, stdout: "", stderr: message };
  } finally {
    clearTimeout(timer);
  }
}

async function runOnHost(
  spec: HostSpec,
  script: string,
  opts: {
    sshUser: string;
    identityFile: string;
    connectTimeoutSec: number;
    commandTimeoutSec: number;
  },
): Promise<{ code: number; stdout: string; stderr: string }> {
  if (spec.local) {
    return await runCommand("sh", ["-s"], script, opts.commandTimeoutSec);
  }
  const user = spec.user || opts.sshUser ||
    Deno.env.get("USER") || Deno.env.get("LOGNAME") || "root";
  const args = [
    "-o",
    "BatchMode=yes",
    "-o",
    `ConnectTimeout=${opts.connectTimeoutSec}`,
    "-o",
    "StrictHostKeyChecking=accept-new",
  ];
  if (opts.identityFile) args.push("-i", expandHome(opts.identityFile));
  args.push(
    "-p",
    String(spec.port || 22),
    `${user}@${spec.address}`,
    "sh",
    "-s",
  );
  return await runCommand("ssh", args, script, opts.commandTimeoutSec);
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      while (true) {
        const index = next++;
        if (index >= items.length) return;
        results[index] = await fn(items[index]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function sectionValue(sections: Map<string, string>, key: string): string {
  return (sections.get(key) ?? "").trim();
}

export function parseHostOutput(
  spec: HostSpec,
  result: { code: number; stdout: string; stderr: string },
  securityOrigin: string,
  checkedAt: string,
  staleAfterHours: number,
  cveCheck = true,
  now = Date.now(),
): HostResult {
  const sections = parseSections(result.stdout);
  const notDebian = sections.has("NOT_DEBIAN");
  const os = sectionValue(sections, "ID");
  const osLike = sectionValue(sections, "ID_LIKE");
  const parsedAptExit = Number.parseInt(
    sectionValue(sections, "APT_EXIT"),
    10,
  );
  const aptExit = Number.isNaN(parsedAptExit) ? 0 : parsedAptExit;
  const aptOutput = sections.get("APT") ?? "";
  const proRaw = sections.get("PRO") ?? "";
  const debsecanRaw = sections.get("DEBSECAN") ?? "";
  const pro = parseProSecurity(proRaw);
  const debsecanAvailable = cveCheck && debsecanRaw.trim().length > 0 &&
    !debsecanRaw.includes("__MISSING__");
  const cves = debsecanAvailable ? parseDebsecanDetail(debsecanRaw) : [];
  const proSecurityPackages = new Set(
    pro.packages
      .filter((p) => p.service.startsWith("standard-security"))
      .map((p) => p.package),
  );
  const proEsmPackages = new Set(
    pro.packages
      .filter((p) => p.service.startsWith("esm-"))
      .map((p) => p.package),
  );
  const updates = matchCves(
    parseAptSimulation(
      aptOutput,
      securityOrigin,
      proSecurityPackages,
      proEsmPackages,
    ),
    cves,
  );
  const securityCount = updates.filter((u) => u.isSecurity).length;
  const esmCount = updates.filter((u) => u.isEsm).length;
  const aptError = aptExit !== 0
    ? (aptOutput.split("\n").filter((l) => l.startsWith("E:")).join("\n") ||
      `apt-get exited ${aptExit}`)
    : "";
  const ok = result.code === 0 && !notDebian;
  const checked = new Date(checkedAt).getTime();
  const stale = now - checked > staleAfterHours * 3600 * 1000;
  return {
    name: spec.name,
    address: spec.address,
    user: spec.user,
    port: spec.port,
    local: spec.local,
    ok,
    debian: !notDebian && (os.length > 0 || updates.length > 0),
    error: result.code === 0
      ? (notDebian ? "not a Debian-based host" : "")
      : (result.stderr.trim() || `exit ${result.code}`),
    os,
    osLike,
    versionId: sectionValue(sections, "VERSION_ID"),
    codename: sectionValue(sections, "VERSION_CODENAME"),
    prettyName: sectionValue(sections, "PRETTY_NAME"),
    hostname: sectionValue(sections, "HOSTNAME"),
    arch: sectionValue(sections, "UNAME"),
    aptExit,
    aptError,
    updateCount: updates.length,
    securityCount,
    esmCount,
    cveCount: cves.length,
    actionableCveCount: cves.filter((c) => c.fixAvailableInSuite).length,
    debsecanAvailable,
    updates: updates.sort((a, b) =>
      Number(b.isSecurity) - Number(a.isSecurity) ||
      a.name.localeCompare(b.name)
    ),
    cves,
    pro,
    checkedAt,
    stale,
  };
}

function countTotals(hosts: HostResult[]): z.infer<typeof TotalsSchema> {
  return {
    hosts: hosts.length,
    debianHosts: hosts.filter((h) => h.debian).length,
    reachable: hosts.filter((h) => h.ok).length,
    unreachable: hosts.filter((h) => !h.ok).length,
    updates: hosts.reduce((n, h) => n + h.updateCount, 0),
    securityUpdates: hosts.reduce((n, h) => n + h.securityCount, 0),
    esmUpdates: hosts.reduce((n, h) => n + h.esmCount, 0),
    cves: hosts.reduce((n, h) => n + h.cveCount, 0),
    actionableCves: hosts.reduce((n, h) => n + h.actionableCveCount, 0),
    hostsWithSecurity: hosts.filter((h) => h.securityCount > 0).length,
    hostsWithUpdates: hosts.filter((h) => h.updateCount > 0).length,
  };
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-AU").format(value);
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso || "never";
  return date.toLocaleString("en-AU", {
    timeZone: "Australia/Brisbane",
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function statusClass(host: HostResult): string {
  if (!host.ok) return "bad";
  if (host.securityCount > 0) return "warn";
  if (host.updateCount > 0) return "info";
  return "good";
}

function statusLabel(host: HostResult): string {
  if (!host.ok) return host.debian ? "unreachable" : "not Debian";
  if (host.securityCount > 0) return "security updates";
  if (host.updateCount > 0) return "updates available";
  return "up to date";
}

function cveLink(cve: string): string {
  return `<a href="https://security-tracker.debian.org/tracker/${
    encodeURIComponent(cve)
  }" target="_blank" rel="noopener">${escapeHtml(cve)}</a>`;
}

function renderTask(task: Task): string {
  const link = task.link
    ? ` <a href="${
      escapeHtml(task.link)
    }" target="_blank" rel="noopener">open</a>`
    : "";
  const due = task.due
    ? ` <span class="muted">due ${escapeHtml(task.due)}</span>`
    : "";
  const source = task.source
    ? ` <span class="muted">via ${escapeHtml(task.source)}</span>`
    : "";
  return `<li class="task sev-${escapeHtml(task.severity)}">
    <div><span class="badge ${escapeHtml(task.severity)}">${
    escapeHtml(task.severity)
  }</span> <strong>${
    escapeHtml(task.title)
  }</strong>${link}${due}${source}</div>
    ${task.detail ? `<div class="muted">${escapeHtml(task.detail)}</div>` : ""}
  </li>`;
}

function renderUpdateTable(host: HostResult, onlySecurity: boolean): string {
  const rows = onlySecurity
    ? host.updates.filter((u) => u.isSecurity)
    : host.updates;
  if (rows.length === 0) {
    return `<p class="muted">${
      onlySecurity ? "No pending security updates." : "No pending updates."
    }</p>`;
  }
  const body = rows.map((u) => {
    const cves = u.cves.length > 0
      ? u.cves.map(cveLink).join(", ")
      : `<span class="muted">—</span>`;
    const tags = [
      u.isSecurity ? `<span class="badge high">security</span>` : "",
      u.isEsm ? `<span class="badge medium">ESM</span>` : "",
    ].filter(Boolean).join(" ");
    return `<tr class="${u.isSecurity ? "security-row" : ""}">
      <td><code>${escapeHtml(u.name)}</code> ${tags}</td>
      <td class="muted">${escapeHtml(u.currentVersion ?? "not installed")}</td>
      <td>${escapeHtml(u.candidateVersion)}</td>
      <td class="muted">${escapeHtml(u.origin)}</td>
      <td>${cves}</td>
    </tr>`;
  }).join("");
  return `<table>
    <thead><tr><th>Package</th><th>Installed</th><th>Candidate</th><th>Origin</th><th>CVEs</th></tr></thead>
    <tbody>${body}</tbody>
  </table>`;
}

function renderHostDetails(host: HostResult): string {
  if (!host.ok) {
    return `<p class="muted">No package data collected. ${
      escapeHtml(host.error)
    }</p>`;
  }
  const securityTable = renderUpdateTable(host, true);
  const allTable = renderUpdateTable(host, false);
  const cveBlock = host.cves.length > 0
    ? `<details><summary>${
      formatNumber(host.cves.length)
    } CVE(s) from debsecan</summary>
        <table><thead><tr><th>CVE</th><th>Package</th><th>Installed</th><th>Fixed versions</th><th>Fix available</th></tr></thead>
        <tbody>${
      host.cves.map((c) =>
        `<tr><td>${cveLink(c.cve)}</td><td><code>${
          escapeHtml(c.package)
        }</code></td><td class="muted">${
          escapeHtml(c.installedVersion)
        }</td><td class="muted">${
          escapeHtml(c.fixedVersions.join(", ") || "—")
        }</td><td>${c.fixAvailableInSuite ? "yes" : "no"}</td></tr>`
      ).join("")
    }</tbody></table>
      </details>`
    : `<p class="muted">${
      host.debsecanAvailable
        ? "No CVEs reported by debsecan."
        : "debsecan is not installed on this host, so CVE detail is unavailable. The security-origin package list above is still authoritative."
    }</p>`;
  const proBlock = host.pro.available
    ? `<div class="pro"><strong>Ubuntu security status:</strong>
        ${
      formatNumber(host.pro.standardSecurityUpdates)
    } standard security update(s),
        ${formatNumber(host.pro.esmAppsUpdates)} ESM app update(s),
        ${formatNumber(host.pro.esmInfraUpdates)} ESM infra update(s).
        ${
      host.pro.attached
        ? "Ubuntu Pro is attached."
        : "Ubuntu Pro is not attached; ESM updates are not installable until it is."
    }
      </div>`
    : "";
  return `${proBlock}${securityTable}${host.cves.length > 0 ? cveBlock : ""}
    <details><summary>All pending updates (${
    formatNumber(host.updateCount)
  })</summary>${allTable}</details>
    <div class="remediate"><span class="muted">Apply:</span> <code>ssh ${
    escapeHtml(host.user ? `${host.user}@` : "")
  }${
    escapeHtml(host.address)
  } 'sudo apt-get update &amp;&amp; sudo apt-get -y dist-upgrade'</code></div>`;
}

export function buildHtml(summary: Summary, pageUrl = ""): string {
  const t = summary.totals;
  const overall = t.securityUpdates > 0 || t.unreachable > 0
    ? "attention"
    : (t.updates > 0 ? "updates" : "clear");
  const overallLabel = overall === "attention"
    ? "Attention needed"
    : overall === "updates"
    ? "Updates available"
    : "All clear";
  const hostRows = summary.hosts
    .slice()
    .sort((a, b) =>
      Number(b.securityCount > 0) - Number(a.securityCount > 0) ||
      b.securityCount - a.securityCount ||
      Number(!b.ok) - Number(!a.ok) ||
      b.updateCount - a.updateCount ||
      a.name.localeCompare(b.name)
    )
    .map((host) => {
      const cls = statusClass(host);
      const title = host.hostname && host.hostname !== host.name
        ? `${host.name} (${host.hostname})`
        : host.name;
      return `<details class="host ${cls}">
        <summary>
          <span class="dot ${cls}"></span>
          <strong>${escapeHtml(title)}</strong>
          <span class="muted">${
        escapeHtml(
          host.prettyName ||
            [host.os, host.versionId].filter(Boolean).join(" "),
        )
      }</span>
          <span class="pill ${cls}">${escapeHtml(statusLabel(host))}</span>
          <span class="nums">${formatNumber(host.updateCount)} pending · ${
        formatNumber(host.securityCount)
      } security${
        host.esmCount ? ` · ${formatNumber(host.esmCount)} ESM` : ""
      }</span>
          <span class="muted">checked ${
        escapeHtml(formatTime(host.checkedAt))
      }${host.stale ? " · STALE" : ""}</span>
        </summary>
        ${renderHostDetails(host)}
      </details>`;
    })
    .join("");
  const tasks = summary.tasks.length > 0
    ? `<ul class="tasks">${summary.tasks.map(renderTask).join("")}</ul>`
    : `<p class="muted">No additional network tasks are recorded yet. Add one with <code>swamp model @svendowideit/network-status method run addTask status --input title="..."</code>, or let another workflow write <code>${
      escapeHtml(summary.tasksFile)
    }</code>.</p>`;
  const errors = summary.errors.length > 0
    ? `<div class="errors"><strong>Collector errors</strong><ul>${
      summary.errors.map((e) => `<li>${escapeHtml(e)}</li>`).join("")
    }</ul></div>`
    : "";
  const pageLink = pageUrl
    ? `<a href="${escapeHtml(pageUrl)}">${escapeHtml(pageUrl)}</a>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="3600">
<title>${escapeHtml(summary.pageTitle)}</title>
<style>
:root{color-scheme:light dark;--bg:#f7f7f8;--panel:#fff;--text:#16181d;--muted:#666b76;--line:#e3e5ea;--good:#16794b;--info:#1e63c4;--warn:#a65a00;--bad:#b42318;--chip:#eef0f4}
@media (prefers-color-scheme:dark){:root{--bg:#111317;--panel:#1a1d23;--text:#eef0f4;--muted:#9aa1ae;--line:#2b303a;--good:#5bd39a;--info:#7db1ff;--warn:#ffc46b;--bad:#ff8a80;--chip:#252a33}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:1180px;margin:0 auto;padding:24px 18px 60px}
header{display:flex;flex-wrap:wrap;gap:12px;align-items:baseline;justify-content:space-between;margin-bottom:18px}
h1{font-size:1.55rem;margin:0}h2{font-size:1.12rem;margin:26px 0 10px}
.muted{color:var(--muted)}a{color:var(--info)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px}
.card .num{font-size:1.55rem;font-weight:700;line-height:1.2}.card .label{color:var(--muted);font-size:.85rem}
.overall{display:inline-block;padding:4px 10px;border-radius:999px;font-weight:700;font-size:.85rem}
.overall.clear{background:rgba(22,121,75,.14);color:var(--good)}.overall.updates{background:rgba(30,99,196,.14);color:var(--info)}.overall.attention{background:rgba(180,35,24,.14);color:var(--bad)}
section.panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px;margin-top:14px}
details.host{border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin:8px 0;background:var(--panel)}
details.host summary{cursor:pointer;display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;list-style:none}
details.host summary::-webkit-details-marker{display:none}
.dot{width:10px;height:10px;border-radius:50%;display:inline-block}.dot.good{background:var(--good)}.dot.info{background:var(--info)}.dot.warn{background:var(--warn)}.dot.bad{background:var(--bad)}
.pill{border-radius:999px;padding:2px 8px;font-size:.78rem;background:var(--chip)}.pill.good{color:var(--good)}.pill.info{color:var(--info)}.pill.warn{color:var(--warn)}.pill.bad{color:var(--bad)}
.nums{font-variant-numeric:tabular-nums}
table{border-collapse:collapse;width:100%;font-size:.88rem;margin:10px 0}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:600}code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.86em;background:var(--chip);padding:1px 5px;border-radius:5px}
tr.security-row{background:rgba(180,35,24,.06)}
.badge{display:inline-block;border-radius:999px;padding:1px 7px;font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.02em;background:var(--chip)}
.badge.info{color:var(--info)}.badge.low{color:var(--muted)}.badge.medium{color:var(--warn)}.badge.high{color:var(--bad)}.badge.critical{color:#fff;background:var(--bad)}
.tasks{list-style:none;padding:0;margin:0}.task{border-bottom:1px solid var(--line);padding:8px 0}.task:last-child{border-bottom:0}
.pro{background:var(--chip);border-radius:8px;padding:8px 10px;margin:8px 0;font-size:.9rem}
.remediate{margin-top:8px;font-size:.86rem}.errors{border:1px solid var(--bad);border-radius:10px;padding:10px 12px;margin-top:14px}
footer{margin-top:26px;color:var(--muted);font-size:.82rem}
</style>
</head>
<body><main>
<header>
  <div><h1>${
    escapeHtml(summary.pageTitle)
  }</h1><div class="muted">Debian-family package and security audit · generated ${
    escapeHtml(formatTime(summary.generatedAt))
  } · ${escapeHtml(summary.statusHostname || "local")}</div></div>
  <div><span class="overall ${overall}">${escapeHtml(overallLabel)}</span></div>
</header>
<div class="grid">
  <div class="card"><div class="num">${
    formatNumber(t.hosts)
  }</div><div class="label">hosts checked</div></div>
  <div class="card"><div class="num">${
    formatNumber(t.updates)
  }</div><div class="label">pending updates</div></div>
  <div class="card"><div class="num">${
    formatNumber(t.securityUpdates)
  }</div><div class="label">security updates</div></div>
  <div class="card"><div class="num">${
    formatNumber(t.esmUpdates)
  }</div><div class="label">ESM updates</div></div>
  <div class="card"><div class="num">${
    formatNumber(t.actionableCves)
  }</div><div class="label">CVEs with fixes</div></div>
  <div class="card"><div class="num">${
    formatNumber(t.unreachable)
  }</div><div class="label">unreachable</div></div>
</div>
<section class="panel">
  <h2>What to do next</h2>
  ${tasks}
</section>
<section class="panel">
  <h2>Security updates</h2>
  ${
    t.securityUpdates === 0
      ? `<p class="muted">No security-origin package updates are pending on any reachable Debian-family host.</p>`
      : summary.hosts.filter((h) => h.ok && h.securityCount > 0).map((h) =>
        `<h3>${escapeHtml(h.name)} <span class="muted">(${
          formatNumber(h.securityCount)
        } security update(s))</span></h3>${renderUpdateTable(h, true)}`
      ).join("")
  }
</section>
<section class="panel">
  <h2>Hosts</h2>
  ${
    hostRows ||
    `<p class="muted">No hosts configured. Add them to the model's <code>hosts</code> global argument.</p>`
  }
</section>
<section class="panel">
  <h2>All pending updates</h2>
  ${
    t.updates === 0
      ? `<p class="muted">No pending package updates on any reachable host.</p>`
      : summary.hosts.filter((h) => h.ok && h.updateCount > 0).map((h) =>
        `<h3>${escapeHtml(h.name)} <span class="muted">(${
          formatNumber(h.updateCount)
        } pending)</span></h3>${renderUpdateTable(h, false)}`
      ).join("")
  }
</section>
${errors}
<footer>
  <div>Next automatic run: hourly while <code>swamp serve</code> is running. This page refreshes every hour.</div>
  ${pageLink ? `<div>${pageLink}</div>` : ""}
</footer>
</main></body></html>`;
}

function deriveOutputFile(g: GlobalArgs): string {
  const base = expandHome(g.outputDir);
  if (g.outputFile) return expandHome(g.outputFile);
  return `${base}/site/index.html`;
}

function deriveTasksFile(g: GlobalArgs): string {
  if (g.tasksFile) return expandHome(g.tasksFile);
  return `${expandHome(g.outputDir)}/tasks.json`;
}

function normalizeTask(task: Task): Task {
  return {
    ...task,
    id: task.id || slugify(task.title),
    addedAt: task.addedAt || new Date().toISOString(),
  };
}

async function readTasks(g: GlobalArgs): Promise<Task[]> {
  const byId = new Map<string, Task>();
  for (const task of g.tasks) {
    const normalized = normalizeTask(task);
    byId.set(normalized.id, normalized);
  }
  const path = deriveTasksFile(g);
  try {
    const raw = await Deno.readTextFile(path);
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      for (const task of parsed) {
        const normalized = normalizeTask(TaskSchema.parse(task));
        byId.set(normalized.id, normalized);
      }
    }
  } catch {
    return [...byId.values()];
  }
  const rank: Record<Task["severity"], number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
    info: 4,
  };
  return [...byId.values()].sort((a, b) =>
    rank[a.severity] - rank[b.severity] || a.title.localeCompare(b.title)
  );
}

async function writeTasks(g: GlobalArgs, tasks: Task[]): Promise<Task[]> {
  const path = deriveTasksFile(g);
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".";
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(path, JSON.stringify(tasks, null, 2) + "\n");
  return tasks;
}

async function readSummary(context: MethodContext): Promise<Summary | null> {
  if (!context.readResource) return null;
  try {
    const raw = await context.readResource("summary");
    if (!raw) return null;
    const anyRaw = raw as Record<string, unknown>;
    return SummarySchema.parse(anyRaw.content ?? anyRaw);
  } catch {
    return null;
  }
}

async function writePage(
  g: GlobalArgs,
  summary: Summary,
): Promise<string> {
  const file = deriveOutputFile(g);
  const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : ".";
  await Deno.mkdir(dir, { recursive: true });
  const pageUrl = g.statusHostname ? `https://${g.statusHostname}` : "";
  await Deno.writeTextFile(file, buildHtml(summary, pageUrl));
  return file;
}

async function buildSummary(
  g: GlobalArgs,
  context: MethodContext,
  hosts: HostSpec[],
  cveCheck: boolean,
  parallel: number,
): Promise<{ summary: Summary; summaryHandle: { name: string } }> {
  const script = buildRemoteScript();
  const errors: string[] = [];
  const results = await mapWithConcurrency(hosts, parallel, async (spec) => {
    const started = new Date().toISOString();
    try {
      const result = await runOnHost(spec, script, {
        sshUser: g.sshUser,
        identityFile: g.identityFile,
        connectTimeoutSec: g.connectTimeoutSec,
        commandTimeoutSec: g.commandTimeoutSec,
      });
      return parseHostOutput(
        spec,
        result,
        g.securityOrigin,
        started,
        g.staleAfterHours,
        cveCheck,
      );
    } catch (err) {
      errors.push(
        `${spec.name}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return parseHostOutput(
        spec,
        { code: 1, stdout: "", stderr: String(err) },
        g.securityOrigin,
        started,
        g.staleAfterHours,
        cveCheck,
      );
    }
  });
  for (const host of results) {
    if (!host.ok && host.error) errors.push(`${host.name}: ${host.error}`);
    if (host.aptError) errors.push(`${host.name}: ${host.aptError}`);
  }
  const tasks = await readTasks(g);
  const generatedAt = new Date().toISOString();
  const summary: Summary = {
    generatedAt,
    pageTitle: g.pageTitle,
    statusHostname: g.statusHostname,
    outputFile: deriveOutputFile(g),
    tasksFile: deriveTasksFile(g),
    staleAfterHours: g.staleAfterHours,
    totals: countTotals(results),
    hosts: results,
    tasks,
    errors: [...new Set(errors)],
  };
  for (const host of results) {
    await context.writeResource(
      "host",
      `host-${sanitizeName(host.name)}`,
      host,
    );
  }
  const summaryHandle = await context.writeResource(
    "summary",
    "summary",
    summary as unknown as Record<string, unknown>,
  );
  const file = await writePage(g, summary);
  context.logger?.info(
    "Network status: {hosts} hosts, {updates} pending, {security} security, page {file}",
    {
      hosts: summary.totals.hosts,
      updates: summary.totals.updates,
      security: summary.totals.securityUpdates,
      file,
    },
  );
  return { summary: { ...summary, outputFile: file }, summaryHandle };
}

interface CaddyModelFacts {
  modelName: string;
  baseDomain: string;
  hostFqdn: string;
  serviceName: string;
  target: string;
}

export function parseCaddyModelFacts(
  modelName: string,
  raw: { globalArguments?: Record<string, unknown> },
  hostname = "",
): CaddyModelFacts {
  const g = (raw.globalArguments ?? {}) as Record<string, unknown>;
  const baseDomain = typeof g.baseDomain === "string" ? g.baseDomain : "";
  const serviceName = typeof g.serviceName === "string" && g.serviceName
    ? g.serviceName
    : "caddy";
  const target = typeof g.target === "string" ? g.target : "";
  const records = Array.isArray(g.dnsRecords)
    ? (g.dnsRecords as Array<Record<string, unknown>>)
    : [];
  const base = baseDomain.toLowerCase().replace(/^\.+/, "");
  const shortHost = hostname.split(".")[0].toLowerCase();
  const candidates: string[] = [];
  for (const r of records) {
    if (typeof r.name !== "string" || typeof r.type !== "string") continue;
    const type = r.type.toUpperCase();
    if (type !== "A" && type !== "AAAA") continue;
    const name = r.name.toLowerCase().replace(/^\.+/, "");
    if (base && name !== base && !name.endsWith(`.${base}`)) continue;
    const value = Array.isArray(r.value) ? r.value : [];
    if (!value.some((v) => typeof v === "string" && !!v)) continue;
    candidates.push(name);
  }
  const named = candidates.find(
    (n) => shortHost && n.split(".")[0] === shortHost,
  );
  const deepest = candidates.slice().sort(
    (a, b) => b.split(".").length - a.split(".").length,
  )[0];
  const hostFqdn = named ?? deepest ?? baseDomain;
  return { modelName, baseDomain, hostFqdn, serviceName, target };
}

export function caddyModelNames(listJson: string): string[] {
  try {
    const parsed = JSON.parse(listJson) as {
      results?: Array<{ name?: unknown; type?: unknown }>;
    };
    return (parsed.results ?? [])
      .filter((r) =>
        r.type === "@svendowideit/caddy" && typeof r.name === "string"
      )
      .map((r) => r.name as string);
  } catch {
    return [];
  }
}

export function pickSourceCaddy(
  facts: CaddyModelFacts[],
  hostname: string,
): CaddyModelFacts | null {
  const shortHost = hostname.split(".")[0].toLowerCase();
  const matches = facts.filter(
    (f) => shortHost && f.hostFqdn.split(".")[0] === shortHost,
  );
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) return null;
  const withDomain = facts.filter((f) => f.baseDomain);
  return withDomain.length === 1 ? withDomain[0] : null;
}

export function statusRouteHostname(
  hostFqdn: string,
  label = "status",
): string {
  const host = hostFqdn.trim().replace(/^\.+/, "");
  if (!host) return "";
  const prefix = `${label}.`;
  return host.startsWith(prefix) ? host : `${prefix}${host}`;
}

export function machineHostname(): string {
  try {
    return Deno.hostname();
  } catch {
    return Deno.env.get("HOSTNAME") ?? "";
  }
}

export async function runSwampCmd(
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    // swamp-quality-ignore deno-command: optional caddy peer discovered at runtime; args are fixed literals plus typed model names/hostnames, never a shell string — see README.
    const proc = new Deno.Command("swamp", {
      args,
      stdout: "piped",
      stderr: "piped",
    });
    const out = await proc.output();
    return {
      stdout: new TextDecoder().decode(out.stdout),
      stderr: new TextDecoder().decode(out.stderr),
      code: out.code,
    };
  } catch (err) {
    return {
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
      code: 127,
    };
  }
}

function deriveSiteDir(g: GlobalArgs): string {
  const file = deriveOutputFile(g);
  return file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : ".";
}

export const model = {
  type: "@svendowideit/network-status",
  version: "2026.10.25.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.10.25.1",
      description:
        "Initial release: audit pending Debian-family package updates over SSH, " +
        "classify security updates (apt security origin, Ubuntu Pro security " +
        "status, debsecan CVEs), aggregate the results into one extensible HTML " +
        "status page, and expose addTask/removeTask/clearTasks for other " +
        "workflows to add network-wide action items.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    summary: {
      description: "Aggregated package and security status for every host",
      schema: SummarySchema,
      lifetime: "infinite",
      garbageCollection: 30,
    },
    host: {
      description: "Per-host package and security audit result",
      schema: HostResultSchema,
      lifetime: "infinite",
      garbageCollection: 30,
    },
    tasks: {
      description: "Network-wide action items shown on the status page",
      schema: TasksSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    caddyServe: {
      description: "The Caddy file_server route that serves the status page",
      schema: CaddyServeSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    audit: {
      description:
        "Audit pending package and security updates on every configured " +
        "Debian-family host, then write the summary resource and HTML page.",
      arguments: AuditArgsSchema,
      execute: async (
        args: z.infer<typeof AuditArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const g = context.globalArgs;
        const hosts = normalizeHosts(
          args.hosts.length > 0 ? args.hosts : g.hosts,
          g.sshUser,
        );
        if (hosts.length === 0) {
          throw new Error(
            "No hosts configured. Set the model's hosts global argument or pass --input hosts:json=[...].",
          );
        }
        const { summary, summaryHandle } = await buildSummary(
          g,
          context,
          hosts,
          args.cveCheck ?? g.cveCheck,
          args.parallel ?? g.parallel,
        );
        context.logger?.info(
          "Audited {hosts} hosts: {updates} pending, {security} security",
          {
            hosts: summary.totals.hosts,
            updates: summary.totals.updates,
            security: summary.totals.securityUpdates,
          },
        );
        return { dataHandles: [summaryHandle] };
      },
    },

    render: {
      description:
        "Rebuild the HTML page from the latest summary and the current tasks file.",
      arguments: RenderArgsSchema,
      execute: async (
        _args: Record<string, never>,
        context: MethodContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const g = context.globalArgs;
        context.logger?.info("Rendering network status page");
        const existing = await readSummary(context);
        if (!existing) {
          throw new Error("No summary data yet — run the audit method first.");
        }
        const tasks = await readTasks(g);
        const summary: Summary = {
          ...existing,
          tasks,
          tasksFile: deriveTasksFile(g),
          generatedAt: existing.generatedAt,
        };
        const file = await writePage(g, summary);
        const handle = await context.writeResource(
          "summary",
          "summary",
          { ...summary, outputFile: file } as unknown as Record<
            string,
            unknown
          >,
        );
        return { dataHandles: [handle] };
      },
    },

    "ensure-caddy-serve": {
      description:
        "When @svendowideit/caddy is installed, idempotently declare a Caddy " +
        "file_server route that serves the status page at " +
        "status.<host>.<domain>, reading the host and domain from the caddy " +
        "model that already owns this machine. Creates/updates a dedicated " +
        "status-caddy model carrying only that model's baseDomain and " +
        "serviceName; caddy derives the TLS subject and A record from the " +
        "route. Intended to run from the hourly workflow, never in isolation.",
      arguments: EnsureCaddyServeArgsSchema,
      execute: async (
        args: z.infer<typeof EnsureCaddyServeArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const logger = context.logger;
        const g = context.globalArgs;
        logger?.info("Ensuring the status page Caddy route");
        const probe = await runSwampCmd([
          "model",
          "type",
          "search",
          "@svendowideit/caddy",
          "--json",
        ]);
        const installed = probe.code === 0 &&
          probe.stdout.includes("@svendowideit/caddy");
        if (!installed) {
          logger?.info(
            "@svendowideit/caddy not installed — skipping status-page serving setup.",
          );
          return { dataHandles: [] };
        }
        const list = await runSwampCmd(["model", "list", "--json"]);
        if (list.code !== 0) {
          logger?.info(
            "Could not list models ({code}) — skipping status-page serving setup.",
            { code: list.code },
          );
          return { dataHandles: [] };
        }
        const names = caddyModelNames(list.stdout);
        if (names.length === 0) {
          logger?.info(
            "No @svendowideit/caddy model found — skipping status-page serving setup.",
          );
          return { dataHandles: [] };
        }
        const host = machineHostname();
        const facts: CaddyModelFacts[] = [];
        for (const name of names) {
          const got = await runSwampCmd(["model", "get", name, "--json"]);
          if (got.code !== 0) continue;
          try {
            facts.push(
              parseCaddyModelFacts(name, JSON.parse(got.stdout), host),
            );
          } catch {
            continue;
          }
        }
        const explicit = args.model.trim() || g.caddyModelName.trim();
        let source: CaddyModelFacts | null;
        if (explicit) {
          source = facts.find((f) => f.modelName === explicit) ?? null;
          if (!source) {
            logger?.info(
              "caddy model '{model}' not found — skipping status-page serving setup.",
              { model: explicit },
            );
            return { dataHandles: [] };
          }
        } else {
          source = pickSourceCaddy(facts, host);
          if (!source) {
            logger?.info(
              "Could not pick a single caddy model to read the status host/domain from ({models}) — skipping. Set caddyModelName on this model to choose one.",
              { models: names.join(", ") },
            );
            return { dataHandles: [] };
          }
        }
        const hostname = args.hostname.trim() ||
          g.caddyRouteHostname.trim() ||
          g.statusHostname.trim() ||
          statusRouteHostname(source.hostFqdn);
        if (!hostname) {
          logger?.info(
            "caddy model '{model}' has no base domain — skipping status-page serving setup.",
            { model: source.modelName },
          );
          return { dataHandles: [] };
        }
        const root = args.serveRoot.trim()
          ? expandHome(args.serveRoot.trim())
          : deriveSiteDir(g);
        const serveModel = args.serveModel.trim() ||
          g.caddyServeModel.trim() ||
          "status-caddy";
        const existing = await runSwampCmd([
          "model",
          "get",
          serveModel,
          "--json",
        ]);
        if (existing.code !== 0) {
          const createArgs = [
            "model",
            "create",
            "@svendowideit/caddy",
            serveModel,
            "--global-arg",
            `baseDomain=${source.baseDomain}`,
            "--global-arg",
            `serviceName=${source.serviceName}`,
          ];
          if (source.target) {
            createArgs.push("--global-arg", `target=${source.target}`);
          }
          const create = await runSwampCmd(createArgs);
          if (create.code !== 0) {
            throw new Error(
              `Failed to create caddy model ${serveModel} (${create.code}): ${
                create.stderr || create.stdout
              }`,
            );
          }
          logger?.info(
            "Created caddy model {model} (baseDomain {domain}, unit {unit}) to serve the status page",
            {
              model: serveModel,
              domain: source.baseDomain,
              unit: source.serviceName,
            },
          );
        } else {
          try {
            const raw = JSON.parse(existing.stdout) as {
              globalArguments?: Record<string, unknown>;
            };
            const cur = parseCaddyModelFacts(serveModel, raw, host);
            if (
              cur.baseDomain && source.baseDomain &&
              cur.baseDomain !== source.baseDomain
            ) {
              logger?.warn?.(
                "caddy model {model} baseDomain '{cur}' differs from '{src}'; update it with `swamp model edit {model} --global-arg baseDomain={src}`",
                {
                  model: serveModel,
                  cur: cur.baseDomain,
                  src: source.baseDomain,
                },
              );
            }
            const records = raw.globalArguments?.dnsRecords;
            if (Array.isArray(records) && records.length > 0) {
              logger?.warn?.(
                "caddy model {model} declares dnsRecords; the route itself derives the A record and TLS, so this is redundant and may break reconcile",
                { model: serveModel },
              );
            }
          } catch {
            void 0;
          }
        }
        const run = await runSwampCmd([
          "model",
          "method",
          "run",
          serveModel,
          "serveSettings",
          "--input",
          `hostname=${hostname}`,
          "--input",
          `root=${root}`,
          "--skip-reports",
        ]);
        if (run.code !== 0) {
          throw new Error(
            `serveSettings failed (${run.code}): ${run.stderr || run.stdout}`,
          );
        }
        logger?.info(
          "Status page served: {hostname} -> {root} via caddy model {model} (domain from {source})",
          {
            hostname,
            root,
            model: serveModel,
            source: source.modelName,
          },
        );
        const handle = await context.writeResource(
          "caddyServe",
          "current",
          {
            hostname,
            root,
            serveModel,
            sourceModel: source.modelName,
            baseDomain: source.baseDomain,
            changed: true,
            servedAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    addTask: {
      description:
        "Add or update a network-wide action item, then re-render the status page.",
      arguments: AddTaskArgsSchema,
      execute: async (
        args: z.infer<typeof AddTaskArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const g = context.globalArgs;
        context.logger?.info("Adding network status task: {title}", {
          title: args.title,
        });
        const tasks = await readTasks(g);
        const task = normalizeTask(TaskSchema.parse(args));
        const next = tasks.filter((t) => t.id !== task.id);
        next.push(task);
        const saved = await writeTasks(g, next);
        const handle = await context.writeResource("tasks", "tasks", {
          tasks: saved,
          updatedAt: new Date().toISOString(),
        });
        try {
          await model.methods.render.execute({}, context);
        } catch (err) {
          context.logger?.warn?.(
            "Task saved, but the page was not re-rendered: {error}",
            {
              error: err instanceof Error ? err.message : String(err),
            },
          );
        }
        return { dataHandles: [handle] };
      },
    },

    removeTask: {
      description:
        "Remove a network-wide action item and re-render the status page.",
      arguments: RemoveTaskArgsSchema,
      execute: async (
        args: z.infer<typeof RemoveTaskArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const g = context.globalArgs;
        context.logger?.info("Removing network status task: {id}", {
          id: args.id,
        });
        const tasks = (await readTasks(g)).filter((t) => t.id !== args.id);
        const saved = await writeTasks(g, tasks);
        const handle = await context.writeResource("tasks", "tasks", {
          tasks: saved,
          updatedAt: new Date().toISOString(),
        });
        try {
          await model.methods.render.execute({}, context);
        } catch (err) {
          context.logger?.warn?.(
            "Task removed, but the page was not re-rendered: {error}",
            {
              error: err instanceof Error ? err.message : String(err),
            },
          );
        }
        return { dataHandles: [handle] };
      },
    },

    clearTasks: {
      description:
        "Remove every network-wide action item and re-render the status page.",
      arguments: ClearTasksArgsSchema,
      execute: async (
        args: z.infer<typeof ClearTasksArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        if (!args.confirm) {
          throw new Error("Pass --input confirm=true to clear every task.");
        }
        const g = context.globalArgs;
        context.logger?.info("Clearing every network status task");
        const saved = await writeTasks(g, []);
        const handle = await context.writeResource("tasks", "tasks", {
          tasks: saved,
          updatedAt: new Date().toISOString(),
        });
        try {
          await model.methods.render.execute({}, context);
        } catch (err) {
          context.logger?.warn?.(
            "Tasks cleared, but the page was not re-rendered: {error}",
            {
              error: err instanceof Error ? err.message : String(err),
            },
          );
        }
        return { dataHandles: [handle] };
      },
    },
  },
};
