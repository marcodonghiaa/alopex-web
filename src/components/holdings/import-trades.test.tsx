import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const db = vi.hoisted(() => ({
  inserted: [] as Array<Record<string, unknown>>,
  upserted: [] as Array<[string, Array<Record<string, unknown>>, unknown]>,
  rpc: [] as Array<[string, Record<string, unknown>]>,
  ratesDown: false,
  rpcMissing: false,
  // set_holding_quantity fails outright.
  rpcError: false,
  upsertError: null as string | null,
  eventsDown: false,
  holdingsDown: false,
  // The saved investment_events never arrive (still loading).
  eventsHang: false,
  signedOut: false,
  // portfolio_holdings, reset before each test.
  stocks: [] as Array<Record<string, unknown>>,
  getUserCalls: 0,
  // The saved investment_events rows (the file's own, once imported).
  events: [] as Array<Record<string, unknown>>,
  // How many upserted rows the database says it saved (the rest were already there).
  upsertSaved: null as number | null,
  updated: [] as Array<[string, Record<string, unknown>, Array<[string, unknown]>]>,
  // While set, the trades insert waits for it: a slow save whose pending state really renders.
  insertGate: null as Promise<void> | null,
}));
vi.mock("@/integrations/supabase/client", () => {
  const tables: Record<string, Array<Record<string, unknown>>> = {
    portfolio_holdings: db.stocks,
    crypto_holdings: [
      { asset_symbol: "BTC", amount: 0.008, name: "Bitcoin", source: "Ledger" },
      // Typed in lowercase by hand: the count goes to that row as stored.
      { asset_symbol: "eth", amount: 0.4, name: "Ethereum", source: "Manual" },
      { asset_symbol: "USDT", amount: 50, name: "Tether", source: "Coinbase" },
    ],
    // A dollar is 0.9 euro on every day the sample needs.
    investment_events: db.events,
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
      (rows === tables["investment_events"] && db.eventsDown) ||
      (rows === tables["portfolio_holdings"] && db.holdingsDown);
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
        rows === tables["investment_events"] && db.eventsHang
          ? new Promise(() => {})
          : Promise.resolve(
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
            : db.rpcError
              ? { data: null, error: { code: "XX000", message: "boom" } }
              : { data: 1, error: null },
        );
      },
      auth: {
        getUser: () => {
          db.getUserCalls++;
          return Promise.resolve({ data: { user: db.signedOut ? null : { id: "u1" } } });
        },
      },
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
  // "and 1 row" once your saved dividends have loaded.
  return screen.findByRole("button", { name: /^Save 4 trades/ });
}

function open(kind: "stock" | "crypto", saved: Array<Trade> = []) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ImportTrades kind={kind} saved={saved} />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByText("Import trades from CSV"));
  return client;
}

describe("ImportTrades", () => {
  beforeEach(() => {
    db.inserted.length = 0;
    db.stocks.splice(
      0,
      Infinity,
      { isin: "XX0000000001", shares: 1, name: "Example World ETF" },
      { isin: "XX0000000002", shares: 1, name: "Example Bond ETF" },
    );
    db.upserted.length = 0;
    db.ratesDown = false;
    db.signedOut = false;
    db.rpc.length = 0;
    db.updated.length = 0;
    db.rpcMissing = false;
    db.rpcError = false;
    db.upsertError = null;
    db.upsertSaved = null;
    db.eventsDown = false;
    db.holdingsDown = false;
    db.eventsHang = false;
    db.getUserCalls = 0;
    db.events.length = 0;
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
    expect(screen.getByText("Notes")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save 4 trades and 1 row" })).toBeTruthy();
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
    expect(screen.getByText("Share counts to correct")).toBeTruthy();
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
    // The file card stops reading: it can't be, until the rates load.
    expect(screen.getByText("Can't be read")).toBeTruthy();
    expect(screen.queryByText("Reading…")).toBeNull();
  });

  it("if the income rows fail after the trades saved, it says so and still updates share counts", async () => {
    db.upsertError = "boom";
    open("stock");
    fireEvent.click(screen.getByRole("button", { name: /Trade Republic/ }));
    const csv = readFileSync("src/lib/brokers/fixtures/trade_republic.csv", "utf8");
    fireEvent.change(screen.getByLabelText("CSV file"), {
      target: { files: [new File([csv], "export.csv", { type: "text/csv" })] },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Save 4 trades and 1 row" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "4 trades saved, but the income, fee and cash rows weren't (boom). Import the file again to save them.",
    );
    expect(db.inserted).toHaveLength(4);
    // Through set_holding_quantity, which also writes today's value for net worth.
    expect(db.rpc).toEqual([
      [
        "set_holding_quantity",
        { p_kind: "stock", p_key: "XX0000000001", p_quantity: 4, p_source: null },
      ],
      [
        "set_holding_quantity",
        { p_kind: "stock", p_key: "XX0000000002", p_quantity: 0, p_source: null },
      ],
    ]);
    expect(db.updated).toEqual([]);
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

  it("polish-4 UB4 the preview says dividends are after tax; not when the file has none", async () => {
    open("stock");
    await pickTradeRepublic();
    expect(screen.getByText("Dividends and interest are after tax.")).toBeInTheDocument();
    cleanup();
    open("stock");
    fireEvent.click(screen.getByRole("button", { name: /Trade Republic/ }));
    const [header] = readFileSync("src/lib/brokers/fixtures/trade_republic.csv", "utf8").split(
      "\n",
    );
    const saveback =
      '"2026-03-02T09:00:00Z","2026-03-02","DEFAULT","CASH","BENEFITS_SAVEBACK","","","","","","1.50","","","EUR","00000000-0000-4000-8000-000000000007"';
    fireEvent.change(screen.getByLabelText("CSV file"), {
      target: { files: [new File([`${header}\n${saveback}`], "export.csv", { type: "text/csv" })] },
    });
    expect(await screen.findByText("Rewards")).toBeInTheDocument();
    expect(screen.queryByText("Dividends and interest are after tax.")).toBeNull();
  });

  it("polish-4 R4 the after-tax line sits right under the dividends and interest", async () => {
    open("stock");
    await pickTradeRepublic();
    const note = screen.getByText("Dividends and interest are after tax.");
    // Right after the Dividends row, not below the whole list and its row count.
    expect(note.previousElementSibling?.textContent).toMatch(/^(Dividends|Interest)€[\d.,]+$/);
  });

  it("polish-4 UB6 the row count says it counts every row saved", async () => {
    open("stock");
    await pickTradeRepublic();
    expect(
      screen.getByText("Rows saved in all (deposits and withdrawals too)").parentElement
        ?.textContent,
    ).toBe("Rows saved in all (deposits and withdrawals too)1");
  });

  it("polish-4 UB7 Save names the trades and the rows it saves; trades alone name only trades", async () => {
    open("stock");
    fireEvent.click(screen.getByRole("button", { name: /Trade Republic/ }));
    const csv = readFileSync("src/lib/brokers/fixtures/trade_republic.csv", "utf8");
    fireEvent.change(screen.getByLabelText("CSV file"), {
      target: { files: [new File([csv], "export.csv", { type: "text/csv" })] },
    });
    expect(await screen.findByRole("button", { name: "Save 4 trades and 1 row" })).toBeTruthy();
    cleanup();
    open("stock");
    fireEvent.click(screen.getByRole("button", { name: /My own spreadsheet/ }));
    fireEvent.change(screen.getByLabelText("CSV text"), {
      target: { value: "date,side,isin,shares,price,fee\n2026-01-15,buy,XX0000000001,1,10,0" },
    });
    expect(await screen.findByRole("button", { name: "Save 1 trade" })).toBeTruthy();
  });

  it("polish-4 F7b the preview's fees and taxes count those on the trades, as the page does", async () => {
    open("stock");
    await pickTradeRepublic();
    // The sale's €1 fee: the page's Fees row adds it too.
    expect(screen.getByText("Fees").parentElement?.textContent).toBe("Fees−€1.00");
  });

  it("polish-4 R3 fees only on the trades don't claim extra rows are saved", async () => {
    open("stock");
    fireEvent.click(screen.getByRole("button", { name: /My own spreadsheet/ }));
    fireEvent.change(screen.getByLabelText("CSV text"), {
      target: { value: "date,side,isin,shares,price,fee\n2026-01-15,buy,XX0000000001,1,10,1" },
    });
    expect(await screen.findByRole("button", { name: "Save 1 trade" })).toBeTruthy();
    expect((await screen.findByText("Fees")).parentElement?.textContent).toBe("Fees−€1.00");
    expect(screen.getByText("Costs on these trades")).toBeInTheDocument();
    expect(screen.queryByText("Also saved: income, fees and cash")).toBeNull();
  });

  it("polish-4 UB8 the toast calls the other rows income and cash rows", async () => {
    open("stock");
    fireEvent.click(await pickTradeRepublic());
    await waitFor(() =>
      expect(toast.success).toHaveBeenLastCalledWith("4 trades and 1 income and cash row imported"),
    );
  });

  it("polish-4 UB9 the file's notes sit under Notes, as some were saved", async () => {
    open("stock");
    await pickTradeRepublic();
    expect(screen.getByText("Notes")).toBeInTheDocument();
    expect(screen.queryByText("Left out")).toBeNull();
  });

  describe("polish-4 UB10 a file with nothing new says what it found", () => {
    const fixture = () => readFileSync("src/lib/brokers/fixtures/trade_republic.csv", "utf8");
    const pick = (csv: string) => {
      fireEvent.click(screen.getByRole("button", { name: /Trade Republic/ }));
      fireEvent.change(screen.getByLabelText("CSV file"), {
        target: { files: [new File([csv], "export.csv", { type: "text/csv" })] },
      });
    };

    it("a file with only its header says there's nothing to import, with no check and no Save", async () => {
      open("stock");
      pick(fixture().split("\n")[0]!);
      expect(await screen.findByText("Nothing in this file to import here.")).toBeInTheDocument();
      expect(screen.getByText("Nothing new to import")).toBeInTheDocument();
      expect(document.querySelector(".lucide-check")).toBeNull();
      expect(screen.queryByRole("button", { name: /^Save/ })).toBeNull();
      expect(screen.queryByText(/new trades? to save/)).toBeNull();
    });

    it("a file saved before says everything is already saved, trades and rows counted", async () => {
      const { trades, events } = parseTradesCsv(fixture(), {
        kind: "stock",
        knownKeys: new Set(["XX0000000001", "XX0000000002"]),
        today: "2026-11-17",
      });
      db.events.push(...events!.map((e) => ({ ...e })));
      db.stocks[0]!["shares"] = 4;
      db.stocks[1]!["shares"] = 0;
      open("stock", trades);
      pick(fixture());
      expect(
        await screen.findByText("Everything in this file is already saved."),
      ).toBeInTheDocument();
      expect(screen.getByText("Already saved, skipped").parentElement?.textContent).toBe(
        "Already saved, skipped4 trades, 1 row",
      );
      expect(screen.queryByRole("button", { name: /^Save/ })).toBeNull();
    });

    it("a file of income only counts its rows, not 0 trades", async () => {
      const [header] = fixture().split("\n");
      const saveback =
        '"2026-03-02T09:00:00Z","2026-03-02","DEFAULT","CASH","BENEFITS_SAVEBACK","","","","","","1.50","","","EUR","00000000-0000-4000-8000-000000000007"';
      open("stock");
      pick(`${header}\n${saveback}`);
      expect(await screen.findByText("new income and cash row to save")).toBeInTheDocument();
      expect(screen.queryByText(/new trades? to save/)).toBeNull();
      expect(screen.getByText("Read, check what it found below")).toBeInTheDocument();
      expect(document.querySelector(".lucide-check")).not.toBeNull();
      expect(screen.getByRole("button", { name: "Save 1 row" })).toBeEnabled();
    });
  });

  it("polish-4 F5 the summary leaves out a side with no trades", async () => {
    open("stock");
    fireEvent.click(screen.getByRole("button", { name: /My own spreadsheet/ }));
    fireEvent.change(screen.getByLabelText("CSV text"), {
      target: { value: "date,side,isin,shares,price,fee\n2026-01-15,buy,XX0000000001,1,10,0" },
    });
    await screen.findByRole("button", { name: "Save 1 trade" });
    expect(screen.getByText(/^1 buy · /).textContent).toBe("1 buy · 15 Jan 2026");
  });

  it("polish-4 UB13 Change is named, 44px tall and shows keyboard focus; before a file, the picker is the CSV file", async () => {
    open("stock");
    fireEvent.click(screen.getByRole("button", { name: /Trade Republic/ }));
    const csv = readFileSync("src/lib/brokers/fixtures/trade_republic.csv", "utf8");
    fireEvent.change(screen.getByLabelText("CSV file"), {
      target: { files: [new File([csv], "export.csv", { type: "text/csv" })] },
    });
    await screen.findByText("export.csv");
    const input = screen.getByLabelText("Change file");
    expect(input.closest("label")).toHaveClass("min-h-11", "has-[:focus-visible]:ring-2");
    expect(screen.queryByLabelText("CSV file")).toBeNull();
  });

  it("polish-4 UB14 focus moves to the file picker, then to the file's status", async () => {
    open("stock");
    fireEvent.click(screen.getByRole("button", { name: /Trade Republic/ }));
    expect(document.activeElement).toBe(screen.getByLabelText("CSV file"));
    const csv = readFileSync("src/lib/brokers/fixtures/trade_republic.csv", "utf8");
    fireEvent.change(screen.getByLabelText("CSV file"), {
      target: { files: [new File([csv], "export.csv", { type: "text/csv" })] },
    });
    const status = await screen.findByRole("status");
    expect(document.activeElement?.contains(screen.getByText("export.csv"))).toBe(true);
    await waitFor(() => expect(status.textContent).toBe("Read, check what it found below"));
  });

  it("polish-4 UB14 another broker puts focus on the way to ask for it", () => {
    open("stock");
    fireEvent.click(screen.getByRole("button", { name: /Another broker/ }));
    expect(document.activeElement).toBe(screen.getByRole("link", { name: "Ask for your broker" }));
  });

  it("polish-4 UB15 the X looks disabled during a save, and not before", async () => {
    const release = slowInsert();
    open("stock");
    const save = await pickTradeRepublic();
    const close = screen.getByRole("button", { name: "Close" });
    expect(close).not.toHaveAttribute("aria-disabled");
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);
    await waitFor(() => expect(close).toHaveAttribute("aria-disabled", "true"));
    expect(close).toHaveClass("opacity-30");
    release();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("polish-4 UB16 a file that can't be imported offers no Save", async () => {
    open("stock");
    fireEvent.click(screen.getByRole("button", { name: /My own spreadsheet/ }));
    fireEvent.change(screen.getByLabelText("CSV text"), {
      target: { value: "date,side,isin,shares,price,fee\n2999-01-15,buy,XX0000000001,1,10,0" },
    });
    expect(await screen.findByText("Nothing saved. Fix these first:")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Save/ })).toBeNull();
  });

  it("polish-4 N1 a file that can't be imported shows an X, not a check", async () => {
    open("stock");
    fireEvent.click(screen.getByRole("button", { name: /Trade Republic/ }));
    fireEvent.change(screen.getByLabelText("CSV file"), {
      target: { files: [new File(["a,b\n1,2"], "wrong.csv", { type: "text/csv" })] },
    });
    expect(await screen.findByText("Can't be imported")).toBeInTheDocument();
    const card = screen.getByText("wrong.csv").closest("[tabindex]")!;
    expect(card.querySelector(".lucide-check")).toBeNull();
    expect(card.querySelector(".lucide-x")).not.toBeNull();
  });

  it("polish-4 N5 if the share counts fail after the trades saved, it says the trades are saved", async () => {
    db.rpcError = true;
    open("stock");
    fireEvent.click(await pickTradeRepublic());
    expect((await screen.findByRole("alert")).textContent).toBe(
      "4 trades saved, but the share counts and the income, fee and cash rows weren't (boom). Import the file again to save them.",
    );
    expect(db.upserted).toEqual([]);
  });

  it("polish-4 N5 with no trades saved, a share count failure shows the database's error", async () => {
    db.rpcError = true;
    const csv = readFileSync("src/lib/brokers/fixtures/trade_republic.csv", "utf8");
    const { trades, events } = parseTradesCsv(csv, {
      kind: "stock",
      knownKeys: new Set(["XX0000000001", "XX0000000002"]),
      today: "2026-11-17",
    });
    db.events.push(...events!.map((e) => ({ ...e })));
    open("stock", trades);
    fireEvent.click(screen.getByRole("button", { name: /Trade Republic/ }));
    fireEvent.change(screen.getByLabelText("CSV file"), {
      target: { files: [new File([csv], "export.csv", { type: "text/csv" })] },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Save share counts" }));
    expect((await screen.findByRole("alert")).textContent).toBe("boom");
  });

  describe("polish-4 N6 a file read that ends late is ignored", () => {
    const csv = () => readFileSync("src/lib/brokers/fixtures/trade_republic.csv", "utf8");
    /** A file whose text arrives only when the returned function is called. */
    const slowFile = (text: string, name: string) => {
      let finish!: () => void;
      const ready = new Promise<string>((r) => (finish = () => r(text)));
      return { file: Object.assign(new File([text], name), { text: () => ready }), finish };
    };

    it("a file chosen after it wins", async () => {
      open("stock");
      fireEvent.click(screen.getByRole("button", { name: /Trade Republic/ }));
      const a = slowFile(csv(), "a.csv");
      fireEvent.change(screen.getByLabelText("CSV file"), { target: { files: [a.file] } });
      fireEvent.change(screen.getByLabelText("Change file"), {
        target: { files: [new File([csv().split("\n")[0]!], "b.csv")] },
      });
      expect(await screen.findByText("Nothing in this file to import here.")).toBeInTheDocument();
      a.finish();
      await new Promise((r) => setTimeout(r, 20));
      expect(screen.getByText("b.csv")).toBeInTheDocument();
      expect(screen.getByText("Nothing in this file to import here.")).toBeInTheDocument();
    });

    it("after going back to all sources, it doesn't come back", async () => {
      open("stock");
      fireEvent.click(screen.getByRole("button", { name: /Trade Republic/ }));
      const a = slowFile(csv(), "a.csv");
      fireEvent.change(screen.getByLabelText("CSV file"), { target: { files: [a.file] } });
      fireEvent.click(screen.getByRole("button", { name: /All sources/ }));
      a.finish();
      await new Promise((r) => setTimeout(r, 20));
      fireEvent.click(screen.getByRole("button", { name: /My own spreadsheet/ }));
      await new Promise((r) => setTimeout(r, 20));
      expect(screen.getByLabelText("CSV text")).toHaveValue("");
      expect(screen.queryByRole("button", { name: /^Save/ })).toBeNull();
    });
  });

  it("polish-4 N10 before Save the share counts are still to correct", async () => {
    open("stock");
    await pickTradeRepublic();
    expect(screen.getByText("Share counts to correct").parentElement?.textContent).toBe(
      "Share counts to correct2",
    );
  });

  it("polish-4 N11 a source's name never wraps; its hint gives way", () => {
    open("stock");
    const name = screen.getByText("My own spreadsheet");
    expect(name).toHaveClass("shrink-0");
    expect(screen.getByText("Any CSV with our columns")).toHaveClass("min-w-0", "truncate");
  });

  it("polish-4 N12 the preview sets its figures as the page does", async () => {
    open("stock");
    await pickTradeRepublic();
    expect(screen.getByText("€1.20")).toHaveClass("font-figure");
    expect(screen.getByText("Share counts to correct").nextElementSibling).toHaveClass(
      "font-figure",
    );
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
    open("stock", trades);
    fireEvent.click(screen.getByRole("button", { name: /Trade Republic/ }));
    fireEvent.change(screen.getByLabelText("CSV file"), {
      target: { files: [new File([csv], "export.csv", { type: "text/csv" })] },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Save 1 row" }));
    await waitFor(() =>
      expect(toast.success).toHaveBeenLastCalledWith("1 income and cash row imported"),
    );
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
    fireEvent.click(await screen.findByRole("button", { name: "Save 4 trades and 1 row" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(vi.mocked(toast.success).mock.lastCall?.[0]).toBe("4 trades imported");
  });

  it("a Trade Republic file saves its dividends too, skipping ones already saved by id", async () => {
    open("stock");
    fireEvent.click(screen.getByRole("button", { name: /Trade Republic/ }));
    const csv = readFileSync("src/lib/brokers/fixtures/trade_republic.csv", "utf8");
    fireEvent.change(screen.getByLabelText("CSV file"), {
      target: { files: [new File([csv], "export.csv", { type: "text/csv" })] },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Save 4 trades and 1 row" }));
    await waitFor(() => expect(db.upserted).toHaveLength(1));
    const [table, rows, options] = db.upserted[0]!;
    expect(table).toBe("investment_events");
    expect(options).toEqual({ onConflict: "user_id,source,external_id", ignoreDuplicates: true });
    expect(rows).toEqual([
      expect.objectContaining({ kind: "dividend", amount_eur: 1.2, user_id: "u1" }),
    ]);
    await waitFor(() =>
      expect(toast.success).toHaveBeenLastCalledWith("4 trades and 1 income and cash row imported"),
    );
  });

  it("the toast counts what the save saved, even if the trades list changes meanwhile", async () => {
    // During the save the trades list refreshes (another tab saved them): the dialog's new
    // trades drop to none, but this save still inserted 4.
    const csv = readFileSync("src/lib/brokers/fixtures/trade_republic.csv", "utf8");
    const { trades } = parseTradesCsv(csv, {
      kind: "stock",
      knownKeys: new Set(["XX0000000001", "XX0000000002"]),
      today: "2026-11-17",
    });
    const release = slowInsert();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = (saved: Array<Trade>) => (
      <QueryClientProvider client={client}>
        <ImportTrades kind="stock" saved={saved} />
      </QueryClientProvider>
    );
    const { rerender } = render(view([]));
    fireEvent.click(screen.getByText("Import trades from CSV"));
    fireEvent.click(await pickTradeRepublic());
    await waitFor(() => expect(db.inserted).toHaveLength(4));
    rerender(view(trades));
    release();
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(vi.mocked(toast.success).mock.lastCall?.[0]).toBe(
      "4 trades and 1 income and cash row imported",
    );
  });

  it("Esc and All sources do nothing during a save, so an old save can't close a new session", async () => {
    const release = slowInsert();
    open("stock");
    fireEvent.click(await pickTradeRepublic());
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save 4 trades and 1 row" })).toBeDisabled(),
    );
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: /All sources/ }));
    expect(screen.getByText("export.csv")).toBeTruthy();
    release();
    // The save that finished closes the dialog it belongs to.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("when nothing is saving, Esc closes the dialog and All sources goes back", async () => {
    open("stock");
    await pickTradeRepublic();
    fireEvent.click(screen.getByRole("button", { name: /All sources/ }));
    expect(screen.getByText("Where are these trades from?")).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("after a save it refreshes trades, income and costs, holdings, returns and net worth", async () => {
    const client = open("stock");
    const invalidate = vi.spyOn(client, "invalidateQueries");
    fireEvent.click(await pickTradeRepublic());
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(6));
    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toEqual([
      ["holding-trades"],
      ["investment-events"],
      ["holding-keys", "stock"],
      ["holding-performance"],
      ["portfolio-latest"],
      ["net-worth-daily"],
    ]);
  });

  it("a slow save shows a spinner, disables Save, and a double click saves once", async () => {
    const release = slowInsert();
    open("stock");
    const save = await pickTradeRepublic();
    expect(save.querySelector(".animate-spin")).toBeNull();
    fireEvent.click(save);
    // A real double click: the second press lands a moment after the first.
    await new Promise((r) => setTimeout(r, 5));
    fireEvent.click(save);
    expect(save).toBeDisabled();
    expect(save.querySelector(".animate-spin")).not.toBeNull();
    release();
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(db.inserted).toHaveLength(4);
  });

  it("a failed save's error is gone when you open the dialog again", async () => {
    db.upsertError = "boom";
    open("stock");
    fireEvent.click(await pickTradeRepublic());
    expect((await screen.findByRole("alert")).textContent).toMatch(/boom/);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByText("Import trades from CSV"));
    expect(screen.getByText("Where are these trades from?")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("when your holdings can't be loaded the file card says it can't be read, not Reading…", async () => {
    db.holdingsDown = true;
    open("stock");
    fireEvent.click(screen.getByRole("button", { name: /Trade Republic/ }));
    const csv = readFileSync("src/lib/brokers/fixtures/trade_republic.csv", "utf8");
    fireEvent.change(screen.getByLabelText("CSV file"), {
      target: { files: [new File([csv], "export.csv", { type: "text/csv" })] },
    });
    expect(await screen.findByText("Couldn't load your holdings: offline")).toBeTruthy();
    expect(screen.getByText("Can't be read")).toBeTruthy();
    expect(screen.queryByText("Reading…")).toBeNull();
    expect(document.querySelector(".animate-spin")).toBeNull();
  });

  it("an empty file says it's empty instead of reading forever", async () => {
    open("stock");
    fireEvent.click(screen.getByRole("button", { name: /Trade Republic/ }));
    fireEvent.change(screen.getByLabelText("CSV file"), {
      target: { files: [new File(["  \n"], "empty.csv", { type: "text/csv" })] },
    });
    expect(await screen.findByText("The file is empty.")).toBeTruthy();
    expect(screen.getByText("Can't be imported")).toBeTruthy();
    expect(screen.queryByText("Reading…")).toBeNull();
  });

  it("while the file is being read it says Reading…", () => {
    open("stock");
    fireEvent.click(screen.getByRole("button", { name: /Trade Republic/ }));
    fireEvent.change(screen.getByLabelText("CSV file"), {
      target: { files: [new File(["x"], "export.csv", { type: "text/csv" })] },
    });
    expect(screen.getByText("Reading…")).toBeTruthy();
  });

  it("a save with trades and other rows asks who you are once", async () => {
    open("stock");
    fireEvent.click(await pickTradeRepublic());
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(db.getUserCalls).toBe(1);
  });

  it("one new trade is counted in the singular", async () => {
    const csv = readFileSync("src/lib/brokers/fixtures/trade_republic.csv", "utf8");
    const { trades } = parseTradesCsv(csv, {
      kind: "stock",
      knownKeys: new Set(["XX0000000001", "XX0000000002"]),
      today: "2026-11-17",
    });
    open("stock", trades.slice(1));
    fireEvent.click(screen.getByRole("button", { name: /Trade Republic/ }));
    fireEvent.change(screen.getByLabelText("CSV file"), {
      target: { files: [new File([csv], "export.csv", { type: "text/csv" })] },
    });
    expect(await screen.findByRole("button", { name: "Save 1 trade and 1 row" })).toBeTruthy();
    expect(screen.getByText("new trade to save")).toBeTruthy();
  });

  it("with only share counts to fix, Save and the toast say share counts", async () => {
    const csv = readFileSync("src/lib/brokers/fixtures/trade_republic.csv", "utf8");
    const { trades, events } = parseTradesCsv(csv, {
      kind: "stock",
      knownKeys: new Set(["XX0000000001", "XX0000000002"]),
      today: "2026-11-17",
    });
    db.events.push(...events!.map((e) => ({ ...e })));
    open("stock", trades);
    fireEvent.click(screen.getByRole("button", { name: /Trade Republic/ }));
    fireEvent.change(screen.getByLabelText("CSV file"), {
      target: { files: [new File([csv], "export.csv", { type: "text/csv" })] },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Save share counts" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(vi.mocked(toast.success).mock.lastCall?.[0]).toBe("2 share counts corrected");
    expect(db.inserted).toEqual([]);
    expect(db.rpc).toHaveLength(2);
  });

  it("Save waits for your saved dividends and fees, so a re-import can't save them twice", async () => {
    db.eventsHang = true;
    open("stock");
    expect(await pickTradeRepublic()).toBeDisabled();
    expect(screen.queryByText("Also saved: income, fees and cash")).toBeNull();
  });

  it("on a backend without set_holding_quantity a stock's count is set on the holding itself", async () => {
    db.rpcMissing = true;
    open("stock");
    fireEvent.click(await pickTradeRepublic());
    await waitFor(() => expect(db.updated).toHaveLength(2));
    expect(db.updated).toEqual([
      ["portfolio_holdings", { shares: 4 }, [["isin", "XX0000000001"]]],
      ["portfolio_holdings", { shares: 0 }, [["isin", "XX0000000002"]]],
    ]);
  });

  it("signed out, nothing is saved and it says to sign in", async () => {
    db.signedOut = true;
    open("stock");
    fireEvent.click(await pickTradeRepublic());
    expect((await screen.findByRole("alert")).textContent).toBe(
      "You're signed out. Sign in and try again.",
    );
    expect(db.inserted).toEqual([]);
    expect(db.upserted).toEqual([]);
  });

  it("if only other rows are saved and they fail, it shows the database's error", async () => {
    db.upsertError = "boom";
    const csv = readFileSync("src/lib/brokers/fixtures/trade_republic.csv", "utf8");
    const { trades } = parseTradesCsv(csv, {
      kind: "stock",
      knownKeys: new Set(["XX0000000001", "XX0000000002"]),
      today: "2026-11-17",
    });
    open("stock", trades);
    fireEvent.click(screen.getByRole("button", { name: /Trade Republic/ }));
    fireEvent.change(screen.getByLabelText("CSV file"), {
      target: { files: [new File([csv], "export.csv", { type: "text/csv" })] },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Save 1 row" }));
    expect((await screen.findByRole("alert")).textContent).toBe("boom");
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("with no counts to fix, other rows the database already had are nothing new", async () => {
    db.upsertSaved = 0;
    // The holdings already match the file.
    db.stocks[0]!["shares"] = 4;
    db.stocks[1]!["shares"] = 0;
    const csv = readFileSync("src/lib/brokers/fixtures/trade_republic.csv", "utf8");
    const { trades } = parseTradesCsv(csv, {
      kind: "stock",
      knownKeys: new Set(["XX0000000001", "XX0000000002"]),
      today: "2026-11-17",
    });
    open("stock", trades);
    fireEvent.click(screen.getByRole("button", { name: /Trade Republic/ }));
    fireEvent.change(screen.getByLabelText("CSV file"), {
      target: { files: [new File([csv], "export.csv", { type: "text/csv" })] },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Save 1 row" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(vi.mocked(toast.success).mock.lastCall?.[0]).toBe("Nothing new imported");
    expect(db.rpc).toEqual([]);
  });

  it("the summary counts buys and sells and gives the dates, one date for one day", async () => {
    const csv = readFileSync("src/lib/brokers/fixtures/trade_republic.csv", "utf8");
    const { trades } = parseTradesCsv(csv, {
      kind: "stock",
      knownKeys: new Set(["XX0000000001", "XX0000000002"]),
      today: "2026-11-17",
    });
    open("stock");
    await pickTradeRepublic();
    expect(screen.getByText(/buys? · /).textContent).toBe(
      "3 buys · 1 sell · 2 Jan 2026 – 3 Feb 2026",
    );
    cleanup();
    // Only the two buys of 2 January are new.
    open(
      "stock",
      trades.filter((t) => t.trade_date !== "2026-01-02"),
    );
    fireEvent.click(screen.getByRole("button", { name: /Trade Republic/ }));
    fireEvent.change(screen.getByLabelText("CSV file"), {
      target: { files: [new File([csv], "export.csv", { type: "text/csv" })] },
    });
    await screen.findByRole("button", { name: "Save 2 trades and 1 row" });
    expect(screen.getByText(/buys? · /).textContent).toBe("2 buys · 2 Jan 2026");
  });

  it("during a save the file and paste box can't be changed, so the save can't wipe new input", async () => {
    const release = slowInsert();
    open("stock");
    fireEvent.click(screen.getByRole("button", { name: /My own spreadsheet/ }));
    const box = screen.getByLabelText("CSV text");
    fireEvent.change(box, {
      target: { value: "date,side,isin,shares,price,fee\n2026-01-15,buy,XX0000000001,1,10,0" },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Save 1 trade" }));
    await waitFor(() => expect(box).toBeDisabled());
    expect(screen.getByLabelText("CSV file")).toBeDisabled();
    // A file dropped meanwhile is not read.
    fireEvent.drop(screen.getByText("or drop it here"), {
      dataTransfer: { files: [new File(["x"], "late.csv", { type: "text/csv" })] },
    });
    expect(screen.queryByText("late.csv")).toBeNull();
    release();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("when nothing is saving the file and paste box can be used", () => {
    open("stock");
    fireEvent.click(screen.getByRole("button", { name: /My own spreadsheet/ }));
    expect(screen.getByLabelText("CSV text")).toBeEnabled();
    expect(screen.getByLabelText("CSV file")).toBeEnabled();
    fireEvent.drop(screen.getByText("or drop it here"), {
      dataTransfer: { files: [new File(["x"], "mine.csv", { type: "text/csv" })] },
    });
    expect(screen.getByText("mine.csv")).toBeTruthy();
  });
});
