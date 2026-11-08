var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// main.ts
var main_exports = {};
__export(main_exports, {
  default: () => ObsidianFactoryPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian = require("obsidian");

// model.ts
function stripFrontmatter(raw) {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(raw);
  return match ? raw.slice(match[0].length) : raw;
}
function stripManagedMarkers(text) {
  return text.replace(
    /<!--\s*swamp:(summary|plan|definition|activity):begin\s*-->/gi,
    ""
  ).replace(/<!--\s*swamp:(summary|plan|definition|activity):end\s*-->/gi, "").replace(/<!--\s*swamp:entry[^>]*-->/gi, "").replace(/<!--\s*swamp:entry:end\s*-->/gi, "").replace(/\n{3,}/g, "\n\n").trim();
}
function section(text, heading) {
  const lines = text.split(/\r?\n/);
  const wanted = heading.trim().toLowerCase();
  const start = lines.findIndex((line) => {
    const match = /^(#{1,6})\s+(.*)$/.exec(line);
    return match !== null && match[2].trim().toLowerCase() === wanted;
  });
  if (start < 0) return "";
  const level = /^(#{1,6})/.exec(lines[start])[1].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const match = /^(#{1,6})\s+/.exec(lines[i]);
    if (match && match[1].length <= level) {
      end = i;
      break;
    }
  }
  return stripManagedMarkers(lines.slice(start, end).join("\n"));
}
function managedBlock(text, name) {
  const pattern = new RegExp(
    `<!--\\s*swamp:${name}:begin\\s*-->[\\s\\S]*?<!--\\s*swamp:${name}:end\\s*-->`,
    "i"
  );
  const match = pattern.exec(text);
  return match ? match[0] : "";
}
function withoutManagedBlock(text, name) {
  const pattern = new RegExp(
    `<!--\\s*swamp:${name}:begin\\s*-->[\\s\\S]*?<!--\\s*swamp:${name}:end\\s*-->`,
    "gi"
  );
  return text.replace(pattern, "");
}
function sanitizeMarkdown(markdown) {
  return markdown.replace(/<script\b[\s\S]*?<\/script>/gi, "").replace(/<iframe\b[\s\S]*?<\/iframe>/gi, "").replace(/<object\b[\s\S]*?<\/object>/gi, "").replace(/<embed\b[^>]*>/gi, "").replace(/<style\b[\s\S]*?<\/style>/gi, "").replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, "").replace(/\son[a-z]+\s*=\s*'[^']*'/gi, "").replace(/javascript\s*:/gi, "");
}
function isCardPath(path, folder = "Factory/Cards") {
  let decoded = path;
  try {
    decoded = decodeURIComponent(path).replace(/^\/+/, "");
  } catch {
    decoded = path.replace(/^\/+/, "");
  }
  const normalized = folder.replace(/^\/+|\/+$/g, "");
  return decoded.startsWith(`${normalized}/`) && decoded.endsWith(".md");
}
function readableCard(raw) {
  const withoutFrontmatter = stripFrontmatter(raw);
  const titleMatch = /^#\s+(.+)$/m.exec(withoutFrontmatter);
  const title = titleMatch ? titleMatch[1].trim() : "";
  const summaryBlock = managedBlock(withoutFrontmatter, "summary");
  const planBlock = managedBlock(withoutFrontmatter, "plan");
  const body = withoutManagedBlock(
    withoutManagedBlock(
      withoutManagedBlock(
        withoutManagedBlock(withoutFrontmatter, "summary"),
        "plan"
      ),
      "definition"
    ),
    "activity"
  );
  const briefSection = section(body, "Brief");
  const firstHeading = body.search(/^#{1,6}\s+/m);
  const intro = (firstHeading >= 0 ? body.slice(0, firstHeading) : body).replace(/^#\s+.+$/m, "").trim();
  const brief = (briefSection || stripManagedMarkers(intro)).replace(/^#{1,6}\s+Brief\s*\n+/i, "").trim();
  return {
    title,
    brief,
    summary: stripManagedMarkers(summaryBlock),
    plan: stripManagedMarkers(planBlock)
  };
}

// main.ts
var ObsidianFactoryPlugin = class extends import_obsidian.Plugin {
  onload() {
    this.registerDomEvent(document, "click", (event) => {
      void this.onClick(event);
    }, true);
    this.addCommand({
      id: "open-card-dialog",
      name: "Open factory card as dialog",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !isCardPath(file.path)) return false;
        if (!checking) void this.openCard(file);
        return true;
      }
    });
  }
  async onClick(event) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
      return;
    }
    const target = event.target;
    const link = target?.closest(
      "a.internal-link, a[data-href]"
    );
    if (!link) return;
    const href = link.getAttribute("data-href") ?? link.getAttribute("href") ?? "";
    if (!isCardPath(href)) return;
    let decoded = href;
    try {
      decoded = decodeURIComponent(href);
    } catch {
      decoded = href;
    }
    const file = this.app.metadataCache.getFirstLinkpathDest(decoded, "");
    if (!file) return;
    event.preventDefault();
    event.stopPropagation();
    await this.openCard(file);
  }
  async openCard(file) {
    try {
      const raw = await this.app.vault.read(file);
      new CardDialog(this.app, file, readableCard(raw)).open();
    } catch (error) {
      new import_obsidian.Notice(
        `Could not open ${file.basename}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
};
var CardDialog = class extends import_obsidian.Modal {
  constructor(app, file, card) {
    super(app);
    this.file = file;
    this.card = card;
  }
  onOpen() {
    this.modalEl.addClass("factory-card-dialog");
    this.titleEl.setText(this.card.title || this.file.basename);
    const summary = this.contentEl.createDiv({
      cls: "factory-dialog-section factory-dialog-summary"
    });
    if (this.card.summary) {
      void this.render(summary, this.card.summary);
    } else {
      summary.createEl("p", {
        text: "This card has no At a glance section yet."
      });
    }
    if (this.card.brief) {
      const brief = this.contentEl.createDiv({
        cls: "factory-dialog-section factory-dialog-brief"
      });
      brief.createEl("h3", { text: "Brief" });
      void this.render(brief, this.card.brief);
    }
    if (this.card.plan) {
      const plan = this.contentEl.createDiv({
        cls: "factory-dialog-section factory-dialog-plan"
      });
      void this.render(plan, this.card.plan);
    }
    const actions = this.contentEl.createDiv({
      cls: "factory-dialog-actions"
    });
    const edit = actions.createEl("button", { text: "Open in editor" });
    edit.addEventListener("click", () => {
      void this.app.workspace.getLeaf().openFile(this.file);
      this.close();
    });
    const close = actions.createEl("button", { text: "Close" });
    close.addEventListener("click", () => this.close());
  }
  async render(parent, markdown) {
    await import_obsidian.MarkdownRenderer.render(
      this.app,
      sanitizeMarkdown(markdown),
      parent,
      this.file.path,
      this
    );
    this.sanitizeDom(parent);
  }
  sanitizeDom(parent) {
    for (const el of Array.from(
      parent.querySelectorAll("script, iframe, object, embed, style")
    )) {
      el.remove();
    }
    for (const el of Array.from(parent.querySelectorAll("*"))) {
      if (!(el instanceof HTMLElement)) continue;
      for (const attribute of Array.from(el.attributes)) {
        if (/^on/i.test(attribute.name) || /^\s*javascript:/i.test(attribute.value)) {
          el.removeAttribute(attribute.name);
        }
      }
    }
  }
};
module.exports = module.exports.default || module.exports;
