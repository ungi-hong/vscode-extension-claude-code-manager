import * as vscode from "vscode";
import { FolderEntry, FolderStore, labelOf } from "../folders/store";
import { HiddenStore } from "../sessions/hiddenStore";
import { SessionRegistry } from "../sessions/registry";
import { TitleStore } from "../sessions/titleStore";
import { SessionState, SessionStatus } from "../sessions/types";
import { truncate } from "../utils/text";

type TreeNode = FolderNode | SessionNode | ActionNode;

class FolderNode extends vscode.TreeItem {
  readonly kind = "folder" as const;
  constructor(
    public readonly entry: FolderEntry,
    public readonly sessions: SessionState[],
  ) {
    super(labelOf(entry), vscode.TreeItemCollapsibleState.Expanded);
    this.id = `folder:${entry.cwd}`;
    this.contextValue =
      entry.source === "user" ? "folder.user" : "folder.workspace";
    // アイコンは "folder" に統一する。`root-folder` と混在するとアイコン幅の
    // 微妙な違いで子要素 (+ New Session) のインデントがズレて見えるため。
    // workspace との区別は contextValue (削除ボタンの出し分け) と
    // description 末尾の [workspace] タグで行う。
    this.iconPath = new vscode.ThemeIcon("folder");
    const counts = countByStatus(sessions);
    const summary: string[] = [];
    if (counts.running) summary.push(`${counts.running} running`);
    if (counts.waiting) summary.push(`${counts.waiting} waiting`);
    if (counts.idle) summary.push(`${counts.idle} idle`);
    if (counts.stale) summary.push(`${counts.stale} stale`);
    if (entry.source === "workspace") summary.push("workspace");
    this.description = summary.join(" · ");
    this.tooltip = entry.cwd;
  }
}

class SessionNode extends vscode.TreeItem {
  readonly kind = "session" as const;
  constructor(
    public readonly state: SessionState,
    customTitle: string | undefined,
  ) {
    super(buildLabel(state, customTitle), vscode.TreeItemCollapsibleState.None);
    this.id = `session:${state.sessionId}`;
    this.contextValue =
      state.origin === "managed" ? "session.managed" : "session.external";
    this.iconPath = iconForState(state);
    this.description = buildDescription(state);
    this.tooltip = buildTooltip(state, customTitle);
    this.command = {
      command: "claudeCodeManager.openSession",
      title: "Open Session",
      arguments: [state.sessionId],
    };
  }
}

class ActionNode extends vscode.TreeItem {
  readonly kind = "action" as const;
  // フォルダの子として並ぶ "+ New Session" のみ。Add Folder は viewTitle の
  // ツールバー ($(new-folder)) に寄せたためツリー内には出さない。
  constructor(public readonly cwd: string) {
    super("+ New Session", vscode.TreeItemCollapsibleState.None);
    this.id = `action:newSession:${cwd}`;
    this.contextValue = "action.newSession";
    this.iconPath = new vscode.ThemeIcon("plus");
    this.command = {
      command: "claudeCodeManager.newSession",
      title: "+ New Session",
      arguments: [{ cwd }],
    };
  }
}

export class SessionsTreeProvider
  implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable
{
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private timer: NodeJS.Timeout;

  constructor(
    private registry: SessionRegistry,
    private hiddenStore: HiddenStore,
    private folders: FolderStore,
    private titleStore: TitleStore,
  ) {
    registry.on("changed", () => this._onDidChangeTreeData.fire(undefined));
    registry.on("removed", () => this._onDidChangeTreeData.fire(undefined));
    registry.on("snapshot", () => this._onDidChangeTreeData.fire(undefined));
    hiddenStore.on("changed", () =>
      this._onDidChangeTreeData.fire(undefined),
    );
    folders.on("changed", () => this._onDidChangeTreeData.fire(undefined));
    titleStore.on("changed", () =>
      this._onDidChangeTreeData.fire(undefined),
    );
    this.timer = setInterval(
      () => this._onDidChangeTreeData.fire(undefined),
      30_000,
    );
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  dispose(): void {
    clearInterval(this.timer);
    this._onDidChangeTreeData.dispose();
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TreeNode): TreeNode[] {
    if (!element) {
      const sessionsByCwd = new Map<string, SessionState[]>();
      for (const s of this.registry.list()) {
        if (this.hiddenStore.has(s.sessionId)) continue;
        const arr = sessionsByCwd.get(s.cwd) ?? [];
        arr.push(s);
        sessionsByCwd.set(s.cwd, arr);
      }
      // ベースフォルダ集合 = 登録フォルダ ∪ セッションが居る cwd
      const folderMap = new Map<string, FolderEntry>();
      for (const f of this.folders.list()) folderMap.set(f.cwd, f);
      for (const cwd of sessionsByCwd.keys()) {
        if (!folderMap.has(cwd)) {
          // 観測のみで登録外。フォルダ表示はするが、登録は user フォルダではない
          folderMap.set(cwd, { cwd, source: "workspace" });
        }
      }
      const folderNodes: FolderNode[] = [];
      for (const [cwd, entry] of folderMap) {
        const sessions = (sessionsByCwd.get(cwd) ?? []).slice();
        sessions.sort((a, b) => b.lastEventAt - a.lastEventAt);
        folderNodes.push(new FolderNode(entry, sessions));
      }
      folderNodes.sort((a, b) => {
        const aLast = a.sessions[0]?.lastEventAt ?? 0;
        const bLast = b.sessions[0]?.lastEventAt ?? 0;
        if (bLast !== aLast) return bLast - aLast;
        return labelOf(a.entry).localeCompare(labelOf(b.entry));
      });
      // "+ Add Folder" はツリー内には出さない。viewTitle の toolbar
      // ($(new-folder)) で同等機能を提供する。
      return folderNodes;
    }
    if (element.kind === "folder") {
      const sessionItems = element.sessions.map(
        (s) => new SessionNode(s, this.titleStore.get(s.sessionId)),
      );
      return [new ActionNode(element.entry.cwd), ...sessionItems];
    }
    return [];
  }
}

const buildLabel = (s: SessionState, customTitle?: string): string => {
  // 優先順位: ① 手動で付けたカスタム題名 ② 最初の user メッセージ (auto) ③ sessionId 先頭8文字
  // 状態は iconPath (VS Code アイコン) が表現するので label には glyph を付けない。
  // ブランチも description 側に移して label は「題名そのもの」に絞る。
  return (
    customTitle ||
    autoTitleFromFirstPrompt(s.firstUserPrompt) ||
    s.sessionId.slice(0, 8)
  );
};

/**
 * Claude Code が user prompt に挿入する `<command-message>` / `<command-name>` /
 * `<local-command-*>` / `<system-reminder>` のような特殊タグを取り除き、
 * 人間可読な auto title を生成する。
 *
 * 例:
 * - `<command-message>fe-pr:fe-pr</command-message>` → `/fe-pr`
 * - `<command-name>create-pr</command-name>\n<command-args>...` → `/create-pr ...`
 * - 通常テキスト → そのまま (40 文字超は省略)
 */
const autoTitleFromFirstPrompt = (raw?: string): string => {
  if (!raw) return "";
  // 1) slash command 実行を示すパターンを優先的に抽出
  const cmdName = raw.match(/<command-name>([^<]+)<\/command-name>/);
  if (cmdName) {
    const name = cmdName[1].trim().replace(/^\/+/, "").split(":")[0];
    const argMatch = raw.match(/<command-args>([^<]*)<\/command-args>/);
    const args = argMatch ? argMatch[1].trim() : "";
    return truncateOneLine(args ? `/${name} ${args}` : `/${name}`, 40);
  }
  // command-message タグだけがあるケース (XML のみで本文がない場合) も拾う
  const cmdMsg = raw.match(/<command-message>([^<]+)<\/command-message>/);
  if (cmdMsg) {
    const name = cmdMsg[1].trim().replace(/^\/+/, "").split(":")[0];
    return truncateOneLine(`/${name}`, 40);
  }
  // 2) その他の XML 風タグを除去してプレーン化
  const plain = raw
    .replace(/<[^>]+>/g, " ") // タグ全般を空白に
    .replace(/\s+/g, " ")
    .trim();
  return truncateOneLine(plain, 40);
};

const truncateOneLine = (s: string, max: number): string => {
  if (!s) return "";
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
};

const buildDescription = (s: SessionState): string => {
  // description は label の右に薄字で出る補足情報。短く整理する。
  // 順序: [branch] · preview · elapsed
  const branch = s.gitBranch ? `[${s.gitBranch}]` : "";
  const preview = s.lastAssistantText ?? s.lastUserPrompt ?? "";
  const compact = preview.replace(/\s+/g, " ").trim();
  // プレビューは 36 文字程度に抑える (長文だと elapsed が埋もれるため)。
  const head = compact ? truncate(compact, 36) : "";
  const elapsed = formatElapsed(Date.now() - s.lastEventAt);
  return [branch, head, elapsed].filter(Boolean).join(" · ");
};

const buildTooltip = (
  s: SessionState,
  customTitle?: string,
): vscode.MarkdownString => {
  const md = new vscode.MarkdownString();
  md.isTrusted = false;
  md.supportThemeIcons = true;
  if (customTitle) md.appendMarkdown(`**Title**: ${customTitle}\n\n`);
  md.appendMarkdown(`**Origin**: ${s.origin}\n\n`);
  md.appendMarkdown(`**Status**: ${s.status}\n\n`);
  md.appendMarkdown(`**Project**: \`${s.cwd}\`\n\n`);
  if (s.gitBranch) md.appendMarkdown(`**Branch**: \`${s.gitBranch}\`\n\n`);
  md.appendMarkdown(`**Session**: \`${s.sessionId}\`\n\n`);
  md.appendMarkdown(
    `**Started**: ${new Date(s.startedAt).toLocaleString()}\n\n`,
  );
  md.appendMarkdown(
    `**Last event**: ${new Date(s.lastEventAt).toLocaleString()}`,
  );
  if (s.lastUserPrompt) {
    md.appendMarkdown(`\n\n---\n\n**User**: ${truncate(s.lastUserPrompt, 200)}`);
  }
  if (s.lastAssistantText) {
    md.appendMarkdown(
      `\n\n**Assistant**: ${truncate(s.lastAssistantText, 200)}`,
    );
  }
  return md;
};

/**
 * セッションの状態アイコンを「経過時間軸」で整理する。
 *
 * - running        : Claude が思考中 → ローディング (青クルクル)
 * - 30 分以内      : アクティブ (waiting / idle) → 青枠丸
 * - 30 分超過      : stale → ⏸ (グレー)
 * - isSuspended    : ユーザー停止 → ⏸ (紫) で他と区別
 *
 * 30 分の閾値は config `claudeCodeManager.staleAfterMinutes` で
 * registry が既に `status === "stale"` を割り当ててくれているので、ここでは
 * `status` を信用してアイコンを引き当てるだけでよい。
 */
const iconForState = (s: SessionState): vscode.ThemeIcon => {
  if (s.isSuspended) {
    return new vscode.ThemeIcon(
      "debug-pause",
      new vscode.ThemeColor("charts.purple"),
    );
  }
  return iconForStatus(s.status);
};

const iconForStatus = (status: SessionStatus): vscode.ThemeIcon => {
  switch (status) {
    case "running":
      // 生成中: 青のクルクル
      return new vscode.ThemeIcon(
        "loading~spin",
        new vscode.ThemeColor("charts.blue"),
      );
    case "waiting":
    case "idle":
      // 直近 30 分以内のアクティブ: 青枠丸
      return new vscode.ThemeIcon(
        "circle-outline",
        new vscode.ThemeColor("charts.blue"),
      );
    case "stale":
      // 30 分超過: 一時停止アイコンで休眠を示す (グレー)
      return new vscode.ThemeIcon(
        "debug-pause",
        new vscode.ThemeColor("disabledForeground"),
      );
  }
};

const countByStatus = (sessions: SessionState[]) => {
  const c = { running: 0, waiting: 0, idle: 0, stale: 0 };
  for (const s of sessions) c[s.status] += 1;
  return c;
};

const formatElapsed = (ms: number): string => {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
};

