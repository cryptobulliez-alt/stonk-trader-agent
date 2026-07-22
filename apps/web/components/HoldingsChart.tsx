"use client";

import { useMemo } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export type HistoryPoint = {
  ts: number;
  totalUsd: number;
  holdings: Record<string, number>;
};

/** Terminal palette — lime accent first, then distinct companions (no purple). */
const COLORS = [
  "#b2ff00",
  "#5eead4",
  "#fbbf24",
  "#38bdf8",
  "#f97316",
  "#a3e635",
  "#eab308",
  "#22d3ee",
  "#fb7185",
  "#84cc16",
  "#fde047",
  "#2dd4bf",
];

function colorFor(symbol: string, index: number) {
  if (symbol === "WETH" || symbol === "ETH") return "#b2ff00";
  if (symbol === "USDG") return "#5eead4";
  return COLORS[(index + 2) % COLORS.length];
}

type Props = {
  points: HistoryPoint[];
  series: string[];
};

type TipPayload = {
  name?: string;
  value?: number;
  color?: string;
  dataKey?: string;
  payload?: Record<string, string | number>;
};

function ChartTooltip({
  active,
  label,
  payload,
}: {
  active?: boolean;
  label?: string;
  payload?: TipPayload[];
}) {
  if (!active || !payload?.length) return null;
  const rows = payload.filter(
    (p) => p.dataKey !== "totalUsd" && typeof p.value === "number",
  );
  const totalFromPayload = payload[0]?.payload?.totalUsd;
  const total =
    typeof totalFromPayload === "number"
      ? totalFromPayload
      : rows.reduce((s, p) => s + (Number(p.value) || 0), 0);

  return (
    <div className="chart-tooltip">
      <div className="chart-tooltip-label">{label}</div>
      {rows.map((p) => (
        <div key={String(p.dataKey ?? p.name)} className="chart-tooltip-row">
          <span style={{ color: p.color }}>{p.name}</span>
          <span>${Number(p.value).toFixed(2)}</span>
        </div>
      ))}
      <div className="chart-tooltip-total">
        <span>Total</span>
        <span>${total.toFixed(2)}</span>
      </div>
    </div>
  );
}

export function HoldingsChart({ points, series }: Props) {
  const data = useMemo(() => {
    return points.map((p) => {
      const row: Record<string, string | number> = {
        ts: p.ts,
        label: new Date(p.ts).toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        }),
        totalUsd: p.totalUsd,
      };
      for (const s of series) {
        row[s] = p.holdings[s] ?? 0;
      }
      return row;
    });
  }, [points, series]);

  if (points.length < 1) {
    return (
      <p className="sub" style={{ margin: 0 }}>
        No history yet — refresh Portfolio to record the first snapshot.
      </p>
    );
  }

  return (
    <div className="chart-wrap">
      <ResponsiveContainer width="100%" height={280}>
        <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="#222" strokeDasharray="3 3" />
          <XAxis
            dataKey="label"
            tick={{ fill: "#a0a0a0", fontSize: 10 }}
            tickLine={false}
            axisLine={{ stroke: "#333" }}
            minTickGap={40}
          />
          <YAxis
            tick={{ fill: "#a0a0a0", fontSize: 10 }}
            tickLine={false}
            axisLine={{ stroke: "#333" }}
            tickFormatter={(v: number) =>
              v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : `$${v}`
            }
            width={52}
          />
          <Tooltip content={<ChartTooltip />} />
          <Legend
            wrapperStyle={{ fontSize: 11, color: "#a0a0a0" }}
            iconType="square"
          />
          {series.map((sym, i) => (
            <Area
              key={sym}
              type="monotone"
              dataKey={sym}
              stackId="1"
              stroke={colorFor(sym, i)}
              fill={colorFor(sym, i)}
              fillOpacity={0.55}
              strokeWidth={1.5}
              isAnimationActive={points.length < 80}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
      {points.length === 1 && (
        <p className="sub" style={{ margin: "8px 0 0" }}>
          One snapshot recorded. More points appear as Portfolio refreshes /
          autopilot runs (min ~1 min apart).
        </p>
      )}
    </div>
  );
}
