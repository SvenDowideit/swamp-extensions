// Browser: open the configured browser argv in a new tab on this space's
// machine. The argv comes from ~/.config/herdr-app/browser.json, written by
// @svendowideit/herdr-app (default: docker run --rm -it browsh/browsh).
import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import {
  appHome,
  checking,
  exec,
  readTextFile,
  run,
  spaces,
  theme,
} from "herdr";

const CONFIG = "browser.json";
const DEFAULT_ARGV = ["docker", "run", "--rm", "-it", "browsh/browsh"];

export default class BrowserLaunch extends View {
  init(_props, cx) {
    this.argv = DEFAULT_ARGV;
    this.ready = null; // null: checking; true/false: the program can run
    cx.spawn(async (cx) => {
      try {
        const raw = await readTextFile(appHome() + "/" + CONFIG);
        const cfg = raw ? JSON.parse(raw) : null;
        if (Array.isArray(cfg?.argv) && cfg.argv.length > 0) {
          this.argv = cfg.argv.map(String);
        }
      } catch {
        // keep the defaults
      }
      if (checking()) {
        this.ready = true;
        cx.notify();
        return;
      }
      this.ready = await this.present();
      cx.notify();
    });
  }

  async present() {
    const space = spaces().find((s) => s.active);
    try {
      const r = await exec(this.argv[0], ["--version"], {
        on: space?.machine ?? null,
        timeout: 5000,
      });
      return r.code === 0;
    } catch {
      return false;
    }
  }

  open(cx) {
    cx.stop_propagation();
    if (this.ready === false) return;
    const space = spaces().find((s) => s.active);
    run("tab.new", {
      name: "Browser (browsh)",
      space: space?.id,
      argv: this.argv,
    });
  }

  render() {
    const t = theme();
    const label = this.ready === false ? "No docker" : "Browser";
    return h_flex().id("browser-launch").size_full().items_center()
      .child(
        div().id("open").h(28).px(12).flex().items_center().rounded(6)
          .text_size(12).border(1).border_color(t.border).bg(t.chrome)
          .text_color(this.ready === false ? t.dim : t.foreground)
          .when(
            this.ready !== false,
            (el) => el.hover((s) => s.bg(t.hover).text_color(t.foreground)),
          )
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => this.open(cx))
          .child(label),
      );
  }
}
