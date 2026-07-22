import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { formatEther } from "viem";
import { stonkBrokersAbi } from "../abis.js";
import { listStockAssets } from "../assets.js";
import { getVenueForSymbol, loadVenueMap, venueBadge } from "../venueMap.js";
import { makePublicClient } from "../brokerReads.js";
import { getXAccount, postTextToX, type XAccountInfo } from "../twitter.js";
import { formatStonkSwapTweet } from "../swap.js";
import { loadConfig, loadEnvStatus, ownerAccount, STONKBROKERS_ADDRESS } from "../config.js";
import {
  analyzeBrokerPortfolio,
  fetchBrokerArt,
} from "../portfolioManage.js";
import { connectBroker } from "../tba.js";
import {
  getAutopilotSchedule,
  pauseAutopilot,
  resumeAutopilot,
  runOnce,
  startAutopilot,
  stopAutopilot,
} from "./autopilot.js";
import {
  getRecentEvents,
  snapshotRuntime,
  subscribe,
  type ShellEvent,
} from "./events.js";
import {
  getHistory,
  recordSnapshot,
  seriesKeys,
} from "./history.js";
import {
  enrichHoldings,
  getLedger,
} from "./ledger.js";
import { getLlmConnection, type LlmConnection } from "./llm.js";
import { loadSettings, saveSettings, type ShellSettings } from "./settings.js";
import {
  backfillTradeFees,
  importTbaTradesFromExplorer,
  listTrades,
  tradeTotals,
} from "./tradeLog.js";
import { getEthUsd } from "../prices.js";
import { evaluateEoaGasReserve, type EoaGasWarn } from "./tradeEconomics.js";

const PORT = Number(process.env.SHELL_PORT || 8788);

let xAccountCache: { at: number; account: XAccountInfo | null } | null = null;
const X_ACCOUNT_TTL_MS = 5 * 60_000;

let llmConnectionCache: { at: number; connection: LlmConnection } | null = null;
const LLM_CONNECTION_TTL_MS = 5 * 60_000;

async function loadLlmConnectionCached(): Promise<LlmConnection> {
  if (
    llmConnectionCache &&
    Date.now() - llmConnectionCache.at < LLM_CONNECTION_TTL_MS
  ) {
    // Refresh currentModel from settings without re-listing
    const connection = {
      ...llmConnectionCache.connection,
      currentModel: (() => {
        const cfg = loadConfig();
        const fromSettings = loadSettings().llmModel?.trim();
        if (fromSettings) return fromSettings;
        if (cfg.llmModel?.trim()) return cfg.llmModel.trim();
        return llmConnectionCache.connection.defaultModel;
      })(),
    };
    return connection;
  }
  const connection = await getLlmConnection(loadConfig());
  llmConnectionCache = { at: Date.now(), connection };
  return connection;
}

async function loadXAccountCached(): Promise<XAccountInfo | null> {
  const env = loadEnvStatus();
  if (!env.hasX) return null;
  if (xAccountCache && Date.now() - xAccountCache.at < X_ACCOUNT_TTL_MS) {
    return xAccountCache.account;
  }
  try {
    const account = await getXAccount(loadConfig());
    xAccountCache = { at: Date.now(), account };
    return account;
  } catch {
    xAccountCache = { at: Date.now(), account: null };
    return null;
  }
}

type BalancesSnap = {
  eoa: string;
  eoaEth: number;
  tba: string | null;
  tbaEth: number | null;
  ethUsd: number | null;
  at: number;
  eoaGasWarn: EoaGasWarn | null;
};

let balancesCache: BalancesSnap | null = null;
const BALANCES_TTL_MS = 30_000;

/** Short-lived TBA cache so status + portfolio don't each re-call tokenWallet. */
let tbaCache: { tokenId: string; tba: string; at: number } | null = null;
const TBA_TTL_MS = 60_000;

async function resolveTbaCached(
  client: ReturnType<typeof makePublicClient>,
  tokenId: bigint,
): Promise<string | null> {
  const key = String(tokenId);
  if (
    tbaCache &&
    tbaCache.tokenId === key &&
    Date.now() - tbaCache.at < TBA_TTL_MS
  ) {
    return tbaCache.tba;
  }
  const tbaRaw = await client.readContract({
    address: STONKBROKERS_ADDRESS,
    abi: stonkBrokersAbi,
    functionName: "tokenWallet",
    args: [tokenId],
  });
  const tba = String(tbaRaw);
  if (!tba || tba === "0x0000000000000000000000000000000000000000") {
    return null;
  }
  tbaCache = { tokenId: key, tba, at: Date.now() };
  return tba;
}

async function loadBalances(): Promise<BalancesSnap | null> {
  const now = Date.now();
  if (balancesCache && now - balancesCache.at < BALANCES_TTL_MS) {
    return balancesCache;
  }
  try {
    const config = loadConfig();
    const account = ownerAccount(config.privateKey);
    const client = makePublicClient(config.rpcUrl);
    const eoaBal = await client.getBalance({ address: account.address });

    let tba: string | null = null;
    let tbaEth: number | null = null;
    try {
      tba = await resolveTbaCached(client, config.tokenId);
      if (tba) {
        const tbaBal = await client.getBalance({
          address: tba as `0x${string}`,
        });
        tbaEth = +Number(formatEther(tbaBal)).toFixed(6);
      }
    } catch {
      /* TBA optional */
    }

    const ethUsd = await getEthUsd(client).catch(() => null);
    const eoaEth = +Number(formatEther(eoaBal)).toFixed(6);
    const settings = loadSettings();
    const eoaGasWarn = evaluateEoaGasReserve({
      eoaEth,
      ethUsd,
      maxActionsPerPass: settings.maxActionsPerPass,
      gasEthPerStep: settings.estimateGasEth,
      tokenId: String(config.tokenId),
    });
    balancesCache = {
      eoa: account.address,
      eoaEth,
      tba,
      tbaEth,
      ethUsd: ethUsd != null ? +ethUsd.toFixed(2) : null,
      at: now,
      eoaGasWarn,
    };
    return balancesCache;
  } catch (err) {
    console.error(
      "[shell] loadBalances failed:",
      err instanceof Error ? err.message : err,
    );
    return balancesCache;
  }
}

/** Don't let balance RPC hang the status endpoint. */
async function loadBalancesBounded(ms = 4_000): Promise<BalancesSnap | null> {
  return await Promise.race([
    loadBalances(),
    new Promise<BalancesSnap | null>((resolve) =>
      setTimeout(() => resolve(balancesCache), ms),
    ),
  ]);
}

function cors(res: ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function json(res: ServerResponse, status: number, body: unknown) {
  cors(res);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  const path = url.pathname;
  const method = req.method ?? "GET";

  if (method === "OPTIONS") {
    cors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    if (method === "GET" && path === "/api/health") {
      json(res, 200, { ok: true });
      return;
    }

    if (method === "GET" && path === "/api/status") {
      const env = loadEnvStatus();
      const settings = loadSettings();
      const runtime = snapshotRuntime();
      const schedule = getAutopilotSchedule();
      const balances = await loadBalancesBounded();
      const lastError =
        runtime.lastError && runtime.lastError.length > 280
          ? `${runtime.lastError.slice(0, 280)}…`
          : runtime.lastError;
      json(res, 200, {
        ok: true,
        env: {
          hasPrivateKey: env.hasPrivateKey,
          hasTokenId: env.hasTokenId,
          hasLlm: env.hasLlm,
          hasX: env.hasX,
          dryRun: env.dryRun,
          llmProvider: env.llmProvider,
          tokenId: env.tokenId,
          // never return secrets
        },
        settings,
        agent: {
          state: runtime.state,
          running: runtime.running,
          lastThesis: runtime.lastThesis,
          lastError,
          nextPassAt: schedule.nextPassAt,
          passInFlight: schedule.passInFlight,
        },
        balances,
        events: runtime.events,
        canBroadcast: !settings.dryRun,
        shellUrl: `http://127.0.0.1:${PORT}`,
      });
      return;
    }

    if (method === "GET" && path === "/api/settings") {
      json(res, 200, { ok: true, settings: loadSettings() });
      return;
    }

    if (method === "POST" && path === "/api/settings") {
      const raw = await readBody(req);
      const patch = JSON.parse(raw || "{}") as Partial<ShellSettings>;
      const settings = saveSettings(patch);
      balancesCache = null; // refresh eoa gas reserve vs new maxActions / estimateGasEth
      // Current model may have changed — keep list cache, refresh on next /api/llm/me
      if (llmConnectionCache) {
        llmConnectionCache = {
          ...llmConnectionCache,
          connection: {
            ...llmConnectionCache.connection,
            currentModel:
              settings.llmModel?.trim() ||
              llmConnectionCache.connection.currentModel,
          },
        };
      }
      json(res, 200, { ok: true, settings });
      return;
    }

    if (method === "GET" && path === "/api/events") {
      // SSE — connect from the browser to this host:port directly (Next rewrites break SSE)
      cors(res);
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(`data: ${JSON.stringify({ id: "hello", ts: Date.now(), type: "agent.hello", message: "SSE connected" })}\n\n`);
      for (const ev of getRecentEvents(40)) {
        res.write(`data: ${JSON.stringify(ev)}\n\n`);
      }
      const unsub = subscribe((ev: ShellEvent) => {
        try {
          res.write(`data: ${JSON.stringify(ev)}\n\n`);
        } catch {
          /* client gone */
        }
      });
      const heartbeat = setInterval(() => {
        try {
          res.write(`: ping ${Date.now()}\n\n`);
        } catch {
          clearInterval(heartbeat);
        }
      }, 15_000);
      const cleanup = () => {
        clearInterval(heartbeat);
        unsub();
      };
      req.on("close", cleanup);
      req.on("error", cleanup);
      return;
    }

    if (method === "GET" && path === "/api/events/recent") {
      json(res, 200, { ok: true, events: getRecentEvents(100) });
      return;
    }

    if (method === "GET" && path === "/api/assets") {
      const venueMap = loadVenueMap();
      json(res, 200, {
        ok: true,
        count: listStockAssets().length,
        venueMap: venueMap
          ? {
              scannedAt: venueMap.scannedAt,
              tradeable: venueMap.tradeable,
              total: venueMap.total,
              v3Only: venueMap.v3Only,
              v4Only: venueMap.v4Only,
              both: venueMap.both,
              none: venueMap.none,
            }
          : null,
        assets: listStockAssets().map((a) => {
          const venue = getVenueForSymbol(a.symbol);
          const badge = venueBadge(venue);
          return {
            symbol: a.symbol,
            name: a.name,
            address: a.address,
            logoUrl: a.logoUrl,
            tradable: a.tradable,
            onChainTradeable: badge.tradeableOnChain,
            venue: badge.label,
            preferredVenue: venue?.preferred ?? null,
            v3: venue?.v3?.ok ?? null,
            v4: venue?.v4?.ok ?? null,
          };
        }),
      });
      return;
    }

    if (method === "GET" && path === "/api/broker") {
      const config = loadConfig();
      const session = await connectBroker(config);
      const art = await fetchBrokerArt(
        makePublicClient(config.rpcUrl),
        Number(session.tokenId),
      );
      json(res, 200, {
        ok: true,
        broker: {
          tokenId: String(session.tokenId),
          owner: session.nftOwner,
          tba: session.tba,
          name: art.name,
          image: art.image,
          attributes: art.attributes,
        },
      });
      return;
    }

    if (method === "GET" && path === "/api/portfolio") {
      const config = loadConfig();
      const session = await connectBroker(config);
      const settings = loadSettings();
      const tokenId = String(session.tokenId);
      const analysis = await analyzeBrokerPortfolio(
        makePublicClient(config.rpcUrl),
        Number(session.tokenId),
        {
          policy: settings.policy,
          reserveWethPct: settings.reserveWethPct,
          deployPct: settings.deployPct,
          symbols: settings.allowlist,
        },
      );
      // Seed / reconcile cost basis from marks, then attach P&L fields
      const holdings = enrichHoldings(tokenId, analysis.holdings, analysis.ethUsd);
      const ledger = getLedger(tokenId);

      recordSnapshot({
        tokenId,
        holdings: [
          ...holdings.map((h) => ({
            symbol: h.symbol,
            usd: h.usd,
          })),
          ...(analysis.ethBalanceUsd != null && analysis.ethBalanceUsd > 0
            ? [{ symbol: "ETH", usd: analysis.ethBalanceUsd }]
            : []),
        ],
      });

      json(res, 200, {
        ok: true,
        broker: {
          tokenId,
          owner: session.nftOwner,
          tba: session.tba,
          name: analysis.art?.name ?? null,
          image: analysis.art?.image ?? null,
          attributes: analysis.art?.attributes ?? null,
        },
        analysis: {
          contentsUsd: analysis.contentsUsd,
          cashUsd: analysis.cashUsd,
          cashPct: analysis.cashPct,
          targetCashPct: analysis.targetCashPct,
          ethUsd: analysis.ethUsd,
          holdings,
          actions: analysis.actions,
          buyUniverse: analysis.buyUniverse,
          fundingHint: analysis.fundingHint,
          disclaimer: analysis.disclaimer,
        },
        ledger: {
          fills: ledger.fills.slice(-40).reverse(),
          positions: ledger.positions,
        },
      });
      return;
    }

    if (method === "GET" && path === "/api/ledger") {
      const tokenId =
        url.searchParams.get("tokenId") ||
        loadEnvStatus().tokenId ||
        undefined;
      const ledger = getLedger(tokenId ?? undefined);
      json(res, 200, { ok: true, ...ledger });
      return;
    }

    if (method === "GET" && path === "/api/trades") {
      const tokenId =
        url.searchParams.get("tokenId") ||
        loadEnvStatus().tokenId ||
        undefined;
      const limit = Number(url.searchParams.get("limit") || 200);
      const config = loadConfig();
      const client = makePublicClient(config.rpcUrl);
      const ethUsd = await getEthUsd(client);
      let imported = 0;
      try {
        const session = await connectBroker(config);
        const sync = await importTbaTradesFromExplorer({
          tokenId: String(session.tokenId),
          owner: session.nftOwner,
          tba: session.tba,
          ethUsd,
        });
        imported = sync.imported;
      } catch {
        /* connect optional for read — local log still returned */
      }
      await backfillTradeFees(client, ethUsd, tokenId ?? undefined);
      const trades = listTrades(tokenId ?? undefined, limit);
      json(res, 200, {
        ok: true,
        tokenId: tokenId ?? null,
        ethUsd: ethUsd != null ? +ethUsd.toFixed(2) : null,
        imported,
        totals: tradeTotals(trades),
        trades,
      });
      return;
    }

    if (method === "GET" && path === "/api/history") {
      const tokenId =
        url.searchParams.get("tokenId") ||
        loadEnvStatus().tokenId ||
        undefined;
      const hist = getHistory(tokenId ?? undefined);
      json(res, 200, {
        ok: true,
        tokenId: hist.tokenId,
        series: seriesKeys(hist.points),
        points: hist.points,
      });
      return;
    }

    if (method === "POST" && path === "/api/agent/start") {
      startAutopilot();
      json(res, 200, { ok: true, running: true });
      return;
    }

    if (method === "POST" && path === "/api/agent/resume") {
      resumeAutopilot();
      json(res, 200, { ok: true, running: true });
      return;
    }

    if (method === "POST" && path === "/api/agent/pause") {
      pauseAutopilot();
      json(res, 200, { ok: true, running: false, paused: true });
      return;
    }

    if (method === "POST" && path === "/api/agent/stop") {
      stopAutopilot();
      json(res, 200, { ok: true, running: false, stopped: true });
      return;
    }

    if (method === "POST" && path === "/api/agent/once") {
      void runOnce();
      json(res, 200, { ok: true, started: true });
      return;
    }

    if (method === "GET" && path === "/api/llm/me") {
      const env = loadEnvStatus();
      if (!env.hasLlm) {
        json(res, 200, { ok: true, configured: false, connection: null });
        return;
      }
      try {
        const connection = await loadLlmConnectionCached();
        json(res, 200, { ok: true, configured: true, connection });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        json(res, 200, {
          ok: true,
          configured: true,
          connection: null,
          error: message,
        });
      }
      return;
    }

    if (method === "GET" && path === "/api/x/me") {
      const env = loadEnvStatus();
      if (!env.hasX) {
        json(res, 200, { ok: true, configured: false, account: null });
        return;
      }
      try {
        const account = await loadXAccountCached();
        if (!account) {
          json(res, 200, {
            ok: true,
            configured: true,
            account: null,
            error: "Could not load X profile — check X_* credentials / API access",
          });
          return;
        }
        json(res, 200, { ok: true, configured: true, account });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        json(res, 200, {
          ok: true,
          configured: true,
          account: null,
          error: message,
        });
      }
      return;
    }

    if (method === "POST" && path === "/api/x/test") {
      const config = loadConfig();
      // Force dry-run on chain config so we never broadcast from this path
      config.dryRun = true;
      const text = formatStonkSwapTweet({
        tokenId: config.tokenId,
        fromAmount: "0.0013",
        fromSymbol: "WETH",
        toAmount: "0.05",
        toSymbol: "AAPL",
        dryRun: true,
      });
      const posted = await postTextToX(config, text, { live: true });
      if ("skipped" in posted) {
        json(res, 400, { ok: false, error: posted.skipped, text });
        return;
      }
      json(res, 200, {
        ok: true,
        id: posted.id,
        text: posted.text,
        url: `https://x.com/i/status/${posted.id}`,
      });
      return;
    }

    json(res, 404, { ok: false, error: "not found" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    json(res, 500, { ok: false, error: message });
  }
}

const server = createServer((req, res) => {
  void handle(req, res);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`stonk-trader shell API http://127.0.0.1:${PORT}`);
  console.log("Dashboard: npm run web (http://localhost:3000)");
});
