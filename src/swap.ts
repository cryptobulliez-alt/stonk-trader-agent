import {
  encodeFunctionData,
  formatUnits,
  getAddress,
  parseUnits,
  type Address,
  type Hash,
  type Hex,
} from "viem";
import { resolveToken, ZEROX_API_URL, type AppConfig } from "./config.js";
import { txUrl } from "./chain.js";
import { ensureAllowance, tbaExecute, type BrokerSession } from "./tba.js";

export type TradeRequest = {
  sell: string;
  buy: string;
  amount: string;
};

export type TradeResult = {
  sellSymbol: string;
  buySymbol: string;
  sellAmount: string;
  buyAmount: string;
  sellToken: Address;
  buyToken: Address;
  txHash: Hash;
  dryRun: boolean;
  explorerUrl: string;
  quote: ZeroXQuote;
};

type ZeroXQuote = {
  transaction: {
    to: Address;
    data: Hex;
    value: string;
    gas?: string;
    gasPrice?: string;
  };
  buyAmount: string;
  sellAmount: string;
  allowanceTarget?: Address;
  issues?: {
    allowance?: { actual: string; spender: Address } | null;
  };
  route?: unknown;
};

async function fetchQuote(
  config: AppConfig,
  params: {
    sellToken: Address;
    buyToken: Address;
    sellAmount: bigint;
    taker: Address;
    slippageBps: number;
  },
): Promise<ZeroXQuote> {
  if (!config.zeroXApiKey) {
    throw new Error("ZEROX_API_KEY is required for quotes and swaps (https://dashboard.0x.org)");
  }

  const query = new URLSearchParams({
    chainId: "4663",
    sellToken: params.sellToken,
    buyToken: params.buyToken,
    sellAmount: params.sellAmount.toString(),
    taker: params.taker,
    slippageBps: String(params.slippageBps),
  });

  const res = await fetch(
    `${ZEROX_API_URL}/swap/allowance-holder/quote?${query}`,
    {
      headers: {
        "0x-api-key": config.zeroXApiKey,
        "0x-version": "v2",
        Accept: "application/json",
      },
    },
  );

  const body = (await res.json()) as ZeroXQuote & { reason?: string; message?: string; name?: string };
  if (!res.ok) {
    throw new Error(
      `0x quote failed (${res.status}): ${body.reason || body.message || body.name || JSON.stringify(body)}`,
    );
  }
  if (!body.transaction?.to || !body.transaction?.data) {
    throw new Error(`Unexpected 0x quote shape: ${JSON.stringify(body)}`);
  }
  return body;
}

function spenderFromQuote(quote: ZeroXQuote): Address {
  const fromIssues = quote.issues?.allowance?.spender;
  if (fromIssues) return getAddress(fromIssues);
  if (quote.allowanceTarget) return getAddress(quote.allowanceTarget);
  return getAddress(quote.transaction.to);
}

export async function executeTrade(
  session: BrokerSession,
  request: TradeRequest,
): Promise<TradeResult> {
  const sell = resolveToken(request.sell);
  const buy = resolveToken(request.buy);
  if (sell.address.toLowerCase() === buy.address.toLowerCase()) {
    throw new Error("sell and buy tokens must differ");
  }

  const sellAmount = parseUnits(request.amount, sell.decimals);
  if (sellAmount <= 0n) throw new Error("amount must be > 0");

  const quote = await fetchQuote(session.config, {
    sellToken: sell.address,
    buyToken: buy.address,
    sellAmount,
    taker: session.tba,
    slippageBps: session.config.slippageBps,
  });

  const spender = spenderFromQuote(quote);
  await ensureAllowance(session, sell.address, spender, sellAmount);

  const value = BigInt(quote.transaction.value || "0");
  const { hash, dryRun } = await tbaExecute(
    session,
    getAddress(quote.transaction.to),
    quote.transaction.data,
    value,
  );

  const buyAmount = formatUnits(BigInt(quote.buyAmount), buy.decimals);

  return {
    sellSymbol: sell.symbol,
    buySymbol: buy.symbol,
    sellAmount: request.amount,
    buyAmount,
    sellToken: sell.address,
    buyToken: buy.address,
    txHash: hash,
    dryRun,
    explorerUrl: dryRun ? "(dry-run — not broadcast)" : txUrl(hash),
    quote,
  };
}

export function formatTradeTweet(trade: TradeResult, tokenId: bigint): string {
  return formatStonkSwapTweet({
    tokenId,
    fromAmount: trade.sellAmount,
    fromSymbol: trade.sellSymbol,
    toAmount: trade.buyAmount,
    toSymbol: trade.buySymbol,
    txUrl: trade.dryRun ? null : trade.explorerUrl,
    dryRun: trade.dryRun,
  });
}

/** Canonical StonkTraderBot X fill template (≤280 chars). */
export function formatStonkSwapTweet(args: {
  tokenId: string | number | bigint;
  fromAmount: string;
  fromSymbol: string;
  toAmount: string;
  toSymbol: string;
  txUrl?: string | null;
  dryRun?: boolean;
}): string {
  const fromAmt = trimTweetAmt(args.fromAmount);
  const toAmt = trimTweetAmt(args.toAmount);
  const fromSym = args.fromSymbol.toUpperCase();
  const toSym = args.toSymbol.toUpperCase();
  const lines = [
    `StonkBroker #${args.tokenId} swapped ${fromAmt}`,
    `${fromSym} to ${toAmt} ${toSym} on Robinhood Chain using his StonkTraderBot Agent!`,
    "",
  ];
  if (args.dryRun) {
    lines.push("(dry-run — not broadcast)");
  } else if (args.txUrl) {
    lines.push(args.txUrl);
  }
  lines.push("", "$STONKBROKER  @realstonkbroker @cryptobullyznft");
  return lines.join("\n").slice(0, 280);
}

function trimTweetAmt(raw: string): string {
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  if (Math.abs(n) >= 1000) return n.toFixed(2);
  if (Math.abs(n) >= 1) return n.toPrecision(6).replace(/\.?0+$/, "");
  return n.toPrecision(4).replace(/\.?0+$/, "");
}

/** Encode a raw ERC-20 transfer through the TBA (escape hatch / withdrawals). */
export function encodeErc20Transfer(to: Address, amount: bigint): Hex {
  return encodeFunctionData({
    abi: [
      {
        type: "function",
        name: "transfer",
        stateMutability: "nonpayable",
        inputs: [
          { name: "to", type: "address" },
          { name: "amount", type: "uint256" },
        ],
        outputs: [{ type: "bool" }],
      },
    ] as const,
    functionName: "transfer",
    args: [to, amount],
  });
}
