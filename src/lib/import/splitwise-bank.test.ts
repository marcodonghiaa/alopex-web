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

import { fetchBankWindow, withFileRates } from "./splitwise-bank";

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

  // polish-3 #2: a long history must not leave random items without a suggestion
  it("pages through the window, newest first, without deleted rows", async () => {
    const page = (n: number, date: string) =>
      Array.from({ length: n }, (_, i) =>
        bankRow({ entry_reference: `${date}-${i}`, booking_date: date }),
      );
    answers.transactions = [
      { data: page(1000, "2026-11-12"), error: null },
      { data: page(3, "2026-11-01"), error: null },
    ];
    const w = await fetchBankWindow(["2026-11-10"], []);
    expect(w.bank).toHaveLength(1003);
    expect(w.capped).toBe(false);
    expect(args("transactions", "range")).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
    expect(args("transactions", "order")[0]).toEqual(["booking_date", { ascending: false }]);
    expect(args("transactions", "is")).toContainEqual(["deleted_at", null]);
  });

  it("stops after 10 000 bank rows and says from which date they are complete", async () => {
    const full = {
      data: Array.from({ length: 1000 }, () => bankRow({ booking_date: "2026-11-05" })),
      error: null,
    };
    answers.transactions = Array.from({ length: 12 }, () => full);
    const w = await fetchBankWindow(["2026-11-10"], []);
    expect(args("transactions", "range")).toHaveLength(11); // 10 pages, then one row to see if more
    expect(w.capped).toBe(true);
    // Other rows on 5 Nov may be the ones cut: complete only from the day after.
    expect(w.completeFrom).toBe("2026-11-06");
  });

  // polish-3 round 2: exactly 10 000 rows is everything, not a cut
  it("reads exactly 10 000 rows as complete", async () => {
    const full = {
      data: Array.from({ length: 1000 }, () => bankRow({ booking_date: "2026-11-05" })),
      error: null,
    };
    answers.transactions = [...Array.from({ length: 10 }, () => full), { data: [], error: null }];
    const w = await fetchBankWindow(["2026-11-10"], []);
    expect(w.bank).toHaveLength(10_000);
    expect(w.capped).toBe(false);
    expect(w.completeFrom).toBeNull();
    expect(args("transactions", "range").at(-1)).toEqual([10_000, 10_000]);
  });

  it("pages the rates newest first too", async () => {
    answers.transactions = [{ data: [bankRow({ currency: "CHF" })], error: null }];
    const rates = Array.from({ length: 1000 }, () => ({
      currency: "CHF",
      date: "2026-11-01",
      rate_to_eur: 1,
    }));
    answers.fx_rates = [
      { data: rates, error: null },
      { data: rates.slice(0, 5), error: null },
    ];
    const w = await fetchBankWindow(["2026-11-10"], []);
    expect(w.fx).toHaveLength(1005);
    expect(args("fx_rates", "order")[0]).toEqual(["date", { ascending: false }]);
    expect(w.capped).toBe(false);
  });

  // polish-3 round 2: too many rates keeps the newest, and the note dates from them
  it("with too many rates, keeps the newest and says from when payments have one", async () => {
    answers.transactions = [
      { data: [bankRow({ currency: "CHF", booking_date: "2026-11-11" })], error: null },
    ];
    const page = {
      data: Array.from({ length: 1000 }, () => ({
        currency: "CHF",
        date: "2026-11-03",
        rate_to_eur: 1,
      })),
      error: null,
    };
    answers.fx_rates = Array.from({ length: 11 }, () => page);
    const w = await fetchBankWindow(["2026-11-10"], []);
    expect(w.capped).toBe(true);
    expect(w.completeFrom).toBe("2026-11-04");
  });
});

// issue #11: a fresh install keeps rates only from its install day, older file dates had none
describe("withFileRates", () => {
  const usd = (date: string) => ({ currency: "USD", date });
  it("asks for the days the stored rates miss, only for the currencies that miss them", async () => {
    const load = vi.fn(async () => [{ date: "2026-08-14", rate_to_eur: 0.9 }]);
    const stored = [{ currency: "GBP", date: "2026-08-01", rate_to_eur: 1.2 }];
    const rows = [
      usd("2026-11-02"),
      usd("2026-08-16"),
      { currency: "GBP", date: "2026-09-01" },
      { currency: "EUR", date: "2026-08-01" },
    ];
    const r = await withFileRates(stored, rows, load);
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith("USD", "2026-08-16", "2026-11-02");
    expect(r.fx).toEqual([...stored, { currency: "USD", date: "2026-08-14", rate_to_eur: 0.9 }]);
    expect(r.failed).toEqual([]);
  });

  it("asks nothing when every row already has a rate", async () => {
    const load = vi.fn();
    const stored = [{ currency: "USD", date: "2026-08-01", rate_to_eur: 0.9 }];
    expect(await withFileRates(stored, [usd("2026-08-16")], load)).toEqual({
      fx: stored,
      failed: [],
    });
    expect(load).not.toHaveBeenCalled();
  });

  it("says once per currency when the rates can't be loaded", async () => {
    const message = "Couldn't load USD to EUR rates from api.frankfurter.app to value this file.";
    const load = vi.fn(async () => {
      throw new Error(message);
    });
    const r = await withFileRates([], [usd("2026-08-16"), usd("2026-08-17")], load);
    expect(r).toEqual({ fx: [], failed: [{ currency: "USD", message }] });
  });
});
