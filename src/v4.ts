/**
 * Uniswap v4 on Robinhood Chain via Universal Router → PoolManager.
 * Live bots trade stock tokens against native ETH (currency0 = address(0)).
 */
import {
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  formatUnits,
  keccak256,
  maxUint48,
  maxUint160,
  parseAbi,
  zeroAddress,
  type Address,
  type PublicClient,
} from "viem";

export const V4 = {
  poolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951" as Address,
  universalRouter: "0x8876789976dEcBfCbBbe364623C63652db8C0904" as Address,
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address,
  stateView: "0xF3334192D15450CdD385c8B70e03f9A6bD9E673b" as Address,
  quoter: "0x628c00B016415Ef530552063faE4154B0CdEb0Ac" as Address,
} as const;

/** Common ETH/stock fee tiers observed on Robinhood Chain. */
const V4_FEE_CANDIDATES = [
  { fee: 10_000, tickSpacing: 200 },
  { fee: 50_000, tickSpacing: 1_000 },
  { fee: 100, tickSpacing: 1 },
  { fee: 500, tickSpacing: 10 },
  { fee: 3_000, tickSpacing: 60 },
] as const;

const CMD_V4_SWAP = 0x10;
const ACTION_SWAP_EXACT_IN_SINGLE = 0x06;
const ACTION_SETTLE_ALL = 0x0c;
const ACTION_TAKE_ALL = 0x0f;

const stateViewAbi = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)",
]);

const quoterAbi = parseAbi([
  "function quoteExactInputSingle(((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)",
]);

export const universalRouterAbi = parseAbi([
  "function execute(bytes commands, bytes[] inputs, uint256 deadline) payable",
]);

export const permit2Abi = parseAbi([
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
  "function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
]);

export const wethAbi = parseAbi([
  "function deposit() payable",
  "function withdraw(uint256 wad)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);

export type V4PoolKey = {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
};

export type V4Pool = {
  key: V4PoolKey;
  poolId: `0x${string}`;
  liquidity: bigint;
  sqrtPriceX96: bigint;
};

function poolIdOf(key: V4PoolKey): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "address" },
        { type: "uint24" },
        { type: "int24" },
        { type: "address" },
      ],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
    ),
  );
}

/** ETH (address(0)) / ERC-20 pool key — currency0 is always native ETH. */
export function ethStockKey(
  stock: Address,
  fee: number,
  tickSpacing: number,
): V4PoolKey {
  return {
    currency0: zeroAddress,
    currency1: stock,
    fee,
    tickSpacing,
    hooks: zeroAddress,
  };
}

export async function findBestEthStockPool(
  client: PublicClient,
  stock: Address,
): Promise<V4Pool | null> {
  let best: V4Pool | null = null;
  for (const c of V4_FEE_CANDIDATES) {
    const key = ethStockKey(stock, c.fee, c.tickSpacing);
    const id = poolIdOf(key);
    try {
      const [sqrtPriceX96] = await client.readContract({
        address: V4.stateView,
        abi: stateViewAbi,
        functionName: "getSlot0",
        args: [id],
      });
      const liquidity = await client.readContract({
        address: V4.stateView,
        abi: stateViewAbi,
        functionName: "getLiquidity",
        args: [id],
      });
      if (liquidity === 0n || sqrtPriceX96 === 0n) continue;
      if (!best || liquidity > best.liquidity) {
        best = { key, poolId: id, liquidity, sqrtPriceX96 };
      }
    } catch {
      // candidate not initialized
    }
  }
  return best;
}

export async function quoteV4ExactIn(
  client: PublicClient,
  key: V4PoolKey,
  zeroForOne: boolean,
  amountIn: bigint,
): Promise<bigint> {
  if (amountIn >= 2n ** 128n) throw new Error("amountIn exceeds uint128");
  const { result } = await client.simulateContract({
    address: V4.quoter,
    abi: quoterAbi,
    functionName: "quoteExactInputSingle",
    args: [
      {
        poolKey: key,
        zeroForOne,
        exactAmount: amountIn,
        hookData: "0x",
      },
    ],
  });
  return result[0];
}

/** Build UniversalRouter.execute calldata for a single-hop v4 exact-in swap. */
export function encodeV4ExactInExecute(args: {
  key: V4PoolKey;
  zeroForOne: boolean;
  amountIn: bigint;
  amountOutMinimum: bigint;
  deadlineSec?: number;
}): { data: `0x${string}`; value: bigint; deadline: bigint } {
  const { key, zeroForOne, amountIn, amountOutMinimum } = args;
  const currencyIn = zeroForOne ? key.currency0 : key.currency1;
  const currencyOut = zeroForOne ? key.currency1 : key.currency0;

  const swapParam = encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          {
            name: "poolKey",
            type: "tuple",
            components: [
              { name: "currency0", type: "address" },
              { name: "currency1", type: "address" },
              { name: "fee", type: "uint24" },
              { name: "tickSpacing", type: "int24" },
              { name: "hooks", type: "address" },
            ],
          },
          { name: "zeroForOne", type: "bool" },
          { name: "amountIn", type: "uint128" },
          { name: "amountOutMinimum", type: "uint128" },
          { name: "hookData", type: "bytes" },
        ],
      },
    ],
    [
      {
        poolKey: key,
        zeroForOne,
        amountIn,
        amountOutMinimum,
        hookData: "0x",
      },
    ],
  );

  const settleParam = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }],
    [currencyIn, amountIn],
  );
  const takeParam = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }],
    [currencyOut, amountOutMinimum],
  );

  const actions = encodePacked(
    ["uint8", "uint8", "uint8"],
    [ACTION_SWAP_EXACT_IN_SINGLE, ACTION_SETTLE_ALL, ACTION_TAKE_ALL],
  );
  const v4Input = encodeAbiParameters(
    [{ type: "bytes" }, { type: "bytes[]" }],
    [actions, [swapParam, settleParam, takeParam]],
  );

  const commands = encodePacked(["uint8"], [CMD_V4_SWAP]);
  const deadline = BigInt(
    args.deadlineSec ?? Math.floor(Date.now() / 1000) + 20 * 60,
  );
  const data = encodeFunctionData({
    abi: universalRouterAbi,
    functionName: "execute",
    args: [commands, [v4Input], deadline],
  });

  // Native ETH in → forward as call value
  const value = currencyIn === zeroAddress ? amountIn : 0n;
  return { data, value, deadline };
}

export async function needsPermit2Approval(
  client: PublicClient,
  owner: Address,
  token: Address,
  amount: bigint,
): Promise<{ erc20: boolean; permit2: boolean }> {
  if (token === zeroAddress) return { erc20: false, permit2: false };
  const erc20Allow = await client.readContract({
    address: token,
    abi: wethAbi,
    functionName: "allowance",
    args: [owner, V4.permit2],
  });
  const [p2Amount, p2Exp] = await client.readContract({
    address: V4.permit2,
    abi: permit2Abi,
    functionName: "allowance",
    args: [owner, token, V4.universalRouter],
  });
  const now = BigInt(Math.floor(Date.now() / 1000));
  const permit2Ok = p2Amount >= amount && BigInt(p2Exp) > now;
  return { erc20: erc20Allow < amount, permit2: !permit2Ok };
}

export function encodePermit2MaxApprove(token: Address): `0x${string}` {
  return encodeFunctionData({
    abi: permit2Abi,
    functionName: "approve",
    args: [token, V4.universalRouter, maxUint160, Number(maxUint48)],
  });
}

export function encodeErc20Approve(spender: Address, amount: bigint): `0x${string}` {
  return encodeFunctionData({
    abi: wethAbi,
    functionName: "approve",
    args: [spender, amount],
  });
}

export function encodeWethWithdraw(amount: bigint): `0x${string}` {
  return encodeFunctionData({
    abi: wethAbi,
    functionName: "withdraw",
    args: [amount],
  });
}

export function encodeWethDeposit(): `0x${string}` {
  return encodeFunctionData({
    abi: wethAbi,
    functionName: "deposit",
    args: [],
  });
}

export function formatV4Pool(pool: V4Pool): string {
  return `v4 ETH/${pool.key.currency1.slice(0, 8)}… fee=${pool.key.fee} tickSpacing=${pool.key.tickSpacing} liq=${formatUnits(pool.liquidity, 0)}`;
}
