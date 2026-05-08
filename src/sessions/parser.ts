import { truncate } from "../utils/text";
import { RawJsonlLine, SessionEvent } from "./types";

/**
 * `RawJsonlLine` と SDK の `SDKAssistantMessage` / `SDKUserMessage` は
 * いずれも `{ message: { content } }` 構造を共有するため、抽出ロジックは
 * この構造的部分型で受ける。
 */
type MessageLike = { message?: { content?: unknown; stop_reason?: unknown } };

/**
 * Buffer for incremental JSONL parsing. Keeps incomplete trailing lines
 * across `feed()` calls so partial writes never produce parse errors.
 */
export class JsonlBuffer {
  private buf = "";

  feed(chunk: string): RawJsonlLine[] {
    this.buf += chunk;
    const lines = this.buf.split("\n");
    this.buf = lines.pop() ?? "";
    const parsed: RawJsonlLine[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        parsed.push(JSON.parse(trimmed));
      } catch {
        // Drop malformed line. JSONL writers can produce them when interleaving;
        // skipping is safer than aborting the stream.
      }
    }
    return parsed;
  }
}

export const toSessionEvent = (
  raw: RawJsonlLine,
  filePath: string,
  fallbackSessionId: string,
): SessionEvent | undefined => {
  const sessionId =
    typeof raw.sessionId === "string" ? raw.sessionId : fallbackSessionId;
  if (!sessionId) return undefined;
  const cwd = typeof raw.cwd === "string" ? raw.cwd : "";
  const gitBranch =
    typeof raw.gitBranch === "string" ? raw.gitBranch : undefined;
  const type = typeof raw.type === "string" ? raw.type : "unknown";
  const timestamp = parseTimestamp(raw.timestamp);
  return {
    sessionId,
    cwd,
    gitBranch,
    type,
    raw,
    timestamp,
    filePath,
  };
};

const parseTimestamp = (value: unknown): number => {
  if (typeof value === "string") {
    const t = Date.parse(value);
    if (!Number.isNaN(t)) return t;
  }
  if (typeof value === "number") return value;
  return Date.now();
};

/**
 * Extract the inner content array from an assistant or user message.
 */
export const extractMessageContent = (raw: MessageLike): any[] => {
  const message = raw?.message;
  if (!message) return [];
  const content = message.content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (Array.isArray(content)) return content;
  return [];
};

export const extractAssistantText = (raw: MessageLike): string => {
  return extractMessageContent(raw)
    .filter((c) => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("\n")
    .trim();
};

export const extractUserText = (raw: MessageLike): string => {
  const parts = extractMessageContent(raw);
  const out: string[] = [];
  for (const c of parts) {
    if (c?.type === "text" && typeof c.text === "string") out.push(c.text);
    else if (typeof c === "string") out.push(c);
  }
  return out.join("\n").trim();
};

export const extractStopReason = (raw: MessageLike): string | undefined => {
  const reason = raw?.message?.stop_reason;
  return typeof reason === "string" ? reason : undefined;
};

/**
 * 拡張内チャットの "直近メッセージ" プレビュー用に長さ制限付きで抽出。
 */
export const extractAssistantSummary = (
  raw: MessageLike,
  max = 280,
): string => truncate(extractAssistantText(raw), max);

export const extractUserSummary = (
  raw: MessageLike,
  max = 280,
): string => truncate(extractUserText(raw), max);

export const extractToolUses = (
  raw: RawJsonlLine,
): { id: string; name: string; input: any }[] => {
  return extractMessageContent(raw)
    .filter(
      (c) => c?.type === "tool_use" && typeof c?.id === "string",
    )
    .map((c) => ({
      id: c.id as string,
      name: typeof c.name === "string" ? c.name : "tool",
      input: c.input,
    }));
};

export const extractToolResults = (
  raw: RawJsonlLine,
): { tool_use_id: string; output: string; isError: boolean }[] => {
  return extractMessageContent(raw)
    .filter(
      (c) => c?.type === "tool_result" && typeof c?.tool_use_id === "string",
    )
    .map((c) => {
      let output = "";
      if (typeof c.content === "string") {
        output = c.content;
      } else if (Array.isArray(c.content)) {
        output = c.content
          .map((p: any) =>
            typeof p?.text === "string" ? p.text : "",
          )
          .join("\n");
      }
      return {
        tool_use_id: c.tool_use_id as string,
        output,
        isError: !!c.is_error,
      };
    });
};
