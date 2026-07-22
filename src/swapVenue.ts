/**
 * Pick Uniswap v3 vs v4 for ETH/WETH ↔ stock.
 * Many names only have a real V3 book; some have thin/junk V4 pools that still "exist".
 */
import { formatUnits, type Address, type PublicClient } from "viem";
import { findBestQuotedRoute, v3RouteFeeBps } from "./brokerReads.js";
import { WETH } from "./config.js";
import { checkSwapQuoteVsMark } from "./swapSanity.js";
import { findBestEthStockPool, quoteV4ExactIn } from "./v4.js";

export type SwapVenuePref = "auto" | "v3" | "v4";

export type VenueProbeOk = {
  ok: true;
  engine: "v4" | "v3";
  quotedOut: bigint;
  vsMarkBps: number;
  markSource: string;
  detail: string;
};

export type VenueProbeFail = {
  ok: false;
  engine: "v4" | "v3";
  reason: string;
};

export type VenueProbe = VenueProbeOk | VenueProbeFail;

export function normalizeSwapVenue(raw: unknown): SwapVenuePref {
  const v = String(raw ?? "auto").toLowerCase();
  if (v === "v3" || v === "v4" || v === "auto") return v;
  return "auto";
}

/** Cash leg address for V3 routing (native ETH is not a V3 pool currency). */
function v3CashAddress(symbol: string, address: Address): Address {
  if (symbol === "ETH" || symbol === "WETH") return WETH;
  return address;
}

async function probeV4(
  client: PublicClient,
  args: {
    buyStock: boolean;
    stock: { symbol: string; address: Address; decimals: number };
    amountIn: bigint;
    maxUnderBps?: number;
  },
): Promise<VenueProbe> {
  const pool = await findBestEthStockPool(client, args.stock.address);
  if (!pool) {
    return { ok: false, engine: "v4", reason: `no liquid v4 ETH/${args.stock.symbol} pool` };
  }
  try {
    const spot = await quoteV4ExactIn(client, pool.key, args.buyStock, args.amountIn);
    if (spot === 0n) {
      return { ok: false, engine: "v4", reason: "v4 quoter returned 0" };
    }
    const sanity = await checkSwapQuoteVsMark(client, {
      buyStock: args.buyStock,
      stock: args.stock,
      amountIn: args.amountIn,
      quotedOut: spot,
      engine: "v4",
      routeFeeBps: Math.round(pool.key.fee / 100),
      maxUnderBps: args.maxUnderBps,
    });
    if (!sanity.ok) {
      return { ok: false, engine: "v4", reason: sanity.reason };
    }
    return {
      ok: true,
      engine: "v4",
      quotedOut: spot,
      vsMarkBps: sanity.vsMarkBps,
      markSource: sanity.markSource,
      detail: `v4 ETH/${args.stock.symbol} fee=${pool.key.fee} vsMark=${sanity.vsMarkBps}bps`,
    };
  } catch (err) {
    return {
      ok: false,
      engine: "v4",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

async function probeV3(
  client: PublicClient,
  args: {
    buyStock: boolean;
    tokenIn: { symbol: string; address: Address; decimals: number };
    tokenOut: { symbol: string; address: Address; decimals: number };
    stock: { symbol: string; address: Address; decimals: number };
    amountIn: bigint;
    fee?: number;
    maxUnderBps?: number;
  },
): Promise<VenueProbe> {
  const inAddr = v3CashAddress(args.tokenIn.symbol, args.tokenIn.address);
  const outAddr = v3CashAddress(args.tokenOut.symbol, args.tokenOut.address);
  try {
    const quoted = await findBestQuotedRoute(
      client,
      inAddr,
      outAddr,
      args.amountIn,
      args.fee,
    );
    if (!quoted || quoted.quotedOut === 0n) {
      return {
        ok: false,
        engine: "v3",
        reason: `no liquid v3 WETH/USDG route for ${args.tokenIn.symbol}→${args.tokenOut.symbol}`,
      };
    }
    const { route, quotedOut: spot } = quoted;
    const sanity = await checkSwapQuoteVsMark(client, {
      buyStock: args.buyStock,
      stock: args.stock,
      amountIn: args.amountIn,
      quotedOut: spot,
      engine: route.kind === "direct" ? "v3" : "v3-multihop",
      routeFeeBps: v3RouteFeeBps(route),
      maxUnderBps: args.maxUnderBps,
    });
    if (!sanity.ok) {
      return { ok: false, engine: "v3", reason: sanity.reason };
    }
    const routeNote =
      route.kind === "direct"
        ? `v3 direct fee ${route.fee}`
        : `v3 via ${route.midSymbol} (${route.feeIn}/${route.feeOut})`;
    return {
      ok: true,
      engine: "v3",
      quotedOut: spot,
      vsMarkBps: sanity.vsMarkBps,
      markSource: sanity.markSource,
      detail: `${routeNote} vsMark=${sanity.vsMarkBps}bps`,
    };
  } catch (err) {
    return {
      ok: false,
      engine: "v3",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Choose a mark-sane venue for ETH/WETH ↔ stock.
 * Prefer the better (higher) vsMarkBps; tie-break by higher quotedOut, then v4.
 */
export async function selectEthStockVenue(
  client: PublicClient,
  args: {
    tokenIn: { symbol: string; address: Address; decimals: number };
    tokenOut: { symbol: string; address: Address; decimals: number };
    amountIn: bigint;
    prefer?: SwapVenuePref;
    fee?: number;
    maxUnderBps?: number;
  },
): Promise<{ engine: "v4" | "v3"; probes: VenueProbe[]; pick: VenueProbeOk }> {
  const prefer = normalizeSwapVenue(args.prefer);
  const buyStock = ["WETH", "ETH"].includes(args.tokenIn.symbol);
  const stock = buyStock ? args.tokenOut : args.tokenIn;

  const probes: VenueProbe[] = [];
  if (prefer !== "v3") {
    probes.push(
      await probeV4(client, {
        buyStock,
        stock: {
          symbol: stock.symbol,
          address: stock.address,
          decimals: stock.decimals,
        },
        amountIn: args.amountIn,
        maxUnderBps: args.maxUnderBps,
      }),
    );
  }
  if (prefer !== "v4") {
    // Native ETH cannot be sold on V3 without wrapping; skip probe for ETH→stock
    // when prefer is auto/v3 — still allow WETH→stock.
    if (args.tokenIn.symbol === "ETH") {
      probes.push({
        ok: false,
        engine: "v3",
        reason: "v3 requires WETH (not native ETH) — use v4 or wrap first",
      });
    } else {
      probes.push(
        await probeV3(client, {
          buyStock,
          tokenIn: args.tokenIn,
          tokenOut: args.tokenOut,
          stock: {
            symbol: stock.symbol,
            address: stock.address,
            decimals: stock.decimals,
          },
          amountIn: args.amountIn,
          fee: args.fee,
          maxUnderBps: args.maxUnderBps,
        }),
      );
    }
  }

  const ok = probes.filter((p): p is VenueProbeOk => p.ok);
  if (ok.length === 0) {
    const why = probes.map((p) => `${p.engine}: ${"reason" in p ? p.reason : "?"}`).join("; ");
    throw new Error(
      `verification failed: no mark-sane ${prefer === "auto" ? "v3/v4" : prefer} venue for ${args.tokenIn.symbol}→${args.tokenOut.symbol} (${why})`,
    );
  }

  ok.sort((a, b) => {
    if (b.vsMarkBps !== a.vsMarkBps) return b.vsMarkBps - a.vsMarkBps;
    if (b.quotedOut !== a.quotedOut) return b.quotedOut > a.quotedOut ? 1 : -1;
    return a.engine === "v4" ? -1 : 1;
  });

  return { engine: ok[0].engine, probes, pick: ok[0] };
}

export function formatVenueProbes(probes: VenueProbe[]): string {
  return probes
    .map((p) => {
      if (p.ok) {
        return `${p.engine}: ok out=${formatUnits(p.quotedOut, 18)} ${p.detail}`;
      }
      return `${p.engine}: skip — ${p.reason}`;
    })
    .join(" | ");
}
