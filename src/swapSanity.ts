/**
 * Cross-check execution venue quotes against an independent mark (usually V3).
 * Blocks wrong-pool dust (SLV v4 disaster) without blocking thin-but-real books (USO/SLV v3).
 */
import { formatUnits, type Address, type PublicClient } from "viem";
import { getEthUsd, priceTokenUsd } from "./prices.js";

/**
 * Default max under-mark for executable quotes.
 * Thin ETF multi-hops (USO/SLV) often print 2–6% under slot0 marks after fees/impact —
 * that is tradeable. Wrong-pool dust is orders of magnitude worse.
 */
export const MAX_EXEC_VS_MARK_BPS = 2_500; // 25% — thin multi-hops (SOFI/USO); still blocks dust

export type SwapSanityOk = {
  ok: true;
  ethUsd: number;
  markUsd: number;
  markSource: string;
  fairOutHuman: number;
  quotedOutHuman: number;
  /** Negative = exec worse than mark. */
  vsMarkBps: number;
  outDecimals: number;
  maxUnderBps: number;
};

export type SwapSanityFail = {
  ok: false;
  reason: string;
};

/**
 * Compare quoted amountOut to mark-implied fair out.
 * buyStock: amountIn is ETH/WETH (18 dec), out is stock.
 * !buyStock: amountIn is stock, out is ETH (18 dec).
 */
export async function checkSwapQuoteVsMark(
  client: PublicClient,
  args: {
    buyStock: boolean;
    stock: { symbol: string; address: Address; decimals: number };
    amountIn: bigint;
    quotedOut: bigint;
    engine: string;
    /**
     * Extra tolerance for known route fees (Uniswap fee 3000 → 30 bps).
     * Slot0 marks ignore fees; Quoter/exec quotes include them.
     */
    routeFeeBps?: number;
    /** Override default MAX_EXEC_VS_MARK_BPS (settings.maxExecVsMarkBps). */
    maxUnderBps?: number;
  },
): Promise<SwapSanityOk | SwapSanityFail> {
  const ethUsd = await getEthUsd(client);
  if (ethUsd == null || !(ethUsd > 0)) {
    return { ok: false, reason: "no ETH/USD mark — refusing swap" };
  }

  const mark = await priceTokenUsd(
    client,
    args.stock.address,
    args.stock.symbol,
    args.stock.decimals,
    ethUsd,
  );
  if (mark.usd == null || !(mark.usd > 0)) {
    return {
      ok: false,
      reason: `no USD mark for ${args.stock.symbol} — refusing swap`,
    };
  }

  const outDecimals = args.buyStock ? args.stock.decimals : 18;
  const quotedOutHuman = Number(formatUnits(args.quotedOut, outDecimals));
  if (!(quotedOutHuman > 0)) {
    return { ok: false, reason: `${args.engine} quote is zero` };
  }

  let fairOutHuman: number;
  if (args.buyStock) {
    const ethIn = Number(formatUnits(args.amountIn, 18));
    fairOutHuman = (ethIn * ethUsd) / mark.usd;
  } else {
    const stockIn = Number(formatUnits(args.amountIn, args.stock.decimals));
    fairOutHuman = (stockIn * mark.usd) / ethUsd;
  }

  if (!(fairOutHuman > 0)) {
    return { ok: false, reason: "fair amountOut from mark is zero" };
  }

  const vsMarkBps = Math.round((quotedOutHuman / fairOutHuman - 1) * 10_000);
  const feeBps = Math.max(0, Math.round(args.routeFeeBps ?? 0));
  const base =
    args.maxUnderBps != null && Number.isFinite(args.maxUnderBps)
      ? Math.max(50, Math.round(args.maxUnderBps))
      : MAX_EXEC_VS_MARK_BPS;
  const maxUnderBps = base + feeBps;
  const floorBps = -maxUnderBps;

  if (vsMarkBps < floorBps) {
    return {
      ok: false,
      reason:
        `${args.engine} quote ${quotedOutHuman.toPrecision(6)} ${
          args.buyStock ? args.stock.symbol : "ETH"
        } is ${((-vsMarkBps) / 100).toFixed(1)}% below mark ` +
        `(fair ≈ ${fairOutHuman.toPrecision(6)} from ${mark.source ?? "mark"} @ $${mark.usd.toFixed(4)}) — ` +
        `refusing wrong-pool/dust fill (max ${maxUnderBps / 100}% under mark` +
        (feeBps ? ` incl. ${feeBps}bps route fees` : "") +
        `)`,
    };
  }

  return {
    ok: true,
    ethUsd,
    markUsd: mark.usd,
    markSource: mark.source ?? "mark",
    fairOutHuman,
    quotedOutHuman,
    vsMarkBps,
    outDecimals,
    maxUnderBps,
  };
}

/**
 * amountOutMinimum from an *executable* quoter (V3 QuoterV2 / V4 quoter).
 * Never raise this with a slot0 mark floor — that caused USO Too little received.
 */
export function minOutFromExecutableQuote(args: {
  quotedOut: bigint;
  slippageBps: number;
}): bigint {
  const slip = Math.max(0, Math.min(9_900, args.slippageBps));
  return (args.quotedOut * BigInt(10_000 - slip)) / 10_000n;
}

/** @deprecated use minOutFromExecutableQuote */
export function applyMinOutFloors(args: {
  quotedOut: bigint;
  slippageBps: number;
  markFloor?: bigint;
}): bigint {
  return minOutFromExecutableQuote(args);
}
