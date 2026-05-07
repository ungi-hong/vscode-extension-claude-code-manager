import { EventEmitter } from "events";
import * as path from "path";
import * as vscode from "vscode";

const STORAGE_KEY = "ccmgr.registeredFolders";

export interface FolderEntry {
  cwd: string;
  /** ユーザー編集可能な表示名 (空なら basename) */
  label?: string;
  /** "user" = 手動追加 / "workspace" = 現在の VSCode workspace から自動取り込み */
  source: "user" | "workspace";
}

export declare interface FolderStore {
  on(event: "changed", listener: () => void): this;
}

/**
 * 登録フォルダ (≒ Claude セッションをグルーピングしたい cwd) の管理。
 * - 手動追加した分は globalState に永続化
 * - 現在の VSCode workspace folder は常に自動取り込み (重複は排除)
 */
export class FolderStore extends EventEmitter {
  private userFolders: Map<string, FolderEntry> = new Map();
  private workspaceFolders: Map<string, FolderEntry> = new Map();
  private workspaceListener?: vscode.Disposable;

  constructor(private readonly state: vscode.Memento) {
    super();
    const stored = state.get<FolderEntry[]>(STORAGE_KEY, []);
    for (const f of stored) {
      this.userFolders.set(f.cwd, { ...f, source: "user" });
    }
    this.refreshWorkspace();
    this.workspaceListener = vscode.workspace.onDidChangeWorkspaceFolders(() => {
      this.refreshWorkspace();
      this.emit("changed");
    });
  }

  dispose(): void {
    this.workspaceListener?.dispose();
  }

  list(): FolderEntry[] {
    const merged = new Map<string, FolderEntry>();
    for (const [cwd, f] of this.workspaceFolders) merged.set(cwd, f);
    // user-added が優先 (label を保持)
    for (const [cwd, f] of this.userFolders) merged.set(cwd, f);
    return Array.from(merged.values()).sort((a, b) =>
      labelOf(a).localeCompare(labelOf(b)),
    );
  }

  has(cwd: string): boolean {
    return this.userFolders.has(cwd) || this.workspaceFolders.has(cwd);
  }

  async add(cwd: string, label?: string): Promise<void> {
    const normalized = path.resolve(cwd);
    if (this.userFolders.has(normalized)) return;
    this.userFolders.set(normalized, {
      cwd: normalized,
      label,
      source: "user",
    });
    await this.persist();
    this.emit("changed");
  }

  async remove(cwd: string): Promise<void> {
    if (!this.userFolders.has(cwd)) return;
    this.userFolders.delete(cwd);
    await this.persist();
    this.emit("changed");
  }

  async rename(cwd: string, label: string): Promise<void> {
    const f = this.userFolders.get(cwd);
    if (!f) return;
    this.userFolders.set(cwd, { ...f, label });
    await this.persist();
    this.emit("changed");
  }

  private refreshWorkspace(): void {
    this.workspaceFolders.clear();
    for (const wf of vscode.workspace.workspaceFolders ?? []) {
      const cwd = wf.uri.fsPath;
      this.workspaceFolders.set(cwd, {
        cwd,
        label: wf.name,
        source: "workspace",
      });
    }
  }

  private async persist(): Promise<void> {
    const entries = Array.from(this.userFolders.values());
    await this.state.update(STORAGE_KEY, entries);
  }
}

export const labelOf = (f: FolderEntry): string =>
  f.label && f.label.trim().length > 0 ? f.label : path.basename(f.cwd);
