/**
 * The swamp ownership catalogue: which extension owns a piece of software, and
 * how to migrate a hand-installed copy to it.
 *
 * This is data, not a call to the registry: a census run must work offline and
 * must not claim an extension exists because a search happened to answer. Each
 * entry also lists the systemd unit names that the extension installs, which is
 * the only way `managed` is ever claimed for something that is not an OS
 * package — "a unit this extension manages is running this exact binary, on this
 * host" is evidence, whereas "an extension exists" is not.
 *
 * `command` is what to run to hand the tool over to swamp. It is printed, never
 * executed.
 *
 * @module
 */

export interface OwnerCatalogEntry {
  /** Matches the executable name or the resolved identity name. */
  match: RegExp;
  /** The extension that would own it. */
  extension: string;
  /** What to run to convert a hand-installed copy. */
  command: string;
  /**
   * systemd unit names (without `.service`) this extension installs. A host that
   * is running the binary from one of these units is `managed`, not merely
   * `manageable`.
   */
  unitPatterns: RegExp[];
  /**
   * The upstream GitHub repository, when the catalogue knows it. This is what
   * gives a name-only binary (no Go build info) an identity, an upstream link and
   * a freshness lookup.
   */
  upstreamRepo?: string;
  /**
   * A safe, catalogue-owned version probe for a binary that carries no version
   * of its own (Deno-compiled or stripped builds). It is only run when the model
   * has `execProbe=true`; the argument list is fixed here, never derived from
   * discovered data.
   */
  versionProbe?: { args: string[]; pattern: string };
}

export const OWNER_CATALOG: OwnerCatalogEntry[] = [
  {
    match: /^ollama$/,
    extension: "@svendowideit/ollama",
    command: "swamp workflow run @svendowideit/ollama-install",
    unitPatterns: [/^ollama$/],
    upstreamRepo: "ollama/ollama",
  },
  {
    match: /^caddy$/,
    extension: "@svendowideit/caddy",
    command: "swamp workflow run @svendowideit/caddy-setup",
    unitPatterns: [/^caddy$/],
    upstreamRepo: "caddyserver/caddy",
    versionProbe: { args: ["version"], pattern: "v?(\\d+\\.\\d+\\.\\d+)" },
  },
  {
    match: /^tuios$/,
    extension: "@svendowideit/tuios",
    command: "swamp extension pull @svendowideit/tuios",
    unitPatterns: [/^tuios$/],
    upstreamRepo: "Gaurav-Gosain/tuios",
  },
  {
    match: /^(herdr|herdr-core|herdr-app|hc)$/,
    extension: "@svendowideit/herdr-app",
    command: "swamp extension pull @svendowideit/herdr-app",
    unitPatterns: [/^herdr/],
  },
  {
    match: /^opencode(2)?$/,
    extension: "@svendowideit/opencode",
    command: "swamp extension pull @svendowideit/opencode",
    unitPatterns: [/^opencode/],
  },
  {
    match: /^obsidian(-headless)?$/,
    extension: "@svendowideit/obsidian-app",
    command: "swamp extension pull @svendowideit/obsidian-app",
    unitPatterns: [/^obsidian/],
  },
  {
    // The worker installs the swamp binary itself; `swamp-serve` is the
    // orchestrator side of the same extension family.
    match: /^swamp$/,
    extension: "@svendowideit/swamp-worker",
    command: "swamp extension pull @svendowideit/swamp-worker",
    unitPatterns: [/^swamp-worker-/, /^swamp-serve$/],
    upstreamRepo: "swamp-club/swamp",
    // Deno-compiled: no Go build info, so the only safe source is the binary's
    // own version line, run only when execProbe is enabled.
    versionProbe: {
      args: ["--version"],
      pattern: "(\\d{8}\\.\\d{6}\\.\\d+(?:-sha\\.[0-9a-f]+)?)",
    },
  },
  {
    match: /^(llama-server|llama-cli|kolibri)$/,
    extension: "@svendowideit/llama-cpp",
    command: "swamp extension pull @svendowideit/llama-cpp",
    unitPatterns: [/^kolibri/, /^llama/],
  },
  {
    match: /^magnitude$/,
    extension: "@svendowideit/magnitude",
    command: "swamp extension pull @svendowideit/magnitude",
    unitPatterns: [/^magnitude/],
  },
  {
    match: /^netbird$/,
    extension: "@svendowideit/netbird",
    command: "swamp extension search netbird",
    unitPatterns: [/^netbird/],
  },
];

/** The catalogue entry for a name/identity, if there is one. */
export function catalogEntryFor(
  name: string,
  identityName = "",
): OwnerCatalogEntry | null {
  return OWNER_CATALOG.find((e) =>
    e.match.test(name) || (identityName !== "" && e.match.test(identityName))
  ) ?? null;
}

/**
 * Whether a unit this extension installs is running the item on this host.
 * `units` are the unit names the scanner saw running the item's binary.
 */
export function managedByUnit(
  entry: OwnerCatalogEntry | null,
  units: string[],
): string {
  if (!entry) return "";
  return units.find((u) => entry.unitPatterns.some((p) => p.test(u))) ?? "";
}
