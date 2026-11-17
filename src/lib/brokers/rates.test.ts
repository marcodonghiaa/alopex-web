import { describe, expect, it, vi } from "vitest";
import { loadRates, rateLookup } from "./rates";

const rows = [
  { date: "2026-01-02", rate_to_eur: 0.9 },
  { date: "2026-01-05", rate_to_eur: 0.8 },
];

describe("rateLookup", () => {
  const rate = rateLookup("USD", rows);

  it("uses the day's rate, or the last one before it (weekends have none)", () => {
    expect(rate("USD", "2026-01-02")).toBe(0.9);
    expect(rate("USD", "2026-01-04")).toBe(0.9);
    expect(rate("USD", "2026-01-05")).toBe(0.8);
  });

  it("never guesses: no rate before the first day, after a long gap, or for another currency", () => {
    expect(rate("USD", "2026-01-01")).toBeNull();
    expect(rate("USD", "2026-02-01")).toBeNull();
    expect(rate("GBP", "2026-01-02")).toBeNull();
  });
});

// The few calls loadRates makes on the supabase client, answering with `stored`. Like the real
// server, one request returns at most 1000 rows, and `eq` keeps only the matching rows (a row
// without that column always matches).
const CAP = 1000;
type StoredRow = { date: string; rate_to_eur: number; currency?: string };
const fakeDb = (all: Array<StoredRow>, error: unknown = null) => {
  let stored = all;
  const q = {
    select: () => q,
    eq: (column: string, value: unknown) => {
      stored = stored.filter((r) => !(column in r) || r[column as keyof StoredRow] === value);
      return q;
    },
    gte: () => q,
    lte: () => q,
    order: () => q,
    limit: (n: number) => Promise.resolve({ data: stored.slice(0, Math.min(n, CAP)), error }),
    range: (from: number, to: number) =>
      Promise.resolve({
        data: error ? null : stored.slice(from, Math.min(to + 1, from + CAP)),
        error,
        count: error ? null : stored.length,
      }),
  };
  return { from: vi.fn(() => q) } as unknown as Parameters<typeof loadRates>[3];
};
const series = (rates: Record<string, number>) =>
  vi.fn(async () => ({
    ok: true,
    json: async () => ({
      rates: Object.fromEntries(Object.entries(rates).map(([d, r]) => [d, { USD: r }])),
    }),
  }));

describe("loadRates", () => {
  it("uses the stored rates when they cover every day", async () => {
    const get = series({});
    const found = await loadRates("USD", "2026-01-03", "2026-01-05", fakeDb(rows), get);
    expect(found).toEqual(rows);
    expect(get).not.toHaveBeenCalled();
  });

  it("stored rates that start exactly on the first day need nothing else", async () => {
    const get = series({});
    const found = await loadRates("USD", "2026-01-02", "2026-01-05", fakeDb(rows), get);
    expect(found).toEqual(rows);
    expect(get).not.toHaveBeenCalled();
  });

  it("reads only the rates of the currency asked for", async () => {
    const usd = rows.map((r) => ({ ...r, currency: "USD" }));
    const gbp = [{ date: "2026-01-03", rate_to_eur: 1.2, currency: "GBP" }];
    const get = series({});
    const found = await loadRates("USD", "2026-01-02", "2026-01-05", fakeDb([...usd, ...gbp]), get);
    expect(found).toEqual(usd);
  });

  it("reads every stored day, past the server's 1000 rows a request", async () => {
    const many = Array.from({ length: 1500 }, (_, i) => ({
      date: new Date(Date.UTC(2020, 0, 1) + i * 86_400_000).toISOString().slice(0, 10),
      rate_to_eur: 0.9,
    }));
    const found = await loadRates("USD", "2020-01-01", "2024-02-08", fakeDb(many), series({}));
    expect(found).toHaveLength(1500);
    expect(found.at(-1)!.date).toBe(many.at(-1)!.date);
  });

  it("fetches the older days a fresh install hasn't stored, as euro per dollar", async () => {
    // Frankfurter also answers for 2026-01-02, a day already stored: the stored one is kept.
    const get = series({ "2025-12-29": 1.25, "2026-01-02": 2 });
    const found = await loadRates("USD", "2026-01-01", "2026-01-05", fakeDb(rows), get);
    expect(get).toHaveBeenCalledWith(
      "https://api.frankfurter.dev/v1/2025-12-22..2026-01-02?base=EUR&symbols=USD",
    );
    expect(found[0]).toEqual({ date: "2025-12-29", rate_to_eur: 0.8 });
    expect(found.slice(1)).toEqual(rows);
  });

  it("keeps only real days with a usable rate from the exchange-rate site", async () => {
    const get = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        rates: {
          __proto__x: { USD: 1 },
          "9999-zz": { USD: 1 },
          "2025-02-30": { USD: 1 },
          "2025-12-27": null,
          "2025-12-28": { USD: 5e-324 },
          "2025-12-29": { USD: "1.1" },
          "2025-12-30": { USD: 1.25 },
        },
      }),
    }));
    const found = await loadRates("USD", "2026-01-01", "2026-01-05", fakeDb(rows), get);
    expect(found[0]).toEqual({ date: "2025-12-30", rate_to_eur: 0.8 });
    expect(found).toHaveLength(1 + rows.length);
  });

  it("a broken answer from the exchange-rate site is our error, not a crash", async () => {
    const get = vi.fn(async () => ({ ok: true, json: async () => JSON.parse("{") as unknown }));
    await expect(loadRates("USD", "2026-01-01", "2026-01-05", fakeDb([]), get)).rejects.toThrow(
      /Couldn't load USD exchange rates/,
    );
  });

  it("asks the exchange-rate site with the currency encoded", async () => {
    const get = series({});
    await loadRates("US D", "2026-01-01", "2026-01-05", fakeDb([]), get);
    expect(get).toHaveBeenCalledWith(
      "https://api.frankfurter.dev/v1/2025-12-22..2026-01-05?base=EUR&symbols=US%20D",
    );
  });

  it("asks the exchange-rate site the security policy allows (FX_HISTORY)", async () => {
    vi.resetModules();
    vi.doMock("@/lib/csp", () => ({ FX_HISTORY: "https://fx.example" }));
    try {
      const fresh = await import("./rates");
      const get = series({});
      await fresh.loadRates("USD", "2026-01-01", "2026-01-05", fakeDb([]), get);
      expect(get).toHaveBeenCalledWith(
        "https://fx.example/v1/2025-12-22..2026-01-05?base=EUR&symbols=USD",
      );
    } finally {
      vi.doUnmock("@/lib/csp");
      vi.resetModules();
    }
  });

  it("an exchange-rate site that can't be reached (offline, blocked) is our error", async () => {
    const offline = vi.fn(() => Promise.reject(new TypeError("Failed to fetch")));
    await expect(loadRates("USD", "2026-01-01", "2026-01-05", fakeDb([]), offline)).rejects.toThrow(
      /Couldn't load USD exchange rates/,
    );
  });

  it("says so when the rates can't be loaded", async () => {
    const down = vi.fn(async () => ({ ok: false, json: async () => ({}) }));
    await expect(loadRates("USD", "2025-01-01", "2026-01-05", fakeDb([]), down)).rejects.toThrow(
      /Couldn't load USD exchange rates/,
    );
    await expect(
      loadRates("USD", "2026-01-03", "2026-01-05", fakeDb([], { message: "x" }), down),
    ).rejects.toThrow(/Couldn't load USD exchange rates/);
  });
});
