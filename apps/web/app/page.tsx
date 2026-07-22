"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from "react";
import {
  HoldingsChart,
  type HistoryPoint,
} from "../components/HoldingsChart";

type Tab = "live" | "portfolio" | "log" | "settings";

const TABS: Tab[] = ["live", "portfolio", "log", "settings"];

function tabFromHash(): Tab {
  if (typeof window === "undefined") return "live";
  const h = window.location.hash.replace(/^#/, "").toLowerCase();
  return (TABS as string[]).includes(h) ? (h as Tab) : "live";
}

type TradeEntry = {
  id: string;
  ts: number;
  tokenId: string;
  side: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  notionalUsd?: number;
  reason?: string;
  dryRun: boolean;
  status: "filled" | "dry_run" | "error";
  txs: Array<{
    what: string;
    hash: string;
    url: string | null;
    valueEth?: number;
    valueUsd?: number;
    gasFeeEth?: number;
    gasFeeUsd?: number;
  }>;
  valueEth?: number;
  valueUsd?: number;
  gasFeeEth?: number;
  gasFeeUsd?: number;
  error?: string;
};

type TradeTotals = {
  swaps: number;
  filled: number;
  dryRun: number;
  errors: number;
  gasFeeEth: number;
  gasFeeUsd: number;
  valueEth: number;
  valueUsd: number;
  txCount: number;
};

type Status = {
  env: {
    hasPrivateKey: boolean;
    hasTokenId: boolean;
    hasLlm: boolean;
    hasX: boolean;
    dryRun: boolean;
    llmProvider: string;
    tokenId: string | null;
  };
  settings: Settings;
  agent: {
    state: string;
    running: boolean;
    lastThesis: string;
    lastError: string | null;
    nextPassAt?: number | null;
    passInFlight?: boolean;
  };
  balances?: {
    eoa: string;
    eoaEth: number;
    tba: string | null;
    tbaEth: number | null;
    ethUsd: number | null;
    eoaGasWarn?: {
      low: boolean;
      critical: boolean;
      haveEth: number;
      needEth: number;
      haveUsd: number | null;
      message: string;
    } | null;
  } | null;
  events?: ShellEvent[];
  canBroadcast: boolean;
  shellUrl?: string;
};

type Settings = {
  policy: string;
  reserveWethPct: number;
  deployPct: number;
  intervalMs: number;
  allowlist: string[];
  maxNotionalEth: number;
  maxActionsPerPass: number;
  postToX: boolean;
  useXSignals: boolean;
  researchRails: "auto" | "always" | "off";
  swapVenue: "auto" | "v3" | "v4";
  maxExecVsMarkBps: number;
  thesis: string;
  dryRun: boolean;
  minNotionalUsd: number;
  minEdgeBps: number;
  takeProfitPct: number;
  stopLossPct: number;
  addOnlyDipBps: number;
  maxRiskPctPerTrade: number;
  estimateGasEth?: number;
  llmModel?: string;
};

type ShellEvent = {
  id: string;
  ts: number;
  type: string;
  message: string;
  data?: unknown;
};

type Asset = {
  symbol: string;
  name: string;
  address: string;
  logoUrl: string;
  tradable: boolean;
  /** From data/venueMap.json — null if not scanned yet. */
  onChainTradeable?: boolean | null;
  venue?: string;
  preferredVenue?: "v3" | "v4" | null;
  v3?: boolean | null;
  v4?: boolean | null;
};

type BrokerInfo = {
  tokenId: string;
  owner: string;
  tba: string;
  name: string | null;
  image: string | null;
  attributes: Array<{ trait_type: string; value: string }> | null;
};

type Portfolio = {
  broker: BrokerInfo;
  analysis: {
    contentsUsd: number | null;
    cashUsd: number | null;
    cashPct: number | null;
    targetCashPct: number | null;
    holdings: Array<{
      symbol: string;
      amount: number;
      usd: number | null;
      weightPct: number | null;
      priceUsd?: number | null;
      avgCostUsd?: number | null;
      avgCostWeth?: number | null;
      markUsd?: number | null;
      markWeth?: number | null;
      unrealizedPnlUsd?: number | null;
      unrealizedPnlUsdPct?: number | null;
      unrealizedPnlWeth?: number | null;
      unrealizedPnlWethPct?: number | null;
      unrealizedPnlPct?: number | null;
      costBasisUsd?: number | null;
      costBasisWeth?: number | null;
      realizedPnlUsd?: number;
      realizedPnlWeth?: number;
      lastBuyPrice?: number | null;
      lastSellPrice?: number | null;
      seeded?: boolean;
    }>;
    actions: Array<{
      action: string;
      reason: string;
      side?: string;
      amountIn?: string;
      tokenIn?: string;
      tokenOut?: string;
    }>;
  };
  ledger?: {
    fills: Array<{
      ts: number;
      side: string;
      symbol: string;
      qty: number;
      priceUsd: number;
      notionalUsd: number;
      dryRun: boolean;
      seeded?: boolean;
      reason?: string;
    }>;
    positions?: Record<
      string,
      {
        symbol: string;
        qty: number;
        costUsd: number;
        avgCostUsd: number;
        costWeth?: number;
        avgCostWeth?: number;
        realizedPnlUsd: number;
        realizedPnlWeth?: number;
        seeded: boolean;
      }
    >;
  };
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
  const json = await res.json();
  if (!res.ok || json.ok === false) {
    throw new Error(json.error || res.statusText);
  }
  return json as T;
}

function shortAddr(addr: string) {
  if (addr.length < 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/** Turn http(s) URLs in plain text into new-tab links. */
function linkify(text: string) {
  const re = /(https?:\/\/[^\s]+)/g;
  const parts = text.split(re);
  return parts.map((part, i) => {
    if (/^https?:\/\//.test(part)) {
      const href = part.replace(/[.,;:!?)]+$/, "");
      const trailing = part.slice(href.length);
      return (
        <span key={i}>
          <a href={href} target="_blank" rel="noreferrer">
            {href}
          </a>
          {trailing}
        </span>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

/** Settings label with hover tooltip overlay. */
function TipLabel({
  tip,
  children,
}: {
  tip: string;
  children: ReactNode;
}) {
  return (
    <label className="tip-label">
      <span className="tip-label-text">{children}</span>
      <span className="tip-bubble" role="tooltip">
        {tip}
      </span>
    </label>
  );
}

const SETTING_TIPS = {
  policy:
    "Trading policy for each pass. core = cash reserve + selective sleeve buys/sells (recommended). Others are manual/legacy modes.",
  reserveWethPct:
    "Target cash share (WETH+ETH) of the book. Below this → sells only to restore dry powder. Default 30. Max 100.",
  deployPct:
    "Max % of total book value that can be spent on new buys in a single pass. Caps how fast dry powder is deployed. Max 100.",
  intervalMs:
    "How often autopilot runs when Run is active (hours / minutes / seconds). Minimum 30 seconds. Once ignores this.",
  maxNotionalEth:
    "Hard cap on WETH/ETH amountIn for a single buy. Skips larger prepared tickets.",
  maxActionsPerPass:
    "Max swaps prepared/signed per pass (buys + sells). Keeps passes from spraying many small txs.",
  minNotionalUsd:
    "Minimum USD size for a scheduled swap. Smaller tickets are skipped (fee protection).",
  minEdgeBps:
    "Preferred buy edge in bps vs round-trip gas+slip. On small books, buys still pass if the ticket is ≥10× estimated entry fees (and under 8% fee drag).",
  takeProfitPct:
    "Trim when WETH-relative unrealized P&L % ≥ this (stock beat idle WETH). Banks gains into cash. Max 100.",
  stopLossPct:
    "Cut/trim when WETH-relative unrealized P&L % ≤ −this (stock underperformed idle WETH). Risk exit — clears fee gate at min notional even when dollar uPnL is negative.",
  maxRiskPctPerTrade:
    "Max % of book at risk if stopLossPct hits on a new open. Caps buy size: book × this / stopLossPct (position-sizing skill).",
  addOnlyDipBps:
    "Only add to an existing position if mark is at least this many bps below avg cost in WETH (don’t chase strength into fees).",
  estimateGasEth:
    "Optional gas ETH cost per TBA step for fee estimates. Leave blank to use the trailing average from the trade log.",
  allowlist:
    "Candidate universe for thesis picks — not a must-buy list. Autopilot opens 1–2 names from here via LLM/preferBuys.",
  thesis:
    "Operator notes for the LLM (can name tickers). Used as context; tickers mentioned here can seed preferBuys if LLM is off.",
  postToX:
    "When yes, post a templated tweet after dry-run or live fills. Dry run does not block X.",
  useXSignals:
    "When yes and X_BEARER_TOKEN is set, fetch cashtag buzz only when Research rails says the pass needs research (not every pass in auto mode).",
  researchRails:
    "auto = skip LLM/X when TP/SL, cash-restore, or near-target hold are obvious from marks; always = every pass; off = never call LLM/X.",
  swapVenue:
    "Which Uniswap engine to use for ETH/WETH↔stock. auto = probe v3 and v4 and pick the mark-sane quote (recommended — many names only have real v3 liquidity). v3 / v4 = force that venue when it clears the mark gate.",
  maxExecVsMarkBps:
    "Max % (in bps) an executable quote may sit under the independent mark before refuse. Default 2500 = 25%. Allows thin multi-hop books; still blocks wrong-pool dust. Range 100–5000.",
  dryRun:
    "ON = prepare and log only, no chain broadcast. OFF = live TBA txs. Toggle also available on the Live tab.",
  llmModel:
    "Chat model for thesis / preferBuys each autopilot pass. Listed from the connected provider API when possible.",
} as const;

/**
 * Number input that allows clearing while typing; clamps/validates on blur.
 */
function SettingsNumber({
  value,
  onCommit,
  min = 0,
  max,
  step,
  placeholder,
  optional,
}: {
  value: number | undefined;
  onCommit: (n: number | undefined) => void;
  min?: number;
  max?: number;
  step?: string | number;
  placeholder?: string;
  /** Empty on blur clears to undefined instead of min/default. */
  optional?: boolean;
}) {
  const [text, setText] = useState(
    value == null || !Number.isFinite(value) ? "" : String(value),
  );
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (focused) return;
    setText(value == null || !Number.isFinite(value) ? "" : String(value));
  }, [value, focused]);

  function commit(raw: string) {
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed === "-" || trimmed === ".") {
      if (optional) {
        onCommit(undefined);
        setText("");
        return;
      }
      const fallback = min;
      onCommit(fallback);
      setText(String(fallback));
      return;
    }
    let n = Number(trimmed);
    if (!Number.isFinite(n)) {
      setText(value == null ? "" : String(value));
      return;
    }
    if (min != null) n = Math.max(min, n);
    if (max != null) n = Math.min(max, n);
    onCommit(n);
    setText(String(n));
  }

  return (
    <input
      type="text"
      inputMode="decimal"
      step={step}
      placeholder={placeholder}
      value={text}
      onFocus={() => setFocused(true)}
      onChange={(e) => {
        const v = e.target.value;
        // Allow empty / partial numeric typing
        if (v === "" || /^-?\d*\.?\d*$/.test(v)) setText(v);
      }}
      onBlur={() => {
        setFocused(false);
        commit(text);
      }}
    />
  );
}

function msToHms(ms: number): { h: number; m: number; s: number } {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return { h, m, s };
}

function hmsToMs(h: number, m: number, s: number): number {
  return Math.max(0, h) * 3_600_000 + Math.max(0, m) * 60_000 + Math.max(0, s) * 1000;
}

function formatIntervalLabel(ms: number): string {
  const { h, m, s } = msToHms(ms);
  const parts: string[] = [];
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (s || !parts.length) parts.push(`${s}s`);
  return parts.join(" ");
}

function IntervalDurationField({
  ms,
  onCommit,
}: {
  ms: number;
  onCommit: (ms: number) => void;
}) {
  const parts = msToHms(ms);
  const [h, setH] = useState(String(parts.h));
  const [m, setM] = useState(String(parts.m));
  const [s, setS] = useState(String(parts.s));
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (focused) return;
    const next = msToHms(ms);
    setH(String(next.h));
    setM(String(next.m));
    setS(String(next.s));
  }, [ms, focused]);

  function commitAll(nextH: string, nextM: string, nextS: string) {
    const hh = Math.max(0, Math.floor(Number(nextH) || 0));
    let mm = Math.max(0, Math.floor(Number(nextM) || 0));
    let ss = Math.max(0, Math.floor(Number(nextS) || 0));
    // Normalize overflow (e.g. 90s → 1m 30s)
    if (ss >= 60) {
      mm += Math.floor(ss / 60);
      ss = ss % 60;
    }
    if (mm >= 60) {
      const addH = Math.floor(mm / 60);
      mm = mm % 60;
      onCommit(Math.max(30_000, hmsToMs(hh + addH, mm, ss)));
    } else {
      onCommit(Math.max(30_000, hmsToMs(hh, mm, ss)));
    }
  }

  function onPartBlur() {
    setFocused(false);
    commitAll(h, m, s);
  }

  function bindPart(
    value: string,
    set: (v: string) => void,
  ) {
    return {
      value,
      onFocus: () => setFocused(true),
      onChange: (e: ChangeEvent<HTMLInputElement>) => {
        const v = e.target.value;
        if (v === "" || /^\d*$/.test(v)) set(v);
      },
      onBlur: onPartBlur,
    };
  }

  return (
    <div className="interval-hms">
      <div className="interval-hms-row">
        <label className="interval-part">
          <input
            type="text"
            inputMode="numeric"
            aria-label="Hours"
            {...bindPart(h, setH)}
          />
          <span>hr</span>
        </label>
        <label className="interval-part">
          <input
            type="text"
            inputMode="numeric"
            aria-label="Minutes"
            {...bindPart(m, setM)}
          />
          <span>min</span>
        </label>
        <label className="interval-part">
          <input
            type="text"
            inputMode="numeric"
            aria-label="Seconds"
            {...bindPart(s, setS)}
          />
          <span>sec</span>
        </label>
      </div>
      <div className="interval-hms-hint">{formatIntervalLabel(ms)}</div>
    </div>
  );
}

function fmtUsd(n: number | null | undefined, digits = 2) {
  if (n == null || !Number.isFinite(n)) return "—";
  return `$${n.toFixed(digits)}`;
}

function fmtPnl(n: number | null | undefined, pct: number | null | undefined) {
  if (n == null || !Number.isFinite(n)) return { text: "—", cls: "pnl-flat" };
  const sign = n > 0 ? "+" : "";
  const pctPart =
    pct != null && Number.isFinite(pct) ? ` (${sign}${pct.toFixed(1)}%)` : "";
  return {
    text: `${sign}${n.toFixed(2)}${pctPart}`,
    cls: n > 0.005 ? "pnl-up" : n < -0.005 ? "pnl-down" : "pnl-flat",
  };
}

function fmtWethPnl(
  weth: number | null | undefined,
  pct: number | null | undefined,
) {
  if (weth == null || !Number.isFinite(weth)) {
    return { text: "—", cls: "pnl-flat" };
  }
  const sign = weth > 0 ? "+" : "";
  const pctPart =
    pct != null && Number.isFinite(pct) ? ` (${sign}${pct.toFixed(1)}%)` : "";
  const abs = Math.abs(weth);
  const digits = abs >= 0.01 ? 4 : 6;
  return {
    text: `${sign}${weth.toFixed(digits)} ETH${pctPart}`,
    cls: weth > 1e-8 ? "pnl-up" : weth < -1e-8 ? "pnl-down" : "pnl-flat",
  };
}

const CASH_SYMS = new Set(["WETH", "ETH", "USDG", "STONKBROKER"]);

function portfolioPnlSummary(
  portfolio: Portfolio,
  points: HistoryPoint[],
) {
  let unrealizedWeth = 0;
  let costBasisWeth = 0;
  let unrealizedUsd = 0;
  let costBasisUsd = 0;
  let hasPnl = false;
  for (const h of portfolio.analysis.holdings) {
    if (CASH_SYMS.has(h.symbol)) continue;
    if (h.unrealizedPnlWeth != null && Number.isFinite(h.unrealizedPnlWeth)) {
      unrealizedWeth += h.unrealizedPnlWeth;
      hasPnl = true;
    }
    if (h.costBasisWeth != null && Number.isFinite(h.costBasisWeth)) {
      costBasisWeth += h.costBasisWeth;
    } else if (h.avgCostWeth != null && h.amount > 0) {
      costBasisWeth += h.avgCostWeth * h.amount;
    }
    if (h.unrealizedPnlUsd != null && Number.isFinite(h.unrealizedPnlUsd)) {
      unrealizedUsd += h.unrealizedPnlUsd;
      hasPnl = true;
    }
    if (h.costBasisUsd != null && Number.isFinite(h.costBasisUsd)) {
      costBasisUsd += h.costBasisUsd;
    } else if (h.avgCostUsd != null && h.amount > 0) {
      costBasisUsd += h.avgCostUsd * h.amount;
    }
  }
  let realizedWeth = 0;
  let realizedUsd = 0;
  if (portfolio.ledger?.positions) {
    for (const p of Object.values(portfolio.ledger.positions)) {
      realizedUsd += p.realizedPnlUsd || 0;
      realizedWeth += (p as { realizedPnlWeth?: number }).realizedPnlWeth || 0;
    }
  }
  const unrealizedPct =
    costBasisWeth > 0
      ? (unrealizedWeth / costBasisWeth) * 100
      : costBasisUsd > 0
        ? (unrealizedUsd / costBasisUsd) * 100
        : null;

  // Overall / period P&L = book change across the chart (first → latest snapshot)
  const first = points[0];
  const last = points.at(-1);
  let periodPnl: number | null = null;
  let periodPct: number | null = null;
  let periodFrom: number | null = null;
  let periodTo: number | null = null;
  if (first && last && points.length >= 2) {
    periodFrom = first.totalUsd;
    periodTo = last.totalUsd;
    periodPnl = +(last.totalUsd - first.totalUsd).toFixed(4);
    periodPct =
      first.totalUsd > 0
        ? +(((last.totalUsd - first.totalUsd) / first.totalUsd) * 100).toFixed(2)
        : null;
  }

  return {
    book: portfolio.analysis.contentsUsd,
    costBasis: costBasisWeth > 0 ? costBasisWeth : costBasisUsd > 0 ? costBasisUsd : null,
    costBasisWeth: costBasisWeth > 0 ? costBasisWeth : null,
    costBasisUsd: costBasisUsd > 0 ? costBasisUsd : null,
    unrealized: hasPnl
      ? costBasisWeth > 0
        ? unrealizedWeth
        : unrealizedUsd
      : null,
    unrealizedWeth: hasPnl ? unrealizedWeth : null,
    unrealizedUsd: hasPnl ? unrealizedUsd : null,
    unrealizedPct,
    realized: realizedWeth || realizedUsd,
    realizedWeth,
    realizedUsd,
    periodPnl,
    periodPct,
    periodFrom,
    periodTo,
  };
}

function pnlClass(n: number | null | undefined) {
  if (n == null || !Number.isFinite(n)) return "pnl-flat";
  if (n > 0.005) return "pnl-up";
  if (n < -0.005) return "pnl-down";
  return "pnl-flat";
}

function pnlClassWeth(n: number | null | undefined) {
  if (n == null || !Number.isFinite(n)) return "pnl-flat";
  if (n > 1e-8) return "pnl-up";
  if (n < -1e-8) return "pnl-down";
  return "pnl-flat";
}

function moneySigned(n: number) {
  return n >= 0 ? `+$${n.toFixed(2)}` : `-$${Math.abs(n).toFixed(2)}`;
}

function wethSigned(n: number) {
  const abs = Math.abs(n);
  const digits = abs >= 0.01 ? 4 : 6;
  return n >= 0
    ? `+${n.toFixed(digits)} ETH`
    : `-${abs.toFixed(digits)} ETH`;
}

function pctSigned(n: number) {
  return n >= 0 ? `+${n.toFixed(1)}%` : `-${Math.abs(n).toFixed(1)}%`;
}

function mergeEvents(prev: ShellEvent[], incoming: ShellEvent[]): ShellEvent[] {
  const map = new Map<string, ShellEvent>();
  for (const e of prev) map.set(e.id, e);
  for (const e of incoming) map.set(e.id, e);
  return [...map.values()]
    .sort((a, b) => a.ts - b.ts)
    .slice(-120);
}

function LoadingBlock({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="loading-block" role="status" aria-live="polite">
      <div className="loading-bars" aria-hidden>
        <span />
        <span />
        <span />
        <span />
        <span />
      </div>
      <span className="loading-label">{label}</span>
    </div>
  );
}

function LoadingInline({ label = "Refreshing" }: { label?: string }) {
  return (
    <span className="loading-inline" role="status" aria-live="polite">
      <span className="loading-bars" aria-hidden>
        <span />
        <span />
        <span />
        <span />
      </span>
      {label}
    </span>
  );
}

function LoadingBars({ className = "" }: { className?: string }) {
  return (
    <span className={`loading-bars ${className}`.trim()} aria-hidden>
      <span />
      <span />
      <span />
      <span />
      <span />
    </span>
  );
}

/** Format remaining ms as H:MM:SS or M:SS. */
function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function HomePage() {
  const [tab, setTab] = useState<Tab>("live");
  const [status, setStatus] = useState<Status | null>(null);
  const [events, setEvents] = useState<ShellEvent[]>([]);
  const [broker, setBroker] = useState<BrokerInfo | null>(null);
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [history, setHistory] = useState<{
    series: string[];
    points: HistoryPoint[];
  }>({ series: [], points: [] });
  const [trades, setTrades] = useState<TradeEntry[]>([]);
  const [tradeTotals, setTradeTotals] = useState<TradeTotals | null>(null);
  const [settingsDraft, setSettingsDraft] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [loadingPortfolio, setLoadingPortfolio] = useState(true);
  const [loadingTrades, setLoadingTrades] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const portfolioInflight = useRef(0);
  const tradesInflight = useRef(0);
  const prevTab = useRef<Tab | null>(null);

  const [assets, setAssets] = useState<Asset[]>([]);
  const [allowModalOpen, setAllowModalOpen] = useState(false);
  const [allowDraft, setAllowDraft] = useState<string[]>([]);
  const [allowFilter, setAllowFilter] = useState("");
  const [allowTradeableOnly, setAllowTradeableOnly] = useState(true);
  const [xAccount, setXAccount] = useState<{
    id: string;
    name: string;
    username: string;
    profileImageUrl: string | null;
    url: string;
  } | null>(null);
  const [xAccountError, setXAccountError] = useState<string | null>(null);
  const [xAccountLoading, setXAccountLoading] = useState(false);
  const [llmConnection, setLlmConnection] = useState<{
    provider: string;
    currentModel: string;
    defaultModel: string;
    models: Array<{ id: string; label: string }>;
    source: string;
    error?: string;
  } | null>(null);
  const [llmConnectionError, setLlmConnectionError] = useState<string | null>(
    null,
  );
  const [llmConnectionLoading, setLlmConnectionLoading] = useState(false);

  function goTab(next: Tab) {
    setTab(next);
    if (typeof window === "undefined") return;
    const hash = `#${next}`;
    if (window.location.hash !== hash) {
      window.history.replaceState(null, "", hash);
    }
  }

  async function refreshStatus() {
    const s = await api<{ ok: true } & Status>("/api/status");
    setStatus(s);
    setSettingsDraft((prev) => prev ?? s.settings);
    if (s.events?.length) {
      setEvents((prev) => mergeEvents(prev, s.events!));
    }
  }

  async function refreshBroker() {
    const res = await api<{ ok: true; broker: BrokerInfo }>("/api/broker");
    setBroker(res.broker);
  }

  async function refreshPortfolio() {
    portfolioInflight.current += 1;
    setLoadingPortfolio(true);
    let tokenId: string | undefined;
    try {
      const p = await api<{ ok: true } & Portfolio>("/api/portfolio");
      setPortfolio(p);
      setBroker(p.broker);
      tokenId = p.broker.tokenId;
    } finally {
      portfolioInflight.current = Math.max(0, portfolioInflight.current - 1);
      if (portfolioInflight.current === 0) setLoadingPortfolio(false);
    }
    // History is secondary — don't keep the refresh indicator waiting on it
    if (tokenId) {
      void refreshHistory(tokenId).catch(() => undefined);
    }
  }

  async function refreshHistory(tokenId?: string) {
    const id = tokenId ?? status?.env.tokenId ?? undefined;
    const q = id ? `?tokenId=${encodeURIComponent(id)}` : "";
    const res = await api<{
      ok: true;
      series: string[];
      points: HistoryPoint[];
    }>(`/api/history${q}`);
    setHistory({ series: res.series, points: res.points });
  }

  async function refreshTrades(
    tokenId?: string,
    opts?: { quiet?: boolean },
  ) {
    if (!opts?.quiet) {
      tradesInflight.current += 1;
      setLoadingTrades(true);
    }
    try {
      const id = tokenId ?? status?.env.tokenId ?? undefined;
      const q = id ? `?tokenId=${encodeURIComponent(id)}` : "";
      const res = await api<{
        ok: true;
        trades: TradeEntry[];
        totals: TradeTotals;
      }>(`/api/trades${q}`);
      setTrades(res.trades);
      setTradeTotals(res.totals);
    } finally {
      if (!opts?.quiet) {
        tradesInflight.current = Math.max(0, tradesInflight.current - 1);
        if (tradesInflight.current === 0) setLoadingTrades(false);
      }
    }
  }

  async function loadAssets() {
    const res = await api<{ ok: true; assets: Asset[] }>("/api/assets");
    setAssets(res.assets);
  }

  useEffect(() => {
    goTab(tabFromHash());
    void refreshStatus().catch((e: Error) => setError(e.message));
    void refreshBroker()
      .then(() => setError(null))
      .catch((e: Error) => setError(e.message));
    void refreshPortfolio()
      .then(() => setError(null))
      .catch((e: Error) => setError(e.message));
    void refreshTrades().catch(() => undefined);
    void loadAssets().catch(() => undefined);
    const onHash = () => setTab(tabFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // Poll status (and events) — faster while autopilot is running
  useEffect(() => {
    const ms = status?.agent.running ? 1500 : 4000;
    const id = setInterval(() => {
      void refreshStatus().catch(() => undefined);
    }, ms);
    return () => clearInterval(id);
  }, [status?.agent.running]);

  // Local tick for next-pass countdown (smooth; nextPassAt comes from status)
  useEffect(() => {
    if (!status?.agent.running) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [status?.agent.running]);

  // SSE direct to shell API (Next rewrites break EventSource)
  useEffect(() => {
    const shell =
      status?.shellUrl ||
      process.env.NEXT_PUBLIC_SHELL_URL ||
      "http://127.0.0.1:8788";
    const es = new EventSource(`${shell}/api/events`);
    es.onmessage = (msg) => {
      try {
        const ev = JSON.parse(msg.data) as ShellEvent;
        setEvents((prev) => mergeEvents(prev, [ev]));
      } catch {
        /* ignore */
      }
    };
    es.onerror = () => {
      /* polling still covers the feed */
    };
    return () => es.close();
  }, [status?.shellUrl]);

  // Refresh tab data on user tab changes only (boot effect handles first load)
  useEffect(() => {
    const prev = prevTab.current;
    prevTab.current = tab;
    if (prev === null || prev === tab) return;
    if (tab === "portfolio") {
      void refreshPortfolio().catch((e: Error) => setError(e.message));
    }
    if (tab === "log") {
      void refreshTrades().catch((e: Error) => setError(e.message));
    }
  }, [tab]);

  // Load connected X profile when Settings is open and X_* is configured
  useEffect(() => {
    if (tab !== "settings" || !status?.env.hasX) {
      return;
    }
    let cancelled = false;
    setXAccountLoading(true);
    void (async () => {
      try {
        const res = await api<{
          ok: true;
          configured: boolean;
          account: {
            id: string;
            name: string;
            username: string;
            profileImageUrl: string | null;
            url: string;
          } | null;
          error?: string;
        }>("/api/x/me");
        if (cancelled) return;
        setXAccount(res.account);
        setXAccountError(res.error ?? null);
      } catch (e) {
        if (cancelled) return;
        setXAccount(null);
        setXAccountError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setXAccountLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tab, status?.env.hasX]);

  // Load connected LLM + model list when Settings is open
  useEffect(() => {
    if (tab !== "settings" || !status?.env.hasLlm) {
      return;
    }
    let cancelled = false;
    setLlmConnectionLoading(true);
    void (async () => {
      try {
        const res = await api<{
          ok: true;
          configured: boolean;
          connection: {
            provider: string;
            currentModel: string;
            defaultModel: string;
            models: Array<{ id: string; label: string }>;
            source: string;
            error?: string;
          } | null;
          error?: string;
        }>("/api/llm/me");
        if (cancelled) return;
        setLlmConnection(res.connection);
        setLlmConnectionError(res.error ?? res.connection?.error ?? null);
      } catch (e) {
        if (cancelled) return;
        setLlmConnection(null);
        setLlmConnectionError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLlmConnectionLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tab, status?.env.hasLlm]);

  // Refresh trade log when txs land
  useEffect(() => {
    const last = events.at(-1);
    if (!last) return;
    if (
      last.type === "agent.tx" ||
      last.type === "agent.dry_run" ||
      last.type === "agent.prepare"
    ) {
      void refreshTrades(undefined, { quiet: true }).catch(() => undefined);
    }
  }, [events]);

  const cashPct = portfolio?.analysis.cashPct ?? null;
  const cashUsd = portfolio?.analysis.cashUsd ?? null;
  const bookUsd = portfolio?.analysis.contentsUsd ?? null;
  const shellBooting =
    status == null || (portfolio == null && loadingPortfolio);
  const statsBooting = portfolio == null && loadingPortfolio;

  const passInFlight = Boolean(status?.agent.passInFlight);
  // Prefer server schedule; fall back to last "Pass complete" + intervalMs
  const nextPassAt = (() => {
    if (!status?.agent.running) return null;
    if (status.agent.nextPassAt != null) return status.agent.nextPassAt;
    if (passInFlight) return null;
    const interval = status.settings.intervalMs;
    if (!(interval > 0)) return null;
    const lastComplete = [...events]
      .reverse()
      .find(
        (e) =>
          e.type === "agent.state" &&
          /pass complete/i.test(e.message),
      );
    if (lastComplete) return lastComplete.ts + interval;
    const scheduled = [...events]
      .reverse()
      .find((e) => e.type === "agent.schedule");
    const fromEv = (scheduled?.data as { nextPassAt?: number } | undefined)
      ?.nextPassAt;
    return fromEv != null ? fromEv : null;
  })();
  const nextPassRemainingMs =
    nextPassAt != null ? Math.max(0, nextPassAt - now) : null;
  const showNextCheck = Boolean(status?.agent.running);
  const nextCheckValue = !showNextCheck
    ? null
    : passInFlight
      ? "…"
      : nextPassAt != null
        ? formatCountdown(nextPassRemainingMs ?? 0)
        : "—";
  const nextCheckLabel = passInFlight ? "Pass in progress" : "Next check";

  const autopilotRunning = Boolean(status?.agent.running);
  const autopilotPaused =
    !autopilotRunning && status?.agent.state === "paused";
  const autopilotActive = autopilotRunning || autopilotPaused;

  const tba = broker?.tba ?? portfolio?.broker.tba ?? null;
  const owner = broker?.owner ?? portfolio?.broker.owner ?? null;
  const brokerName = broker?.name ?? portfolio?.broker.name ?? null;
  const brokerImage = broker?.image ?? portfolio?.broker.image ?? null;

  const filteredAssets = useMemo(() => {
    const q = allowFilter.trim().toUpperCase();
    return assets.filter((a) => {
      if (allowTradeableOnly && a.onChainTradeable === false) return false;
      if (!q) return true;
      return (
        a.symbol.includes(q) ||
        a.name.toUpperCase().includes(q) ||
        a.address.toUpperCase().includes(q) ||
        (a.venue ?? "").toUpperCase().includes(q)
      );
    });
  }, [assets, allowFilter, allowTradeableOnly]);

  async function copyText(label: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* ignore */
    }
  }

  async function postAgent(path: string) {
    setBusy(path);
    setError(null);
    try {
      await api(path, { method: "POST", body: "{}" });
      const s = await api<{ ok: true } & Status>("/api/status");
      setStatus(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  }

  async function saveSettings() {
    if (!settingsDraft) return;
    setBusy("settings");
    setError(null);
    try {
      const res = await api<{ ok: true; settings: Settings }>("/api/settings", {
        method: "POST",
        body: JSON.stringify(settingsDraft),
      });
      setSettingsDraft(res.settings);
      const s = await api<{ ok: true } & Status>("/api/status");
      setStatus(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  }

  async function testXPost() {
    setBusy("x-test");
    setError(null);
    try {
      const res = await api<{
        ok: true;
        id: string;
        text: string;
        url: string;
      }>("/api/x/test", { method: "POST", body: "{}" });
      setEvents((prev) =>
        mergeEvents(prev, [
          {
            id: `x-test-${res.id}`,
            ts: Date.now(),
            type: "agent.x",
            message: `Test post ${res.url}`,
          },
        ]),
      );
      goTab("live");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  }

  function openAllowModal() {
    setAllowDraft([...(settingsDraft?.allowlist ?? [])]);
    setAllowFilter("");
    setAllowModalOpen(true);
    if (!assets.length) void loadAssets().catch(() => undefined);
  }

  function toggleSymbol(sym: string) {
    setAllowDraft((prev) =>
      prev.includes(sym) ? prev.filter((s) => s !== sym) : [...prev, sym].sort(),
    );
  }

  function confirmAllowlist() {
    if (!settingsDraft) return;
    setSettingsDraft({ ...settingsDraft, allowlist: [...allowDraft].sort() });
    setAllowModalOpen(false);
  }

  return (
    <div className="app">
      <div className="main">
        <div className="ticker">
          <span className={`dot ${autopilotActive ? "" : "off"}`} />
          <span className="ticker-left">
            {autopilotRunning
              ? `RUNNING · ${status?.agent.state.toUpperCase()}`
              : autopilotPaused
                ? "PAUSED"
                : "IDLE"}{" "}
            · BROKER #{status?.env.tokenId ?? "?"}
            {tba ? ` · TBA ${shortAddr(tba)}` : ""} ·{" "}
            {status?.settings.dryRun !== false ? "DRY_RUN" : "LIVE"}
          </span>
          <span
            className={`ticker-bal ${
              (() => {
                const b = status?.balances;
                if (!b) return "pending";
                if (b.eoaGasWarn?.critical) return "low";
                if (b.eoaGasWarn?.low) return "low";
                const usd =
                  b.ethUsd != null && b.ethUsd > 0
                    ? b.eoaEth * b.ethUsd
                    : null;
                if (usd == null) return b.eoaEth < 0.002 ? "low" : "ok";
                return usd < 5 ? "low" : "ok";
              })()
            }`}
            title={
              status?.balances
                ? `EOA ${status.balances.eoa}\n${status.balances.eoaEth.toFixed(6)} ETH · $${status.balances.ethUsd ?? "?"}/ETH\nPays gas only (buys fund from TBA)${
                    status.balances.eoaGasWarn?.low
                      ? `\n⚠ ${status.balances.eoaGasWarn.message}`
                      : ""
                  }`
                : "Loading EOA balance…"
            }
          >
            {status?.balances ? (
              <>
                EOA{" "}
                {status.balances.ethUsd != null && status.balances.ethUsd > 0
                  ? `$${(status.balances.eoaEth * status.balances.ethUsd).toFixed(2)}`
                  : `${status.balances.eoaEth.toFixed(4)} ETH`}
                <span className="ticker-bal-sub">
                  {" "}
                  ({status.balances.eoaEth.toFixed(4)} ETH)
                </span>
              </>
            ) : (
              "EOA …"
            )}
          </span>
        </div>
        {status?.balances?.eoaGasWarn?.low && (
          <div
            className={`banner-warn ${
              status.balances.eoaGasWarn.critical ? "critical" : ""
            }`}
            role="alert"
          >
            <strong>
              {status.balances.eoaGasWarn.critical
                ? "Fund EOA for gas"
                : "EOA gas low"}
            </strong>
            {" — "}
            {status.balances.eoaGasWarn.message}. Send ETH to{" "}
            <code title={status.balances.eoa}>
              {shortAddr(status.balances.eoa)}
            </code>{" "}
            (owner wallet, not the TBA).
            <button
              className="btn"
              type="button"
              style={{ marginLeft: 10 }}
              onClick={() => void copyText("eoa-warn", status.balances!.eoa)}
            >
              {copied === "eoa-warn" ? "Copied" : "Copy EOA"}
            </button>
          </div>
        )}

        <div className="content">
          <div className="hero-row">
            <div className="nft-frame">
              {brokerImage ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={brokerImage}
                  alt={
                    brokerName ??
                    `StonkBroker #${status?.env.tokenId ?? ""}`
                  }
                  className="nft-img"
                />
              ) : (
                <div
                  className={`nft-placeholder${
                    !broker && !portfolio ? " loading" : ""
                  }`}
                >
                  {broker || portfolio ? "NO IMG" : "LOADING"}
                </div>
              )}
            </div>
            <div>
              <h1 className="title">
                {brokerName ?? "Stonk Trader Shell"}
              </h1>
              {tba && (
                <div className="addr-row">
                  <span className="label">TBA</span>
                  <code title={tba}>{tba}</code>
                  <button
                    className="btn"
                    type="button"
                    onClick={() => void copyText("tba", tba)}
                  >
                    {copied === "tba" ? "Copied" : "Copy"}
                  </button>
                </div>
              )}
              {owner && (
                <div className="addr-row">
                  <span className="label">Owner</span>
                  <code title={owner}>{shortAddr(owner)}</code>
                  <button
                    className="btn"
                    type="button"
                    onClick={() => void copyText("owner", owner)}
                  >
                    {copied === "owner" ? "Copied" : "Copy"}
                  </button>
                </div>
              )}
            </div>
          </div>

          <div className="stats">
            <div className="stat">
              <div
                className={`value${statsBooting && cashUsd == null ? " loading" : ""}`}
              >
                {cashUsd != null ? (
                  `$${cashUsd.toFixed(2)}`
                ) : statsBooting ? (
                  <LoadingBars />
                ) : (
                  "—"
                )}
              </div>
              <div className="label">Cash</div>
            </div>
            <div className="stat">
              <div
                className={`value${statsBooting && cashPct == null ? " loading" : ""}`}
              >
                {cashPct != null ? (
                  `${cashPct.toFixed(0)}%`
                ) : statsBooting ? (
                  <LoadingBars />
                ) : (
                  "—"
                )}
              </div>
              <div className="label">Cash pct</div>
            </div>
            <div className="stat">
              <div
                className={`value${statsBooting && bookUsd == null ? " loading" : ""}`}
              >
                {bookUsd != null ? (
                  `$${bookUsd.toFixed(2)}`
                ) : statsBooting ? (
                  <LoadingBars />
                ) : (
                  "—"
                )}
              </div>
              <div className="label">Book</div>
            </div>
            <div className="stat">
              <div
                className={`value${
                  status == null ? " loading" : ""
                }`}
              >
                {status?.agent.state ?? (status == null ? <LoadingBars /> : "—")}
              </div>
              <div className="label">Agent state</div>
            </div>
          </div>

          <div className="tabs">
            {TABS.map((t) => (
              <button
                key={t}
                className={`tab ${tab === t ? "active" : ""}`}
                onClick={() => goTab(t)}
              >
                {t}
              </button>
            ))}
          </div>

          <div className="btn-row">
            <button
              className="btn primary"
              disabled={!!busy || autopilotActive}
              onClick={() => void postAgent("/api/agent/start")}
            >
              Run
            </button>
            {autopilotPaused ? (
              <button
                className="btn primary"
                disabled={!!busy}
                onClick={() => void postAgent("/api/agent/resume")}
              >
                Resume
              </button>
            ) : (
              <button
                className="btn"
                disabled={!!busy || !autopilotRunning}
                onClick={() => void postAgent("/api/agent/pause")}
              >
                Pause
              </button>
            )}
            <button
              className="btn"
              disabled={!!busy || !autopilotActive}
              onClick={() => void postAgent("/api/agent/stop")}
              title="Deactivate autopilot"
            >
              Stop
            </button>
            <button
              className="btn"
              disabled={!!busy}
              onClick={() => void postAgent("/api/agent/once")}
            >
              Once
            </button>
            <button
              className={`btn ${settingsDraft?.dryRun !== false ? "primary" : ""}`}
              disabled={!settingsDraft || busy === "settings"}
              type="button"
              title="Toggle dry run (prepare only vs broadcast live)"
              onClick={() => {
                if (!settingsDraft) return;
                const next = {
                  ...settingsDraft,
                  dryRun: !settingsDraft.dryRun,
                };
                setSettingsDraft(next);
                void (async () => {
                  setBusy("settings");
                  try {
                    const res = await api<{ ok: true; settings: Settings }>(
                      "/api/settings",
                      { method: "POST", body: JSON.stringify({ dryRun: next.dryRun }) },
                    );
                    setSettingsDraft(res.settings);
                    await refreshStatus();
                  } catch (e) {
                    setError(e instanceof Error ? e.message : String(e));
                  } finally {
                    setBusy("");
                  }
                })();
              }}
            >
              {settingsDraft?.dryRun !== false ? "Dry run: ON" : "Dry run: OFF"}
            </button>
            {showNextCheck ? (
              <div
                className="countdown-slot"
                title={
                  passInFlight
                    ? "Autopilot pass in progress"
                    : nextPassAt != null
                      ? `Next check at ${new Date(nextPassAt).toLocaleTimeString()}`
                      : "Waiting for schedule"
                }
              >
                <div className="countdown-value">{nextCheckValue}</div>
                <div className="countdown-label">{nextCheckLabel}</div>
              </div>
            ) : null}
          </div>

          {error && (
            <div className="panel">
              <h2>Error</h2>
              <div style={{ color: "var(--danger)", fontSize: 12 }}>{error}</div>
              <p className="sub" style={{ marginTop: 8 }}>
                Is the shell API running? <code>npm run shell:api</code> on
                :8788
              </p>
            </div>
          )}

          {tab === "live" && (
            <div className="panel">
              <div className="panel-head">
                <h2>Live feed</h2>
                {shellBooting ? <LoadingInline label="Loading" /> : null}
              </div>
              {shellBooting ? (
                <>
                  <div className="loading-strip" aria-hidden />
                  <LoadingBlock label="Loading shell" />
                </>
              ) : (
                <>
                  {status?.agent.lastThesis && (
                    <p className="sub" style={{ marginBottom: 12 }}>
                      Thesis: {status.agent.lastThesis}
                    </p>
                  )}
                  <div className="log">
                    {events.length === 0 && (
                      <div className="log-line">
                        <span>—</span>
                        <span className="msg">
                          {status?.agent.running
                            ? "Pass in progress — waiting for first event…"
                            : "Waiting for events — press RUN or ONCE"}
                        </span>
                      </div>
                    )}
                    {[...events].reverse().map((ev) => (
                      <div
                        key={ev.id}
                        className={`log-line ${
                          ev.type.includes("error")
                            ? "error"
                            : ev.type.includes("skip") ||
                                ev.type.includes("warn")
                              ? "warn"
                              : ev.type === "agent.fee"
                                ? "ok"
                                : ""
                        }`}
                      >
                        <span>{new Date(ev.ts).toLocaleTimeString()}</span>
                        <span className="msg">
                          [{ev.type}] {linkify(ev.message)}
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          {tab === "portfolio" && (
            <div className="panel">
              <div className="panel-head">
                <h2>Portfolio</h2>
                {portfolio && loadingPortfolio ? (
                  <LoadingInline />
                ) : null}
              </div>
              {loadingPortfolio && !portfolio ? (
                <>
                  <div className="loading-strip" aria-hidden />
                  <LoadingBlock label="Loading portfolio" />
                </>
              ) : portfolio ? (
                <>
                  {loadingPortfolio ? (
                    <div className="loading-strip" aria-hidden />
                  ) : null}
                  {(() => {
                    const pnl = portfolioPnlSummary(portfolio, history.points);
                    const pCls = pnlClass(pnl.periodPnl);
                    const uCls = pnlClassWeth(pnl.unrealizedWeth ?? pnl.unrealized);
                    return (
                      <div className="stats pnl-stats" style={{ marginBottom: 18 }}>
                        <div className="stat">
                          <div className="value">
                            {pnl.book != null ? `$${pnl.book.toFixed(2)}` : "—"}
                          </div>
                          <div className="label">Book (USD)</div>
                        </div>
                        <div className="stat">
                          <div className={`value ${pCls}`}>
                            {pnl.periodPnl == null
                              ? "—"
                              : moneySigned(pnl.periodPnl)}
                          </div>
                          <div className="label">
                            Period P&amp;L (USD)
                            {pnl.periodFrom != null && pnl.periodTo != null
                              ? ` · $${pnl.periodFrom.toFixed(2)}→$${pnl.periodTo.toFixed(2)}`
                              : ""}
                          </div>
                        </div>
                        <div className="stat">
                          <div className={`value ${pCls}`}>
                            {pnl.periodPct == null
                              ? "—"
                              : pctSigned(pnl.periodPct)}
                          </div>
                          <div className="label">Period %</div>
                        </div>
                        <div className="stat">
                          <div className={`value ${uCls}`}>
                            {pnl.unrealizedWeth != null
                              ? wethSigned(pnl.unrealizedWeth)
                              : pnl.unrealizedUsd != null
                                ? moneySigned(pnl.unrealizedUsd)
                                : "—"}
                          </div>
                          <div className="label">
                            Sleeve vs WETH
                            {pnl.unrealizedPct != null
                              ? ` · ${pctSigned(pnl.unrealizedPct)}`
                              : ""}
                          </div>
                        </div>
                      </div>
                    );
                  })()}

                  <h2 style={{ marginTop: 0 }}>Value over time</h2>
                  <HoldingsChart
                    points={history.points}
                    series={history.series}
                  />

                  <p className="sub" style={{ marginTop: 14, marginBottom: 0 }}>
                    Trading P&amp;L is <strong>vs idle WETH</strong> (stock/ETH).
                    USD columns are for reporting — ETH/USD moves do not drive stops.
                  </p>

                  <table className="holdings" style={{ marginTop: 12 }}>
                    <thead>
                      <tr>
                        <th>Symbol</th>
                        <th>Amount</th>
                        <th>Mark</th>
                        <th>Avg (WETH)</th>
                        <th>USD</th>
                        <th>P&amp;L (WETH)</th>
                        <th>Weight</th>
                      </tr>
                    </thead>
                    <tbody>
                      {portfolio.analysis.holdings.map((h) => {
                        const isCash = ["WETH", "ETH", "USDG"].includes(
                          h.symbol,
                        );
                        const pnl = isCash
                          ? { text: "—", cls: "pnl-flat" }
                          : fmtWethPnl(
                              h.unrealizedPnlWeth,
                              h.unrealizedPnlWethPct ?? h.unrealizedPnlPct,
                            );
                        const mark = h.markUsd ?? h.priceUsd;
                        return (
                          <tr key={h.symbol}>
                            <td>
                              {h.symbol}
                              {h.seeded && !isCash ? (
                                <span className="seeded" title="Cost seeded at mark">
                                  ~
                                </span>
                              ) : null}
                            </td>
                            <td>{h.amount.toFixed(6)}</td>
                            <td>
                              {isCash
                                ? "—"
                                : h.markWeth != null
                                  ? `${h.markWeth.toFixed(8)} ETH`
                                  : fmtUsd(mark, 4)}
                            </td>
                            <td>
                              {isCash
                                ? "—"
                                : h.avgCostWeth != null
                                  ? `${h.avgCostWeth.toFixed(8)} ETH`
                                  : h.avgCostUsd != null
                                    ? fmtUsd(h.avgCostUsd, 4)
                                    : "—"}
                            </td>
                            <td>{fmtUsd(h.usd)}</td>
                            <td className={pnl.cls}>
                              {pnl.text}
                              {!isCash &&
                              h.unrealizedPnlUsd != null &&
                              h.unrealizedPnlUsdPct != null ? (
                                <span
                                  className="sub"
                                  style={{ display: "block", fontSize: 11 }}
                                  title="USD P&L (reporting)"
                                >
                                  {fmtPnl(
                                    h.unrealizedPnlUsd,
                                    h.unrealizedPnlUsdPct,
                                  ).text}{" "}
                                  USD
                                </span>
                              ) : null}
                            </td>
                            <td>{(h.weightPct ?? 0).toFixed(1)}%</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {portfolio.ledger?.fills && portfolio.ledger.fills.length > 0 && (
                    <>
                      <h2 style={{ marginTop: 18 }}>Recent fills</h2>
                      <p className="sub" style={{ marginBottom: 8 }}>
                        Live fills update avg cost. Dry-run lines are audit-only.
                        <span className="seeded"> ~</span> = cost seeded at mark
                        (unknown prior entry).
                      </p>
                      <div className="log">
                        {portfolio.ledger.fills.slice(0, 12).map((f, i) => (
                          <div key={`${f.ts}-${i}`} className="log-line">
                            <span>
                              {new Date(f.ts).toLocaleTimeString()}{" "}
                              {f.dryRun ? "[dry]" : f.seeded ? "[seed]" : "[live]"}
                            </span>
                            <span className="msg">
                              {f.side.toUpperCase()} {f.qty.toFixed(4)} {f.symbol} @{" "}
                              {fmtUsd(f.priceUsd, 4)} · {fmtUsd(f.notionalUsd)}
                              {f.reason ? ` — ${f.reason}` : ""}
                            </span>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                  <h2 style={{ marginTop: 18 }}>Actions</h2>
                  <div className="log">
                    {portfolio.analysis.actions.map((a, i) => (
                      <div key={i} className="log-line">
                        <span>{a.action}</span>
                        <span className="msg">
                          {a.action === "swap"
                            ? `${(a.side ?? "").toUpperCase()} ${a.amountIn} ${a.tokenIn} → ${a.tokenOut} — ${a.reason}`
                            : a.reason}
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <p className="sub">No portfolio data yet.</p>
              )}
            </div>
          )}

          {tab === "log" && (
            <div className="panel">
              <div className="panel-head">
                <h2>Swap log</h2>
                {loadingTrades && trades.length > 0 ? (
                  <LoadingInline />
                ) : null}
              </div>
              <p className="sub" style={{ marginBottom: 12 }}>
                Owner→TBA executeCalls
                {tba ? (
                  <>
                    {" "}
                    from{" "}
                    <a
                      href={`https://robinhoodchain.blockscout.com/address/${tba}?tab=txs`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Blockscout
                    </a>
                  </>
                ) : null}
                . <strong>Gas</strong> is the EOA fee (small).{" "}
                <strong>Value</strong> is native ETH attached to the call
                (often the swap path — still in the TBA, not burned).
              </p>
              {loadingTrades && trades.length === 0 ? (
                <>
                  <div className="loading-strip" aria-hidden />
                  <LoadingBlock label="Loading swap log" />
                </>
              ) : null}
              {loadingTrades && trades.length > 0 ? (
                <div className="loading-strip" aria-hidden />
              ) : null}
              {tradeTotals && !(loadingTrades && trades.length === 0) && (
                <div className="stats pnl-stats" style={{ marginBottom: 18 }}>
                  <div className="stat">
                    <div className="value">
                      {tradeTotals.txCount}
                    </div>
                    <div className="label">
                      Live txs · {tradeTotals.filled} filled
                    </div>
                  </div>
                  <div className="stat">
                    <div className="value pnl-down">
                      {tradeTotals.gasFeeUsd > 0
                        ? `$${tradeTotals.gasFeeUsd.toFixed(2)}`
                        : tradeTotals.gasFeeEth > 0
                          ? `${tradeTotals.gasFeeEth.toFixed(5)} ETH`
                          : "—"}
                    </div>
                    <div className="label">
                      Gas fees (EOA)
                      {tradeTotals.gasFeeEth > 0
                        ? ` · ${tradeTotals.gasFeeEth.toFixed(5)} ETH`
                        : ""}
                    </div>
                  </div>
                  <div className="stat">
                    <div className="value">
                      {tradeTotals.valueUsd > 0
                        ? `$${tradeTotals.valueUsd.toFixed(2)}`
                        : tradeTotals.valueEth > 0
                          ? `${tradeTotals.valueEth.toFixed(5)} ETH`
                          : "—"}
                    </div>
                    <div className="label">
                      Call value (in TBA path)
                      {tradeTotals.valueEth > 0
                        ? ` · ${tradeTotals.valueEth.toFixed(5)} ETH`
                        : ""}
                    </div>
                  </div>
                  <div className="stat">
                    <div className="value">
                      {tradeTotals.dryRun}
                    </div>
                    <div className="label">Dry-run rows</div>
                  </div>
                </div>
              )}
              {loadingTrades && trades.length === 0 ? null : trades.length === 0 ? (
                <p className="sub">
                  No swaps logged yet — run Once / Run (dry or live).
                </p>
              ) : (
                <table className="holdings trade-log">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Status</th>
                      <th>Side</th>
                      <th>Swap</th>
                      <th>Notional</th>
                      <th>Gas</th>
                      <th>Value</th>
                      <th>Txs</th>
                    </tr>
                  </thead>
                  <tbody>
                    {trades.map((t) => (
                      <tr key={t.id}>
                        <td>
                          {new Date(t.ts).toLocaleString(undefined, {
                            month: "short",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                            second: "2-digit",
                          })}
                        </td>
                        <td>
                          <span
                            className={
                              t.status === "filled"
                                ? "pnl-up"
                                : t.status === "error"
                                  ? "pnl-down"
                                  : "pnl-flat"
                            }
                          >
                            {t.status}
                          </span>
                        </td>
                        <td>{t.side.toUpperCase()}</td>
                        <td>
                          <div>
                            {t.amountIn} {t.tokenIn} → {t.tokenOut}
                          </div>
                          {t.reason ? (
                            <div className="sub" style={{ marginTop: 2 }}>
                              {t.reason}
                            </div>
                          ) : null}
                          {t.error ? (
                            <div className="pnl-down" style={{ marginTop: 2 }}>
                              {t.error}
                            </div>
                          ) : null}
                        </td>
                        <td>
                          {t.notionalUsd != null
                            ? `$${t.notionalUsd.toFixed(2)}`
                            : "—"}
                        </td>
                        <td className={t.gasFeeEth ? "pnl-down" : "pnl-flat"}>
                          {t.gasFeeUsd != null
                            ? `$${t.gasFeeUsd.toFixed(2)}`
                            : t.gasFeeEth != null
                              ? `${t.gasFeeEth.toFixed(5)} ETH`
                              : "—"}
                          {t.gasFeeEth != null && t.gasFeeUsd != null ? (
                            <div className="sub">
                              {t.gasFeeEth.toFixed(5)} ETH
                            </div>
                          ) : null}
                        </td>
                        <td>
                          {t.valueUsd != null
                            ? `$${t.valueUsd.toFixed(2)}`
                            : t.valueEth != null && t.valueEth > 0
                              ? `${t.valueEth.toFixed(5)} ETH`
                              : "—"}
                          {t.valueEth != null &&
                          t.valueEth > 0 &&
                          t.valueUsd != null ? (
                            <div className="sub">
                              {t.valueEth.toFixed(5)} ETH
                            </div>
                          ) : null}
                        </td>
                        <td>
                          {t.txs.length === 0 ? (
                            <span className="pnl-flat">—</span>
                          ) : (
                            <div className="tx-links">
                              {t.txs.map((tx, i) =>
                                tx.url ? (
                                  <a
                                    key={`${t.id}-${i}`}
                                    href={tx.url}
                                    target="_blank"
                                    rel="noreferrer"
                                    title={
                                      tx.gasFeeEth != null
                                        ? `${tx.hash} · gas ${tx.gasFeeEth.toFixed(5)} ETH`
                                        : tx.hash
                                    }
                                  >
                                    {tx.what || "tx"}
                                    {tx.gasFeeUsd != null
                                      ? ` $${tx.gasFeeUsd.toFixed(2)}`
                                      : ""}
                                  </a>
                                ) : (
                                  <span
                                    key={`${t.id}-${i}`}
                                    className="pnl-flat"
                                  >
                                    {tx.what || "dry"}
                                  </span>
                                ),
                              )}
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {tab === "settings" && settingsDraft && (
            <div className="panel">
              <h2>Settings</h2>
              <div className="status-pills">
                <span
                  className={`pill ${status?.env.hasPrivateKey ? "ok" : "bad"}`}
                >
                  wallet {status?.env.hasPrivateKey ? "ok" : "missing"}
                </span>
                <span className={`pill ${status?.env.hasLlm ? "ok" : "bad"}`}>
                  llm {status?.env.hasLlm ? "ok" : "missing"}
                </span>
                <span className={`pill ${status?.env.hasX ? "ok" : "bad"}`}>
                  x {status?.env.hasX ? "ok" : "missing"}
                </span>
                <span
                  className={`pill ${settingsDraft.dryRun ? "ok" : "bad"}`}
                >
                  dry_run {String(settingsDraft.dryRun)}
                </span>
              </div>

              {tba && (
                <div className="addr-block">
                  <div className="k">StonkBroker TBA (fund this)</div>
                  <div className="v">{tba}</div>
                  <div className="btn-row" style={{ marginTop: 8 }}>
                    <button
                      className="btn"
                      type="button"
                      onClick={() => void copyText("tba-set", tba)}
                    >
                      {copied === "tba-set" ? "Copied" : "Copy TBA"}
                    </button>
                    {owner && (
                      <button
                        className="btn"
                        type="button"
                        onClick={() => void copyText("owner-set", owner)}
                      >
                        {copied === "owner-set"
                          ? "Copied"
                          : `Owner ${shortAddr(owner)}`}
                      </button>
                    )}
                  </div>
                </div>
              )}

              {status?.env.hasX && (
                <div className="addr-block">
                  <div className="k">Connected X account</div>
                  {xAccountLoading && !xAccount ? (
                    <div className="x-account">
                      <LoadingInline label="Loading profile" />
                    </div>
                  ) : xAccount ? (
                    <div className="x-account">
                      {xAccount.profileImageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          className="x-account-pfp"
                          src={xAccount.profileImageUrl}
                          alt=""
                          width={48}
                          height={48}
                          referrerPolicy="no-referrer"
                        />
                      ) : (
                        <div className="x-account-pfp placeholder" aria-hidden>
                          X
                        </div>
                      )}
                      <div className="x-account-meta">
                        {xAccount.name ? (
                          <div className="x-account-name">{xAccount.name}</div>
                        ) : null}
                        <a
                          className="x-account-handle"
                          href={xAccount.url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          @{xAccount.username}
                        </a>
                      </div>
                    </div>
                  ) : (
                    <p className="sub" style={{ margin: "6px 0 0" }}>
                      {xAccountError ??
                        "X_* is set but profile could not be loaded."}
                    </p>
                  )}
                </div>
              )}

              {status?.env.hasLlm && (
                <div className="addr-block">
                  <div className="k">Connected LLM</div>
                  {llmConnectionLoading && !llmConnection ? (
                    <div className="x-account">
                      <LoadingInline label="Loading models" />
                    </div>
                  ) : llmConnection ? (
                    <div className="llm-account">
                      <div className="llm-provider">
                        <span className="llm-provider-badge">
                          {llmConnection.provider}
                        </span>
                        <span className="sub">
                          {llmConnection.source === "api"
                            ? "models from API"
                            : "curated list"}
                        </span>
                      </div>
                      <div className="field" style={{ marginTop: 10 }}>
                        <TipLabel tip={SETTING_TIPS.llmModel}>Model</TipLabel>
                        <select
                          value={
                            settingsDraft.llmModel ||
                            llmConnection.currentModel
                          }
                          onChange={(e) =>
                            setSettingsDraft({
                              ...settingsDraft,
                              llmModel: e.target.value,
                            })
                          }
                        >
                          {llmConnection.models.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.label}
                            </option>
                          ))}
                        </select>
                      </div>
                      {llmConnectionError ? (
                        <p className="sub" style={{ margin: "8px 0 0" }}>
                          {llmConnectionError}
                        </p>
                      ) : null}
                    </div>
                  ) : (
                    <p className="sub" style={{ margin: "6px 0 0" }}>
                      {llmConnectionError ??
                        "LLM_API_KEY is set but models could not be loaded."}
                    </p>
                  )}
                </div>
              )}

              <p className="sub" style={{ margin: "10px 0 14px" }}>
                Secrets stay in <code>.env</code>. This form edits{" "}
                <code>data/settings.json</code>. Broadcast when{" "}
                <code>Dry run: OFF</code>. Swaps skip unless expected edge
                beats gas+slip.
              </p>
              <div className="form-grid">
                <div className="field">
                  <TipLabel tip={SETTING_TIPS.policy}>Policy</TipLabel>
                  <select
                    value={settingsDraft.policy}
                    onChange={(e) =>
                      setSettingsDraft({
                        ...settingsDraft,
                        policy: e.target.value,
                      })
                    }
                  >
                    {[
                      "core",
                      "equal_weight",
                      "deploy",
                      "targets",
                      "trim",
                      "dry_powder",
                      "max_name",
                    ].map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <TipLabel tip={SETTING_TIPS.reserveWethPct}>
                    Reserve WETH %
                  </TipLabel>
                  <SettingsNumber
                    value={settingsDraft.reserveWethPct}
                    min={0}
                    max={100}
                    onCommit={(n) =>
                      setSettingsDraft({
                        ...settingsDraft,
                        reserveWethPct: n ?? 30,
                      })
                    }
                  />
                </div>
                <div className="field">
                  <TipLabel tip={SETTING_TIPS.deployPct}>Deploy %</TipLabel>
                  <SettingsNumber
                    value={settingsDraft.deployPct}
                    min={1}
                    max={100}
                    onCommit={(n) =>
                      setSettingsDraft({
                        ...settingsDraft,
                        deployPct: n ?? 15,
                      })
                    }
                  />
                </div>
                <div className="field">
                  <TipLabel tip={SETTING_TIPS.intervalMs}>
                    Interval
                  </TipLabel>
                  <IntervalDurationField
                    ms={settingsDraft.intervalMs}
                    onCommit={(nextMs) =>
                      setSettingsDraft({
                        ...settingsDraft,
                        intervalMs: nextMs,
                      })
                    }
                  />
                </div>
                <div className="field">
                  <TipLabel tip={SETTING_TIPS.maxNotionalEth}>
                    Max notional ETH
                  </TipLabel>
                  <SettingsNumber
                    value={settingsDraft.maxNotionalEth}
                    min={0}
                    step="0.001"
                    onCommit={(n) =>
                      setSettingsDraft({
                        ...settingsDraft,
                        maxNotionalEth: n ?? 0.05,
                      })
                    }
                  />
                </div>
                <div className="field">
                  <TipLabel tip={SETTING_TIPS.maxActionsPerPass}>
                    Max actions / pass
                  </TipLabel>
                  <SettingsNumber
                    value={settingsDraft.maxActionsPerPass}
                    min={1}
                    max={10}
                    onCommit={(n) =>
                      setSettingsDraft({
                        ...settingsDraft,
                        maxActionsPerPass: n ?? 3,
                      })
                    }
                  />
                </div>
                <div className="field">
                  <TipLabel tip={SETTING_TIPS.minNotionalUsd}>
                    Min notional USD
                  </TipLabel>
                  <SettingsNumber
                    value={settingsDraft.minNotionalUsd ?? 3}
                    min={1}
                    step={1}
                    onCommit={(n) =>
                      setSettingsDraft({
                        ...settingsDraft,
                        minNotionalUsd: n ?? 3,
                      })
                    }
                  />
                </div>
                <div className="field">
                  <TipLabel tip={SETTING_TIPS.minEdgeBps}>Min edge bps</TipLabel>
                  <SettingsNumber
                    value={settingsDraft.minEdgeBps ?? 10}
                    min={0}
                    max={500}
                    step={1}
                    onCommit={(n) =>
                      setSettingsDraft({
                        ...settingsDraft,
                        minEdgeBps: n ?? 10,
                      })
                    }
                  />
                </div>
                <div className="field">
                  <TipLabel tip={SETTING_TIPS.takeProfitPct}>
                    Take profit %
                  </TipLabel>
                  <SettingsNumber
                    value={settingsDraft.takeProfitPct ?? 3}
                    min={0}
                    max={100}
                    step="0.1"
                    onCommit={(n) =>
                      setSettingsDraft({
                        ...settingsDraft,
                        takeProfitPct: n ?? 3,
                      })
                    }
                  />
                </div>
                <div className="field">
                  <TipLabel tip={SETTING_TIPS.stopLossPct}>Stop loss %</TipLabel>
                  <SettingsNumber
                    value={settingsDraft.stopLossPct ?? 2.5}
                    min={0}
                    max={100}
                    step="0.1"
                    onCommit={(n) =>
                      setSettingsDraft({
                        ...settingsDraft,
                        stopLossPct: n ?? 2.5,
                      })
                    }
                  />
                </div>
                <div className="field">
                  <TipLabel tip={SETTING_TIPS.maxRiskPctPerTrade}>
                    Max risk % / trade
                  </TipLabel>
                  <SettingsNumber
                    value={settingsDraft.maxRiskPctPerTrade ?? 1.5}
                    min={0.1}
                    max={10}
                    step="0.1"
                    onCommit={(n) =>
                      setSettingsDraft({
                        ...settingsDraft,
                        maxRiskPctPerTrade: n ?? 1.5,
                      })
                    }
                  />
                </div>
                <div className="field">
                  <TipLabel tip={SETTING_TIPS.addOnlyDipBps}>
                    Add-only dip bps
                  </TipLabel>
                  <SettingsNumber
                    value={settingsDraft.addOnlyDipBps ?? 50}
                    min={0}
                    max={2000}
                    step={1}
                    onCommit={(n) =>
                      setSettingsDraft({
                        ...settingsDraft,
                        addOnlyDipBps: n ?? 50,
                      })
                    }
                  />
                </div>
                <div className="field">
                  <TipLabel tip={SETTING_TIPS.estimateGasEth}>
                    Est. gas ETH / step
                  </TipLabel>
                  <SettingsNumber
                    value={settingsDraft.estimateGasEth}
                    min={0}
                    step="0.000001"
                    placeholder="auto from trade-log"
                    optional
                    onCommit={(n) =>
                      setSettingsDraft({
                        ...settingsDraft,
                        estimateGasEth: n != null && n > 0 ? n : undefined,
                      })
                    }
                  />
                </div>
                <div className="field full">
                  <TipLabel tip={SETTING_TIPS.allowlist}>
                    Allowlist ({settingsDraft.allowlist.length} symbols)
                  </TipLabel>
                  <div className="allow-row">
                    <input
                      readOnly
                      value={settingsDraft.allowlist.join(", ") || "(none)"}
                      title={settingsDraft.allowlist.join(", ")}
                    />
                    <button
                      className="btn"
                      type="button"
                      onClick={openAllowModal}
                    >
                      Edit
                    </button>
                  </div>
                </div>
                <div className="field full">
                  <TipLabel tip={SETTING_TIPS.thesis}>Thesis notes</TipLabel>
                  <textarea
                    rows={3}
                    value={settingsDraft.thesis}
                    onChange={(e) =>
                      setSettingsDraft({
                        ...settingsDraft,
                        thesis: e.target.value,
                      })
                    }
                  />
                </div>
                <div className="field">
                  <TipLabel tip={SETTING_TIPS.postToX}>Post to X</TipLabel>
                  <select
                    value={settingsDraft.postToX ? "yes" : "no"}
                    onChange={(e) =>
                      setSettingsDraft({
                        ...settingsDraft,
                        postToX: e.target.value === "yes",
                      })
                    }
                  >
                    <option value="yes">yes</option>
                    <option value="no">no</option>
                  </select>
                </div>
                <div className="field">
                  <TipLabel tip={SETTING_TIPS.useXSignals}>
                    X signals
                  </TipLabel>
                  <select
                    value={settingsDraft.useXSignals !== false ? "yes" : "no"}
                    onChange={(e) =>
                      setSettingsDraft({
                        ...settingsDraft,
                        useXSignals: e.target.value === "yes",
                      })
                    }
                  >
                    <option value="yes">yes</option>
                    <option value="no">no</option>
                  </select>
                </div>
                <div className="field">
                  <TipLabel tip={SETTING_TIPS.researchRails}>
                    Research rails
                  </TipLabel>
                  <select
                    value={settingsDraft.researchRails ?? "auto"}
                    onChange={(e) =>
                      setSettingsDraft({
                        ...settingsDraft,
                        researchRails: e.target.value as
                          | "auto"
                          | "always"
                          | "off",
                      })
                    }
                  >
                    <option value="auto">auto (thrifty)</option>
                    <option value="always">always</option>
                    <option value="off">off</option>
                  </select>
                </div>
                <div className="field">
                  <TipLabel tip={SETTING_TIPS.swapVenue}>Swap venue</TipLabel>
                  <select
                    value={settingsDraft.swapVenue ?? "auto"}
                    onChange={(e) =>
                      setSettingsDraft({
                        ...settingsDraft,
                        swapVenue: e.target.value as "auto" | "v3" | "v4",
                      })
                    }
                  >
                    <option value="auto">auto (v3 or v4)</option>
                    <option value="v3">v3 only</option>
                    <option value="v4">v4 only</option>
                  </select>
                </div>
                <div className="field">
                  <TipLabel tip={SETTING_TIPS.maxExecVsMarkBps}>
                    Max under mark (bps)
                  </TipLabel>
                  <SettingsNumber
                    value={settingsDraft.maxExecVsMarkBps ?? 2500}
                    min={100}
                    max={5000}
                    step={50}
                    onCommit={(n) =>
                      setSettingsDraft({
                        ...settingsDraft,
                        maxExecVsMarkBps: n ?? 2500,
                      })
                    }
                  />
                </div>
                <div className="field">
                  <TipLabel tip={SETTING_TIPS.dryRun}>Dry run</TipLabel>
                  <select
                    value={settingsDraft.dryRun ? "yes" : "no"}
                    onChange={(e) =>
                      setSettingsDraft({
                        ...settingsDraft,
                        dryRun: e.target.value === "yes",
                      })
                    }
                  >
                    <option value="yes">yes (prepare only)</option>
                    <option value="no">no (broadcast live)</option>
                  </select>
                </div>
              </div>
              <div className="btn-row" style={{ marginTop: 14 }}>
                <button
                  className="btn primary"
                  disabled={busy === "settings"}
                  onClick={() => void saveSettings()}
                >
                  Save settings
                </button>
                <button
                  className="btn"
                  disabled={!!busy || !status?.env.hasX}
                  type="button"
                  title="Post a test tweet — never broadcasts chain txs"
                  onClick={() => void testXPost()}
                >
                  {busy === "x-test" ? "Posting…" : "Test X post"}
                </button>
              </div>
              <p className="sub" style={{ marginTop: 10 }}>
                <code>Dry run: ON</code> blocks chain txs only.{" "}
                <code>Post to X: yes</code> still tweets on Once/Run (marked
                dry-run). Use <code>Test X post</code> to tweet without analyzing
                trades.
              </p>
            </div>
          )}
        </div>

        <div className="footer">
          <span>
            StonkTrader · Robinhood Chain
            {tba ? ` · TBA ${shortAddr(tba)}` : ""}
          </span>
          <span>
            <span
              className="dot"
              style={{ display: "inline-block", marginRight: 6 }}
            />
            Online
          </span>
        </div>
      </div>

      {allowModalOpen && (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={() => setAllowModalOpen(false)}
        >
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="Edit allowlist"
            onClick={(e) => e.stopPropagation()}
          >
            <h2>Select tokens</h2>
            <p className="sub" style={{ margin: 0 }}>
              Choose stock tokens the autopilot may trade. Venue badges come from{" "}
              <code>npm run scan:venues</code> (v3 / v4 / both). Confirm to
              update the draft, then Save settings.
            </p>
            <div className="modal-tools">
              <input
                type="search"
                placeholder="Filter symbol / name / venue…"
                value={allowFilter}
                onChange={(e) => setAllowFilter(e.target.value)}
                autoFocus
              />
              <button
                className="btn"
                type="button"
                onClick={() =>
                  setAllowDraft(filteredAssets.map((a) => a.symbol))
                }
              >
                All shown
              </button>
              <button
                className="btn"
                type="button"
                onClick={() => setAllowDraft([])}
              >
                Clear
              </button>
              <label className="onchain-toggle">
                <input
                  type="checkbox"
                  checked={allowTradeableOnly}
                  onChange={(e) => setAllowTradeableOnly(e.target.checked)}
                />
                <span>On-chain only</span>
              </label>
            </div>
            <div className="token-list">
              {filteredAssets.map((a) => {
                const selected = allowDraft.includes(a.symbol);
                const venue = a.venue ?? "?";
                return (
                  <label
                    key={a.symbol}
                    className={`token-item ${selected ? "selected" : ""} ${a.onChainTradeable === false ? "no-venue" : ""}`}
                  >
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={() => toggleSymbol(a.symbol)}
                    />
                    <span>
                      <strong>{a.symbol}</strong>
                      <div className="name">{a.name}</div>
                    </span>
                    <span className="venue-badge" title={a.preferredVenue ? `prefer ${a.preferredVenue}` : venue}>
                      {venue}
                    </span>
                  </label>
                );
              })}
              {!filteredAssets.length && (
                <div className="token-item">
                  <span />
                  <span>No matches</span>
                  <span />
                </div>
              )}
            </div>
            <div className="modal-foot">
              <span className="sub" style={{ margin: 0 }}>
                {allowDraft.length} selected
              </span>
              <div className="btn-row">
                <button
                  className="btn"
                  type="button"
                  onClick={() => setAllowModalOpen(false)}
                >
                  Cancel
                </button>
                <button
                  className="btn primary"
                  type="button"
                  onClick={confirmAllowlist}
                >
                  Confirm
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
