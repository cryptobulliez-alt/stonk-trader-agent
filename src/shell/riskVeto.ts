/**
 * Portfolio-manager style risk veto (TradingAgents / Vibe-Trading live guards).
 * Approves or rejects proposed buys before prepare — mechanical, not LLM.
 */
import { isBuyCoolingDown } from "./cooldowns.js";
import { recentLossStreak } from "./tradeMemory.js";
import { getVenueForSymbol } from "../venueMap.js";

export type VetoHolding = {
  symbol: string;
  weightPct: number | null;
  unrealizedPnlWethPct?: number | null;
  unrealizedPnlPct?: number | null;
};

export type RiskVetoResult = {
  allowed: string[];
  vetoed: Array<{ symbol: string; reason: string }>;
};

const MAX_STOCK_NAMES = 4;
const UNDERWATER_SLEEVE_FRAC = 0.55;
const LOSS_STREAK_BLOCK = 3;

function stockHoldings(holdings: VetoHolding[]): VetoHolding[] {
  const skip = new Set(["WETH", "ETH", "USDG", "STONKBROKER"]);
  return holdings.filter((h) => !skip.has(h.symbol.toUpperCase()));
}

function upnl(h: VetoHolding): number | null {
  if (h.unrealizedPnlWethPct != null && Number.isFinite(h.unrealizedPnlWethPct)) {
    return h.unrealizedPnlWethPct;
  }
  if (h.unrealizedPnlPct != null && Number.isFinite(h.unrealizedPnlPct)) {
    return h.unrealizedPnlPct;
  }
  return null;
}

/**
 * Filter preferBuys through hard risk rails.
 * Risk exits / sells are never vetoed here.
 */
export function applyRiskVeto(args: {
  preferBuys: string[];
  holdings: VetoHolding[];
  cashPct: number | null;
  reserveWethPct: number;
  /** LLM confidence 1–5; below 3 needs strong deploy pressure. */
  confidence?: number | null;
}): RiskVetoResult {
  const held = stockHoldings(args.holdings);
  const heldSyms = new Set(held.map((h) => h.symbol.toUpperCase()));
  const openCount = held.length;
  const underwater = held.filter((h) => {
    const u = upnl(h);
    return u != null && u < -0.5;
  });
  const underwaterFrac = openCount > 0 ? underwater.length / openCount : 0;
  const cashExcess =
    args.cashPct != null ? args.cashPct - args.reserveWethPct : null;
  const lossStreak = recentLossStreak(5);
  const conf = args.confidence ?? null;

  const allowed: string[] = [];
  const vetoed: Array<{ symbol: string; reason: string }> = [];

  for (const raw of args.preferBuys) {
    const symbol = raw.toUpperCase();
    if (heldSyms.has(symbol)) {
      // Adds are gated elsewhere (addOnlyDip); allow through here.
      allowed.push(symbol);
      continue;
    }

    if (isBuyCoolingDown(symbol)) {
      vetoed.push({ symbol, reason: "buy_cooldown_after_sl" });
      continue;
    }

    if (openCount >= MAX_STOCK_NAMES) {
      vetoed.push({
        symbol,
        reason: `max_names_${MAX_STOCK_NAMES}_trim_first`,
      });
      continue;
    }

    if (lossStreak >= LOSS_STREAK_BLOCK && (cashExcess == null || cashExcess < 25)) {
      vetoed.push({
        symbol,
        reason: `loss_streak_${lossStreak}_cool_off`,
      });
      continue;
    }

    if (underwaterFrac >= UNDERWATER_SLEEVE_FRAC && openCount >= 2) {
      vetoed.push({
        symbol,
        reason: "sleeve_mostly_underwater_fix_first",
      });
      continue;
    }

    if (conf != null && conf < 3 && (cashExcess == null || cashExcess < 20)) {
      vetoed.push({
        symbol,
        reason: `low_confidence_${conf}`,
      });
      continue;
    }

    const venue = getVenueForSymbol(symbol);
    if (venue && !venue.tradeable) {
      vetoed.push({ symbol, reason: "venue_not_tradeable" });
      continue;
    }

    allowed.push(symbol);
  }

  return { allowed, vetoed };
}
