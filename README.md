# Stonk Trader Shell

Local, permissionless shell for a **StonkBroker ERC-6551 TBA** on Robinhood Chain.

You host it. You hold the keys. Clone → fill `.env` → open the dashboard.

UI styling matches [stonkbrokers.cash](https://www.stonkbrokers.cash/marketplace).

## What you need

1. An alt wallet that **owns 1 StonkBroker** (gas on the EOA, inventory on the TBA)
2. Optional **LLM API key** (OpenAI or Anthropic) for pass theses
3. Optional **X API** OAuth 1.0a credentials to tweet fills
4. Node.js 20+

Secrets stay in `.env` — the browser never sees private keys or API secrets.

## Quick start

```bash
git clone <this-repo>
cd stonk-trader
npm install
npm run web:install
cp .env.example .env
# fill keys — see “Configure .env” below
cp data/settings.example.json data/settings.json   # optional; auto-created on first run

npm run shell
```

Open [http://localhost:3000](http://localhost:3000) (or the next free port if 3000 is taken — the shell prints the URL).

| Process | Port | Role |
| --- | --- | --- |
| Shell API | `8788` | Status, settings, portfolio, SSE events, autopilot |
| Dashboard | `3000+` | Next.js UI (proxies `/api/*` → shell; next free port if 3000 is taken) |

Restart the shell after changing `.env` or backend code (`npm run shell`). Settings → status pills show whether **wallet / llm / x** keys loaded.

## Configure `.env`

Copy `.env.example` → `.env` and fill what you use. Only the wallet + token id are required to open the shell.

### 1. Required — broker wallet

| Variable | What |
| --- | --- |
| `PRIVATE_KEY` | Owner EOA private key (`0x…`) that **owns** the StonkBroker NFT. Pays gas; signs TBA `executeCall`. |
| `STONK_TOKEN_ID` | Your broker token id (e.g. `1`). |
| `RH_RPC_URL` | Defaults to Robinhood Chain mainnet RPC if unset. |

Fund that EOA with a little RH-chain ETH for gas, and fund the **TBA** with WETH/ETH for buys (dashboard shows TBA address after connect).

### 2. Optional — LLM thesis

Used each autopilot pass for a short thesis + preferred buys.

1. Create an API key at [OpenAI](https://platform.openai.com/api-keys) or [Anthropic](https://console.anthropic.com/).
2. Set:

```bash
LLM_API_KEY=sk-...
LLM_PROVIDER=openai          # or anthropic
# LLM_MODEL=gpt-4o-mini     # optional override
```

If `LLM_API_KEY` is empty, the shell uses the settings thesis / a default core line instead.

### 3. Optional — X (Twitter) fill posts

Autopilot can post a short update after a pass when Settings → **Post to X** is on. Needs **OAuth 1.0a user context** (not Bearer alone).

1. Go to [developer.x.com](https://developer.x.com/) → your project/app → **Keys and tokens**.
2. Create/regenerate:
   - **API Key** + **API Key Secret** (consumer)
   - **Access Token** + **Access Token Secret** (read+write for the account that should post)
3. App permissions must allow **Read and Write** (regenerate access token after changing permissions).
4. Set in `.env`:

```bash
X_API_KEY=...
X_API_SECRET=...
X_ACCESS_TOKEN=...
X_ACCESS_SECRET=...
```

Optional for X MCP read tools only:

```bash
X_BEARER_TOKEN=...
```

A `403` on post usually means wrong keys, missing write permission, or an access token minted before write was enabled — fix permissions and regenerate the access token.

### 4. Optional — other

| Variable | What |
| --- | --- |
| `DRY_RUN` | Env default (`true`). Dashboard dry-run toggle overrides while the shell runs. |
| `SLIPPAGE_BPS` | Swap slippage (default `100` = 1%). |
| `ZEROX_API_KEY` | Optional 0x RFQ path. |
| `SHELL_PORT` / `MCP_PORT` | Defaults `8788` / `8787`. |

### First live trade checklist

1. Dashboard Settings: allowlist, `reserveWethPct`, `minNotionalUsd`, `maxNotionalEth` look right.
2. Leave **Dry run: ON**, press **Once** — confirm planned `[would]` swaps (or `agent.skip` fee gates) in Live.
3. Turn **Dry run: OFF** only when you intend to broadcast.
4. Press **Once** or **Run**.

## Safety

- Dry run ON by default (prepare + log only); turn **Dry run: OFF** in the dashboard to broadcast
- Dashboard dry-run toggle writes `data/settings.json` and overrides process `DRY_RUN` for that shell session.
- **Dry run does not block X** — with Post to X on, Once/Run still tweets (labeled dry-run). Use **Settings → Test X post** to tweet without trading.
- Default policy **`core`**: ~70% WETH cash, small `deployPct` per pass
- **Fee-aware gate**: swaps skip unless expected edge beats gas+slip (`minNotionalUsd` / `minEdgeBps`); Live shows cost/EV lines
- Allowlist + `maxNotionalEth` + `maxActionsPerPass` cap how fast the agent can spend
- Not financial advice. Stock tokens are geo-restricted (not for U.S. persons).

## Dashboard

| Tab | What it shows |
| --- | --- |
| **Live** | Autopilot feed (analyze → thesis → fee gate → prepare → sign / dry-run → optional X) |
| **Portfolio** | Book + **period P&L** (first→latest history snapshot), open P&L vs cost basis, stacked value chart, per-token mark/avg cost/P&L, recent fills, planned actions |
| **Log** | Swap history with Blockscout tx links (`data/trade-log.json`) |
| **Settings** | Policy, cash reserve, fee gates (min notional / edge), take-profit / stop, allowlist, dry run, X posting, etc. |

## Local data (`data/`)

| File | Purpose |
| --- | --- |
| `settings.json` | Non-secret policy (gitignored; copy from `settings.example.json`) |
| `portfolio-history.json` | Book snapshots for the timeseries (gitignored) |
| `cost-basis.json` | Avg cost / fills for stock P&L (gitignored) |
| `trade-log.json` | Swap log + tx hashes / explorer links (gitignored) |
| `assets.json` | Stock-token universe |

Unknown stock positions are **seeded at mark** on first see (`~` in the UI) so open P&L starts flat until prices move or live fills update basis. Dry-run fills are audit-only and do not change cost basis.

## Stock universe

`data/assets.json` — 96 Robinhood Chain stock tokens (drop-in refresh from Robinhood assets dump). Cash rails: WETH + USDG. Autopilot only trades the **allowlist** in settings.

## Autopilot

Dashboard **Run / Pause / Once**:

1. Analyze TBA portfolio (`core` policy); prefer trimming winners when raising cash
2. Optional LLM thesis (uses holdings + unrealized P&L when available)
3. Prepare Uniswap v4 UniversalRouter swaps (V3 fallback)
4. Sign only when **Dry run is OFF**
5. Record live fills into cost basis; optional X post

Policy knobs live in `data/settings.json` (editable in the UI).

## MCP (optional / Cursor)

```bash
npm run mcp          # stdio
npm run mcp:http     # :8787
```

See [`AGENTS.md`](./AGENTS.md) for dual-rail notes (Robinhood research MCP vs this TBA shell).

## CLI

```bash
npm run dev -- connect
npm run dev -- manage --policy core
npm run portfolio
```

## Env reference

| Variable | Required | Purpose |
| --- | --- | --- |
| `PRIVATE_KEY` | yes | NFT owner EOA |
| `STONK_TOKEN_ID` | yes | Broker id |
| `RH_RPC_URL` | no | Robinhood Chain RPC |
| `LLM_API_KEY` / `LLM_PROVIDER` / `LLM_MODEL` | no | Pass thesis |
| `X_API_KEY` / `X_API_SECRET` / `X_ACCESS_TOKEN` / `X_ACCESS_SECRET` | no | Tweet fills (OAuth 1.0a) |
| `X_BEARER_TOKEN` | no | X MCP reads |
| `DRY_RUN` | no | Env default (`true`); dashboard override wins while shell runs |
| `SLIPPAGE_BPS` | no | Swap slippage |
| `ZEROX_API_KEY` | no | Optional 0x path |
| `SHELL_PORT` / `MCP_PORT` | no | Defaults 8788 / 8787 |
