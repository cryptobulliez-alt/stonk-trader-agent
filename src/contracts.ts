import { type Address } from "viem";
import {
  STONKBROKERS_ADDRESS,
  WETH,
  STOCK_TOKENS,
} from "./config.js";

/** StonkBrokers protocol contracts on Robinhood Chain (mainnet). */
export const CONTRACTS = {
  nft: STONKBROKERS_ADDRESS,
  stonkbrokerToken: "0xe934e36a439c94017b64a3fece66af12099abf50" as Address,
  activationManager: "0xacd5ae3c060c1137fe2ee86b0ab2ef697456f664" as Address,
  stockBooster: "0x038a7f4e4e89448ad74e044337c9ac25c11e726b" as Address,
  ammVault: "0xe302733accf4800146e55fc45b46b4e4ffc032d2" as Address,
  swapRouter02: "0xcaf681a66d020601342297493863e78c959e5cb2" as Address,
  uniswapV3Factory: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA" as Address,
  /** Uniswap v4 — used by live TBA trading bots on Robinhood Chain */
  poolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951" as Address,
  universalRouter: "0x8876789976dEcBfCbBbe364623C63652db8C0904" as Address,
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address,
  v4StateView: "0xF3334192D15450CdD385c8B70e03f9A6bD9E673b" as Address,
  v4Quoter: "0x628c00B016415Ef530552063faE4154B0CdEb0Ac" as Address,
  weth: WETH,
} as const;

/** Display tiers 1–5 (on-chain activate/quote use zero-based index = tier - 1). */
export const ACTIVATION_TIERS = [
  { tier: 1, price: 66_666, weightBps: 10_000 },
  { tier: 2, price: 166_666, weightBps: 12_500 },
  { tier: 3, price: 366_666, weightBps: 16_000 },
  { tier: 4, price: 666_666, weightBps: 20_000 },
  { tier: 5, price: 1_666_666, weightBps: 33_300 },
] as const;

export const FEE_TIERS = [100, 500, 3000, 10000] as const;

export const activationAbi = [
  {
    type: "function",
    name: "TIER_COUNT",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
  {
    type: "function",
    name: "tiers",
    stateMutability: "view",
    inputs: [{ name: "index", type: "uint256" }],
    outputs: [
      { name: "price", type: "uint256" },
      { name: "weightBps", type: "uint16" },
    ],
  },
  {
    type: "function",
    name: "activationOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [
      { name: "active", type: "bool" },
      { name: "tier", type: "uint8" },
    ],
  },
  {
    type: "function",
    name: "quoteActivation",
    stateMutability: "view",
    inputs: [
      { name: "tokenId", type: "uint256" },
      { name: "tier", type: "uint8" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "activate",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tokenId", type: "uint256" },
      { name: "tier", type: "uint8" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "activeCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "totalActiveWeight",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
] as const;

export const stockBoosterAbi = [
  {
    type: "function",
    name: "getStockTokens",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { type: "address" },
      { type: "address" },
      { type: "address" },
    ],
  },
  {
    type: "function",
    name: "stockTokens",
    stateMutability: "view",
    inputs: [{ type: "uint256" }],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "pendingEth",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "currentRound",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "router",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
] as const;

export const factoryAbi = [
  {
    type: "function",
    name: "getPool",
    stateMutability: "view",
    inputs: [
      { name: "tokenA", type: "address" },
      { name: "tokenB", type: "address" },
      { name: "fee", type: "uint24" },
    ],
    outputs: [{ type: "address" }],
  },
] as const;

export const poolAbi = [
  {
    type: "function",
    name: "slot0",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "observationIndex", type: "uint16" },
      { name: "observationCardinality", type: "uint16" },
      { name: "observationCardinalityNext", type: "uint16" },
      { name: "feeProtocol", type: "uint8" },
      { name: "unlocked", type: "bool" },
    ],
  },
  {
    type: "function",
    name: "token0",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "token1",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "liquidity",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint128" }],
  },
] as const;

export const swapRouterAbi = [
  {
    type: "function",
    name: "exactInputSingle",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "recipient", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
  {
    type: "function",
    name: "exactInput",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "path", type: "bytes" },
          { name: "recipient", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;

export const dividendStockSymbols: Record<string, string> = {
  [STOCK_TOKENS.AAPL.toLowerCase()]: "AAPL",
  [STOCK_TOKENS.AMZN.toLowerCase()]: "AMZN",
  [STOCK_TOKENS.NVDA.toLowerCase()]: "NVDA",
};
