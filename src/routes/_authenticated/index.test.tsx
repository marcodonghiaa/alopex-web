import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let failTable: string | null = null;
// Someone who imported a spreadsheet but has no bank yet: history rows, no live snapshots.
let historyOnly = false;
// Per-test rows for a table, in place of the defaults below.
let rowsFor: Record<string, Array<unknown>> = {};
const HISTORY = {
  snapshot_date: "2025-01-31",
  stocks_eur: 1000,
  bonds_eur: 0,
  crypto_eur: 0,
  cash_eur: 500,
  other_eur: 0,
  liabilities_eur: 0,
  total_eur: 1500,
};
const SNAPSHOT = {
  snapshot_date: "2026-10-19",
  total_eur: 1000,
  bank_total_eur: 400,
  portfolio_total_eur: 400,
  crypto_total_eur: 200,
};
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "order", "limit", "in"]) q[m] = () => q;
      // Paged reads: every row comes on the first page, so the next one is empty.
      let offset = 0;
      q["range"] = (from: number) => ((offset = from), q);
      q["then"] = (resolve: (v: unknown) => void) => {
        if (offset > 0) return resolve({ data: [], error: null });
        // The exchange rates never arrive: the page must say it is waiting, not that there are none.
        if (rowsFor[table]) return resolve({ data: rowsFor[table], error: null });
        if (table === "fx_rates") return;
        if (table === failTable) return resolve({ data: null, error: { message: "boom" } });
        if (historyOnly)
          return resolve({ data: table === "net_worth_history" ? [HISTORY] : [], error: null });
        resolve({ data: table === "v_net_worth_daily" ? [SNAPSHOT] : [], error: null });
      };
      return q;
    },
  },
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ children }: { children: React.ReactNode }) => <a href="/health">{children}</a>,
}));
vi.mock("recharts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("recharts")>()),
  ResponsiveContainer: () => null,
}));

import { Route } from "./index";

const Page = Route.options.component as () => React.JSX.Element;

describe("Net worth page in a foreign currency", () => {
  it("does not claim a missing exchange rate while rates are still loading", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Page />
      </QueryClientProvider>,
    );
    await userEvent.click(await screen.findByRole("radio", { name: "USD" }));
    expect(screen.queryByText(/No USD exchange rate/)).toBeNull();
  });
});

describe("Net worth page when an extra source fails to load", () => {
  // protects=a failed history query is reported instead of silently shortening the chart;
  // fails_when=the page ignores the error state of its history, rebuilt-month or FX queries
  it.each(["net_worth_history", "net_worth_reconstructed"])(
    "shows an error when %s fails",
    async (table) => {
      failTable = table;
      render(
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <Page />
        </QueryClientProvider>,
      );
      expect((await screen.findByRole("alert")).textContent).toContain("boom");
      failTable = null;
    },
  );

  it("shows no error when everything loads", async () => {
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <Page />
      </QueryClientProvider>,
    );
    await screen.findByRole("radio", { name: "USD" });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  // Health lives in Settings now; the dashboard no longer links to it.
  it("has no Health shortcut", async () => {
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <Page />
      </QueryClientProvider>,
    );
    await screen.findByRole("radio", { name: "USD" });
    expect(screen.queryByRole("link", { name: /health/i })).toBeNull();
  });
});

describe("Net worth page with only imported history", () => {
  // protects=a new user who imported a CSV sees their history charted; fails_when=the empty
  // chart message keys on live snapshots instead of on what the chart would draw
  it("charts the history instead of saying there is no data", async () => {
    historyOnly = true;
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <Page />
      </QueryClientProvider>,
    );
    await screen.findByRole("radio", { name: "USD" });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText("No data to chart yet.")).toBeNull();
    historyOnly = false;
  });
});

const renderPage = () =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <Page />
    </QueryClientProvider>,
  );
const day = (snapshot_date: string, total_eur: number) => ({
  ...SNAPSHOT,
  snapshot_date,
  total_eur,
});

describe("Net worth page: headline (iOS view board)", () => {
  // protects=the range change sits beside the figure as a percent, a tap shows the amount, and the
  // range is named once underneath; fails_when=a separate Today line comes back
  it("shows the range change beside the figure, with no Today line", async () => {
    rowsFor = {
      v_net_worth_daily: [
        day("2025-12-31", 1000),
        day("2026-11-09", 1500),
        day("2026-11-10", 1250),
      ],
    };
    renderPage();
    const chip = await screen.findByRole("button", { name: /show change as amount/i });
    expect(chip).toHaveTextContent("▲ 25.00%");
    expect(chip.className).toContain("text-positive");
    expect(screen.getByText("Year to date")).toBeInTheDocument();
    expect(screen.queryByText("Today")).toBeNull();
    await userEvent.click(chip);
    expect(screen.getByRole("button", { name: /show change as percent/i })).toHaveTextContent(
      "▲ €250.00",
    );
    rowsFor = {};
  });

  it("titles the page like the Breakdown card", async () => {
    renderPage();
    const title = await screen.findByRole("heading", { level: 1, name: "Net worth" });
    expect(title.className).toContain("font-semibold");
    expect(title.className).toContain("text-foreground");
  });

  it("offers WTD and no 2Y", async () => {
    renderPage();
    expect(await screen.findByRole("radio", { name: "WTD" })).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "2Y" })).toBeNull();
  });

  // protects=the rate line is just the rate and its source
  it("writes the exchange rate with no label or date", async () => {
    rowsFor = { fx_rates: [{ date: "2026-11-12", currency: "USD", rate_to_eur: 0.9024 }] };
    renderPage();
    await userEvent.click(await screen.findByRole("radio", { name: "USD" }));
    expect(await screen.findByText("1 USD = 0.9024 EUR · ECB")).toBeInTheDocument();
    expect(screen.queryByText(/Rate:/)).toBeNull();
    rowsFor = {};
  });
});

describe("Net worth page: sync freshness", () => {
  const bank = (snapshot_date: string) => ({
    uid: "u1",
    label: "Bank EUR",
    currency: "EUR",
    bank_name: "Bank",
    consent_valid_until: "2999-01-01",
    snapshot_date,
  });

  // protects=the user sees how fresh the figure is; fails_when=the line is missing or links when healthy
  it("says when the banks last synced, as plain text when all is well", async () => {
    rowsFor = { v_bank_accounts_latest: [bank(new Date().toISOString().slice(0, 10))] };
    renderPage();
    const synced = await screen.findByText("Synced today");
    // It sits on the range pills' row, not under the headline.
    expect(synced.closest("[data-chart-controls]")).not.toBeNull();
    expect(screen.queryByRole("link", { name: /attention/ })).toBeNull();
    rowsFor = {};
  });

  it("links to the health checks when one fails", async () => {
    rowsFor = { v_bank_accounts_latest: [bank("2020-01-01")] };
    renderPage();
    expect(
      await screen.findByRole("link", { name: /1 check needs attention/ }),
    ).toBeInTheDocument();
    rowsFor = {};
  });

  it("says nothing without a connected bank", async () => {
    renderPage();
    await screen.findByRole("radio", { name: "USD" });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(/Synced/)).toBeNull();
  });
});
