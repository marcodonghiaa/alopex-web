import { describe, expect, it } from "vitest";
import { newEvents, summarizeIncome } from "@/lib/investment-events";
import { parseTradesCsv } from "@/lib/trades-csv";

// The 23 columns of Trade Republic's transaction export, in its order.
const HEADER =
  '"datetime","date","account_type","category","type","asset_class","name","symbol","shares","price","amount","fee","tax","currency","original_amount","original_currency","fx_rate","description","transaction_id","counterparty_name","counterparty_iban","payment_reference","mcc_code"';
type Row = Partial<{
  date: string;
  category: string;
  type: string;
  asset_class: string;
  name: string;
  symbol: string;
  shares: string;
  price: string;
  amount: string;
  fee: string;
  tax: string;
  currency: string;
  original_amount: string;
  original_currency: string;
  fx_rate: string;
  description: string;
  id: string;
}>;
let n = 0;
const row = (r: Row) => {
  const date = r.date ?? "2026-03-02";
  const cells = [
    `${date}T09:30:00.123Z`,
    date,
    "DEFAULT",
    r.category ?? "TRADING",
    r.type ?? "BUY",
    r.asset_class ?? "STOCK",
    r.name ?? "Example Corp",
    r.symbol ?? "XX0000000001",
    r.shares ?? "",
    r.price ?? "",
    r.amount ?? "",
    r.fee ?? "",
    r.tax ?? "",
    r.currency ?? "EUR",
    r.original_amount ?? "",
    r.original_currency ?? "",
    r.fx_rate ?? "",
    r.description ?? "",
    r.id ?? `00000000-0000-7000-8000-${String(++n).padStart(12, "0")}`,
    "",
    "",
    "",
    "",
  ];
  return cells.map((c) => `"${c}"`).join(",");
};
const file = (...rows: Array<Row>) => [HEADER, ...rows.map(row)].join("\n");
const stock = {
  kind: "stock" as const,
  knownKeys: new Set(["XX0000000001", "XX0000000002", "BTC"]),
  today: "2026-11-17",
};
const crypto = { ...stock, kind: "crypto" as const };

describe("Trade Republic, trades", () => {
  it("keeps the tax on a trade, its exact time and what kind of buy it was", () => {
    const { trades, errors } = parseTradesCsv(
      file({
        type: "BUY",
        shares: "2.5",
        price: "10",
        amount: "-25.07",
        fee: "-0.05",
        tax: "-0.02",
        description: "Savings plan execution",
      }),
      stock,
    );
    expect(errors).toEqual([]);
    expect(trades[0]).toMatchObject({
      side: "buy",
      shares: 2.5,
      price_eur: 10,
      fee_eur: 0.05,
      tax_eur: 0.02,
      traded_at: "2026-03-02T09:30:00.123Z",
      note: "Savings plan execution",
    });
  });

  it("reads private-market buys and sells as trades", () => {
    const { trades } = parseTradesCsv(
      file(
        { type: "PRIVATE_MARKET_BUY", shares: "1", price: "50", amount: "-50" },
        { type: "PRIVATE_MARKET_SELL", shares: "-1", price: "60", amount: "60" },
      ),
      stock,
    );
    expect(trades.map((t) => t.side)).toEqual(["buy", "sell"]);
  });

  it("shares you got for free come in at no cost, so all their value is gain", () => {
    const { trades, events } = parseTradesCsv(
      file({ category: "TRADING", type: "STOCKPERK", shares: "0.5", amount: "0" }),
      stock,
    );
    expect(trades[0]).toMatchObject({
      side: "buy",
      shares: 0.5,
      price_eur: 0,
      note: "Received free",
    });
    expect(events).toEqual([]);
  });

  it("a bond paid back at maturity is a sale at what you got for it", () => {
    const { trades, events } = parseTradesCsv(
      file({
        category: "CORPORATE_ACTION",
        type: "FINAL_MATURITY",
        asset_class: "BOND",
        shares: "-1000",
        amount: "1000",
      }),
      stock,
    );
    expect(trades[0]).toMatchObject({
      side: "sell",
      shares: 1000,
      price_eur: 1,
      note: "Paid back",
    });
    expect(events?.[0]).toMatchObject({
      kind: "corporate_action",
      raw_type: "CORPORATE_ACTION|FINAL_MATURITY",
    });
  });

  it("tax held back on a bond paid back goes on its sale, counted once", () => {
    const { trades, events } = parseTradesCsv(
      file({
        category: "CORPORATE_ACTION",
        type: "FINAL_MATURITY",
        asset_class: "BOND",
        shares: "-1000",
        amount: "1000",
        tax: "-26",
      }),
      stock,
    );
    expect(trades[0]).toMatchObject({ side: "sell", price_eur: 1, tax_eur: 26 });
    expect(events?.map((e) => [e.kind, e.tax_eur])).toEqual([["corporate_action", 0]]);
  });

  it("shares moved in from elsewhere count at no cost, and you're told to fix the price", () => {
    const { trades, notes } = parseTradesCsv(
      file({ category: "CORPORATE_ACTION", type: "MERGER", shares: "3", amount: "" }),
      stock,
    );
    expect(trades[0]).toMatchObject({ side: "buy", shares: 3, price_eur: 0 });
    expect(notes).toContain(
      "1 row moved shares in from elsewhere at no cost: the file doesn't say what you paid. Edit the price in the holding's trades.",
    );
  });

  it("a reverse split isn't guessed: you're asked to add it", () => {
    const { trades, notes } = parseTradesCsv(
      file({ category: "CORPORATE_ACTION", type: "SPLIT", shares: "-4" }),
      stock,
    );
    expect(trades).toEqual([]);
    expect(notes).toContain("1 reverse split wasn't imported. Add it by hand.");
  });

  it("a migration moves shares out and straight back: nothing is imported", () => {
    const { trades, events, notes } = parseTradesCsv(
      file(
        { category: "DELIVERY", type: "MIGRATION", shares: "-7" },
        { category: "DELIVERY", type: "MIGRATION", shares: "7" },
      ),
      stock,
    );
    expect([trades, events, notes]).toEqual([[], [], []]);
  });

  it("a number it can't read stops the import", () => {
    const { errors } = parseTradesCsv(file({ shares: "abc", price: "10" }), stock);
    expect(errors).toEqual(["Line 2: couldn't read this BUY row."]);
  });

  it("a date it can't read stops the import", () => {
    const { errors } = parseTradesCsv(
      file({ date: "2026-02-31", shares: "1", price: "10" }),
      stock,
    );
    expect(errors).toEqual(["Line 2: the date isn't valid."]);
  });

  it("a description with a line break inside quotes stays one row", () => {
    const text = file({ shares: "1", price: "10", description: "Savings\nplan" });
    const { trades, errors } = parseTradesCsv(text, stock);
    expect(errors).toEqual([]);
    expect(trades[0]?.note).toBe("Savings\nplan");
  });

  it("a long description is cut to 200 characters without splitting an emoji or an accent", () => {
    const description = `${"a".repeat(198)}é😀 and more`;
    const { trades } = parseTradesCsv(file({ shares: "1", price: "10", description }), stock);
    expect(trades[0]?.note).toBe(`${"a".repeat(198)}é😀`);
  });
});

describe("Trade Republic, crypto", () => {
  const btc = { asset_class: "CRYPTO", name: "Bitcoin", symbol: "BTC" };

  it("a coin bought on Trade Republic goes to the Crypto page, keyed by its ticker", () => {
    const text = file({ ...btc, shares: "0.01", price: "60000", amount: "-600" });
    const onCrypto = parseTradesCsv(text, crypto);
    expect(onCrypto.trades[0]).toMatchObject({ kind: "crypto", key: "BTC", shares: 0.01 });
    const onPortfolio = parseTradesCsv(text, stock);
    expect(onPortfolio.trades).toEqual([]);
    expect(onPortfolio.notes).toContain(
      "1 crypto row is for the Crypto page: import this file there too.",
    );
  });

  it("only shares get their count set from the file: coins also sit in other wallets", () => {
    expect(parseTradesCsv(file(), stock).setsShares).toBe(true);
    expect(parseTradesCsv(file(), crypto).setsShares).toBe(false);
  });

  it("a coin received for free (staking) is an event on the Crypto page, not on Portfolio", () => {
    const text = file({ ...btc, category: "TRADING", type: "FREE_RECEIPT", shares: "0.001" });
    expect(parseTradesCsv(text, crypto).trades[0]).toMatchObject({
      price_eur: 0,
      note: "Received free",
    });
    expect(parseTradesCsv(text, stock).trades).toEqual([]);
  });
});

describe("Trade Republic, income, fees, taxes and cash", () => {
  it("a foreign dividend is saved after its tax, and keeps the tax, the amount before converting and the rate", () => {
    const { events } = parseTradesCsv(
      file({
        category: "CASH",
        type: "DIVIDEND",
        shares: "10",
        amount: "4.21",
        tax: "-0.74",
        original_amount: "5.50",
        original_currency: "usd",
        fx_rate: "1.1",
      }),
      stock,
    );
    expect(events).toEqual([
      expect.objectContaining({
        kind: "dividend",
        asset_kind: "stock",
        key: "XX0000000001",
        event_date: "2026-03-02",
        occurred_at: "2026-03-02T09:30:00.123Z",
        amount_eur: 3.47,
        tax_eur: 0.74,
        fee_eur: 0,
        shares: 10,
        orig_amount: 5.5,
        orig_currency: "USD",
        fx_rate: 1.1,
        raw_type: "CASH|DIVIDEND",
        source: "trade_republic",
      }),
    ]);
  });

  it("a tax charged only in the tax column (stamp duty) is a tax, its cancellation a refund", () => {
    const cash = {
      category: "CASH",
      symbol: "",
      name: "",
      type: "TAX_OPTIMIZATION",
      amount: "0.000000",
    };
    const { events } = parseTradesCsv(
      file(
        { ...cash, tax: "-20.34", description: "Stamp Duty Tax (Portfolio)" },
        { ...cash, tax: "20.34", description: "Cancellation Stamp Duty Tax (Portfolio)" },
      ),
      stock,
    );
    expect(events?.map((e) => [e.kind, e.amount_eur, e.tax_eur])).toEqual([
      ["tax", -20.34, 0],
      ["tax_refund", 20.34, 0],
    ]);
  });

  it("interest is saved after the tax held back from it", () => {
    const { events } = parseTradesCsv(
      file({
        category: "CASH",
        type: "INTEREST_PAYMENT",
        symbol: "",
        amount: "19.250000",
        tax: "-5.01",
      }),
      stock,
    );
    expect(events?.[0]).toMatchObject({ kind: "interest", amount_eur: 14.24, tax_eur: 5.01 });
  });

  it("tax given back on a trade is a refund, not a cost", () => {
    const { trades, events } = parseTradesCsv(
      file({ type: "SELL", shares: "-1", price: "10", amount: "10", tax: "1.5" }),
      stock,
    );
    expect(trades[0]).toMatchObject({ side: "sell", tax_eur: 0 });
    expect(events?.[0]).toMatchObject({ kind: "tax_refund", amount_eur: 1.5, key: "XX0000000001" });
  });

  it("a fee given back on a trade (a rebate) is money in, not dropped", () => {
    const { trades, events } = parseTradesCsv(
      file({ type: "BUY", shares: "1", price: "10", amount: "-10", fee: "0.5" }),
      stock,
    );
    expect(trades[0]).toMatchObject({ side: "buy", fee_eur: 0 });
    expect(events?.map((e) => [e.kind, e.amount_eur, e.fee_eur, e.key])).toEqual([
      ["fee", 0.5, 0, "XX0000000001"],
    ]);
    expect(summarizeIncome(events ?? []).fees).toBe(-0.5);
    const both = parseTradesCsv(
      file({ type: "SELL", shares: "-1", price: "10", amount: "10", fee: "0.5", tax: "1.5" }),
      stock,
    ).events!;
    expect(newEvents(both, []).map((e) => e.kind)).toEqual(["tax_refund", "fee"]);
  });

  it("interest, saveback, fees, taxes and refunds each get their kind", () => {
    const cash = { category: "CASH", symbol: "", name: "" };
    const { events } = parseTradesCsv(
      file(
        { ...cash, type: "INTEREST_PAYMENT", amount: "3.10", tax: "-0.80" },
        { ...cash, type: "BENEFITS_SAVEBACK", amount: "1.50" },
        { ...cash, type: "CARD_ORDERING_FEE", amount: "-5" },
        { ...cash, type: "TAX", amount: "-2" },
        { ...cash, type: "TAX_OPTIMIZATION", amount: "2" },
        { ...cash, type: "PRE_DETERMINED_TAX_BASE", amount: "-0.4" },
      ),
      stock,
    );
    expect(events?.map((e) => e.kind)).toEqual([
      "interest",
      "reward",
      "fee",
      "tax",
      "tax_refund",
      "tax",
    ]);
    expect(events?.every((e) => e.key == null && e.asset_kind == null)).toBe(true);
  });

  it("a fee row with the fee in the fee column counts the fee once", () => {
    const { events } = parseTradesCsv(
      file({ category: "CASH", type: "FEE", symbol: "", name: "", amount: "0", fee: "-1" }),
      stock,
    );
    expect(events?.map((e) => [e.kind, e.amount_eur, e.fee_eur])).toEqual([["fee", -1, 0]]);
    expect(summarizeIncome(events ?? []).fees).toBe(1);
  });

  it("money moved in or out is a deposit or a withdrawal, by its sign", () => {
    const cash = { category: "CASH", symbol: "", name: "" };
    const { events } = parseTradesCsv(
      file(
        { ...cash, type: "CUSTOMER_INBOUND", amount: "500" },
        { ...cash, type: "TRANSFER_INSTANT_OUTBOUND", amount: "-200" },
        { ...cash, type: "TRANSFER_DIRECT_DEBIT_INBOUND", amount: "-50" },
      ),
      stock,
    );
    expect(events?.map((e) => e.kind)).toEqual(["deposit", "withdrawal", "withdrawal"]);
  });

  it("card payments are skipped and counted; a card fee is still a fee", () => {
    const cash = { category: "CASH", symbol: "", name: "" };
    const { events, notes } = parseTradesCsv(
      file(
        { ...cash, type: "CARD_TRANSACTION", amount: "-9.90" },
        { ...cash, type: "CARD_TRANSACTION_INTERNATIONAL", amount: "-20" },
        { ...cash, type: "CARD_ORDERING_FEE", amount: "-5" },
      ),
      stock,
    );
    expect(events?.map((e) => [e.kind, e.amount_eur])).toEqual([["fee", -5]]);
    expect(notes).toContain(
      "2 card payments were skipped: they're your bank account's. Connect Trade Republic as a bank to see them.",
    );
  });

  it("a kind it doesn't know is kept as other, with its name, and you're told", () => {
    const { events, notes } = parseTradesCsv(
      file({ category: "CASH", type: "SOMETHING_NEW", symbol: "", amount: "1" }),
      stock,
    );
    expect(events?.[0]).toMatchObject({ kind: "other", raw_type: "CASH|SOMETHING_NEW" });
    expect(notes).toContain('1 row of a kind Alopex doesn\'t know yet was kept as "other".');
  });

  it("a dividend from something you don't hold is left out with its trades", () => {
    const { events } = parseTradesCsv(
      file(
        { symbol: "ZZ", shares: "1", price: "10" },
        { category: "CASH", type: "DIVIDEND", symbol: "ZZ", amount: "1" },
      ),
      stock,
    );
    expect(events).toEqual([]);
  });

  it("a coin's reward goes with the Crypto page, cash interest with Portfolio", () => {
    const text = file(
      { category: "CASH", type: "BONUS", asset_class: "CRYPTO", symbol: "BTC", amount: "1" },
      { category: "CASH", type: "INTEREST_PAYMENT", symbol: "", amount: "2" },
    );
    expect(parseTradesCsv(text, crypto).events?.map((e) => e.kind)).toEqual(["reward"]);
    expect(parseTradesCsv(text, stock).events?.map((e) => e.kind)).toEqual(["interest"]);
  });

  it("a future date stops the import", () => {
    const { errors } = parseTradesCsv(
      file({ date: "2027-01-01", category: "CASH", type: "DIVIDEND", amount: "1" }),
      stock,
    );
    expect(errors).toEqual(["Line 2: the date is in the future."]);
  });
});
