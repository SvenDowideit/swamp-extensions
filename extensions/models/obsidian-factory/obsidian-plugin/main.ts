// @ts-nocheck: Obsidian resolves the module at runtime; the local obsidian.d.ts is for the editor and esbuild bundles the file.
/// <reference lib="dom" />
/// <reference path="./obsidian.d.ts" />
import {
  App,
  MarkdownRenderer,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  requestUrl,
  Setting,
  TextComponent,
  TFile,
} from "obsidian";
import { spawn } from "child_process";
import { createHash } from "crypto";
import { existsSync, readdirSync, readFileSync } from "fs";
import {
  ARCHIVE_OUTCOMES,
  archiveRequestBody,
  archiveRequestProblem,
  CAPTURE_PLACEHOLDER,
  captureRequestBody,
  captureTextProblem,
  columnFields,
  isArchivablePath,
  isArchivedPath,
  isBoardPath,
  isCardPath,
  isSupersededPropertyRow,
  movesForStatus,
  readableCard,
  sanitizeMarkdown,
  shouldInterceptCardOpen,
  STATUSES,
  statusFromFrontmatter,
} from "./model.ts";
import type { ArchiveOutcome } from "./model.ts";

/** Open factory cards in a read-only prose dialog instead of navigating away. */
type OpenLinkText = (
  linktext: string,
  sourcePath: string,
  newLeaf?: boolean,
  openViewState?: unknown,
) => Promise<void>;

type WorkspaceWithOpenLinkText = { openLinkText: OpenLinkText };

interface FactorySettings {
  repoPath: string;
  swampBinary: string;
  agent: string;
  model: string;
  archiveWebhookUrl: string;
  archiveWebhookToken: string;
}

function numericVersion(value: string): number[] {
  return value.replace(/^v/, "").split(".").map((part) => Number(part) || 0);
}

function piDefaultModel(): string {
  try {
    const path = `${process.env.HOME ?? ""}/.pi/agent/settings.json`;
    if (!existsSync(path)) return "";
    const settings = JSON.parse(readFileSync(path, "utf8")) as Record<
      string,
      unknown
    >;
    const model = typeof settings.defaultModel === "string"
      ? settings.defaultModel.trim()
      : "";
    const provider = typeof settings.defaultProvider === "string"
      ? settings.defaultProvider.trim()
      : "";
    if (!model) return "";
    if (model.includes("/")) return model;
    return provider ? `${provider}/${model}` : model;
  } catch {
    return "";
  }
}

function agentPath(): string {
  const home = process.env.HOME ?? "";
  const parts = [
    `${home}/.pi/agent/bin`,
    `${home}/.local/bin`,
    `${home}/.opencode/bin`,
  ];
  const nvm = `${home}/.nvm/versions/node`;
  if (existsSync(nvm)) {
    const versions = readdirSync(nvm)
      .filter((name) => /^v?\d/.test(name))
      .sort((a, b) => {
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

const DEFAULT_SETTINGS: FactorySettings = {
  repoPath: "",
  swampBinary: "swamp",
  agent: "pi",
  model: "",
  archiveWebhookUrl: "",
  archiveWebhookToken: "",
};

export default class ObsidianFactoryPlugin extends Plugin {
  settings: FactorySettings = { ...DEFAULT_SETTINGS };
  private originalOpenLinkText: OpenLinkText | null = null;
  private statusItem: HTMLElement | null = null;
  private tickRunning = false;
  private decorateScheduled = false;
  private tickLog = "";
  private tickLastLine = "";
  private tickStartedAt = 0;
  private tickTimer: number | null = null;
  private fieldPassInFlight = new Set<string>();

  override async onload(): Promise<void> {
    await this.loadSettings();
    this.registerDomEvent(document, "click", (event) => {
      void this.onClick(event);
    }, true);

    const workspace = this.app
      .workspace as unknown as WorkspaceWithOpenLinkText;
    this.originalOpenLinkText = workspace.openLinkText.bind(workspace);
    workspace.openLinkText = (
      linktext: string,
      sourcePath: string,
      newLeaf?: boolean,
      openViewState?: unknown,
    ) => {
      if (shouldInterceptCardOpen(linktext, newLeaf === true)) {
        const file = this.app.metadataCache.getFirstLinkpathDest(
          linktext,
          sourcePath,
        );
        if (file) {
          void this.openCard(file);
          return Promise.resolve();
        }
      }
      return this.originalOpenLinkText!(
        linktext,
        sourcePath,
        newLeaf,
        openViewState,
      );
    };

    this.addCommand({
      id: "open-card-dialog",
      name: "Open factory card as dialog",
      checkCallback: (checking: boolean) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !isCardPath(file.path)) return false;
        if (!checking) void this.openCard(file);
        return true;
      },
    });

    for (const status of STATUSES) {
      this.addCommand({
        id: `move-to-${status.toLowerCase().replace(/\s+/g, "-")}`,
        name: `Move factory card to ${status}`,
        checkCallback: (checking: boolean) => {
          const file = this.app.workspace.getActiveFile();
          if (!file || !isCardPath(file.path)) return false;
          if (!movesForStatus(this.cardStatus(file)).includes(status)) {
            return false;
          }
          if (!checking) void this.moveCard(file, status);
          return true;
        },
      });
    }

    const workspaceEvents = this.app.workspace as unknown as {
      on: (name: string, callback: () => void) => unknown;
      onLayoutReady: (callback: () => void) => void;
    };
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
    // The note/Bases view often renders after file-open/layout-change. Watch
    // the DOM and re-run decoration once per settled mutation batch. The
    // decoration itself checks for an existing capture box, so adding one
    // cannot cause a loop or a second box.
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
      subtree: true,
    });
    this.register(() => observer.disconnect());

    this.addCommand({
      id: "capture-idea",
      name: "Capture an idea",
      callback: () => {
        new CaptureIdeaModal(this.app, (text) => {
          void this.captureIdea(text);
        }).open();
      },
    });

    this.addCommand({
      id: "tick-factory",
      name: "Tick the Obsidian factory",
      callback: () => {
        void this.tickFactory();
      },
    });
    this.addRibbonIcon(
      "refresh-cw",
      "Tick the Obsidian factory",
      () => void this.tickFactory(),
    );
    this.addCommand({
      id: "archive-factory-card",
      name: "Archive factory card",
      checkCallback: (checking: boolean) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !isArchivablePath(file.path)) return false;
        if (!checking) this.openArchiveDialog(file);
        return true;
      },
    });
    this.addCommand({
      id: "unarchive-factory-card",
      name: "Unarchive factory card",
      checkCallback: (checking: boolean) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !isArchivedPath(file.path)) return false;
        if (!checking) void this.unarchiveCard(file);
        return true;
      },
    });
    this.addSettingTab(new FactorySettingTab(this.app, this));

    this.statusItem = this.addStatusBarItem();
    this.statusItem.addClass("factory-status");
    this.statusItem.setText("Factory: idle");
    this.statusItem.addEventListener("click", () => this.showLog());
    this.addCommand({
      id: "show-tick-log",
      name: "Show factory tick log",
      callback: () => this.showLog(),
    });
  }

  async loadSettings(): Promise<void> {
    this.settings = { ...DEFAULT_SETTINGS, ...(await this.loadData()) };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private async tickFactory(): Promise<void> {
    await this.loadSettings();
    if (this.tickRunning) {
      new Notice("Factory tick is already running.");
      this.showLog();
      return;
    }
    const repo = this.settings.repoPath.trim();
    if (!repo) {
      this.setStatus("Factory: needs repo path");
      new Notice(
        "The tick has no repo path. Run obsidian-board tick or set it in Settings -> Community plugins -> Obsidian Factory.",
      );
      return;
    }
    const factory = `${
      repo.replace(/\/+$/, "")
    }/models/@swamp/stagecraft/factory/obsidian-idea-factory.yaml`;
    let factoryDefinition = "";
    try {
      factoryDefinition = createHash("sha256")
        .update(readFileSync(factory))
        .digest("hex");
    } catch {
      new Notice(`Could not read ${factory}; ticking without a repin hash.`);
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
      `agent=${this.settings.agent || "pi"}`,
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
      `$ ${this.settings.swampBinary || "swamp"} ${args.join(" ")}\n\n`,
    );
    new Notice(
      "Obsidian factory tick started. Click the status bar for the log.",
    );
    const swamp = this.settings.swampBinary || "swamp";
    const env = { ...process.env, PATH: agentPath() };
    // Obsidian is usually launched from a desktop session, not your shell, so
    // its process environment does not contain the API keys you exported in
    // .bashrc (for example OLLAMA_API_KEY). Run swamp through the login shell
    // so the agent sees the same environment as a terminal tick. The command
    // is passed as "$0"/"$@" -- it is never interpolated into a shell string.
    const useLoginShell = process.platform !== "win32";
    const shell = process.env.SHELL || "/bin/bash";
    if (useLoginShell) {
      this.appendLog(
        `# via ${shell} -ic (loads your login environment)\n\n`,
      );
    }
    const child = useLoginShell
      ? spawn(
        shell,
        ["-ic", 'exec "$0" "$@"', swamp, ...args],
        { cwd: repo, env },
      )
      : spawn(swamp, args, { cwd: repo, env });
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
  private async captureIdea(text: string): Promise<void> {
    await this.loadSettings();
    const problem = captureTextProblem(text);
    if (problem) {
      new Notice(problem);
      return;
    }
    const repo = this.settings.repoPath.trim();
    if (!repo) {
      new Notice(
        "Capturing needs a swamp repo path. Set one in Settings -> Community plugins -> Obsidian Factory.",
      );
      return;
    }
    const payload = captureRequestBody(text);
    const child = spawn(
      this.settings.swampBinary || "swamp",
      [
        "behavior",
        "run",
        "obsidian-board",
        "capture",
        "--input",
        `text=${payload.text}`,
      ],
      { cwd: repo, env: { ...process.env, PATH: agentPath() } },
    );
    let output = "";
    child.stdout?.on("data", (data) => {
      output += data.toString();
    });
    child.stderr?.on("data", (data) => {
      output += data.toString();
    });
    child.on("error", (error) => {
      new Notice(`Capture failed: ${error.message}`);
    });
    child.on("close", (code) => {
      if (code === 0) {
        new Notice("Added to the inbox card in Uncharacterised.");
      } else {
        new Notice(
          `Capture failed (exit ${code}): ${
            output.trim().split("\n").slice(-3).join(" ")
          }`,
        );
      }
    });
  }

  private openArchiveDialog(file: TFile): void {
    new ArchiveCardModal(this.app, file, (outcome, reason, detail) => {
      void this.archiveCard(file, outcome, reason, detail);
    }).open();
  }

  /**
   * Archive one card through the board model: over the configured webhook when
   * there is one, otherwise through the archive workflow in the repo. The
   * plugin never writes the note itself.
   */
  private async archiveCard(
    file: TFile,
    outcome: ArchiveOutcome,
    reason: string,
    detail: string,
  ): Promise<void> {
    await this.loadSettings();
    const payload = archiveRequestBody(file.path, outcome, reason, detail);
    const problem = archiveRequestProblem(payload.outcome, payload.reason);
    if (problem) {
      new Notice(problem);
      return;
    }
    const url = this.settings.archiveWebhookUrl.trim();
    if (url) {
      const token = this.settings.archiveWebhookToken.trim();
      try {
        const response = await requestUrl({
          url,
          method: "POST",
          contentType: "application/json",
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          body: JSON.stringify(payload),
          throw: false,
        });
        if (response.status >= 200 && response.status < 300) {
          new Notice(`Archived ${file.basename} as ${payload.outcome}`);
        } else {
          new Notice(
            `Archive webhook failed: HTTP ${response.status} ${
              response.text.slice(0, 200)
            }`,
          );
        }
      } catch (error) {
        new Notice(
          `Archive webhook failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      return;
    }
    const repo = this.settings.repoPath.trim();
    if (!repo) {
      new Notice(
        "Archiving needs an archive webhook URL or a swamp repo path. Set one in Settings -> Community plugins -> Obsidian Factory.",
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
      `detail=${payload.detail}`,
    ];
    const child = spawn(
      this.settings.swampBinary || "swamp",
      args,
      { cwd: repo, env: { ...process.env, PATH: agentPath() } },
    );
    let output = "";
    child.stdout?.on("data", (data) => {
      output += data.toString();
    });
    child.stderr?.on("data", (data) => {
      output += data.toString();
    });
    child.on("error", (error) => {
      new Notice(`Archive failed: ${error.message}`);
    });
    child.on("close", (code) => {
      if (code === 0) {
        new Notice(`Archived ${file.basename} as ${payload.outcome}`);
      } else {
        new Notice(
          `Archive failed (exit ${code}): ${
            output.trim().split("\n").slice(-3).join(" ")
          }`,
        );
      }
    });
  }

  /**
   * Restore one archived card through the board model. Like archive, this runs
   * the workflow and never writes the note itself.
   */
  private async unarchiveCard(file: TFile): Promise<void> {
    await this.loadSettings();
    const repo = this.settings.repoPath.trim();
    if (!repo) {
      new Notice(
        "Unarchiving needs a swamp repo path. Set one in Settings -> Community plugins -> Obsidian Factory.",
      );
      return;
    }
    const child = spawn(
      this.settings.swampBinary || "swamp",
      [
        "workflow",
        "run",
        "@svendowideit/obsidian-factory-unarchive",
        "--input",
        `id=${file.path}`,
      ],
      { cwd: repo, env: { ...process.env, PATH: agentPath() } },
    );
    let output = "";
    child.stdout?.on("data", (data) => {
      output += data.toString();
    });
    child.stderr?.on("data", (data) => {
      output += data.toString();
    });
    child.on("error", (error) => {
      new Notice(`Unarchive failed: ${error.message}`);
    });
    child.on("close", (code) => {
      if (code === 0) {
        new Notice(`Restored ${file.basename} to the board`);
      } else {
        new Notice(
          `Unarchive failed (exit ${code}): ${
            output.trim().split("\n").slice(-3).join(" ")
          }`,
        );
      }
    });
  }

  private setStatus(text: string): void {
    this.statusItem?.setText(text);
  }

  private startTickTimer(): void {
    this.stopTickTimer();
    const tick = () => {
      const seconds = Math.floor((Date.now() - this.tickStartedAt) / 1000);
      const tail = this.tickLastLine
        ? ` | ${this.tickLastLine.slice(0, 70)}`
        : "";
      this.setStatus(`Factory: ticking ${seconds}s${tail}`);
    };
    tick();
    this.tickTimer = globalThis.setInterval(tick, 1000);
  }

  private stopTickTimer(): void {
    if (this.tickTimer !== null) {
      globalThis.clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  private appendLog(text: string): void {
    if (!text) return;
    this.tickLog += text;
    if (this.tickLog.length > 200_000) {
      this.tickLog = this.tickLog.slice(-200_000);
    }
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(
      Boolean,
    );
    if (lines.length > 0) {
      const ansi = new RegExp(
        `${String.fromCharCode(27)}\\[[0-9;]*m`,
        "g",
      );
      this.tickLastLine = lines[lines.length - 1].replace(ansi, "");
    }
  }

  private finishTick(ok: boolean, detail: string): void {
    this.tickRunning = false;
    this.stopTickTimer();
    this.setStatus(ok ? "Factory: done" : "Factory: failed");
    this.appendLog(`\n${ok ? "✓" : "✗"} ${detail}\n`);
    new Notice(
      ok
        ? "Factory tick finished. Click the status bar to read the log."
        : `Factory tick failed: ${detail}`,
    );
    if (!ok) this.showLog();
  }

  private showLog(): void {
    if (!this.tickLog) {
      new Notice("No factory tick has run yet.");
      return;
    }
    new TickLogModal(this.app, () => this.tickLog).open();
  }
  override onunload(): void {
    if (this.originalOpenLinkText) {
      (this.app.workspace as unknown as WorkspaceWithOpenLinkText)
        .openLinkText = this.originalOpenLinkText;
      this.originalOpenLinkText = null;
    }
  }

  private cardStatus(file: TFile): string {
    const cache = this.app.metadataCache.getFileCache(file);
    return statusFromFrontmatter(cache?.frontmatter);
  }

  private async moveCard(file: TFile, status: string): Promise<void> {
    await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
      frontmatter.status = status;
    });
    new Notice(`Moved ${file.basename} to ${status}`);
    this.decorateCards();
  }

  private decorateCards(): void {
    this.decorateBoardNote();
    this.decorateCaptureBoxes();
    const cards = Array.from(
      document.querySelectorAll<HTMLElement>(".bases-kanban-card"),
    );
    if (cards.length === 0) return;
    const byTitle = this.cardFilesByTitle();
    for (const cardEl of cards) {
      if (cardEl.dataset.factoryMoves === "1") continue;
      const titleEl = cardEl.querySelector(
        ".bases-kanban-card-property.mod-title .bases-kanban-card-line",
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
    // The fields pass runs after the moves pass, so the moves row keeps the
    // top of the card and the fields block is stable whatever order the
    // workspace hooks fire in.
    this.decorateCardFields(byTitle);
  }

  /** Map each card's human title to its vault file, for the kanban cards. */
  private cardFilesByTitle(): Map<string, TFile> {
    const byTitle = new Map<string, TFile>();
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!isCardPath(file.path)) continue;
      const cache = this.app.metadataCache.getFileCache(file);
      const frontmatter = cache?.frontmatter;
      const title = frontmatter && typeof frontmatter === "object" &&
          typeof (frontmatter as { title?: unknown }).title === "string"
        ? (frontmatter as { title: string }).title
        : file.basename.replace(/^FAC-\d+\s+/, "");
      byTitle.set(title.trim().toLowerCase(), file);
    }
    return byTitle;
  }

  /**
   * Put the fields that matter for each card's column on the kanban card face
   * and hide the four rows they replace.
   *
   * This pass is separate from the moves pass on purpose: a card in Done,
   * Category or Uncharacterised has no legal move, so a fields block rendered
   * inside that loop would never appear on it. It reads the card and writes
   * nothing: obsidian-board stays the only writer of the managed sections.
   */
  private decorateCardFields(byTitle: Map<string, TFile>): void {
    const cards = Array.from(
      document.querySelectorAll<HTMLElement>(".bases-kanban-card"),
    );
    for (const cardEl of cards) {
      void this.decorateCardFieldsOne(cardEl, byTitle);
    }
  }

  private async decorateCardFieldsOne(
    cardEl: HTMLElement,
    byTitle: Map<string, TFile>,
  ): Promise<void> {
    const titleEl = cardEl.querySelector(
      ".bases-kanban-card-property.mod-title .bases-kanban-card-line",
    ) ?? cardEl.querySelector(".bases-kanban-card-line");
    const title = titleEl?.textContent?.trim() ?? "";
    const file = byTitle.get(title.toLowerCase());
    if (!file) return;
    // Mark the file before the first await: the observer fires often enough
    // for two passes to overlap the read, and a second block would stack.
    if (this.fieldPassInFlight.has(file.path)) return;
    this.fieldPassInFlight.add(file.path);
    try {
      const raw = await this.app.vault.cachedRead(file);
      if (!cardEl.isConnected) return;
      const frontmatter = this.app.metadataCache.getFileCache(file)
        ?.frontmatter;
      const status = statusFromFrontmatter(frontmatter);
      const project = frontmatter && typeof frontmatter === "object" &&
          typeof (frontmatter as { project?: unknown }).project === "string"
        ? (frontmatter as { project: string }).project
        : "";
      const updated = frontmatter && typeof frontmatter === "object" &&
          typeof (frontmatter as { updated?: unknown }).updated === "string"
        ? (frontmatter as { updated: string }).updated
        : "";
      this.hideSupersededRows(cardEl);
      const fields = columnFields(status, raw, project);
      const signature = `${updated}|${fields.length}`;
      const existing = cardEl.querySelector<HTMLElement>(
        ".factory-card-fields",
      );
      if (existing?.dataset.factoryFieldsKey === signature) return;
      existing?.remove();
      if (fields.length === 0) return;
      const block = document.createElement("div");
      block.className = "factory-card-fields";
      block.dataset.factoryFieldsKey = signature;
      for (const field of fields) {
        const row = document.createElement("div");
        row.className = "factory-card-field";
        const label = document.createElement("span");
        label.className = "factory-card-field-label";
        label.textContent = field.label;
        const value = document.createElement("span");
        value.className = "factory-card-field-value";
        value.textContent = field.value;
        row.appendChild(label);
        row.appendChild(value);
        block.appendChild(row);
      }
      const moves = cardEl.querySelector(".factory-card-moves");
      if (moves) cardEl.insertBefore(block, moves.nextSibling);
      else cardEl.prepend(block);
      cardEl.dataset.factoryFields = "1";
    } catch {
      // A card that vanished or failed to read gets no block this pass and is
      // retried on the next one: the finally below clears the in-flight mark.
    } finally {
      this.fieldPassInFlight.delete(file.path);
    }
  }

  /** Hide the four property rows the fields block replaces. */
  private hideSupersededRows(cardEl: HTMLElement): void {
    const rows = Array.from(
      cardEl.querySelectorAll<HTMLElement>(".bases-kanban-card-property"),
    );
    for (const row of rows) {
      const label = row.querySelector(
        ".bases-kanban-card-property-label, .bases-kanban-card-property-name",
      )?.textContent ?? row.getAttribute("aria-label") ?? "";
      if (!isSupersededPropertyRow(Array.from(row.classList), label)) continue;
      row.classList.add("factory-card-field-hidden");
    }
  }

  /**
   * Put the capture box on the kanban board page: the Board view is a Bases
   * Kanban, and the native view cannot host an input widget, so the plugin
   * adds the box above the columns. The box submits through captureIdea, so
   * obsidian-board stays the only writer of the inbox note.
   */
  /** Add the capture form to a container. */
  private addCaptureForm(parent: HTMLElement): HTMLElement {
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
      text: "Lands on the inbox card in Uncharacterised",
    });
    return form;
  }

  /** True when the active note is the Board page itself. */
  private boardNoteActive(): boolean {
    const file = this.app.workspace.getActiveFile();
    return Boolean(file && isBoardPath(file.path));
  }

  /**
   * Put the capture box on the Board note page. This is the reliable anchor:
   * it does not depend on the Bases kanban's internal DOM. It is inserted
   * after the page title, before the embedded board.
   */
  private decorateBoardNote(): void {
    if (!this.boardNoteActive()) return;
    const leaf = document.querySelector(".workspace-leaf.mod-active");
    if (!leaf) return;
    const preview = leaf.querySelector<HTMLElement>(
      ".markdown-preview-view",
    );
    const view = preview ??
      leaf.querySelector<HTMLElement>(
        ".markdown-source-view .cm-scroller",
      );
    if (!view) return;
    // Check the DOM, not only a data attribute: Obsidian may replace the
    // preview/scroller element, which would make the old attribute useless.
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
  private decorateCaptureBoxes(): void {
    if (this.boardNoteActive()) return;
    const containers = new Set<HTMLElement>();
    for (
      const card of Array.from(
        document.querySelectorAll<HTMLElement>(".bases-kanban-card"),
      )
    ) {
      const container = card.closest<HTMLElement>(".bases-view") ??
        card.closest<HTMLElement>(".bases-kanban");
      if (container) containers.add(container);
    }
    for (const container of containers) {
      if (container.querySelector(".factory-capture")) continue;
      const form = this.addCaptureForm(container);
      container.prepend(form);
    }
  }

  private async onClick(event: MouseEvent): Promise<void> {
    if (
      event.defaultPrevented || event.button !== 0 || event.metaKey ||
      event.ctrlKey || event.altKey || event.shiftKey
    ) {
      return;
    }
    const target = event.target as HTMLElement | null;
    const link = target?.closest(
      "a.internal-link, a[data-href]",
    ) as HTMLAnchorElement | null;
    if (!link) return;
    const href = link.getAttribute("data-href") ?? link.getAttribute("href") ??
      "";
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

  private async openCard(file: TFile): Promise<void> {
    try {
      const raw = await this.app.vault.read(file);
      new CardDialog(
        this.app,
        file,
        readableCard(raw),
        raw,
        isArchivablePath(file.path)
          ? () => this.openArchiveDialog(file)
          : undefined,
      ).open();
    } catch (error) {
      new Notice(
        `Could not open ${file.basename}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    new Notice("Copied to clipboard");
  } catch (error) {
    new Notice(
      `Could not copy: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

class CardDialog extends Modal {
  constructor(
    app: App,
    private file: TFile,
    private card: ReturnType<typeof readableCard>,
    private raw: string,
    private onArchive?: () => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.modalEl.addClass("factory-card-dialog");
    this.titleEl.setText(this.card.title || this.file.basename);

    const topActions = this.contentEl.createDiv({
      cls: "factory-dialog-moves",
    });
    const frontmatter = this.app.metadataCache.getFileCache(this.file)
      ?.frontmatter;
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
            },
          ).then(() => {
            new Notice(`Moved to ${move}`);
            this.close();
          });
        });
      }
    }
    const openInEditor = topActions.createEl("button", {
      text: "Open in editor",
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
      cls: "factory-dialog-section factory-dialog-summary",
    });
    if (this.card.summary) {
      void this.render(summary, this.card.summary);
    } else {
      summary.createEl("p", {
        text: "This card has no At a glance section yet.",
      });
    }

    if (this.card.brief) {
      const brief = this.contentEl.createDiv({
        cls: "factory-dialog-section factory-dialog-brief",
      });
      brief.createEl("h3", { text: "Brief" });
      void this.render(brief, this.card.brief);
    }

    if (this.card.plan) {
      const plan = this.contentEl.createDiv({
        cls: "factory-dialog-section factory-dialog-plan",
      });
      void this.render(plan, this.card.plan);
    }

    const actions = this.contentEl.createDiv({
      cls: "factory-dialog-actions",
    });
    const copy = actions.createEl("button", { text: "Copy card markdown" });
    copy.addEventListener("click", () => {
      void copyToClipboard(this.raw);
    });
    const close = actions.createEl("button", { text: "Close" });
    close.addEventListener("click", () => this.close());
  }

  private async render(parent: HTMLElement, markdown: string): Promise<void> {
    await MarkdownRenderer.render(
      this.app,
      sanitizeMarkdown(markdown),
      parent,
      this.file.path,
      this,
    );
    this.sanitizeDom(parent);
  }

  private sanitizeDom(parent: HTMLElement): void {
    for (
      const el of Array.from(
        parent.querySelectorAll("script, iframe, object, embed, style"),
      )
    ) {
      el.remove();
    }
    for (const el of Array.from(parent.querySelectorAll("*"))) {
      if (!(el instanceof HTMLElement)) continue;
      for (const attribute of Array.from(el.attributes)) {
        if (
          /^on/i.test(attribute.name) ||
          /^\s*javascript:/i.test(attribute.value)
        ) {
          el.removeAttribute(attribute.name);
        }
      }
    }
  }
}

/**
 * Ask for the archive outcome, the reason and an optional detail, then hand
 * them to the board model. The plugin never writes the note itself.
 */
class ArchiveCardModal extends Modal {
  constructor(
    app: App,
    private file: TFile,
    private onSubmit: (
      outcome: ArchiveOutcome,
      reason: string,
      detail: string,
    ) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.modalEl.addClass("factory-archive-dialog");
    this.titleEl.setText(`Archive ${this.file.basename}`);
    const form = this.contentEl.createDiv({ cls: "factory-archive-form" });
    form.createEl("p", {
      text:
        "The card leaves the board and keeps its whole note in the Archive folder: what happened, why, and when.",
    });

    const outcomeRow = form.createDiv({
      cls: "factory-archive-row",
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
      cls: "factory-dialog-actions",
    });
    const submit = actions.createEl("button", { text: "Archive" });
    submit.addEventListener("click", () => {
      const outcome = select.value as ArchiveOutcome;
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
}

/**
 * The command-palette capture fallback: type one thought, then hand it to the
 * board model. The dialog never writes the note itself, and it refuses empty
 * text so a blank idea cannot land in the inbox.
 */
class CaptureIdeaModal extends Modal {
  constructor(app: App, private onSubmit: (text: string) => void) {
    super(app);
  }

  override onOpen(): void {
    this.modalEl.addClass("factory-capture-dialog");
    this.titleEl.setText("Capture an idea");
    const form = this.contentEl.createDiv({ cls: "factory-capture-form" });
    form.createEl("p", {
      text:
        "The thought lands on the inbox card in Uncharacterised; the next tick routes it to a category.",
    });
    const input = form.createEl("textarea");
    input.rows = 3;
    input.placeholder = CAPTURE_PLACEHOLDER;
    const error = form.createEl("p", { cls: "factory-capture-error" });
    const actions = this.contentEl.createDiv({
      cls: "factory-dialog-actions",
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
}

class TickLogModal extends Modal {
  private logEl: HTMLElement | null = null;
  private timer: number | null = null;
  private pauseButton: HTMLButtonElement | null = null;
  private paused = false;
  private lastLog = "";

  constructor(app: App, private getLog: () => string) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText("Factory tick log");
    const actions = this.contentEl.createDiv({
      cls: "factory-dialog-actions factory-tick-log-actions",
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

  private selectionInsideLog(): boolean {
    const selection = document.getSelection();
    if (!selection || selection.isCollapsed || !this.logEl) return false;
    return this.logEl.contains(selection.anchorNode) ||
      this.logEl.contains(selection.focusNode);
  }

  private refresh(): void {
    if (!this.logEl || this.paused) return;
    const log = this.getLog();
    if (log === this.lastLog) return;
    this.lastLog = log;
    // Never destroy a selection the user is making while the tick streams.
    if (this.selectionInsideLog()) return;
    this.logEl.setText(log || "No tick output yet.");
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  override onClose(): void {
    if (this.timer !== null) globalThis.clearInterval(this.timer);
    this.timer = null;
    this.pauseButton = null;
    this.contentEl.empty();
  }
}

class FactorySettingTab extends PluginSettingTab {
  plugin: ObsidianFactoryPlugin;

  constructor(app: App, plugin: ObsidianFactoryPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl)
      .setName("Swamp repo path")
      .setDesc("Absolute path to the swamp repository that owns the board.")
      .addText((text: TextComponent) =>
        text
          .setPlaceholder("/home/me/src/swamp-project")
          .setValue(this.plugin.settings.repoPath)
          .onChange(async (value) => {
            this.plugin.settings.repoPath = value.trim();
            await this.plugin.saveSettings();
          })
      );
    new Setting(containerEl)
      .setName("Swamp binary")
      .setDesc("The swamp executable used by the Tick button.")
      .addText((text: TextComponent) =>
        text
          .setPlaceholder("swamp")
          .setValue(this.plugin.settings.swampBinary)
          .onChange(async (value) => {
            this.plugin.settings.swampBinary = value.trim() || "swamp";
            await this.plugin.saveSettings();
          })
      );
    new Setting(containerEl)
      .setName("Agent")
      .setDesc(
        "Headless agent for the tick: pi, claude, codex, opencode or kilo.",
      )
      .addText((text: TextComponent) =>
        text
          .setPlaceholder("pi")
          .setValue(this.plugin.settings.agent)
          .onChange(async (value) => {
            this.plugin.settings.agent = value.trim() || "pi";
            await this.plugin.saveSettings();
          })
      );
    new Setting(containerEl)
      .setName("Archive webhook URL")
      .setDesc(
        "Optional swamp serve webhook for archiving, e.g. https://swamp.example/hooks/obsidian-archive. Empty archives through the repo path instead.",
      )
      .addText((text: TextComponent) =>
        text
          .setPlaceholder("https://swamp.example/hooks/obsidian-archive")
          .setValue(this.plugin.settings.archiveWebhookUrl)
          .onChange(async (value) => {
            this.plugin.settings.archiveWebhookUrl = value.trim();
            await this.plugin.saveSettings();
          })
      );
    new Setting(containerEl)
      .setName("Archive webhook token")
      .setDesc(
        "Bearer token for the archive webhook; stored in data.json. Leave empty for a local, tokenless route.",
      )
      .addText((text: TextComponent) =>
        text
          .setPlaceholder("")
          .setValue(this.plugin.settings.archiveWebhookToken)
          .onChange(async (value) => {
            this.plugin.settings.archiveWebhookToken = value.trim();
            await this.plugin.saveSettings();
          })
      );
    new Setting(containerEl)
      .setName("Model")
      .setDesc("Optional provider/model for the agent; empty uses its default.")
      .addText((text: TextComponent) =>
        text
          .setPlaceholder("")
          .setValue(this.plugin.settings.model)
          .onChange(async (value) => {
            this.plugin.settings.model = value.trim();
            await this.plugin.saveSettings();
          })
      );
  }
}
