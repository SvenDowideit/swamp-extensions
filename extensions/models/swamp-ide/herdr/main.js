// Swamp activity: the live list of every agent tool call and swarm extension
// method, newest first. Read-only. Routed operations (herdr-core / vim) are
// green; bypassed built-in tools (read/write/edit/grep/bash) are red.
//
// Source: the JSONL event log written by .pi/extensions/swamp-ide.ts and by
// @svendowideit/herdr-core / @svendowideit/vim. Polls a file, not swamp.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { home, readTextFile, theme } from "herdr";

const LOG = home() + "/.local/state/swamp-agent-ide/events.jsonl";
const LIMIT = 80;
const POLL_MS = 1000;

function parse(line) {
  try {
    const e = JSON.parse(line);
    if (!e || typeof e !== "object") return null;
    return e;
  } catch {
    return null;
  }
}

function ago(ts) {
  const s = Math.max(0, (Date.now() - Date.parse(ts)) / 1000);
  if (!isFinite(s)) return "";
  if (s < 5) return "now";
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function dur(ms) {
  if (ms == null || !isFinite(ms)) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function short(value, n = 90) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > n ? `${text.slice(0, n)}…` : text;
}

export default class SwampActivity extends View {
  init(_props, cx) {
    this.events = [];
    this.loading = true;
    this.error = "";
    this.filter = "all"; // all | routed | bypass | errors
    cx.timer.every(POLL_MS, (cx) => this.refresh(cx));
    this.refresh(cx);
  }

  refresh(cx) {
    cx.spawn(async (cx) => {
      try {
        const text = (await readTextFile(LOG)) ?? "";
        if (!text.trim()) {
          this.events = [];
          this.error = "";
          return;
        }
        const rows = text
          .split(/\r?\n/)
          .filter(Boolean)
          .slice(-LIMIT * 4)
          .map(parse)
          .filter(Boolean);
        this.events = rows.reverse().slice(0, LIMIT);
        this.error = "";
      } catch (e) {
        this.events = [];
        this.error = String(e?.message ?? e);
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  render(cx) {
    const t = theme();
    const routedCount = this.events.filter((e) => e.route === "herdr-core" || e.route === "vim").length;
    const bypassCount = this.events.filter((e) => e.route === "bypass").length;
    const errorCount = this.events.filter((e) => e.outcome === "error").length;

    const shown = this.events.filter((e) => {
      if (this.filter === "routed") return e.route === "herdr-core" || e.route === "vim";
      if (this.filter === "bypass") return e.route === "bypass";
      if (this.filter === "errors") return e.outcome === "error";
      return true;
    });

    const stop = (el) => el.on_mouse_down("left", (_e, cx) => cx.stop_propagation());
    const chip = (id, label, on, onClick) =>
      stop(h_flex().id(id).h(22).px(8).items_center().rounded(11).text_size(11).cursor_pointer()
        .border_1().border_color(on ? t.accent : t.border).bg(on ? t.selected : t.chrome)
        .text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover)).on_click(onClick).child(label));

    const row = (e, index) => {
      const route = e.route === "herdr-core" || e.route === "vim" ? e.route : e.route === "bypass" ? "bypass" : "other";
      const color = e.outcome === "error"
        ? t.blocked
        : route === "bypass"
        ? t.blocked
        : route === "other"
        ? t.muted
        : t.ansi2;
      const detail = e.command || e.target || e.detail || "";
      const name = e.method ? `${e.name} → ${e.method}` : e.name;
      return v_flex().id(`activity-${index}`).px(8).py(6).gap(3).rounded(6)
        .bg(t.chrome).border_1().border_color(t.chrome)
        .child(h_flex().gap(6).items_center()
          .child(div().w(7).h(7).rounded(4).flex_none().bg(color))
          .child(div().flex_1().truncate().text_size(12).text_color(t.foreground).child(String(name ?? "?")))
          .child(div().flex_none().text_size(10).text_color(t.dim).child(ago(e.ts))))
        .child(div().pl(13).truncate().text_size(11).text_color(t.muted)
          .child(`${route}${e.outcome === "error" ? " · error" : ""}${e.durationMs != null ? ` · ${dur(e.durationMs)}` : ""}`))
        .when(Boolean(detail), (el) => el.child(div().pl(13).truncate().text_size(11).text_color(t.dim).child(short(detail))));
    };

    const body = v_flex().gap(2);
    if (this.loading) body.child(div().py(20).text_size(12).text_color(t.muted).child("Reading activity…"));
    else if (this.error) body.child(div().p(8).rounded(6).bg(t.raised).text_size(11).text_color(t.blocked).child(`Cannot read ${LOG}: ${this.error}`));
    else if (!shown.length) body.child(div().py(24).text_size(12).text_color(t.muted).child("No activity yet. Run a tool or a swamp method."));
    body.children(shown.map((e, index) => row(e, index)));

    return v_flex().id("root").size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(h_flex().h(34).px(10).flex_none().items_center().gap(6).border_b_1().border_color(t.border)
        .child(div().flex_1().font_semibold().text_color(t.foreground).child("Swamp activity"))
        .child(div().px(5).rounded(7).bg(t.working).text_color(t.background).text_size(10).child(`${routedCount} routed`))
        .when(bypassCount > 0, (el) => el.child(div().px(5).rounded(7).bg(t.blocked).text_color(t.background).text_size(10).child(`${bypassCount} bypass`)))
        .when(errorCount > 0, (el) => el.child(div().px(5).rounded(7).bg(t.blocked).text_color(t.background).text_size(10).child(`${errorCount} errors`)))
        .child(stop(div().id("refresh").px(6).py(2).rounded(4).text_size(11).text_color(t.muted).cursor_pointer()
          .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.refresh(cx)).child("refresh"))))
      .child(h_flex().px(8).py(6).flex_none().gap(5).items_center()
        .child(chip("all", "all", this.filter === "all", (_e, cx) => { this.filter = "all"; cx.notify(); }))
        .child(chip("routed", "routed", this.filter === "routed", (_e, cx) => { this.filter = "routed"; cx.notify(); }))
        .child(chip("bypass", "bypass", this.filter === "bypass", (_e, cx) => { this.filter = "bypass"; cx.notify(); }))
        .child(chip("errors", "errors", this.filter === "errors", (_e, cx) => { this.filter = "errors"; cx.notify(); })))
      .child(div().id("scroll").flex_1().min_h(0).overflow_y_scrollbar().px(6).pb(8).child(body));
  }
}
