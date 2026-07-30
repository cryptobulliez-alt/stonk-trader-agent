# Decision memory & risk veto

Patterns adapted from [TradingAgents](https://github.com/TauricResearch/TradingAgents) (decision log + portfolio-manager approve/reject) and [Vibe-Trading](https://github.com/HKUDS/Vibe-Trading) (fail-closed live guards).

## Rules

1. **Remember fills** — after each live buy/sell, append a one-line reflection to `data/trade-memory.json`. Inject recent lessons into the LLM pass.
2. **Risk veto before prepare** — mechanical gate may drop `preferBuys` for: post-SL cooldown, max open names (4), loss streak ≥3, sleeve mostly underwater, confidence &lt;3 without large cash excess, or non-tradeable venue.
3. **Confidence** — LLM returns 1–5; low conviction opens need dry powder (cash ≫ reserve), not FOMO adds.
4. **Bear case** — every open should name a risk; empty preferBuys is correct when bear risks dominate.
5. **Sells / TP-SL never vetoed** here — risk exits stay hard rails.
