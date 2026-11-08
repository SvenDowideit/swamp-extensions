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
var import_child_process = require("child_process");
var import_crypto = require("crypto");
var import_fs = require("fs");

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
var STATUSES = [
  "Uncharacterised",
  "Category",
  "Proposed",
  "Please Plan",
  "Work Planned",
  "Please Implement",
  "Please Test",
  "User Acceptance",
  "Please Release",
  "Done"
];
function movesForStatus(status) {
  switch (status) {
    case "Proposed":
      return ["Please Plan"];
    case "Please Plan":
      return ["Work Planned"];
    case "Work Planned":
      return ["Please Plan", "Please Implement"];
    case "Please Implement":
      return ["Please Test"];
    case "Please Test":
      return ["Please Implement", "User Acceptance"];
    case "User Acceptance":
      return [
        "Please Plan",
        "Please Implement",
        "Please Test",
        "Please Release"
      ];
    case "Please Release":
      return ["User Acceptance", "Done"];
    default:
      return [];
  }
}
function statusFromFrontmatter(frontmatter) {
  if (frontmatter && typeof frontmatter === "object" && "status" in frontmatter && typeof frontmatter.status === "string") {
    return frontmatter.status;
  }
  return "";
}
function shouldInterceptCardOpen(linktext, newLeaf) {
  return !newLeaf && isCardPath(linktext);
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
var DEFAULT_SETTINGS = {
  repoPath: "",
  swampBinary: "swamp",
  agent: "pi",
  model: ""
};
var ObsidianFactoryPlugin = class extends import_obsidian.Plugin {
  settings = { ...DEFAULT_SETTINGS };
  originalOpenLinkText = null;
  async onload() {
    await this.loadSettings();
    this.registerDomEvent(document, "click", (event) => {
      void this.onClick(event);
    }, true);
    const workspace = this.app.workspace;
    this.originalOpenLinkText = workspace.openLinkText.bind(workspace);
    workspace.openLinkText = (linktext, sourcePath, newLeaf, openViewState) => {
      if (shouldInterceptCardOpen(linktext, newLeaf === true)) {
        const file = this.app.metadataCache.getFirstLinkpathDest(
          linktext,
          sourcePath
        );
        if (file) {
          void this.openCard(file);
          return Promise.resolve();
        }
      }
      return this.originalOpenLinkText(
        linktext,
        sourcePath,
        newLeaf,
        openViewState
      );
    };
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
    for (const status of STATUSES) {
      this.addCommand({
        id: `move-to-${status.toLowerCase().replace(/\s+/g, "-")}`,
        name: `Move factory card to ${status}`,
        checkCallback: (checking) => {
          const file = this.app.workspace.getActiveFile();
          if (!file || !isCardPath(file.path)) return false;
          if (!movesForStatus(this.cardStatus(file)).includes(status)) {
            return false;
          }
          if (!checking) void this.moveCard(file, status);
          return true;
        }
      });
    }
    const workspaceEvents = this.app.workspace;
    this.registerEvent(workspaceEvents.on("layout-change", () => {
      this.decorateCards();
    }));
    workspaceEvents.onLayoutReady(() => this.decorateCards());
    this.addCommand({
      id: "tick-factory",
      name: "Tick the Obsidian factory",
      callback: () => {
        void this.tickFactory();
      }
    });
    this.addRibbonIcon(
      "refresh-cw",
      "Tick the Obsidian factory",
      () => void this.tickFactory()
    );
    this.addSettingTab(new FactorySettingTab(this.app, this));
  }
  async loadSettings() {
    this.settings = { ...DEFAULT_SETTINGS, ...await this.loadData() };
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
  async tickFactory() {
    await this.loadSettings();
    const repo = this.settings.repoPath.trim();
    if (!repo) {
      new import_obsidian.Notice(
        "Set the swamp repo path in Settings -> Community plugins -> Obsidian Factory."
      );
      return;
    }
    const factory = `${repo.replace(/\/+$/, "")}/models/@swamp/stagecraft/factory/obsidian-idea-factory.yaml`;
    let factoryDefinition = "";
    try {
      factoryDefinition = (0, import_crypto.createHash)("sha256").update((0, import_fs.readFileSync)(factory)).digest("hex");
    } catch {
      new import_obsidian.Notice(`Could not read ${factory}; ticking without a repin hash.`);
    }
    const args = [
      "workflow",
      "run",
      "@svendowideit/obsidian-factory-tick",
      "--input",
      `repo=${repo}`,
      "--input",
      `factoryDefinition=${factoryDefinition}`,
      "--input",
      `agent=${this.settings.agent || "pi"}`
    ];
    if (this.settings.model.trim()) {
      args.push("--input", `model=${this.settings.model.trim()}`);
    }
    new import_obsidian.Notice("Obsidian factory tick started.");
    (0, import_child_process.execFile)(
      this.settings.swampBinary || "swamp",
      args,
      { cwd: repo, maxBuffer: 10 * 1024 * 1024 },
      (error, _stdout, stderr) => {
        if (error) {
          new import_obsidian.Notice(
            `Obsidian factory tick failed: ${(stderr || error.message || "").slice(0, 300)}`
          );
        } else {
          new import_obsidian.Notice("Obsidian factory tick finished.");
        }
      }
    );
  }
  onunload() {
    if (this.originalOpenLinkText) {
      this.app.workspace.openLinkText = this.originalOpenLinkText;
      this.originalOpenLinkText = null;
    }
  }
  cardStatus(file) {
    const cache = this.app.metadataCache.getFileCache(file);
    return statusFromFrontmatter(cache?.frontmatter);
  }
  async moveCard(file, status) {
    await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
      frontmatter.status = status;
    });
    new import_obsidian.Notice(`Moved ${file.basename} to ${status}`);
    this.decorateCards();
  }
  decorateCards() {
    const cards = Array.from(
      document.querySelectorAll(".bases-kanban-card")
    );
    if (cards.length === 0) return;
    const byTitle = /* @__PURE__ */ new Map();
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!isCardPath(file.path)) continue;
      const cache = this.app.metadataCache.getFileCache(file);
      const frontmatter = cache?.frontmatter;
      const title = frontmatter && typeof frontmatter === "object" && typeof frontmatter.title === "string" ? frontmatter.title : file.basename.replace(/^FAC-\d+\s+/, "");
      byTitle.set(title.trim().toLowerCase(), file);
    }
    for (const cardEl of cards) {
      if (cardEl.dataset.factoryMoves === "1") continue;
      const titleEl = cardEl.querySelector(
        ".bases-kanban-card-property.mod-title .bases-kanban-card-line"
      ) ?? cardEl.querySelector(".bases-kanban-card-line");
      const title = titleEl?.textContent?.trim() ?? "";
      const file = byTitle.get(title.toLowerCase());
      if (!file) continue;
      const moves = movesForStatus(this.cardStatus(file));
      if (moves.length === 0) continue;
      const row = document.createElement("div");
      row.className = "factory-card-moves";
      for (const move of moves) {
        const button = document.createElement("button");
        button.textContent = move;
        button.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          void this.moveCard(file, move);
        });
        row.appendChild(button);
      }
      const open = document.createElement("button");
      open.textContent = "Open in editor";
      open.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void this.app.workspace.getLeaf().openFile(file);
      });
      row.appendChild(open);
      cardEl.prepend(row);
      cardEl.dataset.factoryMoves = "1";
    }
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
    const topActions = this.contentEl.createDiv({
      cls: "factory-dialog-moves"
    });
    const frontmatter = this.app.metadataCache.getFileCache(this.file)?.frontmatter;
    const moves = movesForStatus(statusFromFrontmatter(frontmatter));
    if (moves.length > 0) {
      topActions.createEl("span", { text: "Move to" });
      for (const move of moves) {
        const button = topActions.createEl("button", { text: move });
        button.addEventListener("click", () => {
          void this.app.fileManager.processFrontMatter(
            this.file,
            (fm) => {
              fm.status = move;
            }
          ).then(() => {
            new import_obsidian.Notice(`Moved to ${move}`);
            this.close();
          });
        });
      }
    }
    const openInEditor = topActions.createEl("button", {
      text: "Open in editor"
    });
    openInEditor.addEventListener("click", () => {
      void this.app.workspace.getLeaf().openFile(this.file);
      this.close();
    });
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
var FactorySettingTab = class extends import_obsidian.PluginSettingTab {
  plugin;
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    new import_obsidian.Setting(containerEl).setName("Swamp repo path").setDesc("Absolute path to the swamp repository that owns the board.").addText(
      (text) => text.setPlaceholder("/home/me/src/swamp-project").setValue(this.plugin.settings.repoPath).onChange(async (value) => {
        this.plugin.settings.repoPath = value.trim();
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Swamp binary").setDesc("The swamp executable used by the Tick button.").addText(
      (text) => text.setPlaceholder("swamp").setValue(this.plugin.settings.swampBinary).onChange(async (value) => {
        this.plugin.settings.swampBinary = value.trim() || "swamp";
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Agent").setDesc(
      "Headless agent for the tick: pi, claude, codex, opencode or kilo."
    ).addText(
      (text) => text.setPlaceholder("pi").setValue(this.plugin.settings.agent).onChange(async (value) => {
        this.plugin.settings.agent = value.trim() || "pi";
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Model").setDesc("Optional provider/model for the agent; empty uses its default.").addText(
      (text) => text.setPlaceholder("").setValue(this.plugin.settings.model).onChange(async (value) => {
        this.plugin.settings.model = value.trim();
        await this.plugin.saveSettings();
      })
    );
  }
};
module.exports = module.exports.default || module.exports;
