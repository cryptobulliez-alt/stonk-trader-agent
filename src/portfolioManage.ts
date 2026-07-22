import {
  formatUnits,
  getAddress,
  parseAbiItem,
  type Address,
  type PublicClient,
} from "viem";
import { getBroker, findTradeRoute } from "./brokerReads.js";
import { prepareBrokerTrade } from "./brokerPrepare.js";
import { STOCK_TOKENS, WETH } from "./config.js";
import { CONTRACTS, dividendStockSymbols } from "./contracts.js";
import { getEthUsd, priceTokenUsd } from "./prices.js";
import { findBestEthStockPool } from "./v4.js";
import {
  riskBudgetBuyCapUsd,
  stopLossTrimFraction,
} from "./shell/skills.js";

export type ManagePolicy =
  | "core" // keep ~reserveWethPct WETH; trim stock profits into cash; sleeve the rest across buy universe
  | "equal_weight" // equal USD among buy universe; sell overweight + buy underweight from WETH
  | "deploy" // spend WETH (above reserve) into symbols — for cash-heavy books
  | "targets" // rebalance toward explicit weight map from research (e.g. NVDA:40,AAPL:40,WETH:20)
  | "trim" // sell pct of one stock into WETH
  | "dry_powder" // sell stocks into WETH until WETH >= targetPct
  | "max_name"; // cap any single stock; trim excess → WETH

export type PortfolioAction = {
  action: "hold" | "swap";
  side?: "buy" | "sell";
  reason: string;
  tokenIn?: string;
  tokenOut?: string;
  amountIn?: string;
  notionalUsd?: number;
  tradeable: boolean;
  priority: number;
};

export type TargetWeights = Record<string, number>;

const transferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

const BOOSTER_DEPLOY_BLOCK = 12_514_721n;
const MIN_NOTIONAL_USD = 1;
const BAND = 0.05; // ±5% rebalance band

/** Default sleeves — v4 ETH/stock pools cover AAPL/AMZN/etc. */
const DEFAULT_BUY_SYMBOLS = ["AAPL", "NVDA", "TSLA", "AMZN"] as const;

export async function fetchBrokerArt(client: PublicClient, id: number) {
  try {
    const uri = await client.readContract({
      address: CONTRACTS.nft,
      abi: [
        {
          type: "function",
          name: "tokenURI",
          stateMutability: "view",
          inputs: [{ name: "tokenId", type: "uint256" }],
          outputs: [{ type: "string" }],
        },
      ] as const,
      functionName: "tokenURI",
      args: [BigInt(id)],
    });
    if (!uri.startsWith("data:application/json;base64,")) {
      return { name: null, image: null, attributes: null, raw: uri, partial: true };
    }
    const json = JSON.parse(
      Buffer.from(uri.slice("data:application/json;base64,".length), "base64").toString(
        "utf8",
      ),
    ) as {
      name?: string;
      image?: string;
      attributes?: Array<{ trait_type: string; value: string }>;
    };
    return {
      name: json.name ?? null,
      image: json.image ?? null,
      attributes: json.attributes ?? null,
      partial: false,
    };
  } catch {
    return { name: null, image: null, attributes: null, partial: true };
  }
}

export async function fetchDividends(
  client: PublicClient,
  wallet: Address,
  active: boolean,
) {
  if (!active) {
    return {
      byStock: [] as Array<{
        token: Address;
        symbol: string;
        count: number | null;
        amount: number | null;
      }>,
      note: "Inactive brokers do not receive StockBooster drops.",
      partial: false,
    };
  }

  const stocks = await client.readContract({
    address: CONTRACTS.stockBooster,
    abi: [
      {
        type: "function",
        name: "getStockTokens",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "address" }, { type: "address" }, { type: "address" }],
      },
    ] as const,
    functionName: "getStockTokens",
  });

  const byStock = [];
  let partial = false;
  const latest = await client.getBlockNumber();

  for (const token of stocks as readonly Address[]) {
    const symbol =
      dividendStockSymbols[token.toLowerCase()] ?? `${token.slice(0, 6)}…`;
    try {
      let count = 0;
      let amount = 0n;
      let from = BOOSTER_DEPLOY_BLOCK;
      const chunk = 200_000n;
      while (from <= latest) {
        const to = from + chunk > latest ? latest : from + chunk;
        const logs = await client.getLogs({
          address: getAddress(token),
          event: transferEvent,
          args: {
            from: CONTRACTS.stockBooster,
            to: getAddress(wallet),
          },
          fromBlock: from,
          toBlock: to,
        });
        for (const log of logs) {
          count += 1;
          amount += log.args.value ?? 0n;
        }
        from = to + 1n;
      }
      byStock.push({
        token: getAddress(token),
        symbol,
        count,
        amount: Number(formatUnits(amount, 18)),
      });
    } catch {
      partial = true;
      byStock.push({
        token: getAddress(token),
        symbol,
        count: null,
        amount: null,
      });
    }
  }

  return {
    byStock,
    note: "StockBooster → TBA Transfer logs (auto-dropped rewards; other inflows excluded).",
    partial,
  };
}

type PricedHolding = {
  token: Address;
  symbol: string;
  amount: number;
  amountRaw: string;
  decimals: number;
  usd: number | null;
  priceUsd: number | null;
  priceSource: string | null;
  tradeableToWeth: boolean;
  routeFromWeth: string | null;
  weightPct: number | null;
};

async function resolveBuyUniverse(
  client: PublicClient,
  symbols: string[] | undefined,
): Promise<string[]> {
  const wanted = (symbols?.length ? symbols : [...DEFAULT_BUY_SYMBOLS]).map((s) =>
    s.toUpperCase(),
  );
  const out: string[] = [];
  for (const sym of wanted) {
    const addr = STOCK_TOKENS[sym];
    if (!addr) continue;
    if (["WETH", "USDG"].includes(sym)) continue;
    const v4 = await findBestEthStockPool(client, addr);
    if (v4) {
      out.push(sym);
      continue;
    }
    const route = await findTradeRoute(client, WETH, addr);
    if (route) out.push(sym);
  }
  return out;
}

export function parseTargetWeights(raw: string | TargetWeights | undefined): TargetWeights | undefined {
  if (!raw) return undefined;
  if (typeof raw !== "string") return normalizeTargets(raw);
  const map: TargetWeights = {};
  for (const part of raw.split(/[,;\s]+/).filter(Boolean)) {
    const [sym, pctStr] = part.includes(":") ? part.split(":") : part.split("=");
    if (!sym || pctStr == null) continue;
    const pct = Number(pctStr);
    if (!Number.isFinite(pct) || pct < 0) continue;
    map[sym.toUpperCase()] = pct;
  }
  return normalizeTargets(map);
}

function normalizeTargets(map: TargetWeights): TargetWeights {
  const out: TargetWeights = {};
  for (const [k, v] of Object.entries(map)) {
    out[k.toUpperCase()] = v;
  }
  return out;
}

export type ManageOpts = {
  policy?: ManagePolicy;
  trimSymbol?: string;
  trimPct?: number;
  targetWethPct?: number;
  maxNamePct?: number;
  /** Keep at least this % in WETH (default 30). */
  reserveWethPct?: number;
  /** Max % of total portfolio to deploy in one manage pass (default 15). */
  deployPct?: number;
  /** Candidate universe (allowlist) — not an equal-weight buy list. */
  symbols?: string[];
  /** Explicit target weights from research, e.g. { NVDA: 40, AAPL: 40, WETH: 20 }. */
  targets?: string | TargetWeights;
  thesis?: string;
  /** Selective buys this pass (from LLM / thesis) — subset of allowlist. */
  preferBuys?: string[];
  /** Discretionary trims this pass (trend break) — subset of held names. */
  preferSells?: string[];
  /** Unrealized P&L % by symbol — prefer trimming winners when raising cash. */
  unrealizedPnlPct?: Record<string, number>;
  /** Avg cost USD by symbol (for dip-only adds). */
  avgCostUsd?: Record<string, number>;
  /** Skip scheduling swaps below this USD (default MIN_NOTIONAL_USD). */
  minNotionalUsd?: number;
  takeProfitPct?: number;
  stopLossPct?: number;
  addOnlyDipBps?: number;
  /** Max book % at risk if stop hits on a new open (position-sizing skill). */
  maxRiskPctPerTrade?: number;
};

export async function analyzeBrokerPortfolio(
  client: PublicClient,
  id: number,
  opts: ManageOpts = {},
) {
  const broker = await getBroker(client, id);
  const ethUsd = await getEthUsd(client);
  const art = await fetchBrokerArt(client, id);
  const dividends = await fetchDividends(
    client,
    broker.wallet as Address,
    Boolean(broker.activation.active),
  );

  const priced: PricedHolding[] = [];
  const unpriced: string[] = [];
  let contentsUsd = 0;

  for (const h of broker.holdings) {
    const p = await priceTokenUsd(
      client,
      h.token as Address,
      h.symbol,
      h.decimals,
      ethUsd,
    );
    const usd = p.usd != null ? h.amount * p.usd : null;
    if (usd != null) contentsUsd += usd;
    else unpriced.push(h.symbol);
    const isWeth = h.token.toLowerCase() === CONTRACTS.weth.toLowerCase();
    let routeFromWeth: string | null = null;
    let tradeableToWeth = isWeth;
    if (!isWeth) {
      const v4 = await findBestEthStockPool(client, h.token as Address);
      if (v4) {
        tradeableToWeth = true;
        routeFromWeth = `v4/${v4.key.fee}`;
      } else {
        const route = await findTradeRoute(client, h.token as Address, CONTRACTS.weth);
        tradeableToWeth = route != null;
        routeFromWeth = route
          ? route.kind === "direct"
            ? `v3/${route.fee}`
            : `v3 via ${route.midSymbol}`
          : null;
      }
    }
    priced.push({
      ...h,
      token: h.token as Address,
      usd: usd != null ? +usd.toFixed(4) : null,
      priceUsd: p.usd != null ? +p.usd.toFixed(6) : null,
      priceSource: p.source,
      tradeableToWeth,
      routeFromWeth,
      weightPct: null,
    });
  }

  // Surface WETH even at zero so deploy/buy policies are obvious
  if (!priced.some((h) => h.symbol === "WETH")) {
    priced.push({
      token: CONTRACTS.weth,
      symbol: "WETH",
      amount: 0,
      amountRaw: "0",
      decimals: 18,
      usd: 0,
      priceUsd: ethUsd != null ? +ethUsd.toFixed(6) : null,
      priceSource: ethUsd != null ? "USDG/WETH" : null,
      tradeableToWeth: true,
      routeFromWeth: "n/a",
      weightPct: 0,
    });
  }

  let ethUsdValue: number | null = null;
  if (broker.ethBalance > 0 && ethUsd != null) {
    ethUsdValue = broker.ethBalance * ethUsd;
    contentsUsd += ethUsdValue;
  } else if (broker.ethBalance > 0) {
    unpriced.push("ETH");
  }

  for (const h of priced) {
    h.weightPct =
      contentsUsd > 0 && h.usd != null ? +((h.usd / contentsUsd) * 100).toFixed(2) : null;
  }

  const buyUniverse = await resolveBuyUniverse(client, opts.symbols);
  const policy = opts.policy ?? "core";
  const targets = parseTargetWeights(opts.targets);
  const cashUsd = (priced.find((h) => h.symbol === "WETH")?.usd ?? 0) + (ethUsdValue ?? 0);
  const actions = buildActions(priced, {
    policy,
    trimSymbol: opts.trimSymbol,
    trimPct: opts.trimPct ?? 10,
    targetWethPct: opts.targetWethPct ?? 30,
    maxNamePct: opts.maxNamePct ?? 40,
    reserveWethPct: opts.reserveWethPct ?? 30,
    deployPct: opts.deployPct ?? 15,
    contentsUsd,
    cashUsd,
    ethUsd,
    buyUniverse,
    targets,
    thesis: opts.thesis,
    unrealizedPnlPct: opts.unrealizedPnlPct,
    avgCostUsd: opts.avgCostUsd,
    minNotionalUsd: opts.minNotionalUsd,
    takeProfitPct: opts.takeProfitPct,
    stopLossPct: opts.stopLossPct,
    addOnlyDipBps: opts.addOnlyDipBps,
    maxRiskPctPerTrade: opts.maxRiskPctPerTrade,
    preferBuys: opts.preferBuys,
    preferSells: opts.preferSells,
  });

  return {
    ok: true,
    id,
    owner: broker.owner,
    wallet: broker.wallet,
    activation: broker.activation,
    seed: broker.seed,
    art,
    dividends,
    ethBalance: broker.ethBalance,
    ethBalanceUsd: ethUsdValue != null ? +ethUsdValue.toFixed(4) : null,
    ethUsd: ethUsd != null ? +ethUsd.toFixed(2) : null,
    cashUsd: +cashUsd.toFixed(2),
    cashPct: contentsUsd > 0 ? +((cashUsd / contentsUsd) * 100).toFixed(2) : 0,
    targetCashPct: opts.reserveWethPct ?? 30,
    holdings: priced,
    contentsUsd: +contentsUsd.toFixed(2),
    unpricedAssets: unpriced.length ? unpriced : undefined,
    buyUniverse,
    policy,
    targets: targets ?? null,
    thesis: opts.thesis ?? null,
    actions,
    fundingHint:
      contentsUsd < 1
        ? `TBA looks underfunded (~$${contentsUsd.toFixed(2)}). Send WETH to ${broker.wallet} (not the owner EOA) before deploy/buy policies can act.`
        : null,
    disclaimer:
      "Decision support only — not financial advice. No strategy guarantees profit. Onchain stock tokens are geo-restricted. Opportunity buys come from your research targets — this tool sizes/rebalances, it does not predict alpha.",
    bindingRules: broker.bindingRules,
  };
}

function usdToWethAmount(usd: number, ethUsd: number | null): string | null {
  if (ethUsd == null || ethUsd <= 0 || usd <= 0) return null;
  return (usd / ethUsd).toPrecision(6);
}

function pushSell(
  actions: PortfolioAction[],
  h: { symbol: string; amount: number; usd: number },
  sellUsd: number,
  reason: string,
  priority: number,
  minNotional = MIN_NOTIONAL_USD,
) {
  if (sellUsd < minNotional || h.usd <= 0) return;
  const amountIn = ((Math.min(sellUsd, h.usd) / h.usd) * h.amount).toPrecision(6);
  actions.push({
    action: "swap",
    side: "sell",
    reason,
    tokenIn: h.symbol,
    tokenOut: "WETH",
    amountIn,
    notionalUsd: +Math.min(sellUsd, h.usd).toFixed(2),
    tradeable: true,
    priority,
  });
}

function pushBuy(
  actions: PortfolioAction[],
  symbol: string,
  buyUsd: number,
  ethUsd: number | null,
  wethAvailableUsd: number,
  reason: string,
  priority: number,
  minNotional = MIN_NOTIONAL_USD,
) {
  const spend = Math.min(buyUsd, wethAvailableUsd);
  if (spend < minNotional) return;
  const amountIn = usdToWethAmount(spend, ethUsd);
  if (!amountIn) return;
  actions.push({
    action: "swap",
    side: "buy",
    reason,
    tokenIn: "WETH",
    tokenOut: symbol,
    amountIn,
    notionalUsd: +spend.toFixed(2),
    tradeable: true,
    priority,
  });
}

function buildActions(
  holdings: PricedHolding[],
  opts: {
    policy: ManagePolicy;
    trimSymbol?: string;
    trimPct: number;
    targetWethPct: number;
    maxNamePct: number;
    reserveWethPct: number;
    deployPct: number;
    contentsUsd: number;
    cashUsd: number;
    ethUsd: number | null;
    buyUniverse: string[];
    targets?: TargetWeights;
    thesis?: string;
    unrealizedPnlPct?: Record<string, number>;
    avgCostUsd?: Record<string, number>;
    minNotionalUsd?: number;
    takeProfitPct?: number;
    stopLossPct?: number;
    addOnlyDipBps?: number;
    maxRiskPctPerTrade?: number;
    preferBuys?: string[];
    preferSells?: string[];
  },
): PortfolioAction[] {
  const actions: PortfolioAction[] = [];
  const stocks = holdings.filter(
    (h) => !["WETH", "USDG", "STONKBROKER", "ETH"].includes(h.symbol),
  );
  const weth = holdings.find((h) => h.symbol === "WETH");
  const wethUsd = weth?.usd ?? 0;
  const cashUsd = opts.cashUsd;
  const cashPct = opts.contentsUsd > 0 ? (cashUsd / opts.contentsUsd) * 100 : 0;
  const wethPct = weth?.weightPct ?? 0;
  let wethBudget = wethUsd; // depletes as we schedule buys in this plan
  const minNotional = opts.minNotionalUsd ?? MIN_NOTIONAL_USD;

  for (const h of stocks) {
    if (!h.tradeableToWeth && (h.usd ?? 0) > 0) {
      actions.push({
        action: "hold",
        reason: `${h.symbol} has no WETH/ETH pool — cannot rebalance onchain until liquidity exists`,
        tokenIn: h.symbol,
        tradeable: false,
        priority: 0,
      });
    }
  }

  const tradeable = stocks.filter((h) => h.tradeableToWeth && h.usd != null && h.usd > 0);
  const thesisNote = opts.thesis ? ` Thesis: ${opts.thesis}` : "";

  if (opts.policy === "core") {
    return finalize(
      buildCoreActions(actions, tradeable, {
        contentsUsd: opts.contentsUsd,
        cashUsd,
        cashPct,
        reserveWethPct: opts.reserveWethPct,
        deployPct: opts.deployPct,
        ethUsd: opts.ethUsd,
        buyUniverse: opts.buyUniverse,
        thesisNote,
        wethBudget,
        unrealizedPnlPct: opts.unrealizedPnlPct,
        avgCostUsd: opts.avgCostUsd,
        priceUsd: Object.fromEntries(
          holdings
            .filter((h) => h.priceUsd != null)
            .map((h) => [h.symbol.toUpperCase(), h.priceUsd as number]),
        ),
        minNotionalUsd: minNotional,
        takeProfitPct: opts.takeProfitPct ?? 3,
        stopLossPct: opts.stopLossPct ?? 2.5,
        addOnlyDipBps: opts.addOnlyDipBps ?? 50,
        maxNamePct: opts.maxNamePct,
        maxRiskPctPerTrade: opts.maxRiskPctPerTrade ?? 1.5,
        preferBuys: opts.preferBuys,
        preferSells: opts.preferSells,
      }),
      `Core: ~${opts.reserveWethPct}% cash · selective sleeve (allowlist = candidates, not equal-weight)`,
    );
  }

  if (opts.policy === "trim") {
    const sym = (
      opts.trimSymbol ||
      tradeable.sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0))[0]?.symbol
    )?.toUpperCase();
    const h = tradeable.find((x) => x.symbol === sym);
    if (!h || h.usd == null) {
      actions.push({
        action: "hold",
        reason: "Nothing tradeable to trim",
        tradeable: false,
        priority: 0,
      });
      return actions;
    }
    pushSell(
      actions,
      { symbol: h.symbol, amount: h.amount, usd: h.usd },
      (h.usd * opts.trimPct) / 100,
      `Trim ${opts.trimPct}% of ${h.symbol} → WETH`,
      1,
    );
    return finalize(actions);
  }

  if (opts.policy === "dry_powder") {
    if (wethPct >= opts.targetWethPct) {
      actions.push({
        action: "hold",
        reason: `WETH already ${wethPct}% ≥ target ${opts.targetWethPct}%`,
        tradeable: true,
        priority: 0,
      });
      return actions;
    }
    let remaining =
      opts.contentsUsd * (opts.targetWethPct / 100) - wethUsd;
    const sorted = [...tradeable].sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0));
    for (const h of sorted) {
      if (remaining <= 0 || h.usd == null) break;
      const sellUsd = Math.min(remaining, h.usd * 0.5);
      pushSell(
        actions,
        { symbol: h.symbol, amount: h.amount, usd: h.usd },
        sellUsd,
        `Raise dry powder toward ${opts.targetWethPct}% WETH`,
        1,
      );
      remaining -= sellUsd;
    }
    return finalize(actions);
  }

  if (opts.policy === "max_name") {
    for (const h of tradeable) {
      if ((h.weightPct ?? 0) <= opts.maxNamePct || h.usd == null) continue;
      const targetUsd = opts.contentsUsd * (opts.maxNamePct / 100);
      pushSell(
        actions,
        { symbol: h.symbol, amount: h.amount, usd: h.usd },
        h.usd - targetUsd,
        `${h.symbol} at ${h.weightPct}% > max ${opts.maxNamePct}% — trim excess to WETH`,
        1,
      );
    }
    return finalize(actions, `No name above ${opts.maxNamePct}% cap`);
  }

  if (opts.policy === "targets") {
    if (!opts.targets || !Object.keys(opts.targets).length) {
      actions.push({
        action: "hold",
        reason:
          "targets policy needs weights (e.g. NVDA:40,AAPL:40,WETH:20) from research",
        tradeable: false,
        priority: 0,
      });
      return actions;
    }
    const targeted = rebalanceToTargets(actions, holdings, {
      targets: opts.targets,
      contentsUsd: opts.contentsUsd,
      ethUsd: opts.ethUsd,
      wethBudget,
      thesisNote,
      buyUniverse: opts.buyUniverse,
    });
    return finalize(
      targeted,
      wethUsd < MIN_NOTIONAL_USD
        ? "Targets need WETH in the TBA to buy underweight sleeves — fund the token-bound wallet"
        : "Already near target weights (±5%), or remaining deltas below $1 min notional",
    );
  }

  if (opts.policy === "deploy") {
    return finalize(
      deployWeth(actions, {
        symbols: opts.buyUniverse,
        contentsUsd: opts.contentsUsd,
        wethUsd,
        reserveWethPct: opts.reserveWethPct,
        deployPct: opts.deployPct,
        ethUsd: opts.ethUsd,
        thesisNote,
      }),
    );
  }

  // equal_weight: if book is cash-heavy, deploy into buy universe; else rebalance held names + fill underweights with WETH
  const stockUsd = tradeable.reduce((s, h) => s + (h.usd ?? 0), 0);
  const cashHeavy =
    opts.contentsUsd > 0 &&
    wethUsd >= opts.contentsUsd * 0.5 &&
    stockUsd < opts.contentsUsd * 0.5;

  if (cashHeavy || tradeable.length === 0) {
    if (wethUsd < MIN_NOTIONAL_USD) {
      actions.push({
        action: "hold",
        reason:
          "Need WETH in the TBA to buy opportunities — fund the token-bound wallet, then re-run with deploy/targets",
        tradeable: false,
        priority: 0,
      });
      return actions;
    }
    return finalize(
      deployWeth(actions, {
        symbols: opts.buyUniverse,
        contentsUsd: opts.contentsUsd,
        wethUsd,
        reserveWethPct: opts.reserveWethPct,
        deployPct: opts.deployPct,
        ethUsd: opts.ethUsd,
        thesisNote: thesisNote || " equal_weight auto-deploy (cash-heavy book)",
      }),
    );
  }

  // Rebalance existing tradeable names toward equal USD, buying underweights with WETH
  const target = stockUsd / tradeable.length;
  for (const h of tradeable) {
    const usd = h.usd ?? 0;
    if (usd > target * (1 + BAND)) {
      pushSell(
        actions,
        { symbol: h.symbol, amount: h.amount, usd },
        usd - target,
        `Equal-weight: trim overweight ${h.symbol} → WETH`,
        1,
      );
    }
  }
  // Estimated WETH after sells in this plan
  const plannedSellUsd = actions
    .filter((a) => a.side === "sell")
    .reduce((s, a) => s + (a.notionalUsd ?? 0), 0);
  wethBudget = wethUsd + plannedSellUsd;

  for (const h of tradeable) {
    const usd = h.usd ?? 0;
    if (usd >= target * (1 - BAND)) continue;
    const need = target - usd;
    const before = wethBudget;
    pushBuy(
      actions,
      h.symbol,
      need,
      opts.ethUsd,
      wethBudget,
      `Equal-weight: buy underweight ${h.symbol} with WETH`,
      2,
    );
    const spent =
      actions.filter((a) => a.side === "buy" && a.tokenOut === h.symbol).at(-1)
        ?.notionalUsd ?? 0;
    if (spent > 0 && spent <= before) wethBudget -= spent;
  }

  // Optionally open missing names — capped by reserve + per-pass deployPct
  const held = new Set(tradeable.map((h) => h.symbol));
  const missing = opts.buyUniverse.filter((s) => !held.has(s));
  const deployable = deployableUsd(
    opts.contentsUsd,
    wethBudget,
    opts.reserveWethPct,
    opts.deployPct,
  );
  if (missing.length && deployable >= MIN_NOTIONAL_USD) {
    const per = deployable / missing.length;
    for (const sym of missing) {
      pushBuy(
        actions,
        sym,
        per,
        opts.ethUsd,
        wethBudget,
        `Equal-weight: open ${sym} (≤${opts.deployPct}% book / pass)${thesisNote}`,
        3,
      );
      const spent =
        actions.filter((a) => a.side === "buy" && a.tokenOut === sym).at(-1)
          ?.notionalUsd ?? 0;
      wethBudget -= spent;
    }
  }

  return finalize(actions, "Tradeable book already near equal-weight (±5%)");
}

/**
 * Autopilot core: keep ~reserveWethPct in cash (WETH+ETH).
 * 1) If cash low → sell stocks (largest first) to restore cash.
 * 2) If cash ok → diversify the stock sleeve; buy only with cash above reserve.
 */
function buildCoreActions(
  actions: PortfolioAction[],
  tradeable: Array<{
    symbol: string;
    amount: number;
    usd: number | null;
    weightPct: number | null;
    tradeableToWeth: boolean;
  }>,
  opts: {
    contentsUsd: number;
    cashUsd: number;
    cashPct: number;
    reserveWethPct: number;
    deployPct: number;
    ethUsd: number | null;
    buyUniverse: string[];
    thesisNote: string;
    wethBudget: number;
    unrealizedPnlPct?: Record<string, number>;
    avgCostUsd?: Record<string, number>;
    priceUsd?: Record<string, number>;
    minNotionalUsd: number;
    takeProfitPct: number;
    stopLossPct: number;
    addOnlyDipBps: number;
    maxNamePct: number;
    maxRiskPctPerTrade: number;
    preferBuys?: string[];
    preferSells?: string[];
  },
): PortfolioAction[] {
  const minN = opts.minNotionalUsd;
  const maxNamePct = opts.maxNamePct > 0 ? opts.maxNamePct : 40;
  const targetCashUsd = opts.contentsUsd * (opts.reserveWethPct / 100);
  let wethBudget = opts.wethBudget;
  const pnlOf = (sym: string) => opts.unrealizedPnlPct?.[sym.toUpperCase()] ?? 0;
  const avgOf = (sym: string) => opts.avgCostUsd?.[sym.toUpperCase()];
  const markOf = (sym: string) => opts.priceUsd?.[sym.toUpperCase()];
  const universe = new Set(
    (opts.buyUniverse.length
      ? opts.buyUniverse
      : tradeable.map((h) => h.symbol)
    ).map((s) => s.toUpperCase()),
  );
  const bySym = new Map(tradeable.map((h) => [h.symbol.toUpperCase(), h]));

  // Phase 1 — restore cash core (liquidity first)
  if (opts.cashUsd < targetCashUsd * (1 - BAND)) {
    let need = targetCashUsd - opts.cashUsd;
    const sorted = [...tradeable].sort((a, b) => {
      const pnlDiff = pnlOf(b.symbol) - pnlOf(a.symbol);
      if (Math.abs(pnlDiff) > 0.5) return pnlDiff;
      return (b.usd ?? 0) - (a.usd ?? 0);
    });
    for (const h of sorted) {
      if (need < minN || h.usd == null || h.usd <= 0) break;
      const sellUsd = Math.min(need, h.usd * 0.6);
      const pnl = pnlOf(h.symbol);
      const pnlNote =
        opts.unrealizedPnlPct && h.symbol.toUpperCase() in opts.unrealizedPnlPct
          ? ` · uPnL ${pnl >= 0 ? "+" : ""}${pnl.toFixed(1)}%`
          : "";
      pushSell(
        actions,
        { symbol: h.symbol, amount: h.amount, usd: h.usd },
        sellUsd,
        `Core: raise cash to ${opts.reserveWethPct}% — trim ${h.symbol}${pnlNote}${opts.thesisNote}`,
        1,
        minN,
      );
      need -= sellUsd;
    }
    if (!actions.some((a) => a.action === "swap")) {
      actions.push({
        action: "hold",
        reason: `Cash ${opts.cashPct.toFixed(1)}% < ${opts.reserveWethPct}% target but nothing tradeable to sell`,
        tradeable: false,
        priority: 0,
      });
    }
    return actions;
  }

  const soldSyms = new Set<string>();
  const markSold = (sym: string) => soldSyms.add(sym.toUpperCase());
  const alreadySold = (sym: string) => soldSyms.has(sym.toUpperCase());

  // Hard exits — take-profit / stop-loss on held names
  for (const h of tradeable) {
    if (h.usd == null || h.usd < minN || alreadySold(h.symbol)) continue;
    const pnl = pnlOf(h.symbol);
    if (pnl >= opts.takeProfitPct) {
      const before = actions.length;
      pushSell(
        actions,
        { symbol: h.symbol, amount: h.amount, usd: h.usd },
        Math.min(h.usd * 0.5, Math.max(minN, h.usd * 0.35)),
        `Core: take-profit ${h.symbol} (uPnL +${pnl.toFixed(1)}% ≥ ${opts.takeProfitPct}%)${opts.thesisNote}`,
        1,
        minN,
      );
      if (actions.length > before) markSold(h.symbol);
      continue;
    }
    if (pnl <= -opts.stopLossPct) {
      const before = actions.length;
      const frac = stopLossTrimFraction(pnl, opts.stopLossPct);
      pushSell(
        actions,
        { symbol: h.symbol, amount: h.amount, usd: h.usd },
        Math.min(h.usd * frac, Math.max(minN, h.usd * 0.35)),
        `Core: stop-loss ${h.symbol} (uPnL ${pnl.toFixed(1)}% ≤ -${opts.stopLossPct}% · trim ~${Math.round(frac * 100)}%)${opts.thesisNote}`,
        1,
        minN,
      );
      if (actions.length > before) markSold(h.symbol);
    }
  }

  // Thesis / trend sells (discretionary)
  const preferSells = (opts.preferSells ?? [])
    .map((s) => s.toUpperCase())
    .filter((s) => bySym.has(s) && !alreadySold(s));
  for (const sym of preferSells) {
    const h = bySym.get(sym)!;
    if (h.usd == null || h.usd < minN) continue;
    const before = actions.length;
    pushSell(
      actions,
      { symbol: h.symbol, amount: h.amount, usd: h.usd },
      Math.min(h.usd * 0.4, Math.max(minN, h.usd * 0.25)),
      `Core: thesis trim ${sym} (trend / preferSells)${opts.thesisNote}`,
      1,
      minN,
    );
    if (actions.length > before) markSold(sym);
  }

  // Concentration cap vs maxNamePct (not equal-weight)
  for (const h of tradeable) {
    if (h.usd == null || alreadySold(h.symbol)) continue;
    const capUsd = opts.contentsUsd * (maxNamePct / 100);
    if (h.usd > capUsd * (1 + BAND)) {
      const before = actions.length;
      pushSell(
        actions,
        { symbol: h.symbol, amount: h.amount, usd: h.usd },
        h.usd - capUsd,
        `Core: concentration trim ${h.symbol} above ${maxNamePct}% of book${opts.thesisNote}`,
        1,
        minN,
      );
      if (actions.length > before) markSold(h.symbol);
    }
  }

  const plannedSellUsd = actions
    .filter((a) => a.side === "sell")
    .reduce((s, a) => s + (a.notionalUsd ?? 0), 0);
  wethBudget += plannedSellUsd;

  const deployable = deployableUsd(
    opts.contentsUsd,
    wethBudget,
    opts.reserveWethPct,
    opts.deployPct,
  );

  const preferBuys = (opts.preferBuys ?? [])
    .map((s) => s.toUpperCase())
    .filter((s) => universe.has(s));

  if (deployable < minN) {
    if (!actions.some((a) => a.action === "swap")) {
      actions.push({
        action: "hold",
        reason: `Core on plan: cash ~${opts.cashPct.toFixed(1)}% (target ${opts.reserveWethPct}%), deployable $${deployable.toFixed(2)} < min notional $${minN}`,
        tradeable: true,
        priority: 0,
      });
    }
    return actions;
  }

  if (!preferBuys.length) {
    if (!actions.some((a) => a.action === "swap")) {
      actions.push({
        action: "hold",
        reason: `Core: no preferBuys this pass — allowlist is candidates only; need thesis/LLM pick before opening risk${opts.thesisNote}`,
        tradeable: true,
        priority: 0,
      });
    }
    return actions;
  }

  const picks = preferBuys.slice(0, 2);
  let budget = deployable;
  const perPick = budget / picks.length;

  for (const sym of picks) {
    if (budget < minN) break;
    const current = bySym.get(sym)?.usd ?? 0;
    const capUsd = opts.contentsUsd * (maxNamePct / 100);
    const room = Math.max(0, capUsd - current);
    if (room < minN) {
      actions.push({
        action: "hold",
        reason: `Core: skip buy ${sym} — already at/near ${maxNamePct}% name cap`,
        tokenOut: sym,
        tradeable: true,
        priority: 0,
      });
      continue;
    }

    const mark = markOf(sym);
    const avg = avgOf(sym);
    if (current > 0 && avg != null && avg > 0 && mark != null) {
      const maxAdd = avg * (1 - opts.addOnlyDipBps / 10_000);
      if (mark > maxAdd) {
        actions.push({
          action: "hold",
          reason: `Core: skip add ${sym} — mark $${mark.toFixed(4)} > avg $${avg.toFixed(4)} − ${opts.addOnlyDipBps}bps`,
          tokenOut: sym,
          tradeable: true,
          priority: 0,
        });
        continue;
      }
    }

    const buyCap = riskBudgetBuyCapUsd({
      contentsUsd: opts.contentsUsd,
      stopLossPct: opts.stopLossPct,
      maxRiskPctPerTrade: opts.maxRiskPctPerTrade,
    });
    const buyUsd = Math.min(budget, perPick, room, buyCap);
    if (buyUsd < minN) {
      actions.push({
        action: "hold",
        reason: `Core: skip buy ${sym} — risk budget / size $${buyUsd.toFixed(2)} < min $${minN} (maxRisk ${opts.maxRiskPctPerTrade}% @ stop ${opts.stopLossPct}%)`,
        tokenOut: sym,
        tradeable: true,
        priority: 0,
      });
      continue;
    }
    pushBuy(
      actions,
      sym,
      buyUsd,
      opts.ethUsd,
      budget,
      `Core: selective buy ${sym} (thesis preferBuys · deploy ≤${opts.deployPct}% · risk≤${opts.maxRiskPctPerTrade}%)${opts.thesisNote}`,
      2,
      minN,
    );
    const spent =
      actions.filter((a) => a.side === "buy" && a.tokenOut === sym).at(-1)
        ?.notionalUsd ?? 0;
    budget -= spent;
    wethBudget -= spent;
  }

  if (!actions.some((a) => a.action === "swap")) {
    actions.push({
      action: "hold",
      reason: `Core: preferBuys ${picks.join(",")} but no fee-viable ticket this pass (min $${minN}, deployable $${deployable.toFixed(2)})`,
      tradeable: true,
      priority: 0,
    });
  }
  return actions;
}

/** Never spend below reserve; never put more than deployPct of the book to work in one pass. */
function deployableUsd(
  contentsUsd: number,
  wethUsd: number,
  reserveWethPct: number,
  deployPct: number,
): number {
  const reserveUsd = contentsUsd * (reserveWethPct / 100);
  const aboveReserve = Math.max(0, wethUsd - reserveUsd);
  const perPassCap = contentsUsd * (deployPct / 100);
  return Math.min(aboveReserve, perPassCap);
}

function deployWeth(
  actions: PortfolioAction[],
  opts: {
    symbols: string[];
    contentsUsd: number;
    wethUsd: number;
    reserveWethPct: number;
    deployPct: number;
    ethUsd: number | null;
    thesisNote: string;
  },
): PortfolioAction[] {
  if (!opts.symbols.length) {
    actions.push({
      action: "hold",
      reason: "No buyable symbols (need liquid WETH or USDG route — see get_stock_tokens)",
      tradeable: false,
      priority: 0,
    });
    return actions;
  }
  const deployable = deployableUsd(
    opts.contentsUsd,
    opts.wethUsd,
    opts.reserveWethPct,
    opts.deployPct,
  );
  if (deployable < MIN_NOTIONAL_USD) {
    actions.push({
      action: "hold",
      reason: `No deploy room (need WETH above ${opts.reserveWethPct}% reserve, cap ${opts.deployPct}% of book/pass; have $${opts.wethUsd.toFixed(2)} WETH)`,
      tradeable: opts.wethUsd > 0,
      priority: 0,
    });
    return actions;
  }
  const per = deployable / opts.symbols.length;
  let budget = opts.wethUsd;
  for (const sym of opts.symbols) {
    pushBuy(
      actions,
      sym,
      per,
      opts.ethUsd,
      budget,
      `Deploy ~$${per.toFixed(2)} WETH → ${sym} (reserve ${opts.reserveWethPct}%, max ${opts.deployPct}% book/pass)${opts.thesisNote}`,
      1,
    );
    const spent =
      actions.filter((a) => a.side === "buy" && a.tokenOut === sym).at(-1)?.notionalUsd ??
      0;
    budget -= spent;
  }
  return actions;
}

function rebalanceToTargets(
  actions: PortfolioAction[],
  holdings: PricedHolding[],
  opts: {
    targets: TargetWeights;
    contentsUsd: number;
    ethUsd: number | null;
    wethBudget: number;
    thesisNote: string;
    buyUniverse: string[];
  },
): PortfolioAction[] {
  const totalPct = Object.values(opts.targets).reduce((s, v) => s + v, 0);
  if (totalPct <= 0) {
    actions.push({
      action: "hold",
      reason: "Target weights sum to 0",
      tradeable: false,
      priority: 0,
    });
    return actions;
  }

  // Scale to 100
  const scaled: TargetWeights = {};
  for (const [k, v] of Object.entries(opts.targets)) {
    scaled[k] = (v / totalPct) * 100;
  }

  const bySym = new Map(holdings.map((h) => [h.symbol, h]));
  let wethBudget = opts.wethBudget;

  // Sells first
  for (const [sym, pct] of Object.entries(scaled)) {
    if (sym === "WETH" || sym === "USDG" || sym === "ETH") continue;
    const h = bySym.get(sym);
    const current = h?.usd ?? 0;
    const targetUsd = opts.contentsUsd * (pct / 100);
    if (current > targetUsd * (1 + BAND) && h && h.tradeableToWeth && h.usd != null) {
      pushSell(
        actions,
        { symbol: sym, amount: h.amount, usd: h.usd },
        current - targetUsd,
        `Targets: trim ${sym} toward ${pct.toFixed(1)}%${opts.thesisNote}`,
        1,
      );
    }
  }

  const plannedSellUsd = actions
    .filter((a) => a.side === "sell")
    .reduce((s, a) => s + (a.notionalUsd ?? 0), 0);
  wethBudget += plannedSellUsd;

  // Target WETH sleeve: if overweight WETH vs target, deploy excess into underweight stocks
  const wethTargetPct = scaled.WETH ?? 0;
  const wethTargetUsd = opts.contentsUsd * (wethTargetPct / 100);

  for (const [sym, pct] of Object.entries(scaled)) {
    if (sym === "WETH" || sym === "USDG" || sym === "ETH") continue;
    if (!opts.buyUniverse.includes(sym) && !(bySym.get(sym)?.tradeableToWeth)) {
      actions.push({
        action: "hold",
        reason: `${sym} not buyable (no WETH pool) — skip target`,
        tokenOut: sym,
        tradeable: false,
        priority: 0,
      });
      continue;
    }
    const h = bySym.get(sym);
    const current = h?.usd ?? 0;
    const targetUsd = opts.contentsUsd * (pct / 100);
    if (current < targetUsd * (1 - BAND)) {
      pushBuy(
        actions,
        sym,
        targetUsd - current,
        opts.ethUsd,
        wethBudget,
        `Targets: buy ${sym} toward ${pct.toFixed(1)}%${opts.thesisNote}`,
        2,
      );
      const spent =
        actions.filter((a) => a.side === "buy" && a.tokenOut === sym).at(-1)
          ?.notionalUsd ?? 0;
      wethBudget -= spent;
    }
  }

  // If no WETH target set but we still have excess cash, leave it (dry powder)
  void wethTargetUsd;

  return actions;
}

function finalize(actions: PortfolioAction[], idleReason?: string): PortfolioAction[] {
  const swaps = actions.filter((a) => a.action === "swap");
  // sells before buys
  swaps.sort((a, b) => a.priority - b.priority || (a.side === "sell" ? -1 : 1));
  const holds = actions.filter((a) => a.action === "hold");
  if (!swaps.length && idleReason && !holds.length) {
    return [
      {
        action: "hold",
        reason: idleReason,
        tradeable: true,
        priority: 0,
      },
    ];
  }
  if (!swaps.length && !holds.length && idleReason) {
    return [
      {
        action: "hold",
        reason: idleReason,
        tradeable: true,
        priority: 0,
      },
    ];
  }
  return [...holds, ...swaps];
}

export async function preparePortfolioPlan(
  client: PublicClient,
  args: ManageOpts & {
    id: number;
    from: string;
    maxActions?: number;
    slippageBps?: number;
  },
) {
  const analysis = await analyzeBrokerPortfolio(client, args.id, args);
  const swaps = analysis.actions
    .filter(
      (a) => a.action === "swap" && a.tradeable && a.tokenIn && a.tokenOut && a.amountIn,
    )
    .sort((a, b) => a.priority - b.priority)
    .slice(0, args.maxActions ?? 5);

  const prepared = [];
  for (const a of swaps) {
    try {
      const tx = await prepareBrokerTrade(client, {
        id: args.id,
        from: args.from,
        tokenIn: a.tokenIn!,
        tokenOut: a.tokenOut!,
        amountIn: a.amountIn!,
        slippageBps: args.slippageBps,
      });
      prepared.push({ action: a, prepared: tx });
    } catch (err) {
      prepared.push({
        action: a,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    ok: true,
    analysis: {
      contentsUsd: analysis.contentsUsd,
      holdings: analysis.holdings,
      buyUniverse: analysis.buyUniverse,
      policy: analysis.policy,
      targets: analysis.targets,
      thesis: analysis.thesis,
      actions: analysis.actions,
      fundingHint: analysis.fundingHint,
      disclaimer: analysis.disclaimer,
    },
    prepared,
    signOrder:
      "Sign sells before buys. Per trade follow prepared.signOrder / steps (v4 may include unwrap, Permit2, swap, wrap). Output stays in TBA.",
  };
}
