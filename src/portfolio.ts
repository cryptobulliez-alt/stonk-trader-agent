import { formatUnits, getAddress, type Address } from "viem";
import { erc20Abi, stonkBrokersAbi } from "./abis.js";
import { STOCK_TOKENS, STONKBROKERS_ADDRESS, TOKEN_DECIMALS } from "./config.js";
import { multicallBalanceOf } from "./multicall.js";
import type { BrokerSession } from "./tba.js";

export type Holding = {
  symbol: string;
  address: Address;
  balance: bigint;
  decimals: number;
  formatted: string;
};

async function tokenMeta(
  session: BrokerSession,
  address: Address,
  fallbackSymbol: string,
): Promise<{ symbol: string; decimals: number }> {
  const known = Object.entries(STOCK_TOKENS).find(
    ([, a]) => a.toLowerCase() === address.toLowerCase(),
  );
  if (known) {
    return { symbol: known[0], decimals: TOKEN_DECIMALS[known[0]] ?? 18 };
  }

  try {
    const [symbol, decimals] = await Promise.all([
      session.clients.publicClient.readContract({
        address,
        abi: erc20Abi,
        functionName: "symbol",
      }),
      session.clients.publicClient.readContract({
        address,
        abi: erc20Abi,
        functionName: "decimals",
      }),
    ]);
    return { symbol, decimals };
  } catch {
    return { symbol: fallbackSymbol, decimals: 18 };
  }
}

export async function getPortfolio(session: BrokerSession): Promise<Holding[]> {
  const { publicClient } = session.clients;

  const seeded = await publicClient.readContract({
    address: STONKBROKERS_ADDRESS,
    abi: stonkBrokersAbi,
    functionName: "fundedToken",
    args: [session.tokenId],
  });

  const count = await publicClient.readContract({
    address: STONKBROKERS_ADDRESS,
    abi: stonkBrokersAbi,
    functionName: "stockTokenCount",
  });

  const registryTokens: Address[] = [];
  for (let i = 0n; i < count; i++) {
    registryTokens.push(
      await publicClient.readContract({
        address: STONKBROKERS_ADDRESS,
        abi: stonkBrokersAbi,
        functionName: "stockTokenAt",
        args: [i],
      }),
    );
  }

  const candidates = new Map<string, Address>();
  for (const [symbol, address] of Object.entries(STOCK_TOKENS)) {
    candidates.set(address.toLowerCase(), getAddress(address));
    void symbol;
  }
  for (const address of registryTokens) {
    candidates.set(address.toLowerCase(), getAddress(address));
  }
  if (seeded && seeded !== "0x0000000000000000000000000000000000000000") {
    candidates.set(seeded.toLowerCase(), getAddress(seeded));
  }

  const ethBalance = await publicClient.getBalance({ address: session.tba });
  const holdings: Holding[] = [];

  if (ethBalance > 0n) {
    holdings.push({
      symbol: "ETH",
      address: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
      balance: ethBalance,
      decimals: 18,
      formatted: formatUnits(ethBalance, 18),
    });
  }

  const addresses = [...candidates.values()];
  const balances = await multicallBalanceOf(
    publicClient,
    session.tba,
    addresses,
  );

  for (let i = 0; i < addresses.length; i++) {
    const result = balances[i];
    if (result.status !== "success") continue;
    const balance = result.result as bigint;
    if (balance === 0n) continue;
    const address = addresses[i];
    const meta = await tokenMeta(session, address, address.slice(0, 8));
    holdings.push({
      symbol: meta.symbol,
      address,
      balance,
      decimals: meta.decimals,
      formatted: formatUnits(balance, meta.decimals),
    });
  }

  holdings.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return holdings;
}

export function formatPortfolio(holdings: Holding[]): string {
  if (holdings.length === 0) return "(empty wallet)";
  return holdings
    .map((h) => `  ${h.symbol.padEnd(6)} ${h.formatted}`)
    .join("\n");
}
