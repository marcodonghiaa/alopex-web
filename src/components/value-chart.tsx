import { useRef } from "react";
import { ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
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

// One line, no grid, no y-axis: hovering scrubs it and hands the day back to the page.
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
