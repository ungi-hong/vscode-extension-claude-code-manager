import { EventEmitter } from "events";
import { randomUUID } from "crypto";
import type {
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

export interface ClaudeProcessOptions {
  cwd: string;
  resumeSessionId?: string;
}

export declare interface ClaudeProcess {
  on(event: "message", listener: (msg: SDKMessage) => void): this;
  on(event: "init", listener: (sessionId: string) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  on(event: "disposed", listener: () => void): this;
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
      },
    });
    this.currentQuery = q;
    void this.consume(q);
  }

  send(text: string): boolean {
    if (this.done) return false;
    const msg: SDKUserMessage = {
      type: "user",
      message: { role: "user", content: text },
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
