# Claude Code Manager

複数の Claude Code セッションを **VSCode / Cursor のサイドバー** で管理し、Webview 上で対話できる拡張機能。
公式 Claude Code CLI の使い心地 (Shift+Tab モード切替・slash command 補完) を **エディタの中で全部やる** がコンセプト。

---

## ✨ 主な機能

### 🔐 権限モード切替 (Shift+Tab)

公式 CLI と同じ感覚で **入力欄にフォーカスして Shift+Tab** を押すたびに権限モードが循環:

```
Default  →  Accept Edits  →  Plan  →  Default …
```

- 入力欄右下のバッジで現在のモードを色付き表示 (灰/緑/青/赤)
- SDK の `Query.setPermissionMode()` で **セッション再起動なし**に切替
- VSCode 設定 `claudeCodeManager.defaultPermissionMode` で起動時のデフォルトモードを選択 (`default` / `plan` / `acceptEdits` / `bypassPermissions`)
- `bypassPermissions` = `--dangerously-skip-permissions` 相当 (自己責任)

### ⌨️ Slash command 補完

入力欄で `/` を打つとドロップダウン補完が開く:

| ソース | 例 | バッジ |
|---|---|---|
| SDK 組み込み | `/help` `/clear` `/compact` `/cost` `/model` … | — |
| User 定義 | `~/.claude/commands/**/*.md` | 🟣 USER |
| Project 定義 | `<cwd>/.claude/commands/**/*.md` | 🔵 PROJECT |
| Plugin 由来 | `~/.claude/plugins/cache/<marketplace>/<plugin>/<ver>/commands/*.md` (例: `/fe-pr:fe-pr`) | 🟠 PLUGIN |

操作:
- ↑↓ で選択 / `Enter` または `Tab` で確定 / `Esc` でキャンセル
- **部分一致 + 優先度スコア** でフィルタ (name 前方一致 > alias 前方一致 > name 部分一致 > description 部分一致)

### 📋 セッション管理

- Activity Bar に **🤖 Claude Code Manager** アイコン
- TreeView で **フォルダ (cwd) → セッション** の 2 階層
- `+ New Session` で SDK 経由のチャットセッションを起動
- 既存のターミナル起動セッション (`claude` を CLI で立ち上げたもの) も Tree に自動表示 → クリックで Webview を開いて resume 可能
- セッション状態: `running` / `idle` / `stale` をアイコン色分け
- VSCode / Cursor 再起動後も Tree に **⏸ suspended** で並び、クリックで自動 resume
- セッションごとに **カスタム題名** を付けられる (Tree 右クリック → `Rename Session`)
- 任意のフォルダを Tree の cwd グループに **手動で追加** (`Add Folder`) / 削除 (`Remove Folder`)
- `Hide from Sidebar` で個別アーカイブ、`Show Hidden Sessions...` で復元
- `Remove from Sidebar (Permanent)...` で永続削除、`Show Removed Sessions...` から復活も可能

### 💬 Webview チャット

- 入力欄: `Cmd+Enter` (macOS) / `Ctrl+Enter` で送信
- ストリーミング応答 (`text_delta` を progressive 表示)
- 「考えています…」ドットアニメーション、ステータス行 (エラー / 接続 / コンテキスト圧縮等)
- 過去 JSONL 履歴を自動 replay (古いセッション開いても会話が出る)
- 画像の **ドラッグ&ドロップ添付** (png / jpeg / gif / webp、複数枚同時可) → サムネ表示後そのまま送信
- `Cmd+F` / `Ctrl+F` で **会話内検索** (前/次/Esc で閉じる)
- ヘッダーに **コンテキストウィンドウ残量バー** を常時表示 (緑 → 黄 → 赤)。
  ソースは SDK 公式 `Query.getContextUsage()` + statusline JSON の二系統

### ❓ AskUserQuestion 専用 UI

Claude Agent SDK の `AskUserQuestion` ツールに対して、複数選択肢を選んで答える専用 UI:

- ラジオ (単一選択) / チェックボックス (複数選択) で選んで `Enter` 送信
- 末尾に自動付与される `Other (自由記述)` でフリーテキスト回答も可能
- ↑↓ で選択肢移動、`Tab` で次の質問、`Esc` でキャンセル
- 質問到着時に **panel が無ければ自動 open**、ある場合も `reveal()` で前面化
- 別タブ表示中で気付けない時のために **トースト通知** で再注目
- 極端ケース (panel を作れない等) では `vscode.window.showQuickPick` + `showInputBox` の **VSCode ネイティブ UI** にフォールバック

### 🛠 自動回復機能

- **Zombie session 修復**: 空 JSONL ファイル (init 受信したが会話無しのセッション) を resume しようとするとエラーになる SDK の振る舞いに対して、**自動で新規セッションに切替**してメッセージ送信を継続
- **古いセッション履歴復元**: 24h より古いセッションでも `~/.claude/projects/.../<sid>.jsonl` を直接探して再生 → tree から開けば履歴が見える

---

## 🚀 インストール

### VSCode

```bash
# CLI で一発
code --install-extension claude-code-manager-0.1.0.vsix
```

または GUI:
Extensions ビュー → 右上の `…` → `Install from VSIX...` → `.vsix` ファイル選択 → リスタート

### Cursor

```bash
cursor --install-extension claude-code-manager-0.1.0.vsix
```

`cursor` コマンドが無ければ Cursor 内で `Cmd+Shift+P` → `Shell Command: Install 'cursor' command in PATH` で PATH に追加可能。
GUI 手順は VSCode と同じ。Cursor は VSCode 1.93+ ベースなので互換あり。

---

## ⚙️ 設定 (Settings)

`Cmd+,` (`Ctrl+,`) → `claude code manager` で検索:

| キー | デフォルト | 説明 |
|---|---|---|
| `claudeCodeManager.defaultPermissionMode` | `default` | 新規セッションの初期権限モード。`bypassPermissions` で `--dangerously-skip-permissions` 相当 |
| `claudeCodeManager.claudePath` | `""` | `claude` CLI バイナリの絶対パス。空なら PATH から `which claude` で自動検出 → それも無ければ SDK 同梱バイナリ (約 208 MB) にフォールバック |
| `claudeCodeManager.staleAfterMinutes` | `30` | この分数以上更新が無いセッションを `stale` (薄表示) にする |
| `claudeCodeManager.hideSessionsOlderThanHours` | `24` | 起動時に何時間以上前の JSONL を初期 load から除外するか |
| `claudeCodeManager.maxEventsPerSession` | `200` | registry に保持する 1 セッションあたりの直近イベント数 |

### `~/.claude/settings.json` (Claude Code 公式) との関係

この拡張は `options.permissionMode` を SDK に **明示的に渡す**ため、`~/.claude/settings.json` の `permissions.defaultMode` は**上書きされる**。永続的に bypass にしたい場合は VSCode 設定の `claudeCodeManager.defaultPermissionMode` で設定してね。

---

## 🎯 使い方クイックリファレンス

| やりたいこと | 操作 |
|---|---|
| 新規セッション起動 | フォルダ行の `+` アイコン or 右クリック → `New Session` |
| チャット送信 | 入力欄に書いて `Cmd+Enter` |
| 画像添付 | 入力欄にドラッグ&ドロップ → サムネ表示で確認 → 送信 |
| 会話内検索 | パネル内で `Cmd+F` / `Ctrl+F` |
| 権限モード切替 | 入力欄にフォーカス → `Shift+Tab` |
| 生成を中断 | `Esc` (生成中のみ) or Stop ボタン |
| Slash コマンド | `/` 入力 → ↑↓ で選択 → `Enter` |
| AskUserQuestion 回答 | パネルに出るカード上で ↑↓ で選択 → `Enter` (キャンセルは `Esc`) |
| セッション題名変更 | Tree で右クリック → `Rename Session` |
| フォルダ追加 / 削除 | Tree 上部の `+ Add Folder` / 該当行で `Remove Folder` |
| 過去セッション開く | Tree のセッション名をクリック → Webview に履歴が再生される |
| 出力ログ確認 | コマンドパレット → `Claude Code Manager: Show Output Logs` |
| 隠したセッション復元 | コマンドパレット → `Show Hidden Sessions...` |
| セッション永続削除 | Tree で右クリック → `Remove from Sidebar (Permanent)...` (JSONL 自体は残る) |
| 永続削除を復活 | コマンドパレット → `Show Removed Sessions...` |

---

## 🏗 アーキテクチャ

```
┌──────────────────────────────────────────────────────────────────┐
│  VSCode Extension Host                                            │
│                                                                   │
│  ┌────────────────┐  ┌──────────────────┐  ┌──────────────────┐ │
│  │ SessionWatcher │→│ SessionRegistry  │→│ TreeProvider     │ │
│  │ (~/.claude/    │  │ (in-memory state)│  │ (sidebar UI)     │ │
│  │   projects 監視)│  └──────────────────┘  └──────────────────┘ │
│  └────────────────┘           │                       │           │
│                               ↓                       ↓           │
│                       ┌─────────────────┐    ┌──────────────────┐│
│                       │ ProcessManager  │←→│ SessionPanel     ││
│                       │ (SDK session    │    │ Manager          ││
│                       │  spawn / proxy) │    │ (Webview パネル) ││
│                       └─────────────────┘    └──────────────────┘│
│                               │                       ↑           │
│                               ↓                       │           │
│                      ┌──────────────────┐    ┌──────────────────┐│
│                      │  ClaudeProcess   │    │ StatuslineMonitor││
│                      │  (@anthropic-ai/ │    │ (/tmp/claude-    ││
│                      │  claude-agent-sdk│    │  statusline-     ││
│                      │  ラッパー)       │    │  input.json 監視)││
│                      └──────────────────┘    └──────────────────┘│
└──────────────────────────────────────────────────────────────────┘
```

主要ファイル:

```
src/
├── extension.ts                ← activate / コマンド登録 / 全体配線
├── runtime/
│   ├── claudeProcess.ts        ← SDK Query ラッパー (setPermissionMode / supportedCommands / getContextUsage / canUseTool)
│   ├── processManager.ts       ← pending- → 確定 sid の rename / proxy
│   ├── persistence.ts          ← managed session の globalState 永続化
│   └── statuslineMonitor.ts    ← /tmp/claude-statusline-input.json 監視 → コンテキスト残量を流す
├── sessions/
│   ├── watcher.ts              ← ~/.claude/projects/**/*.jsonl 監視
│   ├── parser.ts               ← JSONL → SessionEvent
│   ├── registry.ts             ← SessionState を in-memory に集約
│   ├── types.ts                ← SessionState / SessionEvent の型定義
│   ├── hiddenStore.ts          ← 一時 hide リスト (~/.claude/ccmgr-state/hidden.json)
│   ├── forgottenStore.ts       ← 永続削除リスト (~/.claude/ccmgr-state/forgotten.json)
│   └── titleStore.ts           ← カスタム題名の永続化
├── folders/
│   └── store.ts                ← Tree に手動追加されたフォルダ (cwd) の永続化
├── views/
│   ├── sessionPanel.ts         ← セッションごとの Webview パネル + AskUserQuestion 用 native fallback
│   ├── treeProvider.ts         ← サイドバー TreeView
│   ├── statusBar.ts            ← ステータスバー
│   └── webview/
│       ├── main.ts             ← Webview UI スクリプト (Shift+Tab / slash / 検索 / 添付 / AskUserQuestion カード等)
│       ├── style.css           ← UI スタイル (ctx-window バー / permission カード等を含む)
│       └── index.html
└── utils/
    ├── projectsPath.ts         ← ~/.claude/projects/<encoded>/<sid>.jsonl 解決
    ├── customCommands.ts       ← ~/.claude/commands + plugins スキャナ
    ├── syncedJsonFile.ts       ← 複数 VSCode window 間で共有する小さい JSON ファイルの atomic 読み書き + fs.watch ラッパ
    ├── nonce.ts                ← Webview CSP 用 nonce 生成
    └── text.ts                 ← formatTokens 等
```

### 設計判断

- **誤マッチ事故ゼロ**: ターミナル側の claude プロセスを拡張から触りに行く処理は完全に廃止。「同じ sessionId で外部と拡張の両方が動く可能性」はユーザーに警告のみ
- **二重ソース防止**: managed セッションは SDK のストリームを真実とし、jsonl watcher のイベントは Webview に流さない。external セッションは jsonl が真実
- **pending → 確定 sessionId**: SDK の `system.init` 受信前は `pending-<uuid>` で扱い、init 受信時に Tree / Panel / Persistence を一斉に rename
- **コンテキスト残量は 2 系統**: SDK 公式の `Query.getContextUsage()` (assistant 応答受信時に取得) と、CLI 対話モードが書く `/tmp/claude-statusline-input.json` の `context_window` フィールド (StatuslineMonitor 経由) を同じ webview バー UI に流して、両モードで残量が見えるようにしている
- **AskUserQuestion を絶対に取りこぼさない**: `canUseTool` 経由で来た AskUserQuestion は panel が無ければ自動 open / 通知でユーザーに気付かせ、それでも UI を出せない場合は `showQuickPick` の native UI で必ず回答を受け取って SDK の Promise を resolve させる
- **永続削除は最上流フィルタ**: `Remove from Sidebar (Permanent)` で消したセッションは `SessionWatcher` の event ingest 段階で破棄するため、registry にも載らず TreeProvider 側のフィルタに頼らない

---

## 🧑‍💻 開発

### 必要環境

- Node.js 22+
- pnpm (推奨) / npm
- VSCode 1.90+ (Cursor 含む)

### セットアップ

```bash
git clone <this-repo>
cd vscode-extension-claude-code-manager
pnpm install
pnpm run build           # esbuild で dist/extension.js & dist/webview/main.js 出力
npx tsc -p . --noEmit    # 型チェック
pnpm test                # vitest
```

### F5 で Extension Development Host 起動

VSCode / Cursor でこのリポジトリを開いて **F5** → 別ウィンドウで拡張がロード済の Extension Development Host が起動。

### .vsix パッケージ生成

```bash
npx @vscode/vsce package --no-dependencies
# → claude-code-manager-0.1.0.vsix
```

---

## 🐛 トラブルシューティング

### 古いセッションを開いたら履歴が出ない

- 24h より古い JSONL は `SessionWatcher` の初期 load から除外される設計
- 拡張は `<cwd>/.claude/projects/.../<sid>.jsonl` を後追いで読み込んで再生する
- それでも出ない場合は JSONL ファイル自体が空 (0 byte) の可能性 → zombie 修復が自動で動いて新規セッション切替するはず

### "No conversation found with session ID" エラー

- 空 JSONL を resume しようとした時の SDK エラー
- 自動修復で同じ cwd に新規セッションが立ち上がるはず (panel 内に `履歴が空のため新規セッションに切り替えます…` 通知が出る)

### AskUserQuestion の選択肢が画面に出ない / 自動でスキップされる

- まず `Claude Code Manager: Show Output Logs` で OutputChannel を開いて以下のログ順序を確認:
  1. `[ccmgr] assistant emitted AskUserQuestion tool_use id=...` — モデルが質問を投げた
  2. `[ccmgr] canUseTool fired tool=AskUserQuestion mode=...` — SDK が canUseTool を呼んだ
  3. `[ccmgr] permission request sid=... tool=AskUserQuestion`
- 1 だけで 2 が出ない場合は SDK 側で auto-deny されている可能性 (plan mode の挙動など)
- 1〜3 が全て出ているのに UI が見当たらない場合は panel が別タブにある可能性 → トースト通知の `回答する` をクリックすれば前面化
- 極端ケース (panel を作れない等) では VSCode の QuickPick が出るので、そこで選んで `Enter` で回答できる

### コンテキスト残量バーが出ない

- Webview パネルを 1 度 reload (タブを閉じてから再 open) すると初期化される
- SDK 経由の `getContextUsage()` は assistant 応答到着時に取りに行くので、init 直後は数秒のラグが出る
- statusline JSON 経由は CLI 対話モードで起動した既存セッションのみ更新される (managed セッションでは SDK 経由が主)

---

## 📜 ライセンス

MIT
