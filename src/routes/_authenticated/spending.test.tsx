import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const worthItBounds: Array<[string, string]> = [];
let failTable: string | null = null;
// v_spend_by_category_monthly rows by month ("2026-10-01").
let spendByMonth: Record<string, Array<{ category: string | null; spend_eur: number }>> = {};
// v_transactions_eur rows answered "not worth it".
let regretRows: Array<Record<string, unknown>> = [];
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => {
      const filters: Record<string, string> = {};
      const q: Record<string, unknown> = {};
      for (const m of ["select", "order", "is"]) q[m] = () => q;
      q["eq"] = (c: string, v: string) => (c === "month" && (filters["month"] = v), q);
      q["gte"] = (_c: string, v: string) => ((filters["gte"] = v), q);
      q["lt"] = (_c: string, v: string) => ((filters["lt"] = v), q);
      q["then"] = (resolve: (v: unknown) => void) => {
        if (table === "v_transactions_eur") {
          worthItBounds.push([filters["gte"] ?? "", filters["lt"] ?? ""]);
        }
        resolve(
          table === failTable
            ? { data: null, error: { message: "boom" } }
            : {
                data:
                  table === "v_spend_by_category_monthly"
                    ? (spendByMonth[filters["month"] ?? ""] ?? [])
                    : table === "v_transactions_eur"
                      ? regretRows
                      : [],
                error: null,
              },
        );
      };
      return q;
    },
  },
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({
    children,
    search,
    resetScroll,
  }: {
    children: React.ReactNode;
    search?: Record<string, string>;
    resetScroll?: boolean;
  }) => (
    <a
      href={`/transactions?${new URLSearchParams(search).toString()}`}
      data-reset-scroll={String(resetScroll ?? true)}
    >
      {children}
    </a>
  ),
}));
vi.mock("recharts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("recharts")>()),
  ResponsiveContainer: () => null,
}));

import { Route } from "./spending";

const Page = Route.options.component as () => React.JSX.Element;
let search: { month?: string } = {};
vi.spyOn(Route, "useSearch").mockImplementation((() => search) as never);

describe("Spending page 'not worth it' section", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-10-20T12:00:00"));
  });
  afterEach(() => vi.useRealTimers());

  // protects=October's page never shows August's regretted purchases;
  // fails_when=the not-worth-it query is not limited to the selected month
  it("only asks for the selected month", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Page />
      </QueryClientProvider>,
    );
    await screen.findByText(/No spending recorded/);
    expect(worthItBounds).toContainEqual(["2026-10-01", "2026-11-01"]);
  });

  // Polish 5 #1: Cash flow's Spending row opens this page on its month (?month=YYYY-MM).
  it("opens on the month in the link", async () => {
    search = { month: "2026-08" };
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Page />
      </QueryClientProvider>,
    );
    await screen.findByText(/No spending recorded/);
    expect(worthItBounds).toContainEqual(["2026-08-01", "2026-09-01"]);
    search = {};
  });
});

describe("Spending page when the 'not worth it' answers fail to load", () => {
  // protects=a failed check-in query is reported, not mistaken for "nothing regretted";
  // fails_when=the page ignores the error state of that query
  it("shows an error", async () => {
    failTable = "v_transactions_eur";
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
});

const renderPage = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Page />
    </QueryClientProvider>,
  );

// protects=the page answers "where did it go, and is that normal?" once per number;
// fails_when=the total or shares repeat, rows are dead ends, or the comparison reads the wrong way
describe("Spending page breakdown", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-11-10T12:00:00"));
  });
  afterEach(() => {
    vi.useRealTimers();
    spendByMonth = {};
  });

  const october = [
    { category: "Housing", spend_eur: 800 },
    { category: null, spend_eur: 200 },
  ];

  it("shows each category once, with its share, and no Total row", async () => {
    spendByMonth = { "2026-11-01": october };
    renderPage();
    const links = await screen.findAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual([
      "Housing80.0%€800.00",
      "Uncategorized20.0%€200.00",
    ]);
    expect(screen.queryByText("Total")).toBeNull();
  });

  // iOS view (fonts): the label over the figure is set like Net Worth's "Year to date".
  it("labels the figure in Net Worth's range-line style", async () => {
    spendByMonth = { "2026-11-01": october };
    renderPage();
    expect(await screen.findByText("Spent")).toHaveClass(
      "text-[0.9375rem]",
      "text-muted-foreground",
    );
    expect(screen.getByText("Spent")).not.toHaveClass("font-medium");
  });

  // Whiteboard: the comparison is the headline chip (like Net Worth), not a sentence.
  it("shows a finished month's drop as a green chip, with the month it compares to", async () => {
    spendByMonth = {
      "2026-10-01": [{ category: "Housing", spend_eur: 900 }],
      "2026-09-01": [{ category: "Housing", spend_eur: 1000 }],
    };
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Previous month" }));
    const chip = await screen.findByRole("button", { name: "Show change as amount" });
    expect(chip).toHaveTextContent("▼ 10.00%");
    expect(chip).toHaveClass("text-positive");
    expect(screen.getByText("vs September")).toBeInTheDocument();
    await userEvent.click(chip);
    expect(chip).toHaveTextContent("▼ €100.00");
    expect(screen.queryByText(/less than/)).toBeNull();
  });

  it("shows a finished month that cost more in the alarm colour", async () => {
    spendByMonth = {
      "2026-10-01": [{ category: "Housing", spend_eur: 1100 }],
      "2026-09-01": [{ category: "Housing", spend_eur: 1000 }],
    };
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Previous month" }));
    const chip = await screen.findByRole("button", { name: "Show change as amount" });
    expect(chip).toHaveTextContent("▲ 10.00%");
    expect(chip).toHaveClass("text-negative");
  });

  it("keeps a sub-euro move neutral", async () => {
    spendByMonth = {
      "2026-10-01": [{ category: "Housing", spend_eur: 1000.4 }],
      "2026-09-01": [{ category: "Housing", spend_eur: 1000 }],
    };
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Previous month" }));
    expect(await screen.findByRole("button", { name: "Show change as amount" })).toHaveClass(
      "text-muted-foreground",
    );
  });

  // The running month gets the same chip as any other: no "so far" wording.
  it("compares the running month the same way", async () => {
    spendByMonth = {
      "2026-11-01": october,
      "2026-10-01": [{ category: "Housing", spend_eur: 1500 }],
    };
    renderPage();
    const chip = await screen.findByRole("button", { name: "Show change as amount" });
    expect(chip).toHaveClass("text-positive");
    expect(screen.getByText("vs October")).toBeInTheDocument();
    expect(screen.queryByText(/so far|already|all of/)).toBeNull();
  });

  it("shows no comparison when last month has no spend", async () => {
    spendByMonth = { "2026-11-01": october };
    renderPage();
    await screen.findAllByRole("link");
    expect(screen.queryByText(/October/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Show change/ })).toBeNull();
  });

  it("offers the previous month when this one is empty", async () => {
    renderPage();
    await screen.findByText("No spending recorded for November 2026.");
    await userEvent.click(screen.getByText("Previous month", { selector: "button" }));
    expect(await screen.findByText("No spending recorded for October 2026.")).toBeInTheDocument();
  });
});

// protects=regretted purchases are their own clear card and lead back to each purchase;
// fails_when=the card is missing, rows don't open, or a purchase doesn't link to Activity
describe("Spending page 'not worth it' card", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-11-10T12:00:00"));
    spendByMonth = { "2026-11-01": [{ category: "Shopping", spend_eur: 100 }] };
    regretRows = [
      {
        category: "Shopping",
        personal_signed_amount_eur: -30,
        signed_amount_eur: -30,
        entry_reference: "r1",
        creditor_name: "AMAZON PAYMENTS EUROPE",
        booking_date: "2026-11-03",
      },
      {
        category: "Shopping",
        personal_signed_amount_eur: null,
        signed_amount_eur: -12,
        entry_reference: "r2",
        creditor_name: null,
        booking_date: "2026-11-05",
      },
    ];
  });
  afterEach(() => {
    vi.useRealTimers();
    spendByMonth = {};
    regretRows = [];
  });

  it("titles the card with the total, closed until a category is tapped", async () => {
    renderPage();
    const card = await screen.findByRole("region", { name: "Not worth it" });
    expect(card).toHaveTextContent("Not worth it€42.00");
    const row = screen.getByRole("button", { name: /Shopping/ });
    expect(row).toHaveAttribute("aria-expanded", "false");
    expect(row).toHaveTextContent("2 purchases");
    expect(screen.queryByText("Amazon")).toBeNull();
  });

  it("opens a category to its purchases, newest first, each linking to Activity", async () => {
    renderPage();
    const row = await screen.findByRole("button", { name: /Shopping/ });
    await userEvent.click(row);
    expect(row).toHaveAttribute("aria-expanded", "true");
    const amazon = screen.getByText("Amazon").closest("a")!;
    expect(amazon).toHaveAttribute("href", "/transactions?month=2026-11&highlight=r1");
    expect(amazon).toHaveTextContent("€30.00");
    // Activity scrolls to the row; the router's scroll-to-top must not undo it.
    expect(amazon).toHaveAttribute("data-reset-scroll", "false");
    const items = screen
      .getAllByRole("link")
      .filter((a) => a.getAttribute("href")?.includes("highlight"));
    expect(items.map((a) => a.textContent?.startsWith("Amazon"))).toEqual([false, true]);
    expect(items[0]).toHaveTextContent("—");
  });
});
