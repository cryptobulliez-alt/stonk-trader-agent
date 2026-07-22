import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppConfig } from "../config.js";
import { loadSettings } from "./settings.js";

const SYSTEM = `You are a local StonkBroker TBA portfolio agent on Robinhood Chain.

Follow docs/TRADING.md:
- Allowlist = CANDIDATES. Never buy every name. Prefer 1 (max 2) selective opens.
- Cash target is ~reserveWethPct (default 30%). Cash well ABOVE that is dry powder that should be put to work — not parked forever.
- When cashExcessPct >= 10 and unheldAllowlist is non-empty: stance should be "risk_on" and preferBuys MUST include 1 symbol from unheldAllowlist (open a new sleeve name). Only use stance "hold" or empty preferBuys if stance is "risk_off" with a clear risk reason.
- Do NOT refuse to buy solely because currently held names are flat/noisy — those are separate; look at unheld candidates for diversification toward the cash target.
- Adding to an existing name: only if dip vs avg cost or a strong continuation thesis.
- Never send TBA proceeds to the owner EOA.
- Cut losers (stop-loss), bank winners (take-profit); respect minNotionalUsd / minEdgeBps.
- Output JSON: { thesis, preferBuys, preferSells, stance }.
  - preferBuys: 0–2 allowlist symbols (empty only if risk_off or cash already near target).
  - preferSells: 0–2 held symbols for broken trend (else rely on TP/SL).
  - stance: "risk_on" | "risk_off" | "hold".
- Not financial advice. Stock tokens are geo-restricted.`;

export type LlmPlan = {
  thesis: string;
  preferBuys: string[];
  preferSells: string[];
  stance: "risk_on" | "risk_off" | "hold";
};

export type LlmProvider = "openai" | "anthropic";

export type LlmConnection = {
  provider: LlmProvider;
  currentModel: string;
  defaultModel: string;
  models: Array<{ id: string; label: string }>;
  source: "api" | "fallback";
  error?: string;
};

const OPENAI_FALLBACK = [
  "gpt-4o-mini",
  "gpt-4o",
  "gpt-4.1-mini",
  "gpt-4.1",
  "o4-mini",
  "o3-mini",
];

const ANTHROPIC_FALLBACK = [
  "claude-sonnet-5",
  "claude-opus-4-8",
  "claude-haiku-4-5",
  "claude-sonnet-4-5",
  "claude-3-5-haiku-latest",
  "claude-3-5-sonnet-latest",
];

export function defaultLlmModel(provider: LlmProvider): string {
  return provider === "anthropic" ? "claude-sonnet-5" : "gpt-4o-mini";
}

/** Resolve model: settings.json → LLM_MODEL env → provider default. */
export function resolveLlmModel(config: AppConfig): string {
  const fromSettings = loadSettings().llmModel?.trim();
  if (fromSettings) return fromSettings;
  if (config.llmModel?.trim()) return config.llmModel.trim();
  return defaultLlmModel(config.llmProvider);
}

function labelForModel(id: string): string {
  return id;
}

function asModelList(ids: string[]): Array<{ id: string; label: string }> {
  const seen = new Set<string>();
  const out: Array<{ id: string; label: string }> = [];
  for (const id of ids) {
    const clean = id.trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push({ id: clean, label: labelForModel(clean) });
  }
  return out;
}

async function listOpenAiModels(apiKey: string): Promise<string[]> {
  const res = await fetch("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    throw new Error(`OpenAI models ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as { data?: Array<{ id?: string }> };
  const ids = (json.data ?? [])
    .map((m) => m.id ?? "")
    .filter((id) =>
      /^(gpt-|o[1-9]|chatgpt-)/i.test(id) &&
      !/instruct|realtime|audio|transcribe|tts|image|search/i.test(id),
    )
    .sort((a, b) => a.localeCompare(b));
  return ids.length ? ids : [...OPENAI_FALLBACK];
}

async function listAnthropicModels(apiKey: string): Promise<string[]> {
  const res = await fetch("https://api.anthropic.com/v1/models", {
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
  });
  if (!res.ok) {
    throw new Error(`Anthropic models ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as { data?: Array<{ id?: string }> };
  const ids = (json.data ?? [])
    .map((m) => m.id ?? "")
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  return ids.length ? ids : [...ANTHROPIC_FALLBACK];
}

/** Provider + selectable models for the Settings panel. */
export async function getLlmConnection(config: AppConfig): Promise<LlmConnection> {
  const provider = config.llmProvider;
  const defaultModel = defaultLlmModel(provider);
  const currentModel = resolveLlmModel(config);
  if (!config.llmApiKey) {
    return {
      provider,
      currentModel,
      defaultModel,
      models: asModelList(
        provider === "anthropic" ? ANTHROPIC_FALLBACK : OPENAI_FALLBACK,
      ),
      source: "fallback",
      error: "LLM_API_KEY missing",
    };
  }

  try {
    const ids =
      provider === "anthropic"
        ? await listAnthropicModels(config.llmApiKey)
        : await listOpenAiModels(config.llmApiKey);
    // Ensure current + defaults appear even if API omits them
    const merged = asModelList([currentModel, defaultModel, ...ids]);
    return {
      provider,
      currentModel,
      defaultModel,
      models: merged,
      source: "api",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const fallback =
      provider === "anthropic" ? ANTHROPIC_FALLBACK : OPENAI_FALLBACK;
    return {
      provider,
      currentModel,
      defaultModel,
      models: asModelList([currentModel, defaultModel, ...fallback]),
      source: "fallback",
      error: message,
    };
  }
}

function playbookSnippet(): string {
  const candidates = [
    join(process.cwd(), "docs", "TRADING.md"),
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "docs", "TRADING.md"),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const raw = readFileSync(p, "utf8");
      const rules = raw.split("## Rules this agent must follow")[1]?.split("## Mapping settings")[0];
      return (rules ?? raw).slice(0, 3500);
    } catch {
      /* ignore */
    }
  }
  return "Selective preferBuys; deploy when cash ≫ reserve; TP/SL exits; fee gate.";
}

/** Pull allowlist tickers mentioned in free-text thesis notes. */
export function tickersFromText(text: string, allowlist: string[]): string[] {
  if (!text) return [];
  const up = text.toUpperCase();
  return allowlist
    .map((s) => s.toUpperCase())
    .filter((sym) => new RegExp(`\\b${sym}\\b`).test(up));
}

export async function askLlmForThesis(
  config: AppConfig,
  ctx: {
    cashPct: number | null;
    reserveWethPct: number;
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

  const cashPct = ctx.cashPct;
  const reserve = ctx.reserveWethPct;
  const cashExcessPct =
    cashPct != null ? +(cashPct - reserve).toFixed(2) : null;
  const held = new Set(
    ctx.holdings
      .map((h) => h.symbol.toUpperCase())
      .filter((s) => !["WETH", "ETH", "USDG", "STONKBROKER"].includes(s)),
  );
  const unheldAllowlist = ctx.allowlist
    .map((s) => s.toUpperCase())
    .filter((s) => !held.has(s));
  const deployPressure = cashExcessPct != null && cashExcessPct >= 10;

  const user = JSON.stringify(
    {
      task: deployPressure
        ? "Cash is well above reserve. Pick 1 unheld allowlist name in preferBuys (stance risk_on) unless you set stance risk_off with a concrete risk reason. Do not hold just because existing positions are flat."
        : "Decide this manage pass: hold, or name 1–2 preferBuys / preferSells from the allowlist with a short thesis.",
      playbook: playbookSnippet(),
      allocation: {
        cashPct,
        reserveWethPct: reserve,
        cashExcessPct,
        deployPressure,
        hint: deployPressure
          ? "Investor.gov-style rebalance: restore risk sleeve toward target by OPENING an unheld candidate — not by ignoring dry powder."
          : "Near cash target — selective holds/trims OK.",
      },
      heldStocks: ctx.holdings.filter(
        (h) => !["WETH", "ETH", "USDG", "STONKBROKER"].includes(h.symbol.toUpperCase()),
      ),
      allowlist: ctx.allowlist,
      unheldAllowlist,
      notes: ctx.settingsThesis || undefined,
      feeAware: {
        minNotionalUsd: ctx.minNotionalUsd,
        minEdgeBps: ctx.minEdgeBps,
        takeProfitPct: ctx.takeProfitPct,
        stopLossPct: ctx.stopLossPct,
        addOnlyDipBps: ctx.addOnlyDipBps,
        hint: "One fee-viable ticket into an unheld name beats spraying. Empty preferBuys only if risk_off or cash near target.",
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
  const model = resolveLlmModel(config);
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.llmApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.35,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            SYSTEM +
            "\nRespond JSON only: {thesis, preferBuys: string[], preferSells: string[], stance}. Escape quotes inside thesis. Keep thesis under 400 chars.",
        },
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
  const model = resolveLlmModel(config);
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": config.llmApiKey!,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 800,
      system:
        SYSTEM +
        "\nRespond with a single JSON object only (no markdown). Keys: thesis (string), preferBuys (string[]), preferSells (string[]), stance (risk_on|risk_off|hold). Escape any quotes inside thesis with \\\". Keep thesis under 400 chars.",
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

function extractJsonObject(raw: string): string {
  let s = raw.trim();
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  return s;
}

function softenJson(s: string): string {
  return s
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/,\s*([}\]])/g, "$1");
}

function matchStringArray(raw: string, key: string): string[] {
  const re = new RegExp(`"${key}"\\s*:\\s*\\[([\\s\\S]*?)\\]`, "i");
  const m = raw.match(re);
  if (!m) return [];
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1].toUpperCase());
}

/** Last-resort field scrape when the model breaks JSON quoting in thesis. */
function parsePlanLoose(raw: string): LlmPlan {
  const preferBuys = matchStringArray(raw, "preferBuys").slice(0, 2);
  const preferSells = matchStringArray(raw, "preferSells").slice(0, 2);
  const stanceMatch = raw.match(
    /"stance"\s*:\s*"(risk_on|risk_off|hold)"/i,
  );
  const stanceRaw = (stanceMatch?.[1] ?? "hold").toLowerCase();
  const stance: LlmPlan["stance"] =
    stanceRaw === "risk_on" || stanceRaw === "risk_off" ? stanceRaw : "hold";

  let thesis = "Hold — no selective sleeve action.";
  const thesisQuoted = raw.match(/"thesis"\s*:\s*"((?:\\.|[^"\\])*)"/);
  if (thesisQuoted?.[1]) {
    thesis = thesisQuoted[1].replace(/\\"/g, '"').replace(/\\n/g, " ");
  } else {
    // Broken quotes inside thesis — take text until next known key
    const loose = raw.match(
      /"thesis"\s*:\s*"([\s\S]*?)"\s*,\s*"(preferBuys|preferSells|stance)"/i,
    );
    if (loose?.[1]) {
      thesis = loose[1].replace(/\s+/g, " ").trim().slice(0, 500);
    }
  }

  return { thesis, preferBuys, preferSells, stance };
}

function normalizePlan(obj: {
  thesis?: string;
  preferBuys?: string[];
  preferSells?: string[];
  stance?: string;
}): LlmPlan {
  const stanceRaw = (obj.stance ?? "hold").toLowerCase();
  const stance: LlmPlan["stance"] =
    stanceRaw === "risk_on" || stanceRaw === "risk_off" ? stanceRaw : "hold";
  const preferBuys = Array.isArray(obj.preferBuys)
    ? obj.preferBuys.map((s) => String(s).toUpperCase())
    : [];
  const preferSells = Array.isArray(obj.preferSells)
    ? obj.preferSells.map((s) => String(s).toUpperCase())
    : [];
  return {
    thesis:
      typeof obj.thesis === "string" && obj.thesis.trim()
        ? obj.thesis.trim()
        : "Hold — no selective sleeve action.",
    preferBuys: preferBuys.slice(0, 2),
    preferSells: preferSells.slice(0, 2),
    stance,
  };
}

function parsePlan(raw: string): LlmPlan {
  const extracted = extractJsonObject(raw);
  const candidates = [extracted, softenJson(extracted)];
  for (const candidate of candidates) {
    try {
      return normalizePlan(JSON.parse(candidate));
    } catch {
      /* try next */
    }
  }
  // Model often breaks JSON by putting unescaped " inside thesis — scrape fields
  return parsePlanLoose(raw);
}
