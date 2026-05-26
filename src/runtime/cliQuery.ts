import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import { randomUUID } from "crypto";
import * as readline from "readline";
import type {
  CanUseTool,
  PermissionMode,
  PermissionResult,
  SDKMessage,
  SDKUserMessage,
  SlashCommand,
} from "./cliTypes";

/**
 * `ClaudeCliQuery` のコンストラクタ引数。`@anthropic-ai/claude-agent-sdk` の
 * `query({ prompt, options })` と同じ意味のフィールドを取る。
 */
export interface ClaudeCliQueryOptions {
  /** ユーザー入力ストリーム。Webview から逐次 push される。 */
  prompt: AsyncIterable<SDKUserMessage>;
  /** 作業ディレクトリ (Claude が File 操作する基準パス)。 */
  cwd: string;
  /** `claude` CLI バイナリの絶対パス (必須)。 */
  pathToClaudeCodeExecutable: string;
  /** 既存セッションを再開する場合の session_id。 */
  resume?: string;
  /** 起動時の権限モード。途中で `setPermissionMode` で変更可。 */
  permissionMode?: PermissionMode;
  /** `bypassPermissions` モード使用時の安全ロック解除フラグ。 */
  allowDangerouslySkipPermissions?: boolean;
  /** Claude が許可なくアクセスできる追加ディレクトリ。 */
  additionalDirectories?: string[];
  /** `text_delta` を細切れに流す (Webview のストリーミング表示用)。 */
  includePartialMessages?: boolean;
  /** ツール実行前の許可ダイアログ用コールバック。未指定だと自動承認。 */
  canUseTool?: CanUseTool;
  /** stderr / 内部状態を OutputChannel に流す optional logger。 */
  logger?: (msg: string) => void;
}

interface PendingControl {
  resolve: (response: Record<string, unknown>) => void;
  reject: (err: Error) => void;
}

/**
 * `claude` CLI を `child_process.spawn` で直接起動し、stream-json プロトコル
 * (`--input-format stream-json --output-format stream-json --verbose`) で
 * 対話する。SDK の `Query` と同じ API surface を提供する:
 *
 *   - `for await (const msg of q)` でメッセージを受け取れる async iterable
 *   - `setPermissionMode(mode)` / `interrupt()` / `getContextUsage()` /
 *     `supportedCommands()` / `return()`
 *   - `canUseTool` callback (CLI 側の `can_use_tool` 制御リクエストを処理)
 *
 * これにより `@anthropic-ai/claude-agent-sdk` への依存を排しつつ、
 * 公式拡張と同じく `claude` CLI を bin として呼び出す構成にできる。
 *
 * ## stream-json プロトコル (sdk.mjs を読んで確認済み)
 *
 * stdin (1 行 = 1 JSON):
 *   - ユーザーメッセージ: {type:"user", message:{role,content}, parent_tool_use_id:null, uuid}
 *   - 制御リクエスト: {type:"control_request", request_id, request:{subtype, ...}}
 *   - 制御応答 (CLI 起のリクエストへの返信):
 *     {type:"control_response", response:{subtype:"success"|"error", request_id, response?, error?}}
 *
 * stdout (1 行 = 1 JSON):
 *   - 通常メッセージ (system.init / assistant / user / result / stream_event / rate_limit_event 等)
 *     → そのまま消費者にエンキュー
 *   - {type:"control_request", ...}: CLI 側から発火 (主に can_use_tool) → canUseTool に dispatch
 *   - {type:"control_response", ...}: ホストが送った制御リクエストへの返信 → pendingControl を resolve
 */
export class ClaudeCliQuery implements AsyncIterable<SDKMessage> {
  private child: ChildProcessWithoutNullStreams | undefined;
  private readonly options: ClaudeCliQueryOptions;
  /** for await の消費者向けキュー。 */
  private readonly outQueue: SDKMessage[] = [];
  /** outQueue が空のとき次の push を待つ resolver。 */
  private outResolvers: Array<(v: IteratorResult<SDKMessage>) => void> = [];
  /** 子プロセス終了 / error 状態。 */
  private terminated = false;
  /** consumer に伝播するエラー (子プロセスが死んだなど)。 */
  private fatalError: Error | undefined;
  /** ホスト発の制御リクエスト (setPermissionMode 等) の応答待ち。 */
  private readonly pendingControl = new Map<string, PendingControl>();
  /** CLI 発の can_use_tool 中の AbortController (cancel_request 用)。 */
  private readonly inFlightTools = new Map<string, AbortController>();
  /** initialize 制御リクエストで取得したスラッシュコマンド一覧キャッシュ。 */
  private initializeCommands: SlashCommand[] | undefined;
  /** initialize 制御リクエストの promise (一度だけ実行)。 */
  private initializePromise: Promise<void> | undefined;

  constructor(options: ClaudeCliQueryOptions) {
    this.options = options;
    this.spawnChild();
    // ユーザー入力ストリームを背景で消費して stdin に流す
    void this.pumpUserInput();
    // 起動直後に initialize を投げてスラッシュコマンド一覧を取得 (背景)
    this.initializePromise = this.runInitialize().catch((err) => {
      this.options.logger?.(
        `[cliQuery] initialize failed (slash commands may be empty): ${(err as Error).message}`,
      );
    });
  }

  // ---------------------------------------------------------------------------
  // public API (SDK の Query と同じ surface)
  // ---------------------------------------------------------------------------

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return {
      next: (): Promise<IteratorResult<SDKMessage>> => {
        if (this.fatalError) {
          const err = this.fatalError;
          this.fatalError = undefined;
          return Promise.reject(err);
        }
        if (this.outQueue.length > 0) {
          const value = this.outQueue.shift()!;
          return Promise.resolve({ value, done: false });
        }
        if (this.terminated) {
          return Promise.resolve({
            value: undefined as unknown as SDKMessage,
            done: true,
          });
        }
        return new Promise<IteratorResult<SDKMessage>>((resolve) => {
          this.outResolvers.push(resolve);
        });
      },
      return: async (): Promise<IteratorResult<SDKMessage>> => {
        await this.shutdown();
        return { value: undefined as unknown as SDKMessage, done: true };
      },
    };
  }

  /** 実行中セッションの権限モードを切り替える (Shift+Tab 連動)。 */
  async setPermissionMode(mode: PermissionMode): Promise<void> {
    await this.sendControlRequest({
      subtype: "set_permission_mode",
      mode,
    });
  }

  /** SDK 公式の context usage 取得相当。 */
  async getContextUsage(): Promise<unknown> {
    return await this.sendControlRequest({ subtype: "get_context_usage" });
  }

  /** 起動時に取得したスラッシュコマンド一覧 (initialize の応答)。 */
  async supportedCommands(): Promise<SlashCommand[]> {
    // initialize promise の完了を待ってからキャッシュを返す
    if (this.initializePromise) {
      try {
        await this.initializePromise;
      } catch {
        // 失敗時は空配列 (initialize 側で logger に記録済み)
      }
    }
    return this.initializeCommands ?? [];
  }

  /** 生成を中断する (Stop Generating)。 */
  async interrupt(): Promise<void> {
    await this.sendControlRequest({ subtype: "interrupt" });
  }

  /** AsyncIterator の `return()` 経路で呼ばれる shutdown と同等。 */
  async return(): Promise<void> {
    await this.shutdown();
  }

  // ---------------------------------------------------------------------------
  // child process lifecycle
  // ---------------------------------------------------------------------------

  private spawnChild(): void {
    const args = this.buildArgs();
    this.options.logger?.(
      `[cliQuery] spawn ${this.options.pathToClaudeCodeExecutable} ${args.join(" ")}`,
    );

    // 親環境から NODE_OPTIONS を除いて子プロセスに `--inspect` 等が
    // 意図せず流れないようにする (SDK の挙動と同じ)。
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.NODE_OPTIONS;
    env.CLAUDE_CODE_ENTRYPOINT = "sdk-ts";
    env.CLAUDE_AGENT_SDK_CLIENT_APP = "ccmgr-vscode";

    this.child = spawn(this.options.pathToClaudeCodeExecutable, args, {
      cwd: this.options.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    });

    // stdin が壊れたら以後 write を諦める (二重エラーを防ぐ)
    this.child.stdin.on("error", (err) => {
      this.options.logger?.(
        `[cliQuery] stdin error: ${(err as Error).message}`,
      );
    });

    // stdout を行単位で読んで JSON パース
    const rl = readline.createInterface({ input: this.child.stdout });
    rl.on("line", (line) => this.handleStdoutLine(line));
    rl.on("close", () => {
      this.options.logger?.("[cliQuery] stdout closed");
    });

    // stderr は logger が指定されていれば line-by-line で流す
    if (this.options.logger) {
      const errRl = readline.createInterface({ input: this.child.stderr });
      errRl.on("line", (line) => {
        if (line.trim()) this.options.logger!(`[cliQuery:stderr] ${line}`);
      });
    } else {
      // logger 無しでも stderr を resume させないと EAGAIN になる可能性があるので drain
      this.child.stderr.resume();
    }

    this.child.on("error", (err) => {
      this.fatalError = err instanceof Error ? err : new Error(String(err));
      this.terminate();
    });

    this.child.on("exit", (code, signal) => {
      this.options.logger?.(
        `[cliQuery] child exit code=${code} signal=${signal}`,
      );
      // 終了前に応答を待っていた制御リクエストはすべて reject する
      for (const [, p] of this.pendingControl) {
        p.reject(
          new Error(`claude exited (code=${code}) before responding`),
        );
      }
      this.pendingControl.clear();
      // in-flight な canUseTool も abort
      for (const [, ac] of this.inFlightTools) {
        try {
          ac.abort();
        } catch {
          // ignore
        }
      }
      this.inFlightTools.clear();
      // exit code が異常ならエラーとして consumer に伝える
      if (code !== null && code !== 0 && !this.fatalError) {
        this.fatalError = new Error(
          `claude CLI exited with code ${code}${signal ? ` (signal ${signal})` : ""}`,
        );
      }
      this.terminate();
    });
  }

  /** spawn する CLI の argv を組み立てる。sdk.mjs と同じ並び。 */
  private buildArgs(): string[] {
    const args: string[] = [
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--verbose",
    ];

    if (this.options.canUseTool) {
      // これが無いと CLI は can_use_tool 制御リクエストを発火させない。
      // ある = ホスト側で許可ダイアログを出すモード。
      args.push("--permission-prompt-tool", "stdio");
    }

    if (this.options.resume) {
      args.push("--resume", this.options.resume);
    }

    if (this.options.permissionMode) {
      args.push("--permission-mode", this.options.permissionMode);
    }

    if (this.options.allowDangerouslySkipPermissions) {
      args.push("--allow-dangerously-skip-permissions");
    }

    if (this.options.includePartialMessages) {
      args.push("--include-partial-messages");
    }

    if (this.options.additionalDirectories) {
      for (const dir of this.options.additionalDirectories) {
        args.push("--add-dir", dir);
      }
    }

    return args;
  }

  /** stdout の 1 行をパースして種別ごとに dispatch。 */
  private handleStdoutLine(line: string): void {
    if (!line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      this.options.logger?.(
        `[cliQuery] stdout parse error: ${(err as Error).message} line=${line.slice(0, 200)}`,
      );
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    const msg = parsed as SDKMessage;

    // 制御プロトコルメッセージは consumer に流さず内部処理する
    if (msg.type === "control_response") {
      this.handleControlResponse(msg);
      return;
    }
    if (msg.type === "control_request") {
      void this.handleControlRequestFromCli(msg);
      return;
    }
    if (msg.type === "control_cancel_request") {
      this.handleControlCancelRequest(msg);
      return;
    }

    // 通常メッセージは消費者にエンキュー
    this.enqueueMessage(msg);
  }

  private enqueueMessage(msg: SDKMessage): void {
    if (this.outResolvers.length > 0) {
      const resolver = this.outResolvers.shift()!;
      resolver({ value: msg, done: false });
    } else {
      this.outQueue.push(msg);
    }
  }

  /** 子プロセス終了 / shutdown 時に consumer を done 状態に遷移させる。 */
  private terminate(): void {
    if (this.terminated) return;
    this.terminated = true;
    // 待機中の consumer に done を返す (fatalError は別 promise で reject 済み)
    while (this.outResolvers.length > 0) {
      const resolver = this.outResolvers.shift()!;
      if (this.fatalError) {
        // next() の promise を reject させる手段がないので、エラーを 1 つだけ流して残りは done
        const err = this.fatalError;
        // resolve 経由でエラーをスローさせるには consumer 側で例外を投げる必要がある。
        // 簡略のため stream を done で閉じ、fatalError は次の next() 呼び出しで報告される。
        this.fatalError = err;
        resolver({ value: undefined as unknown as SDKMessage, done: true });
      } else {
        resolver({ value: undefined as unknown as SDKMessage, done: true });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // stdin / control protocol
  // ---------------------------------------------------------------------------

  /** 1 行 = 1 JSON で stdin に書き込む。子プロセスが死んでいたら no-op。 */
  private writeLine(obj: unknown): boolean {
    if (!this.child || this.child.stdin.destroyed || this.terminated) {
      return false;
    }
    try {
      const line = JSON.stringify(obj);
      return this.child.stdin.write(line + "\n");
    } catch (err) {
      this.options.logger?.(
        `[cliQuery] stdin write error: ${(err as Error).message}`,
      );
      return false;
    }
  }

  /** ユーザー入力ストリームを消費して stdin にユーザーメッセージを流し続ける。 */
  private async pumpUserInput(): Promise<void> {
    try {
      for await (const userMsg of this.options.prompt) {
        if (this.terminated) break;
        this.writeLine(userMsg);
      }
    } catch (err) {
      this.options.logger?.(
        `[cliQuery] user input stream error: ${(err as Error).message}`,
      );
    }
    // ユーザー入力が尽きても stdin を即 close しない。
    // (CLI 側はホストからの control_request も受けるので open で維持)
  }

  /**
   * ホスト発の制御リクエスト (set_permission_mode / interrupt / get_context_usage /
   * initialize 等) を送って応答を待つ。
   */
  private sendControlRequest(
    request: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      if (this.terminated) {
        reject(new Error("claude CLI is terminated"));
        return;
      }
      const requestId = randomUUID();
      this.pendingControl.set(requestId, { resolve, reject });
      const ok = this.writeLine({
        type: "control_request",
        request_id: requestId,
        request,
      });
      if (!ok) {
        this.pendingControl.delete(requestId);
        reject(new Error("failed to write control_request to stdin"));
      }
    });
  }

  /** CLI が返してきた control_response を pendingControl に紐付けて resolve/reject。 */
  private handleControlResponse(msg: SDKMessage): void {
    const response = (msg as { response?: Record<string, unknown> }).response;
    if (!response || typeof response !== "object") return;
    const requestId = response.request_id as string | undefined;
    if (!requestId) return;
    const pending = this.pendingControl.get(requestId);
    if (!pending) return;
    this.pendingControl.delete(requestId);
    const subtype = response.subtype as string | undefined;
    if (subtype === "error") {
      const errMsg =
        (response.error as string | undefined) ?? "control_request failed";
      pending.reject(new Error(errMsg));
      return;
    }
    // subtype === "success" || それ以外: response.response を payload として返す
    const payload =
      (response.response as Record<string, unknown> | undefined) ?? response;
    pending.resolve(payload);
  }

  /**
   * CLI 発の制御リクエスト (主に can_use_tool) を処理してホスト側 callback に
   * dispatch し、結果を control_response で返信する。
   */
  private async handleControlRequestFromCli(msg: SDKMessage): Promise<void> {
    const requestId = (msg as { request_id?: string }).request_id;
    const request = (msg as { request?: Record<string, unknown> }).request;
    if (!requestId || !request) return;
    const subtype = request.subtype as string | undefined;

    if (subtype !== "can_use_tool") {
      // SDK 経由でないと使わない subtype (hook_callback / mcp_* 等) は未対応として
      // error 返信。pendingControlRequests を CLI 側でクリーンにするため必須。
      this.options.logger?.(
        `[cliQuery] unsupported control_request subtype=${subtype} reqId=${requestId.slice(0, 8)}`,
      );
      this.writeLine({
        type: "control_response",
        response: {
          subtype: "error",
          request_id: requestId,
          error: `unsupported control_request subtype: ${subtype}`,
        },
      });
      return;
    }

    if (!this.options.canUseTool) {
      // canUseTool が無いのに CLI が can_use_tool を投げてきた = 想定外
      // (--permission-prompt-tool stdio を付けていない時はそもそも来ないはず)。
      // 安全側で deny を返す。
      this.writeLine({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: requestId,
          response: {
            behavior: "deny",
            message: "no canUseTool handler available",
            interrupt: false,
          } satisfies PermissionResult,
        },
      });
      return;
    }

    const ac = new AbortController();
    this.inFlightTools.set(requestId, ac);
    try {
      const toolName = (request.tool_name as string) ?? "";
      const input = (request.input as Record<string, unknown>) ?? {};
      const result = await this.options.canUseTool(toolName, input, {
        signal: ac.signal,
        toolUseID: (request.tool_use_id as string) ?? "",
        title: request.title as string | undefined,
        description: request.description as string | undefined,
        displayName: request.display_name as string | undefined,
        decisionReason: request.decision_reason as string | undefined,
        blockedPath: request.blocked_path as string | undefined,
      });
      this.writeLine({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: requestId,
          response: result,
        },
      });
    } catch (err) {
      this.writeLine({
        type: "control_response",
        response: {
          subtype: "error",
          request_id: requestId,
          error: (err as Error).message ?? String(err),
        },
      });
    } finally {
      this.inFlightTools.delete(requestId);
    }
  }

  /**
   * CLI 側で can_use_tool がタイムアウト等で取り消された場合の通知。
   * 対応する AbortController を abort して canUseTool callback を解放する。
   */
  private handleControlCancelRequest(msg: SDKMessage): void {
    const requestId = (msg as { request_id?: string }).request_id;
    if (!requestId) return;
    const ac = this.inFlightTools.get(requestId);
    if (!ac) return;
    this.inFlightTools.delete(requestId);
    try {
      ac.abort();
    } catch {
      // ignore
    }
  }

  // ---------------------------------------------------------------------------
  // initialize (スラッシュコマンド一覧の取得)
  // ---------------------------------------------------------------------------

  /**
   * 起動直後に 1 回だけ送る initialize 制御リクエスト。
   * 応答の `commands` をキャッシュして `supportedCommands()` から返す。
   *
   * もし CLI 側がこの subtype をサポートしていなければ無視する
   * (custom commands だけで運用する fallback パス)。
   */
  private async runInitialize(): Promise<void> {
    try {
      const response = (await this.sendControlRequest({
        subtype: "initialize",
      })) as { commands?: SlashCommand[] };
      if (Array.isArray(response.commands)) {
        this.initializeCommands = response.commands.map((c) => ({
          name: c.name,
          description: c.description,
          argumentHint: c.argumentHint,
          aliases: c.aliases,
        }));
        this.options.logger?.(
          `[cliQuery] initialize OK (${this.initializeCommands.length} commands)`,
        );
      } else {
        this.initializeCommands = [];
      }
    } catch (err) {
      this.initializeCommands = [];
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // shutdown
  // ---------------------------------------------------------------------------

  /** Async iterator の return() / 外部からの dispose で呼ばれる。子プロセス終了まで面倒見る。 */
  private async shutdown(): Promise<void> {
    if (this.terminated || !this.child) {
      this.terminate();
      return;
    }
    try {
      this.child.stdin.end();
    } catch {
      // ignore
    }
    // 2 秒 grace を与えて生きていれば SIGTERM、さらに 1 秒で SIGKILL
    const grace = 2000;
    const exited = await new Promise<boolean>((resolve) => {
      let done = false;
      const t = setTimeout(() => {
        if (done) return;
        done = true;
        resolve(false);
      }, grace);
      this.child!.once("exit", () => {
        if (done) return;
        done = true;
        clearTimeout(t);
        resolve(true);
      });
    });
    if (exited) return;
    try {
      this.child.kill("SIGTERM");
    } catch {
      // ignore
    }
    const finalGrace = 1000;
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        try {
          this.child?.kill("SIGKILL");
        } catch {
          // ignore
        }
        resolve();
      }, finalGrace);
      this.child!.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
    this.terminate();
  }
}
