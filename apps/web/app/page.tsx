"use client";

import { useEffect, useMemo, useState } from "react";
import {
  HoldingsChart,
  type HistoryPoint,
} from "../components/HoldingsChart";

type Tab = "live" | "portfolio" | "log" | "settings";

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
  thesis: string;
  dryRun: boolean;
  minNotionalUsd: number;
  minEdgeBps: number;
  takeProfitPct: number;
  stopLossPct: number;
  addOnlyDipBps: number;
  estimateGasEth?: number;
};

type ShellEvent = {
  id: string;
  ts: number;
  type: string;
  message: string;
};

type Asset = {
  symbol: string;
  name: string;
  address: string;
  logoUrl: string;
  tradable: boolean;
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
      markUsd?: number | null;
      unrealizedPnlUsd?: number | null;
      unrealizedPnlPct?: number | null;
      costBasisUsd?: number | null;
      realizedPnlUsd?: number;
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
        realizedPnlUsd: number;
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

const CASH_SYMS = new Set(["WETH", "ETH", "USDG", "STONKBROKER"]);

function portfolioPnlSummary(
  portfolio: Portfolio,
  points: HistoryPoint[],
) {
  let unrealized = 0;
  let costBasis = 0;
  let hasPnl = false;
  for (const h of portfolio.analysis.holdings) {
    if (CASH_SYMS.has(h.symbol)) continue;
    if (h.unrealizedPnlUsd != null && Number.isFinite(h.unrealizedPnlUsd)) {
      unrealized += h.unrealizedPnlUsd;
      hasPnl = true;
    }
    if (h.costBasisUsd != null && Number.isFinite(h.costBasisUsd)) {
      costBasis += h.costBasisUsd;
    } else if (h.avgCostUsd != null && h.amount > 0) {
      costBasis += h.avgCostUsd * h.amount;
    }
  }
  let realized = 0;
  if (portfolio.ledger?.positions) {
    for (const p of Object.values(portfolio.ledger.positions)) {
      realized += p.realizedPnlUsd || 0;
    }
  }
  const unrealizedPct =
    costBasis > 0 ? (unrealized / costBasis) * 100 : null;

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
    costBasis: costBasis > 0 ? costBasis : null,
    unrealized: hasPnl ? unrealized : null,
    unrealizedPct,
    realized,
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

function moneySigned(n: number) {
  return n >= 0 ? `+$${n.toFixed(2)}` : `-$${Math.abs(n).toFixed(2)}`;
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

  const [assets, setAssets] = useState<Asset[]>([]);
  const [allowModalOpen, setAllowModalOpen] = useState(false);
  const [allowDraft, setAllowDraft] = useState<string[]>([]);
  const [allowFilter, setAllowFilter] = useState("");

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
    const p = await api<{ ok: true } & Portfolio>("/api/portfolio");
    setPortfolio(p);
    setBroker(p.broker);
    await refreshHistory(p.broker.tokenId).catch(() => undefined);
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

  async function refreshTrades(tokenId?: string) {
    const id = tokenId ?? status?.env.tokenId ?? undefined;
    const q = id ? `?tokenId=${encodeURIComponent(id)}` : "";
    const res = await api<{
      ok: true;
      trades: TradeEntry[];
      totals: TradeTotals;
    }>(`/api/trades${q}`);
    setTrades(res.trades);
    setTradeTotals(res.totals);
  }

  async function loadAssets() {
    const res = await api<{ ok: true; assets: Asset[] }>("/api/assets");
    setAssets(res.assets);
  }

  useEffect(() => {
    void refreshStatus().catch((e: Error) => setError(e.message));
    void refreshBroker()
      .then(() => setError(null))
      .catch((e: Error) => setError(e.message));
    void refreshPortfolio()
      .then(() => setError(null))
      .catch((e: Error) => setError(e.message));
    void refreshTrades().catch(() => undefined);
    void loadAssets().catch(() => undefined);
  }, []);

  // Poll status (and events) — faster while autopilot is running
  useEffect(() => {
    const ms = status?.agent.running ? 1500 : 4000;
    const id = setInterval(() => {
      void refreshStatus().catch(() => undefined);
    }, ms);
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

  useEffect(() => {
    if (tab === "portfolio") {
      void refreshPortfolio().catch((e: Error) => setError(e.message));
    }
    if (tab === "log") {
      void refreshTrades().catch((e: Error) => setError(e.message));
    }
  }, [tab]);

  // Refresh trade log when txs land
  useEffect(() => {
    const last = events.at(-1);
    if (!last) return;
    if (
      last.type === "agent.tx" ||
      last.type === "agent.dry_run" ||
      last.type === "agent.prepare"
    ) {
      void refreshTrades().catch(() => undefined);
    }
  }, [events]);

  const cashPct = portfolio?.analysis.cashPct ?? null;
  const cashUsd = portfolio?.analysis.cashUsd ?? null;
  const bookUsd = portfolio?.analysis.contentsUsd ?? null;

  const tba = broker?.tba ?? portfolio?.broker.tba ?? null;
  const owner = broker?.owner ?? portfolio?.broker.owner ?? null;
  const brokerName = broker?.name ?? portfolio?.broker.name ?? null;
  const brokerImage = broker?.image ?? portfolio?.broker.image ?? null;

  const filteredAssets = useMemo(() => {
    const q = allowFilter.trim().toUpperCase();
    if (!q) return assets;
    return assets.filter(
      (a) =>
        a.symbol.includes(q) ||
        a.name.toUpperCase().includes(q) ||
        a.address.toUpperCase().includes(q),
    );
  }, [assets, allowFilter]);

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
      setTab("live");
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
          <span className={`dot ${status?.agent.running ? "" : "off"}`} />
          <span className="ticker-left">
            {status?.agent.running
              ? `RUNNING · ${status.agent.state.toUpperCase()}`
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
                <div className="nft-placeholder">
                  {broker || portfolio ? "NO IMG" : "…"}
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
              <div className="value">
                {cashUsd != null ? `$${cashUsd.toFixed(2)}` : "—"}
              </div>
              <div className="label">Cash</div>
            </div>
            <div className="stat">
              <div className="value">
                {cashPct != null ? `${cashPct.toFixed(0)}%` : "—"}
              </div>
              <div className="label">Cash pct</div>
            </div>
            <div className="stat">
              <div className="value">
                {bookUsd != null ? `$${bookUsd.toFixed(2)}` : "—"}
              </div>
              <div className="label">Book</div>
            </div>
            <div className="stat">
              <div className="value">{status?.agent.state ?? "—"}</div>
              <div className="label">Agent state</div>
            </div>
          </div>

          <div className="tabs">
            {(["live", "portfolio", "log", "settings"] as Tab[]).map((t) => (
              <button
                key={t}
                className={`tab ${tab === t ? "active" : ""}`}
                onClick={() => setTab(t)}
              >
                {t}
              </button>
            ))}
          </div>

          <div className="btn-row">
            <button
              className="btn primary"
              disabled={!!busy || status?.agent.running}
              onClick={() => void postAgent("/api/agent/start")}
            >
              Run
            </button>
            <button
              className="btn"
              disabled={!!busy || !status?.agent.running}
              onClick={() => void postAgent("/api/agent/pause")}
            >
              Pause
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
              <h2>Live feed</h2>
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
                        : ev.type.includes("skip") || ev.type.includes("warn")
                          ? "warn"
                          : ev.type === "agent.fee"
                            ? "ok"
                            : ""
                    }`}
                  >
                    <span>{new Date(ev.ts).toLocaleTimeString()}</span>
                    <span className="msg">
                      [{ev.type}] {ev.message}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {tab === "portfolio" && (
            <div className="panel">
              <h2>Portfolio</h2>
              {portfolio ? (
                <>
                  {(() => {
                    const pnl = portfolioPnlSummary(portfolio, history.points);
                    const pCls = pnlClass(pnl.periodPnl);
                    const uCls = pnlClass(pnl.unrealized);
                    return (
                      <div className="stats pnl-stats" style={{ marginBottom: 18 }}>
                        <div className="stat">
                          <div className="value">
                            {pnl.book != null ? `$${pnl.book.toFixed(2)}` : "—"}
                          </div>
                          <div className="label">Book</div>
                        </div>
                        <div className="stat">
                          <div className={`value ${pCls}`}>
                            {pnl.periodPnl == null
                              ? "—"
                              : moneySigned(pnl.periodPnl)}
                          </div>
                          <div className="label">
                            Period P&amp;L
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
                            {pnl.unrealized == null
                              ? "—"
                              : moneySigned(pnl.unrealized)}
                          </div>
                          <div className="label">
                            Open (vs cost)
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

                  <table className="holdings" style={{ marginTop: 18 }}>
                    <thead>
                      <tr>
                        <th>Symbol</th>
                        <th>Amount</th>
                        <th>Mark</th>
                        <th>Avg cost</th>
                        <th>USD</th>
                        <th>P&amp;L</th>
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
                          : fmtPnl(h.unrealizedPnlUsd, h.unrealizedPnlPct);
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
                            <td>{isCash ? "—" : fmtUsd(mark, 4)}</td>
                            <td>
                              {isCash
                                ? "—"
                                : h.avgCostUsd != null
                                  ? fmtUsd(h.avgCostUsd, 4)
                                  : "—"}
                            </td>
                            <td>{fmtUsd(h.usd)}</td>
                            <td className={pnl.cls}>{pnl.text}</td>
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
                <p className="sub">Loading portfolio…</p>
              )}
            </div>
          )}

          {tab === "log" && (
            <div className="panel">
              <h2>Swap log</h2>
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
              {tradeTotals && (
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
              {trades.length === 0 ? (
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

              <p className="sub" style={{ margin: "10px 0 14px" }}>
                Secrets stay in <code>.env</code>. This form edits{" "}
                <code>data/settings.json</code>. Broadcast when{" "}
                <code>Dry run: OFF</code>. Swaps skip unless expected edge
                beats gas+slip.
              </p>
              <div className="form-grid">
                <div className="field">
                  <label>Policy</label>
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
                  <label>Reserve WETH %</label>
                  <input
                    type="number"
                    value={settingsDraft.reserveWethPct}
                    onChange={(e) =>
                      setSettingsDraft({
                        ...settingsDraft,
                        reserveWethPct: Number(e.target.value),
                      })
                    }
                  />
                </div>
                <div className="field">
                  <label>Deploy %</label>
                  <input
                    type="number"
                    value={settingsDraft.deployPct}
                    onChange={(e) =>
                      setSettingsDraft({
                        ...settingsDraft,
                        deployPct: Number(e.target.value),
                      })
                    }
                  />
                </div>
                <div className="field">
                  <label>Interval ms</label>
                  <input
                    type="number"
                    value={settingsDraft.intervalMs}
                    onChange={(e) =>
                      setSettingsDraft({
                        ...settingsDraft,
                        intervalMs: Number(e.target.value),
                      })
                    }
                  />
                </div>
                <div className="field">
                  <label>Max notional ETH</label>
                  <input
                    type="number"
                    step="0.001"
                    value={settingsDraft.maxNotionalEth}
                    onChange={(e) =>
                      setSettingsDraft({
                        ...settingsDraft,
                        maxNotionalEth: Number(e.target.value),
                      })
                    }
                  />
                </div>
                <div className="field">
                  <label>Max actions / pass</label>
                  <input
                    type="number"
                    value={settingsDraft.maxActionsPerPass}
                    onChange={(e) =>
                      setSettingsDraft({
                        ...settingsDraft,
                        maxActionsPerPass: Number(e.target.value),
                      })
                    }
                  />
                </div>
                <div className="field">
                  <label>Min notional USD</label>
                  <input
                    type="number"
                    step="1"
                    value={settingsDraft.minNotionalUsd ?? 25}
                    onChange={(e) =>
                      setSettingsDraft({
                        ...settingsDraft,
                        minNotionalUsd: Number(e.target.value),
                      })
                    }
                  />
                </div>
                <div className="field">
                  <label>Min edge bps</label>
                  <input
                    type="number"
                    step="1"
                    value={settingsDraft.minEdgeBps ?? 40}
                    onChange={(e) =>
                      setSettingsDraft({
                        ...settingsDraft,
                        minEdgeBps: Number(e.target.value),
                      })
                    }
                  />
                </div>
                <div className="field">
                  <label>Take profit %</label>
                  <input
                    type="number"
                    step="0.1"
                    value={settingsDraft.takeProfitPct ?? 3}
                    onChange={(e) =>
                      setSettingsDraft({
                        ...settingsDraft,
                        takeProfitPct: Number(e.target.value),
                      })
                    }
                  />
                </div>
                <div className="field">
                  <label>Stop loss %</label>
                  <input
                    type="number"
                    step="0.1"
                    value={settingsDraft.stopLossPct ?? 2.5}
                    onChange={(e) =>
                      setSettingsDraft({
                        ...settingsDraft,
                        stopLossPct: Number(e.target.value),
                      })
                    }
                  />
                </div>
                <div className="field">
                  <label>Add-only dip bps</label>
                  <input
                    type="number"
                    step="1"
                    value={settingsDraft.addOnlyDipBps ?? 50}
                    onChange={(e) =>
                      setSettingsDraft({
                        ...settingsDraft,
                        addOnlyDipBps: Number(e.target.value),
                      })
                    }
                  />
                </div>
                <div className="field">
                  <label>Est. gas ETH / step</label>
                  <input
                    type="number"
                    step="0.000001"
                    placeholder="auto from trade-log"
                    value={settingsDraft.estimateGasEth ?? ""}
                    onChange={(e) => {
                      const v = e.target.value;
                      setSettingsDraft({
                        ...settingsDraft,
                        estimateGasEth:
                          v === "" ? undefined : Number(v),
                      });
                    }}
                  />
                </div>
                <div className="field full">
                  <label>Allowlist ({settingsDraft.allowlist.length} symbols)</label>
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
                  <label>Thesis notes</label>
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
                  <label>Post to X</label>
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
                  <label>Dry run</label>
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
            <h2>Select tokens█</h2>
            <p className="sub" style={{ margin: 0 }}>
              Choose stock tokens the autopilot may trade. Confirm to update the
              draft, then Save settings.
            </p>
            <div className="modal-tools">
              <input
                placeholder="Filter symbol / name…"
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
            </div>
            <div className="token-list">
              {filteredAssets.map((a) => {
                const selected = allowDraft.includes(a.symbol);
                return (
                  <label
                    key={a.symbol}
                    className={`token-item ${selected ? "selected" : ""}`}
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
                    <span className="name">{shortAddr(a.address)}</span>
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
