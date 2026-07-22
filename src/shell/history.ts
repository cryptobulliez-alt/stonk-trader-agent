import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type HistoryPoint = {
  ts: number;
  totalUsd: number;
  holdings: Record<string, number>;
};

type HistoryFile = {
  tokenId: string;
  points: HistoryPoint[];
};

const MAX_POINTS = 2_000;
/** Don't write another point sooner than this unless forced. */
const MIN_INTERVAL_MS = 60_000;

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

function historyPath(): string {
  return join(dataDir(), "portfolio-history.json");
}

function loadRaw(): HistoryFile {
  const path = historyPath();
  if (!existsSync(path)) {
    return { tokenId: "", points: [] };
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as HistoryFile;
  } catch {
    return { tokenId: "", points: [] };
  }
}

function saveRaw(file: HistoryFile) {
  const path = historyPath();
  // Keep a bak when the series shrinks so a bad write can't erase the night.
  if (existsSync(path)) {
    try {
      const prev = JSON.parse(readFileSync(path, "utf8")) as HistoryFile;
      const prevN = prev.points?.length ?? 0;
      const nextN = file.points.length;
      if (prevN >= 10 && nextN < prevN) {
        writeFileSync(
          path + ".bak",
          JSON.stringify(prev, null, 2) + "\n",
        );
      }
    } catch {
      // ignore bak failures
    }
  }
  writeFileSync(path, JSON.stringify(file, null, 2) + "\n");
}

export function getHistory(tokenId?: string): HistoryFile {
  const file = loadRaw();
  if (tokenId && file.tokenId && file.tokenId !== tokenId) {
    return { tokenId, points: [] };
  }
  return file;
}

/**
 * Append a holdings snapshot (USD per symbol). Throttled unless `force`.
 */
export function recordSnapshot(args: {
  tokenId: string;
  holdings: Array<{ symbol: string; usd: number | null | undefined }>;
  force?: boolean;
}): HistoryPoint | null {
  const holdings: Record<string, number> = {};
  let totalUsd = 0;
  for (const h of args.holdings) {
    const usd = h.usd != null && Number.isFinite(h.usd) ? +h.usd : 0;
    if (usd <= 0) continue;
    const sym = h.symbol.toUpperCase();
    holdings[sym] = +((holdings[sym] ?? 0) + usd).toFixed(4);
    totalUsd += usd;
  }
  totalUsd = +totalUsd.toFixed(4);

  const file = loadRaw();
  if (file.tokenId && file.tokenId !== args.tokenId) {
    // Different broker — start a fresh series
    file.tokenId = args.tokenId;
    file.points = [];
  } else {
    file.tokenId = args.tokenId;
  }

  const now = Date.now();
  const prev = file.points.at(-1);
  if (
    !args.force &&
    prev &&
    now - prev.ts < MIN_INTERVAL_MS &&
    nearEqual(prev.holdings, holdings)
  ) {
    return null;
  }

  const point: HistoryPoint = { ts: now, totalUsd, holdings };
  file.points.push(point);
  if (file.points.length > MAX_POINTS) {
    file.points = file.points.slice(-MAX_POINTS);
  }
  saveRaw(file);
  return point;
}

function nearEqual(a: Record<string, number>, b: Record<string, number>) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const av = a[k] ?? 0;
    const bv = b[k] ?? 0;
    if (Math.abs(av - bv) > 0.05) return false;
  }
  return true;
}

/** Series keys = union across all points, ordered by latest USD weight. */
export function seriesKeys(points: HistoryPoint[]): string[] {
  const last = points.at(-1);
  if (!last) return [];
  const keys = new Set<string>();
  for (const p of points) {
    for (const k of Object.keys(p.holdings)) keys.add(k);
  }
  return [...keys].sort((a, b) => (last.holdings[b] ?? 0) - (last.holdings[a] ?? 0));
}
