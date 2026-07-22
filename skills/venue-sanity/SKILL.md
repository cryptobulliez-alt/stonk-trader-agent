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
2. **Venue select:** probe v3 and v4 when both exist; pick the mark-sane quote (`settings.swapVenue`: `auto` | `v3` | `v4`). A pool that “exists” is not enough — junk v4 must lose to good v3.
3. If exec quote is **>1% below** mark-implied fair out → **refuse that venue** (try the other; if neither passes, refuse prepare).
4. `amountOutMinimum` is floored by mark × (1 − 1% − slip) so a lying quoter cannot set a dust minOut.
5. After buy: parse Transfer logs; book **actual** qty; error if received ≪ expected.
6. Prefer hold / skip over trading an illiquid or wrong pool. Remove thin names from allowlist.
7. Notional/mark estimates in the fill log are not ground truth — chain receipts are.
