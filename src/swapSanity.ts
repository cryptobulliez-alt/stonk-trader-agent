/**
 * Cross-check execution venue quotes against an independent mark (usually V3).
 * Prevents "mark says $54, v4 pool pays dust" disasters.
 */
import { formatUnits, parseUnits, type Address, type PublicClient } from "viem";
import { getEthUsd, priceTokenUsd } from "./prices.js";

/** Refuse to build a swap if exec quote is worse than mark by more than this. */
export const MAX_EXEC_VS_MARK_BPS = 500; // 5%

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
  const floorBps = -MAX_EXEC_VS_MARK_BPS;

  if (vsMarkBps < floorBps) {
    return {
      ok: false,
      reason:
        `${args.engine} quote ${quotedOutHuman.toPrecision(6)} ${
          args.buyStock ? args.stock.symbol : "ETH"
        } is ${((-vsMarkBps) / 100).toFixed(1)}% below mark ` +
        `(fair ≈ ${fairOutHuman.toPrecision(6)} from ${mark.source ?? "mark"} @ $${mark.usd.toFixed(4)}) — ` +
        `refusing illiquid/wrong-pool fill (max ${MAX_EXEC_VS_MARK_BPS / 100}% under mark)`,
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
  };
}

/** Mark-based minimum out: never accept less than fair × (1 − maxDev − slip). */
export function markBasedMinOut(args: {
  fairOutHuman: number;
  outDecimals: number;
  slippageBps: number;
  maxDeviationBps?: number;
}): bigint {
  const maxDev = args.maxDeviationBps ?? MAX_EXEC_VS_MARK_BPS;
  const totalBps = Math.min(9_900, maxDev + Math.max(0, args.slippageBps));
  const floor = args.fairOutHuman * ((10_000 - totalBps) / 10_000);
  if (!(floor > 0)) return 0n;
  // Cap decimal string length for parseUnits
  const fixed = floor.toFixed(Math.min(18, args.outDecimals));
  try {
    return parseUnits(fixed, args.outDecimals);
  } catch {
    return 0n;
  }
}

export function applyMinOutFloors(args: {
  quotedOut: bigint;
  slippageBps: number;
  markFloor: bigint;
}): bigint {
  const fromQuote =
    (args.quotedOut * BigInt(10_000 - args.slippageBps)) / 10_000n;
  return fromQuote > args.markFloor ? fromQuote : args.markFloor;
}
