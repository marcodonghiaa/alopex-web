import { describe, expect, it } from "vitest";
import { rangeReturn, returnLine, sampleIndices, tradedValue } from "./range-return";

const trade = (
  side: string,
  trade_date: string,
  shares: number,
  price_eur: number,
  fee_eur = 0,
) => ({
  kind: "stock",
  key: "X",
  side,
  trade_date,
  shares,
  price_eur,
  fee_eur,
});

// protects=the Portfolio/Crypto chip reads as a return, not as money you added;
// fails_when=buys in the range count as gains (iOS view board: "+75%" YTD from a savings plan)
describe("rangeReturn", () => {
  it("is the plain change when nothing was bought or sold", () => {
    const r = rangeReturn(
      { date: "2026-01-01", value: 1000 },
      { date: "2026-12-31", value: 1100 },
      [],
    );
    expect(r.gain).toBeCloseTo(100);
    expect(r.percent).toBeCloseTo(0.1);
  });

  it("takes money added out of the gain, weighted by how long it was invested", () => {
    // 1000 at the start, 1000 more bought half way, 2100 at the end: 100 gained.
    const r = rangeReturn(
      { date: "2026-01-01", value: 1000 },
      { date: "2026-01-31", value: 2100 },
      [trade("buy", "2026-01-16", 10, 100)],
    );
    expect(r.gain).toBeCloseTo(100);
    expect(r.percent).toBeCloseTo(100 / 1500);
  });

  it("counts a sale as money taken out, and fees as a cost", () => {
    const r = rangeReturn({ date: "2026-01-01", value: 1000 }, { date: "2026-01-31", value: 600 }, [
      trade("sell", "2026-01-31", 5, 100, 2),
      trade("buy", "2026-01-31", 1, 10, 1),
    ]);
    // Out 498 net of fee, in 11 with fee: net flow −487, so the gain is 600 − 1000 + 487.
    expect(r.gain).toBeCloseTo(87);
  });

  it("ignores trades outside the range, and on its first day", () => {
    const r = rangeReturn(
      { date: "2026-01-01", value: 1000 },
      { date: "2026-01-31", value: 1000 },
      [
        trade("buy", "2025-12-31", 1, 500),
        trade("buy", "2026-01-01", 1, 500),
        trade("buy", "2026-02-01", 1, 500),
      ],
    );
    expect(r.gain).toBe(0);
  });

  it("counts tax on a trade like a fee, and income paid inside the range only", () => {
    const r = rangeReturn(
      { date: "2026-01-01", value: 1000 },
      { date: "2026-01-31", value: 1000 },
      [{ ...trade("sell", "2026-01-31", 5, 100, 2), tax_eur: 3 }],
      [
        { event_date: "2026-01-01", amount_eur: 50 }, // already in the start
        { event_date: "2026-01-15", amount_eur: 8 },
        { event_date: "2026-02-01", amount_eur: 50 }, // after the end
      ],
    );
    // Out 495 net of fee and tax: 1000 − 1000 + 495, plus the 8 paid in the range.
    expect(r.gain).toBeCloseTo(503);
  });

  it("has no percent when nothing was invested", () => {
    expect(
      rangeReturn({ date: "2026-01-01", value: 0 }, { date: "2026-01-31", value: 0 }, []).percent,
    ).toBeNull();
  });
});

// protects=the chip only counts what your trades explain; fails_when=a coin with no trades (USDC
// cashed out on an exchange) leaves the value and reads as a loss (Marco: Crypto ▼ 52.73% YTD)
describe("tradedValue", () => {
  const t = (key: string, side: string, trade_date: string, shares: number, price_eur: number) => ({
    ...trade(side, trade_date, shares, price_eur),
    key,
  });

  it("is the shares your trades hold on that day, at that day's price", () => {
    const trades = [t("BTC", "buy", "2025-06-01", 2, 50), t("BTC", "sell", "2026-03-01", 1, 80)];
    const prices = new Map([["BTC", 100]]);
    expect(tradedValue(trades, "2026-01-01", prices)).toBe(200);
    expect(tradedValue(trades, "2026-03-01", prices)).toBe(100);
  });

  it("leaves out what no trade holds", () => {
    const prices = new Map([
      ["BTC", 100],
      ["USDC", 1],
    ]);
    expect(tradedValue([t("BTC", "buy", "2025-06-01", 1, 50)], "2026-01-01", prices)).toBe(100);
  });

  it("falls back to the nearest trade's price when the day has none", () => {
    // Sold during the range and gone from your holdings: no price for the start day.
    const trades = [t("NOVO", "buy", "2025-06-01", 4, 80), t("NOVO", "sell", "2026-03-04", 4, 30)];
    expect(tradedValue(trades, "2026-01-01", new Map())).toBe(4 * 80);
    expect(tradedValue([t("X", "buy", "2026-02-01", 1, 9)], "2026-01-01", new Map())).toBe(0);
  });
});

// protects=the Return line samples the range ends; fails_when=the line stops short of today
describe("sampleIndices", () => {
  it("keeps the first and last day and spaces the rest evenly", () => {
    expect(sampleIndices(10, 4)).toEqual([0, 3, 6, 9]);
  });

  it("keeps every day when there are fewer than asked", () => {
    expect(sampleIndices(3, 24)).toEqual([0, 1, 2]);
  });

  it("is empty for an empty range", () => {
    expect(sampleIndices(0, 24)).toEqual([]);
  });
});

// protects=the Return line is the gain without money added; fails_when=a buy reads as a jump
describe("returnLine", () => {
  const buys = [
    {
      key: "X",
      side: "buy" as const,
      trade_date: "2026-01-01",
      shares: 10,
      price_eur: 100,
      fee_eur: 0,
    },
    {
      key: "X",
      side: "buy" as const,
      trade_date: "2026-01-16",
      shares: 10,
      price_eur: 100,
      fee_eur: 0,
    },
  ];

  it("starts at zero and leaves the money you add out", () => {
    const line = returnLine(buys, [
      { date: "2026-01-10", prices: new Map([["X", 100]]) },
      { date: "2026-01-20", prices: new Map([["X", 100]]) },
      { date: "2026-01-31", prices: new Map([["X", 105]]) },
    ]);
    // 10 → 20 shares at 100: no gain; then 20 × 5 = 100.
    expect(line).toEqual([0, 0, 100]);
  });

  it("is empty without days", () => {
    expect(returnLine(buys, [])).toEqual([]);
  });
});
