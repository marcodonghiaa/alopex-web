import { useMemo, useState } from "react";
import { chartPoints, inRange, type ChartRange } from "@/lib/net-worth";
import { useNetWorthSources } from "@/lib/net-worth-queries";

type ValueKey = "portfolio_total_eur" | "crypto_total_eur";

/**
 * One slice of net worth (portfolio or crypto) over time, from the same merged history as the
 * Net Worth page (shared query cache). Scrubbing the chart swaps `shownEur` to that day.
 */
export function useValueHistory(key: ValueKey, todayEur: number) {
  const [range, setRange] = useState<ChartRange>("YTD");
  const { live, history, reconstructed, rows } = useNetWorthSources();
  // Same ranges as Net Worth. No 1D: history is one point a day, so a day is a two-point line.
  const chartData = useMemo(() => inRange(chartPoints(rows), range), [rows, range]);
  const [scrubIndex, setScrubIndex] = useState<number | null>(null);
  const scrubbed = scrubIndex != null ? chartData.at(scrubIndex) : undefined;
  const first = chartData.at(0);

  const shownEur = scrubbed?.[key] ?? todayEur;
  const delta = first ? shownEur - first[key] : null;
  const change = delta != null && first && first[key] !== 0 ? delta / Math.abs(first[key]) : null;
  const error = [live, history, reconstructed].find((q) => q.isError)?.error;

  return {
    key,
    range,
    setRange,
    chartData,
    first,
    scrubbed,
    setScrubIndex,
    shownEur,
    delta,
    change,
    error,
  };
}

export type ValueHistory = ReturnType<typeof useValueHistory>;
