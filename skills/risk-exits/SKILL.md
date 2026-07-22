---
name: risk-exits
description: >-
  Pre-define stop-loss and take-profit; execute them as hard risk exits.
  Use when holdings breach stopLossPct/takeProfitPct or thesis breaks mid-band.
priority: 30
inject: thesis
---

# Risk exits (TP / SL)

Exits are portfolio **constraints** (CFA-style), not vibes. Pre-define upside/downside; do not move stops on hope (CIBC entries/exits practice). Cut losers; bank or trail winners.

## Agent rules

1. **Stop-loss** — uPnL% ≤ −`stopLossPct` → **risk exit**. Must clear fee gate at min notional even when **dollar uPnL is negative** (otherwise stops never fire).
2. **Take-profit** — uPnL% ≥ `takeProfitPct` → **risk exit** trim into cash.
3. Deep stops (breach ≥1.5× `stopLossPct`) → trim a **larger** fraction of the position.
4. Thesis / X bearish mid-band trims are **discretionary** — need uPnL ≥ estimated sell fees unless TP/SL already breached.
5. Cash-restore sells may proceed with weak uPnL when cash is critically low.
6. Do not widen a stop after entry to "give it room." Widen the *policy* setting if RH token noise is high — not the live stop.

## Trim fractions (guidance)

| Condition | Typical trim |
| --- | --- |
| Soft TP (≥ takeProfitPct) | ~35–50% of position |
| Soft SL (≤ −stopLossPct) | ~35–50% |
| Deep SL (≤ −1.5× stop) | ~60–75% |
| Concentration over maxNamePct | Down to cap |

## Notes

Tight stops chop; defaults ~2.5–5% SL / ~3%+ TP are sleeve rules — match noise and fees (CFA Enterprising Investor caution on overly tight stops).
