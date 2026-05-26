import * as vscode from "vscode";
import type { PermissionMode, SDKMessage } from "./runtime/cliTypes";
import { FolderStore } from "./folders/store";
import { ManagedSessionStore } from "./runtime/persistence";
import { ProcessManager } from "./runtime/processManager";
import { RemoteControlManager } from "./runtime/remoteControl";
import { StatuslineMonitor } from "./runtime/statuslineMonitor";
import { ForgottenStore } from "./sessions/forgottenStore";
import { HiddenStore } from "./sessions/hiddenStore";
import {
  extractAssistantSummary,
  extractUserSummary,
} from "./sessions/parser";
import { SessionRegistry } from "./sessions/registry";
import { TitleStore } from "./sessions/titleStore";
import { SessionWatcher } from "./sessions/watcher";
import { scanCustomCommands } from "./utils/customCommands";
import { sessionJsonlPath } from "./utils/projectsPath";
import { SessionsTreeProvider } from "./views/treeProvider";
import { PanelSlashCommand, SessionPanelManager } from "./views/sessionPanel";
import { StatusBar } from "./views/statusBar";

import { statSync, readdirSync } from "fs";
import { execSync } from "child_process";
import * as path from "path";
import * as os from "os";

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

  /**
   * `claude` CLI のパスを解決:
   *   1. `claudeCodeManager.claudePath` 設定が空でなければそれを使う
   *   2. `which claude` (Windows は `where claude`) で PATH から検索
   *   3. Windows のみ: `mise which claude` で mise 管理 Node の install dir から辿る
   *   4. Windows のみ: `%LOCALAPPDATA%\mise\installs\node\*\node_modules\@anthropic-ai\
   *      claude-code\bin\claude.exe` を直接スキャン
   *   5. それでも見つからなければ undefined を返す (起動できないのでエラー)
   *
   * SDK を廃止したため、見つからない場合の同梱バイナリ fallback は無くなった。
   *
   * Windows の難しさ:
   *   npm でインストールされた CLI は `<npm-prefix>/` 配下に
   *     - `claude`        (拡張子なし: mac/linux 用 sh スクリプト)
   *     - `claude.cmd`    (Windows 用バッチラッパー)
   *     - `claude.ps1`    (PowerShell 用)
   *   を置くが、`child_process.spawn` を `shell: false` で呼ぶ場合 `.cmd` は
   *   起動できないし、拡張子なしの sh は Windows では実行不能。
   *
   *   結果: `.cmd` を渡しても "native binary not found" になる。
   *   対策: `<npm-prefix>/node_modules/@anthropic-ai/claude-code/bin/claude.exe`
   *   (npm が同梱する本物のネイティブバイナリ) を直指定する。これなら
   *   spawn が直接 launch できる。
   *
   *   mise 補足: mise (jdx/mise) は Windows でも基本 shim を作らず、`mise activate`
   *   が走ったシェルだけ `installs/node/<ver>/` を PATH に足す。VS Code が
   *   非アクティベート環境から起動されると `where claude` は失敗するので、
   *   `mise which claude` または install dir 直接探索のフォールバックを足す。
   */
  const npmDirToNativeExe = (dir: string): string | undefined => {
    const nativeExe = path.join(
      dir,
      "node_modules",
      "@anthropic-ai",
      "claude-code",
      "bin",
      "claude.exe",
    );
    try {
      if (statSync(nativeExe).isFile()) return nativeExe;
    } catch {
      // fall through
    }
    return undefined;
  };

  const resolveClaudePath = (): string | undefined => {
    const override = vscode.workspace
      .getConfiguration("claudeCodeManager")
      .get<string>("claudePath", "")
      .trim();
    if (override) return override;
    try {
      const cmd = process.platform === "win32" ? "where claude" : "which claude";
      const lines = execSync(cmd, { encoding: "utf8" })
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      if (process.platform === "win32") {
        // 1) PATH から見つかった候補のうち、まず .exe を探す (= 既にネイティブ exe を直指定済)
        const exeDirect = lines.find((l) => l.toLowerCase().endsWith(".exe"));
        if (exeDirect) return exeDirect;
        // 2) .cmd 経由でインストールされている npm CLI 構造から本物の exe を辿る
        const cmdPath = lines.find((l) => l.toLowerCase().endsWith(".cmd"));
        if (cmdPath) {
          const native = npmDirToNativeExe(path.dirname(cmdPath));
          if (native) return native;
          output.appendLine(
            `[ccmgr] WARN: found ${cmdPath} but could not locate native claude.exe under it`,
          );
        }
        // fall through to mise fallbacks
      } else {
        if (lines[0]) return lines[0];
      }
    } catch {
      // not in PATH — on Windows still try mise fallbacks
    }

    if (process.platform === "win32") {
      // 3) `mise which claude` を試す。mise が PATH にあって user が node@... を
      //    install していれば、これでラッパーパスが返る。
      try {
        const out = execSync("mise which claude", {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        if (out) {
          const lower = out.toLowerCase();
          if (lower.endsWith(".exe")) return out;
          if (lower.endsWith(".cmd") || lower.endsWith(".ps1") || !path.extname(out)) {
            const native = npmDirToNativeExe(path.dirname(out));
            if (native) return native;
          }
          output.appendLine(
            `[ccmgr] WARN: mise which claude → ${out} but could not locate native claude.exe under it`,
          );
        }
      } catch {
        // mise not available or no claude in any node tool
      }

      // 4) 既知の mise install dir を直接スキャン (mise 未 activate でも効く)
      const home = os.homedir();
      const localApp =
        process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
      const candidates = [
        path.join(localApp, "mise", "installs", "node"),
        path.join(home, ".local", "share", "mise", "installs", "node"),
      ];
      for (const root of candidates) {
        let versions: string[];
        try {
          versions = readdirSync(root);
        } catch {
          continue;
        }
        for (const v of versions) {
          const native = npmDirToNativeExe(path.join(root, v));
          if (native) {
            output.appendLine(
              `[ccmgr] found claude via mise install dir scan: ${native}`,
            );
            return native;
          }
        }
      }
    }

    return undefined;
  };
  const claudePath = resolveClaudePath();
  output.appendLine(
    `[ccmgr] claude CLI path: ${claudePath ?? "(NOT FOUND — sessions cannot be started)"}`,
  );

  /**
   * CLI が見つからない場合、起動経路のあるコマンドで毎回出すエラー導線。
   * Tree (jsonl 読み取り) 系は CLI 非依存なので activate 自体は続行する。
   *
   * 返り値: 起動可能なら true (= claudePath が有効)、未設定なら false。
   * 呼び出し側は false 時は早期 return する。
   */
  const ensureClaudePathOrPrompt = (): boolean => {
    if (claudePath) return true;
    void vscode.window
      .showErrorMessage(
        "Claude Code Manager: `claude` CLI が見つかりません。`npm i -g @anthropic-ai/claude-code` でインストールするか、`claudeCodeManager.claudePath` に絶対パスを設定してください。",
        "設定を開く",
      )
      .then((sel) => {
        if (sel === "設定を開く") {
          void vscode.commands.executeCommand(
            "workbench.action.openSettings",
            "claudeCodeManager.claudePath",
          );
        }
      });
    return false;
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
  const forgottenStore = new ForgottenStore(context.globalState);
  const folders = new FolderStore(context.globalState);
  const titleStore = new TitleStore(context.globalState);

  watcher.on("event", (evt) => {
    // 永続削除されたセッションは jsonl 更新を一切無視する。registry に載せない
    // ことでメモリ消費を抑えるとともに、TreeProvider 側のフィルタに依存せず
    // 復活されない保証を最上流で担保する。
    if (forgottenStore.has(evt.sessionId)) return;
    registry.ingest(evt);
  });

  const treeProvider = new SessionsTreeProvider(
    registry,
    hiddenStore,
    forgottenStore,
    folders,
    titleStore,
  );
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
  // ClaudeProcess 内のデバッグ (canUseTool 発火等) を OutputChannel へ流す。
  // AskUserQuestion の skip 調査が主目的。3 箇所の create/resume 呼び出しで共有。
  const procLogger = (msg: string): void => output.appendLine(msg);
  const managedStore = new ManagedSessionStore(context.globalState);
  // 携帯/ブラウザから操作するための並走 `claude remote-control` プロセス管理。
  // Webview セッション (headless CLI) とは別会話。
  const remoteControl = new RemoteControlManager();

  // Restore previously-managed sessions as suspended on activate.
  // 古い session でも `~/.claude/projects/.../<sid>.jsonl` が残ってれば
  // panel 復元時に replay できるよう、ここで filePath を解決して registry に渡す。
  for (const snap of managedStore.list()) {
    // 永続削除されたセッションは managed として記録されていても復元しない。
    // (Remove 時に managedStore.remove() するので通常はここに来ないが、
    //  二重防御として forgottenStore も見ておく)
    if (forgottenStore.has(snap.sessionId)) continue;
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
    if (!ensureClaudePathOrPrompt()) return undefined;

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
        pathToClaudeCodeExecutable: claudePath,
        logger: procLogger,
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
    processManager.resume(sessionId, state.cwd, {
      permissionMode: startMode,
      pathToClaudeCodeExecutable: claudePath,
      logger: procLogger,
    });
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
    onSubmit: (sessionId, text, attachments) => {
      const activeId = ensureManagedProcess(sessionId);
      if (!activeId) {
        vscode.window.showWarningMessage(
          "Claude Code Manager: このセッションを起動できません",
        );
        return;
      }
      processManager.send(activeId, text, attachments);
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
      // Remote Control バナーの初期状態 (off or 既存 active) を流す。
      const rcInfo = remoteControl.getInfo(sessionId);
      panelManager.pushRemoteControl(sessionId, {
        status: rcInfo?.status ?? "off",
        url: rcInfo?.url,
        name: rcInfo?.name,
      });
    },
    onInterrupt: (sessionId) => {
      void (async () => {
        try {
          await processManager.interrupt(sessionId);
          panelManager.pushStatus(sessionId, "生成を中断しました", "info");
        } catch (err) {
          output.appendLine(
            `[ccmgr] interrupt failed sid=${sessionId.slice(0, 8)}: ${(err as Error).message}`,
          );
        }
      })();
    },
    onPermissionResponse: (sessionId, requestId, result) => {
      const ok = processManager.resolvePermission(sessionId, requestId, result);
      output.appendLine(
        `[ccmgr] permission ${result.behavior} reqId=${requestId.slice(0, 8)} delivered=${ok}`,
      );
    },
    onToggleRemoteControl: (sessionId) => {
      toggleRemoteControl(sessionId);
    },
    onOpenExternalUrl: (url) => {
      // Webview 内 a 要素は CSP で外部へ遷移できないので、ここで openExternal を呼ぶ。
      // remote-control 系以外の任意 URL が来ても困るので、claude.ai / claude.com 限定。
      if (!/^https:\/\/[a-z0-9.-]*claude\.(ai|com)\//i.test(url)) {
        output.appendLine(`[ccmgr] openExternal rejected (non-claude host): ${url}`);
        return;
      }
      void vscode.env.openExternal(vscode.Uri.parse(url));
    },
  });

  /**
   * Remote Control 並走モードの起動/停止トグル。
   *
   * - 起動中なら停止
   * - 未起動なら `claude remote-control --spawn session` を子プロセスで起動
   *
   * Webview セッション (headless CLI) と claude.ai/code 側セッションは別会話なので
   * 履歴は同期しない。携帯から続きを書きたい時の「逃げ道」として使う。
   */
  const toggleRemoteControl = (sessionId: string): void => {
    if (remoteControl.isActive(sessionId)) {
      output.appendLine(`[rc] stop requested sid=${sessionId.slice(0, 8)}`);
      remoteControl.stop(sessionId);
      return;
    }
    if (!ensureClaudePathOrPrompt()) return;
    const state = registry.get(sessionId);
    if (!state) {
      vscode.window.showWarningMessage(
        "Claude Code Manager: セッションが見つかりません",
      );
      return;
    }
    const name = `${state.projectName} · remote`;
    try {
      const info = remoteControl.start(sessionId, {
        pathToClaudeCodeExecutable: claudePath!,
        cwd: state.cwd,
        name,
        logger: procLogger,
      });
      panelManager.pushRemoteControl(sessionId, {
        status: info.status,
        url: info.url,
        name: info.name,
      });
      panelManager.pushStatus(
        sessionId,
        "Remote Control を起動中… URL 取得まで数秒お待ちください",
        "info",
      );
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      panelManager.pushStatus(
        sessionId,
        `Remote Control 起動失敗: ${e.message}`,
        "error",
      );
    }
  };

  remoteControl.on("started", (info) => {
    output.appendLine(
      `[rc] active sid=${info.sessionId.slice(0, 8)} url=${info.url ?? "?"}`,
    );
    panelManager.pushRemoteControl(info.sessionId, {
      status: "active",
      url: info.url,
      name: info.name,
    });
    if (info.url) {
      void vscode.window
        .showInformationMessage(
          `Remote Control を起動しました: ${info.url}`,
          "ブラウザで開く",
          "URL をコピー",
        )
        .then((sel) => {
          if (sel === "ブラウザで開く") {
            void vscode.env.openExternal(vscode.Uri.parse(info.url!));
          } else if (sel === "URL をコピー") {
            void vscode.env.clipboard.writeText(info.url!);
          }
        });
    }
  });
  remoteControl.on("stopped", (sessionId) => {
    output.appendLine(`[rc] stopped sid=${sessionId.slice(0, 8)}`);
    panelManager.pushRemoteControl(sessionId, { status: "off" });
    panelManager.pushStatus(sessionId, "Remote Control を停止しました", "info");
  });
  remoteControl.on("error", (sessionId, err) => {
    output.appendLine(
      `[rc] error sid=${sessionId.slice(0, 8)} ${err.message}`,
    );
    panelManager.pushRemoteControl(sessionId, { status: "off" });
    panelManager.pushStatus(
      sessionId,
      `Remote Control エラー: ${err.message}`,
      "error",
    );
  });

  // SDK の canUseTool callback で発生した承認依頼を webview へ転送
  processManager.on("permissionRequest", (id, req) => {
    output.appendLine(
      `[ccmgr] permission request sid=${id.slice(0, 8)} tool=${req.toolName} reqId=${req.requestId.slice(0, 8)} title=${JSON.stringify(req.title ?? null)}`,
    );
    // AskUserQuestion は input.questions[] の件数まで出す。これで「UI に届く
    // 前に SDK 側で消えた」のか「届いたが panel が無くて drop した」のかを
    // 切り分けやすくなる。
    if (req.toolName === "AskUserQuestion") {
      const qs = (req.input as { questions?: unknown })?.questions;
      output.appendLine(
        `  AskUserQuestion: ${Array.isArray(qs) ? qs.length : 0} question(s)`,
      );
    }
    panelManager.pushPermissionRequest(id, req);
  });

  // ProcessManager のイベントを Tree / Panel / Persistence に橋渡し。
  processManager.on("promoted", ({ pendingId, sessionId }) => {
    registry.promotePending(pendingId, sessionId);
    panelManager.rekey(pendingId, sessionId);
    void titleStore.rename(pendingId, sessionId);
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

  // SDK 公式 API `Query.getContextUsage()` を使ったコンテキスト使用率の取得。
  //   - `result` メッセージは stream 全体が閉じる時にしか来ないので対話中は届かない
  //     (実測で確認済み)。なので `assistant` メッセージ到着のタイミングで
  //     getContextUsage() を呼び、現在の使用率を取り直す。
  //   - レスポンスの `percentage` は SDK が内部で計算した値で、deferred tools や
  //     autocompact buffer も含む正確な値。`apiKeySource=none` でも動く。
  //   - 同一 session で同時に in-flight しないよう、簡易な lock を入れる。
  const contextUsageInFlight = new Set<string>();
  const refreshContextUsage = async (id: string): Promise<void> => {
    if (contextUsageInFlight.has(id)) return;
    contextUsageInFlight.add(id);
    try {
      const res = (await processManager.getContextUsage(id)) as
        | { percentage?: number; totalTokens?: number; maxTokens?: number }
        | undefined;
      if (!res || typeof res.percentage !== "number") return;
      const usedPct = Math.max(0, Math.min(100, Math.round(res.percentage)));
      const remainingPct = 100 - usedPct;
      if (panelManager.hasPanel(id)) {
        panelManager.pushContextWindow(id, {
          usedPercentage: usedPct,
          remainingPercentage: remainingPct,
        });
      }
      output.appendLine(
        `[ctx] sid=${id.slice(0, 8)} used=${usedPct}% (${res.totalTokens ?? "?"}/${res.maxTokens ?? "?"})`,
      );
    } catch (err) {
      output.appendLine(
        `[ctx] getContextUsage failed sid=${id.slice(0, 8)}: ${(err as Error).message}`,
      );
    } finally {
      contextUsageInFlight.delete(id);
    }
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
      // init 直後にも一度コンテキスト使用率を取って、新規セッションでも
      // ヘッダーバーが出るようにする (system prompt や tools 由来の初期トークン分)。
      void refreshContextUsage(id);
    }

    // assistant メッセージ受信時に SDK 公式の getContextUsage を呼んで更新する。
    // 応答完了直後のタイミングなのでユーザー体感的にも自然。
    if (t === "assistant") {
      void refreshContextUsage(id);
      // AskUserQuestion 用調査ログ: assistant が AskUserQuestion の tool_use を
      // 投げてきたら明示的に記録する。直後に canUseTool 発火ログが続けば
      // 期待通り。続かなければ SDK 側で auto-deny されている (= H1/H4 の証拠)。
      const content = (msg as { message?: { content?: unknown } })?.message
        ?.content;
      if (Array.isArray(content)) {
        for (const part of content as Array<{
          type?: string;
          name?: string;
          id?: string;
        }>) {
          if (part?.type === "tool_use" && part?.name === "AskUserQuestion") {
            output.appendLine(
              `[ccmgr] assistant emitted AskUserQuestion tool_use id=${(part.id ?? "").slice(0, 8)} sid=${id.slice(0, 8)} -- expecting canUseTool callback`,
            );
          }
        }
      }
    }

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
    sessionModes.delete(id);
    sdkCommandsCache.delete(id);
    contextUsageInFlight.delete(id);
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

  // statusline JSON 監視: Claude Code 本体が `~/.claude/ccmgr-statusline.sh` 経由で
  // `/tmp/claude-statusline-input.json` を書き換えるので context_window を
  // session_id が一致する SessionPanel のヘッダーバーへ流す。
  // rate_limits は SDK 経由 (apiKeySource=none) では取れないことが調査済みなので
  // 非表示方針。statusline JSON 自体は CLI 対話モード時のみ更新される。
  const statuslineMonitor = new StatuslineMonitor();
  statuslineMonitor.on("update", (payload) => {
    if (!payload.contextWindow) return;
    if (panelManager.hasPanel(payload.sessionId)) {
      panelManager.pushContextWindow(payload.sessionId, payload.contextWindow);
    }
  });
  statuslineMonitor.start();

  context.subscriptions.push(
    output,
    treeView,
    treeProvider,
    hiddenStore,
    forgottenStore,
    titleStore,
    statusBar,
    { dispose: () => statuslineMonitor.dispose() },
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
      "claudeCodeManager.renameSession",
      async (target: unknown) => {
        const sessionId = resolveSessionId(target);
        if (!sessionId) return;
        const state = registry.get(sessionId);
        const currentCustom = titleStore.get(sessionId) ?? "";
        // 既存タイトル (custom があればそれ、なければ最初の user メッセージから生成)
        const initialValue =
          currentCustom ||
          (state?.firstUserPrompt
            ? state.firstUserPrompt.replace(/\s+/g, " ").trim().slice(0, 80)
            : "");
        const next = await vscode.window.showInputBox({
          title: "セッション題名の変更",
          prompt: "新しい題名を入力 (空欄で自動生成に戻る)",
          value: initialValue,
          ignoreFocusOut: true,
        });
        if (next === undefined) return; // キャンセル
        await titleStore.set(sessionId, next);
      },
    ),
    vscode.commands.registerCommand(
      "claudeCodeManager.resetSessionTitle",
      async (target: unknown) => {
        const sessionId = resolveSessionId(target);
        if (!sessionId) return;
        await titleStore.remove(sessionId);
      },
    ),
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
        if (!ensureClaudePathOrPrompt()) return;
        const startMode = getDefaultPermissionMode();
        const { id } = processManager.create(cwd, {
          permissionMode: startMode,
          pathToClaudeCodeExecutable: claudePath,
          logger: procLogger,
        });
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
      },
    ),
    vscode.commands.registerCommand(
      "claudeCodeManager.toggleRemoteControl",
      (target: unknown) => {
        const sessionId = resolveSessionId(target);
        if (!sessionId) {
          vscode.window.showWarningMessage(
            "Claude Code Manager: セッションを指定してください",
          );
          return;
        }
        toggleRemoteControl(sessionId);
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
        // 各項目の右側に表示する「ゴミ箱ボタン」。クリックすると永続削除へ昇格する。
        const trashButton: vscode.QuickInputButton = {
          iconPath: new vscode.ThemeIcon("trash"),
          tooltip: "Remove permanently (Show Removed Sessions... から復元可能)",
        };
        type Item = vscode.QuickPickItem & {
          sessionId: string;
          buttons?: vscode.QuickInputButton[];
        };
        const items: Item[] = ids.map((sessionId) => {
          const state = registry.get(sessionId);
          const project = state?.projectName ?? "(unknown project)";
          const branch = state?.gitBranch ? ` (${state.gitBranch})` : "";
          return {
            sessionId,
            label: `$(eye) ${project}${branch}`,
            description: sessionId.slice(0, 8),
            detail: state?.lastAssistantText ?? state?.lastUserPrompt ?? "",
            buttons: [trashButton],
          };
        });
        items.push({
          sessionId: "__clear_all__",
          label: "$(clear-all) Clear All Hidden",
          description: `${ids.length} sessions`,
        });

        // showQuickPick は item buttons をサポートしないので createQuickPick で構築する。
        // ボタンクリック (= remove) と enter (= restore) を別ハンドラで処理。
        await new Promise<void>((resolve) => {
          const qp = vscode.window.createQuickPick<Item>();
          qp.title = "Hidden Sessions — Enter で復元 / ゴミ箱で永続削除";
          qp.placeholder = "復元するセッションを選択 (各項目のゴミ箱で永続削除)";
          qp.canSelectMany = false;
          qp.items = items;
          qp.onDidTriggerItemButton(async (e) => {
            const item = e.item;
            if (item.sessionId === "__clear_all__") return;
            qp.hide();
            await removeSessionPermanently(item.sessionId);
            resolve();
          });
          qp.onDidAccept(async () => {
            const picked = qp.selectedItems[0];
            qp.hide();
            if (!picked) {
              resolve();
              return;
            }
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
            resolve();
          });
          qp.onDidHide(() => {
            qp.dispose();
            resolve();
          });
          qp.show();
        });
      },
    ),
    vscode.commands.registerCommand(
      "claudeCodeManager.removeSession",
      async (target: unknown) => {
        const sessionId = resolveSessionId(target);
        if (!sessionId) return;
        await removeSessionPermanently(sessionId);
      },
    ),
    vscode.commands.registerCommand(
      "claudeCodeManager.showForgottenSessions",
      async () => {
        const ids = forgottenStore.list();
        if (ids.length === 0) {
          vscode.window.showInformationMessage(
            "Claude Code Manager: 永続削除されたセッションはありません",
          );
          return;
        }
        // forgotten セッションは registry に載っていないため、preview / project 名は
        // 取れない (= sessionId 先頭 8 文字でしか識別できない)。これは仕様。
        // jsonl からメタ情報を再読み込みする手も理論上はあるが、「永続削除」の
        // 意味からして load しない方がメモリ・I/O ともに健全。
        type Item = vscode.QuickPickItem & { sessionId: string };
        const items: Item[] = ids.map((sessionId) => ({
          sessionId,
          label: `$(trash) ${sessionId.slice(0, 8)}`,
          description: "永続削除済み",
        }));
        items.push({
          sessionId: "__clear_all__",
          label: "$(clear-all) Restore All Removed",
          description: `${ids.length} sessions`,
        });
        const picked = await vscode.window.showQuickPick(items, {
          title: "Removed Sessions — 選択して復活",
          placeHolder: "復活させるセッションを選択",
          canPickMany: false,
        });
        if (!picked) return;
        if (picked.sessionId === "__clear_all__") {
          await forgottenStore.clear();
          vscode.window.setStatusBarMessage(
            "All removed sessions restored (jsonl 更新時に再表示されます)",
            5000,
          );
        } else {
          await forgottenStore.remove(picked.sessionId);
          vscode.window.setStatusBarMessage(
            `Restored ${picked.sessionId.slice(0, 8)} (jsonl 更新時に再表示されます)`,
            5000,
          );
        }
      },
    ),
  );

  /**
   * セッションを「永続削除」する。確認ダイアログを出し、OK なら:
   *   1. forgottenStore に追加 (= watcher の event を以後破棄)
   *   2. hiddenStore からは消す (重複保持を防ぐ)
   *   3. managed なら process を止めて managedStore からも消す
   *   4. panel が開いていれば閉じる
   *   5. registry からも消す
   *
   * 結果: VSCode を再起動しても、jsonl が更新されても二度と表示されない。
   * 復活させたい場合は `Show Removed Sessions...` から行う。
   */
  async function removeSessionPermanently(sessionId: string): Promise<void> {
    const state = registry.get(sessionId);
    const project = state?.projectName ?? sessionId.slice(0, 8);
    const confirm = await vscode.window.showWarningMessage(
      `セッション ${project} (${sessionId.slice(0, 8)}) を永続的に削除しますか?\n\n` +
        `・ サイドバーに二度と表示されません (VSCode 再起動後も)\n` +
        `・ jsonl 履歴自体はディスクに残ります\n` +
        `・ 復活は "Show Removed Sessions..." から可能です`,
      { modal: true },
      "削除",
    );
    if (confirm !== "削除") return;

    await forgottenStore.add(sessionId);
    // hiddenStore に入っていれば取り除く (forgotten が優先で重複保持の意味がない)
    if (hiddenStore.has(sessionId)) {
      await hiddenStore.remove(sessionId);
    }
    // managed セッションなら関連リソースを後片付け
    if (processManager.has(sessionId)) {
      await processManager.dispose(sessionId);
    }
    await managedStore.remove(sessionId);
    panelManager.disposePanel(sessionId);
    registry.removeSession(sessionId);
    vscode.window.setStatusBarMessage(
      `Removed ${sessionId.slice(0, 8)} permanently`,
      3000,
    );
  }

  registry.start();
  watcher.start();

  context.subscriptions.push({
    dispose: () => {
      registry.stop();
      void watcher.stop();
      remoteControl.disposeAll();
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

