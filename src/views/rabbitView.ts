import * as vscode from "vscode";
import {
  RateLimitState,
  RateLimitType,
  UsageBlock,
  UsageStore,
} from "../sessions/usageStore";

/**
 * 🐰 トークン使用率 WebviewView。
 *
 * うさぎのにんじん消費 (rabbit-{20,40,60,80,100}.gif) で **現在のトークン
 * 使用率** を表現するパネル。同じ画面に下記も併記する:
 *
 * - 現在 (5h ブロック) の累計トークン / バーンレート / 経過時間
 * - SDK rate_limit_event 由来のアカウント枠 (5h / 週次 / Opus / Sonnet / 超過)
 *
 * usageRatio (= rateLimits の最大 utilization) でうさぎが食べ進んでいき、
 * 100% に到達するとにんじんを食べきった状態 = トークン枯渇 を意味する。
 *
 * usageRatio が取得できない (rate_limit_event 未到達) ときは 0% 扱いで
 * rabbit-20.gif を表示する。
 */
export class RabbitWebviewProvider
  implements vscode.WebviewViewProvider, vscode.Disposable
{
  public static readonly viewType = "ccmgr.rabbit";

  private view?: vscode.WebviewView;
  private storeListener = () => this.updateView();
  private liveTimer: NodeJS.Timeout;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly usageStore: UsageStore,
  ) {
    this.usageStore.on("changed", this.storeListener);
    // 残り時間/カウントダウンの滑らか更新のため 5 秒ごとに再評価
    this.liveTimer = setInterval(() => this.updateView(), 5_000);
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    webviewView.webview.html = this.renderHtml(webviewView.webview);
    webviewView.onDidDispose(() => {
      this.view = undefined;
    });
    this.updateView();
  }

  dispose(): void {
    clearInterval(this.liveTimer);
    this.usageStore.off("changed", this.storeListener);
  }

  private updateView(): void {
    if (!this.view) return;
    const summary = this.usageStore.summary();

    const usageRatio = Math.min(
      1,
      Math.max(
        0,
        summary.rateLimits.reduce(
          (acc, r) => Math.max(acc, r.utilization ?? 0),
          0,
        ),
      ),
    );

    const block = summary.currentBlock;
    // block が無い (5h 以内の JSONL 活動なし) ときでもトークン行は常に出す。
    // 使ったトークン: block.totalTokens または 0
    // 推定上限: usedTokens / usageRatio (usageRatio>0 のときのみ)
    const usedTokens = block?.totalTokens ?? 0;
    const usedFmt = formatTokens(usedTokens);
    const totalEst =
      usageRatio > 0 && usedTokens > 0
        ? Math.round(usedTokens / usageRatio)
        : undefined;
    const tokensRatioFmt =
      totalEst !== undefined
        ? `${usedFmt} / ${formatTokens(totalEst)}`
        : usedFmt;

    const blockPayload = block
      ? buildBlockPayload(block, usageRatio)
      : undefined;
    const rateLimitsPayload = sortRateLimits(summary.rateLimits).map(
      buildRateLimitPayload,
    );

    this.view.webview.postMessage({
      type: "state",
      usageRatio,
      usagePct: Math.round(usageRatio * 100),
      tokensRatioFmt,
      block: blockPayload,
      rateLimits: rateLimitsPayload,
      now: Date.now(),
    });
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = makeNonce();
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${webview.cspSource}`,
    ].join("; ");

    const rabbitUris = [20, 40, 60, 80, 100].map((pct) =>
      webview
        .asWebviewUri(
          vscode.Uri.joinPath(
            this.extensionUri,
            "src",
            "views",
            "images",
            `rabbit-${pct}.gif`,
          ),
        )
        .toString(),
    );

    return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 12px 10px;
      font-family: var(--vscode-font-family);
      color: var(--vscode-editor-foreground);
      font-size: var(--vscode-font-size, 13px);
      line-height: 1.5;
    }
    .bunny {
      width: 100%;
      max-width: 120px;
      margin: 0 auto 12px;
    }
    .bunny img {
      width: 100%;
      height: auto;
      display: block;
    }
    .section-title {
      margin: 14px 0 4px;
      font-size: 0.78em;
      letter-spacing: 0.04em;
      color: var(--vscode-descriptionForeground);
      text-transform: uppercase;
    }
    .row {
      display: flex;
      align-items: baseline;
      gap: 6px;
      padding: 2px 0;
    }
    .row .emoji { width: 1.4em; flex: none; text-align: center; }
    .row .label { color: var(--vscode-descriptionForeground); flex: 1; }
    .row .value { font-weight: 600; }
    .row .small {
      color: var(--vscode-descriptionForeground);
      font-size: 0.85em;
    }
    .breakdown {
      margin-left: calc(1.4em + 6px);
      font-size: 0.85em;
      color: var(--vscode-descriptionForeground);
    }
    .ratio-bar {
      display: inline-block;
      vertical-align: middle;
      width: 56px;
      height: 6px;
      border-radius: 3px;
      background: color-mix(in srgb, currentColor 15%, transparent);
      overflow: hidden;
      margin-right: 4px;
    }
    .ratio-bar > span {
      display: block;
      height: 100%;
      border-radius: 3px;
    }
    .pct-low    > span { background: var(--vscode-charts-green); }
    .pct-mid    > span { background: var(--vscode-charts-yellow); }
    .pct-high   > span { background: var(--vscode-charts-orange); }
    .pct-critical > span { background: var(--vscode-charts-red); }

    /* スクショに合わせたアカウント枠 row */
    .limit-row {
      margin: 6px 0 10px;
    }
    .limit-label {
      font-weight: 600;
      margin-bottom: 2px;
    }
    .limit-meta {
      font-size: 0.78em;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 4px;
    }
    .limit-bar-line {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .bar-full {
      flex: 1;
      height: 6px;
      border-radius: 3px;
      background: color-mix(in srgb, currentColor 15%, transparent);
      overflow: hidden;
    }
    .bar-full > span {
      display: block;
      height: 100%;
      border-radius: 3px;
    }
    .bar-full.pct-low    > span { background: var(--vscode-charts-green); }
    .bar-full.pct-mid    > span { background: var(--vscode-charts-yellow); }
    .bar-full.pct-high   > span { background: var(--vscode-charts-orange); }
    .bar-full.pct-critical > span { background: var(--vscode-charts-red); }
    .limit-pct {
      flex: none;
      font-size: 0.85em;
      color: var(--vscode-descriptionForeground);
    }
    .empty {
      text-align: center;
      padding: 18px 8px;
      color: var(--vscode-descriptionForeground);
      font-size: 0.9em;
    }
    .empty .big { font-size: 2em; display: block; margin-bottom: 6px; }
    .hint {
      margin-top: 12px;
      padding: 8px 10px;
      font-size: 0.78em;
      color: var(--vscode-descriptionForeground);
      background: var(--vscode-editorWidget-background);
      border-left: 3px solid var(--vscode-charts-yellow, #d4a017);
      border-radius: 3px;
      line-height: 1.45;
    }
  </style>
</head>
<body>
  <div id="root">
    <div class="bunny"><img id="bunny-img" alt="rabbit" /></div>
    <div id="stats"></div>
  </div>

  <script nonce="${nonce}">
    const RABBIT_URIS = ${JSON.stringify(rabbitUris)};
    const bunnyImg = document.getElementById('bunny-img');
    const stats = document.getElementById('stats');

    function pickUri(usageRatio) {
      const idx = Math.max(1, Math.min(5, Math.ceil(usageRatio * 5))) - 1;
      return RABBIT_URIS[idx];
    }

    function setBunny(usageRatio) {
      bunnyImg.src = pickUri(usageRatio);
    }

    function pctClass(ratio) {
      if (ratio >= 0.9) return 'pct-critical';
      if (ratio >= 0.7) return 'pct-high';
      if (ratio >= 0.5) return 'pct-mid';
      return 'pct-low';
    }

    function fmtPct(ratio) {
      return Math.min(100, Math.round(ratio * 100)) + '%';
    }

    function renderRatioBar(ratio) {
      const cls = pctClass(ratio);
      const w = Math.min(100, Math.max(0, ratio * 100));
      return '<span class="ratio-bar ' + cls + '"><span style="width:' + w + '%"></span></span>';
    }

    function escapeHtml(s) {
      return String(s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function row(emoji, valueHtml, labelHtml) {
      return '<div class="row">' +
        '<span class="emoji">' + emoji + '</span>' +
        '<span class="value">' + valueHtml + '</span>' +
        (labelHtml ? '<span class="label">' + labelHtml + '</span>' : '') +
        '</div>';
    }

    function renderBlock(block) {
      if (!block) return '';
      const parts = [];

      // breakdown (block 由来のときだけ詳細出す)
      const breakdown = [];
      breakdown.push('⤵' + block.inputTokensFmt);
      breakdown.push('⤴' + block.outputTokensFmt);
      if (block.cacheReadInputTokens > 0) breakdown.push('📦r' + block.cacheReadFmt);
      if (block.cacheCreationInputTokens > 0) breakdown.push('📦c' + block.cacheCreateFmt);
      parts.push('<div class="breakdown">' + breakdown.join(' · ') + '</div>');

      // burn rate
      let burnRight = '';
      if (block.projectedAddTokensFmt) {
        burnRight = '+' + block.projectedAddTokensFmt + ' 予測';
      }
      parts.push(row('💨', block.burnRateFmt + '/min', burnRight));

      // elapsed / remaining
      const elapsedBar = renderRatioBar(block.elapsedRatio);
      const elapsedRight = block.remainingFmt
        ? '残り ' + escapeHtml(block.remainingFmt)
        : '';
      parts.push(row('⏰',
        elapsedBar + fmtPct(block.elapsedRatio) + ' (' + escapeHtml(block.elapsedFmt) + ' 経過)',
        elapsedRight));

      // start/end
      parts.push(row('🕐',
        escapeHtml(block.startStr) + ' → ' + escapeHtml(block.endStr),
        '最終 ' + escapeHtml(block.sinceLastFmt) + ' 前'));

      return parts.join('');
    }

    function renderLimitRow(r) {
      const meta = r.resetFmt
        ? '<div class="limit-meta">' + escapeHtml(r.resetFmt) + '</div>'
        : '';
      const bar = r.hasRatio
        ? '<div class="limit-bar-line">' +
            '<div class="bar-full ' + pctClass(r.ratio) + '">' +
              '<span style="width:' + Math.min(100, Math.max(0, r.ratio * 100)) + '%"></span>' +
            '</div>' +
            '<div class="limit-pct">' + fmtPct(r.ratio) + ' 使用済み</div>' +
          '</div>'
        : '<div class="limit-meta">' + escapeHtml(r.statusLabel) + '</div>';
      return '<div class="limit-row">' +
        '<div class="limit-label">' + escapeHtml(r.label) + '</div>' +
        meta + bar +
      '</div>';
    }

    function renderRateLimits(rls) {
      const sessionRows = rls.filter(r => r.section === 'session');
      const weeklyRows  = rls.filter(r => r.section === 'weekly');
      const overageRows = rls.filter(r => r.section === 'overage');
      const parts = [];

      if (sessionRows.length > 0) {
        parts.push('<div class="section-title">現在のセッション</div>');
        for (const r of sessionRows) parts.push(renderLimitRow(r));
      }
      if (weeklyRows.length > 0) {
        parts.push('<div class="section-title">週間制限</div>');
        for (const r of weeklyRows) parts.push(renderLimitRow(r));
      }
      if (overageRows.length > 0) {
        parts.push('<div class="section-title">超過</div>');
        for (const r of overageRows) parts.push(renderLimitRow(r));
      }
      return parts.join('');
    }

    function render(state) {
      const rls = state.rateLimits || [];
      const hasRateLimits = rls.length > 0;
      const hasBlock = !!state.block;

      // うさぎは常に表示。utilization データが無ければ rabbit-20 で固定。
      setBunny(state.usageRatio || 0);

      const parts = [];

      // 🔥 トークン (block 経由)。block 無くても 0 表示はしない
      if (hasBlock) {
        const pctSuffix = hasRateLimits
          ? ' (' + state.usagePct + '%)'
          : '';
        parts.push(row('🔥', escapeHtml(state.tokensRatioFmt), 'tokens' + pctSuffix));
        parts.push(renderBlock(state.block));
      }

      // 現在のセッション / 週間制限 (rate_limit_event があるときだけ)
      if (hasRateLimits) {
        parts.push(renderRateLimits(rls));
      }

      if (!hasBlock && !hasRateLimits) {
        parts.push('<div class="empty"><span class="big">🐰💤</span>セッション開始まちだよ</div>');
      }

      stats.innerHTML = parts.join('');
    }

    // 初期表示 (state 来るまでは 0%)
    setBunny(0);
    stats.innerHTML = '<div class="empty"><span class="big">🐰</span>読み込み中…</div>';

    window.addEventListener('message', (e) => {
      const msg = e.data;
      if (!msg || msg.type !== 'state') return;
      render(msg);
    });
  </script>
</body>
</html>`;
  }
}

// ============ サーバ側: payload 構築 ============

interface BlockPayload {
  elapsedRatio: number;
  elapsedFmt: string;
  remainingFmt?: string;
  inputTokensFmt: string;
  outputTokensFmt: string;
  cacheReadFmt: string;
  cacheCreateFmt: string;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  /** 「12.3K / 87.8K」のような used/total 表示。total 推定不可なら used のみ。 */
  tokensRatioFmt: string;
  burnRateFmt: string;
  projectedAddTokensFmt?: string;
  startStr: string;
  endStr: string;
  sinceLastFmt: string;
}

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;

const buildBlockPayload = (
  block: UsageBlock,
  usageRatio: number,
): BlockPayload => {
  const elapsedRatio = Math.min(1, block.elapsedMs / FIVE_HOURS_MS);
  const sinceLast = Date.now() - block.lastActivity;
  const projectedAdd =
    block.remainingMs && block.remainingMs > 0
      ? Math.round(block.burnRatePerMinute * (block.remainingMs / 60_000))
      : undefined;

  // 推定: 使用率 (utilization) と 実際使用量 (totalTokens) から
  // 「ブロック全体で使えるトークン量」を逆算。utilization=0 のとき (公式枠の
  // データなし) は推定不可なので used のみを表示する。
  const usedFmt = formatTokens(block.totalTokens);
  const tokensRatioFmt =
    usageRatio > 0
      ? `${usedFmt} / ${formatTokens(Math.round(block.totalTokens / usageRatio))}`
      : usedFmt;

  return {
    elapsedRatio,
    elapsedFmt: formatDuration(block.elapsedMs),
    remainingFmt:
      block.remainingMs !== undefined
        ? formatDuration(block.remainingMs)
        : undefined,
    inputTokensFmt: formatTokens(block.inputTokens),
    outputTokensFmt: formatTokens(block.outputTokens),
    cacheReadFmt: formatTokens(block.cacheReadInputTokens),
    cacheCreateFmt: formatTokens(block.cacheCreationInputTokens),
    cacheReadInputTokens: block.cacheReadInputTokens,
    cacheCreationInputTokens: block.cacheCreationInputTokens,
    tokensRatioFmt,
    burnRateFmt: formatTokens(Math.round(block.burnRatePerMinute)),
    projectedAddTokensFmt:
      projectedAdd !== undefined ? formatTokens(projectedAdd) : undefined,
    startStr: new Date(block.startTime).toLocaleTimeString(),
    endStr: new Date(block.endTime).toLocaleTimeString(),
    sinceLastFmt: formatDuration(sinceLast),
  };
};

interface RateLimitPayload {
  type: RateLimitType;
  section: "session" | "weekly" | "overage";
  label: string;
  hasRatio: boolean;
  ratio: number;
  statusLabel: string;
  resetFmt?: string;
}

const buildRateLimitPayload = (r: RateLimitState): RateLimitPayload => {
  const display = RATE_LIMIT_DISPLAY[r.type];
  return {
    type: r.type,
    section: display.section,
    label: display.name,
    hasRatio: r.utilization !== undefined,
    ratio: r.utilization ?? 0,
    statusLabel: r.status,
    resetFmt: r.resetsAt
      ? display.section === "session"
        ? `${formatCountdown(r.resetsAt)}後にリセット`
        : `${formatAbsoluteResetTime(r.resetsAt)}にリセット`
      : undefined,
  };
};

const sortRateLimits = (xs: readonly RateLimitState[]): RateLimitState[] =>
  xs
    .slice()
    .sort(
      (a, b) =>
        RATE_LIMIT_ORDER.indexOf(a.type) - RATE_LIMIT_ORDER.indexOf(b.type),
    );

/**
 * Claude 公式 UI の用語に揃えてある。
 * - `five_hour`     → 「現在のセッション」セクション (countdown 表示)
 * - `seven_day*`    → 「週間制限」セクション (絶対時刻 + 曜日 表示)
 * - `overage`       → 「超過」セクション
 */
const RATE_LIMIT_DISPLAY: Record<
  RateLimitType,
  { section: "session" | "weekly" | "overage"; name: string }
> = {
  five_hour: { section: "session", name: "現在のセッション" },
  seven_day: { section: "weekly", name: "すべてのモデル" },
  seven_day_opus: { section: "weekly", name: "Opus" },
  seven_day_sonnet: { section: "weekly", name: "Sonnet" },
  overage: { section: "overage", name: "超過" },
};

const RATE_LIMIT_ORDER: RateLimitType[] = [
  "five_hour",
  "seven_day",
  "seven_day_opus",
  "seven_day_sonnet",
  "overage",
];

const WEEKDAY_JA = ["日", "月", "火", "水", "木", "金", "土"] as const;

const formatAbsoluteResetTime = (resetsAt: number): string => {
  const d = new Date(resetsAt);
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  return `${hh}:${mm} (${WEEKDAY_JA[d.getDay()]})`;
};

// ============ formatters (tokenView から移植) ============

const formatTokens = (n: number): string => {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10000 ? 1 : 0) + "K";
  return (n / 1_000_000).toFixed(1) + "M";
};

const formatDuration = (ms: number): string => {
  if (ms < 1000) return "0秒";
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}秒`;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) return `${totalMin}分`;
  const hr = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  if (hr < 24) return min > 0 ? `${hr}時間${min}分` : `${hr}時間`;
  const day = Math.floor(hr / 24);
  const remHr = hr % 24;
  return remHr > 0 ? `${day}日${remHr}時間` : `${day}日`;
};

const formatCountdown = (resetsAt: number): string => {
  const ms = resetsAt - Date.now();
  if (ms <= 0) return "リセット済み";
  return formatDuration(ms);
};

const makeNonce = (): string => {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i += 1)
    out += chars[Math.floor(Math.random() * chars.length)];
  return out;
};
