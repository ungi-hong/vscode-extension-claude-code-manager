import * as vscode from "vscode";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { FolderStore } from "./folders/store";
import { ManagedSessionStore } from "./runtime/persistence";
import { ProcessManager } from "./runtime/processManager";
import { HiddenStore } from "./sessions/hiddenStore";
import {
  extractAssistantSummary,
  extractUserSummary,
} from "./sessions/parser";
import { SessionRegistry } from "./sessions/registry";
import { SessionWatcher } from "./sessions/watcher";
import { SessionsTreeProvider } from "./views/treeProvider";
import { SessionPanelManager } from "./views/sessionPanel";
import { StatusBar } from "./views/statusBar";

export function activate(context: vscode.ExtensionContext): void {
  const cfg = vscode.workspace.getConfiguration("claudeCodeManager");
  const registry = new SessionRegistry({
    staleAfterMinutes: cfg.get<number>("staleAfterMinutes", 30),
    maxEventsPerSession: cfg.get<number>("maxEventsPerSession", 200),
  });
  const watcher = new SessionWatcher({
    initialMaxAgeHours: cfg.get<number>("hideSessionsOlderThanHours", 24),
  });

  watcher.on("event", (evt) => registry.ingest(evt));
  watcher.on("error", (err) => {
    console.error("[ccmgr] watcher error", err);
  });

  const hiddenStore = new HiddenStore(context.globalState);
  const folders = new FolderStore(context.globalState);
  const treeProvider = new SessionsTreeProvider(registry, hiddenStore, folders);
  const treeView = vscode.window.createTreeView("ccmgr.sessions", {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });
  const updateTreeBadge = () => {
    const n = hiddenStore.size();
    treeView.description = n > 0 ? `${n} hidden` : undefined;
  };
  hiddenStore.on("changed", updateTreeBadge);
  updateTreeBadge();

  const processManager = new ProcessManager();
  const managedStore = new ManagedSessionStore(context.globalState);

  // Restore previously-managed sessions as suspended on activate.
  for (const snap of managedStore.list()) {
    registry.registerManaged({
      sessionId: snap.sessionId,
      cwd: snap.cwd,
    });
    registry.markSuspended(snap.sessionId, true);
  }

  const ensureManagedProcess = (sessionId: string): boolean => {
    if (processManager.has(sessionId)) return true;
    const state = registry.get(sessionId);
    if (!state) return false;
    if (sessionId.startsWith("pending-")) return false;
    // external または suspended な managed → resume で managed として再起動。
    // SDK の起動には数百 ms かかるため、Webview に進行状態を通知して
    // 「送信したのに無反応」と感じさせないようにする。
    panelManager.pushStatus(sessionId, "セッションを再開中…", "info");
    processManager.resume(sessionId, state.cwd);
    registry.markAsManaged(sessionId);
    registry.markSuspended(sessionId, false);
    void managedStore.record({
      sessionId,
      cwd: state.cwd,
    });
    return true;
  };

  const panelManager = new SessionPanelManager(context, registry, {
    onSubmit: (sessionId, text) => {
      if (!ensureManagedProcess(sessionId)) {
        vscode.window.showWarningMessage(
          "Claude Code Manager: このセッションを起動できません",
        );
        return;
      }
      processManager.send(sessionId, text);
    },
    onResume: (sessionId) => {
      ensureManagedProcess(sessionId);
    },
  });

  // ProcessManager のイベントを Tree / Panel / Persistence に橋渡し。
  processManager.on("promoted", ({ pendingId, sessionId }) => {
    registry.promotePending(pendingId, sessionId);
    panelManager.rekey(pendingId, sessionId);
    const cwd = registry.get(sessionId)?.cwd ?? "";
    void managedStore.record({ sessionId, cwd });
  });
  processManager.on("message", (id, msg) => {
    panelManager.pushSdkMessage(id, msg);
    // 軽い snapshot 更新: 直近 user/assistant プレビューを永続化
    if (id.startsWith("pending-")) return;
    if (isAssistantMessage(msg)) {
      const text = extractAssistantSummary(msg);
      if (text) void managedStore.update(id, { lastAssistantText: text });
    } else if (isUserMessage(msg)) {
      const text = extractUserSummary(msg);
      if (text) void managedStore.update(id, { lastUserPrompt: text });
    }
  });
  processManager.on("disposed", (id) => {
    registry.markSuspended(id, true);
    if (!id.startsWith("pending-")) {
      void managedStore.update(id, { suspendedAt: Date.now() });
    }
    panelManager.pushStatus(id, "セッションが終了しました", "info");
  });
  processManager.on("error", (id, err) => {
    console.error("[ccmgr] process error", id, err);
    panelManager.pushStatus(id, `エラー: ${err.message}`, "error");
    vscode.window.showErrorMessage(
      `Claude Code Manager: session ${id.slice(0, 8)} — ${err.message}`,
    );
  });

  const statusBar = new StatusBar(registry);

  context.subscriptions.push(
    treeView,
    treeProvider,
    statusBar,
    vscode.commands.registerCommand(
      "claudeCodeManager.openSession",
      (target: unknown) => {
        const sessionId = resolveSessionId(target);
        if (!sessionId) return;
        panelManager.open(sessionId);
      },
    ),
    vscode.commands.registerCommand("claudeCodeManager.refresh", () => {
      registry.recomputeAllStatuses();
      treeProvider.refresh();
    }),
    vscode.commands.registerCommand(
      "claudeCodeManager.copySessionId",
      async (target: unknown) => {
        const sessionId = resolveSessionId(target);
        if (!sessionId) return;
        await vscode.env.clipboard.writeText(sessionId);
        vscode.window.setStatusBarMessage(
          `Copied ${sessionId}`,
          2000,
        );
      },
    ),
    vscode.commands.registerCommand(
      "claudeCodeManager.focusSidebar",
      async () => {
        await vscode.commands.executeCommand("ccmgr.sessions.focus");
      },
    ),
    vscode.commands.registerCommand(
      "claudeCodeManager.addFolder",
      async () => {
        const picks = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: true,
          openLabel: "Add as Claude Code folder",
        });
        if (!picks || picks.length === 0) return;
        for (const u of picks) {
          await folders.add(u.fsPath);
        }
        vscode.window.setStatusBarMessage(
          `Added ${picks.length} folder(s)`,
          2500,
        );
      },
    ),
    vscode.commands.registerCommand(
      "claudeCodeManager.removeFolder",
      async (target: unknown) => {
        const cwd = resolveCwd(target);
        if (!cwd) return;
        await folders.remove(cwd);
      },
    ),
    vscode.commands.registerCommand(
      "claudeCodeManager.newSession",
      async (target: unknown) => {
        const cwd = resolveCwd(target);
        if (!cwd) {
          vscode.window.showWarningMessage(
            "Claude Code Manager: フォルダを指定してください",
          );
          return;
        }
        const { id } = processManager.create(cwd);
        registry.registerManaged({ sessionId: id, cwd });
        panelManager.open(id);
      },
    ),
    vscode.commands.registerCommand(
      "claudeCodeManager.hideSession",
      async (target: unknown) => {
        const sessionId = resolveSessionId(target);
        if (!sessionId) return;
        await hiddenStore.add(sessionId);
        vscode.window.setStatusBarMessage(
          `Hidden ${sessionId.slice(0, 8)} (Show Hidden Sessions で復元可能)`,
          3000,
        );
      },
    ),
    vscode.commands.registerCommand(
      "claudeCodeManager.forgetSession",
      async (target: unknown) => {
        const sessionId = resolveSessionId(target);
        if (!sessionId) return;
        const confirm = await vscode.window.showWarningMessage(
          `セッション ${sessionId.slice(0, 8)} を一覧から完全に削除しますか? (jsonl 履歴はディスクに残ります)`,
          { modal: true },
          "削除",
        );
        if (confirm !== "削除") return;
        await processManager.dispose(sessionId);
        await managedStore.remove(sessionId);
        panelManager.disposePanel(sessionId);
        registry.removeSession(sessionId);
      },
    ),
    vscode.commands.registerCommand(
      "claudeCodeManager.stopSession",
      async (target: unknown) => {
        const sessionId = resolveSessionId(target);
        if (!sessionId) return;
        if (!processManager.has(sessionId)) {
          vscode.window.showInformationMessage(
            "Claude Code Manager: 起動中のセッションではありません",
          );
          return;
        }
        await processManager.interrupt(sessionId);
        panelManager.pushStatus(sessionId, "生成を中断しました", "info");
      },
    ),
    vscode.commands.registerCommand(
      "claudeCodeManager.showHiddenSessions",
      async () => {
        const ids = hiddenStore.list();
        if (ids.length === 0) {
          vscode.window.showInformationMessage(
            "Claude Code Manager: 隠しているセッションはありません",
          );
          return;
        }
        const items = ids.map<vscode.QuickPickItem & { sessionId: string }>(
          (sessionId) => {
            const state = registry.get(sessionId);
            const project = state?.projectName ?? "(unknown project)";
            const branch = state?.gitBranch ? ` (${state.gitBranch})` : "";
            return {
              sessionId,
              label: `$(eye) ${project}${branch}`,
              description: sessionId.slice(0, 8),
              detail: state?.lastAssistantText ?? state?.lastUserPrompt ?? "",
            };
          },
        );
        items.push({
          sessionId: "__clear_all__",
          label: "$(clear-all) Clear All Hidden",
          description: `${ids.length} sessions`,
        });
        const picked = await vscode.window.showQuickPick(items, {
          title: "Hidden Sessions — 選択して復元",
          placeHolder: "復元するセッションを選択",
          canPickMany: false,
        });
        if (!picked) return;
        if (picked.sessionId === "__clear_all__") {
          await hiddenStore.clear();
          vscode.window.setStatusBarMessage(
            "All hidden sessions restored",
            3000,
          );
        } else {
          await hiddenStore.remove(picked.sessionId);
          vscode.window.setStatusBarMessage(
            `Restored ${picked.sessionId.slice(0, 8)}`,
            3000,
          );
        }
      },
    ),
  );

  registry.start();
  watcher.start();

  context.subscriptions.push({
    dispose: () => {
      registry.stop();
      void watcher.stop();
      void processManager.disposeAll();
      folders.dispose();
    },
  });
}

export function deactivate(): void {
  // Disposables are handled via context.subscriptions.
}

/**
 * VSCode の command callback は引数の型が unknown。TreeItem からは
 * `{ sessionId }` / `{ state: { sessionId } }` のいずれかで渡ってくる。
 */
const resolveSessionId = (target: unknown): string | undefined => {
  if (typeof target === "string") return target;
  if (!target || typeof target !== "object") return undefined;
  const r = target as Record<string, unknown>;
  if (typeof r.sessionId === "string") return r.sessionId;
  const state = r.state;
  if (state && typeof state === "object") {
    const s = state as Record<string, unknown>;
    if (typeof s.sessionId === "string") return s.sessionId;
  }
  return undefined;
};

const resolveCwd = (target: unknown): string | undefined => {
  if (typeof target === "string") return target;
  if (!target || typeof target !== "object") return undefined;
  const r = target as Record<string, unknown>;
  if (typeof r.cwd === "string") return r.cwd;
  const entry = r.entry;
  if (entry && typeof entry === "object") {
    const e = entry as Record<string, unknown>;
    if (typeof e.cwd === "string") return e.cwd;
  }
  const state = r.state;
  if (state && typeof state === "object") {
    const s = state as Record<string, unknown>;
    if (typeof s.cwd === "string") return s.cwd;
  }
  return undefined;
};

const isAssistantMessage = (
  msg: SDKMessage,
): msg is Extract<SDKMessage, { type: "assistant" }> =>
  msg?.type === "assistant";

const isUserMessage = (
  msg: SDKMessage,
): msg is Extract<SDKMessage, { type: "user" }> =>
  msg?.type === "user";
