import { SegmentedControl } from "@/components/segmented-control";
import { ValueChart } from "@/components/value-chart";
import { trendSummary } from "@/lib/chart-summary";
import { formatDay } from "@/lib/date";
import { CHART_RANGES, RANGE_LABEL } from "@/lib/net-worth";
import type { NetWorthRow } from "@/lib/net-worth";
import { RETURN_NOISE_BAND } from "@/lib/performance";
import type { HeadlineChange } from "@/components/headline-figure";
import { TONE_TEXT, toneOf } from "@/lib/tone";
import type { ValueHistory } from "@/lib/use-value-history";
import type { usePerformance } from "@/lib/use-performance";
import { rangeReturn, tradedValue } from "@/lib/range-return";
import { formatEur } from "@/lib/transactions";

type RangeChangeProps = Pick<ValueHistory, "delta" | "change" | "range"> &
  Partial<Pick<ValueHistory, "first" | "scrubbed">>;

type ChipPerformance = Pick<
  ReturnType<typeof usePerformance>,
  "isPending" | "unavailable" | "tradesByKey" | "measuredByKey" | "endPrices"
> & { summary: Pick<ReturnType<typeof usePerformance>["summary"], "gain" | "change"> };

// Trades that disagree with the shares you hold can't value what you held: no return at all.
const tradesUsable = (perf: ChipPerformance) =>
  perf.tradesByKey.size > 0 &&
  [...perf.measuredByKey.values()].every((m) => m.state !== "mismatch");

const chip = (gain: number, percent: number | null): HeadlineChange | undefined =>
  percent == null
    ? undefined
    : { value: gain, percent, className: TONE_TEXT[toneOf(percent, RETURN_NOISE_BAND)] };

/**
 * The chip beside the hero figure: the range's return of what your trades hold, valued at each
 * holding's price on the range's first day and today, with buys and sales in between taken out.
 * Holdings without trades (cash-like coins on an exchange, an old spreadsheet's bonds) are left
 * out: their money moving in or out would read as a gain or a loss. ALL is the all-time return
 * from the trades. Absent while scrubbing, since there is no price per holding for that day.
 */
export function rangeChip(
  { chartData, first, scrubbed, range }: ValueHistory,
  perf: ChipPerformance,
  startPrices: Map<string, number> | undefined,
): HeadlineChange | undefined {
  const end = chartData.at(-1);
  if (first == null || end == null || scrubbed != null) return undefined;
  if (perf.isPending || perf.unavailable || !tradesUsable(perf)) return undefined;
  if (range === "ALL") return chip(perf.summary.gain, perf.summary.change);
  if (startPrices == null) return undefined;
  const trades = [...perf.tradesByKey.values()].flat();
  const { gain, percent } = rangeReturn(
    { date: first.snapshot_date, value: tradedValue(trades, first.snapshot_date, startPrices) },
    { date: end.snapshot_date, value: tradedValue(trades, end.snapshot_date, perf.endPrices) },
    trades,
  );
  return chip(gain, percent);
}

/**
 * Names the range the chip beside the figure covers, or the days from the range start to the
 * scrubbed day.
 */
export function RangeChange({ delta, change, first, scrubbed, range }: RangeChangeProps) {
  if (delta == null || change == null || first == null) return null;
  return (
    <p className="mt-1 text-[0.9375rem] text-muted-foreground">
      {scrubbed
        ? `${formatDay(first.snapshot_date)} – ${formatDay(scrubbed.snapshot_date)}`
        : RANGE_LABEL[range]}
    </p>
  );
}

// The holding's value over the chosen range. A value change counts purchases and sales, so the
// price return is shown separately (performance section), not here.
export function ValueHistoryChart({ history, title }: { history: ValueHistory; title: string }) {
  const { chartData, key, range, setRange, setScrubIndex } = history;
  if (chartData.length < 2) return null;
  const valueOf = (row: NetWorthRow) => row[key];
  return (
    <section aria-label={title} className="mb-8">
      <div
        className="-mx-1 h-64 sm:h-72"
        role="img"
        aria-label={trendSummary(
          title,
          valueOf(chartData[0]!),
          valueOf(chartData.at(-1)!),
          formatEur,
        )}
      >
        <ValueChart data={chartData} dataKey={key} name={title} onScrub={setScrubIndex} />
      </div>
      <div className="mt-4 flex">
        <SegmentedControl
          label="Chart range"
          options={CHART_RANGES.map((r) => ({ value: r, label: r }))}
          value={range}
          onChange={setRange}
        />
      </div>
    </section>
  );
}
