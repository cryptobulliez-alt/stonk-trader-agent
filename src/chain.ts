import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Account,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { CHAIN_ID, EXPLORER_URL } from "./config.js";

export const robinhoodChain = defineChain({
  id: CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.mainnet.chain.robinhood.com"] },
  },
  blockExplorers: {
    default: { name: "Blockscout", url: EXPLORER_URL },
  },
  contracts: {
    multicall3: {
      address: "0xcA11bde05977b3631167028862bE2a173976CA11",
      blockCreated: 1,
    },
  },
});

export function createClients(rpcUrl: string, account: Account): Clients {
  const transport = http(rpcUrl, {
    fetchOptions: {
      headers: {
        "User-Agent": "stonk-trader/1.0",
      },
    },
  });

  const publicClient = createPublicClient({
    chain: robinhoodChain,
    transport,
  });

  const walletClient = createWalletClient({
    account,
    chain: robinhoodChain,
    transport,
  });

  return { publicClient, walletClient, account };
}

export type Clients = {
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: Account;
};

export function txUrl(hash: Hex): string {
  return `${EXPLORER_URL}/tx/${hash}`;
}

export function addressUrl(address: string): string {
  return `${EXPLORER_URL}/address/${address}`;
}
