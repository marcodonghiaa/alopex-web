import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// The demo client mirrors the real tables: split bills plus Splitwise groups on both sides. A
// fresh one per test, so answers given in one test never leak into the next.
const db = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/integrations/supabase/client", () => ({
  get supabase() {
    return db.client;
  },
}));
beforeEach(async () => {
  const { createFakeClient } = await import("@/lib/demo/fake-client");
  db.client = createFakeClient(new Date("2026-11-08T12:00:00Z"));
});

import { toast } from "sonner";
import { Route } from "./splitwise";

const Page = Route.options.component as () => React.JSX.Element;

// protects=Who owes you answers with one net figure first, the two totals below it (#10);
// fails_when=the net is missing, or shows €0.00 while the balances are still loading
describe("Who owes you", () => {
  it("shows a loading state, then the net owed above the two totals", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Page />
      </QueryClientProvider>,
    );
    expect(screen.getByRole("status", { name: "Loading balances" })).toBeTruthy();
    expect(screen.queryByText("Net owed to you")).toBeNull();

    const label = await screen.findByText("Net owed to you");
    const hero = label.closest("section")!;
    const owed = screen.getByText("Owed to you");
    const euros = (el: Element | null | undefined) =>
      Number(el!.textContent!.replace(/[^\d.]/g, ""));
    const net =
      euros(owed.nextElementSibling) - euros(screen.getByText("You owe").nextElementSibling);
    expect(net).toBeGreaterThan(0);
    expect(euros(hero.querySelector(".figure-display"))).toBeCloseTo(net, 2);
    expect(hero.compareDocumentPosition(owed) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("offers the Splitwise import after the balances, not above them", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Page />
      </QueryClientProvider>,
    );
    const importButton = await screen.findByRole("button", { name: "Import from Splitwise" });
    const groups = screen.getByText(/Splitwise groups/);
    expect(
      groups.compareDocumentPosition(importButton) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  // protects=taking back a "Not a payback" answer: the toast is its only Undo;
  // fails_when=it closes as fast as a plain notice
  it("keeps the 'Not a payback' Undo on screen as long as the Yes one", async () => {
    const success = vi.spyOn(toast, "success");
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Page />
      </QueryClientProvider>,
    );
    const section = await screen.findByRole("region", { name: "Payments to check" });
    await userEvent.click(within(section).getByRole("button", { name: "Not a payback" }));
    await waitFor(() =>
      expect(success).toHaveBeenCalledWith(
        "Got it: not a payback.",
        expect.objectContaining({ duration: 10_000, action: expect.anything() }),
      ),
    );
    // Its Undo brings the question back.
    const opts = success.mock.calls.at(-1)?.[1] as unknown as { action: { onClick: () => void } };
    opts.action.onClick();
    expect(await screen.findByRole("region", { name: "Payments to check" })).toBeTruthy();
    success.mockRestore();
  });

  // protects=matching a friend's bank transfer to what they owe (end to end on the demo data);
  // fails_when=the question doesn't show, or Yes doesn't settle their oldest bill
  it("asks whether a transfer from GIULIA BIANCHI is Giulia, and Yes settles her oldest bill", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Page />
      </QueryClientProvider>,
    );
    const section = await screen.findByRole("region", { name: "Payments to check" });
    expect(within(section).getByText("Is this Giulia?")).toBeTruthy();
    expect(within(section).getByText(/from GIULIA BIANCHI/)).toBeTruthy();
    const giulia = () =>
      screen.getByText("Giulia", { selector: "summary span span" }).closest("summary")!;
    const billsBefore = Number(/(\d+) open bills?/.exec(giulia().textContent ?? "")?.[1]);

    await userEvent.click(within(section).getByRole("button", { name: "Yes, it's Giulia" }));
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Payments to check" })).toBeNull(),
    );
    await waitFor(() =>
      expect(Number(/(\d+) open bills?/.exec(giulia().textContent ?? "")?.[1])).toBe(
        billsBefore - 1,
      ),
    );
  });

  // protects=self-hosters on a database without the payback functions; fails_when=the page breaks
  // or shows an error instead of just leaving the questions out
  it("without the payback functions, the page works and asks nothing", async () => {
    const client = db.client as { rpc: (name: string, args?: unknown) => unknown };
    const rpc = client.rpc.bind(client);
    client.rpc = (name, args) =>
      name === "payback_candidates"
        ? Promise.resolve({
            data: null,
            error: { message: "function does not exist", code: "PGRST202" },
          })
        : rpc(name, args);
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Page />
      </QueryClientProvider>,
    );
    expect(await screen.findByText("Net owed to you")).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Import from Splitwise" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Payments to check" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  // protects=the Yes toast and its Undo; fails_when=it doesn't say what was settled, or Undo
  // doesn't reopen the bill
  it("Yes says what it settled, and its Undo reopens the bill", async () => {
    const success = vi.spyOn(toast, "success");
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Page />
      </QueryClientProvider>,
    );
    const section = await screen.findByRole("region", { name: "Payments to check" });
    const giulia = () =>
      screen.getByText("Giulia", { selector: "summary span span" }).closest("summary")!;
    const bills = () => Number(/(\d+) open bills?/.exec(giulia().textContent ?? "")?.[1]);
    const before = bills();
    await userEvent.click(within(section).getByRole("button", { name: "Yes, it's Giulia" }));
    await waitFor(() =>
      expect(success).toHaveBeenCalledWith(
        expect.stringMatching(/^Giulia paid you back: 1 bill settled/),
        expect.objectContaining({ duration: 10_000 }),
      ),
    );
    await waitFor(() => expect(bills()).toBe(before - 1));
    const opts = success.mock.calls.at(-1)?.[1] as unknown as { action: { onClick: () => void } };
    opts.action.onClick();
    await waitFor(() => expect(bills()).toBe(before));
    expect(await screen.findByRole("region", { name: "Payments to check" })).toBeTruthy();
    success.mockRestore();
  });
});
