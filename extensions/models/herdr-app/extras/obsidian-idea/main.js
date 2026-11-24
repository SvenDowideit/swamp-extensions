// Add idea: one line that captures a thought onto the swamp obsidian-factory
// board. The board model is the only writer: this mod runs
// `swamp behavior run <board> capture --input text=<text>` in the repo named in
// ~/.config/herdr-app/swamp.json.
//
// It renders as a bar block (props.compact) and as a dialog opened with
// `herdr-app do mod.open --name obsidian-idea` (or a key).
import { View, div } from "gpui-kit";
import { h_flex, v_flex, Input, InputState } from "gpui-base";
import {
  appHome,
  closeOverlay,
  exec,
  notify,
  props,
  readTextFile,
  theme,
} from "herdr";

const CONFIG = "swamp.json";
const EMPTY = "Write the thought before adding it to the inbox.";
const NO_CONFIG =
  "No " + CONFIG +
  ": run @svendowideit/herdr-app's installExtras with swampRepo set.";

export default class ObsidianIdea extends View {
  init(_props, cx) {
    this.state = InputState.new({ placeholder: "Add idea\u2026", value: "" });
    this.state.on("change", (_e, cx) => {
      if (this.error) this.error = "";
      cx.notify();
    });
    this.state.on("submit", (_e, cx) => this.submit(cx));
    this.busy = false;
    this.error = "";
    this.config = null;
    cx.spawn(async (cx) => {
      let raw = null;
      try {
        raw = await readTextFile(appHome() + "/" + CONFIG);
      } catch {
        raw = null;
      }
      try {
        this.config = raw ? JSON.parse(raw) : null;
      } catch {
        this.config = null;
      }
      if (!this.config?.repo) this.error = NO_CONFIG;
      cx.notify();
    });
  }

  submit(cx) {
    if (this.busy) return;
    const text = this.state.value().trim();
    if (text === "") {
      this.error = EMPTY;
      cx.notify();
      return;
    }
    const cfg = this.config;
    if (!cfg?.repo || !cfg?.swampBinary) {
      this.error = NO_CONFIG;
      cx.notify();
      return;
    }
    const argv = [
      "behavior",
      "run",
      String(cfg.boardModel ?? "obsidian-board"),
      "capture",
      "--input",
      "text=" + text,
    ];
    if (cfg.source) argv.push("--input", "source=" + String(cfg.source));
    this.busy = true;
    this.error = "";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await exec(String(cfg.swampBinary), argv, {
          cwd: String(cfg.repo),
          timeout: 60000,
        });
        if (r.code !== 0) {
          const why = (r.stderr.trim() || r.stdout.trim() || "exit " + r.code)
            .split("\n").pop();
          this.error = why;
          notify({ title: "Idea not captured", body: why, level: "error" });
        } else {
          this.state.set_value("");
          notify({
            title: "Idea captured",
            body: text.slice(0, 140),
            level: "success",
          });
          if (!props()?.compact) this.state.focus();
        }
      } catch (error) {
        const why = String(error?.message ?? error);
        this.error = why;
        notify({ title: "Idea not captured", body: why, level: "error" });
      }
      this.busy = false;
      cx.notify();
    });
  }

  render() {
    const t = theme();
    const compact = Boolean(props()?.compact);
    const overlay = props()?.overlay;
    const input = Input.new(this.state)
      .flex_1()
      .min_w(0)
      .h(28)
      .px(8)
      .items_center()
      .rounded(6)
      .border(1)
      .border_color(this.error ? t.blocked : t.input)
      .bg(t.background)
      .text_color(t.foreground);
    const add = div().id("add").h(28).px(12).flex_none().flex().items_center()
      .rounded(6).text_size(12)
      .bg(this.busy ? t.chrome : t.solid)
      .text_color(this.busy ? t.dim : t.solid_foreground)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => this.submit(cx))
      .child(this.busy ? "Adding\u2026" : "Add idea");
    const row = h_flex().id("obsidian-idea").size_full().items_center().gap(6)
      .px(compact ? 4 : 0)
      .child(input)
      .child(add);

    if (compact) return row;

    return v_flex().id("root").size_full().p(12).gap(8).bg(t.popover)
      .child(
        h_flex().gap(8).items_center()
          .child(
            div().flex_1().text_size(13).font_semibold()
              .text_color(t.foreground)
              .child("Add an idea to the board"),
          )
          .child(
            div().id("close").px(6).py(2).rounded(4).text_size(13)
              .text_color(t.muted).cursor_pointer()
              .hover((s) => s.bg(t.hover))
              .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
              .on_click(() => {
                if (overlay) closeOverlay(overlay);
              })
              .child("\u00d7"),
          ),
      )
      .child(row)
      .child(
        div().text_size(11)
          .text_color(this.error ? t.blocked : t.dim)
          .child(
            this.error ||
              (this.config
                ? "Enter adds it to the uncharacterised inbox card."
                : NO_CONFIG),
          ),
      );
  }
}
