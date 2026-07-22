import {
  formatUnits,
  getAddress,
  zeroAddress,
  type Address,
  type PublicClient,
} from "viem";
import { CONTRACTS, FEE_TIERS, factoryAbi, poolAbi } from "./contracts.js";
import { USDG, WETH } from "./config.js";

const Q96 = 2n ** 96n;

export type TokenUsdPrice = {
  symbol: string;
  address: Address;
  usd: number | null;
  eth: number | null;
  source: string | null;
  partial: boolean;
};

async function bestPool(
  client: PublicClient,
  a: Address,
  b: Address,
): Promise<{ pool: Address; fee: number } | null> {
  let best: { pool: Address; fee: number; liq: bigint } | null = null;
  for (const fee of FEE_TIERS) {
    const pool = await client.readContract({
      address: CONTRACTS.uniswapV3Factory,
      abi: factoryAbi,
      functionName: "getPool",
      args: [a, b, fee],
    });
    if (pool === zeroAddress) continue;
    const liq = await client.readContract({
      address: pool,
      abi: poolAbi,
      functionName: "liquidity",
    });
    if (liq === 0n) continue;
    if (!best || liq > best.liq) best = { pool: getAddress(pool), fee, liq };
  }
  return best ? { pool: best.pool, fee: best.fee } : null;
}

/** token1 per token0 from slot0, adjusted for decimals. */
async function spotToken1PerToken0(
  client: PublicClient,
  pool: Address,
  decimals0: number,
  decimals1: number,
): Promise<number | null> {
  try {
    const [slot0, token0] = await Promise.all([
      client.readContract({ address: pool, abi: poolAbi, functionName: "slot0" }),
      client.readContract({ address: pool, abi: poolAbi, functionName: "token0" }),
    ]);
    void token0;
    const sqrt = slot0[0];
    if (sqrt === 0n) return null;
    // price = (sqrt/2^96)^2 * 10^(dec0-dec1)
    const priceX192 = sqrt * sqrt;
    const scale = 10n ** BigInt(18 + decimals0 - decimals1);
    const raw = (priceX192 * scale) / (Q96 * Q96);
    return Number(formatUnits(raw, 18));
  } catch {
    return null;
  }
}

/** ETH price in USD from deepest USDG/WETH pool (USDG ≈ $1). */
export async function getEthUsd(client: PublicClient): Promise<number | null> {
  const pair = await bestPool(client, USDG, WETH);
  if (!pair) return null;
  const [token0] = await Promise.all([
    client.readContract({
      address: pair.pool,
      abi: poolAbi,
      functionName: "token0",
    }),
  ]);
  const usdgIs0 = token0.toLowerCase() === USDG.toLowerCase();
  const t1PerT0 = await spotToken1PerToken0(
    client,
    pair.pool,
    usdgIs0 ? 6 : 18,
    usdgIs0 ? 18 : 6,
  );
  if (t1PerT0 == null || t1PerT0 <= 0) return null;
  // If token0=USDG, token1=WETH → t1PerT0 = WETH per USDG → ethUsd = 1 / t1PerT0
  // If token0=WETH, token1=USDG → t1PerT0 = USDG per WETH → ethUsd = t1PerT0
  return usdgIs0 ? 1 / t1PerT0 : t1PerT0;
}

/** USD price for a token via WETH pool * ethUsd. WETH/USDG handled specially. */
export async function priceTokenUsd(
  client: PublicClient,
  token: Address,
  symbol: string,
  decimals: number,
  ethUsd: number | null,
): Promise<TokenUsdPrice> {
  const address = getAddress(token);
  if (address.toLowerCase() === WETH.toLowerCase()) {
    return {
      symbol: "WETH",
      address,
      usd: ethUsd,
      eth: 1,
      source: ethUsd != null ? "USDG/WETH pool" : null,
      partial: ethUsd == null,
    };
  }
  if (address.toLowerCase() === USDG.toLowerCase()) {
    return {
      symbol: "USDG",
      address,
      usd: 1,
      eth: ethUsd != null && ethUsd > 0 ? 1 / ethUsd : null,
      source: "stable≈1",
      partial: false,
    };
  }

  const pair = await bestPool(client, address, WETH);
  if (!pair || ethUsd == null) {
    return {
      symbol,
      address,
      usd: null,
      eth: null,
      source: null,
      partial: true,
    };
  }

  const token0 = await client.readContract({
    address: pair.pool,
    abi: poolAbi,
    functionName: "token0",
  });
  const tokenIs0 = token0.toLowerCase() === address.toLowerCase();
  const t1PerT0 = await spotToken1PerToken0(
    client,
    pair.pool,
    tokenIs0 ? decimals : 18,
    tokenIs0 ? 18 : decimals,
  );
  if (t1PerT0 == null || t1PerT0 <= 0) {
    return { symbol, address, usd: null, eth: null, source: null, partial: true };
  }
  const ethPerToken = tokenIs0 ? t1PerT0 : 1 / t1PerT0;
  return {
    symbol,
    address,
    usd: ethPerToken * ethUsd,
    eth: ethPerToken,
    source: `V3 fee=${pair.fee} × ETH/USD`,
    partial: false,
  };
}
