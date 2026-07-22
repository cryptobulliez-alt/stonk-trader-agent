import {
  type Address,
  type PublicClient,
} from "viem";
import { erc20Abi } from "./abis.js";

/** Canonical Multicall3 on Robinhood Chain (and most EVM nets). */
export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as Address;

/**
 * Batch ERC-20 balanceOf reads. Passes multicallAddress explicitly so it works
 * even if the chain config was loaded without contracts.multicall3 (stale process).
 * Falls back to chunked parallel eth_calls if multicall fails.
 */
export async function multicallBalanceOf(
  client: PublicClient,
  owner: Address,
  tokens: Address[],
): Promise<Array<{ status: "success"; result: bigint } | { status: "failure" }>> {
  if (!tokens.length) return [];

  try {
    const results = await client.multicall({
      allowFailure: true,
      multicallAddress: MULTICALL3,
      contracts: tokens.map((address) => ({
        address,
        abi: erc20Abi,
        functionName: "balanceOf" as const,
        args: [owner] as const,
      })),
    });
    return results.map((r) =>
      r.status === "success"
        ? { status: "success" as const, result: r.result as bigint }
        : { status: "failure" as const },
    );
  } catch {
    // Fallback: parallel eth_call in chunks
    const out: Array<
      { status: "success"; result: bigint } | { status: "failure" }
    > = [];
    const chunkSize = 20;
    for (let i = 0; i < tokens.length; i += chunkSize) {
      const chunk = tokens.slice(i, i + chunkSize);
      const part = await Promise.all(
        chunk.map(async (address) => {
          try {
            const result = await client.readContract({
              address,
              abi: erc20Abi,
              functionName: "balanceOf",
              args: [owner],
            });
            return { status: "success" as const, result };
          } catch {
            return { status: "failure" as const };
          }
        }),
      );
      out.push(...part);
    }
    return out;
  }
}
