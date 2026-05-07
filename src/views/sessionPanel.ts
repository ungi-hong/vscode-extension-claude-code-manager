import * as fs from "fs";
import * as vscode from "vscode";
import { SessionRegistry } from "../sessions/registry";
import { SessionEvent, SessionState } from "../sessions/types";
import { JsonlBuffer, toSessionEvent } from "../sessions/parser";

export interface PanelActions {
  /** Webview からのユーザー入力。managed セッションのみで呼ばれる前提。 */
  onSubmit?: (sessionId: string, text: string) => void;
  /** Webview の "Resume" 操作 (suspended な managed セッションを再起動)。 */
  onResume?: (sessionId: string) => void;
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
    registry.on("removed", (sessionId) => {
      const panel = this.panels.get(sessionId);
      if (!panel) return;
      // pending が確定 sid に rename されたときなど。明示的に id 差し替え。
      this.panels.delete(sessionId);
    });
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
    const panel = new SessionPanel(
      this.context,
      state,
      this.actions,
      () => this.panels.delete(this.panelKey(panel)),
    );
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

  private panelKey(panel: SessionPanel): string {
    for (const [id, p] of this.panels) {
      if (p === panel) return id;
    }
    return "";
  }
}

class SessionPanel {
  private readonly panel: vscode.WebviewPanel;
  private bootstrapped = false;
  private currentSessionId: string;

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

  notifyIdRename(newId: string): void {
    this.currentSessionId = newId;
    this.panel.title = this.titleFor({
      ...this.initialState,
      sessionId: newId,
    });
  }

  bootstrap(): void {
    // managed の新規セッション (filePath 未確定) は jsonl replay をスキップ
    if (!this.initialState.filePath) {
      this.bootstrapped = true;
      this.postState(this.initialState);
      return;
    }
    void this.replayJsonl(this.initialState).finally(() => {
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
        break;
      case "submit": {
        const text = typeof msg.text === "string" ? msg.text.trim() : "";
        if (!text) return;
        this.actions.onSubmit?.(this.currentSessionId, text);
        break;
      }
      case "resume":
        this.actions.onResume?.(this.currentSessionId);
        break;
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
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data:; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
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
  <main id="log" class="ccmgr-log"></main>
  <footer class="ccmgr-input" id="input-bar">
    <textarea id="input-text" placeholder="Cmd+Enter で送信" rows="3"></textarea>
    <div class="input-actions">
      <span class="input-hint" id="input-hint"></span>
      <button id="btn-submit">Send</button>
    </div>
  </footer>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

const serializeEvent = (evt: SessionEvent): any => ({
  sessionId: evt.sessionId,
  type: evt.type,
  timestamp: evt.timestamp,
  raw: evt.raw,
});

const makeNonce = (): string => {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i += 1)
    out += chars[Math.floor(Math.random() * chars.length)];
  return out;
};
