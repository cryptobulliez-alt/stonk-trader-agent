/**
 * Cheap always-on watcher: RPC mark shocks + public RSS headlines.
 * Wakes autopilot early (asymmetric risk vs opportunity) — never bypasses fee/core rails.
 */
import { makePublicClient } from "../brokerReads.js";
import { loadConfig, STOCK_TOKENS, TOKEN_DECIMALS } from "../config.js";
import { getEthUsd, priceTokenUsd } from "../prices.js";
import { emitEvent } from "./events.js";
import { getLedger } from "./ledger.js";
import { loadSettings } from "./settings.js";

export type SignalTriggerKind = "risk" | "opportunity";

export type SignalTrigger = {
  kind: SignalTriggerKind;
  symbols: string[];
  reasons: string[];
  source: "mark" | "rss" | "mixed";
};

export type SignalWatchStatus = {
  enabled: boolean;
  running: boolean;
  lastTickAt: number | null;
  lastWakeAt: number | null;
  lastSignals: Array<{
    ts: number;
    kind: SignalTriggerKind;
    symbol: string;
    reason: string;
    source: string;
  }>;
};

type MarkSample = { ts: number; markWeth: number };
type WakeFn = (trigger: SignalTrigger) => void;

const CASH_SYMS = new Set(["WETH", "ETH", "USDG", "STONKBROKER"]);
const LOOKBACK_MS = 5 * 60_000;
const MAX_RSS_SYMBOLS = 12;
const MAX_MARK_SYMBOLS = 12;
const NEWS_DEBOUNCE_MS = 10 * 60_000;
const MAX_STATUS_SIGNALS = 12;

const BULL =
  /\b(bullish|breakout|upgrade|beat(s|ing)?|surge(d|s)?|rally|soar(ed|s)?|record high|all[- ]time high|strong buy|raises? guidance|acquisition|buyback)\b/i;
const BEAR =
  /\b(bearish|breakdown|downgrade|miss(es|ed)?|dump(ed|s)?|plunge(d|s)?|crash(ed|es)?|lawsuit|fraud|investigation|cut guidance|recall|bankrupt|sec charges|probe|halt(ed)?)\b/i;

let timer: ReturnType<typeof setTimeout> | null = null;
let tickInFlight = false;
let watchRunning = false;
let wakeFn: WakeFn | null = null;

let lastTickAt: number | null = null;
let lastWakeAt: number | null = null;
const lastSignals: SignalWatchStatus["lastSignals"] = [];

/** In-memory WETH mark ring per symbol. */
const markRing = new Map<string, MarkSample[]>();
/** guid/url → ts last seen */
const seenHeadlines = new Map<string, number>();
/** symbol → last news-wake ts (debounce) */
const newsDebounce = new Map<string, number>();

/** Snapshot from last autopilot pass (cash room + held). */
let bookSnap: {
  cashPct: number | null;
  held: string[];
  ts: number;
} = { cashPct: null, held: [], ts: 0 };

export function updateSignalBookSnapshot(args: {
  cashPct: number | null | undefined;
  heldSymbols: string[];
}): void {
  bookSnap = {
    cashPct: args.cashPct ?? null,
    held: args.heldSymbols.map((s) => s.toUpperCase()).filter(Boolean),
    ts: Date.now(),
  };
}

export function getSignalWatchStatus(): SignalWatchStatus {
  const s = loadSettings();
  return {
    enabled: s.signalWatchEnabled,
    running: watchRunning,
    lastTickAt,
    lastWakeAt,
    lastSignals: lastSignals.slice(-MAX_STATUS_SIGNALS).reverse(),
  };
}

export function startSignalWatch(onWake: WakeFn): void {
  wakeFn = onWake;
  watchRunning = true;
  if (timer) clearTimeout(timer);
  timer = null;
  const settings = loadSettings();
  emitEvent(
    "agent.signal",
    settings.signalWatchEnabled
      ? `Signal watch on · every ${Math.round(settings.signalWatchMs / 1000)}s (marks+RSS)`
      : "Signal watch idle (disabled in settings — enable + keep autopilot running)",
  );
  scheduleTick(0);
}

export function stopSignalWatch(): void {
  watchRunning = false;
  wakeFn = null;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  emitEvent("agent.signal", "Signal watch stopped");
}

function scheduleTick(delayMs: number): void {
  if (timer) clearTimeout(timer);
  if (!watchRunning) return;
  timer = setTimeout(() => {
    void (async () => {
      try {
        await runTick();
      } finally {
        if (watchRunning) {
          const s = loadSettings();
          scheduleTick(
            s.signalWatchEnabled ? s.signalWatchMs : Math.max(s.signalWatchMs, 60_000),
          );
        }
      }
    })();
  }, Math.max(0, delayMs));
}

function noteSignal(
  kind: SignalTriggerKind,
  symbol: string,
  reason: string,
  source: string,
): void {
  lastSignals.push({ ts: Date.now(), kind, symbol, reason, source });
  if (lastSignals.length > 40) lastSignals.splice(0, lastSignals.length - 40);
}

function heldSymbols(): string[] {
  if (bookSnap.held.length && Date.now() - bookSnap.ts < 30 * 60_000) {
    return bookSnap.held;
  }
  // Fallback: ledger positions with qty
  try {
    const ledger = getLedger();
    return Object.values(ledger.positions)
      .filter((p) => p.qty > 0 && !CASH_SYMS.has(p.symbol.toUpperCase()))
      .map((p) => p.symbol.toUpperCase());
  } catch {
    return [];
  }
}

function watchUniverse(allowlist: string[], held: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of [...held, ...allowlist]) {
    const u = s.toUpperCase();
    if (CASH_SYMS.has(u) || seen.has(u)) continue;
    seen.add(u);
    out.push(u);
    if (out.length >= MAX_MARK_SYMBOLS) break;
  }
  return out;
}

function pushMark(symbol: string, markWeth: number): void {
  const now = Date.now();
  const arr = markRing.get(symbol) ?? [];
  arr.push({ ts: now, markWeth });
  const cut = now - LOOKBACK_MS * 2;
  const trimmed = arr.filter((s) => s.ts >= cut);
  markRing.set(symbol, trimmed.slice(-40));
}

function markShockBps(
  symbol: string,
  nowWeth: number,
  lookbackMs: number,
): number | null {
  const arr = markRing.get(symbol);
  if (!arr?.length || !(nowWeth > 0)) return null;
  const oldest = arr.find((s) => Date.now() - s.ts >= lookbackMs * 0.5) ?? arr[0];
  if (!(oldest.markWeth > 0)) return null;
  if (Date.now() - oldest.ts < 20_000) return null; // need some history
  return Math.round(((nowWeth - oldest.markWeth) / oldest.markWeth) * 10_000);
}

async function probeMarks(args: {
  symbols: string[];
  shockBps: number;
  held: Set<string>;
  cashPct: number | null;
  reserveWethPct: number;
}): Promise<SignalTrigger[]> {
  const triggers: SignalTrigger[] = [];
  let client;
  try {
    const config = loadConfig();
    client = makePublicClient(config.rpcUrl);
  } catch (e) {
    emitEvent(
      "agent.warn",
      `Mark signals skipped: ${e instanceof Error ? e.message : String(e)}`,
    );
    return triggers;
  }

  let ethUsd: number | null = null;
  try {
    ethUsd = await getEthUsd(client);
  } catch {
    ethUsd = null;
  }

  const cashRoom =
    args.cashPct != null && args.cashPct >= args.reserveWethPct + 5;

  for (const sym of args.symbols) {
    const addr = STOCK_TOKENS[sym];
    if (!addr) continue;
    const decimals = TOKEN_DECIMALS[sym] ?? 18;
    try {
      const px = await priceTokenUsd(client, addr, sym, decimals, ethUsd);
      if (px.eth == null || !(px.eth > 0)) continue;
      pushMark(sym, px.eth);
      const move = markShockBps(sym, px.eth, LOOKBACK_MS);
      if (move == null) continue;
      if (Math.abs(move) < args.shockBps) continue;

      if (move <= -args.shockBps && args.held.has(sym)) {
        const reason = `mark shock ${sym} ${move}bps vs ~5m (held)`;
        noteSignal("risk", sym, reason, "mark");
        triggers.push({
          kind: "risk",
          symbols: [sym],
          reasons: [reason],
          source: "mark",
        });
      } else if (move >= args.shockBps && !args.held.has(sym) && cashRoom) {
        const reason = `mark surge ${sym} +${move}bps vs ~5m (unheld · cash room)`;
        noteSignal("opportunity", sym, reason, "mark");
        triggers.push({
          kind: "opportunity",
          symbols: [sym],
          reasons: [reason],
          source: "mark",
        });
      }
    } catch {
      // soft-skip single symbol
    }
  }
  return triggers;
}

function scoreHeadline(text: string): "bullish" | "bearish" | "neutral" {
  const bull = BULL.test(text) ? 1 : 0;
  const bear = BEAR.test(text) ? 1 : 0;
  if (bear > bull) return "bearish";
  if (bull > bear) return "bullish";
  return "neutral";
}

function parseRssItems(xml: string): Array<{ id: string; title: string }> {
  const items: Array<{ id: string; title: string }> = [];
  const chunks = xml.split(/<item[\s>]|<entry[\s>]/i).slice(1);
  for (const chunk of chunks.slice(0, 8)) {
    const titleMatch = chunk.match(
      /<title[^>]*>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))<\/title>/i,
    );
    const title = (titleMatch?.[1] ?? titleMatch?.[2] ?? "")
      .replace(/<[^>]+>/g, "")
      .trim();
    const link =
      chunk.match(/<link[^>]*href="([^"]+)"/i)?.[1] ??
      chunk.match(/<link[^>]*>([^<]+)<\/link>/i)?.[1] ??
      chunk.match(/<guid[^>]*>([^<]+)<\/guid>/i)?.[1] ??
      title;
    if (!title) continue;
    items.push({ id: (link || title).trim(), title });
  }
  return items;
}

async function fetchFeed(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "stonk-trader-signal-watch/1.0 (local; research only)",
        Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
      },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

function feedUrls(symbol: string): string[] {
  const q = encodeURIComponent(`${symbol} stock`);
  return [
    `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`,
    `https://finance.yahoo.com/rss/headline?s=${encodeURIComponent(symbol)}`,
    `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${encodeURIComponent(symbol)}&type=&dateb=&owner=include&count=8&output=atom`,
  ];
}

async function probeRss(args: {
  symbols: string[];
  held: Set<string>;
  cashPct: number | null;
  reserveWethPct: number;
}): Promise<SignalTrigger[]> {
  const triggers: SignalTrigger[] = [];
  const cashRoom =
    args.cashPct != null && args.cashPct >= args.reserveWethPct + 5;
  const now = Date.now();

  // Prune old headline ids
  for (const [id, ts] of seenHeadlines) {
    if (now - ts > 24 * 60_000 * 60) seenHeadlines.delete(id);
  }

  const syms = args.symbols.slice(0, MAX_RSS_SYMBOLS);
  for (const sym of syms) {
    const lastNews = newsDebounce.get(sym) ?? 0;
    if (now - lastNews < NEWS_DEBOUNCE_MS) continue;

    let fired = false;
    for (const url of feedUrls(sym)) {
      if (fired) break;
      const xml = await fetchFeed(url);
      if (!xml) continue;
      const items = parseRssItems(xml);
      for (const item of items) {
        const key = `${sym}|${item.id}`;
        if (seenHeadlines.has(key)) continue;
        seenHeadlines.set(key, now);
        const lean = scoreHeadline(item.title);
        if (lean === "neutral") continue;

        if (lean === "bearish" && args.held.has(sym)) {
          const reason = `RSS bearish ${sym}: ${item.title.slice(0, 120)}`;
          noteSignal("risk", sym, reason, "rss");
          triggers.push({
            kind: "risk",
            symbols: [sym],
            reasons: [reason],
            source: "rss",
          });
          newsDebounce.set(sym, now);
          fired = true;
          break;
        }
        if (lean === "bullish" && !args.held.has(sym) && cashRoom) {
          const reason = `RSS bullish ${sym}: ${item.title.slice(0, 120)}`;
          noteSignal("opportunity", sym, reason, "rss");
          triggers.push({
            kind: "opportunity",
            symbols: [sym],
            reasons: [reason],
            source: "rss",
          });
          newsDebounce.set(sym, now);
          fired = true;
          break;
        }
      }
    }
  }
  return triggers;
}

function mergeTriggers(list: SignalTrigger[]): SignalTrigger | null {
  if (!list.length) return null;
  const risk = list.filter((t) => t.kind === "risk");
  const opp = list.filter((t) => t.kind === "opportunity");
  // Risk wins: asymmetric policy — don't open buys on a risk wake
  if (risk.length) {
    const symbols = [...new Set(risk.flatMap((t) => t.symbols))];
    const reasons = risk.flatMap((t) => t.reasons);
    const sources = new Set(risk.map((t) => t.source));
    return {
      kind: "risk",
      symbols,
      reasons,
      source: sources.size > 1 ? "mixed" : risk[0].source,
    };
  }
  const symbols = [...new Set(opp.flatMap((t) => t.symbols))].slice(0, 2);
  const reasons = opp.flatMap((t) => t.reasons);
  const sources = new Set(opp.map((t) => t.source));
  return {
    kind: "opportunity",
    symbols,
    reasons,
    source: sources.size > 1 ? "mixed" : opp[0].source,
  };
}

async function runTick(): Promise<void> {
  if (tickInFlight || !watchRunning) return;
  tickInFlight = true;
  lastTickAt = Date.now();
  try {
    const settings = loadSettings();
    if (!settings.signalWatchEnabled) return;
    if (!settings.useMarkSignals && !settings.useRssSignals) return;

    const held = heldSymbols();
    const heldSet = new Set(held);
    const universe = watchUniverse(settings.allowlist, held);
    if (!universe.length) return;

    const found: SignalTrigger[] = [];

    if (settings.useMarkSignals) {
      const markHits = await probeMarks({
        symbols: universe,
        shockBps: settings.markShockBps,
        held: heldSet,
        cashPct: bookSnap.cashPct,
        reserveWethPct: settings.reserveWethPct,
      });
      found.push(...markHits);
    }

    if (settings.useRssSignals) {
      // Prefer held for RSS first
      const rssOrder = watchUniverse(settings.allowlist, held);
      try {
        const rssHits = await probeRss({
          symbols: rssOrder,
          held: heldSet,
          cashPct: bookSnap.cashPct,
          reserveWethPct: settings.reserveWethPct,
        });
        found.push(...rssHits);
      } catch (e) {
        emitEvent(
          "agent.warn",
          `RSS signals soft-fail: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    const merged = mergeTriggers(found);
    if (!merged) return;

    const gap = settings.minWakeGapMs;
    if (lastWakeAt != null && Date.now() - lastWakeAt < gap) {
      emitEvent(
        "agent.signal",
        `Wake suppressed (cooldown ${Math.round((gap - (Date.now() - lastWakeAt)) / 1000)}s) · ${merged.kind} ${merged.symbols.join(",")}`,
        { trigger: merged },
      );
      return;
    }

    lastWakeAt = Date.now();
    emitEvent(
      "agent.wake",
      `Signal wake · ${merged.kind} · ${merged.symbols.join(",")} · ${merged.reasons[0] ?? merged.source}`,
      { trigger: merged },
    );
    wakeFn?.(merged);
  } finally {
    tickInFlight = false;
  }
}
