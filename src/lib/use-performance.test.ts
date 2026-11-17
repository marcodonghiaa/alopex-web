import { describe, expect, it, vi } from "vitest";
import { fetchEvents, fetchPerformance, fetchTrades, startPricesOf } from "./use-performance";

const client = (result: unknown) =>
  ({ rpc: vi.fn(async () => result) }) as unknown as Parameters<typeof fetchPerformance>[0];

describe("fetchPerformance", () => {
  it("asks for the range start and passes the rows through", async () => {
    const c = client({ data: [{ key: "A" }], error: null });
    expect(await fetchPerformance(c, "2026-09-30", false)).toEqual({ rows: [{ key: "A" }] });
    expect(c.rpc).toHaveBeenCalledWith("holding_performance", {
      p_from: "2026-09-30",
      p_last_move: false,
    });
  });

  it("treats a database without the function as not available yet, not as an error", async () => {
    const c = client({
      data: null,
      error: { code: "PGRST202", message: "Could not find the function" },
    });
    expect(await fetchPerformance(c, "2026-09-30", false)).toEqual({ unavailable: true });
  });

  it("throws any other error", async () => {
    const error = { code: "42501", message: "permission denied" };
    await expect(fetchPerformance(client({ data: null, error }), "2026-09-30", false)).rejects.toBe(
      error,
    );
  });

  it("no rows is an empty list", async () => {
    expect(await fetchPerformance(client({ data: null, error: null }), "2026-09-30", true)).toEqual(
      { rows: [] },
    );
  });
});

describe("fetchTrades", () => {
  const paged = (pages: Array<unknown>) => {
    const range = vi.fn(async () => pages.shift());
    return {
      client: {
        from: () => ({ select: () => ({ order: () => ({ range }) }) }),
      } as unknown as Parameters<typeof fetchTrades>[0],
      range,
    };
  };

  it("pages past the 1000-row limit", async () => {
    const first = Array.from({ length: 1000 }, (_, i) => ({ id: String(i) }));
    const { client, range } = paged([
      { data: first, error: null, count: 1001 },
      { data: [{ id: "last" }], error: null, count: 1001 },
    ]);
    const out = await fetchTrades(client);
    expect("trades" in out && out.trades.length).toBe(1001);
    expect(range).toHaveBeenCalledTimes(2);
  });

  it("treats a database without the table as not available yet", async () => {
    const { client } = paged([
      { data: null, error: { code: "PGRST205", message: "x" }, count: null },
    ]);
    expect(await fetchTrades(client)).toEqual({ unavailable: true });
  });

  it("throws on any other error", async () => {
    const { client } = paged([
      { data: null, error: { code: "500", message: "boom" }, count: null },
    ]);
    await expect(fetchTrades(client)).rejects.toThrow("boom");
  });
});

describe("fetchEvents", () => {
  const client = (page: unknown) =>
    ({
      from: () => ({ select: () => ({ order: () => ({ range: async () => page }) }) }),
    }) as unknown as Parameters<typeof fetchEvents>[0];

  it("pages events like trades", async () => {
    const rows = [{ kind: "dividend" }, { kind: "fee" }];
    expect(await fetchEvents(client({ data: rows, error: null, count: 2 }))).toEqual(rows);
  });

  it("throws on an error: the table comes with trades' columns, so no fallback of its own", async () => {
    const missing = { data: null, error: { code: "PGRST205", message: "no table" }, count: null };
    await expect(fetchEvents(client(missing))).rejects.toThrow("no table");
  });
});

describe("fetchTrades and fetchEvents columns", () => {
  const columnsOf = async (fetch: typeof fetchTrades | typeof fetchEvents) => {
    const select = vi.fn(() => ({
      order: () => ({ range: async () => ({ data: [], error: null, count: 0 }) }),
    }));
    await fetch({ from: () => ({ select }) } as unknown as Parameters<typeof fetchTrades>[0]);
    return (select.mock.calls[0] as unknown as [string])[0].split(",");
  };

  it("fetch only the columns the app reads", async () => {
    expect(await columnsOf(fetchTrades)).toEqual([
      "id",
      "kind",
      "key",
      "side",
      "trade_date",
      "shares",
      "price_eur",
      "fee_eur",
      "tax_eur",
      "traded_at",
      "source",
      "external_id",
    ]);
    expect(await columnsOf(fetchEvents)).toEqual([
      "kind",
      "asset_kind",
      "key",
      "event_date",
      "amount_eur",
      "tax_eur",
      "fee_eur",
      "source",
      "external_id",
    ]);
  });
});

// protects=the Return line doesn't price a day with a later price; fails_when=days before prices
// were kept read as a flat "no gain" line
describe("startPricesOf", () => {
  const row = (key: string, status: string) => ({
    kind: "stock",
    key,
    name: null,
    quantity: 1,
    start_date: "2026-08-20",
    start_price_eur: 10,
    end_date: "2026-11-17",
    end_price_eur: 12,
    status,
  });
  const data = { rows: [row("A", "ok"), row("B", "since"), { ...row("C", "ok"), kind: "crypto" }] };

  it("keeps every holding of the kind for the chip's start", () => {
    expect([...startPricesOf(data, "stock").keys()]).toEqual(["A", "B"]);
  });

  it("on the day leaves out holdings first priced after it", () => {
    expect([...startPricesOf(data, "stock", true).keys()]).toEqual(["A"]);
  });

  it("is empty when the database can't answer yet", () => {
    expect(startPricesOf({ unavailable: true }, "stock").size).toBe(0);
  });
});
