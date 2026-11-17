import { describe, expect, it } from "vitest";
import { makeRate } from "./fx";

describe("makeRate with a gap limit", () => {
  it("won't use a rate older than the limit", () => {
    const rate = makeRate([{ currency: "USD", date: "2026-01-01", rate_to_eur: 0.9 }], 10);
    expect(rate("USD", "2026-01-11")).toBe(0.9);
    expect(rate("USD", "2026-01-12")).toBeNull();
  });
});

describe("makeRate", () => {
  const rate = makeRate([
    { currency: "USD", date: "2026-08-10", rate_to_eur: 0.9 },
    { currency: "USD", date: "2026-08-14", rate_to_eur: 0.92 },
    { currency: "CHF", date: "2026-08-14", rate_to_eur: 1.04 },
  ]);

  // protects=the rate used to compare Splitwise amounts to the bank; fails_when=a later rate is
  // used for an earlier date, or EUR is not 1
  it("uses the latest rate on or before the date", () => {
    expect(rate("USD", "2026-08-14")).toBe(0.92);
    expect(rate("USD", "2026-08-13")).toBe(0.9);
    expect(rate("USD", "2026-09-30")).toBe(0.92);
  });
  it("returns null when there is no rate yet, and 1 for euros", () => {
    expect(rate("USD", "2026-08-09")).toBeNull();
    expect(rate("GBP", "2026-08-14")).toBeNull();
    expect(rate("EUR", "2020-01-01")).toBe(1);
  });
});

describe("makeRate with rows in any order", () => {
  it("still uses the latest rate on or before the date", () => {
    const rate = makeRate([
      { currency: "USD", date: "2026-08-14", rate_to_eur: 0.92 },
      { currency: "USD", date: "2026-08-10", rate_to_eur: 0.9 },
    ]);
    expect(rate("USD", "2026-08-13")).toBe(0.9);
    expect(rate("USD", "2026-08-15")).toBe(0.92);
  });
});
