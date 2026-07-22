---
name: social-signals
description: >-
  Use X cashtag buzz as a soft bias on preferBuys/preferSells — never as sole authority.
  Use when useXSignals is on, interpreting agent.x buzz lines, or merging social hints.
priority: 60
inject: thesis
---

# Social signals (X)

Optional rail: recent cashtag search (`X_BEARER_TOKEN` + `useXSignals`). Soft edge only — social is noisy and laggy.

## Agent rules

1. Treat X lean as **hint**, not a hard order. Mechanical TP/SL and cash core always win.
2. Bearish lean on a **held** name → may fill an empty `preferSells` slot (still fee-gated if mid-band).
3. Bullish lean on an **unheld** allowlist name → may fill `preferBuys` only when cash has room (≥~5pp over reserve).
4. Do not invent tickers outside the allowlist from buzz.
5. Do not override explicit `risk_off` with bullish buzz.
6. Low mention count → treat as **neutral** (ignore).
7. Never call Robinhood `place_*` for TBA execution; X is research/bias + fill posts only.

## Merge priority

1. Cash core / risk exits  
2. LLM thesis  
3. X hints (fill empty slots)  
4. Settings thesis note tickers (if no LLM)
