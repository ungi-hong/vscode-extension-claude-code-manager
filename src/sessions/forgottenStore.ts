import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { EventEmitter } from "events";
import { SyncedJsonFile } from "../utils/syncedJsonFile";

const STORAGE_KEY = "ccmgr.forgottenSessions";
const FILE_PATH = path.join(
  os.homedir(),
  ".claude",
  "ccmgr-state",
  "forgotten.json",
);

export declare interface ForgottenStore {
  on(event: "changed", listener: () => void): this;
}

/**
 * 「サイドバーから永続的に削除したセッション」の id 集合を保持する。
 *
 * `HiddenStore` との違い:
 * - `HiddenStore` (Hide): 一時的に隠す。`Show Hidden Sessions...` から復元可能。
 *   jsonl が更新されると registry には載るが TreeProvider 側で非表示にされる。
 * - `ForgottenStore` (Remove): 永続削除。watcher の event 段階で破棄するので
 *   registry にも載らない (= メモリも消費しない)。VSCode を再起動しても
 *   jsonl が更新されても、二度とサイドバーには出てこない。
 *   復活させたい場合は `Show Removed Sessions...` から復元するか、
 *   `~/.claude/ccmgr-state/forgotten.json` を直接編集する。
 *
 * 保存先は `~/.claude/ccmgr-state/forgotten.json` で `SyncedJsonFile` 経由で
 * `fs.watch` するため、**複数 VSCode/Cursor ウィンドウ間で同期** される。
 *
 * VSCode の `globalState` にもコピーを書く (旧バージョン互換 & 万一ファイル
 * watch が効かない FS でも自プロセス内では動くフォールバック)。
 */
export class ForgottenStore
  extends EventEmitter
  implements vscode.Disposable
{
  private forgotten: Set<string>;
  private file = new SyncedJsonFile<string[]>(FILE_PATH, []);

  constructor(private readonly state: vscode.Memento) {
    super();

    // 初期化: ファイル優先、空なら旧 globalState から migrate
    const fromFile = this.file.read();
    if (Array.isArray(fromFile) && fromFile.length > 0) {
      this.forgotten = new Set(fromFile);
    } else {
      const fromOld = state.get<string[]>(STORAGE_KEY, []);
      this.forgotten = new Set(fromOld);
      if (fromOld.length > 0) this.file.write(Array.from(this.forgotten));
    }

    // 他ウィンドウからの変更を検知して内部 set を更新
    this.file.on("externalChange", () => {
      const next = new Set(this.file.read());
      if (!setEqual(this.forgotten, next)) {
        this.forgotten = next;
        this.emit("changed");
      }
    });
  }

  has(sessionId: string): boolean {
    return this.forgotten.has(sessionId);
  }

  list(): string[] {
    return Array.from(this.forgotten);
  }

  size(): number {
    return this.forgotten.size;
  }

  async add(sessionId: string): Promise<void> {
    if (this.forgotten.has(sessionId)) return;
    this.forgotten.add(sessionId);
    await this.persist();
    this.emit("changed");
  }

  async remove(sessionId: string): Promise<void> {
    if (!this.forgotten.has(sessionId)) return;
    this.forgotten.delete(sessionId);
    await this.persist();
    this.emit("changed");
  }

  async clear(): Promise<void> {
    if (this.forgotten.size === 0) return;
    this.forgotten.clear();
    await this.persist();
    this.emit("changed");
  }

  dispose(): void {
    this.file.dispose();
  }

  private async persist(): Promise<void> {
    const arr = Array.from(this.forgotten);
    this.file.write(arr);
    // 旧 globalState にも書く (downgrade 時の保険)
    await this.state.update(STORAGE_KEY, arr);
  }
}

const setEqual = (a: Set<string>, b: Set<string>): boolean => {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
};
