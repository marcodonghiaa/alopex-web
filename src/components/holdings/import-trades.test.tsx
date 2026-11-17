import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const db = vi.hoisted(() => ({
  inserted: [] as Array<Record<string, unknown>>,
  upserted: [] as Array<[string, Array<Record<string, unknown>>, unknown]>,
  rpc: [] as Array<[string, Record<string, unknown>]>,
  ratesDown: false,
}));
vi.mock("@/integrations/supabase/client", () => {
  const tables: Record<string, Array<Record<string, unknown>>> = {
    portfolio_holdings: [
      { isin: "XX0000000001", shares: 1, name: "Example World ETF" },
      { isin: "XX0000000002", shares: 1, name: "Example Bond ETF" },
    ],
    crypto_holdings: [
      { asset_symbol: "BTC", amount: 0.008, name: "Bitcoin", source: "Ledger" },
      { asset_symbol: "ETH", amount: 0.4, name: "Ethereum", source: "Ledger" },
      { asset_symbol: "USDT", amount: 50, name: "Tether", source: "Coinbase" },
    ],
    // A dollar is 0.9 euro on every day the sample needs.
    fx_rates: [
      "2026-01-01",
      "2026-01-10",
      "2026-01-20",
      "2026-02-01",
      "2026-02-10",
      "2026-03-01",
    ].map((date) => ({ date, rate_to_eur: 0.9 })),
  };
  // Every filter is ignored: each table answers with all its rows.
  const query = (rows: Array<Record<string, unknown>>) => {
    const down = rows === tables["fx_rates"] && db.ratesDown;
    const result = Promise.resolve(
      down ? { data: null, error: { message: "offline" } } : { data: rows, error: null },
    );
    return Object.assign(result, {
      eq: () => query(rows),
      gte: () => query(rows),
      lte: () => query(rows),
      order: () => query(rows),
      limit: () => query(rows),
      range: () => Promise.resolve({ data: rows, error: null, count: rows.length }),
    });
  };
  return {
    supabase: {
      from: (table: string) => ({
        select: () => query(tables[table] ?? []),
        insert: (rows: Array<Record<string, unknown>>) => {
          db.inserted.push(...rows);
          return Promise.resolve({ error: null });
        },
        upsert: (rows: Array<Record<string, unknown>>, options: unknown) => {
          db.upserted.push([table, rows, options]);
          return Promise.resolve({ error: null });
        },
      }),
      rpc: (name: string, args: Record<string, unknown>) => {
        db.rpc.push([name, args]);
        return Promise.resolve({ data: 1, error: null });
      },
      auth: { getUser: () => Promise.resolve({ data: { user: { id: "u1" } } }) },
    },
  };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ImportTrades } from "./import-trades";

function open(kind: "stock" | "crypto") {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ImportTrades kind={kind} saved={[]} />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByText("Import trades from CSV"));
}

describe("ImportTrades", () => {
  it("asks where the trades are from before asking for a file", () => {
    open("stock");
    expect(screen.getByText("Where are these trades from?")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Trade Republic/ })).toBeTruthy();
    expect(screen.queryByLabelText("CSV file")).toBeNull();
  });

  it("a broker shows how to export from it, then the file picker, and no text box", () => {
    open("stock");
    fireEvent.click(screen.getByRole("button", { name: /Trade Republic/ }));
    expect(screen.getByText("Import from Trade Republic")).toBeTruthy();
    expect(screen.getByText("Open the Trade Republic app")).toBeTruthy();
    expect(screen.getByLabelText("CSV file")).toBeTruthy();
    expect(screen.queryByLabelText("CSV text")).toBeNull();
  });

  it("a spreadsheet shows the columns and lets you paste", () => {
    open("stock");
    fireEvent.click(screen.getByRole("button", { name: /My own spreadsheet/ }));
    expect(screen.getByText(/date, side, isin, shares, price/)).toBeTruthy();
    expect(screen.getByLabelText("CSV text")).toBeTruthy();
  });

  it("another broker offers to ask for it, or to use a spreadsheet instead", () => {
    open("stock");
    fireEvent.click(screen.getByRole("button", { name: /Another broker/ }));
    expect(screen.getByRole("link", { name: "Ask for your broker" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save trades" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Use a spreadsheet" }));
    expect(screen.getByLabelText("CSV text")).toBeTruthy();
  });

  it("you can go back and choose another source", () => {
    open("stock");
    fireEvent.click(screen.getByRole("button", { name: /Another broker/ }));
    fireEvent.click(screen.getByRole("button", { name: /All sources/ }));
    expect(screen.getByText("Where are these trades from?")).toBeTruthy();
  });

  it("the crypto page lists crypto sources and Trade Republic (it sells coins too)", () => {
    open("crypto");
    expect(screen.getByRole("button", { name: /Trade Republic/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Ledger Live/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /My own spreadsheet/ })).toBeTruthy();
  });

  it("a picked file shows its name and how many trades it holds, and hides the how-to", async () => {
    open("stock");
    fireEvent.click(screen.getByRole("button", { name: /Trade Republic/ }));
    const csv = readFileSync("src/lib/brokers/fixtures/trade_republic.csv", "utf8");
    const file = new File([csv], "Transaction export.csv", { type: "text/csv" });
    fireEvent.change(screen.getByLabelText("CSV file"), { target: { files: [file] } });
    expect(await screen.findByText("Transaction export.csv")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("new trades to save")).toBeTruthy());
    expect(screen.getByText("By holding")).toBeTruthy();
    expect(screen.getByText("Example World ETF")).toBeTruthy();
    expect(screen.getByText("Left out")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save 4 trades" })).toBeTruthy();
    // The dividend in the file is shown and saved with the trades.
    expect(screen.getByText("Also saved: income, fees and cash")).toBeTruthy();
    expect(screen.getByText("Dividends")).toBeTruthy();
    expect(screen.queryByText("How to get the file")).toBeNull();
  });

  it("a Ledger Live file is priced in euro, saved, and sets only your Ledger holdings", async () => {
    open("crypto");
    fireEvent.click(screen.getByRole("button", { name: /Ledger Live/ }));
    const csv = readFileSync("src/lib/brokers/fixtures/ledger_live.csv", "utf8");
    const file = new File([csv], "ledgerwallet-operations.csv", { type: "text/csv" });
    fireEvent.change(screen.getByLabelText("CSV file"), { target: { files: [file] } });
    const save = await screen.findByRole("button", { name: "Save 9 trades" });
    expect(screen.getByText("Share counts corrected")).toBeTruthy();
    fireEvent.click(save);
    await waitFor(() => expect(db.inserted).toHaveLength(9));
    const firstBuy = db.inserted.find((t) => t["key"] === "BTC" && t["side"] === "buy")!;
    expect(firstBuy["price_eur"]).toBeCloseTo((300 * 0.9) / 0.01);
    expect(firstBuy["user_id"]).toBe("u1");
    // BTC already matches; ETH is corrected; USDT has no Ledger holding, so it's left alone.
    await waitFor(() => expect(db.rpc).toHaveLength(1));
    expect(db.rpc[0]![0]).toBe("set_holding_quantity");
    expect(db.rpc[0]![1]).toMatchObject({ p_kind: "crypto", p_key: "ETH", p_source: "Ledger" });
    expect(db.rpc[0]![1]["p_quantity"]).toBeCloseTo(0.4988);
  });

  it("when the exchange rates can't be loaded it says so and offers no save", async () => {
    db.ratesDown = true;
    open("crypto");
    fireEvent.click(screen.getByRole("button", { name: /Ledger Live/ }));
    const csv = readFileSync("src/lib/brokers/fixtures/ledger_live.csv", "utf8");
    fireEvent.change(screen.getByLabelText("CSV file"), {
      target: { files: [new File([csv], "ops.csv", { type: "text/csv" })] },
    });
    // One retry first, a second later.
    expect(
      await screen.findByText(/Couldn't load USD exchange rates/, {}, { timeout: 4000 }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Save/ })).toBeNull();
    db.ratesDown = false;
  });

  it("a Trade Republic file saves its dividends too, skipping ones already saved by id", async () => {
    db.upserted.length = 0;
    open("stock");
    fireEvent.click(screen.getByRole("button", { name: /Trade Republic/ }));
    const csv = readFileSync("src/lib/brokers/fixtures/trade_republic.csv", "utf8");
    fireEvent.change(screen.getByLabelText("CSV file"), {
      target: { files: [new File([csv], "export.csv", { type: "text/csv" })] },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Save 4 trades" }));
    await waitFor(() => expect(db.upserted).toHaveLength(1));
    const [table, rows, options] = db.upserted[0]!;
    expect(table).toBe("investment_events");
    expect(options).toEqual({ onConflict: "user_id,source,external_id", ignoreDuplicates: true });
    expect(rows).toEqual([
      expect.objectContaining({ kind: "dividend", amount_eur: 1.2, user_id: "u1" }),
    ]);
  });
});
