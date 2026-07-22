import {
  encodeFunctionData,
  formatUnits,
  getAddress,
  isAddress,
  maxUint256,
  parseUnits,
  type Address,
  type PublicClient,
} from "viem";
import { erc20Abi, tbaAbi } from "./abis.js";
import {
  encodeV3Path,
  findTradeRoute,
  getBroker,
  quoteTradeRoute,
  resolveTradeToken,
  unsignedTx,
  v3RouteFeeBps,
  type UnsignedTx,
} from "./brokerReads.js";
import { WETH } from "./config.js";
import { CONTRACTS, activationAbi, swapRouterAbi } from "./contracts.js";
import {
  encodeErc20Approve,
  encodePermit2MaxApprove,
  encodeV4ExactInExecute,
  encodeWethDeposit,
  encodeWethWithdraw,
  findBestEthStockPool,
  formatV4Pool,
  needsPermit2Approval,
  quoteV4ExactIn,
  V4,
} from "./v4.js";
import {
  checkSwapQuoteVsMark,
  minOutFromExecutableQuote,
  MAX_EXEC_VS_MARK_BPS,
} from "./swapSanity.js";
import {
  formatVenueProbes,
  normalizeSwapVenue,
  selectEthStockVenue,
  type SwapVenuePref,
} from "./swapVenue.js";
import { loadSettings } from "./shell/settings.js";

function requireAddress(label: string, value: string | undefined): Address {
  if (!value || !isAddress(value)) {
    throw new Error(`${label} must be a 0x-prefixed 40-hex address`);
  }
  return getAddress(value);
}

function tbaExecute(tba: Address, to: Address, data: `0x${string}`, value = 0n) {
  return encodeFunctionData({
    abi: tbaAbi,
    functionName: "executeCall",
    args: [to, value, data],
  });
}

export async function prepareActivateBroker(
  client: PublicClient,
  args: { id: number; tier: number; from: string },
): Promise<Record<string, unknown>> {
  const { id, tier } = args;
  if (!(id >= 1 && id <= 4444)) throw new Error("id must be 1-4444");
  if (!(tier >= 1 && tier <= 5)) throw new Error("tier must be 1-5");
  const from = requireAddress("from", args.from);

  let feeWei: bigint;
  try {
    feeWei = await client.readContract({
      address: CONTRACTS.activationManager,
      abi: activationAbi,
      functionName: "quoteActivation",
      args: [BigInt(id), tier - 1],
    });
  } catch {
    throw new Error(
      "verification failed: could not quoteActivation live — no calldata returned; retry shortly",
    );
  }

  const allowed = await client.readContract({
    address: CONTRACTS.stonkbrokerToken,
    abi: erc20Abi,
    functionName: "allowance",
    args: [from, CONTRACTS.activationManager],
  });

  const activateData = encodeFunctionData({
    abi: activationAbi,
    functionName: "activate",
    args: [BigInt(id), tier - 1],
  });

  const out: Record<string, unknown> = unsignedTx(
    CONTRACTS.activationManager,
    activateData,
    {
      what: `Activate StonkBroker #${id} at tier ${tier}`,
      feeStonkbroker: Number(formatUnits(feeWei, 18)),
      feeRaw: feeWei.toString(),
      tierArgNote: `On-chain tiers are ZERO-BASED: display tier ${tier} is encoded as ${tier - 1}.`,
      verified: {
        quote: "fee quoted live from quoteActivation",
        allowance:
          allowed >= feeWei
            ? `sufficient (${formatUnits(allowed, 18)} approved)`
            : "short — sign approveFirst before this",
      },
      feeNote:
        "Paid in $STONKBROKER by the signer via transferFrom. Already-active brokers are only charged the upgrade difference. 50% of the fee is burned.",
      signAs: from,
    },
  );

  if (allowed < feeWei) {
    const approveData = encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [CONTRACTS.activationManager, feeWei],
    });
    out.approveFirst = unsignedTx(CONTRACTS.stonkbrokerToken, approveData, {
      what: `Approve ${formatUnits(feeWei, 18)} $STONKBROKER to ActivationManager`,
    });
  }

  return out;
}

/**
 * ETH/WETH ↔ stock: probe v3 and v4, pick the mark-sane venue (or force via preferVenue).
 * Other pairs: Uniswap v3 SwapRouter02 only.
 */
export async function prepareBrokerTrade(
  client: PublicClient,
  args: {
    id: number;
    from: string;
    tokenIn: string;
    tokenOut: string;
    amountIn: string;
    fee?: number;
    slippageBps?: number;
    minAmountOut?: string;
    /** auto = pick mark-sane v3/v4; v3/v4 = force that engine when viable. */
    preferVenue?: SwapVenuePref;
  },
): Promise<Record<string, unknown>> {
  const { id } = args;
  if (!(id >= 1 && id <= 4444)) throw new Error("id must be 1-4444");
  const from = requireAddress("from", args.from);
  const slippageBps = args.slippageBps ?? 100;

  const broker = await getBroker(client, id);
  if (getAddress(broker.owner) !== from) {
    throw new Error(
      `verification failed: from ${from} is not ownerOf(#${id}) (owner is ${broker.owner}). executeCall is owner-gated — no calldata returned.`,
    );
  }

  const tokenIn = resolveTradeToken(args.tokenIn);
  const tokenOut = resolveTradeToken(args.tokenOut);
  if (tokenIn.address.toLowerCase() === tokenOut.address.toLowerCase()) {
    throw new Error("tokenIn and tokenOut must differ");
  }

  const amountIn = parseUnits(args.amountIn, tokenIn.decimals);
  if (amountIn <= 0n) throw new Error("amountIn must be > 0");

  const inIsCash = ["WETH", "ETH"].includes(tokenIn.symbol);
  const outIsCash = ["WETH", "ETH"].includes(tokenOut.symbol);
  if (inIsCash !== outIsCash) {
    const settings = loadSettings();
    const prefer =
      args.preferVenue ?? normalizeSwapVenue(settings.swapVenue);
    const maxUnderBps = settings.maxExecVsMarkBps;
    const { engine, probes, pick } = await selectEthStockVenue(client, {
      tokenIn,
      tokenOut,
      amountIn,
      prefer,
      fee: args.fee,
      maxUnderBps,
    });

    const prepared =
      engine === "v4"
        ? await prepareV4Trade(client, {
            broker,
            from,
            id,
            tokenIn,
            tokenOut,
            amountIn,
            amountInHuman: args.amountIn,
            slippageBps,
            minAmountOut: args.minAmountOut,
            maxUnderBps,
          })
        : await prepareV3Trade(client, {
            broker,
            from,
            id,
            tokenIn,
            tokenOut,
            amountIn,
            amountInHuman: args.amountIn,
            fee: args.fee,
            slippageBps,
            minAmountOut: args.minAmountOut,
            maxUnderBps,
          });

    return {
      ...prepared,
      venueSelect: {
        prefer,
        picked: pick.engine,
        detail: pick.detail,
        probes: formatVenueProbes(probes),
      },
    };
  }

  return prepareV3Trade(client, {
    broker,
    from,
    id,
    tokenIn,
    tokenOut,
    amountIn,
    amountInHuman: args.amountIn,
    fee: args.fee,
    slippageBps,
    minAmountOut: args.minAmountOut,
  });
}

async function prepareV4Trade(
  client: PublicClient,
  args: {
    broker: Awaited<ReturnType<typeof getBroker>>;
    from: Address;
    id: number;
    tokenIn: { symbol: string; address: Address; decimals: number };
    tokenOut: { symbol: string; address: Address; decimals: number };
    amountIn: bigint;
    amountInHuman: string;
    slippageBps: number;
    minAmountOut?: string;
    maxUnderBps?: number;
  },
): Promise<Record<string, unknown>> {
  const { broker, tokenIn, tokenOut, amountIn, slippageBps } = args;
  const tba = broker.wallet as Address;
  const buyStock = ["WETH", "ETH"].includes(tokenIn.symbol);
  const stock = buyStock ? tokenOut : tokenIn;
  const cashSym = buyStock ? tokenIn.symbol : tokenOut.symbol;

  if (["WETH", "ETH", "USDG", "STONKBROKER"].includes(stock.symbol)) {
    throw new Error("v4 path expects a stock token on one side");
  }

  const pool = await findBestEthStockPool(client, stock.address);
  if (!pool) {
    throw new Error(`no liquid v4 ETH/${stock.symbol} pool`);
  }

  // Balance checks
  if (buyStock) {
    const ethBal = BigInt(broker.ethBalanceRaw);
    const wethHolding = broker.holdings.find(
      (h) => h.token.toLowerCase() === WETH.toLowerCase(),
    );
    const wethBal = wethHolding ? BigInt(wethHolding.amountRaw) : 0n;
    if (tokenIn.symbol === "ETH") {
      if (ethBal < amountIn) {
        throw new Error(
          `verification failed: TBA holds ${formatUnits(ethBal, 18)} ETH, need ${args.amountInHuman}`,
        );
      }
    } else {
      // WETH in — may unwrap
      if (ethBal + wethBal < amountIn) {
        throw new Error(
          `verification failed: TBA ETH+WETH ${formatUnits(ethBal + wethBal, 18)} < ${args.amountInHuman}`,
        );
      }
    }
  } else {
    const holding = broker.holdings.find(
      (h) => h.token.toLowerCase() === stock.address.toLowerCase(),
    );
    const bal = holding ? BigInt(holding.amountRaw) : 0n;
    if (bal < amountIn) {
      throw new Error(
        `verification failed: TBA holds ${holding?.amount ?? 0} ${stock.symbol}, need ${args.amountInHuman}`,
      );
    }
  }

  const zeroForOne = buyStock; // ETH→stock
  const spot = await quoteV4ExactIn(client, pool.key, zeroForOne, amountIn);
  if (spot === 0n) {
    throw new Error("verification failed: v4 quoter returned 0");
  }

  const routeFeeBps = Math.round(pool.key.fee / 100);
  const sanity = await checkSwapQuoteVsMark(client, {
    buyStock,
    stock: {
      symbol: stock.symbol,
      address: stock.address,
      decimals: stock.decimals,
    },
    amountIn,
    quotedOut: spot,
    engine: "v4",
    routeFeeBps,
    maxUnderBps: args.maxUnderBps,
  });
  if (!sanity.ok) {
    throw new Error(`verification failed: ${sanity.reason}`);
  }

  let minOut: bigint;
  if (args.minAmountOut != null && args.minAmountOut !== "") {
    minOut = parseUnits(args.minAmountOut, buyStock ? stock.decimals : 18);
  } else {
    // Executable v4 quoter only — do not raise with slot0 mark (reverts thin books).
    minOut = minOutFromExecutableQuote({ quotedOut: spot, slippageBps });
  }
  if (minOut <= 0n) {
    throw new Error("verification failed: refused zero amountOutMinimum");
  }
  if (spot < minOut) {
    throw new Error(
      `verification failed: v4 quote ${formatUnits(spot, sanity.outDecimals)} cannot meet minOut ${formatUnits(minOut, sanity.outDecimals)}`,
    );
  }

  const { data: urData, value: urValue } = encodeV4ExactInExecute({
    key: pool.key,
    zeroForOne,
    amountIn,
    amountOutMinimum: minOut,
  });

  const steps: UnsignedTx[] = [];
  const signOrder: string[] = [];

  // Buys with WETH: unwrap any shortfall of native ETH inside the TBA first.
  // Owner outer tx value stays 0 — TBA ETH (after unwrap) funds UniversalRouter.
  if (buyStock && tokenIn.symbol === "WETH") {
    const ethBal = BigInt(broker.ethBalanceRaw);
    if (ethBal < amountIn) {
      const needUnwrap = amountIn - ethBal;
      steps.push(
        unsignedTx(tba, tbaExecute(tba, WETH, encodeWethWithdraw(needUnwrap)), {
          what: `TBA unwrap ${formatUnits(needUnwrap, 18)} WETH → ETH for v4 buy`,
          step: "unwrapWeth",
          fundedBy: "tba",
        }),
      );
      signOrder.push("unwrapWeth");
    }
  }

  // Sells: Permit2 allowances so UniversalRouter can SETTLE the stock
  if (!buyStock) {
    const need = await needsPermit2Approval(client, tba, stock.address, amountIn);
    if (need.erc20) {
      steps.push(
        unsignedTx(
          tba,
          tbaExecute(tba, stock.address, encodeErc20Approve(V4.permit2, maxUint256)),
          {
            what: `TBA approve Permit2 for ${stock.symbol}`,
            step: "approvePermit2",
          },
        ),
      );
      signOrder.push("approvePermit2");
    }
    if (need.permit2) {
      steps.push(
        unsignedTx(
          tba,
          tbaExecute(tba, V4.permit2, encodePermit2MaxApprove(stock.address)),
          {
            what: `TBA Permit2.approve ${stock.symbol} → UniversalRouter`,
            step: "permit2Approve",
          },
        ),
      );
      signOrder.push("permit2Approve");
    }
  }

  const swapTx = unsignedTx(
    tba,
    tbaExecute(tba, V4.universalRouter, urData, urValue),
    {
      what: `TBA → UniversalRouter v4 ${args.amountInHuman} ${tokenIn.symbol} → ${tokenOut.symbol}`,
      step: "swap",
      brokerId: args.id,
      tba,
      recipient: tba,
      router: V4.universalRouter,
      poolManager: V4.poolManager,
      route: formatV4Pool(pool),
      tokenIn: tokenIn.symbol,
      tokenOut: tokenOut.symbol,
      amountIn: args.amountInHuman,
      amountOutMinimum: formatUnits(minOut, buyStock ? stock.decimals : 18),
      amountOutMinimumRaw: minOut.toString(),
      expectedAmountOut: formatUnits(spot, buyStock ? stock.decimals : 18),
      fairAmountOut: sanity.fairOutHuman.toPrecision(8),
      markUsd: sanity.markUsd,
      markSource: sanity.markSource,
      quoteVsMarkBps: sanity.vsMarkBps,
      slippageBps,
      /** Inner executeCall value (TBA → router). Outer owner msg.value is 0. */
      callValue: urValue.toString(),
      fundedBy: buyStock ? "tba" : "n/a",
      signAs: args.from,
      verified: {
        owner: "from matches ownerOf",
        engine: "UniversalRouter V4_SWAP → PoolManager",
        pool: formatV4Pool(pool),
        priceFloor: `v4 quoter − slip; refuse prepare if >${(args.maxUnderBps ?? MAX_EXEC_VS_MARK_BPS) / 100}% under mark (wrong-pool dust)`,
        quoteVsMarkBps: sanity.vsMarkBps,
        funding: buyStock
          ? "TBA native ETH (unwrap WETH first if needed); EOA pays gas only"
          : "ERC-20 settle via Permit2",
      },
    },
    0n,
  );
  steps.push(swapTx);
  signOrder.push("swap");

  // Sells requesting WETH: wrap native ETH proceeds after fill (use minOut as safe wrap)
  if (!buyStock && cashSym === "WETH") {
    steps.push(
      unsignedTx(
        tba,
        tbaExecute(tba, WETH, encodeWethDeposit(), minOut),
        {
          what: `TBA wrap ≥${formatUnits(minOut, 18)} ETH → WETH (use actual ETH bal if higher)`,
          step: "wrapEth",
          note: "After swap, re-read TBA ETH and wrap the full balance if it exceeds minOut",
        },
      ),
    );
    signOrder.push("wrapEth");
  }

  return {
    ok: true,
    engine: "v4-universal-router",
    steps,
    swap: swapTx,
    fundedBy: buyStock ? "tba" : "n/a",
    approveFirst: steps.length > 1 ? steps[0] : undefined,
    signOrder: `Sign in order: ${signOrder.join(" → ")}. Output stays in TBA.`,
    route: formatV4Pool(pool),
    amountOutMinimum: formatUnits(minOut, buyStock ? stock.decimals : 18),
    amountOutMinimumRaw: minOut.toString(),
    expectedAmountOut: formatUnits(spot, buyStock ? stock.decimals : 18),
    fairAmountOut: sanity.fairOutHuman.toPrecision(8),
    markUsd: sanity.markUsd,
    markSource: sanity.markSource,
    quoteVsMarkBps: sanity.vsMarkBps,
  };
}

async function prepareV3Trade(
  client: PublicClient,
  args: {
    broker: Awaited<ReturnType<typeof getBroker>>;
    from: Address;
    id: number;
    tokenIn: { symbol: string; address: Address; decimals: number };
    tokenOut: { symbol: string; address: Address; decimals: number };
    amountIn: bigint;
    amountInHuman: string;
    fee?: number;
    slippageBps: number;
    minAmountOut?: string;
    maxUnderBps?: number;
  },
): Promise<Record<string, unknown>> {
  const { broker, tokenIn, tokenOut, amountIn, slippageBps } = args;
  const tba = broker.wallet as Address;

  const holding = broker.holdings.find(
    (h) => h.token.toLowerCase() === tokenIn.address.toLowerCase(),
  );
  const bal = holding ? BigInt(holding.amountRaw) : 0n;
  if (bal < amountIn && tokenIn.symbol !== "ETH") {
    throw new Error(
      `verification failed: TBA ${tba} holds ${holding?.amount ?? 0} ${tokenIn.symbol}, need ${args.amountInHuman}. Trades spend the broker wallet, not the owner EOA.`,
    );
  }

  const v3In =
    tokenIn.symbol === "ETH" || tokenIn.symbol === "WETH"
      ? WETH
      : tokenIn.address;
  const v3Out =
    tokenOut.symbol === "ETH" || tokenOut.symbol === "WETH"
      ? WETH
      : tokenOut.address;
  const route = await findTradeRoute(client, v3In, v3Out, args.fee);
  if (!route) {
    throw new Error(
      `verification failed: no liquid Uniswap V3 or v4 route for ${tokenIn.symbol}→${tokenOut.symbol}. Call get_stock_tokens.`,
    );
  }
  if (tokenIn.symbol === "ETH") {
    throw new Error(
      "verification failed: v3 SwapRouter02 needs WETH (not native ETH) — use v4 or wrap first",
    );
  }

  const routeFeeBps = v3RouteFeeBps(route);
  let minOut: bigint;
  let spotOut: bigint;
  let sanityNote: Record<string, unknown> = {};
  if (args.minAmountOut != null && args.minAmountOut !== "") {
    minOut = parseUnits(args.minAmountOut, tokenOut.decimals);
    spotOut = minOut;
  } else {
    spotOut = await quoteTradeRoute(client, route, v3In, v3Out, amountIn);
    if (spotOut === 0n) {
      throw new Error(
        "verification failed: V3 QuoterV2 returned zero — pass explicit minAmountOut or retry",
      );
    }

    const buyStock = ["WETH", "ETH"].includes(tokenIn.symbol);
    const sellStock = ["WETH", "ETH"].includes(tokenOut.symbol);
    if (buyStock || sellStock) {
      const stock = buyStock ? tokenOut : tokenIn;
      const sanity = await checkSwapQuoteVsMark(client, {
        buyStock,
        stock: {
          symbol: stock.symbol,
          address: stock.address,
          decimals: stock.decimals,
        },
        amountIn,
        quotedOut: spotOut,
        engine: route.kind === "direct" ? "v3" : "v3-multihop",
        routeFeeBps,
        maxUnderBps: args.maxUnderBps,
      });
      if (!sanity.ok) {
        throw new Error(`verification failed: ${sanity.reason}`);
      }
      // QuoterV2 executable out − slip only (slot0 mark floors caused USO reverts).
      minOut = minOutFromExecutableQuote({
        quotedOut: spotOut,
        slippageBps,
      });
      if (spotOut < minOut) {
        throw new Error(
          `verification failed: v3 QuoterV2 out below minOut after slippage`,
        );
      }
      sanityNote = {
        fairAmountOut: sanity.fairOutHuman.toPrecision(8),
        markUsd: sanity.markUsd,
        markSource: sanity.markSource,
        quoteVsMarkBps: sanity.vsMarkBps,
        routeFeeBps,
        quoteSource: "QuoterV2",
      };
    } else {
      minOut = minOutFromExecutableQuote({
        quotedOut: spotOut,
        slippageBps,
      });
    }
  }
  if (minOut <= 0n) {
    throw new Error(
      "verification failed: refused to build a swap with no price floor (amountOutMinimum would be 0)",
    );
  }

  let swapData: `0x${string}`;
  let routeNote: string;
  if (route.kind === "direct") {
    swapData = encodeFunctionData({
      abi: swapRouterAbi,
      functionName: "exactInputSingle",
      args: [
        {
          tokenIn: tokenIn.address,
          tokenOut: tokenOut.address,
          fee: route.fee,
          recipient: tba,
          amountIn,
          amountOutMinimum: minOut,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
    routeNote = `v3 direct pool ${route.pool} fee=${route.fee}`;
  } else {
    const path = encodeV3Path(route, v3In, v3Out);
    swapData = encodeFunctionData({
      abi: swapRouterAbi,
      functionName: "exactInput",
      args: [
        {
          path,
          recipient: tba,
          amountIn,
          amountOutMinimum: minOut,
        },
      ],
    });
    routeNote = `v3 multi-hop via ${route.midSymbol} fees ${route.feeIn}/${route.feeOut}`;
  }

  const executeSwapData = tbaExecute(tba, CONTRACTS.swapRouter02, swapData);
  const allowance = await client.readContract({
    address: tokenIn.address,
    abi: erc20Abi,
    functionName: "allowance",
    args: [tba, CONTRACTS.swapRouter02],
  });

  const swapTx: UnsignedTx = unsignedTx(tba, executeSwapData, {
    what: `TBA executeCall → Uniswap V3 ${args.amountInHuman} ${tokenIn.symbol} → ${tokenOut.symbol}`,
    brokerId: args.id,
    tba,
    recipient: tba,
    tokenIn: tokenIn.symbol,
    tokenOut: tokenOut.symbol,
    amountIn: args.amountInHuman,
    amountOutMinimum: formatUnits(minOut, tokenOut.decimals),
    amountOutMinimumRaw: minOut.toString(),
    expectedAmountOut: formatUnits(spotOut, tokenOut.decimals),
    ...sanityNote,
    route: routeNote,
    routeDetail: route,
    slippageBps,
    signAs: args.from,
    verified: {
      owner: "from matches ownerOf",
      balance: `TBA holds >= ${args.amountInHuman} ${tokenIn.symbol}`,
      route: routeNote,
      priceFloor:
        Object.keys(sanityNote).length > 0
          ? `QuoterV2 − slip; refuse prepare if >${(args.maxUnderBps ?? MAX_EXEC_VS_MARK_BPS) / 100}% under mark (wrong-pool dust)`
          : "amountOutMinimum from QuoterV2 − slippage",
    },
  });

  const result: Record<string, unknown> = {
    ok: true,
    engine: "v3-swap-router02",
    swap: swapTx,
    steps: [swapTx] as UnsignedTx[],
    signOrder: "Sign approveFirst (if any), then swap. Output stays in TBA.",
  };

  if (allowance < amountIn) {
    const approveInner = encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [CONTRACTS.swapRouter02, amountIn],
    });
    result.approveFirst = unsignedTx(
      tba,
      tbaExecute(tba, tokenIn.address, approveInner),
      {
        what: `TBA executeCall → approve router for ${args.amountInHuman} ${tokenIn.symbol}`,
        signOrder: "Sign approveFirst, wait for confirmation, then sign swap",
      },
    );
    result.steps = [result.approveFirst, swapTx];
  }

  return result;
}
