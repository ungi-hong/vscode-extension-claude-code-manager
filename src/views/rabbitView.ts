import * as vscode from "vscode";

/**
 * 🐰 サイドバー WebviewView — うさぎ GIF を表示するだけの最小実装。
 *
 * 旧トークン使用率機能 (rate_limits / context_window 表示など) は一度すべて
 * 削除し、ここから再度設計し直す前提でスケルトン状態にしてある。
 */
export class RabbitWebviewProvider
  implements vscode.WebviewViewProvider, vscode.Disposable
{
  public static readonly viewType = "ccmgr.rabbit";

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    webviewView.webview.options = {
      enableScripts: false, // 表示するのは GIF のみなのでスクリプト不要
      localResourceRoots: [this.extensionUri],
    };
    webviewView.webview.html = this.renderHtml(webviewView.webview);
  }

  dispose(): void {
    // 監視対象なし。WebviewView 本体は VS Code 側で破棄される。
  }

  private renderHtml(webview: vscode.Webview): string {
    // とりあえずデフォルトは rabbit-20。後で動的に切り替える実装に差し替える。
    const rabbitUri = webview
      .asWebviewUri(
        vscode.Uri.joinPath(
          this.extensionUri,
          "src",
          "views",
          "images",
          "rabbit-20.gif",
        ),
      )
      .toString();

    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `img-src ${webview.cspSource}`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <style>
    body {
      margin: 0;
      padding: 16px 12px;
      font-family: var(--vscode-font-family);
      color: var(--vscode-editor-foreground);
      text-align: center;
    }
    .bunny {
      width: 100%;
      max-width: 120px;
      margin: 0 auto;
    }
    .bunny img {
      width: 100%;
      height: auto;
      display: block;
    }
  </style>
</head>
<body>
  <div class="bunny">
    <img src="${rabbitUri}" alt="rabbit" />
  </div>
</body>
</html>`;
  }
}
