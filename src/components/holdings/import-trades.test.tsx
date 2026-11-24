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
  /** match_broker_rows: how often it ran, and what it answers (null = an error, say an older backend). */
  matchCalls: 0,
  match: null as null | { matched: number; cleared: number; unmatched: number },
  /** Set, a write answers with this error (set_holding_quantity for rpcError). */
  insertError: null as null | Record<string, unknown>,
  rpcError: null as null | Record<string, unknown>,
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
  /** add-holding calls, and what its search finds (by default, one result per ISIN). */
  invoked: [] as Array<Record<string, unknown>>,
  searchFinds: null as null | ((query: string) => Array<Record<string, unknown>>),
  /** Set, add-holding answers 409 already_held with this key (the backend's duplicate check). */
  alreadyHeld: null as string | null,
  /** Rows deleted: [table, column, values]. */
  deleted: [] as Array<[string, string, Array<unknown>]>,
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
            then: (resolve: (v: unknown) => void) => resolve({ error: null }),
          };
          return chain;
        },
        insert: (rows: Array<Record<string, unknown>>) => {
          if (db.insertError) {
            const failed = Promise.resolve({ data: null, error: db.insertError });
            return Object.assign(failed, { select: () => failed });
          }
          const start = db.inserted.length;
          db.inserted.push(...rows);
          // Each saved trade gets its id, as the database gives it.
          const ids = rows.map((_, i) => ({ id: `trade-${start + i + 1}` }));
          const done = (db.insertGate ?? Promise.resolve()).then(() => ({
            data: ids,
            error: null,
          }));
          return Object.assign(done, { select: () => done });
        },
        delete: () => ({
          in: (column: string, values: Array<unknown>) => {
            db.deleted.push([table, column, values]);
            return Promise.resolve({ error: null });
          },
        }),
        upsert: (rows: Array<Record<string, unknown>>, options: unknown) => {
          db.upserted.push([table, rows, options]);
          const error = db.upsertError ? { message: db.upsertError } : null;
          const saved = rows
            .slice(0, db.upsertSaved ?? rows.length)
            .map((r, i) => ({ ...r, id: `event-${i + 1}` }));
          return Object.assign(Promise.resolve({ error }), {
            select: () => Promise.resolve({ data: error ? null : saved, error }),
          });
        },
      }),
      rpc: (name: string, args: Record<string, unknown>) => {
        // Bank-row matching is counted on its own, so the holding writes stay easy to check.
        if (name === "match_broker_rows") {
          db.matchCalls++;
          return Promise.resolve(
            db.match
              ? { data: db.match, error: null }
              : { data: null, error: { message: "not there" } },
          );
        }
        db.rpc.push([name, args]);
        return Promise.resolve(
          db.rpcError ? { data: null, error: db.rpcError } : { data: 1, error: null },
        );
      },
      functions: {
        invoke: (name: string, { body }: { body: Record<string, unknown> }) => {
          db.invoked.push({ fn: name, ...body });
          if (body["action"] === "search") {
            const q = String(body["query"]);
            const results = db.searchFinds
              ? db.searchFinds(q)
              : [{ id: `${q}.DE`, symbol: `${q}.DE`, name: `Found ${q}`, detail: "ETF" }];
            return Promise.resolve({ data: { results }, error: null });
          }
          if (db.alreadyHeld) {
            const body = JSON.stringify({ error: "already_held", key: db.alreadyHeld });
            return Promise.resolve({
              data: null,
              error: { context: new Response(body, { status: 409 }) },
            });
          }
          return Promise.resolve({ data: { added: true, priced: true }, error: null });
        },
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
    db.matchCalls = 0;
    db.match = null;
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
    db.signedOut = false;
    db.ratesGate = null;
    db.ratesReads = 0;
    db.invoked.length = 0;
    db.searchFinds = null;
    db.alreadyHeld = null;
    db.deleted.length = 0;
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

  // Some notes are about rows that are imported ("counted at €0"): not all were left out.
  it("the file's notes sit under Notes, not Left out", async () => {
    open("crypto");
    pickText(
      /Ledger Live/,
      [
        readFileSync("src/lib/brokers/fixtures/ledger_live.csv", "utf8").split("\n")[0],
        "2026-01-05T08:00:00.000Z,Confirmed,BTC,IN,0.008,,h1,Bitcoin 1,a,USD,,",
      ].join("\n"),
    );
    await screen.findByRole("button", { name: "Save 1 trade" });
    const note = screen.getByText("1 operation had no value in the file, so it was counted at €0.");
    expect(note.closest("div")!.parentElement!.previousElementSibling!.textContent).toBe("Notes");
    expect(screen.queryByText("Left out")).toBeNull();
  });

  it("a Ledger Live file is priced in euro, saved, and sets your wallet coins, not synced ones", async () => {
    open("crypto");
    fireEvent.click(screen.getByRole("button", { name: /Ledger Live/ }));
    const csv = readFileSync("src/lib/brokers/fixtures/ledger_live.csv", "utf8");
    const file = new File([csv], "ledgerwallet-operations.csv", { type: "text/csv" });
    fireEvent.change(screen.getByLabelText("CSV file"), { target: { files: [file] } });
    // USDT sits only on Coinbase, which syncs itself: its Ledger moves are left out, and it says so.
    const save = await screen.findByRole("button", { name: "Save 5 trades" });
    expect(screen.getByText(/USDT has no Ledger or manual holding/)).toBeTruthy();
    expect(screen.getByText("Holdings to correct")).toBeTruthy();
    expect(screen.queryByText("Share counts corrected")).toBeNull();
    fireEvent.click(save);
    await waitFor(() => expect(db.inserted).toHaveLength(5));
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

  it("a coin held on Ledger and added by hand too is corrected on its Ledger row", async () => {
    db.extraCoins.push({ asset_symbol: "ETH", amount: 0.1, name: "Ethereum", source: "Ledger" });
    open("crypto");
    fireEvent.click(screen.getByRole("button", { name: /Ledger Live/ }));
    const csv = readFileSync("src/lib/brokers/fixtures/ledger_live.csv", "utf8");
    fireEvent.change(screen.getByLabelText("CSV file"), {
      target: { files: [new File([csv], "ops.csv", { type: "text/csv" })] },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Save 5 trades" }));
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
    fireEvent.click(await screen.findByRole("button", { name: "Save 5 trades" }));
    // BTC's Ledger holding (0.008) already matches its Ledger moves: only ETH changes.
    await waitFor(() => expect(db.rpc).toHaveLength(1));
    expect(db.rpc[0]![1]).toMatchObject({ p_key: "eth" });
  });

  it("a Ledger Live file pasted as a spreadsheet is read the same way", async () => {
    open("crypto");
    fireEvent.click(screen.getByRole("button", { name: /My own spreadsheet/ }));
    const csv = readFileSync("src/lib/brokers/fixtures/ledger_live.csv", "utf8");
    fireEvent.change(screen.getByLabelText("CSV text"), { target: { value: csv } });
    expect(await screen.findByRole("button", { name: "Save 5 trades" })).toBeTruthy();
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
    // The file card stops reading: it says the rates failed.
    expect(screen.getByRole("status").textContent).toBe("Couldn't load exchange rates");
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

  // The amounts above are after tax: a Taxes line read as more to pay looked counted twice.
  it("#15 the Taxes line says it's already taken off, right under it; no line without taxes", async () => {
    const [header] = readFileSync("src/lib/brokers/fixtures/trade_republic.csv", "utf8").split(
      "\n",
    );
    const dividend =
      '"2026-03-01T08:00:00Z","2026-03-01","DEFAULT","CASH","DIVIDEND","FUND","Example World ETF","XX0000000001","4.0","","1.50","","-0.30","EUR","00000000-0000-4000-8000-000000000005"';
    open("stock");
    pickText(/Trade Republic/, `${header}\n${dividend}`);
    const note = await screen.findByText("Already taken off what you were paid, not extra.");
    expect(note.previousElementSibling?.textContent).toBe("Taxes−€0.30");
    expect(screen.getByText("Dividends").parentElement?.textContent).toBe("Dividends€1.20");
    expect(screen.queryByText(/are after tax/)).toBeNull();
    cleanup();
    open("stock");
    await pickTradeRepublic();
    expect(screen.queryByText(/Already taken off/)).toBeNull();
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
      expect(vi.mocked(toast.success).mock.lastCall?.[0]).toBe(
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

  describe("polish-5 B4 the stale file read guard", () => {
    const csv = () => readFileSync("src/lib/brokers/fixtures/trade_republic.csv", "utf8");
    /** A file whose text is a deferred promise: it arrives when finish() is called. */
    const deferredFile = (text: string, name: string) => {
      let finish!: () => void;
      const ready = new Promise<string>((r) => (finish = () => r(text)));
      return { file: Object.assign(new File([text], name), { text: () => ready }), finish };
    };
    const settle = () => new Promise((r) => setTimeout(r, 20));

    it("file A read late, after file B: B's content wins, A's result is ignored", async () => {
      open("stock");
      fireEvent.click(screen.getByRole("button", { name: /Trade Republic/ }));
      const a = deferredFile(csv(), "a.csv");
      const b = deferredFile(csv().split("\n")[0]!, "b.csv");
      fireEvent.change(screen.getByLabelText("CSV file"), { target: { files: [a.file] } });
      fireEvent.change(screen.getByLabelText("Change file"), { target: { files: [b.file] } });
      b.finish();
      expect(await screen.findByText("Nothing in this file to import here.")).toBeInTheDocument();
      a.finish();
      await settle();
      expect(screen.getByText("b.csv")).toBeInTheDocument();
      expect(screen.getByText("Nothing in this file to import here.")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /^Save/ })).toBeNull();
    });

    it("a read that ends after the dialog closed doesn't come back on reopening", async () => {
      open("stock");
      fireEvent.click(screen.getByRole("button", { name: /Trade Republic/ }));
      const a = deferredFile(csv(), "a.csv");
      fireEvent.change(screen.getByLabelText("CSV file"), { target: { files: [a.file] } });
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      a.finish();
      await settle();
      fireEvent.click(screen.getByText("Import trades from CSV"));
      fireEvent.click(screen.getByRole("button", { name: /My own spreadsheet/ }));
      await settle();
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
        await screen.findByRole("button", { name: "Save 5 trades" });
      }
      expect(screen.getByRole("region", { name: heading })).toBeInTheDocument();
      expect(screen.queryByText(/corrected$/)).toBeNull();
    },
  );

  describe("polish-5 B3 the file card says what the exchange rates are doing", () => {
    it("while they load: Loading exchange rates…, a spinner, no error icon", async () => {
      let release!: () => void;
      db.ratesGate = new Promise((r) => (release = r));
      open("crypto");
      pick(/Ledger Live/, "ledger_live.csv");
      await waitFor(() =>
        expect(screen.getByRole("status").textContent).toBe("Loading exchange rates…"),
      );
      expect(document.querySelector(".animate-spin")).toBeTruthy();
      expect(statusIcon()).toBeNull();
      release();
      await screen.findByRole("button", { name: "Save 5 trades" });
    });

    it("once they fail: the error icon, Couldn't load exchange rates, and Try again", async () => {
      db.ratesDown = true;
      open("crypto");
      pick(/Ledger Live/, "ledger_live.csv");
      await screen.findByRole("button", { name: "Try again" });
      expect(screen.getByRole("status").textContent).toBe("Couldn't load exchange rates");
      expect(statusIcon()?.classList.contains("lucide-circle-alert")).toBe(true);
    });
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
      expect(vi.mocked(toast.success).mock.lastCall?.[0]).toBe(
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
      expect(vi.mocked(toast.success).mock.lastCall?.[0]).toBe(
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
    expect(await screen.findByRole("button", { name: "Save 5 trades" })).toBeTruthy();
    expect(screen.queryByText(/Couldn't load USD to EUR rates/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it.each([
    ["en-GB", "1,234"],
    ["it-IT", "1.234"],
  ])(
    "counts are grouped in the reader's locale (%s): the total, the summary, Save and the toast",
    async (locale, n) => {
      const language = vi.spyOn(navigator, "language", "get").mockReturnValue(locale);
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
      expect(screen.getByText(n)).toBeTruthy();
      expect(screen.getByText(new RegExp(`^${n.replace(".", "\\.")} buys · `))).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: `Save ${n} trades` }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(vi.mocked(toast.success).mock.lastCall?.[0]).toBe(`Imported ${n} trades`);
    },
  );

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
    // Only the rates failed: the file is fine, the card says the rates failed.
    expect(screen.getByRole("status").textContent).toBe(
      what === "the exchange rates" ? "Couldn't load exchange rates" : "Can't be read",
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

  it("while the exchange rates load it says so and offers no save yet", async () => {
    let release!: () => void;
    db.ratesGate = new Promise((r) => (release = r));
    open("crypto");
    pick(/Ledger Live/, "ledger_live.csv");
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe("Loading exchange rates…"),
    );
    expect(document.querySelector(".animate-spin")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Save/ })).toBeNull();
    release();
    expect(await screen.findByRole("button", { name: "Save 5 trades" })).toBeTruthy();
    expect(screen.queryByText("Loading exchange rates…")).toBeNull();
  });

  it("the dialog can't be closed while saving, and closes once saved", async () => {
    let release!: () => void;
    db.insertGate = new Promise((r) => (release = r));
    open("crypto");
    pick(/Ledger Live/, "ledger_live.csv");
    fireEvent.click(await screen.findByRole("button", { name: "Save 5 trades" }));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("ops.csv")).toBeTruthy();
    release();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(db.inserted).toHaveLength(5);
  });

  it("while saving, the file can't be swapped or the source left", async () => {
    let release!: () => void;
    db.insertGate = new Promise((r) => (release = r));
    open("crypto");
    pick(/Ledger Live/, "ledger_live.csv");
    fireEvent.click(await screen.findByRole("button", { name: "Save 5 trades" }));
    const back = screen.getByRole("button", { name: /All sources/ });
    await waitFor(() => expect((back as HTMLButtonElement).disabled).toBe(true));
    fireEvent.click(back);
    // Named Change file once a file is chosen (polish-4 UB13).
    expect((screen.getByLabelText("Change file") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText("ops.csv")).toBeTruthy();
    release();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(db.inserted).toHaveLength(5);
  });

  it("while a pasted spreadsheet saves, its text and the drop zone are locked", async () => {
    let release!: () => void;
    db.insertGate = new Promise((r) => (release = r));
    open("crypto");
    fireEvent.click(screen.getByRole("button", { name: /My own spreadsheet/ }));
    const csv = readFileSync("src/lib/brokers/fixtures/ledger_live.csv", "utf8");
    fireEvent.change(screen.getByLabelText("CSV text"), { target: { value: csv } });
    fireEvent.click(await screen.findByRole("button", { name: "Save 5 trades" }));
    const area = screen.getByLabelText("CSV text") as HTMLTextAreaElement;
    await waitFor(() => expect(area.disabled).toBe(true));
    const dropped = new File([csv], "dropped.csv", { type: "text/csv" });
    fireEvent.drop(screen.getByLabelText("CSV file").closest("label")!, {
      dataTransfer: { files: [dropped] },
    });
    expect(screen.queryByText("dropped.csv")).toBeNull();
    release();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(db.inserted).toHaveLength(5);
  });

  it("Esc closes the dialog when nothing is saving", async () => {
    open("crypto");
    pick(/Ledger Live/, "ledger_live.csv");
    await screen.findByRole("button", { name: "Save 5 trades" });
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  describe("leaving the page while saving", () => {
    /** A beforeunload as the browser sends it: cancelled means it asks before leaving. */
    const leave = () => {
      const event = new Event("beforeunload", { cancelable: true });
      // jsdom has no BeforeUnloadEvent: give it the browser's string returnValue to set.
      Object.defineProperty(event, "returnValue", { value: "", writable: true });
      window.dispatchEvent(event);
      return event;
    };

    it("asks first while the save runs, and not once it's done", async () => {
      let release!: () => void;
      db.insertGate = new Promise((r) => (release = r));
      open("crypto");
      pick(/Ledger Live/, "ledger_live.csv");
      fireEvent.click(await screen.findByRole("button", { name: "Save 5 trades" }));
      await waitFor(() => expect(db.inserted).toHaveLength(5));
      const during = leave();
      expect(during.defaultPrevented).toBe(true);
      // Older browsers ask only when returnValue is set too.
      expect((during as BeforeUnloadEvent).returnValue).toBeTruthy();
      release();
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(leave().defaultPrevented).toBe(false);
    });

    it("doesn't ask when nothing is saving", async () => {
      open("crypto");
      pick(/Ledger Live/, "ledger_live.csv");
      await screen.findByRole("button", { name: "Save 5 trades" });
      expect(leave().defaultPrevented).toBe(false);
    });
  });

  it("a failed save's error is gone after closing and opening again", async () => {
    db.insertError = { message: "insert failed" };
    open("crypto");
    pick(/Ledger Live/, "ledger_live.csv");
    fireEvent.click(await screen.findByRole("button", { name: "Save 5 trades" }));
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
    const save = await screen.findByRole("button", { name: "Save 5 trades" });
    fireEvent.click(save);
    fireEvent.click(save);
    await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(true));
    fireEvent.click(save);
    release();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(db.inserted).toHaveLength(5);
    expect(db.rpc).toHaveLength(1);
  });

  it("after a failed save you can save again", async () => {
    db.insertError = { message: "insert failed" };
    open("crypto");
    pick(/Ledger Live/, "ledger_live.csv");
    const save = await screen.findByRole("button", { name: "Save 5 trades" });
    fireEvent.click(save);
    await screen.findByText("insert failed");
    db.insertError = null;
    fireEvent.click(save);
    await waitFor(() => expect(db.inserted).toHaveLength(5));
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
  });

  describe("the file's icon matches its state", () => {
    it("read: a check", async () => {
      open("crypto");
      pick(/Ledger Live/, "ledger_live.csv");
      await screen.findByRole("button", { name: "Save 5 trades" });
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
    await screen.findByRole("button", { name: "Save 5 trades" });
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
    await screen.findByRole("button", { name: "Save 5 trades" });
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
    expect(screen.getByRole("status").textContent).toBe("Loading exchange rates…");
    release();
    expect(await screen.findByRole("button", { name: "Save 5 trades" })).toBeTruthy();
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
    expect(await screen.findByRole("button", { name: "Save 5 trades" })).toBeTruthy();
  });

  it("a retry that fails again offers Try again once more", async () => {
    db.ratesDown = true;
    open("crypto");
    pick(/Ledger Live/, "ledger_live.csv");
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    const again = await screen.findByRole("button", { name: "Try again" });
    expect((again as HTMLButtonElement).disabled).toBe(false);
    expect(again.hasAttribute("aria-disabled")).toBe(false);
    expect(screen.getByRole("status").textContent).toBe("Couldn't load exchange rates");
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

    it("a holding with trades you added by hand says its return won't match", async () => {
      const byHand: Trade = {
        kind: "crypto",
        key: "ETH",
        side: "buy",
        trade_date: "2025-12-01",
        shares: 0.4,
        price_eur: 2000,
        fee_eur: 0,
        source: null,
      };
      open("crypto", [byHand]);
      pick(/Ledger Live/, "ledger_live.csv");
      await screen.findByRole("button", { name: "Save 5 trades" });
      const rows = within(corrected()).getAllByRole("listitem");
      expect(rows.map((r) => r.textContent)).toEqual([
        "EthereumManual · Has 1 trade not from Ledger Live: its return will show as not matching until you remove it0.4 → 0.4988",
      ]);
    });

    it("two trades added by hand are counted, and both are to remove", async () => {
      const byHand = (trade_date: string): Trade => ({
        kind: "crypto",
        key: "eth",
        side: "buy",
        trade_date,
        shares: 0.2,
        price_eur: 2000,
        fee_eur: 0,
      });
      open("crypto", [byHand("2025-11-01"), byHand("2025-12-01")]);
      pick(/Ledger Live/, "ledger_live.csv");
      await screen.findByRole("button", { name: "Save 5 trades" });
      expect(within(corrected()).getByText(/Has 2 trades not from Ledger Live/).textContent).toBe(
        "Manual · Has 2 trades not from Ledger Live: its return will show as not matching until you remove them",
      );
    });

    it("trades from this file's own source aren't counted", async () => {
      const fromLedger: Trade = {
        kind: "crypto",
        key: "ETH",
        side: "buy",
        trade_date: "2025-12-01",
        shares: 0.4,
        price_eur: 2000,
        fee_eur: 0,
        source: "ledger_live",
        external_id: "older",
      };
      open("crypto", [fromLedger]);
      pick(/Ledger Live/, "ledger_live.csv");
      await screen.findByRole("button", { name: "Save 5 trades" });
      expect(within(corrected()).queryByText(/not from Ledger Live/)).toBeNull();
    });

    describe("a holding the file sets that has other trades, its amount unchanged", () => {
      const toCheck = () => screen.getByRole("region", { name: "Trades to check" });
      const byHand = (key: string): Trade => ({
        kind: "crypto",
        key,
        side: "buy",
        trade_date: "2025-12-01",
        shares: 0.4988,
        price_eur: 2000,
        fee_eur: 0,
        source: null,
      });

      it("added by hand, already at the file's amount: warned, though not corrected", async () => {
        db.extraCoins.push({
          asset_symbol: "ETH",
          amount: 0.4988,
          name: "Ethereum",
          source: "Manual",
        });
        open("crypto", [byHand("ETH")]);
        pick(/Ledger Live/, "ledger_live.csv");
        await screen.findByRole("button", { name: "Save 5 trades" });
        expect(screen.queryByRole("region", { name: "Holdings corrected" })).toBeNull();
        expect(
          within(toCheck())
            .getAllByRole("listitem")
            .map((r) => r.textContent),
        ).toEqual([
          "EthereumManual · Has 1 trade not from Ledger Live: its return will show as not matching until you remove it",
        ]);
      });

      it("on Ledger, with a trade added by hand: warned", async () => {
        open("crypto", [byHand("btc")]);
        pick(/Ledger Live/, "ledger_live.csv");
        await screen.findByRole("button", { name: "Save 5 trades" });
        expect(
          within(toCheck())
            .getAllByRole("listitem")
            .map((r) => r.textContent),
        ).toEqual([
          "BitcoinLedger · Has 1 trade not from Ledger Live: its return will show as not matching until you remove it",
        ]);
      });

      it("no trades but the file's: no warning", async () => {
        open("crypto");
        pick(/Ledger Live/, "ledger_live.csv");
        await screen.findByRole("button", { name: "Save 5 trades" });
        expect(screen.queryByRole("region", { name: "Trades to check" })).toBeNull();
        expect(screen.queryByText(/Has \d+ trade/)).toBeNull();
      });
    });

    it("the toast counts the trades and the holdings updated", async () => {
      db.extraCoins.push({ asset_symbol: "LTC", amount: 0.5, name: "Litecoin", source: "Manual" });
      open("crypto");
      pick(/Ledger Live/, "ledger_live.csv");
      fireEvent.click(await screen.findByRole("button", { name: "Save 7 trades" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(vi.mocked(toast.success).mock.lastCall?.[0]).toBe(
        "Imported 7 trades, updated 2 holdings",
      );
    });

    it("one holding updated is singular", async () => {
      open("crypto");
      pick(/Ledger Live/, "ledger_live.csv");
      fireEvent.click(await screen.findByRole("button", { name: "Save 5 trades" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(vi.mocked(toast.success).mock.lastCall?.[0]).toBe(
        "Imported 5 trades, updated 1 holding",
      );
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
      expect(vi.mocked(toast.success).mock.lastCall?.[0]).toBe("Imported 1 trade");
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
    expect(vi.mocked(toast.success).mock.lastCall?.[0]).toBe("Updated 2 share counts");
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
    it("is left out of the save and listed under the notes, with why", async () => {
      open("crypto");
      pick(/Ledger Live/, "ledger_live.csv");
      await screen.findByRole("button", { name: "Save 5 trades" });
      expect(screen.getByText("By holding").nextElementSibling!.textContent).not.toMatch(
        /LTC|Litecoin/,
      );
      expect(
        screen.getByText(
          "LTC: sold to zero and not held on Ledger or by hand, so its 2 trades were left out.",
        ),
      ).toBeTruthy();
    });

    it("held only on another source, the note doesn't say it isn't held", async () => {
      db.extraCoins.push({ asset_symbol: "LTC", amount: 1, name: "Litecoin", source: "Coinbase" });
      open("crypto");
      pick(/Ledger Live/, "ledger_live.csv");
      await screen.findByRole("button", { name: "Save 5 trades" });
      expect(
        screen.getByText(
          "LTC: sold to zero and not held on Ledger or by hand, so its 2 trades were left out.",
        ),
      ).toBeTruthy();
    });

    it("a stock sold to zero with no holding is still kept and labelled fully sold", async () => {
      const header = readFileSync("src/lib/brokers/fixtures/trade_republic.csv", "utf8").split(
        "\n",
      )[0];
      const trade = (date: string, type: string, shares: string, id: string) =>
        `"${date}T09:30:00Z","${date}","DEFAULT","TRADING","${type}","FUND","Sold Fund","XX0000000099","${shares}","10.000000","","","","EUR","${id}"`;
      open("stock");
      pickText(
        /Trade Republic/,
        [
          header,
          trade("2026-01-02", "BUY", "1.0", "s1"),
          trade("2026-02-02", "SELL", "-1.0", "s2"),
        ].join("\n"),
      );
      await screen.findByRole("button", { name: "Save 2 trades" });
      expect(screen.getByText("By holding").nextElementSibling!.textContent).toContain(
        "Sold Fund · fully sold",
      );
    });

    it("held here, it's kept and set to zero, with no note", async () => {
      db.extraCoins.push({ asset_symbol: "LTC", amount: 0.5, name: "Litecoin", source: "Manual" });
      open("crypto");
      pick(/Ledger Live/, "ledger_live.csv");
      await screen.findByRole("button", { name: "Save 7 trades" });
      expect(screen.getByText("By holding").nextElementSibling!.textContent).toContain("Litecoin");
      expect(screen.queryByText(/sold to zero/)).toBeNull();
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
      await screen.findByRole("button", { name: "Save 5 trades" });
      expect(screen.queryByRole("link", { name: /Open the/ })).toBeNull();
    });
  });

  it("Save stays in view at the dialog's bottom: a sticky footer with the dialog's background", async () => {
    open("crypto");
    fireEvent.click(screen.getByRole("button", { name: /My own spreadsheet/ }));
    const csv = readFileSync("src/lib/brokers/fixtures/ledger_live.csv", "utf8");
    fireEvent.change(screen.getByLabelText("CSV text"), { target: { value: csv } });
    const footer = (await screen.findByRole("button", { name: "Save 5 trades" })).parentElement!;
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
      await screen.findByRole("button", { name: "Save 5 trades" });
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

  describe("#15 a Trade Republic file on a fresh install adds the holdings it needs", () => {
    beforeEach(() => {
      db.stocks.splice(0, Infinity);
      vi.mocked(toast.error).mockClear();
    });

    it("the preview says how many holdings it adds, and marks them new", async () => {
      open("stock");
      await pickTradeRepublic();
      expect(screen.getByText("Adds 1 holding")).toBeInTheDocument();
      const list = screen.getByText("By holding").nextElementSibling!.textContent;
      expect(list).toContain("Example World ETF · new");
      expect(list).toContain("Example Corp · fully sold");
      // No note per holding: it isn't left out.
      expect(screen.queryByText(/isn't in your holdings/)).toBeNull();
    });

    it("Save adds the holding with what's left of it, then saves all trades and dividends", async () => {
      open("stock");
      fireEvent.click(await pickTradeRepublic());
      await waitFor(() => expect(toast.success).toHaveBeenCalled());
      expect(db.invoked).toEqual([
        { fn: "add-holding", action: "search", kind: "stock", query: "XX0000000001" },
        {
          fn: "add-holding",
          action: "add",
          kind: "stock",
          id: "XX0000000001.DE",
          symbol: "XX0000000001.DE",
          name: "Example World ETF",
          quantity: 4,
          isin: "XX0000000001",
          broker: "Trade Republic",
        },
      ]);
      expect(db.inserted).toHaveLength(4);
      expect(db.upserted[0]![1]).toEqual([
        expect.objectContaining({ kind: "dividend", key: "XX0000000001" }),
      ]);
      // add-holding sets the count: no correction on top.
      expect(db.rpc).toEqual([]);
      expect(vi.mocked(toast.success).mock.lastCall?.[0]).toBe(
        "Imported 4 trades and 1 income and cash row, added 1 holding",
      );
    });

    it("a holding that can't be found is left out, with one line saying so", async () => {
      db.searchFinds = () => [];
      open("stock");
      fireEvent.click(await pickTradeRepublic());
      await waitFor(() => expect(toast.success).toHaveBeenCalled());
      // Only the fully sold one's trades; the dividend was the missing holding's.
      expect(db.inserted.map((t) => t["key"])).toEqual(["XX0000000002", "XX0000000002"]);
      expect(db.upserted).toEqual([]);
      expect(vi.mocked(toast.error).mock.lastCall?.[0]).toBe(
        "Example World ETF couldn't be added, so its trades weren't saved. Add it, then import again.",
      );
    });

    // protects=one position, counted once; fails_when=a holding added earlier by name or ticker
    // (keyed by its Yahoo symbol) gets a second holding from the file's ISIN
    it("a holding added by ticker before gets the trades, and no second holding is added", async () => {
      db.stocks.push({
        isin: "VWCE.DE",
        yahoo_symbol: "VWCE.DE",
        shares: 4,
        name: "Example World ETF",
      });
      db.searchFinds = () => [{ id: "VWCE.DE", symbol: "VWCE.DE", name: "World", detail: "ETF" }];
      open("stock");
      fireEvent.click(await pickTradeRepublic());
      await waitFor(() => expect(toast.success).toHaveBeenCalled());
      expect(db.invoked.map((c) => c["action"])).toEqual(["search"]);
      expect(db.inserted.map((t) => t["key"])).toEqual([
        "VWCE.DE",
        "VWCE.DE",
        "XX0000000002",
        "XX0000000002",
      ]);
      expect(db.upserted[0]![1]).toEqual([
        expect.objectContaining({ kind: "dividend", key: "VWCE.DE" }),
      ]);
      expect(vi.mocked(toast.success).mock.lastCall?.[0]).toBe(
        "Imported 4 trades and 1 income and cash row",
      );
    });

    // fails_when=the backend's "already held" answer shows as an error and the trades are dropped
    it("when add-holding says it's already held, the trades go to that holding", async () => {
      db.alreadyHeld = "VWCE.DE";
      open("stock");
      fireEvent.click(await pickTradeRepublic());
      await waitFor(() => expect(toast.success).toHaveBeenCalled());
      expect(db.invoked.map((c) => c["action"])).toEqual(["search", "add"]);
      expect(db.inserted.filter((t) => t["key"] === "VWCE.DE")).toHaveLength(2);
      expect(db.upserted[0]![1]).toEqual([expect.objectContaining({ key: "VWCE.DE" })]);
      expect(toast.error).not.toHaveBeenCalled();
      expect(vi.mocked(toast.success).mock.lastCall?.[0]).toBe(
        "Imported 4 trades and 1 income and cash row",
      );
    });

    it("importing the same file again saves nothing twice and adds no holding", async () => {
      const { trades, events } = parseTradesCsv(
        readFileSync("src/lib/brokers/fixtures/trade_republic.csv", "utf8"),
        { kind: "stock", knownKeys: new Set(), today: "2026-11-17" },
      );
      db.events.push(...events!.map((e) => ({ ...e })));
      db.stocks.push({ isin: "XX0000000001", shares: 4, name: "Example World ETF" });
      open("stock", trades);
      fireEvent.click(screen.getByRole("button", { name: /Trade Republic/ }));
      fireEvent.change(screen.getByLabelText("CSV file"), {
        target: {
          files: [
            new File(
              [readFileSync("src/lib/brokers/fixtures/trade_republic.csv", "utf8")],
              "e.csv",
            ),
          ],
        },
      });
      expect(
        await screen.findByText("Everything in this file is already saved."),
      ).toBeInTheDocument();
      expect(screen.queryByText(/^Adds /)).toBeNull();
      expect(screen.queryByRole("button", { name: /^Save/ })).toBeNull();
      expect(db.invoked).toEqual([]);
    });
  });
  describe("e2e #23 Trade Republic bank rows are matched to the import", () => {
    const lastSuccess = () =>
      vi.mocked(toast.success).mock.lastCall as unknown as [
        string,
        { description?: string; action: { onClick: () => void } },
      ];

    it("after Save it matches and says how many bank rows matched and how many are left", async () => {
      db.match = { matched: 12, cleared: 0, unmatched: 3 };
      open("stock");
      fireEvent.click(await pickTradeRepublic());
      await waitFor(() => expect(toast.success).toHaveBeenCalled());
      expect(db.matchCalls).toBe(1);
      expect(lastSuccess()[1].description).toBe("Matched 12 bank rows, 3 not matched yet");
    });

    it("no Trade Republic bank account: nothing to say", async () => {
      db.match = { matched: 0, cleared: 0, unmatched: 0 };
      open("stock");
      fireEvent.click(await pickTradeRepublic());
      await waitFor(() => expect(toast.success).toHaveBeenCalled());
      expect(lastSuccess()[1].description).toBeUndefined();
    });

    it("if matching fails the import is still saved", async () => {
      db.match = null;
      open("stock");
      fireEvent.click(await pickTradeRepublic());
      await waitFor(() => expect(toast.success).toHaveBeenCalled());
      expect(db.matchCalls).toBe(1);
      expect(lastSuccess()[0]).toMatch(/^Imported 4 trades/);
      expect(lastSuccess()[1].description).toBeUndefined();
    });

    it("Undo runs it again, so the bank rows go back to spending", async () => {
      db.match = { matched: 4, cleared: 0, unmatched: 0 };
      open("stock");
      fireEvent.click(await pickTradeRepublic());
      await waitFor(() => expect(toast.success).toHaveBeenCalled());
      db.match = { matched: 0, cleared: 4, unmatched: 4 };
      lastSuccess()[1].action.onClick();
      await waitFor(() =>
        expect(vi.mocked(toast.success).mock.lastCall?.[0]).toBe("Import undone"),
      );
      expect(db.matchCalls).toBe(2);
    });

    it("another broker's file doesn't run it", async () => {
      open("crypto");
      pick(/Ledger Live/, "ledger_live.csv");
      fireEvent.click(await screen.findByRole("button", { name: "Save 5 trades" }));
      await waitFor(() => expect(toast.success).toHaveBeenCalled());
      expect(db.matchCalls).toBe(0);
    });
  });

  describe("#16 Undo this import removes what that import saved, and nothing else", () => {
    /** Saves, then presses the toast's Undo. */
    async function saveThenUndo(saveButton: Promise<HTMLElement>) {
      vi.mocked(toast.success).mockClear();
      fireEvent.click(await saveButton);
      await waitFor(() => expect(toast.success).toHaveBeenCalled());
      const options = vi.mocked(toast.success).mock.lastCall?.[1] as unknown as {
        action: { label: string; onClick: () => void };
      };
      expect(options.action.label).toBe("Undo this import");
      db.rpc.length = 0;
      options.action.onClick();
      await waitFor(() =>
        expect(vi.mocked(toast.success).mock.lastCall?.[0]).toBe("Import undone"),
      );
    }

    it("deletes its trades and rows by id, and the holding it added", async () => {
      db.stocks.splice(0, Infinity);
      open("stock");
      await saveThenUndo(pickTradeRepublic());
      expect(db.deleted).toEqual([
        ["holding_trades", "id", ["trade-1", "trade-2", "trade-3", "trade-4"]],
        ["investment_events", "id", ["event-1"]],
      ]);
      expect(db.rpc).toEqual([["delete_holding", { p_kind: "stock", p_key: "XX0000000001" }]]);
    });

    it("sets the share counts it corrected back, and deletes no holding", async () => {
      open("stock");
      await saveThenUndo(pickTradeRepublic());
      expect(db.rpc).toEqual([
        [
          "set_holding_quantity",
          { p_kind: "stock", p_key: "XX0000000001", p_quantity: 1, p_source: null },
        ],
        [
          "set_holding_quantity",
          { p_kind: "stock", p_key: "XX0000000002", p_quantity: 1, p_source: null },
        ],
      ]);
    });

    it("a holding it added that had trades from before is set to zero, so those stay", async () => {
      db.stocks.splice(0, Infinity);
      const earlier: Trade = {
        kind: "stock",
        key: "XX0000000001",
        side: "buy",
        trade_date: "2025-01-02",
        shares: 1,
        price_eur: 10,
        fee_eur: 0,
      };
      open("stock", [earlier, { ...earlier, side: "sell", trade_date: "2025-02-02" }]);
      await saveThenUndo(pickTradeRepublic());
      expect(db.rpc).toEqual([
        [
          "set_holding_quantity",
          { p_kind: "stock", p_key: "XX0000000001", p_quantity: 0, p_source: null },
        ],
      ]);
    });

    it("if it fails, it says so", async () => {
      db.stocks.splice(0, Infinity);
      vi.mocked(toast.error).mockClear();
      open("stock");
      fireEvent.click(await pickTradeRepublic());
      await waitFor(() => expect(toast.success).toHaveBeenCalled());
      const options = vi.mocked(toast.success).mock.lastCall?.[1] as unknown as {
        action: { onClick: () => void };
      };
      db.rpcError = { message: "offline" };
      options.action.onClick();
      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith("Couldn't undo", { description: "offline" }),
      );
    });

    it("a save that saved nothing offers no Undo", async () => {
      const [header] = readFileSync("src/lib/brokers/fixtures/trade_republic.csv", "utf8").split(
        "\n",
      );
      const saveback =
        '"2026-03-02T09:00:00Z","2026-03-02","DEFAULT","CASH","BENEFITS_SAVEBACK","","","","","","1.50","","","EUR","00000000-0000-4000-8000-000000000007"';
      // Another tab saved the row meanwhile: the database had it already.
      db.upsertSaved = 0;
      vi.mocked(toast.success).mockClear();
      open("stock");
      pickText(/Trade Republic/, `${header}\n${saveback}`);
      fireEvent.click(await screen.findByRole("button", { name: "Save 1 row" }));
      await waitFor(() => expect(toast.success).toHaveBeenCalled());
      expect(vi.mocked(toast.success).mock.lastCall).toEqual(["Nothing new imported", undefined]);
    });
  });
});
