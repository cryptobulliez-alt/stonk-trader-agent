---
name: cash-core
description: >-
  Keep a strategic cash (WETH/ETH) reserve and restore it before new risk.
  Use when deciding buy vs hold, rebalancing, or cash% drifts from reserveWethPct.
priority: 10
inject: thesis
---

# Cash core (allocation)

Separate **cash vs risk sleeve** (Investor.gov-style allocation). Rebalance means restore cash to target — not equal-weight every allowlist name.

## Agent rules

1. Target cash ≈ `reserveWethPct` (default 30% WETH+ETH of book).
2. If cash is below reserve − band → **sells only** until restored (prefer winners when cutting for cash).
3. If cash is ≥10pp above reserve and unheld allowlist names exist → prefer `risk_on` + **one** new open (put dry powder to work).
4. Near target (± a few pp) → prefer **hold** over fee-churning micro-rebalances.
5. Never treat the full allowlist as a must-buy shopping list.

## Decision cues

| Cash vs reserve | Stance bias |
| --- | --- |
| ≪ reserve | `risk_off` / sells only |
| ≈ reserve | `hold` unless TP/SL or strong thesis |
| ≫ reserve (+10pp) | `risk_on` + 1 unheld preferBuy |
