import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const db = vi.hoisted(() => ({
  inserted: [] as Array<Record<string, unknown>>,
  upserted: [] as Array<[string, Array<Record<string, unknown>>, unknown]>,
  rpc: [] as Array<[string, Record<string, unknown>]>,
  ratesDown: false,
  holdingsDown: false,
  /** Coin rows added for one test. */
  extraCoins: [] as Array<Record<string, unknown>>,
  rpcMissing: false,
  /** Set, a write answers with this error (set_holding_quantity for rpcError). */
  insertError: null as null | Record<string, unknown>,
  rpcError: null as null | Record<string, unknown>,
  updateError: null as null | Record<string, unknown>,
  upsertError: null as string | null,
  eventsDown: false,
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
  /** Set, the exchange rates wait for it. */
  ratesGate: null as null | Promise<void>,
  /** How many times the exchange rates were read. */
  ratesReads: 0,
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
      "2026-01-25",
      "2026-02-01",
      "2026-02-10",
      "2026-02-20",
      "2026-03-01",
    ].map((date) => ({ date, rate_to_eur: 0.9 })),
  };
  // Every filter is ignored: each table answers with all its rows.
  const query = (rows: Array<Record<string, unknown>>) => {
    const down =
      (rows === tables["fx_rates"] && db.ratesDown) ||
      (rows === tables["investment_events"] && db.eventsDown) ||
      ((rows === tables["portfolio_holdings"] || rows === tables["crypto_holdings"]) &&
        db.holdingsDown);
    const result = Promise.resolve(
      down ? { data: null, error: { message: "offline" } } : { data: rows, error: null },
    );
    return Object.assign(result, {
      eq: () => query(rows),
      gte: () => query(rows),
      lte: () => query(rows),
      order: () => query(rows),
      limit: () => query(rows),
      range: () => {
        if (rows === tables["investment_events"] && db.eventsHang) return new Promise(() => {});
        if (rows === tables["fx_rates"]) db.ratesReads++;
        return (
          rows === tables["fx_rates"] && db.ratesGate ? db.ratesGate : Promise.resolve()
        ).then(() =>
          down
            ? { data: null, error: { message: "offline" }, count: null }
            : { data: rows, error: null, count: rows.length },
        );
      },
    });
  };
  return {
    supabase: {
      from: (table: string) => ({
        select: () =>
          query(
            table === "crypto_holdings" && db.extraCoins.length > 0
              ? [...tables[table]!, ...db.extraCoins]
              : (tables[table] ?? []),
          ),
        update: (patch: Record<string, unknown>) => {
          const where: Array<[string, unknown]> = [];
          db.updated.push([table, patch, where]);
          const chain = {
            eq: (c: string, v: unknown) => (where.push([c, v]), chain),
            then: (resolve: (v: unknown) => void) => resolve({ error: db.updateError }),
          };
          return chain;
        },
        insert: (rows: Array<Record<string, unknown>>) => {
          if (db.insertError) return Promise.resolve({ error: db.insertError });
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
          db.rpcError
            ? { data: null, error: db.rpcError }
            : db.rpcMissing
              ? { data: null, error: { code: "PGRST202", message: "not found" } }
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
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, ...rest }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
import { toast } from "sonner";

import { ImportTrades } from "./import-trades";
import { parseTradesCsv } from "@/lib/trades-csv";
import type { Trade } from "@/lib/trades";

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

function pick(name: RegExp, fixture: string) {
  fireEvent.click(screen.getByRole("button", { name }));
  const csv = readFileSync(`src/lib/brokers/fixtures/${fixture}`, "utf8");
  fireEvent.change(screen.getByLabelText("CSV file"), {
    target: { files: [new File([csv], "ops.csv", { type: "text/csv" })] },
  });
}

/** The file status row's icon: lucide names each svg by its icon. */
const statusIcon = () => document.querySelector("svg.lucide-check, svg.lucide-circle-alert");

function pickText(name: RegExp, csv: string) {
  fireEvent.click(screen.getByRole("button", { name }));
  fireEvent.change(screen.getByLabelText("CSV file"), {
    target: { files: [new File([csv], "ops.csv", { type: "text/csv" })] },
  });
}

function open(kind: "stock" | "crypto", saved: Array<Trade> = []) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
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
    db.rpcError = null;
    db.upsertError = null;
    db.upsertSaved = null;
    db.eventsDown = false;
    db.holdingsDown = false;
    db.eventsHang = false;
    db.getUserCalls = 0;
    db.events.length = 0;
    db.insertGate = null;
    vi.mocked(toast.success).mockClear();
    db.ratesDown = false;
    db.extraCoins.length = 0;
    db.insertError = null;
    db.updateError = null;
    db.signedOut = false;
    db.ratesGate = null;
    db.ratesReads = 0;
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

  it("the source list says where Ledger Live's file comes from: its desktop app", () => {
    open("crypto");
    expect(screen.getByRole("button", { name: /Ledger Live/ }).textContent).toContain(
      "Desktop app export",
    );
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
    // Listed under By holding, and under Share counts to correct too.
    expect(screen.getAllByText("Example World ETF")).toHaveLength(2);
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
    expect(screen.getByText("Holdings to correct")).toBeTruthy();
    expect(screen.queryByText("Share counts corrected")).toBeNull();
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

  it("a stock import corrects the share counts through set_holding_quantity", async () => {
    open("stock");
    pick(/Trade Republic/, "trade_republic.csv");
    // "and 1 row": the file's dividend is saved too.
    const save = await screen.findByRole("button", { name: /^Save 4 trades/ });
    expect(screen.getByText("Share counts to correct")).toBeTruthy();
    fireEvent.click(save);
    await waitFor(() => expect(db.rpc.length).toBeGreaterThan(0));
    expect(db.rpc[0]![0]).toBe("set_holding_quantity");
    expect(db.rpc[0]![1]).toMatchObject({ p_kind: "stock", p_key: "XX0000000001", p_quantity: 4 });
    expect(db.updated).toHaveLength(0);
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

  it("a coin held on Ledger and added by hand too is corrected on its Ledger row", async () => {
    db.extraCoins.push({ asset_symbol: "ETH", amount: 0.1, name: "Ethereum", source: "Ledger" });
    open("crypto");
    fireEvent.click(screen.getByRole("button", { name: /Ledger Live/ }));
    const csv = readFileSync("src/lib/brokers/fixtures/ledger_live.csv", "utf8");
    fireEvent.change(screen.getByLabelText("CSV file"), {
      target: { files: [new File([csv], "ops.csv", { type: "text/csv" })] },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Save 7 trades" }));
    await waitFor(() => expect(db.rpc).toHaveLength(1));
    expect(db.rpc[0]![1]).toMatchObject({ p_key: "ETH", p_source: "Ledger" });
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

  describe("polish-5 B1 Trade Republic coins go only to manual coins or ones you don't hold", () => {
    // Holdings: BTC on Ledger, eth added by hand (0.4), USDT on Coinbase.
    const tr = (...rows: Array<string>) =>
      [
        "datetime,date,category,type,asset_class,name,symbol,shares,price,amount,fee,tax,currency,transaction_id",
        ...rows.map((r, i) => `2026-03-02T09:30:00Z,2026-03-02,${r},EUR,tr-${i}`),
      ].join("\n");
    const ethBuy = "TRADING,BUY,CRYPTO,Ethereum,ETH,0.1,2000,-200,,";

    it("a coin held only on Coinbase is left out, with a note", async () => {
      open("crypto");
      pickText(/Trade Republic/, tr("TRADING,BUY,CRYPTO,Tether,USDT,10,0.9,-9,,", ethBuy));
      fireEvent.click(await screen.findByRole("button", { name: "Save 1 trade" }));
      expect(
        screen.getByText(
          "Tether has no manual holding, so it was left out. Add it as a manual coin, then import again.",
        ),
      ).toBeInTheDocument();
      await waitFor(() => expect(db.inserted).toHaveLength(1));
      expect(db.inserted[0]).toMatchObject({ key: "ETH", source: "trade_republic" });
    });

    it("a coin held on Ledger is left out, with a note", async () => {
      open("crypto");
      pickText(/Trade Republic/, tr("TRADING,BUY,CRYPTO,Bitcoin,BTC,0.001,60000,-60,,", ethBuy));
      await screen.findByRole("button", { name: "Save 1 trade" });
      expect(screen.getByText(/^Bitcoin has no manual holding, so it was left out/)).toBeTruthy();
    });

    it("a manual coin whose count differs gets its trades, and its count is left alone", async () => {
      open("crypto");
      pickText(/Trade Republic/, tr(ethBuy));
      fireEvent.click(await screen.findByRole("button", { name: "Save 1 trade" }));
      expect(screen.queryByRole("region", { name: "Holdings to correct" })).toBeNull();
      expect(screen.queryByText(/has no manual holding/)).toBeNull();
      await waitFor(() => expect(db.inserted).toHaveLength(1));
      expect(db.inserted[0]).toMatchObject({ key: "ETH", shares: 0.1 });
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(db.rpc).toEqual([]);
    });

    it("a coin you don't hold: bought, it's left out with a note; sold off, its trades are kept", async () => {
      open("crypto");
      pickText(
        /Trade Republic/,
        tr(
          "TRADING,BUY,CRYPTO,Solana,SOL,2,100,-200,,",
          "TRADING,BUY,CRYPTO,Cardano,ADA,10,1,-10,,",
          "TRADING,SELL,CRYPTO,Cardano,ADA,-10,1.2,12,,",
        ),
      );
      await screen.findByRole("button", { name: "Save 2 trades" });
      expect(
        screen.getByText(
          "Solana has no manual holding, so it was left out. Add it as a manual coin, then import again.",
        ),
      ).toBeTruthy();
      expect(screen.getByText(/Cardano · fully sold/)).toBeTruthy();
    });

    it("a saveback row is saved as a reward and leaves the coin's count alone", async () => {
      open("crypto");
      pickText(
        /Trade Republic/,
        tr(ethBuy, "BENEFITS,BENEFITS_SAVEBACK,CRYPTO,Ethereum,ETH,0.0015,,3,,"),
      );
      fireEvent.click(await screen.findByRole("button", { name: "Save 1 trade and 1 row" }));
      expect(screen.queryByRole("region", { name: "Holdings to correct" })).toBeNull();
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(db.inserted).toHaveLength(1);
      expect(db.upserted[0]![1]).toMatchObject([{ kind: "reward", key: "ETH", shares: 0.0015 }]);
      expect(db.rpc).toEqual([]);
    });
  });

  it("when the exchange rates can't be loaded it says so and offers no save", async () => {
    db.ratesDown = true;
    open("crypto");
    fireEvent.click(screen.getByRole("button", { name: /Ledger Live/ }));
    const csv = readFileSync("src/lib/brokers/fixtures/ledger_live.csv", "utf8");
    fireEvent.change(screen.getByLabelText("CSV file"), {
      target: { files: [new File([csv], "ops.csv", { type: "text/csv" })] },
    });
    // One retry first (no wait in tests).
    expect((await screen.findByText(/Couldn't load USD to EUR rates/)).textContent).not.toMatch(
      /Try again/,
    );
    expect(screen.queryByRole("button", { name: /^Save/ })).toBeNull();
    // The file card stops reading: it waits for the rates.
    expect(screen.getByRole("status").textContent).toBe("Waiting for exchange rates");
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
      expect(toast.success).toHaveBeenLastCalledWith(
        "Imported 4 trades and 1 income and cash row, updated 2 share counts",
      ),
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

  it("polish-4 UB14 focus moves to the step's title, then to the file's status", async () => {
    open("stock");
    fireEvent.click(screen.getByRole("button", { name: /Trade Republic/ }));
    // The new step's title (grnc06 #14a), from which the steps and the picker follow.
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { name: "Import from Trade Republic" }),
    );
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

  it("polish-4 N1 a file that can't be imported shows an alert, not a check", async () => {
    open("stock");
    fireEvent.click(screen.getByRole("button", { name: /Trade Republic/ }));
    fireEvent.change(screen.getByLabelText("CSV file"), {
      target: { files: [new File(["a,b\n1,2"], "wrong.csv", { type: "text/csv" })] },
    });
    expect(await screen.findByText("Can't be imported")).toBeInTheDocument();
    const card = screen.getByText("wrong.csv").closest("[tabindex]")!;
    expect(card.querySelector(".lucide-check")).toBeNull();
    // An alert icon (grnc06 #5), not an X beside the dialog's own close X.
    expect(card.querySelector(".lucide-circle-alert")).not.toBeNull();
  });

  it("polish-4 N5 if the share counts fail after the trades saved, it says the trades are saved", async () => {
    db.rpcError = { code: "XX000", message: "boom" };
    open("stock");
    fireEvent.click(await pickTradeRepublic());
    expect((await screen.findByRole("alert")).textContent).toBe(
      "4 trades saved, but the share counts and the income, fee and cash rows weren't (boom). Import the file again to save them.",
    );
    expect(db.upserted).toEqual([]);
  });

  it("polish-4 N5 with no trades saved, a share count failure shows the database's error", async () => {
    db.rpcError = { code: "XX000", message: "boom" };
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
    // Each one listed under that heading: 2 of them.
    const region = screen.getByRole("region", { name: "Share counts to correct" });
    expect(within(region).getAllByRole("listitem")).toHaveLength(2);
    expect(screen.queryByText("Share counts corrected")).toBeNull();
  });

  it.each([
    ["stock", "Share counts to correct"],
    ["crypto", "Holdings to correct"],
  ] as const)(
    "polish-5 B2 before Save a %s preview says what's still to correct",
    async (kind, heading) => {
      open(kind);
      if (kind === "stock") await pickTradeRepublic();
      else {
        pick(/Ledger Live/, "ledger_live.csv");
        await screen.findByRole("button", { name: "Save 7 trades" });
      }
      expect(screen.getByRole("region", { name: heading })).toBeInTheDocument();
      expect(screen.queryByText(/corrected$/)).toBeNull();
    },
  );

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
    const region = screen.getByRole("region", { name: "Share counts to correct" });
    expect(within(region).getByText("1 → 4")).toHaveClass("font-figure");
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
      expect(toast.success).toHaveBeenLastCalledWith(
        "Imported 1 income and cash row, updated 2 share counts",
      ),
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
    expect(vi.mocked(toast.success).mock.lastCall?.[0]).toBe(
      "Imported 4 trades, updated 2 share counts",
    );
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
      expect(toast.success).toHaveBeenLastCalledWith(
        "Imported 4 trades and 1 income and cash row, updated 2 share counts",
      ),
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
      "Imported 4 trades and 1 income and cash row, updated 2 share counts",
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

  it.each([
    ["crypto", /Ledger Live/, "ledger_live.csv", "crypto-latest", "portfolio-latest"],
    ["stock", /Trade Republic/, "trade_republic.csv", "portfolio-latest", "crypto-latest"],
  ] as const)(
    "a %s import refreshes that page's holdings",
    async (kind, from, file, key, other) => {
      const client = open(kind);
      const invalidate = vi.spyOn(client, "invalidateQueries");
      pick(from, file);
      fireEvent.click(await screen.findByRole("button", { name: /^Save \d+ trades/ }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      const keys = invalidate.mock.calls.map(([f]) => f?.queryKey);
      expect(keys).toContainEqual([key]);
      expect(keys).not.toContainEqual([other]);
    },
  );

  it("after a rates error, Try again loads them and offers the save", async () => {
    db.ratesDown = true;
    open("crypto");
    pick(/Ledger Live/, "ledger_live.csv");
    await screen.findByText(/Couldn't load USD to EUR rates/);
    db.ratesDown = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: "Save 7 trades" })).toBeTruthy();
    expect(screen.queryByText(/Couldn't load USD to EUR rates/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("counts are grouped in the reader's locale", async () => {
    const language = vi.spyOn(navigator, "language", "get").mockReturnValue("en-GB");
    onTestFinished(() => language.mockRestore());
    const rows = Array.from({ length: 1234 }, (_, i) => {
      const day = new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10);
      return `${day},buy,XX0000000001,1,${100 + i}`;
    });
    open("stock");
    fireEvent.click(screen.getByRole("button", { name: /My own spreadsheet/ }));
    fireEvent.change(screen.getByLabelText("CSV text"), {
      target: { value: ["date,side,isin,shares,price", ...rows].join("\n") },
    });
    await screen.findByText("new trades to save");
    expect(screen.getByText("1,234")).toBeTruthy();
  });

  it("when your holdings can't be loaded it says so", async () => {
    db.holdingsDown = true;
    open("crypto");
    expect(await screen.findByText("Couldn't load your holdings: offline")).toBeTruthy();
  });

  it.each([
    ["the exchange rates", () => (db.ratesDown = true), /Couldn't load USD to EUR rates/],
    ["your holdings", () => (db.holdingsDown = true), /Couldn't load your holdings/],
  ])("when %s can't be loaded the file stops reading", async (what, fail, message) => {
    fail();
    open("crypto");
    pick(/Ledger Live/, "ledger_live.csv");
    await screen.findByText(message);
    // Only the rates failed: the file is fine, it waits for them.
    expect(screen.getByRole("status").textContent).toBe(
      what === "the exchange rates" ? "Waiting for exchange rates" : "Can't be read",
    );
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
    expect(vi.mocked(toast.success).mock.lastCall?.[0]).toBe("Updated 2 share counts");
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

  it("while the exchange rates load it says Reading… and offers no save yet", async () => {
    let release!: () => void;
    db.ratesGate = new Promise((r) => (release = r));
    open("crypto");
    pick(/Ledger Live/, "ledger_live.csv");
    expect(await screen.findByText("Reading…")).toBeTruthy();
    expect(document.querySelector(".animate-spin")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Save/ })).toBeNull();
    release();
    expect(await screen.findByRole("button", { name: "Save 7 trades" })).toBeTruthy();
    expect(screen.queryByText("Reading…")).toBeNull();
  });

  it("the dialog can't be closed while saving, and closes once saved", async () => {
    let release!: () => void;
    db.insertGate = new Promise((r) => (release = r));
    open("crypto");
    pick(/Ledger Live/, "ledger_live.csv");
    fireEvent.click(await screen.findByRole("button", { name: "Save 7 trades" }));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("ops.csv")).toBeTruthy();
    release();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(db.inserted).toHaveLength(7);
  });

  it("while saving, the file can't be swapped or the source left", async () => {
    let release!: () => void;
    db.insertGate = new Promise((r) => (release = r));
    open("crypto");
    pick(/Ledger Live/, "ledger_live.csv");
    fireEvent.click(await screen.findByRole("button", { name: "Save 7 trades" }));
    const back = screen.getByRole("button", { name: /All sources/ });
    await waitFor(() => expect((back as HTMLButtonElement).disabled).toBe(true));
    fireEvent.click(back);
    // Named Change file once a file is chosen (polish-4 UB13).
    expect((screen.getByLabelText("Change file") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText("ops.csv")).toBeTruthy();
    release();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(db.inserted).toHaveLength(7);
  });

  it("while a pasted spreadsheet saves, its text and the drop zone are locked", async () => {
    let release!: () => void;
    db.insertGate = new Promise((r) => (release = r));
    open("crypto");
    fireEvent.click(screen.getByRole("button", { name: /My own spreadsheet/ }));
    const csv = readFileSync("src/lib/brokers/fixtures/ledger_live.csv", "utf8");
    fireEvent.change(screen.getByLabelText("CSV text"), { target: { value: csv } });
    fireEvent.click(await screen.findByRole("button", { name: "Save 7 trades" }));
    const area = screen.getByLabelText("CSV text") as HTMLTextAreaElement;
    await waitFor(() => expect(area.disabled).toBe(true));
    const dropped = new File([csv], "dropped.csv", { type: "text/csv" });
    fireEvent.drop(screen.getByLabelText("CSV file").closest("label")!, {
      dataTransfer: { files: [dropped] },
    });
    expect(screen.queryByText("dropped.csv")).toBeNull();
    release();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(db.inserted).toHaveLength(7);
  });

  it("Esc closes the dialog when nothing is saving", async () => {
    open("crypto");
    pick(/Ledger Live/, "ledger_live.csv");
    await screen.findByRole("button", { name: "Save 7 trades" });
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("a failed save's error is gone after closing and opening again", async () => {
    db.insertError = { message: "insert failed" };
    open("crypto");
    pick(/Ledger Live/, "ledger_live.csv");
    fireEvent.click(await screen.findByRole("button", { name: "Save 7 trades" }));
    await screen.findByText("insert failed");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByText("Import trades from CSV"));
    expect(screen.getByText("Where are these trades from?")).toBeTruthy();
    expect(screen.queryByText("insert failed")).toBeNull();
  });

  it("a second click while saving saves nothing twice", async () => {
    let release!: () => void;
    db.insertGate = new Promise((r) => (release = r));
    open("crypto");
    pick(/Ledger Live/, "ledger_live.csv");
    const save = await screen.findByRole("button", { name: "Save 7 trades" });
    fireEvent.click(save);
    fireEvent.click(save);
    await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(true));
    fireEvent.click(save);
    release();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(db.inserted).toHaveLength(7);
    expect(db.rpc).toHaveLength(1);
  });

  it("after a failed save you can save again", async () => {
    db.insertError = { message: "insert failed" };
    open("crypto");
    pick(/Ledger Live/, "ledger_live.csv");
    const save = await screen.findByRole("button", { name: "Save 7 trades" });
    fireEvent.click(save);
    await screen.findByText("insert failed");
    db.insertError = null;
    fireEvent.click(save);
    await waitFor(() => expect(db.inserted).toHaveLength(7));
  });

  describe("a failed save says why, saves nothing more and stays open", () => {
    async function saveFails(kind: "stock" | "crypto", message: RegExp) {
      open(kind);
      if (kind === "crypto") pick(/Ledger Live/, "ledger_live.csv");
      else pick(/Trade Republic/, "trade_republic.csv");
      fireEvent.click(await screen.findByRole("button", { name: /^Save \d+ trades/ }));
      expect((await screen.findByRole("alert")).textContent).toMatch(message);
      expect(screen.getByRole("dialog")).toBeTruthy();
    }

    it("the trades can't be written", async () => {
      db.insertError = { message: "insert failed" };
      await saveFails("crypto", /insert failed/);
      expect(db.inserted).toHaveLength(0);
      expect(db.rpc).toHaveLength(0);
    });

    it("you're signed out", async () => {
      db.signedOut = true;
      await saveFails("crypto", /You're signed out/);
      expect(db.inserted).toHaveLength(0);
      expect(db.rpc).toHaveLength(0);
    });

    it("the count is refused (42501), with no fallback write", async () => {
      db.rpcError = { code: "42501", message: "permission denied" };
      await saveFails("crypto", /permission denied/);
      expect(db.rpc).toHaveLength(1);
      expect(db.updated).toHaveLength(0);
    });

    it("the fallback count write fails", async () => {
      db.rpcMissing = true;
      db.updateError = { message: "update failed" };
      await saveFails("crypto", /update failed/);
      expect(db.updated).toHaveLength(1);
    });

    it("a stock count write fails", async () => {
      db.rpcMissing = true;
      db.updateError = { message: "update failed" };
      await saveFails("stock", /update failed/);
      expect(db.updated).toHaveLength(1);
      expect(db.updated[0]![0]).toBe("portfolio_holdings");
    });
  });

  describe("the file's icon matches its state", () => {
    it("read: a check", async () => {
      open("crypto");
      pick(/Ledger Live/, "ledger_live.csv");
      await screen.findByRole("button", { name: "Save 7 trades" });
      expect(statusIcon()?.classList.contains("lucide-check")).toBe(true);
    });

    it("rates failed: an alert, not a check", async () => {
      db.ratesDown = true;
      open("crypto");
      pick(/Ledger Live/, "ledger_live.csv");
      await screen.findByRole("button", { name: "Try again" });
      expect(statusIcon()?.classList.contains("lucide-circle-alert")).toBe(true);
    });

    it("bad lines: an alert, not a check", async () => {
      open("stock");
      pickText(
        /My own spreadsheet/,
        "date,side,isin,shares,price\n2026-01-02,buy,XX0000000001,abc,10",
      );
      await screen.findByText(/Fix these first/);
      expect(statusIcon()?.classList.contains("lucide-circle-alert")).toBe(true);
    });
  });

  it("Change is a 44px tap target, underlined, with a keyboard focus ring", async () => {
    open("crypto");
    pick(/Ledger Live/, "ledger_live.csv");
    await screen.findByRole("button", { name: "Save 7 trades" });
    const change = screen.getByLabelText("Change file").closest("label")!;
    expect(change.textContent).toBe("Change");
    for (const c of ["underline", "min-h-11", "has-[:focus-visible]:ring-2"])
      expect(change.classList.contains(c), c).toBe(true);
  });

  it("the Ask for your broker link is always underlined", () => {
    open("stock");
    fireEvent.click(screen.getByRole("button", { name: /Another broker/ }));
    expect(screen.getByRole("link", { name: "Ask for your broker" }).classList).toContain(
      "underline",
    );
  });

  it("the file's status line is announced: Reading…, then the result", async () => {
    let release!: () => void;
    db.ratesGate = new Promise((r) => (release = r));
    open("crypto");
    pick(/Ledger Live/, "ledger_live.csv");
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Reading…"));
    release();
    await screen.findByRole("button", { name: "Save 7 trades" });
    expect(screen.getByRole("status").textContent).toBe("Read, check what it found below");
  });

  it("Try again shows it's trying until the rates arrive", async () => {
    db.ratesDown = true;
    open("crypto");
    pick(/Ledger Live/, "ledger_live.csv");
    await screen.findByRole("button", { name: "Try again" });
    let release!: () => void;
    db.ratesDown = false;
    db.ratesGate = new Promise((r) => (release = r));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    const trying = await screen.findByRole("button", { name: "Trying…" });
    expect(trying.getAttribute("aria-disabled")).toBe("true");
    expect(trying.querySelector(".animate-spin")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Reading…");
    release();
    expect(await screen.findByRole("button", { name: "Save 7 trades" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Trying|Try again/ })).toBeNull();
  });

  it("Try again keeps keyboard focus while it tries, and ignores another press", async () => {
    db.ratesDown = true;
    open("crypto");
    pick(/Ledger Live/, "ledger_live.csv");
    const button = await screen.findByRole("button", { name: "Try again" });
    let release!: () => void;
    db.ratesDown = false;
    db.ratesGate = new Promise((r) => (release = r));
    const before = db.ratesReads;
    button.focus();
    fireEvent.click(button);
    const trying = await screen.findByRole("button", { name: "Trying…" });
    // aria-disabled, not disabled: a disabled button drops keyboard focus to the page body.
    expect(trying.hasAttribute("disabled")).toBe(false);
    expect(document.activeElement).toBe(trying);
    await waitFor(() => expect(db.ratesReads).toBeGreaterThan(before));
    const reads = db.ratesReads;
    fireEvent.click(trying);
    await new Promise((r) => setTimeout(r, 20));
    expect(db.ratesReads).toBe(reads);
    expect(screen.getByRole("button", { name: "Trying…" })).toBe(trying);
    expect(document.activeElement).toBe(trying);
    release();
    expect(await screen.findByRole("button", { name: "Save 7 trades" })).toBeTruthy();
  });

  it("a retry that fails again offers Try again once more", async () => {
    db.ratesDown = true;
    open("crypto");
    pick(/Ledger Live/, "ledger_live.csv");
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    const again = await screen.findByRole("button", { name: "Try again" });
    expect((again as HTMLButtonElement).disabled).toBe(false);
    expect(again.hasAttribute("aria-disabled")).toBe(false);
    expect(screen.getByRole("status").textContent).toBe("Waiting for exchange rates");
  });

  it.each([
    ["Try again", () => (db.ratesDown = true), () => pick(/Ledger Live/, "ledger_live.csv")],
    [
      "Use a spreadsheet",
      () => {},
      () => fireEvent.click(screen.getByRole("button", { name: /Another broker/ })),
    ],
  ])("%s has a border on the dialog's background", async (name, setup, go) => {
    setup();
    open("crypto");
    go();
    const button = await screen.findByRole("button", { name });
    expect(button.classList).toContain("border");
    expect(button.classList).toContain("border-rule");
  });

  it("a file with errors offers no Save; a clean one does", async () => {
    open("stock");
    pickText(
      /My own spreadsheet/,
      "date,side,isin,shares,price\n2026-01-02,buy,XX0000000001,abc,10",
    );
    await screen.findByText(/Fix these first/);
    expect(screen.queryByRole("button", { name: /^Save/ })).toBeNull();
    fireEvent.change(screen.getByLabelText("Change file"), {
      target: {
        files: [
          new File(["date,side,isin,shares,price\n2026-01-02,buy,XX0000000001,1,10"], "ok.csv"),
        ],
      },
    });
    expect(await screen.findByRole("button", { name: "Save 1 trade" })).toBeTruthy();
  });

  describe("corrected holdings", () => {
    const corrected = () => screen.getByRole("region", { name: "Holdings to correct" });

    it("lists each one: name, source, old → new, with its decimals", async () => {
      db.extraCoins.push({ asset_symbol: "LTC", amount: 0.5, name: "Litecoin", source: "Manual" });
      open("crypto");
      pick(/Ledger Live/, "ledger_live.csv");
      await screen.findByRole("button", { name: "Save 7 trades" });
      const rows = within(corrected()).getAllByRole("listitem");
      expect(rows.map((r) => r.textContent)).toEqual([
        "EthereumManual0.4 → 0.4988",
        "LitecoinManual0.5 → 0",
      ]);
    });

    it("the toast counts the trades and the holdings updated", async () => {
      db.extraCoins.push({ asset_symbol: "LTC", amount: 0.5, name: "Litecoin", source: "Manual" });
      open("crypto");
      pick(/Ledger Live/, "ledger_live.csv");
      fireEvent.click(await screen.findByRole("button", { name: "Save 7 trades" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(toast.success).toHaveBeenLastCalledWith("Imported 7 trades, updated 2 holdings");
    });

    it("one holding updated is singular", async () => {
      open("crypto");
      pick(/Ledger Live/, "ledger_live.csv");
      fireEvent.click(await screen.findByRole("button", { name: "Save 7 trades" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(toast.success).toHaveBeenLastCalledWith("Imported 7 trades, updated 1 holding");
    });

    it("nothing corrected: no list, and the toast only counts the trades", async () => {
      open("stock");
      pickText(
        /My own spreadsheet/,
        "date,side,isin,shares,price\n2026-01-02,buy,XX0000000001,1,10",
      );
      fireEvent.click(await screen.findByRole("button", { name: "Save 1 trade" }));
      expect(screen.queryByRole("region", { name: /corrected/ })).toBeNull();
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(toast.success).toHaveBeenLastCalledWith("Imported 1 trade");
    });

    it("a stock's count shows old → new, with no source", async () => {
      open("stock");
      pick(/Trade Republic/, "trade_republic.csv");
      await screen.findByRole("button", { name: /^Save 4 trades/ });
      const rows = within(
        screen.getByRole("region", { name: "Share counts to correct" }),
      ).getAllByRole("listitem");
      expect(rows[0]!.textContent).toBe("Example World ETF1 → 4");
    });
  });

  it("a file that only corrects counts says Updated, as the sibling import says Imported", async () => {
    const csv = readFileSync("src/lib/brokers/fixtures/trade_republic.csv", "utf8");
    const ctx = {
      kind: "stock" as const,
      knownKeys: new Set(["XX0000000001", "XX0000000002"]),
      today: "2099-01-01",
    };
    // Every trade and income row already saved: only the share count is left to set.
    const { trades, events } = parseTradesCsv(csv, ctx);
    db.events.push(...events!.map((e) => ({ ...e })));
    open("stock", trades);
    pick(/Trade Republic/, "trade_republic.csv");
    fireEvent.click(await screen.findByRole("button", { name: "Save share counts" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(toast.success).toHaveBeenLastCalledWith("Updated 2 share counts");
  });

  it("on Crypto, a file that only corrects holdings offers Save holdings", async () => {
    db.extraCoins.push({ asset_symbol: "LTC", amount: 0.5, name: "Litecoin", source: "Manual" });
    open("crypto");
    pick(/Ledger Live/, "ledger_live.csv");
    fireEvent.click(await screen.findByRole("button", { name: "Save 7 trades" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    cleanup();
    // Every trade saved, the coin counts still off: only the holdings are left.
    open("crypto", db.inserted as unknown as Array<Trade>);
    pick(/Ledger Live/, "ledger_live.csv");
    expect(await screen.findByRole("button", { name: "Save holdings" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save share counts" })).toBeNull();
  });

  describe("a coin sold to zero with no holding", () => {
    const byHolding = () => screen.getByText("By holding").nextElementSibling!.textContent;

    it("is labelled by its ticker, fully sold", async () => {
      open("crypto");
      pick(/Ledger Live/, "ledger_live.csv");
      await screen.findByRole("button", { name: "Save 7 trades" });
      expect(byHolding()).toContain("LTC · fully sold");
      expect(byHolding()).not.toContain("Ethereum · fully sold");
    });

    it("uses the coin's name when it's known", async () => {
      db.extraCoins.push({ asset_symbol: "LTC", amount: 3, name: "Litecoin", source: "Coinbase" });
      open("crypto");
      pick(/Ledger Live/, "ledger_live.csv");
      await screen.findByRole("button", { name: "Save 7 trades" });
      expect(byHolding()).toContain("Litecoin · fully sold");
    });
  });

  describe("changing step moves focus to the new step's title", () => {
    const title = (name: string) => screen.getByRole("heading", { name });

    it("after choosing a source", () => {
      open("crypto");
      fireEvent.click(screen.getByRole("button", { name: /Ledger Live/ }));
      expect(document.activeElement).toBe(title("Import from Ledger Live"));
    });

    it("after All sources", () => {
      open("crypto");
      fireEvent.click(screen.getByRole("button", { name: /Ledger Live/ }));
      fireEvent.click(screen.getByRole("button", { name: /All sources/ }));
      expect(document.activeElement).toBe(title("Import trades"));
    });

    it("after Use a spreadsheet", () => {
      open("stock");
      fireEvent.click(screen.getByRole("button", { name: /Another broker/ }));
      fireEvent.click(screen.getByRole("button", { name: "Use a spreadsheet" }));
      expect(document.activeElement).toBe(title("Import a spreadsheet"));
    });

    it("not when the dialog opens: the dialog places it then", () => {
      open("crypto");
      expect(document.activeElement).not.toBe(title("Import trades"));
    });
  });

  it("a file chosen from the keyboard keeps focus on the file picker (now Change)", async () => {
    open("crypto");
    fireEvent.click(screen.getByRole("button", { name: /Ledger Live/ }));
    screen.getByLabelText("CSV file").focus();
    const csv = readFileSync("src/lib/brokers/fixtures/ledger_live.csv", "utf8");
    fireEvent.change(screen.getByLabelText("CSV file"), {
      target: { files: [new File([csv], "ops.csv", { type: "text/csv" })] },
    });
    await screen.findByText("ops.csv");
    const picker = screen.getByLabelText("Change file");
    expect(picker.closest("label")!.textContent).toBe("Change");
    expect(document.activeElement).toBe(picker);
  });

  it("typing in the text box after a file leaves focus in the text box", async () => {
    open("stock");
    fireEvent.click(screen.getByRole("button", { name: /My own spreadsheet/ }));
    screen.getByLabelText("CSV file").focus();
    fireEvent.change(screen.getByLabelText("CSV file"), {
      target: { files: [new File(["date,side,isin,shares,price"], "a.csv")] },
    });
    await screen.findByText("a.csv");
    const area = screen.getByLabelText("CSV text");
    area.focus();
    fireEvent.change(area, { target: { value: "date,side" } });
    expect(screen.queryByText("a.csv")).toBeNull();
    expect(document.activeElement).toBe(area);
  });

  describe("a file for the other page links to it", () => {
    it("a Ledger Live file on the Portfolio page links to the Crypto page", async () => {
      open("stock");
      pick(/My own spreadsheet/, "ledger_live.csv");
      await screen.findByText(/import it on the Crypto page/);
      expect(screen.getByRole("link", { name: "Open the Crypto page" }).getAttribute("href")).toBe(
        "/crypto",
      );
    });

    it("on its own page there's no such link", async () => {
      open("crypto");
      pick(/My own spreadsheet/, "ledger_live.csv");
      await screen.findByRole("button", { name: "Save 7 trades" });
      expect(screen.queryByRole("link", { name: /Open the/ })).toBeNull();
    });
  });

  it("Save stays in view at the dialog's bottom: a sticky footer with the dialog's background", async () => {
    open("crypto");
    fireEvent.click(screen.getByRole("button", { name: /My own spreadsheet/ }));
    const csv = readFileSync("src/lib/brokers/fixtures/ledger_live.csv", "utf8");
    fireEvent.change(screen.getByLabelText("CSV text"), { target: { value: csv } });
    const footer = (await screen.findByRole("button", { name: "Save 7 trades" })).parentElement!;
    for (const c of ["sticky", "-bottom-6", "bg-background"])
      expect(footer.classList.contains(c), c).toBe(true);
  });

  describe("the spreadsheet route's description follows the file", () => {
    const description = () => screen.getByRole("dialog").querySelector("h2 + p")!.textContent;

    it("a pasted Ledger Live file is described as Ledger's, in its currency", async () => {
      open("crypto");
      fireEvent.click(screen.getByRole("button", { name: /My own spreadsheet/ }));
      const csv = readFileSync("src/lib/brokers/fixtures/ledger_live.csv", "utf8");
      fireEvent.change(screen.getByLabelText("CSV text"), { target: { value: csv } });
      await screen.findByRole("button", { name: "Save 7 trades" });
      expect(description()).toBe(
        "This file comes from Ledger Live: read as it comes, its USD values turned into euro with each day's rate.",
      );
    });

    it("your own columns keep the columns' description", async () => {
      open("stock");
      fireEvent.click(screen.getByRole("button", { name: /My own spreadsheet/ }));
      fireEvent.change(screen.getByLabelText("CSV text"), {
        target: { value: "date,side,isin,shares,price\n2026-01-02,buy,XX0000000001,1,10" },
      });
      await screen.findByRole("button", { name: "Save 1 trade" });
      expect(description()).toMatch(/price is per share in EUR/);
    });

    it.each([["stock", "ledger_live.csv", "Crypto"]] as const)(
      "on the %s page, the other page's file (%s) keeps the columns' description",
      async (kind, fixture, page) => {
        open(kind);
        pick(/My own spreadsheet/, fixture);
        await screen.findByRole("link", { name: `Open the ${page} page` });
        expect(description()).toMatch(/^A header row with date, side/);
      },
    );

    it("a Trade Republic file belongs on the Crypto page too: described as its own, no link away", async () => {
      open("crypto");
      pick(/My own spreadsheet/, "trade_republic.csv");
      await screen.findByText("Nothing in this file to import here.");
      expect(description()).toBe("This file comes from Trade Republic: read as it comes.");
      expect(screen.queryByRole("link", { name: /Open the/ })).toBeNull();
    });
  });
});
