import {
  encodeFunctionData,
  formatUnits,
  getAddress,
  isAddress,
  parseUnits,
  type Address,
  type PublicClient,
} from "viem";
import { erc20Abi, tbaAbi } from "./abis.js";
import {
  getBroker,
  resolveTradeToken,
  unsignedTx,
  type UnsignedTx,
} from "./brokerReads.js";

function requireAddress(label: string, value: string | undefined): Address {
  if (!value || !isAddress(value)) {
    throw new Error(`${label} must be a 0x-prefixed 40-hex address`);
  }
  return getAddress(value);
}

function tbaExecuteCall(
  tba: Address,
  to: Address,
  data: `0x${string}`,
  value = 0n,
) {
  return encodeFunctionData({
    abi: tbaAbi,
    functionName: "executeCall",
    args: [to, value, data],
  });
}

export type PrepareTbaTransferArgs = {
  id: number;
  /** Current NFT owner (verified against ownerOf). */
  from: string;
  /** Symbol or address: ETH, WETH, NVDA, … */
  token: string;
  /** Human amount, or "max" / "all" for full balance. */
  amount: string;
  /** Destination wallet. */
  to: string;
  /**
   * Allow sending to the NFT owner EOA.
   * Default false — trading doctrine forbids TBA→owner as a trade path;
   * this is an explicit inventory-removal override.
   */
  allowOwner?: boolean;
};

export type PrepareTbaTransferResult = {
  ok: true;
  engine: "tba-transfer";
  steps: UnsignedTx[];
  signOrder: string;
  fundedBy: "tba";
  brokerId: number;
  tba: Address;
  recipient: Address;
  token: string;
  tokenAddress: Address | null;
  amount: string;
  amountRaw: string;
  toOwner: boolean;
  warning?: string;
};

/**
 * Escape hatch: prepare UNSIGNED owner→TBA txs that send TBA ETH or ERC-20
 * inventory to an external wallet. Not wired into autopilot.
 */
export async function prepareTbaTransfer(
  client: PublicClient,
  args: PrepareTbaTransferArgs,
): Promise<PrepareTbaTransferResult> {
  if (!(args.id >= 1 && args.id <= 4444)) {
    throw new Error("id must be 1-4444");
  }
  const from = requireAddress("from", args.from);
  const to = requireAddress("to", args.to);
  const broker = await getBroker(client, args.id);
  const tba = getAddress(broker.wallet);

  if (from !== getAddress(broker.owner)) {
    throw new Error(
      `from ${from} does not match ownerOf StonkBroker #${args.id} (${broker.owner})`,
    );
  }
  if (to === tba) {
    throw new Error("to must not be the TBA itself");
  }

  const toOwner = to === from;
  if (toOwner && !args.allowOwner) {
    throw new Error(
      "Refusing TBA → owner EOA (trading doctrine). Pass allowOwner=true for explicit inventory removal.",
    );
  }

  const resolved = resolveTradeToken(args.token);
  const amountKey = args.amount.trim().toLowerCase();
  const wantMax = amountKey === "max" || amountKey === "all";

  let amountRaw: bigint;
  let decimals: number;
  let tokenAddress: Address | null;
  let step: UnsignedTx;

  if (resolved.symbol === "ETH") {
    decimals = 18;
    tokenAddress = null;
    const bal = BigInt(broker.ethBalanceRaw);
    amountRaw = wantMax ? bal : parseUnits(args.amount.trim(), decimals);
    if (amountRaw <= 0n) throw new Error("amount must be > 0");
    if (amountRaw > bal) {
      throw new Error(
        `TBA ETH balance ${formatUnits(bal, 18)} < requested ${formatUnits(amountRaw, 18)}`,
      );
    }
    step = unsignedTx(
      tba,
      tbaExecuteCall(tba, to, "0x", amountRaw),
      {
        what: `TBA send ${formatUnits(amountRaw, 18)} ETH → ${to}`,
        step: "transferEth",
        brokerId: args.id,
        tba,
        recipient: to,
        token: "ETH",
        amount: formatUnits(amountRaw, 18),
        amountRaw: amountRaw.toString(),
        signAs: from,
        verified: {
          owner: "from matches ownerOf",
          balance: `TBA holds >= ${formatUnits(amountRaw, 18)} ETH`,
        },
      },
    );
  } else {
    decimals = resolved.decimals;
    tokenAddress = resolved.address;
    const holding = broker.holdings.find(
      (h) => getAddress(h.token) === tokenAddress,
    );
    let bal: bigint;
    if (holding) {
      bal = BigInt(holding.amountRaw);
      decimals = holding.decimals;
    } else {
      bal = await client.readContract({
        address: tokenAddress,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [tba],
      });
    }
    amountRaw = wantMax ? bal : parseUnits(args.amount.trim(), decimals);
    if (amountRaw <= 0n) throw new Error("amount must be > 0");
    if (amountRaw > bal) {
      throw new Error(
        `TBA ${resolved.symbol} balance ${formatUnits(bal, decimals)} < requested ${formatUnits(amountRaw, decimals)}`,
      );
    }

    const transferData = encodeFunctionData({
      abi: tbaAbi,
      functionName: "executeTokenTransfer",
      args: [tokenAddress, to, amountRaw],
    });

    step = unsignedTx(tba, transferData, {
      what: `TBA send ${formatUnits(amountRaw, decimals)} ${resolved.symbol} → ${to}`,
      step: "transfer",
      brokerId: args.id,
      tba,
      recipient: to,
      token: resolved.symbol,
      tokenAddress,
      amount: formatUnits(amountRaw, decimals),
      amountRaw: amountRaw.toString(),
      signAs: from,
      verified: {
        owner: "from matches ownerOf",
        balance: `TBA holds >= ${formatUnits(amountRaw, decimals)} ${resolved.symbol}`,
      },
    });
  }

  const warning = toOwner
    ? "Sending TBA inventory to the owner EOA — explicit override; not a trade path."
    : undefined;

  return {
    ok: true,
    engine: "tba-transfer",
    steps: [step],
    signOrder: "Sign the transfer step (owner pays gas; assets leave the TBA).",
    fundedBy: "tba",
    brokerId: args.id,
    tba,
    recipient: to,
    token: resolved.symbol,
    tokenAddress,
    amount: formatUnits(amountRaw, decimals),
    amountRaw: amountRaw.toString(),
    toOwner,
    ...(warning ? { warning } : {}),
  };
}

export type PrepareTbaWithdrawAllArgs = {
  id: number;
  /** Current NFT owner (verified against ownerOf). Destination is always this address. */
  from: string;
};

export type PrepareTbaWithdrawAllResult = {
  ok: true;
  engine: "tba-withdraw-all";
  steps: UnsignedTx[];
  signOrder: string;
  fundedBy: "tba";
  brokerId: number;
  tba: Address;
  recipient: Address;
  items: Array<{ token: string; amount: string; amountRaw: string }>;
  warning: string;
};

/**
 * Escape hatch: prepare UNSIGNED owner→TBA txs that empty TBA ETH + ERC-20
 * inventory to the NFT owner EOA. Explicit inventory removal — not a trade path.
 */
export async function prepareTbaWithdrawAll(
  client: PublicClient,
  args: PrepareTbaWithdrawAllArgs,
): Promise<PrepareTbaWithdrawAllResult> {
  if (!(args.id >= 1 && args.id <= 4444)) {
    throw new Error("id must be 1-4444");
  }
  const from = requireAddress("from", args.from);
  const broker = await getBroker(client, args.id);
  if (from !== getAddress(broker.owner)) {
    throw new Error(
      `from ${from} does not match ownerOf StonkBroker #${args.id} (${broker.owner})`,
    );
  }

  const tokens: string[] = [];
  if (BigInt(broker.ethBalanceRaw) > 0n) tokens.push("ETH");
  for (const h of broker.holdings) {
    if (BigInt(h.amountRaw) > 0n) tokens.push(h.symbol);
  }
  if (tokens.length === 0) {
    throw new Error("TBA has nothing to withdraw");
  }

  const steps: UnsignedTx[] = [];
  const items: PrepareTbaWithdrawAllResult["items"] = [];
  for (const token of tokens) {
    const prepared = await prepareTbaTransfer(client, {
      id: args.id,
      from,
      token,
      amount: "max",
      to: from,
      allowOwner: true,
    });
    steps.push(...prepared.steps);
    items.push({
      token: prepared.token,
      amount: prepared.amount,
      amountRaw: prepared.amountRaw,
    });
  }

  return {
    ok: true,
    engine: "tba-withdraw-all",
    steps,
    signOrder: `Sign ${steps.length} transfer step(s) (owner pays gas; all TBA assets leave to EOA).`,
    fundedBy: "tba",
    brokerId: args.id,
    tba: getAddress(broker.wallet),
    recipient: from,
    items,
    warning:
      "Withdrawing ALL TBA inventory to the owner EOA — explicit override; not a trade path.",
  };
}
