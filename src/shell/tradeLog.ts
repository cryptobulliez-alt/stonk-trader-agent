import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatEther, type Hash, type PublicClient } from "viem";
import { txUrl } from "../chain.js";

export type TradeTx = {
  what: string;
  hash: string;
  url: string | null;
  valueEth?: number;
  valueUsd?: number;
  gasUsed?: string;
  effectiveGasPriceWei?: string;
  gasFeeEth?: number;
  gasFeeUsd?: number;
};

export type TradeEntry = {
  id: string;
  ts: number;
  tokenId: string;
  side: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  notionalUsd?: number;
  reason?: string;
  dryRun: boolean;
  status: "filled" | "dry_run" | "error";
  txs: TradeTx[];
  /** Sum of step native values (ETH). */
  valueEth?: number;
  valueUsd?: number;
  /** Sum of gas fees paid by the signing EOA (ETH). */
  gasFeeEth?: number;
  gasFeeUsd?: number;
  ethUsd?: number;
  error?: string;
};

export type TradeTotals = {
  swaps: number;
  filled: number;
  dryRun: number;
  errors: number;
  gasFeeEth: number;
  gasFeeUsd: number;
  valueEth: number;
  valueUsd: number;
  txCount: number;
};

type TradeLogFile = {
  tokenId: string;
  trades: TradeEntry[];
};

const MAX_TRADES = 500;

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

function tradeLogPath(): string {
  return join(dataDir(), "trade-log.json");
}

function empty(tokenId = ""): TradeLogFile {
  return { tokenId, trades: [] };
}

function loadRaw(): TradeLogFile {
  const path = tradeLogPath();
  if (!existsSync(path)) return empty();
  try {
    return JSON.parse(readFileSync(path, "utf8")) as TradeLogFile;
  } catch {
    return empty();
  }
}

function saveRaw(file: TradeLogFile) {
  writeFileSync(tradeLogPath(), JSON.stringify(file, null, 2) + "\n");
}

function ensureToken(file: TradeLogFile, tokenId: string): TradeLogFile {
  if (file.tokenId && file.tokenId !== tokenId) {
    return empty(tokenId);
  }
  file.tokenId = tokenId;
  return file;
}

function round(n: number, d = 8): number {
  const p = 10 ** d;
  return Math.round(n * p) / p;
}

function usdOf(eth: number | undefined, ethUsd: number | undefined): number | undefined {
  if (eth == null || ethUsd == null || !(ethUsd > 0)) return undefined;
  return round(eth * ethUsd, 4);
}

export function getTradeLog(tokenId?: string): TradeLogFile {
  const file = loadRaw();
  if (tokenId && file.tokenId && file.tokenId !== tokenId) {
    return empty(tokenId);
  }
  return file;
}

export function listTrades(tokenId?: string, limit = 200): TradeEntry[] {
  const file = getTradeLog(tokenId);
  return [...file.trades].reverse().slice(0, limit);
}

export function tradeTotals(trades: TradeEntry[]): TradeTotals {
  const totals: TradeTotals = {
    swaps: trades.length,
    filled: 0,
    dryRun: 0,
    errors: 0,
    gasFeeEth: 0,
    gasFeeUsd: 0,
    valueEth: 0,
    valueUsd: 0,
    txCount: 0,
  };
  for (const t of trades) {
    if (t.status === "filled") totals.filled += 1;
    else if (t.status === "dry_run") totals.dryRun += 1;
    else if (t.status === "error") totals.errors += 1;
    totals.gasFeeEth += t.gasFeeEth ?? 0;
    totals.gasFeeUsd += t.gasFeeUsd ?? 0;
    totals.valueEth += t.valueEth ?? 0;
    totals.valueUsd += t.valueUsd ?? 0;
    totals.txCount += t.txs.filter((x) => x.url).length;
  }
  totals.gasFeeEth = round(totals.gasFeeEth, 8);
  totals.gasFeeUsd = round(totals.gasFeeUsd, 4);
  totals.valueEth = round(totals.valueEth, 8);
  totals.valueUsd = round(totals.valueUsd, 4);
  return totals;
}

export function recordTrade(args: {
  tokenId: string;
  side?: string;
  tokenIn?: string;
  tokenOut?: string;
  amountIn?: string;
  notionalUsd?: number;
  reason?: string;
  dryRun: boolean;
  status?: "filled" | "dry_run" | "error";
  ethUsd?: number | null;
  txs?: Array<{
    what: string;
    hash: string;
    dryRun?: boolean;
    valueEth?: number;
    gasUsed?: string;
    effectiveGasPriceWei?: string;
    gasFeeEth?: number;
  }>;
  error?: string;
}): TradeEntry {
  const file = ensureToken(loadRaw(), args.tokenId);
  const ethUsd = args.ethUsd != null && args.ethUsd > 0 ? args.ethUsd : undefined;
  const txs: TradeTx[] = (args.txs ?? []).map((t) => {
    const isDry = t.dryRun || t.hash === "0xdryrun";
    const gasFeeEth = t.gasFeeEth;
    const valueEth = t.valueEth;
    return {
      what: t.what,
      hash: t.hash,
      url: isDry ? null : txUrl(t.hash as `0x${string}`),
      valueEth,
      valueUsd: usdOf(valueEth, ethUsd),
      gasUsed: t.gasUsed,
      effectiveGasPriceWei: t.effectiveGasPriceWei,
      gasFeeEth,
      gasFeeUsd: usdOf(gasFeeEth, ethUsd),
    };
  });

  const gasFeeEth = round(
    txs.reduce((s, t) => s + (t.gasFeeEth ?? 0), 0),
    8,
  );
  const valueEth = round(
    txs.reduce((s, t) => s + (t.valueEth ?? 0), 0),
    8,
  );

  const entry: TradeEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ts: Date.now(),
    tokenId: args.tokenId,
    side: (args.side ?? "swap").toLowerCase(),
    tokenIn: args.tokenIn ?? "?",
    tokenOut: args.tokenOut ?? "?",
    amountIn: args.amountIn ?? "?",
    notionalUsd: args.notionalUsd,
    reason: args.reason,
    dryRun: args.dryRun,
    status: args.status ?? (args.dryRun ? "dry_run" : "filled"),
    txs,
    valueEth: valueEth > 0 ? valueEth : undefined,
    valueUsd: usdOf(valueEth > 0 ? valueEth : undefined, ethUsd),
    gasFeeEth: gasFeeEth > 0 ? gasFeeEth : undefined,
    gasFeeUsd: usdOf(gasFeeEth > 0 ? gasFeeEth : undefined, ethUsd),
    ethUsd,
    error: args.error,
  };
  file.trades.push(entry);
  if (file.trades.length > MAX_TRADES) {
    file.trades = file.trades.slice(-MAX_TRADES);
  }
  saveRaw(file);
  return entry;
}

/**
 * Enrich older log rows that have hashes but no gas/value by reading chain receipts.
 */
export async function backfillTradeFees(
  client: PublicClient,
  ethUsd: number | null,
  tokenId?: string,
): Promise<number> {
  const file = tokenId ? ensureToken(loadRaw(), tokenId) : loadRaw();
  let updated = 0;
  const price = ethUsd != null && ethUsd > 0 ? ethUsd : undefined;

  for (const trade of file.trades) {
    let dirty = false;
    for (const tx of trade.txs) {
      if (!tx.hash || tx.hash === "0xdryrun" || !tx.url) continue;
      if (tx.gasFeeEth != null && tx.valueEth != null) continue;
      try {
        const hash = tx.hash as Hash;
        const [receipt, mined] = await Promise.all([
          client.getTransactionReceipt({ hash }),
          client.getTransaction({ hash }),
        ]);
        const gasUsed = receipt.gasUsed;
        const effectiveGasPrice = receipt.effectiveGasPrice ?? 0n;
        const gasFeeWei = gasUsed * effectiveGasPrice;
        const gasFeeEth = Number(formatEther(gasFeeWei));
        const valueEth = Number(formatEther(mined.value));
        tx.gasUsed = gasUsed.toString();
        tx.effectiveGasPriceWei = effectiveGasPrice.toString();
        tx.gasFeeEth = round(gasFeeEth, 8);
        tx.gasFeeUsd = usdOf(tx.gasFeeEth, price);
        tx.valueEth = round(valueEth, 8);
        tx.valueUsd = usdOf(tx.valueEth, price);
        dirty = true;
      } catch {
        /* tx may be pruned / wrong chain */
      }
    }
    if (dirty) {
      const gasFeeEth = round(
        trade.txs.reduce((s, t) => s + (t.gasFeeEth ?? 0), 0),
        8,
      );
      const valueEth = round(
        trade.txs.reduce((s, t) => s + (t.valueEth ?? 0), 0),
        8,
      );
      trade.gasFeeEth = gasFeeEth > 0 ? gasFeeEth : undefined;
      trade.gasFeeUsd = usdOf(trade.gasFeeEth, price);
      trade.valueEth = valueEth > 0 ? valueEth : undefined;
      trade.valueUsd = usdOf(trade.valueEth, price);
      if (price) trade.ethUsd = price;
      updated += 1;
    } else if (price && trade.gasFeeEth != null && trade.gasFeeUsd == null) {
      trade.gasFeeUsd = usdOf(trade.gasFeeEth, price);
      trade.valueUsd = usdOf(trade.valueEth, price);
      for (const tx of trade.txs) {
        tx.gasFeeUsd = usdOf(tx.gasFeeEth, price);
        tx.valueUsd = usdOf(tx.valueEth, price);
      }
      trade.ethUsd = price;
      updated += 1;
    }
  }

  if (updated > 0) saveRaw(file);
  return updated;
}

type ExplorerTx = {
  hash: string;
  timeStamp: string;
  from: string;
  to: string;
  value: string;
  gasUsed: string;
  gasPrice: string;
  isError?: string;
  methodId?: string;
};

/**
 * Import owner→TBA executeCall txs from Blockscout into the trade log
 * (skips hashes already present).
 */
export async function importTbaTradesFromExplorer(args: {
  tokenId: string;
  owner: string;
  tba: string;
  ethUsd?: number | null;
  explorerApi?: string;
}): Promise<{ imported: number; skipped: number }> {
  const api =
    args.explorerApi ?? "https://robinhoodchain.blockscout.com/api";
  const url = `${api}?module=account&action=txlist&address=${args.owner}&sort=asc`;
  const res = await fetch(url);
  const json = (await res.json()) as { result?: ExplorerTx[]; message?: string };
  const rows = Array.isArray(json.result) ? json.result : [];
  const tba = args.tba.toLowerCase();
  const relevant = rows.filter((t) => t.to?.toLowerCase() === tba);

  const file = ensureToken(loadRaw(), args.tokenId);
  const existing = new Set(
    file.trades.flatMap((t) => t.txs.map((x) => x.hash.toLowerCase())),
  );
  const ethUsd =
    args.ethUsd != null && args.ethUsd > 0 ? args.ethUsd : undefined;
  let imported = 0;
  let skipped = 0;

  for (const t of relevant) {
    const hash = t.hash;
    if (existing.has(hash.toLowerCase())) {
      skipped += 1;
      continue;
    }
    const gasFeeEth = round(
      Number(BigInt(t.gasUsed) * BigInt(t.gasPrice)) / 1e18,
      8,
    );
    const valueEth = round(Number(BigInt(t.value || "0")) / 1e18, 8);
    const entry: TradeEntry = {
      id: `import-${hash.slice(2, 10)}-${t.timeStamp}`,
      ts: Number(t.timeStamp) * 1000,
      tokenId: args.tokenId,
      side: "swap",
      tokenIn: "?",
      tokenOut: "?",
      amountIn: "?",
      reason: "Imported from Blockscout (owner→TBA executeCall)",
      dryRun: false,
      status: t.isError === "1" ? "error" : "filled",
      ethUsd,
      valueEth: valueEth > 0 ? valueEth : undefined,
      valueUsd: usdOf(valueEth > 0 ? valueEth : undefined, ethUsd),
      gasFeeEth,
      gasFeeUsd: usdOf(gasFeeEth, ethUsd),
      txs: [
        {
          what: "executeCall",
          hash,
          url: txUrl(hash as `0x${string}`),
          valueEth,
          valueUsd: usdOf(valueEth, ethUsd),
          gasUsed: t.gasUsed,
          effectiveGasPriceWei: t.gasPrice,
          gasFeeEth,
          gasFeeUsd: usdOf(gasFeeEth, ethUsd),
        },
      ],
      error: t.isError === "1" ? "onchain revert" : undefined,
    };
    file.trades.push(entry);
    existing.add(hash.toLowerCase());
    imported += 1;
  }

  if (imported > 0) {
    file.trades.sort((a, b) => a.ts - b.ts);
    if (file.trades.length > MAX_TRADES) {
      file.trades = file.trades.slice(-MAX_TRADES);
    }
    saveRaw(file);
  }
  return { imported, skipped };
}

