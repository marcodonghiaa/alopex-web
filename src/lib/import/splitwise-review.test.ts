import { describe, expect, it } from "vitest";
import { makeRate } from "@/lib/fx";
import { defaultSelection, toBankTx, type BankRowFromDb } from "./splitwise-review";

const dbRow = (over: Partial<BankRowFromDb> = {}): BankRowFromDb => ({
  account_uid: "acc",
  entry_reference: "e1",
  booking_date: "2026-08-16",
  amount: 12.34,
  currency: "USD",
  credit_debit_indicator: "DBIT",
  personal_amount: null,
  flow_type: null,
  deleted_at: null,
  ...over,
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

// polish-3 #1: the To link page looks a rate up for many (item, bank row) pairs
describe("makeRate at scale", () => {
  it("answers 100k lookups over 3000 rates quickly, and the same as a scan", () => {
    const rows = Array.from({ length: 3000 }, (_, i) => ({
      currency: i % 2 ? "CHF" : "USD",
      date: new Date(Date.UTC(2020, 0, 1) + Math.floor(i / 2) * 86_400_000)
        .toISOString()
        .slice(0, 10),
      rate_to_eur: 1 + i / 10_000,
    }));
    const rate = makeRate(rows.slice().reverse());
    expect(rate("CHF", "2019-12-31")).toBeNull();
    expect(rate("USD", "2020-01-01")).toBe(1);
    expect(rate("CHF", "2020-01-01")).toBe(1.0001);
    expect(rate("CHF", "2020-01-02")).toBe(1.0003);
    expect(rate("USD", "2030-01-01")).toBe(1.2998);
    const start = performance.now();
    for (let i = 0; i < 100_000; i++) rate(i % 2 ? "CHF" : "USD", `2022-0${1 + (i % 9)}-15`);
    expect(performance.now() - start).toBeLessThan(500);
  });
});

describe("toBankTx", () => {
  it("converts a bank row to cents and a direction", () => {
    expect(toBankTx(dbRow({ personal_amount: 5 }))).toEqual({
      entryReference: "e1",
      accountUid: "acc",
      bookingDate: "2026-08-16",
      amountCents: 1234,
      currency: "USD",
      direction: "DBIT",
      personalAmountCents: 500,
      flowType: null,
      name: null,
    });
  });
  it("keeps who was paid, for the user to recognise the payment", () => {
    expect(toBankTx(dbRow({ creditor_name: "Uber" }))?.name).toBe("Uber");
  });
  it("skips deleted rows and rows it cannot place", () => {
    expect(toBankTx(dbRow({ deleted_at: "2026-09-01" }))).toBeNull();
    expect(toBankTx(dbRow({ booking_date: null }))).toBeNull();
    expect(toBankTx(dbRow({ account_uid: null }))).toBeNull();
    expect(toBankTx(dbRow({ credit_debit_indicator: null }))).toBeNull();
  });
});

describe("defaultSelection", () => {
  it("ticks only the sure matches", () => {
    const picked = defaultSelection([
      { row: 3, confidence: "likely" },
      { row: 4, confidence: "ambiguous" },
    ]);
    expect([...picked]).toEqual([3]);
  });
});
