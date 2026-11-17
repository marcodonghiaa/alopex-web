import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const db = vi.hoisted(() => ({
  inserted: [] as Array<Record<string, unknown>>,
  rpc: [] as Array<[string, Record<string, unknown>]>,
  ratesDown: false,
  holdingsDown: false,
  /** Coin rows added for one test. */
  extraCoins: [] as Array<Record<string, unknown>>,
  rpcMissing: false,
  /** Set, a write answers with this error. */
  insertError: null as null | Record<string, unknown>,
  rpcError: null as null | Record<string, unknown>,
  updateError: null as null | Record<string, unknown>,
  signedOut: false,
  /** Set, the insert waits for it. */
  insertGate: null as null | Promise<void>,
  /** Set, the exchange rates wait for it. */
  ratesGate: null as null | Promise<void>,
  updated: [] as Array<[string, Record<string, unknown>, Array<[string, unknown]>]>,
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
    const down = rows === tables["fx_rates"] ? db.ratesDown : db.holdingsDown;
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
        (rows === tables["fx_rates"] && db.ratesGate ? db.ratesGate : Promise.resolve()).then(() =>
          down
            ? { data: null, error: { message: "offline" }, count: null }
            : { data: rows, error: null, count: rows.length },
        ),
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
        getUser: () => Promise.resolve({ data: { user: db.signedOut ? null : { id: "u1" } } }),
      },
    },
  };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ImportTrades } from "./import-trades";
import type { Trade } from "@/lib/trades";

function pick(name: RegExp, fixture: string) {
  fireEvent.click(screen.getByRole("button", { name }));
  const csv = readFileSync(`src/lib/brokers/fixtures/${fixture}`, "utf8");
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
    db.rpc.length = 0;
    db.updated.length = 0;
    db.rpcMissing = false;
    db.ratesDown = false;
    db.extraCoins.length = 0;
    db.insertError = null;
    db.rpcError = null;
    db.updateError = null;
    db.signedOut = false;
    db.insertGate = null;
    db.ratesGate = null;
    db.holdingsDown = false;
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

  it("the crypto page lists no stock brokers, and lists Ledger Live", () => {
    open("crypto");
    expect(screen.queryByRole("button", { name: /Trade Republic/ })).toBeNull();
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
    expect(screen.getByText("Holdings corrected")).toBeTruthy();
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
    const save = await screen.findByRole("button", { name: "Save 4 trades" });
    expect(screen.getByText("Share counts corrected")).toBeTruthy();
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

  it("when the exchange rates can't be loaded it says so and offers no save", async () => {
    db.ratesDown = true;
    open("crypto");
    fireEvent.click(screen.getByRole("button", { name: /Ledger Live/ }));
    const csv = readFileSync("src/lib/brokers/fixtures/ledger_live.csv", "utf8");
    fireEvent.change(screen.getByLabelText("CSV file"), {
      target: { files: [new File([csv], "ops.csv", { type: "text/csv" })] },
    });
    // One retry first (no wait in tests).
    expect(await screen.findByText(/Couldn't load USD exchange rates/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Save/ })).toBeNull();
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
      fireEvent.click(await screen.findByRole("button", { name: /^Save \d+ trades$/ }));
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
    await screen.findByText(/Couldn't load USD exchange rates/);
    db.ratesDown = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: "Save 7 trades" })).toBeTruthy();
    expect(screen.queryByText(/Couldn't load USD exchange rates/)).toBeNull();
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
    ["the exchange rates", () => (db.ratesDown = true), /Couldn't load USD exchange rates/],
    ["your holdings", () => (db.holdingsDown = true), /Couldn't load your holdings/],
  ])("when %s can't be loaded the file stops reading", async (_, fail, message) => {
    fail();
    open("crypto");
    pick(/Ledger Live/, "ledger_live.csv");
    await screen.findByText(message);
    expect(screen.getByText("Can't be imported")).toBeTruthy();
    expect(screen.queryByText("Reading…")).toBeNull();
    expect(document.querySelector(".animate-spin")).toBeNull();
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
      fireEvent.click(await screen.findByRole("button", { name: /^Save \d+ trades$/ }));
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
});
