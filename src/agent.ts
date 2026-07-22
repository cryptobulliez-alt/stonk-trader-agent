import { makePublicClient } from "./brokerReads.js";
import { loadConfig } from "./config.js";
import { formatPortfolio, getPortfolio } from "./portfolio.js";
import {
  analyzeBrokerPortfolio,
  type ManagePolicy,
} from "./portfolioManage.js";
import { executeTrade, formatTradeTweet, type TradeRequest } from "./swap.js";
import { connectBroker, sessionSummary, type BrokerSession } from "./tba.js";
import { postTradeToX } from "./twitter.js";
import { runWatcherLoop, watchAndPost } from "./watcher.js";

export async function boot(): Promise<BrokerSession> {
  const config = loadConfig();
  const session = await connectBroker(config);
  console.log(sessionSummary(session));
  return session;
}

export async function cmdConnect(): Promise<void> {
  await boot();
  console.log("\nAgent connected. TBA is ready to trade stock tokens via 0x RFQ.");
}

export async function cmdPortfolio(): Promise<void> {
  const session = await boot();
  const holdings = await getPortfolio(session);
  console.log("\nTBA portfolio:");
  console.log(formatPortfolio(holdings));
}

export async function cmdTrade(request: TradeRequest, opts: { tweet: boolean }): Promise<void> {
  const session = await boot();
  console.log(
    `\nQuoting ${request.amount} ${request.sell.toUpperCase()} → ${request.buy.toUpperCase()}…`,
  );

  const trade = await executeTrade(session, request);
  console.log("\n" + formatTradeTweet(trade, session.tokenId));

  if (opts.tweet) {
    const posted = await postTradeToX(session.config, trade, session.tokenId);
    if ("skipped" in posted) {
      console.log(posted.skipped);
    } else {
      console.log(`Posted to X: https://x.com/i/status/${posted.id}`);
    }
  } else {
    console.log("(tweet skipped — pass --tweet to post)");
  }
}

export async function cmdWatch(once: boolean): Promise<void> {
  const session = await boot();
  if (once) {
    await watchAndPost(session);
    return;
  }
  await runWatcherLoop(session);
}

export async function cmdManage(opts: {
  policy: ManagePolicy;
  trimSymbol?: string;
  trimPct?: number;
  targetWethPct?: number;
  maxNamePct?: number;
  reserveWethPct?: number;
  deployPct?: number;
  symbols?: string[];
  targets?: string;
  thesis?: string;
}): Promise<void> {
  const session = await boot();
  const analysis = await analyzeBrokerPortfolio(
    makePublicClient(session.config.rpcUrl),
    Number(session.tokenId),
    opts,
  );
  console.log(`\nContents ≈ $${analysis.contentsUsd} (ETH/USD ${analysis.ethUsd ?? "?"})`);
  console.log(
    `Cash (WETH+ETH) ≈ $${analysis.cashUsd ?? 0} (${analysis.cashPct ?? 0}%) — target ${analysis.targetCashPct ?? 30}%`,
  );
  console.log(`Buy universe: ${analysis.buyUniverse.join(", ") || "(none)"}`);
  console.log("Holdings:");
  for (const h of analysis.holdings) {
    console.log(
      `  ${h.symbol.padEnd(12)} ${h.amount.toFixed(6).padStart(14)}  $${(h.usd ?? 0).toFixed(2).padStart(8)}  ${(h.weightPct ?? 0).toFixed(1)}%${h.tradeableToWeth ? (h.routeFromWeth && h.routeFromWeth !== "n/a" ? `  [${h.routeFromWeth}]` : "") : "  [no route]"}`,
    );
  }
  if (analysis.fundingHint) console.log(`\n⚠ ${analysis.fundingHint}`);
  if (analysis.targets) console.log(`\nTargets: ${JSON.stringify(analysis.targets)}`);
  if (analysis.thesis) console.log(`Thesis: ${analysis.thesis}`);
  console.log(`\nPolicy: ${analysis.policy}`);
  console.log("Actions:");
  for (const a of analysis.actions) {
    if (a.action === "swap") {
      const side = (a.side ?? "?").toUpperCase();
      const usd = a.notionalUsd != null ? ` (~$${a.notionalUsd})` : "";
      console.log(
        `  ${side.padEnd(4)} ${a.amountIn} ${a.tokenIn} → ${a.tokenOut}${usd} — ${a.reason}`,
      );
    } else {
      console.log(`  HOLD — ${a.reason}`);
    }
  }
  console.log(`\n${analysis.disclaimer}`);
  console.log("Next: MCP prepare_portfolio_rebalance (sells before buys), then sign.");
}
