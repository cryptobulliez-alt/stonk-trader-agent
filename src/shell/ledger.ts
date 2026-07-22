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
  dryRun: boolean;
  seeded?: boolean;
  reason?: string;
};

export type PositionBasis = {
  symbol: string;
  qty: number;
  costUsd: number;
  avgCostUsd: number;
  lastBuyPrice: number | null;
  lastSellPrice: number | null;
  realizedPnlUsd: number;
  seeded: boolean;
};

export type EnrichedHolding = {
  avgCostUsd: number | null;
  costBasisUsd: number | null;
  markUsd: number | null;
  unrealizedPnlUsd: number | null;
  unrealizedPnlPct: number | null;
  lastBuyPrice: number | null;
  lastSellPrice: number | null;
  realizedPnlUsd: number;
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

function blankPos(symbol: string): PositionBasis {
  return {
    symbol,
    qty: 0,
    costUsd: 0,
    avgCostUsd: 0,
    lastBuyPrice: null,
    lastSellPrice: null,
    realizedPnlUsd: 0,
    seeded: false,
  };
}

export function getLedger(tokenId?: string): LedgerFile {
  const file = loadRaw();
  if (tokenId && file.tokenId && file.tokenId !== tokenId) {
    return empty(tokenId);
  }
  return file;
}

export function getPosition(tokenId: string, symbol: string): PositionBasis | null {
  const file = getLedger(tokenId);
  return file.positions[symbol.toUpperCase()] ?? null;
}

/**
 * Record a buy/sell against cost basis. Buys raise avg cost; sells realize P&L
 * against avg cost and reduce remaining basis proportionally.
 */
export function recordFill(args: {
  tokenId: string;
  side: FillSide;
  symbol: string;
  qty: number;
  priceUsd: number;
  notionalUsd?: number;
  dryRun?: boolean;
  seeded?: boolean;
  reason?: string;
}): PositionBasis | null {
  const symbol = args.symbol.toUpperCase();
  if (CASH_SYMS.has(symbol)) return null;
  if (!(args.qty > 0) || !(args.priceUsd > 0)) return null;

  const notional = args.notionalUsd ?? args.qty * args.priceUsd;
  const file = ensureToken(loadRaw(), args.tokenId);
  const dryRun = Boolean(args.dryRun);

  // Dry-run fills are audit-only — never mutate cost basis.
  if (!dryRun) {
    const pos = file.positions[symbol] ?? blankPos(symbol);
    if (args.side === "buy") {
      pos.costUsd = round(pos.costUsd + notional, 4);
      pos.qty = round(pos.qty + args.qty, 8);
      pos.avgCostUsd = pos.qty > 0 ? round(pos.costUsd / pos.qty, 6) : 0;
      pos.lastBuyPrice = round(args.priceUsd, 6);
      if (args.seeded) pos.seeded = true;
      else pos.seeded = false;
    } else {
      const sellQty = Math.min(args.qty, pos.qty > 0 ? pos.qty : args.qty);
      const avg = pos.avgCostUsd > 0 ? pos.avgCostUsd : args.priceUsd;
      const realized = (args.priceUsd - avg) * sellQty;
      pos.realizedPnlUsd = round(pos.realizedPnlUsd + realized, 4);
      if (pos.qty > 0) {
        const remainFrac = Math.max(0, (pos.qty - sellQty) / pos.qty);
        pos.costUsd = round(pos.costUsd * remainFrac, 4);
        pos.qty = round(pos.qty - sellQty, 8);
        pos.avgCostUsd = pos.qty > 0 ? round(pos.costUsd / pos.qty, 6) : 0;
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
 */
export function reconcileHoldings(
  tokenId: string,
  holdings: Array<{
    symbol: string;
    amount: number;
    priceUsd: number | null | undefined;
  }>,
): void {
  const file = ensureToken(loadRaw(), tokenId);
  let dirty = false;

  for (const h of holdings) {
    const symbol = h.symbol.toUpperCase();
    if (CASH_SYMS.has(symbol)) continue;
    const amount = h.amount;
    const mark = h.priceUsd;
    if (!(amount > 0) || mark == null || !(mark > 0)) continue;

    const pos = file.positions[symbol];
    if (!pos || pos.qty <= 0) {
      const notional = amount * mark;
      file.positions[symbol] = {
        symbol,
        qty: round(amount, 8),
        costUsd: round(notional, 4),
        avgCostUsd: round(mark, 6),
        lastBuyPrice: round(mark, 6),
        lastSellPrice: null,
        realizedPnlUsd: 0,
        seeded: true,
      };
      file.fills.push({
        ts: Date.now(),
        side: "buy",
        symbol,
        qty: round(amount, 8),
        priceUsd: round(mark, 6),
        notionalUsd: round(notional, 4),
        dryRun: false,
        seeded: true,
        reason: "seeded at mark (unknown prior cost)",
      });
      dirty = true;
      continue;
    }

    // Tokens appeared outside the agent — seed the delta at mark
    if (amount > pos.qty * 1.02) {
      const delta = amount - pos.qty;
      const notional = delta * mark;
      pos.costUsd = round(pos.costUsd + notional, 4);
      pos.qty = round(amount, 8);
      pos.avgCostUsd = round(pos.costUsd / pos.qty, 6);
      pos.lastBuyPrice = round(mark, 6);
      pos.seeded = true;
      file.fills.push({
        ts: Date.now(),
        side: "buy",
        symbol,
        qty: round(delta, 8),
        priceUsd: round(mark, 6),
        notionalUsd: round(notional, 4),
        dryRun: false,
        seeded: true,
        reason: "reconcile +delta at mark",
      });
      dirty = true;
    } else if (amount < pos.qty * 0.98) {
      // Disposed outside agent — shrink basis, no realized P&L
      const frac = amount / pos.qty;
      pos.costUsd = round(pos.costUsd * frac, 4);
      pos.qty = round(amount, 8);
      pos.avgCostUsd = pos.qty > 0 ? round(pos.costUsd / pos.qty, 6) : 0;
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
): EnrichedHolding {
  const symbol = h.symbol.toUpperCase();
  const pos = getPosition(tokenId, symbol);
  const mark = h.priceUsd ?? null;
  if (!pos || pos.qty <= 0 || !(pos.avgCostUsd > 0)) {
    return {
      avgCostUsd: null,
      costBasisUsd: null,
      markUsd: mark,
      unrealizedPnlUsd: null,
      unrealizedPnlPct: null,
      lastBuyPrice: pos?.lastBuyPrice ?? null,
      lastSellPrice: pos?.lastSellPrice ?? null,
      realizedPnlUsd: pos?.realizedPnlUsd ?? 0,
      seeded: Boolean(pos?.seeded),
    };
  }

  const marketUsd =
    h.usd != null && Number.isFinite(h.usd)
      ? h.usd
      : mark != null
        ? mark * h.amount
        : null;
  const costBasisUsd = round(pos.avgCostUsd * h.amount, 4);
  const unrealizedPnlUsd =
    marketUsd != null ? round(marketUsd - costBasisUsd, 4) : null;
  const unrealizedPnlPct =
    unrealizedPnlUsd != null && costBasisUsd > 0
      ? round((unrealizedPnlUsd / costBasisUsd) * 100, 2)
      : null;

  return {
    avgCostUsd: pos.avgCostUsd,
    costBasisUsd,
    markUsd: mark,
    unrealizedPnlUsd,
    unrealizedPnlPct,
    lastBuyPrice: pos.lastBuyPrice,
    lastSellPrice: pos.lastSellPrice,
    realizedPnlUsd: pos.realizedPnlUsd,
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
>(tokenId: string, holdings: T[]): Array<T & EnrichedHolding> {
  reconcileHoldings(tokenId, holdings);
  return holdings.map((h) => ({ ...h, ...enrichHolding(tokenId, h) }));
}

/** Map of symbol → unrealized P&L % for sell preference. */
export function pnlPctBySymbol(
  tokenId: string,
  holdings: Array<{
    symbol: string;
    amount: number;
    usd: number | null | undefined;
    priceUsd: number | null | undefined;
  }>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const h of enrichHoldings(tokenId, holdings)) {
    if (h.unrealizedPnlPct != null) out[h.symbol.toUpperCase()] = h.unrealizedPnlPct;
  }
  return out;
}

/**
 * Infer qty/price from a planned swap action and record it.
 * Buys: qty ≈ notionalUsd / mark of tokenOut.
 * Sells: qty from amountIn, price ≈ notionalUsd / qty.
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
}): PositionBasis | null {
  const side = args.action.side;
  if (side !== "buy" && side !== "sell") return null;
  const notional = args.action.notionalUsd;
  if (notional == null || !(notional > 0)) return null;

  if (side === "buy") {
    const symbol = (args.action.tokenOut ?? "").toUpperCase();
    const mark = args.marks[symbol];
    if (!symbol || mark == null || !(mark > 0)) return null;
    const qty = notional / mark;
    return recordFill({
      tokenId: args.tokenId,
      side: "buy",
      symbol,
      qty,
      priceUsd: mark,
      notionalUsd: notional,
      dryRun: args.dryRun,
      reason: args.action.reason,
    });
  }

  const symbol = (args.action.tokenIn ?? "").toUpperCase();
  const qty = Number(args.action.amountIn);
  if (!symbol || !(qty > 0)) return null;
  const priceUsd = notional / qty;
  return recordFill({
    tokenId: args.tokenId,
    side: "sell",
    symbol,
    qty,
    priceUsd,
    notionalUsd: notional,
    dryRun: args.dryRun,
    reason: args.action.reason,
  });
}
