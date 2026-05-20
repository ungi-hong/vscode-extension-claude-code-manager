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
- `Hide from Sidebar` で個別アーカイブ、`Show Hidden Sessions...` で復元
- `Remove from Sidebar (Permanent)...` で永続削除、`Show Removed Sessions...` から復活も可能

### 💬 Webview チャット

- 入力欄: `Cmd+Enter` (macOS) / `Ctrl+Enter` で送信
- ストリーミング応答 (`text_delta` を progressive 表示)
- 「考えています…」ドットアニメーション、ステータス行 (エラー / 接続 / コンテキスト圧縮等)
- 過去 JSONL 履歴を自動 replay (古いセッション開いても会話が出る)

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
| 権限モード切替 | 入力欄にフォーカス → `Shift+Tab` |
| Slash コマンド | `/` 入力 → ↑↓ で選択 → `Enter` |
| 過去セッション開く | Tree のセッション名をクリック → Webview に履歴が再生される |
| 出力ログ確認 | コマンドパレット → `Claude Code Manager: Show Output Logs` |
| 隠したセッション復元 | コマンドパレット → `Show Hidden Sessions...` |
| セッション永続削除 | Tree で右クリック → `Remove from Sidebar (Permanent)...` (JSONL 自体は残る) |
| 永続削除を復活 | コマンドパレット → `Show Removed Sessions...` |

---

## 🏗 アーキテクチャ

```
┌─────────────────────────────────────────────────────────────┐
│  VSCode Extension Host                                       │
│                                                              │
│  ┌────────────────┐  ┌──────────────────┐  ┌─────────────┐ │
│  │ SessionWatcher │→│ SessionRegistry  │→│ TreeProvider │ │
│  │ (~/.claude/    │  │ (in-memory state)│  │ (sidebar UI)│ │
│  │   projects 監視)│  └──────────────────┘  └─────────────┘ │
│  └────────────────┘           │                              │
│                               ↓                              │
│                       ┌─────────────────┐                    │
│                       │ ProcessManager  │                    │
│                       │ (SDK session    │                    │
│                       │  spawn / proxy) │                    │
│                       └─────────────────┘                    │
│                               │                              │
│                               ↓                              │
│                      ┌──────────────────┐                    │
│                      │  ClaudeProcess   │                    │
│                      │  (@anthropic-ai/ │                    │
│                      │  claude-agent-sdk│                    │
│                      │  ラッパー)       │                    │
│                      └──────────────────┘                    │
└─────────────────────────────────────────────────────────────┘
```

主要ファイル:

```
src/
├── extension.ts                ← activate / コマンド登録 / 全体配線
├── runtime/
│   ├── claudeProcess.ts        ← SDK Query ラッパー (setPermissionMode / supportedCommands)
│   ├── processManager.ts       ← pending- → 確定 sid の rename / proxy
│   ├── persistence.ts          ← managed session の globalState 永続化
│   └── statuslineMonitor.ts    ← /tmp/claude-statusline-input.json 監視
├── sessions/
│   ├── watcher.ts              ← ~/.claude/projects/**/*.jsonl 監視
│   ├── parser.ts               ← JSONL → SessionEvent
│   ├── registry.ts             ← SessionState を in-memory に集約
│   ├── hiddenStore.ts          ← 一時 hide リスト (~/.claude/ccmgr-state/hidden.json)
│   ├── forgottenStore.ts       ← 永続削除リスト (~/.claude/ccmgr-state/forgotten.json)
│   └── titleStore.ts           ← カスタム題名の永続化
├── views/
│   ├── sessionPanel.ts         ← セッションごとの Webview パネル
│   ├── treeProvider.ts         ← サイドバー TreeView
│   ├── statusBar.ts            ← ステータスバー
│   └── webview/
│       ├── main.ts             ← Webview UI スクリプト (Shift+Tab / slash 等)
│       └── style.css
└── utils/
    ├── projectsPath.ts         ← ~/.claude/projects/<encoded>/<sid>.jsonl 解決
    ├── customCommands.ts       ← ~/.claude/commands + plugins スキャナ
    └── text.ts                 ← formatTokens 等
```

### 設計判断

- **誤マッチ事故ゼロ**: ターミナル側の claude プロセスを拡張から触りに行く処理は完全に廃止。「同じ sessionId で外部と拡張の両方が動く可能性」はユーザーに警告のみ
- **二重ソース防止**: managed セッションは SDK のストリームを真実とし、jsonl watcher のイベントは Webview に流さない。external セッションは jsonl が真実
- **pending → 確定 sessionId**: SDK の `system.init` 受信前は `pending-<uuid>` で扱い、init 受信時に Tree / Panel / Persistence を一斉に rename
- **`rate_limit_event` の pending 期間取りこぼし対策**: アカウント全体情報なので session_id が確定前でも ingest する

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

---

## 📜 ライセンス

MIT
