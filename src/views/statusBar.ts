import * as vscode from "vscode";
import { SessionRegistry } from "../sessions/registry";

export class StatusBar implements vscode.Disposable {
  private item: vscode.StatusBarItem;
  private timer: NodeJS.Timeout;

  constructor(private registry: SessionRegistry) {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      120,
    );
    this.item.command = "claudeCodeManager.focusSidebar";
    this.item.show();

    registry.on("changed", () => this.refresh());
    registry.on("snapshot", () => this.refresh());
    this.timer = setInterval(() => this.refresh(), 30_000);
    this.refresh();
  }

  refresh(): void {
    const sessions = this.registry.list();
    const running = sessions.filter((s) => s.status === "running").length;
    const waiting = sessions.filter((s) => s.status === "waiting").length;
    const idle = sessions.filter((s) => s.status === "idle").length;
    const total = running + waiting + idle;
    const parts: string[] = [];
    if (running) parts.push(`${running} running`);
    if (waiting) parts.push(`${waiting} waiting`);
    if (idle) parts.push(`${idle} idle`);
    if (total === 0) {
      this.item.text = "$(robot) CC: idle";
    } else {
      this.item.text = `$(robot) CC: ${parts.join(" · ")}`;
    }

    const tooltip = new vscode.MarkdownString();
    tooltip.isTrusted = false;
    tooltip.supportThemeIcons = true;
    tooltip.appendMarkdown(
      "Claude Code Manager — クリックでサイドバーを開く",
    );
    this.item.tooltip = tooltip;
  }

  dispose(): void {
    clearInterval(this.timer);
    this.item.dispose();
  }
}
