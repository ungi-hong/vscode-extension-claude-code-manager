import * as vscode from "vscode";
import { EventEmitter } from "events";

const STORAGE_KEY = "ccmgr.hiddenSessions";

export declare interface HiddenStore {
  on(event: "changed", listener: () => void): this;
}

export class HiddenStore extends EventEmitter {
  private hidden: Set<string>;

  constructor(private readonly state: vscode.Memento) {
    super();
    const stored = state.get<string[]>(STORAGE_KEY, []);
    this.hidden = new Set(stored);
  }

  has(sessionId: string): boolean {
    return this.hidden.has(sessionId);
  }

  list(): string[] {
    return Array.from(this.hidden);
  }

  size(): number {
    return this.hidden.size;
  }

  async add(sessionId: string): Promise<void> {
    if (this.hidden.has(sessionId)) return;
    this.hidden.add(sessionId);
    await this.persist();
    this.emit("changed");
  }

  async remove(sessionId: string): Promise<void> {
    if (!this.hidden.has(sessionId)) return;
    this.hidden.delete(sessionId);
    await this.persist();
    this.emit("changed");
  }

  async clear(): Promise<void> {
    if (this.hidden.size === 0) return;
    this.hidden.clear();
    await this.persist();
    this.emit("changed");
  }

  private async persist(): Promise<void> {
    await this.state.update(STORAGE_KEY, Array.from(this.hidden));
  }
}
