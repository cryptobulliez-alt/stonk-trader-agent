/**
 * Decide when LLM / X research rails are worth calling.
 * Mechanical TP/SL / cash-restore / near-target hold should not burn API spend.
 */

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
const EXCESS_DEPLOY_PP = 10;
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

  let mechanicalPreferBuys: string[] = [];
  if (
    excess != null &&
    excess >= EXCESS_DEPLOY_PP &&
    unheld.length &&
    !cashRestore
  ) {
    mechanicalPreferBuys = [unheld[0]];
  }

  const mechanicalThesis =
    bits.length > 0
      ? `Mechanical: ${bits.join(" · ")}.${
          mechanicalPreferBuys.length
            ? ` Deploy dry powder → ${mechanicalPreferBuys[0]} (unheld).`
            : riskExits.length
              ? " Executing risk exits; no research rail."
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
    // Risk exits are mechanical. Only pull research if we also need a deploy pick
    // in the same pass (unusual: exits raise cash further).
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
