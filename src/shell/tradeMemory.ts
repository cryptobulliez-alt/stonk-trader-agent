/**
 * TradingAgents-style decision memory: record fill outcomes + short reflections
 * so the next LLM pass can learn what worked / what didn't.
 * @see https://github.com/TauricResearch/TradingAgents
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type MemoryEntry = {
  ts: number;
  side: "buy" | "sell";
  symbol: string;
  notionalUsd: number;
  /** Realized % on this sell vs avg cost; null for buys. */
  realizedPnlPct: number | null;
  reason: string;
  /** One-line lesson for future passes. */
  reflection: string;
};

type MemoryFile = { entries: MemoryEntry[] };

const MAX_ENTRIES = 80;

function dataDir(): string {
  const candidates = [
    join(process.cwd(), "data"),
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "data"),
  ];
  for (const d of candidates) {
    if (existsSync(d)) return d;
  }
  const d = join(process.cwd(), "data");
  mkdirSync(d, { recursive: true });
  return d;
}

function path(): string {
  return join(dataDir(), "trade-memory.json");
}

function load(): MemoryFile {
  try {
    if (!existsSync(path())) return { entries: [] };
    const raw = JSON.parse(readFileSync(path(), "utf8")) as MemoryFile;
    return { entries: Array.isArray(raw.entries) ? raw.entries : [] };
  } catch {
    return { entries: [] };
  }
}

function save(file: MemoryFile) {
  const entries = file.entries.slice(-MAX_ENTRIES);
  writeFileSync(path(), JSON.stringify({ entries }, null, 2) + "\n");
}

function reflect(args: {
  side: "buy" | "sell";
  symbol: string;
  realizedPnlPct: number | null;
  reason: string;
}): string {
  const r = args.reason.slice(0, 120);
  if (args.side === "sell" && args.realizedPnlPct != null) {
    if (args.realizedPnlPct <= -4) {
      return `${args.symbol}: realized ${args.realizedPnlPct.toFixed(1)}% — cut loser; avoid re-entry until thesis resets (${r})`;
    }
    if (args.realizedPnlPct >= 3) {
      return `${args.symbol}: banked +${args.realizedPnlPct.toFixed(1)}% — let winners run / trim into strength worked (${r})`;
    }
    return `${args.symbol}: flat/small ${args.realizedPnlPct >= 0 ? "+" : ""}${args.realizedPnlPct.toFixed(1)}% exit — fees matter at this size (${r})`;
  }
  if (args.side === "buy") {
    return `${args.symbol}: opened — size for stop; prefer liquid core over thin ETFs (${r})`;
  }
  return `${args.symbol}: ${args.side} logged (${r})`;
}

export function recordTradeMemory(args: {
  side: "buy" | "sell";
  symbol: string;
  notionalUsd: number;
  realizedPnlPct?: number | null;
  reason?: string;
}): MemoryEntry {
  const entry: MemoryEntry = {
    ts: Date.now(),
    side: args.side,
    symbol: args.symbol.toUpperCase(),
    notionalUsd: args.notionalUsd,
    realizedPnlPct: args.realizedPnlPct ?? null,
    reason: (args.reason ?? "").slice(0, 200),
    reflection: reflect({
      side: args.side,
      symbol: args.symbol.toUpperCase(),
      realizedPnlPct: args.realizedPnlPct ?? null,
      reason: args.reason ?? "",
    }),
  };
  const file = load();
  file.entries.push(entry);
  save(file);
  return entry;
}

/** Recent lessons for LLM / risk veto (newest first). */
export function recentTradeLessons(limit = 8): string[] {
  return load()
    .entries.slice()
    .reverse()
    .slice(0, limit)
    .map((e) => e.reflection);
}

export function recentLossStreak(limit = 5): number {
  const sells = load()
    .entries.slice()
    .reverse()
    .filter((e) => e.side === "sell" && e.realizedPnlPct != null)
    .slice(0, limit);
  let streak = 0;
  for (const e of sells) {
    if ((e.realizedPnlPct ?? 0) < 0) streak++;
    else break;
  }
  return streak;
}

export function formatMemoryForLlm(limit = 6): string | undefined {
  const lessons = recentTradeLessons(limit);
  if (!lessons.length) return undefined;
  return lessons.map((l, i) => `${i + 1}. ${l}`).join("\n");
}
