import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/integrations/supabase/client", () => {
  const rows: Record<string, Array<Record<string, unknown>>> = {
    v_portfolio_latest: [
      {
        isin: "IE00B4L5Y983",
        name: "iShares Core MSCI World",
        shares: 12.3456,
        broker_label: "Scalable",
        snapshot_date: "2026-11-17",
        price: 101.5,
        currency: "EUR",
        value_native: 1253.08,
        value_eur: 1253.08,
        asset_type: "ETF",
      },
      {
        isin: "US0000000001",
        name: "No Price Inc",
        shares: null,
        broker_label: null,
        snapshot_date: "2026-11-17",
        price: null,
        currency: null,
        value_native: null,
        value_eur: 10,
        asset_type: "ETF",
      },
    ],
  };
  const query = (table: string) => {
    const q: Record<string, unknown> = {};
    for (const m of ["select", "order", "eq", "in", "gte", "lte", "neq", "limit", "range"])
      q[m] = () => q;
    q["then"] = (resolve: (v: unknown) => void) =>
      resolve({ data: rows[table] ?? [], error: null });
    return q;
  };
  return {
    supabase: {
      from: query,
      rpc: () => Promise.resolve({ data: [], error: null }),
      functions: { invoke: vi.fn() },
    },
  };
});

import { Route } from "./portfolio";

const Page = Route.options.component as () => React.JSX.Element;

describe("Portfolio holding rows", () => {
  it("shows shares and price on the table and the phone rows, a dash when unknown", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Page />
      </QueryClientProvider>,
    );
    const toggle = (await screen.findAllByRole("button", { expanded: false }))[0]!;
    fireEvent.click(toggle);
    const table = await screen.findByRole("table");
    const [, priced, unpriced] = within(table).getAllByRole("row");
    expect(priced).toHaveTextContent("12.346");
    expect(priced).toHaveTextContent("€101.50");
    expect(within(unpriced!).getAllByText("—").length).toBeGreaterThanOrEqual(2);
    // The phone row's shares line.
    expect(screen.getAllByText("12.346")).toHaveLength(2);
  });
});
