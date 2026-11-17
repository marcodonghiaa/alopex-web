import { beforeEach, describe, expect, it, vi } from "vitest";

type Answer = { data: unknown; error: { message: string } | null };
const answers = vi.hoisted(() => ({
  transactions: [] as Array<Answer>,
  fx_rates: [] as Array<Answer>,
}));
const calls = vi.hoisted(() => [] as Array<[string, string, Array<unknown>]>);
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: "transactions" | "fx_rates") => {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "gte", "lte", "in", "is", "limit", "order", "range"])
        q[m] = (...args: Array<unknown>) => {
          calls.push([table, m, args]);
          return q;
        };
      q["then"] = (resolve: (v: unknown) => void) =>
        resolve(answers[table].shift() ?? { data: [], error: null });
      return q;
    },
  },
}));

import { fetchBankWindow } from "./splitwise-bank";

const bankRow = (over: Record<string, unknown> = {}) => ({
  account_uid: "a1",
  entry_reference: "e1",
  booking_date: "2026-11-11",
  amount: 60,
  currency: "EUR",
  credit_debit_indicator: "DBIT",
  personal_amount: null,
  flow_type: null,
  deleted_at: null,
  creditor_name: "Market",
  ...over,
});
const args = (table: string, method: string) =>
  calls.filter(([t, m]) => t === table && m === method).map(([, , a]) => a);

beforeEach(() => {
  calls.length = 0;
  answers.transactions = [];
  answers.fx_rates = [];
});

// polish-3 #12: one bank and FX fetch for the CSV import and To link
describe("fetchBankWindow", () => {
  it("reads the bank from 30 days before the first date to 7 after the last, and rates from 14 before that", async () => {
    answers.transactions = [{ data: [bankRow({ currency: "CHF" })], error: null }];
    answers.fx_rates = [
      { data: [{ currency: "CHF", date: "2026-10-01", rate_to_eur: 1.05 }], error: null },
    ];
    const w = await fetchBankWindow(["2026-11-20", "2026-11-10"], ["USD", "EUR"]);
    expect(args("transactions", "gte")).toContainEqual(["booking_date", "2026-10-11"]);
    expect(args("transactions", "lte")).toContainEqual(["booking_date", "2026-11-27"]);
    expect(args("fx_rates", "in")).toEqual([["currency", ["USD", "CHF"]]]);
    expect(args("fx_rates", "gte")).toContainEqual(["date", "2026-09-27"]);
    expect(args("fx_rates", "lte")).toContainEqual(["date", "2026-11-27"]);
    expect(w.bank.map((t) => t.entryReference)).toEqual(["e1"]);
    expect(w.fx).toHaveLength(1);
    expect(w.capped).toBe(false);
  });

  it("asks for no rates when everything is in euros", async () => {
    answers.transactions = [{ data: [bankRow()], error: null }];
    await fetchBankWindow(["2026-11-10"], ["EUR"]);
    expect(calls.some(([t]) => t === "fx_rates")).toBe(false);
  });

  it("throws the database's message", async () => {
    answers.transactions = [{ data: null, error: { message: "timeout" } }];
    await expect(fetchBankWindow(["2026-11-10"], [])).rejects.toThrow("timeout");
  });
});
