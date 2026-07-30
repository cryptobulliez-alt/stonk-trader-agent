---
name: event-signals
description: >-
  Near-real-time mark shocks (RPC) and public RSS headlines can wake autopilot
  early. Asymmetric: risk trims on bad news/drops; opportunity buys only with cash room.
priority: 55
inject: thesis
---

# Event signals (marks + RSS)

Watcher ticks while autopilot runs (`signalWatchEnabled`). Free rails: Uniswap marks + Google/Yahoo/SEC RSS. X remains optional via research rails.

## Agent rules

1. **Risk wakes** (held mark drop ≥ `markShockBps`, or bearish RSS on held) → preferSells / thesis trim; **defer buys** this pass; skip LLM/X in `auto`.
2. **Opportunity wakes** (unheld mark surge or bullish RSS) → preferBuys hints **only** when cash is above reserve band; still fee EV, cooldown, risk veto, deploy caps.
3. Signals never bypass min notional, TBA funding, or venue sanity.
4. Allowlist = candidates; do not invent tickers from headlines outside allowlist.
5. Mechanical TP/SL and cash-core restore still win over soft opportunity buzz.
6. Wake spam is rate-limited (`minWakeGapMs` + per-symbol news debounce) — ignore duplicate wakes.
7. Never call Robinhood `place_*` for TBA execution.

## Merge priority

1. Cash core / mechanical TP/SL  
2. Signal risk trims  
3. LLM thesis (when research gate opens)  
4. Signal / X opportunity hints (empty slots, cash room)  
5. Settings thesis note tickers
