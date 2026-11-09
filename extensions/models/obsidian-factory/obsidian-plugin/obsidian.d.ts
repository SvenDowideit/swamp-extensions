/// <reference lib="dom" />
declare module "obsidian" {
  export class Plugin {
    app: App;
    onload(): void;
    onunload(): void;
    registerEvent(eventRef: unknown): void;
    registerInterval(id: number): number;
    registerDomEvent(
      el: Document,
      type: string,
      callback: (evt: MouseEvent) => void,
      capture?: boolean,
    ): void;
    addCommand(command: {
      id: string;
      name: string;
      checkCallback?: (checking: boolean) => boolean | void;
      callback?: () => void;
    }): void;
    addRibbonIcon(
      icon: string,
      title: string,
      callback: () => void,
    ): HTMLElement;
    addSettingTab(tab: PluginSettingTab): void;
    addStatusBarItem(): HTMLElement;
    loadData(): Promise<unknown>;
    saveData(data: unknown): Promise<void>;
  }
  export class App {
    workspace: Workspace;
    vault: Vault;
    metadataCache: MetadataCache;
    fileManager: FileManager;
  }
  export class Workspace {
    getActiveFile(): TFile | null;
    getLeaf(): WorkspaceLeaf;
    on(name: string, callback: () => void): unknown;
    onLayoutReady(callback: () => void): void;
    openLinkText(
      linktext: string,
      sourcePath: string,
      newLeaf?: boolean,
      openViewState?: unknown,
    ): Promise<void>;
  }
  export class WorkspaceLeaf {
    openFile(file: TFile): Promise<void>;
  }
  export class Vault {
    read(file: TFile): Promise<string>;
    getMarkdownFiles(): TFile[];
  }
  export class MetadataCache {
    getFirstLinkpathDest(link: string, source: string): TFile | null;
    getFileCache(file: TFile): { frontmatter?: unknown } | null;
  }
  export class TFile {
    path: string;
    basename: string;
  }
  export class Modal {
    app: App;
    containerEl: HTMLElement;
    contentEl: HTMLElement;
    titleEl: HTMLElement;
    modalEl: HTMLElement;
    constructor(app: App);
    open(): void;
    close(): void;
    onOpen(): void;
    onClose(): void;
  }
  export class MarkdownRenderer {
    static render(
      app: App,
      markdown: string,
      el: HTMLElement,
      sourcePath: string,
      component: unknown,
    ): Promise<void>;
  }
  export class FileManager {
    processFrontMatter(
      file: TFile,
      callback: (frontmatter: Record<string, unknown>) => void,
    ): Promise<void>;
  }
  export class Notice {
    constructor(message: string);
  }
  export interface RequestUrlParam {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    contentType?: string;
    throw?: boolean;
  }
  export interface RequestUrlResponse {
    status: number;
    text: string;
    json: unknown;
  }
  export function requestUrl(
    request: RequestUrlParam,
  ): Promise<RequestUrlResponse>;
  export class TextComponent {
    setPlaceholder(value: string): TextComponent;
    setValue(value: string): TextComponent;
    onChange(callback: (value: string) => void | Promise<void>): TextComponent;
  }
  export class Setting {
    constructor(containerEl: HTMLElement);
    setName(value: string): Setting;
    setDesc(value: string): Setting;
    addText(callback: (text: TextComponent) => void): Setting;
  }
  export class PluginSettingTab {
    app: App;
    containerEl: HTMLElement;
    constructor(app: App, plugin: Plugin);
    display(): void;
  }
}
