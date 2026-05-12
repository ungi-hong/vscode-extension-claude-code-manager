import { EventEmitter } from "events";
import * as vscode from "vscode";
import {
  AssistantUsage,
  ResultUsageSummary,
  extractAssistantUsage,
  extractUsageFromResult,
} from "./parser";
import { SessionEvent } from "./types";

const STORAGE_KEY = "ccmgr.usageCosts";
const RATE_LIMIT_STORAGE_KEY = "ccmgr.rateLimits";

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
/** メモリ節約のため、過去 24h より古い event は捨てる */
const EVENT_RETENTION_MS = 24 * 60 * 60 * 1000;

/** SDK rate_limit_event 用 (claude.ai サブスク向けの公式情報) */
export type RateLimitType =
  | "five_hour"
  | "seven_day"
  | "seven_day_opus"
  | "seven_day_sonnet"
  | "overage";

export interface RateLimitState {
  type: RateLimitType;
  status: "allowed" | "allowed_warning" | "rejected";
  utilization?: number;
  resetsAt?: number;
  surpassedThreshold?: number;
  isUsingOverage?: boolean;
  receivedAt: number;
}

/** 1 メッセージ単位の usage record (uuid で dedup) */
interface UsageEvent extends AssistantUsage {
  sessionId: string;
  timestamp: number;
}

export interface SessionUsage {
  sessionId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  totalTokens: number;
  /** SDK result 由来の context window (managed のみ確定) */
  contextWindow: number;
  remaining?: number;
  /** SDK result 由来の累計 cost (managed のみ確定) */
  totalCostUsd: number;
  models: string[];
  updatedAt: number;
}

/**
 * Claude Code の 5 時間 rolling block。
 *
 * ブロックの定義 (ccusage 互換):
 * - 直近の連続活動の塊 (>5h gap で分割、または block start から 5h 経過で分割)
 * - "active" = 現在も継続中 (最後の活動から 5h 未経過)
 */
export interface UsageBlock {
  startTime: number;
  endTime: number;
  /** 最後の event 時刻 */
  lastActivity: number;
  /** 現在もアクティブ?(now - lastActivity < 5h) */
  isActive: boolean;
  /** 経過時間 ms (active なら now - startTime / 非active なら lastActivity - startTime) */
  elapsedMs: number;
  /** 残り時間 ms (active のみ。endTime - now) */
  remainingMs?: number;
  eventCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  totalTokens: number;
  /** トークン/分 */
  burnRatePerMinute: number;
  /** モデル一覧 (出現順) */
  models: string[];
}

export interface UsageSummary {
  sessions: SessionUsage[];
  totalCostUsd: number;
  rateLimits: RateLimitState[];
  /** 現在進行中の 5h ブロック (無ければ undefined) */
  currentBlock?: UsageBlock;
  /** 直前の (active でない) ブロック。参考表示用 */
  previousBlock?: UsageBlock;
  /** 過去 24h の累計 (rolling) */
  last24h: TokenTotals;
  /** 全期間 (events 保持期間内) の累計 */
  allTime: TokenTotals;
}

export interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  totalTokens: number;
  eventCount: number;
}

export declare interface UsageStore {
  on(event: "changed", listener: () => void): this;
}

export class UsageStore extends EventEmitter {
  private map = new Map<string, SessionUsage>();
  private rateLimits = new Map<RateLimitType, RateLimitState>();
  /** uuid → UsageEvent。dedup と rolling window 計算に使う */
  private events = new Map<string, UsageEvent>();
  private pruneTimer?: NodeJS.Timeout;

  constructor(private readonly state: vscode.Memento) {
    super();
    const persisted = state.get<Record<string, number>>(STORAGE_KEY, {});
    for (const [sessionId, cost] of Object.entries(persisted)) {
      if (typeof cost !== "number" || !sessionId) continue;
      this.map.set(sessionId, {
        sessionId,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        totalTokens: 0,
        contextWindow: 0,
        totalCostUsd: cost,
        models: [],
        updatedAt: 0,
      });
    }
    const persistedLimits = state.get<RateLimitState[]>(
      RATE_LIMIT_STORAGE_KEY,
      [],
    );
    for (const r of persistedLimits) {
      if (!r || !r.type) continue;
      if (r.resetsAt && r.resetsAt < Date.now()) continue;
      this.rateLimits.set(r.type, r);
    }
    // 古い event を 5 分おきに掃除
    this.pruneTimer = setInterval(() => this.prune(), 5 * 60 * 1000);
  }

  dispose(sessionId?: string): void {
    if (sessionId) {
      if (!this.map.has(sessionId)) return;
      this.map.delete(sessionId);
      // events からも該当 session を消す
      for (const [uuid, e] of this.events) {
        if (e.sessionId === sessionId) this.events.delete(uuid);
      }
      void this.persistCosts();
      this.emit("changed");
      return;
    }
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.pruneTimer = undefined;
  }

  get(sessionId: string): SessionUsage | undefined {
    return this.map.get(sessionId);
  }

  list(): SessionUsage[] {
    return Array.from(this.map.values());
  }

  has(sessionId: string): boolean {
    return this.map.has(sessionId);
  }

  /**
   * SDK の `result` メッセージを取り込み、最新値で上書き保存。
   * pending-* は無視。
   */
  ingestResult(sessionId: string, raw: unknown): boolean {
    if (!sessionId || sessionId.startsWith("pending-")) return false;
    const summary = extractUsageFromResult(raw as { type?: unknown });
    if (!summary) return false;
    this.applySummary(sessionId, summary);
    return true;
  }

  /**
   * JSONL 由来の event を取り込む。assistant メッセージなら usage を抽出して
   * uuid で dedup しつつ events に蓄積する。
   *
   * これが ccusage と同等の **block 集計の主軸データ源**。
   * managed / external 両方で動く。
   */
  ingestJsonlEvent(evt: SessionEvent): boolean {
    const usage = extractAssistantUsage(evt.raw);
    if (!usage) return false;
    if (this.events.has(usage.uuid)) return false;
    this.events.set(usage.uuid, {
      ...usage,
      sessionId: evt.sessionId,
      timestamp: evt.timestamp,
    });
    this.emit("changed");
    return true;
  }

  /** SDK の rate_limit_event を取り込む (claude.ai サブスクのみ) */
  ingestRateLimit(raw: unknown): boolean {
    if (!raw || typeof raw !== "object") return false;
    const r = raw as Record<string, unknown>;
    if (r.type !== "rate_limit_event") return false;
    const info = r.rate_limit_info;
    if (!info || typeof info !== "object") return false;
    const i = info as Record<string, unknown>;
    const type = i.rateLimitType;
    if (typeof type !== "string") return false;
    const validTypes: RateLimitType[] = [
      "five_hour",
      "seven_day",
      "seven_day_opus",
      "seven_day_sonnet",
      "overage",
    ];
    if (!validTypes.includes(type as RateLimitType)) return false;
    const status = i.status;
    if (
      status !== "allowed" &&
      status !== "allowed_warning" &&
      status !== "rejected"
    ) {
      return false;
    }
    const state: RateLimitState = {
      type: type as RateLimitType,
      status,
      utilization:
        typeof i.utilization === "number" ? i.utilization : undefined,
      resetsAt: typeof i.resetsAt === "number" ? i.resetsAt : undefined,
      surpassedThreshold:
        typeof i.surpassedThreshold === "number"
          ? i.surpassedThreshold
          : undefined,
      isUsingOverage:
        typeof i.isUsingOverage === "boolean" ? i.isUsingOverage : undefined,
      receivedAt: Date.now(),
    };
    this.rateLimits.set(state.type, state);
    void this.persistRateLimits();
    this.emit("changed");
    return true;
  }

  rename(oldId: string, newId: string): void {
    if (oldId === newId) return;
    const existing = this.map.get(oldId);
    if (existing) {
      this.map.delete(oldId);
      this.map.set(newId, { ...existing, sessionId: newId });
    }
    // events 内の sessionId も rename
    for (const [uuid, e] of this.events) {
      if (e.sessionId === oldId) {
        this.events.set(uuid, { ...e, sessionId: newId });
      }
    }
    void this.persistCosts();
    this.emit("changed");
  }

  summary(): UsageSummary {
    const sessions = this.list();
    const totalCostUsd = sessions.reduce((acc, s) => acc + s.totalCostUsd, 0);
    const now = Date.now();
    const rateLimits = Array.from(this.rateLimits.values()).filter(
      (r) => !r.resetsAt || r.resetsAt > now,
    );

    const sortedEvents = Array.from(this.events.values()).sort(
      (a, b) => a.timestamp - b.timestamp,
    );
    const blocks = computeBlocks(sortedEvents);
    const lastBlock = blocks.length > 0 ? blocks[blocks.length - 1] : undefined;
    const currentBlock =
      lastBlock && lastBlock.isActive ? lastBlock : undefined;
    const previousBlock =
      lastBlock && !lastBlock.isActive
        ? lastBlock
        : blocks.length >= 2
          ? blocks[blocks.length - 2]
          : undefined;

    const last24h = sumEvents(
      sortedEvents.filter((e) => e.timestamp >= now - 24 * 60 * 60 * 1000),
    );
    const allTime = sumEvents(sortedEvents);

    return {
      sessions,
      totalCostUsd,
      rateLimits,
      currentBlock,
      previousBlock,
      last24h,
      allTime,
    };
  }

  listRateLimits(): RateLimitState[] {
    return Array.from(this.rateLimits.values());
  }

  private applySummary(sessionId: string, s: ResultUsageSummary): void {
    const totalTokens =
      s.inputTokens + s.cacheReadInputTokens + s.cacheCreationInputTokens;
    const remaining =
      s.contextWindow > 0
        ? Math.max(0, s.contextWindow - totalTokens)
        : undefined;
    this.map.set(sessionId, {
      sessionId,
      inputTokens: s.inputTokens,
      outputTokens: s.outputTokens,
      cacheReadInputTokens: s.cacheReadInputTokens,
      cacheCreationInputTokens: s.cacheCreationInputTokens,
      totalTokens,
      contextWindow: s.contextWindow,
      remaining,
      totalCostUsd: s.totalCostUsd,
      models: s.models,
      updatedAt: Date.now(),
    });
    void this.persistCosts();
    this.emit("changed");
  }

  private prune(): void {
    const cutoff = Date.now() - EVENT_RETENTION_MS;
    let pruned = 0;
    for (const [uuid, e] of this.events) {
      if (e.timestamp < cutoff) {
        this.events.delete(uuid);
        pruned += 1;
      }
    }
    if (pruned > 0) this.emit("changed");
  }

  private async persistCosts(): Promise<void> {
    const record: Record<string, number> = {};
    for (const [sid, u] of this.map) {
      if (u.totalCostUsd > 0) record[sid] = u.totalCostUsd;
    }
    await this.state.update(STORAGE_KEY, record);
  }

  private async persistRateLimits(): Promise<void> {
    await this.state.update(
      RATE_LIMIT_STORAGE_KEY,
      Array.from(this.rateLimits.values()),
    );
  }
}

// ---- ブロック検出 ----

const sumEvents = (events: UsageEvent[]): TokenTotals => {
  const totals: TokenTotals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    totalTokens: 0,
    eventCount: events.length,
  };
  for (const e of events) {
    totals.inputTokens += e.inputTokens;
    totals.outputTokens += e.outputTokens;
    totals.cacheReadInputTokens += e.cacheReadInputTokens;
    totals.cacheCreationInputTokens += e.cacheCreationInputTokens;
  }
  totals.totalTokens =
    totals.inputTokens +
    totals.outputTokens +
    totals.cacheReadInputTokens +
    totals.cacheCreationInputTokens;
  return totals;
};

/**
 * sortedEvents を 5h ブロックにグループ化する。
 * - block start から 5h 経過したら次ブロック
 * - >5h の活動 gap でも次ブロック
 */
const computeBlocks = (sortedEvents: UsageEvent[]): UsageBlock[] => {
  if (sortedEvents.length === 0) return [];
  const blocks: UsageBlock[] = [];
  let blockStart = sortedEvents[0].timestamp;
  let currentEvents: UsageEvent[] = [];
  let prevTs = sortedEvents[0].timestamp;

  const flush = (): void => {
    if (currentEvents.length === 0) return;
    blocks.push(buildBlock(blockStart, currentEvents));
  };

  for (const e of sortedEvents) {
    const overflow = e.timestamp - blockStart > FIVE_HOURS_MS;
    const gap = e.timestamp - prevTs > FIVE_HOURS_MS;
    if (currentEvents.length > 0 && (overflow || gap)) {
      flush();
      blockStart = e.timestamp;
      currentEvents = [];
    }
    currentEvents.push(e);
    prevTs = e.timestamp;
  }
  flush();
  return blocks;
};

const buildBlock = (
  startTime: number,
  events: UsageEvent[],
): UsageBlock => {
  const last = events[events.length - 1];
  const endTime = startTime + FIVE_HOURS_MS;
  const now = Date.now();
  const isActive = now - last.timestamp < FIVE_HOURS_MS && now < endTime;
  const elapsedMs = isActive
    ? Math.min(FIVE_HOURS_MS, now - startTime)
    : last.timestamp - startTime;
  const remainingMs = isActive ? Math.max(0, endTime - now) : undefined;

  const totals = sumEvents(events);
  const elapsedMin = elapsedMs / 60_000;
  const burnRatePerMinute = elapsedMin > 0 ? totals.totalTokens / elapsedMin : 0;

  // model 出現順 (重複除去)
  const seen = new Set<string>();
  const models: string[] = [];
  for (const e of events) {
    if (!seen.has(e.model)) {
      seen.add(e.model);
      models.push(e.model);
    }
  }

  return {
    startTime,
    endTime,
    lastActivity: last.timestamp,
    isActive,
    elapsedMs,
    remainingMs,
    eventCount: events.length,
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    cacheReadInputTokens: totals.cacheReadInputTokens,
    cacheCreationInputTokens: totals.cacheCreationInputTokens,
    totalTokens: totals.totalTokens,
    burnRatePerMinute,
    models,
  };
};
