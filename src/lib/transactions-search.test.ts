import { describe, expect, it } from "vitest";
import { searchPattern, totalsOf, type TransactionRow } from "./transactions";

const row = (p: Partial<TransactionRow>): TransactionRow => ({
  entry_reference: "r",
  account_uid: "a",
  booking_date: "2026-01-01",
  category: null,
  transaction_type: null,
  creditor_name: null,
  currency: "EUR",
  amount: null,
  signed_amount_eur: null,
  credit_debit_indicator: null,
  created_at: null,
  worth_it: null,
  personal_amount: null,
  owed_by: null,
  flow_type: "spend",
  refund_of: null,
  note: null,
  tags: [],
  ...p,
});

describe("searchPattern", () => {
  it("wraps the trimmed words in wildcards", () => {
    expect(searchPattern("  netflix ")).toBe("*netflix*");
  });

  // fails_when=a comma, bracket or quote reaches PostgREST's or=(…) list and breaks the query
  it("turns characters with a meaning in the or-list into one-character wildcards", () => {
    expect(searchPattern('Smith, J. (UK) "x"')).toBe("*Smith__J___UK___x_*");
  });

  it("does not let a typed % or _ or * widen the match beyond one character", () => {
    expect(searchPattern("50%_off*")).toBe("*50__off_*");
  });
});

describe("totalsOf", () => {
  it("adds money in and money out apart", () => {
    const rows = [
      row({ amount: 100, signed_amount_eur: 100 }),
      row({ amount: 30, signed_amount_eur: -30 }),
      row({ amount: 20, signed_amount_eur: -20 }),
    ];
    expect(totalsOf(rows)).toEqual({ income: 100, expenses: 50 });
  });

  it("counts only my share of a split charge, in euros", () => {
    // 100 USD = 92 EUR, my share 25 USD → 23 EUR
    expect(totalsOf([row({ amount: 100, personal_amount: 25, signed_amount_eur: -92 })])).toEqual({
      income: 0,
      expenses: 23,
    });
  });

  it("skips rows without a euro value and counts a zero-amount row in full", () => {
    expect(
      totalsOf([row({ signed_amount_eur: null }), row({ amount: 0, signed_amount_eur: -5 })]),
    ).toEqual({ income: 0, expenses: 5 });
  });
});
