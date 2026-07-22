import { makePublicClient } from "../brokerReads.js";
import { loadConfig } from "../config.js";
import {
  analyzeBrokerPortfolio,
  preparePortfolioPlan,
} from "../portfolioManage.js";
import { formatStonkSwapTweet } from "../swap.js";
import { connectBroker } from "../tba.js";
import { postTextToX } from "../twitter.js";
import { txUrl } from "../chain.js";
import {
  emitEvent,
  isRunning,
  setAgentState,
  setLastThesis,
  setRunning,
} from "./events.js";
import { executePreparedSteps } from "./executeSteps.js";
import { askLlmForThesis, tickersFromText } from "./llm.js";
import { recordSnapshot } from "./history.js";
import {
  enrichHoldings,
  recordActionFill,
} from "./ledger.js";
import { recordTrade } from "./tradeLog.js";
import { loadSettings } from "./settings.js";
import { evaluateEoaGasReserve, evaluateFeeGate } from "./tradeEconomics.js";
import { getAssetBySymbol } from "../assets.js";
import { priceTokenUsd } from "../prices.js";
import { formatEther } from "viem";
import { ownerAccount } from "../config.js";

let timer: ReturnType<typeof setTimeout> | null = null;
let passInFlight = false;
/** Epoch ms when the next scheduled pass should start; null while idle/paused or mid-pass. */
let nextPassAt: number | null = null;

export function startAutopilot() {
  setRunning(true);
  setAgentState("analyzing", "Autopilot started — first pass beginning");
  void scheduleNext(0);
}

export function resumeAutopilot() {
  setRunning(true, "Autopilot resumed");
  setAgentState("analyzing", "Autopilot resumed — next pass beginning");
  void scheduleNext(0);
}

export function pauseAutopilot() {
  setRunning(false, "Autopilot paused");
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  nextPassAt = null;
  setAgentState("paused", "Autopilot paused");
}

/** Fully deactivate autopilot (not the same as pause — no Resume). */
export function stopAutopilot() {
  setRunning(false, "Autopilot stopped");
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  nextPassAt = null;
  setAgentState("idle", "Autopilot stopped");
}

export function getAutopilotSchedule() {
  return {
    nextPassAt,
    passInFlight,
  };
}

export async function runOnce(): Promise<void> {
  await runPass();
}

function scheduleNext(delayMs: number) {
  if (timer) clearTimeout(timer);
  if (!isRunning()) {
    nextPassAt = null;
    return;
  }
  const wait = Math.max(0, delayMs);
  nextPassAt = Date.now() + wait;
  emitEvent(
    "agent.schedule",
    wait === 0
      ? "Next check starting now"
      : `Next check in ${Math.round(wait / 1000)}s`,
    { nextPassAt, delayMs: wait },
  );
  timer = setTimeout(() => {
    void (async () => {
      try {
        await runPass();
      } finally {
        if (isRunning()) {
          const settings = loadSettings();
          scheduleNext(settings.intervalMs);
        } else {
          nextPassAt = null;
        }
      }
    })();
  }, wait);
}

async function runPass(): Promise<void> {
  if (passInFlight) {
    emitEvent("agent.skip", "Pass already in flight");
    return;
  }
  passInFlight = true;
  nextPassAt = null;
  try {
    const settings = loadSettings();
    const config = loadConfig();
    // Shell UI dry-run toggle overrides env for this process
    config.dryRun = settings.dryRun;
    const canBroadcast = !settings.dryRun;

    setAgentState("analyzing", "Connecting broker + analyzing portfolio");
    const session = await connectBroker(config);
    const client = makePublicClient(config.rpcUrl);
    const tokenId = String(session.tokenId);

    const eoaBal = await client.getBalance({
      address: ownerAccount(config.privateKey).address,
    });
    const eoaEth = Number(formatEther(eoaBal));

    const preview = await analyzeBrokerPortfolio(client, Number(session.tokenId), {
      policy: settings.policy,
      reserveWethPct: settings.reserveWethPct,
      deployPct: settings.deployPct,
      symbols: settings.allowlist,
      thesis: settings.thesis || undefined,
      minNotionalUsd: settings.minNotionalUsd,
      takeProfitPct: settings.takeProfitPct,
      stopLossPct: settings.stopLossPct,
      addOnlyDipBps: settings.addOnlyDipBps,
    });
    const holdings = enrichHoldings(tokenId, preview.holdings);
    const unrealizedPnlPct = Object.fromEntries(
      holdings
        .filter((h) => h.unrealizedPnlPct != null)
        .map((h) => [h.symbol.toUpperCase(), h.unrealizedPnlPct as number]),
    );
    const avgCostUsd = Object.fromEntries(
      holdings
        .filter((h) => h.avgCostUsd != null && h.avgCostUsd > 0)
        .map((h) => [h.symbol.toUpperCase(), h.avgCostUsd as number]),
    );
    const unrealizedPnlUsdBySym = Object.fromEntries(
      holdings
        .filter((h) => h.unrealizedPnlUsd != null)
        .map((h) => [h.symbol.toUpperCase(), h.unrealizedPnlUsd as number]),
    );

    recordSnapshot({
      tokenId,
      holdings: [
        ...holdings.map((h) => ({
          symbol: h.symbol,
          usd: h.usd,
        })),
        ...(preview.ethBalanceUsd != null && preview.ethBalanceUsd > 0
          ? [{ symbol: "ETH", usd: preview.ethBalanceUsd }]
          : []),
      ],
    });

    emitEvent(
      "agent.portfolio",
      `Cash ${preview.cashPct ?? "?"}% · book ~$${preview.contentsUsd ?? "?"}`,
      {
        cashPct: preview.cashPct,
        contentsUsd: preview.contentsUsd,
        actions: preview.actions.filter((a) => a.action === "swap").length,
      },
    );

    const eoaGas = evaluateEoaGasReserve({
      eoaEth,
      ethUsd: preview.ethUsd,
      maxActionsPerPass: settings.maxActionsPerPass,
      gasEthPerStep: settings.estimateGasEth,
      tokenId,
    });
    if (eoaGas.low) {
      emitEvent("agent.warn", eoaGas.message, {
        eoaEth: eoaGas.haveEth,
        needEth: eoaGas.needEth,
        critical: eoaGas.critical,
      });
    }

    let thesis =
      settings.thesis ||
      `Core pass: target ${settings.reserveWethPct}% cash, selective sleeve (allowlist = candidates).`;
    let preferBuys: string[] = tickersFromText(settings.thesis, settings.allowlist);
    let preferSells: string[] = [];

    if (config.llmApiKey) {
      setAgentState("thinking", "Asking LLM for thesis");
      try {
        const plan = await askLlmForThesis(config, {
          cashPct: preview.cashPct,
          reserveWethPct: settings.reserveWethPct,
          holdings: holdings.map((h) => ({
            symbol: h.symbol,
            weightPct: h.weightPct,
            unrealizedPnlPct: h.unrealizedPnlPct,
            avgCostUsd: h.avgCostUsd,
            markUsd: h.markUsd ?? h.priceUsd,
          })),
          allowlist: settings.allowlist,
          settingsThesis: settings.thesis,
          minNotionalUsd: settings.minNotionalUsd,
          minEdgeBps: settings.minEdgeBps,
          takeProfitPct: settings.takeProfitPct,
          stopLossPct: settings.stopLossPct,
          addOnlyDipBps: settings.addOnlyDipBps,
        });
        if (plan?.thesis) thesis = plan.thesis;
        if (plan?.preferBuys?.length) {
          preferBuys = plan.preferBuys.filter((s) =>
            settings.allowlist.includes(s),
          );
        } else if (plan?.stance === "hold" || plan?.stance === "risk_off") {
          preferBuys = [];
        }
        if (plan?.preferSells?.length) {
          preferSells = plan.preferSells.filter(
            (s) =>
              settings.allowlist.includes(s) ||
              holdings.some((h) => h.symbol.toUpperCase() === s),
          );
        }
        // Hard fallback: excess cash + LLM skipped unheld names → open one candidate
        const cashPct = preview.cashPct ?? 0;
        const excess = cashPct - settings.reserveWethPct;
        if (
          excess >= 10 &&
          preferBuys.length === 0 &&
          plan?.stance !== "risk_off"
        ) {
          const held = new Set(
            holdings
              .map((h) => h.symbol.toUpperCase())
              .filter((s) => !["WETH", "ETH", "USDG", "STONKBROKER"].includes(s)),
          );
          const unheld = settings.allowlist.filter((s) => !held.has(s));
          if (unheld.length) {
            preferBuys = [unheld[0]];
            emitEvent(
              "agent.plan",
              `fallback deploy: cash +${excess.toFixed(1)}pp over reserve → open ${preferBuys[0]} (unheld allowlist)`,
              { preferBuys, reason: "cash_excess_fallback" },
            );
          }
        }
        if (plan) {
          emitEvent(
            "agent.plan",
            `stance=${plan.stance} · buys=${preferBuys.join(",") || "—"} · sells=${preferSells.join(",") || "—"}`,
            { stance: plan.stance, preferBuys, preferSells },
          );
        }
      } catch (err) {
        emitEvent(
          "agent.warn",
          err instanceof Error ? err.message : String(err),
        );
      }
    } else if (preferBuys.length) {
      emitEvent(
        "agent.plan",
        `no LLM — preferBuys from thesis notes: ${preferBuys.join(",")}`,
        { preferBuys },
      );
    }

    setLastThesis(thesis);
    emitEvent("agent.thesis", thesis);

    setAgentState("preparing", "Preparing rebalance txs");
    const plan = await preparePortfolioPlan(client, {
      id: Number(session.tokenId),
      from: session.nftOwner,
      policy: settings.policy,
      reserveWethPct: settings.reserveWethPct,
      deployPct: settings.deployPct,
      symbols: settings.allowlist,
      thesis,
      preferBuys,
      preferSells,
      maxActions: settings.maxActionsPerPass,
      slippageBps: config.slippageBps,
      unrealizedPnlPct,
      avgCostUsd,
      minNotionalUsd: settings.minNotionalUsd,
      takeProfitPct: settings.takeProfitPct,
      stopLossPct: settings.stopLossPct,
      addOnlyDipBps: settings.addOnlyDipBps,
      maxNamePct: 40,
    });

    const cashPct = preview.cashPct ?? 100;
    const reserve = settings.reserveWethPct;
    const cashRestore = cashPct < reserve * (1 - 0.05);
    const cashCritical = cashPct < reserve - 10;

    const swaps = plan.prepared.filter(
      (p): p is { action: (typeof plan.prepared)[0]["action"]; prepared: Record<string, unknown> } =>
        "prepared" in p && p.prepared != null,
    );

    // Cap notional: skip buys/sells above maxNotionalEth when we can parse amountIn
    const sizeOk = swaps.filter((item) => {
      const amt = Number(item.action.amountIn ?? 0);
      const isEthSide =
        item.action.tokenIn === "WETH" ||
        item.action.tokenIn === "ETH" ||
        item.action.tokenOut === "WETH" ||
        item.action.tokenOut === "ETH";
      if (!isEthSide) return true;
      if (!Number.isFinite(amt)) return true;
      // amountIn for sells is stock qty — only enforce when selling/buying with WETH amount
      if (item.action.tokenIn === "WETH" || item.action.tokenIn === "ETH") {
        return amt <= settings.maxNotionalEth;
      }
      return true;
    });
    for (const item of swaps) {
      if (!sizeOk.includes(item)) {
        emitEvent(
          "agent.skip",
          `maxNotionalEth: ${item.action.amountIn} ${item.action.tokenIn} > ${settings.maxNotionalEth}`,
        );
      }
    }

    const capped = sizeOk.filter((item) => {
      const a = item.action;
      const side = a.side === "sell" ? "sell" : "buy";
      const notionalUsd = a.notionalUsd ?? 0;
      const stockSym =
        side === "sell"
          ? (a.tokenIn ?? "").toUpperCase()
          : (a.tokenOut ?? "").toUpperCase();
      const holdingUsd =
        holdings.find((h) => h.symbol.toUpperCase() === stockSym)?.usd ?? 0;
      const uPnlTotal = unrealizedPnlUsdBySym[stockSym] ?? 0;
      const unrealizedPnlUsd =
        side === "sell" && holdingUsd > 0
          ? uPnlTotal * (Math.min(notionalUsd, holdingUsd) / holdingUsd)
          : null;
      const gate = evaluateFeeGate({
        side,
        notionalUsd,
        ethUsd: preview.ethUsd,
        slippageBps: config.slippageBps,
        minNotionalUsd: settings.minNotionalUsd,
        minEdgeBps: settings.minEdgeBps,
        gasEthPerStep: settings.estimateGasEth,
        tokenId,
        unrealizedPnlUsd,
        cashRestore: side === "sell" && (cashRestore || /raise cash/i.test(a.reason ?? "")),
        cashCritical: side === "sell" && cashCritical,
      });
      const fundedBy =
        typeof item.prepared.fundedBy === "string"
          ? item.prepared.fundedBy
          : undefined;
      const fundNote =
        fundedBy === "tba"
          ? " · path: TBA-funded (EOA gas only)"
          : fundedBy && fundedBy !== "n/a"
            ? ` · path: ${fundedBy}`
            : "";
      emitEvent(
        gate.ok ? "agent.fee" : "agent.skip",
        `${gate.reason}${fundNote}`,
        {
          side,
          notionalUsd,
          costUsd: gate.cost.totalCostUsd,
          edgeUsd: gate.edgeUsd,
          ok: gate.ok,
          fundedBy,
        },
      );
      return gate.ok;
    });

    emitEvent(
      "agent.prepare",
      `${capped.length} trade(s) ready (${swaps.length - capped.length} skipped by size/fee gate)`,
      { count: capped.length },
    );

    if (capped.length === 0) {
      const holdReason =
        plan.analysis.actions.find((a) => a.action === "hold")?.reason ??
        "No actionable swaps this pass";
      // Defer hold emit to the branch below so fee-skipped plans get one clear line
      void holdReason;
    }

    const marks: Record<string, number | null | undefined> = {};
    for (const h of holdings) {
      marks[h.symbol.toUpperCase()] = h.priceUsd;
    }
    if (preview.ethUsd != null && preview.ethUsd > 0) {
      marks.WETH = preview.ethUsd;
      marks.ETH = preview.ethUsd;
    }

    const hashes: string[] = [];
    const tweetQueue: string[] = [];

    /** Fill USD marks for symbols we are about to tweet (unheld buys often missing). */
    async function ensureMarks(symbols: string[]) {
      for (const raw of symbols) {
        const sym = raw.toUpperCase();
        if (!sym || (marks[sym] != null && marks[sym]! > 0)) continue;
        if (sym === "WETH" || sym === "ETH") {
          if (preview.ethUsd != null && preview.ethUsd > 0) marks[sym] = preview.ethUsd;
          continue;
        }
        const asset = getAssetBySymbol(sym);
        if (!asset) continue;
        try {
          const p = await priceTokenUsd(
            client,
            asset.address,
            sym,
            18,
            preview.ethUsd,
          );
          if (p.usd != null && p.usd > 0) marks[sym] = p.usd;
        } catch {
          /* leave missing — fall back to quote floor */
        }
      }
    }

    function amountOutFromPrepared(
      prepared?: Record<string, unknown>,
    ): string | null {
      if (!prepared) return null;
      const raw = prepared.amountOutMinimum;
      const n = typeof raw === "string" || typeof raw === "number" ? Number(raw) : NaN;
      if (!(n > 0)) return null;
      // amountOutMinimum is spot − slippage; back out approx mid for the tweet
      const slip = Number(prepared.slippageBps ?? 50);
      const mid =
        slip > 0 && slip < 5_000 ? n / (1 - slip / 10_000) : n;
      return mid.toPrecision(6);
    }

    function estimateAmountOut(
      action: {
        side?: string;
        tokenIn?: string;
        tokenOut?: string;
        amountIn?: string;
        notionalUsd?: number;
      },
      prepared?: Record<string, unknown>,
    ): string {
      const notional = action.notionalUsd;
      if (notional != null && notional > 0) {
        if (action.side === "sell") {
          const ethUsd = preview.ethUsd;
          if (ethUsd != null && ethUsd > 0) {
            return (notional / ethUsd).toPrecision(6);
          }
        } else {
          const outSym = (action.tokenOut ?? "").toUpperCase();
          const mark = marks[outSym];
          if (mark != null && mark > 0) {
            return (notional / mark).toPrecision(6);
          }
        }
      }
      const fromQuote = amountOutFromPrepared(prepared);
      if (fromQuote) return fromQuote;
      return "~";
    }

    function enqueueSwapTweet(
      action: {
        side?: string;
        tokenIn?: string;
        tokenOut?: string;
        amountIn?: string;
        notionalUsd?: number;
      },
      opts: {
        dryRun: boolean;
        txHash?: string;
        prepared?: Record<string, unknown>;
      },
    ) {
      const text = formatStonkSwapTweet({
        tokenId: session.tokenId,
        fromAmount: action.amountIn ?? "?",
        fromSymbol: action.tokenIn ?? "?",
        toAmount: estimateAmountOut(action, opts.prepared),
        toSymbol: action.tokenOut ?? "?",
        txUrl: opts.txHash ? txUrl(opts.txHash as `0x${string}`) : null,
        dryRun: opts.dryRun,
      });
      tweetQueue.push(text);
    }

    // Price any tokenOut/tokenIn we will tweet that isn't already marked
    if (settings.postToX && capped.length > 0) {
      await ensureMarks(
        capped.flatMap((item) => [
          item.action.tokenIn ?? "",
          item.action.tokenOut ?? "",
        ]),
      );
    }

    if (capped.length === 0) {
      const holdReason =
        plan.analysis.actions.find((a) => a.action === "hold")?.reason ??
        "No actionable swaps this pass";
      emitEvent("agent.hold", holdReason);
    } else if (!canBroadcast) {
      for (const item of capped) {
        const a = item.action;
        emitEvent(
          "agent.dry_run",
          `[would] ${(a.side ?? "swap").toUpperCase()} ${a.amountIn} ${a.tokenIn} → ${a.tokenOut} — ${a.reason}`,
        );
        recordActionFill({
          tokenId,
          action: a,
          marks,
          dryRun: true,
        });
        recordTrade({
          tokenId,
          side: a.side,
          tokenIn: a.tokenIn,
          tokenOut: a.tokenOut,
          amountIn: a.amountIn,
          notionalUsd: a.notionalUsd,
          reason: a.reason,
          dryRun: true,
          status: "dry_run",
          ethUsd: preview.ethUsd,
          txs: [],
        });
        if (settings.postToX) {
          enqueueSwapTweet(a, { dryRun: true, prepared: item.prepared });
        }
      }
      emitEvent("agent.warn", "Dry run on — turn off Dry run to broadcast");
    } else if (eoaGas.critical) {
      emitEvent(
        "agent.skip",
        `Blocked live broadcast — ${eoaGas.message}`,
        { eoaEth: eoaGas.haveEth, needEth: eoaGas.needEth },
      );
      for (const item of capped) {
        const a = item.action;
        emitEvent(
          "agent.dry_run",
          `[held] ${(a.side ?? "swap").toUpperCase()} ${a.amountIn} ${a.tokenIn} → ${a.tokenOut} — EOA needs ETH for gas`,
        );
      }
    } else {
      setAgentState("signing", "Broadcasting TBA steps");
      for (const item of capped) {
        const prepared = item.prepared;
        const steps = (prepared.steps as Array<{
          to: string;
          data: string;
          value?: string;
          what?: string;
          step?: string;
        }>) ?? (prepared.swap ? [prepared.swap as never] : []);
        if (!steps.length) {
          emitEvent("agent.warn", `No steps for ${item.action.tokenIn}→${item.action.tokenOut}`);
          recordTrade({
            tokenId,
            side: item.action.side,
            tokenIn: item.action.tokenIn,
            tokenOut: item.action.tokenOut,
            amountIn: item.action.amountIn,
            notionalUsd: item.action.notionalUsd,
            reason: item.action.reason,
            dryRun: false,
            status: "error",
            ethUsd: preview.ethUsd,
            error: "No steps prepared",
            txs: [],
          });
          continue;
        }
        try {
          const results = await executePreparedSteps(session, steps);
          let ok = false;
          let primaryHash: string | undefined;
          for (const r of results) {
            if (!r.dryRun) {
              hashes.push(r.hash);
              ok = true;
              // Prefer the swap step link when present
              if (!primaryHash || /swap/i.test(r.what)) primaryHash = r.hash;
            }
          }
          recordTrade({
            tokenId,
            side: item.action.side,
            tokenIn: item.action.tokenIn,
            tokenOut: item.action.tokenOut,
            amountIn: item.action.amountIn,
            notionalUsd: item.action.notionalUsd,
            reason: item.action.reason,
            dryRun: false,
            status: ok ? "filled" : "dry_run",
            ethUsd: preview.ethUsd,
            txs: results.map((r) => ({
              what: r.what,
              hash: r.hash,
              dryRun: r.dryRun,
              valueEth: r.valueEth,
              gasUsed: r.gasUsed,
              effectiveGasPriceWei: r.effectiveGasPriceWei,
              gasFeeEth: r.gasFeeEth,
            })),
          });
          if (ok) {
            recordActionFill({
              tokenId,
              action: item.action,
              marks,
              dryRun: false,
            });
            if (settings.postToX) {
              enqueueSwapTweet(item.action, {
                dryRun: false,
                txHash: primaryHash ?? hashes.at(-1),
                prepared: item.prepared,
              });
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          emitEvent("agent.warn", `Swap failed: ${msg}`);
          recordTrade({
            tokenId,
            side: item.action.side,
            tokenIn: item.action.tokenIn,
            tokenOut: item.action.tokenOut,
            amountIn: item.action.amountIn,
            notionalUsd: item.action.notionalUsd,
            reason: item.action.reason,
            dryRun: false,
            status: "error",
            ethUsd: preview.ethUsd,
            error: msg,
            txs: [],
          });
        }
      }
    }

    if (settings.postToX && tweetQueue.length > 0) {
      setAgentState("posting", "Posting swap(s) to X");
      for (const text of tweetQueue) {
        const posted = await postTextToX(config, text, { live: true });
        if ("skipped" in posted) {
          emitEvent("agent.x", posted.skipped);
        } else {
          emitEvent("agent.x", `Posted https://x.com/i/status/${posted.id}`, {
            id: posted.id,
          });
        }
      }
    }

    setAgentState("idle", "Pass complete");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setAgentState("error", msg);
    emitEvent("agent.error", msg);
  } finally {
    passInFlight = false;
  }
}
