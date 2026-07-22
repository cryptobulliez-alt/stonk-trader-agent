import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Address, getAddress } from "viem";
import { USDG, WETH } from "./configCash.js";

export type RhAsset = {
  id: string;
  tokenSymbol: string;
  tokenName: string;
  deployments: Array<{ contractAddress: string; chainId: number }>;
  currentMultiplier: string;
  pendingMultiplier: string;
  status: string;
  logoUrl: string;
  tradingCapabilities?: {
    market?: { whole?: string; fractional?: string };
    extended?: { whole?: string; fractional?: string };
    overnight?: { whole?: string; fractional?: string };
  };
};

export type StockAssetMeta = {
  symbol: string;
  name: string;
  address: Address;
  logoUrl: string;
  status: string;
  currentMultiplier: string;
  tradable: boolean;
};

function findDataFile(name: string): string {
  const candidates = [
    join(process.cwd(), "data", name),
    join(process.cwd(), "..", "data", name),
    join(dirname(fileURLToPath(import.meta.url)), "..", "data", name),
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "data", name),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error(
    `Missing data/${name}. Copy Robinhood assets dump to data/assets.json at the repo root.`,
  );
}

let cached: {
  assets: StockAssetMeta[];
  stockTokens: Record<string, Address>;
  byAddress: Map<string, StockAssetMeta>;
} | null = null;

function loadUniverse() {
  if (cached) return cached;
  const raw = JSON.parse(readFileSync(findDataFile("assets.json"), "utf8")) as {
    assets: RhAsset[];
  };
  const assets: StockAssetMeta[] = [];
  const stockTokens: Record<string, Address> = { USDG, WETH };
  const byAddress = new Map<string, StockAssetMeta>();

  for (const a of raw.assets) {
    const dep = a.deployments?.find((d) => d.chainId === 4663) ?? a.deployments?.[0];
    if (!dep?.contractAddress) continue;
    const symbol = a.tokenSymbol.trim().toUpperCase();
    const address = getAddress(dep.contractAddress);
    const tradable =
      a.tradingCapabilities?.market?.whole === "TRADING_STATUS_TRADABLE" ||
      a.status === "ASSET_STATUS_ACTIVE";
    const meta: StockAssetMeta = {
      symbol,
      name: a.tokenName,
      address,
      logoUrl: a.logoUrl,
      status: a.status,
      currentMultiplier: a.currentMultiplier || "1",
      tradable,
    };
    assets.push(meta);
    stockTokens[symbol] = address;
    byAddress.set(address.toLowerCase(), meta);
  }

  cached = { assets, stockTokens, byAddress };
  return cached;
}

/** Cash rails + all Robinhood stock tokens from data/assets.json */
export function getStockTokenMap(): Record<string, Address> {
  return { ...loadUniverse().stockTokens };
}

export function listStockAssets(): StockAssetMeta[] {
  return loadUniverse().assets;
}

export function getAssetBySymbol(symbol: string): StockAssetMeta | undefined {
  const key = symbol.trim().toUpperCase();
  return loadUniverse().assets.find((a) => a.symbol === key);
}

export function getAssetByAddress(address: string): StockAssetMeta | undefined {
  return loadUniverse().byAddress.get(address.toLowerCase());
}

export function stockTokenDecimals(): Record<string, number> {
  const decimals: Record<string, number> = { USDG: 6, WETH: 18 };
  for (const a of loadUniverse().assets) {
    decimals[a.symbol] = 18;
  }
  return decimals;
}
