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
3. **V3 sizing uses QuoterV2** (fees + impact), never slot0. `amountOutMinimum` = quoter × (1 − slip) so thin USO/SLV fills succeed.
4. Mark gate (`maxExecVsMarkBps`, default **10%** + route fees) blocks wrong-pool **dust** (SLV v4 disaster), not normal thin-book impact.
5. Prefer the mark-sane venue with the best executable quote — trade USO/SLV on v3 when that is the real book.
6. After buy: parse Transfer logs; book **actual** qty; error if received ≪ expected.
7. Prefer hold / skip only when **no** venue clears the dust gate. Thin names with a real Quoter path are tradeable.
8. Notional/mark estimates in the fill log are not ground truth — chain receipts are.
