/**
 * Optional X (Twitter) social-edge rail for autopilot thesis.
 * Uses app-only Bearer (`X_BEARER_TOKEN`) → recent search. Soft-fails if missing / rate-limited.
 */

export type XSymbolSignal = {
  symbol: string;
  mentions: number;
  bullHits: number;
  bearHits: number;
  /** Rough −1..+1 from keyword lean. */
  sentiment: number;
  lean: "bullish" | "bearish" | "neutral";
  sample?: string;
};

export type XSignalDigest = {
  ok: boolean;
  source: "x_recent_search" | "skipped";
  reason?: string;
  symbols: XSymbolSignal[];
  /** Unheld / allowlist names with bullish lean — soft preferBuys hints. */
  preferBuysHint: string[];
  /** Held names with bearish lean — soft preferSells hints. */
  preferSellsHint: string[];
  summary: string;
};

const BULL =
  /\b(bullish|breakout|upgrade|beat(s|ing)?|surge(d|s)?|rally|moon|long\b|buy\b|calls?\b|ath\b|all[- ]time high|strong buy)\b/i;
const BEAR =
  /\b(bearish|breakdown|downgrade|miss(es|ed)?|dump(ed|s)?|plunge(d|s)?|crash(ed|es)?|short\b|sell\b|puts?\b|lawsuit|fraud|investigation|cut guidance)\b/i;

function scoreText(text: string): { bull: number; bear: number } {
  const bull = BULL.test(text) ? 1 : 0;
  const bear = BEAR.test(text) ? 1 : 0;
  return { bull, bear };
}

function leanFrom(sentiment: number, mentions: number): XSymbolSignal["lean"] {
  if (mentions < 2) return "neutral";
  if (sentiment >= 0.25) return "bullish";
  if (sentiment <= -0.25) return "bearish";
  return "neutral";
}

async function searchRecent(
  bearer: string,
  query: string,
  maxResults = 10,
): Promise<string[]> {
  const url = new URL("https://api.x.com/2/tweets/search/recent");
  url.searchParams.set("query", query);
  url.searchParams.set("max_results", String(Math.min(100, Math.max(10, maxResults))));
  url.searchParams.set("tweet.fields", "text,lang");
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${bearer}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`X search ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    data?: Array<{ text?: string }>;
  };
  return (json.data ?? []).map((t) => t.text ?? "").filter(Boolean);
}

function signalForTexts(symbol: string, texts: string[]): XSymbolSignal {
  let bullHits = 0;
  let bearHits = 0;
  for (const t of texts) {
    const s = scoreText(t);
    bullHits += s.bull;
    bearHits += s.bear;
  }
  const mentions = texts.length;
  const denom = Math.max(1, bullHits + bearHits);
  const sentiment =
    mentions === 0 ? 0 : +((bullHits - bearHits) / denom).toFixed(3);
  const lean = leanFrom(sentiment, mentions);
  return {
    symbol,
    mentions,
    bullHits,
    bearHits,
    sentiment,
    lean,
    sample: texts[0]?.slice(0, 140),
  };
}

/**
 * Fetch recent cashtag buzz for symbols. Caps work to avoid burning rate limit.
 */
export async function fetchXSignals(args: {
  bearerToken?: string | null;
  symbols: string[];
  heldSymbols?: string[];
  /** Max symbols to query this pass (default 8). */
  maxSymbols?: number;
}): Promise<XSignalDigest> {
  const bearer = args.bearerToken?.trim();
  if (!bearer) {
    return {
      ok: false,
      source: "skipped",
      reason: "X_BEARER_TOKEN not set",
      symbols: [],
      preferBuysHint: [],
      preferSellsHint: [],
      summary: "X signals skipped (no bearer)",
    };
  }

  const held = new Set(
    (args.heldSymbols ?? []).map((s) => s.toUpperCase()).filter(Boolean),
  );
  const uniq = [
    ...new Set(args.symbols.map((s) => s.toUpperCase()).filter(Boolean)),
  ].slice(0, args.maxSymbols ?? 8);

  if (!uniq.length) {
    return {
      ok: false,
      source: "skipped",
      reason: "no symbols",
      symbols: [],
      preferBuysHint: [],
      preferSellsHint: [],
      summary: "X signals skipped (empty universe)",
    };
  }

  const settled = await Promise.allSettled(
    uniq.map(async (sym) => {
      // Cashtag + plain ticker; exclude replies/retweets noise a bit
      const query = `$${sym} lang:en -is:retweet`;
      const texts = await searchRecent(bearer, query, 10);
      return signalForTexts(sym, texts);
    }),
  );

  const symbols: XSymbolSignal[] = [];
  const errors: string[] = [];
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i];
    if (r.status === "fulfilled") symbols.push(r.value);
    else {
      errors.push(
        `${uniq[i]}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`,
      );
    }
  }

  if (!symbols.length) {
    return {
      ok: false,
      source: "skipped",
      reason: errors[0] ?? "all searches failed",
      symbols: [],
      preferBuysHint: [],
      preferSellsHint: [],
      summary: `X signals failed: ${errors[0] ?? "unknown"}`,
    };
  }

  const preferBuysHint = symbols
    .filter((s) => s.lean === "bullish" && !held.has(s.symbol))
    .sort((a, b) => b.sentiment - a.sentiment || b.mentions - a.mentions)
    .map((s) => s.symbol)
    .slice(0, 2);

  const preferSellsHint = symbols
    .filter((s) => s.lean === "bearish" && held.has(s.symbol))
    .sort((a, b) => a.sentiment - b.sentiment || b.mentions - a.mentions)
    .map((s) => s.symbol)
    .slice(0, 2);

  const bits = symbols
    .filter((s) => s.mentions > 0)
    .map(
      (s) =>
        `${s.symbol}:${s.lean}(${s.sentiment >= 0 ? "+" : ""}${s.sentiment},n=${s.mentions})`,
    );
  const summary =
    bits.length > 0
      ? `X buzz: ${bits.join(" · ")}`
      : "X buzz: no recent cashtag hits";

  return {
    ok: true,
    source: "x_recent_search",
    reason: errors.length ? `partial: ${errors[0]}` : undefined,
    symbols,
    preferBuysHint,
    preferSellsHint,
    summary,
  };
}

/** Merge soft X hints into LLM / thesis prefer lists (cap 2). */
export function mergeXHints(args: {
  preferBuys: string[];
  preferSells: string[];
  digest: XSignalDigest;
  allowlist: string[];
  heldSymbols: string[];
  /** When cash near target, don't force new opens from buzz alone. */
  allowBuyHints?: boolean;
}): { preferBuys: string[]; preferSells: string[] } {
  const allow = new Set(args.allowlist.map((s) => s.toUpperCase()));
  const held = new Set(args.heldSymbols.map((s) => s.toUpperCase()));
  let preferBuys = [...args.preferBuys];
  let preferSells = [...args.preferSells];

  if (args.allowBuyHints !== false) {
    for (const s of args.digest.preferBuysHint) {
      if (preferBuys.length >= 2) break;
      if (!allow.has(s) || held.has(s)) continue;
      if (preferBuys.includes(s) || preferSells.includes(s)) continue;
      preferBuys.push(s);
    }
  }

  for (const s of args.digest.preferSellsHint) {
    if (preferSells.length >= 2) break;
    if (!held.has(s)) continue;
    if (preferSells.includes(s) || preferBuys.includes(s)) continue;
    preferSells.push(s);
  }

  return { preferBuys, preferSells };
}
