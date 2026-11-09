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
function isBoardPath(path, folder = "Factory") {
  const normalized = folder.replace(/^\/+|\/+$/g, "");
  return path.replace(/^\/+/, "") === `${normalized}/Board.md`;
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
var CAPTURE_PLACEHOLDER = "Add an idea to the inbox...";
function captureTextProblem(text) {
  if (text.trim() === "") {
    return "Write the thought before adding it to the inbox.";
  }
  return "";
}
function captureRequestBody(text) {
  return { text: text.trim() };
}
var ARCHIVE_OUTCOMES = ["done", "deleted", "duplicate"];
function isArchivablePath(path, folder = "Factory") {
  const normalized = folder.replace(/^\/+|\/+$/g, "");
  return isCardPath(path, `${normalized}/Cards`);
}
function isArchivedPath(path, folder = "Factory") {
  const normalized = folder.replace(/^\/+|\/+$/g, "");
  return isCardPath(path, `${normalized}/Archive`);
}
function archiveRequestProblem(outcome, reason) {
  if (!ARCHIVE_OUTCOMES.includes(outcome)) {
    return `Pick an outcome: ${ARCHIVE_OUTCOMES.join(", ")}`;
  }
  if (reason.trim() === "") return "Say why this card is finished.";
  return "";
}
function archiveRequestBody(id, outcome, reason, detail = "") {
  return {
    id: id.trim(),
    outcome,
    reason: reason.trim(),
    detail: detail.trim()
  };
}

// main.ts
function numericVersion(value) {
  return value.replace(/^v/, "").split(".").map((part) => Number(part) || 0);
}
function piDefaultModel() {
  try {
    const path = `${process.env.HOME ?? ""}/.pi/agent/settings.json`;
    if (!(0, import_fs.existsSync)(path)) return "";
    const settings = JSON.parse((0, import_fs.readFileSync)(path, "utf8"));
    const model = typeof settings.defaultModel === "string" ? settings.defaultModel.trim() : "";
    const provider = typeof settings.defaultProvider === "string" ? settings.defaultProvider.trim() : "";
    if (!model) return "";
    if (model.includes("/")) return model;
    return provider ? `${provider}/${model}` : model;
  } catch {
    return "";
  }
}
function agentPath() {
  const home = process.env.HOME ?? "";
  const parts = [
    `${home}/.pi/agent/bin`,
    `${home}/.local/bin`,
    `${home}/.opencode/bin`
  ];
  const nvm = `${home}/.nvm/versions/node`;
  if ((0, import_fs.existsSync)(nvm)) {
    const versions = (0, import_fs.readdirSync)(nvm).filter((name) => /^v?\d/.test(name)).sort((a, b) => {
      const left = numericVersion(a);
      const right = numericVersion(b);
      for (let i = 0; i < Math.max(left.length, right.length); i++) {
        const diff = (right[i] ?? 0) - (left[i] ?? 0);
        if (diff !== 0) return diff;
      }
      return 0;
    });
    for (const version of versions) parts.push(`${nvm}/${version}/bin`);
  }
  parts.push(process.env.PATH ?? "");
  return parts.filter(Boolean).join(":");
}
var DEFAULT_SETTINGS = {
  repoPath: "",
  swampBinary: "swamp",
  agent: "pi",
  model: "",
  archiveWebhookUrl: "",
  archiveWebhookToken: ""
};
var ObsidianFactoryPlugin = class extends import_obsidian.Plugin {
  settings = { ...DEFAULT_SETTINGS };
  originalOpenLinkText = null;
  statusItem = null;
  tickRunning = false;
  decorateScheduled = false;
  tickLog = "";
  tickLastLine = "";
  tickStartedAt = 0;
  tickTimer = null;
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
    this.registerEvent(workspaceEvents.on("file-open", () => {
      this.decorateCards();
    }));
    this.registerEvent(workspaceEvents.on("active-leaf-change", () => {
      this.decorateCards();
    }));
    const observer = new MutationObserver(() => {
      if (this.decorateScheduled) return;
      this.decorateScheduled = true;
      globalThis.setTimeout(() => {
        this.decorateScheduled = false;
        this.decorateCards();
      }, 120);
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
    this.register(() => observer.disconnect());
    this.addCommand({
      id: "capture-idea",
      name: "Capture an idea",
      callback: () => {
        new CaptureIdeaModal(this.app, (text) => {
          void this.captureIdea(text);
        }).open();
      }
    });
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
    this.addCommand({
      id: "archive-factory-card",
      name: "Archive factory card",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !isArchivablePath(file.path)) return false;
        if (!checking) this.openArchiveDialog(file);
        return true;
      }
    });
    this.addCommand({
      id: "unarchive-factory-card",
      name: "Unarchive factory card",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !isArchivedPath(file.path)) return false;
        if (!checking) void this.unarchiveCard(file);
        return true;
      }
    });
    this.addSettingTab(new FactorySettingTab(this.app, this));
    this.statusItem = this.addStatusBarItem();
    this.statusItem.addClass("factory-status");
    this.statusItem.setText("Factory: idle");
    this.statusItem.addEventListener("click", () => this.showLog());
    this.addCommand({
      id: "show-tick-log",
      name: "Show factory tick log",
      callback: () => this.showLog()
    });
  }
  async loadSettings() {
    this.settings = { ...DEFAULT_SETTINGS, ...await this.loadData() };
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
  async tickFactory() {
    await this.loadSettings();
    if (this.tickRunning) {
      new import_obsidian.Notice("Factory tick is already running.");
      this.showLog();
      return;
    }
    const repo = this.settings.repoPath.trim();
    if (!repo) {
      this.setStatus("Factory: needs repo path");
      new import_obsidian.Notice(
        "The tick has no repo path. Run obsidian-board tick or set it in Settings -> Community plugins -> Obsidian Factory."
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
    const model = this.settings.model.trim() || piDefaultModel();
    if (model) {
      args.push("--input", `model=${model}`);
    }
    this.tickLog = "";
    this.tickLastLine = "";
    this.tickRunning = true;
    this.tickStartedAt = Date.now();
    this.startTickTimer();
    this.appendLog(
      `$ ${this.settings.swampBinary || "swamp"} ${args.join(" ")}

`
    );
    new import_obsidian.Notice(
      "Obsidian factory tick started. Click the status bar for the log."
    );
    const swamp = this.settings.swampBinary || "swamp";
    const env = { ...process.env, PATH: agentPath() };
    const useLoginShell = process.platform !== "win32";
    const shell = process.env.SHELL || "/bin/bash";
    if (useLoginShell) {
      this.appendLog(
        `# via ${shell} -ic (loads your login environment)

`
      );
    }
    const child = useLoginShell ? (0, import_child_process.spawn)(
      shell,
      ["-ic", 'exec "$0" "$@"', swamp, ...args],
      { cwd: repo, env }
    ) : (0, import_child_process.spawn)(swamp, args, { cwd: repo, env });
    child.stdout?.on("data", (data) => this.appendLog(data.toString()));
    child.stderr?.on("data", (data) => this.appendLog(data.toString()));
    child.on("error", (error) => this.finishTick(false, error.message));
    child.on("close", (code) => {
      this.finishTick(code === 0, `exit ${code ?? "unknown"}`);
    });
  }
  /**
   * Send one captured thought to the board model's capture method. The plugin
   * never writes the inbox note: obsidian-board is its only writer.
   */
  async captureIdea(text) {
    await this.loadSettings();
    const problem = captureTextProblem(text);
    if (problem) {
      new import_obsidian.Notice(problem);
      return;
    }
    const repo = this.settings.repoPath.trim();
    if (!repo) {
      new import_obsidian.Notice(
        "Capturing needs a swamp repo path. Set one in Settings -> Community plugins -> Obsidian Factory."
      );
      return;
    }
    const payload = captureRequestBody(text);
    const child = (0, import_child_process.spawn)(
      this.settings.swampBinary || "swamp",
      [
        "behavior",
        "run",
        "obsidian-board",
        "capture",
        "--input",
        `text=${payload.text}`
      ],
      { cwd: repo, env: { ...process.env, PATH: agentPath() } }
    );
    let output = "";
    child.stdout?.on("data", (data) => {
      output += data.toString();
    });
    child.stderr?.on("data", (data) => {
      output += data.toString();
    });
    child.on("error", (error) => {
      new import_obsidian.Notice(`Capture failed: ${error.message}`);
    });
    child.on("close", (code) => {
      if (code === 0) {
        new import_obsidian.Notice("Added to the inbox card in Uncharacterised.");
      } else {
        new import_obsidian.Notice(
          `Capture failed (exit ${code}): ${output.trim().split("\n").slice(-3).join(" ")}`
        );
      }
    });
  }
  openArchiveDialog(file) {
    new ArchiveCardModal(this.app, file, (outcome, reason, detail) => {
      void this.archiveCard(file, outcome, reason, detail);
    }).open();
  }
  /**
   * Archive one card through the board model: over the configured webhook when
   * there is one, otherwise through the archive workflow in the repo. The
   * plugin never writes the note itself.
   */
  async archiveCard(file, outcome, reason, detail) {
    await this.loadSettings();
    const payload = archiveRequestBody(file.path, outcome, reason, detail);
    const problem = archiveRequestProblem(payload.outcome, payload.reason);
    if (problem) {
      new import_obsidian.Notice(problem);
      return;
    }
    const url = this.settings.archiveWebhookUrl.trim();
    if (url) {
      const token = this.settings.archiveWebhookToken.trim();
      try {
        const response = await (0, import_obsidian.requestUrl)({
          url,
          method: "POST",
          contentType: "application/json",
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          body: JSON.stringify(payload),
          throw: false
        });
        if (response.status >= 200 && response.status < 300) {
          new import_obsidian.Notice(`Archived ${file.basename} as ${payload.outcome}`);
        } else {
          new import_obsidian.Notice(
            `Archive webhook failed: HTTP ${response.status} ${response.text.slice(0, 200)}`
          );
        }
      } catch (error) {
        new import_obsidian.Notice(
          `Archive webhook failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      return;
    }
    const repo = this.settings.repoPath.trim();
    if (!repo) {
      new import_obsidian.Notice(
        "Archiving needs an archive webhook URL or a swamp repo path. Set one in Settings -> Community plugins -> Obsidian Factory."
      );
      return;
    }
    const args = [
      "workflow",
      "run",
      "@svendowideit/obsidian-factory-archive",
      "--input",
      `id=${payload.id}`,
      "--input",
      `outcome=${payload.outcome}`,
      "--input",
      `reason=${payload.reason}`,
      "--input",
      `detail=${payload.detail}`
    ];
    const child = (0, import_child_process.spawn)(
      this.settings.swampBinary || "swamp",
      args,
      { cwd: repo, env: { ...process.env, PATH: agentPath() } }
    );
    let output = "";
    child.stdout?.on("data", (data) => {
      output += data.toString();
    });
    child.stderr?.on("data", (data) => {
      output += data.toString();
    });
    child.on("error", (error) => {
      new import_obsidian.Notice(`Archive failed: ${error.message}`);
    });
    child.on("close", (code) => {
      if (code === 0) {
        new import_obsidian.Notice(`Archived ${file.basename} as ${payload.outcome}`);
      } else {
        new import_obsidian.Notice(
          `Archive failed (exit ${code}): ${output.trim().split("\n").slice(-3).join(" ")}`
        );
      }
    });
  }
  /**
   * Restore one archived card through the board model. Like archive, this runs
   * the workflow and never writes the note itself.
   */
  async unarchiveCard(file) {
    await this.loadSettings();
    const repo = this.settings.repoPath.trim();
    if (!repo) {
      new import_obsidian.Notice(
        "Unarchiving needs a swamp repo path. Set one in Settings -> Community plugins -> Obsidian Factory."
      );
      return;
    }
    const child = (0, import_child_process.spawn)(
      this.settings.swampBinary || "swamp",
      [
        "workflow",
        "run",
        "@svendowideit/obsidian-factory-unarchive",
        "--input",
        `id=${file.path}`
      ],
      { cwd: repo, env: { ...process.env, PATH: agentPath() } }
    );
    let output = "";
    child.stdout?.on("data", (data) => {
      output += data.toString();
    });
    child.stderr?.on("data", (data) => {
      output += data.toString();
    });
    child.on("error", (error) => {
      new import_obsidian.Notice(`Unarchive failed: ${error.message}`);
    });
    child.on("close", (code) => {
      if (code === 0) {
        new import_obsidian.Notice(`Restored ${file.basename} to the board`);
      } else {
        new import_obsidian.Notice(
          `Unarchive failed (exit ${code}): ${output.trim().split("\n").slice(-3).join(" ")}`
        );
      }
    });
  }
  setStatus(text) {
    this.statusItem?.setText(text);
  }
  startTickTimer() {
    this.stopTickTimer();
    const tick = () => {
      const seconds = Math.floor((Date.now() - this.tickStartedAt) / 1e3);
      const tail = this.tickLastLine ? ` | ${this.tickLastLine.slice(0, 70)}` : "";
      this.setStatus(`Factory: ticking ${seconds}s${tail}`);
    };
    tick();
    this.tickTimer = globalThis.setInterval(tick, 1e3);
  }
  stopTickTimer() {
    if (this.tickTimer !== null) {
      globalThis.clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }
  appendLog(text) {
    if (!text) return;
    this.tickLog += text;
    if (this.tickLog.length > 2e5) {
      this.tickLog = this.tickLog.slice(-2e5);
    }
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(
      Boolean
    );
    if (lines.length > 0) {
      const ansi = new RegExp(
        `${String.fromCharCode(27)}\\[[0-9;]*m`,
        "g"
      );
      this.tickLastLine = lines[lines.length - 1].replace(ansi, "");
    }
  }
  finishTick(ok, detail) {
    this.tickRunning = false;
    this.stopTickTimer();
    this.setStatus(ok ? "Factory: done" : "Factory: failed");
    this.appendLog(`
${ok ? "\u2713" : "\u2717"} ${detail}
`);
    new import_obsidian.Notice(
      ok ? "Factory tick finished. Click the status bar to read the log." : `Factory tick failed: ${detail}`
    );
    if (!ok) this.showLog();
  }
  showLog() {
    if (!this.tickLog) {
      new import_obsidian.Notice("No factory tick has run yet.");
      return;
    }
    new TickLogModal(this.app, () => this.tickLog).open();
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
    this.decorateBoardNote();
    this.decorateCaptureBoxes();
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
  /**
   * Put the capture box on the kanban board page: the Board view is a Bases
   * Kanban, and the native view cannot host an input widget, so the plugin
   * adds the box above the columns. The box submits through captureIdea, so
   * obsidian-board stays the only writer of the inbox note.
   */
  /** Add the capture form to a container. */
  addCaptureForm(parent) {
    const form = parent.createDiv({ cls: "factory-capture" });
    form.dataset.factoryCapture = "1";
    const input = form.createEl("input", { type: "text" });
    input.placeholder = CAPTURE_PLACEHOLDER;
    const submit = () => {
      void this.captureIdea(input.value);
      input.value = "";
    };
    const button = form.createEl("button", { text: "Add idea" });
    button.addEventListener("click", submit);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        submit();
      }
    });
    form.createEl("span", {
      cls: "factory-capture-hint",
      text: "Lands on the inbox card in Uncharacterised"
    });
    return form;
  }
  /** True when the active note is the Board page itself. */
  boardNoteActive() {
    const file = this.app.workspace.getActiveFile();
    return Boolean(file && isBoardPath(file.path));
  }
  /**
   * Put the capture box on the Board note page. This is the reliable anchor:
   * it does not depend on the Bases kanban's internal DOM. It is inserted
   * after the page title, before the embedded board.
   */
  decorateBoardNote() {
    if (!this.boardNoteActive()) return;
    const leaf = document.querySelector(".workspace-leaf.mod-active");
    if (!leaf) return;
    const preview = leaf.querySelector(
      ".markdown-preview-view"
    );
    const view = preview ?? leaf.querySelector(
      ".markdown-source-view .cm-scroller"
    );
    if (!view) return;
    if (leaf.querySelector(".factory-capture")) return;
    const form = this.addCaptureForm(view);
    const heading = preview?.querySelector("h1");
    if (heading) heading.after(form);
    else view.prepend(form);
  }
  /**
   * Put the capture box on a Bases kanban view when the Board page is not the
   * active note (for example when Board.base is opened directly). The native
   * view cannot host an input widget, so the plugin adds one above the cards.
   */
  decorateCaptureBoxes() {
    if (this.boardNoteActive()) return;
    const containers = /* @__PURE__ */ new Set();
    for (const card of Array.from(
      document.querySelectorAll(".bases-kanban-card")
    )) {
      const container = card.closest(".bases-view") ?? card.closest(".bases-kanban");
      if (container) containers.add(container);
    }
    for (const container of containers) {
      if (container.querySelector(".factory-capture")) continue;
      const form = this.addCaptureForm(container);
      container.prepend(form);
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
      new CardDialog(
        this.app,
        file,
        readableCard(raw),
        raw,
        isArchivablePath(file.path) ? () => this.openArchiveDialog(file) : void 0
      ).open();
    } catch (error) {
      new import_obsidian.Notice(
        `Could not open ${file.basename}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
};
async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    new import_obsidian.Notice("Copied to clipboard");
  } catch (error) {
    new import_obsidian.Notice(
      `Could not copy: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
var CardDialog = class extends import_obsidian.Modal {
  constructor(app, file, card, raw, onArchive) {
    super(app);
    this.file = file;
    this.card = card;
    this.raw = raw;
    this.onArchive = onArchive;
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
    if (this.onArchive) {
      const archive = topActions.createEl("button", { text: "Archive..." });
      archive.addEventListener("click", () => {
        this.close();
        this.onArchive?.();
      });
    }
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
    const copy = actions.createEl("button", { text: "Copy card markdown" });
    copy.addEventListener("click", () => {
      void copyToClipboard(this.raw);
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
var ArchiveCardModal = class extends import_obsidian.Modal {
  constructor(app, file, onSubmit) {
    super(app);
    this.file = file;
    this.onSubmit = onSubmit;
  }
  onOpen() {
    this.modalEl.addClass("factory-archive-dialog");
    this.titleEl.setText(`Archive ${this.file.basename}`);
    const form = this.contentEl.createDiv({ cls: "factory-archive-form" });
    form.createEl("p", {
      text: "The card leaves the board and keeps its whole note in the Archive folder: what happened, why, and when."
    });
    const outcomeRow = form.createDiv({
      cls: "factory-archive-row"
    });
    outcomeRow.createEl("label", { text: "Outcome" });
    const select = outcomeRow.createEl("select");
    for (const outcome of ARCHIVE_OUTCOMES) {
      select.createEl("option", { text: outcome, value: outcome });
    }
    const reasonRow = form.createDiv({ cls: "factory-archive-row" });
    reasonRow.createEl("label", { text: "Reason (required)" });
    const reason = reasonRow.createEl("input", { type: "text" });
    reason.placeholder = "Why is this card finished?";
    const detailRow = form.createDiv({ cls: "factory-archive-row" });
    detailRow.createEl("label", { text: "Detail (optional)" });
    const detail = detailRow.createEl("textarea");
    detail.rows = 3;
    detail.placeholder = "Anything the history should keep";
    const error = form.createEl("p", { cls: "factory-archive-error" });
    const actions = this.contentEl.createDiv({
      cls: "factory-dialog-actions"
    });
    const submit = actions.createEl("button", { text: "Archive" });
    submit.addEventListener("click", () => {
      const outcome = select.value;
      const problem = archiveRequestProblem(outcome, reason.value);
      if (problem) {
        error.setText(problem);
        return;
      }
      this.onSubmit(outcome, reason.value, detail.value);
      this.close();
    });
    const cancel = actions.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.close());
  }
};
var CaptureIdeaModal = class extends import_obsidian.Modal {
  constructor(app, onSubmit) {
    super(app);
    this.onSubmit = onSubmit;
  }
  onOpen() {
    this.modalEl.addClass("factory-capture-dialog");
    this.titleEl.setText("Capture an idea");
    const form = this.contentEl.createDiv({ cls: "factory-capture-form" });
    form.createEl("p", {
      text: "The thought lands on the inbox card in Uncharacterised; the next tick routes it to a category."
    });
    const input = form.createEl("textarea");
    input.rows = 3;
    input.placeholder = CAPTURE_PLACEHOLDER;
    const error = form.createEl("p", { cls: "factory-capture-error" });
    const actions = this.contentEl.createDiv({
      cls: "factory-dialog-actions"
    });
    const submit = actions.createEl("button", { text: "Add idea" });
    submit.addEventListener("click", () => {
      const problem = captureTextProblem(input.value);
      if (problem) {
        error.setText(problem);
        return;
      }
      this.onSubmit(input.value);
      this.close();
    });
    const cancel = actions.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.close());
    input.focus();
  }
};
var TickLogModal = class extends import_obsidian.Modal {
  constructor(app, getLog) {
    super(app);
    this.getLog = getLog;
  }
  logEl = null;
  timer = null;
  pauseButton = null;
  paused = false;
  lastLog = "";
  onOpen() {
    this.titleEl.setText("Factory tick log");
    const actions = this.contentEl.createDiv({
      cls: "factory-dialog-actions factory-tick-log-actions"
    });
    const copy = actions.createEl("button", { text: "Copy log" });
    copy.addEventListener("click", () => {
      void copyToClipboard(this.getLog());
    });
    this.pauseButton = actions.createEl("button", { text: "Pause" });
    this.pauseButton.addEventListener("click", () => {
      this.paused = !this.paused;
      if (this.pauseButton) {
        this.pauseButton.setText(this.paused ? "Resume" : "Pause");
      }
      if (!this.paused) this.refresh();
    });
    const close = actions.createEl("button", { text: "Close" });
    close.addEventListener("click", () => this.close());
    this.logEl = this.contentEl.createEl("pre", { cls: "factory-tick-log" });
    this.refresh();
    this.timer = globalThis.setInterval(() => this.refresh(), 500);
  }
  selectionInsideLog() {
    const selection = document.getSelection();
    if (!selection || selection.isCollapsed || !this.logEl) return false;
    return this.logEl.contains(selection.anchorNode) || this.logEl.contains(selection.focusNode);
  }
  refresh() {
    if (!this.logEl || this.paused) return;
    const log = this.getLog();
    if (log === this.lastLog) return;
    this.lastLog = log;
    if (this.selectionInsideLog()) return;
    this.logEl.setText(log || "No tick output yet.");
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }
  onClose() {
    if (this.timer !== null) globalThis.clearInterval(this.timer);
    this.timer = null;
    this.pauseButton = null;
    this.contentEl.empty();
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
    new import_obsidian.Setting(containerEl).setName("Archive webhook URL").setDesc(
      "Optional swamp serve webhook for archiving, e.g. https://swamp.example/hooks/obsidian-archive. Empty archives through the repo path instead."
    ).addText(
      (text) => text.setPlaceholder("https://swamp.example/hooks/obsidian-archive").setValue(this.plugin.settings.archiveWebhookUrl).onChange(async (value) => {
        this.plugin.settings.archiveWebhookUrl = value.trim();
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Archive webhook token").setDesc(
      "Bearer token for the archive webhook; stored in data.json. Leave empty for a local, tokenless route."
    ).addText(
      (text) => text.setPlaceholder("").setValue(this.plugin.settings.archiveWebhookToken).onChange(async (value) => {
        this.plugin.settings.archiveWebhookToken = value.trim();
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
