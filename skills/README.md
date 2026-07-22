# Trading skills (runtime + Cursor)

Operational skill packs for the Stonk Trader shell. Autopilot loads `## Agent rules` from each pack into the LLM thesis context and applies mechanical hooks (risk budget, deep stop sizing).

**Not financial advice.** Stock tokens are geo-restricted.

| Pack | Role |
| --- | --- |
| [`cash-core`](./cash-core/SKILL.md) | Reserve cash %, restore dry powder |
| [`position-sizing`](./position-sizing/SKILL.md) | Risk-per-trade budget, deploy caps |
| [`risk-exits`](./risk-exits/SKILL.md) | Stop-loss / take-profit discipline |
| [`selective-entries`](./selective-entries/SKILL.md) | Thesis opens, no spray, dip-adds |
| [`fee-ev`](./fee-ev/SKILL.md) | Fee / min-notional EV gate |
| [`social-signals`](./social-signals/SKILL.md) | X buzz as soft bias only |
| [`onchain-tba`](./onchain-tba/SKILL.md) | TBA funding, gas, no EOA proceeds |

Cursor agents: see also [`.cursor/skills/stonk-trading/SKILL.md`](../.cursor/skills/stonk-trading/SKILL.md).

Doctrine overview: [`docs/TRADING.md`](../docs/TRADING.md).

## Sources (principles adapted for fee-heavy on-chain sleeves)

- [Investor.gov — Asset allocation](https://www.investor.gov/introduction-investing/getting-started/asset-allocation)
- [CFA — Measuring and Managing Market Risk](https://www.cfainstitute.org/insights/professional-learning/refresher-readings/2026/measuring-managing-market-risk)
- [CIBC — Position sizing / trade risk](https://www.investorsedge.cibc.com/en/learn/investing/portfolio-strategies/position-sizing.html)
- Trend-following consensus: cut losers, volatility-aware size, sector/name caps (retail primers / CTA practice)
