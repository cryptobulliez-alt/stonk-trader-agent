import { formatEther, type Address, type Hex, type Hash } from "viem";
import type { BrokerSession } from "../tba.js";
import { txUrl } from "../chain.js";
import { emitEvent } from "./events.js";

type StepTx = {
  to: string;
  data: string;
  value?: string;
  what?: string;
  step?: string;
};

export type ExecutedStep = {
  what: string;
  hash: Hash;
  dryRun: boolean;
  valueWei: string;
  valueEth: number;
  gasUsed?: string;
  effectiveGasPriceWei?: string;
  gasFeeWei?: string;
  gasFeeEth?: number;
};

/**
 * Broadcast prepared TBA executeCall steps (already owner→TBA encoded).
 * Honors session.config.dryRun via simulate-only when dry.
 * Live txs include receipt gas fee + native value.
 */
export async function executePreparedSteps(
  session: BrokerSession,
  steps: StepTx[],
): Promise<ExecutedStep[]> {
  const results: ExecutedStep[] = [];
  for (const step of steps) {
    const what = step.what ?? step.step ?? "step";
    emitEvent("agent.signing", what, { step: step.step });

    const to = step.to as Address;
    const data = step.data as Hex;
    const value = BigInt(step.value ?? "0");
    const valueEth = Number(formatEther(value));

    if (session.config.dryRun) {
      await session.clients.publicClient.call({
        to,
        data,
        value,
        account: session.clients.account,
      });
      results.push({
        what,
        hash: "0xdryrun" as Hash,
        dryRun: true,
        valueWei: value.toString(),
        valueEth,
      });
      emitEvent("agent.dry_run", `[dry-run] ${what}`);
      continue;
    }

    // eth_call first so bad minOut / route reverts don't burn gas after approve
    try {
      await session.clients.publicClient.call({
        to,
        data,
        value,
        account: session.clients.account,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Preflight failed (${what}): ${msg.split("Details:")[0].trim()}`,
      );
    }

    const hash = await session.clients.walletClient.sendTransaction({
      to,
      data,
      value,
      account: session.clients.account,
      chain: session.clients.walletClient.chain,
    });
    const receipt = await session.clients.publicClient.waitForTransactionReceipt({
      hash,
    });
    const gasUsed = receipt.gasUsed;
    const effectiveGasPrice = receipt.effectiveGasPrice ?? 0n;
    const gasFeeWei = gasUsed * effectiveGasPrice;
    const gasFeeEth = Number(formatEther(gasFeeWei));

    results.push({
      what,
      hash,
      dryRun: false,
      valueWei: value.toString(),
      valueEth,
      gasUsed: gasUsed.toString(),
      effectiveGasPriceWei: effectiveGasPrice.toString(),
      gasFeeWei: gasFeeWei.toString(),
      gasFeeEth,
    });
    emitEvent(
      "agent.tx",
      `${what} — ${txUrl(hash)} · gas ${gasFeeEth.toFixed(6)} ETH`,
      { hash, what, gasFeeEth, valueEth },
    );
  }
  return results;
}
