// @ts-nocheck: Obsidian resolves the module at runtime; the local obsidian.d.ts is for the editor and esbuild bundles the file.
/// <reference lib="dom" />
/// <reference path="./obsidian.d.ts" />
import { App, MarkdownRenderer, Modal, Notice, Plugin, TFile } from "obsidian";
import {
  isCardPath,
  movesForStatus,
  readableCard,
  sanitizeMarkdown,
  shouldInterceptCardOpen,
  STATUSES,
  statusFromFrontmatter,
} from "./model.ts";

/** Open factory cards in a read-only prose dialog instead of navigating away. */
type OpenLinkText = (
  linktext: string,
  sourcePath: string,
  newLeaf?: boolean,
  openViewState?: unknown,
) => Promise<void>;

type WorkspaceWithOpenLinkText = { openLinkText: OpenLinkText };

export default class ObsidianFactoryPlugin extends Plugin {
  private originalOpenLinkText: OpenLinkText | null = null;

  override onload(): void {
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
    const cards = Array.from(
      document.querySelectorAll<HTMLElement>(".bases-kanban-card"),
    );
    if (cards.length === 0) return;
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
      new CardDialog(this.app, file, readableCard(raw)).open();
    } catch (error) {
      new Notice(
        `Could not open ${file.basename}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

class CardDialog extends Modal {
  constructor(
    app: App,
    private file: TFile,
    private card: ReturnType<typeof readableCard>,
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
