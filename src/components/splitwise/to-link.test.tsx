import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReviewItem } from "@/lib/splitwise-sync";

const rpc = vi.hoisted(() => vi.fn());
const tables = vi.hoisted(() => ({
  splitwise_review: { data: [], error: null } as { data: unknown; error: unknown; count?: number },
  transactions: { data: [] as unknown, error: null as unknown },
  fx_rates: { data: [] as unknown, error: null as unknown },
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
const demo = vi.hoisted(() => ({ on: false }));
vi.mock("@/lib/demo/mode", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo/mode")>()),
  isDemoMode: () => demo.on,
}));
vi.mock("@/integrations/supabase/client", () => {
  const from = (table: keyof typeof tables) => {
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "order", "limit", "gte", "lte", "in", "is", "range"])
      q[m] = () => q;
    q["then"] = (resolve: (v: unknown) => void) => resolve(tables[table]);
    return q;
  };
  return { supabase: { rpc, from } };
});

import { ToLink } from "./to-link";

const item = (over: Partial<ReviewItem> = {}): ReviewItem => ({
  id: "r1",
  kind: "paid_by_me",
  group_name: "Flat",
  booking_date: "2026-11-10",
  description: "Groceries",
  cost: 60,
  my_share: 20,
  my_paid: 60,
  currency: "EUR",
  rejected_entry_references: [],
  ...over,
});
const bankRow = (over: Record<string, unknown> = {}) => ({
  account_uid: "a1",
  entry_reference: "e1",
  booking_date: "2026-11-11",
  amount: 60,
  currency: "EUR",
  credit_debit_indicator: "DBIT",
  personal_amount: null,
  flow_type: null,
  deleted_at: null,
  creditor_name: "Market",
  ...over,
});

let client: QueryClient;
const renderList = (connected = true) => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  render(
    <QueryClientProvider client={client}>
      <ToLink connected={connected} />
    </QueryClientProvider>,
  );
  return invalidate;
};

beforeEach(() => {
  rpc.mockReset();
  rpc.mockResolvedValue({ data: {}, error: null });
  toast.success.mockClear();
  toast.error.mockClear();
  tables.splitwise_review = { data: [], error: null };
  tables.transactions = { data: [], error: null };
  tables.fx_rates = { data: [], error: null };
});
afterEach(() => {
  demo.on = false;
});

describe("ToLink", () => {
  it("shows nothing when not connected and nothing waits", async () => {
    renderList(false);
    await waitFor(() => expect(screen.queryByRole("region", { name: "To link" })).toBeNull());
  });

  it("says nothing is waiting once connected", async () => {
    renderList();
    expect(await screen.findByText(/Nothing to link/)).toBeTruthy();
  });

  it("still lists what waits after a disconnect", async () => {
    tables.splitwise_review = { data: [item()], error: null };
    renderList(false);
    expect(await screen.findByRole("listitem", { name: "Groceries" })).toBeTruthy();
  });

  it("shows a loading error", async () => {
    tables.splitwise_review = { data: null, error: { message: "boom" } };
    renderList();
    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
  });

  // protects=each item says what it is; fails_when=kind, group, cost or share is missing
  it("lists each item with date, group, kind, cost and my share, and counts them", async () => {
    tables.splitwise_review = {
      data: [
        item(),
        item({
          id: "r2",
          kind: "multi_payer",
          description: "Trip",
          cost: 90,
          my_paid: 30,
          my_share: 30,
        }),
        item({
          id: "r3",
          kind: "settle_out",
          description: "Paid Ana",
          cost: 15,
          my_paid: 15,
          my_share: 0,
        }),
        item({
          id: "r4",
          kind: "settle_in",
          description: "Ben paid",
          cost: 22,
          my_paid: 0,
          my_share: 0,
        }),
      ],
      error: null,
    };
    renderList();
    const groceries = await screen.findByRole("listitem", { name: "Groceries" });
    expect(groceries).toHaveTextContent("Flat · You paid");
    expect(groceries).toHaveTextContent("€60.00");
    expect(groceries).toHaveTextContent("your share €20.00");
    expect(screen.getByRole("listitem", { name: "Trip" })).toHaveTextContent("Several payers");
    const out = screen.getByRole("listitem", { name: "Paid Ana" });
    expect(out).toHaveTextContent("Settle-up you paid");
    expect(out).not.toHaveTextContent("your share");
    // Only an expense I paid can count without a bank payment.
    expect(within(out).queryByRole("button", { name: /Count my share/ })).toBeNull();
    expect(screen.getByRole("listitem", { name: "Ben paid" })).toHaveTextContent(
      "Settle-up you received",
    );
    expect(screen.getByRole("region", { name: "To link" })).toHaveTextContent("4 to link");
  });

  // protects=Link writes the suggested payment; fails_when=the wrong ids reach link_splitwise_review
  // or spending isn't refreshed after
  it("suggests the bank payment and links it", async () => {
    tables.splitwise_review = { data: [item()], error: null };
    tables.transactions = { data: [bankRow()], error: null };
    const invalidate = renderList();
    const row = await screen.findByRole("listitem", { name: "Groceries" });
    expect(await within(row).findByText("Market")).toBeTruthy();
    expect(row).toHaveTextContent("−€60.00");
    await userEvent.click(within(row).getByRole("button", { name: "Link" }));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith("link_splitwise_review", {
        p_id: "r1",
        p_account_uid: "a1",
        p_entry_reference: "e1",
      }),
    );
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Linked to the bank payment"));
    const keys = invalidate.mock.calls.map(
      (c) => (c[0] as { queryKey: Array<string> }).queryKey[0],
    );
    expect(keys).toEqual(
      expect.arrayContaining(["splitwise-review", "transactions", "spend-by-category"]),
    );
  });

  it("rejects a suggestion with Not this one", async () => {
    tables.splitwise_review = { data: [item()], error: null };
    tables.transactions = { data: [bankRow()], error: null };
    renderList();
    const row = await screen.findByRole("listitem", { name: "Groceries" });
    await userEvent.click(await within(row).findByRole("button", { name: "Not this one" }));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith("reject_splitwise_match", {
        p_id: "r1",
        p_entry_reference: "e1",
      }),
    );
  });

  it("never suggests a rejected payment, the next one instead", async () => {
    tables.splitwise_review = { data: [item({ rejected_entry_references: ["e1"] })], error: null };
    tables.transactions = {
      data: [
        bankRow(),
        bankRow({ entry_reference: "e2", booking_date: "2026-11-13", creditor_name: "Other" }),
      ],
      error: null,
    };
    renderList();
    const row = await screen.findByRole("listitem", { name: "Groceries" });
    expect(await within(row).findByText("Other")).toBeTruthy();
    expect(within(row).queryByText("Market")).toBeNull();
  });

  // protects=a settle-up received matches money in; fails_when=a payment out is suggested
  it("suggests money in for a settle-up received", async () => {
    tables.splitwise_review = {
      data: [
        item({ kind: "settle_in", description: "Ben paid", cost: 22, my_paid: 0, my_share: 0 }),
      ],
      error: null,
    };
    tables.transactions = {
      data: [
        bankRow({ entry_reference: "out", amount: 22, creditor_name: "Shop" }),
        bankRow({
          entry_reference: "in",
          amount: 22,
          credit_debit_indicator: "CRDT",
          creditor_name: "Ben",
        }),
      ],
      error: null,
    };
    renderList();
    const row = await screen.findByRole("listitem", { name: "Ben paid" });
    expect(await within(row).findByText("Ben")).toBeTruthy();
    expect(row).toHaveTextContent("+€22.00");
    expect(within(row).queryByText("Shop")).toBeNull();
  });

  it("counts my share without linking, and ignores", async () => {
    tables.splitwise_review = { data: [item()], error: null };
    renderList();
    const row = await screen.findByRole("listitem", { name: "Groceries" });
    await userEvent.click(within(row).getByRole("button", { name: "Count my share" }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("count_splitwise_review", { p_id: "r1" }));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Your share counts as spending"),
    );
    await userEvent.click(within(row).getByRole("button", { name: "Ignore" }));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith("dismiss_splitwise_review", { p_id: "r1" }),
    );
  });

  it("shows the database's refusal", async () => {
    tables.splitwise_review = { data: [item()], error: null };
    rpc.mockResolvedValue({
      data: null,
      error: { message: "This Splitwise expense is already settled." },
    });
    renderList();
    const row = await screen.findByRole("listitem", { name: "Groceries" });
    await userEvent.click(within(row).getByRole("button", { name: "Ignore" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("This Splitwise expense is already settled."),
    );
  });

  // protects=manual search when the matcher finds nothing; fails_when=the picked payment isn't linked
  it("links a payment found by hand", async () => {
    tables.splitwise_review = { data: [item({ cost: 80, my_paid: 80 })], error: null };
    tables.transactions = {
      data: [bankRow({ entry_reference: "tip", amount: 88, creditor_name: "Bistro" })],
      error: null,
    };
    renderList();
    const row = await screen.findByRole("listitem", { name: "Groceries" });
    await userEvent.click(within(row).getByRole("button", { name: "Find in bank" }));
    const sheet = await screen.findByRole("dialog", { name: "Which payment was Groceries?" });
    await userEvent.click(within(sheet).getByText("Bistro"));
    await userEvent.click(within(sheet).getByRole("button", { name: "Link payment" }));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith("link_splitwise_review", {
        p_id: "r1",
        p_account_uid: "a1",
        p_entry_reference: "tip",
      }),
    );
  });

  // polish-3 #5: a re-render of the list must not wipe the payment picked in Find in bank
  it("keeps the payment picked in Find in bank when the list refreshes", async () => {
    tables.splitwise_review = { data: [item({ cost: 80, my_paid: 80 })], error: null };
    tables.transactions = {
      data: [bankRow({ entry_reference: "tip", amount: 88, creditor_name: "Bistro" })],
      error: null,
    };
    renderList();
    const row = await screen.findByRole("listitem", { name: "Groceries" });
    await userEvent.click(within(row).getByRole("button", { name: "Find in bank" }));
    const sheet = await screen.findByRole("dialog", { name: "Which payment was Groceries?" });
    await userEvent.click(within(sheet).getByText("Bistro"));
    expect(within(sheet).getByRole("button", { name: "Link payment" })).toBeEnabled();
    tables.splitwise_review = {
      data: [item({ cost: 80, my_paid: 80 }), item({ id: "r2", description: "Trip" })],
      error: null,
    };
    await client.invalidateQueries({ queryKey: ["splitwise-review"] });
    await screen.findByRole("listitem", { name: "Trip", hidden: true });
    expect(within(sheet).getByRole("button", { name: "Link payment" })).toBeEnabled();
  });

  // polish-3 #4: one action at a time, so a second row can't turn the first row's buttons back on
  it("keeps every row off while an action runs", async () => {
    tables.splitwise_review = {
      data: [item(), item({ id: "r2", description: "Trip" })],
      error: null,
    };
    let finish: (v: unknown) => void = () => {};
    rpc.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    renderList();
    const a = await screen.findByRole("listitem", { name: "Groceries" });
    const b = screen.getByRole("listitem", { name: "Trip" });
    await userEvent.click(within(a).getByRole("button", { name: "Ignore" }));
    const off = (el: HTMLElement) => expect(el).toHaveAttribute("aria-disabled", "true");
    await waitFor(() => off(within(a).getByRole("button", { name: "Ignore" })));
    off(within(b).getByRole("button", { name: "Ignore" }));
    await userEvent.click(within(b).getByRole("button", { name: "Ignore" }));
    off(within(a).getByRole("button", { name: "Ignore" }));
    expect(rpc).toHaveBeenCalledTimes(1);
    finish({ data: {}, error: null });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Ignored"));
  });

  // polish-3 #3: the buttons stay off until the list has refreshed, so Ignore can't undo a Link
  it("keeps the row off until the list has refreshed after an action", async () => {
    tables.splitwise_review = { data: [item()], error: null };
    tables.transactions = { data: [bankRow()], error: null };
    renderList();
    const row = await screen.findByRole("listitem", { name: "Groceries" });
    await within(row).findByRole("button", { name: "Link" });
    let refreshed: () => void = () => {};
    (tables as Record<string, unknown>)["splitwise_review"] = new Promise(
      (resolve) => (refreshed = () => resolve({ data: [], error: null })),
    );
    await userEvent.click(within(row).getByRole("button", { name: "Link" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Linked to the bank payment"));
    expect(within(row).getByRole("button", { name: "Ignore" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await userEvent.click(within(row).getByRole("button", { name: "Ignore" }));
    expect(rpc).toHaveBeenCalledTimes(1);
    refreshed();
    await waitFor(() => expect(screen.queryByRole("listitem", { name: "Groceries" })).toBeNull());
  });

  // polish-3 #2: no silent cut-offs
  it("says how many wait when it shows only the newest", async () => {
    tables.splitwise_review = { data: [item()], error: null, count: 1200 };
    renderList();
    const list = await screen.findByRole("region", { name: "To link" });
    await screen.findByRole("listitem", { name: "Groceries" });
    expect(list).toHaveTextContent("1,200 to link");
    expect(list).toHaveTextContent("Showing the newest 1 of 1,200.");
  });

  it("says when suggestions don't reach older bank payments", async () => {
    tables.splitwise_review = { data: [item()], error: null, count: 1 };
    tables.transactions = {
      data: Array.from({ length: 1000 }, (_, i) =>
        bankRow({ entry_reference: `e${i}`, booking_date: "2026-11-05" }),
      ),
      error: null,
    };
    renderList();
    // polish-3 round 2: Find in bank searches the same rows, so the note must not send you there.
    // polish-4 #30: a gap, not a range: rows from the partly read day still show.
    const note = await screen.findByText(/^Bank payments before/);
    expect(note.textContent).toBe(
      "Bank payments before 6 Nov may be missing from suggestions and Find in bank.",
    );
  });

  // polish-4 #30: the note must not contradict a suggestion from the partly read day
  it("keeps a suggestion from before the complete date without contradicting it", async () => {
    tables.splitwise_review = {
      data: [item({ booking_date: "2026-11-05", cost: 33, my_paid: 33 })],
      error: null,
      count: 1,
    };
    tables.transactions = {
      data: [
        bankRow({
          entry_reference: "shop",
          booking_date: "2026-11-05",
          amount: 33,
          creditor_name: "Shop 15",
        }),
        ...Array.from({ length: 999 }, (_, i) =>
          bankRow({ entry_reference: `e${i}`, booking_date: "2026-11-05", amount: 500 }),
        ),
      ],
      error: null,
    };
    renderList();
    const row = await screen.findByRole("listitem", { name: "Groceries" });
    expect(await within(row).findByText("Shop 15")).toBeTruthy();
    expect(row).toHaveTextContent("5 Nov");
    const note = screen.getByText(/^Bank payments before 6 Nov/);
    expect(note.textContent).not.toMatch(/only cover/);
  });

  // polish-3 #18: the rates fetched depend on the items' currencies, so the cache key does too
  it("fetches rates again when an item in a new currency arrives in the same dates", async () => {
    tables.splitwise_review = { data: [item()], error: null };
    tables.transactions = {
      data: [bankRow(), bankRow({ entry_reference: "e2", amount: 45, creditor_name: "Airline" })],
      error: null,
    };
    tables.fx_rates = {
      data: [{ currency: "USD", date: "2026-11-01", rate_to_eur: 0.9 }],
      error: null,
    };
    renderList();
    const groceries = await screen.findByRole("listitem", { name: "Groceries" });
    await within(groceries).findByText("Market");
    tables.splitwise_review = {
      data: [
        item(),
        item({ id: "r2", description: "Trip", cost: 50, my_paid: 50, currency: "USD" }),
      ],
      error: null,
    };
    await client.invalidateQueries({ queryKey: ["splitwise-review"] });
    const trip = await screen.findByRole("listitem", { name: "Trip" });
    expect(await within(trip).findByText("Airline")).toBeTruthy();
  });

  it("says what to do when no payment is around", async () => {
    tables.splitwise_review = { data: [item()], error: null };
    renderList();
    const row = await screen.findByRole("listitem", { name: "Groceries" });
    await userEvent.click(within(row).getByRole("button", { name: "Find in bank" }));
    expect(await screen.findByText(/count your share without linking/)).toBeTruthy();
  });

  it("keeps the list without suggestions when the bank can't be read", async () => {
    tables.splitwise_review = { data: [item()], error: null };
    tables.transactions = { data: null, error: { message: "timeout" } };
    renderList();
    expect(await screen.findByText("No bank suggestions: timeout")).toBeTruthy();
    expect(screen.getByRole("listitem", { name: "Groceries" })).toBeTruthy();
  });

  // polish-4 #17: Find in bank only reads, so the demo can show it
  it("turns every action off in the demo except Find in bank", async () => {
    demo.on = true;
    tables.splitwise_review = { data: [item()], error: null };
    tables.transactions = { data: [bankRow()], error: null };
    renderList();
    const row = await screen.findByRole("listitem", { name: "Groceries" });
    await within(row).findByRole("button", { name: "Link" });
    for (const b of within(row).getAllByRole("button"))
      if (b.textContent === "Find in bank") expect(b).toBeEnabled();
      else expect(b).toBeDisabled();
    expect(screen.getByRole("note")).toHaveTextContent("Linking is off in the demo.");
    await userEvent.click(within(row).getByRole("button", { name: "Find in bank" }));
    const sheet = await screen.findByRole("dialog", { name: "Which payment was Groceries?" });
    // polish-5 #6: picking a payment must not offer a Link that only fails with a toast
    await userEvent.click(within(sheet).getAllByRole("radio")[0]!);
    expect(within(sheet).getByRole("button", { name: "Link payment" })).toBeDisabled();
    expect(within(sheet).getByRole("note")).toHaveTextContent("Linking is off in the demo.");
  });
});

// polish-4 #2: leaving Find in bank hands focus back to the expense, not to <body>
describe("Find in bank focus", () => {
  it("returns focus to the row's Find in bank on Esc, and to the row after a link", async () => {
    tables.splitwise_review = { data: [item({ cost: 80, my_paid: 80 })], error: null };
    tables.transactions = {
      data: [bankRow({ entry_reference: "tip", amount: 88, creditor_name: "Bistro" })],
      error: null,
    };
    renderList();
    const row = await screen.findByRole("listitem", { name: "Groceries" });
    const find = within(row).getByRole("button", { name: "Find in bank" });
    await userEvent.click(find);
    await screen.findByRole("dialog", { name: "Which payment was Groceries?" });
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(find));
    // The same exit through another control: the sheet's X.
    await userEvent.click(find);
    const again = await screen.findByRole("dialog", { name: "Which payment was Groceries?" });
    await userEvent.click(within(again).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(document.activeElement).toBe(find));

    await userEvent.click(find);
    const sheet = await screen.findByRole("dialog", { name: "Which payment was Groceries?" });
    await userEvent.click(within(sheet).getByText("Bistro"));
    await userEvent.click(within(sheet).getByRole("button", { name: "Link payment" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("listitem", { name: "Groceries" })),
    );
  });
});

// polish-4 #5: a long list must not push the groups (the page's answer) far down
describe("To link length", () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => item({ id: `r${i}`, description: `Expense ${i}` }));

  it("shows the newest 5 and a Show all that reveals the rest and keeps focus in the list", async () => {
    tables.splitwise_review = { data: many(7), error: null };
    renderList();
    await screen.findByRole("listitem", { name: "Expense 0" });
    expect(screen.getAllByRole("listitem")).toHaveLength(5);
    expect(screen.queryByRole("listitem", { name: "Expense 5" })).toBeNull();
    expect(screen.getByRole("region", { name: "To link" })).toHaveTextContent("7 to link");
    await userEvent.click(screen.getByRole("button", { name: "Show all 7" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(7);
    expect(screen.queryByRole("button", { name: /Show all/ })).toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("listitem", { name: "Expense 5" })),
    );
  });

  it("shows every row and no Show all when 5 or fewer wait", async () => {
    tables.splitwise_review = { data: many(5), error: null };
    renderList();
    await screen.findByRole("listitem", { name: "Expense 4" });
    expect(screen.getAllByRole("listitem")).toHaveLength(5);
    expect(screen.queryByRole("button", { name: /Show all/ })).toBeNull();
  });
});

// polish-4 #7: the 12 px count was ember on white (2.9:1)
it("draws the To link count in a text colour that reads at 12 px", async () => {
  tables.splitwise_review = { data: [item()], error: null };
  renderList();
  await screen.findByRole("listitem", { name: "Groceries" });
  const badge = screen.getByText("1", { selector: "span" });
  expect(badge.className).not.toContain("text-ember");
  expect(badge.className).toContain("text-muted-foreground");
});

// polish-4 #8: 44 px row actions (DESIGN.md), and a label short enough that Ignore doesn't wrap alone
it("makes every row action 44 px tall", async () => {
  tables.splitwise_review = { data: [item()], error: null };
  tables.transactions = { data: [bankRow()], error: null };
  renderList();
  const row = await screen.findByRole("listitem", { name: "Groceries" });
  await within(row).findByRole("button", { name: "Link" });
  const buttons = within(row).getAllByRole("button");
  expect(buttons.map((b) => b.textContent)).toEqual([
    "Link",
    "Not this one",
    "Find in bank",
    "Count my share",
    "Ignore",
  ]);
  for (const b of buttons) expect(b.className.split(" ")).toContain("min-h-11");
});

// polish-4 #10: a settle-up is named as one, with its amount (Splitwise calls them all "Settle up")
describe("Find in bank for a settle-up", () => {
  it.each([
    ["settle_out", "Which payment was this settle-up?"],
    ["settle_in", "Which payment came in for this settle-up?"],
  ] as const)("%s → %s", async (kind, title) => {
    tables.splitwise_review = {
      data: [item({ kind, description: "Settle up", cost: 40, my_paid: 0, my_share: 0 })],
      error: null,
    };
    renderList();
    const row = await screen.findByRole("listitem", { name: "Settle up" });
    await userEvent.click(within(row).getByRole("button", { name: "Find in bank" }));
    const sheet = await screen.findByRole("dialog", { name: title });
    expect(sheet).toHaveTextContent("Settle-up of €40.00. Payments around 10 Nov, any amount.");
  });

  it("keeps the expense's own name for an expense", async () => {
    tables.splitwise_review = { data: [item()], error: null };
    renderList();
    const row = await screen.findByRole("listitem", { name: "Groceries" });
    await userEvent.click(within(row).getByRole("button", { name: "Find in bank" }));
    const sheet = await screen.findByRole("dialog", { name: "Which payment was Groceries?" });
    expect(sheet).toHaveTextContent("Payments around 10 Nov, any amount.");
  });
});

// polish-4 #11: pending rows keep the clicked button focused; a row that goes hands focus on
describe("To link focus around an action", () => {
  it("keeps focus on the clicked button while it runs and after it fails", async () => {
    tables.splitwise_review = { data: [item()], error: null };
    let finish: (v: unknown) => void = () => {};
    rpc.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    renderList();
    const row = await screen.findByRole("listitem", { name: "Groceries" });
    const ignore = within(row).getByRole("button", { name: "Ignore" });
    await userEvent.click(ignore);
    await waitFor(() => expect(ignore).toHaveAttribute("aria-disabled", "true"));
    expect(ignore).not.toBeDisabled();
    expect(document.activeElement).toBe(ignore);
    finish({ data: null, error: { message: "nope" } });
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("nope"));
    await waitFor(() => expect(ignore).not.toHaveAttribute("aria-disabled"));
    expect(document.activeElement).toBe(ignore);
  });

  it("moves focus to the row that takes the place of one that went", async () => {
    tables.splitwise_review = {
      data: [item(), item({ id: "r2", description: "Trip" })],
      error: null,
    };
    renderList();
    const row = await screen.findByRole("listitem", { name: "Groceries" });
    tables.splitwise_review = { data: [item({ id: "r2", description: "Trip" })], error: null };
    await userEvent.click(within(row).getByRole("button", { name: "Ignore" }));
    await waitFor(() => expect(screen.queryByRole("listitem", { name: "Groceries" })).toBeNull());
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("listitem", { name: "Trip" })),
    );
  });
});

// polish-4 #16: the To link error has a Retry, like the connection error
describe("To link load error", () => {
  it("retries and shows the list", async () => {
    tables.splitwise_review = { data: null, error: { message: "boom" } };
    renderList();
    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
    tables.splitwise_review = { data: [item()], error: null };
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("listitem", { name: "Groceries" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("has no Retry when the list loaded", async () => {
    tables.splitwise_review = { data: [item()], error: null };
    renderList();
    await screen.findByRole("listitem", { name: "Groceries" });
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});

// polish-4 #18: with several payers the suggestion is for what you paid, so show it
describe("What you paid", () => {
  it("shows it for several payers", async () => {
    tables.splitwise_review = {
      data: [
        item({ kind: "multi_payer", description: "Trip", cost: 180, my_paid: 100, my_share: 60 }),
      ],
      error: null,
    };
    renderList();
    const row = await screen.findByRole("listitem", { name: "Trip" });
    expect(row).toHaveTextContent("you paid €100.00");
    expect(row).toHaveTextContent("your share €60.00");
  });

  it("leaves it out when you paid it all", async () => {
    tables.splitwise_review = { data: [item()], error: null };
    renderList();
    const row = await screen.findByRole("listitem", { name: "Groceries" });
    expect(row).not.toHaveTextContent("you paid");
  });
});

// polish-4 #20: a long description wraps to two lines instead of a one-line ellipsis
it("lets a long description use two lines", async () => {
  tables.splitwise_review = { data: [item()], error: null };
  renderList();
  const row = await screen.findByRole("listitem", { name: "Groceries" });
  const name = within(row).getByText("Groceries");
  expect(name.className.split(" ")).toContain("line-clamp-2");
  expect(name.className.split(" ")).not.toContain("truncate");
});

// polish-4 #25: "settle" would read as the Settle-up item type in the same list
it("tells what brings the older ones in without saying settle", async () => {
  tables.splitwise_review = { data: [item()], error: null, count: 742 };
  renderList();
  const note = await screen.findByText(/^Showing the newest/);
  expect(note.textContent).toBe(
    "Showing the newest 1 of 742. Link or ignore these and older ones appear.",
  );
});

// polish-4 #8 follow-up: at 375 px the 44 px buttons still left Ignore alone on a line; compact
// side padding fits Find in bank, Count my share and Ignore on one line
it("gives the row actions compact side padding", async () => {
  tables.splitwise_review = { data: [item()], error: null };
  renderList();
  const row = await screen.findByRole("listitem", { name: "Groceries" });
  for (const b of within(row).getAllByRole("button")) {
    // Ignore has no fill, so it goes tighter still.
    expect(b.className.split(" ")).toContain(b.textContent === "Ignore" ? "px-2" : "px-3");
    expect(b.className.split(" ")).toContain("min-h-11");
  }
});

// re-audit N2: with a suggestion a settle-up row has Link, Not this one, Find in bank and Ignore,
// too wide for 375 px; the suggestion's two actions take their own line on phones
describe("Row actions with a suggestion", () => {
  it("puts Link and Not this one on their own line on phones, the rest together", async () => {
    tables.splitwise_review = {
      data: [
        item({ kind: "settle_out", description: "Paid Ana", cost: 60, my_paid: 60, my_share: 0 }),
      ],
      error: null,
    };
    tables.transactions = { data: [bankRow()], error: null };
    renderList();
    const row = await screen.findByRole("listitem", { name: "Paid Ana" });
    const link = await within(row).findByRole("button", { name: "Link" });
    const line = link.parentElement!;
    expect(line.className.split(" ")).toEqual(
      expect.arrayContaining(["basis-full", "sm:basis-auto"]),
    );
    expect(
      within(line)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Link", "Not this one"]);
    const ignore = within(row).getByRole("button", { name: "Ignore" });
    expect(ignore.parentElement).toBe(
      within(row).getByRole("button", { name: "Find in bank" }).parentElement,
    );
    expect(ignore.parentElement).not.toBe(line);
  });

  it("has no such line without a suggestion", async () => {
    tables.splitwise_review = { data: [item()], error: null };
    renderList();
    const row = await screen.findByRole("listitem", { name: "Groceries" });
    expect(row.querySelector(".basis-full")).toBeNull();
  });
});
