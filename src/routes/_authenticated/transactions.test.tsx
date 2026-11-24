import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let failTable: string | null = null;
// Rows the mocked views return (empty unless a test sets them).
const rows: Record<string, Array<Record<string, unknown>>> = {};
let tableData: Record<string, unknown> = {};
// Every select the page sends, to check which columns each query asks for.
const selects: Array<{ table: string; cols: string }> = [];
const ins: Array<{ table: string; col: string; values: unknown }> = [];
// Every or() and limit() filter, by table, to tell a search across months from a month's list.
const ors: Array<{ table: string; expr: string }> = [];
const limits: Array<{ table: string; n: number }> = [];
const cap = vi.hoisted(() => ({ rows: 1000 }));
let rpcResult: { data: unknown; error: { message: string } | null } = { data: [], error: null };
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: () => Promise.resolve(rpcResult),
    functions: { invoke },
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      for (const m of [
        "select",
        "order",
        "eq",
        "neq",
        "gte",
        "lt",
        "lte",
        "is",
        "in",
        "not",
        "update",
        "maybeSingle",
      ]) {
        q[m] = () => q;
      }
      q["or"] = (expr: string) => {
        ors.push({ table, expr });
        return q;
      };
      q["in"] = (col: string, values: unknown) => {
        ins.push({ table, col, values });
        return q;
      };
      q["limit"] = (n: number) => {
        limits.push({ table, n });
        return q;
      };
      q["select"] = (cols: string) => {
        selects.push({ table, cols });
        return q;
      };
      // range() pages; every answer stops at the server's row cap (PostgREST's default is 1000).
      let from = 0;
      let to = Infinity;
      q["range"] = (a: number, b: number) => {
        from = a;
        to = b;
        return q;
      };
      q["then"] = (resolve: (v: unknown) => void) => {
        const data = table in tableData ? tableData[table] : (rows[table] ?? []);
        return resolve(
          table === failTable
            ? { data: null, error: { message: "boom" } }
            : {
                data: Array.isArray(data)
                  ? data.slice(from, Math.min(to + 1, from + cap.rows))
                  : data,
                error: null,
              },
        );
      };
      return q;
    },
  },
}));

const toastSuccess = vi.fn();
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: vi.fn(),
  }),
}));

let searchParams: Record<string, string> = {};
const navigate = vi.fn();
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useSearch: () => searchParams,
  useNavigate: () => navigate,
}));

import { Route } from "./transactions";
import { formatDayHeading } from "@/lib/transactions";

const Page = Route.options.component as () => React.JSX.Element;
const renderPage = (client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) =>
  render(
    <QueryClientProvider client={client}>
      <Page />
    </QueryClientProvider>,
  );

afterEach(() => {
  toastSuccess.mockReset();
  navigate.mockReset();
  for (const k of Object.keys(rows)) delete rows[k];
});

// Polish pass 4 #1 and #14: Make a rule sits in the transaction's sheet (a phone's sheet covers
// the toast), and isn't offered when a loaded rule already sorts the name.
describe("Make a rule in the transaction sheet", () => {
  const today = new Date().toISOString().slice(0, 10);
  const bankRow = {
    entry_reference: "e1",
    account_uid: "a1",
    booking_date: today,
    category: "Shopping",
    creditor_name: "Poste Italiane",
    currency: "EUR",
    amount: 12.75,
    signed_amount_eur: -12.75,
    credit_debit_indicator: "DBIT",
    flow_type: "spend",
  };
  const openSheet = async (name: RegExp) => {
    const [card] = await screen.findAllByRole("button", { name });
    await userEvent.click(card!);
    return screen.findByRole("dialog");
  };

  it("offers it for a bank transaction", async () => {
    rows["v_transactions_eur"] = [bankRow];
    renderPage();
    const sheet = await openSheet(/Poste Italiane/);
    expect(within(sheet).getByRole("button", { name: "Make a rule" })).toBeTruthy();
  });

  // polish-1 #1 (#164): the sheet has its own history entry; pushing /rules on top of it left a
  // Back press that did nothing. fails_when=the sheet's Make a rule pushes instead of replacing
  it("opens Rules in place of the sheet's history entry", async () => {
    rows["v_transactions_eur"] = [bankRow];
    renderPage();
    const sheet = await openSheet(/Poste Italiane/);
    await userEvent.click(within(sheet).getByRole("button", { name: "Make a rule" }));
    expect(navigate).toHaveBeenLastCalledWith(
      expect.objectContaining({ to: "/rules", replace: true }),
    );
  });

  // pass5 #1: the rules come from the database, not only from a cache the Rules page filled
  it("leaves it out on a cold start when a saved rule already sorts the name", async () => {
    rows["v_transactions_eur"] = [bankRow];
    rows["category_rules"] = [
      {
        id: "r1",
        match_field: "creditor_name",
        match_text: "Poste",
        match_mode: "word",
        set_category: "Shopping",
        priority: 100,
      },
    ];
    renderPage();
    const sheet = await openSheet(/Poste Italiane/);
    await waitFor(() =>
      expect(within(sheet).queryByRole("button", { name: "Make a rule" })).toBeNull(),
    );
  });

  // Rules left-open #3: if the rules can't load, we can't tell the name is covered, so no button
  it("leaves it out when the rules fail to load", async () => {
    rows["v_transactions_eur"] = [bankRow];
    failTable = "category_rules";
    try {
      renderPage();
      const sheet = await openSheet(/Poste Italiane/);
      expect(within(sheet).queryByRole("button", { name: "Make a rule" })).toBeNull();
    } finally {
      failTable = null;
    }
  });

  // pass5 #2: the sheet's overlay covers the toast, so a change made in the sheet gets no toast
  // button (the sheet has its own); an inline change in the table keeps it
  it("puts Make a rule on the toast only when the change wasn't made in the sheet", async () => {
    rows["v_transactions_eur"] = [bankRow];
    renderPage();
    const sheet = await openSheet(/Poste Italiane/);
    await userEvent.click(within(sheet).getByRole("button", { name: /Change category for/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Groceries" }));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(toastSuccess.mock.calls.at(-1)?.[1]).not.toHaveProperty("action");
  });

  it("keeps Make a rule on the toast for an inline change in the table", async () => {
    rows["v_transactions_eur"] = [bankRow];
    renderPage();
    const [inline] = await screen.findAllByRole("button", { name: /Change category for/ });
    await userEvent.click(inline!);
    await userEvent.click(await screen.findByRole("button", { name: "Groceries" }));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(toastSuccess.mock.calls.at(-1)?.[1]).toHaveProperty("action.label", "Make a rule");
  });

  // polish-3 #1 (#164): toasts take clicks over an open sheet; the toast's Make a rule pushed
  // /rules on top of the sheet's history entry, leaving a Back that did nothing.
  // fails_when=the toast's action pushes while a sheet is open, or replaces when none is
  it("the toast's Make a rule replaces only while a sheet is open", async () => {
    rows["v_transactions_eur"] = [bankRow];
    renderPage();
    const [inline] = await screen.findAllByRole("button", { name: /Change category for/ });
    await userEvent.click(inline!);
    await userEvent.click(await screen.findByRole("button", { name: "Groceries" }));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    const action = (toastSuccess.mock.calls.at(-1)?.[1] as { action: { onClick: () => void } })
      .action;
    action.onClick();
    expect(navigate).toHaveBeenLastCalledWith(expect.not.objectContaining({ replace: true }));
    await openSheet(/Poste Italiane/);
    action.onClick();
    expect(navigate).toHaveBeenLastCalledWith(
      expect.objectContaining({ to: "/rules", replace: true }),
    );
  });

  // H142: rules match the bank's name, so a rule made from a renamed row ("Amazon") never matched.
  // fails_when=Make a rule fills in or checks the shown name instead of bank_creditor_name
  it("fills in the bank's name, not the name the row was renamed to", async () => {
    rows["v_transactions_eur"] = [
      { ...bankRow, creditor_name: "Amazon", bank_creditor_name: "AMZN Mktp DE*123" },
    ];
    renderPage();
    const sheet = await openSheet(/Amazon/);
    await userEvent.click(within(sheet).getByRole("button", { name: "Make a rule" }));
    expect(navigate).toHaveBeenLastCalledWith(
      expect.objectContaining({ search: { text: "AMZN Mktp DE*123", category: "Shopping" } }),
    );
  });

  it("leaves it out when a rule already sorts the bank's name of a renamed row", async () => {
    rows["v_transactions_eur"] = [
      { ...bankRow, creditor_name: "Amazon", bank_creditor_name: "AMZN Mktp DE*123" },
    ];
    rows["category_rules"] = [
      {
        id: "r1",
        match_field: "creditor_name",
        match_text: "AMZN",
        match_mode: "word",
        set_category: "Shopping",
        priority: 100,
      },
    ];
    renderPage();
    const sheet = await openSheet(/Amazon/);
    await waitFor(() =>
      expect(within(sheet).queryByRole("button", { name: "Make a rule" })).toBeNull(),
    );
  });

  // Batch H review: with no bank name (a manual or broker row) a rule could never match it.
  it("leaves it out when the bank sent no name", async () => {
    rows["v_transactions_eur"] = [
      { ...bankRow, creditor_name: "Broker buy", bank_creditor_name: null },
    ];
    renderPage();
    const sheet = await openSheet(/Broker buy/);
    await waitFor(() =>
      expect(within(sheet).queryByRole("button", { name: "Make a rule" })).toBeNull(),
    );
  });

  it("leaves it out for a Splitwise share", async () => {
    rows["v_splitwise_eur"] = [
      {
        id: "s1",
        booking_date: today,
        category: "Dine Out",
        description: "Dinner",
        group_name: "Trip",
        currency: "EUR",
        amount: 12.5,
        amount_eur: 12.5,
      },
    ];
    renderPage();
    const sheet = await openSheet(/Dinner/);
    expect(within(sheet).queryByRole("button", { name: "Make a rule" })).toBeNull();
  });
});

describe("Transactions page when an extra source fails to load", () => {
  // protects=a failed Splitwise or account query is reported, not shown as missing rows or labels;
  // fails_when=the page ignores the error state of its shares, accounts or transfers queries
  it.each(["v_splitwise_eur", "accounts"])("shows an error when %s fails", async (table) => {
    failTable = table;
    renderPage();
    expect((await screen.findByRole("alert")).textContent).toContain("boom");
    failTable = null;
  });

  it("shows no error when everything loads", async () => {
    renderPage();
    await screen.findAllByText(/No transactions for/);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

const thisMonth = (day: number) => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
};
const row = (ref: string, over: Record<string, unknown> = {}) => ({
  entry_reference: ref,
  account_uid: "a1",
  booking_date: thisMonth(1),
  category: "Groceries",
  transaction_type: "One-time",
  creditor_name: `Shop ${ref}`,
  currency: "EUR",
  amount: 10,
  signed_amount_eur: -10,
  credit_debit_indicator: "DBIT",
  created_at: null,
  worth_it: null,
  personal_amount: null,
  owed_by: null,
  flow_type: "spend",
  refund_of: null,
  ...over,
});

// protects=the phone page answers "what happened" in the first viewport: month in/out line, day
// groups, and empty states that say why and offer the way out;
// fails_when=the in/out line is missing or shown without data, or an empty list is a dead end
describe("Activity page", () => {
  afterEach(() => {
    tableData = {};
  });

  // H373: a month past the server's row cap lost its oldest rows without a word.
  it("lists every row of a month past the server's row cap", async () => {
    cap.rows = 2;
    tableData = {
      v_transactions_eur: [
        row("r1", { creditor_name: "Corner shop" }),
        row("r2", { creditor_name: "Bakery" }),
        row("r3", { creditor_name: "Oldest Cafe" }),
      ],
    };
    try {
      renderPage();
      expect((await screen.findAllByText("Oldest Cafe")).length).toBeGreaterThan(0);
    } finally {
      cap.rows = 1000;
    }
  });

  it("shows the month's money in and out under the month", async () => {
    tableData = { v_income_vs_expenses_monthly: { income_eur: 2450, expenses_eur: 1382.34 } };
    renderPage();
    expect(await screen.findByText("€2,450.00")).toBeInTheDocument();
    expect(screen.getByText("€1,382.34")).toBeInTheDocument();
  });

  it("leaves the in/out line empty when the month has no figures", async () => {
    tableData = { v_income_vs_expenses_monthly: null };
    renderPage();
    await screen.findAllByText(/No transactions for/);
    expect(screen.queryByText(/^In /)).toBeNull();
  });

  it("titles the phone page Activity, like its tab, and the desktop page Transactions", () => {
    renderPage();
    const h1 = screen.getByRole("heading", { level: 1 });
    expect(h1).toHaveTextContent("Activity");
    expect(h1).toHaveTextContent("Transactions");
  });

  it("offers the previous month when this one is empty", async () => {
    renderPage();
    await screen.findAllByText(/No transactions for/);
    const label = () => document.querySelector("[aria-live]")?.textContent;
    const before = label();
    // The empty state's own button, not the switcher's icon button with the same label.
    await userEvent.click(screen.getAllByText("Previous month", { selector: "button" })[0]!);
    expect(label()).not.toBe(before);
  });

  it("groups the phone list by day", async () => {
    tableData = {
      v_transactions_eur: [row("1", { booking_date: thisMonth(2) }), row("2"), row("3")],
    };
    renderPage();
    const sections = await screen.findAllByRole("heading", { level: 2 });
    expect(sections.map((h) => h.textContent)).toHaveLength(2);
  });

  // protects=desktop rows sit under day headings like the phone list (Marco 2026-11-23);
  // fails_when=the table is flat again or keeps a Date column the headings make redundant
  it("groups the desktop table by day, with no Date column", async () => {
    tableData = {
      v_transactions_eur: [row("1", { booking_date: thisMonth(2) }), row("2"), row("3")],
    };
    renderPage();
    await screen.findAllByText("Shop 1");
    const table = screen.getByRole("table");
    const days = within(table)
      .getAllByRole("columnheader")
      .filter((th) => th.getAttribute("scope") === "colgroup");
    expect(days).toHaveLength(2);
    expect(within(table).queryByRole("columnheader", { name: "Date" })).toBeNull();
    // Day 2 heading comes first, then its one row, then day 1's heading and its two rows.
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((r) => r.textContent?.match(/Shop \d/)?.[0] ?? "day")).toEqual([
      "day",
      "Shop 1",
      "day",
      "Shop 2",
      "Shop 3",
    ]);
  });

  it("says when a search finds nothing, and clears it", async () => {
    tableData = { v_transactions_eur: [row("1")] };
    renderPage();
    await screen.findAllByText("Shop 1");
    await userEvent.type(screen.getByLabelText("Search by merchant or note"), "zzz");
    expect(screen.getAllByText("Nothing matches “zzz”.").length).toBeGreaterThan(0);
    await userEvent.click(screen.getAllByRole("button", { name: "Clear search" })[0]!);
    expect(screen.getAllByText("Shop 1").length).toBeGreaterThan(0);
  });

  // protects=search looks through every month (Marco 2026-11-24); fails_when=a search only
  // filters the month on screen, or the month arrows stay up while results span every month
  it("searches every month on the server, then goes back to the month", async () => {
    ors.length = 0;
    limits.length = 0;
    tableData = {
      v_income_vs_expenses_monthly: { income_eur: 999, expenses_eur: 888 },
      v_transactions_eur: [
        row("1", { creditor_name: "Rent Co" }),
        row("2", {
          creditor_name: "Rent Co",
          booking_date: "2024-03-01",
          amount: 40,
          signed_amount_eur: -40,
        }),
      ],
    };
    renderPage();
    await screen.findAllByText("€999.00");
    await userEvent.type(screen.getByLabelText("Search by merchant or note"), "rent");
    expect(await screen.findByText("All months")).toBeInTheDocument();
    // The search query fires after typing settles, so on a slow runner it can land after the label.
    await waitFor(() => {
      expect(ors).toContainEqual({
        table: "v_transactions_eur",
        expr: "creditor_name.ilike.*rent*,note.ilike.*rent*",
      });
      expect(ors).toContainEqual({ table: "v_splitwise_eur", expr: "description.ilike.*rent*" });
      expect(limits).toContainEqual({ table: "v_transactions_eur", n: 500 });
    });
    // In/Out add up what was found, not the month's figures.
    expect(await screen.findByText("€50.00")).toBeInTheDocument();
    expect(screen.queryByText("€888.00")).toBeNull();
    expect(screen.queryByRole("button", { name: "Previous month" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /^Back to / }));
    expect(screen.queryByText("All months")).toBeNull();
    expect(screen.getByRole("button", { name: "Previous month" })).toBeInTheDocument();
    expect(await screen.findByText("€888.00")).toBeInTheDocument();
  });

  it("says when no month matches a search", async () => {
    tableData = { v_transactions_eur: [] };
    renderPage();
    await screen.findAllByText(/No transactions for/);
    await userEvent.type(screen.getByLabelText("Search by merchant or note"), "zzz");
    expect(
      (await screen.findAllByText("Nothing matches “zzz” in any month.")).length,
    ).toBeGreaterThan(0);
    await userEvent.click(screen.getAllByRole("button", { name: "Clear search" })[0]!);
    expect((await screen.findAllByText(/No transactions for/)).length).toBeGreaterThan(0);
  });

  it("says when a search shows only the newest matches", async () => {
    tableData = {
      v_transactions_eur: Array.from({ length: 500 }, (_, i) =>
        row(String(i), { creditor_name: "Bar" }),
      ),
    };
    renderPage();
    await userEvent.type(screen.getByLabelText("Search by merchant or note"), "bar");
    expect(
      await screen.findByText(/Newest 500 matches/, {}, { timeout: 15_000 }),
    ).toBeInTheDocument();
  }, 30_000);

  it("keeps a day picked while searching only if it's in the month it goes back to", async () => {
    tableData = { v_transactions_eur: [row("1", { booking_date: "2024-03-01" })] };
    renderPage();
    await userEvent.type(screen.getByLabelText("Search by merchant or note"), "shop");
    await screen.findByText("All months");
    const dayInput = screen.getByLabelText("Filter by day");
    expect(dayInput).not.toHaveAttribute("min");
    fireEvent.change(dayInput, { target: { value: "2024-03-01" } });
    await userEvent.click(screen.getByRole("button", { name: /^Back to / }));
    expect(screen.getByLabelText("Filter by day")).toHaveValue("");
    expect(screen.getByLabelText("Filter by day")).toHaveAttribute("min");
  });

  it("says when filters hide everything, and clears them", async () => {
    tableData = { v_transactions_eur: [row("1"), row("2", { category: "Dine Out" })] };
    renderPage();
    await screen.findAllByText("Shop 1");
    await userEvent.selectOptions(screen.getByLabelText("Filter by category"), "Dine Out");
    await userEvent.type(screen.getByLabelText("Search by merchant or note"), "Shop 1");
    expect(screen.getAllByText("No transactions match your filters.").length).toBeGreaterThan(0);
    await userEvent.click(screen.getAllByRole("button", { name: "Clear filters" })[0]!);
    expect(screen.getAllByText("Shop 2").length).toBeGreaterThan(0);
  });

  it("shows the account badge only when the month spans more than one account", async () => {
    tableData = { v_transactions_eur: [row("1"), row("2", { account_uid: "a2" })] };
    const { unmount } = renderPage();
    await screen.findAllByText("Shop 1");
    expect(screen.getAllByTitle("Unknown account")).toHaveLength(2);
    unmount();
    tableData = { v_transactions_eur: [row("1"), row("2")] };
    renderPage();
    await screen.findAllByText("Shop 1");
    expect(screen.queryByTitle("Unknown account")).toBeNull();
  });
});

// protects=a Spending category row opens Activity on that category and month;
// fails_when=the route ignores ?category / ?month, or the month param is applied off by one
describe("Activity deep link", () => {
  afterEach(() => {
    tableData = {};
    searchParams = {};
  });

  it("opens on the linked month and category", async () => {
    tableData = { v_transactions_eur: [row("1"), row("2", { category: "Dine Out" })] };
    searchParams = { category: "Dine Out", month: "2026-03" };
    renderPage();
    expect(document.querySelector("[aria-live]")?.textContent).toBe("March 2026");
    expect((await screen.findAllByText("Shop 2")).length).toBeGreaterThan(0);
    expect(screen.queryByText("Shop 1")).toBeNull();
  });

  it("opens on this month with every category without params", async () => {
    tableData = { v_transactions_eur: [row("1"), row("2", { category: "Dine Out" })] };
    renderPage();
    expect((await screen.findAllByText("Shop 1")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Shop 2").length).toBeGreaterThan(0);
  });

  it("validates its search params", () => {
    const validate = Route.options.validateSearch as (s: Record<string, unknown>) => unknown;
    expect(validate({ category: "Dine Out", month: "2026-03", junk: 1 })).toEqual({
      category: "Dine Out",
      month: "2026-03",
    });
    expect(validate({ category: 5, month: "2026-13" })).toEqual({});
  });
});

// protects=the tag filter keeps only rows with that tag; fails_when=the filter ignores tags
describe("Transactions page tag filter", () => {
  // protects=only the list that shows notes and tags fetches them;
  // fails_when=the transfers query also selects note and tags
  it("fetches note and tags for the month list only", async () => {
    selects.length = 0;
    renderPage();
    await screen.findAllByText(/No transactions for/);
    const views = selects.filter((s) => s.table === "v_transactions_eur").map((s) => s.cols);
    expect(views.length).toBeGreaterThan(1);
    expect(views.filter((c) => c.includes("note,tags"))).toHaveLength(1);
  });

  // protects=the month list shows spending and refunds, the transfers list only transfers
  it("filters the two lists by flow type", async () => {
    ins.length = 0;
    renderPage();
    await screen.findAllByText(/No transactions for/);
    const flows = ins
      .filter((i) => i.table === "v_transactions_eur" && i.col === "flow_type")
      .map((i) => i.values);
    expect(flows).toEqual(expect.arrayContaining([["spend", "refunded"], ["transfer"]]));
  });

  // protects=a failing tag-suggestions call is reported in the console, not hidden;
  // fails_when=fetchTagSuggestions swallows the error
  it("logs a failed suggestions call and still shows the page", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    rpcResult = { data: null, error: { message: "denied" } };
    renderPage();
    await screen.findAllByText(/No transactions for/);
    await waitFor(() =>
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining("tag suggestions"),
        expect.objectContaining({ message: "denied" }),
      ),
    );
    rpcResult = { data: [], error: null };
    log.mockRestore();
  });

  it("filters the month by tag", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const base = {
      account_uid: "a",
      booking_date: today,
      category: "Travel",
      currency: "EUR",
      amount: 10,
      signed_amount_eur: -10,
      credit_debit_indicator: "DBIT",
      flow_type: "spend",
    };
    rows["v_transactions_eur"] = [
      { ...base, entry_reference: "1", creditor_name: "Hotel Alpha", tags: ["trip"] },
      { ...base, entry_reference: "2", creditor_name: "Cafe Beta", tags: [] },
    ];
    renderPage();
    expect((await screen.findAllByText("Cafe Beta")).length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText("Filter by tag"), { target: { value: "trip" } });
    expect(screen.queryAllByText("Cafe Beta")).toHaveLength(0);
    expect(screen.getAllByText("Hotel Alpha").length).toBeGreaterThan(0);
  });

  // polish-3 #8: fails_when=the tag filter carries over to another month
  it("turns the tag filter off when the month changes", async () => {
    const today = new Date().toISOString().slice(0, 10);
    rows["v_transactions_eur"] = [
      {
        account_uid: "a",
        booking_date: today,
        category: "Travel",
        currency: "EUR",
        amount: 10,
        signed_amount_eur: -10,
        credit_debit_indicator: "DBIT",
        flow_type: "spend",
        entry_reference: "1",
        creditor_name: "Hotel Alpha",
        tags: ["trip"],
      },
    ];
    renderPage();
    fireEvent.change(await screen.findByLabelText("Filter by tag"), { target: { value: "trip" } });
    await userEvent.click(screen.getAllByRole("button", { name: "Previous month" })[0]!);
    expect(await screen.findByLabelText("Filter by tag")).toHaveValue("");
  });

  // fails_when=removing the last use of the selected tag leaves the filter on and the list empty
  it("turns the tag filter off when its tag is no longer used", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const base = {
      account_uid: "a",
      booking_date: today,
      category: "Travel",
      currency: "EUR",
      amount: 10,
      signed_amount_eur: -10,
      credit_debit_indicator: "DBIT",
      flow_type: "spend",
    };
    rows["v_transactions_eur"] = [
      { ...base, entry_reference: "1", creditor_name: "Hotel Alpha", tags: ["trip"] },
      { ...base, entry_reference: "2", creditor_name: "Cafe Beta", tags: ["work"] },
    ];
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderPage(client);
    fireEvent.change(await screen.findByLabelText("Filter by tag"), { target: { value: "trip" } });
    expect(screen.queryAllByText("Cafe Beta")).toHaveLength(0);
    rows["v_transactions_eur"] = [
      { ...base, entry_reference: "1", creditor_name: "Hotel Alpha", tags: [] },
      { ...base, entry_reference: "2", creditor_name: "Cafe Beta", tags: ["work"] },
    ];
    await act(() => client.invalidateQueries({ queryKey: ["transactions"] }));
    expect((await screen.findAllByText("Cafe Beta")).length).toBeGreaterThan(0);
    expect(screen.getByLabelText("Filter by tag")).toHaveValue("");
  });

  // polish-5 #1: fails_when=the selected tag's spelling changes under it (Trip/trip) and the select
  // shows "All tags" while the list stays filtered
  it("keeps the tag filter showing its tag when the tag's spelling changes", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const base = {
      account_uid: "a",
      booking_date: today,
      category: "Travel",
      currency: "EUR",
      amount: 10,
      signed_amount_eur: -10,
      credit_debit_indicator: "DBIT",
      flow_type: "spend",
    };
    rows["v_transactions_eur"] = [
      { ...base, entry_reference: "1", creditor_name: "Hotel Alpha", tags: ["Trip"] },
      { ...base, entry_reference: "2", creditor_name: "Cafe Beta", tags: ["trip"] },
      { ...base, entry_reference: "3", creditor_name: "Bar Gamma", tags: ["trip"] },
      { ...base, entry_reference: "4", creditor_name: "Shop Delta", tags: [] },
    ];
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderPage(client);
    const select = await screen.findByLabelText("Filter by tag");
    fireEvent.change(select, { target: { value: "trip" } });
    rows["v_transactions_eur"] = [
      { ...base, entry_reference: "1", creditor_name: "Hotel Alpha", tags: ["Trip"] },
      { ...base, entry_reference: "2", creditor_name: "Cafe Beta", tags: [] },
      { ...base, entry_reference: "3", creditor_name: "Bar Gamma", tags: [] },
      { ...base, entry_reference: "4", creditor_name: "Shop Delta", tags: [] },
    ];
    await act(() => client.invalidateQueries({ queryKey: ["transactions"] }));
    await waitFor(() => expect(screen.queryAllByText("Cafe Beta")).toHaveLength(0));
    expect(screen.getByLabelText("Filter by tag")).toHaveValue("Trip");
    expect(screen.queryAllByText("Shop Delta")).toHaveLength(0);
  });

  // polish-4 #6: fails_when=a long tag stretches the desktop tag select and squeezes Search
  it("caps the desktop tag select's width", async () => {
    rows["v_transactions_eur"] = [
      {
        account_uid: "a",
        booking_date: new Date().toISOString().slice(0, 10),
        category: "Travel",
        currency: "EUR",
        amount: 10,
        signed_amount_eur: -10,
        credit_debit_indicator: "DBIT",
        flow_type: "spend",
        entry_reference: "1",
        creditor_name: "Hotel Alpha",
        tags: ["w".repeat(40)],
      },
    ];
    renderPage();
    expect(await screen.findByLabelText("Filter by tag")).toHaveClass("max-w-48", "truncate");
  });

  // polish-4 #2: fails_when=an edit that makes the row stop matching the filter closes its sheet
  it("keeps an open row's sheet while an edit takes it out of the filter", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const base = {
      account_uid: "a",
      booking_date: today,
      category: "Travel",
      currency: "EUR",
      amount: 10,
      signed_amount_eur: -10,
      credit_debit_indicator: "DBIT",
      flow_type: "spend",
    };
    rows["v_transactions_eur"] = [
      { ...base, entry_reference: "1", creditor_name: "Hotel Alpha", tags: ["trip"] },
      { ...base, entry_reference: "2", creditor_name: "Cafe Beta", tags: ["trip"] },
    ];
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderPage(client);
    fireEvent.change(await screen.findByLabelText("Filter by tag"), { target: { value: "trip" } });
    const [edit] = await screen.findAllByRole("button", { name: "Edit Hotel Alpha" });
    await userEvent.click(edit!);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    rows["v_transactions_eur"] = [
      { ...base, entry_reference: "1", creditor_name: "Hotel Alpha", tags: [] },
      { ...base, entry_reference: "2", creditor_name: "Cafe Beta", tags: ["trip"] },
    ];
    await act(() => client.invalidateQueries({ queryKey: ["transactions"] }));
    // The sheet's exit runs after the list re-renders, so give it a moment before checking.
    await act(() => new Promise((r) => setTimeout(r, 100)));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryAllByText("Hotel Alpha")).toHaveLength(0));
  });
});

// protects=charges paid entirely for others sit in a collapsed "Paid for others" section, still
// found by search; fails_when=they stay in the main list, vanish, or search can't find them
describe("Paid for others", () => {
  afterEach(() => {
    tableData = {};
  });

  it("keeps them out of the main list until shown", async () => {
    tableData = {
      v_transactions_eur: [row("1"), row("2", { personal_amount: 0, amount: 49.02 })],
    };
    renderPage();
    await screen.findAllByText("Shop 1");
    expect(screen.queryByText("Shop 2")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Show 1 charge paid for others" }));
    expect(screen.getAllByRole("heading", { name: "Paid for others" }).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Shop 2").length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole("button", { name: "Hide 1 charge paid for others" }));
    expect(screen.queryByText("Shop 2")).toBeNull();
  });

  // Polish 4 #6: "Show 1 paid for others" had no noun. fails_when=the label drops "charge(s)"
  it("names the rows it shows: charge, or charges", async () => {
    tableData = {
      v_transactions_eur: [
        row("1"),
        row("2", { personal_amount: 0 }),
        row("3", { personal_amount: 0 }),
      ],
    };
    renderPage();
    expect(
      await screen.findByRole("button", { name: "Show 2 charges paid for others" }),
    ).toBeInTheDocument();
  });

  // Polish 4 #4: both toggles under the list were 36px, under the 44px tap minimum.
  // fails_when=either toggle loses its 44px minimum height
  it("gives the toggles under the list a 44px tap height", async () => {
    tableData = { v_transactions_eur: [row("1"), row("2", { personal_amount: 0 })] };
    renderPage();
    expect(await screen.findByRole("button", { name: /^Show 1 .*paid for others$/ })).toHaveClass(
      "min-h-11",
    );
    expect(await screen.findByRole("button", { name: /^Show \d+ transfers?$/ })).toHaveClass(
      "min-h-11",
    );
  });

  // Polish 4 #3: on desktop the rows open above the toggle, so the next Tab went past them.
  // fails_when=focus stays on the toggle after "Show"
  it("moves focus to the section's heading when shown", async () => {
    tableData = { v_transactions_eur: [row("1"), row("2", { personal_amount: 0 })] };
    renderPage();
    await userEvent.click(
      await screen.findByRole("button", { name: "Show 1 charge paid for others" }),
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getAllByRole("heading", { name: "Paid for others" })[0],
      ),
    );
  });

  // Polish 1 #3: a forced-open section offered a "Hide" button that did nothing.
  it("offers no hide button while a search or an empty list keeps the section open", async () => {
    tableData = {
      v_transactions_eur: [row("1"), row("2", { personal_amount: 0, creditor_name: "Fresh" })],
    };
    renderPage();
    await screen.findAllByText("Shop 1");
    await userEvent.type(screen.getByLabelText("Search by merchant or note"), "Fresh");
    expect(screen.getAllByRole("heading", { name: "Paid for others" }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /paid for others/ })).toBeNull();
  });

  it("opens the section when every row this month was paid for others", async () => {
    tableData = { v_transactions_eur: [row("2", { personal_amount: 0 })] };
    renderPage();
    expect(
      (await screen.findAllByRole("heading", { name: "Paid for others" })).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /paid for others/ })).toBeNull();
  });

  // Polish 1 #4: phone cards carry no date, so the section groups them by day like the main list.
  // Polish 3 #3: the region is named by its heading alone.
  it("groups the phone section by day", async () => {
    tableData = {
      v_transactions_eur: [row("1"), row("2", { personal_amount: 0, booking_date: thisMonth(3) })],
    };
    renderPage();
    await screen.findAllByText("Shop 1");
    await userEvent.click(screen.getByRole("button", { name: "Show 1 charge paid for others" }));
    const phone = screen.getByRole("region", { name: "Paid for others" });
    expect(within(phone).getByText(formatDayHeading(thisMonth(3)))).toBeInTheDocument();
  });

  // Polish 1 #8: the phone filter's count matches the rows you will see.
  it("leaves collapsed rows out of the filter sheet's count", async () => {
    tableData = {
      v_transactions_eur: [row("1"), row("2"), row("3", { personal_amount: 0 })],
    };
    renderPage();
    await screen.findAllByText("Shop 1");
    await userEvent.click(screen.getByRole("button", { name: "Filter" }));
    expect(await screen.findByText("Show 2 transactions")).toBeInTheDocument();
  });

  it("shows them when a search matches", async () => {
    tableData = {
      v_transactions_eur: [row("1"), row("2", { personal_amount: 0, creditor_name: "Fresh" })],
    };
    renderPage();
    await screen.findAllByText("Shop 1");
    await userEvent.type(screen.getByLabelText("Search by merchant or note"), "Fresh");
    expect(screen.getAllByRole("heading", { name: "Paid for others" }).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Fresh").length).toBeGreaterThan(0);
  });

  // Polish 1 #1: opening a row in the section moved it to the main list, closing its sheet.
  it("opens a row in the section and keeps its sheet open", async () => {
    tableData = {
      v_transactions_eur: [row("1"), row("2", { personal_amount: 0 })],
    };
    renderPage();
    await screen.findAllByText("Shop 1");
    await userEvent.click(screen.getByRole("button", { name: "Show 1 charge paid for others" }));
    const [edit] = await screen.findAllByRole("button", { name: "Edit Shop 2" });
    await userEvent.click(edit!);
    await act(() => new Promise((r) => setTimeout(r, 100)));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  // Polish 1 #1, opposite state: a split set to 0 mid-edit stays put until the sheet closes.
  it("keeps a row in the main list while its sheet is open, then moves it", async () => {
    tableData = { v_transactions_eur: [row("1"), row("2")] };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderPage(client);
    const [edit] = await screen.findAllByRole("button", { name: "Edit Shop 2" });
    await userEvent.click(edit!);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    tableData = { v_transactions_eur: [row("1"), row("2", { personal_amount: 0 })] };
    await act(() => client.invalidateQueries({ queryKey: ["transactions"] }));
    await act(() => new Promise((r) => setTimeout(r, 100)));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /paid for others/ })).toBeNull();
    await userEvent.keyboard("{Escape}");
    expect(
      await screen.findByRole("button", { name: "Show 1 charge paid for others" }),
    ).toBeInTheDocument();
  });

  // Polish 3 #2: a failed reload hides the list, so it must not offer the section either.
  it("offers no paid-for-others toggle after the month fails to reload", async () => {
    tableData = { v_transactions_eur: [row("1"), row("2", { personal_amount: 0 })] };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderPage(client);
    expect(
      await screen.findByRole("button", { name: "Show 1 charge paid for others" }),
    ).toBeInTheDocument();
    failTable = "v_transactions_eur";
    try {
      await act(() => client.invalidateQueries({ queryKey: ["transactions"] }));
      await waitFor(() =>
        expect(screen.queryByRole("button", { name: /paid for others/ })).toBeNull(),
      );
    } finally {
      failTable = null;
    }
  });

  // Polish 3 #1: the sheet's trigger is gone when its row moves list, so focus must land
  // somewhere useful, not on the page body.
  it("moves focus to the section toggle when the edited row moves into the collapsed section", async () => {
    tableData = { v_transactions_eur: [row("1"), row("2")] };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderPage(client);
    const [edit] = await screen.findAllByRole("button", { name: "Edit Shop 2" });
    await userEvent.click(edit!);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    tableData = { v_transactions_eur: [row("1"), row("2", { personal_amount: 0 })] };
    await act(() => client.invalidateQueries({ queryKey: ["transactions"] }));
    await userEvent.keyboard("{Escape}");
    const toggle = await screen.findByRole("button", { name: "Show 1 charge paid for others" });
    await waitFor(() => expect(document.activeElement).toBe(toggle));
  });

  it("moves focus to the row's new place when it leaves the section", async () => {
    tableData = { v_transactions_eur: [row("1"), row("2", { personal_amount: 0 })] };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderPage(client);
    await userEvent.click(
      await screen.findByRole("button", { name: "Show 1 charge paid for others" }),
    );
    const [edit] = await screen.findAllByRole("button", { name: "Edit Shop 2" });
    await userEvent.click(edit!);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    tableData = { v_transactions_eur: [row("1"), row("2", { personal_amount: 4 })] };
    await act(() => client.invalidateQueries({ queryKey: ["transactions"] }));
    await userEvent.keyboard("{Escape}");
    await waitFor(() =>
      expect(
        document.activeElement?.closest("[data-entry-ref]")?.getAttribute("data-entry-ref"),
      ).toBe("2"),
    );
  });

  // Polish 5 #9: jsdom renders nothing, so the tests above only ever take the fallbacks
  // (first copy). These make one copy "on screen" to cover the pick itself.
  // fails_when=focus goes to the hidden copy of the moved row, or the hidden heading
  describe("with only one copy on screen", () => {
    let onScreen: "phone" | "desktop" = "phone";
    let rects: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      rects = vi.spyOn(Element.prototype, "getClientRects").mockImplementation(function (
        this: Element,
      ) {
        const phone = this.closest("li") != null || this.id === "paid-for-others-phone";
        return (phone === (onScreen === "phone") ? [{}] : []) as unknown as DOMRectList;
      });
    });
    afterEach(() => {
      rects.mockRestore();
      onScreen = "phone";
    });

    // The phone card comes first in the page, so the desktop copy is the one to pick.
    it("focuses the moved row's desktop copy", async () => {
      onScreen = "desktop";
      tableData = { v_transactions_eur: [row("1"), row("2", { personal_amount: 0 })] };
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      renderPage(client);
      await userEvent.click(
        await screen.findByRole("button", { name: "Show 1 charge paid for others" }),
      );
      const [edit] = await screen.findAllByRole("button", { name: "Edit Shop 2" });
      await userEvent.click(edit!);
      expect(await screen.findByRole("dialog")).toBeInTheDocument();
      tableData = { v_transactions_eur: [row("1"), row("2", { personal_amount: 4 })] };
      await act(() => client.invalidateQueries({ queryKey: ["transactions"] }));
      await userEvent.keyboard("{Escape}");
      await waitFor(() =>
        expect(document.activeElement?.closest("[data-entry-ref]")?.tagName).toBe("TR"),
      );
    });

    it("focuses the phone section's heading when shown", async () => {
      tableData = { v_transactions_eur: [row("1"), row("2", { personal_amount: 0 })] };
      renderPage();
      await userEvent.click(
        await screen.findByRole("button", { name: "Show 1 charge paid for others" }),
      );
      await waitFor(() => expect(document.activeElement?.id).toBe("paid-for-others-phone"));
    });
  });

  // Polish 3 #5: on desktop the section lives in the same table, under its own heading row.
  it("adds a heading row and the rows to the desktop table when shown", async () => {
    tableData = { v_transactions_eur: [row("1"), row("2", { personal_amount: 0 })] };
    renderPage();
    await screen.findAllByText("Shop 1");
    const table = screen.getByRole("table");
    expect(within(table).queryByText("Shop 2")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Show 1 charge paid for others" }));
    expect(within(table).getByRole("heading", { name: "Paid for others" })).toBeInTheDocument();
    expect(within(table).getByText("Shop 2")).toBeInTheDocument();
  });

  // Polish 4 #1: a Worth it? link to a row later paid entirely for others asked "€0.00" and left
  // the row hidden in the collapsed section.
  describe("a Worth it? link", () => {
    const eligible = { category: "Dine Out", amount: 40, created_at: "2026-01-01T00:00:00Z" };
    afterEach(() => window.history.replaceState(null, "", "/"));

    it("to a row paid for others asks nothing and opens the section on it", async () => {
      Element.prototype.scrollIntoView = vi.fn();
      window.history.replaceState(null, "", "/transactions?highlight=2");
      tableData = {
        v_transactions_eur: [row("1"), row("2", { ...eligible, personal_amount: 0 })],
      };
      renderPage();
      expect(
        await screen.findByRole("button", { name: /Hide 1 (charge )?paid for others/ }),
      ).toBeInTheDocument();
      expect(within(screen.getByRole("table")).getByText("Shop 2")).toBeInTheDocument();
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    // Polish 5 #1: querySelector took the first copy of the row, the hidden desktop one on phone.
    // fails_when=the link scrolls to a copy of the row that isn't rendered
    it("scrolls to the copy of the row that is on screen", async () => {
      const scroll = vi.fn();
      Element.prototype.scrollIntoView = scroll;
      const rects = vi.spyOn(Element.prototype, "getClientRects").mockImplementation(function (
        this: Element,
      ) {
        return (this.tagName === "LI" ? [{}] : []) as unknown as DOMRectList;
      });
      window.history.replaceState(null, "", "/transactions?highlight=2");
      tableData = { v_transactions_eur: [row("1"), row("2", { ...eligible, personal_amount: 0 })] };
      renderPage();
      await waitFor(() => expect(scroll).toHaveBeenCalled());
      expect(scroll.mock.contexts.map((el) => (el as Element).tagName)).toEqual(["LI"]);
      rects.mockRestore();
    });

    // Polish 5 re-audit: the router's scroll restoration jumps to the top just after render,
    // cancelling a scroll made right away. fails_when=the link scrolls as soon as the row renders
    it("scrolls only after the page has settled, not as the row renders", async () => {
      const scroll = vi.fn();
      Element.prototype.scrollIntoView = scroll;
      const rects = vi
        .spyOn(Element.prototype, "getClientRects")
        .mockImplementation(() => [{}] as unknown as DOMRectList);
      window.history.replaceState(null, "", "/transactions?highlight=2");
      tableData = { v_transactions_eur: [row("1"), row("2", { personal_amount: 0 })] };
      renderPage();
      await screen.findAllByText("Shop 2");
      expect(scroll).not.toHaveBeenCalled();
      await waitFor(() => expect(scroll).toHaveBeenCalledTimes(1));
      rects.mockRestore();
    });

    it("to a split row asks about my share", async () => {
      Element.prototype.scrollIntoView = vi.fn();
      window.history.replaceState(null, "", "/transactions?highlight=2");
      tableData = {
        v_transactions_eur: [row("1"), row("2", { ...eligible, personal_amount: 20 })],
      };
      renderPage();
      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByText("€20.00")).toBeInTheDocument();
    });

    // Re-audit gap on polish 4 #1: in the link's first 3s, each toggle re-ran the link handling.
    // fails_when=Hide is undone at once, or Show reopens a closed spotlight
    it("lets Hide close the section it opened", async () => {
      Element.prototype.scrollIntoView = vi.fn();
      window.history.replaceState(null, "", "/transactions?highlight=2");
      tableData = {
        v_transactions_eur: [row("1"), row("2", { ...eligible, personal_amount: 0 })],
      };
      renderPage();
      await userEvent.click(
        await screen.findByRole("button", { name: "Hide 1 charge paid for others" }),
      );
      expect(
        await screen.findByRole("button", { name: "Show 1 charge paid for others" }),
      ).toBeInTheDocument();
      expect(screen.queryByText("Shop 2")).toBeNull();
    });

    it("doesn't reopen a closed spotlight when the section is shown", async () => {
      Element.prototype.scrollIntoView = vi.fn();
      window.history.replaceState(null, "", "/transactions?highlight=2");
      tableData = {
        v_transactions_eur: [
          row("1"),
          row("2", { ...eligible, personal_amount: 20 }),
          row("3", { personal_amount: 0 }),
        ],
      };
      renderPage();
      await screen.findByRole("dialog");
      await userEvent.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await userEvent.click(screen.getByRole("button", { name: "Show 1 charge paid for others" }));
      await act(() => new Promise((r) => setTimeout(r, 50)));
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  it("shows no section when nothing was paid for others", async () => {
    tableData = { v_transactions_eur: [row("1", { personal_amount: 4 })] };
    renderPage();
    await screen.findAllByText("Shop 1");
    expect(screen.queryByRole("button", { name: /paid for others/ })).toBeNull();
  });
});

// polish-4 #5: after a type save the nav badge ("Subscriptions 1 to review") stayed stale until
// Subscriptions was opened. fails_when=a type save doesn't re-check subscriptions and refetch them
describe("Type save and subscriptions", () => {
  const bankRow = {
    entry_reference: "e1",
    account_uid: "a1",
    booking_date: new Date().toISOString().slice(0, 10),
    category: "Entertainment",
    transaction_type: "Subscription",
    creditor_name: "Streamflix",
    currency: "EUR",
    amount: 9.99,
    signed_amount_eur: -9.99,
    credit_debit_indicator: "DBIT",
    flow_type: "spend",
  };
  const saveType = async (client: QueryClient) => {
    rows["v_transactions_eur"] = [bankRow];
    renderPage(client);
    const [card] = await screen.findAllByRole("button", { name: /Streamflix/ });
    await userEvent.click(card!);
    const sheet = await screen.findByRole("dialog");
    await userEvent.click(within(sheet).getByRole("button", { name: /Change type/ }));
    await userEvent.click(await screen.findByRole("button", { name: "One-time" }));
  };
  afterEach(() => invoke.mockReset());

  it("re-checks subscriptions, then refetches the recurring streams", async () => {
    const order: Array<string> = [];
    invoke.mockImplementation(async (fn: string) => {
      order.push(`invoke ${fn}`);
      return { data: { streams: 1 }, error: null };
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const spy = vi.spyOn(client, "invalidateQueries").mockImplementation(async (f) => {
      if (JSON.stringify(f?.queryKey) === JSON.stringify(["recurring_streams"]))
        order.push("refetch recurring_streams");
    });
    await saveType(client);
    await waitFor(() =>
      expect(order).toEqual(["invoke refresh-recurring", "refetch recurring_streams"]),
    );
    spy.mockRestore();
  });

  it("doesn't re-check when the type save fails", async () => {
    failTable = "transactions";
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    try {
      await saveType(client);
      await new Promise((r) => setTimeout(r, 50));
      expect(invoke).not.toHaveBeenCalled();
    } finally {
      failTable = null;
    }
  });

  it("still refetches when the re-check is rate limited (429)", async () => {
    invoke.mockResolvedValue({ data: null, error: { context: { status: 429 } } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const spy = vi.spyOn(client, "invalidateQueries");
    await saveType(client);
    await waitFor(() => expect(spy).toHaveBeenCalledWith({ queryKey: ["recurring_streams"] }));
  });

  // polish-5 E3: a 429 (server allows one re-check per 5 s) was never retried, so the nav badge
  // stayed stale. fails_when=no second re-check after the window, a ran/failed check is retried,
  // or a retry fires after the page closed
  describe("re-check after a rate limit", () => {
    afterEach(() => vi.useRealTimers());
    const LIMITED = { data: null, error: { context: { status: 429 } } };
    // Save with real timers, then switch to fake ones before the first answer comes back.
    const saveThenAnswer = async (first: unknown) => {
      let answer!: () => void;
      invoke.mockImplementationOnce(() => new Promise((res) => (answer = () => res(first))));
      invoke.mockResolvedValue({ data: { streams: 1 }, error: null });
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const spy = vi.spyOn(client, "invalidateQueries");
      await saveType(client);
      await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
      vi.useFakeTimers();
      return { spy, answer };
    };
    const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
    const recurringRefetches = (spy: { mock: { calls: Array<Array<unknown>> } }) =>
      spy.mock.calls.filter(
        ([f]) =>
          JSON.stringify((f as { queryKey?: unknown })?.queryKey) === '["recurring_streams"]',
      ).length;

    it("retries once after 5 s, then refetches the recurring streams", async () => {
      const { spy, answer } = await saveThenAnswer(LIMITED);
      answer();
      await advance(4_900);
      expect(invoke).toHaveBeenCalledTimes(1);
      const before = recurringRefetches(spy);
      await advance(200);
      expect(invoke).toHaveBeenCalledTimes(2);
      expect(recurringRefetches(spy)).toBe(before + 1);
      await advance(10_000);
      expect(invoke).toHaveBeenCalledTimes(2);
    });

    it("stops after one retry, even when the retry is rate limited too", async () => {
      const { answer } = await saveThenAnswer(LIMITED);
      invoke.mockResolvedValue(LIMITED);
      answer();
      await advance(5_100);
      expect(invoke).toHaveBeenCalledTimes(2);
      await advance(30_000);
      expect(invoke).toHaveBeenCalledTimes(2);
    });

    it("doesn't retry a check that ran", async () => {
      const { answer } = await saveThenAnswer({ data: { streams: 1 }, error: null });
      answer();
      await advance(10_000);
      expect(invoke).toHaveBeenCalledTimes(1);
    });

    it("doesn't retry a check that failed for another reason", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { answer } = await saveThenAnswer({ data: null, error: new Error("Load failed") });
      answer();
      await advance(10_000);
      expect(invoke).toHaveBeenCalledTimes(1);
      warn.mockRestore();
    });

    it("sends no retry once the page has closed", async () => {
      const { answer } = await saveThenAnswer(LIMITED);
      answer();
      await advance(100);
      cleanup();
      await advance(10_000);
      expect(invoke).toHaveBeenCalledTimes(1);
    });

    it("sends no retry when the page closes before the 429 comes back", async () => {
      await saveThenAnswer(LIMITED).then(({ answer }) => {
        cleanup();
        answer();
      });
      await advance(10_000);
      expect(invoke).toHaveBeenCalledTimes(1);
    });
  });
});
