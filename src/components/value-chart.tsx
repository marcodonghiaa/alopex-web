import { useId, useRef } from "react";
import {
  Area,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { axisDateFormatter, formatISODate } from "@/lib/date";

interface ValueChartProps<T extends { ts: number; snapshot_date: string }> {
  data: Array<T>;
  dataKey: keyof T & string;
  name: string;
  // Dashed line drawn across gaps in the history, when the series carries one.
  estimateKey?: keyof T & string;
  onScrub: (index: number | null) => void;
}

/** Once a vertical swipe, always one: the finger went further up/down than sideways, past a few px. */
export function isVerticalSwipe(
  from: { x: number; y: number; scroll: boolean },
  x: number,
  y: number,
) {
  if (from.scroll) return true;
  const dx = Math.abs(x - from.x);
  const dy = Math.abs(y - from.y);
  return dy > 6 && dy > dx;
}

/** The range's first value, for the faint baseline the line is read against. */
export function startValue<T>(data: Array<T>, key: keyof T & string): number | undefined {
  for (const row of data) {
    const v = row[key];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return undefined;
}

/** Marks the latest value only: an Ember dot in a soft Ember halo. */
export function latestDot(last: number) {
  return function LatestDot({ cx, cy, index }: { cx?: number; cy?: number; index?: number }) {
    if (index !== last || cx == null || cy == null) return <g key={index} />;
    return (
      <g key={index}>
        <circle cx={cx} cy={cy} r={6} fill="var(--color-ember)" fillOpacity={0.2} />
        <circle cx={cx} cy={cy} r={3} fill="var(--color-ember)" />
      </g>
    );
  };
}

// One line over a faint fill, a dashed baseline at the range's start, no grid, no y-axis:
// hovering scrubs it and hands the day back to the page.
export function ValueChart<T extends { ts: number; snapshot_date: string }>({
  data,
  dataKey,
  name,
  estimateKey,
  onScrub,
}: ValueChartProps<T>) {
  const formatTick = axisDateFormatter(data.at(0)?.snapshot_date, data.at(-1)?.snapshot_date);
  // A finger moving mostly up or down is scrolling the page past the chart, not scrubbing it.
  const touch = useRef<{ x: number; y: number; scroll: boolean } | null>(null);
  // useId's colons break url(#…) references.
  const fillId = `value-fill-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const start = startValue(data, dataKey);
  return (
    // A lifted finger ends the scrub: recharts' touch end never calls onMouseLeave.
    <div
      className="h-full w-full"
      onTouchStartCapture={(e) => {
        const t = e.touches[0];
        touch.current = t ? { x: t.clientX, y: t.clientY, scroll: false } : null;
      }}
      onTouchMoveCapture={(e) => {
        const t = e.touches[0];
        if (t && touch.current && isVerticalSwipe(touch.current, t.clientX, t.clientY))
          touch.current.scroll = true;
      }}
      onTouchEnd={() => {
        touch.current = null;
        onScrub(null);
      }}
      onTouchCancel={() => {
        touch.current = null;
        onScrub(null);
      }}
    >
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart
          data={data}
          margin={{ top: 8, right: 24, bottom: 0, left: 24 }}
          onMouseMove={(state) =>
            onScrub(
              !touch.current?.scroll && state?.isTooltipActive && state.activeTooltipIndex != null
                ? state.activeTooltipIndex
                : null,
            )
          }
          onMouseLeave={() => onScrub(null)}
        >
          <XAxis
            dataKey="ts"
            type="number"
            scale="time"
            domain={["dataMin", "dataMax"]}
            tickFormatter={(ts: number) => formatTick(formatISODate(new Date(ts)))}
            tick={{
              fill: "var(--color-muted-foreground)",
              fontSize: 11,
              fontFamily: "var(--font-figure)",
            }}
            tickLine={false}
            axisLine={false}
            minTickGap={56}
            interval="preserveStartEnd"
          />
          <YAxis hide domain={["auto", "auto"]} />
          <defs>
            <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-foreground)" stopOpacity={0.14} />
              <stop offset="100%" stopColor="var(--color-foreground)" stopOpacity={0} />
            </linearGradient>
          </defs>
          {start != null && (
            <ReferenceLine
              y={start}
              stroke="var(--color-muted-foreground)"
              strokeOpacity={0.5}
              strokeWidth={1}
              strokeDasharray="2 4"
              ifOverflow="extendDomain"
            />
          )}
          <Area
            type="monotone"
            dataKey={dataKey}
            baseValue="dataMin"
            isAnimationActive={false}
            stroke="none"
            fill={`url(#${fillId})`}
            activeDot={false}
            tooltipType="none"
          />
          <Tooltip
            content={() => null}
            cursor={{ stroke: "var(--color-foreground)", strokeWidth: 1, strokeDasharray: "2 3" }}
          />
          <Line
            type="monotone"
            dataKey={dataKey}
            name={name}
            isAnimationActive={false}
            stroke="var(--color-foreground)"
            strokeWidth={2.5}
            dot={latestDot(data.length - 1)}
            activeDot={{
              r: 3,
              fill: "var(--color-foreground)",
              stroke: "var(--color-background)",
              strokeWidth: 1.5,
            }}
          />
          {estimateKey && (
            <Line
              type="linear"
              dataKey={estimateKey}
              name="Estimate"
              isAnimationActive={false}
              stroke="var(--color-muted-foreground)"
              strokeWidth={1}
              strokeDasharray="2 3"
              dot={false}
              activeDot={false}
              connectNulls
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
