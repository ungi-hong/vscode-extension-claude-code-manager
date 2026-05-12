import * as vscode from "vscode";
import type { PermissionMode, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { FolderStore } from "./folders/store";
import { ManagedSessionStore } from "./runtime/persistence";
import { ProcessManager } from "./runtime/processManager";
import { HiddenStore } from "./sessions/hiddenStore";
import {
  extractAssistantSummary,
  extractUserSummary,
} from "./sessions/parser";
import { SessionRegistry } from "./sessions/registry";
import { UsageStore } from "./sessions/usageStore";
import { SessionWatcher } from "./sessions/watcher";
import { scanCustomCommands } from "./utils/customCommands";
import { sessionJsonlPath } from "./utils/projectsPath";
import { RabbitWebviewProvider } from "./views/rabbitView";
import { SessionsTreeProvider } from "./views/treeProvider";
import { PanelSlashCommand, SessionPanelManager } from "./views/sessionPanel";
import { StatusBar } from "./views/statusBar";

import { statSync } from "fs";

/** Shift+Tab で循環するモード (bypassPermissions は危険なので含めない)。 */
const MODE_CYCLE: PermissionMode[] = ["default", "acceptEdits", "plan"];
const cycleNext = (cur: PermissionMode): PermissionMode => {
  const i = MODE_CYCLE.indexOf(cur);
  if (i < 0) return MODE_CYCLE[0];
  return MODE_CYCLE[(i + 1) % MODE_CYCLE.length];
};

export function activate(context: vscode.ExtensionContext): void {
  const cfg = vscode.workspace.getConfiguration("claudeCodeManager");
  const output = vscode.window.createOutputChannel("Claude Code Manager");
  output.appendLine(`[ccmgr] activate at ${new Date().toISOString()}`);

  /** 設定から取った起動時デフォルトモード。Shift+Tab で実行中も切替可能。 */
  const getDefaultPermissionMode = (): PermissionMode => {
    const m = vscode.workspace
      .getConfiguration("claudeCodeManager")
      .get<string>("defaultPermissionMode", "default");
    if (m === "plan" || m === "acceptEdits" || m === "bypassPermissions") {
      return m;
    }
    return "default";
  };
  /** sessionId → 現在の権限モード (Shift+Tab 履歴と SDK の実態の source of truth) */
  const sessionModes = new Map<string, PermissionMode>();

  const registry = new SessionRegistry({
    staleAfterMinutes: cfg.get<number>("staleAfterMinutes", 30),
    maxEventsPerSession: cfg.get<number>("maxEventsPerSession", 200),
  });
  const watcher = new SessionWatcher({
    initialMaxAgeHours: cfg.get<number>("hideSessionsOlderThanHours", 24),
  });

  watcher.on("error", (err) => {
    console.error("[ccmgr] watcher error", err);
  });

  const hiddenStore = new HiddenStore(context.globalState);
  const folders = new FolderStore(context.globalState);
  const usageStore = new UsageStore(context.globalState);

  // 順序的に usageStore 宣言後に listener を登録 (const の TDZ 回避)
  watcher.on("event", (evt) => {
    registry.ingest(evt);
    // assistant メッセージの usage を block 集計用にも流す
    usageStore.ingestJsonlEvent(evt);
  });

  const treeProvider = new SessionsTreeProvider(
    registry,
    hiddenStore,
    folders,
    usageStore,
  );
  const treeView = vscode.window.createTreeView("ccmgr.sessions", {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });
  const rabbitProvider = new RabbitWebviewProvider(
    context.extensionUri,
    usageStore,
  );
  const rabbitRegistration = vscode.window.registerWebviewViewProvider(
    RabbitWebviewProvider.viewType,
    rabbitProvider,
  );
  const updateTreeBadge = () => {
    const n = hiddenStore.size();
    treeView.description = n > 0 ? `${n} hidden` : undefined;
  };
  hiddenStore.on("changed", updateTreeBadge);
  updateTreeBadge();

  const processManager = new ProcessManager();
  const managedStore = new ManagedSessionStore(context.globalState);

  // Restore previously-managed sessions as suspended on activate.
  // 古い session でも `~/.claude/projects/.../<sid>.jsonl` が残ってれば
  // panel 復元時に replay できるよう、ここで filePath を解決して registry に渡す。
  for (const snap of managedStore.list()) {
    const candidate = sessionJsonlPath(snap.cwd, snap.sessionId);
    let filePath: string | undefined;
    try {
      if (statSync(candidate).size > 0) filePath = candidate;
    } catch {
      filePath = undefined;
    }
    registry.registerManaged({
      sessionId: snap.sessionId,
      cwd: snap.cwd,
      filePath,
    });
    registry.markSuspended(snap.sessionId, true);
  }

  /**
   * 起動中ならそのまま、そうでなければ resume / create を試みる。
   * 成功時は実際に "今アクティブな" id (resume 時は同 id, create fallback 時は
   * 新しい pending- id) を返す。失敗時は undefined。
   *
   * Zombie session 対策: JSONL ファイルが 0 byte (= init 受信したが会話成立せず
   * 履歴空) のセッションは claude バイナリが resume できないので、登録を消して
   * 新規セッションを同じ cwd で create し直す。
   */
  const ensureManagedProcess = (sessionId: string): string | undefined => {
    if (processManager.has(sessionId)) return sessionId;
    const state = registry.get(sessionId);
    if (!state) return undefined;
    if (sessionId.startsWith("pending-")) return undefined;

    // 空 JSONL 検出: そのまま resume すると「No conversation found」エラーになる
    const jsonlPath = sessionJsonlPath(state.cwd, sessionId);
    let isZombie = false;
    try {
      isZombie = statSync(jsonlPath).size === 0;
    } catch {
      isZombie = true; // 存在しないも会話なしと同義に扱う
    }

    const startMode = getDefaultPermissionMode();
    if (isZombie) {
      output.appendLine(
        `[ccmgr] zombie session detected sid=${sessionId.slice(0, 8)} (empty JSONL at ${jsonlPath}) — creating fresh session in same cwd`,
      );
      panelManager.pushStatus(
        sessionId,
        "履歴が空のため新規セッションに切り替えます…",
        "info",
      );
      void managedStore.remove(sessionId);
      registry.removeSession(sessionId);
      sessionModes.delete(sessionId);
      const { id: newId } = processManager.create(state.cwd, {
        permissionMode: startMode,
      });
      registry.registerManaged({ sessionId: newId, cwd: state.cwd });
      sessionModes.set(newId, startMode);
      panelManager.rekey(sessionId, newId);
      panelManager.pushMode(newId, startMode);
      return newId;
    }

    // external または suspended な managed → resume で managed として再起動。
    // SDK の起動には数百 ms かかるため、Webview に進行状態を通知して
    // 「送信したのに無反応」と感じさせないようにする。
    panelManager.pushStatus(sessionId, "セッションを再開中…", "info");
    processManager.resume(sessionId, state.cwd, { permissionMode: startMode });
    registry.markAsManaged(sessionId);
    registry.markSuspended(sessionId, false);
    sessionModes.set(sessionId, startMode);
    panelManager.pushMode(sessionId, startMode);
    void managedStore.record({
      sessionId,
      cwd: state.cwd,
    });
    return sessionId;
  };

  const panelManager = new SessionPanelManager(context, registry, {
    onSubmit: (sessionId, text) => {
      const activeId = ensureManagedProcess(sessionId);
      if (!activeId) {
        vscode.window.showWarningMessage(
          "Claude Code Manager: このセッションを起動できません",
        );
        return;
      }
      processManager.send(activeId, text);
    },
    onResume: (sessionId) => {
      ensureManagedProcess(sessionId);
    },
    onCycleMode: async (sessionId) => {
      const cur = sessionModes.get(sessionId) ?? getDefaultPermissionMode();
      const next = cycleNext(cur);
      sessionModes.set(sessionId, next);
      try {
        await processManager.setPermissionMode(sessionId, next);
      } catch (err) {
        output.appendLine(
          `[ccmgr] setPermissionMode failed sid=${sessionId.slice(0, 8)}: ${(err as Error).message}`,
        );
      }
      panelManager.pushMode(sessionId, next);
    },
    onRequestMode: (sessionId) => {
      // Panel が ready になったら mode と custom commands を即時 push。
      const cur = sessionModes.get(sessionId) ?? getDefaultPermissionMode();
      panelManager.pushMode(sessionId, cur);
      // SDK init 待たずに custom (filesystem) commands は流せる
      pushCommandsToPanel(sessionId, false);
    },
  });

  // ProcessManager のイベントを Tree / Panel / Persistence / UsageStore に橋渡し。
  processManager.on("promoted", ({ pendingId, sessionId }) => {
    registry.promotePending(pendingId, sessionId);
    panelManager.rekey(pendingId, sessionId);
    usageStore.rename(pendingId, sessionId);
    // sessionModes は pending- 側で保持していたので confirmed id に移す
    const pendingMode = sessionModes.get(pendingId);
    if (pendingMode) {
      sessionModes.delete(pendingId);
      sessionModes.set(sessionId, pendingMode);
    }
    const cwd = registry.get(sessionId)?.cwd ?? "";
    void managedStore.record({ sessionId, cwd });
  });

  /**
   * SDK の組み込み slash command + `~/.claude/commands/` / `<cwd>/.claude/commands/`
   * のユーザー定義カスタムコマンドを結合して webview へ流す。
   *
   * - `init = false` (panel ready 時) : SDK fetch せず、custom のみ即 push (素早い)
   * - `init = true`  (SDK init 受信時): SDK fetch して custom + SDK で再 push
   */
  const sdkCommandsCache = new Map<
    string,
    Awaited<ReturnType<typeof processManager.getSupportedCommands>>
  >();
  const pushCommandsToPanel = (id: string, fetchSdk: boolean): void => {
    void (async () => {
      let sdkCmds = sdkCommandsCache.get(id) ?? [];
      if (fetchSdk && !sdkCommandsCache.has(id)) {
        try {
          sdkCmds = await processManager.getSupportedCommands(id);
          sdkCommandsCache.set(id, sdkCmds);
        } catch (err) {
          output.appendLine(
            `[ccmgr] getSupportedCommands failed sid=${id.slice(0, 8)}: ${(err as Error).message}`,
          );
        }
      }
      const cwd = registry.get(id)?.cwd ?? "";
      const customCmds = cwd ? scanCustomCommands(cwd) : [];
      const seen = new Set(sdkCmds.map((c) => c.name));
      const merged: PanelSlashCommand[] = [
        ...sdkCmds.map((c) => ({
          name: c.name,
          description: c.description,
          argumentHint: c.argumentHint,
          aliases: c.aliases,
        })),
        ...customCmds
          .filter((c) => !seen.has(c.name))
          .map((c) => ({
            name: c.name,
            description: c.description,
            argumentHint: c.argumentHint,
            source: c.source,
            plugin: c.plugin,
          })),
      ];
      output.appendLine(
        `[ccmgr] commands sid=${id.slice(0, 8)} sdk=${sdkCmds.length} custom=${customCmds.length} fetchSdk=${fetchSdk}`,
      );
      if (merged.length > 0) panelManager.pushCommands(id, merged);
    })();
  };

  processManager.on("message", (id, msg) => {
    panelManager.pushSdkMessage(id, msg);
    // デバッグ: 来てる SDKMessage の type を全部記録 (rate_limit_event の到来確認用)
    const t = (msg as { type?: string })?.type ?? "?";
    output.appendLine(`[msg] sid=${id.slice(0, 8)} type=${t}`);
    if (t === "rate_limit_event") {
      output.appendLine(
        `  rate_limit_info=${JSON.stringify((msg as any).rate_limit_info)}`,
      );
    }
    if (t === "system" && (msg as { subtype?: string }).subtype === "init") {
      // 認証モード等のデバッグ情報をログ。apiKeySource が "user" だと API key 直
      // 認証なので rate_limit_event は飛んでこない。"oauth" なら claude.ai 経由。
      const s = msg as any;
      output.appendLine(
        `  init: apiKeySource=${s.apiKeySource} model=${s.model} ver=${s.claude_code_version}`,
      );
      pushCommandsToPanel(id, true);
    }

    // ⚠ rate_limit_event はアカウント全体の情報なので、session_id が pending-
    // (まだ promote されてない) の段階でも ingest する。早期 return の前で処理する。
    if (isRateLimitEvent(msg)) {
      const accepted = usageStore.ingestRateLimit(msg);
      output.appendLine(
        `  rate_limit ingest=${accepted ? "OK" : "REJECTED"}`,
      );
    }

    // 軽い snapshot 更新: 直近 user/assistant プレビューを永続化
    if (id.startsWith("pending-")) return;
    if (isAssistantMessage(msg)) {
      const text = extractAssistantSummary(msg);
      if (text) void managedStore.update(id, { lastAssistantText: text });
    } else if (isUserMessage(msg)) {
      const text = extractUserSummary(msg);
      if (text) void managedStore.update(id, { lastUserPrompt: text });
    } else if (isResultMessage(msg)) {
      usageStore.ingestResult(id, msg);
    }
  });
  processManager.on("disposed", (id) => {
    registry.markSuspended(id, true);
    if (!id.startsWith("pending-")) {
      void managedStore.update(id, { suspendedAt: Date.now() });
    }
    sessionModes.delete(id);
    sdkCommandsCache.delete(id);
    panelManager.pushStatus(id, "セッションが終了しました", "info");
  });
  processManager.on("error", (id, err) => {
    console.error("[ccmgr] process error", id, err);
    panelManager.pushStatus(id, `エラー: ${err.message}`, "error");
    vscode.window.showErrorMessage(
      `Claude Code Manager: session ${id.slice(0, 8)} — ${err.message}`,
    );
  });

  const statusBar = new StatusBar(registry, usageStore);

  context.subscriptions.push(
    output,
    treeView,
    treeProvider,
    rabbitRegistration,
    rabbitProvider,
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
    vscode.commands.registerCommand("claudeCodeManager.showLogs", () => {
      output.show(true);
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
        const startMode = getDefaultPermissionMode();
        const { id } = processManager.create(cwd, { permissionMode: startMode });
        registry.registerManaged({ sessionId: id, cwd });
        sessionModes.set(id, startMode);
        panelManager.open(id);
        panelManager.pushMode(id, startMode);
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
        usageStore.dispose(sessionId);
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
      usageStore.dispose();
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

const isResultMessage = (
  msg: SDKMessage,
): msg is Extract<SDKMessage, { type: "result" }> =>
  msg?.type === "result";

const isRateLimitEvent = (
  msg: SDKMessage,
): msg is Extract<SDKMessage, { type: "rate_limit_event" }> =>
  msg?.type === "rate_limit_event";
