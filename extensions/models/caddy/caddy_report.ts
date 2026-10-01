/**
 * Report extension for @svendowideit/caddy — prints the `audit` and `plan`
 * results as a human-readable table right after the method runs, so one command
 * tells the user what every model wants, what the extension merged, and how that
 * compares to the live Caddy.
 *
 * @module
 */
type DataHandle = {
  name: string;
  specName: string;
  kind: string;
  version?: number;
};

type MethodReportContext = {
  scope: "method";
  modelType: string;
  modelId: string;
  methodName: string;
  executionStatus: "succeeded" | "failed";
  errorMessage?: string;
  dataHandles: DataHandle[];
  dataRepository: {
    getContent: (
      type: string,
      modelId: string,
      dataName: string,
      version?: number,
    ) => Promise<Uint8Array | null>;
  };
  logger: { info: (msg: string, props?: Record<string, unknown>) => void };
};

type RouteRow = {
  hostname: string;
  kind: string;
  upstream: string;
  root: string;
  model: string;
};

type UnmergedModel = {
  model: string;
  routes: Array<{
    hostname: string;
    kind: string;
    upstream: string;
    root: string;
  }>;
  tlsSubjects: string[];
  statusPage: boolean;
};

type TlsView = {
  desired: Array<{
    model: string;
    email: string;
    dnsProvider: string;
    subjects: string[];
    providerConfigFields: string[];
  }>;
  desiredSubjects: string[];
  liveSubjects: string[];
  liveHasDnsChallenge: boolean;
  liveDnsProvider: string;
  issuedDomains: string[];
  subjectsWithoutCert: string[];
  statusPageHostnames: string[];
  pluginsWanted: string[];
  pluginsCompiled: string[];
  pluginsMissing: string[];
  environmentFile: string;
  environmentFileExists: boolean;
  environmentFileKeys: string[];
  inSync: boolean;
};

type CaddyView = {
  target: string;
  adminApiAddr: string;
  serviceName: string;
  models: string[];
  unmerged?: UnmergedModel[];
  runModel?: string;
  nextCommands?: string;
  tls?: TlsView;
  conflicts: string[];
  desiredRoutes: RouteRow[];
  actualSwampRoutes: Array<{ id: string; hostnames: string[] }>;
  foreignRoutes: string[];
  onlyDesired: string[];
  onlyActual: string[];
  inSync: boolean;
  reachable: boolean;
  error: string;
};

type AuditOutput = { cadies: CaddyView[]; modelCount: number; inSync: boolean };

/** Report definition: render caddy audit/plan results as a human table. */
export const report = {
  name: "@svendowideit/caddy-status",
  description:
    "Human-readable summary of which models manage each Caddy and whether the running config matches",
  scope: "method",
  labels: ["caddy", "summary"],
  execute: async (
    context: MethodReportContext,
  ): Promise<{ markdown: string; json: Record<string, unknown> }> => {
    if (
      context.executionStatus === "failed" ||
      (context.methodName !== "audit" && context.methodName !== "plan")
    ) {
      return { markdown: "", json: {} };
    }
    const handle = context.dataHandles.find(
      (h) => h.specName === context.methodName,
    );
    if (!handle) {
      return { markdown: "No caddy status data produced.", json: {} };
    }

    const raw = await context.dataRepository.getContent(
      context.modelType,
      context.modelId,
      handle.name,
      handle.version,
    );
    if (!raw) return { markdown: "Caddy status data not found.", json: {} };

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      return { markdown: "Caddy status data could not be parsed.", json: {} };
    }

    const cadies: CaddyView[] = Array.isArray(data.cadies)
      ? data.cadies as CaddyView[]
      : [data as unknown as CaddyView];
    return { markdown: formatCadies(cadies), json: { cadies } };
  },
};

/** Render one or more caddy views as markdown. */
function formatCadies(cadies: CaddyView[]): string {
  const lines: string[] = [];
  lines.push("# Caddy status");
  lines.push("");
  for (const c of cadies) {
    const flag = !c.reachable
      ? "⚠ unreachable"
      : c.inSync
      ? "✓ in sync"
      : "✗ DRIFT";
    lines.push(`## ${c.target.replace("\u0000", " · ")} — ${flag}`);
    lines.push("");
    lines.push(
      `- Models: ${c.models.map((m) => `\`${m}\``).join(", ") || "—"}`,
    );
    lines.push(`- Admin API: ${c.reachable ? c.adminApiAddr : "unreachable"}`);
    if (c.conflicts.length > 0) {
      lines.push(`- **Conflicts:** ${c.conflicts.join("; ")}`);
    }
    if (!c.reachable && c.error) {
      lines.push(`- Error: ${c.error}`);
    }
    lines.push("");
    lines.push("| URL (route) | Kind | Target | Wanted by |");
    lines.push("| ----------- | ---- | ------ | --------- |");
    if (c.desiredRoutes.length === 0) {
      lines.push("| _(no routes desired)_ | | | |");
    }
    for (const r of c.desiredRoutes) {
      const to = r.kind === "file_server" ? `files: ${r.root}` : r.upstream;
      lines.push(`| ${r.hostname} | ${r.kind} | ${to} | \`${r.model}\` |`);
    }
    // TLS / DNS / plugin layer — this is what makes a wildcard/DNS-01 setup
    // (e.g. the Gandi libdns driver + bearer token) visible.
    if (c.tls) {
      const t = c.tls;
      lines.push("");
      lines.push("TLS / DNS:");
      lines.push("");
      if (t.desired.length === 0) {
        const setup = t.pluginsWanted.length > 0 || t.environmentFile
          ? " — the DNS driver and env file are set up, so run `configureTls` next"
          : "";
        lines.push(
          `- Desired: none (no \`configureTls\` recorded by any model)${setup}`,
        );
      } else {
        for (const d of t.desired) {
          lines.push(
            `- Desired (by \`${d.model}\`): provider \`${
              d.dnsProvider || "none"
            }\`, ` +
              `email \`${d.email}\`, subjects ${
                d.subjects.map((s) => `\`${s}\``).join(", ") || "—"
              }${
                d.providerConfigFields.length
                  ? `, creds ${d.providerConfigFields.join("+")}`
                  : ""
              }`,
          );
        }
      }
      lines.push(
        `- Live config: ${
          t.liveSubjects.length
            ? t.liveSubjects.map((s) => `\`${s}\``).join(", ")
            : "no TLS automation in the running config"
        }${
          t.liveHasDnsChallenge ? ` (DNS-01 via \`${t.liveDnsProvider}\`)` : ""
        }`,
      );
      if (t.desiredSubjects.length > 0) {
        // Issued certificates are the proof the DNS-01 challenge actually
        // worked — "live config" alone does not mean a cert exists.
        const issued = t.desiredSubjects.filter((s) =>
          t.issuedDomains.includes(s)
        );
        lines.push(
          `- Certificates issued: ${
            issued.length
              ? issued.map((s) => `\`${s}\``).join(", ")
              : "NONE yet"
          }${
            t.subjectsWithoutCert.length
              ? ` — still pending: ${
                t.subjectsWithoutCert.map((s) => `\`${s}\``).join(", ")
              }`
              : ""
          }`,
        );
      }
      if (t.pluginsWanted.length > 0) {
        lines.push(
          `- Plugins wanted: ${t.pluginsWanted.join(", ")} — ` +
            (t.pluginsMissing.length === 0
              ? "all compiled in"
              : `MISSING: ${
                t.pluginsMissing.join(", ")
              } (re-run installCaddy)`),
        );
      }
      if (t.environmentFile) {
        lines.push(
          `- Env file: \`${t.environmentFile}\` — ` +
            (t.environmentFileExists
              ? `present, keys: ${t.environmentFileKeys.join(", ") || "(none)"}`
              : "MISSING (create it, then createService + restartService)"),
        );
      }
      if (t.statusPageHostnames.length > 0) {
        lines.push(
          `- Status page also answers on: ${
            t.statusPageHostnames.map((s) => `\`${s}\``).join(", ")
          }`,
        );
      }
      lines.push(
        t.desired.length === 0
          ? "- TLS in sync: n/a (nothing desired yet)"
          : `- TLS in sync: ${
            t.inSync
              ? "✓"
              : "✗ (desired subjects/provider not live, or certificate not issued yet)"
          }`,
      );
    }

    if (c.unmerged && c.unmerged.length > 0) {
      lines.push("");
      lines.push("Unmerged — each model's own desired state:");
      lines.push("");
      lines.push("| Model | Routes | TLS subjects | Status page |");
      lines.push("| ----- | ------ | ------------ | ----------- |");
      for (const u of c.unmerged) {
        const routes = u.routes.length > 0
          ? u.routes.map((r) => `${r.hostname}→${r.upstream || r.root}`).join(
            ", ",
          )
          : "—";
        const tls = u.tlsSubjects.length > 0 ? u.tlsSubjects.join(", ") : "—";
        lines.push(
          `| \`${u.model}\` | ${routes} | ${tls} | ${
            u.statusPage ? "yes" : "—"
          } |`,
        );
      }
    }
    if (c.foreignRoutes.length > 0) {
      lines.push("");
      lines.push(
        `- Hand-added (untouched by swamp): ${
          c.foreignRoutes.map((h) => `\`${h}\``).join(", ")
        }`,
      );
    }
    if (c.onlyDesired.length > 0) {
      lines.push(
        `- **Wanted but not live:** ${
          c.onlyDesired.map((h) => `\`${h}\``).join(", ")
        }`,
      );
    }
    if (c.onlyActual.length > 0) {
      lines.push(
        `- **Live but not wanted:** ${
          c.onlyActual.map((h) => `\`${h}\``).join(", ")
        }`,
      );
    }
    lines.push("");
  }
  // The next commands to inspect unmerged, merged, and actual — so the user
  // never has to guess or look elsewhere.
  const next = cadies.find((c) => c.nextCommands)?.nextCommands;
  if (next) {
    lines.push("## Next commands");
    lines.push("");
    lines.push("```sh");
    lines.push(next);
    lines.push("```");
    lines.push("");
  } else {
    lines.push(
      "_Compare with the live config: `curl -s <adminApiAddr>/config/ | jq`._",
    );
    lines.push("");
  }
  return lines.join("\n");
}
