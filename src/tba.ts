import {
  type Address,
  type Hash,
  type Hex,
  encodeFunctionData,
  getAddress,
  zeroAddress,
} from "viem";
import { erc20Abi, stonkBrokersAbi, tbaAbi } from "./abis.js";
import { STONKBROKERS_ADDRESS, type AppConfig, ownerAccount } from "./config.js";
import { createClients, txUrl, type Clients } from "./chain.js";

export type BrokerSession = {
  config: AppConfig;
  clients: Clients;
  tokenId: bigint;
  nftOwner: Address;
  tba: Address;
};

type BrokerIdentityCache = {
  tokenId: string;
  tba: Address;
  nftOwner: Address;
  at: number;
};

let brokerIdentityCache: BrokerIdentityCache | null = null;
const BROKER_IDENTITY_TTL_MS = 60_000;

export async function connectBroker(config: AppConfig): Promise<BrokerSession> {
  const account = ownerAccount(config.privateKey);
  const clients = createClients(config.rpcUrl, account);
  const tokenKey = String(config.tokenId);

  let tba: Address;
  let nftOwner: Address;

  if (
    brokerIdentityCache &&
    brokerIdentityCache.tokenId === tokenKey &&
    Date.now() - brokerIdentityCache.at < BROKER_IDENTITY_TTL_MS
  ) {
    tba = brokerIdentityCache.tba;
    nftOwner = brokerIdentityCache.nftOwner;
  } else {
    const [tbaRaw, ownerRaw] = await Promise.all([
      clients.publicClient.readContract({
        address: STONKBROKERS_ADDRESS,
        abi: stonkBrokersAbi,
        functionName: "tokenWallet",
        args: [config.tokenId],
      }),
      clients.publicClient.readContract({
        address: STONKBROKERS_ADDRESS,
        abi: stonkBrokersAbi,
        functionName: "ownerOf",
        args: [config.tokenId],
      }),
    ]);
    tba = getAddress(tbaRaw);
    nftOwner = getAddress(ownerRaw);
    brokerIdentityCache = {
      tokenId: tokenKey,
      tba,
      nftOwner,
      at: Date.now(),
    };
  }

  if (tba === zeroAddress) {
    throw new Error(
      `No TBA found for StonkBroker #${config.tokenId}. Confirm the token exists on ${STONKBROKERS_ADDRESS}.`,
    );
  }

  if (getAddress(nftOwner) !== getAddress(account.address)) {
    throw new Error(
      `PRIVATE_KEY wallet ${account.address} does not own StonkBroker #${config.tokenId} (owner is ${nftOwner}).`,
    );
  }

  const tbaOwner = await clients.publicClient.readContract({
    address: tba,
    abi: tbaAbi,
    functionName: "owner",
  });

  if (getAddress(tbaOwner) !== getAddress(account.address)) {
    throw new Error(
      `TBA ${tba} reports owner ${tbaOwner}, expected ${account.address}.`,
    );
  }

  return {
    config,
    clients,
    tokenId: config.tokenId,
    nftOwner: getAddress(nftOwner),
    tba,
  };
}

/** NFT owner pays gas; TBA holds assets and executes the inner call. */
export async function tbaExecute(
  session: BrokerSession,
  to: Address,
  data: Hex,
  value: bigint = 0n,
): Promise<{ hash: Hash; dryRun: boolean }> {
  const { clients, tba, config } = session;

  if (config.dryRun) {
    await clients.publicClient.simulateContract({
      address: tba,
      abi: tbaAbi,
      functionName: "executeCall",
      args: [to, value, data],
      account: clients.account,
      value,
    });
    return { hash: "0xdryrun" as Hash, dryRun: true };
  }

  const hash = await clients.walletClient.writeContract({
    address: tba,
    abi: tbaAbi,
    functionName: "executeCall",
    args: [to, value, data],
    account: clients.account,
    chain: clients.walletClient.chain,
    value,
  });

  await clients.publicClient.waitForTransactionReceipt({ hash });
  return { hash, dryRun: false };
}

export async function ensureAllowance(
  session: BrokerSession,
  token: Address,
  spender: Address,
  amount: bigint,
): Promise<Hash | null> {
  const allowance = await session.clients.publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [session.tba, spender],
  });

  if (allowance >= amount) return null;

  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: "approve",
    args: [spender, amount],
  });

  const { hash } = await tbaExecute(session, token, data);
  console.log(
    session.config.dryRun
      ? `[dry-run] Would approve ${spender} on ${token}`
      : `Approved ${spender}: ${txUrl(hash)}`,
  );
  return hash;
}

export function sessionSummary(session: BrokerSession): string {
  return [
    `StonkBroker #${session.tokenId}`,
    `Collection (agent): ${STONKBROKERS_ADDRESS}`,
    `NFT owner:          ${session.nftOwner}`,
    `Token-bound wallet: ${session.tba}`,
    `Mode:               ${session.config.dryRun ? "DRY RUN" : "LIVE"}`,
  ].join("\n");
}
