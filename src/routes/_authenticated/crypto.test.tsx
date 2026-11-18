import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/integrations/supabase/client", () => {
  const rows: Record<string, Array<Record<string, unknown>>> = {
    v_crypto_latest: [
      {
        asset_symbol: "BTC",
        name: "Bitcoin",
        amount: 1,
        source: "Manual",
        snapshot_date: "2026-11-17",
        price_usd: 90000,
        value_usd: 90000,
        value_eur: 80000,
      },
    ],
  };
  const query = (table: string) => {
    const q: Record<string, unknown> = {};
    for (const m of ["select", "order", "eq", "in", "gte", "lte", "neq", "limit"]) q[m] = () => q;
    q["then"] = (resolve: (v: unknown) => void) =>
      resolve({ data: rows[table] ?? [], error: null });
    return q;
  };
  return { supabase: { from: query, functions: { invoke: vi.fn() } } };
});

import { Route } from "./crypto";

const Page = Route.options.component as () => React.JSX.Element;

// polish-4 #8: the table's "Edit" header label is screen-reader-only, so absolutely placed. With no
// positioned box around it, the table's own scroll box didn't clip it and the whole page scrolled
// sideways at 768-834 px. jsdom can't measure layout; the browser check is in the polish-4 log.
// fails_when=the table's scroll box isn't the containing block of what's inside it
describe("Crypto page table", () => {
  it("keeps what's inside the table in the table's own scroll box", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Page />
      </QueryClientProvider>,
    );
    const table = await screen.findByRole("table");
    expect(table.parentElement).toHaveClass("overflow-x-auto", "relative");
  });
});
