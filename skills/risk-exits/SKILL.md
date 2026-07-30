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

1. **Stop-loss** — WETH-relative uPnL% ≤ −`stopLossPct` → **risk exit** (default **5%**). Clears fee gate even when dollar uPnL is negative.
2. **Take-profit** — WETH-relative uPnL% ≥ `takeProfitPct` → **risk exit** trim into cash (default **6%** — asymmetric vs SL).
3. **Full / near-full SL exit** — do not drip 50% every pass (fee death spiral). Deep breach → 100% exit; soft SL → ≥75%.
4. After SL, **6h buy cooldown** on that symbol; **no redeploy same pass** as risk exits.
5. Thesis / X bearish mid-band trims are **discretionary** — need edge ≥ estimated sell fees unless TP/SL already breached.
6. Cash-restore sells may proceed with weak uPnL when cash is critically low.
7. Do not widen a live stop on hope — widen the *policy* if RH token noise is high.
8. **Numeraire = WETH** — USD NAV is for reporting only.

## Trim fractions

| Condition | Typical trim |
| --- | --- |
| Soft TP (≥ takeProfitPct) | ~50% of position |
| Soft SL (≤ −stopLossPct) | ≥75% (prefer clean cut) |
| Deep SL (≤ −1.5× stop) | 100% |
| Concentration over maxNamePct | Down to cap |

## Notes

Tight 2.5% stops chopped this book (15 SL / 0 TP). Wider SL + full exits + no immediate redeploy into thin names.
