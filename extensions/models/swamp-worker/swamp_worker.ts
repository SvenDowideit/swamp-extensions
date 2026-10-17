/**
 * Swamp model that enlists a host as a **swamp worker** for one `swamp serve`
 * orchestrator.
 *
 * A worker is a disposable swamp process that dials home to a serve instance,
 * enrolls with a one-time token, and executes dispatched method bodies. This
 * model owns the *host* half of that: it renders the worker's systemd user unit
 * from the desired state, ensures the swamp binary is present, mints/rotates its
 * enrollment token, reconciles the unit (enabling it at boot with linger), and
 * reports and removes exactly the unit it owns.
 *
 * Coexistence is the core rule: one swamp repo manages **one** worker per host
 * (`swamp-worker-<identity>.service`). Other repos' workers on the same host
 * (`swamp-worker-rc.service`, …) are never enumerated, stopped or removed — every
 * artifact is namespaced by `identity`, and `remove` refuses any unit that is not
 * this identity's own.
 *
 * Everything is rendered by the model; nothing is written by hand on a host. The
 * same pure render helpers (`renderWorkerUnit`, the path helpers) are what a site
 * workflow ships to a *remote* host over SSH, so the local path and the fan-out
 * path are the same code.
 *
 * Methods:
 *   - `renderUnit`    — render the unit + a `unit` resource (audit, no changes)
 *   - `install`       — ensure the swamp binary exists at `swampBinPath`
 *   - `mintToken`     — mint an enrollment token and write it to a 0600 file
 *   - `ensureService` — reconcile the unit on this host and (re)start it
 *   - `status`        — report unit state and this identity's enrolled workers
 *   - `remove`        — stop/disable and delete only this identity's artifacts
 *   - `guidance`      — print every option with its value and how to change it
 *
 * @module
 */

// meta-factory-ignore config-lifecycle setup-method-missing: this model is
// driven by a site workflow and configured via global args at creation, so it
// ships no `setup` method by design; its `readModelData` call reads a *peer's*
// published @svendowideit/otel-settings contract, not this extension's own config.

import { z } from "npm:zod@4";

// ---------------------------------------------------------------------------
// Global args
// ---------------------------------------------------------------------------

const GlobalArgsSchema = z.object({
  identity: z.string().default("worker").describe(
    "Worker identity slug. Namespaces every artifact (unit name, cache dir, " +
      "token/env files) so this repo's worker never collides with another " +
      "repo's worker on the same host. e.g. 'figy' or 'rc'.",
  ),
  unitName: z.string().default("").describe(
    "Systemd user unit name (without .service). Defaults to " +
      "'swamp-worker-<identity>'.",
  ),
  swampBinPath: z.string().default("/usr/local/bin/swamp").describe(
    "Absolute path to the swamp binary the worker unit executes.",
  ),
  repoDir: z.string().default(".").describe(
    "Repository directory used for local `swamp worker token` calls.",
  ),
  configDir: z.string().default("~/.config/swamp-worker").describe(
    "Directory holding the identity's token and env files (0600).",
  ),
  cacheDirRoot: z.string().default("~/.local/share/swamp-worker").describe(
    "Root for per-identity worker cache dirs (each holds the machine-id the " +
      "enrollment token binds to).",
  ),
  stagingDir: z.string().default("/tmp/swamp-worker-staging")
    .describe(
      "Orchestrator-side dir where `mintToken` writes each node's token plaintext " +
        "as `<name>.token` (0600) for a site workflow to copy to that node, and " +
        "where `mintToken` reuses it on a re-run. Absolute by default so a " +
        "workflow can compute the path (a step's globalArgs do not merge with the " +
        "instance's, so set this at model creation, not per step).",
    ),
  unitDir: z.string().default("~/.config/systemd/user").describe(
    "Directory where systemd user unit files are written.",
  ),
  swampHome: z.string().default("~/.swamp").describe(
    "SWAMP_HOME exported into the worker unit.",
  ),
  swampConfigDir: z.string().default("~/.config/swamp").describe(
    "SWAMP_CONFIG_DIR exported into the worker unit.",
  ),
  releaseBaseUrl: z.string().default(
    "https://github.com/swamp-club/swamp/releases",
  ).describe(
    "Base URL for swamp release downloads when the binary is absent.",
  ),
  concurrency: z.string().default("auto").describe(
    "Worker `--concurrency` ('auto' = CPU count, min 1).",
  ),
  enableLinger: z.boolean().default(true).describe(
    "Run `loginctl enable-linger` so the user service survives logout/reboot.",
  ),
  otelSettingsModel: z.string().default("").describe(
    "Name of the @svendowideit/otel-settings model whose contract the worker " +
      "exports telemetry to (empty disables worker telemetry). Set it to the " +
      "site's settings model so the worker exports logs, metrics and traces.",
  ),
  otelServiceName: z.string().default("swamp-worker").describe(
    "OTEL_SERVICE_NAME the worker reports; the resource `service.name` is set " +
      "to the same. Each node adds a `host=` resource attribute.",
  ),
  telemetryVault: z.string().default("").describe(
    "Vault holding the gateway OTLP bearer token (empty = unauthenticated).",
  ),
  authRef: z.string().default("OTEL_EXPORTER_OTLP_TOKEN").describe(
    "Vault key holding the gateway bearer token (a reference, never the secret).",
  ),
}).strict();

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit testing)
// ---------------------------------------------------------------------------

/** Expand a leading `~` to the user's home directory. */
export function expandHome(path: string, home?: string): string {
  const h = home ?? Deno.env.get("HOME") ?? "";
  if (path === "~") return h;
  if (path.startsWith("~/")) return `${h}${path.slice(1)}`;
  return path;
}

/**
 * The host label (and telemetry `host=`) for a worker: the explicit arg, else
 * this machine's hostname.
 */
export function resolveHost(host?: string): string {
  return (host ?? "").trim() || Deno.hostname();
}

/** The unit name for an identity: `swamp-worker-<identity>`. */
export function deriveUnitName(identity: string, override?: string): string {
  const explicit = (override ?? "").trim();
  if (explicit) return explicit;
  return `swamp-worker-${identity}`;
}

/**
 * Reject a service name that is not this identity's own.
 *
 * `remove` may only ever touch `swamp-worker-<identity>` — a foreign worker
 * (`swamp-worker-rc`, `swamp-worker`, …) belongs to another swamp and must be
 * left alone. systemd unit-name safety is asserted separately.
 */
export function assertOwnedUnit(
  unitName: string,
  identity: string,
  override?: string,
): void {
  const expected = deriveUnitName(identity, override);
  if (unitName !== expected) {
    throw new Error(
      `Refusing to manage '${unitName}': this model owns only '${expected}' ` +
        `(identity '${identity}').`,
    );
  }
  // Even an explicit `unitName` override may not point at another identity's
  // *standard* worker unit — that is exactly the collision this model exists to
  // prevent. A custom name that is not `swamp-worker-<slug>` is this model's own.
  const slug = /^swamp-worker-(.+)$/.exec(unitName)?.[1] ?? null;
  if (slug !== null && slug !== identity && !slug.startsWith(`${identity}-`)) {
    throw new Error(
      `Refusing to manage '${unitName}': it is the standard unit of identity ` +
        `'${slug}', not '${identity}'. A repo must not manage another repo's worker.`,
    );
  }
}

/** Reject characters that would escape the unit dir or inject directives. */
export function assertValidUnitName(unitName: string): void {
  if (
    unitName.length === 0 ||
    unitName.includes("/") ||
    unitName.includes("\\") ||
    unitName.includes("..") ||
    unitName.includes("\0") ||
    unitName.startsWith(".") ||
    /\s/.test(unitName)
  ) {
    throw new Error(
      `Invalid unit name '${unitName}': systemd unit names must not be empty ` +
        `or contain '/', '\\', '..', whitespace, or null bytes.`,
    );
  }
}

/** Absolute path of the identity's systemd user unit file. */
export function unitPathFor(
  g: Pick<GlobalArgs, "unitDir" | "identity" | "unitName">,
  home?: string,
): string {
  const name = deriveUnitName(g.identity, g.unitName);
  return `${expandHome(g.unitDir, home)}/${name}.service`;
}

/** Absolute path of the identity's token file (0600). */
export function tokenFilePath(g: GlobalArgs, home?: string): string {
  return `${expandHome(g.configDir, home)}/${g.identity}.token`;
}

/** Absolute path of the identity's env file (0600, optional in the unit). */
export function envFilePath(g: GlobalArgs, home?: string): string {
  return `${expandHome(g.configDir, home)}/${g.identity}.env`;
}

/** Absolute path of the identity's worker cache dir (holds the machine-id). */
export function cacheDirFor(g: GlobalArgs, home?: string): string {
  return `${expandHome(g.cacheDirRoot, home)}/${g.identity}`;
}

/**
 * The default enrollment-token name for this host: `<identity>-<hostname>`.
 *
 * One token per (repo/host): the name is the stable per-target key used for the
 * `token` resource instance and the orchestrator-side staging file, so two hosts
 * never share a slot.
 */
export function defaultTokenName(identity: string, hostname?: string): string {
  return `${identity}-${((hostname ?? Deno.hostname()) || "host").trim()}`;
}

/**
 * Absolute path of the orchestrator-side staging file for one node's token.
 * `mintToken` writes `<stagingDir>/<name>.token` (0600) so a site workflow can
 * `@swamp/ssh copy` it to the node without the secret ever entering swamp data
 * or a command line. Keyed by the full token `name` (e.g. `figy-node1`).
 */
export function stagedTokenPath(
  g: GlobalArgs,
  name: string,
  home?: string,
): string {
  return `${expandHome(g.stagingDir, home)}/${name}.token`;
}

/** The stable scheduling labels every worker of this identity advertises. */
export function baseLabels(identity: string, host: string): [string, string][] {
  return [["serve", identity], ["host", host]];
}

/** Quote one systemd `ExecStart` argument. */
function unitArg(value: string): string {
  // `%h` (home) and `@@TF_HOSTNAME@@` (host placeholder) are left unquoted so
  // systemd/the provisioning script see them as-is.
  if (/^[A-Za-z0-9_./:=+%@-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Replace a leading `home` prefix with `marker`, so a rendered unit/script is
 * portable to a node whose home dir differs from the orchestrator's: `%h` for a
 * systemd unit, `$HOME` for a shell script.
 */
export function portabilize(
  value: string,
  home: string,
  marker: string,
): string {
  if (!home) return value;
  if (value === home) return marker;
  if (value.startsWith(`${home}/`)) {
    return `${marker}${value.slice(home.length)}`;
  }
  return value;
}

/** Double-quote a shell value, letting `$HOME` expand (but escaping the rest). */
function shVal(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Assign a shell variable with {@link shVal}. */
function shVar(name: string, value: string): string {
  return `${name}=${shVal(value)}`;
}

function assertNoNewlines(field: string, value: string): void {
  if (/[\r\n]/.test(value)) {
    throw new Error(
      `Invalid ${field}: must not contain newlines (a newline would inject ` +
        `extra systemd unit directives).`,
    );
  }
}

/** The OTLP telemetry a worker unit exports, resolved from a settings contract. */
export interface TelemetryEnv {
  endpoint: string;
  headers: string;
  serviceName: string;
  resourceAttributes: string;
}

/**
 * Build the worker's OTEL env from an `otel-settings` `settings` document: the
 * default-mesh OTLP/HTTP endpoint, a bearer header when a token is configured,
 * the service name, and the resource attributes (with this worker's own
 * `host`). Pure; mirrors `@svendowideit/swamp-serve`'s telemetry resolution.
 */
export function buildTelemetryEnv(
  settings: {
    endpoints?: Array<{ mesh?: string; otlp_http_url?: string }>;
    defaultMesh?: string;
    deploymentEnvironment?: string;
    site?: string;
    owner?: string;
  },
  opts: {
    serviceName: string;
    host?: string;
    token?: string;
    endpoint?: string;
  },
): TelemetryEnv {
  let endpoint = opts.endpoint ?? "";
  if (!endpoint) {
    const endpoints = settings.endpoints ?? [];
    const preferred = settings.defaultMesh
      ? endpoints.find((e) => e.mesh === settings.defaultMesh)
      : undefined;
    endpoint = preferred?.otlp_http_url ?? endpoints[0]?.otlp_http_url ?? "";
  }
  const resourceAttributes = [
    // service.name belongs here as well as in OTEL_SERVICE_NAME: Deno's native
    // (Rust) telemetry reads OTEL_RESOURCE_ATTRIBUTES but ignores
    // OTEL_SERVICE_NAME, so without it native records land as
    // "unknown_service:deno". swamp's Node SDK path honours both.
    opts.serviceName ? `service.name=${opts.serviceName}` : "",
    settings.deploymentEnvironment
      ? `deployment.environment=${settings.deploymentEnvironment}`
      : "",
    settings.site ? `site=${settings.site}` : "",
    settings.owner ? `owner=${settings.owner}` : "",
    opts.host ? `host=${opts.host}` : "",
  ].filter(Boolean).join(",");
  return {
    endpoint,
    headers: opts.token ? `Authorization=Bearer ${opts.token}` : "",
    serviceName: opts.serviceName,
    resourceAttributes,
  };
}

/** Everything needed to render a worker unit. */
export interface WorkerUnitOptions {
  /** Systemd user unit name (without `.service`). */
  unitName: string;
  /** Identity slug — used in the description and the `serve` label. */
  identity: string;
  /** `wss://` or `ws://` URL of the serve orchestrator. */
  serveUrl: string;
  /** Absolute path to the swamp binary. */
  swampBinPath: string;
  /** Absolute path to the token file the unit reads. */
  tokenFile: string;
  /** Absolute path to the worker cache dir. */
  cacheDir: string;
  /** `--concurrency` value. */
  concurrency: string;
  /** Absolute SWAMP_HOME. */
  swampHome: string;
  /** Absolute SWAMP_CONFIG_DIR. */
  swampConfigDir: string;
  /** Optional 0600 EnvironmentFile (absolute); rendered with `-` (optional). */
  envFile?: string;
  /** Extra scheduling labels, merged after the base `serve`/`host` labels. */
  labels?: [string, string][];
  /** Resolved OTLP telemetry; when present its env is written into the unit. */
  otel?: TelemetryEnv | null;
}

/**
 * Render the `swamp worker connect` systemd **user** unit for one identity.
 *
 * Mirrors `@svendowideit/systemd-service`'s unit construction: `Type=simple`,
 * `WantedBy=default.target`, sane restart/timeout hardening. The unit is the
 * *desired state* — `ensureService` writes it and reloads only when it changes.
 */
export function renderWorkerUnit(o: WorkerUnitOptions): string {
  assertValidUnitName(o.unitName);
  for (
    const [field, value] of [
      ["serveUrl", o.serveUrl],
      ["swampBinPath", o.swampBinPath],
      ["tokenFile", o.tokenFile],
      ["cacheDir", o.cacheDir],
      ["concurrency", o.concurrency],
      ["swampHome", o.swampHome],
      ["swampConfigDir", o.swampConfigDir],
      ["envFile", o.envFile ?? ""],
      ["otelServiceName", o.otel?.serviceName ?? ""],
      ["otelEndpoint", o.otel?.endpoint ?? ""],
      ["otelHeaders", o.otel?.headers ?? ""],
      ["otelResourceAttributes", o.otel?.resourceAttributes ?? ""],
    ] as [string, string][]
  ) {
    assertNoNewlines(field, value);
  }
  const labels = o.labels ?? [];
  for (const [k, v] of labels) {
    assertNoNewlines("label", `${k}=${v}`);
  }

  const exec: string[] = [
    o.swampBinPath,
    "worker",
    "connect",
    o.serveUrl,
    "--token-file",
    o.tokenFile,
    "--cache-dir",
    o.cacheDir,
    "--concurrency",
    o.concurrency,
  ];
  for (const [k, v] of labels) exec.push("--label", `${k}=${v}`);

  const lines: string[] = [
    `# Managed by @svendowideit/swamp-worker — do not edit by hand.`,
    `# identity: ${o.identity}`,
    `[Unit]`,
    `Description=swamp worker (${o.identity}) for ${o.serveUrl}`,
    `After=network-online.target`,
    `Wants=network-online.target`,
    ``,
    `[Service]`,
    `Type=simple`,
    `ExecStart=${exec.map(unitArg).join(" ")}`,
    `Environment=SWAMP_HOME=${o.swampHome}`,
    `Environment=SWAMP_CONFIG_DIR=${o.swampConfigDir}`,
  ];
  if (o.otel && o.otel.endpoint) {
    lines.push(`Environment=OTEL_EXPORTER_OTLP_ENDPOINT=${o.otel.endpoint}`);
    lines.push(`Environment=OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`);
    if (o.otel.headers) {
      lines.push(`Environment=OTEL_EXPORTER_OTLP_HEADERS=${o.otel.headers}`);
    }
    lines.push(`Environment=OTEL_SERVICE_NAME=${o.otel.serviceName}`);
    if (o.otel.resourceAttributes) {
      lines.push(
        `Environment=OTEL_RESOURCE_ATTRIBUTES=${o.otel.resourceAttributes}`,
      );
    }
    // A long-running worker batches rather than flushing per record.
    lines.push(`Environment=OTEL_BSP_USE=1`);
    lines.push(`Environment=OTEL_BLRP_USE=1`);
  }
  if (o.envFile) lines.push(`EnvironmentFile=-${o.envFile}`);
  lines.push(
    `Restart=always`,
    `RestartSec=5`,
    `TimeoutStopSec=10`,
    ``,
    `[Install]`,
    `WantedBy=default.target`,
    ``,
  );
  return lines.join("\n");
}

/**
 * The token `renderWorkerUnit` puts in place of a host label when the unit is
 * rendered once for a *set* of nodes. The provisioning script substitutes each
 * node's own hostname at install time, so one script serves every node but each
 * worker still advertises its real host.
 */
export const HOSTNAME_PLACEHOLDER = "@@TF_HOSTNAME@@";

/** Everything a provisioning script needs, rendered by the model. */
export interface ProvisionScriptOptions {
  /** systemd user unit name (without `.service`). */
  unitName: string;
  /** The rendered unit file content (may contain {@link HOSTNAME_PLACEHOLDER}). */
  unitContent: string;
  /** Absolute path to the swamp binary the worker runs. */
  swampBinPath: string;
  /** Absolute dir holding the token/env files (on the node). */
  configDir: string;
  /** Absolute worker cache dir (on the node). */
  cacheDir: string;
  /** Absolute token file path (on the node); delivered over SSH beforehand. */
  tokenFile: string;
  /** Absolute optional env file path (on the node). */
  envFile: string;
  /** Absolute systemd user unit dir (on the node). */
  unitDir: string;
  /** Absolute SWAMP_HOME. */
  swampHome: string;
  /** Absolute SWAMP_CONFIG_DIR. */
  swampConfigDir: string;
  /** Base URL for the swamp release download. */
  releaseBaseUrl: string;
  /** swamp release tag to install, empty/`latest` for the latest. */
  version?: string;
  /** Run `loginctl enable-linger` so the worker survives logout/reboot. */
  enableLinger: boolean;
}

/** POSIX shell single-quote a value. */
function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Render the POSIX shell script that installs and starts one worker on a host.
 *
 * Pure: the same text is what `ensureService` runs locally and what a site
 * workflow ships to a remote host over SSH (`@swamp/ssh script`). It does *not*
 * contain the enrollment token — the token file is delivered separately (a
 * `copy`) and the script only enforces its `0600` mode. The unit content is
 * embedded verbatim; when it contains {@link HOSTNAME_PLACEHOLDER} the script
 * substitutes the node's own hostname, so one script serves every node.
 */
export function renderProvisionScript(o: ProvisionScriptOptions): string {
  assertValidUnitName(o.unitName);
  for (
    const [field, value] of [
      ["swampBinPath", o.swampBinPath],
      ["configDir", o.configDir],
      ["cacheDir", o.cacheDir],
      ["tokenFile", o.tokenFile],
      ["envFile", o.envFile],
      ["unitDir", o.unitDir],
      ["swampHome", o.swampHome],
      ["swampConfigDir", o.swampConfigDir],
      ["releaseBaseUrl", o.releaseBaseUrl],
      ["version", o.version ?? ""],
    ] as [string, string][]
  ) {
    assertNoNewlines(field, value);
  }
  // The unit content legitimately spans lines; only the heredoc terminator must
  // not appear inside it.
  if (o.unitContent.split("\n").some((l) => l.trim() === "TF_UNIT_EOF")) {
    throw new Error(
      "unit content must not contain a 'TF_UNIT_EOF' line (heredoc terminator)",
    );
  }
  const version = o.version && o.version !== "latest" ? o.version : "latest";
  const releasePath = version === "latest"
    ? "latest/download"
    : `download/${version}`;
  const url = `${o.releaseBaseUrl}/${releasePath}/swamp-linux-$ARCH`;

  const linger = o.enableLinger
    ? `  command -v loginctl >/dev/null 2>&1 && loginctl enable-linger >/dev/null 2>&1 || true`
    : `  :`;
  // Requesting a `version` (including `latest`) turns the binary step into an
  // install-or-upgrade; leaving it empty keeps it install-only-if-absent.
  const upgrade = (o.version ?? "").trim() !== "";

  return `#!/bin/sh
# Generated by @svendowideit/swamp-worker — installs and starts one worker.
set -eu

${shVar("SWAMP_BIN", o.swampBinPath)}
${shVar("SWAMP_HOME", o.swampHome)}
${shVar("SWAMP_CONFIG_DIR", o.swampConfigDir)}
${shVar("CONFIG_DIR", o.configDir)}
${shVar("CACHE_DIR", o.cacheDir)}
${shVar("TOKEN_FILE", o.tokenFile)}
${shVar("ENV_FILE", o.envFile)}
${shVar("UNIT_DIR", o.unitDir)}
UNIT_NAME=${shq(o.unitName)}
UNIT_FILE="$UNIT_DIR/$UNIT_NAME.service"
# identity derived from the unit name — used to verify a delivered token's owner.
IDENTITY=\${UNIT_NAME#swamp-worker-}

# A user service needs the caller's runtime dir (set by PAM on a login shell).
[ -d "/run/user/$(id -u)" ] && export XDG_RUNTIME_DIR="/run/user/$(id -u)"
export SWAMP_HOME SWAMP_CONFIG_DIR

# systemd is required: fail clearly (not by hanging) on a host without it.
if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemctl not found — this host has no systemd; cannot manage $UNIT_NAME" >&2
  exit 1
fi

# Download a URL to a file, preferring curl but falling back to wget — minimal
# hosts (e.g. a fresh Ubuntu) ship wget but not curl.
download() {
  DL_URL=$1
  DL_DEST=$2
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -o "$DL_DEST" "$DL_URL"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$DL_DEST" "$DL_URL"
  else
    echo "neither curl nor wget is available to download $DL_URL" >&2
    return 1
  fi
}

# 1. the swamp binary: install when absent; when a version was requested, upgrade
BINARY_CHANGED=0
ARCH=$(uname -m)
case "$ARCH" in
  x86_64|amd64) ARCH=x86_64 ;;
  aarch64|arm64) ARCH=aarch64 ;;
esac
if [ ! -x "$SWAMP_BIN" ]; then
  mkdir -p "$(dirname "$SWAMP_BIN")"
  echo "installing swamp → $SWAMP_BIN"
  download "${url}" "$SWAMP_BIN"
  chmod +x "$SWAMP_BIN"
  BINARY_CHANGED=1${
    upgrade
      ? `
else
  # upgrade: fetch the requested release and replace only if the bytes differ
  TMP_BIN=$(mktemp)
  if download "${url}" "$TMP_BIN"; then
    chmod +x "$TMP_BIN"
    if ! cmp -s "$TMP_BIN" "$SWAMP_BIN"; then
      echo "upgrading swamp → $SWAMP_BIN"
      install -m755 "$TMP_BIN" "$SWAMP_BIN"
      BINARY_CHANGED=1
    fi
  fi
  rm -f "$TMP_BIN"`
      : ``
  }
fi

# 1b. a token delivered to the staging path (by the site workflow's @swamp/ssh
# copy) is installed to its final 0600 location here, then the staging copy is
# removed. This avoids needing to know the node user's home at copy time.
STAGED_TOKEN=/tmp/swamp-worker-token
if [ -f "$STAGED_TOKEN" ]; then
  # Freshness/identity: swamp token plaintext is '<name>.<secret>'; the name must
  # be this identity's, so a stale or another repo's token is refused rather than
  # installed as this worker's.
  STAGED_NAME=$(head -n1 "$STAGED_TOKEN" | cut -s -d. -f1)
  case "$STAGED_NAME" in
    "") : ;;
    "$IDENTITY"-*) : ;;
    *)
      echo "delivered token '$STAGED_NAME' is not an '$IDENTITY-' token — refusing" >&2
      exit 1
      ;;
  esac
  install -D -m600 "$STAGED_TOKEN" "$TOKEN_FILE"
  rm -f "$STAGED_TOKEN"
fi

# 2. the token file must be present; lock it down.
if [ ! -s "$TOKEN_FILE" ]; then
  echo "token file $TOKEN_FILE is missing — deliver it before provisioning" >&2
  exit 1
fi
chmod 600 "$TOKEN_FILE"

# 3. the optional env file (0600)
[ -e "$ENV_FILE" ] || : > "$ENV_FILE"
chmod 600 "$ENV_FILE"

# 4. write the unit only when it changed
mkdir -p "$CONFIG_DIR" "$UNIT_DIR"
UNIT_TMP=$(mktemp)
HOST=$(hostname 2>/dev/null || cat /etc/hostname 2>/dev/null || echo unknown)
cat > "$UNIT_TMP" <<'TF_UNIT_EOF'
${o.unitContent}
TF_UNIT_EOF
sed "s/${HOSTNAME_PLACEHOLDER}/$HOST/g" "$UNIT_TMP" > "$UNIT_TMP.2" && mv "$UNIT_TMP.2" "$UNIT_TMP"
CHANGED=0
if [ ! -f "$UNIT_FILE" ] || ! cmp -s "$UNIT_TMP" "$UNIT_FILE"; then
  mv "$UNIT_TMP" "$UNIT_FILE"
  CHANGED=1
else
  rm -f "$UNIT_TMP"
fi

# 4b. a changed *token* (a re-deploy or a rotation) must restart the worker onto
# it — comparing the unit alone would leave the running process on the old token.
TOKEN_STAMP="$CONFIG_DIR/.$UNIT_NAME.token.sha"
TOKEN_HASH=$(sha256sum "$TOKEN_FILE" | awk '{print $1}')
if [ "$TOKEN_HASH" != "$(cat "$TOKEN_STAMP" 2>/dev/null || echo '')" ]; then
  CHANGED=1
fi

# a changed binary likewise needs a restart onto it.
if [ "$BINARY_CHANGED" = "1" ]; then
  CHANGED=1
fi

# 5. reconcile systemd
systemctl --user daemon-reload
${linger}
systemctl --user enable "$UNIT_NAME"
if [ "$CHANGED" = "1" ]; then
  systemctl --user restart "$UNIT_NAME" 2>/dev/null || systemctl --user start "$UNIT_NAME"
else
  systemctl --user start "$UNIT_NAME" 2>/dev/null || true
fi
printf '%s' "$TOKEN_HASH" > "$TOKEN_STAMP"
chmod 600 "$TOKEN_STAMP" 2>/dev/null || true

# 6. confirm it is actually running (a real gate, so the caller fails loudly)
i=0
while [ "$i" -lt 15 ]; do
  [ "$(systemctl --user is-active "$UNIT_NAME" 2>/dev/null || true)" = "active" ] && break
  i=$((i+1)); sleep 1
done
STATUS=$(systemctl --user is-active "$UNIT_NAME" 2>/dev/null || echo unknown)
echo "worker $UNIT_NAME: $STATUS"
if [ "$STATUS" != "active" ]; then
  echo "worker $UNIT_NAME is not active on this host" >&2
  exit 1
fi
`;
}

/** Everything a remote teardown script needs. */
export interface RemoveScriptOptions {
  unitName: string;
  unitDir: string;
  configDir: string;
  cacheDir: string;
  tokenFile: string;
  envFile: string;
}

/**
 * Render the POSIX shell script that removes one worker's local artifacts on a
 * host (stop/disable/delete the unit, cache dir, token/env files). Pure; the
 * orchestrator-side token revocation is separate (`revokeToken`).
 */
export function renderRemoveScript(o: RemoveScriptOptions): string {
  assertValidUnitName(o.unitName);
  return `#!/bin/sh
# Generated by @svendowideit/swamp-worker — removes one worker's host artifacts.
set -eu
UNIT_NAME=${shq(o.unitName)}
${shVar("UNIT_DIR", o.unitDir)}
UNIT_FILE="$UNIT_DIR/$UNIT_NAME.service"
[ -d "/run/user/$(id -u)" ] && export XDG_RUNTIME_DIR="/run/user/$(id -u)"
if command -v systemctl >/dev/null 2>&1; then
  systemctl --user stop "$UNIT_NAME" 2>/dev/null || true
  systemctl --user disable "$UNIT_NAME" 2>/dev/null || true
fi
rm -f "$UNIT_FILE"
if command -v systemctl >/dev/null 2>&1; then
  systemctl --user daemon-reload 2>/dev/null || true
fi
rm -rf ${shVal(o.cacheDir)} ${shVal(o.tokenFile)} ${shVal(o.envFile)}
if [ -d ${shVal(o.configDir)} ]; then
  rmdir ${shVal(o.configDir)} 2>/dev/null || true
fi
echo "removed worker $UNIT_NAME"
`;
}

// ---------------------------------------------------------------------------
// Command + filesystem helpers
// ---------------------------------------------------------------------------

export type CmdResult = { stdout: string; stderr: string; code: number };

/** A subprocess runner: run `binary` with `args`, returning captured output. */
export type RunFn = (
  binary: string,
  args: string[],
  cwd?: string,
) => Promise<CmdResult>;

/** The real runner: spawn the process and capture stdout/stderr. */
export async function defaultRun(
  binary: string,
  args: string[],
  cwd?: string,
): Promise<CmdResult> {
  try {
    // swamp-quality-ignore deno-command: this model drives systemctl/swamp/curl; arguments are quoted and this is the single injectable spawn seam, stubbed in tests
    const proc = new Deno.Command(binary, {
      args,
      cwd,
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

let activeRun: RunFn = defaultRun;

/**
 * Override the subprocess runner. Tests inject a stub so `install`, `mintToken`,
 * `ensureService`, `status`, `remove` and `revokeToken` can be exercised without
 * a real host. Pass `null` to restore the real runner.
 */
export function setRunFn(fn: RunFn | null): void {
  activeRun = fn ?? defaultRun;
}

async function runCmd(
  binary: string,
  args: string[],
  cwd?: string,
): Promise<CmdResult> {
  return await activeRun(binary, args, cwd);
}

async function systemctl(args: string[]): Promise<CmdResult> {
  return await runCmd("systemctl", ["--user", ...args]);
}

async function writeMode600(path: string, content: string): Promise<void> {
  const dir = path.slice(0, path.lastIndexOf("/"));
  if (dir) await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(path, content);
  await Deno.chmod(path, 0o600);
}

async function readTextSafe(path: string): Promise<string> {
  try {
    return await Deno.readTextFile(path);
  } catch {
    return "";
  }
}

function isAlreadyStopped(result: CmdResult): boolean {
  if (result.code === 0) return true;
  return result.code === 5 &&
    /not loaded|not found/i.test(`${result.stderr}${result.stdout}`);
}

/** Create one named enrollment token; the plaintext is in `.token` on success. */
function createNamedToken(
  g: GlobalArgs,
  name: string,
  duration: string,
): Promise<CmdResult> {
  return runCmd(
    expandHome(g.swampBinPath),
    [
      "worker",
      "token",
      "create",
      name,
      "--duration",
      duration,
      "--repo-dir",
      expandHome(g.repoDir),
      "--json",
    ],
    expandHome(g.repoDir),
  );
}

/**
 * Revoke one named enrollment token, tolerating an already-absent token (so a
 * repeated teardown is clean). Throws on any other failure.
 */
async function revokeNamedToken(
  g: GlobalArgs,
  name: string,
): Promise<CmdResult> {
  const res = await runCmd(
    expandHome(g.swampBinPath),
    [
      "worker",
      "token",
      "revoke",
      name,
      "--repo-dir",
      expandHome(g.repoDir),
    ],
    expandHome(g.repoDir),
  );
  if (
    res.code !== 0 &&
    !/not found|already revoked|does not exist/i.test(
      `${res.stderr}${res.stdout}`,
    )
  ) {
    throw new Error(
      `swamp worker token revoke ${name} failed (${res.code}): ` +
        `${res.stderr || res.stdout}`,
    );
  }
  return res;
}

/**
 * Every token name that belongs to one target: the base `<identity>-<node>` plus
 * any rotation generations `<identity>-<node>-g<gen>`. Exact, so `figy-node1`
 * never matches `figy-node10`.
 */
export function targetTokenNames(base: string, all: string[]): string[] {
  return all.filter((n) => n === base || n.startsWith(`${base}-g`));
}

/**
 * The token names a revoke should retire: just the exact `name` (a rotation
 * revokes only the previous token), or — the default — the target's base name
 * plus every generation found in the repo, so a rotated target is fully retired.
 * The base name is always included even when listing is unavailable.
 */
async function namesToRevoke(
  g: GlobalArgs,
  name: string,
  allGenerations: boolean,
): Promise<string[]> {
  if (!allGenerations) return [name];
  const names = targetTokenNames(name, await listTokenNames(g));
  if (!names.includes(name)) names.unshift(name);
  return names;
}

/**
 * List the enrollment-token names in the repo (`swamp worker token list --json`).
 * Returns `[]` when listing is unavailable, so a revoke can still fall back to
 * the single exact name rather than failing the whole operation.
 */
async function listTokenNames(g: GlobalArgs): Promise<string[]> {
  const res = await runCmd(
    expandHome(g.swampBinPath),
    ["worker", "token", "list", "--json", "--repo-dir", expandHome(g.repoDir)],
    expandHome(g.repoDir),
  );
  try {
    const parsed = JSON.parse(res.stdout);
    if (Array.isArray(parsed)) {
      return parsed.map((t) => String((t as { name?: unknown }).name ?? ""))
        .filter((n) => n !== "");
    }
  } catch {
    // fall through
  }
  return [];
}

/**
 * The first dotted segment of a token plaintext — the token's own name in swamp's
 * `<name>.<secret>` format — or "" when there is no dot to split on.
 */
export function tokenPlaintextName(plaintext: string): string {
  const dot = plaintext.indexOf(".");
  return dot > 0 ? plaintext.slice(0, dot) : "";
}

/**
 * Mint `name`, self-healing when the name already exists: `token create` rejects
 * an existing name, so — a re-run whose staged plaintext was lost, or a forced
 * re-mint — revokes the old token first, then creates the name afresh.
 */
async function mintNamedToken(
  g: GlobalArgs,
  name: string,
  duration: string,
  context: MethodContext,
): Promise<string> {
  let res = await createNamedToken(g, name, duration);
  if (res.code !== 0 && /already exists/i.test(`${res.stderr}${res.stdout}`)) {
    context.logger?.info(
      "token {name} already exists — revoking it before minting a replacement",
      { name },
    );
    await revokeNamedToken(g, name);
    res = await createNamedToken(g, name, duration);
  }
  let token = "";
  try {
    token = String(JSON.parse(res.stdout).token ?? "");
  } catch {
    token = "";
  }
  if (res.code !== 0 || token === "") {
    throw new Error(
      `swamp worker token create ${name} failed (${res.code}): ` +
        `${res.stderr || res.stdout}`,
    );
  }
  return token;
}

// ---------------------------------------------------------------------------
// Method args
// ---------------------------------------------------------------------------

const RenderUnitArgsSchema = z.object({
  serveUrl: z.string().min(1).describe("Serve URL the worker dials."),
  host: z.string().default("").describe(
    "Host label value. Defaults to this machine's hostname.",
  ),
  labels: z.array(z.string()).default([]).describe(
    "Extra scheduling labels as KEY=VALUE strings.",
  ),
  concurrency: z.string().default("").describe(
    "Override the global concurrency for this render.",
  ),
  write: z.boolean().default(false).describe(
    "Also write the unit file to disk (without reloading systemd).",
  ),
});

const RenderProvisionArgsSchema = z.object({
  serveUrl: z.string().min(1).describe("Serve URL the worker dials."),
  host: z.string().default("").describe(
    "Host label value. Empty fills each node's own hostname at install time, so " +
      "one script serves every node.",
  ),
  labels: z.array(z.string()).default([]).describe(
    "Extra scheduling labels as KEY=VALUE strings.",
  ),
  concurrency: z.string().default("").describe("Override concurrency."),
  version: z.string().default("").describe(
    "swamp release tag to install on the node; empty = latest.",
  ),
});

const InstallArgsSchema = z.object({
  version: z.string().default("").describe(
    "swamp release tag to install (empty = latest).",
  ),
  force: z.boolean().default(false).describe(
    "Reinstall even when the binary is already present.",
  ),
});

const ClearStagedArgsSchema = z.object({
  names: z.array(z.string()).default([]).describe(
    "Enrollment token names whose orchestrator-side staging files " +
      "(`<stagingDir>/<name>.token`) to delete.",
  ),
});

const MintTokenArgsSchema = z.object({
  name: z.string().default("").describe(
    "Enrollment token name — also names the 0600 orchestrator-side staging file " +
      "`<stagingDir>/<name>.token` and the `token` resource instance. Defaults to " +
      "`<identity>-<hostname>`. Per-target: call once per node.",
  ),
  duration: z.string().default("30d").describe(
    "Token lifetime (hard deadline), e.g. 24h, 7d, 30d.",
  ),
  force: z.boolean().default(false).describe(
    "Mint a fresh token even when one is already staged for this name. The old " +
      "token of the same name is revoked first (a name cannot be re-minted while " +
      "it exists), so a forced re-mint replaces the token rather than reusing it.",
  ),
});

const RevokeTokenArgsSchema = z.object({
  name: z.string().default("").describe(
    "Enrollment token name to revoke (the target's base name, or an exact " +
      "generation name). Defaults to `<identity>-<hostname>`.",
  ),
  allGenerations: z.boolean().default(true).describe(
    "Also revoke every rotation generation of this name (`<name>-g<gen>`), so a " +
      "target that has been rotated is fully retired and no live token survives. " +
      "Set false to revoke only the exact name (as a rotation does for the " +
      "previous token).",
  ),
  purgeFile: z.boolean().default(true).describe(
    "Also delete the local token file, so the revoked token cannot be reused.",
  ),
});

const EnsureServiceArgsSchema = z.object({
  serveUrl: z.string().min(1).describe("Serve URL the worker dials."),
  host: z.string().default("").describe(
    "Host label value. Defaults to this machine's hostname.",
  ),
  labels: z.array(z.string()).default([]).describe(
    "Extra scheduling labels as KEY=VALUE strings.",
  ),
  concurrency: z.string().default("").describe("Override concurrency."),
  name: z.string().default("").describe(
    "Enrollment token name whose staged plaintext to install before starting " +
      "the unit. Defaults to `<identity>-<hostname>`. Ignored when no staged " +
      "token exists.",
  ),
  force: z.boolean().default(false).describe(
    "Restart the unit even when nothing changed.",
  ),
});

const RemoveArgsSchema = z.object({
  name: z.string().default("").describe(
    "Enrollment token name to revoke and whose staged file to drop. Defaults to " +
      "`<identity>-<hostname>`.",
  ),
  revokeToken: z.boolean().default(true).describe(
    "Also revoke the enrollment token on the orchestrator (a complete " +
      "decommission). Set false when revoking separately, e.g. when the repo " +
      "is not reachable from this host.",
  ),
  purgeData: z.boolean().default(true).describe(
    "Also delete the identity's cache dir and token/env files.",
  ),
});

// ---------------------------------------------------------------------------
// Resource schemas
// ---------------------------------------------------------------------------

const UnitOutputSchema = z.object({
  unitName: z.string(),
  unitPath: z.string(),
  identity: z.string(),
  serveUrl: z.string(),
  content: z.string(),
  written: z.boolean(),
  renderedAt: z.string(),
});

const InstallOutputSchema = z.object({
  swampBinPath: z.string(),
  present: z.boolean(),
  action: z.enum(["kept", "installed", "failed"]),
  detail: z.string(),
  checkedAt: z.string(),
});

const TokenOutputSchema = z.object({
  name: z.string(),
  duration: z.string(),
  // swamp-quality-ignore credentials-sensitive-field: not a secret — a file path
  tokenFile: z.string(),
  stored: z.boolean(),
  reused: z.boolean(),
  /** True when this run revoked the token rather than minting it. */
  revoked: z.boolean().default(false),
  createdAt: z.string(),
});

/** A rendered per-node provisioning script, for a site workflow to ship. */
const ProvisionOutputSchema = z.object({
  unitName: z.string(),
  serveUrl: z.string(),
  script: z.string(),
  unitContent: z.string(),
  renderedAt: z.string(),
});

/** A rendered per-node removal script, for a site teardown to ship. */
const RemovalOutputSchema = z.object({
  unitName: z.string(),
  script: z.string(),
  renderedAt: z.string(),
});

const WorkerOutputSchema = z.object({
  unitName: z.string(),
  unitPath: z.string(),
  identity: z.string(),
  serveUrl: z.string(),
  labels: z.array(z.string()),
  changed: z.boolean(),
  restarted: z.boolean(),
  enabled: z.boolean(),
  active: z.boolean(),
  ensuredAt: z.string(),
});

const StatusOutputSchema = z.object({
  unitName: z.string(),
  unitPath: z.string(),
  exists: z.boolean(),
  state: z.string(),
  active: z.boolean(),
  enabled: z.boolean(),
  enrolledWorkers: z.number().int(),
  matchingWorkers: z.array(z.string()),
  checkedAt: z.string(),
});

// ---------------------------------------------------------------------------
// Shared render context derived from globals
// ---------------------------------------------------------------------------

function workerRenderInput(
  g: GlobalArgs,
  args: {
    serveUrl: string;
    host?: string;
    labels: string[];
    concurrency?: string;
  },
  otel?: TelemetryEnv | null,
): WorkerUnitOptions {
  const host = resolveHost(args.host);
  const labelPairs: [string, string][] = [
    ...baseLabels(g.identity, host),
  ];
  for (const raw of args.labels) {
    const idx = raw.indexOf("=");
    if (idx <= 0) {
      throw new Error(`Invalid label '${raw}': expected KEY=VALUE.`);
    }
    labelPairs.push([raw.slice(0, idx), raw.slice(idx + 1)]);
  }
  return {
    unitName: deriveUnitName(g.identity, g.unitName),
    identity: g.identity,
    serveUrl: args.serveUrl,
    swampBinPath: expandHome(g.swampBinPath),
    tokenFile: tokenFilePath(g),
    cacheDir: cacheDirFor(g),
    concurrency: (args.concurrency ?? "").trim() || g.concurrency,
    swampHome: expandHome(g.swampHome),
    swampConfigDir: expandHome(g.swampConfigDir),
    envFile: envFilePath(g),
    labels: labelPairs,
    otel: otel ?? null,
  };
}

/**
 * Read the `settings` document from the configured otel-settings model, through
 * the sanctioned in-process APIs (never a CLI subprocess).
 */
async function readOtelSettings(
  context: MethodContext,
  modelName: string,
): Promise<Parameters<typeof buildTelemetryEnv>[0] | null> {
  const coerce = (
    record: Record<string, unknown>,
  ): Parameters<typeof buildTelemetryEnv>[0] => {
    const attrs = record.attributes && typeof record.attributes === "object"
      ? record.attributes as Record<string, unknown>
      : record;
    return attrs as Parameters<typeof buildTelemetryEnv>[0];
  };
  if (context.readModelData) {
    try {
      const records = await context.readModelData(modelName, "settings");
      if (records && records.length > 0) return coerce(records[0]);
    } catch {
      // fall through to queryData
    }
  }
  if (context.queryData) {
    try {
      const records = await context.queryData(
        `modelName == "${modelName}" && specName == "settings"`,
      );
      if (records && records.length > 0) {
        return coerce(records[0] as Record<string, unknown>);
      }
    } catch {
      // no settings available
    }
  }
  return null;
}

/** Read the gateway bearer token from the vault, when one is configured. */
async function readTelemetryToken(
  context: MethodContext,
  g: GlobalArgs,
): Promise<string> {
  if (!g.telemetryVault || !context.vaultService) return "";
  try {
    return (await context.vaultService.get(g.telemetryVault, g.authRef)).trim();
  } catch {
    return "";
  }
}

/**
 * Resolve the worker's OTLP telemetry from the configured otel-settings model.
 * Returns null when telemetry is disabled (no model configured) or the contract
 * cannot be read, so a worker without telemetry renders exactly as before.
 */
async function resolveTelemetry(
  context: MethodContext,
  g: GlobalArgs,
  host: string,
): Promise<TelemetryEnv | null> {
  if (!g.otelSettingsModel) return null;
  const settings = await readOtelSettings(context, g.otelSettingsModel);
  if (!settings) return null;
  const token = await readTelemetryToken(context, g);
  return buildTelemetryEnv(settings, {
    serviceName: g.otelServiceName,
    host,
    token,
  });
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

type MethodContext = {
  globalArgs: GlobalArgs;
  logger?: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warn?: (msg: string, props?: Record<string, unknown>) => void;
  };
  definition?: { name?: string };
  writeResource: (
    resource: string,
    instance: string,
    data: unknown,
  ) => Promise<{ name: string }>;
  queryData?: (predicate: string, select?: string) => Promise<unknown[]>;
  readModelData?: (
    modelName: string,
    specName?: string,
  ) => Promise<Array<Record<string, unknown>>>;
  vaultService?: {
    get(vaultName: string, secretKey: string, caller?: string): Promise<string>;
  };
};

export const model = {
  type: "@svendowideit/swamp-worker",
  version: "2026.10.17.2",
  globalArguments: GlobalArgsSchema,

  upgrades: [
    {
      toVersion: "2026.10.12.1",
      description:
        "Initial release: enlists a host as one swamp worker for a serve " +
        "orchestrator. Renders the systemd user unit, installs/upgrades the swamp " +
        "binary, mints enrollment tokens (single and per-node, to 0600 files), " +
        "reconciles and reports the unit (restarting when the unit, token or binary " +
        "changed), renders per-node provisioning/removal scripts for a fan-out " +
        "deploy, and completely decommissions (token revoked, artifacts removed) " +
        "only its own namespaced artifacts.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.12.2",
      description:
        "Per-target tokens (A7): `stageTokens` and the plural `stagedTokens` " +
        "resource are removed; `mintToken` now takes a `name` and is the one " +
        "method that mints and stages a token, keyed by that name for the token, " +
        "the 0600 staging file and the `token` resource instance — so one call " +
        "per node, idempotent per node, and no node can clobber another's file or " +
        "record. `clearStagedTokens` takes `names`; `revokeToken`/`remove` take a " +
        "full token `name`. `ensureService` now installs a staged token to its " +
        "0600 file and restarts when the token changed, so local token rotation " +
        "reaches a running worker.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.12.3",
      description:
        "Safer retire/apply: `revokeToken` (and `remove`) now retire **every** " +
        "token for a target by default — the base name plus any rotation " +
        "generations `<name>-g<gen>` — so teardown after a rotation can no longer " +
        "orphan the live token (`allGenerations: false` keeps the exact-name " +
        "behaviour rotation uses for the previous token). `ensureService` checks " +
        "preconditions before starting (the swamp binary and the token file must " +
        "exist) and refuses to install a staged token whose own name is not this " +
        "target's. The rendered provisioning script likewise refuses a delivered " +
        "token that is not this identity's, and fails clearly on a host without " +
        "systemd instead of hanging.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.16.1",
      description:
        "Release bump: no schema or data changes since 2026.10.12.3. " +
        "Cumulative since the first release: per-target `mintToken` (one call per " +
        "node, idempotent, no cross-node clobber), `ensureService` installing a " +
        "staged token and restarting when it changed, safer retire/apply that " +
        "retires every rotation generation by default (opt out with " +
        "`allGenerations: false`), and provisioning that refuses a foreign token " +
        "and fails clearly on a host without systemd.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.17.1",
      description: "Unified install/upgrade: ships one idempotent workflow, " +
        "`@svendowideit/swamp-worker-upgrade`, that installs the worker when it " +
        "is absent and upgrades the swamp binary and reconciles the unit when it " +
        "is present — the same command either way. No schema or data changes.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.17.2",
      description:
        "Robust provisioning download and worker telemetry. The provisioning " +
        "script now downloads the swamp binary with curl when present and falls " +
        "back to wget otherwise, so minimal hosts without curl (e.g. a fresh " +
        "Ubuntu) provision instead of failing with `curl: not found`. New " +
        "optional globals `otelSettingsModel`, `otelServiceName`, " +
        "`telemetryVault` and `authRef` render a site's `OTEL_EXPORTER_OTLP_*` " +
        "env onto the worker unit (read from an @svendowideit/otel-settings " +
        "contract), so the worker exports logs, metrics and traces with a " +
        "per-node `host=` resource attribute; both default off. No schema or " +
        "data changes.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],

  resources: {
    unit: {
      description: "Rendered swarm worker systemd user unit (desired state).",
      schema: UnitOutputSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    install: {
      description: "swamp binary presence and install outcome.",
      schema: InstallOutputSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    token: {
      description:
        "Enrollment token metadata, keyed by token name (never the secret " +
        "plaintext).",
      schema: TokenOutputSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    provision: {
      description:
        "The rendered per-node provisioning script a site workflow ships to each " +
        "node over SSH.",
      schema: ProvisionOutputSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    removal: {
      description:
        "The rendered per-node removal script a site teardown ships to each node " +
        "over SSH.",
      schema: RemovalOutputSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    worker: {
      description: "Result of reconciling the worker unit on this host.",
      schema: WorkerOutputSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    status: {
      description: "Live systemd + enrollment status for this identity.",
      schema: StatusOutputSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },

  methods: {
    renderUnit: {
      description:
        "Render the worker's systemd user unit from the desired state and " +
        "record it in a `unit` resource. Pure by default (writes nothing on " +
        "the host); pass write=true to also place the file.",
      arguments: RenderUnitArgsSchema,
      execute: async (
        args: z.infer<typeof RenderUnitArgsSchema>,
        context: MethodContext,
      ) => {
        const g = context.globalArgs;
        const otel = await resolveTelemetry(context, g, resolveHost(args.host));
        const input = workerRenderInput(g, args, otel);
        const content = renderWorkerUnit(input);
        const unitPath = unitPathFor(g);
        let written = false;
        if (args.write) {
          const dir = unitPath.slice(0, unitPath.lastIndexOf("/"));
          await Deno.mkdir(dir, { recursive: true });
          await Deno.writeTextFile(unitPath, content);
          written = true;
        }
        const handle = await context.writeResource("unit", "unit", {
          unitName: input.unitName,
          unitPath,
          identity: g.identity,
          serveUrl: args.serveUrl,
          content,
          written,
          renderedAt: new Date().toISOString(),
        });
        context.logger?.info(
          "Rendered unit {unitName} for {serveUrl}{written}",
          {
            unitName: input.unitName,
            serveUrl: args.serveUrl,
            written: written ? ` (written to ${unitPath})` : "",
          },
        );
        return { dataHandles: [handle] };
      },
    },

    renderProvision: {
      description:
        "Render the per-node provisioning script (install the binary, lock the " +
        "token, write the unit, start it) for a fan-out deploy, and record it in " +
        "a `provision` resource a site workflow ships over SSH. With no `host`, " +
        "the host label is filled from each node's own hostname at install time, " +
        "so one script serves every node.",
      arguments: RenderProvisionArgsSchema,
      execute: async (
        args: z.infer<typeof RenderProvisionArgsSchema>,
        context: MethodContext,
      ) => {
        const g = context.globalArgs;
        const home = expandHome("~");
        const host = (args.host ?? "").trim() || HOSTNAME_PLACEHOLDER;
        const otel = await resolveTelemetry(context, g, host);
        const input = workerRenderInput(g, {
          serveUrl: args.serveUrl,
          host,
          labels: args.labels,
          concurrency: args.concurrency,
        }, otel);
        // The node's home dir may differ from the orchestrator's, so rewrite the
        // orchestrator-home prefix to `%h` in the unit (systemd expands it) and
        // `$HOME` in the script (the shell expands it at install time).
        const unitInput: WorkerUnitOptions = {
          ...input,
          swampBinPath: portabilize(input.swampBinPath, home, "%h"),
          tokenFile: portabilize(input.tokenFile, home, "%h"),
          cacheDir: portabilize(input.cacheDir, home, "%h"),
          swampHome: portabilize(input.swampHome, home, "%h"),
          swampConfigDir: portabilize(input.swampConfigDir, home, "%h"),
          envFile: input.envFile
            ? portabilize(input.envFile, home, "%h")
            : input.envFile,
        };
        const unitContent = renderWorkerUnit(unitInput);
        const script = renderProvisionScript({
          unitName: input.unitName,
          unitContent,
          swampBinPath: portabilize(input.swampBinPath, home, "$HOME"),
          configDir: portabilize(expandHome(g.configDir), home, "$HOME"),
          cacheDir: portabilize(input.cacheDir, home, "$HOME"),
          tokenFile: portabilize(input.tokenFile, home, "$HOME"),
          envFile: portabilize(input.envFile ?? envFilePath(g), home, "$HOME"),
          unitDir: portabilize(expandHome(g.unitDir), home, "$HOME"),
          swampHome: portabilize(input.swampHome, home, "$HOME"),
          swampConfigDir: portabilize(input.swampConfigDir, home, "$HOME"),
          releaseBaseUrl: g.releaseBaseUrl,
          version: args.version,
          enableLinger: g.enableLinger,
        });
        const handle = await context.writeResource("provision", "provision", {
          unitName: input.unitName,
          serveUrl: args.serveUrl,
          script,
          unitContent,
          renderedAt: new Date().toISOString(),
        });
        context.logger?.info(
          "Rendered provision script for {unitName} → {serveUrl}",
          { unitName: input.unitName, serveUrl: args.serveUrl },
        );
        return { dataHandles: [handle] };
      },
    },

    renderRemoval: {
      description:
        "Render the per-node removal script (stop, disable and delete the unit " +
        "and its artifacts) for a site teardown to ship over SSH, and record it " +
        "in a `removal` resource. Paths are made portable with `$HOME`.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: MethodContext,
      ) => {
        const g = context.globalArgs;
        const home = expandHome("~");
        const unitName = deriveUnitName(g.identity, g.unitName);
        const p = (v: string) => portabilize(v, home, "$HOME");
        const script = renderRemoveScript({
          unitName,
          unitDir: p(expandHome(g.unitDir)),
          configDir: p(expandHome(g.configDir)),
          cacheDir: p(cacheDirFor(g)),
          tokenFile: p(tokenFilePath(g)),
          envFile: p(envFilePath(g)),
        });
        const handle = await context.writeResource("removal", "removal", {
          unitName,
          script,
          renderedAt: new Date().toISOString(),
        });
        context.logger?.info("Rendered removal script for {unitName}", {
          unitName,
        });
        return { dataHandles: [handle] };
      },
    },

    install: {
      description:
        "Ensure the swamp binary is installed at swampBinPath, downloading the " +
        "release (or the requested `version`) when it is absent or force=true; " +
        "otherwise a no-op.",
      arguments: InstallArgsSchema,
      execute: async (
        args: z.infer<typeof InstallArgsSchema>,
        context: MethodContext,
      ) => {
        const g = context.globalArgs;
        const bin = expandHome(g.swampBinPath);
        const present = await fileIsExecutable(bin);
        let action: "kept" | "installed" | "failed" = "kept";
        let detail = "binary already present";
        if (!present || args.force) {
          const ver = args.version && args.version !== "latest"
            ? args.version
            : "latest";
          const path = ver === "latest" ? "latest/download" : `download/${ver}`;
          const url = `${g.releaseBaseUrl}/${path}/swamp-linux-${swampArch()}`;
          const dir = bin.slice(0, bin.lastIndexOf("/"));
          if (dir) await Deno.mkdir(dir, { recursive: true });
          const res = await runCmd("curl", ["-fsSL", "-o", bin, url]);
          if (res.code !== 0) {
            action = "failed";
            detail = `download failed (${res.code}): ${
              res.stderr || res.stdout
            }`;
          } else {
            await Deno.chmod(bin, 0o755).catch(() => {});
            if (await fileIsExecutable(bin)) {
              action = "installed";
              detail = `installed from ${url}`;
            } else {
              action = "failed";
              detail = "downloaded but not an executable file";
            }
          }
        }
        const handle = await context.writeResource("install", "install", {
          swampBinPath: bin,
          present: await fileIsExecutable(bin),
          action,
          detail,
          checkedAt: new Date().toISOString(),
        });
        context.logger?.info("swamp binary {bin}: {detail}", { bin, detail });
        return { dataHandles: [handle] };
      },
    },

    clearStagedTokens: {
      description:
        "Delete the orchestrator-side staged token files for the given token " +
        "names (`<stagingDir>/<name>.token`).",
      arguments: ClearStagedArgsSchema,
      execute: async (
        args: z.infer<typeof ClearStagedArgsSchema>,
        context: MethodContext,
      ) => {
        const g = context.globalArgs;
        let removed = 0;
        for (
          const name of args.names.map((n) => n.trim()).filter((n) => n !== "")
        ) {
          const path = stagedTokenPath(g, name);
          if (await fileExists(path)) {
            await Deno.remove(path).catch(() => {});
            removed++;
          }
        }
        context.logger?.info("Cleared {removed} staged token file(s)", {
          removed,
        });
        return { dataHandles: [] };
      },
    },

    mintToken: {
      description:
        "Mint one enrollment token on the orchestrator and stage its plaintext " +
        "in a 0600 file `<stagingDir>/<name>.token`, keyed per target (call " +
        "once per node). Idempotent: an already-staged token is reused unless " +
        "`force`. The secret is never recorded in a swamp resource.",
      arguments: MintTokenArgsSchema,
      execute: async (
        args: z.infer<typeof MintTokenArgsSchema>,
        context: MethodContext,
      ) => {
        const g = context.globalArgs;
        const name = (args.name ?? "").trim() || defaultTokenName(g.identity);
        if (!name.startsWith(`${g.identity}-`)) {
          throw new Error(
            `Refusing to mint '${name}': not an '${g.identity}-' token.`,
          );
        }
        const stagedFile = stagedTokenPath(g, name);

        // Idempotent by default: reuse the token already staged for this name so
        // re-running a deploy neither mints a fresh token (stranding the live
        // worker) nor fails ('token create' rejects an existing name).
        const existing = (await readTextSafe(stagedFile)).trim();
        if (existing !== "" && !args.force) {
          const handle = await context.writeResource("token", name, {
            name,
            duration: args.duration,
            tokenFile: stagedFile,
            stored: true,
            reused: true,
            revoked: false,
            createdAt: new Date().toISOString(),
          });
          context.logger?.info(
            "Reusing staged enrollment token {name} at {stagedFile} (pass force=true to replace)",
            { name, stagedFile },
          );
          return { dataHandles: [handle] };
        }

        const token = await mintNamedToken(g, name, args.duration, context);
        await writeMode600(stagedFile, token + "\n");
        const handle = await context.writeResource("token", name, {
          name,
          duration: args.duration,
          tokenFile: stagedFile,
          stored: true,
          reused: false,
          revoked: false,
          createdAt: new Date().toISOString(),
        });
        context.logger?.info(
          "Minted enrollment token {name} ({duration}) → {stagedFile} (0600)",
          { name, duration: args.duration, stagedFile },
        );
        return { dataHandles: [handle] };
      },
    },

    revokeToken: {
      description:
        "Revoke this target's enrollment token(s) on the orchestrator (any " +
        "worker using them is disconnected) and, by default, delete the local " +
        "token file. With `allGenerations` (the default) it also revokes every " +
        "rotation generation `<name>-g<gen>`, so a rotated target is fully " +
        "retired — teardown after a rotation cannot orphan the live token. Names " +
        "must be this identity's (`<identity>-…`), so only this repo's tokens are " +
        "ever touched.",
      arguments: RevokeTokenArgsSchema,
      execute: async (
        args: z.infer<typeof RevokeTokenArgsSchema>,
        context: MethodContext,
      ) => {
        const g = context.globalArgs;
        const name = (args.name ?? "").trim() || defaultTokenName(g.identity);
        // The name is namespaced by identity, so it can only target our own
        // token; assert the invariant anyway (a caller could pass another shape).
        if (!name.startsWith(`${g.identity}-`)) {
          throw new Error(
            `Refusing to revoke '${name}': not an '${g.identity}-' token.`,
          );
        }
        const names = await namesToRevoke(g, name, args.allGenerations);
        const tokenFile = tokenFilePath(g);
        const handles = [];
        for (const n of names) {
          const res = await revokeNamedToken(g, n);
          // Always drop this token's own staging file (it belongs to the token
          // just revoked). The canonical token file is only removed when asked:
          // under rotation it holds the *new* live token, so it must be left
          // alone.
          await Deno.remove(stagedTokenPath(g, n)).catch(() => {});
          handles.push(
            await context.writeResource("token", n, {
              name: n,
              duration: "",
              tokenFile,
              stored: false,
              reused: false,
              revoked: true,
              createdAt: new Date().toISOString(),
            }),
          );
          context.logger?.info(
            res.code === 0
              ? "Revoked enrollment token {name}"
              : "token {name} was already gone (revoke is a no-op)",
            { name: n },
          );
        }
        if (args.purgeFile) {
          await Deno.remove(tokenFile).catch(() => {});
        }
        context.logger?.info(
          "Revoked {count} token(s) for {name}{purged}",
          {
            count: names.length,
            name,
            purged: args.purgeFile ? ` and removed ${tokenFile}` : "",
          },
        );
        return { dataHandles: handles };
      },
    },

    ensureService: {
      description:
        "Reconcile this host onto the desired worker state: install a pending " +
        "staged token (from mintToken) to its 0600 file, write the unit if it " +
        "changed, daemon-reload, enable with linger, and restart only when the " +
        "unit or the token changed (or force=true). Idempotent — a no-op run " +
        "restarts nothing.",
      arguments: EnsureServiceArgsSchema,
      execute: async (
        args: z.infer<typeof EnsureServiceArgsSchema>,
        context: MethodContext,
      ) => {
        const g = context.globalArgs;
        const otel = await resolveTelemetry(context, g, resolveHost(args.host));
        const input = workerRenderInput(g, args, otel);
        const unitPath = unitPathFor(g);
        const content = renderWorkerUnit(input);
        const tokenFile = tokenFilePath(g);

        // Apply: a token staged by `mintToken` is installed to the unit's 0600
        // token file here (the local equivalent of the provisioning script's
        // delivery step). A changed token restarts the unit, mirroring the
        // provision script, so a token rotation reaches a running worker.
        let tokenChanged = false;
        const tokenName = (args.name ?? "").trim() ||
          defaultTokenName(g.identity);
        const stagedFile = stagedTokenPath(g, tokenName);
        const stagedToken = (await readTextSafe(stagedFile)).trim();
        if (stagedToken !== "") {
          // Freshness/identity: a staged token is only ever this target's if its
          // own name (swamp's `<name>.<secret>`) matches — refuse a stale or
          // foreign file rather than installing it as this host's token.
          const embedded = tokenPlaintextName(stagedToken);
          if (embedded !== "" && embedded !== tokenName) {
            throw new Error(
              `staged token at ${stagedFile} is for '${embedded}', not ` +
                `'${tokenName}' — refusing to install a foreign/stale token.`,
            );
          }
          const currentToken = (await readTextSafe(tokenFile)).trim();
          if (stagedToken !== currentToken) {
            await writeMode600(tokenFile, stagedToken + "\n");
            tokenChanged = true;
          }
        }

        // Preconditions: never start (or restart) a unit that is guaranteed to
        // crash-loop — the swamp binary it execs and the token it reads must both
        // exist. Fail loudly and point at the fixing method instead.
        const bin = expandHome(g.swampBinPath);
        if (!(await fileIsExecutable(bin))) {
          throw new Error(
            `swamp binary not found at ${bin} — run \`install\` first, or fix ` +
              `swampBinPath.`,
          );
        }
        if (!(await fileExists(tokenFile))) {
          throw new Error(
            `token file ${tokenFile} is missing — run \`mintToken\` first ` +
              `(ensureService installs a token staged by mintToken).`,
          );
        }

        const existing = await readTextSafe(unitPath);
        const changed = args.force || existing !== content || tokenChanged;
        const beforeActive = await systemctl(["is-active", input.unitName]);
        const wasActive = beforeActive.stdout.trim() === "active";

        if (changed) {
          const dir = unitPath.slice(0, unitPath.lastIndexOf("/"));
          await Deno.mkdir(dir, { recursive: true });
          await Deno.writeTextFile(unitPath, content);
          const reload = await systemctl(["daemon-reload"]);
          if (reload.code !== 0) {
            throw new Error(
              `systemctl --user daemon-reload failed (${reload.code}): ` +
                `${reload.stderr || reload.stdout}`,
            );
          }
        }

        if (g.enableLinger) {
          await runCmd("loginctl", ["enable-linger"]);
        }

        // `enable --now` only *starts* an inactive unit — it never restarts a
        // running one, so a changed unit would keep running the old ExecStart.
        // Enable always; then restart a changed+active unit, otherwise start it.
        if (changed) {
          const enable = await systemctl(["enable", input.unitName]);
          if (enable.code !== 0) {
            throw new Error(
              `systemctl --user enable ${input.unitName} failed ` +
                `(${enable.code}): ${enable.stderr || enable.stdout}`,
            );
          }
          const apply = await systemctl([
            wasActive ? "restart" : "start",
            input.unitName,
          ]);
          if (apply.code !== 0) {
            throw new Error(
              `systemctl --user ${wasActive ? "restart" : "start"} ` +
                `${input.unitName} failed (${apply.code}): ` +
                `${apply.stderr || apply.stdout}`,
            );
          }
        } else if (!wasActive) {
          const start = await systemctl(["start", input.unitName]);
          if (start.code !== 0) {
            throw new Error(
              `systemctl --user start ${input.unitName} failed ` +
                `(${start.code}): ${start.stderr || start.stdout}`,
            );
          }
        }

        const activeRes = await systemctl(["is-active", input.unitName]);
        const enabledRes = await systemctl(["is-enabled", input.unitName]);
        const labels = (input.labels ?? []).map(([k, v]) => `${k}=${v}`);
        const handle = await context.writeResource("worker", "worker", {
          unitName: input.unitName,
          unitPath,
          identity: g.identity,
          serveUrl: args.serveUrl,
          labels,
          changed,
          restarted: changed,
          enabled: enabledRes.stdout.trim() === "enabled",
          active: activeRes.stdout.trim() === "active",
          ensuredAt: new Date().toISOString(),
        });
        context.logger?.info(
          "Worker {unitName}: {verdict}",
          {
            unitName: input.unitName,
            verdict: changed
              ? `unit changed → enabled + restarted`
              : `already converged (no restart)`,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    status: {
      description:
        "Report live unit state and whether this identity's workers are " +
        "enrolled on the orchestrator.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: MethodContext,
      ) => {
        const g = context.globalArgs;
        const unitName = deriveUnitName(g.identity, g.unitName);
        const unitPath = unitPathFor(g);
        const exists = (await readTextSafe(unitPath)).length > 0;
        const activeRes = await systemctl(["is-active", unitName]);
        const enabledRes = await systemctl(["is-enabled", unitName]);
        const showRes = await systemctl([
          "show",
          unitName,
          "-p",
          "ActiveState",
        ]);

        const listRes = await runCmd(
          expandHome(g.swampBinPath),
          ["worker", "list", "--json", "--repo-dir", expandHome(g.repoDir)],
          expandHome(g.repoDir),
        );
        let enrolled = 0;
        const matching: string[] = [];
        try {
          const parsed = JSON.parse(listRes.stdout);
          const workers: Array<Record<string, unknown>> = parsed.workers ??
            parsed.items ?? [];
          enrolled = typeof parsed.count === "number"
            ? parsed.count
            : workers.length;
          for (const w of workers) {
            const labels = (w.labels ?? {}) as Record<string, string>;
            if (labels.serve === g.identity) {
              matching.push(String(w.name ?? w.id ?? "worker"));
            }
          }
        } catch {
          enrolled = 0;
        }

        const handle = await context.writeResource("status", "status", {
          unitName,
          unitPath,
          exists,
          state: showRes.stdout.trim() || activeRes.stdout.trim(),
          active: activeRes.stdout.trim() === "active",
          enabled: enabledRes.stdout.trim() === "enabled",
          enrolledWorkers: enrolled,
          matchingWorkers: matching,
          checkedAt: new Date().toISOString(),
        });
        context.logger?.info(
          "Worker {unitName}: {active} · {matching} of {enrolled} enrolled worker(s) are serve={identity}",
          {
            unitName,
            active: activeRes.stdout.trim() || "unknown",
            matching: matching.length,
            enrolled,
            identity: g.identity,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    remove: {
      description:
        "Completely decommission this identity's worker: revoke its enrollment " +
        "token on the orchestrator (so it can never re-enroll), then stop and " +
        "disable its unit and delete its namespaced artifacts (unit, token/env " +
        "files, cache dir). Foreign worker units are never touched.",
      arguments: RemoveArgsSchema,
      execute: async (
        args: z.infer<typeof RemoveArgsSchema>,
        context: MethodContext,
      ) => {
        const g = context.globalArgs;
        const unitName = deriveUnitName(g.identity, g.unitName);
        // Guard first, before any action, so a mis-pointed unit is never touched.
        assertOwnedUnit(unitName, g.identity, g.unitName);
        const unitPath = unitPathFor(g);
        const tokenName = (args.name ?? "").trim() ||
          defaultTokenName(g.identity);

        // Revoke first: once the token(s) are gone the worker cannot re-enroll, so
        // a restart between here and the unit deletion cannot resurrect it. Every
        // generation of this target is retired (`allGenerations`), so a worker that
        // was rotated before removal is not left with a live token. This is
        // best-effort because a token may already be revoked or expired, or the
        // repo may not be reachable from this host (revoke separately then).
        let revoked = 0;
        const revokedNames: string[] = [];
        if (args.revokeToken) {
          for (const name of await namesToRevoke(g, tokenName, true)) {
            try {
              const res = await revokeNamedToken(g, name);
              if (res.code === 0) revoked++;
            } catch (err) {
              context.logger?.warn?.(
                "could not revoke token {name}: {detail} — continuing removal",
                {
                  name,
                  detail: err instanceof Error ? err.message : String(err),
                },
              );
            }
            await Deno.remove(stagedTokenPath(g, name)).catch(() => {});
            revokedNames.push(name);
          }
        }

        const stop = await systemctl(["stop", unitName]);
        if (!isAlreadyStopped(stop)) {
          context.logger?.warn?.(
            "systemctl --user stop {unitName} reported {code}",
            { unitName, code: stop.code },
          );
        }
        await systemctl(["disable", unitName]);
        await Deno.remove(unitPath).catch(() => {});
        const reload = await systemctl(["daemon-reload"]);
        if (reload.code !== 0) {
          context.logger?.warn?.("daemon-reload after remove reported {code}", {
            code: reload.code,
          });
        }

        if (args.purgeData) {
          await Deno.remove(cacheDirFor(g), { recursive: true }).catch(
            () => {},
          );
          await Deno.remove(tokenFilePath(g)).catch(() => {});
          await Deno.remove(envFilePath(g)).catch(() => {});
        }

        const handle = await context.writeResource("status", "status", {
          unitName,
          unitPath,
          exists: false,
          state: "removed",
          active: false,
          enabled: false,
          enrolledWorkers: 0,
          matchingWorkers: [],
          checkedAt: new Date().toISOString(),
        });
        context.logger?.info(
          "Removed worker {unitName} (identity {identity}){revoked}{purge}",
          {
            unitName,
            identity: g.identity,
            revoked: args.revokeToken
              ? `, revoked ${revoked} of ${revokedNames.length} token(s): ${
                revokedNames.join(", ")
              }`
              : "",
            purge: args.purgeData ? " and its cache/token files" : "",
          },
        );
        return { dataHandles: [handle] };
      },
    },

    guidance: {
      description:
        "Print every global option with its current value, so a setting can " +
        "be changed without reading source.",
      arguments: z.object({}),
      execute: (
        _args: Record<string, never>,
        context: MethodContext,
      ) => {
        const g = context.globalArgs;
        context.logger?.info(
          [
            `identity       = ${g.identity}   (unit ${
              deriveUnitName(g.identity, g.unitName)
            })`,
            `swampBinPath   = ${expandHome(g.swampBinPath)}`,
            `unitDir        = ${expandHome(g.unitDir)}`,
            `configDir      = ${expandHome(g.configDir)}`,
            `cacheDirRoot   = ${expandHome(g.cacheDirRoot)}`,
            `stagingDir     = ${expandHome(g.stagingDir)}`,
            `tokenFile      = ${tokenFilePath(g)}`,
            `tokenName      = ${defaultTokenName(g.identity)}  (staged ${
              stagedTokenPath(g, defaultTokenName(g.identity))
            })`,
            `envFile        = ${envFilePath(g)}`,
            `swampHome      = ${expandHome(g.swampHome)}`,
            `swampConfigDir = ${expandHome(g.swampConfigDir)}`,
            `concurrency    = ${g.concurrency}`,
            `enableLinger   = ${g.enableLinger}`,
            `releaseBaseUrl = ${g.releaseBaseUrl}`,
            ``,
            `Change a value:  swamp model edit <name> --global-arg <key>=<value>`,
            `Run a method:    swamp model @svendowideit/swamp-worker method run <method> <name>`,
          ].join("\n"),
          {},
        );
        return Promise.resolve({ dataHandles: [] });
      },
    },
  },
};

/** Whether a path exists and is a regular file. */
async function fileIsExecutable(path: string): Promise<boolean> {
  try {
    const st = await Deno.stat(path);
    return st.isFile;
  } catch {
    return false;
  }
}

/** Whether a path exists (any kind). */
async function fileExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** The release asset arch for this machine (`swamp-linux-<arch>`). */
function swampArch(): string {
  return Deno.build.arch === "aarch64" ? "aarch64" : "x86_64";
}
