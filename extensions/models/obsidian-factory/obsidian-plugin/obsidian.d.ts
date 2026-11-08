/// <reference lib="dom" />
declare module "obsidian" {
  export class Plugin {
    app: App;
    onload(): void;
    onunload(): void;
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
    }): void;
  }
  export class App {
    workspace: Workspace;
    vault: Vault;
    metadataCache: MetadataCache;
  }
  export class Workspace {
    getActiveFile(): TFile | null;
    getLeaf(): WorkspaceLeaf;
  }
  export class WorkspaceLeaf {
    openFile(file: TFile): Promise<void>;
  }
  export class Vault {
    read(file: TFile): Promise<string>;
  }
  export class MetadataCache {
    getFirstLinkpathDest(link: string, source: string): TFile | null;
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
  export class Notice {
    constructor(message: string);
  }
}
