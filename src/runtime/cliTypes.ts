/**
 * `@anthropic-ai/claude-agent-sdk` の型を完全に置き換えるローカル型定義。
 *
 * 公式拡張と同じく `claude` CLI を直接 `child_process.spawn` で起動する構成
 * (`cliQuery.ts`) のため SDK 依存を排した。SDK が提供していた型を 1:1 で
 * 模倣する形にしてあるので、`claudeProcess.ts` / `processManager.ts` /
 * `extension.ts` / `sessionPanel.ts` の利用側はほぼ無変更で済む。
 *
 * SDK の API 表面と異なる点:
 *   - `SDKMessage` はゆるい型にしてある (`consume()` は `type` と `subtype` しか
 *     見ない。Webview 側も duck-typing で扱うので強い型は不要)。
 *   - `PermissionMode` から SDK 内部用の `"dontAsk"` / `"auto"` を除いた。
 *     拡張側でも MODE_CYCLE = ["default","acceptEdits","plan"] しか使わない。
 */

/** Shift+Tab で切替可能な権限モード ("bypassPermissions" は危険なので明示指定時のみ)。 */
export type PermissionMode =
  | "default"
  | "plan"
  | "acceptEdits"
  | "bypassPermissions";

/**
 * `canUseTool` コールバックの戻り値。
 *
 * - `allow`: ツールを実行させる。`updatedInput` で input を書き換えることもできる
 *   (例: AskUserQuestion の answers を埋め込む)。
 * - `deny`: ツール実行を拒否。`message` に拒否理由、`interrupt: true` だと
 *   ツール呼び出し連鎖そのものを止める。
 */
export type PermissionResult =
  | {
      behavior: "allow";
      /**
       * ツール実行時の input を書き換える場合に指定。
       * 例: AskUserQuestion で answers をここに載せて返す。
       * 省略時は CLI が受け取った元の input がそのまま使われる。
       */
      updatedInput?: Record<string, unknown>;
      updatedPermissions?: unknown[];
    }
  | {
      behavior: "deny";
      message: string;
      interrupt: boolean;
    };

/** Webview に渡すスラッシュコマンド 1 件の SDK 由来分。 */
export interface SlashCommand {
  name: string;
  description: string;
  argumentHint: string;
  aliases?: string[];
}

/**
 * stdout の NDJSON から流れてくる 1 行分のメッセージ。
 *
 * 種別 (`type` / `subtype`) ベースの discriminated union を持つには SDK の
 * 型定義をそのまま輸入する必要があるが、`claudeProcess.ts:consume()` も
 * Webview も `type === "system" && subtype === "init"` のような duck typing
 * しかしないので、ここでは `Record<string, unknown>` 相当のゆるい型にする。
 */
export interface SDKMessage {
  type: string;
  [key: string]: unknown;
}

/**
 * stdin に書き込むユーザーメッセージ 1 件分。SDK の SDKUserMessage と同形式。
 *
 * `content` は単純テキストなら string、画像添付があれば
 * `[{type:"text",text}, {type:"image",source:{...}}]` 形式の配列。
 */
export interface SDKUserMessage {
  type: "user";
  message: {
    role: "user";
    content:
      | string
      | Array<
          | { type: "text"; text: string }
          | {
              type: "image";
              source: {
                type: "base64";
                media_type:
                  | "image/jpeg"
                  | "image/png"
                  | "image/gif"
                  | "image/webp";
                data: string;
              };
            }
        >;
  };
  parent_tool_use_id: null;
  uuid: string;
}

/** CLI 側から発火する `can_use_tool` 制御リクエストを処理するコールバック。 */
export type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: CanUseToolOptions,
) => Promise<PermissionResult>;

/** `canUseTool` callback の 3 番目の引数。SDK の同名と同じフィールド構成。 */
export interface CanUseToolOptions {
  /** この呼び出しを取り消す abort 通知 (CLI 側で interrupt された等)。 */
  signal: AbortSignal;
  /** SDK 内部の tool_use_id。Webview に転送して assistant message と紐付ける。 */
  toolUseID: string;
  /** 許可ダイアログ表示用 (CLI 側がヒューリスティックで生成)。 */
  title?: string;
  description?: string;
  displayName?: string;
  /** なぜこの確認が出たかの理由 (permission rule / mode / safetyCheck 等)。 */
  decisionReason?: string;
  /** ブロックされた対象パス (Bash/Edit でディレクトリ違反時など)。 */
  blockedPath?: string;
}
