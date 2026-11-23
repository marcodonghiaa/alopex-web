import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Charged a week ago, so none of them counts as stopped whatever day the suite runs.
const lastCharged = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
const stream = (over: Record<string, unknown>) => ({
  cadence: "monthly",
  user_cadence: null,
  custom_interval_value: null,
  custom_interval_unit: null,
  charge_count: 3,
  last_charged: lastCharged,
  next_expected: null,
  detected_status: "active",
  user_status: null,
  ...over,
});
const streams = [
  stream({ id: "a", typical_amount_eur: -10 }),
  stream({
    id: "b",
    typical_amount_eur: -5,
    user_status: "confirmed",
    detected_status: "suggested",
  }),
  stream({ id: "c", typical_amount_eur: -100, user_status: "dismissed" }),
  stream({ id: "d", typical_amount_eur: -40, detected_status: "gone" }),
  stream({ id: "e", typical_amount_eur: -7, cadence: null }), // no frequency: not priced
];

let streamRows: Array<Record<string, unknown>> = streams;
let failTable: string | null = null;
let txRows: Array<Record<string, unknown>> = [];

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "order", "eq", "gte", "lt", "lte", "is", "in", "not", "range"])
        q[m] = () => q;
      q["maybeSingle"] = () => q;
      q["then"] = (resolve: (v: unknown) => void) =>
        resolve(
          table === failTable
            ? { data: null, error: { message: "boom" } }
            : {
                // maybeSingle() gives null when the month has no row.
                data:
                  table === "recurring_streams"
                    ? streamRows
                    : table === "v_income_vs_expenses_monthly"
                      ? null
                      : table === "v_transactions_eur"
                        ? txRows
                        : [],
                error: null,
              },
        );
      return q;
    },
  },
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({
    children,
    to,
    search,
    className,
  }: {
    children: React.ReactNode;
    to: string;
    search?: Record<string, string>;
    className?: string;
  }) => (
    <a href={search ? `${to}?${new URLSearchParams(search)}` : to} className={className}>
      {children}
    </a>
  ),
}));
vi.mock("recharts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("recharts")>()),
  ResponsiveContainer: () => null,
}));

import { Route } from "./reports";
import { groupStreams, monthlyTotal, romeToday } from "@/lib/recurring";
import { RECURRING_KEY } from "@/lib/use-recurring-streams";

const Page = Route.options.component as () => React.JSX.Element;

describe("Reports subscriptions total", () => {
  // protects=Reports shows the same monthly subscription figure as the Subscriptions page;
  // fails_when=Reports reads another source, or counts dismissed/gone/unpriced streams
  it("matches the Subscriptions page total", async () => {
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <Page />
      </QueryClientProvider>,
    );
    const card = (await screen.findByText("Subscriptions")).closest("section") as HTMLElement;
    // The Subscriptions page's own computation, on the same rows.
    const pageTotal = monthlyTotal(groupStreams(streams as never, romeToday()).active).sum;
    expect(pageTotal).toBe(15);
    // As the Subscriptions page writes it: an estimate, and the streams it couldn't price.
    expect(await within(card).findByText("~€15.00")).toBeTruthy();
    expect(within(card).getByText("+ 1 without a frequency")).toBeTruthy();
    // Same cache entry as the Subscriptions page and the nav badge.
    expect(client.getQueryData(RECURRING_KEY)).toBe(streams);
  });
});

// protects=Reports never shows a quiet €0 the Subscriptions page wouldn't; fails_when=streams
// without a frequency, or a failed read, read as "€0.00"
describe("Reports subscriptions without a figure", () => {
  afterEach(() => {
    streamRows = streams;
    failTable = null;
  });
  const subscriptionsRow = async () =>
    (await screen.findByText("Subscriptions")).closest("section") as HTMLElement;
  it("shows a dash when no active stream has a frequency", async () => {
    streamRows = [stream({ id: "e", typical_amount_eur: -7, cadence: null })];
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Page />
      </QueryClientProvider>,
    );
    const card = await subscriptionsRow();
    await waitFor(() => expect(card).toHaveTextContent("—"));
    expect(card).not.toHaveTextContent("€0.00");
  });

  it("shows a dash when the subscriptions can't load", async () => {
    failTable = "recurring_streams";
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <Page />
      </QueryClientProvider>,
    );
    const card = await subscriptionsRow();
    await waitFor(() => expect(card).toHaveTextContent("—"));
    expect(card).not.toHaveTextContent("€0.00");
  });

  it("shows €0.00 when nothing is active", async () => {
    streamRows = [];
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Page />
      </QueryClientProvider>,
    );
    const card = await subscriptionsRow();
    await waitFor(() => expect(card).toHaveTextContent("€0.00"));
    expect(card).not.toHaveTextContent("~");
  });
});

describe("Reports when a figure fails to load", () => {
  // protects=a failed query shows an error instead of a quiet zero;
  // fails_when=the page ignores the error state of its queries
  it("tells the user some figures could not load", async () => {
    failTable = "recurring_streams";
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <Page />
      </QueryClientProvider>,
    );
    expect((await screen.findByRole("alert")).textContent).toContain("boom");
    failTable = null;
  });

  it("shows no error when everything loads", async () => {
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <Page />
      </QueryClientProvider>,
    );
    const card = (await screen.findByText("Subscriptions")).closest("section") as HTMLElement;
    await within(card).findByText("~€15.00");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  // Regression: a month with nothing recorded showed "+€0.00", as if income matched spending.
  it("shows a dash, not +€0.00, for a month with no income or expense data", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Page />
      </QueryClientProvider>,
    );
    const card = (await screen.findByText("Income minus spending")).closest("li")!;
    await waitFor(() => expect(card).toHaveTextContent("—"));
    expect(card).not.toHaveTextContent("€0.00");
  });
});

// protects=every Reports row opens the page behind its figure (#7);
// fails_when=a headline or the Subscriptions row stops being a link
// Polish 5 #4 (QA): a rated charge paid entirely for others counted as one of my purchases.
// fails_when=a rated row with a 0 share counts in "N of M rated purchases"
describe("Reports Not worth it tile", () => {
  afterEach(() => {
    txRows = [];
  });
  it("leaves out rated charges paid entirely for others", async () => {
    txRows = [
      { worth_it: "yes", personal_signed_amount_eur: -40, signed_amount_eur: -40 },
      { worth_it: "yes", personal_signed_amount_eur: 0, signed_amount_eur: -30 },
      { worth_it: "no", personal_signed_amount_eur: -45, signed_amount_eur: -45 },
    ];
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Page />
      </QueryClientProvider>,
    );
    expect(await screen.findByText("1 of 2 rated purchases")).toBeInTheDocument();
  });
});

describe("Reports rows lead to their pages", () => {
  it("links the headlines and Subscriptions, with plain sublabels", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Page />
      </QueryClientProvider>,
    );
    const href = (text: string) =>
      screen.getByText(text).closest("a")?.getAttribute("href") ?? null;
    await screen.findByText("Income minus spending");
    expect(href("Net worth")).toBe("/");
    // Polish 1 #7: Cash flow opens on the month Reports is showing.
    expect(href("Income minus spending")).toMatch(/^\/cash-flow\?month=\d{4}-\d{2}$/);
    expect(href("Not worth it")).toBe("/spending");
    expect(href("Subscriptions")).toBe("/subscriptions");
    expect(screen.queryByText("Income vs expenses")).toBeNull();
    expect(await screen.findByText("0 of 0 rated purchases")).toBeTruthy();
  });

  it("names the month as the page heading", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Page />
      </QueryClientProvider>,
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).toMatch(/^Report for \w+ \d{4}$/);
  });
});
