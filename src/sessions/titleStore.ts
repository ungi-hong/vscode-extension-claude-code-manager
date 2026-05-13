import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { EventEmitter } from "events";
import { SyncedJsonFile } from "../utils/syncedJsonFile";

const STORAGE_KEY = "ccmgr.customTitles";
const FILE_PATH = path.join(
  os.homedir(),
  ".claude",
  "ccmgr-state",
  "titles.json",
);

export declare interface TitleStore {
  /** sessionId 引数は変更があった id (外部同期で複数まとめて変わったときは "*")。 */
  on(event: "changed", listener: (sessionId: string) => void): this;
}

/**
 * 「ユーザーが手動で付けたセッション題名」の永続ストア。
 *
 * 保存先は `~/.claude/ccmgr-state/titles.json` で `SyncedJsonFile` 経由で
 * `fs.watch` するため、**複数 VSCode/Cursor ウィンドウ間で同期** される。
 *
 * 自動生成 (firstUserPrompt 由来) のタイトルはここでは保存せず、
 * 都度 `SessionState.firstUserPrompt` から計算する。
 */
export class TitleStore extends EventEmitter implements vscode.Disposable {
  private titles: Map<string, string>;
  private file = new SyncedJsonFile<Record<string, string>>(FILE_PATH, {});

  constructor(private readonly state: vscode.Memento) {
    super();

    // 初期化: ファイル優先、空なら旧 globalState から migrate
    const fromFile = this.file.read();
    if (fromFile && Object.keys(fromFile).length > 0) {
      this.titles = new Map(Object.entries(fromFile));
    } else {
      const fromOld = state.get<Record<string, string>>(STORAGE_KEY, {});
      this.titles = new Map(Object.entries(fromOld));
      if (Object.keys(fromOld).length > 0) this.file.write({ ...fromOld });
    }

    this.file.on("externalChange", () => {
      const next = new Map(Object.entries(this.file.read()));
      if (!mapEqual(this.titles, next)) {
        this.titles = next;
        // どの sid が変わったか個別追跡は省略。Tree refresh は wildcard でも問題ない
        this.emit("changed", "*");
      }
    });
  }

  get(sessionId: string): string | undefined {
    const t = this.titles.get(sessionId);
    if (typeof t !== "string") return undefined;
    const trimmed = t.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  async set(sessionId: string, title: string): Promise<void> {
    const trimmed = title.trim();
    if (!trimmed) {
      await this.remove(sessionId);
      return;
    }
    if (this.titles.get(sessionId) === trimmed) return;
    this.titles.set(sessionId, trimmed);
    await this.persist();
    this.emit("changed", sessionId);
  }

  async remove(sessionId: string): Promise<void> {
    if (!this.titles.has(sessionId)) return;
    this.titles.delete(sessionId);
    await this.persist();
    this.emit("changed", sessionId);
  }

  /** pending- から確定 sessionId へ rename された時に、保存済みタイトルを引き継ぐ。 */
  async rename(oldId: string, newId: string): Promise<void> {
    if (oldId === newId) return;
    const t = this.titles.get(oldId);
    if (t === undefined) return;
    this.titles.delete(oldId);
    this.titles.set(newId, t);
    await this.persist();
    this.emit("changed", newId);
  }

  dispose(): void {
    this.file.dispose();
  }

  private async persist(): Promise<void> {
    const obj: Record<string, string> = {};
    for (const [k, v] of this.titles) obj[k] = v;
    this.file.write(obj);
    // 旧 globalState にも書く (downgrade 時の保険)
    await this.state.update(STORAGE_KEY, obj);
  }
}

const mapEqual = (a: Map<string, string>, b: Map<string, string>): boolean => {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
};
