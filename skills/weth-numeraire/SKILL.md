---
name: weth-numeraire
description: >-
  Measure stock-sleeve P&L in WETH (vs idle cash), not USD. Use when setting
  stops, take-profits, dip-adds, or interpreting portfolio P&L.
priority: 15
inject: thesis
---

# WETH numeraire

You trade **stock ↔ WETH** on-chain. ETH/USD is a separate macro bet. Sleeve alpha = did the name beat **holding WETH**?

## Agent rules

1. Cost basis for stocks is tracked in **WETH spent per share** (plus USD for reporting).
2. TP/SL / preferSells mid-band use **WETH-relative** unrealized % (`unrealizedPnlWethPct`).
3. Dip-adds compare mark WETH vs avg cost WETH (`addOnlyDipBps`).
4. USD book / period chart = human scoreboard; do not stop out solely because ETH pumped against a flat stock in dollars.
5. Goal of the risk sleeve: grow TBA **WETH inventory** after fees — subject to cash-core reserve.
6. When describing thesis, prefer “−3% vs WETH” over “−3% USD” for held names.
