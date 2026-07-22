import {
  createPublicClient,
  formatUnits,
  getAddress,
  http,
  zeroAddress,
  type Address,
  type PublicClient,
} from "viem";
import { erc20Abi, stonkBrokersAbi } from "./abis.js";
import { robinhoodChain } from "./chain.js";
import {
  EXPLORER_URL,
  STOCK_TOKENS,
  TOKEN_DECIMALS,
  USDG,
  WETH,
  resolveToken,
} from "./config.js";
import { multicallBalanceOf } from "./multicall.js";
import { findBestEthStockPool } from "./v4.js";
import {
  ACTIVATION_TIERS,
  CONTRACTS,
  FEE_TIERS,
  activationAbi,
  dividendStockSymbols,
  factoryAbi,
  poolAbi,
  stockBoosterAbi,
} from "./contracts.js";

export function makePublicClient(rpcUrl?: string): PublicClient {
  return createPublicClient({
    chain: robinhoodChain,
    transport: http(rpcUrl || process.env.RH_RPC_URL || "https://rpc.mainnet.chain.robinhood.com", {
      fetchOptions: { headers: { "User-Agent": "stonk-trader-mcp/1.0" } },
    }),
  });
}

export type UnsignedTx = {
  to: Address;
  data: `0x${string}`;
  value: string;
  chainId: number;
  what: string;
  [key: string]: unknown;
};

export function unsignedTx(
  to: Address,
  data: `0x${string}`,
  meta: Record<string, unknown> & { what: string },
  value = 0n,
): UnsignedTx {
  // Outer msg.value must not be overwritten by meta (inner callValue lives in calldata).
  const { value: _ignoreMetaValue, ...rest } = meta as Record<string, unknown> & {
    what: string;
    value?: unknown;
  };
  return {
    to: getAddress(to),
    data,
    chainId: 4663,
    ...rest,
    value: value.toString(),
  };
}

export async function getBrokersSummary(client: PublicClient) {
  const [
    minted,
    activeCount,
    totalActiveWeight,
    pendingEth,
    currentRound,
    stockAddrs,
  ] = await Promise.all([
    client.readContract({
      address: CONTRACTS.nft,
      abi: stonkBrokersAbi,
      functionName: "totalSupply",
    }),
    client.readContract({
      address: CONTRACTS.activationManager,
      abi: activationAbi,
      functionName: "activeCount",
    }),
    client.readContract({
      address: CONTRACTS.activationManager,
      abi: activationAbi,
      functionName: "totalActiveWeight",
    }),
    client.readContract({
      address: CONTRACTS.stockBooster,
      abi: stockBoosterAbi,
      functionName: "pendingEth",
    }),
    client.readContract({
      address: CONTRACTS.stockBooster,
      abi: stockBoosterAbi,
      functionName: "currentRound",
    }),
    client.readContract({
      address: CONTRACTS.stockBooster,
      abi: stockBoosterAbi,
      functionName: "getStockTokens",
    }),
  ]);

  const tiers = [];
  for (let i = 0; i < ACTIVATION_TIERS.length; i++) {
    const [price, weightBps] = await client.readContract({
      address: CONTRACTS.activationManager,
      abi: activationAbi,
      functionName: "tiers",
      args: [BigInt(i)],
    });
    tiers.push({
      tier: i + 1,
      price: Number(formatUnits(price, 18)),
      priceRaw: price.toString(),
      weightBps: Number(weightBps),
      weightX: Number(weightBps) / 10_000,
    });
  }

  const stocks = (stockAddrs as readonly Address[]).map((address) => ({
    address: getAddress(address),
    symbol: dividendStockSymbols[address.toLowerCase()] ?? address.slice(0, 8),
  }));

  return {
    ok: true,
    chainId: 4663,
    minted: Number(minted),
    maxSupply: 4444,
    mintedOut: Number(minted) >= 4444,
    activation: {
      active: Number(activeCount),
      pctOfMinted: Number(minted) ? (Number(activeCount) / Number(minted)) * 100 : 0,
      totalWeight: Number(totalActiveWeight),
      tiers,
    },
    dividends: {
      currentRound: Number(currentRound),
      pendingEth: Number(formatUnits(pendingEth, 18)),
      stocks,
      note: "StockBooster drops tokenized stock into activated broker TBAs, weighted by tier.",
    },
    contracts: CONTRACTS,
    explorer: EXPLORER_URL,
    conventions: {
      amounts: "Human units unless _raw / wei fields.",
      nullMeansUnknown: true,
      activationClearedOnTransfer: true,
      walletContentsRemovable: true,
    },
  };
}

export async function getBroker(client: PublicClient, id: number) {
  if (id < 1 || id > 4444) throw new Error("id must be 1-4444");
  const tokenId = BigInt(id);

  const [owner, wallet, funded, activation] = await Promise.all([
    client.readContract({
      address: CONTRACTS.nft,
      abi: stonkBrokersAbi,
      functionName: "ownerOf",
      args: [tokenId],
    }),
    client.readContract({
      address: CONTRACTS.nft,
      abi: stonkBrokersAbi,
      functionName: "tokenWallet",
      args: [tokenId],
    }),
    client.readContract({
      address: CONTRACTS.nft,
      abi: stonkBrokersAbi,
      functionName: "fundedToken",
      args: [tokenId],
    }),
    client.readContract({
      address: CONTRACTS.activationManager,
      abi: activationAbi,
      functionName: "activationOf",
      args: [tokenId],
    }),
  ]);

  const tba = getAddress(wallet);
  const [active, tierIndex] = activation;
  const ethBalance = await client.getBalance({ address: tba });

  const candidates = new Map<string, Address>();
  for (const [symbol, address] of Object.entries(STOCK_TOKENS)) {
    candidates.set(address.toLowerCase(), address);
    void symbol;
  }
  candidates.set(CONTRACTS.stonkbrokerToken.toLowerCase(), CONTRACTS.stonkbrokerToken);
  if (funded && funded !== zeroAddress) {
    candidates.set(funded.toLowerCase(), getAddress(funded));
  }

  const addresses = [...candidates.values()];
  const balances = await multicallBalanceOf(client, tba, addresses);

  const holdings = [];
  for (let i = 0; i < addresses.length; i++) {
    const result = balances[i];
    if (result.status !== "success") continue;
    const balance = result.result as bigint;
    if (balance === 0n) continue;
    const address = addresses[i];
    let symbol = dividendStockSymbols[address.toLowerCase()];
    let decimals = 18;
    if (!symbol) {
      const known = Object.entries(STOCK_TOKENS).find(
        ([, a]) => a.toLowerCase() === address.toLowerCase(),
      );
      if (known) {
        symbol = known[0];
        decimals = TOKEN_DECIMALS[known[0]] ?? 18;
      } else if (address.toLowerCase() === CONTRACTS.stonkbrokerToken.toLowerCase()) {
        symbol = "STONKBROKER";
      } else {
        try {
          symbol = await client.readContract({
            address,
            abi: erc20Abi,
            functionName: "symbol",
          });
          decimals = await client.readContract({
            address,
            abi: erc20Abi,
            functionName: "decimals",
          });
        } catch {
          symbol = address.slice(0, 8);
        }
      }
    }
    holdings.push({
      token: address,
      symbol,
      amount: Number(formatUnits(balance, decimals)),
      amountRaw: balance.toString(),
      decimals,
    });
  }

  const seedSymbol =
    funded && funded !== zeroAddress
      ? dividendStockSymbols[funded.toLowerCase()] ?? funded.slice(0, 8)
      : null;

  return {
    ok: true,
    id,
    owner: getAddress(owner),
    wallet: tba,
    walletUrl: `${EXPLORER_URL}/address/${tba}`,
    opensea: `https://opensea.io/item/robinhood/${CONTRACTS.nft.toLowerCase()}/${id}`,
    activation: {
      active,
      tier: active ? Number(tierIndex) + 1 : null,
      tierIndex: active ? Number(tierIndex) : null,
      weightBps: active ? ACTIVATION_TIERS[Number(tierIndex)]?.weightBps ?? null : null,
      note: "Activation clears on every NFT transfer — buyers must re-activate.",
    },
    seed: seedSymbol
      ? { token: getAddress(funded), symbol: seedSymbol }
      : null,
    ethBalance: Number(formatUnits(ethBalance, 18)),
    ethBalanceRaw: ethBalance.toString(),
    holdings,
    bindingRules: {
      activationSurvivesTransfer: false,
      walletContentsRemovableUntilSale: true,
      tbaTravelsWithNft: true,
    },
  };
}

async function livePoolsForPair(
  client: PublicClient,
  token: Address,
  quote: Address,
  symbol: string,
  quoteSym: string,
) {
  const pools = [];
  for (const fee of FEE_TIERS) {
    const pool = await client.readContract({
      address: CONTRACTS.uniswapV3Factory,
      abi: factoryAbi,
      functionName: "getPool",
      args: [token, quote, fee],
    });
    if (pool === zeroAddress) continue;
    const liquidity = await client.readContract({
      address: pool,
      abi: poolAbi,
      functionName: "liquidity",
    });
    if (liquidity === 0n) continue;
    pools.push({
      fee,
      feePct: fee / 10_000,
      pool: getAddress(pool),
      pair: `${symbol}/${quoteSym}`,
      liquidity: liquidity.toString(),
    });
  }
  return pools;
}

export async function getStockTokens(client: PublicClient) {
  const stockAddrs = await client.readContract({
    address: CONTRACTS.stockBooster,
    abi: stockBoosterAbi,
    functionName: "getStockTokens",
  });

  // Include TSLA (tradable) even if not on StockBooster dividend list
  const uniq = new Map<string, Address>();
  for (const a of stockAddrs as readonly Address[]) uniq.set(a.toLowerCase(), getAddress(a));
  for (const [sym, addr] of Object.entries(STOCK_TOKENS)) {
    if (["WETH", "USDG"].includes(sym)) continue;
    uniq.set(addr.toLowerCase(), addr);
  }

  const tokens = [];
  for (const address of uniq.values()) {
    const symbol =
      dividendStockSymbols[address.toLowerCase()] ??
      Object.entries(STOCK_TOKENS).find(([, a]) => a.toLowerCase() === address.toLowerCase())?.[0] ??
      address.slice(0, 8);
    const wethPools = await livePoolsForPair(client, address, WETH, symbol, "WETH");
    const usdgPools = await livePoolsForPair(client, address, USDG, symbol, "USDG");
    const v4 = await findBestEthStockPool(client, address);
    const routeFromWeth = await findTradeRoute(client, WETH, address);
    const tradeable = v4 != null || routeFromWeth != null;
    tokens.push({
      address: getAddress(address),
      symbol,
      decimals: 18,
      tradeableViaUniswapV3: routeFromWeth != null,
      tradeableViaUniswapV4: v4 != null,
      preferredEngine: v4 ? "v4-universal-router" : routeFromWeth ? "v3-swap-router02" : null,
      routeFromWeth: v4
        ? `v4 ETH/${symbol} fee=${v4.key.fee} tickSpacing=${v4.key.tickSpacing}`
        : routeFromWeth
          ? routeFromWeth.kind === "direct"
            ? `v3 direct fee ${routeFromWeth.fee}`
            : `v3 via ${routeFromWeth.midSymbol} (${routeFromWeth.feeIn}/${routeFromWeth.feeOut})`
          : null,
      wethPools,
      usdgPools,
      v4EthPool: v4
        ? {
            fee: v4.key.fee,
            tickSpacing: v4.key.tickSpacing,
            liquidity: v4.liquidity.toString(),
            poolId: v4.poolId,
          }
        : null,
      note: !tradeable
        ? "No liquid v4 ETH or v3 WETH/USDG route."
        : v4
          ? "Preferred: TBA → UniversalRouter V4_SWAP → PoolManager (native ETH leg)."
          : undefined,
    });
  }

  return {
    ok: true,
    weth: CONTRACTS.weth,
    usdg: USDG,
    router: CONTRACTS.swapRouter02,
    universalRouter: CONTRACTS.universalRouter,
    poolManager: CONTRACTS.poolManager,
    factory: CONTRACTS.uniswapV3Factory,
    tokens,
    alsoKnown: Object.entries(STOCK_TOKENS).map(([symbol, address]) => ({
      symbol,
      address,
    })),
  };
}

export async function getActivationMath(
  client: PublicClient,
  args: { id?: number; tier?: number },
) {
  const totalWeight = await client.readContract({
    address: CONTRACTS.activationManager,
    abi: activationAbi,
    functionName: "totalActiveWeight",
  });

  const tiers = args.tier
    ? ACTIVATION_TIERS.filter((t) => t.tier === args.tier)
    : [...ACTIVATION_TIERS];

  if (args.tier != null && tiers.length === 0) {
    throw new Error("tier must be 1-5");
  }

  const rows = [];
  for (const t of tiers) {
    let fee = t.price as number;
    let feeSource: string = "tier table";
    if (args.id != null) {
      try {
        const quoted = await client.readContract({
          address: CONTRACTS.activationManager,
          abi: activationAbi,
          functionName: "quoteActivation",
          args: [BigInt(args.id), t.tier - 1],
        });
        fee = Number(formatUnits(quoted, 18));
        feeSource = "quoteActivation (exact — credits any tier already paid)";
      } catch {
        feeSource = "tier table (live quote unavailable or tier not upgradeable)";
      }
    }
    const share = t.weightBps / (Number(totalWeight) + t.weightBps);
    rows.push({
      tier: t.tier,
      feeStonkbroker: fee,
      feeSource,
      weightBps: t.weightBps,
      weightX: t.weightBps / 10_000,
      shareOfPoolAfterJoin: share,
      sharePct: share * 100,
      factsNotAdvice:
        "Drop rate tracks Anvil AMM volume and varies; new activations dilute weight; token prices move.",
    });
  }

  return {
    ok: true,
    id: args.id ?? null,
    totalActiveWeight: Number(totalWeight),
    tiers: rows,
  };
}

export async function findBestPool(
  client: PublicClient,
  tokenA: Address,
  tokenB: Address,
  preferredFee?: number,
): Promise<{ pool: Address; fee: number } | null> {
  const fees = preferredFee
    ? [preferredFee, ...FEE_TIERS.filter((f) => f !== preferredFee)]
    : [...FEE_TIERS];

  let best: { pool: Address; fee: number; liquidity: bigint } | null = null;
  for (const fee of fees) {
    const pool = await client.readContract({
      address: CONTRACTS.uniswapV3Factory,
      abi: factoryAbi,
      functionName: "getPool",
      args: [tokenA, tokenB, fee],
    });
    if (pool === zeroAddress) continue;
    const liquidity = await client.readContract({
      address: pool,
      abi: poolAbi,
      functionName: "liquidity",
    });
    // Skip empty pools — slot0 can still quote a price with liquidity=0, but swaps revert.
    if (liquidity === 0n) continue;
    if (!best || liquidity > best.liquidity) {
      best = { pool: getAddress(pool), fee, liquidity };
    }
  }
  return best ? { pool: best.pool, fee: best.fee } : null;
}

export type TradeRoute =
  | { kind: "direct"; pool: Address; fee: number }
  | {
      kind: "multi";
      mid: Address;
      midSymbol: string;
      feeIn: number;
      feeOut: number;
      poolIn: Address;
      poolOut: Address;
    };

/** Direct liquid pool, else multi-hop via USDG (AAPL) or WETH. */
export async function findTradeRoute(
  client: PublicClient,
  tokenIn: Address,
  tokenOut: Address,
  preferredFee?: number,
): Promise<TradeRoute | null> {
  const direct = await findBestPool(client, tokenIn, tokenOut, preferredFee);
  if (direct) return { kind: "direct", pool: direct.pool, fee: direct.fee };

  const mids: Array<{ address: Address; symbol: string }> = [
    { address: USDG, symbol: "USDG" },
    { address: WETH, symbol: "WETH" },
  ];
  for (const mid of mids) {
    if (
      tokenIn.toLowerCase() === mid.address.toLowerCase() ||
      tokenOut.toLowerCase() === mid.address.toLowerCase()
    ) {
      continue;
    }
    const legIn = await findBestPool(client, tokenIn, mid.address);
    const legOut = await findBestPool(client, mid.address, tokenOut);
    if (legIn && legOut) {
      return {
        kind: "multi",
        mid: mid.address,
        midSymbol: mid.symbol,
        feeIn: legIn.fee,
        feeOut: legOut.fee,
        poolIn: legIn.pool,
        poolOut: legOut.pool,
      };
    }
  }
  return null;
}

export async function quoteTradeRoute(
  client: PublicClient,
  route: TradeRoute,
  tokenIn: Address,
  amountIn: bigint,
): Promise<bigint> {
  if (route.kind === "direct") {
    return quoteExactInSpot(client, route.pool, tokenIn, amountIn);
  }
  const midAmount = await quoteExactInSpot(client, route.poolIn, tokenIn, amountIn);
  if (midAmount === 0n) return 0n;
  return quoteExactInSpot(client, route.poolOut, route.mid, midAmount);
}

/** Rough amountOut from slot0 (spot). Not a TWAP — use with slippage floor. */
export async function quoteExactInSpot(
  client: PublicClient,
  pool: Address,
  tokenIn: Address,
  amountIn: bigint,
): Promise<bigint> {
  const [slot0, token0] = await Promise.all([
    client.readContract({ address: pool, abi: poolAbi, functionName: "slot0" }),
    client.readContract({ address: pool, abi: poolAbi, functionName: "token0" }),
  ]);
  const sqrtPriceX96 = slot0[0];
  const zeroForOne = tokenIn.toLowerCase() === token0.toLowerCase();
  // price = (sqrtPriceX96 / 2^96)^2 = token1/token0
  const Q96 = 2n ** 96n;
  if (zeroForOne) {
    // amountOut1 = amountIn0 * price
    return (amountIn * sqrtPriceX96 * sqrtPriceX96) / (Q96 * Q96);
  }
  // amountOut0 = amountIn1 / price
  if (sqrtPriceX96 === 0n) return 0n;
  return (amountIn * Q96 * Q96) / (sqrtPriceX96 * sqrtPriceX96);
}

export function resolveTradeToken(symbolOrAddress: string): {
  symbol: string;
  address: Address;
  decimals: number;
} {
  const key = symbolOrAddress.trim().toUpperCase();
  if (key === "ETH" || key === "NATIVE") {
    return { symbol: "ETH", address: zeroAddress, decimals: 18 };
  }
  if (key === "STONKBROKER" || key === "STONK") {
    return {
      symbol: "STONKBROKER",
      address: CONTRACTS.stonkbrokerToken,
      decimals: 18,
    };
  }
  return resolveToken(symbolOrAddress);
}
