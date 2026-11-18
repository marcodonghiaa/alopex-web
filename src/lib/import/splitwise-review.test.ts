import { describe, expect, it } from "vitest";
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
