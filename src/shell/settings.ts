import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ManagePolicy } from "../portfolioManage.js";

export type ShellSettings = {
  policy: ManagePolicy;
  reserveWethPct: number;
  deployPct: number;
  intervalMs: number;
  allowlist: string[];
  maxNotionalEth: number;
  maxActionsPerPass: number;
  postToX: boolean;
  thesis: string;
  /** When true, prepare/log only — no broadcast. When false, live txs. */
  dryRun: boolean;
  /** Skip swaps below this USD notional (fee-aware). */
  minNotionalUsd: number;
  /** Buys must clear notional × this bps vs estimated gas+slip round-trip. */
  minEdgeBps: number;
  /** Take-profit trim when unrealized P&L % ≥ this. */
  takeProfitPct: number;
  /** Cut-loss trim when unrealized P&L % ≤ -this. */
  stopLossPct: number;
  /** Only add to a name when mark is at least this many bps below avg cost. */
  addOnlyDipBps: number;
  /** Optional gas ETH/step override; else trade-log average. */
  estimateGasEth?: number;
};

const DEFAULTS: ShellSettings = {
  policy: "core",
  reserveWethPct: 30,
  deployPct: 15,
  intervalMs: 300_000,
  allowlist: ["NVDA", "AAPL", "AMZN", "TSLA", "META", "GOOGL", "MSFT", "PLTR"],
  maxNotionalEth: 0.05,
  maxActionsPerPass: 3,
  postToX: true,
  thesis: "",
  dryRun: true,
  minNotionalUsd: 3,
  minEdgeBps: 10,
  takeProfitPct: 3,
  stopLossPct: 2.5,
  addOnlyDipBps: 50,
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

function settingsPath(): string {
  return join(dataDir(), "settings.json");
}

function examplePath(): string {
  return join(dataDir(), "settings.example.json");
}

export function loadSettings(): ShellSettings {
  const path = settingsPath();
  if (!existsSync(path)) {
    const ex = examplePath();
    if (existsSync(ex)) {
      writeFileSync(path, readFileSync(ex, "utf8"));
    } else {
      writeFileSync(path, JSON.stringify(DEFAULTS, null, 2) + "\n");
    }
  }
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<ShellSettings>;
    return normalize({ ...DEFAULTS, ...raw });
  } catch {
    return { ...DEFAULTS };
  }
}

function normalize(s: ShellSettings): ShellSettings {
  return {
    policy: s.policy || "core",
    reserveWethPct: clamp(Number(s.reserveWethPct) || 30, 0, 100),
    deployPct: clamp(Number(s.deployPct) || 15, 1, 100),
    intervalMs: Math.max(30_000, Number(s.intervalMs) || 300_000),
    allowlist: Array.isArray(s.allowlist)
      ? s.allowlist.map((x) => String(x).toUpperCase()).filter(Boolean)
      : DEFAULTS.allowlist,
    maxNotionalEth: Math.max(0, Number(s.maxNotionalEth) || 0.05),
    maxActionsPerPass: clamp(Number(s.maxActionsPerPass) || 3, 1, 10),
    postToX: Boolean(s.postToX),
    thesis: typeof s.thesis === "string" ? s.thesis : "",
    dryRun: s.dryRun === undefined ? true : Boolean(s.dryRun),
    minNotionalUsd: Math.max(1, Number(s.minNotionalUsd) || 3),
    minEdgeBps: clamp(Number(s.minEdgeBps) || 10, 0, 500),
    takeProfitPct: clamp(Math.max(0, Number(s.takeProfitPct) || 3), 0, 100),
    stopLossPct: clamp(Math.max(0, Number(s.stopLossPct) || 2.5), 0, 100),
    addOnlyDipBps: clamp(Number(s.addOnlyDipBps) || 50, 0, 2000),
    estimateGasEth:
      s.estimateGasEth != null && Number(s.estimateGasEth) > 0
        ? Number(s.estimateGasEth)
        : undefined,
  };
}

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

export function saveSettings(patch: Partial<ShellSettings>): ShellSettings {
  const next = normalize({ ...loadSettings(), ...patch });
  writeFileSync(settingsPath(), JSON.stringify(next, null, 2) + "\n");
  return next;
}
