import { describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

type Row = Record<string, unknown>;
const db: Record<string, Array<Row>> = {};
// A small in-memory PostgREST: eq, in, order (newest first) and limit really apply.
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => {
      const filters: Array<(r: Row) => boolean> = [];
      let desc: string | null = null;
      let limit = 1000;
      const q: Record<string, unknown> = {};
      q["select"] = () => q;
      q["eq"] = (c: string, v: unknown) => (filters.push((r) => r[c] === v), q);
      q["in"] = (c: string, v: Array<unknown>) => (filters.push((r) => v.includes(r[c])), q);
      q["order"] = (c: string) => ((desc = c), q);
      q["limit"] = (n: number) => ((limit = n), q);
      q["then"] = (resolve: (v: unknown) => void) => {
        let rows = (db[table] ?? []).filter((r) => filters.every((f) => f(r)));
        if (desc) rows = [...rows].sort((a, b) => String(b[desc!]).localeCompare(String(a[desc!])));
        resolve({ data: rows.slice(0, Math.min(limit, 1000)), error: null });
      };
      return q;
    },
  },
}));

import { useSplitwiseBalances } from "./use-splitwise-balances";

const day = (i: number) =>
  new Date(Date.UTC(2026, 10, 20) - i * 86_400_000).toISOString().slice(0, 10);
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
);

describe("useSplitwiseBalances", () => {
  // protects=every balance currency gets its latest rate; fails_when=a currency whose feed stalled
  // falls outside a window shared with the others and shows no euro value
  it("finds each currency's latest rate, however many newer rows another currency has", async () => {
    db["splitwise_balances"] = [
      { group_name: "Trip", person: "Ann", balance: 10, currency: "USD", is_me: false },
      { group_name: "Trip", person: "Bob", balance: 5, currency: "GBP", is_me: false },
    ];
    db["fx_rates"] = [
      ...Array.from({ length: 600 }, (_, i) => ({
        currency: "USD",
        date: day(i),
        rate_to_eur: 0.9,
      })),
      { currency: "GBP", date: day(700), rate_to_eur: 1.15 },
      { currency: "GBP", date: day(701), rate_to_eur: 1.1 },
    ];
    const { result } = renderHook(() => useSplitwiseBalances(), { wrapper });
    await waitFor(() => expect(result.current.rates.isSuccess).toBe(true));
    expect(result.current.rate("USD")).toBe(0.9);
    expect(result.current.rate("GBP")).toBe(1.15);
    expect(result.current.rate("EUR")).toBe(1);
  });
});
