import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type FillSide = "buy" | "sell";

export type LedgerFill = {
  ts: number;
  side: FillSide;
  symbol: string;
  qty: number;
  priceUsd: number;
  notionalUsd: number;
  /** WETH spent (buy) or received (sell) at fill ETH/USD. */
  notionalWeth?: number;
  /** Stock price in WETH at fill. */
  priceWeth?: number;
  ethUsd?: number;
  dryRun: boolean;
  seeded?: boolean;
  reason?: string;
};

export type PositionBasis = {
  symbol: string;
  qty: number;
  costUsd: number;
  avgCostUsd: number;
  /** Total WETH spent (buys) still attributed to remaining qty. */
  costWeth: number;
  /** Avg WETH paid per share — trading cost basis. */
  avgCostWeth: number;
  lastBuyPrice: number | null;
  lastSellPrice: number | null;
  realizedPnlUsd: number;
  realizedPnlWeth: number;
  seeded: boolean;
};

export type EnrichedHolding = {
  avgCostUsd: number | null;
  costBasisUsd: number | null;
  markUsd: number | null;
  unrealizedPnlUsd: number | null;
  /** USD P&L % — reporting only (ETH/USD noise included). */
  unrealizedPnlUsdPct: number | null;
  avgCostWeth: number | null;
  costBasisWeth: number | null;
  markWeth: number | null;
  unrealizedPnlWeth: number | null;
  /**
   * WETH-relative P&L % — primary trading numeraire (stock vs holding WETH).
   * Also exposed as unrealizedPnlPct for TP/SL consumers.
   */
  unrealizedPnlWethPct: number | null;
  /** Alias of unrealizedPnlWethPct (trading / stop engine). */
  unrealizedPnlPct: number | null;
  lastBuyPrice: number | null;
  lastSellPrice: number | null;
  realizedPnlUsd: number;
  realizedPnlWeth: number;
  seeded: boolean;
};

type LedgerFile = {
  tokenId: string;
  positions: Record<string, PositionBasis>;
  fills: LedgerFill[];
};

const MAX_FILLS = 500;
const CASH_SYMS = new Set(["WETH", "ETH", "USDG", "STONKBROKER"]);

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

function ledgerPath(): string {
  return join(dataDir(), "cost-basis.json");
}

function empty(tokenId = ""): LedgerFile {
  return { tokenId, positions: {}, fills: [] };
}

function loadRaw(): LedgerFile {
  const path = ledgerPath();
  if (!existsSync(path)) return empty();
  try {
    return JSON.parse(readFileSync(path, "utf8")) as LedgerFile;
  } catch {
    return empty();
  }
}

function saveRaw(file: LedgerFile) {
  writeFileSync(ledgerPath(), JSON.stringify(file, null, 2) + "\n");
}

function ensureToken(file: LedgerFile, tokenId: string): LedgerFile {
  if (file.tokenId && file.tokenId !== tokenId) {
    return empty(tokenId);
  }
  file.tokenId = tokenId;
  return file;
}

function round(n: number, d = 6): number {
  const p = 10 ** d;
  return Math.round(n * p) / p;
}

/** Normalize legacy positions that only have USD basis. */
function normalizePos(raw: Partial<PositionBasis> & { symbol: string }): PositionBasis {
  const qty = Number(raw.qty) || 0;
  const costUsd = Number(raw.costUsd) || 0;
  const avgCostUsd =
    Number(raw.avgCostUsd) || (qty > 0 && costUsd > 0 ? costUsd / qty : 0);
  let costWeth = Number(raw.costWeth) || 0;
  let avgCostWeth = Number(raw.avgCostWeth) || 0;
  if (!(costWeth > 0) && avgCostWeth > 0 && qty > 0) {
    costWeth = avgCostWeth * qty;
  }
  if (!(avgCostWeth > 0) && costWeth > 0 && qty > 0) {
    avgCostWeth = costWeth / qty;
  }
  return {
    symbol: raw.symbol.toUpperCase(),
    qty,
    costUsd,
    avgCostUsd,
    costWeth,
    avgCostWeth,
    lastBuyPrice: raw.lastBuyPrice ?? null,
    lastSellPrice: raw.lastSellPrice ?? null,
    realizedPnlUsd: Number(raw.realizedPnlUsd) || 0,
    realizedPnlWeth: Number(raw.realizedPnlWeth) || 0,
    seeded: Boolean(raw.seeded),
  };
}

function blankPos(symbol: string): PositionBasis {
  return normalizePos({ symbol });
}

export function getLedger(tokenId?: string): LedgerFile {
  const file = loadRaw();
  if (tokenId && file.tokenId && file.tokenId !== tokenId) {
    return empty(tokenId);
  }
  // Normalize legacy positions in memory (persist on next write)
  for (const [k, v] of Object.entries(file.positions)) {
    file.positions[k] = normalizePos({ ...v, symbol: k });
  }
  return file;
}

export function getPosition(tokenId: string, symbol: string): PositionBasis | null {
  const file = getLedger(tokenId);
  return file.positions[symbol.toUpperCase()] ?? null;
}

function wethFromUsd(
  usd: number,
  ethUsd: number | null | undefined,
): number | null {
  if (!(usd > 0) || ethUsd == null || !(ethUsd > 0)) return null;
  return usd / ethUsd;
}

/**
 * Record a buy/sell against cost basis.
 * Trading basis is WETH (stock vs idle WETH); USD kept for reporting.
 */
export function recordFill(args: {
  tokenId: string;
  side: FillSide;
  symbol: string;
  qty: number;
  priceUsd: number;
  notionalUsd?: number;
  /** Preferred: WETH notional of the swap. Else derived from ethUsd. */
  notionalWeth?: number;
  ethUsd?: number | null;
  dryRun?: boolean;
  seeded?: boolean;
  reason?: string;
}): PositionBasis | null {
  const symbol = args.symbol.toUpperCase();
  if (CASH_SYMS.has(symbol)) return null;
  if (!(args.qty > 0) || !(args.priceUsd > 0)) return null;

  const notional = args.notionalUsd ?? args.qty * args.priceUsd;
  const notionalWeth =
    args.notionalWeth != null && args.notionalWeth > 0
      ? args.notionalWeth
      : wethFromUsd(notional, args.ethUsd);
  const priceWeth =
    notionalWeth != null && args.qty > 0
      ? notionalWeth / args.qty
      : wethFromUsd(args.priceUsd, args.ethUsd);

  const file = ensureToken(loadRaw(), args.tokenId);
  for (const [k, v] of Object.entries(file.positions)) {
    file.positions[k] = normalizePos({ ...v, symbol: k });
  }
  const dryRun = Boolean(args.dryRun);

  // Dry-run fills are audit-only — never mutate cost basis.
  if (!dryRun) {
    const pos = file.positions[symbol] ?? blankPos(symbol);
    if (args.side === "buy") {
      pos.costUsd = round(pos.costUsd + notional, 4);
      if (notionalWeth != null) {
        pos.costWeth = round(pos.costWeth + notionalWeth, 8);
      }
      pos.qty = round(pos.qty + args.qty, 8);
      pos.avgCostUsd = pos.qty > 0 ? round(pos.costUsd / pos.qty, 6) : 0;
      pos.avgCostWeth = pos.qty > 0 ? round(pos.costWeth / pos.qty, 10) : 0;
      pos.lastBuyPrice = round(args.priceUsd, 6);
      if (args.seeded) pos.seeded = true;
      else pos.seeded = false;
    } else {
      const sellQty = Math.min(args.qty, pos.qty > 0 ? pos.qty : args.qty);
      const avgUsd = pos.avgCostUsd > 0 ? pos.avgCostUsd : args.priceUsd;
      const avgWeth =
        pos.avgCostWeth > 0
          ? pos.avgCostWeth
          : priceWeth != null && priceWeth > 0
            ? priceWeth
            : 0;
      pos.realizedPnlUsd = round(
        pos.realizedPnlUsd + (args.priceUsd - avgUsd) * sellQty,
        4,
      );
      if (priceWeth != null && avgWeth > 0) {
        pos.realizedPnlWeth = round(
          pos.realizedPnlWeth + (priceWeth - avgWeth) * sellQty,
          8,
        );
      }
      if (pos.qty > 0) {
        const remainFrac = Math.max(0, (pos.qty - sellQty) / pos.qty);
        pos.costUsd = round(pos.costUsd * remainFrac, 4);
        pos.costWeth = round(pos.costWeth * remainFrac, 8);
        pos.qty = round(pos.qty - sellQty, 8);
        pos.avgCostUsd = pos.qty > 0 ? round(pos.costUsd / pos.qty, 6) : 0;
        pos.avgCostWeth = pos.qty > 0 ? round(pos.costWeth / pos.qty, 10) : 0;
      }
      pos.lastSellPrice = round(args.priceUsd, 6);
    }
    file.positions[symbol] = pos;
  }

  file.fills.push({
    ts: Date.now(),
    side: args.side,
    symbol,
    qty: round(args.qty, 8),
    priceUsd: round(args.priceUsd, 6),
    notionalUsd: round(notional, 4),
    notionalWeth:
      notionalWeth != null ? round(notionalWeth, 8) : undefined,
    priceWeth: priceWeth != null ? round(priceWeth, 10) : undefined,
    ethUsd:
      args.ethUsd != null && args.ethUsd > 0
        ? round(args.ethUsd, 2)
        : undefined,
    dryRun,
    seeded: args.seeded,
    reason: args.reason,
  });
  if (file.fills.length > MAX_FILLS) {
    file.fills = file.fills.slice(-MAX_FILLS);
  }
  saveRaw(file);
  return file.positions[symbol] ?? null;
}

/**
 * Align ledger qty with on-chain holdings. Missing basis is seeded at mark
 * (flat P&L) so the UI and agent have something to work with.
 * Seeds / backfills WETH basis from USD ÷ ethUsd when needed.
 */
export function reconcileHoldings(
  tokenId: string,
  holdings: Array<{
    symbol: string;
    amount: number;
    priceUsd: number | null | undefined;
  }>,
  ethUsd?: number | null,
): void {
  const file = ensureToken(loadRaw(), tokenId);
  for (const [k, v] of Object.entries(file.positions)) {
    file.positions[k] = normalizePos({ ...v, symbol: k });
  }
  let dirty = false;

  for (const h of holdings) {
    const symbol = h.symbol.toUpperCase();
    if (CASH_SYMS.has(symbol)) continue;
    const amount = h.amount;
    const mark = h.priceUsd;
    if (!(amount > 0) || mark == null || !(mark > 0)) continue;

    const markWeth = wethFromUsd(mark, ethUsd);
    const pos = file.positions[symbol];
    if (!pos || pos.qty <= 0) {
      const notional = amount * mark;
      const notionalWeth =
        markWeth != null ? amount * markWeth : wethFromUsd(notional, ethUsd) ?? 0;
      file.positions[symbol] = {
        symbol,
        qty: round(amount, 8),
        costUsd: round(notional, 4),
        avgCostUsd: round(mark, 6),
        costWeth: round(notionalWeth, 8),
        avgCostWeth: amount > 0 ? round(notionalWeth / amount, 10) : 0,
        lastBuyPrice: round(mark, 6),
        lastSellPrice: null,
        realizedPnlUsd: 0,
        realizedPnlWeth: 0,
        seeded: true,
      };
      file.fills.push({
        ts: Date.now(),
        side: "buy",
        symbol,
        qty: round(amount, 8),
        priceUsd: round(mark, 6),
        notionalUsd: round(notional, 4),
        notionalWeth: round(notionalWeth, 8),
        priceWeth: markWeth != null ? round(markWeth, 10) : undefined,
        ethUsd: ethUsd != null && ethUsd > 0 ? round(ethUsd, 2) : undefined,
        dryRun: false,
        seeded: true,
        reason: "seeded at mark (unknown prior cost)",
      });
      dirty = true;
      continue;
    }

    // Backfill WETH basis for legacy USD-only positions (flat at current ETH)
    if (!(pos.costWeth > 0) && pos.costUsd > 0 && ethUsd != null && ethUsd > 0) {
      pos.costWeth = round(pos.costUsd / ethUsd, 8);
      pos.avgCostWeth =
        pos.qty > 0 ? round(pos.costWeth / pos.qty, 10) : 0;
      dirty = true;
    }

    // Tokens appeared outside the agent — seed the delta at mark
    if (amount > pos.qty * 1.02) {
      const delta = amount - pos.qty;
      const notional = delta * mark;
      const notionalWeth =
        markWeth != null ? delta * markWeth : wethFromUsd(notional, ethUsd) ?? 0;
      pos.costUsd = round(pos.costUsd + notional, 4);
      pos.costWeth = round(pos.costWeth + notionalWeth, 8);
      pos.qty = round(amount, 8);
      pos.avgCostUsd = round(pos.costUsd / pos.qty, 6);
      pos.avgCostWeth = round(pos.costWeth / pos.qty, 10);
      pos.lastBuyPrice = round(mark, 6);
      pos.seeded = true;
      file.fills.push({
        ts: Date.now(),
        side: "buy",
        symbol,
        qty: round(delta, 8),
        priceUsd: round(mark, 6),
        notionalUsd: round(notional, 4),
        notionalWeth: round(notionalWeth, 8),
        priceWeth: markWeth != null ? round(markWeth, 10) : undefined,
        ethUsd: ethUsd != null && ethUsd > 0 ? round(ethUsd, 2) : undefined,
        dryRun: false,
        seeded: true,
        reason: "reconcile +delta at mark",
      });
      dirty = true;
    } else if (amount < pos.qty * 0.98) {
      // Disposed outside agent — shrink basis, no realized P&L
      const frac = amount / pos.qty;
      pos.costUsd = round(pos.costUsd * frac, 4);
      pos.costWeth = round(pos.costWeth * frac, 8);
      pos.qty = round(amount, 8);
      pos.avgCostUsd = pos.qty > 0 ? round(pos.costUsd / pos.qty, 6) : 0;
      pos.avgCostWeth = pos.qty > 0 ? round(pos.costWeth / pos.qty, 10) : 0;
      dirty = true;
    }
  }

  if (dirty) {
    if (file.fills.length > MAX_FILLS) {
      file.fills = file.fills.slice(-MAX_FILLS);
    }
    saveRaw(file);
  }
}

export function enrichHolding(
  tokenId: string,
  h: {
    symbol: string;
    amount: number;
    usd: number | null | undefined;
    priceUsd: number | null | undefined;
  },
  ethUsd?: number | null,
): EnrichedHolding {
  const symbol = h.symbol.toUpperCase();
  const pos = getPosition(tokenId, symbol);
  const mark = h.priceUsd ?? null;
  const empty: EnrichedHolding = {
    avgCostUsd: null,
    costBasisUsd: null,
    markUsd: mark,
    unrealizedPnlUsd: null,
    unrealizedPnlUsdPct: null,
    avgCostWeth: null,
    costBasisWeth: null,
    markWeth: null,
    unrealizedPnlWeth: null,
    unrealizedPnlWethPct: null,
    unrealizedPnlPct: null,
    lastBuyPrice: pos?.lastBuyPrice ?? null,
    lastSellPrice: pos?.lastSellPrice ?? null,
    realizedPnlUsd: pos?.realizedPnlUsd ?? 0,
    realizedPnlWeth: pos?.realizedPnlWeth ?? 0,
    seeded: Boolean(pos?.seeded),
  };

  if (!pos || pos.qty <= 0) return empty;

  const marketUsd =
    h.usd != null && Number.isFinite(h.usd)
      ? h.usd
      : mark != null
        ? mark * h.amount
        : null;

  // USD reporting
  let costBasisUsd: number | null = null;
  let unrealizedPnlUsd: number | null = null;
  let unrealizedPnlUsdPct: number | null = null;
  if (pos.avgCostUsd > 0) {
    costBasisUsd = round(pos.avgCostUsd * h.amount, 4);
    unrealizedPnlUsd =
      marketUsd != null ? round(marketUsd - costBasisUsd, 4) : null;
    unrealizedPnlUsdPct =
      unrealizedPnlUsd != null && costBasisUsd > 0
        ? round((unrealizedPnlUsd / costBasisUsd) * 100, 2)
        : null;
  }

  // WETH trading numeraire
  let costWeth = pos.costWeth;
  let avgCostWeth = pos.avgCostWeth;
  if (!(costWeth > 0) && pos.costUsd > 0 && ethUsd != null && ethUsd > 0) {
    costWeth = pos.costUsd / ethUsd;
    avgCostWeth = h.amount > 0 ? costWeth / h.amount : 0;
  }

  const markWeth =
    mark != null && ethUsd != null && ethUsd > 0
      ? mark / ethUsd
      : marketUsd != null && ethUsd != null && ethUsd > 0 && h.amount > 0
        ? marketUsd / ethUsd / h.amount
        : null;

  let costBasisWeth: number | null = null;
  let unrealizedPnlWeth: number | null = null;
  let unrealizedPnlWethPct: number | null = null;
  if (avgCostWeth > 0 && h.amount > 0) {
    costBasisWeth = round(avgCostWeth * h.amount, 8);
    const marketWeth =
      markWeth != null
        ? markWeth * h.amount
        : marketUsd != null && ethUsd != null && ethUsd > 0
          ? marketUsd / ethUsd
          : null;
    if (marketWeth != null) {
      unrealizedPnlWeth = round(marketWeth - costBasisWeth, 8);
      unrealizedPnlWethPct = round(
        (unrealizedPnlWeth / costBasisWeth) * 100,
        2,
      );
    }
  }

  return {
    avgCostUsd: pos.avgCostUsd > 0 ? pos.avgCostUsd : null,
    costBasisUsd,
    markUsd: mark,
    unrealizedPnlUsd,
    unrealizedPnlUsdPct,
    avgCostWeth: avgCostWeth > 0 ? round(avgCostWeth, 10) : null,
    costBasisWeth,
    markWeth: markWeth != null ? round(markWeth, 10) : null,
    unrealizedPnlWeth,
    unrealizedPnlWethPct,
    // Trading alias — TP/SL / prefer trim use WETH-relative %
    unrealizedPnlPct: unrealizedPnlWethPct,
    lastBuyPrice: pos.lastBuyPrice,
    lastSellPrice: pos.lastSellPrice,
    realizedPnlUsd: pos.realizedPnlUsd,
    realizedPnlWeth: pos.realizedPnlWeth,
    seeded: pos.seeded,
  };
}

export function enrichHoldings<
  T extends {
    symbol: string;
    amount: number;
    usd: number | null | undefined;
    priceUsd: number | null | undefined;
  },
>(
  tokenId: string,
  holdings: T[],
  ethUsd?: number | null,
): Array<T & EnrichedHolding> {
  reconcileHoldings(tokenId, holdings, ethUsd);
  return holdings.map((h) => ({ ...h, ...enrichHolding(tokenId, h, ethUsd) }));
}

/** Map of symbol → WETH-relative unrealized P&L % (trading numeraire). */
export function pnlPctBySymbol(
  tokenId: string,
  holdings: Array<{
    symbol: string;
    amount: number;
    usd: number | null | undefined;
    priceUsd: number | null | undefined;
  }>,
  ethUsd?: number | null,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const h of enrichHoldings(tokenId, holdings, ethUsd)) {
    if (h.unrealizedPnlWethPct != null) {
      out[h.symbol.toUpperCase()] = h.unrealizedPnlWethPct;
    }
  }
  return out;
}

/**
 * Infer qty/price from a planned swap action and record it.
 * Buys: qty ≈ notionalUsd / mark of tokenOut; WETH cost = notionalUsd / ethUsd.
 * Sells: qty from amountIn; WETH proceeds ≈ notionalUsd / ethUsd.
 */
export function recordActionFill(args: {
  tokenId: string;
  action: {
    side?: string;
    tokenIn?: string;
    tokenOut?: string;
    amountIn?: string;
    notionalUsd?: number;
    reason?: string;
  };
  marks: Record<string, number | null | undefined>;
  dryRun: boolean;
  ethUsd?: number | null;
  /** Actual stock qty from Transfer logs (preferred over notional/mark estimate). */
  actualStockQty?: number | null;
}): PositionBasis | null {
  const side = args.action.side;
  if (side !== "buy" && side !== "sell") return null;
  const notional = args.action.notionalUsd;
  if (notional == null || !(notional > 0)) return null;
  const ethUsd = args.ethUsd ?? args.marks.WETH ?? args.marks.ETH ?? null;
  const notionalWeth = wethFromUsd(notional, ethUsd) ?? undefined;

  if (side === "buy") {
    const symbol = (args.action.tokenOut ?? "").toUpperCase();
    const mark = args.marks[symbol];
    if (!symbol || mark == null || !(mark > 0)) return null;
    const qty =
      args.actualStockQty != null && args.actualStockQty > 0
        ? args.actualStockQty
        : notional / mark;
    // Never book a "full" estimated fill when actual is known dust
    if (
      args.actualStockQty != null &&
      args.actualStockQty > 0 &&
      args.actualStockQty < (notional / mark) * 0.5
    ) {
      // still record truth — caller should have aborted; defensive
    }
    return recordFill({
      tokenId: args.tokenId,
      side: "buy",
      symbol,
      qty,
      priceUsd: mark,
      notionalUsd:
        args.actualStockQty != null && args.actualStockQty > 0
          ? args.actualStockQty * mark
          : notional,
      notionalWeth:
        args.actualStockQty != null &&
        args.actualStockQty > 0 &&
        ethUsd != null &&
        ethUsd > 0
          ? (args.actualStockQty * mark) / ethUsd
          : notionalWeth,
      ethUsd,
      dryRun: args.dryRun,
      reason: args.action.reason,
    });
  }

  const symbol = (args.action.tokenIn ?? "").toUpperCase();
  const qty =
    args.actualStockQty != null && args.actualStockQty > 0
      ? args.actualStockQty
      : Number(args.action.amountIn);
  if (!symbol || !(qty > 0)) return null;
  const priceUsd = notional / qty;
  return recordFill({
    tokenId: args.tokenId,
    side: "sell",
    symbol,
    qty,
    priceUsd,
    notionalUsd: notional,
    notionalWeth,
    ethUsd,
    dryRun: args.dryRun,
    reason: args.action.reason,
  });
}
