import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import { EventEmitter } from "events";
import { normalizeCwd } from "../utils/cwd";

/**
 * セッション 1 件分の Remote Control 状態。
 * Webview ヘッダーへ流すペイロードと一致させる。
 */
export interface RemoteControlInfo {
  /** どの managed セッションに紐付くか */
  sessionId: string;
  /** spawn 完了済みかつ URL 抽出済みなら "active"、それ以外は "starting" */
  status: "starting" | "active";
  /** claude.ai/code 上の Remote Control セッション URL (active 時のみ) */
  url?: string;
  /** Remote Control 側で付けた表示名 (--name の値) */
  name?: string;
}

interface Slot {
  proc: ChildProcessWithoutNullStreams;
  info: RemoteControlInfo;
}

export interface StartOptions {
  /** `claude` CLI バイナリの絶対パス (extension.ts で解決済み) */
  pathToClaudeCodeExecutable: string;
  /** Remote Control セッションを起動するディレクトリ (= managed セッションの cwd) */
  cwd: string;
  /** claude.ai/code 上に出す表示名。未指定なら CLI が auto 生成 */
  name?: string;
  /** OutputChannel への logger (stderr / URL 抽出ログ用) */
  logger?: (msg: string) => void;
}

export declare interface RemoteControlManager {
  on(
    event: "started",
    listener: (info: RemoteControlInfo) => void,
  ): this;
  on(
    event: "stopped",
    listener: (sessionId: string) => void,
  ): this;
  on(
    event: "error",
    listener: (sessionId: string, err: Error) => void,
  ): this;
}

/**
 * `claude remote-control --spawn session ...` を managed セッションごとに 1 本だけ
 * 並走させる。Webview セッション (headless CLI) とは独立した別会話になる
 * (履歴は共有しない)。
 *
 * 設計メモ:
 *   - `--spawn session` で「単一セッション・追加接続拒否」モードにしている。
 *     server (same-dir / worktree) モードだと携帯側が空っぽから何度でも
 *     新規セッションを開けてしまうので、ユーザー期待 (このフォルダ用の 1 本) と
 *     合わない。
 *   - URL 抽出は raw data の累積に regex を当てる方式。行バッファだと
 *     TUI 制御文字や Windows のブロックバッファで行が来ないケースを取りこぼす。
 *   - TUI を抑制するため NO_COLOR / TERM=dumb / CI=1 / FORCE_COLOR=0 / --verbose を渡す。
 *   - 1 セッション 1 子プロセス。同 sessionId に対する重複 start は no-op。
 *   - 15s 経って URL を抽出できなければ error を発火し UI に通知。
 */
export class RemoteControlManager extends EventEmitter {
  private slots = new Map<string, Slot>();

  /**
   * 既に動いていれば既存 Slot を返す。新規 spawn は子プロセス起動だけ済ませて
   * 同期的に "starting" 情報を返す。URL 確定は started イベントで通知。
   */
  start(sessionId: string, opts: StartOptions): RemoteControlInfo {
    const existing = this.slots.get(sessionId);
    if (existing) return existing.info;

    // Windows のドライブレター違い (`c:\` と `C:\`) で trust 判定が外れるため正規化。
    const cwd = normalizeCwd(opts.cwd);

    // `--verbose` を足して URL を確実に stdout に印字させる狙い。
    const args = [
      "remote-control",
      "--spawn",
      "session",
      "--verbose",
    ];
    if (opts.name) {
      args.push("--name", opts.name);
    }

    opts.logger?.(
      `[rc] spawn sid=${sessionId.slice(0, 8)} cwd=${cwd} name=${opts.name ?? "(auto)"} bin=${opts.pathToClaudeCodeExecutable}`,
    );

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(opts.pathToClaudeCodeExecutable, args, {
        cwd,
        // stdin を完全に閉じると CLI が EOF 検知で即終了することがあるので
        // pipe で開きっぱなしにしておく (書き込まない)。
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: {
          ...process.env,
          // ANSI / TUI を抑制して URL を素直に行で出させるためのヒント群。
          // 効くかは CLI 実装次第だが、効くケースが多いので一通り set。
          NO_COLOR: "1",
          FORCE_COLOR: "0",
          TERM: "dumb",
          CI: "1",
        },
      });
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      this.emit("error", sessionId, e);
      throw e;
    }

    const info: RemoteControlInfo = {
      sessionId,
      status: "starting",
      name: opts.name,
    };
    const slot: Slot = { proc: child, info };
    this.slots.set(sessionId, slot);

    // URL 抽出: claude.ai / claude.com の URL を拾う。
    // 行バッファに頼らず raw data の累積から正規表現で抜く (TUI モードや
    // Windows のブロックバッファで行が来ない場合への保険)。
    const urlRegex = /https:\/\/[a-z0-9.-]*claude\.(ai|com)\/[^\s\x1b\x07"'<>]+/gi; // eslint-disable-line no-control-regex
    // ANSI / OSC / カーソル制御を一通り剥がす。ESC (\x1b) のシーケンス全種。
    const ansiRegex = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()*+][AB012]|[=>])/g; // eslint-disable-line no-control-regex
    const stripAnsi = (s: string): string => s.replace(ansiRegex, "");

    let stdoutBuffer = "";
    let stderrBuffer = "";
    let rawBytesLogged = 0;
    const MAX_RAW_LOG = 4096;
    // 初回起動時の "Enable Remote Control? (y/n)" オンボーディング確認。
    // 1 回 y を投げれば以降の起動では出なくなるので、検出時のみ自動応答する。
    let enablePromptAnswered = false;
    const tryAnswerEnablePrompt = (haystack: string): void => {
      if (enablePromptAnswered) return;
      if (!/Enable Remote Control\?\s*\(y\/n\)/i.test(haystack)) return;
      enablePromptAnswered = true;
      try {
        child.stdin.write("y\n");
      } catch (err) {
        opts.logger?.(
          `[rc] failed to answer enable prompt sid=${sessionId.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      opts.logger?.(`[rc] auto-answered enable prompt sid=${sessionId.slice(0, 8)}`);
    };

    const tryExtractUrl = (): void => {
      if (info.status === "active") return;
      const haystack = stripAnsi(stdoutBuffer + "\n" + stderrBuffer);
      urlRegex.lastIndex = 0;
      const m = urlRegex.exec(haystack);
      if (!m) return;
      info.url = m[0];
      info.status = "active";
      opts.logger?.(
        `[rc] URL captured sid=${sessionId.slice(0, 8)} url=${info.url}`,
      );
      this.emit("started", { ...info });
    };

    const onChunk = (which: "out" | "err", chunk: Buffer): void => {
      const text = chunk.toString("utf8");
      if (which === "out") stdoutBuffer += text;
      else stderrBuffer += text;
      // 累積が肥大化しないよう古い部分を捨てる (URL は近くにあるはず)
      if (stdoutBuffer.length > 16384) stdoutBuffer = stdoutBuffer.slice(-8192);
      if (stderrBuffer.length > 16384) stderrBuffer = stderrBuffer.slice(-8192);

      // raw を最初の数 KB だけ生ログ (TUI で行が来ないケースの調査用)
      if (rawBytesLogged < MAX_RAW_LOG) {
        const sample = text
          .replace(/\x1b/g, "\\x1b") // eslint-disable-line no-control-regex
          .replace(/\r/g, "\\r")
          .replace(/\n/g, "\\n");
        opts.logger?.(
          `[rc:${which}:raw] sid=${sessionId.slice(0, 8)} bytes=${chunk.length} ${sample.slice(0, 400)}`,
        );
        rawBytesLogged += chunk.length;
      }

      // 行単位の clean ログも別途出す (人間が読みやすい)
      const cleaned = stripAnsi(text);
      for (const line of cleaned.split(/\r?\n/)) {
        const t = line.trim();
        if (t) opts.logger?.(`[rc:${which}] sid=${sessionId.slice(0, 8)} ${t}`);
      }

      tryAnswerEnablePrompt(stripAnsi(stdoutBuffer + "\n" + stderrBuffer));
      tryExtractUrl();
    };

    child.stdout.on("data", (c: Buffer) => onChunk("out", c));
    child.stderr.on("data", (c: Buffer) => onChunk("err", c));

    child.on("error", (err) => {
      opts.logger?.(`[rc] spawn error sid=${sessionId.slice(0, 8)}: ${err.message}`);
      this.emit("error", sessionId, err);
      this.cleanup(sessionId);
    });

    child.on("exit", (code, signal) => {
      opts.logger?.(
        `[rc] exited sid=${sessionId.slice(0, 8)} code=${code} signal=${signal ?? "-"}`,
      );
      // URL を出す前に code != 0 で落ちた場合は、stderr の中身から既知のエラーを
      // 抜き出してユーザー向けに案内する。何も拾えなければ "stopped" だけ流す。
      // - "Workspace not trusted": CLI 初回起動時の trust dialog 未承認。
      //   spawn 経由だと TUI が出せないので、ターミナルで一度 claude を実行する
      //   よう案内する。
      let userError: Error | undefined;
      if (code !== 0 && info.status !== "active") {
        const stderrText = stripAnsi(stderrBuffer);
        if (/Workspace not trusted/i.test(stderrText)) {
          userError = new Error(
            `Workspace not trusted: PowerShell で \`${cwd}\` に移動し、一度 \`claude\` を実行して trust dialog を承認してください。承認後はこの拡張から再度 Remote Control を起動できます。`,
          );
        }
      }
      this.cleanup(sessionId);
      if (userError) {
        // cleanup の "stopped" を上書きする形で error を流す
        // (extension.ts の status push は後勝ち)。
        this.emit("error", sessionId, userError);
      }
    });

    // 15 秒経っても URL を拾えていなければ、ユーザーに OutputChannel を見るよう促す。
    // CLI 仕様変更で URL 書式が変わった場合や、Windows のブロックバッファで
    // stdout が飛んでこないケースを早めに検知させる。
    setTimeout(() => {
      if (this.slots.get(sessionId) === slot && info.status === "starting") {
        opts.logger?.(
          `[rc] no URL captured after 15s sid=${sessionId.slice(0, 8)} — check raw output above; CLI may be buffering or URL pattern changed.`,
        );
        this.emit("error", sessionId, new Error(
          "Remote Control URL を 15 秒以内に抽出できませんでした。Output (Claude Code Manager) の [rc:*:raw] ログを確認してください。",
        ));
      }
    }, 15000).unref();

    return info;
  }

  /**
   * 該当 sessionId の Remote Control を停止する。動いていなければ no-op。
   * 停止完了は stopped イベントで通知。
   */
  stop(sessionId: string): void {
    const slot = this.slots.get(sessionId);
    if (!slot) return;
    try {
      // Windows の子プロセスツリーを確実に殺すために SIGTERM → 1 秒後 SIGKILL。
      // remote-control は CLI 自身が claude.ai に "session closed" を送ってから
      // 終了するため、即殺すと向こうに残骸が残る可能性がある (が、サーバー側で
      // 短時間で枯れる想定)。
      slot.proc.kill("SIGTERM");
      const proc = slot.proc;
      setTimeout(() => {
        if (!proc.killed && proc.exitCode === null) {
          proc.kill("SIGKILL");
        }
      }, 1000).unref();
    } catch {
      // すでに死んでる等は無視
    }
  }

  /** 現在の Remote Control 状態を取得 (active/starting/未起動) */
  getInfo(sessionId: string): RemoteControlInfo | undefined {
    return this.slots.get(sessionId)?.info;
  }

  isActive(sessionId: string): boolean {
    return this.slots.has(sessionId);
  }

  /** 全 Remote Control を停止 (extension deactivate 時) */
  disposeAll(): void {
    for (const sid of Array.from(this.slots.keys())) {
      this.stop(sid);
    }
  }

  private cleanup(sessionId: string): void {
    if (!this.slots.has(sessionId)) return;
    this.slots.delete(sessionId);
    this.emit("stopped", sessionId);
  }
}
