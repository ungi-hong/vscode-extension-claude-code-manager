import { EventEmitter } from "events";
import { projectBaseName } from "../utils/projectsPath";
import { truncate } from "../utils/text";
import {
  extractAssistantText,
  extractStopReason,
  extractToolResults,
  extractToolUses,
  extractUserText,
} from "./parser";
import { SessionEvent, SessionState, SessionStatus } from "./types";

export interface SessionRegistryOptions {
  staleAfterMinutes: number;
  maxEventsPerSession: number;
}

export declare interface SessionRegistry {
  on(event: "changed", listener: (sessionId: string) => void): this;
  on(event: "removed", listener: (sessionId: string) => void): this;
  on(event: "snapshot", listener: () => void): this;
}

export class SessionRegistry extends EventEmitter {
  private states = new Map<string, SessionState>();
  private statusTimer?: NodeJS.Timeout;

  constructor(private opts: SessionRegistryOptions) {
    super();
  }

  start(): void {
    this.statusTimer = setInterval(() => this.recomputeAllStatuses(), 10_000);
  }

  stop(): void {
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.statusTimer = undefined;
  }

  list(): SessionState[] {
    return Array.from(this.states.values()).sort(
      (a, b) => b.lastEventAt - a.lastEventAt,
    );
  }

  get(sessionId: string): SessionState | undefined {
    return this.states.get(sessionId);
  }

  /**
   * 拡張から ProcessManager 経由で起動した managed セッションを登録する。
   * pending-* の暫定 id でもセッションとして表示できるようにする。
   */
  registerManaged(args: {
    sessionId: string;
    cwd: string;
    filePath?: string;
  }): SessionState {
    const existing = this.states.get(args.sessionId);
    if (existing) {
      existing.origin = "managed";
      existing.isSuspended = false;
      this.emit("changed", existing.sessionId);
      return existing;
    }
    const now = Date.now();
    const state: SessionState = {
      sessionId: args.sessionId,
      cwd: args.cwd,
      projectName: projectBaseName(args.cwd),
      status: "running",
      filePath: args.filePath ?? "",
      startedAt: now,
      lastEventAt: now,
      pendingToolUseIds: new Set(),
      recentEvents: [],
      origin: "managed",
      isSuspended: false,
    };
    this.states.set(args.sessionId, state);
    this.emit("changed", args.sessionId);
    return state;
  }

  /** SDK の system.init で確定した sessionId を pending-* から rename する。 */
  promotePending(pendingId: string, confirmedSessionId: string): boolean {
    if (pendingId === confirmedSessionId) return false;
    const pendingState = this.states.get(pendingId);
    const existing = this.states.get(confirmedSessionId);

    if (existing) {
      // jsonl 経由で先に external として観測されてしまった場合の救済。
      // 既存 state を managed に昇格して採用し、pending は捨てる。
      existing.origin = "managed";
      existing.isSuspended = false;
      // pending 側に値があればフォールバック値として merge
      if (pendingState) {
        if (!existing.lastUserPrompt && pendingState.lastUserPrompt) {
          existing.lastUserPrompt = pendingState.lastUserPrompt;
        }
        if (!existing.lastAssistantText && pendingState.lastAssistantText) {
          existing.lastAssistantText = pendingState.lastAssistantText;
        }
      }
      if (pendingState) this.states.delete(pendingId);
      this.emit("removed", pendingId);
      this.emit("changed", confirmedSessionId);
      return true;
    }

    if (!pendingState) return false;
    pendingState.sessionId = confirmedSessionId;
    this.states.delete(pendingId);
    this.states.set(confirmedSessionId, pendingState);
    this.emit("removed", pendingId);
    this.emit("changed", confirmedSessionId);
    return true;
  }

  markSuspended(sessionId: string, value = true): void {
    const state = this.states.get(sessionId);
    if (!state) return;
    state.isSuspended = value;
    this.emit("changed", sessionId);
  }

  markAsManaged(sessionId: string): void {
    const state = this.states.get(sessionId);
    if (!state || state.origin === "managed") return;
    state.origin = "managed";
    this.emit("changed", sessionId);
  }

  removeSession(sessionId: string): void {
    if (!this.states.has(sessionId)) return;
    this.states.delete(sessionId);
    this.emit("removed", sessionId);
  }

  ingest(evt: SessionEvent): void {
    const existing = this.states.get(evt.sessionId);
    const state = existing ?? this.createState(evt);
    this.applyEvent(state, evt);
    state.lastEventAt = Math.max(state.lastEventAt, evt.timestamp);
    state.recentEvents.push(evt);
    if (state.recentEvents.length > this.opts.maxEventsPerSession) {
      state.recentEvents.splice(
        0,
        state.recentEvents.length - this.opts.maxEventsPerSession,
      );
    }
    state.status = this.inferStatus(state);
    this.states.set(state.sessionId, state);
    this.emit("changed", state.sessionId);
  }

  private createState(evt: SessionEvent): SessionState {
    return {
      sessionId: evt.sessionId,
      cwd: evt.cwd,
      projectName: projectBaseName(evt.cwd),
      gitBranch: evt.gitBranch,
      status: "running",
      filePath: evt.filePath,
      startedAt: evt.timestamp,
      lastEventAt: evt.timestamp,
      pendingToolUseIds: new Set(),
      recentEvents: [],
      // jsonl 経由で初観測されるセッションは常に外部起動扱い。
      // managed への昇格は ProcessManager 経由で別途行う (Stage B)。
      origin: "external",
      isSuspended: false,
    };
  }

  private applyEvent(state: SessionState, evt: SessionEvent): void {
    if (!state.cwd && evt.cwd) state.cwd = evt.cwd;
    if (!state.projectName && evt.cwd)
      state.projectName = projectBaseName(evt.cwd);
    if (evt.gitBranch) state.gitBranch = evt.gitBranch;
    state.filePath = evt.filePath;

    const role = evt.raw?.message?.role;
    if (evt.type === "user" || role === "user") {
      const text = extractUserText(evt.raw);
      if (text) {
        state.lastUserPrompt = truncate(text, 280);
        // auto-title: 最初の user メッセージを保持 (以後の発言では上書きしない)
        if (!state.firstUserPrompt) {
          state.firstUserPrompt = truncate(text, 280);
        }
      }
    } else if (evt.type === "assistant" || role === "assistant") {
      const text = extractAssistantText(evt.raw);
      if (text) state.lastAssistantText = truncate(text, 280);
      const stop = extractStopReason(evt.raw);
      if (stop) state.lastAssistantStopReason = stop;
      for (const tu of extractToolUses(evt.raw)) {
        state.pendingToolUseIds.add(tu.id);
      }
    }

    for (const tr of extractToolResults(evt.raw)) {
      state.pendingToolUseIds.delete(tr.tool_use_id);
    }
  }

  private inferStatus(state: SessionState): SessionStatus {
    const ageMs = Date.now() - state.lastEventAt;
    const staleMs = this.opts.staleAfterMinutes * 60_000;
    if (ageMs > staleMs) return "stale";
    if (state.pendingToolUseIds.size > 0) return "running";
    if (state.lastAssistantStopReason === "tool_use") return "running";
    if (state.lastAssistantStopReason === "end_turn" && ageMs > 5_000)
      return "idle";
    if (ageMs < 1_500) return "running";
    return "idle";
  }

  recomputeAllStatuses(): void {
    let changed = false;
    for (const state of this.states.values()) {
      const next = this.inferStatus(state);
      if (next !== state.status) {
        state.status = next;
        this.emit("changed", state.sessionId);
        changed = true;
      }
    }
    if (changed) this.emit("snapshot");
  }
}
