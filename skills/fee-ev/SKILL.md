---
name: fee-ev
description: >-
  Skip swaps that cannot clear gas+slip after fees on Robinhood Chain.
  Use when preparing tickets, reviewing fee-gate skips, or sizing minNotional.
priority: 50
inject: thesis
---

# Fee / EV gate

On-chain stock-token swaps are **fee-heavy**. Tiny notionals are structurally negative EV. Prefer hold over churn.

## Agent rules

1. Skip if notional < `minNotionalUsd` (except cash-critical dust restores).
2. Buys: need edge (`minEdgeBps`) vs round-trip **or** ticket ≥ ~10× entry fees and entry drag ≤ 8%.
3. Discretionary sells (thesis trim): need sold-fraction uPnL $ ≥ estimated sell cost.
4. **Risk exits** (TP/SL/concentration): pass when notional ≥ min — **do not** require profitable uPnL.
5. One fee-viable ticket beats eight dust tickets.
6. Near cash target → prefer hold over forced micro-rebalances.

## Live feed cues

- `fee gate ok: risk exit` → stop/TP cleared correctly  
- `skip discretionary trim` → thesis trim failed EV (expected mid-band)  
- `notional < min` → size up or skip
