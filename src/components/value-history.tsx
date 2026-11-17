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
import { useDayPrices } from "@/lib/use-performance";
import type { usePerformance } from "@/lib/use-performance";
import { rangeReturn, returnLine, sampleIndices, tradedValue } from "@/lib/range-return";
import { formatEur } from "@/lib/transactions";

type RangeChangeProps = Pick<ValueHistory, "delta" | "change" | "range"> &
  Partial<Pick<ValueHistory, "first" | "scrubbed">>;

type ChipPerformance = Pick<
  ReturnType<typeof usePerformance>,
  "isPending" | "unavailable" | "tradesByKey" | "measuredByKey" | "endPrices"
> & { kind?: "stock" | "crypto" } & {
  summary: Pick<ReturnType<typeof usePerformance>["summary"], "gain" | "change">;
};

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

// Days on the Return line: one price request each, so a sample of the range, not every day.
const RETURN_DAYS = 24;

/**
 * Performance over the chosen range: the gain since its first day without the money you added
 * or took out, as a broker's Performance view; it ends on the chip's figure (same trades, same
 * prices). Without usable trades there is no return to draw, so the value is shown instead.
 */
export function ValueHistoryChart({
  history,
  title,
  perf,
}: {
  history: ValueHistory;
  title: string;
  perf?: ChipPerformance;
}) {
  const { chartData, key, range, setRange, setScrubIndex } = history;
  const onReturn = perf != null && !perf.isPending && !perf.unavailable && tradesUsable(perf);
  const picked = sampleIndices(chartData.length, RETURN_DAYS);
  // The last day is today: today's prices, as the chip.
  const prices = useDayPrices(
    onReturn ? picked.slice(0, -1).map((i) => chartData[i]!.snapshot_date) : [],
    perf?.kind ?? "stock",
  );
  // Days before the first daily price can't be measured: the line starts where prices do.
  const from = Math.max(
    0,
    prices.findIndex((p) => p != null && p.size > 0),
  );
  const returnRows =
    onReturn && prices.every((p) => p != null)
      ? (() => {
          const trades = [...perf.tradesByKey.values()].flat();
          const kept = picked.slice(from);
          const gains = returnLine(
            trades,
            kept.map((at, i) => ({
              date: chartData[at]!.snapshot_date,
              prices: prices[from + i] ?? perf.endPrices,
            })),
          );
          return kept.map((at, i) => ({ ...chartData[at]!, at, return_eur: gains[i]! }));
        })()
      : undefined;
  if (chartData.length < 2) return null;
  const valueOf = (row: NetWorthRow) => row[key];
  return (
    <section aria-label={title} className="mb-8">
      <div className="-mx-1 h-64 sm:h-72" aria-busy={onReturn && returnRows == null}>
        {onReturn ? (
          returnRows &&
          (returnRows.length < 2 || prices.every((p) => p?.size === 0) ? (
            <p className="pt-24 text-center text-[0.9375rem] text-muted-foreground">
              No daily prices in this range yet.
            </p>
          ) : (
            <div
              className="h-full"
              role="img"
              aria-label={trendSummary("Return", 0, returnRows.at(-1)!.return_eur, formatEur)}
            >
              <ValueChart
                data={returnRows}
                dataKey="return_eur"
                name="Return"
                onScrub={(i) => setScrubIndex(i == null ? null : (returnRows[i]?.at ?? null))}
              />
            </div>
          ))
        ) : (
          <div
            className="h-full"
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
        )}
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
