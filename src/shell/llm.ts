import type { AppConfig } from "../config.js";

const SYSTEM = `You are a local StonkBroker TBA portfolio agent on Robinhood Chain.
Rules:
- Keep ~70% cash (WETH+ETH) unless settings say otherwise.
- Never send TBA proceeds to the owner EOA.
- Prefer liquid mega-caps from the allowlist.
- Prefer hold over sub-edge rebalances — swaps skip unless expected edge beats gas+slip.
- Respect minNotionalUsd / minEdgeBps from context; do not suggest micro-churn.
- When trimming for cash, prefer names with positive unrealized P&L; avoid selling losers unless cash is critically low or stop-loss applies.
- Take-profit / stop-loss / dip-only adds are already in core policy — reinforce them in the thesis.
- Use avg cost / mark / unrealized P&L when present.
- Output a short thesis (1-2 sentences) and optional preferred buy symbols from the allowlist.
- Not financial advice. Stock tokens are geo-restricted.`;

export type LlmPlan = {
  thesis: string;
  preferBuys: string[];
};

export async function askLlmForThesis(
  config: AppConfig,
  ctx: {
    cashPct: number | null;
    holdings: Array<{
      symbol: string;
      weightPct: number | null;
      unrealizedPnlPct?: number | null;
      avgCostUsd?: number | null;
      markUsd?: number | null;
    }>;
    allowlist: string[];
    settingsThesis: string;
    minNotionalUsd?: number;
    minEdgeBps?: number;
    takeProfitPct?: number;
    stopLossPct?: number;
    addOnlyDipBps?: number;
  },
): Promise<LlmPlan | null> {
  if (!config.llmApiKey) return null;

  const user = JSON.stringify(
    {
      task: "Write a short thesis for this manage pass.",
      cashPct: ctx.cashPct,
      holdings: ctx.holdings,
      allowlist: ctx.allowlist,
      notes: ctx.settingsThesis || undefined,
      feeAware: {
        minNotionalUsd: ctx.minNotionalUsd,
        minEdgeBps: ctx.minEdgeBps,
        takeProfitPct: ctx.takeProfitPct,
        stopLossPct: ctx.stopLossPct,
        addOnlyDipBps: ctx.addOnlyDipBps,
        hint: "Swaps skip unless expected edge beats gas+slip; prefer hold over micro rebalance.",
      },
    },
    null,
    2,
  );

  try {
    if (config.llmProvider === "anthropic") {
      return await callAnthropic(config, user);
    }
    return await callOpenAi(config, user);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`LLM error: ${msg}`);
  }
}

async function callOpenAi(config: AppConfig, user: string): Promise<LlmPlan> {
  const model = config.llmModel || "gpt-4o-mini";
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.llmApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.3,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM + "\nRespond JSON: {thesis, preferBuys: string[]}" },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return parsePlan(json.choices?.[0]?.message?.content ?? "{}");
}

async function callAnthropic(config: AppConfig, user: string): Promise<LlmPlan> {
  const model = config.llmModel || "claude-sonnet-4-20250514";
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": config.llmApiKey!,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 400,
      system: SYSTEM + "\nRespond with JSON only: {thesis, preferBuys: string[]}",
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!res.ok) {
    throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as {
    content?: Array<{ type: string; text?: string }>;
  };
  const text = json.content?.find((c) => c.type === "text")?.text ?? "{}";
  return parsePlan(text);
}

function parsePlan(raw: string): LlmPlan {
  const cleaned = raw.replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
  const obj = JSON.parse(cleaned) as { thesis?: string; preferBuys?: string[] };
  return {
    thesis: typeof obj.thesis === "string" ? obj.thesis : "Core cash policy pass.",
    preferBuys: Array.isArray(obj.preferBuys)
      ? obj.preferBuys.map((s) => String(s).toUpperCase())
      : [],
  };
}
