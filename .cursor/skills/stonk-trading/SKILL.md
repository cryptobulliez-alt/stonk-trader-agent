---
name: stonk-trading
description: >-
  Stonk Trader TBA sleeve doctrine: cash core, selective entries, risk exits,
  fee EV, X signals, on-chain TBA rules. Use when editing autopilot, portfolio
  manage, fee gate, thesis/LLM, skills packs, or trading settings.
---

# Stonk trading (project)

When changing trading logic, read and respect runtime skill packs under [`skills/`](../../../skills/README.md) and [`docs/TRADING.md`](../../../docs/TRADING.md).

## Non-negotiables

1. Cash target = `reserveWethPct` — restore before new risk when below band.
2. Allowlist = candidates; opens only via `preferBuys` (≤2).
3. Stop-loss / take-profit are **risk exits** — fee gate must allow losers past min notional.
4. Buys fund from **TBA**; EOA gas only; never send TBA proceeds to EOA.
5. Never `place_*` on Robinhood research MCP for TBA execution.

## Where logic lives

| Concern | Code |
| --- | --- |
| Core actions TP/SL/buys | `src/portfolioManage.ts` |
| Fee gate / riskExit | `src/shell/tradeEconomics.ts` |
| Autopilot pass / X / LLM | `src/shell/autopilot.ts` |
| Skill load + risk budget helpers | `src/shell/skills.ts` |
| Thesis prompt | `src/shell/llm.ts` |

## Editing skills

- Packs: `skills/<id>/SKILL.md` with YAML frontmatter + `## Agent rules`.
- Autopilot injects Agent rules into the LLM each pass — keep rules concise.
- Mechanical hooks (risk budget, deep-stop trim) live in `skills.ts` + `portfolioManage.ts`.

## Additional packs

- [cash-core](../../../skills/cash-core/SKILL.md)
- [position-sizing](../../../skills/position-sizing/SKILL.md)
- [risk-exits](../../../skills/risk-exits/SKILL.md)
- [selective-entries](../../../skills/selective-entries/SKILL.md)
- [fee-ev](../../../skills/fee-ev/SKILL.md)
- [social-signals](../../../skills/social-signals/SKILL.md)
- [onchain-tba](../../../skills/onchain-tba/SKILL.md)
