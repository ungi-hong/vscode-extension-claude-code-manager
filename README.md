# Claude Code Manager — VSCode / Cursor 拡張

並行で動作している複数の Claude Code セッションをサイドバーで一覧し、Webview 上で対話できるようにする拡張機能 (実装中)。

## ステータス

**Stage C 完了** — 拡張内 SDK チャット + 再起動 resume まで揃いました。

| ステージ | 内容 | ステータス |
|---|---|---|
| Stage A | ターミナル連携削除 + フォルダ階層 + 既存セッション読み取り表示 | ✅ 完了 |
| Stage B | 拡張内 `@anthropic-ai/claude-agent-sdk` 経由で claude を起動・チャット | ✅ 完了 |
| Stage C | 再起動時のセッション resume + ストリーミング UI | ✅ 完了 |

## できること

- Activity Bar に **🤖 Claude Code Manager** アイコン
- サイドバー TreeView に **フォルダ → セッション** の階層
  - フォルダ = リポジトリ (cwd)。`+ Add Folder` で手動追加 / 現在の VSCode workspace folder は自動取り込み
  - 各フォルダ配下に `+ New Session` と既存セッション一覧
- **拡張内チャット** (Stage B):
  - `+ New Session` でその場に claude セッションを起動 (`@anthropic-ai/claude-agent-sdk` 経由)
  - Webview パネルでチャット (Cmd+Enter で送信)
  - ストリーミング応答 (`text_delta` を progressive 表示)
  - 「考えています…」ドットアニメーションでフィードバック
  - エラー / 接続 / コンテキスト圧縮などのステータス行
- **既存ターミナル起動セッションの引き継ぎ**:
  - Tree に表示されているセッションをクリックして Webview を開き、入力欄に送信すると **拡張側で `claude --resume <sid>`** を呼んで以後はチャットで継続可能
  - jsonl 履歴は再生されるので会話の流れも残る
- **再起動 resume** (Stage C):
  - 拡張内で起動した managed セッションは `globalState` に永続化
  - VSCode/Cursor を再起動すると Tree に **⏸ suspended** で並ぶ
  - クリック → Webview を開いて入力すると自動で `claude --resume <sid>` が走り、続きから再開
  - 不要になった managed セッションは右クリックメニュー「Forget Managed Session」で削除 (jsonl 自体は残る)
- ステータス表示: `running` / `idle` / `waiting` / `stale` / `⏸ suspended`
- `Hide from Sidebar` で個別アーカイブ、`Show Hidden Sessions...` で復元
- StatusBar に件数バッジ

## 設計上のポイント

- **誤マッチ事故ゼロ**: ターミナル側の claude プロセスを拡張から触りに行く処理は完全に廃止。「同じ sessionId で外部と拡張の両方が動く可能性」はユーザーに警告のみ。
- **二重ソース防止**: managed セッションは SDK のストリームを真実とし、jsonl watcher のイベントは Webview に流さない。external セッションは jsonl が真実。
- **pending → 確定 sessionId**: SDK の `system.init` 受信前は `pending-<uuid>` で扱い、init 受信時に Tree / Panel / Persistence を一斉に rename。

## インストール

```bash
git clone <this-repo>
cd vscode-extension-claude-code-manager
pnpm install
pnpm build
pnpm package   # → claude-code-manager-0.1.0.vsix
```

VSCode/Cursor で `Extensions: Install from VSIX...` から `.vsix` を選択。

開発中は本リポジトリを VSCode/Cursor で開いて `F5` で Extension Development Host が起動します。

## 設定

| 設定キー | 既定値 | 説明 |
| --- | --- | --- |
| `claudeCodeManager.staleAfterMinutes` | `30` | 最終イベントから何分経過したら `stale` 表示にするか |
| `claudeCodeManager.hideSessionsOlderThanHours` | `24` | 起動時に何時間以上前のセッションを初期表示から除外するか |
| `claudeCodeManager.maxEventsPerSession` | `200` | registry が保持する 1 セッションあたりの直近イベント数 |

## アーキテクチャ

```
SessionWatcher (chokidar + JSONL tailer) ──── jsonl 由来の event ────┐
                                                                     │
ManagedSessionStore (globalState 永続化) ── activate 時に suspended 復元
                                                                     ▼
                                                          SessionRegistry
                                                          (origin: external | managed)
                                                                     │
ProcessManager ── SDK message ─── SessionPanelManager ◄──────────────┤
   ↑                                  │                              │
   │ submit                           ▼                              ▼
   └─ Webview ◄─────────── postMessage (stream / status)         TreeView
```

**主要ファイル:**

- `src/sessions/watcher.ts` — `~/.claude/projects/**/*.jsonl` を chokidar で watch
- `src/sessions/registry.ts` — セッション状態管理。`origin` で managed/external を区別
- `src/folders/store.ts` — 登録フォルダの永続化 (globalState) + workspace 自動取り込み
- `src/runtime/claudeProcess.ts` — SDK `query()` を AsyncIterable 入力でラップ
- `src/runtime/processManager.ts` — sessionId 単位の ClaudeProcess を保持、pending → 確定 ID リネーム
- `src/runtime/persistence.ts` — managed セッションのスナップショット永続化
- `src/views/treeProvider.ts` — フォルダ → セッションの 2 段階階層
- `src/views/sessionPanel.ts` — Webview パネル (チャット入力欄あり)
- `src/views/webview/main.ts` — ストリーム表示 + 「考えています…」インジケーター

## 設計判断

**なぜターミナル連携をやめたか:**
過去 6 回の修正にもかかわらず、外部から「claude プロセスと sessionId を確実に紐付ける手段」が無く誤マッチが残りました。Stage B 以降は **拡張内から SDK 経由で claude を起動** することで claude プロセスと sessionId の対応を確定させ、誤マッチを根絶します。

**なぜ既存ターミナルセッションの操作はサポートしないか:**
ターミナル側で動いている claude プロセスを拡張から触ると、stdin の衝突・jsonl の競合書き込みでセッション破壊の危険があります。**読み取り専用にすることで事故ゼロを保証** します。

## ライセンス

MIT
