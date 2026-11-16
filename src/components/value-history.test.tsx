import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { RangeChange, rangeChip } from "./value-history";
import type { ValueHistory } from "@/lib/use-value-history";
import type { Measured } from "@/lib/trades";

type Point = NonNullable<ValueHistory["first"]>;
const day = (snapshot_date: string) => ({ snapshot_date }) as Point;

describe("RangeChange", () => {
  // iOS view board: the amount and % moved into the chip beside the figure; only the range stays.
  it("names the selected range only, as on Net Worth", () => {
    render(<RangeChange delta={200} change={0.2} first={day("2025-12-31")} range="YTD" />);
    expect(screen.getByText("Year to date")).toBeInTheDocument();
    expect(screen.queryByText(/€200/)).toBeNull();
  });

  it("while scrubbing, names the days it spans", () => {
    render(
      <RangeChange
        delta={-50}
        change={-0.05}
        first={day("2026-10-10")}
        scrubbed={day("2026-11-01")}
        range="1M"
      />,
    );
    expect(screen.getByText(/10 Oct 2026 – 1 Nov 2026/)).toBeInTheDocument();
    expect(screen.queryByText("Past month")).not.toBeInTheDocument();
  });

  it("says nothing without a start to compare with", () => {
    const { container } = render(
      <RangeChange delta={null} change={null} first={undefined} range="ALL" />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

const point = (snapshot_date: string, portfolio_total_eur: number) =>
  ({ snapshot_date, portfolio_total_eur }) as Point;
const history = (over: Partial<ValueHistory> = {}) =>
  ({
    key: "portfolio_total_eur",
    chartData: [point("2026-01-01", 1000), point("2026-01-31", 2100)],
    first: point("2026-01-01", 1000),
    scrubbed: undefined,
    shownEur: 2100,
    range: "YTD",
    ...over,
  }) as ValueHistory;
const buy = {
  kind: "stock",
  key: "X",
  side: "buy",
  trade_date: "2026-01-16",
  shares: 10,
  price_eur: 100,
  fee_eur: 0,
  id: "1",
};
const perf = (over: Partial<Parameters<typeof rangeChip>[1]> = {}) => ({
  isPending: false,
  unavailable: false,
  tradesByKey: new Map([["X", [buy]]]),
  measuredByKey: new Map([["X", { state: "ok" as const, gain: 0, base: 1, change: 0 }]]),
  summary: { gain: 1234, change: 0.25 },
  ...over,
});

// protects=the chip is the return, not money added; fails_when=a savings plan reads as +75% YTD
describe("rangeChip", () => {
  it("is the return without money added, toned by the return band", () => {
    expect(rangeChip(history(), perf())).toEqual({
      value: 100,
      percent: 100 / 1500,
      className: "text-positive",
    });
    expect(rangeChip(history({ shownEur: 1900 }), perf())?.className).toBe("text-negative");
  });

  it("ends on the scrubbed day", () => {
    const scrubbed = point("2026-01-10", 1050);
    expect(rangeChip(history({ scrubbed, shownEur: 1050 }), perf())?.value).toBeCloseTo(50);
  });

  it("is absent without a start to compare with", () => {
    expect(rangeChip(history({ first: undefined, chartData: [] }), perf())).toBeUndefined();
  });

  it("is absent while trades load, or when they can't", () => {
    expect(rangeChip(history(), perf({ isPending: true }))).toBeUndefined();
    expect(rangeChip(history(), perf({ unavailable: true }))).toBeUndefined();
  });

  it("is absent when no trades are imported", () => {
    expect(rangeChip(history(), perf({ tradesByKey: new Map() }))).toBeUndefined();
  });

  it("is absent when some holdings miss trades, so money added would read as gain", () => {
    const missing = new Map<string, Measured>([
      ["X", { state: "ok", gain: 0, base: 1, change: 0 }],
      ["Y", { state: "no_trades" }],
    ]);
    expect(rangeChip(history(), perf({ measuredByKey: missing }))).toBeUndefined();
    const off = new Map<string, Measured>([["X", { state: "mismatch", traded: 5, held: 10 }]]);
    expect(rangeChip(history(), perf({ measuredByKey: off }))).toBeUndefined();
  });

  it("still shows when the only gap is a leftover or a missing price", () => {
    const fine = new Map<string, Measured>([
      ["X", { state: "dust" }],
      ["Y", { state: "no_price" }],
    ]);
    expect(rangeChip(history(), perf({ measuredByKey: fine }))).toBeDefined();
  });

  // protects=ALL matches the broker's all-time gain; fails_when=imported history holds value with
  // no trades (a bond in an old spreadsheet), whose disappearance reads as a loss (Marco: €8.6k
  // instead of €12.6k)
  it("on ALL is the all-time return from your trades, not from the chart's first day", () => {
    expect(rangeChip(history({ range: "ALL" }), perf())).toEqual({
      value: 1234,
      percent: 0.25,
      className: "text-positive",
    });
  });

  it("on ALL while scrubbing is the change up to that day, like the other ranges", () => {
    const scrubbed = point("2026-01-10", 1050);
    expect(
      rangeChip(history({ range: "ALL", scrubbed, shownEur: 1050 }), perf())?.value,
    ).toBeCloseTo(50);
  });

  it("on ALL is absent when trades can't give a return", () => {
    expect(
      rangeChip(history({ range: "ALL" }), perf({ summary: { gain: 0, change: null } })),
    ).toBeUndefined();
  });
});
