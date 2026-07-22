#!/usr/bin/env node
import { Command } from "commander";
import {
  cmdConnect,
  cmdManage,
  cmdPortfolio,
  cmdTrade,
  cmdWatch,
} from "./agent.js";
import { STOCK_TOKENS, STONKBROKERS_ADDRESS } from "./config.js";
import type { ManagePolicy } from "./portfolioManage.js";

const program = new Command();

program
  .name("stonk-trader")
  .description(
    "Connect a StonkBroker token-bound wallet to an onchain trading agent on Robinhood Chain, swap stock tokens via 0x, and auto-post trades to X.",
  )
  .version("1.0.0");

program
  .command("connect")
  .description("Resolve the StonkBroker TBA and verify NFT ownership")
  .action(async () => {
    await cmdConnect();
  });

program
  .command("portfolio")
  .description("Show stock-token balances in the broker TBA")
  .action(async () => {
    await cmdPortfolio();
  });

program
  .command("trade")
  .description("Swap stock tokens through the TBA using 0x RFQ on Robinhood Chain")
  .requiredOption("--sell <token>", `Token to sell (${Object.keys(STOCK_TOKENS).join(", ")})`)
  .requiredOption("--buy <token>", `Token to buy (${Object.keys(STOCK_TOKENS).join(", ")})`)
  .requiredOption("--amount <amount>", "Human-readable sell amount (e.g. 0.01)")
  .option("--tweet", "Post the trade to X after execution", false)
  .action(async (opts: { sell: string; buy: string; amount: string; tweet: boolean }) => {
    await cmdTrade(
      { sell: opts.sell, buy: opts.buy, amount: opts.amount },
      { tweet: opts.tweet },
    );
  });

program
  .command("watch")
  .description("Watch TBA token transfers and auto-post every trade to X")
  .option("--once", "Scan once and exit", false)
  .action(async (opts: { once: boolean }) => {
    await cmdWatch(opts.once);
  });

program
  .command("manage")
  .description("Analyze TBA portfolio — buy + sell actions (no broadcast)")
  .option(
    "--policy <policy>",
    "core | equal_weight | deploy | targets | trim | dry_powder | max_name",
    "core",
  )
  .option("--symbol <symbol>", "trim target symbol")
  .option("--pct <pct>", "trim percent", "10")
  .option("--target-weth <pct>", "dry_powder WETH target %", "20")
  .option("--max-name <pct>", "max_name cap %", "40")
  .option("--reserve-weth <pct>", "min % WETH to keep (default 30)", "30")
  .option("--deploy-pct <pct>", "max % of book to deploy per pass (default 15)", "15")
  .option("--symbols <list>", "buy universe, e.g. NVDA,AAPL,TSLA")
  .option("--targets <weights>", 'e.g. "NVDA:45,AAPL:40,WETH:15"')
  .option("--thesis <text>", "short research reason")
  .action(
    async (opts: {
      policy: string;
      symbol?: string;
      pct: string;
      targetWeth: string;
      maxName: string;
      reserveWeth: string;
      deployPct: string;
      symbols?: string;
      targets?: string;
      thesis?: string;
    }) => {
      await cmdManage({
        policy: opts.policy as ManagePolicy,
        trimSymbol: opts.symbol,
        trimPct: Number(opts.pct),
        targetWethPct: Number(opts.targetWeth),
        maxNamePct: Number(opts.maxName),
        reserveWethPct: Number(opts.reserveWeth),
        deployPct: Number(opts.deployPct),
        symbols: opts.symbols
          ?.split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        targets: opts.targets,
        thesis: opts.thesis,
      });
    },
  );

program
  .command("info")
  .description("Print known agent / token addresses")
  .action(() => {
    console.log(`StonkBrokers (agent NFT): ${STONKBROKERS_ADDRESS}`);
    console.log("Known tokens:");
    for (const [symbol, address] of Object.entries(STOCK_TOKENS)) {
      console.log(`  ${symbol.padEnd(6)} ${address}`);
    }
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
