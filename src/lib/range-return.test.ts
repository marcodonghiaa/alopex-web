import { describe, expect, it } from "vitest";
import { rangeReturn } from "./range-return";

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

  it("has no percent when nothing was invested", () => {
    expect(
      rangeReturn({ date: "2026-01-01", value: 0 }, { date: "2026-01-31", value: 0 }, []).percent,
    ).toBeNull();
  });
});
