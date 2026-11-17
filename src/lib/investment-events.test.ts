import { describe, expect, it } from "vitest";
import { incomeByKey, newEvents, summarizeIncome } from "./investment-events";
import type { InvestmentEvent } from "./investment-events";

const ev = (e: Partial<InvestmentEvent>): InvestmentEvent => ({
  kind: "dividend",
  asset_kind: "stock",
  key: "XX1",
  event_date: "2026-03-01",
  amount_eur: 10,
  tax_eur: 0,
  fee_eur: 0,
  raw_type: "CASH|DIVIDEND",
  source: "trade_republic",
  external_id: null,
  ...e,
});

describe("newEvents", () => {
  it("leaves out an event already saved by its broker id, and a repeat within the file", () => {
    const a = ev({ external_id: "a" });
    const b = ev({ external_id: "b" });
    expect(newEvents([a, b, b], [{ source: "trade_republic", external_id: "a" }])).toEqual([b]);
  });

  it("the same id from another broker is another event; one without an id is always new", () => {
    const a = ev({ external_id: "a" });
    expect(newEvents([{ ...a, source: "ibkr" }], [a])).toHaveLength(1);
    const plain = ev({});
    expect(newEvents([plain, plain], [plain])).toHaveLength(2);
  });
});

describe("summarizeIncome", () => {
  const events = [
    ev({ kind: "dividend", amount_eur: 8, tax_eur: 2 }),
    ev({ kind: "interest", key: null, asset_kind: null, amount_eur: 3, tax_eur: 1 }),
    ev({ kind: "reward", amount_eur: 1.5 }),
    ev({ kind: "fee", key: null, asset_kind: null, amount_eur: -5 }),
    ev({ kind: "tax", key: null, asset_kind: null, amount_eur: -4 }),
    ev({ kind: "tax_refund", key: null, asset_kind: null, amount_eur: 1 }),
    ev({ kind: "deposit", key: null, asset_kind: null, amount_eur: 500 }),
    ev({ kind: "dividend", event_date: "2025-12-31", amount_eur: 100 }),
  ];

  it("adds up income after tax, and taxes and fees paid, deposits aside", () => {
    expect(summarizeIncome(events, "2026-01-01")).toEqual({
      income: 12.5,
      dividends: 8,
      interest: 3,
      rewards: 1.5,
      taxes: 2 + 1 + 4 - 1,
      fees: 5,
    });
  });

  it("with no start date it counts everything", () => {
    expect(summarizeIncome(events).dividends).toBe(108);
  });

  it("a fee held back from a dividend counts as a fee", () => {
    expect(summarizeIncome([ev({ fee_eur: 0.5 })]).fees).toBe(0.5);
  });
});

describe("incomeByKey", () => {
  it("what each holding paid you, by kind and key; cash interest and fees belong to none", () => {
    const by = incomeByKey([
      ev({ amount_eur: 2 }),
      ev({ amount_eur: -0.5 }), // a corrected dividend
      ev({ kind: "reward", asset_kind: "crypto", key: "BTC", amount_eur: 1 }),
      ev({ kind: "fee", amount_eur: -3 }),
      ev({ kind: "interest", key: null, asset_kind: null, amount_eur: 9 }),
    ]);
    expect([...by]).toEqual([
      ["stock|XX1", 1.5],
      ["crypto|BTC", 1],
    ]);
  });

  it("tax given back on a holding's trade goes back into its return; an unkeyed refund doesn't", () => {
    const by = incomeByKey([
      ev({ kind: "tax_refund", amount_eur: 10 }),
      ev({ kind: "tax_refund", key: null, asset_kind: null, amount_eur: 5 }),
    ]);
    expect([...by]).toEqual([["stock|XX1", 10]]);
  });
});
