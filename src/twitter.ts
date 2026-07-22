import { TwitterApi } from "twitter-api-v2";
import type { AppConfig } from "./config.js";
import type { TradeResult } from "./swap.js";
import { formatTradeTweet } from "./swap.js";

export function createXClient(config: Pick<AppConfig, "x">) {
  if (!config.x) {
    throw new Error(
      "X credentials missing. Set X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET.",
    );
  }
  return new TwitterApi({
    appKey: config.x.apiKey,
    appSecret: config.x.apiSecret,
    accessToken: config.x.accessToken,
    accessSecret: config.x.accessSecret,
  });
}

export async function postTradeToX(
  config: AppConfig,
  trade: TradeResult,
  tokenId: bigint,
): Promise<{ id: string; text: string } | { skipped: string }> {
  if (!config.x) {
    return { skipped: "X credentials not configured — trade not posted" };
  }

  const text = formatTradeTweet(trade, tokenId);
  if (config.dryRun) {
    return { skipped: `dry-run tweet:\n${text}` };
  }

  const client = createXClient(config);
  const result = await client.v2.tweet(text);
  return { id: result.data.id, text };
}

export async function postTextToX(
  config: Pick<AppConfig, "dryRun" | "x">,
  text: string,
  opts?: { /** When true, post even if config.dryRun (shell dry-run only gates chain). */ live?: boolean },
): Promise<{ id: string; text: string } | { skipped: string }> {
  if (!config.x) {
    return { skipped: "X credentials not configured" };
  }
  // Dry-run gates on-chain txs — not X — unless caller omits live.
  const live = opts?.live !== false;
  if (config.dryRun && !live) {
    return { skipped: `dry-run tweet:\n${text}` };
  }
  const client = createXClient(config);
  const result = await client.v2.tweet(text);
  return { id: result.data.id, text };
}
