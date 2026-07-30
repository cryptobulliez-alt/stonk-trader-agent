/**
 * After a stop-loss, block re-buying that symbol for a while (anti-churn).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_SL_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6h

type CooldownFile = {
  /** symbol → unix ms when buy is allowed again */
  buyBlockedUntil: Record<string, number>;
};

function dataDir(): string {
  const candidates = [
    join(process.cwd(), "data"),
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "data"),
  ];
  for (const d of candidates) {
    if (existsSync(d)) return d;
  }
  const d = join(process.cwd(), "data");
  mkdirSync(d, { recursive: true });
  return d;
}

function path(): string {
  return join(dataDir(), "cooldowns.json");
}

function load(): CooldownFile {
  try {
    if (!existsSync(path())) return { buyBlockedUntil: {} };
    const raw = JSON.parse(readFileSync(path(), "utf8")) as CooldownFile;
    return { buyBlockedUntil: raw.buyBlockedUntil ?? {} };
  } catch {
    return { buyBlockedUntil: {} };
  }
}

function save(file: CooldownFile) {
  const now = Date.now();
  const cleaned: Record<string, number> = {};
  for (const [k, v] of Object.entries(file.buyBlockedUntil)) {
    if (v > now) cleaned[k] = v;
  }
  writeFileSync(
    path(),
    JSON.stringify({ buyBlockedUntil: cleaned }, null, 2) + "\n",
  );
}

export function isBuyCoolingDown(symbol: string, now = Date.now()): boolean {
  const until = load().buyBlockedUntil[symbol.toUpperCase()];
  return until != null && until > now;
}

export function filterBuyCooldown(symbols: string[]): string[] {
  return symbols.filter((s) => !isBuyCoolingDown(s));
}

export function markStopLossCooldown(
  symbol: string,
  ms = DEFAULT_SL_COOLDOWN_MS,
): void {
  const file = load();
  const key = symbol.toUpperCase();
  const until = Date.now() + ms;
  file.buyBlockedUntil[key] = Math.max(file.buyBlockedUntil[key] ?? 0, until);
  save(file);
}

/** Mega-cap / liquid sleeve candidates for mechanical dry-powder deploys. */
export const CORE_LIQUID_SYMBOLS = [
  "AAPL",
  "MSFT",
  "GOOGL",
  "AMZN",
  "META",
  "NVDA",
  "TSLA",
  "SPY",
  "QQQ",
] as const;

export function isCoreLiquid(symbol: string): boolean {
  return (CORE_LIQUID_SYMBOLS as readonly string[]).includes(
    symbol.toUpperCase(),
  );
}
