import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({ breaks: true, gfm: true });

interface VsCodeApi {
  postMessage(msg: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

const log = document.getElementById("log") as HTMLElement;
const statusDot = document.getElementById("status-dot") as HTMLElement;
const titleProject = document.getElementById("title-project") as HTMLElement;
const titleBranch = document.getElementById("title-branch") as HTMLElement;
const titleSession = document.getElementById("title-session") as HTMLElement;
const originBadge = document.getElementById("origin-badge") as HTMLElement;
const inputBar = document.getElementById("input-bar") as HTMLElement;
const inputText = document.getElementById("input-text") as HTMLTextAreaElement;
const inputHint = document.getElementById("input-hint") as HTMLElement;
const btnSubmit = document.getElementById("btn-submit") as HTMLButtonElement;
const modeBadge = document.getElementById("mode-badge") as HTMLElement;
const slashDropdown = document.getElementById("slash-dropdown") as HTMLElement;

type PermissionMode =
  | "default"
  | "plan"
  | "acceptEdits"
  | "bypassPermissions";

interface SlashCommandLite {
  name: string;
  description: string;
  argumentHint: string;
  aliases?: string[];
  /** "user" / "project" / "plugin" / undefined (built-in) */
  source?: "user" | "project" | "plugin";
  /** plugin 由来時の plugin 名 */
  plugin?: string;
}

const MODE_BADGE: Record<PermissionMode, { label: string; icon: string }> = {
  default: { label: "Default", icon: "●" },
  acceptEdits: { label: "Accept Edits", icon: "⚡" },
  plan: { label: "Plan", icon: "📋" },
  bypassPermissions: { label: "Bypass", icon: "⚠" },
};

/**
 * Claude Code CLI 標準の slash command 静的フォールバック。
 * SDK の `supportedCommands()` が返ってくる前に `/` を打っても dropdown が
 * 出るようにするためのデフォルト。SDK から本物リストが来たら上書きされる。
 */
const FALLBACK_COMMANDS: SlashCommandLite[] = [
  { name: "help", description: "ヘルプを表示", argumentHint: "" },
  { name: "clear", description: "会話履歴をクリア", argumentHint: "" },
  { name: "compact", description: "会話履歴を要約して圧縮", argumentHint: "[focus]" },
  { name: "cost", description: "現在の会話のコストを表示", argumentHint: "" },
  { name: "model", description: "モデルを切替 (例: sonnet/opus)", argumentHint: "<model>" },
  { name: "init", description: "プロジェクト初期化 (CLAUDE.md 等)", argumentHint: "" },
  { name: "usage", description: "使用量・残り枠を表示", argumentHint: "" },
  { name: "memory", description: "メモリを編集", argumentHint: "" },
  { name: "review", description: "コードレビューを実行", argumentHint: "" },
  { name: "diff", description: "現在の差分を表示", argumentHint: "" },
  { name: "agents", description: "利用可能なエージェントを表示", argumentHint: "" },
  { name: "doctor", description: "環境チェックを実行", argumentHint: "" },
  { name: "config", description: "設定を表示・変更", argumentHint: "" },
  { name: "context", description: "コンテキスト情報を表示", argumentHint: "" },
  { name: "status", description: "セッション情報を表示", argumentHint: "" },
  { name: "todos", description: "TODO 一覧を表示", argumentHint: "" },
  { name: "hooks", description: "hooks 設定を編集", argumentHint: "" },
  { name: "mcp", description: "MCP サーバ一覧", argumentHint: "" },
  { name: "bug", description: "バグ報告", argumentHint: "" },
  { name: "exit", description: "セッションを終了", argumentHint: "" },
];

let slashCommands: SlashCommandLite[] = FALLBACK_COMMANDS.slice();
let slashState: { active: boolean; query: string; selected: number } = {
  active: false,
  query: "",
  selected: 0,
};

const renderedToolUses = new Map<string, HTMLElement>();
const renderedMessages = new Set<string>();
let userPinnedScroll = false;
let sessionOrigin: "external" | "managed" = "external";
let sessionSuspended = false;

window.addEventListener("scroll", () => {
  const nearBottom =
    window.innerHeight + window.scrollY >= document.body.offsetHeight - 50;
  userPinnedScroll = !nearBottom;
});

window.addEventListener("message", (event) => {
  const msg = event.data;
  if (!msg) return;
  if (msg.type === "state") applyState(msg.state);
  else if (msg.type === "event") applyEvent(msg.event);
  else if (msg.type === "sdk") applySdkMessage(msg.message);
  else if (msg.type === "status") {
    if (msg.kind === "error") hideThinking();
    showStatusLine(msg.text, msg.kind ?? "info");
  } else if (msg.type === "mode") {
    applyMode(msg.mode as PermissionMode);
  } else if (msg.type === "commands") {
    const incoming = (msg.commands ?? []) as SlashCommandLite[];
    // SDK が有効なリストを返したらフォールバックを置き換え。空なら静的を保つ。
    if (incoming.length > 0) {
      slashCommands = incoming;
    }
    if (slashState.active) renderSlashDropdown();
  }
});

btnSubmit.addEventListener("click", submitInput);
inputText.addEventListener("keydown", (ev) => {
  // 1. Slash dropdown が開いてる時は dropdown のキー操作を最優先
  if (slashState.active) {
    const filtered = filteredSlash();
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      if (filtered.length > 0) {
        slashState.selected = (slashState.selected + 1) % filtered.length;
        renderSlashDropdown();
      }
      return;
    }
    if (ev.key === "ArrowUp") {
      ev.preventDefault();
      if (filtered.length > 0) {
        slashState.selected =
          (slashState.selected - 1 + filtered.length) % filtered.length;
        renderSlashDropdown();
      }
      return;
    }
    if (ev.key === "Enter" || ev.key === "Tab") {
      if (filtered.length > 0) {
        ev.preventDefault();
        acceptSlash(filtered[slashState.selected]);
        return;
      }
    }
    if (ev.key === "Escape") {
      ev.preventDefault();
      closeSlash();
      return;
    }
  }

  // 2. Shift+Tab: モードサイクル
  if (ev.key === "Tab" && ev.shiftKey) {
    ev.preventDefault();
    vscode.postMessage({ command: "cycleMode" });
    return;
  }

  // 3. 既存: Cmd/Ctrl+Enter で送信
  if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) {
    ev.preventDefault();
    submitInput();
  }
});

// 入力変化を見て slash dropdown の open/filter を判定
inputText.addEventListener("input", () => {
  const v = inputText.value;
  // 「行頭が / で始まる、最初の行のみ評価」(textarea で複数行入力途中の / は無視)
  const firstLine = v.split("\n", 1)[0];
  if (firstLine.startsWith("/")) {
    slashState.active = true;
    slashState.query = firstLine.slice(1);
    if (slashState.selected >= filteredSlash().length) slashState.selected = 0;
    renderSlashDropdown();
  } else if (slashState.active) {
    closeSlash();
  }
});

function applyMode(mode: PermissionMode): void {
  const info = MODE_BADGE[mode];
  if (!info) return;
  modeBadge.textContent = `${info.icon} ${info.label}`;
  modeBadge.dataset.mode = mode;
}

/**
 * 部分一致 (substring) フィルタ + 優先度ソート。
 *   0: name が前方一致 (最も近い)
 *   1: alias が前方一致
 *   2: name に部分一致
 *   3: alias に部分一致
 *   4: description に部分一致
 * 同点は name アルファベット順。
 */
function filteredSlash(): SlashCommandLite[] {
  const q = slashState.query.toLowerCase();
  if (!q) return slashCommands;
  const scored: { cmd: SlashCommandLite; score: number }[] = [];
  for (const c of slashCommands) {
    const name = c.name.toLowerCase();
    const desc = c.description.toLowerCase();
    const aliasesLow = (c.aliases ?? []).map((a) => a.toLowerCase());
    let score = -1;
    if (name.startsWith(q)) score = 0;
    else if (aliasesLow.some((a) => a.startsWith(q))) score = 1;
    else if (name.includes(q)) score = 2;
    else if (aliasesLow.some((a) => a.includes(q))) score = 3;
    else if (desc.includes(q)) score = 4;
    if (score >= 0) scored.push({ cmd: c, score });
  }
  scored.sort(
    (a, b) => a.score - b.score || a.cmd.name.localeCompare(b.cmd.name),
  );
  return scored.map((s) => s.cmd);
}

function renderSlashDropdown(): void {
  const items = filteredSlash();
  if (items.length === 0) {
    slashDropdown.hidden = true;
    slashDropdown.innerHTML = "";
    return;
  }
  slashDropdown.hidden = false;
  slashDropdown.innerHTML = items
    .map((c, i) => {
      const cls = i === slashState.selected ? "slash-item active" : "slash-item";
      const hint = c.argumentHint
        ? `<span class="slash-hint">${escapeHtml(c.argumentHint)}</span>`
        : "";
      const srcBadge = c.source
        ? `<span class="slash-source slash-source-${c.source}">${c.source}</span>`
        : "";
      return `<div class="${cls}" data-index="${i}">
        <span class="slash-name">/${escapeHtml(c.name)}</span>
        ${srcBadge}
        ${hint}
        <span class="slash-desc">${escapeHtml(c.description)}</span>
      </div>`;
    })
    .join("");
  // クリック選択
  slashDropdown.querySelectorAll(".slash-item").forEach((el) => {
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const idx = Number((el as HTMLElement).dataset.index);
      const list = filteredSlash();
      if (list[idx]) acceptSlash(list[idx]);
    });
  });
}

function acceptSlash(cmd: SlashCommandLite): void {
  // 行頭の slash 行だけ書き換えて、続きの行は維持。引数が必要そうなら trailing space を入れる
  const lines = inputText.value.split("\n");
  const needsArg = !!cmd.argumentHint;
  lines[0] = `/${cmd.name}${needsArg ? " " : ""}`;
  inputText.value = lines.join("\n");
  closeSlash();
  // カーソルを slash 行末尾へ
  const pos = lines[0].length;
  inputText.setSelectionRange(pos, pos);
  inputText.focus();
}

function closeSlash(): void {
  slashState.active = false;
  slashState.query = "";
  slashState.selected = 0;
  slashDropdown.hidden = true;
  slashDropdown.innerHTML = "";
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function submitInput() {
  const text = inputText.value.trim();
  if (!text) return;
  vscode.postMessage({ command: "submit", text });
  // ローカルにも user メッセージとして即時表示 (echo)
  const block = document.createElement("section");
  block.className = "msg msg-user";
  block.appendChild(timestampEl(Date.now(), "User"));
  const body = document.createElement("div");
  body.className = "msg-body";
  body.innerHTML = renderMarkdown(text);
  block.appendChild(body);
  log.appendChild(block);
  inputText.value = "";
  showThinking();
  scrollToBottomIfNeeded();
}

let pendingAssistantBlock: HTMLElement | null = null;
let pendingAssistantBody: HTMLElement | null = null;
// SDK の stream_event は複数の content_block (text / tool_use / ...) を index 付きで
// 順次送ってくる。delta が text 以外の block (tool_use の input_json_delta 等) に
// 紛れ込んで assistant 表示領域に流れないよう、block index → 状態で管理する。
const activeBlockTypes = new Map<number, string>();
const activeBlockTexts = new Map<number, string>();

function showThinking() {
  if (pendingAssistantBlock) return;
  const block = document.createElement("section");
  block.className = "msg msg-assistant pending";
  block.appendChild(timestampEl(Date.now(), "Assistant"));
  const body = document.createElement("div");
  body.className = "msg-body thinking";
  body.innerHTML = '<span class="dots"><span></span><span></span><span></span></span> 考えています…';
  block.appendChild(body);
  log.appendChild(block);
  pendingAssistantBlock = block;
  pendingAssistantBody = body;
  activeBlockTypes.clear();
  activeBlockTexts.clear();
}

function appendTextDelta(index: number, text: string) {
  if (!pendingAssistantBlock) showThinking();
  if (!pendingAssistantBody) return;
  if (pendingAssistantBody.classList.contains("thinking")) {
    pendingAssistantBody.classList.remove("thinking");
    pendingAssistantBody.innerHTML = "";
  }
  const prev = activeBlockTexts.get(index) ?? "";
  activeBlockTexts.set(index, prev + text);
  // 進行中は素のテキストで表示。最終 assistant 受信時に Markdown 化。
  // 複数 text block があれば index 順に結合。
  const ordered = Array.from(activeBlockTexts.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v)
    .join("");
  pendingAssistantBody.textContent = ordered;
  scrollToBottomIfNeeded();
}

function hideThinking() {
  if (!pendingAssistantBlock) return;
  pendingAssistantBlock.remove();
  pendingAssistantBlock = null;
  pendingAssistantBody = null;
  activeBlockTypes.clear();
  activeBlockTexts.clear();
}

function showStatusLine(text: string, kind: "info" | "error" = "info") {
  const block = document.createElement("section");
  block.className = `msg msg-status ${kind}`;
  block.textContent = text;
  log.appendChild(block);
  scrollToBottomIfNeeded();
}

vscode.postMessage({ command: "ready" });

interface IncomingState {
  sessionId: string;
  cwd: string;
  projectName: string;
  gitBranch?: string;
  status: "running" | "idle" | "waiting" | "stale";
  startedAt: number;
  lastEventAt: number;
  origin: "external" | "managed";
  isSuspended: boolean;
}

function applyState(state: IncomingState) {
  titleProject.textContent = state.projectName || state.cwd;
  titleBranch.textContent = state.gitBranch ? `(${state.gitBranch})` : "";
  titleSession.textContent = state.sessionId.slice(0, 8);
  statusDot.dataset.status = state.status;
  statusDot.title = `Status: ${state.status}`;
  sessionOrigin = state.origin;
  sessionSuspended = state.isSuspended;
  originBadge.textContent =
    state.origin === "managed" ? "chat" : "履歴";
  originBadge.dataset.origin = state.origin;
  inputBar.classList.remove("disabled");
  inputText.disabled = false;
  btnSubmit.disabled = false;
  btnSubmit.textContent = "Send";
  if (state.origin === "managed" && !state.isSuspended) {
    inputHint.textContent = "Cmd+Enter で送信";
  } else if (state.origin === "managed" && state.isSuspended) {
    inputHint.textContent =
      "中断中 — 送信すると claude --resume で再開します";
  } else {
    inputHint.textContent =
      "履歴セッション — 送信すると拡張内で claude --resume を起動して継続できます";
  }
}

interface IncomingEvent {
  sessionId: string;
  type: string;
  timestamp: number;
  raw: any;
}

/**
 * SDK 由来の message を Webview にレンダリングする。
 * - stream_event: text_delta なら progressive にテキストを伸ばす
 * - assistant: 完全メッセージ受信。typing 表示を消して Markdown でレンダリング
 * - system.init: 接続成立を簡易表示
 * - result: ターン完了 (typing が残っていれば消す)
 * - その他: applyEvent に流して既存ロジックで処理
 */
function applySdkMessage(msg: any) {
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "stream_event") {
    const ev = msg.event;
    if (ev?.type === "content_block_start" && typeof ev.index === "number") {
      const blockType =
        typeof ev.content_block?.type === "string"
          ? (ev.content_block.type as string)
          : "unknown";
      activeBlockTypes.set(ev.index, blockType);
      if (blockType === "text") activeBlockTexts.set(ev.index, "");
      return;
    }
    if (ev?.type === "content_block_delta" && typeof ev.index === "number") {
      // text_delta は対応する block が text の場合のみ流す。tool_use の
      // input_json_delta 等を流すと assistant 表示が JSON 文字列で汚れる。
      if (
        ev.delta?.type === "text_delta" &&
        typeof ev.delta.text === "string" &&
        activeBlockTypes.get(ev.index) === "text"
      ) {
        appendTextDelta(ev.index, ev.delta.text);
      }
      return;
    }
    if (ev?.type === "content_block_stop" && typeof ev.index === "number") {
      activeBlockTypes.delete(ev.index);
      // 表示中の text は assistant 完全メッセージで Markdown 化されて
      // 上書きされるので、ここでは消さない。
      return;
    }
    return;
  }

  if (msg.type === "assistant") {
    hideThinking();
    const evt: IncomingEvent = {
      sessionId: typeof msg.session_id === "string" ? msg.session_id : "",
      type: "assistant",
      timestamp: Date.now(),
      raw: msg,
    };
    applyEvent(evt);
    return;
  }

  if (msg.type === "result") {
    hideThinking();
    return;
  }

  if (msg.type === "system" && msg.subtype === "init") {
    showStatusLine(`session ${String(msg.session_id ?? "").slice(0, 8)} 接続`);
    return;
  }

  if (msg.type === "system" && msg.subtype === "compact_boundary") {
    showStatusLine("コンテキストを圧縮しました");
    return;
  }

  // user/tool_result/tool_use などは既存 applyEvent に流す
  const evt: IncomingEvent = {
    sessionId: typeof msg.session_id === "string" ? msg.session_id : "",
    type: typeof msg.type === "string" ? msg.type : "unknown",
    timestamp: Date.now(),
    raw: msg,
  };
  applyEvent(evt);
}

function applyEvent(evt: IncomingEvent) {
  const uuid: string | undefined = evt.raw?.uuid;
  if (uuid) {
    if (renderedMessages.has(uuid)) {
      // Already rendered; only update tool results that may have arrived later.
      handleToolResults(evt);
      return;
    }
    renderedMessages.add(uuid);
  }

  const role: string | undefined = evt.raw?.message?.role;
  if (evt.type === "user" || role === "user") renderUserMessage(evt);
  else if (evt.type === "assistant" || role === "assistant")
    renderAssistantMessage(evt);

  handleToolResults(evt);
  scrollToBottomIfNeeded();
}

function renderUserMessage(evt: IncomingEvent) {
  const text = collectText(evt.raw?.message?.content) || asString(evt.raw?.message);
  if (!text) return;
  const block = document.createElement("section");
  block.className = "msg msg-user";
  block.appendChild(timestampEl(evt.timestamp, "User"));
  const body = document.createElement("div");
  body.className = "msg-body";
  body.innerHTML = renderMarkdown(text);
  block.appendChild(body);
  log.appendChild(block);
}

function renderAssistantMessage(evt: IncomingEvent) {
  const content = evt.raw?.message?.content;
  if (!Array.isArray(content)) return;

  const text = collectText(content);
  if (text) {
    const block = document.createElement("section");
    block.className = "msg msg-assistant";
    block.appendChild(timestampEl(evt.timestamp, "Assistant"));
    const body = document.createElement("div");
    body.className = "msg-body";
    body.innerHTML = renderMarkdown(text);
    block.appendChild(body);
    log.appendChild(block);
  }

  for (const part of content) {
    if (part?.type !== "tool_use" || typeof part?.id !== "string") continue;
    const card = renderToolUseCard(part);
    renderedToolUses.set(part.id, card);
    log.appendChild(card);
  }
}

function renderToolUseCard(part: any): HTMLElement {
  const card = document.createElement("section");
  card.className = "msg msg-tool";
  const head = document.createElement("div");
  head.className = "tool-head";
  head.textContent = `[tool] ${part.name ?? "tool"}`;
  card.appendChild(head);

  const inputBlock = document.createElement("pre");
  inputBlock.className = "tool-input";
  inputBlock.textContent = formatInput(part.input);
  card.appendChild(inputBlock);

  const out = document.createElement("pre");
  out.className = "tool-output pending";
  out.textContent = "(running…)";
  out.dataset.toolUseId = part.id;
  card.appendChild(out);

  return card;
}

function handleToolResults(evt: IncomingEvent) {
  const content = evt.raw?.message?.content;
  if (!Array.isArray(content)) return;
  for (const part of content) {
    if (part?.type !== "tool_result" || typeof part?.tool_use_id !== "string")
      continue;
    const card = renderedToolUses.get(part.tool_use_id);
    if (!card) continue;
    const out = card.querySelector(".tool-output") as HTMLElement | null;
    if (!out) continue;
    let output = "";
    if (typeof part.content === "string") output = part.content;
    else if (Array.isArray(part.content))
      output = part.content
        .map((p: any) => (typeof p?.text === "string" ? p.text : ""))
        .join("\n");
    out.textContent = output || "(no output)";
    out.classList.remove("pending");
    out.classList.toggle("error", !!part.is_error);
  }
}

function collectText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c: any) => c?.type === "text" && typeof c.text === "string")
    .map((c: any) => c.text as string)
    .join("\n")
    .trim();
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function formatInput(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

function timestampEl(ts: number, role: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "msg-meta";
  const date = new Date(ts);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  el.textContent = `${role} · ${hh}:${mm}:${ss}`;
  return el;
}

function renderMarkdown(text: string): string {
  const html = marked.parse(text, { async: false }) as string;
  // marked は HTML を素通しするため、DOMPurify で <script> やイベント
  // ハンドラ (onerror 等) を除去してから innerHTML に流す。
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}

function scrollToBottomIfNeeded() {
  if (userPinnedScroll) return;
  window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" as ScrollBehavior });
}
