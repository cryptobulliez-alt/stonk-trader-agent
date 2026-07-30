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
  getPosition,
  recordActionFill,
} from "./ledger.js";
import { recordTrade } from "./tradeLog.js";
import { loadSettings } from "./settings.js";
import { evaluateEoaGasReserve, evaluateFeeGate, isRiskExitReason } from "./tradeEconomics.js";
import { fetchXSignals, mergeXHints } from "./xSignals.js";
import { loadTradingSkills } from "./skills.js";
import { classifyResearchNeed } from "./researchGate.js";
import {
  filterBuyCooldown,
  isCoreLiquid,
  markStopLossCooldown,
} from "./cooldowns.js";
import { applyRiskVeto } from "./riskVeto.js";
import {
  formatMemoryForLlm,
  recordTradeMemory,
} from "./tradeMemory.js";
import {
  getSignalWatchStatus,
  startSignalWatch,
  stopSignalWatch,
  updateSignalBookSnapshot,
  type SignalTrigger,
} from "./signalWatch.js";
import { getAssetBySymbol } from "../assets.js";
import { priceTokenUsd } from "../prices.js";
import { formatEther, type Hash } from "viem";
import { ownerAccount, STOCK_TOKENS, TOKEN_DECIMALS } from "../config.js";
import { isRpcRateLimitError, summarizeRpcError } from "../rpcTransport.js";
import { actualTokenInFromTx, assertFillSane } from "./fillVerify.js";

let timer: ReturnType<typeof setTimeout> | null = null;
let passInFlight = false;
/** Epoch ms when the next scheduled pass should start; null while idle/paused or mid-pass. */
let nextPassAt: number | null = null;
/** At most one queued signal wake while a pass is in flight. */
let pendingWake: SignalTrigger | null = null;

function mergePendingWake(next: SignalTrigger): SignalTrigger {
  if (!pendingWake) return next;
  // Risk wins over opportunity
  if (pendingWake.kind === "risk" || next.kind === "risk") {
    const a = pendingWake.kind === "risk" ? pendingWake : next;
    const b = pendingWake.kind === "risk" ? next : pendingWake;
    const symbols = [
      ...new Set([
        ...a.symbols,
        ...(b.kind === "risk" ? b.symbols : []),
      ]),
    ];
    return {
      kind: "risk",
      symbols,
      reasons: [...a.reasons, ...(b.kind === "risk" ? b.reasons : [])],
      source:
        a.source !== b.source && b.kind === "risk" ? "mixed" : a.source,
    };
  }
  return {
    kind: "opportunity",
    symbols: [...new Set([...pendingWake.symbols, ...next.symbols])].slice(
      0,
      2,
    ),
    reasons: [...pendingWake.reasons, ...next.reasons],
    source:
      pendingWake.source !== next.source ? "mixed" : pendingWake.source,
  };
}

/** Called by signal watcher — wake ASAP or queue behind in-flight pass. */
export function requestSignalWake(trigger: SignalTrigger): void {
  if (!isRunning()) return;
  pendingWake = mergePendingWake(trigger);
  if (passInFlight) {
    emitEvent(
      "agent.signal",
      `Wake queued · ${trigger.kind} · ${trigger.symbols.join(",")}`,
      { trigger },
    );
    return;
  }
  scheduleNext(0);
}

export function startAutopilot() {
  setRunning(true);
  setAgentState("analyzing", "Autopilot started — first pass beginning");
  startSignalWatch(requestSignalWake);
  void scheduleNext(0);
}

export function resumeAutopilot() {
  setRunning(true, "Autopilot resumed");
  setAgentState("analyzing", "Autopilot resumed — next pass beginning");
  startSignalWatch(requestSignalWake);
  void scheduleNext(0);
}

export function pauseAutopilot() {
  setRunning(false, "Autopilot paused");
  stopSignalWatch();
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  nextPassAt = null;
  pendingWake = null;
  setAgentState("paused", "Autopilot paused");
}

/** Fully deactivate autopilot (not the same as pause — no Resume). */
export function stopAutopilot() {
  setRunning(false, "Autopilot stopped");
  stopSignalWatch();
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  nextPassAt = null;
  pendingWake = null;
  setAgentState("idle", "Autopilot stopped");
}

export function getAutopilotSchedule() {
  return {
    nextPassAt,
    passInFlight,
    signalWatch: getSignalWatchStatus(),
    pendingWake,
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
    { nextPassAt, delayMs: wait, pendingWake: pendingWake?.kind ?? null },
  );
  timer = setTimeout(() => {
    void (async () => {
      const trigger = pendingWake;
      pendingWake = null;
      try {
        await runPass(trigger ?? undefined);
      } finally {
        if (isRunning()) {
          // Another wake may have queued during the pass
          if (pendingWake) {
            scheduleNext(0);
          } else {
            const settings = loadSettings();
            scheduleNext(settings.intervalMs);
          }
        } else {
          nextPassAt = null;
        }
      }
    })();
  }, wait);
}

async function runPass(trigger?: SignalTrigger): Promise<void> {
  if (passInFlight) {
    if (trigger) pendingWake = mergePendingWake(trigger);
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

    if (trigger) {
      emitEvent(
        "agent.wake",
        `Pass triggered by signal · ${trigger.kind} · ${trigger.symbols.join(",")}`,
        { trigger },
      );
    }

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
      maxRiskPctPerTrade: settings.maxRiskPctPerTrade,
    });
    const holdings = enrichHoldings(tokenId, preview.holdings, preview.ethUsd);
    const unrealizedPnlPct = Object.fromEntries(
      holdings
        .filter((h) => h.unrealizedPnlWethPct != null)
        .map((h) => [h.symbol.toUpperCase(), h.unrealizedPnlWethPct as number]),
    );
    const avgCostUsd = Object.fromEntries(
      holdings
        .filter((h) => h.avgCostUsd != null && h.avgCostUsd > 0)
        .map((h) => [h.symbol.toUpperCase(), h.avgCostUsd as number]),
    );
    const avgCostWeth = Object.fromEntries(
      holdings
        .filter((h) => h.avgCostWeth != null && h.avgCostWeth > 0)
        .map((h) => [h.symbol.toUpperCase(), h.avgCostWeth as number]),
    );
    const unrealizedPnlWethBySym = Object.fromEntries(
      holdings
        .filter((h) => h.unrealizedPnlWeth != null)
        .map((h) => [h.symbol.toUpperCase(), h.unrealizedPnlWeth as number]),
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

    const skillIds = loadTradingSkills()
      .filter((s) => s.inject)
      .map((s) => s.id);
    if (skillIds.length) {
      emitEvent("agent.skills", `Doctrine: ${skillIds.join(", ")}`, {
        skills: skillIds,
      });
    }

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

    // Signal risk: seed thesis trims immediately (fee-gated in core)
    if (trigger?.kind === "risk" && trigger.symbols.length) {
      preferSells = trigger.symbols.map((s) => s.toUpperCase());
      thesis = `Signal risk wake (${trigger.source}): ${trigger.reasons[0] ?? trigger.symbols.join(",")}`;
    }
    // Signal opportunity: soft buy seeds (cash/gates still apply)
    if (trigger?.kind === "opportunity" && trigger.symbols.length) {
      preferBuys = [
        ...new Set([
          ...preferBuys,
          ...trigger.symbols
            .map((s) => s.toUpperCase())
            .filter((s) => settings.allowlist.includes(s)),
        ]),
      ].slice(0, 2);
      thesis = `Signal opportunity wake (${trigger.source}): ${trigger.reasons[0] ?? trigger.symbols.join(",")}`;
    }

    const heldStockSyms = holdings
      .map((h) => h.symbol.toUpperCase())
      .filter((s) => !["WETH", "ETH", "USDG", "STONKBROKER"].includes(s));

    updateSignalBookSnapshot({
      cashPct: preview.cashPct,
      heldSymbols: heldStockSyms,
    });

    const holdingUsdBySym = Object.fromEntries(
      holdings
        .filter((h) => h.usd != null && h.usd > 0)
        .map((h) => [h.symbol.toUpperCase(), h.usd as number]),
    );

    const research = classifyResearchNeed({
      mode: settings.researchRails,
      cashPct: preview.cashPct,
      reserveWethPct: settings.reserveWethPct,
      unrealizedPnlWethPct: unrealizedPnlPct,
      takeProfitPct: settings.takeProfitPct,
      stopLossPct: settings.stopLossPct,
      allowlist: settings.allowlist,
      heldSymbols: heldStockSyms,
      settingsThesis: settings.thesis,
      minNotionalUsd: settings.minNotionalUsd,
      holdingUsdBySym,
      signalTrigger: trigger ?? null,
    });

    emitEvent(
      research.needLlm || research.needX ? "agent.plan" : "agent.research",
      research.needLlm || research.needX
        ? `Research rails on — ${research.reason}`
        : `Research skipped — ${research.reason}`,
      {
        needLlm: research.needLlm,
        needX: research.needX,
        reason: research.reason,
        takeProfitHits: research.takeProfitHits,
        stopLossHits: research.stopLossHits,
        cashExcessPct: research.cashExcessPct,
      },
    );

    // Empty digest when X not needed (no network)
    let xDigest: Awaited<ReturnType<typeof fetchXSignals>> = {
      ok: false,
      source: "skipped",
      reason: research.reason,
      symbols: [],
      preferBuysHint: [],
      preferSellsHint: [],
      summary: "X signals skipped (mechanical pass)",
    };
    if (settings.useXSignals && research.needX) {
      xDigest = await fetchXSignals({
        bearerToken: config.xBearerToken,
        symbols: [...new Set([...settings.allowlist, ...heldStockSyms])],
        heldSymbols: heldStockSyms,
      });
      const softSkip =
        !xDigest.ok &&
        (xDigest.reason?.includes("X_BEARER") ||
          xDigest.reason === "no symbols");
      emitEvent(
        xDigest.ok || softSkip ? "agent.x" : "agent.warn",
        xDigest.summary,
        {
          preferBuysHint: xDigest.preferBuysHint,
          preferSellsHint: xDigest.preferSellsHint,
          source: xDigest.source,
          reason: xDigest.reason,
        },
      );
    } else if (settings.useXSignals) {
      emitEvent("agent.x", xDigest.summary, { reason: research.reason });
    }

    let llmConfidence: number | null = null;
    if (config.llmApiKey && research.needLlm) {
      setAgentState("thinking", "Asking LLM for thesis");
      try {
        const plan = await askLlmForThesis(config, {
          cashPct: preview.cashPct,
          reserveWethPct: settings.reserveWethPct,
          holdings: holdings.map((h) => ({
            symbol: h.symbol,
            weightPct: h.weightPct,
            unrealizedPnlWethPct: h.unrealizedPnlWethPct,
            unrealizedPnlUsdPct: h.unrealizedPnlUsdPct,
            avgCostWeth: h.avgCostWeth,
            avgCostUsd: h.avgCostUsd,
            markWeth: h.markWeth,
            markUsd: h.markUsd ?? h.priceUsd,
          })),
          allowlist: settings.allowlist,
          settingsThesis: settings.thesis,
          minNotionalUsd: settings.minNotionalUsd,
          minEdgeBps: settings.minEdgeBps,
          takeProfitPct: settings.takeProfitPct,
          stopLossPct: settings.stopLossPct,
          addOnlyDipBps: settings.addOnlyDipBps,
          maxRiskPctPerTrade: settings.maxRiskPctPerTrade,
          recentTradeLessons: formatMemoryForLlm(6),
          xSignals: xDigest.ok
            ? {
                summary: xDigest.summary,
                symbols: xDigest.symbols.map((s) => ({
                  symbol: s.symbol,
                  lean: s.lean,
                  sentiment: s.sentiment,
                  mentions: s.mentions,
                })),
                preferBuysHint: xDigest.preferBuysHint,
                preferSellsHint: xDigest.preferSellsHint,
              }
            : undefined,
        });
        if (plan?.thesis) thesis = plan.thesis;
        if (plan?.confidence != null) llmConfidence = plan.confidence;
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
        // Hard fallback: large cash excess + LLM skipped → open one *liquid core* name only
        const cashPct = preview.cashPct ?? 0;
        const excess = cashPct - settings.reserveWethPct;
        const riskExitPass =
          research.stopLossHits.length > 0 ||
          research.takeProfitHits.length > 0 ||
          trigger?.kind === "risk";
        if (
          excess >= 20 &&
          preferBuys.length === 0 &&
          plan?.stance !== "risk_off" &&
          !riskExitPass
        ) {
          const held = new Set(heldStockSyms);
          const unheldCore = settings.allowlist.filter(
            (s) => !held.has(s) && isCoreLiquid(s),
          );
          const xPick = xDigest.preferBuysHint.find((s) =>
            unheldCore.includes(s),
          );
          if (xPick || unheldCore.length) {
            preferBuys = [xPick ?? unheldCore[0]];
            emitEvent(
              "agent.plan",
              `fallback deploy: cash +${excess.toFixed(1)}pp over reserve → open ${preferBuys[0]} (liquid core)`,
              { preferBuys, reason: "cash_excess_fallback" },
            );
          }
        }
        if (plan) {
          emitEvent(
            "agent.plan",
            `stance=${plan.stance} · conf=${plan.confidence ?? "—"} · buys=${preferBuys.join(",") || "—"} · sells=${preferSells.join(",") || "—"}`,
            {
              stance: plan.stance,
              confidence: plan.confidence,
              bearCase: plan.bearCase,
              preferBuys,
              preferSells,
            },
          );
        }
      } catch (err) {
        emitEvent(
          "agent.warn",
          err instanceof Error ? err.message : String(err),
        );
        // Fall through to mechanical thesis / preferBuys
        thesis = research.mechanicalThesis;
        if (!preferBuys.length && research.mechanicalPreferBuys.length) {
          preferBuys = [...research.mechanicalPreferBuys];
        }
      }
    } else if (!research.needLlm) {
      thesis = research.mechanicalThesis;
      if (!preferBuys.length && research.mechanicalPreferBuys.length) {
        preferBuys = [...research.mechanicalPreferBuys];
      }
      // Surface mechanical risk exits as preferSells too (belt + suspenders).
      preferSells = [
        ...new Set([
          ...preferSells,
          ...research.stopLossHits,
          ...research.takeProfitHits,
        ]),
      ];
      emitEvent(
        "agent.plan",
        `mechanical · buys=${preferBuys.join(",") || "—"} · sells=${
          preferSells.join(",") || "—"
        }`,
        {
          preferBuys,
          preferSells,
          stopLossHits: research.stopLossHits,
          takeProfitHits: research.takeProfitHits,
          reason: research.reason,
        },
      );
    } else if (preferBuys.length) {
      emitEvent(
        "agent.plan",
        `no LLM key — preferBuys from thesis notes: ${preferBuys.join(",")}`,
        { preferBuys },
      );
    } else if (research.mechanicalPreferBuys.length) {
      preferBuys = [...research.mechanicalPreferBuys];
      thesis = research.mechanicalThesis;
      emitEvent(
        "agent.plan",
        `no LLM key — mechanical deploy ${preferBuys[0]}`,
        { preferBuys },
      );
    }

    // Soft-merge X buzz only when we actually fetched it
    if (research.needX && xDigest.ok) {
      const cashPctForHints = preview.cashPct ?? 0;
      const cashExcessForHints = cashPctForHints - settings.reserveWethPct;
      const merged = mergeXHints({
        preferBuys,
        preferSells,
        digest: xDigest,
        allowlist: settings.allowlist,
        heldSymbols: heldStockSyms,
        allowBuyHints: cashExcessForHints >= 5,
      });
      if (
        merged.preferBuys.join() !== preferBuys.join() ||
        merged.preferSells.join() !== preferSells.join()
      ) {
        emitEvent(
          "agent.plan",
          `X hints merged · buys=${merged.preferBuys.join(",") || "—"} · sells=${merged.preferSells.join(",") || "—"}`,
          {
            before: { preferBuys, preferSells },
            after: merged,
          },
        );
      }
      preferBuys = merged.preferBuys;
      preferSells = merged.preferSells;
    }

    // Anti-churn: drop preferBuys still in post-SL cooldown
    const beforeCd = preferBuys;
    preferBuys = filterBuyCooldown(preferBuys);
    if (beforeCd.length && preferBuys.length < beforeCd.length) {
      emitEvent(
        "agent.skip",
        `Buy cooldown: blocked ${beforeCd.filter((s) => !preferBuys.includes(s)).join(",")}`,
      );
    }
    // On a risk-exit pass, do not open new risk the same cycle
    if (
      (research.stopLossHits.length > 0 ||
        research.takeProfitHits.length > 0 ||
        trigger?.kind === "risk") &&
      preferBuys.length
    ) {
      emitEvent(
        "agent.skip",
        `Risk-exit pass — deferring buys (${preferBuys.join(",")})`,
      );
      preferBuys = [];
    }

    // Portfolio-manager risk veto (TradingAgents-style approve/reject)
    if (preferBuys.length) {
      const veto = applyRiskVeto({
        preferBuys,
        holdings: holdings.map((h) => ({
          symbol: h.symbol,
          weightPct: h.weightPct,
          unrealizedPnlWethPct: h.unrealizedPnlWethPct,
          unrealizedPnlPct: h.unrealizedPnlPct,
        })),
        cashPct: preview.cashPct,
        reserveWethPct: settings.reserveWethPct,
        confidence: llmConfidence,
      });
      if (veto.vetoed.length) {
        emitEvent(
          "agent.skip",
          `Risk veto: ${veto.vetoed.map((v) => `${v.symbol}(${v.reason})`).join(", ")}`,
          { vetoed: veto.vetoed, allowed: veto.allowed },
        );
      }
      preferBuys = veto.allowed;
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
      avgCostWeth,
      minNotionalUsd: settings.minNotionalUsd,
      takeProfitPct: settings.takeProfitPct,
      stopLossPct: settings.stopLossPct,
      addOnlyDipBps: settings.addOnlyDipBps,
      maxRiskPctPerTrade: settings.maxRiskPctPerTrade,
      maxNamePct: 40,
    });

    for (const p of plan.prepared) {
      if ("error" in p && p.error) {
        emitEvent(
          "agent.error",
          `Prepare blocked ${p.action.tokenIn}→${p.action.tokenOut}: ${p.error}`,
          {
            tokenIn: p.action.tokenIn,
            tokenOut: p.action.tokenOut,
            reason: p.action.reason,
          },
        );
      }
    }
    const plannedSells = plan.analysis.actions.filter(
      (a) => a.action === "swap" && a.side === "sell",
    );
    for (const sym of research.stopLossHits) {
      const hit = plannedSells.some(
        (a) => (a.tokenIn ?? "").toUpperCase() === sym,
      );
      if (!hit) {
        emitEvent(
          "agent.warn",
          `SL ${sym} signaled but no sell was planned — check venue/size`,
          {
            symbol: sym,
            pnl: unrealizedPnlPct[sym],
            usd: holdingUsdBySym[sym],
            actions: plan.analysis.actions.map((a) => a.reason).slice(0, 6),
          },
        );
      }
    }

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
      const uPnlWethTotal = unrealizedPnlWethBySym[stockSym] ?? 0;
      const ethUsd = preview.ethUsd;
      // Fee gate compares $ friction — convert WETH uPnL when available
      const uPnlTotal =
        ethUsd != null && ethUsd > 0 && unrealizedPnlWethBySym[stockSym] != null
          ? uPnlWethTotal * ethUsd
          : (unrealizedPnlUsdBySym[stockSym] ?? 0);
      const unrealizedPnlUsd =
        side === "sell" && holdingUsd > 0
          ? uPnlTotal * (Math.min(notionalUsd, holdingUsd) / holdingUsd)
          : null;
      const pnlPct = unrealizedPnlPct[stockSym];
      const breachedStop =
        side === "sell" &&
        pnlPct != null &&
        pnlPct <= -settings.stopLossPct;
      const breachedTp =
        side === "sell" &&
        pnlPct != null &&
        pnlPct >= settings.takeProfitPct;
      const riskExit =
        side === "sell" &&
        (isRiskExitReason(a.reason) || breachedStop || breachedTp);
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
        riskExit,
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

    // Surface missed mechanical TP/SL (plan said sell but no swap prepared)
    if (capped.length === 0) {
      const riskHits = [
        ...research.stopLossHits,
        ...research.takeProfitHits,
      ];
      if (riskHits.length) {
        const swapActions = plan.analysis.actions.filter(
          (a) => a.action === "swap" && a.side === "sell",
        );
        const preparedErrs = plan.prepared
          .filter((p) => "error" in p && p.error)
          .map(
            (p) =>
              `${p.action.tokenIn}→${p.action.tokenOut}: ${"error" in p ? p.error : ""}`,
          );
        emitEvent(
          "agent.warn",
          `Risk exit signaled (${riskHits.join(",")}) but no sell ready` +
            (swapActions.length
              ? ` — ${preparedErrs.join("; ") || "blocked by size/fee gate"}`
              : " — analysis produced no sell action (check position size / venue)"),
          { riskHits, swapActions: swapActions.length, preparedErrs },
        );
      }
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

    function sellPnlForTweet(action: {
      side?: string;
      tokenIn?: string;
      amountIn?: string;
      notionalUsd?: number;
    }): { realizedPnlUsd: number | null; realizedPnlPct: number | null } {
      if (action.side !== "sell") {
        return { realizedPnlUsd: null, realizedPnlPct: null };
      }
      const sym = (action.tokenIn ?? "").toUpperCase();
      const qty = Number(action.amountIn);
      const notional = action.notionalUsd;
      if (!sym || !(qty > 0) || notional == null || !(notional > 0)) {
        return { realizedPnlUsd: null, realizedPnlPct: null };
      }
      const pos = getPosition(tokenId, sym);
      const avg = pos?.avgCostUsd;
      if (avg == null || !(avg > 0)) {
        return { realizedPnlUsd: null, realizedPnlPct: null };
      }
      const price = notional / qty;
      const realizedPnlUsd = (price - avg) * qty;
      const realizedPnlPct = ((price - avg) / avg) * 100;
      return { realizedPnlUsd, realizedPnlPct };
    }

    function enqueueSwapTweet(
      action: {
        side?: string;
        tokenIn?: string;
        tokenOut?: string;
        amountIn?: string;
        notionalUsd?: number;
        reason?: string;
      },
      opts: {
        dryRun: boolean;
        txHash?: string;
        prepared?: Record<string, unknown>;
      },
    ) {
      const pnl = sellPnlForTweet(action);
      const text = formatStonkSwapTweet({
        tokenId: session.tokenId,
        fromAmount: action.amountIn ?? "?",
        fromSymbol: action.tokenIn ?? "?",
        toAmount: estimateAmountOut(action, opts.prepared),
        toSymbol: action.tokenOut ?? "?",
        txUrl: opts.txHash ? txUrl(opts.txHash as `0x${string}`) : null,
        dryRun: opts.dryRun,
        realizedPnlUsd: pnl.realizedPnlUsd,
        realizedPnlPct: pnl.realizedPnlPct,
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

    const portfolioUsd =
      preview.contentsUsd != null && Number.isFinite(preview.contentsUsd)
        ? preview.contentsUsd
        : null;
    const portfolioEth =
      portfolioUsd != null &&
      preview.ethUsd != null &&
      preview.ethUsd > 0
        ? portfolioUsd / preview.ethUsd
        : null;

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
        if (settings.postToX) {
          enqueueSwapTweet(a, { dryRun: true, prepared: item.prepared });
        }
        recordActionFill({
          tokenId,
          action: a,
          marks,
          dryRun: true,
          ethUsd: preview.ethUsd,
          portfolioUsd,
          portfolioEth,
        });
        emitEvent(
          "agent.fill",
          `Fill recorded (dry) ${(a.side ?? "swap").toUpperCase()} ${a.tokenIn}→${a.tokenOut}`,
          {
            side: a.side,
            tokenIn: a.tokenIn,
            tokenOut: a.tokenOut,
            notionalUsd: a.notionalUsd,
            dryRun: true,
          },
        );
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

          let actualStockQty: number | null = null;
          if (ok && primaryHash && item.action.side === "buy") {
            const outSym = (item.action.tokenOut ?? "").toUpperCase();
            const tokenAddr = STOCK_TOKENS[outSym];
            const dec = TOKEN_DECIMALS[outSym] ?? 18;
            const minOut = Number(item.prepared.amountOutMinimum ?? 0);
            const expected = Number(
              item.prepared.expectedAmountOut ?? item.prepared.fairAmountOut ?? 0,
            );
            if (tokenAddr) {
              const got = await actualTokenInFromTx({
                client,
                hash: primaryHash as Hash,
                token: tokenAddr,
                recipient: session.tba,
                decimals: dec,
              });
              if (got) {
                actualStockQty = got.human;
                try {
                  assertFillSane({
                    side: "buy",
                    receivedHuman: got.human,
                    minOutHuman: minOut > 0 ? minOut : got.human,
                    expectedHuman: expected > 0 ? expected : undefined,
                    symbol: outSym,
                  });
                } catch (fillErr) {
                  const msg =
                    fillErr instanceof Error ? fillErr.message : String(fillErr);
                  emitEvent("agent.error", msg, {
                    hash: primaryHash,
                    received: got.human,
                    minOut,
                    expected,
                  });
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
                  // Book dust truthfully so ledger matches chain
                  recordActionFill({
                    tokenId,
                    action: item.action,
                    marks,
                    dryRun: false,
                    ethUsd: preview.ethUsd,
                    actualStockQty,
                    portfolioUsd,
                    portfolioEth,
                  });
                  continue;
                }
              }
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
            // Tweet / memory need avg cost *before* ledger mutates on sell
            const pnl = sellPnlForTweet(item.action);
            if (settings.postToX) {
              enqueueSwapTweet(item.action, {
                dryRun: false,
                txHash: primaryHash ?? hashes.at(-1),
                prepared: item.prepared,
              });
            }
            const memSym =
              item.action.side === "sell"
                ? (item.action.tokenIn ?? "").toUpperCase()
                : (item.action.tokenOut ?? "").toUpperCase();
            if (memSym && (item.action.side === "buy" || item.action.side === "sell")) {
              recordTradeMemory({
                side: item.action.side,
                symbol: memSym,
                notionalUsd: item.action.notionalUsd ?? 0,
                realizedPnlPct: pnl.realizedPnlPct,
                reason: item.action.reason,
              });
            }
            recordActionFill({
              tokenId,
              action: item.action,
              marks,
              dryRun: false,
              ethUsd: preview.ethUsd,
              actualStockQty,
              portfolioUsd,
              portfolioEth,
            });
            emitEvent(
              "agent.fill",
              `Fill recorded ${(item.action.side ?? "swap").toUpperCase()} ${item.action.tokenIn}→${item.action.tokenOut}`,
              {
                side: item.action.side,
                tokenIn: item.action.tokenIn,
                tokenOut: item.action.tokenOut,
                notionalUsd: item.action.notionalUsd,
                dryRun: false,
                hash: primaryHash ?? hashes.at(-1),
              },
            );
            if (
              item.action.side === "sell" &&
              /stop-loss/i.test(item.action.reason ?? "")
            ) {
              markStopLossCooldown(item.action.tokenIn ?? "");
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

    // Chart continuity — force a post-pass book point when anything traded
    if (capped.length > 0) {
      try {
        const after = await analyzeBrokerPortfolio(client, Number(tokenId), {
          policy: settings.policy,
          reserveWethPct: settings.reserveWethPct,
          deployPct: settings.deployPct,
          symbols: settings.allowlist,
        });
        recordSnapshot({
          tokenId,
          force: true,
          holdings: [
            ...after.holdings.map((h) => ({
              symbol: h.symbol,
              usd: h.usd,
            })),
            ...(after.ethBalanceUsd != null && after.ethBalanceUsd > 0
              ? [{ symbol: "ETH", usd: after.ethBalanceUsd }]
              : []),
          ],
        });
      } catch {
        /* soft — UI refresh still pulls live book */
      }
    }

    setAgentState("idle", "Pass complete");
  } catch (err) {
    const msg = summarizeRpcError(err);
    if (isRpcRateLimitError(err)) {
      // Don't dump the full viem request — soft-fail and wait for next interval
      setAgentState("idle", msg);
      emitEvent("agent.warn", msg);
    } else {
      setAgentState("error", msg);
      emitEvent("agent.error", msg);
    }
  } finally {
    passInFlight = false;
  }
}
