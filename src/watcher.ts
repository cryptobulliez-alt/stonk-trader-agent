import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  formatUnits,
  getAddress,
  parseAbiItem,
  type Address,
  type Hex,
  type Log,
} from "viem";
import { STOCK_TOKENS, TOKEN_DECIMALS, EXPLORER_URL } from "./config.js";
import { postTextToX } from "./twitter.js";
import type { BrokerSession } from "./tba.js";

const STATE_DIR = path.resolve(".stonk-trader");
const STATE_FILE = path.join(STATE_DIR, "watch-state.json");

const transferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

type WatchState = {
  lastBlock: string;
  postedTx: string[];
};

type TransferHit = {
  token: Address;
  symbol: string;
  direction: "in" | "out";
  amount: string;
  counterparty: Address;
  txHash: Hex;
  blockNumber: bigint;
};

function symbolFor(address: Address): string {
  const known = Object.entries(STOCK_TOKENS).find(
    ([, a]) => a.toLowerCase() === address.toLowerCase(),
  );
  return known?.[0] ?? `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function decimalsFor(address: Address): number {
  const known = Object.entries(STOCK_TOKENS).find(
    ([, a]) => a.toLowerCase() === address.toLowerCase(),
  );
  return known ? (TOKEN_DECIMALS[known[0]] ?? 18) : 18;
}

async function loadState(): Promise<WatchState> {
  try {
    const raw = await readFile(STATE_FILE, "utf8");
    return JSON.parse(raw) as WatchState;
  } catch {
    return { lastBlock: "0", postedTx: [] };
  }
}

async function saveState(state: WatchState): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

function toHit(
  log: Log & {
    args: { from?: Address; to?: Address; value?: bigint };
  },
  direction: "in" | "out",
): TransferHit | null {
  if (!log.transactionHash || log.blockNumber === null || log.blockNumber === undefined) {
    return null;
  }
  const { from, to, value } = log.args;
  if (!from || !to || value === undefined) return null;
  const token = getAddress(log.address);
  return {
    token,
    symbol: symbolFor(token),
    direction,
    amount: formatUnits(value, decimalsFor(token)),
    counterparty: direction === "out" ? to : from,
    txHash: log.transactionHash,
    blockNumber: log.blockNumber,
  };
}

function groupTrades(hits: TransferHit[]): Map<string, TransferHit[]> {
  const byTx = new Map<string, TransferHit[]>();
  for (const hit of hits) {
    const key = hit.txHash.toLowerCase();
    const list = byTx.get(key) ?? [];
    list.push(hit);
    byTx.set(key, list);
  }
  return byTx;
}

function tweetFromTransfers(tokenId: bigint, transfers: TransferHit[]): string {
  const outs = transfers.filter((t) => t.direction === "out");
  const ins = transfers.filter((t) => t.direction === "in");
  const txHash = transfers[0]!.txHash;

  if (outs.length && ins.length) {
    const sold = outs.map((t) => `${t.amount} ${t.symbol}`).join(" + ");
    const bought = ins.map((t) => `${t.amount} ${t.symbol}`).join(" + ");
    return [
      `StonkBroker #${tokenId}`,
      `Traded ${sold} → ${bought}`,
      "Robinhood Chain · stock tokens",
      `${EXPLORER_URL}/tx/${txHash}`,
    ].join("\n");
  }

  const t = transfers[0]!;
  const verb = t.direction === "out" ? "Sent" : "Received";
  return [
    `StonkBroker #${tokenId}`,
    `${verb} ${t.amount} ${t.symbol}`,
    "Robinhood Chain · stock tokens",
    `${EXPLORER_URL}/tx/${txHash}`,
  ].join("\n");
}

/**
 * Poll ERC-20 Transfer logs involving the TBA and post each new trade to X.
 */
export async function watchAndPost(session: BrokerSession): Promise<void> {
  const tokens = Object.values(STOCK_TOKENS).map((a) => getAddress(a));
  const state = await loadState();
  const latest = await session.clients.publicClient.getBlockNumber();
  let fromBlock =
    state.lastBlock === "0" ? latest : BigInt(state.lastBlock) + 1n;

  if (fromBlock > latest) {
    console.log("Watcher up to date.");
    return;
  }

  const maxRange = 2_000n;
  if (latest - fromBlock > maxRange) {
    fromBlock = latest - maxRange;
  }

  console.log(`Scanning blocks ${fromBlock} → ${latest} for TBA ${session.tba}`);

  const [outLogs, inLogs] = await Promise.all([
    session.clients.publicClient.getLogs({
      address: tokens,
      event: transferEvent,
      args: { from: session.tba },
      fromBlock,
      toBlock: latest,
    }),
    session.clients.publicClient.getLogs({
      address: tokens,
      event: transferEvent,
      args: { to: session.tba },
      fromBlock,
      toBlock: latest,
    }),
  ]);

  const hits: TransferHit[] = [];
  for (const log of outLogs) {
    const hit = toHit(log, "out");
    if (hit) hits.push(hit);
  }
  for (const log of inLogs) {
    const hit = toHit(log, "in");
    if (hit) hits.push(hit);
  }

  const byTx = groupTrades(hits);
  const posted = new Set(state.postedTx.map((h) => h.toLowerCase()));

  for (const [txHash, transfers] of byTx) {
    if (posted.has(txHash)) continue;
    const text = tweetFromTransfers(session.tokenId, transfers);
    console.log(`\nNew TBA activity:\n${text}\n`);

    const result = await postTextToX(session.config, text);
    if ("skipped" in result) {
      console.log(result.skipped);
    } else {
      console.log(`Posted to X: https://x.com/i/status/${result.id}`);
    }
    posted.add(txHash);
  }

  await saveState({
    lastBlock: latest.toString(),
    postedTx: [...posted].slice(-500),
  });
}

export async function runWatcherLoop(session: BrokerSession): Promise<void> {
  console.log(
    `Watching StonkBroker #${session.tokenId} TBA ${session.tba} every ${session.config.watchPollMs}ms`,
  );
  for (;;) {
    try {
      await watchAndPost(session);
    } catch (err) {
      console.error("Watcher poll failed:", err);
    }
    await new Promise((r) => setTimeout(r, session.config.watchPollMs));
  }
}
