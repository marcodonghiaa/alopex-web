import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// jsdom has no ResizeObserver; the line itself is not under test.
vi.mock("recharts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("recharts")>()),
  ResponsiveContainer: () => null,
}));
// Each sampled day's prices: 100 for X, as on the range's first day.
const dayPrices = vi.fn((dates: Array<string>) => dates.map(() => new Map([["X", 100]])));
vi.mock("@/lib/use-performance", () => ({
  useDayPrices: (dates: Array<string>) => dayPrices(dates),
}));

import { RangeChange, ValueHistoryChart, rangeChip } from "./value-history";
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
// Bought 10 at 100 before the range; 10 more on 16 Jan. Price 100 on 1 Jan, 105 now.
const trade = (trade_date: string, shares: number, key = "X") => ({
  kind: "stock",
  key,
  side: "buy",
  trade_date,
  shares,
  price_eur: 100,
  fee_eur: 0,
  id: trade_date + key,
});
const perf = (over: Partial<Parameters<typeof rangeChip>[1]> = {}) => ({
  isPending: false,
  unavailable: false,
  tradesByKey: new Map([["X", [trade("2025-06-01", 10), trade("2026-01-16", 10)]]]),
  measuredByKey: new Map([["X", { state: "ok" as const, gain: 0, base: 1, change: 0 }]]),
  summary: { gain: 1234, change: 0.25 },
  endPrices: new Map([["X", 105]]),
  ...over,
});
const startPrices = new Map([["X", 100]]);

// protects=the chip is the return, not money added; fails_when=a savings plan reads as +75% YTD
describe("rangeChip", () => {
  it("is the return of what your trades hold, without money added", () => {
    // 1000 at the start, 1000 added on 16 Jan, 2100 now: 100 gained on 1000 + 1000 × 15/30.
    expect(rangeChip(history(), perf(), startPrices)).toEqual({
      value: 100,
      percent: 100 / 1500,
      className: "text-positive",
    });
    const down = perf({ endPrices: new Map([["X", 95]]) });
    expect(rangeChip(history(), down, startPrices)?.className).toBe("text-negative");
  });

  // protects=money in a holding with no trades isn't a gain or a loss; fails_when=USDC cashed out on
  // an exchange reads as a €2.4k loss (Marco: Crypto ▼ 52.73% YTD), whatever the chart shows
  it("leaves out holdings without trades, whatever the chart's value does", () => {
    const chart = history({ first: point("2026-01-01", 5000), shownEur: 0 });
    const untraded = new Map<string, Measured>([
      ["X", { state: "ok", gain: 0, base: 1, change: 0 }],
      ["USDC", { state: "no_trades" }],
    ]);
    expect(rangeChip(chart, perf({ measuredByKey: untraded }), startPrices)?.value).toBeCloseTo(
      100,
    );
  });

  it("is absent while scrubbing: there is no price per holding for that day", () => {
    const scrubbed = point("2026-01-10", 1050);
    expect(rangeChip(history({ scrubbed, shownEur: 1050 }), perf(), startPrices)).toBeUndefined();
  });

  it("is absent without a start, or while the start prices load", () => {
    expect(
      rangeChip(history({ first: undefined, chartData: [] }), perf(), startPrices),
    ).toBeUndefined();
    expect(rangeChip(history(), perf(), undefined)).toBeUndefined();
  });

  it("is absent while trades load, or when they can't", () => {
    expect(rangeChip(history(), perf({ isPending: true }), startPrices)).toBeUndefined();
    expect(rangeChip(history(), perf({ unavailable: true }), startPrices)).toBeUndefined();
  });

  it("is absent when no trades are imported", () => {
    expect(rangeChip(history(), perf({ tradesByKey: new Map() }), startPrices)).toBeUndefined();
  });

  it("is absent when trades disagree with the shares you hold", () => {
    const off = new Map<string, Measured>([["X", { state: "mismatch", traded: 5, held: 10 }]]);
    expect(rangeChip(history(), perf({ measuredByKey: off }), startPrices)).toBeUndefined();
  });

  // protects=ALL matches the broker's all-time gain; fails_when=imported history holds value with
  // no trades (a bond in an old spreadsheet), whose disappearance reads as a loss (Marco: €8.6k
  // instead of €12.6k)
  it("on ALL is the all-time return from your trades", () => {
    expect(rangeChip(history({ range: "ALL" }), perf(), undefined)).toEqual({
      value: 1234,
      percent: 0.25,
      className: "text-positive",
    });
    expect(
      rangeChip(history({ range: "ALL" }), perf({ summary: { gain: 0, change: null } }), undefined),
    ).toBeUndefined();
  });
});

// protects=a Value | Return switch on the chart, like a broker's Performance view; fails_when=
// the line keeps showing money added as growth while the chip says otherwise
describe("ValueHistoryChart", () => {
  const chart = history({
    chartData: [
      { ...point("2026-01-01", 1000), ts: 1 },
      { ...point("2026-01-16", 2000), ts: 2 },
      { ...point("2026-01-31", 2100), ts: 3 },
    ] as ValueHistory["chartData"],
    setRange: () => {},
    setScrubIndex: () => {},
  });

  // protects=Investing shows performance only (Marco); fails_when=a value chart or switch returns
  it("draws only the return, with no switch to the value", () => {
    render(<ValueHistoryChart history={chart} title="Portfolio value" perf={perf()} />);
    expect(screen.queryByRole("radio", { name: "Value" })).toBeNull();
    expect(screen.queryByRole("img", { name: /^Portfolio value/ })).toBeNull();
  });

  it("on Return draws the gain without money added, ending at today's prices", () => {
    render(<ValueHistoryChart history={chart} title="Portfolio value" perf={perf()} />);
    // Today's price is 105 on 20 shares; every earlier day is priced at 100.
    expect(
      screen.getByRole("img", { name: /^Return: rose from €0\.00 to €100\.00/ }),
    ).toBeInTheDocument();
    expect(dayPrices).toHaveBeenLastCalledWith(["2026-01-01", "2026-01-16"]);
  });

  it("without usable trades draws the value, as there is no return to draw", () => {
    render(
      <ValueHistoryChart
        history={chart}
        title="Portfolio value"
        perf={perf({ tradesByKey: new Map() })}
      />,
    );
    expect(
      screen.getByRole("img", { name: /Portfolio value: rose from €1,000/ }),
    ).toBeInTheDocument();
  });

  // protects=days before the first daily price aren't drawn as "no gain"; fails_when=a range that
  // starts before prices were kept reads as a flat line at zero
  it("starts the return on the first day with prices", () => {
    dayPrices.mockImplementation((dates) =>
      dates.map((d) => (d === "2026-01-01" ? new Map() : new Map([["X", 100]]))),
    );
    const { rerender } = render(
      <ValueHistoryChart history={chart} title="Portfolio value" perf={perf()} />,
    );
    // From 16 Jan (20 shares at 100) to today (105): 100.
    expect(
      screen.getByRole("img", { name: /^Return: rose from €0\.00 to €100\.00/ }),
    ).toBeInTheDocument();
    dayPrices.mockImplementation((dates) => dates.map(() => new Map()));
    rerender(<ValueHistoryChart history={{ ...chart }} title="Portfolio value" perf={perf()} />);
    expect(screen.getByText("No daily prices in this range yet.")).toBeInTheDocument();
    dayPrices.mockImplementation((dates) => dates.map(() => new Map([["X", 100]])));
  });

  it("waits for every day's prices before drawing the return", () => {
    dayPrices.mockImplementation((dates) => dates.map(() => undefined as never));
    render(<ValueHistoryChart history={chart} title="Portfolio value" perf={perf()} />);
    expect(screen.queryByRole("img", { name: /^Return/ })).toBeNull();
    dayPrices.mockRestore();
  });
});
