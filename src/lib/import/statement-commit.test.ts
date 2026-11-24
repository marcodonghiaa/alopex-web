import { describe, expect, it, vi } from "vitest";
import { importStatement, newRows, type StatementClient } from "./statement-commit";
import type { StatementRow } from "./statement";

const coffee: StatementRow = {
  date: "2026-04-25",
  description: "Coffee",
  amount: 2.5,
  direction: "DBIT",
};
const salary: StatementRow = {
  date: "2026-04-26",
  description: "Salary",
  amount: 1500,
  direction: "CRDT",
};

// Fake client: serves `existing` in pages of 1000 like PostgREST (or `cap`, a server set lower),
// and records each request.
function client(existing: Array<Record<string, unknown>>, failOn?: string, cap = 1000) {
  const rpc = vi.fn(async (_fn: string, args: Record<string, unknown>) =>
    args["p_description"] === failOn
      ? { data: null, error: { message: "boom" } }
      : { data: [], error: null },
  );
  const requests: Array<{ from: string; to: string; deleted: unknown; page: [number, number] }> =
    [];
  const orders: Array<string> = [];
  let page = async (_a: number, _b: number) => ({
    data: [] as Array<Record<string, unknown>>,
    error: null,
  });
  // Each order() call records its column and allows another one after it.
  const ordered = (col: string) => {
    orders.push(col);
    return { order: ordered, range: page };
  };
  const c: StatementClient = {
    rpc,
    from: () => ({
      select: () => ({
        is: (_col: string, deleted: null) => ({
          gte: (_c: string, from: string) => ({
            lte: (_c2: string, to: string) => ({
              order: (col: string) => {
                page = async (a: number, b: number) => {
                  requests.push({ from, to, deleted, page: [a, b] });
                  return { data: existing.slice(a, Math.min(b + 1, a + cap)), error: null };
                };
                return ordered(col);
              },
            }),
          }),
        }),
      }),
    }),
  };
  return { c, rpc, requests, orders };
}

const inApp = (row: StatementRow, description = row.description) => ({
  booking_date: row.date,
  amount: row.amount,
  credit_debit_indicator: row.direction,
  creditor_name: description,
});

describe("newRows", () => {
  // H139: a server capped below 1000 rows ended the duplicate check after its first short page,
  // so importing the same statement again added rows that were already there.
  it("reads every page when the server caps a response below 1000 rows", async () => {
    const existing = [...Array(600).fill(inApp(salary)), inApp(coffee)];
    const { c } = client(existing, undefined, 500);
    expect(await newRows(c, [coffee])).toEqual([]);
  });

  // Batch H review: entry_reference repeats across accounts, so paging by it alone can read one
  // row twice and skip another where a page ends.
  it("pages in a total order: account, then reference", async () => {
    const { c, orders } = client([inApp(coffee)]);
    await newRows(c, [coffee]);
    expect(orders.slice(0, 2)).toEqual(["account_uid", "entry_reference"]);
  });

  it("polish-3 #13 asks the app once per date range when given a cache", async () => {
    const { c, requests } = client([inApp(coffee)]);
    const cache = new Map();
    expect(await newRows(c, [coffee, salary], cache)).toEqual([salary]);
    expect(await newRows(c, [salary, coffee], cache)).toEqual([salary]);
    // One read (its first page, then the empty page that ends it), not two.
    expect(requests).toHaveLength(2);
  });

  it("only treats a row as already there when the currency matches too", async () => {
    const usd = { ...inApp(coffee), currency: "USD" };
    expect(await newRows(client([usd]).c, [coffee])).toEqual([coffee]);
    expect(await newRows(client([usd]).c, [{ ...coffee, currency: "USD" }])).toEqual([]);
  });

  it("leaves out rows already in the app, over the file's date range, deleted rows excluded", async () => {
    const { c, requests } = client([inApp(coffee, "COFFEE")]);
    expect(await newRows(c, [coffee, salary])).toEqual([salary]);
    expect(requests[0]).toMatchObject({ from: "2026-04-25", to: "2026-04-26", deleted: null });
  });

  // Regression: two identical coffees on the same day in one statement became one.
  it("keeps repeats inside the file, and skips them all once they are in the app", async () => {
    expect(await newRows(client([]).c, [coffee, coffee])).toEqual([coffee, coffee]);
    expect(await newRows(client([inApp(coffee)]).c, [coffee, coffee])).toEqual([coffee]);
    expect(await newRows(client([inApp(coffee), inApp(coffee)]).c, [coffee, coffee])).toEqual([]);
  });

  // Regression: only the first 1000 rows in the app were compared, so a long history re-imported.
  it("reads every page of rows already in the app", async () => {
    const filler = Array.from({ length: 1000 }, () => inApp(salary, "Other"));
    const { c, requests } = client([...filler, inApp(coffee)]);
    expect(await newRows(c, [coffee])).toEqual([]);
    expect(requests.map((r) => r.page)).toEqual([
      [0, 999],
      [1000, 1999],
      [1001, 2000],
    ]);
  });
});

describe("importStatement", () => {
  it("adds every row with its source and reports progress", async () => {
    const { c, rpc } = client([]);
    const progress = vi.fn();
    const done = await importStatement(c, [coffee, salary], "Fineco", progress);
    expect(done).toBe(2);
    expect(rpc).toHaveBeenCalledWith("add_manual_transaction", {
      p_booking_date: "2026-04-25",
      p_description: "Coffee",
      p_amount: 2.5,
      p_direction: "DBIT",
      p_currency: "EUR",
      p_category: null,
      p_source: "Fineco",
    });
    expect(progress).toHaveBeenLastCalledWith(2);
  });

  it("sends the row's currency and a Transfer category", async () => {
    const { c, rpc } = client([]);
    await importStatement(
      c,
      [{ ...coffee, currency: "USD", category: "Transfer" }],
      null,
      () => {},
    );
    expect(rpc).toHaveBeenCalledWith(
      "add_manual_transaction",
      expect.objectContaining({ p_currency: "USD", p_category: "Transfer" }),
    );
  });

  it("stops at the first error and says how many were added", async () => {
    const { c } = client([], "Salary");
    await expect(importStatement(c, [coffee, salary], null, vi.fn(), 1)).rejects.toThrow(
      /1 of 2 added.*boom/,
    );
  });
});

describe("RPC types", () => {
  it("polish-3 #16 the import client only takes add_manual_transaction's real arguments", () => {
    const typed = (c: StatementClient) =>
      c.rpc("add_manual_transaction", {
        p_booking_date: "2026-01-01",
        p_description: "x",
        // @ts-expect-error p_amount is a number in the database function
        p_amount: "1",
        p_direction: "DBIT",
      });
    expect(typeof typed).toBe("function");
  });
});
