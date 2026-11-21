/**
 * The fleet-census HTML reports.
 *
 * Three pages, one JSON, no external assets (no CDN, no fonts, no JS libraries):
 *
 *   - `software.html` — one row per product, one column per host, so a version
 *     that disagrees across the fleet is visible at a glance, and the hosts that
 *     do NOT have a product are an explicit column, not an absence;
 *   - `host.html` — hosts ordered by an attention score (unknown software,
 *     conversion opportunities, abandoned dependencies, version skew,
 *     unreachable), so the machine that needs work is first;
 *   - `index.html` — the totals, the two entry links and the leaderboards;
 *   - `census.json` — the same tables, for reports and agents.
 *
 * Everything is escaped and rendered as text: no data ever reaches `innerHTML`,
 * and the only script is the row filter, which reads an input's value and toggles
 * a class. Rendering is pure — the methods write the files.
 *
 * @module
 */

export interface CensusHostResult {
  host: string;
  ok: boolean;
  reachedVia: string;
  error: string;
  scannedAt: string;
  durationMs: number;
  items: number;
  unowned: number;
  osManaged: number;
  os: string;
  arch: string;
  addresses: string[];
  searchDomains: string[];
  byManager: Record<string, number>;
  byOwner: Record<string, number>;
}

export interface SoftwareRow {
  identity: string;
  identities: string[];
  name: string;
  hosts: Array<{
    host: string;
    version: string;
    manager: string;
    owner: string;
    flags: string[];
    installs: number;
    /** Every install path this host has for the product (absent on old data). */
    paths?: string[];
  }>;
  versions: string[];
  skewed: boolean;
  managedOn: string[];
  manageableOn: string[];
  /** The swamp extension that owns (or could own) it, and how to convert. */
  extension: string;
  command: string;
  missingOn: string[];
}

export interface FreshnessRow {
  name: string;
  repo: string;
  installed: Array<{ host: string; version: string; channel: string }>;
  latest: { version: string; publishedAt: string; tag: string } | null;
  lts: { version: string; publishedAt: string; tag: string } | null;
  dev: { version: string; publishedAt: string; tag: string } | null;
  archived: boolean;
  upstreamIdleDays: number | null;
  oldestInstalledDays: number | null;
  behindMajor: number;
  flags: string[];
  error: string;
}

export interface FleetData {
  hosts: CensusHostResult[];
  software: SoftwareRow[];
  summary: Record<string, unknown>;
  scannedAt: string;
}

export interface FreshnessData {
  rows: FreshnessRow[];
  summary: Record<string, unknown>;
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Escape every character that matters in HTML text or an attribute. */
export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** A tiny inline filter shared by the two table pages. */
const FILTER_JS = `
document.addEventListener("input", (e) => {
  const box = e.target;
  if (!box || box.id !== "filter") return;
  const q = box.value.toLowerCase().trim();
  for (const row of document.querySelectorAll("tbody tr.searchable")) {
    row.classList.toggle("hid", q !== "" && !row.dataset.search.includes(q));
  }
});`;

const CSS = `
:root { color-scheme: light dark; --ok:#1a7f37; --warn:#9a6700; --bad:#b42318; --mute:#6b7280; }
* { box-sizing: border-box; }
body { margin: 0; padding: 24px; font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
h1 { font-size: 20px; margin: 0 0 4px; }
h2 { font-size: 15px; margin: 28px 0 8px; }
p.sub { color: var(--mute); margin: 0 0 18px; }
nav a { margin-right: 14px; }
a { color: inherit; }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid color-mix(in srgb, currentColor 15%, transparent); vertical-align: top; }
th { font-weight: 600; position: sticky; top: 0; background: Canvas; }
td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; }
tr.hid { display: none; }
tr.skew td { background: color-mix(in srgb, var(--warn) 12%, transparent); }
.miss { color: var(--mute); }
.badge { display: inline-block; padding: 0 5px; border-radius: 4px; font-size: 11px; border: 1px solid currentColor; }
.b-ok { color: var(--ok); } .b-warn { color: var(--warn); } .b-bad { color: var(--bad); } .b-mute { color: var(--mute); }
.cards { display: flex; flex-wrap: wrap; gap: 12px; margin: 0 0 8px; padding: 0; list-style: none; }
.card { border: 1px solid color-mix(in srgb, currentColor 20%, transparent); border-radius: 8px; padding: 10px 14px; min-width: 150px; }
.card b { display: block; font-size: 20px; }
.card span { color: var(--mute); font-size: 12px; }
input#filter { padding: 6px 8px; margin: 0 0 10px; width: 260px; font: inherit; border-radius: 6px; border: 1px solid color-mix(in srgb, currentColor 30%, transparent); }
details { margin: 6px 0; }
summary { cursor: pointer; }
code { font-size: 12px; }
`;

function page(title: string, body: string, generatedAt: string): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${CSS}</style>
</head><body>
<nav><a href="index.html">overview</a><a href="software.html">by software</a><a href="host.html">by host</a><a href="census.json">census.json</a></nav>
${body}
<p class="sub">fleet-census · generated ${escapeHtml(generatedAt)}</p>
<script>${FILTER_JS}</script>
</body></html>
`;
}

/** An escaped external link, or "" when there is no URL. */
export function link(url: string, text: string, title = ""): string {
  if (!url) return escapeHtml(text);
  const t = title ? ` title="${escapeHtml(title)}"` : "";
  return `<a href="${escapeHtml(url)}" rel="noreferrer" target="_blank"${t}>${
    escapeHtml(text)
  }</a>`;
}

/**
 * Where a product actually lives: one entry per host, with every install path
 * that host has. A count of "abandoned dependencies" is useless without the
 * file you would have to replace.
 */
export function whereInstalled(row: SoftwareRow | undefined): string {
  if (!row) return "";
  return row.hosts
    .filter((h) => (h.paths ?? []).length > 0 || h.version !== "")
    .map((h) => {
      const head = `<b>${escapeHtml(h.host)}</b>${
        h.version ? ` ${escapeHtml(h.version)}` : ""
      }`;
      const paths = (h.paths ?? []).filter(Boolean);
      if (paths.length === 0) return head;
      return `${head}${
        paths.map((p) => `<br><code>${escapeHtml(p)}</code>`).join("")
      }`;
    })
    .join("<br>");
}

export interface ProductLinks {
  /** The project's home page (repo, package registry page, …). */
  project: string;
  /** The project's release/version listing, when there is one. */
  releases: string;
}

/**
 * Where a person can go to look at a product before deciding what to do with it.
 *
 * Derived from the identity the census resolved: a GitHub repo gets repo +
 * releases, a Go module gets pkg.go.dev, and the language/container registries
 * get their own pages. When no honest URL can be derived, none is invented.
 */
export function productLinks(row: SoftwareRow): ProductLinks {
  const ids = [row.identity, ...(row.identities ?? [])];
  const pick = (kind: string): string =>
    ids.find((i) => i.startsWith(`${kind}:`))?.substring(kind.length + 1) ?? "";
  const gh = pick("github");
  if (gh) {
    return {
      project: `https://github.com/${gh}`,
      releases: `https://github.com/${gh}/releases`,
    };
  }
  const go = pick("go");
  if (go) return { project: `https://pkg.go.dev/${go}`, releases: "" };
  const pypi = pick("pypi");
  if (pypi) {
    return { project: `https://pypi.org/project/${pypi}/`, releases: "" };
  }
  const npm = pick("npm");
  if (npm) {
    return { project: `https://www.npmjs.com/package/${npm}`, releases: "" };
  }
  const oci = pick("oci");
  if (oci) {
    const repo = oci.split(":")[0];
    // only a Docker Hub reference has a stable browsable page; other registries
    // do not have a URL convention worth guessing at
    if (!repo.includes(".")) {
      return { project: `https://hub.docker.com/r/${repo}`, releases: "" };
    }
  }
  return { project: "", releases: "" };
}

/** How this product is installed across the fleet, e.g. "snap", "none + pip". */
export function managersOf(row: SoftwareRow): string {
  const set = new Set(row.hosts.map((h) => h.manager));
  return set.size === 0 ? "—" : [...set].sort().join(" + ");
}

/** How this product is owned across the fleet, with host counts. */
export function ownersOf(row: SoftwareRow): string {
  const counts = new Map<string, number>();
  for (const h of row.hosts) {
    counts.set(h.owner, (counts.get(h.owner) ?? 0) + 1);
  }
  return counts.size === 0
    ? "—"
    : [...counts.entries()].sort().map(([k, v]) => `${k}×${v}`).join(" ");
}

/** The product name, linked to its project when one is known. */
function productName(row: SoftwareRow): string {
  const { project } = productLinks(row);
  const ids = row.identities.length > 1
    ? ` <span class="miss">(${row.identities.length} ids)</span>`
    : "";
  return `<b>${
    link(project, row.name, project ? `open ${row.name} upstream` : "")
  }</b>${ids}`;
}

/** The upstream release tag page for a version, when the metadata has the tag. */
function releaseUrl(row: SoftwareRow, tag: string): string {
  if (!tag) return "";
  const { releases } = productLinks(row);
  return releases ? `${releases}/tag/${tag}` : "";
}

function badge(text: string, kind: "ok" | "warn" | "bad" | "mute"): string {
  return `<span class="badge b-${kind}">${escapeHtml(text)}</span>`;
}

/** Channel → badge kind. */
function channelBadge(channel: string): string {
  switch (channel) {
    case "lts":
      return badge("lts", "ok");
    case "latest":
      return badge("latest", "ok");
    case "dev":
      return badge("dev", "warn");
    case "behind":
      return badge("behind", "warn");
    default:
      return badge("?", "mute");
  }
}

/** Days → a short human string. */
export function humanAge(days: number | null): string {
  if (days === null) return "";
  if (days >= 730) return `${Math.floor(days / 365)}y`;
  if (days >= 60) return `${Math.floor(days / 30)}mo`;
  return `${days}d`;
}

// ---------------------------------------------------------------------------
// Attention
// ---------------------------------------------------------------------------

export interface HostAttention {
  host: string;
  ok: boolean;
  error: string;
  items: number;
  unowned: number;
  managed: number;
  manageable: number;
  unknown: number;
  abandoned: number;
  skewed: number;
  score: number;
}

/**
 * How much a host needs attention, and why. Weighted so the ranking matches what
 * a person would do first: an unreachable host hides everything behind it, an
 * abandoned dependency is a risk already accepted, unknown software is the point
 * of the exercise, and conversion opportunities are cheap wins.
 */
export function hostAttention(
  fleet: FleetData,
  freshness: FreshnessData | null,
): HostAttention[] {
  const abandonedByHost = new Map<string, number>();
  const skewByHost = new Map<string, number>();
  if (freshness) {
    for (const row of freshness.rows) {
      const abandoned = row.archived ||
        row.flags.includes("upstream-idle-2y") ||
        row.flags.includes("upstream-idle-1y");
      for (const inst of row.installed) {
        if (abandoned) {
          abandonedByHost.set(
            inst.host,
            (abandonedByHost.get(inst.host) ?? 0) + 1,
          );
        }
      }
    }
  }
  for (const row of fleet.software) {
    if (!row.skewed && row.missingOn.length === 0) continue;
    for (const h of row.hosts) {
      if (row.skewed) {
        skewByHost.set(h.host, (skewByHost.get(h.host) ?? 0) + 1);
      }
    }
  }

  return fleet.hosts.map((h) => {
    const unknown = h.byOwner?.unknown ?? 0;
    const manageable = h.byOwner?.manageable ?? 0;
    const managed = h.byOwner?.managed ?? 0;
    const abandoned = abandonedByHost.get(h.host) ?? 0;
    const skewed = skewByHost.get(h.host) ?? 0;
    // An unreachable host hides everything behind it, so it leads the ranking
    // even against a host with abandoned software.
    const score = (h.ok ? 0 : 25) + unknown * 3 + abandoned * 8 + skewed * 2 +
      manageable * 2;
    return {
      host: h.host,
      ok: h.ok,
      error: h.error,
      items: h.items,
      unowned: h.unowned,
      managed,
      manageable,
      unknown,
      abandoned,
      skewed,
      score,
    };
  }).sort((a, b) => b.score - a.score || a.host.localeCompare(b.host));
}

/**
 * Products that are behind upstream, which is **not** the same as skew: the
 * whole fleet can agree on one version and still be three releases behind what
 * upstream publishes (swamp was exactly that). Skew is hosts disagreeing with
 * each other; this is the fleet disagreeing with upstream.
 */
export interface OutdatedProduct {
  name: string;
  installed: string[];
  latest: string;
  latestUrl: string;
  hosts: string[];
  behindMajor: number;
  flags: string[];
}

export function outdatedProducts(
  fleet: FleetData,
  freshness: FreshnessData | null,
): OutdatedProduct[] {
  if (!freshness) return [];
  return freshness.rows
    .filter((r) =>
      r.flags.includes("behind") || r.flags.includes("behind-major")
    )
    .map((r) => {
      const row = fleet.software.find((x) => x.name === r.name);
      const links = row ? productLinks(row) : { project: "", releases: "" };
      const tag = r.latest?.tag ?? "";
      return {
        name: r.name,
        installed: [
          ...new Set(r.installed.map((i) => i.version).filter(Boolean)),
        ]
          .sort(),
        latest: r.latest?.version ?? "",
        latestUrl: tag && links.releases
          ? `${links.releases}/tag/${tag}`
          : links.project,
        hosts: r.installed.filter((i) => i.channel === "behind").map((i) =>
          i.host
        ).sort(),
        behindMajor: r.behindMajor,
        flags: r.flags,
      };
    })
    .sort((a, b) =>
      b.behindMajor - a.behindMajor ||
      b.hosts.length - a.hosts.length ||
      a.name.localeCompare(b.name)
    );
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

/** `index.html` — totals, entry links and the leaderboards. */
export function renderIndex(
  fleet: FleetData,
  freshness: FreshnessData | null,
  generatedAt: string,
): string {
  const raw = fleet.summary as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === "number" ? v : 0);
  const byOwner = (raw.byOwner ?? {}) as Record<string, number>;
  const cards = [
    ["hosts", num(raw.hosts)],
    ["scanned OK", num(raw.ok)],
    ["unreachable", num(raw.failed)],
    ["products", fleet.software.length],
    ["version skew", num(raw.skewed)],
    ["managed", byOwner.managed ?? 0],
    ["manageable", num(raw.manageable)],
    ["unknown", num(raw.unknown)],
  ] as const;
  const outdated = outdatedProducts(fleet, freshness);
  const abandoned =
    freshness?.rows.filter((r) =>
      r.archived || r.flags.includes("upstream-idle-2y")
    ) ?? [];
  const conversions = [...fleet.software]
    .filter((r) => r.manageableOn.length > 0)
    .sort((a, b) => b.manageableOn.length - a.manageableOn.length)
    .slice(0, 10);
  const skew = fleet.software.filter((r) => r.skewed).slice(0, 10);

  const body = `
<h1>Fleet census</h1>
<p class="sub">What is installed that the OS package manager does not own, who owns it, and how stale it is.</p>
<ul class="cards">${
    cards.map(([label, value]) =>
      `<li class="card"><b>${escapeHtml(value)}</b><span>${
        escapeHtml(label)
      }</span></li>`
    ).join("")
  }</ul>

<h2>What the rows are</h2>
<p class="sub">Every listed item, counted once per host that has it, by install source — a product that is on four hosts appears four times here, but once in the table. Plus the layer that is deliberately counted rather than listed: apt/dpkg executables, which the OS package manager already tracks.</p>
<ul class="cards">${
    Object.entries(
      (fleet.summary as Record<string, unknown>).byManager as Record<
        string,
        number
      > ?? {},
    )
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) =>
        `<li class="card"><b>${escapeHtml(v)}</b><span>${
          escapeHtml(k)
        }</span></li>`
      )
      .join("")
  }${`<li class="card"><b>${
    escapeHtml(fleet.hosts.reduce((n, h) => n + h.osManaged, 0))
  }</b><span>apt/dpkg executables (counted, not listed)</span></li>`}</ul>

<h2>Needs attention</h2>
<p class="sub"><a href="host.html">By host →</a> the ranking, with each host's unknown and manageable software.</p>
<p class="sub"><a href="software.html">By software →</a> the version matrix, including the hosts that do not have each product.</p>

<h2>Abandoned dependencies ${
    freshness ? `(${abandoned.length})` : "(no freshness data yet)"
  }</h2>
${
    abandoned.length === 0
      ? `<p class="sub">None found (or the metadata step has not run).</p>`
      : `<table><thead><tr><th>product</th><th>upstream</th><th class="n">idle</th><th>host</th><th>where</th><th>flags</th></tr></thead><tbody>${
        abandoned.map((r) => {
          const row = fleet.software.find((x) => x.name === r.name);
          const links = row ? productLinks(row) : { project: "", releases: "" };
          const tag = r.latest?.tag ?? "";
          const url = tag && links.releases
            ? `${links.releases}/tag/${tag}`
            : links.project;
          return `<tr class="searchable" data-search="${
            escapeHtml(r.name.toLowerCase())
          }"><td>${link(links.project, r.name)}</td><td>${
            r.latest ? link(url, r.latest.version) : ""
          }</td><td class="n">${
            escapeHtml(humanAge(r.upstreamIdleDays))
          }</td><td>${
            escapeHtml(r.installed.map((i) => i.host).join(", "))
          }</td><td class="where">${whereInstalled(row)}</td><td>${
            r.flags.map((f) => badge(f, "warn")).join(" ")
          }</td></tr>`;
        }).join("")
      }</tbody></table>`
  }

<h2>Conversion candidates</h2>
${
    conversions.length === 0
      ? `<p class="sub">None.</p>`
      : `<table><thead><tr><th>product</th><th class="n">hosts</th><th>hosts it is on</th><th>extension</th></tr></thead><tbody>${
        conversions.map((r) => {
          const { project } = productLinks(r);
          return `<tr class="searchable" data-search="${
            escapeHtml(r.name.toLowerCase())
          }"><td>${
            link(project, r.name)
          }</td><td class="n">${r.manageableOn.length}</td><td>${
            escapeHtml(r.manageableOn.join(", "))
          }</td><td>${escapeHtml(r.extension)}<br><code>${
            escapeHtml(r.command)
          }</code></td></tr>`;
        }).join("")
      }</tbody></table>`
  }

<h2>Behind upstream (${outdated.length})</h2>
<p class="sub">The fleet agrees with itself but runs an older release than upstream publishes — a different problem from skew, and the one that matters for a swamp-managed tool that nobody upgraded.</p>
${
    outdated.length === 0
      ? `<p class="sub">Nothing is behind upstream (or the metadata step has not run).</p>`
      : `<table><thead><tr><th>product</th><th>installed</th><th>latest</th><th>hosts behind</th><th>flags</th></tr></thead><tbody>${
        outdated.map((o) =>
          `<tr class="searchable" data-search="${
            escapeHtml(o.name.toLowerCase())
          }"><td>${link(o.latestUrl, o.name)}</td><td>${
            o.installed.map((v) => badge(v, "warn")).join(" ")
          }</td><td>${link(o.latestUrl, o.latest)}</td><td>${
            escapeHtml(o.hosts.join(", "))
          }</td><td>${o.flags.map((f) => badge(f, "warn")).join(" ")}</td></tr>`
        ).join("")
      }</tbody></table>`
  }

<h2>Version skew — hosts disagree</h2>
${
    skew.length === 0
      ? `<p class="sub">The fleet agrees on every product. (A consistent but old version is listed under “Behind upstream” above, not here.)</p>`
      : `<table><thead><tr><th>product</th><th>versions in use</th><th>hosts</th></tr></thead><tbody>${
        skew.map((r) => {
          const { project } = productLinks(r);
          return `<tr class="searchable" data-search="${
            escapeHtml(r.name.toLowerCase())
          }"><td>${link(project, r.name)}</td><td>${
            r.versions.map((v) => badge(v, "warn")).join(" ")
          }</td><td>${
            escapeHtml(
              r.hosts.map((h) => `${h.host}:${h.version || "?"}`).join(", "),
            )
          }</td></tr>`;
        }).join("")
      }</tbody></table>`
  }
`;
  return page("Fleet census", body, generatedAt);
}

/** `software.html` — one row per product, one column per host. */
export function renderSoftware(
  fleet: FleetData,
  freshness: FreshnessData | null,
  generatedAt: string,
): string {
  const hosts = fleet.hosts.map((h) => h.host).sort();
  const fresh = new Map((freshness?.rows ?? []).map((r) => [r.name, r]));
  const head = hosts.map((h) => `<th>${escapeHtml(h)}</th>`).join("");
  const rows = fleet.software.map((row) => {
    const byHost = new Map(row.hosts.map((h) => [h.host, h]));
    const f = fresh.get(row.name);
    const cells = hosts.map((h) => {
      const entry = byHost.get(h);
      if (!entry) {
        return row.missingOn.includes(h)
          ? `<td class="miss" title="scanned, not installed">—</td>`
          : `<td class="miss" title="host not scanned">?</td>`;
      }
      const channel = f?.installed.find((i) => i.host === h)?.channel ??
        "unknown";
      const version = entry.version
        ? escapeHtml(entry.version)
        : `<span class="miss" title="no version evidence">?</span>`;
      const ch = channel === "unknown" ? "" : ` ${channelBadge(channel)}`;
      return `<td>${version}${ch}${
        entry.installs > 1 ? ` ${badge(`×${entry.installs}`, "warn")}` : ""
      }</td>`;
    }).join("");
    const flags = f?.flags ?? [];
    const { project, releases } = productLinks(row);
    const latestUrl = f?.latest
      ? releaseUrl(row, f.latest.tag ?? "") || releases
      : "";
    const action = row.command
      ? ` <details><summary>act</summary><code>${
        escapeHtml(row.command)
      }</code>${project ? `<br>${link(project, "upstream ↗")}` : ""}</details>`
      : project
      ? ` ${link(project, "upstream ↗")}`
      : "";
    return `<tr class="searchable${row.skewed ? " skew" : ""}" data-search="${
      escapeHtml(row.name.toLowerCase())
    }"><td>${productName(row)}</td><td>${escapeHtml(managersOf(row))}</td><td>${
      escapeHtml(ownersOf(row))
    }</td><td>${
      f?.latest ? link(latestUrl, f.latest.version) : ""
    }</td><td class="n">${
      escapeHtml(humanAge(f?.upstreamIdleDays ?? null))
    }</td>${cells}<td>${escapeHtml(row.missingOn.join(", "))}</td><td>${
      flags.map((x) => badge(x, x === "archived" ? "bad" : "warn")).join(" ")
    }${action}</td></tr>`;
  }).join("");

  const body = `
<h1>By software</h1>
<p class="sub">Every product the census found, one column per scanned host. <span class="miss">—</span> means the host was scanned and does not have it; <span class="miss">?</span> in a host cell means the host was not scanned; <span class="miss">?</span> in place of a version means the binary carries no version evidence. A shaded row means the fleet runs more than one version.</p>
<p class="sub"><b>via</b> is what installs it (<code>snap</code>, <code>pip</code>, <code>pip-venv</code>, <code>npm</code>, <code>nvm</code>, <code>rustup</code>, <code>cargo</code>, <code>go</code>, <code>nix</code>, <code>oci</code>, or <code>none</code> for a hand-installed binary).
<p class="sub"><b>owner</b> is swamp's verdict per host: <code>managed</code> (an OS package manager, or a swamp-installed unit running it), <code>manageable</code> (an extension could take it over — <code>act</code> shows the command), or <code>unknown</code>.</p>
<p class="sub"><b>apt/dpkg packages are counted, not listed</b>: the census is about the layer the OS package manager does not own, plus snap/flatpak because those are versioned applications you chose. The overview page shows the apt count.</p>
<input id="filter" type="search" placeholder="filter by product…" aria-label="filter by product">
<table>
<thead><tr><th>product</th><th>via</th><th>owner</th><th>latest</th><th class="n">idle</th>${head}<th>missing on</th><th>flags</th></tr></thead>
<tbody>${rows}</tbody>
</table>
`;
  return page("Fleet census — by software", body, generatedAt);
}

/** `host.html` — hosts ordered by attention, with the detail that explains it. */
export function renderHosts(
  fleet: FleetData,
  freshness: FreshnessData | null,
  generatedAt: string,
): string {
  const attention = hostAttention(fleet, freshness);
  const _rowFor = (name: string): SoftwareRow =>
    fleet.software.find((r) => r.name === name) ?? {
      identity: `name:${name}`,
      identities: [],
      name,
      hosts: [],
      versions: [],
      skewed: false,
      managedOn: [],
      manageableOn: [],
      extension: "",
      command: "",
      missingOn: [],
    };
  const outdated = outdatedProducts(fleet, freshness);
  const rows = attention.map((a) => {
    const behind = outdated.filter((o) => o.hosts.includes(a.host));
    const abandonList = (freshness?.rows ?? []).filter((r) =>
      (r.archived || r.flags.includes("upstream-idle-2y")) &&
      r.installed.some((i) => i.host === a.host)
    ).map((r) => r.name);
    const conversions = fleet.software.filter((r) =>
      r.manageableOn.includes(a.host)
    );
    return `<tr class="searchable${a.ok ? "" : " skew"}" data-search="${
      escapeHtml(a.host.toLowerCase())
    }">
<td><b>${escapeHtml(a.host)}</b>${
      a.ok ? "" : ` ${badge("unreachable", "bad")}`
    }</td>
<td class="n">${a.items}</td><td class="n">${a.unknown}</td><td class="n">${a.manageable}</td><td class="n">${a.managed}</td>
<td class="n">${a.abandoned}</td><td class="n">${a.skewed}</td><td class="n">${a.score}</td>
<td><details><summary>detail</summary>
<p>${
      a.ok
        ? `reached via <code>${
          escapeHtml(
            fleet.hosts.find((h) => h.host === a.host)?.reachedVia ?? "",
          )
        }</code> · ${
          escapeHtml(fleet.hosts.find((h) => h.host === a.host)?.os ?? "")
        } ${escapeHtml(fleet.hosts.find((h) => h.host === a.host)?.arch ?? "")}`
        : `error: <code>${escapeHtml(a.error)}</code>`
    }</p>
${
      abandonList.length > 0
        ? `<p>abandoned here: ${
          abandonList.map((n) => {
            const row = fleet.software.find((x) => x.name === n);
            return row ? link(productLinks(row).project, n) : escapeHtml(n);
          }).join(", ")
        }</p>`
        : ""
    }
${
      conversions.length > 0
        ? `${
          behind.length > 0
            ? `<p>behind upstream: ${
              behind.map((b) =>
                `${link(productLinks(_rowFor(b.name)).project, b.name)} (${
                  escapeHtml(b.installed.join("/") || "?")
                } → ${escapeHtml(b.latest)})`
              ).join(", ")
            }</p>`
            : ""
        }
<p>could convert (${conversions.length}): ${
          conversions.slice(0, 12).map((c) =>
            link(productLinks(c).project, c.name)
          ).join(", ")
        }${conversions.length > 12 ? ", …" : ""}</p>`
        : ""
    }
</details></td></tr>`;
  }).join("");

  const body = `
<h1>By host</h1>
<p class="sub">Ordered by attention: unreachable hosts first, then unknown software, abandoned dependencies, version skew and conversion opportunities.</p>
<input id="filter" type="search" placeholder="filter by host…" aria-label="filter by host">
<table>
<thead><tr><th>host</th><th class="n">items</th><th class="n">unknown</th><th class="n">manageable</th><th class="n">managed</th><th class="n">abandoned</th><th class="n">skewed</th><th class="n">score</th><th></th></tr></thead>
<tbody>${rows}</tbody>
</table>
`;
  return page("Fleet census — by host", body, generatedAt);
}

/** `census.json` — the tables without the presentation. */
export function renderJson(
  fleet: FleetData,
  freshness: FreshnessData | null,
  generatedAt: string,
): string {
  return JSON.stringify(
    {
      generatedAt,
      summary: fleet.summary,
      hosts: fleet.hosts,
      software: fleet.software,
      freshness: freshness?.rows ?? [],
      // behind upstream is a different problem from skew, and agents should not
      // have to re-derive it from flags
      outdated: outdatedProducts(fleet, freshness),
      skew: fleet.software.filter((r) => r.skewed).map((r) => r.name),
      attention: hostAttention(fleet, freshness),
    },
    null,
    2,
  ) + "\n";
}
