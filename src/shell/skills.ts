import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type TradingSkill = {
  id: string;
  name: string;
  description: string;
  priority: number;
  inject: boolean;
  /** Body under "## Agent rules" (or full body fallback). */
  agentRules: string;
  path: string;
};

function skillsRoots(): string[] {
  return [
    join(process.cwd(), "skills"),
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "skills"),
  ];
}

function resolveSkillsDir(): string | null {
  for (const d of skillsRoots()) {
    if (existsSync(d)) return d;
  }
  return null;
}

function parseFrontmatter(raw: string): {
  meta: Record<string, string>;
  body: string;
} {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) return { meta: {}, body: raw };
  const fm = m[1];
  const meta: Record<string, string> = {};

  // Block scalars: key: >- \n  line\n  line
  const blockRe = /^([A-Za-z0-9_-]+):\s*>-?\s*\n((?:[ \t]+.+\n?)*)/gm;
  let block: RegExpExecArray | null;
  const consumed = new Set<string>();
  while ((block = blockRe.exec(fm)) != null) {
    const key = block[1];
    meta[key] = block[2]
      .split(/\n/)
      .map((l) => l.replace(/^[ \t]+/, "").trim())
      .filter(Boolean)
      .join(" ");
    consumed.add(key);
  }

  for (const line of fm.split(/\r?\n/)) {
    if (/^\s/.test(line) || line.trim() === "" || line.trim() === ">-") continue;
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    if (consumed.has(key)) continue;
    let val = line.slice(idx + 1).trim();
    if (val === ">" || val === ">-" || val === "|") continue;
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    meta[key] = val;
  }
  return { meta, body: m[2] };
}

function extractAgentRules(body: string): string {
  const parts = body.split(/^## Agent rules\s*$/im);
  if (parts.length < 2) return body.trim().slice(0, 1200);
  const section = parts[1].split(/^## /m)[0] ?? parts[1];
  return section.trim().slice(0, 1500);
}

/** Load all skills/<id>/SKILL.md packs (sorted by priority then name). */
export function loadTradingSkills(): TradingSkill[] {
  const root = resolveSkillsDir();
  if (!root) return [];
  const out: TradingSkill[] = [];
  for (const ent of readdirSync(root, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const path = join(root, ent.name, "SKILL.md");
    if (!existsSync(path)) continue;
    try {
      const raw = readFileSync(path, "utf8");
      const { meta, body } = parseFrontmatter(raw);
      const inject =
        meta.inject === undefined
          ? true
          : !["false", "0", "no"].includes(meta.inject.toLowerCase());
      out.push({
        id: ent.name,
        name: meta.name || ent.name,
        description: meta.description || "",
        priority: Number(meta.priority) || 100,
        inject,
        agentRules: extractAgentRules(body),
        path,
      });
    } catch {
      /* skip broken pack */
    }
  }
  return out.sort(
    (a, b) => a.priority - b.priority || a.name.localeCompare(b.name),
  );
}

/**
 * Compact skill doctrine for LLM thesis prompts.
 * Prefer Agent rules sections; fall back to TRADING.md snippet if empty.
 */
export function skillsSnippet(maxChars = 4500): string {
  const skills = loadTradingSkills().filter((s) => s.inject);
  if (!skills.length) return "";
  const chunks: string[] = [];
  let used = 0;
  for (const s of skills) {
    const block = `### ${s.name}\n${s.agentRules}`;
    if (used + block.length + 2 > maxChars) break;
    chunks.push(block);
    used += block.length + 2;
  }
  return chunks.join("\n\n");
}

/** Max buy notional so a full stopLossPct hit ≈ maxRiskPctPerTrade of book. */
export function riskBudgetBuyCapUsd(args: {
  contentsUsd: number;
  stopLossPct: number;
  maxRiskPctPerTrade: number;
}): number {
  const book = Math.max(0, args.contentsUsd);
  const stop = Math.max(0.1, args.stopLossPct);
  const riskPct = Math.max(0, args.maxRiskPctPerTrade);
  if (!(book > 0) || !(riskPct > 0)) return Number.POSITIVE_INFINITY;
  return (book * riskPct) / stop;
}

/**
 * Trim fraction for stop-loss: deeper breaches sell more (risk-exits skill).
 */
export function stopLossTrimFraction(pnlPct: number, stopLossPct: number): number {
  const stop = Math.max(0.1, stopLossPct);
  const depth = Math.abs(Math.min(0, pnlPct)) / stop;
  if (depth >= 2) return 0.75;
  if (depth >= 1.5) return 0.6;
  return 0.5;
}
