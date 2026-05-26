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
const btnStop = document.getElementById("btn-stop") as HTMLButtonElement;
const btnAttach = document.getElementById("btn-attach") as HTMLButtonElement;
const fileInput = document.getElementById("file-input") as HTMLInputElement;
const attachmentsEl = document.getElementById("attachments") as HTMLElement;
const modeBadge = document.getElementById("mode-badge") as HTMLElement;
const slashDropdown = document.getElementById("slash-dropdown") as HTMLElement;
const searchBar = document.getElementById("search-bar") as HTMLElement;
const searchInput = document.getElementById("search-input") as HTMLInputElement;
const searchCount = document.getElementById("search-count") as HTMLElement;
const searchPrev = document.getElementById("search-prev") as HTMLButtonElement;
const searchNext = document.getElementById("search-next") as HTMLButtonElement;
const searchClose = document.getElementById("search-close") as HTMLButtonElement;
const ctxWindowEl = document.getElementById("ctx-window") as HTMLElement | null;
const ctxWindowFill = document.getElementById("ctx-window-fill") as HTMLElement | null;
const ctxWindowPct = document.getElementById("ctx-window-pct") as HTMLElement | null;
const rcBanner = document.getElementById("rc-banner") as HTMLElement | null;
const rcToggle = document.getElementById("rc-toggle") as HTMLButtonElement | null;
const rcStatus = document.getElementById("rc-status") as HTMLElement | null;
const rcUrl = document.getElementById("rc-url") as HTMLAnchorElement | null;
const rcCopy = document.getElementById("rc-copy") as HTMLButtonElement | null;

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

// ===== 添付画像 (post 時に submit に含める) =====
interface PendingAttachment {
  id: string;
  name: string;
  mediaType: string;
  base64: string;
  dataUrl: string; // プレビュー表示用
}
const pendingAttachments: PendingAttachment[] = [];

// ===== Cmd+F 検索 =====
let searchMatches: HTMLElement[] = [];
let searchActiveIndex = -1;

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
  } else if (msg.type === "permission") {
    // AskUserQuestion がスキップされる事象の調査用。Help > Toggle Developer
    // Tools on the Webview で開く DevTools コンソールに出る。
    console.log("[ccmgr-webview] permission received", msg.request?.toolName, msg.request);
    renderPermissionRequest(msg.request);
  } else if (msg.type === "contextWindow") {
    applyContextWindow(msg.payload);
  } else if (msg.type === "remoteControl") {
    applyRemoteControl(msg.payload);
  }
});

/**
 * statusline JSON 由来のコンテキストウィンドウ残量をヘッダーバーに反映。
 *   - fill 幅 = remainingPercentage (残量を可視化)
 *   - 色レベルは used で判定 (used 多 = 赤)
 */
function applyContextWindow(payload: {
  usedPercentage: number;
  remainingPercentage: number;
}): void {
  if (!ctxWindowEl || !ctxWindowFill || !ctxWindowPct) return;
  if (
    !payload ||
    typeof payload.remainingPercentage !== "number" ||
    typeof payload.usedPercentage !== "number"
  ) {
    return;
  }
  const used = Math.max(0, Math.min(100, payload.usedPercentage));
  const remaining = Math.max(0, Math.min(100, payload.remainingPercentage));
  ctxWindowEl.hidden = false;
  ctxWindowFill.style.width = remaining + "%";
  ctxWindowPct.textContent = "残り " + remaining + "%";
  const level = used >= 80 ? "danger" : used >= 50 ? "warn" : "";
  ctxWindowFill.dataset.level = level;
}

btnSubmit.addEventListener("click", submitInput);
btnStop.addEventListener("click", interruptGeneration);

/**
 * Remote Control バナーを現在の status (off/starting/active) で再描画。
 * - off: 「📱 Remote」ボタンのみ
 * - starting: 「⏳ 起動中…」、ボタンは「Stop」に切り替え
 * - active: URL リンク + コピー、ボタンは「Stop」に切り替え
 */
function applyRemoteControl(payload: {
  status?: "off" | "starting" | "active";
  url?: string;
  name?: string;
}): void {
  if (!rcBanner || !rcToggle || !rcStatus || !rcUrl || !rcCopy) return;
  const status = payload?.status ?? "off";
  rcBanner.dataset.status = status;
  if (status === "off") {
    rcToggle.textContent = "📱 Remote";
    rcToggle.title =
      "このフォルダで携帯から続けられる Remote Control セッションを並走起動する (履歴は別)";
    rcStatus.hidden = true;
    rcUrl.hidden = true;
    rcCopy.hidden = true;
    rcUrl.removeAttribute("href");
    rcUrl.dataset.url = "";
    return;
  }
  rcToggle.textContent = "⛔ Stop";
  rcToggle.title = "Remote Control を停止";
  if (status === "starting") {
    rcStatus.hidden = false;
    rcStatus.textContent = "起動中…";
    rcUrl.hidden = true;
    rcCopy.hidden = true;
    return;
  }
  // active
  rcStatus.hidden = true;
  if (payload.url) {
    rcUrl.hidden = false;
    rcCopy.hidden = false;
    rcUrl.textContent = payload.name ? `${payload.name} ↗` : "Open ↗";
    rcUrl.dataset.url = payload.url;
    rcUrl.title = payload.url;
  } else {
    rcUrl.hidden = true;
    rcCopy.hidden = true;
  }
}

rcToggle?.addEventListener("click", () => {
  vscode.postMessage({ command: "toggleRemoteControl" });
});
rcUrl?.addEventListener("click", (ev) => {
  ev.preventDefault();
  const url = rcUrl?.dataset.url;
  if (!url) return;
  vscode.postMessage({ command: "openExternal", url });
});
rcCopy?.addEventListener("click", () => {
  const url = rcUrl?.dataset.url;
  if (!url) return;
  // CSP で navigator.clipboard が制限されているケースに備え、textarea fallback も用意。
  void navigator.clipboard?.writeText(url).catch(() => {
    const ta = document.createElement("textarea");
    ta.value = url;
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } finally {
      ta.remove();
    }
  });
});

function interruptGeneration() {
  vscode.postMessage({ command: "interrupt" });
}

function isGenerating(): boolean {
  return !btnStop.hidden;
}

// 生成中に Esc キーで中断 (slash dropdown が開いてる時はそちらが優先)
window.addEventListener("keydown", (ev) => {
  if (ev.key !== "Escape") return;
  if (slashState.active) return; // dropdown 閉じる方を優先 (inputText の handler 側で処理)
  if (!isGenerating()) return;
  ev.preventDefault();
  interruptGeneration();
});
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
  if (!text && pendingAttachments.length === 0) return;
  const attachments = pendingAttachments.map((a) => ({
    name: a.name,
    mediaType: a.mediaType,
    base64: a.base64,
  }));
  vscode.postMessage({ command: "submit", text, attachments });
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
  if (pendingAttachments.length > 0) {
    // 添付画像のサムネイルを user メッセージブロックに見せる (echo)
    const preview = document.createElement("div");
    preview.className = "msg-attachments";
    for (const a of pendingAttachments) {
      const img = document.createElement("img");
      img.src = a.dataUrl;
      img.title = a.name;
      preview.appendChild(img);
    }
    block.appendChild(preview);
    pendingAttachments.length = 0;
    renderAttachmentStrip();
  }
  showThinking();
  scrollToBottomIfNeeded();
}

// ===== 添付ハンドリング =====
btnAttach.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", async () => {
  const files = fileInput.files;
  if (!files) return;
  for (const f of Array.from(files)) {
    await addAttachment(f);
  }
  fileInput.value = ""; // 同一ファイル再選択を許可
  renderAttachmentStrip();
});

// ペースト & ドラッグ&ドロップ
inputText.addEventListener("paste", async (ev) => {
  if (!ev.clipboardData) return;
  const items = Array.from(ev.clipboardData.items).filter((it) =>
    it.type.startsWith("image/"),
  );
  if (items.length === 0) return;
  ev.preventDefault();
  for (const it of items) {
    const file = it.getAsFile();
    if (file) await addAttachment(file);
  }
  renderAttachmentStrip();
});
inputText.addEventListener("dragover", (ev) => ev.preventDefault());
inputText.addEventListener("drop", async (ev) => {
  if (!ev.dataTransfer) return;
  const files = Array.from(ev.dataTransfer.files).filter((f) =>
    f.type.startsWith("image/"),
  );
  if (files.length === 0) return;
  ev.preventDefault();
  for (const f of files) await addAttachment(f);
  renderAttachmentStrip();
});

async function addAttachment(file: File): Promise<void> {
  if (!file.type.startsWith("image/")) return;
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  const m = dataUrl.match(/^data:([^;]+);base64,(.*)$/);
  if (!m) return;
  pendingAttachments.push({
    id: Math.random().toString(36).slice(2),
    name: file.name || "image",
    mediaType: m[1],
    base64: m[2],
    dataUrl,
  });
}

function renderAttachmentStrip(): void {
  if (pendingAttachments.length === 0) {
    attachmentsEl.hidden = true;
    attachmentsEl.innerHTML = "";
    return;
  }
  attachmentsEl.hidden = false;
  attachmentsEl.innerHTML = "";
  for (const a of pendingAttachments) {
    const item = document.createElement("div");
    item.className = "attachment";
    item.innerHTML = `<img src="${a.dataUrl}" alt="${escapeHtml(a.name)}" /><button class="att-remove" title="削除">✕</button>`;
    const removeBtn = item.querySelector(".att-remove") as HTMLButtonElement;
    removeBtn.addEventListener("click", () => {
      const idx = pendingAttachments.findIndex((p) => p.id === a.id);
      if (idx >= 0) pendingAttachments.splice(idx, 1);
      renderAttachmentStrip();
    });
    attachmentsEl.appendChild(item);
  }
}

// ===== Cmd/Ctrl+F 検索 =====
window.addEventListener("keydown", (ev) => {
  if ((ev.metaKey || ev.ctrlKey) && ev.key === "f") {
    ev.preventDefault();
    openSearch();
    return;
  }
  if (ev.key === "Escape" && !searchBar.hidden) {
    ev.preventDefault();
    closeSearch();
  }
});

function openSearch(): void {
  searchBar.hidden = false;
  searchInput.focus();
  searchInput.select();
}
function closeSearch(): void {
  searchBar.hidden = true;
  searchInput.value = "";
  clearSearchHighlights();
}
searchClose.addEventListener("click", closeSearch);
searchInput.addEventListener("input", () => {
  applySearch(searchInput.value);
});
searchInput.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") {
    ev.preventDefault();
    if (ev.shiftKey) navigateSearch(-1);
    else navigateSearch(1);
  } else if (ev.key === "Escape") {
    ev.preventDefault();
    closeSearch();
  }
});
searchPrev.addEventListener("click", () => navigateSearch(-1));
searchNext.addEventListener("click", () => navigateSearch(1));

function applySearch(q: string): void {
  clearSearchHighlights();
  if (!q) {
    updateSearchCount();
    return;
  }
  const lower = q.toLowerCase();
  const root = log;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const t = node as Text;
    if (!t.nodeValue) continue;
    const el = t.parentElement;
    if (!el) continue;
    if (el.closest("mark.search-match")) continue;
    if (el.closest("script, style")) continue;
    textNodes.push(t);
  }
  for (const tn of textNodes) {
    const text = tn.nodeValue ?? "";
    const lc = text.toLowerCase();
    if (!lc.includes(lower)) continue;
    const parent = tn.parentNode;
    if (!parent) continue;
    const frag = document.createDocumentFragment();
    let cursor = 0;
    let idx = lc.indexOf(lower, 0);
    while (idx >= 0) {
      if (idx > cursor) {
        frag.appendChild(document.createTextNode(text.slice(cursor, idx)));
      }
      const mark = document.createElement("mark");
      mark.className = "search-match";
      mark.textContent = text.slice(idx, idx + q.length);
      frag.appendChild(mark);
      searchMatches.push(mark);
      cursor = idx + q.length;
      idx = lc.indexOf(lower, cursor);
    }
    if (cursor < text.length) {
      frag.appendChild(document.createTextNode(text.slice(cursor)));
    }
    parent.replaceChild(frag, tn);
  }
  if (searchMatches.length > 0) setActiveMatch(0, true);
  updateSearchCount();
}

function clearSearchHighlights(): void {
  for (const m of Array.from(document.querySelectorAll("mark.search-match"))) {
    const parent = m.parentNode;
    if (!parent) continue;
    while (m.firstChild) parent.insertBefore(m.firstChild, m);
    parent.removeChild(m);
    if ("normalize" in parent) (parent as Element).normalize();
  }
  searchMatches = [];
  searchActiveIndex = -1;
}

function navigateSearch(delta: number): void {
  if (searchMatches.length === 0) return;
  const next =
    (searchActiveIndex + delta + searchMatches.length) % searchMatches.length;
  setActiveMatch(next, true);
}

function setActiveMatch(i: number, scroll: boolean): void {
  for (const m of searchMatches) m.classList.remove("active");
  searchActiveIndex = i;
  const active = searchMatches[i];
  if (!active) return;
  active.classList.add("active");
  if (scroll) active.scrollIntoView({ block: "center", behavior: "smooth" });
  updateSearchCount();
}

function updateSearchCount(): void {
  if (searchMatches.length === 0) {
    searchCount.textContent = "0 / 0";
  } else {
    searchCount.textContent = `${searchActiveIndex + 1} / ${searchMatches.length}`;
  }
}

let pendingAssistantBlock: HTMLElement | null = null;
let pendingAssistantBody: HTMLElement | null = null;
// SDK の stream_event は複数の content_block (text / tool_use / ...) を index 付きで
// 順次送ってくる。delta が text 以外の block (tool_use の input_json_delta 等) に
// 紛れ込んで assistant 表示領域に流れないよう、block index → 状態で管理する。
const activeBlockTypes = new Map<number, string>();
const activeBlockTexts = new Map<number, string>();

function showThinking() {
  // Send → Stop の入れ替え (重複呼び出し時もボタン状態は常に正しくする)
  btnSubmit.hidden = true;
  btnStop.hidden = false;
  if (pendingAssistantBlock) return;
  const block = document.createElement("section");
  block.className = "msg msg-assistant pending";
  block.appendChild(timestampEl(Date.now(), "Assistant"));
  const body = document.createElement("div");
  body.className = "msg-body thinking";
  body.innerHTML = '<span class="dots"><span></span><span></span><span></span></span> 考えています… <span class="thinking-hint">(Esc / Stop で中断)</span>';
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
  // Stop → Send に戻す
  btnSubmit.hidden = false;
  btnStop.hidden = true;
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
  const name: string = part.name ?? "tool";
  const card = document.createElement("section");
  card.className = "msg msg-tool collapsed";

  // クリックで折り畳み開閉する header 行
  const head = document.createElement("button");
  head.type = "button";
  head.className = "tool-head";
  head.innerHTML = `
    <span class="tool-chevron">▶</span>
    <span class="tool-name">${escapeHtml(name)}</span>
    <span class="tool-summary">${escapeHtml(summarizeToolInput(name, part.input))}</span>
    <span class="tool-status" data-status="pending">⏳</span>
  `;
  head.addEventListener("click", () => {
    card.classList.toggle("collapsed");
  });
  card.appendChild(head);

  // 詳細 (collapsed 中は CSS で非表示)
  const details = document.createElement("div");
  details.className = "tool-details";

  const inputBlock = document.createElement("pre");
  inputBlock.className = "tool-input";
  inputBlock.textContent = formatInput(part.input);
  details.appendChild(inputBlock);

  const out = document.createElement("pre");
  out.className = "tool-output pending";
  out.textContent = "(running…)";
  out.dataset.toolUseId = part.id;
  details.appendChild(out);

  card.appendChild(details);
  return card;
}

/**
 * tool input を 1 行サマリに圧縮。tool 名ごとに「人間が見て一番分かりやすい
 * 1 フィールド」を選んで表示する。
 */
function summarizeToolInput(name: string, input: unknown): string {
  if (input == null || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  const pick = (k: string): string =>
    typeof obj[k] === "string" ? (obj[k] as string) : "";
  switch (name) {
    case "Bash": {
      const desc = pick("description");
      if (desc) return desc;
      const cmd = pick("command");
      return cmd ? truncateOneLine(cmd, 120) : "";
    }
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return pick("file_path") || pick("notebook_path");
    case "Read": {
      const fp = pick("file_path") || pick("notebook_path");
      const off = obj["offset"];
      const lim = obj["limit"];
      const suffix = off || lim ? ` (${off ? `+${off}` : ""}${lim ? `/${lim}` : ""})` : "";
      return fp + suffix;
    }
    case "Grep": {
      const p = pick("pattern");
      const where = pick("path") || pick("glob");
      return p ? `"${truncateOneLine(p, 60)}"${where ? ` in ${where}` : ""}` : "";
    }
    case "Glob":
      return pick("pattern");
    case "WebFetch":
    case "WebSearch":
      return pick("url") || pick("query");
    case "Task":
      return pick("description") || truncateOneLine(pick("prompt"), 100);
    case "TodoWrite":
      return "update todos";
    default: {
      // 既知でない tool: 最初の string フィールドを表示
      for (const v of Object.values(obj)) {
        if (typeof v === "string" && v) return truncateOneLine(v, 100);
      }
      return "";
    }
  }
}

function truncateOneLine(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return oneLine.slice(0, max - 1) + "…";
}

// ===== ツール承認カード (canUseTool 経由の permission request) =====

interface PermissionRequest {
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  toolUseID: string;
  title?: string;
  description?: string;
  displayName?: string;
  decisionReason?: string;
  blockedPath?: string;
}

function renderPermissionRequest(req: PermissionRequest): void {
  // AskUserQuestion は専用 UI (選択肢を矢印キー or クリックで選んで Enter 送信)。
  // SDK が CLI で出している「複数選択質問」UX を webview で再現する。
  if (req.toolName === "AskUserQuestion") {
    if (renderAskUserQuestion(req)) return;
    // input が不正な形ならフォールバック (下の generic UI に流す)
  }

  const isPlan = req.toolName === "ExitPlanMode";
  const card = document.createElement("section");
  card.className = isPlan
    ? "msg msg-permission permission-plan"
    : "msg msg-permission";
  card.dataset.requestId = req.requestId;

  // ヘッダ: アイコン + タイトル + tool 名
  const header = document.createElement("div");
  header.className = "perm-header";
  const icon = isPlan ? "📋" : "🔐";
  const title =
    req.title || (isPlan ? "プランを確認してください" : "ツール実行の承認");
  header.innerHTML = `<span class="perm-icon">${icon}</span><span class="perm-title">${escapeHtml(title)}</span><span class="perm-tool">${escapeHtml(req.toolName)}</span>`;
  card.appendChild(header);

  // 詳細: plan なら plan 内容を markdown 表示。それ以外は input サマリ + 詳細
  const body = document.createElement("div");
  body.className = "perm-body";

  if (isPlan && typeof req.input.plan === "string") {
    body.innerHTML = renderMarkdown(req.input.plan as string);
  } else {
    const summary = summarizeToolInput(req.toolName, req.input);
    if (summary) {
      const s = document.createElement("div");
      s.className = "perm-summary";
      s.textContent = summary;
      body.appendChild(s);
    }
    if (req.description) {
      const d = document.createElement("div");
      d.className = "perm-description";
      d.textContent = req.description;
      body.appendChild(d);
    }
    if (req.decisionReason) {
      const r = document.createElement("div");
      r.className = "perm-reason";
      r.textContent = req.decisionReason;
      body.appendChild(r);
    }
    // 全 input を折り畳みで見られるように
    const det = document.createElement("details");
    det.className = "perm-details";
    const sum = document.createElement("summary");
    sum.textContent = "詳細を表示";
    det.appendChild(sum);
    const pre = document.createElement("pre");
    pre.textContent = formatInput(req.input);
    det.appendChild(pre);
    body.appendChild(det);
  }
  card.appendChild(body);

  // ボタン: Allow / Deny
  const actions = document.createElement("div");
  actions.className = "perm-actions";
  const allowBtn = document.createElement("button");
  allowBtn.className = "perm-btn perm-allow";
  allowBtn.textContent = isPlan ? "✓ プランを承認して実行" : "✓ 許可";
  const denyBtn = document.createElement("button");
  denyBtn.className = "perm-btn perm-deny";
  denyBtn.textContent = isPlan ? "✗ プランを却下" : "✗ 拒否";

  const lock = () => {
    allowBtn.disabled = true;
    denyBtn.disabled = true;
    card.classList.add("perm-resolved");
  };
  allowBtn.addEventListener("click", () => {
    lock();
    card.dataset.decision = "allow";
    vscode.postMessage({
      command: "permissionResponse",
      requestId: req.requestId,
      decision: "allow",
    });
  });
  denyBtn.addEventListener("click", () => {
    lock();
    card.dataset.decision = "deny";
    vscode.postMessage({
      command: "permissionResponse",
      requestId: req.requestId,
      decision: "deny",
      message: "ユーザーが拒否しました",
    });
  });
  actions.appendChild(allowBtn);
  actions.appendChild(denyBtn);
  card.appendChild(actions);

  log.appendChild(card);
  scrollToBottomIfNeeded();
}

// ===== AskUserQuestion: 複数選択肢付きの質問 UI =====

interface AskQuestion {
  question: string;
  header: string;
  options: Array<{ label: string; description?: string; preview?: string }>;
  multiSelect: boolean;
}

interface AskUserQuestionInput {
  questions: AskQuestion[];
}

/**
 * SDK 組み込みツール `AskUserQuestion` 用の専用 UI。
 *
 * - 各質問について `options[]` を radio (single) or checkbox (multi) で並べる
 * - 末尾に "Other (自由記述)" を自動追加 (SDK 仕様)
 * - ↑↓ でオプション間移動、Tab で次質問、Enter で送信、Esc でキャンセル
 * - 送信時は `{ behavior: "allow", updatedInput: { ...input, answers, annotations } }`
 *   を返すことで SDK にユーザー回答を伝える。
 *
 * @returns 描画に成功した場合 true (false なら generic UI でフォールバック描画)。
 */
function renderAskUserQuestion(req: PermissionRequest): boolean {
  const input = req.input as unknown as AskUserQuestionInput;
  if (
    !input ||
    !Array.isArray(input.questions) ||
    input.questions.length === 0
  ) {
    return false;
  }
  // 各質問のフォーマット最低限を検証
  for (const q of input.questions) {
    if (
      !q ||
      typeof q.question !== "string" ||
      !Array.isArray(q.options) ||
      q.options.length === 0
    ) {
      return false;
    }
  }

  const card = document.createElement("section");
  card.className = "msg msg-permission permission-ask";
  card.dataset.requestId = req.requestId;
  card.tabIndex = -1;

  // ヘッダ
  const header = document.createElement("div");
  header.className = "perm-header";
  header.innerHTML = `<span class="perm-icon">❓</span><span class="perm-title">${escapeHtml(req.title || "回答を選んでください")}</span><span class="perm-tool">AskUserQuestion</span>`;
  card.appendChild(header);

  // 各質問の現在の選択 state
  // single の場合: answers[question] = chosenLabel | "__other__:<idx>"
  // multi の場合 : answers[question] = "label1,label2,..." or "__other__:<idx>,label1,..."
  const answers: Record<string, string> = {};
  const otherTexts: Record<string, string> = {};

  // Continue ボタンの先行宣言 (各 setSelected から参照するため)
  const continueBtn = document.createElement("button");

  const updateContinueState = () => {
    const allAnswered = input.questions.every((q) => {
      const a = answers[q.question];
      if (!a) return false;
      // multi では複数の値を含むので "__other__" を部分含む場合も判定
      const includesOther = a.split(",").some((v) => v.startsWith("__other__"));
      if (includesOther) {
        const txt = otherTexts[q.question];
        if (!txt || !txt.trim()) return false;
      }
      return true;
    });
    continueBtn.disabled = !allAnswered;
  };

  for (const q of input.questions) {
    const qEl = document.createElement("div");
    qEl.className = "perm-question";
    qEl.dataset.question = q.question;

    const qHead = document.createElement("div");
    qHead.className = "perm-question-header";
    qHead.innerHTML = `<span class="perm-chip">${escapeHtml(q.header || "")}</span><span class="perm-q-text">${escapeHtml(q.question)}</span>`;
    if (q.multiSelect) {
      const tag = document.createElement("span");
      tag.className = "perm-multi-tag";
      tag.textContent = "複数選択可";
      qHead.appendChild(tag);
    }
    qEl.appendChild(qHead);

    const optsWrap = document.createElement("div");
    optsWrap.className = "perm-options";
    optsWrap.setAttribute("role", q.multiSelect ? "group" : "radiogroup");

    const inputType = q.multiSelect ? "checkbox" : "radio";

    // 通常オプション + 末尾に "Other (自由記述)" を自動追加
    const opts: Array<{
      label: string;
      description?: string;
      preview?: string;
      isOther: boolean;
    }> = [
      ...q.options.map((o) => ({
        label: o.label,
        description: o.description,
        preview: o.preview,
        isOther: false,
      })),
      {
        label: "Other (自由記述)",
        description: "上記以外を自分で書く",
        isOther: true,
      },
    ];

    opts.forEach((o, idx) => {
      const optEl = document.createElement("label");
      optEl.className = "perm-option";
      optEl.tabIndex = 0;
      optEl.dataset.optionIndex = String(idx);

      const inp = document.createElement("input");
      inp.type = inputType;
      inp.name = `q-${req.requestId}-${input.questions.indexOf(q)}`;
      inp.value = o.isOther ? `__other__:${idx}` : o.label;
      optEl.appendChild(inp);

      const main = document.createElement("div");
      main.className = "perm-option-main";

      const labelText = document.createElement("div");
      labelText.className = "perm-option-label";
      labelText.textContent = o.label;
      main.appendChild(labelText);

      if (o.description) {
        const desc = document.createElement("div");
        desc.className = "perm-option-desc";
        desc.textContent = o.description;
        main.appendChild(desc);
      }
      optEl.appendChild(main);

      let otherInput: HTMLTextAreaElement | undefined;
      if (o.isOther) {
        otherInput = document.createElement("textarea");
        otherInput.className = "perm-other-input";
        otherInput.placeholder = "自由記述…";
        otherInput.hidden = true;
        otherInput.rows = 2;
        otherInput.addEventListener("input", () => {
          otherTexts[q.question] = otherInput!.value;
          updateContinueState();
        });
        optEl.appendChild(otherInput);
      }

      const setSelected = () => {
        if (!q.multiSelect) {
          // 兄弟をクリア
          for (const sib of optsWrap.querySelectorAll(".perm-option")) {
            sib.classList.remove("selected");
            const t = sib.querySelector(
              ".perm-other-input",
            ) as HTMLTextAreaElement | null;
            if (t && t !== otherInput) t.hidden = true;
          }
          optEl.classList.add("selected");
          answers[q.question] = inp.value;
          if (otherInput) {
            otherInput.hidden = false;
            otherInput.focus();
          }
        } else {
          optEl.classList.toggle("selected", inp.checked);
          const selected = Array.from(
            optsWrap.querySelectorAll<HTMLInputElement>("input:checked"),
          )
            .map((i) => i.value)
            .join(",");
          answers[q.question] = selected;
          if (otherInput) otherInput.hidden = !inp.checked;
        }
        updateContinueState();
      };

      inp.addEventListener("change", setSelected);
      // label/desc 領域クリックでも選択するように (input 直接クリックとの二重発火を避ける)
      optEl.addEventListener("click", (ev) => {
        if (ev.target === inp) return;
        // textarea 内クリックは選択トグルしない
        if ((ev.target as HTMLElement).closest(".perm-other-input")) return;
        if (!q.multiSelect) inp.checked = true;
        else inp.checked = !inp.checked;
        setSelected();
      });

      optsWrap.appendChild(optEl);
    });

    qEl.appendChild(optsWrap);
    card.appendChild(qEl);
  }

  // Action: Continue / Cancel
  const actions = document.createElement("div");
  actions.className = "perm-actions";
  continueBtn.className = "perm-btn perm-allow";
  continueBtn.textContent = "✓ 回答を送信 (Enter)";
  continueBtn.disabled = true;
  const cancelBtn = document.createElement("button");
  cancelBtn.className = "perm-btn perm-deny";
  cancelBtn.textContent = "✗ キャンセル (Esc)";

  const lock = () => {
    continueBtn.disabled = true;
    cancelBtn.disabled = true;
    card.classList.add("perm-resolved");
    for (const i of card.querySelectorAll<HTMLInputElement>(
      "input, textarea",
    )) {
      i.disabled = true;
    }
  };

  continueBtn.addEventListener("click", () => {
    if (continueBtn.disabled) return;
    // "__other__:idx" を実際の自由記述テキストに展開
    const finalAnswers: Record<string, string> = {};
    const annotations: Record<string, { notes?: string }> = {};
    for (const q of input.questions) {
      const a = answers[q.question] || "";
      const parts = a.split(",").filter((v) => v.length > 0);
      const expanded = parts.map((p) => {
        if (p.startsWith("__other__")) {
          const txt = otherTexts[q.question]?.trim() || "(empty)";
          annotations[q.question] = { notes: otherTexts[q.question] };
          return txt;
        }
        return p;
      });
      finalAnswers[q.question] = expanded.join(", ");
    }
    lock();
    card.dataset.decision = "allow";
    vscode.postMessage({
      command: "permissionResponse",
      requestId: req.requestId,
      decision: "allow",
      updatedInput: {
        ...input,
        answers: finalAnswers,
        annotations,
      },
    });
  });

  cancelBtn.addEventListener("click", () => {
    lock();
    card.dataset.decision = "deny";
    vscode.postMessage({
      command: "permissionResponse",
      requestId: req.requestId,
      decision: "deny",
      message: "ユーザーが質問への回答をキャンセルしました",
    });
  });

  actions.appendChild(continueBtn);
  actions.appendChild(cancelBtn);
  card.appendChild(actions);

  log.appendChild(card);
  scrollToBottomIfNeeded();

  installAskKeyboardNav(card, continueBtn, cancelBtn);

  // 最初のオプションにフォーカス (矢印キーで即操作可能に)
  const firstOpt = card.querySelector<HTMLElement>(".perm-option");
  firstOpt?.focus();

  return true;
}

/**
 * AskUserQuestion カード内のキーボード操作。
 * - ↑↓: 同一質問内オプションの focus 移動 (radio なら focus=select)
 * - Enter: Continue (回答を送信)
 * - Esc: Cancel
 * - Tab/Shift+Tab はブラウザの自然な挙動に任せる (質問間移動)
 */
function installAskKeyboardNav(
  card: HTMLElement,
  continueBtn: HTMLButtonElement,
  cancelBtn: HTMLButtonElement,
): void {
  card.addEventListener("keydown", (ev) => {
    if (card.classList.contains("perm-resolved")) return;

    // textarea 内では矢印 / Enter は通常の編集として扱う
    const target = ev.target as HTMLElement;
    const inTextarea = target.tagName === "TEXTAREA";
    if (inTextarea && ev.key !== "Escape") return;

    if (ev.key === "Enter" && !continueBtn.disabled) {
      ev.preventDefault();
      continueBtn.click();
      return;
    }
    if (ev.key === "Escape") {
      ev.preventDefault();
      cancelBtn.click();
      return;
    }
    if (ev.key !== "ArrowUp" && ev.key !== "ArrowDown") return;

    const optEl = target.closest(".perm-option") as HTMLElement | null;
    if (!optEl) return;
    const group = optEl.parentElement;
    if (!group) return;
    const sibs = Array.from(
      group.querySelectorAll<HTMLElement>(".perm-option"),
    );
    const idx = sibs.indexOf(optEl);
    if (idx < 0) return;
    const next =
      ev.key === "ArrowDown"
        ? sibs[Math.min(idx + 1, sibs.length - 1)]
        : sibs[Math.max(idx - 1, 0)];
    if (!next || next === optEl) return;
    ev.preventDefault();
    next.focus();
    // ラジオなら focus = select (CLI 同等の挙動)
    const inp = next.querySelector<HTMLInputElement>('input[type="radio"]');
    if (inp) {
      inp.checked = true;
      inp.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
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
    // header の status アイコンも更新 (⏳ → ✓ / ✗)
    const status = card.querySelector(".tool-status") as HTMLElement | null;
    if (status) {
      if (part.is_error) {
        status.dataset.status = "error";
        status.textContent = "✗";
      } else {
        status.dataset.status = "ok";
        status.textContent = "✓";
      }
    }
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
