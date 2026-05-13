export type SessionStatus = "running" | "idle" | "waiting" | "stale";

/**
 * "external" — ターミナル等で起動された claude プロセスのセッション。
 *              拡張は jsonl 経由で進捗を観測するだけ。入力は不可。
 * "managed"  — 拡張自身が SDK で起動したセッション。Webview から双方向対話可。
 *              判定は ProcessManager が保持する sid の集合のみで決まる
 *              (jsonl 観測からの推測は禁止)。
 */
export type SessionOrigin = "external" | "managed";

export type RawJsonlLine = Record<string, any>;

export interface SessionEvent {
  sessionId: string;
  cwd: string;
  gitBranch?: string;
  type: string;
  raw: RawJsonlLine;
  timestamp: number;
  filePath: string;
}

export interface ToolUse {
  id: string;
  name: string;
  input: any;
  result?: { ok: boolean; output: string };
}

export interface RenderedMessage {
  uuid: string;
  role: "user" | "assistant" | "system";
  text: string;
  toolUses: ToolUse[];
  timestamp: number;
}

export interface SessionState {
  sessionId: string;
  cwd: string;
  projectName: string;
  gitBranch?: string;
  status: SessionStatus;
  filePath: string;
  startedAt: number;
  lastEventAt: number;
  /** 最初に送信された user メッセージ (auto-title 用)。確定したら以後上書きしない。 */
  firstUserPrompt?: string;
  lastUserPrompt?: string;
  lastAssistantText?: string;
  lastAssistantStopReason?: string;
  pendingToolUseIds: Set<string>;
  recentEvents: SessionEvent[];
  origin: SessionOrigin;
  /** managed セッションが現在 SDK プロセスを持たない (再起動後など) 状態 */
  isSuspended: boolean;
}
