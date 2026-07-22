---
name: venue-sanity
description: >-
  Refuse swaps when the execution venue quote is far worse than an independent
  mark. Use when preparing trades, debugging bad fills, or reviewing amountOutMinimum.
priority: 8
inject: thesis
---

# Venue / mark sanity

Never accept a fill that is dust versus the portfolio mark. The SLV incident (V3 mark ~$54, v4 pool paid ~dust for ~$20 ETH) must not recur.

## Agent rules

1. Independent mark (usually V3 WETH/USDG) and execution venue (v4 or v3) are compared before signing.
2. If exec quote is **>5% below** mark-implied fair out → **refuse prepare** (do not broadcast).
3. `amountOutMinimum` is floored by mark × (1 − 5% − slip) so a lying quoter cannot set a dust minOut.
4. After buy: parse Transfer logs; book **actual** qty; error if received ≪ expected.
5. Prefer hold / skip over trading an illiquid or wrong pool. Remove thin names from allowlist.
6. Notional/mark estimates in the fill log are not ground truth — chain receipts are.
