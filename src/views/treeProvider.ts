import * as vscode from "vscode";
import { FolderEntry, FolderStore, labelOf } from "../folders/store";
import { HiddenStore } from "../sessions/hiddenStore";
import { SessionRegistry } from "../sessions/registry";
import { SessionState, SessionStatus } from "../sessions/types";

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
    this.iconPath = new vscode.ThemeIcon(
      entry.source === "workspace" ? "root-folder" : "folder",
    );
    const counts = countByStatus(sessions);
    const summary: string[] = [];
    if (counts.running) summary.push(`${counts.running} running`);
    if (counts.waiting) summary.push(`${counts.waiting} waiting`);
    if (counts.idle) summary.push(`${counts.idle} idle`);
    if (counts.stale) summary.push(`${counts.stale} stale`);
    this.description = summary.join(" · ");
    this.tooltip = entry.cwd;
  }
}

class SessionNode extends vscode.TreeItem {
  readonly kind = "session" as const;
  constructor(public readonly state: SessionState) {
    super(buildLabel(state), vscode.TreeItemCollapsibleState.None);
    this.id = `session:${state.sessionId}`;
    this.contextValue =
      state.origin === "managed" ? "session.managed" : "session.external";
    this.iconPath = iconForState(state);
    this.description = buildDescription(state);
    this.tooltip = buildTooltip(state);
    this.command = {
      command: "claudeCodeManager.openSession",
      title: "Open Session",
      arguments: [state.sessionId],
    };
  }
}

class ActionNode extends vscode.TreeItem {
  readonly kind = "action" as const;
  constructor(
    public readonly action: "newSession" | "addFolder",
    public readonly cwd?: string,
  ) {
    const opts: { label: string; icon: string; cmd: string } =
      action === "newSession"
        ? {
            label: "+ New Session",
            icon: "plus",
            cmd: "claudeCodeManager.newSession",
          }
        : {
            label: "+ Add Folder",
            icon: "new-folder",
            cmd: "claudeCodeManager.addFolder",
          };
    super(opts.label, vscode.TreeItemCollapsibleState.None);
    this.id =
      action === "newSession" ? `action:newSession:${cwd}` : "action:addFolder";
    this.contextValue = `action.${action}`;
    this.iconPath = new vscode.ThemeIcon(opts.icon);
    this.command = {
      command: opts.cmd,
      title: opts.label,
      arguments: cwd ? [{ cwd }] : [],
    };
  }
}

export class SessionsTreeProvider
  implements vscode.TreeDataProvider<TreeNode>
{
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private registry: SessionRegistry,
    private hiddenStore: HiddenStore,
    private folders: FolderStore,
  ) {
    registry.on("changed", () => this._onDidChangeTreeData.fire(undefined));
    registry.on("removed", () => this._onDidChangeTreeData.fire(undefined));
    registry.on("snapshot", () => this._onDidChangeTreeData.fire(undefined));
    hiddenStore.on("changed", () =>
      this._onDidChangeTreeData.fire(undefined),
    );
    folders.on("changed", () => this._onDidChangeTreeData.fire(undefined));
    setInterval(() => this._onDidChangeTreeData.fire(undefined), 30_000);
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
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
      return [...folderNodes, new ActionNode("addFolder")];
    }
    if (element.kind === "folder") {
      const sessionItems = element.sessions.map((s) => new SessionNode(s));
      return [new ActionNode("newSession", element.entry.cwd), ...sessionItems];
    }
    return [];
  }
}

const buildLabel = (s: SessionState): string => {
  const branch = s.gitBranch ? ` (${s.gitBranch})` : "";
  return `${statusGlyph(s)} ${s.sessionId.slice(0, 8)}${branch}`;
};

const buildDescription = (s: SessionState): string => {
  const preview = s.lastAssistantText ?? s.lastUserPrompt ?? "";
  const compact = preview.replace(/\s+/g, " ").trim();
  const elapsed = formatElapsed(Date.now() - s.lastEventAt);
  // managed = 拡張内チャット可 / external = 外部 (jsonl 観測のみ、直接対話できない)
  const tag = s.origin === "managed" ? "chat" : "履歴";
  const head = compact ? `「${truncate(compact, 60)}」` : "";
  return [tag, head, elapsed].filter(Boolean).join(" · ");
};

const buildTooltip = (s: SessionState): vscode.MarkdownString => {
  const md = new vscode.MarkdownString();
  md.isTrusted = false;
  md.supportThemeIcons = true;
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

const statusGlyph = (s: SessionState): string => {
  if (s.isSuspended) return "⏸";
  switch (s.status) {
    case "running":
      return "●";
    case "waiting":
      return "⚠";
    case "idle":
      return "○";
    case "stale":
      return "·";
  }
};

const iconForState = (s: SessionState): vscode.ThemeIcon => {
  if (s.isSuspended) {
    return new vscode.ThemeIcon(
      "debug-pause",
      new vscode.ThemeColor("charts.purple"),
    );
  }
  return iconForStatus(s.status, s.origin);
};

const iconForStatus = (
  status: SessionStatus,
  origin: SessionState["origin"],
): vscode.ThemeIcon => {
  const color = origin === "managed" ? "charts.green" : "charts.blue";
  switch (status) {
    case "running":
      return new vscode.ThemeIcon("loading~spin", new vscode.ThemeColor(color));
    case "waiting":
      return new vscode.ThemeIcon(
        "question",
        new vscode.ThemeColor("charts.yellow"),
      );
    case "idle":
      return new vscode.ThemeIcon(
        "circle-outline",
        new vscode.ThemeColor(color),
      );
    case "stale":
      return new vscode.ThemeIcon(
        "circle-slash",
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

const truncate = (text: string, max: number): string =>
  text.length > max ? text.slice(0, max - 1).trimEnd() + "…" : text;
