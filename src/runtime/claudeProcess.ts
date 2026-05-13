import { EventEmitter } from "events";
import { randomUUID } from "crypto";
import type {
  CanUseTool,
  PermissionMode,
  PermissionResult,
  Query,
  SDKMessage,
  SDKUserMessage,
  SlashCommand,
} from "@anthropic-ai/claude-agent-sdk";

export interface ClaudeProcessOptions {
  cwd: string;
  resumeSessionId?: string;
  /** SDK の query() に渡す初期権限モード。途中で `setPermissionMode` で変更可能。 */
  permissionMode?: PermissionMode;
  /**
   * 利用する `claude` CLI バイナリの絶対パス。未指定なら SDK 同梱のバイナリ
   * (`@anthropic-ai/claude-agent-sdk-<platform>-<arch>`) を使う。
   * VSIX のサイズ削減のためユーザー環境の `which claude` を指定するのが推奨。
   */
  pathToClaudeCodeExecutable?: string;
  /**
   * cwd 以外に Claude がアクセス許可なしで読み書きできる絶対パス一覧。
   * `../mep-frontend` のような sibling リポジトリを事前許可するときに使う。
   */
  additionalDirectories?: string[];
}

/** ユーザーが添付する画像 1 枚分 (webview → ext → SDK 経由で送る)。 */
export interface Attachment {
  /** 表示用ファイル名 (UI 用、SDK には渡さない) */
  name: string;
  /** "image/png" | "image/jpeg" | "image/gif" | "image/webp" 等 */
  mediaType: string;
  /** base64 エンコード済みの画像データ (data URL の prefix は除く) */
  base64: string;
}

/** webview に送って承認ダイアログを出すための permission 要求 payload */
export interface PermissionRequestPayload {
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  toolUseID: string;
  title?: string;
  description?: string;
  displayName?: string;
  decisionReason?: string;
  blockedPath?: string;
}

export declare interface ClaudeProcess {
  on(event: "message", listener: (msg: SDKMessage) => void): this;
  on(event: "init", listener: (sessionId: string) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  on(event: "disposed", listener: () => void): this;
  on(
    event: "permissionRequest",
    listener: (req: PermissionRequestPayload) => void,
  ): this;
}

/**
 * 単一の Claude SDK セッションのライフサイクルを管理する。
 *
 * SDK は ESM 専用 + 同梱 executable のパスを自前解決するため、esbuild bundle
 * には含めず dynamic import でランタイムロードする。
 */
export class ClaudeProcess extends EventEmitter {
  private done = false;
  private inputResolvers: Array<(v: SDKUserMessage | undefined) => void> = [];
  private inputQueue: SDKUserMessage[] = [];
  private currentQuery: Query | undefined;
  private confirmedSessionId: string | undefined;
  private starting: Promise<void> | undefined;
  /** webview からの承認回答待ちの requestId → resolver */
  private pendingPermissions = new Map<
    string,
    (result: PermissionResult) => void
  >();

  constructor(public readonly options: ClaudeProcessOptions) {
    super();
  }

  /** session_id 確定後に SDK から付与されたもの (`init` 受信前は undefined)。 */
  get sessionId(): string | undefined {
    return this.confirmedSessionId ?? this.options.resumeSessionId;
  }

  start(): Promise<void> {
    if (!this.starting) {
      this.starting = this.startInternal().catch((err) => {
        this.emit(
          "error",
          err instanceof Error ? err : new Error(String(err)),
        );
        this.done = true;
        this.emit("disposed");
      });
    }
    return this.starting;
  }

  private async startInternal(): Promise<void> {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    const userInput = this.makeUserInputStream();
    const mode = this.options.permissionMode;

    // bypassPermissions 以外のモードでは canUseTool を提供して、ツール実行前に
    // webview で承認 UI を出す (CLI と同じ体験)。
    const canUseTool: CanUseTool = (toolName, input, options) => {
      return new Promise<PermissionResult>((resolve) => {
        const requestId = randomUUID();
        this.pendingPermissions.set(requestId, resolve);
        // abort 連携: SDK が中断したら deny として promise を resolve
        if (options.signal) {
          options.signal.addEventListener(
            "abort",
            () => {
              const r = this.pendingPermissions.get(requestId);
              if (r) {
                this.pendingPermissions.delete(requestId);
                r({ behavior: "deny", message: "aborted", interrupt: false });
              }
            },
            { once: true },
          );
        }
        this.emit("permissionRequest", {
          requestId,
          toolName,
          input,
          toolUseID: options.toolUseID,
          title: options.title,
          description: options.description,
          displayName: options.displayName,
          decisionReason: options.decisionReason,
          blockedPath: options.blockedPath,
        });
      });
    };

    const q = sdk.query({
      prompt: userInput,
      options: {
        cwd: this.options.cwd,
        // text_delta のストリーミングを Webview に流して "考えています…" 表示中の
        // 体感遅延をなくす。
        includePartialMessages: true,
        ...(this.options.resumeSessionId
          ? { resume: this.options.resumeSessionId }
          : {}),
        ...(this.options.pathToClaudeCodeExecutable
          ? { pathToClaudeCodeExecutable: this.options.pathToClaudeCodeExecutable }
          : {}),
        ...(this.options.additionalDirectories &&
        this.options.additionalDirectories.length > 0
          ? { additionalDirectories: this.options.additionalDirectories }
          : {}),
        ...(mode === "bypassPermissions"
          ? {
              permissionMode: mode,
              allowDangerouslySkipPermissions: true,
            }
          : {
              ...(mode ? { permissionMode: mode } : {}),
              // bypass 以外では UI で承認させる
              canUseTool,
            }),
      },
    });
    this.currentQuery = q;
    void this.consume(q);
  }

  /**
   * webview から「許可 / 拒否」の回答が返ってきた時に呼ばれる。
   * pending な promise を解決して SDK 側に PermissionResult を返す。
   */
  resolvePermission(requestId: string, result: PermissionResult): boolean {
    const resolve = this.pendingPermissions.get(requestId);
    if (!resolve) return false;
    this.pendingPermissions.delete(requestId);
    resolve(result);
    return true;
  }

  /** 実行中セッションの権限モードを切り替える (Shift+Tab 連動)。 */
  async setPermissionMode(mode: PermissionMode): Promise<void> {
    await this.currentQuery?.setPermissionMode(mode);
  }

  /** SDK 側で有効な slash command の一覧を取得する。 */
  async getSupportedCommands(): Promise<SlashCommand[]> {
    return (await this.currentQuery?.supportedCommands()) ?? [];
  }

  send(text: string, attachments?: Attachment[]): boolean {
    if (this.done) return false;
    let content: SDKUserMessage["message"]["content"];
    if (attachments && attachments.length > 0) {
      content = [
        ...(text ? [{ type: "text" as const, text }] : []),
        ...attachments.map((a) => ({
          type: "image" as const,
          source: {
            type: "base64" as const,
            media_type: a.mediaType as
              | "image/jpeg"
              | "image/png"
              | "image/gif"
              | "image/webp",
            data: a.base64,
          },
        })),
      ];
    } else {
      content = text;
    }
    const msg: SDKUserMessage = {
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      uuid: randomUUID(),
    };
    if (this.inputResolvers.length > 0) {
      const resolver = this.inputResolvers.shift()!;
      resolver(msg);
    } else {
      this.inputQueue.push(msg);
    }
    return true;
  }

  async dispose(): Promise<void> {
    if (this.done) return;
    this.done = true;
    while (this.inputResolvers.length > 0) {
      const r = this.inputResolvers.shift()!;
      r(undefined);
    }
    try {
      await this.currentQuery?.return();
    } catch {
      // ignore
    }
  }

  async interrupt(): Promise<void> {
    try {
      await this.currentQuery?.interrupt();
    } catch (err) {
      this.emit(
        "error",
        err instanceof Error ? err : new Error(String(err)),
      );
    }
  }

  private makeUserInputStream(): AsyncIterableIterator<SDKUserMessage> {
    const self = this;
    return (async function* () {
      while (!self.done) {
        if (self.inputQueue.length > 0) {
          const m = self.inputQueue.shift()!;
          yield m;
          continue;
        }
        const next = await new Promise<SDKUserMessage | undefined>(
          (resolve) => {
            self.inputResolvers.push(resolve);
          },
        );
        if (!next) return;
        yield next;
      }
    })();
  }

  private async consume(q: Query): Promise<void> {
    try {
      for await (const msg of q) {
        this.emit("message", msg);
        if (
          msg.type === "system" &&
          (msg as any).subtype === "init" &&
          typeof (msg as any).session_id === "string"
        ) {
          const sid = (msg as any).session_id as string;
          if (!this.confirmedSessionId) {
            this.confirmedSessionId = sid;
            this.emit("init", sid);
          }
        }
      }
    } catch (err) {
      this.emit(
        "error",
        err instanceof Error ? err : new Error(String(err)),
      );
    } finally {
      this.done = true;
      while (this.inputResolvers.length > 0) {
        const r = this.inputResolvers.shift()!;
        r(undefined);
      }
      this.emit("disposed");
    }
  }
}
