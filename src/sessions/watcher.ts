import * as fs from "fs";
import * as path from "path";
import { EventEmitter } from "events";
import chokidar, { FSWatcher } from "chokidar";
import { JsonlBuffer, toSessionEvent } from "./parser";
import { SessionEvent } from "./types";
import { claudeProjectsRoot } from "../utils/projectsPath";

interface FileState {
  offset: number;
  buffer: JsonlBuffer;
  fallbackSessionId: string;
}

export interface SessionWatcherOptions {
  initialMaxAgeHours: number;
}

export declare interface SessionWatcher {
  on(event: "event", listener: (e: SessionEvent) => void): this;
  on(event: "ready", listener: () => void): this;
  on(event: "error", listener: (err: Error) => void): this;
}

export class SessionWatcher extends EventEmitter {
  private watcher: FSWatcher | undefined;
  private states = new Map<string, FileState>();
  private readonly opts: SessionWatcherOptions;

  constructor(opts: SessionWatcherOptions) {
    super();
    this.opts = opts;
  }

  start(): void {
    const root = claudeProjectsRoot();
    if (!fs.existsSync(root)) {
      this.emit("ready");
      return;
    }
    this.watcher = chokidar.watch(root, {
      persistent: true,
      ignoreInitial: false,
      depth: 2,
      awaitWriteFinish: false,
      followSymlinks: false,
    });

    this.watcher.on("add", (p) => this.handleAdd(p));
    this.watcher.on("change", (p) => this.handleChange(p));
    this.watcher.on("unlink", (p) => this.states.delete(p));
    this.watcher.on("error", (err) =>
      this.emit("error", err instanceof Error ? err : new Error(String(err))),
    );
    this.watcher.on("ready", () => this.emit("ready"));
  }

  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = undefined;
    }
    this.states.clear();
  }

  private isJsonl(p: string): boolean {
    return typeof p === "string" && p.length > 0 && p.endsWith(".jsonl");
  }

  private handleAdd(p: string): void {
    if (!this.isJsonl(p)) return;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(p);
    } catch {
      return;
    }
    const ageHours = (Date.now() - stat.mtimeMs) / 1000 / 60 / 60;
    const fallbackSessionId = path.basename(p, ".jsonl");
    if (ageHours > this.opts.initialMaxAgeHours) {
      // Old-file skip: initialMaxAgeHours より古い jsonl は初期スキャンを
      // 飛ばし、offset だけ stat.size に進めておく。今後 fs writes が来た時
      // のみ差分行が ingest されるため、放置ファイルは永遠に取り込まれない
      // (= 意図通り。起動コストとメモリ消費を抑える)。
      this.states.set(p, {
        offset: stat.size,
        buffer: new JsonlBuffer(),
        fallbackSessionId,
      });
      return;
    }
    this.states.set(p, {
      offset: 0,
      buffer: new JsonlBuffer(),
      fallbackSessionId,
    });
    this.readFromOffset(p).catch((err) =>
      this.emit("error", err instanceof Error ? err : new Error(String(err))),
    );
  }

  private handleChange(p: string): void {
    if (!this.isJsonl(p)) return;
    if (!this.states.has(p)) {
      // First time we see it (race condition with add).
      this.handleAdd(p);
      return;
    }
    this.readFromOffset(p).catch((err) =>
      this.emit("error", err instanceof Error ? err : new Error(String(err))),
    );
  }

  private async readFromOffset(p: string): Promise<void> {
    const state = this.states.get(p);
    if (!state) return;
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(p);
    } catch {
      return;
    }
    if (stat.size < state.offset) {
      // File was truncated/rotated. Reset.
      state.offset = 0;
      state.buffer = new JsonlBuffer();
    }
    if (stat.size === state.offset) return;

    const stream = fs.createReadStream(p, {
      start: state.offset,
      end: stat.size - 1,
      encoding: "utf8",
    });
    let bytesRead = 0;
    for await (const chunk of stream) {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      bytesRead += Buffer.byteLength(text, "utf8");
      const lines = state.buffer.feed(text);
      for (const raw of lines) {
        const evt = toSessionEvent(raw, p, state.fallbackSessionId);
        if (evt) this.emit("event", evt);
      }
    }
    state.offset += bytesRead;
  }
}
