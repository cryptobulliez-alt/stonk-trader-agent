import { getTradeLog } from "./tradeLog.js";

export type TradeCostEstimate = {
  notionalUsd: number;
  gasEth: number;
  gasUsd: number;
  slipUsd: number;
  /** Entry gas+slip; buys also include expected exit load. */
  totalCostUsd: number;
  entryCostUsd: number;
  exitCostUsd: number;
  stepsHint: number;
  /** Min edge $ required = notional * minEdgeBps / 10000 (buys) or cost floor (sells). */
  requiredEdgeUsd: number;
};

const DEFAULT_GAS_ETH_PER_STEP = 0.000012;

/** Trailing average gas fee (ETH) per live tx from trade-log, else default. */
export function recentAvgGasEthPerTx(tokenId?: string): number {
  const file = getTradeLog(tokenId);
  const fees: number[] = [];
  for (const t of file.trades.slice(-40)) {
    for (const tx of t.txs) {
      if (tx.gasFeeEth != null && tx.gasFeeEth > 0 && tx.url) {
        fees.push(tx.gasFeeEth);
      }
    }
  }
  if (fees.length === 0) return DEFAULT_GAS_ETH_PER_STEP;
  const sum = fees.reduce((a, b) => a + b, 0);
  return sum / fees.length;
}

export function stepsHintForSide(side: "buy" | "sell"): number {
  // sell: often approve + permit2 + swap + wrap; buy: unwrap + swap
  return side === "sell" ? 3 : 2;
}

/**
 * All-in friction for a planned swap.
 * Call value on buys stays in the TBA path — counted via slip only, not as a burn.
 */
export function estimateTradeCostUsd(args: {
  side: "buy" | "sell";
  notionalUsd: number;
  ethUsd: number | null | undefined;
  slippageBps: number;
  minEdgeBps: number;
  /** Override gas ETH per step; else trade-log avg / default. */
  gasEthPerStep?: number;
  tokenId?: string;
  stepsHint?: number;
  /** Buys: require edge to cover entry + expected exit. */
  roundTrip?: boolean;
}): TradeCostEstimate {
  const notionalUsd = Math.max(0, args.notionalUsd);
  const steps = args.stepsHint ?? stepsHintForSide(args.side);
  const gasEthPerStep =
    args.gasEthPerStep != null && args.gasEthPerStep > 0
      ? args.gasEthPerStep
      : recentAvgGasEthPerTx(args.tokenId);
  const gasEth = gasEthPerStep * steps;
  const ethUsd = args.ethUsd != null && args.ethUsd > 0 ? args.ethUsd : null;
  const gasUsd = ethUsd != null ? gasEth * ethUsd : gasEth * 2000; // fallback mark
  const slipUsd = notionalUsd * (Math.max(0, args.slippageBps) / 10_000);
  const entryCostUsd = gasUsd + slipUsd;
  const roundTrip = args.roundTrip ?? args.side === "buy";
  const exitCostUsd = roundTrip ? gasUsd + slipUsd : 0;
  const totalCostUsd = entryCostUsd + exitCostUsd;
  const requiredEdgeUsd =
    args.side === "buy"
      ? Math.max(totalCostUsd, notionalUsd * (Math.max(0, args.minEdgeBps) / 10_000))
      : entryCostUsd;

  return {
    notionalUsd,
    gasEth: +gasEth.toFixed(8),
    gasUsd: +gasUsd.toFixed(4),
    slipUsd: +slipUsd.toFixed(4),
    totalCostUsd: +totalCostUsd.toFixed(4),
    entryCostUsd: +entryCostUsd.toFixed(4),
    exitCostUsd: +exitCostUsd.toFixed(4),
    stepsHint: steps,
    requiredEdgeUsd: +requiredEdgeUsd.toFixed(4),
  };
}

export type FeeGateDecision = {
  ok: boolean;
  reason: string;
  cost: TradeCostEstimate;
  edgeUsd: number | null;
};

/**
 * Decide whether a planned swap clears fee/edge requirements.
 * Cash-restore sells can bypass uPnL edge when cash is critically low.
 */
export function evaluateFeeGate(args: {
  side: "buy" | "sell";
  notionalUsd: number;
  ethUsd: number | null | undefined;
  slippageBps: number;
  minNotionalUsd: number;
  minEdgeBps: number;
  gasEthPerStep?: number;
  tokenId?: string;
  /** Unrealized P&L $ attributable to this sell (sold fraction). */
  unrealizedPnlUsd?: number | null;
  /** True when cash is below reserve − band (must raise cash). */
  cashRestore?: boolean;
  /** Cash critically low (reserve − 10pp) — allow sub-min notional sells. */
  cashCritical?: boolean;
}): FeeGateDecision {
  const cost = estimateTradeCostUsd({
    side: args.side,
    notionalUsd: args.notionalUsd,
    ethUsd: args.ethUsd,
    slippageBps: args.slippageBps,
    minEdgeBps: args.minEdgeBps,
    gasEthPerStep: args.gasEthPerStep,
    tokenId: args.tokenId,
  });

  if (!(args.notionalUsd > 0)) {
    return { ok: false, reason: "fee gate: zero notional", cost, edgeUsd: null };
  }

  if (args.notionalUsd < args.minNotionalUsd) {
    if (args.side === "sell" && args.cashCritical) {
      // allow dust sell only when cash is critically low
    } else {
      return {
        ok: false,
        reason: `fee gate: notional $${args.notionalUsd.toFixed(2)} < min $${args.minNotionalUsd}`,
        cost,
        edgeUsd: null,
      };
    }
  }

  if (args.side === "buy") {
    const need = cost.requiredEdgeUsd;
    // Buys have no locked-in edge; require notional large enough that minEdge covers costs
    if (args.notionalUsd * (args.minEdgeBps / 10_000) < cost.totalCostUsd) {
      return {
        ok: false,
        reason: `fee gate: buy needs ≥$${cost.totalCostUsd.toFixed(2)} edge (gas+slip round-trip); notional×${args.minEdgeBps}bps too small`,
        cost,
        edgeUsd: args.notionalUsd * (args.minEdgeBps / 10_000),
      };
    }
    return {
      ok: true,
      reason: `fee gate ok: buy notional $${args.notionalUsd.toFixed(2)} · est cost $${cost.totalCostUsd.toFixed(2)} (RT)`,
      cost,
      edgeUsd: need,
    };
  }

  // Sells
  const uPnl = args.unrealizedPnlUsd ?? 0;
  if (args.cashRestore) {
    return {
      ok: true,
      reason: `fee gate ok: cash-restore sell $${args.notionalUsd.toFixed(2)} · est cost $${cost.entryCostUsd.toFixed(2)}`,
      cost,
      edgeUsd: uPnl,
    };
  }
  if (uPnl >= cost.entryCostUsd) {
    return {
      ok: true,
      reason: `fee gate ok: sell uPnL $${uPnl.toFixed(2)} ≥ cost $${cost.entryCostUsd.toFixed(2)}`,
      cost,
      edgeUsd: uPnl,
    };
  }
  return {
    ok: false,
    reason: `fee gate: sell uPnL $${uPnl.toFixed(2)} < cost $${cost.entryCostUsd.toFixed(2)} (skip discretionary trim)`,
    cost,
    edgeUsd: uPnl,
  };
}

export type EoaGasWarn = {
  low: boolean;
  /** Too low to reliably sign even one multi-step swap. */
  critical: boolean;
  haveEth: number;
  needEth: number;
  haveUsd: number | null;
  message: string;
};

/**
 * Owner EOA only pays gas (buys fund from TBA). Warn when ETH can't cover a pass.
 */
export function evaluateEoaGasReserve(args: {
  eoaEth: number;
  ethUsd?: number | null;
  maxActionsPerPass?: number;
  gasEthPerStep?: number;
  tokenId?: string;
}): EoaGasWarn {
  const maxActions = Math.max(1, args.maxActionsPerPass ?? 2);
  const gasEthPerStep =
    args.gasEthPerStep != null && args.gasEthPerStep > 0
      ? args.gasEthPerStep
      : recentAvgGasEthPerTx(args.tokenId);
  // Worst-case pass: maxActions sells (~3 steps) + 50% buffer
  const needEth = Math.max(
    gasEthPerStep * 3 * maxActions * 1.5,
    0.0005, // hard floor
  );
  const haveEth = Math.max(0, args.eoaEth);
  const ethUsd = args.ethUsd != null && args.ethUsd > 0 ? args.ethUsd : null;
  const haveUsd = ethUsd != null ? haveEth * ethUsd : null;
  const needUsd = ethUsd != null ? needEth * ethUsd : null;
  // Soft warn: under ~3× reserve or under ~$5
  const low =
    haveEth < needEth * 3 ||
    (haveUsd != null && haveUsd < 5) ||
    haveEth < 0.002;
  const critical = haveEth < needEth;
  const needLabel =
    needUsd != null
      ? `${needEth.toFixed(5)} ETH (~$${needUsd.toFixed(2)})`
      : `${needEth.toFixed(5)} ETH`;
  const haveLabel =
    haveUsd != null
      ? `${haveEth.toFixed(5)} ETH (~$${haveUsd.toFixed(2)})`
      : `${haveEth.toFixed(5)} ETH`;
  const message = critical
    ? `Fund EOA with ETH for gas — have ${haveLabel}, need ≥ ${needLabel} before live swaps`
    : low
      ? `EOA gas running low — have ${haveLabel}; top up so gas + fees stay covered (target ≥ ${needLabel} ×3)`
      : `EOA gas ok — ${haveLabel}`;
  return {
    low: low || critical,
    critical,
    haveEth: +haveEth.toFixed(6),
    needEth: +needEth.toFixed(6),
    haveUsd: haveUsd != null ? +haveUsd.toFixed(2) : null,
    message,
  };
}
