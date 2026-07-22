---
name: research-thrift
description: >-
  Skip LLM and X research rails when TP/SL, cash-restore, or near-target hold
  are already decided from book marks. Use when tuning researchRails or costs.
priority: 55
inject: thesis
---

# Research thrift

LLM and X cost money and latency. Prefer mechanical book logic when the decision is obvious.

## Agent rules

1. Default `researchRails=auto`: call LLM/X only when the pass is **ambiguous** (mainly dry-powder deploy pick among unheld names).
2. Skip research when: cash restore, WETH TP/SL hits, or cash within ~5pp of reserve with no exits.
3. Mechanical thesis + core TP/SL still run every pass from marks / cost basis — no API required.
4. Excess cash (≥10pp) without research → open first unheld allowlist name (mechanicalPreferBuys).
5. `researchRails=always` forces LLM/X every pass; `off` never calls them.
6. `useXSignals` still must be on for X fetches — research gate is an additional filter.
