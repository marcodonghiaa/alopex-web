import { describe, expect, it, vi } from "vitest";
import { addedTrade, changeTrade, latestPriceEur, recordTrade } from "./manual-trades";

// protects=a holding added by hand has a return (Marco); fails_when=it shows no % ever
describe("addedTrade", () => {
  it("is one buy of the amount, on the day and at the price given", () => {
    expect(
      addedTrade({
        kind: "stock",
        key: "IE00X",
        quantity: 10,
        boughtOn: "2026-03-02",
        priceEur: 50,
      }),
    ).toEqual({
      kind: "stock",
      key: "IE00X",
      side: "buy",
      trade_date: "2026-03-02",
      shares: 10,
      price_eur: 50,
      fee_eur: 0,
      source: "Manual",
    });
  });
});

// protects=editing shares by hand keeps trades in step; fails_when=the % hides after an edit
describe("changeTrade", () => {
  const base = { kind: "crypto" as const, key: "BTC", date: "2026-11-17", priceEur: 80_000 };

  it("records more as a buy and less as a sale, of the difference", () => {
    expect(changeTrade({ ...base, from: 1, to: 1.5 })).toMatchObject({ side: "buy", shares: 0.5 });
    expect(changeTrade({ ...base, from: 1, to: 0 })).toMatchObject({
      side: "sell",
      shares: 1,
      price_eur: 80_000,
      source: "Manual",
    });
  });

  it("is nothing when the amount didn't change", () => {
    expect(changeTrade({ ...base, from: 1, to: 1 })).toBeNull();
  });
});

const client = (rows: unknown, error: unknown = null) => {
  const q = {
    select: vi.fn(() => q),
    eq: vi.fn(() => q),
    order: vi.fn(() => q),
    limit: vi.fn(async () => ({ data: rows, error })),
    insert: vi.fn(async () => ({ error })),
  };
  return {
    q,
    from: vi.fn(() => q),
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: "u1" } } })) },
  } as never as Parameters<typeof latestPriceEur>[0] & { q: typeof q };
};

describe("latestPriceEur", () => {
  it("is the latest snapshot's euro value per share", async () => {
    const c = client([{ value_eur: 500, value_native: 550, price: 55 }]);
    expect(await latestPriceEur(c, "stock", "IE00X")).toBe(50);
    expect(c.q.eq).toHaveBeenCalledWith("isin", "IE00X");
  });

  it("for a coin is the euro value per coin", async () => {
    const c = client([{ value_eur: 160_000, amount: 2 }]);
    expect(await latestPriceEur(c, "crypto", "BTC")).toBe(80_000);
    expect(c.q.eq).toHaveBeenCalledWith("asset_symbol", "BTC");
  });

  it("is null without a priced snapshot", async () => {
    expect(await latestPriceEur(client([]), "stock", "IE00X")).toBeNull();
    expect(
      await latestPriceEur(client([{ value_eur: null, amount: 1 }]), "crypto", "BTC"),
    ).toBeNull();
  });
});

describe("recordTrade", () => {
  const trade = changeTrade({
    kind: "stock",
    key: "A",
    date: "2026-11-17",
    priceEur: 1,
    from: 0,
    to: 2,
  })!;

  it("saves the trade as yours", async () => {
    const c = client(null);
    await recordTrade(c, trade);
    expect(c.q.insert).toHaveBeenCalledWith({ ...trade, user_id: "u1" });
  });

  it("throws what the database answers", async () => {
    await expect(recordTrade(client(null, { message: "nope" }), trade)).rejects.toEqual({
      message: "nope",
    });
  });
});
