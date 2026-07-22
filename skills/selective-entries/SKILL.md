---
name: selective-entries
description: >-
  Open 1–2 thesis names from the allowlist; hold is valid when no edge.
  Use when forming preferBuys, stance, or deciding whether to deploy dry powder.
priority: 40
inject: thesis
---

# Selective entries

Allowlist = **candidates**, not a shopping list. Trend / thesis sleeve: few names, clear reason, fee-viable size.

## Agent rules

1. `preferBuys`: **0–2** allowlist symbols only.
2. Empty `preferBuys` is correct when cash ≈ target or stance is `risk_off`.
3. Prefer **unheld** names when cash ≫ reserve (diversify the risk sleeve).
4. Do not buy every flat held name "because cash is high."
5. Adds require dip vs avg cost (`addOnlyDipBps`) unless thesis explicitly pyramids.
6. If LLM and settings disagree → prefer **hold** or the smaller action.
7. Log why this name, why now (audit trail).

## Stance map

| Stance | PreferBuys | PreferSells |
| --- | --- | --- |
| `risk_on` | 1 (max 2) | optional |
| `hold` | usually empty | TP/SL / broken trend only |
| `risk_off` | empty | 1–2 held names OK |
