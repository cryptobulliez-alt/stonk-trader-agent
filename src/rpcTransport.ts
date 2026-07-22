import { http, type HttpTransport } from "viem";

const DEFAULT_RPC = "https://rpc.mainnet.chain.robinhood.com";

/**
 * Robinhood public RPC rate-limits aggressively. Retry 429s with backoff
 * (honors Retry-After when present) before viem's own retry layer.
 */
async function fetchWithRateLimit(
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
  attempt = 0,
): Promise<Response> {
  const res = await fetch(input, init);
  if (res.status !== 429 || attempt >= 5) return res;

  const ra = res.headers.get("retry-after");
  const waitMs =
    ra && /^\d+(\.\d+)?$/.test(ra)
      ? Math.min(30_000, Math.ceil(Number(ra) * 1000))
      : Math.min(16_000, 750 * 2 ** attempt);

  await new Promise((r) => setTimeout(r, waitMs));
  return fetchWithRateLimit(input, init, attempt + 1);
}

export function rhHttpTransport(rpcUrl?: string): HttpTransport {
  const url = rpcUrl || process.env.RH_RPC_URL || DEFAULT_RPC;
  return http(url, {
    timeout: 20_000,
    retryCount: 5,
    retryDelay: 750,
    fetchOptions: {
      headers: { "User-Agent": "stonk-trader/1.0" },
    },
    fetchFn: fetchWithRateLimit,
  });
}

export function isRpcRateLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /too many requests|429|rate.?limit/i.test(msg);
}

/** Short message for UI / events (viem dumps the whole request). */
export function summarizeRpcError(err: unknown): string {
  if (isRpcRateLimitError(err)) {
    return "RPC rate limited (Too Many Requests) — will retry next pass";
  }
  const msg = err instanceof Error ? err.message : String(err);
  // Keep first line / truncate noisy viem dumps
  const first = msg.split("\n")[0]?.trim() || msg;
  return first.length > 220 ? `${first.slice(0, 220)}…` : first;
}
