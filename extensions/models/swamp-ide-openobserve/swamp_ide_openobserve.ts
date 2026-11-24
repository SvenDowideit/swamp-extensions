/**
 * `@svendowideit/swamp-ide-openobserve` — the optional OpenObserve page for
 * `@svendowideit/swamp-ide`.
 *
 * It is deliberately separate from `@svendowideit/openobserve`: that extension
 * is a general SQL/streams client, while this one owns one artefact — the
 * "Swamp Agent IDE" dashboard. `swamp-ide` installs this only when an
 * OpenObserve instance is already installed and healthy.
 *
 * @module
 */
import { z } from "npm:zod@4";

/** The dashboard title this extension owns. */
export const DASHBOARD_TITLE = "Swamp Agent IDE";

const GlobalArgsSchema = z.object({
  baseUrl: z.string().default("http://127.0.0.1:5080").describe(
    "OpenObserve base URL (no trailing slash)",
  ),
  organization: z.string().default("default").describe(
    "Organization that owns the dashboard",
  ),
  vaultName: z.string().default("otel-openobserve-admin").describe(
    "Vault holding the OpenObserve login",
  ),
  emailKey: z.string().default("ZO_ROOT_USER_EMAIL").describe(
    "Vault key for the login email",
  ),
  authRef: z.string().default("ZO_ROOT_USER_PASSWORD").describe(
    "Vault key for the login password",
  ),
  authHeaderKey: z.string().default("").describe(
    "Vault key for a ready-made Authorization header (wins when set)",
  ),
  timeoutMs: z.number().int().positive().default(30000).describe(
    "Per-request timeout in milliseconds",
  ),
}).strict();

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const DashboardArgsSchema = z.object({
  title: z.string().default(DASHBOARD_TITLE).describe(
    "Dashboard title; the method creates it or updates the dashboard with this title",
  ),
  stream: z.string().default("default").describe(
    "Trace stream the panels query",
  ),
  folder: z.string().default("default").describe("Dashboard folder"),
  update: z.boolean().default(true).describe(
    "Update an existing dashboard with the same title instead of leaving it alone",
  ),
  uiBaseUrl: z.string().default("").describe(
    "Base URL for the returned UI link; empty uses baseUrl",
  ),
});

const StatusArgsSchema = z.object({
  title: z.string().default(DASHBOARD_TITLE).describe("Dashboard title"),
  folder: z.string().default("default").describe("Dashboard folder"),
});

const DashboardOutputSchema = z.object({
  title: z.string(),
  id: z.string(),
  folder: z.string(),
  action: z.enum(["created", "updated", "exists"]),
  url: z.string(),
  panelCount: z.number(),
  updatedAt: z.string(),
});

const StatusOutputSchema = z.object({
  title: z.string(),
  found: z.boolean(),
  id: z.string(),
  folder: z.string(),
  url: z.string(),
  checkedAt: z.string(),
});

/** The part of swamp's method context this extension uses. */
interface MethodContext {
  globalArgs: GlobalArgs;
  logger?: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warn: (msg: string, props?: Record<string, unknown>) => void;
  };
  writeResource: (
    spec: string,
    name: string,
    data: unknown,
  ) => Promise<{ name: string }>;
  vaultService?: {
    get(vault: string, key: string, reason?: string): Promise<string>;
  };
}

/** Normalize a base URL. */
export function normaliseBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Base64 a UTF-8 string. */
function base64Encode(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** The Basic Authorization header value. */
export function basicAuth(email: string, password: string): string {
  return `Basic ${base64Encode(`${email}:${password}`)}`;
}

/** One OpenObserve table panel for an already-aggregated SQL query. */
function tablePanel(
  id: string,
  title: string,
  sql: string,
  stream: string,
  yColumn: string,
  layout: { x: number; y: number; w: number; h: number; i: number },
): Record<string, unknown> {
  return {
    id,
    type: "table",
    title,
    description: "",
    queryType: "sql",
    queries: [{
      query: sql,
      customQuery: true,
      fields: {
        stream,
        stream_type: "traces",
        x: [],
        y: [{
          label: yColumn,
          alias: yColumn,
          column: yColumn,
          aggregationFunction: null,
          treatAsNonTimeseries: true,
        }],
        z: [],
        breakdown: [],
        filter: {
          filterType: "group",
          logicalOperator: "AND",
          conditions: [],
        },
      },
      config: {
        promql_legend: "",
        layer_type: "scatter",
        weight_fixed: 1,
        limit: 0,
        min: 0,
        max: 100,
      },
    }],
    config: {
      show_legends: true,
      legends_position: null,
      axis_border_show: false,
    },
    layout,
  };
}

/**
 * Build the dashboard that separates routed herdr-core/vim spans from bypassed
 * built-in tool calls. Pure, so the panel SQL and layout are unit-tested.
 */
export function buildAgentIdeDashboard(
  title: string,
  stream: string,
  folder: string,
): Record<string, unknown> {
  const services = "'swamp-herdr-core','swamp-vim','pi-swamp-ide'";
  const routed = "'swamp-herdr-core','swamp-vim'";
  const panels = [
    tablePanel(
      "swamp-route",
      "Routed vs bypassed",
      `SELECT route, COUNT(*) AS spans, ` +
        `SUM(CASE WHEN swamp_outcome = 'success' THEN 1 ELSE 0 END) AS ok, ` +
        `SUM(CASE WHEN swamp_outcome <> 'success' THEN 1 ELSE 0 END) AS errors ` +
        `FROM (SELECT CASE ` +
        `WHEN service_name IN (${routed}) THEN 'routed' ` +
        `WHEN operation_name LIKE 'bypass.%' THEN 'bypass' ` +
        `ELSE 'other' END AS route, swamp_outcome ` +
        `FROM "${stream}" WHERE service_name IN (${services})) ` +
        `GROUP BY route ORDER BY spans DESC`,
      stream,
      "spans",
      { x: 0, y: 0, w: 48, h: 10, i: 1 },
    ),
    tablePanel(
      "swamp-operations",
      "Operations by route",
      `SELECT service_name, operation_name, COUNT(*) AS spans, ` +
        `SUM(CASE WHEN swamp_outcome = 'success' THEN 1 ELSE 0 END) AS ok, ` +
        `SUM(CASE WHEN swamp_outcome <> 'success' THEN 1 ELSE 0 END) AS errors, ` +
        `AVG(duration) / 1000 AS avg_ms ` +
        `FROM "${stream}" WHERE service_name IN (${services}) ` +
        `GROUP BY service_name, operation_name ORDER BY spans DESC`,
      stream,
      "spans",
      { x: 48, y: 0, w: 48, h: 10, i: 2 },
    ),
    tablePanel(
      "swamp-bypass",
      "Recent bypassed tool calls",
      `SELECT _timestamp, service_name, operation_name, swamp_outcome, ` +
        `duration, status_message FROM "${stream}" ` +
        `WHERE operation_name LIKE 'bypass.%' ORDER BY _timestamp DESC LIMIT 100`,
      stream,
      "duration",
      { x: 0, y: 10, w: 96, h: 12, i: 3 },
    ),
    tablePanel(
      "swamp-routed",
      "Recent routed calls",
      `SELECT _timestamp, service_name, operation_name, swamp_outcome, ` +
        `duration, status_message FROM "${stream}" ` +
        `WHERE service_name IN (${routed}) ORDER BY _timestamp DESC LIMIT 100`,
      stream,
      "duration",
      { x: 0, y: 22, w: 96, h: 12, i: 4 },
    ),
    tablePanel(
      "swamp-errors",
      "Recent IDE errors",
      `SELECT _timestamp, service_name, operation_name, status_message ` +
        `FROM "${stream}" WHERE swamp_outcome <> 'success' ` +
        `AND service_name IN (${services}) ORDER BY _timestamp DESC LIMIT 100`,
      stream,
      "operation_name",
      { x: 0, y: 34, w: 96, h: 10, i: 5 },
    ),
    tablePanel(
      "swamp-shellouts",
      "Shell-out histogram",
      `SELECT operation_name, COUNT(*) AS calls, ` +
        `SUM(CASE WHEN swamp_outcome = 'success' THEN 1 ELSE 0 END) AS ok, ` +
        `SUM(CASE WHEN swamp_outcome <> 'success' THEN 1 ELSE 0 END) AS errors ` +
        `FROM "${stream}" WHERE service_name = 'pi-swamp-ide' ` +
        `AND (operation_name LIKE 'bypass.bash.%' OR operation_name LIKE 'tool.bash.%') ` +
        `GROUP BY operation_name ORDER BY calls DESC`,
      stream,
      "operation_name",
      { x: 0, y: 44, w: 96, h: 12, i: 6 },
    ),
  ];
  return {
    version: 8,
    title,
    description:
      "Swamp agent IDE routing: routed herdr-core/vim spans, bypassed built-in tool calls, and the shell-out histogram.",
    folder_id: folder,
    tabs: [{ tabId: "default", name: "Swamp IDE", panels }],
  };
}

/** The OpenObserve UI link for a dashboard. */
export function dashboardViewUrl(
  baseUrl: string,
  organization: string,
  id: string,
  folder: string,
): string {
  return `${normaliseBaseUrl(baseUrl)}/web/dashboards/view?` +
    `org_identifier=${encodeURIComponent(organization)}` +
    `&dashboard=${encodeURIComponent(id)}` +
    `&folder=${encodeURIComponent(folder)}`;
}

/** Read a vault secret, or "". */
async function readSecret(ctx: MethodContext, key: string): Promise<string> {
  if (!ctx.vaultService || !ctx.globalArgs.vaultName || !key) return "";
  try {
    return await ctx.vaultService.get(
      ctx.globalArgs.vaultName,
      key,
      "extension:@svendowideit/swamp-ide-openobserve",
    );
  } catch {
    return "";
  }
}

/** Resolve the Authorization header from the vault. */
async function resolveAuth(ctx: MethodContext): Promise<string> {
  const g = ctx.globalArgs;
  if (g.authHeaderKey) {
    const header = await readSecret(ctx, g.authHeaderKey);
    if (!header) {
      throw new Error(
        `vault '${g.vaultName}' has no secret '${g.authHeaderKey}'`,
      );
    }
    return header;
  }
  const email = await readSecret(ctx, g.emailKey);
  const password = await readSecret(ctx, g.authRef);
  if (!email || !password) {
    throw new Error(
      `could not read credentials from vault '${g.vaultName}': store ` +
        `${g.emailKey} and ${g.authRef}`,
    );
  }
  return basicAuth(email, password);
}

/** Send a JSON request. */
async function requestJson(
  ctx: MethodContext,
  method: "GET" | "POST" | "PUT",
  url: string,
  body?: unknown,
): Promise<{ status: number; body: unknown; text: string }> {
  const auth = await resolveAuth(ctx);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: auth,
        "Content-Type": "application/json",
        "User-Agent": "swamp-ide-openobserve/1.0",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(ctx.globalArgs.timeoutMs),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    return { status: res.status, body: parsed, text };
  } catch (error) {
    return {
      status: 0,
      body: null,
      text: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Truncate a response for an error message. */
function truncate(text: string, max = 300): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Find a dashboard by title. */
async function findDashboard(
  ctx: MethodContext,
  title: string,
  folder: string,
): Promise<Record<string, unknown> | null> {
  const g = ctx.globalArgs;
  const url =
    `${normaliseBaseUrl(g.baseUrl)}/api/${g.organization}/dashboards` +
    `?folder=${encodeURIComponent(folder)}`;
  const list = await requestJson(ctx, "GET", url);
  if (list.status !== 200) {
    throw new Error(
      `listing dashboards failed (HTTP ${list.status}): ${truncate(list.text)}`,
    );
  }
  const rows = Array.isArray(
      (list.body as Record<string, unknown>)?.dashboards,
    )
    ? ((list.body as Record<string, unknown>).dashboards as Array<
      Record<string, unknown>
    >)
    : [];
  return rows.find((row) =>
    String(row.title ?? "").toLowerCase() === title.toLowerCase()
  ) ?? null;
}

/** Create or update the Swamp Agent IDE dashboard. */
async function dashboard(
  args: z.infer<typeof DashboardArgsSchema>,
  ctx: MethodContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const g = ctx.globalArgs;
  const base = normaliseBaseUrl(g.baseUrl);
  const folder = args.folder || "default";
  const existing = await findDashboard(ctx, args.title, folder);
  const body = buildAgentIdeDashboard(args.title, args.stream, folder);
  let id = "";
  let action: "created" | "updated" | "exists" = "created";

  if (existing) {
    id = String(
      existing.dashboard_id ?? existing.dashboardId ?? existing.id ?? "",
    );
    if (!args.update) {
      action = "exists";
    } else {
      const getUrl = `${base}/api/${g.organization}/dashboards/${
        encodeURIComponent(id)
      }?folder=${encodeURIComponent(folder)}`;
      const current = await requestJson(ctx, "GET", getUrl);
      if (current.status !== 200) {
        throw new Error(
          `reading dashboard '${args.title}' failed (HTTP ${current.status}): ${
            truncate(current.text)
          }`,
        );
      }
      const hash = String(
        (current.body as Record<string, unknown>)?.hash ?? "",
      );
      const put = await requestJson(
        ctx,
        "PUT",
        `${getUrl}&hash=${encodeURIComponent(hash)}`,
        body,
      );
      if (put.status !== 200) {
        throw new Error(
          `updating dashboard '${args.title}' failed (HTTP ${put.status}): ${
            truncate(put.text)
          }`,
        );
      }
      id = String(
        (((put.body as Record<string, unknown>)?.v8 ??
          {}) as Record<string, unknown>).dashboardId ?? id,
      );
      action = "updated";
    }
  } else {
    const post = await requestJson(
      ctx,
      "POST",
      `${base}/api/${g.organization}/dashboards?folder=${
        encodeURIComponent(folder)
      }`,
      body,
    );
    if (post.status !== 200 && post.status !== 201) {
      throw new Error(
        `creating dashboard '${args.title}' failed (HTTP ${post.status}): ${
          truncate(post.text)
        }`,
      );
    }
    id = String(
      (((post.body as Record<string, unknown>)?.v8 ??
        {}) as Record<string, unknown>).dashboardId ?? "",
    );
  }
  if (!id) {
    throw new Error(`OpenObserve returned no dashboard id for '${args.title}'`);
  }
  const uiBase = args.uiBaseUrl || g.baseUrl;
  const url = dashboardViewUrl(uiBase, g.organization, id, folder);
  const tabs = Array.isArray(body.tabs) ? body.tabs : [];
  const firstTab = (tabs[0] ?? {}) as Record<string, unknown>;
  const panelCount = Array.isArray(firstTab.panels)
    ? firstTab.panels.length
    : 0;
  const handle = await ctx.writeResource("dashboard", "swamp-agent-ide", {
    title: args.title,
    id,
    folder,
    action,
    url,
    panelCount,
    updatedAt: new Date().toISOString(),
  });
  ctx.logger?.info("Dashboard '{title}' {action}: {url}", {
    title: args.title,
    action,
    url,
  });
  return { dataHandles: [handle] };
}

/** Report whether the dashboard exists. */
async function status(
  args: z.infer<typeof StatusArgsSchema>,
  ctx: MethodContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const g = ctx.globalArgs;
  const folder = args.folder || "default";
  const existing = await findDashboard(ctx, args.title, folder);
  const id = existing
    ? String(existing.dashboard_id ?? existing.dashboardId ?? existing.id ?? "")
    : "";
  const handle = await ctx.writeResource("status", "swamp-agent-ide", {
    title: args.title,
    found: Boolean(existing),
    id,
    folder,
    url: id ? dashboardViewUrl(g.baseUrl, g.organization, id, folder) : "",
    checkedAt: new Date().toISOString(),
  });
  return { dataHandles: [handle] };
}

/** The Swamp Agent IDE dashboard extension. */
export const model = {
  type: "@svendowideit/swamp-ide-openobserve",
  version: "2026.11.23.2",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.11.23.2",
      description:
        "Adds the shell-out histogram panel for per-program bash spans.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],

  resources: {
    dashboard: {
      description: "The Swamp Agent IDE dashboard created or updated",
      schema: DashboardOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    status: {
      description: "Whether the Swamp Agent IDE dashboard exists",
      schema: StatusOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },

  methods: {
    dashboard: {
      description:
        "Create or update the Swamp Agent IDE OpenObserve dashboard: routed " +
        "herdr-core/vim-controller spans, bypassed built-in tool calls, recent " +
        "examples and errors.",
      arguments: DashboardArgsSchema,
      execute: (
        args: z.infer<typeof DashboardArgsSchema>,
        ctx: MethodContext,
      ) => dashboard(args, ctx),
    },
    status: {
      description: "Report whether the Swamp Agent IDE dashboard exists.",
      arguments: StatusArgsSchema,
      execute: (
        args: z.infer<typeof StatusArgsSchema>,
        ctx: MethodContext,
      ) => status(args, ctx),
    },
  },
};
