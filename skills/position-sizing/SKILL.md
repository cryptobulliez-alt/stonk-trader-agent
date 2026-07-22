---
name: position-sizing
description: >-
  Size opens from risk budget and deploy caps so a stop hit is a small % of equity.
  Use when preparing buys, setting deployPct, or reviewing concentration.
priority: 20
inject: thesis
---

# Position sizing

Risk-based sizing (CIBC / trend-following practice): pick **trade risk** first, then size so a stop loss ≈ that budget. Cap per-pass deploy and per-name weight.

## Agent rules

1. Risk per new open at the configured stop ≈ **`maxRiskPctPerTrade` of book** (default ~1.5%).  
   Cap buy notional: `bookUsd × maxRiskPctPerTrade / stopLossPct`.
2. Never spend below cash reserve; never deploy more than `deployPct` of book **per pass**.
3. Cap any single name at `maxNamePct` of book (default 40%).
4. Prefer **one fee-viable ticket** over many dust tickets.
5. Scale in: add to winners only on dip (`addOnlyDipBps`) unless thesis explicitly pyramids strength.
6. Do not size up because of conviction alone — formula + fees win.

## Formula (mechanical)

```
riskUsd     = contentsUsd × (maxRiskPctPerTrade / 100)
buyCapUsd   = riskUsd / (stopLossPct / 100)
ticketUsd   = min(deployable, buyCapUsd, nameRoom, maxNotionalEth$)
```

If `ticketUsd < minNotionalUsd` → skip (fee protection).

## Anti-patterns

- Risking >2–3% of equity on one name at the stop.
- Equal-weighting every allowlist symbol each pass.
- Averaging down endlessly without a stop.
