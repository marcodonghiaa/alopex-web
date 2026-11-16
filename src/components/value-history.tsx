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
import { rangeReturn } from "@/lib/range-return";
import { formatEur } from "@/lib/transactions";

type RangeChangeProps = Pick<ValueHistory, "delta" | "change" | "range"> &
  Partial<Pick<ValueHistory, "first" | "scrubbed">>;

type ChipPerformance = Pick<
  ReturnType<typeof usePerformance>,
  "isPending" | "unavailable" | "tradesByKey" | "measuredByKey"
>;

// A holding with no trades, or fewer shares traded than held: money added there can't be told
// apart from gain, so no return is shown at all.
const tradesComplete = (perf: ChipPerformance) =>
  perf.tradesByKey.size > 0 &&
  [...perf.measuredByKey.values()].every((m) => m.state !== "no_trades" && m.state !== "mismatch");

/**
 * The chip beside the hero figure: the range's return with the money you added or took out
 * removed (from your trades). Absent when trades are missing, since a deposit would read as gain.
 */
export function rangeChip(
  { key, chartData, first, scrubbed, shownEur }: ValueHistory,
  perf: ChipPerformance,
): HeadlineChange | undefined {
  const end = scrubbed ?? chartData.at(-1);
  if (first == null || end == null || perf.isPending || perf.unavailable) return undefined;
  if (!tradesComplete(perf)) return undefined;
  const { gain, percent } = rangeReturn(
    { date: first.snapshot_date, value: first[key] },
    { date: end.snapshot_date, value: shownEur },
    [...perf.tradesByKey.values()].flat(),
  );
  if (percent == null) return undefined;
  return { value: gain, percent, className: TONE_TEXT[toneOf(percent, RETURN_NOISE_BAND)] };
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
