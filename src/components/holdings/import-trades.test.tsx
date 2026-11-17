import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const db = vi.hoisted(() => ({
  inserted: [] as Array<Record<string, unknown>>,
  upserted: [] as Array<[string, Array<Record<string, unknown>>, unknown]>,
  rpc: [] as Array<[string, Record<string, unknown>]>,
  ratesDown: false,
  rpcMissing: false,
  upsertError: null as string | null,
  eventsDown: false,
  // How many upserted rows the database says it saved (the rest were already there).
  upsertSaved: null as number | null,
  updated: [] as Array<[string, Record<string, unknown>, Array<[string, unknown]>]>,
  // While set, the trades insert waits for it: a slow save whose pending state really renders.
  insertGate: null as Promise<void> | null,
}));
vi.mock("@/integrations/supabase/client", () => {
  const tables: Record<string, Array<Record<string, unknown>>> = {
    portfolio_holdings: [
      { isin: "XX0000000001", shares: 1, name: "Example World ETF" },
      { isin: "XX0000000002", shares: 1, name: "Example Bond ETF" },
    ],
    crypto_holdings: [
      { asset_symbol: "BTC", amount: 0.008, name: "Bitcoin", source: "Ledger" },
      // Typed in lowercase by hand: the count goes to that row as stored.
      { asset_symbol: "eth", amount: 0.4, name: "Ethereum", source: "Manual" },
      { asset_symbol: "USDT", amount: 50, name: "Tether", source: "Coinbase" },
    ],
    // A dollar is 0.9 euro on every day the sample needs.
    investment_events: [],
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
    const down =
      (rows === tables["fx_rates"] && db.ratesDown) ||
      (rows === tables["investment_events"] && db.eventsDown);
    const result = Promise.resolve(
      down ? { data: null, error: { message: "offline" } } : { data: rows, error: null },
    );
    return Object.assign(result, {
      eq: () => query(rows),
      gte: () => query(rows),
      lte: () => query(rows),
      order: () => query(rows),
      limit: () => query(rows),
      range: () =>
        Promise.resolve(
          down
            ? { data: null, error: { message: "offline" }, count: null }
            : { data: rows, error: null, count: rows.length },
        ),
    });
  };
  return {
    supabase: {
      from: (table: string) => ({
        select: () => query(tables[table] ?? []),
        update: (patch: Record<string, unknown>) => {
          const where: Array<[string, unknown]> = [];
          db.updated.push([table, patch, where]);
          const chain = {
            eq: (c: string, v: unknown) => (where.push([c, v]), chain),
            then: (resolve: (v: unknown) => void) => resolve({ error: null }),
          };
          return chain;
        },
        insert: (rows: Array<Record<string, unknown>>) => {
          db.inserted.push(...rows);
          return (db.insertGate ?? Promise.resolve()).then(() => ({ error: null }));
        },
        upsert: (rows: Array<Record<string, unknown>>, options: unknown) => {
          db.upserted.push([table, rows, options]);
          const error = db.upsertError ? { message: db.upsertError } : null;
          const saved = rows.slice(0, db.upsertSaved ?? rows.length);
          return Object.assign(Promise.resolve({ error }), {
            select: () => Promise.resolve({ data: error ? null : saved, error }),
          });
        },
      }),
      rpc: (name: string, args: Record<string, unknown>) => {
        db.rpc.push([name, args]);
        return Promise.resolve(
          db.rpcMissing
            ? { data: null, error: { code: "PGRST202", message: "not found" } }
            : { data: 1, error: null },
        );
      },
      auth: { getUser: () => Promise.resolve({ data: { user: { id: "u1" } } }) },
    },
  };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
import { toast } from "sonner";

import { ImportTrades } from "./import-trades";
import type { Trade } from "@/lib/trades";
import { parseTradesCsv } from "@/lib/trades-csv";

/** A slow save: the insert waits until the returned function is called. */
function slowInsert() {
  let release!: () => void;
  db.insertGate = new Promise<void>((r) => (release = r));
  return release;
}

async function pickTradeRepublic() {
  fireEvent.click(screen.getByRole("button", { name: /Trade Republic/ }));
  const csv = readFileSync("src/lib/brokers/fixtures/trade_republic.csv", "utf8");
  fireEvent.change(screen.getByLabelText("CSV file"), {
    target: { files: [new File([csv], "export.csv", { type: "text/csv" })] },
  });
  return screen.findByRole("button", { name: "Save 4 trades" });
}

function open(kind: "stock" | "crypto", saved: Array<Trade> = []) {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ImportTrades kind={kind} saved={saved} />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByText("Import trades from CSV"));
}

describe("ImportTrades", () => {
  beforeEach(() => {
    db.inserted.length = 0;
    db.rpc.length = 0;
    db.updated.length = 0;
    db.rpcMissing = false;
    db.upsertError = null;
    db.upsertSaved = null;
    db.eventsDown = false;
    db.insertGate = null;
    vi.mocked(toast.success).mockClear();
  });

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

  it("a Ledger Live file is priced in euro, saved, and sets your wallet coins, not synced ones", async () => {
    open("crypto");
    fireEvent.click(screen.getByRole("button", { name: /Ledger Live/ }));
    const csv = readFileSync("src/lib/brokers/fixtures/ledger_live.csv", "utf8");
    const file = new File([csv], "ledgerwallet-operations.csv", { type: "text/csv" });
    fireEvent.change(screen.getByLabelText("CSV file"), { target: { files: [file] } });
    // USDT sits only on Coinbase, which syncs itself: its Ledger moves are left out, and it says so.
    const save = await screen.findByRole("button", { name: "Save 7 trades" });
    expect(screen.getByText(/USDT has no Ledger or manual holding/)).toBeTruthy();
    expect(screen.getByText("Share counts corrected")).toBeTruthy();
    fireEvent.click(save);
    await waitFor(() => expect(db.inserted).toHaveLength(7));
    expect(db.inserted.some((t) => t["key"] === "USDT")).toBe(false);
    const firstBuy = db.inserted.find((t) => t["key"] === "BTC" && t["side"] === "buy")!;
    expect(firstBuy["price_eur"]).toBeCloseTo((300 * 0.9) / 0.01);
    expect(firstBuy["user_id"]).toBe("u1");
    // BTC's Ledger holding already matches; ETH, added by hand, is corrected on its own row.
    await waitFor(() => expect(db.rpc).toHaveLength(1));
    expect(db.rpc[0]![0]).toBe("set_holding_quantity");
    expect(db.rpc[0]![1]).toMatchObject({ p_kind: "crypto", p_key: "eth", p_source: "Manual" });
    expect(db.rpc[0]![1]["p_quantity"]).toBeCloseTo(0.4988);
  });

  it("on a backend without set_holding_quantity the count is still set, on the holding itself", async () => {
    db.rpcMissing = true;
    open("crypto");
    fireEvent.click(screen.getByRole("button", { name: /Ledger Live/ }));
    const csv = readFileSync("src/lib/brokers/fixtures/ledger_live.csv", "utf8");
    fireEvent.change(screen.getByLabelText("CSV file"), {
      target: { files: [new File([csv], "ops.csv", { type: "text/csv" })] },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Save 7 trades" }));
    await waitFor(() => expect(db.updated).toHaveLength(1));
    const [table, patch, where] = db.updated[0]!;
    expect(table).toBe("crypto_holdings");
    expect(patch["amount"]).toBeCloseTo(0.4988);
    expect(where).toEqual([
      ["asset_symbol", "eth"],
      ["source", "Manual"],
    ]);
  });

  it("a coin's Ledger count leaves out what you traded elsewhere", async () => {
    const onCoinbase: Trade = {
      kind: "crypto",
      key: "BTC",
      side: "buy",
      trade_date: "2026-01-02",
      shares: 1,
      price_eur: 40000,
      fee_eur: 0,
      source: "coinbase",
      external_id: "cb-1",
    };
    open("crypto", [onCoinbase]);
    fireEvent.click(screen.getByRole("button", { name: /Ledger Live/ }));
    const csv = readFileSync("src/lib/brokers/fixtures/ledger_live.csv", "utf8");
    fireEvent.change(screen.getByLabelText("CSV file"), {
      target: { files: [new File([csv], "ops.csv", { type: "text/csv" })] },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Save 7 trades" }));
    // BTC's Ledger holding (0.008) already matches its Ledger moves: only ETH changes.
    await waitFor(() => expect(db.rpc).toHaveLength(1));
    expect(db.rpc[0]![1]).toMatchObject({ p_key: "eth" });
  });

  it("a Ledger Live file pasted as a spreadsheet is read the same way", async () => {
    open("crypto");
    fireEvent.click(screen.getByRole("button", { name: /My own spreadsheet/ }));
    const csv = readFileSync("src/lib/brokers/fixtures/ledger_live.csv", "utf8");
    fireEvent.change(screen.getByLabelText("CSV text"), { target: { value: csv } });
    expect(await screen.findByRole("button", { name: "Save 7 trades" })).toBeTruthy();
    expect(screen.getByText(/USDT has no Ledger or manual holding/)).toBeTruthy();
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

  it("if the income rows fail after the trades saved, it says so and still updates share counts", async () => {
    db.upsertError = "boom";
    open("stock");
    fireEvent.click(screen.getByRole("button", { name: /Trade Republic/ }));
    const csv = readFileSync("src/lib/brokers/fixtures/trade_republic.csv", "utf8");
    fireEvent.change(screen.getByLabelText("CSV file"), {
      target: { files: [new File([csv], "export.csv", { type: "text/csv" })] },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Save 4 trades" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "4 trades saved, but the income, fee and cash rows weren't (boom). Import the file again to save them.",
    );
    expect(db.inserted).toHaveLength(4);
    expect(db.updated.map(([table]) => table)).toContain("portfolio_holdings");
  });

  it("the preview names income and costs as the Income and costs section does", async () => {
    open("stock");
    fireEvent.click(screen.getByRole("button", { name: /Trade Republic/ }));
    const saveback =
      '"2026-03-02T09:00:00Z","2026-03-02","DEFAULT","CASH","BENEFITS_SAVEBACK","","","","","","1.50","","","EUR","00000000-0000-4000-8000-000000000007"';
    const csv = `${readFileSync("src/lib/brokers/fixtures/trade_republic.csv", "utf8").trim()}\n${saveback}`;
    fireEvent.change(screen.getByLabelText("CSV file"), {
      target: { files: [new File([csv], "export.csv", { type: "text/csv" })] },
    });
    expect((await screen.findByText("Rewards")).parentElement?.textContent).toBe("Rewards€1.50");
    expect(screen.getByText("Dividends").parentElement?.textContent).toBe("Dividends€1.20");
  });

  it("if saved dividends and fees can't load, it says so and won't save", async () => {
    db.eventsDown = true;
    open("stock");
    fireEvent.click(screen.getByRole("button", { name: /Trade Republic/ }));
    const csv = readFileSync("src/lib/brokers/fixtures/trade_republic.csv", "utf8");
    fireEvent.change(screen.getByLabelText("CSV file"), {
      target: { files: [new File([csv], "export.csv", { type: "text/csv" })] },
    });
    expect(
      await screen.findByText("Couldn't load your saved dividends and fees: offline"),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save 4 trades" })).toBeDisabled();
  });

  it("importing again after the income rows failed saves just them: the trades are skipped", async () => {
    const csv = readFileSync("src/lib/brokers/fixtures/trade_republic.csv", "utf8");
    const { trades } = parseTradesCsv(csv, {
      kind: "stock",
      knownKeys: new Set(["XX0000000001", "XX0000000002"]),
      today: "2026-11-17",
    });
    db.upserted.length = 0;
    open("stock", trades);
    fireEvent.click(screen.getByRole("button", { name: /Trade Republic/ }));
    fireEvent.change(screen.getByLabelText("CSV file"), {
      target: { files: [new File([csv], "export.csv", { type: "text/csv" })] },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Save 1 row" }));
    await waitFor(() => expect(toast.success).toHaveBeenLastCalledWith("1 other row imported"));
    expect(db.inserted).toEqual([]);
    expect(db.upserted.map(([table, rows]) => [table, rows.length])).toEqual([
      ["investment_events", 1],
    ]);
  });

  it("the toast counts only the rows the database saved, not ones it already had", async () => {
    db.upsertSaved = 0;
    open("stock");
    fireEvent.click(screen.getByRole("button", { name: /Trade Republic/ }));
    const csv = readFileSync("src/lib/brokers/fixtures/trade_republic.csv", "utf8");
    fireEvent.change(screen.getByLabelText("CSV file"), {
      target: { files: [new File([csv], "export.csv", { type: "text/csv" })] },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Save 4 trades" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(vi.mocked(toast.success).mock.lastCall?.[0]).toBe("4 trades imported");
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
    await waitFor(() =>
      expect(toast.success).toHaveBeenLastCalledWith("4 trades and 1 other row imported"),
    );
  });

  it("Esc during a slow save still toasts what was saved", async () => {
    const release = slowInsert();
    open("stock");
    fireEvent.click(await pickTradeRepublic());
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save 4 trades" })).toBeDisabled(),
    );
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    release();
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(vi.mocked(toast.success).mock.lastCall?.[0]).toBe("4 trades and 1 other row imported");
  });
});
