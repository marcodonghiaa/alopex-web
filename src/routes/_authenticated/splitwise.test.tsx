import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// The demo client mirrors the real tables: split bills plus Splitwise groups on both sides. A
// fresh one per test, so answers given in one test never leak into the next. A test can swap the
// demo's connection row to see the page in other states.
const connectionRow = vi.hoisted(() => ({ value: null as null | Record<string, unknown> }));
const db = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/integrations/supabase/client", () => ({
  get supabase() {
    return db.client;
  },
}));
beforeEach(async () => {
  const { createFakeClient } = await import("@/lib/demo/fake-client");
  const client = createFakeClient(new Date("2026-11-08T12:00:00Z"));
  const rpc = client.rpc.bind(client);
  db.client = Object.assign(client, {
    rpc: (fn: string, args?: unknown) =>
      fn === "get_splitwise_connection" && connectionRow.value
        ? Promise.resolve({ data: [connectionRow.value], error: null })
        : (rpc as (f: string, a?: unknown) => unknown)(fn, args),
  });
});

// The Splitwise sync tests run the page in demo mode, as the demo's own client would.
const demo = vi.hoisted(() => ({ on: false }));
vi.mock("@/lib/demo/mode", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo/mode")>()),
  isDemoMode: () => demo.on,
}));

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
    const importButton = await screen.findByRole("button", { name: "Import a Splitwise file" });
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
    const section = await screen.findByRole("region", { name: "Did someone pay you back?" });
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
    expect(await screen.findByRole("region", { name: "Did someone pay you back?" })).toBeTruthy();
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
    const section = await screen.findByRole("region", { name: "Did someone pay you back?" });
    expect(within(section).getByText("Is this Giulia?")).toBeTruthy();
    expect(within(section).getByText(/from GIULIA BIANCHI/)).toBeTruthy();
    const giulia = () =>
      screen.getByText("Giulia", { selector: "summary span span" }).closest("summary")!;
    const billsBefore = Number(/(\d+) open bills?/.exec(giulia().textContent ?? "")?.[1]);

    await userEvent.click(within(section).getByRole("button", { name: "Yes, it's Giulia" }));
    // The demo's other payment from Giulia (her Splitwise settle-up) may still ask; this one is gone.
    await waitFor(() => expect(screen.queryByText(/from GIULIA BIANCHI/)).toBeNull());
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
    expect(await screen.findByRole("button", { name: "Import a Splitwise file" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Did someone pay you back?" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  // protects=a steady page: the payment questions sit above the lists, so the lists wait for
  // them; fails_when=the lists show first and the questions push them down under a tap (U3)
  it("keeps the lists loading until the payment questions are in, so nothing shifts", async () => {
    const client = db.client as { rpc: (name: string, args?: unknown) => unknown };
    const rpc = client.rpc.bind(client);
    let release = () => {};
    const held = new Promise<void>((r) => (release = r));
    client.rpc = (name, args) =>
      name === "payback_candidates" ? held.then(() => rpc(name, args)) : rpc(name, args);
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Page />
      </QueryClientProvider>,
    );
    expect(await screen.findByText("Net owed to you")).toBeTruthy();
    expect(screen.getByRole("status", { name: "Loading split bills" })).toBeTruthy();
    expect(screen.getByRole("status", { name: "Loading Splitwise groups" })).toBeTruthy();
    release();
    expect(await screen.findByRole("region", { name: "Did someone pay you back?" })).toBeTruthy();
    expect(screen.queryByRole("status", { name: "Loading split bills" })).toBeNull();
  });

  // protects=split bills when the Splitwise balances fail (their rates then never load);
  // fails_when=the bills wait forever for questions that can't come (U3 round 2)
  it("split bills still show when the Splitwise balances fail to load", async () => {
    const client = db.client as { from: (t: string) => unknown };
    const from = client.from.bind(client);
    client.from = (t) =>
      t === "splitwise_balances"
        ? { select: () => Promise.resolve({ data: null, error: { message: "boom" } }) }
        : from(t);
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <Page />
      </QueryClientProvider>,
    );
    expect(await screen.findByText(/Couldn't load Splitwise balances/)).toBeTruthy();
    await waitFor(() =>
      expect(screen.queryByRole("status", { name: "Loading split bills" })).toBeNull(),
    );
    expect(screen.getByText("Giulia", { selector: "summary span span" })).toBeTruthy();
  });

  // protects=no tap lands on a moved row (U3 round 2); fails_when=Import from Splitwise shows
  // while the questions that will push it down are still loading
  it("holds Import from Splitwise until the payment questions are in", async () => {
    const client = db.client as { rpc: (name: string, args?: unknown) => unknown };
    const rpc = client.rpc.bind(client);
    let release = () => {};
    const held = new Promise<void>((r) => (release = r));
    client.rpc = (name, args) =>
      name === "payback_candidates" ? held.then(() => rpc(name, args)) : rpc(name, args);
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Page />
      </QueryClientProvider>,
    );
    expect(await screen.findByText("Net owed to you")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Import a Splitwise file" })).toBeNull();
    release();
    expect(await screen.findByRole("button", { name: "Import a Splitwise file" })).toBeTruthy();
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
    const section = await screen.findByRole("region", { name: "Did someone pay you back?" });
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
    expect(await screen.findByRole("region", { name: "Did someone pay you back?" })).toBeTruthy();
    success.mockRestore();
  });
});

// protects=the demo shows the sync as it looks connected, under a made-up name, with its To link
// list, and nothing can be sent; fails_when=a real name shows or an action is enabled in the demo
describe("Splitwise sync in the demo", () => {
  beforeEach(() => {
    demo.on = true;
  });
  afterEach(() => {
    demo.on = false;
  });
  it("shows the demo connection, the To link list with its count and disabled actions", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Page />
      </QueryClientProvider>,
    );
    expect(await screen.findByText("Splitwise · Alex")).toBeTruthy();
    expect(screen.getByText(/^Synced \d+ (h|days?) ago$/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sync now" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Connect Splitwise" })).toBeNull();

    const list = await screen.findByRole("region", { name: "To link" });
    expect(list).toHaveTextContent("2 to link");
    const dinner = await screen.findByRole("listitem", { name: "Dinner out" });
    expect(dinner).toHaveTextContent("You paid");
    expect(dinner).toHaveTextContent("your share €28.00");
    expect(screen.getByRole("listitem", { name: "Settle up" })).toHaveTextContent(
      "Settle-up you received",
    );
    for (const b of screen.getAllByRole("button", { name: "Ignore" })) expect(b).toBeDisabled();
    expect(screen.getByText("Linking is off in the demo.")).toBeTruthy();
    expect(screen.getByText(/synced from Splitwise/)).toBeTruthy();
  });
});

// polish-3 #17: the balances' title says where they came from only when that is sure
describe("Splitwise groups title", () => {
  beforeEach(() => {
    demo.on = true;
  });
  afterEach(() => {
    demo.on = false;
    connectionRow.value = null;
  });
  const row = (over: Record<string, unknown>) => ({
    connected: false,
    status: null,
    display_name: null,
    last_synced_at: null,
    last_error: null,
    synced_data: false,
    ...over,
  });
  const title = async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Page />
      </QueryClientProvider>,
    );
    // The connection has loaded once its row shows (Connect, or the status with Sync now).
    await screen.findByRole("button", { name: /^(Connect Splitwise|Sync now|Reconnect)$/ });
    return screen.getByText(/^Splitwise groups/).textContent;
  };

  it.each([
    [
      { connected: true, status: "ok", synced_data: true },
      "Splitwise groups · synced from Splitwise",
    ],
    [
      { connected: true, status: "needs_reconnect", synced_data: true },
      "Splitwise groups · from your last sync",
    ],
    [{}, "Splitwise groups · from your last import"],
    [{ synced_data: true }, "Splitwise groups"],
  ])("%o → %s", async (over, expected) => {
    connectionRow.value = row(over);
    expect(await title()).toBe(expected);
  });
});
