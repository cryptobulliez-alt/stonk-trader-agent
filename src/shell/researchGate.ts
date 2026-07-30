/**
 * Decide when LLM / X research rails are worth calling.
 * Mechanical TP/SL / cash-restore / near-target hold should not burn API spend.
 * Signal wakes: risk → skip research; opportunity → research only with cash excess.
 */
import { CORE_LIQUID_SYMBOLS } from "./cooldowns.js";
import type { SignalTrigger } from "./signalWatch.js";

export type ResearchRailsMode = "auto" | "always" | "off";

export type ResearchGateInput = {
  mode: ResearchRailsMode;
  cashPct: number | null;
  reserveWethPct: number;
  /** WETH-relative uPnL % by symbol. */
  unrealizedPnlWethPct: Record<string, number>;
  takeProfitPct: number;
  stopLossPct: number;
  allowlist: string[];
  heldSymbols: string[];
  /** Operator thesis notes — if they name tickers, can seed buys without LLM. */
  settingsThesis?: string;
  minNotionalUsd?: number;
  holdingUsdBySym?: Record<string, number>;
  /** Early wake from mark/RSS watcher (asymmetric). */
  signalTrigger?: SignalTrigger | null;
};

export type ResearchGateResult = {
  /** Call LLM this pass. */
  needLlm: boolean;
  /** Fetch X buzz this pass (still requires useXSignals + bearer). */
  needX: boolean;
  /** Short machine thesis when skipping research. */
  mechanicalThesis: string;
  /** Why research was skipped or requested. */
  reason: string;
  /** Symbols already at TP (WETH). */
  takeProfitHits: string[];
  /** Symbols already at SL (WETH). */
  stopLossHits: string[];
  cashRestore: boolean;
  cashExcessPct: number | null;
  /** Unheld allowlist candidates. */
  unheld: string[];
  /**
   * When research is skipped but cash is heavy, core can still open one name.
   * Empty when not applicable.
   */
  mechanicalPreferBuys: string[];
};

const CASH_BAND = 0.05; // same spirit as core BAND
/** Only force a mechanical open when cash is *meaningfully* above reserve. */
const EXCESS_DEPLOY_PP = 20;
/** Within this many pp of reserve and no TP/SL → clear hold. */
const NEAR_TARGET_PP = 5;

export function classifyResearchNeed(input: ResearchGateInput): ResearchGateResult {
  const cashPct = input.cashPct;
  const reserve = input.reserveWethPct;
  const excess =
    cashPct != null ? +(cashPct - reserve).toFixed(2) : null;
  const cashRestore =
    cashPct != null && cashPct < reserve * (1 - CASH_BAND);

  const held = new Set(input.heldSymbols.map((s) => s.toUpperCase()));
  const unheld = input.allowlist
    .map((s) => s.toUpperCase())
    .filter((s) => !held.has(s));

  const takeProfitHits: string[] = [];
  const stopLossHits: string[] = [];
  const minN = input.minNotionalUsd ?? 0;
  for (const [sym, pnl] of Object.entries(input.unrealizedPnlWethPct)) {
    const usd = input.holdingUsdBySym?.[sym];
    if (usd != null && usd < minN) continue;
    if (pnl >= input.takeProfitPct) takeProfitHits.push(sym);
    if (pnl <= -input.stopLossPct) stopLossHits.push(sym);
  }

  const riskExits = [...takeProfitHits, ...stopLossHits];
  const bits: string[] = [];
  if (cashPct != null) {
    bits.push(`Cash ${cashPct.toFixed(1)}% (target ${reserve}%)`);
  }
  if (stopLossHits.length) {
    bits.push(
      `SL: ${stopLossHits.map((s) => `${s} ${input.unrealizedPnlWethPct[s]?.toFixed(1)}%`).join(", ")}`,
    );
  }
  if (takeProfitHits.length) {
    bits.push(
      `TP: ${takeProfitHits.map((s) => `${s} +${input.unrealizedPnlWethPct[s]?.toFixed(1)}%`).join(", ")}`,
    );
  }

  const trigger = input.signalTrigger ?? null;
  if (trigger?.kind === "risk" && trigger.symbols.length) {
    bits.push(`Signal risk: ${trigger.symbols.join(",")}`);
  } else if (trigger?.kind === "opportunity" && trigger.symbols.length) {
    bits.push(`Signal opportunity: ${trigger.symbols.join(",")}`);
  }

  // Never mechanical-deploy on the same pass as TP/SL — that recycled SL cash into USO/SLV.
  let mechanicalPreferBuys: string[] = [];
  if (
    excess != null &&
    excess >= EXCESS_DEPLOY_PP &&
    unheld.length &&
    !cashRestore &&
    riskExits.length === 0 &&
    trigger?.kind !== "risk"
  ) {
    const coreUnheld = unheld.filter((s) =>
      (CORE_LIQUID_SYMBOLS as readonly string[]).includes(s),
    );
    if (coreUnheld.length) mechanicalPreferBuys = [coreUnheld[0]];
  }

  // Opportunity wake with cash room: seed preferBuys from signal symbols (allowlist ∩ unheld)
  if (
    trigger?.kind === "opportunity" &&
    !cashRestore &&
    riskExits.length === 0 &&
    excess != null &&
    excess >= NEAR_TARGET_PP
  ) {
    const picks = trigger.symbols
      .map((s) => s.toUpperCase())
      .filter((s) => unheld.includes(s))
      .slice(0, 2);
    if (picks.length) mechanicalPreferBuys = picks;
  }

  const mechanicalThesis =
    bits.length > 0
      ? `Mechanical: ${bits.join(" · ")}.${
          trigger?.kind === "risk"
            ? ` Signal risk trim ${trigger.symbols.join(",")}; no research rail; defer buys.`
            : riskExits.length
              ? " Executing risk exits; hold dry powder this pass (no redeploy)."
              : mechanicalPreferBuys.length
                ? ` Deploy dry powder → ${mechanicalPreferBuys.join(",")}.`
                : cashRestore
                  ? " Restoring cash core; sells only."
                  : " Near plan — hold unless exits fire."
        }`
      : "Mechanical pass — book snapshot only.";

  if (input.mode === "off") {
    return {
      needLlm: false,
      needX: false,
      mechanicalThesis,
      reason: "research_rails=off",
      takeProfitHits,
      stopLossHits,
      cashRestore,
      cashExcessPct: excess,
      unheld,
      mechanicalPreferBuys,
    };
  }

  // Signal risk wake: never burn LLM/X (unless researchRails=always)
  if (trigger?.kind === "risk" && input.mode !== "always") {
    return {
      needLlm: false,
      needX: false,
      mechanicalThesis,
      reason: `skip_research: signal_risk (${trigger.symbols.join(",")})`,
      takeProfitHits,
      stopLossHits,
      cashRestore,
      cashExcessPct: excess,
      unheld,
      mechanicalPreferBuys: [],
    };
  }

  if (input.mode === "always") {
    return {
      needLlm: true,
      needX: true,
      mechanicalThesis,
      reason: "research_rails=always",
      takeProfitHits,
      stopLossHits,
      cashRestore,
      cashExcessPct: excess,
      unheld,
      mechanicalPreferBuys,
    };
  }

  // --- auto ---
  // Opportunity wake: research only when cash excess warrants a deploy pick
  if (trigger?.kind === "opportunity") {
    if (cashRestore || riskExits.length > 0) {
      return {
        needLlm: false,
        needX: false,
        mechanicalThesis,
        reason: "skip_research: signal_opportunity_blocked_by_exits",
        takeProfitHits,
        stopLossHits,
        cashRestore,
        cashExcessPct: excess,
        unheld,
        mechanicalPreferBuys: [],
      };
    }
    if (excess != null && excess >= EXCESS_DEPLOY_PP && unheld.length > 0) {
      return {
        needLlm: true,
        needX: true,
        mechanicalThesis,
        reason: `need_research: signal_opportunity (${trigger.symbols.join(",")})`,
        takeProfitHits,
        stopLossHits,
        cashRestore,
        cashExcessPct: excess,
        unheld,
        mechanicalPreferBuys,
      };
    }
    // Mild cash room: mechanical preferBuys from signal only — no LLM/X
    if (excess != null && excess >= NEAR_TARGET_PP && mechanicalPreferBuys.length) {
      return {
        needLlm: false,
        needX: false,
        mechanicalThesis,
        reason: `skip_research: signal_opportunity_mechanical (${mechanicalPreferBuys.join(",")})`,
        takeProfitHits,
        stopLossHits,
        cashRestore,
        cashExcessPct: excess,
        unheld,
        mechanicalPreferBuys,
      };
    }
    return {
      needLlm: false,
      needX: false,
      mechanicalThesis,
      reason: "skip_research: signal_opportunity_no_cash_room",
      takeProfitHits,
      stopLossHits,
      cashRestore,
      cashExcessPct: excess,
      unheld,
      mechanicalPreferBuys: [],
    };
  }

  // Obvious: cash restore or hard TP/SL — core policy handles it.
  if (cashRestore) {
    return {
      needLlm: false,
      needX: false,
      mechanicalThesis,
      reason: "skip_research: cash_restore",
      takeProfitHits,
      stopLossHits,
      cashRestore,
      cashExcessPct: excess,
      unheld,
      mechanicalPreferBuys: [],
    };
  }

  if (riskExits.length > 0) {
    const alsoDeploy =
      excess != null &&
      excess >= EXCESS_DEPLOY_PP &&
      unheld.length > 0 &&
      mechanicalPreferBuys.length > 0;
    if (!alsoDeploy) {
      return {
        needLlm: false,
        needX: false,
        mechanicalThesis,
        reason: `skip_research: risk_exits (${riskExits.join(",")})`,
        takeProfitHits,
        stopLossHits,
        cashRestore,
        cashExcessPct: excess,
        unheld,
        mechanicalPreferBuys: [],
      };
    }
  }

  // Clear hold: cash near target, nothing breached
  if (
    excess != null &&
    Math.abs(excess) < NEAR_TARGET_PP &&
    riskExits.length === 0
  ) {
    return {
      needLlm: false,
      needX: false,
      mechanicalThesis,
      reason: "skip_research: near_target_hold",
      takeProfitHits,
      stopLossHits,
      cashRestore,
      cashExcessPct: excess,
      unheld,
      mechanicalPreferBuys: [],
    };
  }

  // Dry powder: need a name pick — research helps; mechanicalPreferBuys is fallback
  if (excess != null && excess >= EXCESS_DEPLOY_PP && unheld.length > 0) {
    return {
      needLlm: true,
      needX: true,
      mechanicalThesis,
      reason: "need_research: deploy_pick",
      takeProfitHits,
      stopLossHits,
      cashRestore,
      cashExcessPct: excess,
      unheld,
      mechanicalPreferBuys,
    };
  }

  // Mild excess / mild deficit without exits — hold; don't pay for vibes
  return {
    needLlm: false,
    needX: false,
    mechanicalThesis,
    reason: "skip_research: no_ambiguous_decision",
    takeProfitHits,
    stopLossHits,
    cashRestore,
    cashExcessPct: excess,
    unheld,
    mechanicalPreferBuys: [],
  };
}
