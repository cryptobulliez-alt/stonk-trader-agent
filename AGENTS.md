# Agent playbook — Stonk Trader Shell

**Goal:** keep a **~70% WETH cash core**, run a diversified stock sleeve with the rest, take profits into cash, and redeploy selectively — aiming for profitable TBA management over time (no guarantees).

## Host model

Users run this **locally**. Secrets (`PRIVATE_KEY`, `LLM_API_KEY`, `X_*`) live only in `.env`. Non-secret policy lives in `data/settings.json` (dashboard-editable).

Default entry: `npm run shell` → dashboard at `http://localhost:3000` + API at `:8788`.

## Rails

| Rail | Surface | Use for |
| --- | --- | --- |
| A | `robinhood-trading` MCP (optional) | Quotes / research — **not** TBA execution |
| B | This shell (dashboard / MCP / CLI) | TBA state, core rebalance, Uniswap prepare/sign, trade tweets |
| C | X API / X MCP | Social edge + fill posts |

## Autopilot loop

Default policy: **`core`** (`reserveWethPct=70`, `deployPct≤15` per pass).

1. Snapshot — `analyze_broker_portfolio` / manage
   - If **cash < ~70%** → **sells only**
   - If **cash ≈ 70%** → take-profit / stop-loss / trim overweight; buy underweights only with cash above reserve (dip-only adds vs avg cost)
2. Optional LLM thesis (`LLM_API_KEY`)
3. **Fee EV gate** — skip swaps unless notional ≥ `minNotionalUsd` and expected edge clears gas+slip (`minEdgeBps`); cash-restore sells can bypass uPnL edge
4. Prepare — v4 UniversalRouter preferred; buys unwrap TBA WETH so owner outer `value=0` (EOA pays gas only)
5. Sign — only if Dry run is OFF (`settings.dryRun=false`)
6. Post — `post_trade_to_x` / shell X helper when configured
7. Repeat on `intervalMs`

Fee defaults: `minNotionalUsd=25`, `minEdgeBps=40`, `takeProfitPct=3`, `stopLossPct=2.5`, `addOnlyDipBps=50`, `maxActionsPerPass=2`.

## Policies

| Policy | Use |
| --- | --- |
| **`core`** | Default autopilot — 70% cash, diversify stock sleeve |
| `targets` | Research override weights (include `WETH:70`) |
| `deploy` | Only when intentionally putting cash to work |
| `trim` / `dry_powder` / `max_name` | Manual risk controls |

## Engines (B)

- **Preferred:** Uniswap v4 UniversalRouter → PoolManager (ETH↔stock)
- **Fallback:** V3 SwapRouter02 (incl. WETH→USDG hops)

## Universe

`data/assets.json` — full Robinhood Chain stock-token list. Autopilot trades only the **allowlist** in settings (default mega-caps).

## Rules

- Never `place_*` on Rail A for TBA management.
- Never send TBA proceeds to the owner EOA.
- **Buys spend TBA WETH/ETH** — fund the TBA wallet from `get_broker`; owner should not attach call value when TBA can fund.
- Prefer hold over fee-negative micro-rebalances; Live shows `agent.skip` / `agent.fee` with cost vs edge.
- Prefer `core` + small `deployPct` when unattended.
- Activation clears on transfer; liquid contents are removable until sale.
- Not financial advice; stock tokens are geo-restricted.
