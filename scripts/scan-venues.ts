/**
 * Probe every stock token for mark-sane v3/v4 execution paths.
 * Writes data/venueMap.json for the shell/UI.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, formatUnits, http } from "viem";
import { listStockAssets } from "../src/assets.js";
import { findBestQuotedRoute, v3RouteFeeBps } from "../src/brokerReads.js";
import { loadConfig, WETH } from "../src/config.js";
import { checkSwapQuoteVsMark, MAX_EXEC_VS_MARK_BPS } from "../src/swapSanity.js";
import { findBestEthStockPool, quoteV4ExactIn } from "../src/v4.js";

const AMOUNT_IN = 5_000_000_000_000_000n; // 0.005 ETH — typical small ticket
const MAX_UNDER = MAX_EXEC_VS_MARK_BPS;

type Row = {
  symbol: string;
  address: string;
  v3: null | {
    ok: boolean;
    detail: string;
    vsMarkBps?: number;
    quotedOut?: string;
  };
  v4: null | {
    ok: boolean;
    detail: string;
    vsMarkBps?: number;
    quotedOut?: string;
  };
  tradeable: boolean;
  preferred: "v3" | "v4" | null;
};

async function main() {
  const cfg = loadConfig();
  const client = createPublicClient({ transport: http(cfg.rpcUrl) });
  const assets = listStockAssets().filter((a) => a.tradable);
  console.log(`Scanning ${assets.length} tradable assets @ ${formatUnits(AMOUNT_IN, 18)} ETH…`);

  const rows: Row[] = [];
  let i = 0;
  for (const a of assets) {
    i++;
    const row: Row = {
      symbol: a.symbol,
      address: a.address,
      v3: null,
      v4: null,
      tradeable: false,
      preferred: null,
    };

    // V3 — best Quoter across all fee-tier candidates
    try {
      const best = await findBestQuotedRoute(client, WETH, a.address, AMOUNT_IN);
      if (!best) {
        row.v3 = { ok: false, detail: "no v3 WETH/USDG route" };
      } else {
        const { route, quotedOut: quoted } = best;
        const sanity = await checkSwapQuoteVsMark(client, {
          buyStock: true,
          stock: { symbol: a.symbol, address: a.address, decimals: 18 },
          amountIn: AMOUNT_IN,
          quotedOut: quoted,
          engine: "v3",
          routeFeeBps: v3RouteFeeBps(route),
          maxUnderBps: MAX_UNDER,
        });
        const detail =
          route.kind === "direct"
            ? `direct fee ${route.fee}`
            : `via ${route.midSymbol} ${route.feeIn}/${route.feeOut}`;
        if (!sanity.ok) {
          row.v3 = {
            ok: false,
            detail: `${detail} — ${sanity.reason}`,
            quotedOut: formatUnits(quoted, 18),
          };
        } else {
          row.v3 = {
            ok: true,
            detail,
            vsMarkBps: sanity.vsMarkBps,
            quotedOut: formatUnits(quoted, 18),
          };
        }
      }
    } catch (err) {
      row.v3 = {
        ok: false,
        detail: err instanceof Error ? err.message.slice(0, 160) : String(err),
      };
    }

    // V4
    try {
      const pool = await findBestEthStockPool(client, a.address);
      if (!pool) {
        row.v4 = { ok: false, detail: "no v4 ETH pool" };
      } else {
        const quoted = await quoteV4ExactIn(client, pool.key, true, AMOUNT_IN);
        const sanity = await checkSwapQuoteVsMark(client, {
          buyStock: true,
          stock: { symbol: a.symbol, address: a.address, decimals: 18 },
          amountIn: AMOUNT_IN,
          quotedOut: quoted,
          engine: "v4",
          routeFeeBps: Math.round(pool.key.fee / 100),
          maxUnderBps: MAX_UNDER,
        });
        const detail = `fee=${pool.key.fee} tick=${pool.key.tickSpacing}`;
        if (!sanity.ok) {
          row.v4 = {
            ok: false,
            detail: `${detail} — ${sanity.reason}`,
            quotedOut: formatUnits(quoted, 18),
          };
        } else {
          row.v4 = {
            ok: true,
            detail,
            vsMarkBps: sanity.vsMarkBps,
            quotedOut: formatUnits(quoted, 18),
          };
        }
      }
    } catch (err) {
      row.v4 = {
        ok: false,
        detail: err instanceof Error ? err.message.slice(0, 160) : String(err),
      };
    }

    const v3ok = row.v3?.ok === true;
    const v4ok = row.v4?.ok === true;
    row.tradeable = v3ok || v4ok;
    if (v3ok && v4ok) {
      const v3b = row.v3!.vsMarkBps ?? -9999;
      const v4b = row.v4!.vsMarkBps ?? -9999;
      row.preferred = v4b >= v3b ? "v4" : "v3";
    } else if (v4ok) row.preferred = "v4";
    else if (v3ok) row.preferred = "v3";

    const flag = row.tradeable ? "OK" : "NO";
    console.log(
      `[${i}/${assets.length}] ${flag} ${a.symbol.padEnd(6)} v3=${v3ok ? "✓" : "·"} v4=${v4ok ? "✓" : "·"} pref=${row.preferred ?? "-"}`,
    );
    rows.push(row);
  }

  rows.sort((a, b) => a.symbol.localeCompare(b.symbol));
  const summary = {
    scannedAt: new Date().toISOString(),
    amountInEth: formatUnits(AMOUNT_IN, 18),
    maxExecVsMarkBps: MAX_UNDER,
    total: rows.length,
    tradeable: rows.filter((r) => r.tradeable).length,
    v3Only: rows.filter((r) => r.v3?.ok && !r.v4?.ok).length,
    v4Only: rows.filter((r) => r.v4?.ok && !r.v3?.ok).length,
    both: rows.filter((r) => r.v3?.ok && r.v4?.ok).length,
    none: rows.filter((r) => !r.tradeable).length,
    tokens: rows,
  };

  const out = join(process.cwd(), "data", "venueMap.json");
  writeFileSync(out, JSON.stringify(summary, null, 2) + "\n");
  console.log("\nSummary:", {
    total: summary.total,
    tradeable: summary.tradeable,
    v3Only: summary.v3Only,
    v4Only: summary.v4Only,
    both: summary.both,
    none: summary.none,
  });
  console.log("Wrote", out);
  const unt = rows.filter((r) => !r.tradeable);
  if (unt.length) {
    console.log("\nUntadeable:");
    for (const r of unt) {
      console.log(
        `  ${r.symbol}: v3=${r.v3?.detail ?? "?"} | v4=${r.v4?.detail ?? "?"}`,
      );
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
