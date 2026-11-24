import { describe, expect, it } from "vitest";
import { generateDemoData } from "./generate";
import { deriveViews } from "./views";
import type { Tx } from "./helpers";

// H119: the demo rebuilds the views in memory; these follow the SQL definitions on one fixture.
const NOW = new Date("2026-10-20T12:00:00Z");
const base = (over: Partial<Tx> & Pick<Tx, "entry_reference">): Tx => ({
  ...generateDemoData(NOW).transactions[0]!,
  deleted_at: null,
  refund_of: null,
  custom_name: null,
  personal_amount: null,
  currency: "EUR",
  ...over,
});

describe("demo views follow the SQL definitions", () => {
  it("counts only my share of income, and never a debit marked income", () => {
    const db = generateDemoData(NOW);
    db.transactions = [
      base({
        entry_reference: "in-split",
        booking_date: "2026-09-05",
        amount: 100,
        personal_amount: 40,
        credit_debit_indicator: "CRDT",
        flow_type: "income",
      }),
      base({
        entry_reference: "in-debit",
        booking_date: "2026-09-06",
        amount: 25,
        credit_debit_indicator: "DBIT",
        flow_type: "income",
      }),
    ];
    db.spend_history = [];
    const sept = deriveViews(db).v_income_vs_expenses_monthly.find((r) => r.month === "2026-09-01");
    expect(sept?.income_eur).toBe(40);
  });

  it("prices a subscription at my share and skips refunded or incoming rows", () => {
    const db = generateDemoData(NOW);
    const sub = { transaction_type: "Subscription", creditor_name: "Streamly", flow_type: "spend" };
    db.transactions = [
      base({ ...sub, entry_reference: "s1", booking_date: "2026-08-03", amount: 12 }),
      base({
        ...sub,
        entry_reference: "s2",
        booking_date: "2026-09-03",
        amount: 12,
        personal_amount: 6,
      }),
      base({
        ...sub,
        entry_reference: "s3",
        booking_date: "2026-10-03",
        amount: 12,
        flow_type: "refunded",
      }),
      base({
        ...sub,
        entry_reference: "s4",
        booking_date: "2026-10-04",
        amount: 12,
        credit_debit_indicator: "CRDT",
      }),
    ];
    db.subscription_billing_overrides = [];
    const [s] = deriveViews(db).v_subscriptions;
    expect(s).toMatchObject({ charge_count: 2, last_charged: "2026-09-03", signed_amount_eur: -6 });
  });

  it("leaves Splitwise shares linked to a bank row out of v_splitwise_eur", () => {
    const db = generateDemoData(NOW);
    const [first] = db.splitwise_expenses;
    db.splitwise_expenses = [
      { ...first!, id: "free", linked_entry_reference: null },
      { ...first!, id: "linked", linked_entry_reference: "bank-1" },
    ];
    expect(deriveViews(db).v_splitwise_eur.map((s) => s.id)).toEqual(["free"]);
  });

  it("counts only my share of money out as spend; a share of 0 or a credit keeps the import", () => {
    const db = generateDemoData(NOW);
    db.transactions = [
      base({
        entry_reference: "for-others",
        booking_date: "2026-09-05",
        amount: 30,
        personal_amount: 0,
        flow_type: "spend",
        category: "Dining",
      }),
      base({
        entry_reference: "credit",
        booking_date: "2026-09-06",
        amount: 20,
        credit_debit_indicator: "CRDT",
        flow_type: "spend",
        category: "Dining",
      }),
    ];
    db.splitwise_expenses = [];
    db.spend_history = [
      { ...db.spend_history[0]!, month: "2026-09-01", category: "Rent", spend_eur: 500 },
    ];
    const sept = deriveViews(db).v_spend_by_category_monthly.filter(
      (r) => r.month === "2026-09-01",
    );
    expect(sept.map((r) => [r.category, r.spend_eur])).toEqual([["Rent", 500]]);
  });
});
