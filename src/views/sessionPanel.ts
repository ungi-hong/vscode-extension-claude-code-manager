import * as fs from "fs";
import * as vscode from "vscode";
import type {
  PermissionMode,
  PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  Attachment,
  PermissionRequestPayload,
} from "../runtime/claudeProcess";
import { SessionRegistry } from "../sessions/registry";
import { SessionEvent, SessionState } from "../sessions/types";
import { JsonlBuffer, toSessionEvent } from "../sessions/parser";
import { sessionJsonlPath } from "../utils/projectsPath";

/** Webview に流す slash command 1 件分。SDK 由来 + ユーザー定義 + プラグインの合成型。 */
export interface PanelSlashCommand {
  name: string;
  description: string;
  argumentHint: string;
  aliases?: string[];
  /** ユーザー定義は "user" / "project" / "plugin"。SDK 組み込みは undefined。 */
  source?: "user" | "project" | "plugin";
  /** plugin 由来時の plugin 名。 */
  plugin?: string;
}

export interface PanelActions {
  /** Webview からのユーザー入力。managed セッションのみで呼ばれる前提。 */
  onSubmit?: (
    sessionId: string,
    text: string,
    attachments?: Attachment[],
  ) => void;
  /** Webview の "Resume" 操作 (suspended な managed セッションを再起動)。 */
  onResume?: (sessionId: string) => void;
  /** Shift+Tab で次のモードへ循環したいリクエスト。 */
  onCycleMode?: (sessionId: string) => void;
  /** panel が表示直後に「いまのモード送って」と要求してきたら呼ばれる。 */
  onRequestMode?: (sessionId: string) => void;
  /** 生成中の処理を中断 (Stop ボタン / Esc キー)。 */
  onInterrupt?: (sessionId: string) => void;
  /** webview の承認ダイアログから返ってきた回答 (allow / deny)。 */
  onPermissionResponse?: (
    sessionId: string,
    requestId: string,
    result: PermissionResult,
  ) => void;
}

export class SessionPanelManager {
  private panels = new Map<string, SessionPanel>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly registry: SessionRegistry,
    private readonly actions: PanelActions,
  ) {
    registry.on("changed", (sessionId) => {
      const panel = this.panels.get(sessionId);
      if (!panel) return;
      const state = registry.get(sessionId);
      if (!state) return;
      panel.pushDelta(state);
    });
    // NOTE: registry "removed" は処理しない。pending → confirmed の rekey 中に
    // panel を消してしまうと孤立するため、廃棄は disposePanel 経由のみで行う。
  }

  /** forgetSession など、panel を完全に閉じたい場合に呼ぶ。 */
  disposePanel(sessionId: string): void {
    const panel = this.panels.get(sessionId);
    if (!panel) return;
    panel.dispose();
    this.panels.delete(sessionId);
  }

  open(sessionId: string): void {
    const existing = this.panels.get(sessionId);
    if (existing) {
      existing.reveal();
      return;
    }
    const state = this.registry.get(sessionId);
    if (!state) {
      vscode.window.showWarningMessage(
        `Claude Code Manager: Session ${sessionId} is not active`,
      );
      return;
    }
    const panel = new SessionPanel(this.context, state, this.actions, () => {
      // panel.id は rekey で書き換わるため、dispose 時点の最新 id で削除する。
      this.panels.delete(panel.id);
    });
    this.panels.set(state.sessionId, panel);
    panel.bootstrap();
  }

  /** pending → confirmed の rename 時に panel の鍵を差し替える。 */
  rekey(oldId: string, newId: string): void {
    const panel = this.panels.get(oldId);
    if (!panel) return;
    this.panels.delete(oldId);
    this.panels.set(newId, panel);
    panel.notifyIdRename(newId);
  }

  /**
   * SDK 由来の生 message を Webview に push する。jsonl 監視と二重に来ないよう
   * 呼び出し側 (extension.ts) が origin を見て出し分ける。
   */
  pushSdkMessage(sessionId: string, message: unknown): void {
    const panel = this.panels.get(sessionId);
    if (!panel) return;
    panel.pushSdkMessage(message);
  }

  pushStatus(sessionId: string, text: string, kind: "info" | "error" = "info"): void {
    const panel = this.panels.get(sessionId);
    if (!panel) return;
    panel.pushStatus(text, kind);
  }

  /** 現在の permission モードを webview の右下バッジに反映させる。 */
  pushMode(sessionId: string, mode: PermissionMode): void {
    const panel = this.panels.get(sessionId);
    if (!panel) return;
    panel.pushMode(mode);
  }

  /** Slash command の補完候補一覧を webview に流す (1 セッションに 1 回想定)。 */
  pushCommands(sessionId: string, commands: PanelSlashCommand[]): void {
    const panel = this.panels.get(sessionId);
    if (!panel) return;
    panel.pushCommands(commands);
  }

  /** ツール承認依頼を webview に投げる (Allow/Deny ボタン UI を出す)。 */
  pushPermissionRequest(
    sessionId: string,
    req: PermissionRequestPayload,
  ): void {
    const panel = this.panels.get(sessionId);
    if (!panel) return;
    panel.pushPermissionRequest(req);
  }
}

class SessionPanel {
  private readonly panel: vscode.WebviewPanel;
  private bootstrapped = false;
  private currentSessionId: string;

  /** SessionPanelManager 側の Map のキーと一致する現在の id (pending/confirmed)。 */
  get id(): string {
    return this.currentSessionId;
  }

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly initialState: SessionState,
    private readonly actions: PanelActions,
    onDispose: () => void,
  ) {
    this.currentSessionId = initialState.sessionId;
    this.panel = vscode.window.createWebviewPanel(
      "ccmgr.session",
      this.titleFor(initialState),
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, "dist", "webview"),
        ],
      },
    );
    this.panel.webview.html = this.renderHtml();
    this.panel.onDidDispose(() => onDispose(), null, context.subscriptions);
    this.panel.webview.onDidReceiveMessage(
      (msg) => this.handleMessage(msg),
      null,
      context.subscriptions,
    );
  }

  reveal(): void {
    this.panel.reveal(undefined, false);
  }

  dispose(): void {
    this.panel.dispose();
  }

  notifyIdRename(newId: string): void {
    this.currentSessionId = newId;
    this.panel.title = this.titleFor({
      ...this.initialState,
      sessionId: newId,
    });
  }

  bootstrap(): void {
    // filePath 未設定でも、cwd + sessionId から JSONL を探して replay を試みる。
    // (watcher が古いファイルを初期 load してない場合や、managedStore 復元時に
    //  filePath を埋め忘れたケースのフォールバック)
    let filePath = this.initialState.filePath;
    if (!filePath && this.initialState.cwd && !this.initialState.sessionId.startsWith("pending-")) {
      const candidate = sessionJsonlPath(
        this.initialState.cwd,
        this.initialState.sessionId,
      );
      try {
        if (fs.statSync(candidate).size > 0) filePath = candidate;
      } catch {
        // 存在しないなら諦め
      }
    }
    if (!filePath) {
      this.bootstrapped = true;
      this.postState(this.initialState);
      return;
    }
    void this.replayJsonl({ ...this.initialState, filePath }).finally(() => {
      this.bootstrapped = true;
      this.postState(this.initialState);
    });
  }

  pushDelta(state: SessionState): void {
    if (!this.bootstrapped) return;
    this.postState(state);
    // managed セッションでは jsonl 由来のイベントは最終チャンネルにしない
    // (SDK 経由で別途 pushSdkMessage が呼ばれる)
    if (state.origin === "managed") return;
    const events = state.recentEvents.slice(-1);
    for (const evt of events) this.postEvent(evt);
  }

  pushSdkMessage(message: unknown): void {
    this.panel.webview.postMessage({ type: "sdk", message });
  }

  pushStatus(text: string, kind: "info" | "error"): void {
    this.panel.webview.postMessage({ type: "status", text, kind });
  }

  pushMode(mode: PermissionMode): void {
    this.panel.webview.postMessage({ type: "mode", mode });
  }

  pushCommands(commands: PanelSlashCommand[]): void {
    const stripped = commands.map((c) => ({
      name: c.name,
      description: c.description,
      argumentHint: c.argumentHint,
      aliases: c.aliases,
      source: c.source,
      plugin: c.plugin,
    }));
    this.panel.webview.postMessage({ type: "commands", commands: stripped });
  }

  pushPermissionRequest(req: PermissionRequestPayload): void {
    this.panel.webview.postMessage({ type: "permission", request: req });
  }

  private async replayJsonl(state: SessionState): Promise<void> {
    if (!state.filePath || typeof state.filePath !== "string") return;
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(state.filePath);
    } catch {
      return;
    }
    if (stat.size === 0) return;
    const buf = new JsonlBuffer();
    const stream = fs.createReadStream(state.filePath, { encoding: "utf8" });
    for await (const chunk of stream) {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const parsed = buf.feed(text);
      for (const raw of parsed) {
        const evt = toSessionEvent(raw, state.filePath, state.sessionId);
        if (evt) this.postEvent(evt);
      }
    }
  }

  private postEvent(evt: SessionEvent): void {
    this.panel.webview.postMessage({ type: "event", event: serializeEvent(evt) });
  }

  private postState(state: SessionState): void {
    this.panel.webview.postMessage({
      type: "state",
      state: {
        sessionId: state.sessionId,
        cwd: state.cwd,
        projectName: state.projectName,
        gitBranch: state.gitBranch,
        status: state.status,
        startedAt: state.startedAt,
        lastEventAt: state.lastEventAt,
        origin: state.origin,
        isSuspended: state.isSuspended,
      },
    });
  }

  private handleMessage(msg: any): void {
    if (!msg || typeof msg.command !== "string") return;
    switch (msg.command) {
      case "ready":
        // panel が表示完了 → 現在のモードを再送するよう extension に依頼
        this.actions.onRequestMode?.(this.currentSessionId);
        break;
      case "submit": {
        const text = typeof msg.text === "string" ? msg.text.trim() : "";
        const rawAttach = Array.isArray(msg.attachments) ? msg.attachments : [];
        const attachments: Attachment[] = rawAttach.flatMap((a: any) => {
          if (
            !a ||
            typeof a.name !== "string" ||
            typeof a.mediaType !== "string" ||
            typeof a.base64 !== "string"
          )
            return [];
          return [{ name: a.name, mediaType: a.mediaType, base64: a.base64 }];
        });
        if (!text && attachments.length === 0) return;
        this.actions.onSubmit?.(this.currentSessionId, text, attachments);
        break;
      }
      case "resume":
        this.actions.onResume?.(this.currentSessionId);
        break;
      case "cycleMode":
        this.actions.onCycleMode?.(this.currentSessionId);
        break;
      case "interrupt":
        this.actions.onInterrupt?.(this.currentSessionId);
        break;
      case "permissionResponse": {
        const requestId =
          typeof msg.requestId === "string" ? msg.requestId : "";
        const decision = msg.decision;
        if (!requestId || !decision) return;
        let result: PermissionResult;
        if (decision === "allow") {
          // AskUserQuestion 等は updatedInput に回答を載せて返す必要があるので
          // webview から来ていれば PermissionResult.allow.updatedInput に流す。
          if (msg.updatedInput && typeof msg.updatedInput === "object") {
            result = {
              behavior: "allow",
              updatedInput: msg.updatedInput as Record<string, unknown>,
            };
          } else {
            result = { behavior: "allow" };
          }
        } else {
          result = {
            behavior: "deny",
            message: typeof msg.message === "string" ? msg.message : "denied by user",
            interrupt: !!msg.interrupt,
          };
        }
        this.actions.onPermissionResponse?.(
          this.currentSessionId,
          requestId,
          result,
        );
        break;
      }
    }
  }

  private titleFor(state: { projectName: string; sessionId: string }): string {
    return `CC: ${state.projectName} · ${state.sessionId.slice(0, 8)}`;
  }

  private renderHtml(): string {
    const webview = this.panel.webview;
    const cspSource = webview.cspSource;
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.context.extensionUri,
        "dist",
        "webview",
        "main.js",
      ),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.context.extensionUri,
        "dist",
        "webview",
        "style.css",
      ),
    );
    const nonce = makeNonce();
    return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data:; style-src ${cspSource}; script-src 'nonce-${nonce}';" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>Claude Code Session</title>
</head>
<body>
  <header class="ccmgr-header">
    <div class="ccmgr-title">
      <span class="status-dot" id="status-dot"></span>
      <span id="title-project">—</span>
      <span class="branch" id="title-branch"></span>
      <span class="session-id" id="title-session"></span>
      <span class="origin-badge" id="origin-badge"></span>
    </div>
  </header>
  <!-- Cmd/Ctrl+F で表示される検索バー -->
  <div class="ccmgr-search" id="search-bar" hidden>
    <input type="text" id="search-input" placeholder="検索…" autocomplete="off" />
    <span class="search-count" id="search-count">0 / 0</span>
    <button id="search-prev" class="search-btn" title="前 (Shift+Enter)">↑</button>
    <button id="search-next" class="search-btn" title="次 (Enter)">↓</button>
    <button id="search-close" class="search-btn" title="閉じる (Esc)">✕</button>
  </div>
  <main id="log" class="ccmgr-log"></main>
  <footer class="ccmgr-input" id="input-bar">
    <!-- 添付サムネイル列 -->
    <div class="attachments" id="attachments" hidden></div>
    <div class="input-wrap">
      <textarea id="input-text" placeholder="Cmd+Enter で送信 (Shift+Tab モード切替 / / コマンド / 📎 画像添付)" rows="3"></textarea>
      <div class="slash-dropdown" id="slash-dropdown" hidden></div>
    </div>
    <div class="input-actions">
      <span class="input-hint" id="input-hint"></span>
      <span class="mode-badge" id="mode-badge" data-mode="default" title="Shift+Tab で切替">● Default</span>
      <input type="file" id="file-input" accept="image/*" multiple hidden />
      <button id="btn-attach" class="btn-attach" title="画像を添付 (ドラッグ&ドロップでも可)">📎</button>
      <button id="btn-submit">Send</button>
      <button id="btn-stop" class="btn-stop" hidden title="Esc キーでも中断可">■ Stop</button>
    </div>
  </footer>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

/**
 * webview に必要な field だけを抽出する。jsonl raw は tool_result の長文出力で
 * 数 MB 級になりうるため、postMessage の payload を最小化したい。
 * NOTE: tool_result の content 自体のサイズ truncate はやっていない (UI 側で
 *  scroll しつつ要約表示する想定)。将来必要なら別途上限を入れる。
 */
const serializeEvent = (evt: SessionEvent): unknown => {
  const message = evt.raw?.message;
  return {
    sessionId: evt.sessionId,
    type: evt.type,
    timestamp: evt.timestamp,
    raw: {
      uuid: typeof evt.raw?.uuid === "string" ? evt.raw.uuid : undefined,
      message: message
        ? {
            role: message.role,
            content: message.content,
            stop_reason: message.stop_reason,
          }
        : undefined,
    },
  };
};

const makeNonce = (): string => {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i += 1)
    out += chars[Math.floor(Math.random() * chars.length)];
  return out;
};
