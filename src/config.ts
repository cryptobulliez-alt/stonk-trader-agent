import "dotenv/config";
import { type Address, type Hex, isAddress, isHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getStockTokenMap, stockTokenDecimals } from "./assets.js";
import { USDG, WETH } from "./configCash.js";

export { USDG, WETH };

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function optionalEnv(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

/** StonkBrokers NFT collection — the onchain agent identity on Robinhood Chain. */
export const STONKBROKERS_ADDRESS = (
  optionalEnv(
    "STONKBROKERS_ADDRESS",
    "0x539CdD042c2f3d93EbC5BE7DfFf0c79F3B4fAbF0",
  )
) as Address;

export const ERC6551_REGISTRY = "0x28c154CbdeaeCbF5f72B6aE48535ab9A431a4161" as Address;
export const TBA_IMPLEMENTATION = "0xE946075125843aAdb5e40e59f513d929AF507C4B" as Address;

/**
 * Cash rails + full Robinhood stock-token universe from data/assets.json.
 * Prefer Uniswap v4 ETH/stock via UniversalRouter; V3 used as fallback.
 */
export const STOCK_TOKENS: Record<string, Address> = getStockTokenMap();

export const TOKEN_DECIMALS: Record<string, number> = stockTokenDecimals();

export const CHAIN_ID = 4663;
export const EXPLORER_URL = "https://robinhoodchain.blockscout.com";
export const ZEROX_API_URL = "https://api.0x.org";

export type AppConfig = {
  rpcUrl: string;
  privateKey: Hex;
  tokenId: bigint;
  zeroXApiKey: string;
  slippageBps: number;
  dryRun: boolean;
  watchPollMs: number;
  llmApiKey?: string;
  llmProvider: "openai" | "anthropic";
  llmModel?: string;
  x?: {
    apiKey: string;
    apiSecret: string;
    accessToken: string;
    accessSecret: string;
  };
  /** App-only Bearer for recent-search social signals (optional). */
  xBearerToken?: string;
};

function loadXCreds() {
  const xApiKey = optionalEnv("X_API_KEY");
  const xApiSecret = optionalEnv("X_API_SECRET");
  const xAccessToken = optionalEnv("X_ACCESS_TOKEN");
  const xAccessSecret = optionalEnv("X_ACCESS_SECRET");
  const hasX = Boolean(xApiKey && xApiSecret && xAccessToken && xAccessSecret);
  return hasX
    ? {
        apiKey: xApiKey,
        apiSecret: xApiSecret,
        accessToken: xAccessToken,
        accessSecret: xAccessSecret,
      }
    : undefined;
}

export function loadConfig(): AppConfig {
  const privateKey = requireEnv("PRIVATE_KEY") as Hex;
  if (!isHex(privateKey) || privateKey.length !== 66) {
    throw new Error("PRIVATE_KEY must be a 32-byte hex string (0x…)");
  }

  const tokenIdRaw = requireEnv("STONK_TOKEN_ID");
  if (!/^\d+$/.test(tokenIdRaw)) {
    throw new Error("STONK_TOKEN_ID must be a positive integer");
  }

  const providerRaw = optionalEnv("LLM_PROVIDER", "openai").toLowerCase();
  const llmProvider =
    providerRaw === "anthropic" ? "anthropic" : ("openai" as const);

  return {
    rpcUrl: optionalEnv("RH_RPC_URL", "https://rpc.mainnet.chain.robinhood.com"),
    privateKey,
    tokenId: BigInt(tokenIdRaw),
    zeroXApiKey: optionalEnv("ZEROX_API_KEY"),
    slippageBps: Number(optionalEnv("SLIPPAGE_BPS", "100")),
    dryRun: parseBool(process.env.DRY_RUN, true),
    watchPollMs: Number(optionalEnv("WATCH_POLL_MS", "15000")),
    llmApiKey: optionalEnv("LLM_API_KEY") || undefined,
    llmProvider,
    llmModel: optionalEnv("LLM_MODEL") || undefined,
    x: loadXCreds(),
    xBearerToken: optionalEnv("X_BEARER_TOKEN") || undefined,
  };
}

/** Soft config for status APIs — does not throw if wallet missing. */
export function loadEnvStatus() {
  const hasPrivateKey = Boolean(process.env.PRIVATE_KEY?.trim());
  const hasTokenId = Boolean(process.env.STONK_TOKEN_ID?.trim());
  const hasLlm = Boolean(process.env.LLM_API_KEY?.trim());
  const hasX = Boolean(
    process.env.X_API_KEY?.trim() &&
      process.env.X_API_SECRET?.trim() &&
      process.env.X_ACCESS_TOKEN?.trim() &&
      process.env.X_ACCESS_SECRET?.trim(),
  );
  const hasXBearer = Boolean(process.env.X_BEARER_TOKEN?.trim());
  return {
    hasPrivateKey,
    hasTokenId,
    hasLlm,
    hasX,
    hasXBearer,
    dryRun: parseBool(process.env.DRY_RUN, true),
    llmProvider: optionalEnv("LLM_PROVIDER", "openai"),
    tokenId: process.env.STONK_TOKEN_ID?.trim() || null,
    rpcUrl: optionalEnv("RH_RPC_URL", "https://rpc.mainnet.chain.robinhood.com"),
  };
}

/** For MCP tools that only need X posting / dry-run flags (no wallet). */
export function loadXConfig(): Pick<AppConfig, "dryRun" | "x"> {
  return {
    dryRun: parseBool(process.env.DRY_RUN, true),
    x: loadXCreds(),
  };
}

export function resolveToken(symbolOrAddress: string): {
  symbol: string;
  address: Address;
  decimals: number;
} {
  const key = symbolOrAddress.trim().toUpperCase();
  if (STOCK_TOKENS[key]) {
    return {
      symbol: key,
      address: STOCK_TOKENS[key],
      decimals: TOKEN_DECIMALS[key] ?? 18,
    };
  }
  if (isAddress(symbolOrAddress)) {
    const address = symbolOrAddress as Address;
    const known = Object.entries(STOCK_TOKENS).find(
      ([, a]) => a.toLowerCase() === address.toLowerCase(),
    );
    return {
      symbol: known?.[0] ?? address.slice(0, 8),
      address,
      decimals: known ? (TOKEN_DECIMALS[known[0]] ?? 18) : 18,
    };
  }
  throw new Error(
    `Unknown token "${symbolOrAddress}". Use a known symbol or an address.`,
  );
}

export function ownerAccount(privateKey: Hex) {
  return privateKeyToAccount(privateKey);
}
