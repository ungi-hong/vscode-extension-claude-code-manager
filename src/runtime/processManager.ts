import { EventEmitter } from "events";
import { randomUUID } from "crypto";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeProcess } from "./claudeProcess";

export interface CreateResult {
  /**
   * SDK の init 受信前は `pending-<uuid>`、受信後は確定 sessionId に置き換わる。
   * Webview や Tree はこの id を使って参照する。
   */
  id: string;
  process: ClaudeProcess;
}

export declare interface ProcessManager {
  on(
    event: "promoted",
    listener: (info: { pendingId: string; sessionId: string }) => void,
  ): this;
  on(event: "message", listener: (id: string, msg: SDKMessage) => void): this;
  on(event: "disposed", listener: (id: string) => void): this;
  on(event: "error", listener: (id: string, err: Error) => void): this;
}

/**
 * `Map<id, ClaudeProcess>` を保持し、新規/resume を一手に管理する。
 * id は最初は pending-* で、SDK の system.init 受信後に確定 sessionId へ rename。
 */
export class ProcessManager extends EventEmitter {
  /** id (pending or confirmed) → ClaudeProcess */
  private map = new Map<string, ClaudeProcess>();
  /** pendingId → confirmed sessionId (init 受信後に登録) */
  private pendingToSid = new Map<string, string>();
  /** 拡張が管理している = managed なすべての sessionId */
  private managedSids = new Set<string>();

  create(cwd: string): CreateResult {
    const pendingId = `pending-${randomUUID()}`;
    const proc = new ClaudeProcess({ cwd });
    this.wire(pendingId, proc);
    this.map.set(pendingId, proc);
    proc.start();
    return { id: pendingId, process: proc };
  }

  resume(sessionId: string, cwd: string): CreateResult {
    if (this.map.has(sessionId)) {
      return { id: sessionId, process: this.map.get(sessionId)! };
    }
    const proc = new ClaudeProcess({ cwd, resumeSessionId: sessionId });
    this.wire(sessionId, proc);
    this.map.set(sessionId, proc);
    this.managedSids.add(sessionId);
    proc.start();
    return { id: sessionId, process: proc };
  }

  get(id: string): ClaudeProcess | undefined {
    return this.map.get(id);
  }

  has(id: string): boolean {
    return this.map.has(id);
  }

  /** 確定済みの sessionId が拡張管理下か (= managed) */
  isManaged(sessionId: string): boolean {
    return this.managedSids.has(sessionId);
  }

  send(id: string, text: string): boolean {
    return this.get(id)?.send(text) ?? false;
  }

  async interrupt(id: string): Promise<void> {
    const proc = this.map.get(id);
    if (!proc) return;
    await proc.interrupt();
  }

  async dispose(id: string): Promise<void> {
    const proc = this.map.get(id);
    if (!proc) return;
    await proc.dispose();
  }

  async disposeAll(): Promise<void> {
    const all = Array.from(this.map.values());
    await Promise.all(all.map((p) => p.dispose()));
  }

  private wire(initialId: string, proc: ClaudeProcess): void {
    proc.on("init", (sid) => {
      const isPending = initialId.startsWith("pending-");
      if (isPending && sid !== initialId) {
        this.pendingToSid.set(initialId, sid);
        this.map.delete(initialId);
        this.map.set(sid, proc);
        this.managedSids.add(sid);
        this.emit("promoted", { pendingId: initialId, sessionId: sid });
      } else if (!isPending) {
        this.managedSids.add(sid);
      }
    });
    proc.on("message", (msg) => {
      const id = this.idFor(initialId);
      this.emit("message", id, msg);
    });
    proc.on("error", (err) => {
      const id = this.idFor(initialId);
      this.emit("error", id, err);
    });
    proc.on("disposed", () => {
      // idFor は pendingToSid を参照するため、削除前に必ず解決する。
      const confirmedId = this.idFor(initialId);
      this.map.delete(confirmedId);
      // managedSids には残してもよいが、resume するまで無効。
      // ここでは即座に外して再 spawn 時に再登録する。
      this.managedSids.delete(confirmedId);
      this.pendingToSid.delete(initialId);
      this.emit("disposed", confirmedId);
      // EventEmitter 経由のリスナを残すと proc が GC されないため明示的に外す。
      proc.removeAllListeners();
    });
  }

  /** initialId が pending なら現在の confirmed id を解決して返す。 */
  private idFor(initialId: string): string {
    if (!initialId.startsWith("pending-")) return initialId;
    return this.pendingToSid.get(initialId) ?? initialId;
  }
}
