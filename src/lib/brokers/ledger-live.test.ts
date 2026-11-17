import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseTradesCsv } from "@/lib/trades-csv";

const sample = readFileSync(path.resolve(__dirname, "fixtures/ledger_live.csv"), "utf8");
const HEADER = sample.split("\n")[0]!;
// One dollar is 0.9 euro on every day.
const usd = (currency: string) => (currency === "USD" ? 0.9 : null);
const noRates = {
  kind: "crypto" as const,
  knownKeys: new Set(["BTC", "ETH", "USDT"]),
  today: "2026-11-17",
};
const ctx = { ...noRates, rateToEur: usd };
const row = (cells: string) => `${HEADER}\n${cells}`;

describe("Ledger Live operations export", () => {
  it("is recognised by its columns", () => {
    const result = parseTradesCsv(sample, ctx);
    expect(result.errors).toEqual([]);
    expect(result.trades.every((t) => t.source === "ledger_live")).toBe(true);
    expect(result.setsShares).toBe(true);
  });

  it("asks for the dollar rates it needs before reading anything", () => {
    const result = parseTradesCsv(sample, noRates);
    expect(result.trades).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.needsRates).toEqual({ currency: "USD", from: "2026-01-05", to: "2026-03-01" });
  });

  it("a coin coming in is a buy at its value that day, in euro", () => {
    const btc = parseTradesCsv(sample, ctx).trades.find(
      (t) => t.key === "BTC" && t.side === "buy",
    )!;
    expect(btc).toMatchObject({
      kind: "crypto",
      trade_date: "2026-01-05",
      shares: 0.01,
      fee_eur: 0,
    });
    expect(btc.price_eur).toBeCloseTo((300 * 0.9) / 0.01);
  });

  it("a coin going out is a sale; the amount includes the network fee, which counts as a cost", () => {
    const out = parseTradesCsv(sample, ctx).trades.find(
      (t) => t.key === "BTC" && t.side === "sell",
    )!;
    expect(out.shares).toBe(0.002);
    expect(out.price_eur).toBeCloseTo((60 * 0.9) / 0.002);
    expect(out.fee_eur).toBeCloseTo(0.0001 * out.price_eur);
  });

  it("a sale's fee cost is never more than the coins that left", () => {
    const line = "2026-01-05T08:00:00.000Z,Confirmed,BTC,OUT,0.001,0.002,h,Bitcoin 1,a,USD,30,30";
    const [out] = parseTradesCsv(row(line), ctx).trades;
    expect(out!.shares).toBe(0.001);
    expect(out!.fee_eur).toBeCloseTo(0.001 * out!.price_eur);
  });

  it("gas paid in ETH for a token transfer lowers ETH and brings nothing back", () => {
    const gas = parseTradesCsv(sample, ctx).trades.find(
      (t) => t.key === "ETH" && t.side === "sell",
    )!;
    expect(gas.shares).toBe(0.001);
    expect(gas.shares * gas.price_eur - gas.fee_eur).toBeCloseTo(0);
    expect(gas.fee_eur).toBeCloseTo(2 * 0.9);
  });

  it("a failed send takes only its fee, even when the file shows the whole amount", () => {
    const line = "2026-01-05T08:00:00.000Z,Failed,BTC,OUT,0.5,0.0001,h,Bitcoin 1,a,USD,15000,15000";
    const [failed] = parseTradesCsv(row(line), ctx).trades;
    expect(failed!.shares).toBe(0.0001);
    expect(failed!.shares * failed!.price_eur - failed!.fee_eur).toBeCloseTo(0);
    const incoming = line.replace(",OUT,", ",IN,");
    expect(parseTradesCsv(row(incoming), ctx).trades).toEqual([]);
  });

  it("reads the older export without a Status column", () => {
    const old = sample
      .split("\n")
      .map((l) =>
        l
          .split(",")
          .filter((_, i) => i !== 1)
          .join(","),
      )
      .join("\n");
    const { trades, errors } = parseTradesCsv(old, ctx);
    expect(errors).toEqual([]);
    // The 2 LTC trades are left out: sold to zero with no holding here.
    expect(trades).toHaveLength(7);
  });

  it("the same operation keeps its id whatever case the hash is in", () => {
    const line = "2026-01-05T08:00:00.000Z,Confirmed,BTC,IN,0.01,,ABC,Bitcoin 1,a,USD,300,300";
    expect(parseTradesCsv(row(line), ctx).trades[0]?.external_id).toBe("abc:BTC:IN");
  });

  it("a row with no hash has no id, so it can't clash with another", () => {
    const line = "2026-01-05T08:00:00.000Z,Confirmed,BTC,IN,0.01,,  ,Bitcoin 1,a,USD,300,300";
    const { trades, errors } = parseTradesCsv(row(line), ctx);
    expect(errors).toEqual([]);
    expect(trades[0]?.external_id).toBeNull();
  });

  it("one transaction hash can carry a token and its gas, so the id is hash, coin and type", () => {
    const ids = parseTradesCsv(sample, ctx).trades.map((t) => t.external_id);
    expect(new Set(ids).size).toBe(ids.length);
    const hash3 = "0x" + "0".repeat(63) + "3";
    expect(ids).toContain(`${hash3}:ETH:FEES`);
    expect(ids).toContain(`${hash3}:USDT:OUT`);
  });

  it("the same hash, coin and type twice in one file stays two trades", () => {
    const line = "2026-01-05T08:00:00.000Z,Confirmed,BTC,IN,0.01,,abc,Bitcoin 1,a,USD,300,300";
    const ids = parseTradesCsv(row(`${line}\n${line}`), ctx).trades.map((t) => t.external_id);
    expect(ids).toEqual(["abc:BTC:IN", "abc:BTC:IN#2"]);
  });

  it("a coin sold to zero and not held here is left out, and says so; one you still hold elsewhere is left out", () => {
    // Its trades would have no holding to show them on, and nothing could delete them.
    const { trades, notes } = parseTradesCsv(sample, ctx);
    expect(trades.some((t) => t.key === "LTC")).toBe(false);
    expect(notes).toContain("LTC: sold to zero and not held here, so its 2 trades were left out.");
    // Held here (a hand-added Litecoin), its trades are kept and set it to zero.
    const held = parseTradesCsv(sample, { ...ctx, knownKeys: new Set([...ctx.knownKeys, "LTC"]) });
    expect(held.trades.filter((t) => t.key === "LTC")).toHaveLength(2);
    expect(held.notes.some((n) => n.startsWith("LTC"))).toBe(false);
    const noEth = parseTradesCsv(sample, { ...ctx, knownKeys: new Set(["BTC", "USDT"]) });
    expect(noEth.trades.some((t) => t.key === "ETH")).toBe(false);
    expect(noEth.notes).toContain(
      "ETH has no Ledger or manual holding, so it was left out. Add it as a coin, then import again.",
    );
  });

  it("tickers are matched in capitals, like your holdings", () => {
    const line = "2026-01-05T08:00:00.000Z,Confirmed,ETHx,IN,2,,h,Ethereum 1,a,USD,10,10";
    const { trades } = parseTradesCsv(row(line), { ...ctx, knownKeys: new Set(["ETHX"]) });
    expect(trades[0]?.key).toBe("ETHX");
  });

  it("a row with no countervalue first doesn't stop the dollar rates from loading", () => {
    const blank = "2026-01-03T08:00:00.000Z,Confirmed,ETH,NFT_IN,0,,n,Ethereum 1,a,,,";
    const usdRow = "2026-01-05T08:00:00.000Z,Confirmed,BTC,IN,0.01,,h,Bitcoin 1,a,USD,300,300";
    const result = parseTradesCsv(row(`${blank}\n${usdRow}`), noRates);
    expect(result.errors).toEqual([]);
    expect(result.needsRates).toEqual({ currency: "USD", from: "2026-01-05", to: "2026-01-05" });
  });

  it("only asks for rates of a real currency code on real days", () => {
    const odd = "2026-01-05T08:00:00.000Z,Confirmed,BTC,IN,0.01,,h,Bitcoin 1,a,USD&x=1,300,300";
    const badDate = "zz?x=1,Confirmed,BTC,IN,0.01,,h,Bitcoin 1,a,USD,300,300";
    for (const line of [odd, badDate]) {
      const result = parseTradesCsv(row(line), noRates);
      expect(result.needsRates).toBeUndefined();
      expect(result.errors).toHaveLength(1);
    }
  });

  it("values already in euro need no rate", () => {
    const line = "2026-01-05T08:00:00.000Z,Confirmed,BTC,IN,0.01,,h,Bitcoin 1,a,EUR,250,250";
    const result = parseTradesCsv(row(line), noRates);
    expect(result.needsRates).toBeUndefined();
    expect(result.trades[0]?.price_eur).toBeCloseTo(25000);
  });

  it("a coin with no value in the file is counted at zero, and says so", () => {
    const line = "2026-01-05T08:00:00.000Z,Confirmed,BTC,IN,0.01,,h,Bitcoin 1,a,USD,,";
    const { trades, errors, notes } = parseTradesCsv(row(line), ctx);
    expect(errors).toEqual([]);
    expect(trades[0]?.price_eur).toBe(0);
    expect(notes).toContain("1 operation had no value in the file, so it was counted at €0.");
  });

  it("a fee-only row worth nothing in the file is counted at zero, and says so", () => {
    const line = "2026-01-05T08:00:00.000Z,Confirmed,TRX,VOTE,0,0.5,h,Tron 1,a,USD,0.10,0.10";
    const { trades, errors, notes } = parseTradesCsv(row(line), {
      ...ctx,
      knownKeys: new Set(["TRX"]),
    });
    expect(errors).toEqual([]);
    expect(trades[0]).toMatchObject({ shares: 0.5, price_eur: 0 });
    expect(notes).toContain("1 operation had no value in the file, so it was counted at €0.");
  });

  it("two coins with no value say so once, in the plural", () => {
    const a = "2026-01-05T08:00:00.000Z,Confirmed,BTC,IN,0.01,,h1,Bitcoin 1,a,USD,,";
    const b = "2026-01-06T08:00:00.000Z,Confirmed,BTC,IN,0.02,,h2,Bitcoin 1,a,USD,,";
    const { notes } = parseTradesCsv(row(`${a}\n${b}`), ctx);
    expect(notes).toContain("2 operations had no value in the file, so they were counted at €0.");
  });

  it("a day with no exchange rate stops the import, so no price is guessed", () => {
    const { trades, errors } = parseTradesCsv(sample, { ...ctx, rateToEur: () => null });
    expect(trades).toEqual([]);
    expect(errors[0]).toMatch(/^Line 2: no USD to EUR rate for 2026-03-01/);
  });

  it("a file in dollars and pounds loads the dollar rates, then stops on the pound lines", () => {
    const usdRow = "2026-01-05T08:00:00.000Z,Confirmed,BTC,IN,0.01,,h1,Bitcoin 1,a,USD,300,300";
    const gbpRow = "2026-01-06T08:00:00.000Z,Confirmed,BTC,IN,0.01,,h2,Bitcoin 1,a,GBP,250,250";
    const file = row(`${usdRow}\n${gbpRow}`);
    expect(parseTradesCsv(file, noRates).needsRates?.currency).toBe("USD");
    expect(parseTradesCsv(file, ctx).errors).toEqual([
      "Line 3: no GBP to EUR rate for 2026-01-06.",
    ]);
  });

  it("a staking reward comes in at no cost, so all its value is gain", () => {
    const line = "2026-01-05T08:00:00.000Z,Confirmed,ATOM,REWARD,2,,h,Cosmos 1,a,USD,20,20";
    const [reward] = parseTradesCsv(row(line), { ...ctx, knownKeys: new Set(["ATOM"]) }).trades;
    expect(reward).toMatchObject({ side: "buy", shares: 2, price_eur: 0, fee_eur: 0 });
  });

  it("a staking action (vote, freeze, bond) takes only its fee", () => {
    const line = "2026-01-05T08:00:00.000Z,Confirmed,TRX,VOTE,0.5,0.5,h,Tron 1,a,USD,0.10,0.10";
    const [vote] = parseTradesCsv(row(line), { ...ctx, knownKeys: new Set(["TRX"]) }).trades;
    expect(vote).toMatchObject({ side: "sell", shares: 0.5 });
    expect(vote!.shares * vote!.price_eur - vote!.fee_eur).toBeCloseTo(0);
  });

  it("a staking action with no fee moves nothing: no trade, no error", () => {
    const line = "2026-01-05T08:00:00.000Z,Confirmed,TRX,VOTE,0.5,0,h,Tron 1,a,USD,0.10,0.10";
    const { trades, errors } = parseTradesCsv(row(line), { ...ctx, knownKeys: new Set(["TRX"]) });
    expect(trades).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("delegating moves the coins out, and slashed coins are a loss", () => {
    const known = { ...ctx, knownKeys: new Set(["ATOM"]) };
    const delegate =
      "2026-01-05T08:00:00.000Z,Confirmed,ATOM,DELEGATE,10,0.01,h,Cosmos 1,a,USD,100,100";
    const [out] = parseTradesCsv(row(delegate), known).trades;
    expect(out!.shares * out!.price_eur - out!.fee_eur).toBeCloseTo((10 - 0.01) * 9);
    const slash = "2026-01-05T08:00:00.000Z,Confirmed,ATOM,SLASH,1,,h,Cosmos 1,a,USD,10,10";
    const [lost] = parseTradesCsv(row(slash), known).trades;
    expect(lost!.shares * lost!.price_eur - lost!.fee_eur).toBeCloseTo(0);
  });

  it("operations that move no coins (NFTs) are skipped and counted", () => {
    const line = "2026-01-05T08:00:00.000Z,Confirmed,ETH,NFT_IN,0,,h,Ethereum 1,a,USD,,";
    const { trades, notes } = parseTradesCsv(row(line), ctx);
    expect(trades).toEqual([]);
    expect(notes).toContain("1 operation that doesn't move coins (an NFT or similar) was skipped.");
  });

  it("a ticker or hash too long to save is a line error, not a failed save", () => {
    const longTicker = `2026-01-05T08:00:00.000Z,Confirmed,${"X".repeat(101)},IN,1,,h,A,a,USD,1,1`;
    expect(parseTradesCsv(row(longTicker), ctx).errors).toEqual([
      "Line 2: the coin name is too long (received 5 Jan 2026).",
    ]);
    const longHash = `2026-01-05T08:00:00.000Z,Confirmed,BTC,IN,1,,${"a".repeat(195)},A,a,USD,1,1`;
    expect(parseTradesCsv(row(longHash), ctx).errors).toEqual([
      "Line 2: the operation hash is too long (BTC, received 5 Jan 2026).",
    ]);
  });

  // protects=lengths count characters like the database (char_length), not UTF-16 units
  it("a 100-character coin name and a 200-character id fit even with an emoji or accent", () => {
    const at = (ticker: string, hash = "h") =>
      parseTradesCsv(
        row(`2026-01-05T08:00:00.000Z,Confirmed,${ticker},IN,1,,${hash},A,a,USD,1,1`),
        ctx,
      ).errors;
    for (const first of ["😀", "É"]) {
      expect(at(first + "X".repeat(99))).toEqual([]);
      expect(at(first + "X".repeat(100))).toEqual([
        "Line 2: the coin name is too long (received 5 Jan 2026).",
      ]);
    }
    // The id is "<hash>:BTC:IN": a 193-character hash makes it 200.
    for (const first of ["😀", "é"]) {
      expect(at("BTC", first + "a".repeat(192))).toEqual([]);
      expect(at("BTC", first + "a".repeat(193))).toEqual([
        "Line 2: the operation hash is too long (BTC, received 5 Jan 2026).",
      ]);
    }
  });

  it("a number too big to hold (1e999) is a line error, not a failed save", () => {
    for (const cells of ["IN,1e999,,h", "OUT,1,1e999,h"]) {
      const line = `2026-01-05T08:00:00.000Z,Confirmed,BTC,${cells},Bitcoin 1,a,USD,300,300`;
      expect(parseTradesCsv(row(line), ctx).errors).toHaveLength(1);
    }
    const value = "2026-01-05T08:00:00.000Z,Confirmed,BTC,IN,1,,h,Bitcoin 1,a,USD,1e999,1";
    expect(parseTradesCsv(row(value), ctx).errors).toEqual([
      'Line 2: the value "1e999" is too big (BTC, received 5 Jan 2026).',
    ]);
  });

  it("a value too big for its amount is a line error, not a failed save", () => {
    const line = "2026-01-05T08:00:00.000Z,Confirmed,BTC,IN,1e-10,,h,Bitcoin 1,a,USD,1e308,1";
    expect(parseTradesCsv(row(line), ctx).errors).toEqual([
      'Line 2: the value "1e308" is too big for the amount "1e-10" (BTC, received 5 Jan 2026).',
    ]);
  });

  it("an unreadable value is a line error even where the value sets no price", () => {
    const line = "2026-01-05T08:00:00.000Z,Confirmed,ATOM,REWARD,2,,h,Cosmos 1,a,USD,abc,20";
    const result = parseTradesCsv(row(line), { ...ctx, knownKeys: new Set(["ATOM"]) });
    expect(result.errors).toEqual([
      'Line 2: the value "abc" isn\'t a number (ATOM, reward 5 Jan 2026).',
    ]);
  });

  it("a line error names the field, its value, the coin and the operation in plain words", () => {
    const at = (cells: string) =>
      parseTradesCsv(row(`2026-01-05T08:00:00.000Z,Confirmed,${cells},A,a,USD,300,300`), ctx)
        .errors;
    expect(at("BTC,OUT,1,x,h")).toEqual([
      'Line 2: the fee "x" isn\'t a number (BTC, sent 5 Jan 2026).',
    ]);
    expect(at("ETH,FEES,1,x,h")).toEqual([
      'Line 2: the fee "x" isn\'t a number (ETH, fee 5 Jan 2026).',
    ]);
    expect(at("ETH,FREEZE,1,x,h")).toEqual([
      'Line 2: the fee "x" isn\'t a number (ETH, staking 5 Jan 2026).',
    ]);
    expect(at(",IN,1,,h")).toEqual(["Line 2: there's no coin (received 5 Jan 2026)."]);
    const badDay = "2026-13-45T08:00:00.000Z,Confirmed,BTC,IN,1,,h,A,a,USD,300,300";
    expect(parseTradesCsv(row(badDay), ctx).errors).toEqual([
      'Line 2: the date "2026-13-45" isn\'t a date (BTC, received).',
    ]);
  });

  it("amounts are plain decimals: 0x10 is not 16 coins", () => {
    const line = "2026-01-05T08:00:00.000Z,Confirmed,BTC,IN,0x10,,h,Bitcoin 1,a,USD,300,300";
    expect(parseTradesCsv(row(line), ctx).errors).toEqual([
      'Line 2: the amount "0x10" isn\'t a number (BTC, received 5 Jan 2026).',
    ]);
  });

  it("one unreadable row doesn't stop the rates for the others", () => {
    const good = "2026-01-05T08:00:00.000Z,Confirmed,BTC,IN,0.01,,h,Bitcoin 1,a,USD,300,300";
    for (const bad of [
      "zz,Confirmed,ETH,NFT_IN,1,,n,Ethereum 1,a,USD,5,5",
      "2026-13-45T08:00:00.000Z,Confirmed,BTC,IN,0.01,,h2,Bitcoin 1,a,USD,300,300",
    ]) {
      const result = parseTradesCsv(row(`${bad}\n${good}`), noRates);
      expect(result.needsRates).toEqual({ currency: "USD", from: "2026-01-05", to: "2026-01-05" });
    }
  });

  it("a currency in small letters is still that currency", () => {
    const line = "2026-01-05T08:00:00.000Z,Confirmed,BTC,IN,0.01,,h,Bitcoin 1,a,usd,300,300";
    expect(parseTradesCsv(row(line), noRates).needsRates?.currency).toBe("USD");
    const result = parseTradesCsv(row(line), ctx);
    expect(result.errors).toEqual([]);
    expect(result.trades[0]!.price_eur).toBeCloseTo((300 * 0.9) / 0.01);
  });

  it("a broken row or a future date is an error, so nothing is saved", () => {
    const bad = "2026-01-05T08:00:00.000Z,Confirmed,BTC,IN,abc,,h,Bitcoin 1,a,USD,300,300";
    expect(parseTradesCsv(row(bad), ctx).errors).toEqual([
      'Line 2: the amount "abc" isn\'t a number (BTC, received 5 Jan 2026).',
    ]);
    const future = "2027-01-05T08:00:00.000Z,Confirmed,BTC,IN,1,,h,Bitcoin 1,a,USD,300,300";
    expect(parseTradesCsv(row(future), ctx).errors).toEqual([
      "Line 2: the date is in the future (BTC, received 5 Jan 2027).",
    ]);
  });

  it("a UTC day one past your local today is not in the future; two past still is", () => {
    // Ledger dates are UTC days: late evening west of UTC is already tomorrow there.
    const at = (day: string) =>
      `${day}T02:00:00.000Z,Confirmed,BTC,IN,1,,h,Bitcoin 1,a,USD,300,300`;
    const tomorrow = parseTradesCsv(row(at("2026-11-18")), ctx);
    expect(tomorrow.errors).toEqual([]);
    expect(tomorrow.trades[0]?.trade_date).toBe("2026-11-18");
    expect(parseTradesCsv(row(at("2026-11-19")), ctx).errors).toEqual([
      "Line 2: the date is in the future (BTC, received 19 Nov 2026).",
    ]);
  });

  it("on the Portfolio page it points you to the Crypto page", () => {
    const result = parseTradesCsv(sample, { ...ctx, kind: "stock" });
    expect(result.trades).toEqual([]);
    expect(result.errors[0]).toBe(
      "This file comes from Ledger Live: import it on the Crypto page.",
    );
  });
});
