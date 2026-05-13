import {
  existsSync,
  FSWatcher,
  mkdirSync,
  readFileSync,
  watch,
  writeFileSync,
} from "fs";
import * as path from "path";
import { EventEmitter } from "events";

export declare interface SyncedJsonFile<T> {
  /** 自プロセス以外 (別 VSCode ウィンドウ等) からの書き込み検知時に発火。 */
  on(event: "externalChange", listener: () => void): this;
}

/**
 * ホームディレクトリ配下の小さな JSON ファイルを window 間で共有するためのラッパ。
 *
 * - 起動時: ファイルが無ければ defaultValue で作成、あれば parse して返す
 * - 書き込み時: `writeFileSync` で atomic overwrite + 直近の self-write 時刻を記録
 * - `fs.watch` で外部からの変更を監視。self-write 直後 (500ms 以内) は echo として無視
 *
 * 用途: HiddenStore / TitleStore など、複数ウィンドウで共有したい軽量な状態。
 */
export class SyncedJsonFile<T> extends EventEmitter {
  private watcher: FSWatcher | undefined;
  private lastSelfWriteAt = 0;
  private debounceTimer?: NodeJS.Timeout;

  constructor(
    private readonly filePath: string,
    private readonly defaultValue: T,
  ) {
    super();
    this.ensureFile();
    this.startWatch();
  }

  read(): T {
    try {
      const txt = readFileSync(this.filePath, "utf8");
      if (!txt.trim()) return this.defaultValue;
      return JSON.parse(txt) as T;
    } catch {
      return this.defaultValue;
    }
  }

  write(value: T): void {
    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true });
      this.lastSelfWriteAt = Date.now();
      writeFileSync(this.filePath, JSON.stringify(value, null, 2));
    } catch {
      // 書けなくても fatal にはしない (read-only FS など)
    }
  }

  dispose(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.watcher?.close();
    this.watcher = undefined;
  }

  private ensureFile(): void {
    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true });
      if (!existsSync(this.filePath)) {
        writeFileSync(this.filePath, JSON.stringify(this.defaultValue, null, 2));
      }
    } catch {
      // ディレクトリ作れない環境 (権限など) は黙って諦め
    }
  }

  private startWatch(): void {
    try {
      this.watcher = watch(this.filePath, () => {
        // 自身の書き込みから 500ms 以内はエコーとして無視
        if (Date.now() - this.lastSelfWriteAt < 500) return;
        // 同一変更で複数 fire することがあるので 50ms debounce
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
          this.debounceTimer = undefined;
          this.emit("externalChange");
        }, 50);
      });
    } catch {
      // watch 不可な環境 (NFS など) は黙って同期諦め
    }
  }
}
