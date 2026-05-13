import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { EventEmitter } from "events";
import { SyncedJsonFile } from "../utils/syncedJsonFile";

const STORAGE_KEY = "ccmgr.hiddenSessions";
const FILE_PATH = path.join(
  os.homedir(),
  ".claude",
  "ccmgr-state",
  "hidden.json",
);

export declare interface HiddenStore {
  on(event: "changed", listener: () => void): this;
}

/**
 * 「サイドバーから隠したセッション」の id 集合を保持する。
 *
 * 保存先は `~/.claude/ccmgr-state/hidden.json` で `SyncedJsonFile` 経由で
 * `fs.watch` するため、**複数 VSCode/Cursor ウィンドウ間で同期** される。
 *
 * VSCode の `globalState` にもコピーを書く (旧バージョン互換 & 万一ファイル
 * watch が効かない FS でも自プロセス内では動くフォールバック)。
 */
export class HiddenStore extends EventEmitter implements vscode.Disposable {
  private hidden: Set<string>;
  private file = new SyncedJsonFile<string[]>(FILE_PATH, []);

  constructor(private readonly state: vscode.Memento) {
    super();

    // 初期化: ファイル優先、空なら旧 globalState から migrate
    const fromFile = this.file.read();
    if (Array.isArray(fromFile) && fromFile.length > 0) {
      this.hidden = new Set(fromFile);
    } else {
      const fromOld = state.get<string[]>(STORAGE_KEY, []);
      this.hidden = new Set(fromOld);
      if (fromOld.length > 0) this.file.write(Array.from(this.hidden));
    }

    // 他ウィンドウからの変更を検知して内部 set を更新
    this.file.on("externalChange", () => {
      const next = new Set(this.file.read());
      if (!setEqual(this.hidden, next)) {
        this.hidden = next;
        this.emit("changed");
      }
    });
  }

  has(sessionId: string): boolean {
    return this.hidden.has(sessionId);
  }

  list(): string[] {
    return Array.from(this.hidden);
  }

  size(): number {
    return this.hidden.size;
  }

  async add(sessionId: string): Promise<void> {
    if (this.hidden.has(sessionId)) return;
    this.hidden.add(sessionId);
    await this.persist();
    this.emit("changed");
  }

  async remove(sessionId: string): Promise<void> {
    if (!this.hidden.has(sessionId)) return;
    this.hidden.delete(sessionId);
    await this.persist();
    this.emit("changed");
  }

  async clear(): Promise<void> {
    if (this.hidden.size === 0) return;
    this.hidden.clear();
    await this.persist();
    this.emit("changed");
  }

  dispose(): void {
    this.file.dispose();
  }

  private async persist(): Promise<void> {
    const arr = Array.from(this.hidden);
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
