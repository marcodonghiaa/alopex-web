import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReviewItem } from "@/lib/splitwise-sync";

const rpc = vi.hoisted(() => vi.fn());
const tables = vi.hoisted(() => ({
  splitwise_review: { data: [] as unknown, error: null as unknown },
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
    for (const m of ["select", "eq", "order", "limit", "gte", "lte", "in"]) q[m] = () => q;
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
    await userEvent.click(
      within(row).getByRole("button", { name: "Count my share without linking" }),
    );
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
    await waitFor(() => expect(within(a).getByRole("button", { name: "Ignore" })).toBeDisabled());
    expect(within(b).getByRole("button", { name: "Ignore" })).toBeDisabled();
    await userEvent.click(within(b).getByRole("button", { name: "Ignore" }));
    expect(within(a).getByRole("button", { name: "Ignore" })).toBeDisabled();
    expect(rpc).toHaveBeenCalledTimes(1);
    finish({ data: {}, error: null });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Ignored"));
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

  it("turns every action off in the demo", async () => {
    demo.on = true;
    tables.splitwise_review = { data: [item()], error: null };
    tables.transactions = { data: [bankRow()], error: null };
    renderList();
    const row = await screen.findByRole("listitem", { name: "Groceries" });
    await within(row).findByRole("button", { name: "Link" });
    for (const b of within(row).getAllByRole("button")) expect(b).toBeDisabled();
    expect(screen.getByRole("note")).toHaveTextContent("Linking is off in the demo.");
  });
});
