import { describe, expect, it } from "vitest";
import { splitSmallBalances } from "./small-balances";

// iOS view board: coins worth under €1 hide behind a "Show N small balances" link.
describe("splitSmallBalances", () => {
  const a = (symbol: string, valueEur: number) => ({ symbol, valueEur });

  it("keeps €1 and up, sets aside the rest in order", () => {
    const { shown, small } = splitSmallBalances([
      a("BTC", 900),
      a("ETH", 1),
      a("SHIB", 0.4),
      a("X", 0),
    ]);
    expect(shown.map((x) => x.symbol)).toEqual(["BTC", "ETH"]);
    expect(small.map((x) => x.symbol)).toEqual(["SHIB", "X"]);
  });

  it("shows everything when every coin is small, so the list is never empty", () => {
    const { shown, small } = splitSmallBalances([a("SHIB", 0.4)]);
    expect(shown.map((x) => x.symbol)).toEqual(["SHIB"]);
    expect(small).toEqual([]);
  });
});
