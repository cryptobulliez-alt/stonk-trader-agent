/**
 * Parse ERC-20 Transfer logs to recover actual fill size (never trust notional/mark estimates).
 */
import {
  formatUnits,
  getAddress,
  type Address,
  type Hash,
  type Log,
  type PublicClient,
  type TransactionReceipt,
} from "viem";

const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as const;

function topicAddress(topic: `0x${string}` | undefined): Address | null {
  if (!topic || topic.length < 66) return null;
  return getAddress(`0x${topic.slice(26)}`);
}

/** Sum Transfer amounts of `token` to `to` in a receipt. */
export function sumTokenTransfersIn(
  receipt: TransactionReceipt | { logs: Log[] },
  token: Address,
  to: Address,
): bigint {
  const tokenLc = token.toLowerCase();
  const toLc = to.toLowerCase();
  let sum = 0n;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== tokenLc) continue;
    if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
    const dest = topicAddress(log.topics[2] as `0x${string}`);
    if (!dest || dest.toLowerCase() !== toLc) continue;
    sum += BigInt(log.data);
  }
  return sum;
}

export async function actualTokenInFromTx(args: {
  client: PublicClient;
  hash: Hash;
  token: Address;
  recipient: Address;
  decimals: number;
}): Promise<{ raw: bigint; human: number } | null> {
  try {
    const receipt = await args.client.getTransactionReceipt({ hash: args.hash });
    if (receipt.status !== "success") return null;
    const raw = sumTokenTransfersIn(receipt, args.token, args.recipient);
    if (raw <= 0n) return null;
    return {
      raw,
      human: Number(formatUnits(raw, args.decimals)),
    };
  } catch {
    return null;
  }
}

/**
 * After a buy, require received ≥ minOut (and ≥ fraction of expected).
 * Throws if the fill is a dust disaster vs what we prepared for.
 */
export function assertFillSane(args: {
  side: "buy" | "sell";
  receivedHuman: number;
  minOutHuman: number;
  expectedHuman?: number;
  symbol: string;
}): void {
  if (!(args.receivedHuman > 0)) {
    throw new Error(
      `fill verification failed: received 0 ${args.symbol} — refusing to book fill`,
    );
  }
  if (args.receivedHuman + 1e-18 < args.minOutHuman * 0.999) {
    throw new Error(
      `fill verification failed: received ${args.receivedHuman} ${args.symbol} < minOut ${args.minOutHuman}`,
    );
  }
  if (
    args.expectedHuman != null &&
    args.expectedHuman > 0 &&
    args.receivedHuman < args.expectedHuman * 0.5
  ) {
    throw new Error(
      `fill verification failed: received ${args.receivedHuman} ${args.symbol} << expected ~${args.expectedHuman} — possible wrong pool`,
    );
  }
}
