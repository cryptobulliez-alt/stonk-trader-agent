import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getActivationMath,
  getBrokersSummary,
  getStockTokens,
  makePublicClient,
} from "../brokerReads.js";
import { prepareActivateBroker, prepareBrokerTrade } from "../brokerPrepare.js";
import { loadConfig, loadXConfig } from "../config.js";
import { CONTRACTS } from "../contracts.js";
import {
  analyzeBrokerPortfolio,
  preparePortfolioPlan,
  type ManagePolicy,
} from "../portfolioManage.js";
import { executeTrade, formatTradeTweet } from "../swap.js";
import { connectBroker } from "../tba.js";
import { postTextToX, postTradeToX } from "../twitter.js";

function jsonResult(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }, null, 2) }],
    isError: true,
  };
}

/**
 * StonkBrokers-only MCP for Robinhood Chain.
 * Reads are live on-chain. prepare_* returns UNSIGNED calldata only — this server never holds keys.
 * Optional execute_* / post_* use local .env credentials when present.
 */
export function createStonkBrokerMcpServer(): McpServer {
  const server = new McpServer({
    name: "stonk-trader",
    version: "1.0.0",
  });

  const client = () => makePublicClient();

  server.tool(
    "get_contracts",
    "Canonical StonkBrokers + Uniswap V3 addresses on Robinhood Chain (chainId 4663).",
    {},
    async () => jsonResult({ ok: true, chainId: 4663, contracts: CONTRACTS }),
  );

  server.tool(
    "get_brokers",
    "StonkBrokers collection state from chain: minted supply, activation census + tier prices/weights, StockBooster round/pending ETH, dividend stock list. null means unknown.",
    {},
    async () => {
      try {
        return jsonResult(await getBrokersSummary(client()));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    "get_broker",
    "One StonkBroker (1-4444): owner, TBA, holdings with USD weights, StockBooster dividends, on-chain art, activation, and default portfolio actions. Activation clears on transfer; contents are removable until sale.",
    { id: z.number().int().min(1).max(4444).describe("Broker token id 1-4444") },
    async ({ id }) => {
      try {
        return jsonResult(await analyzeBrokerPortfolio(client(), id));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  const manageShape = {
    id: z.number().int().min(1).max(4444),
    policy: z
      .enum(["core", "equal_weight", "deploy", "targets", "trim", "dry_powder", "max_name"])
      .optional()
      .describe(
        "core (default: keep ~70% WETH, trim profits, sleeve rest), equal_weight, deploy, targets, trim, dry_powder, max_name",
      ),
    trimSymbol: z.string().optional().describe("For trim policy"),
    trimPct: z.number().min(1).max(100).optional().describe("Default 10"),
    targetWethPct: z.number().min(0).max(100).optional().describe("dry_powder target, default 20"),
    maxNamePct: z.number().min(1).max(100).optional().describe("max_name cap, default 40"),
    reserveWethPct: z
      .number()
      .min(0)
      .max(100)
      .optional()
      .describe("Min % WETH to keep (default 70)"),
    deployPct: z
      .number()
      .min(1)
      .max(100)
      .optional()
      .describe("Max % of book to deploy in one pass (default 15)"),
    symbols: z
      .array(z.string())
      .optional()
      .describe("Buy universe override, e.g. [\"NVDA\",\"AAPL\"] — must have WETH pools"),
    targets: z
      .union([z.string(), z.record(z.string(), z.number())])
      .optional()
      .describe('Research target weights, e.g. "NVDA:45,AAPL:40,WETH:15" or {"NVDA":45}'),
    thesis: z.string().optional().describe("Short reason from Robinhood research (logged on actions)"),
  };

  server.tool(
    "analyze_broker_portfolio",
    "Manage TBA for profit-seeking agents. Default policy `core`: keep ~70% WETH, trim stock profits into cash, sleeve the rest; buys only above reserve. Pair with Robinhood/X research + thesis. Not a profit guarantee.",
    manageShape,
    async (args) => {
      try {
        return jsonResult(
          await analyzeBrokerPortfolio(client(), args.id, {
            policy: args.policy as ManagePolicy | undefined,
            trimSymbol: args.trimSymbol,
            trimPct: args.trimPct,
            targetWethPct: args.targetWethPct,
            maxNamePct: args.maxNamePct,
            reserveWethPct: args.reserveWethPct,
            deployPct: args.deployPct,
            symbols: args.symbols,
            targets: args.targets,
            thesis: args.thesis,
          }),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    "prepare_portfolio_rebalance",
    "VERIFICATION-GATED: analyze then build unsigned TBA swaps (sells before buys). from must be ownerOf. Sign approveFirst then swap per item. WETH→stock buys stay in TBA. Not financial advice.",
    {
      ...manageShape,
      from: z.string().describe("NFT owner EOA"),
      maxActions: z.number().int().min(1).max(8).optional(),
      slippageBps: z.number().int().min(1).max(5000).optional(),
    },
    async (args) => {
      try {
        return jsonResult(await preparePortfolioPlan(client(), args));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    "get_stock_tokens",
    "Tokenized stocks a broker TBA can trade: addresses from StockBooster plus live Uniswap V3 WETH pool fee tiers. Fee tiers differ per stock — do not guess.",
    {},
    async () => {
      try {
        return jsonResult(await getStockTokens(client()));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    "get_broker_activation_math",
    "Decision facts for activating/upgrading a broker: fee (live quoteActivation when id given), weight share after join. Facts not advice — drop rate varies with AMM volume.",
    {
      id: z.number().int().min(1).max(4444).optional().describe("Broker id for exact upgrade quote"),
      tier: z.number().int().min(1).max(5).optional().describe("Tier 1-5; omit for all"),
    },
    async ({ id, tier }) => {
      try {
        return jsonResult(await getActivationMath(client(), { id, tier }));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    "prepare_activate_broker",
    "VERIFICATION-GATED: build UNSIGNED approve+activate txs for a StonkBroker dividend tier. Errors with no calldata if live quote/allowance reads fail. Sign approveFirst first when present. Never send a private key here.",
    {
      id: z.number().int().min(1).max(4444),
      tier: z.number().int().min(1).max(5),
      from: z.string().describe("EOA that pays $STONKBROKER and owns the NFT"),
    },
    async ({ id, tier, from }) => {
      try {
        return jsonResult(await prepareActivateBroker(client(), { id, tier, from }));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    "prepare_broker_trade",
    "VERIFICATION-GATED: UNSIGNED TBA txs. Prefers Uniswap v4 UniversalRouter→PoolManager (ETH↔stock, same as live bots); falls back to V3 SwapRouter02. May return steps: unwrapWeth / approvePermit2 / permit2Approve / swap / wrapEth. Output stays in TBA.",
    {
      id: z.number().int().min(1).max(4444),
      from: z.string().describe("REQUIRED: current NFT owner (verified against ownerOf)"),
      tokenIn: z.string().describe("Symbol or address (e.g. NVDA, WETH)"),
      tokenOut: z.string().describe("Symbol or address"),
      amountIn: z.string().describe("Human-readable sell amount"),
      fee: z.number().int().optional().describe("Prefer this Uniswap fee tier (100/500/3000/10000)"),
      slippageBps: z.number().int().min(1).max(5000).optional().describe("Default 100 = 1%"),
      minAmountOut: z.string().optional().describe("Explicit floor; skips spot quote when set"),
    },
    async (args) => {
      try {
        return jsonResult(await prepareBrokerTrade(client(), args));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    "execute_broker_trade_0x",
    "Optional local executor: quote+broadcast a stock-token swap via 0x RFQ through the TBA using PRIVATE_KEY from env. Honors DRY_RUN. Prefer prepare_broker_trade for unsigned agent flows.",
    {
      sell: z.string(),
      buy: z.string(),
      amount: z.string(),
      tweet: z.boolean().optional().describe("Also post to X when credentials exist"),
    },
    async ({ sell, buy, amount, tweet }) => {
      try {
        const config = loadConfig();
        const session = await connectBroker(config);
        const trade = await executeTrade(session, { sell, buy, amount });
        let x: unknown = null;
        if (tweet) {
          x = await postTradeToX(config, trade, session.tokenId);
        }
        return jsonResult({
          ok: true,
          trade,
          tweetPreview: formatTradeTweet(trade, session.tokenId),
          x,
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    "post_trade_to_x",
    "Post a trade summary to X using local X_* OAuth credentials. Dry-run when DRY_RUN=true. Use after Robinhood Agentic fills (rail A) or onchain TBA fills (rail B).",
    {
      text: z.string().min(1).max(280).describe("Tweet body"),
    },
    async ({ text }) => {
      try {
        const config = loadXConfig();
        const result = await postTextToX(config, text);
        return jsonResult({ ok: true, result });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    "format_brokerage_trade_tweet",
    "Format a Robinhood Agentic (official MCP) fill into a tweet, then optionally post it. Does not place orders — call after place_* succeeds on robinhood-trading.",
    {
      side: z.enum(["buy", "sell"]),
      symbol: z.string().describe("Ticker, e.g. AAPL"),
      quantity: z.string().describe("Shares / contracts filled"),
      price: z.string().optional().describe("Fill price if known"),
      orderId: z.string().optional(),
      note: z.string().optional(),
      post: z.boolean().optional().describe("If true, post immediately via X_* creds"),
    },
    async ({ side, symbol, quantity, price, orderId, note, post }) => {
      try {
        const lines = [
          "Robinhood Agentic",
          `${side.toUpperCase()} ${quantity} ${symbol.toUpperCase()}${price ? ` @ ${price}` : ""}`,
        ];
        if (orderId) lines.push(`order ${orderId}`);
        if (note) lines.push(note);
        const text = lines.join("\n").slice(0, 280);
        if (!post) return jsonResult({ ok: true, text, posted: false });
        const result = await postTextToX(loadXConfig(), text);
        return jsonResult({ ok: true, text, posted: true, result });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  return server;
}
