import { describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

// One holding: 10 bought at 10, worth 12 now. It paid a 5 dividend; another holding paid 7.
vi.mock("@/integrations/supabase/client", () => {
  const tables: Record<string, Array<Record<string, unknown>>> = {
    holding_trades: [
      {
        id: "t1",
        kind: "stock",
        key: "K",
        side: "buy",
        trade_date: "2026-01-02",
        shares: 10,
        price_eur: 10,
        fee_eur: 0,
      },
    ],
    investment_events: [
      { kind: "dividend", asset_kind: "stock", key: "K", event_date: "2026-03-01", amount_eur: 5 },
      {
        kind: "dividend",
        asset_kind: "stock",
        key: "OTHER",
        event_date: "2026-03-01",
        amount_eur: 7,
      },
    ],
  };
  const rows = [
    {
      kind: "stock",
      key: "K",
      name: "Holding",
      quantity: 10,
      start_date: "2026-01-02",
      start_price_eur: 10,
      end_date: "2026-11-16",
      end_price_eur: 12,
      status: "ok",
    },
  ];
  return {
    supabase: {
      rpc: async () => ({ data: rows, error: null }),
      from: (table: string) => ({
        select: () => ({
          order: () => ({
            range: async () => ({
              data: tables[table],
              error: null,
              count: tables[table]!.length,
            }),
          }),
        }),
      }),
    },
  };
});

import { usePerformance } from "./use-performance";

describe("usePerformance income", () => {
  it("adds what a holding paid you to its return, and only its own", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => usePerformance("2026-11-16", "stock"), { wrapper });
    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(result.current.measuredByKey.get("K")).toMatchObject({ state: "ok", gain: 25 });
  });

  // H155: with no value history yet (or it failed to load), returns still load instead of "…".
  it("loads returns even when there is no value history yet", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => usePerformance(undefined, "stock"), { wrapper });
    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(result.current.measuredByKey.get("K")).toMatchObject({ state: "ok", gain: 25 });
  });
});
