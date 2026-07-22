# Agent playbook — Stonk Trader Shell

**Goal:** keep a cash core at **`reserveWethPct` (default 30%)**, run a **selective** stock sleeve (trend thesis → 1–2 names), take profits / cut losses — aiming for profitable TBA management over time (no guarantees).

**Trading doctrine:** see [`docs/TRADING.md`](docs/TRADING.md) and runtime skill packs in [`skills/`](skills/README.md) (Investor.gov / CFA / exit-discipline + agent rules).

## Host model

Users run this **locally**. Secrets (`PRIVATE_KEY`, `LLM_API_KEY`, `X_*`) live only in `.env`. Non-secret policy lives in `data/settings.json` (dashboard-editable).

Default entry: `npm run shell` → dashboard at `http://localhost:3000` + API at `:8788`.

## Rails

| Rail | Surface | Use for |
| --- | --- | --- |
| A | `robinhood-trading` MCP (optional) | Quotes / research — **not** TBA execution |
| B | This shell (dashboard / MCP / CLI) | TBA state, selective core, Uniswap prepare/sign, trade tweets |
| C | X API (`X_*` OAuth + optional `X_BEARER_TOKEN`) | Fill posts + optional cashtag buzz signals (`useXSignals`) |
| Docs | `docs/TRADING.md` + `skills/*/SKILL.md` | Best-practice rules injected into LLM + human operators |

## Autopilot loop

Default policy: **`core`** (`reserveWethPct=30`, `deployPct≤15` per pass).

1. Snapshot book + cost basis  
2. **Signals** — optional X cashtag buzz (`useXSignals`); **Thesis** — LLM loads `skills/*/SKILL.md` agent rules + returns `preferBuys` / `preferSells` / `stance`; else tickers named in Settings thesis notes  
3. Core actions  
   - Cash below reserve → **sells only**  
   - Held names → **take-profit / stop-loss** (deeper SL → larger trim) (+ thesis sells)  
   - Opens → **only** `preferBuys` (≤2), sized by deploy + **risk budget** (`maxRiskPctPerTrade`)  
4. **Fee EV gate** — buys need edge/size vs fees; **risk exits (TP/SL/concentration) clear when notional ≥ min** (losers are allowed); thesis trims still need uPnL ≥ sell cost  
5. Prepare (v4; TBA-funded buys) → sign if Dry run OFF → optional X fill post  
6. Repeat on `intervalMs`

**Allowlist = candidates**, not a must-buy list. Empty `preferBuys` → hold is correct.

Fee defaults: `minNotionalUsd=3`, `minEdgeBps=10`, `takeProfitPct=3`, `stopLossPct=2.5`, `maxRiskPctPerTrade=1.5`, `addOnlyDipBps=50`, `maxActionsPerPass=3`, `maxNotionalEth=0.05`.

## Policies

| Policy | Use |
| --- | --- |
| **`core`** | Default — cash reserve + selective sleeve |
| `targets` | Explicit research weights (include enough WETH for reserve) |
| `deploy` | Force deploy into symbols (manual) |
| `trim` / `dry_powder` / `max_name` | Manual risk controls |

## Engines (B)

- **Preferred:** Uniswap v4 UniversalRouter → PoolManager (ETH↔stock)
- **Fallback:** V3 SwapRouter02 (incl. WETH→USDG hops)

## Universe

`data/assets.json` — full Robinhood Chain stock-token list. Autopilot **considers** only the **allowlist**; it **buys** only thesis picks.

## Rules

- Follow `docs/TRADING.md`.
- Never `place_*` on Rail A for TBA management.
- Never send TBA proceeds to the owner EOA.
- **Buys spend TBA WETH/ETH** — fund the TBA; EOA pays gas only.
- Prefer hold over fee-negative or thesis-less opens.
- Activation clears on transfer; liquid contents are removable until sale.
- Not financial advice; stock tokens are geo-restricted.
