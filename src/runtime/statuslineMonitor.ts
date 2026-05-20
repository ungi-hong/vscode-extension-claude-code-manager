import { EventEmitter } from "events";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * Claude Code 本体の `statusLine` 設定から呼ばれる shell スクリプトが
 * `/tmp/claude-statusline-input.json` に保存する JSON のうち、UI 表示に
 * 必要なフィールドだけを抜き出した正規化形。
 *
 * 元 JSON は statusline 起動ごとに上書きされる単一ファイル。
 * `current_usage` や `used_percentage` は会話 0 turn 目だと `null` で来る。
 */
export interface StatuslinePayload {
  /** 元 JSON の session_id。SessionPanel と紐付けるために保持。 */
  sessionId: string;
  /** どちらかが null の場合は contextWindow フィールド自体を undefined にする。 */
  contextWindow?: {
    usedPercentage: number;
    remainingPercentage: number;
  };
  /** 5h / 7d レート制限。両方欠けてたら undefined。 */
  rateLimits?: {
    fiveHour: { usedPercentage: number; resetsAt: number };
    sevenDay: { usedPercentage: number; resetsAt: number };
  };
}

/**
 * `/tmp/claude-statusline-input.json` を watch して JSON が更新されたら
 * `update` イベントで `StatuslinePayload` を流すモニタ。
 *
 * - パスは `os.tmpdir() + "/claude-statusline-input.json"`。
 * - ファイルが存在しない状態で start() しても落ちず、後で作られた瞬間から
 *   検知できるように親ディレクトリ (`/tmp`) を watch する設計にした。
 * - 連続書き込み (statusline は秒オーダーで来うる) は debounce 150ms。
 * - JSON.parse 失敗は捨てる (書き込み途中の truncated state を踏みうるため)。
 */
export class StatuslineMonitor extends EventEmitter {
  private static readonly FILENAME = "claude-statusline-input.json";
  private readonly filePath: string;
  private readonly dirPath: string;

  private fileWatcher?: fs.FSWatcher;
  private dirWatcher?: fs.FSWatcher;
  private debounceTimer?: NodeJS.Timeout;
  private disposed = false;

  constructor(opts?: { dirPath?: string; fileName?: string }) {
    super();
    this.dirPath = opts?.dirPath ?? os.tmpdir();
    this.filePath = path.join(
      this.dirPath,
      opts?.fileName ?? StatuslineMonitor.FILENAME,
    );
  }

  start(): void {
    if (this.disposed) return;
    // 既にファイルがあるなら即座に file watcher を貼る。
    this.tryAttachFileWatcher();
    // 親ディレクトリも watch して、削除 → 再作成 / そもそも未作成のケースに追従。
    this.tryAttachDirWatcher();
    // 初回読み込み: 既にファイルがあれば一度 emit しておく。
    this.readAndEmit();
  }

  dispose(): void {
    this.disposed = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    this.fileWatcher?.close();
    this.fileWatcher = undefined;
    this.dirWatcher?.close();
    this.dirWatcher = undefined;
    this.removeAllListeners();
  }

  private tryAttachFileWatcher(): void {
    if (this.fileWatcher) return;
    if (!fs.existsSync(this.filePath)) return;
    try {
      this.fileWatcher = fs.watch(this.filePath, { persistent: false }, () => {
        this.scheduleRead();
      });
      this.fileWatcher.on("error", () => {
        // ファイルが消えると ENOENT が飛んでくる。 close して dirWatcher に任せる。
        this.fileWatcher?.close();
        this.fileWatcher = undefined;
      });
    } catch {
      this.fileWatcher = undefined;
    }
  }

  private tryAttachDirWatcher(): void {
    if (this.dirWatcher) return;
    try {
      this.dirWatcher = fs.watch(
        this.dirPath,
        { persistent: false },
        (_event, fname) => {
          if (!fname) return;
          if (fname.toString() !== StatuslineMonitor.FILENAME) return;
          // 新規作成 / 再作成された可能性 → file watcher を貼り直して read。
          this.tryAttachFileWatcher();
          this.scheduleRead();
        },
      );
      this.dirWatcher.on("error", () => {
        // 例外時は何もしない (tmpdir が消えることは現実には無い)。
      });
    } catch {
      this.dirWatcher = undefined;
    }
  }

  private scheduleRead(): void {
    if (this.disposed) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      this.readAndEmit();
    }, 150);
  }

  private readAndEmit(): void {
    if (this.disposed) return;
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, "utf8");
    } catch {
      return; // ENOENT 等
    }
    if (!raw.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // 書き込み途中で truncated だとここに来る。次の通知で再試行されるので無視。
      return;
    }
    const payload = normalize(parsed);
    if (!payload) return;
    this.emit("update", payload);
  }
}

/**
 * 生 JSON から `StatuslinePayload` を抽出。型を絞ったうえで null チェックを
 * 通す。想定外の形状なら undefined を返して emit をスキップさせる。
 */
function normalize(raw: unknown): StatuslinePayload | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const sessionId = typeof r.session_id === "string" ? r.session_id : undefined;
  if (!sessionId) return undefined;

  const out: StatuslinePayload = { sessionId };

  const cw = r.context_window;
  if (cw && typeof cw === "object") {
    const c = cw as Record<string, unknown>;
    const used = numberOrNull(c.used_percentage);
    const remaining = numberOrNull(c.remaining_percentage);
    if (used != null && remaining != null) {
      out.contextWindow = { usedPercentage: used, remainingPercentage: remaining };
    }
  }

  const rl = r.rate_limits;
  if (rl && typeof rl === "object") {
    const x = rl as Record<string, unknown>;
    const five = extractLimit(x.five_hour);
    const seven = extractLimit(x.seven_day);
    if (five && seven) {
      out.rateLimits = { fiveHour: five, sevenDay: seven };
    }
  }

  return out;
}

function extractLimit(
  raw: unknown,
): { usedPercentage: number; resetsAt: number } | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const used = numberOrNull(r.used_percentage);
  const resets = numberOrNull(r.resets_at);
  if (used == null || resets == null) return undefined;
  return { usedPercentage: used, resetsAt: resets };
}

function numberOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
