import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { toast } from "sonner";
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
  /** How many times the exchange rates were read. */
  ratesReads: 0,
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
      range: () => {
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
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, ...rest }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ImportTrades } from "./import-trades";
import { parseTradesCsv } from "@/lib/trades-csv";
import type { Trade } from "@/lib/trades";

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
    db.ratesReads = 0;
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
    // Listed under By holding, and under Share counts corrected too.
    expect(screen.getAllByText("Example World ETF")).toHaveLength(2);
    expect(screen.getByText("Notes")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save 4 trades" })).toBeTruthy();
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
    expect(screen.getByText("Holdings corrected")).toBeTruthy();
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
    fireEvent.click(await screen.findByRole("button", { name: "Save 5 trades" }));
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
      expect(
        screen.getByText(new RegExp(`^${n.replace(".", "\\.")} buys · 0 sells ·`)),
      ).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: `Save ${n} trades` }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(toast.success).toHaveBeenLastCalledWith(`Imported ${n} trades`);
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
    // Only the rates failed: the file is fine, it waits for them.
    expect(screen.getByRole("status").textContent).toBe(
      what === "the exchange rates" ? "Waiting for exchange rates" : "Can't be imported",
    );
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
    expect(await screen.findByRole("button", { name: "Save 5 trades" })).toBeTruthy();
    expect(screen.queryByText("Reading…")).toBeNull();
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
    expect((screen.getByLabelText("CSV file") as HTMLInputElement).disabled).toBe(true);
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
    const change = screen.getByLabelText("CSV file").closest("label")!;
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
    expect(screen.getByRole("status").textContent).toBe("Reading…");
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
    fireEvent.change(screen.getByLabelText("CSV file"), {
      target: {
        files: [
          new File(["date,side,isin,shares,price\n2026-01-02,buy,XX0000000001,1,10"], "ok.csv"),
        ],
      },
    });
    expect(await screen.findByRole("button", { name: "Save 1 trade" })).toBeTruthy();
  });

  describe("corrected holdings", () => {
    const corrected = () => screen.getByRole("region", { name: "Holdings corrected" });

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
      expect(toast.success).toHaveBeenLastCalledWith("Imported 7 trades, updated 2 holdings");
    });

    it("one holding updated is singular", async () => {
      open("crypto");
      pick(/Ledger Live/, "ledger_live.csv");
      fireEvent.click(await screen.findByRole("button", { name: "Save 5 trades" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(toast.success).toHaveBeenLastCalledWith("Imported 5 trades, updated 1 holding");
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
      await screen.findByRole("button", { name: "Save 4 trades" });
      const rows = within(
        screen.getByRole("region", { name: "Share counts corrected" }),
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
    // Every trade already saved: only the share count is left to set.
    open("stock", parseTradesCsv(csv, ctx).trades);
    pick(/Trade Republic/, "trade_republic.csv");
    fireEvent.click(await screen.findByRole("button", { name: "Save trades" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(toast.success).toHaveBeenLastCalledWith("Updated 2 holdings");
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
        screen.getByText("LTC: sold to zero and not held here, so its 2 trades were left out."),
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
    const picker = screen.getByLabelText("CSV file");
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

    it.each([
      ["stock", "ledger_live.csv", "Crypto"],
      ["crypto", "trade_republic.csv", "Portfolio"],
    ] as const)(
      "on the %s page, the other page's file (%s) keeps the columns' description",
      async (kind, fixture, page) => {
        open(kind);
        pick(/My own spreadsheet/, fixture);
        await screen.findByRole("link", { name: `Open the ${page} page` });
        expect(description()).toMatch(/^A header row with date, side/);
      },
    );
  });
});
