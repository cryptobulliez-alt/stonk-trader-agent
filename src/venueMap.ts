/**
 * Cached per-token v3/v4 tradeability from `npm run scan:venues` → data/venueMap.json.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type VenueTokenRow = {
  symbol: string;
  address: string;
  v3: null | { ok: boolean; detail: string; vsMarkBps?: number };
  v4: null | { ok: boolean; detail: string; vsMarkBps?: number };
  tradeable: boolean;
  preferred: "v3" | "v4" | null;
};

export type VenueMapFile = {
  scannedAt: string;
  amountInEth: string;
  maxExecVsMarkBps: number;
  total: number;
  tradeable: number;
  v3Only: number;
  v4Only: number;
  both: number;
  none: number;
  tokens: VenueTokenRow[];
};

let cached: VenueMapFile | null = null;
let cachedPath: string | null = null;

function venueMapPath(): string | null {
  const candidates = [
    join(process.cwd(), "data", "venueMap.json"),
    join(dirname(fileURLToPath(import.meta.url)), "..", "data", "venueMap.json"),
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "data", "venueMap.json"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

export function loadVenueMap(): VenueMapFile | null {
  const path = venueMapPath();
  if (!path) return null;
  if (cached && cachedPath === path) return cached;
  try {
    cached = JSON.parse(readFileSync(path, "utf8")) as VenueMapFile;
    cachedPath = path;
    return cached;
  } catch {
    return null;
  }
}

export function getVenueForSymbol(symbol: string): VenueTokenRow | null {
  const map = loadVenueMap();
  if (!map) return null;
  const key = symbol.trim().toUpperCase();
  return map.tokens.find((t) => t.symbol === key) ?? null;
}

export function venueBadge(row: VenueTokenRow | null): {
  label: string;
  tradeableOnChain: boolean | null;
} {
  if (!row) return { label: "?", tradeableOnChain: null };
  if (!row.tradeable) return { label: "no pool", tradeableOnChain: false };
  if (row.v3?.ok && row.v4?.ok) return { label: "v3+v4", tradeableOnChain: true };
  if (row.v4?.ok) return { label: "v4", tradeableOnChain: true };
  if (row.v3?.ok) return { label: "v3", tradeableOnChain: true };
  return { label: "no pool", tradeableOnChain: false };
}
