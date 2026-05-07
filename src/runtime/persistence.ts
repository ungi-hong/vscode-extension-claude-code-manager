import { EventEmitter } from "events";
import * as vscode from "vscode";

const STORAGE_KEY = "ccmgr.managedSessions";

export interface ManagedSnapshot {
  sessionId: string;
  cwd: string;
  /** 最後に Tree や Webview のヒントへ出すための直前情報。任意。 */
  lastUserPrompt?: string;
  lastAssistantText?: string;
  /** 最後に SDK プロセスが落ちた時刻 (再起動後の表示で使用)。 */
  suspendedAt?: number;
}

export declare interface ManagedSessionStore {
  on(event: "changed", listener: () => void): this;
}

/**
 * 拡張内で起動した managed セッションを VSCode 再起動を跨いで覚えておく。
 *
 * - `pending-*` の暫定 id は永続化しない
 * - 確定 sessionId のみを保存し、再起動後は「中断中」として Tree に並ぶ
 * - 実体 (claude プロセス) は ProcessManager が管理し、ここは "メモ" に専念
 */
export class ManagedSessionStore extends EventEmitter {
  private map = new Map<string, ManagedSnapshot>();

  constructor(private readonly state: vscode.Memento) {
    super();
    const stored = state.get<ManagedSnapshot[]>(STORAGE_KEY, []);
    for (const s of stored) {
      if (typeof s?.sessionId === "string" && typeof s?.cwd === "string") {
        this.map.set(s.sessionId, s);
      }
    }
  }

  list(): ManagedSnapshot[] {
    return Array.from(this.map.values());
  }

  has(sessionId: string): boolean {
    return this.map.has(sessionId);
  }

  get(sessionId: string): ManagedSnapshot | undefined {
    return this.map.get(sessionId);
  }

  async record(snapshot: ManagedSnapshot): Promise<void> {
    if (snapshot.sessionId.startsWith("pending-")) return;
    const existing = this.map.get(snapshot.sessionId);
    this.map.set(snapshot.sessionId, { ...existing, ...snapshot });
    await this.persist();
    this.emit("changed");
  }

  async update(
    sessionId: string,
    fields: Partial<ManagedSnapshot>,
  ): Promise<void> {
    const existing = this.map.get(sessionId);
    if (!existing) return;
    this.map.set(sessionId, { ...existing, ...fields });
    await this.persist();
    this.emit("changed");
  }

  async rename(oldSessionId: string, newSessionId: string): Promise<void> {
    if (oldSessionId === newSessionId) return;
    const existing = this.map.get(oldSessionId);
    if (!existing) return;
    this.map.delete(oldSessionId);
    this.map.set(newSessionId, { ...existing, sessionId: newSessionId });
    await this.persist();
    this.emit("changed");
  }

  async remove(sessionId: string): Promise<void> {
    if (!this.map.has(sessionId)) return;
    this.map.delete(sessionId);
    await this.persist();
    this.emit("changed");
  }

  async clear(): Promise<void> {
    if (this.map.size === 0) return;
    this.map.clear();
    await this.persist();
    this.emit("changed");
  }

  private async persist(): Promise<void> {
    await this.state.update(STORAGE_KEY, Array.from(this.map.values()));
  }
}
