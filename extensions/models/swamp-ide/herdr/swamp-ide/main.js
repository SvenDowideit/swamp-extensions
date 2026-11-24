// Swamp IDE: the right-hand panel. Two widgets share one header:
//   Activity   the live tool/model call list (same JSONL as swamp-activity)
//   Histogram  the bash programs/subcommands still bypassing the IDE
//
// The panel collapses to a 40px rail. It uses layout.resize on its own block id
// (passed as props.block), so the window really gives the space back.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import {
  home,
  nextCommand as nextModCommand,
  props,
  readTextFile,
  writeTextFile,
  run,
  setShared,
  shared,
  theme,
} from "herdr";

const EVENT_LOG = home() + "/.local/state/swamp-agent-ide/events.jsonl";
const SHELLOUT_LOG = home() + "/.local/state/swamp-agent-ide/shellouts.jsonl";
const ADDIN_HEARTBEAT = home() + "/.local/state/swamp-agent-ide/addin.json";
const GUARD_HEARTBEAT = home() + "/.local/state/swamp-agent-ide/guard.json";
const LEASE = home() + "/.local/state/swamp-agent-ide/lease.json";
const LIMIT = 80;
const POLL_MS = 1000;
const STALE_MS = 5 * 60 * 1000;
const EXPANDED_PX = 420;
const COLLAPSED_PX = 40;

function parse(line) {
  try {
    const value = JSON.parse(line);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function parseObject(text) {
  if (!text || !text.trim()) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function ago(ts) {
  const seconds = Math.max(0, (Date.now() - Date.parse(ts)) / 1000);
  if (!isFinite(seconds)) return "";
  if (seconds < 5) return "now";
  if (seconds < 60) return `${Math.floor(seconds)}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

function dur(ms) {
  if (ms == null || !isFinite(ms)) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function remaining(expiresAt, untilRevoked = false) {
  if (untilRevoked || String(expiresAt ?? "").startsWith("2099")) {
    return "until revoked";
  }
  const ms = Date.parse(String(expiresAt ?? "")) - Date.now();
  if (!isFinite(ms)) return "unknown";
  if (ms <= 0) return "expired";
  const seconds = Math.floor(ms / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

function short(value, n = 90) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > n ? `${text.slice(0, n)}…` : text;
}

function topEntries(map, limit = 8) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit);
}

function shelloutSummary(records) {
  const programs = new Map();
  const commands = new Map();
  const programCommands = new Map();
  const categories = new Map();
  let total = 0;
  let builtins = 0;

  for (const record of records) {
    if (record.kind !== "shellout" || !record.program) continue;
    total++;
    const category = record.category ?? "other";
    categories.set(category, (categories.get(category) ?? 0) + 1);
    if (record.builtin) {
      builtins++;
      continue;
    }
    programs.set(record.program, (programs.get(record.program) ?? 0) + 1);
    const command = record.subcommand
      ? `${record.program} ${record.subcommand}`
      : record.program;
    commands.set(command, (commands.get(command) ?? 0) + 1);
    const bucket = programCommands.get(record.program) ?? new Map();
    bucket.set(command, (bucket.get(command) ?? 0) + 1);
    programCommands.set(record.program, bucket);
  }

  return {
    total,
    builtins,
    categories: Object.fromEntries(categories),
    programs: topEntries(programs, 20),
    commands: topEntries(commands),
    programCommands: Object.fromEntries(
      [...programCommands.entries()].map(([program, map]) => [
        program,
        topEntries(map, 10),
      ]),
    ),
  };
}

function stop(element) {
  return element.on_mouse_down("left", (_event, cx) => cx.stop_propagation());
}

function barRow(t, label, count, max, color, index) {
  const width = Math.max(2, Math.round((180 * count) / Math.max(1, max)));
  return h_flex()
    .id(`swamp-ide-bar-${index}`)
    .gap(8)
    .items_center()
    .px(8)
    .py(4)
    .rounded(6)
    .bg(t.chrome)
    .child(
      div()
        .w(132)
        .truncate()
        .text_size(11)
        .text_color(t.foreground)
        .child(label),
    )
    .child(
      h_flex()
        .flex_1()
        .h(8)
        .rounded(4)
        .bg(t.raised)
        .child(div().h(8).rounded(4).bg(color).w(width)),
    )
    .child(
      div()
        .w(34)
        .text_size(10)
        .text_color(t.muted)
        .child(String(count)),
    );
}

export default class SwampIde extends View {
  init(_props, cx) {
    this.section = props()?.section || "";
    this.blockId = props()?.block || "swamp-ide";
    this.events = [];
    this.shellouts = [];
    this.addinHealth = null;
    this.guardHealth = null;
    this.lease = null;
    this.leaseError = "";
    this.hoverLease = "";
    this.selectedLease = "";
    this.hoverSuppressed = "";
    this.confirmLease = "";
    this.hoverProgram = "";
    this.selectedProgram = "";
    this.loading = true;
    this.error = "";
    this.filter = "all";
    this.tab = ["activity", "histogram", "leases"].includes(
        shared("swamp-ide.tab"),
      )
      ? shared("swamp-ide.tab")
      : "activity";
    this.collapsed = this.section
      ? false
      : shared("swamp-ide.collapsed") === true;
    if (this.collapsed && !this.section) {
      run("layout.resize", { id: this.blockId, px: COLLAPSED_PX });
    }
    cx.timer.every(POLL_MS, (cx) => this.refresh(cx));
    if (!this.section) {
      cx.spawn(async (cx) => {
        for (;;) {
          const command = await nextModCommand();
          if (command === "toggle") this.toggleCollapsed(cx);
          else if (command === "activity") this.selectTab("activity", cx);
          else if (command === "histogram") this.selectTab("histogram", cx);
          else if (command === "leases") this.selectTab("leases", cx);
        }
      });
    }
    this.refresh(cx);
  }

  refresh(cx) {
    cx.spawn(async (cx) => {
      try {
        const [eventsText, shelloutText, addinText, guardText, leaseText] = await Promise.all([
          readTextFile(EVENT_LOG).catch(() => ""),
          readTextFile(SHELLOUT_LOG).catch(() => ""),
          readTextFile(ADDIN_HEARTBEAT).catch(() => ""),
          readTextFile(GUARD_HEARTBEAT).catch(() => ""),
          readTextFile(LEASE).catch(() => ""),
        ]);

        const events = String(eventsText ?? "")
          .split(/\r?\n/)
          .filter(Boolean)
          .slice(-LIMIT * 4)
          .map(parse)
          .filter(Boolean);
        this.events = events.reverse().slice(0, LIMIT);

        this.shellouts = String(shelloutText ?? "")
          .split(/\r?\n/)
          .filter(Boolean)
          .slice(-5000)
          .map(parse)
          .filter(Boolean);

        this.addinHealth = parseObject(String(addinText ?? ""));
        this.guardHealth = parseObject(String(guardText ?? ""));
        this.lease = parseObject(String(leaseText ?? ""));
        this.leaseError = this.lease ? this.leaseError : "no active lease file";

        this.error = "";
      } catch (error) {
        this.events = [];
        this.shellouts = [];
        this.error = String(error?.message ?? error);
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  toggleCollapsed(cx) {
    this.collapsed = !this.collapsed;
    setShared("swamp-ide.collapsed", this.collapsed);
    try {
      run("layout.resize", {
        id: this.blockId,
        px: this.collapsed ? COLLAPSED_PX : EXPANDED_PX,
      });
    } catch {
      // The layout will still remember the state; the next click can expand.
    }
    cx.notify();
  }

  selectTab(tab, cx) {
    this.tab = tab;
    setShared("swamp-ide.tab", tab);
    cx.notify();
  }

  healthSummary() {
    const now = Date.now();
    const fresh = (health) =>
      Boolean(
        health && health.updatedAt &&
          now - Date.parse(health.updatedAt) < STALE_MS,
      );
    const addinFresh = fresh(this.addinHealth);
    const guardFresh = fresh(this.guardHealth) &&
      this.guardHealth?.enforced === true;
    const activeTools = Array.isArray(this.addinHealth?.activeTools)
      ? this.addinHealth.activeTools
      : [];
    const toolActive = activeTools.length === 1 &&
      activeTools[0] === "swamp_ide";
    const serveConnected = this.addinHealth?.serveConnected === true;
    const allActive = addinFresh && guardFresh && toolActive &&
      serveConnected;
    return {
      addinFresh,
      guardFresh,
      toolActive,
      serveConnected,
      allActive,
      label: !addinFresh
        ? "tracking off"
        : allActive
        ? "all active"
        : "degraded",
    };
  }

  renderHealth(t) {
    const health = this.healthSummary();
    const color = !health.addinFresh
      ? t.blocked
      : health.allActive
      ? t.working
      : t.ansi3;
    const parts = [
      `guard ${health.guardFresh ? "on" : "off"}`,
      `addin ${health.addinFresh ? "on" : "off"}`,
      `tool ${health.toolActive ? "active" : "inactive"}`,
      `serve ${health.serveConnected ? "connected" : "down"}`,
    ];
    const age = this.addinHealth?.updatedAt
      ? ago(this.addinHealth.updatedAt)
      : "never";

    return h_flex()
      .px(10)
      .py(5)
      .gap(6)
      .items_center()
      .border_b_1()
      .border_color(t.border)
      .child(div().w(7).h(7).rounded(4).flex_none().bg(color))
      .child(
        div().text_size(11).text_color(color).font_semibold().child(
          health.label,
        ),
      )
      .child(
        div().flex_1().truncate().text_size(10).text_color(t.muted).child(
          parts.join(" · "),
        ),
      )
      .child(div().text_size(10).text_color(t.dim).child(`heartbeat ${age}`));
  }

  renderRail(t, cx) {
    const routed = this.events.filter((event) =>
      event.route === "herdr-core" || event.route === "vim"
    ).length;
    const bypass = this.events.filter((event) =>
      event.route === "bypass"
    ).length;
    const errors = this.events.filter((event) =>
      event.outcome === "error"
    ).length;

    return v_flex()
      .id("root")
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .items_center()
      .py(8)
      .gap(8)
      .child(
        stop(
          div()
            .id("swamp-ide-expand")
            .w(26)
            .h(26)
            .items_center()
            .justify_center()
            .rounded(6)
            .bg(t.selected)
            .text_color(t.foreground)
            .text_size(14)
            .cursor_pointer()
            .hover((s) => s.bg(t.hover))
            .on_click((_event, cx) => this.toggleCollapsed(cx))
            .child("‹"),
        ),
      )
      .child(div().text_size(10).text_color(t.muted).child("SW"))
      .child(div().text_size(10).text_color(t.ansi2).child(String(routed)))
      .child(div().text_size(10).text_color(t.blocked).child(String(bypass)))
      .when(errors > 0, (el) =>
        el.child(
          div().text_size(10).text_color(t.blocked).child(`!${errors}`),
        ));
  }

  renderHeader(t, cx) {
    const routed = this.events.filter((event) =>
      event.route === "herdr-core" || event.route === "vim"
    ).length;
    const bypass = this.events.filter((event) =>
      event.route === "bypass"
    ).length;
    const errors = this.events.filter((event) =>
      event.outcome === "error"
    ).length;

    return h_flex()
      .h(34)
      .px(10)
      .flex_none()
      .items_center()
      .gap(6)
      .border_b_1()
      .border_color(t.border)
      .child(
        div()
          .flex_1()
          .font_semibold()
          .text_color(t.foreground)
          .child("Swamp IDE"),
      )
      .child(
        div()
          .px(5)
          .rounded(7)
          .bg(t.working)
          .text_color(t.background)
          .text_size(10)
          .child(`${routed} routed`),
      )
      .when(bypass > 0, (el) =>
        el.child(
          div()
            .px(5)
            .rounded(7)
            .bg(t.blocked)
            .text_color(t.background)
            .text_size(10)
            .child(`${bypass} bypass`),
        ))
      .when(errors > 0, (el) =>
        el.child(
          div()
            .px(5)
            .rounded(7)
            .bg(t.blocked)
            .text_color(t.background)
            .text_size(10)
            .child(`${errors} errors`),
        ))
      .child(
        stop(
          div()
            .id("swamp-ide-collapse")
            .px(6)
            .py(2)
            .rounded(4)
            .text_size(12)
            .text_color(t.muted)
            .cursor_pointer()
            .hover((s) => s.bg(t.hover))
            .on_click((_event, cx) => this.toggleCollapsed(cx))
            .child("›"),
        ),
      );
  }

  renderTabs(t, cx) {
    const tab = (id, label) =>
      stop(
        h_flex()
          .id(`swamp-ide-tab-${id}`)
          .h(22)
          .px(8)
          .items_center()
          .rounded(11)
          .text_size(11)
          .cursor_pointer()
          .border_1()
          .border_color(this.tab === id ? t.accent : t.border)
          .bg(this.tab === id ? t.selected : t.chrome)
          .text_color(this.tab === id ? t.foreground : t.muted)
          .hover((s) => s.bg(t.hover))
          .on_click((_event, cx) => this.selectTab(id, cx))
          .child(label),
      );

    return h_flex()
      .px(8)
      .py(6)
      .flex_none()
      .gap(5)
      .items_center()
      .child(tab("activity", "activity"))
      .child(tab("histogram", "histogram"))
      .child(tab("leases", "leases"));
  }

  renderActivity(t, cx) {
    const shown = this.events.filter((event) => {
      if (this.filter === "routed") {
        return event.route === "herdr-core" || event.route === "vim";
      }
      if (this.filter === "bypass") return event.route === "bypass";
      if (this.filter === "errors") return event.outcome === "error";
      return true;
    });

    const chip = (id, label, on, onClick) =>
      stop(
        h_flex()
          .id(`swamp-ide-filter-${id}`)
          .h(22)
          .px(8)
          .items_center()
          .rounded(11)
          .text_size(11)
          .cursor_pointer()
          .border_1()
          .border_color(on ? t.accent : t.border)
          .bg(on ? t.selected : t.chrome)
          .text_color(on ? t.foreground : t.muted)
          .hover((s) => s.bg(t.hover))
          .on_click(onClick)
          .child(label),
      );

    const row = (event, index) => {
      const route = event.route === "herdr-core" || event.route === "vim"
        ? event.route
        : event.route === "bypass" || event.route === "blocked"
        ? event.route
        : "other";
      const color = event.outcome === "error" || route === "blocked"
        ? t.blocked
        : route === "bypass"
        ? t.blocked
        : route === "other"
        ? t.muted
        : t.ansi2;
      const detail = event.command || event.target || event.detail || "";
      const name = event.method
        ? `${event.name} → ${event.method}`
        : event.name;

      return v_flex()
        .id(`swamp-ide-activity-${index}`)
        .px(8)
        .py(6)
        .gap(3)
        .rounded(6)
        .bg(t.chrome)
        .border_1()
        .border_color(t.chrome)
        .child(
          h_flex()
            .gap(6)
            .items_center()
            .child(div().w(7).h(7).rounded(4).flex_none().bg(color))
            .child(
              div()
                .flex_1()
                .truncate()
                .text_size(12)
                .text_color(t.foreground)
                .child(String(name ?? "?")),
            )
            .child(
              div()
                .flex_none()
                .text_size(10)
                .text_color(t.dim)
                .child(ago(event.ts)),
            ),
        )
        .child(
          div()
            .pl(13)
            .truncate()
            .text_size(11)
            .text_color(t.muted)
            .child(
              `${route}${
                event.outcome === "error" ? " · error" : ""
              }${event.durationMs != null ? ` · ${dur(event.durationMs)}` : ""}`,
            ),
        )
        .when(Boolean(detail), (el) =>
          el.child(
            div()
              .pl(13)
              .truncate()
              .text_size(11)
              .text_color(t.dim)
              .child(short(detail)),
          ));
    };

    const body = v_flex().gap(2);
    if (this.loading) {
      body.child(
        div()
          .py(20)
          .text_size(12)
          .text_color(t.muted)
          .child("Reading activity…"),
      );
    } else if (this.error) {
      body.child(
        div()
          .p(8)
          .rounded(6)
          .bg(t.raised)
          .text_size(11)
          .text_color(t.blocked)
          .child(`Cannot read ${EVENT_LOG}: ${this.error}`),
      );
    } else if (!this.healthSummary().addinFresh) {
      body.child(
        div()
          .p(8)
          .rounded(6)
          .bg(t.raised)
          .text_size(11)
          .text_color(t.blocked)
          .child(
            "pi addin is not running; tracking is off. This list is stale, not empty.",
          ),
      );
    } else if (!shown.length) {
      body.child(
        div()
          .py(24)
          .text_size(12)
          .text_color(t.muted)
          .child("No activity yet. Run a tool or a swamp method."),
      );
    }
    body.children(shown.map(row));

    return v_flex()
      .gap(4)
      .child(
        h_flex()
          .px(8)
          .py(6)
          .flex_none()
          .gap(5)
          .items_center()
          .child(
            chip("all", "all", this.filter === "all", (_event, cx) => {
              this.filter = "all";
              cx.notify();
            }),
          )
          .child(
            chip("routed", "routed", this.filter === "routed", (_event, cx) => {
              this.filter = "routed";
              cx.notify();
            }),
          )
          .child(
            chip("bypass", "bypass", this.filter === "bypass", (_event, cx) => {
              this.filter = "bypass";
              cx.notify();
            }),
          )
          .child(
            chip("errors", "errors", this.filter === "errors", (_event, cx) => {
              this.filter = "errors";
              cx.notify();
            }),
          ),
      )
      .child(body);
  }

  renderHistogram(t) {
    const summary = shelloutSummary(this.shellouts);

    if (!this.healthSummary().addinFresh) {
      return v_flex().p(8).child(
        div()
          .py(20)
          .text_size(12)
          .text_color(t.blocked)
          .child(
            "pi addin is not running; the histogram is stale, not empty.",
          ),
      );
    }

    if (!summary.total) {
      return v_flex().p(8).child(
        div()
          .py(20)
          .text_size(12)
          .text_color(t.muted)
          .child("No shell-outs recorded yet."),
      );
    }

    const bypass = summary.categories.bypass ?? 0;
    const other = summary.categories.other ?? 0;
    const routed = summary.categories.routed ?? 0;
    const body = v_flex().gap(6);

    body.child(
      div()
        .px(8)
        .text_size(10)
        .text_color(t.muted)
        .child(
          `shell-outs ${summary.total} · routed ${routed} · bypass ${bypass} · other ${other} · builtins ${summary.builtins}`,
        ),
    );

    body.child(
      div()
        .px(8)
        .pt(4)
        .text_size(10)
        .text_color(t.dim)
        .child("PROGRAMS"),
    );

    const programRow = (name, count, index) => {
      const detail = this.hoverProgram === name ||
        this.selectedProgram === name;
      const commands = summary.programCommands?.[name] ?? [];
      return v_flex()
        .id(`swamp-ide-program-${index}`)
        .px(8)
        .py(5)
        .gap(2)
        .rounded(6)
        .bg(t.chrome)
        .border_1()
        .border_color(detail ? t.accent : t.chrome)
        .on_mouse_down("left", (_event, cx) => {
          cx.stop_propagation();
          this.selectedProgram = name;
          cx.notify();
        })
        .on_hover((hovered, cx) => {
          if (hovered) this.hoverProgram = name;
          else if (this.hoverProgram === name) this.hoverProgram = "";
          cx.notify();
        })
        .child(
          h_flex().gap(8).items_center()
            .child(
              div().flex_1().truncate().text_size(12).text_color(t.foreground)
                .child(name),
            )
            .child(div().text_size(11).text_color(t.muted).child(`×${count}`)),
        )
        .when(detail, (el) =>
          el.child(
            v_flex().gap(2).pl(10)
              .child(
                div().text_size(10).text_color(t.dim).child("TOP COMMANDS"),
              )
              .children(
                commands.length
                  ? commands.map(([command, count]) =>
                    div().text_size(10).text_color(t.muted).child(
                      `${command} ×${count}`,
                    )
                  )
                  : [div().text_size(10).text_color(t.dim).child("no subcommands")],
              ),
          ));
    };

    body.children(
      summary.programs.map(([name, count], index) =>
        programRow(name, count, index)
      ),
    );

    return body;
  }

  legacyPurpose(name) {
    if (name === "swamp-ide-dialog") {
      return "Edit the Swamp IDE panel, approval dialog, addin and policy source";
    }
    return "";
  }

  scopePurpose(scope) {
    if (scope.startsWith("protected:")) return "Edit one protected file";
    if (scope.startsWith("file:")) return "Edit one file";
    if (scope.startsWith("dir:")) return "Edit files in one directory";
    if (scope.startsWith("exec:")) return "Run one exact command";
    if (scope.startsWith("run:")) return "Run one exact command";
    if (scope.startsWith("swamp:")) return "Run one swamp model method";
    if (["file-edit", "file-write", "file-edit-lines"].includes(scope)) {
      return "Edit any file (broad method grant)";
    }
    return "";
  }

  scopeRisk(scope) {
    if (scope.startsWith("swamp:")) return "MEDIUM";
    if (
      scope.startsWith("protected:") ||
      scope.startsWith("file:") ||
      scope.startsWith("dir:") ||
      scope.startsWith("exec:") ||
      scope.startsWith("run:") ||
      ["file-edit", "file-write", "file-edit-lines"].includes(scope)
    ) return "HIGH";
    return "";
  }

  scopeTarget(scope) {
    if (scope.startsWith("protected:")) return scope.slice("protected:".length);
    if (scope.startsWith("file:")) return scope.slice("file:".length);
    if (scope.startsWith("dir:")) return `Directory ${scope.slice("dir:".length)}`;
    if (["file-edit", "file-write", "file-edit-lines"].includes(scope)) {
      return "NO specific file — any file (broad method grant)";
    }
    if (scope.startsWith("exec:")) return `Exact command ${scope.slice("exec:".length)}`;
    if (scope.startsWith("run:")) return `Exact command ${scope.slice("run:".length)}`;
    if (scope.startsWith("swamp:")) return scope.slice("swamp:".length);
    return scope;
  }

  leaseRows() {
    const lease = this.lease;
    if (!lease) return [];
    const rows = [];
    const covered = new Set();
    const now = Date.now();
    const features = lease.features ?? {};
    for (const [name, feature] of Object.entries(features)) {
      const scopes = Array.isArray(feature.scopes) ? feature.scopes : [];
      const until = feature.untilRevoked === true ||
        String(feature.expiresAt ?? "").startsWith("2099");
      const expiresAt = feature.expiresAt ?? "";
      if (!until && Date.parse(expiresAt) <= now) continue;
      for (const scope of scopes) covered.add(scope);
      rows.push({
        key: `feature:${name}`,
        kind: "feature",
        label: feature.purpose || this.legacyPurpose(name) || name,
        featureName: name,
        scopes,
        expiresAt,
        until,
        purpose: feature.purpose || this.legacyPurpose(name),
        risk: feature.risk || "",
      });
    }
    for (const scope of lease.scopes ?? []) {
      if (covered.has(scope)) continue;
      const expiresAt = lease.scopeExpiry?.[scope] ?? lease.expiresAt ?? "";
      const until = String(expiresAt).startsWith("2099");
      if (!until && Date.parse(expiresAt) <= now) continue;
      rows.push({
        key: `scope:${scope}`,
        kind: "scope",
        label: this.scopeTarget(scope),
        scopeValue: scope,
        scopes: [scope],
        expiresAt,
        until,
        purpose: lease.purposes?.[scope]?.purpose ?? this.scopePurpose(scope),
        risk: lease.purposes?.[scope]?.risk ?? this.scopeRisk(scope),
      });
    }
    return rows;
  }

  leaseButton(t, id, label, onClick, dangerous = false) {
    return stop(
      div()
        .id(id)
        .px(6)
        .py(2)
        .rounded(4)
        .bg(t.raised)
        .text_size(10)
        .text_color(dangerous ? t.blocked : t.muted)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_click((_event, cx) => {
          cx.stop_propagation();
          onClick(cx);
        })
        .child(label),
    );
  }

  async writeLease(lease, cx) {
    lease.updatedAt = new Date().toISOString();
    lease.updatedBy = "swamp-ide-panel";
    this.leaseError = "";
    try {
      const currentText = await readTextFile(LEASE).catch(() => null);
      await writeTextFile(
        LEASE,
        `${JSON.stringify(lease, null, 2)}\n`,
        currentText,
      );
      this.lease = lease;
      return true;
    } catch (error) {
      this.leaseError = `lease write failed: ${String(error?.message ?? error)}`;
      return false;
    } finally {
      cx.notify();
    }
  }

  async updateLease(cx, mutate) {
    let lastError = null;
    for (let attempt = 0; attempt < 8; attempt++) {
      const currentText = await readTextFile(LEASE).catch(() => null);
      const current = parseObject(currentText) ?? {};
      const next = mutate(JSON.parse(JSON.stringify(current)));
      try {
        await writeTextFile(
          LEASE,
          `${JSON.stringify(next, null, 2)}\n`,
          currentText,
        );
        this.lease = next;
        this.leaseError = "";
        return true;
      } catch (error) {
        lastError = error;
      }
    }
    this.leaseError = `lease write failed: ${String(lastError?.message ?? lastError)}`;
    return false;
  }

  async extendLease(row, milliseconds, cx) {
    if (!this.lease || row.until) return;
    const ok = await this.updateLease(cx, (lease) => {
      const now = Date.now();
      const current = row.kind === "feature"
        ? lease.features?.[row.featureName ?? row.label]?.expiresAt ?? lease.expiresAt
        : lease.scopeExpiry?.[row.scopeValue ?? row.label] ?? lease.expiresAt;
      const base = Math.max(now, Date.parse(String(current ?? "")) || 0);
      const next = new Date(base + milliseconds).toISOString();
      lease.scopeExpiry = lease.scopeExpiry ?? {};
      if (row.kind === "feature") {
        const feature = lease.features?.[row.featureName ?? row.label];
        if (feature) {
          feature.untilRevoked = false;
          feature.expiresAt = next;
          for (const scope of row.scopes) lease.scopeExpiry[scope] = next;
        }
      } else {
        lease.scopeExpiry[row.scopeValue ?? row.label] = next;
      }
      return lease;
    });
    if (ok) this.confirmLease = "";
    cx.notify();
  }

  async revokeLease(row, cx) {
    const ok = await this.updateLease(cx, (lease) => {
      const scopes = new Set(lease.scopes ?? []);
      if (row.kind === "feature") {
        if (lease.features) delete lease.features[row.featureName ?? row.label];
        const covered = new Set();
        for (const feature of Object.values(lease.features ?? {})) {
          for (const scope of feature.scopes ?? []) covered.add(scope);
        }
        for (const scope of row.scopes) {
          if (covered.has(scope)) continue;
          scopes.delete(scope);
          if (lease.scopeExpiry) delete lease.scopeExpiry[scope];
        }
      } else {
        scopes.delete(row.scopeValue ?? row.label);
        if (lease.scopeExpiry) delete lease.scopeExpiry[row.scopeValue ?? row.label];
      }
      lease.scopes = [...scopes];
      return lease;
    });
    if (ok) {
      this.selectedLease = "";
      this.hoverLease = "";
      this.confirmLease = "";
    }
    cx.notify();
  }

  requestRevoke(row, cx) {
    if (this.confirmLease === row.key) {
      this.confirmLease = "";
      void this.revokeLease(row, cx);
    } else {
      this.confirmLease = row.key;
      cx.notify();
    }
  }

  renderLeases(t, cx) {
    const rows = this.leaseRows();
    const body = v_flex().gap(4);
    body.child(
      div().h(14).px(8).text_size(10).text_color(t.blocked).child(
        this.leaseError,
      ),
    );
    if (!rows.length) {
      body.child(
        div().py(24).text_size(12).text_color(t.muted).child(
          "No active leases.",
        ),
      );
    }
    body.children(rows.map((row, index) => {
      const detail = this.hoverLease === row.key ||
        this.selectedLease === row.key;
      const color = row.kind === "feature" ? t.working : t.ansi2;
      const actions = h_flex().pt(3).gap(4)
        .when(!row.until, (el) =>
          el
            .child(
              this.leaseButton(
                t,
                `swamp-ide-lease-${index}-5m`,
                "+5m",
                (inner) => {
                  void this.extendLease(row, 5 * 60 * 1000, inner);
                },
              ),
            )
            .child(
              this.leaseButton(
                t,
                `swamp-ide-lease-${index}-30m`,
                "+30m",
                (inner) => {
                  void this.extendLease(row, 30 * 60 * 1000, inner);
                },
              ),
            )
            .child(
              this.leaseButton(
                t,
                `swamp-ide-lease-${index}-1h`,
                "+1h",
                (inner) => {
                  void this.extendLease(row, 60 * 60 * 1000, inner);
                },
              ),
            ))
        .child(
          this.leaseButton(
            t,
            `swamp-ide-lease-${index}-revoke`,
            this.confirmLease === row.key ? "confirm revoke" : "revoke",
            (inner) => this.requestRevoke(row, inner),
            true,
          ),
        );
      return v_flex()
        .id(`swamp-ide-lease-${index}`)
        .px(8)
        .py(6)
        .gap(3)
        .rounded(6)
        .bg(t.chrome)
        .border_1()
        .border_color(detail ? t.accent : t.chrome)
        .on_mouse_down("left", (_event, cx) => {
          cx.stop_propagation();
          if (this.selectedLease === row.key) {
            this.selectedLease = "";
            this.hoverLease = "";
            this.hoverSuppressed = row.key;
            this.confirmLease = "";
          } else {
            this.selectedLease = row.key;
            this.confirmLease = "";
          }
          cx.notify();
        })
        .on_hover((hovered, cx) => {
          if (hovered) {
            if (this.hoverSuppressed !== row.key) this.hoverLease = row.key;
          } else {
            if (this.hoverLease === row.key) this.hoverLease = "";
            if (this.hoverSuppressed === row.key) this.hoverSuppressed = "";
          }
          cx.notify();
        })
        .child(
          h_flex().gap(6).items_center()
            .child(div().w(7).h(7).rounded(4).flex_none().bg(color))
            .child(
              row.kind === "feature"
                ? div()
                  .flex_1()
                  .min_w(0)
                  .text_size(12)
                  .text_color(t.foreground)
                  .whitespace_normal()
                  .child(row.label)
                : div()
                  .flex_1()
                  .truncate()
                  .text_size(12)
                  .text_color(t.foreground)
                  .child(short(row.label, 60)),
            )
            .child(
              div().text_size(10).text_color(t.muted).child(
                remaining(row.expiresAt, row.until),
              ),
            ),
        )
        .when(row.kind === "feature" && row.scopes.length > 0, (el) =>
          el.child(
            div().pl(13).truncate().text_size(10).text_color(t.muted).child(
              `${row.scopes.length} target(s): ${row.scopes.slice(0, 2).map((scope) => this.scopeTarget(scope)).join(", ")}${row.scopes.length > 2 ? " …" : ""}`,
            ),
          ))
        .when(detail, (el) =>
          el.child(
            div().pl(13).text_size(10).text_color(t.dim).child(
              `expires: ${row.until ? "until revoked" : row.expiresAt}`,
            ),
          ).child(div().pl(13).child(actions)).child(
            v_flex().gap(3).max_h(170).min_h(0).overflow_y_scrollbar().mode("always")
              .when(Boolean(row.purpose), (inner) =>
                inner.child(
                  v_flex().gap(1).pl(13)
                    .child(div().text_size(10).text_color(t.dim).child("PURPOSE"))
                    .child(div().text_size(11).text_color(t.foreground).whitespace_normal().child(row.purpose)),
                ))
              .when(Boolean(row.risk), (inner) =>
                inner.child(div().pl(13).text_size(10).text_color(t.dim).child(`RISK ${row.risk}`)))
              .child(div().pl(13).text_size(10).text_color(t.dim).child("SCOPES"))
              .children(row.scopes.slice(0, 40).map((scope) =>
                div().pl(13).truncate().text_size(10).text_color(t.muted).child(this.scopeTarget(scope))
              ))
              .when(row.scopes.length > 40, (inner) =>
                inner.child(div().pl(13).text_size(10).text_color(t.dim).child(`+${row.scopes.length - 40} more`)))
          ));
    }));

    return v_flex().gap(4)
      .child(
        div().px(8).py(6).text_size(10).text_color(t.muted).child(
          `${rows.length} active lease(s)`,
        ),
      )
      .child(body);
  }

  renderSection(section, cx) {
    const t = theme();
    const health = this.healthSummary();
    const color = !health.addinFresh
      ? t.blocked
      : health.allActive
      ? t.working
      : t.ansi3;
    const routed = this.events.filter((event) =>
      event.route === "herdr-core" || event.route === "vim"
    ).length;
    const bypass = this.events.filter((event) =>
      event.route === "bypass"
    ).length;
    const leases = this.leaseRows().length;
    const histogram = shelloutSummary(this.shellouts).total;
    const title = section === "activity"
      ? "Activity"
      : section === "histogram"
      ? "Command histogram"
      : "Leases";
    const summary = section === "activity"
      ? `${routed} routed · ${bypass} bypass`
      : section === "histogram"
      ? `${histogram} shell-outs`
      : `${leases} active`;
    const body = section === "activity"
      ? this.renderActivity(t, cx)
      : section === "histogram"
      ? this.renderHistogram(t)
      : this.renderLeases(t, cx);

    return v_flex()
      .id(`swamp-ide-section-${section}`)
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .text_size(13)
      .child(
        h_flex()
          .h(30)
          .px(10)
          .flex_none()
          .items_center()
          .gap(6)
          .border_b_1()
          .border_color(t.border)
          .child(
            div().flex_1().font_semibold().text_color(t.foreground).child(
              title,
            ),
          )
          .child(div().text_size(10).text_color(t.muted).child(summary))
          .child(div().w(7).h(7).rounded(4).flex_none().bg(color))
          .child(div().text_size(10).text_color(color).child(health.label)),
      )
      .child(
        div()
          .flex_1()
          .min_h(0)
          .overflow_y_scrollbar()
          .mode("always")
          .px(6)
          .pb(6)
          .child(body),
      );
  }

  render(cx) {
    if (this.section) return this.renderSection(this.section, cx);
    const t = theme();
    if (this.collapsed) return this.renderRail(t, cx);

    return v_flex()
      .id("root")
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .text_size(13)
      .child(this.renderHeader(t, cx))
      .child(this.renderHealth(t))
      .child(this.renderTabs(t, cx))
      .child(
        div()
          .id("swamp-ide-scroll")
          .flex_1()
          .min_h(0)
          .overflow_y_scrollbar()
          .px(6)
          .pb(8)
          .child(
            this.tab === "activity"
              ? this.renderActivity(t, cx)
              : this.tab === "histogram"
              ? this.renderHistogram(t)
              : this.renderLeases(t, cx),
          ),
      );
  }
}
