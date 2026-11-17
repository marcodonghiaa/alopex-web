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
// server, one request returns at most 1000 rows.
const CAP = 1000;
const fakeDb = (stored: Array<{ date: string; rate_to_eur: number }>, error: unknown = null) => {
  const q = {
    select: () => q,
    eq: () => q,
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
