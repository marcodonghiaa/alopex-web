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
    await waitFor(() => expect(screen.queryByText(/from GIULIA BIANCHI/)).toBeNull());
    await waitFor(() =>
      expect(Number(/(\d+) open bills?/.exec(giulia().textContent ?? "")?.[1])).toBe(
        billsBefore - 1,
      ),
    );
  });

  // protects=one payment, one question: a settle-up's bank payment that To link suggests is never
  // also asked about as a payback; fails_when=Giulia's €22 settle-up shows on To link and as
  // "Is this Giulia?" too (double count if both are answered)
  it("doesn't ask whether a payment To link suggests for a settle-up is a payback", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Page />
      </QueryClientProvider>,
    );
    const list = await screen.findByRole("region", { name: "To link" });
    const settleUp = await within(list).findByRole("listitem", { name: "Settle up" });
    await waitFor(() => expect(settleUp).toHaveTextContent("€22.00"));
    const section = await screen.findByRole("region", { name: "Did someone pay you back?" });
    // Her newer transfer is asked about; answered, nothing else about Giulia is.
    expect(within(section).getByText(/€32\.00/)).toBeTruthy();
    expect(within(section).queryByText(/€22\.00/)).toBeNull();
    await userEvent.click(within(section).getByRole("button", { name: "Yes, it's Giulia" }));
    await waitFor(() => expect(screen.queryByText(/from GIULIA BIANCHI/)).toBeNull());
    expect(screen.queryByText("Is this Giulia?")).toBeNull();
    expect(within(list).getByRole("listitem", { name: "Settle up" })).toBeTruthy();
  });

  // The demo has no link RPC (linking is off there): this one does what the server's does.
  const stubLinkRpc = () => {
    const client = db.client as {
      rpc: (name: string, args?: Record<string, unknown>) => unknown;
      from: (t: string) => { update: (p: object) => { eq: (c: string, v: unknown) => unknown } };
    };
    const rpc = client.rpc.bind(client);
    client.rpc = async (name, args) => {
      if (name !== "link_splitwise_review") return rpc(name, args);
      await client
        .from("transactions")
        .update({ flow_type: "transfer" })
        .eq("entry_reference", args!["p_entry_reference"]);
      await client.from("splitwise_review").update({ status: "linked" }).eq("id", args!["p_id"]);
      return { data: { status: "linked" }, error: null };
    };
  };

  // protects=polish-1 P1-2: once To link links a settle-up, its payment is not asked about next;
  // fails_when=the cached payback candidates still hold it ("Is this Giulia? €22.00" after Link)
  it("doesn't ask about a settle-up's payment after linking it on To link", async () => {
    stubLinkRpc();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Page />
      </QueryClientProvider>,
    );
    const section = await screen.findByRole("region", { name: "Did someone pay you back?" });
    await userEvent.click(within(section).getByRole("button", { name: "Yes, it's Giulia" }));
    await waitFor(() => expect(screen.queryByText(/from GIULIA BIANCHI/)).toBeNull());
    const list = screen.getByRole("region", { name: "To link" });
    const settleUp = within(list).getByRole("listitem", { name: "Settle up" });
    await waitFor(() =>
      expect(within(settleUp).getByRole("button", { name: /^Link/ })).toBeEnabled(),
    );
    await userEvent.click(within(settleUp).getByRole("button", { name: /^Link/ }));
    await waitFor(() =>
      expect(within(list).queryByRole("listitem", { name: "Settle up" })).toBeNull(),
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.queryByText("Is this Giulia?")).toBeNull();
  });

  // A query on `table` that waits for `held`, then answers as the demo would (or with `answer`).
  const holdTable = (
    table: string,
    held: Promise<void> | (() => Promise<void>),
    answer?: unknown,
    // Only reads whose select() columns pass (all reads when left out).
    when?: (cols: string) => boolean,
  ) => {
    const client = db.client as { from: (t: string) => unknown };
    const from = client.from.bind(client);
    const wrap = (q: object, cols = ""): unknown =>
      new Proxy(q, {
        get(target, key) {
          if (key === "then" && when && !when(cols))
            return (target as PromiseLike<unknown>).then.bind(target);
          if (key === "then")
            return (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) =>
              (typeof held === "function" ? held() : held).then(() => {
                const a = typeof answer === "function" ? (answer as () => unknown)() : answer;
                return a ? ok(a) : (target as PromiseLike<unknown>).then(ok, ko);
              });
          const v = (target as Record<PropertyKey, unknown>)[key];
          return typeof v === "function"
            ? (...a: Array<unknown>) =>
                wrap(
                  (v as (...x: Array<unknown>) => object).apply(target, a),
                  key === "select" ? String(a[0] ?? "") : cols,
                )
            : v;
        },
      });
    client.from = (t: string) => (t === table ? wrap(from(t) as object) : from(t));
  };

  // protects=no flash: a question To link will take over never shows first;
  // fails_when=the questions show before To link's payments are in, then one disappears
  it("asks nothing until To link's expenses are in", async () => {
    let release = () => {};
    holdTable("splitwise_review", new Promise<void>((r) => (release = r)));
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Page />
      </QueryClientProvider>,
    );
    expect(await screen.findByText("Net owed to you")).toBeTruthy();
    // Long enough for everything else (debts, rates, payments) to be in: only To link is held.
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.getByRole("status", { name: "Loading split bills" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Did someone pay you back?" })).toBeNull();
    release();
    const section = await screen.findByRole("region", { name: "Did someone pay you back?" });
    expect(within(section).queryByText(/€22\.00/)).toBeNull();
  });

  // protects=polish-1 P2-2: the questions also wait for To link's bank payments (what it
  // suggests); fails_when=they show while To link's suggestions are still loading
  it("asks nothing until To link's bank payments are in", async () => {
    let release = () => {};
    holdTable("transactions", new Promise<void>((r) => (release = r)), undefined, (cols) =>
      cols.includes("creditor_name"),
    );
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Page />
      </QueryClientProvider>,
    );
    expect(await screen.findByRole("listitem", { name: "Settle up" })).toBeTruthy();
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.getByRole("status", { name: "Loading split bills" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Did someone pay you back?" })).toBeNull();
    release();
    const section = await screen.findByRole("region", { name: "Did someone pay you back?" });
    expect(within(section).queryByText(/€22\.00/)).toBeNull();
  });

  // protects=polish-1 P1-2's twin P1-1: a To link action doesn't blank the page under it;
  // fails_when=linking the oldest item changes To link's bank window and every list below turns
  // back into a loading skeleton until it is read again
  it("keeps the lists in place while To link reloads after a link", async () => {
    stubLinkRpc();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Page />
      </QueryClientProvider>,
    );
    const list = await screen.findByRole("region", { name: "To link" });
    await screen.findByRole("region", { name: "Did someone pay you back?" });
    const settleUp = within(list).getByRole("listitem", { name: "Settle up" });
    await waitFor(() =>
      expect(within(settleUp).getByRole("button", { name: /^Link/ })).toBeEnabled(),
    );
    // From here every bank read is slow, so a reload of To link's window shows.
    holdTable("transactions", () => new Promise((r) => setTimeout(r, 150)));
    let blanked = false;
    let lostSuggestion = false;
    const watch = setInterval(() => {
      if (screen.queryByRole("status", { name: "Loading split bills" })) blanked = true;
      // The other expense keeps its suggested payment while the window reloads.
      const dinner = within(list).queryByRole("listitem", { name: "Dinner out" });
      if (!dinner?.textContent?.includes("Trattoria da Gino")) lostSuggestion = true;
    }, 5);
    await userEvent.click(within(settleUp).getByRole("button", { name: /^Link/ }));
    await waitFor(() =>
      expect(within(list).queryByRole("listitem", { name: "Settle up" })).toBeNull(),
    );
    await new Promise((r) => setTimeout(r, 400));
    clearInterval(watch);
    expect(blanked).toBe(false);
    expect(lostSuggestion).toBe(false);
  });

  // protects=polish-1 P1-1 (retry): Retry on a To link that failed doesn't blank the page under
  // it; fails_when=the retry puts To link back to loading and the lists below with it
  it("keeps the lists in place while a failed To link retries", async () => {
    let reads = 0;
    holdTable(
      "splitwise_review",
      () => (reads === 0 ? Promise.resolve() : new Promise((r) => setTimeout(r, 150))),
      () => (reads++ === 0 ? { data: null, error: { message: "boom" } } : undefined),
    );
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <Page />
      </QueryClientProvider>,
    );
    await screen.findByRole("region", { name: "Did someone pay you back?" });
    let blanked = false;
    const watch = setInterval(() => {
      if (screen.queryByRole("status", { name: "Loading split bills" })) blanked = true;
    }, 5);
    await userEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await screen.findByRole("listitem", { name: "Settle up" });
    clearInterval(watch);
    expect(blanked).toBe(false);
  });

  // protects=the questions when To link can't load; fails_when=they wait forever for it
  it("still asks when To link fails to load", async () => {
    holdTable("splitwise_review", Promise.resolve(), { data: null, error: { message: "boom" } });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Page />
      </QueryClientProvider>,
    );
    const section = await screen.findByRole("region", { name: "Did someone pay you back?" });
    expect(within(section).getByText("Is this Giulia?")).toBeTruthy();
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
