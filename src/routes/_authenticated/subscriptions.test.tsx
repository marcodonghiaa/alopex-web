import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";

type Row = Record<string, unknown>;
const { db, rpc, invoke, toast } = vi.hoisted(() => ({
  db: {
    rows: [] as Array<Row>,
    error: null as Error | null,
    // Set to hold the next reads back until it resolves.
    gate: null as Promise<void> | null,
  },
  rpc: vi.fn(),
  invoke: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("sonner", () => ({ toast }));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc,
    functions: { invoke },
    from: () => ({
      select: async () => {
        if (db.gate) await db.gate;
        return { data: db.rows, error: db.error };
      },
    }),
  },
}));

import { Route } from "./subscriptions";

// The URL's search params, as a tiny store: navigate() changes them and the page re-renders.
type Search = { view?: "calendar"; month?: string };
const url = vi.hoisted(() => ({
  search: {} as Record<string, unknown>,
  subs: new Set<() => void>(),
}));
const navigate = vi.fn((opts: { search: (s: Search) => Search; replace?: boolean }) => {
  url.search = opts.search(url.search as Search);
  url.subs.forEach((f) => f());
});
vi.spyOn(Route, "useSearch").mockImplementation((() =>
  useSyncExternalStore(
    (f) => (url.subs.add(f), () => url.subs.delete(f)),
    () => url.search,
  )) as never);
vi.spyOn(Route, "useNavigate").mockImplementation((() => navigate) as never);

const Page = Route.options.component as () => React.JSX.Element;

const stream = (over: Row): Row => ({
  id: "s1",
  display_name: "Streamflix",
  category: "Entertainment",
  currency: "EUR",
  cadence: "monthly",
  typical_amount: 10,
  typical_amount_eur: 10,
  charge_count: 4,
  last_charged: "2099-12-01",
  next_expected: "2099-12-31",
  detected_status: "active",
  user_status: null,
  user_cadence: null,
  custom_interval_value: null,
  custom_interval_unit: null,
  ...over,
});

// Applies the RPC to the fake table, like the server would.
function serverApplies(patchFor: (action: string, args: Row) => Row) {
  rpc.mockImplementation((_fn: string, p: { p_stream: string; p_action: string; p_args: Row }) => {
    db.rows = db.rows.map((r) =>
      r["id"] === p.p_stream ? { ...r, ...patchFor(p.p_action, p.p_args) } : r,
    );
    return Promise.resolve({ error: null });
  });
}

const renderPage = () =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <Page />
    </QueryClientProvider>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  url.search = {};
  localStorage.setItem("mf.subscriptionsReveal.seen", "1"); // keep the one-time reveal out of these tests
  db.error = null;
  db.gate = null;
  invoke.mockResolvedValue({ data: { streams: 2 }, error: null });
  db.rows = [
    stream({}),
    stream({
      id: "s2",
      display_name: "Cloudbox",
      detected_status: "suggested",
      typical_amount: 5,
      typical_amount_eur: 5,
      charge_count: 3,
    }),
  ];
  serverApplies((action) => ({
    user_status: action === "dismiss" ? "dismissed" : action === "undismiss" ? null : "confirmed",
  }));
  const base = rpc.getMockImplementation()!;
  // Server rule: undismiss restores to confirmed when nothing was detected, else clears the status.
  rpc.mockImplementation((fn: string, p: { p_stream: string; p_action: string }) => {
    const r = db.rows.find((x) => x["id"] === p.p_stream);
    const res = base(fn, p);
    if (p.p_action === "undismiss" && r?.["detected_status"] == null)
      db.rows = db.rows.map((x) =>
        x["id"] === p.p_stream ? { ...x, user_status: "confirmed" } : x,
      );
    return res;
  });
});

describe("Subscriptions page", () => {
  // Thread "Sync transaction edits to subscriptions": a transaction renamed (or marked One-time)
  // still showed its old subscription until the 6-hour detection run.
  it("re-checks your subscriptions when it opens, so transaction edits show at once", async () => {
    invoke.mockImplementation(async () => {
      db.rows = db.rows.map((r) => (r["id"] === "s1" ? { ...r, display_name: "iCloud" } : r));
      return { data: { streams: 2 }, error: null };
    });
    renderPage();
    expect(await screen.findByText("iCloud")).toBeInTheDocument();
    expect(screen.queryByText("Streamflix")).not.toBeInTheDocument();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("refresh-recurring", { body: {} });
  });

  it("keeps the saved list, with no error, when the re-check fails (demo, offline, older backend)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    invoke.mockResolvedValue({ data: null, error: new Error("FunctionsFetchError") });
    renderPage();
    expect(await screen.findByText("Streamflix")).toBeInTheDocument();
    await waitFor(() => expect(warn).toHaveBeenCalled());
    expect(toast.error).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  // Polish 1 #5: neither guard on the re-check's refetch had a test.
  it("does not refetch when the re-check didn't run", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    invoke.mockResolvedValue({ data: null, error: new Error("FunctionsFetchError") });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const spy = vi.spyOn(client, "invalidateQueries");
    render(
      <QueryClientProvider client={client}>
        <Page />
      </QueryClientProvider>,
    );
    await screen.findByText("Streamflix");
    await waitFor(() => expect(warn).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(spy).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("leaves the refetch to an action still in flight when the re-check ends", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const page = (
      <QueryClientProvider client={client}>
        <Page />
      </QueryClientProvider>
    );
    // Row actions wait for the re-check (polish-3 F2), so the action in flight is an Undo from
    // an earlier visit: remove, leave, come back, tap Undo while the new re-check runs.
    const first = render(page);
    const remove = await screen.findByRole("button", { name: "More actions for Streamflix" });
    await waitFor(() => expect(remove).toBeEnabled());
    fireEvent.click(remove);
    fireEvent.click(await screen.findByRole("button", { name: "Not a subscription" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    const undo = (toast.success.mock.calls[0]![1] as { action: { onClick: () => void } }).action;
    await waitFor(() => expect(client.isMutating()).toBe(0));
    first.unmount();

    let finishCheck!: () => void;
    invoke.mockImplementation(
      () => new Promise((res) => (finishCheck = () => res({ data: { streams: 1 }, error: null }))),
    );
    let finishAction!: () => void;
    rpc.mockImplementation(() => new Promise((res) => (finishAction = () => res({ error: null }))));
    const spy = vi.spyOn(client, "invalidateQueries");
    render(page);
    await screen.findByText("Checking your transactions…");
    undo.onClick();
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(2));
    finishCheck();
    await new Promise((r) => setTimeout(r, 50));
    expect(spy).not.toHaveBeenCalled();
    finishAction();
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
  });

  // polish-3 F2: rows can move when the re-check lands, so a tap mustn't hit the row below.
  it("says it's checking and locks the row actions until the re-check lands", async () => {
    let finishCheck!: () => void;
    invoke.mockImplementation(
      () => new Promise((res) => (finishCheck = () => res({ data: { streams: 2 }, error: null }))),
    );
    db.rows.push(stream({ id: "s3", display_name: "Oldtube", user_status: "dismissed" }));
    renderPage();
    const remove = await screen.findByRole("button", { name: "More actions for Streamflix" });
    const confirm = screen.getByRole("button", { name: "Confirm Cloudbox" });
    // Re-audit F2b: every row action waits, Restore and the frequency picker too.
    const restore = screen.getByRole("button", { name: "Restore Oldtube" });
    const frequency = screen.getByTitle("Monthly — auto-detected");
    expect(restore).toBeDisabled();
    expect(frequency).toBeDisabled();
    // polish-4 #1: no live region (it was never announced); aria-busy says it instead.
    expect(await screen.findByText("Checking your transactions…")).not.toHaveAttribute("aria-live");
    expect(screen.getByTestId("subscriptions-content")).toHaveAttribute("aria-busy", "true");
    expect(remove).toBeDisabled();
    expect(confirm).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cloudbox is not a subscription" })).toBeDisabled();
    fireEvent.click(remove);
    // Locked: the menu doesn't open.
    expect(screen.queryByRole("button", { name: "Not a subscription" })).toBeNull();
    expect(rpc).not.toHaveBeenCalled();

    finishCheck();
    await waitFor(() =>
      expect(screen.queryByText("Checking your transactions…")).not.toBeInTheDocument(),
    );
    expect(screen.getByTestId("subscriptions-content")).toHaveAttribute("aria-busy", "false");
    expect(screen.getByRole("button", { name: "More actions for Streamflix" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Confirm Cloudbox" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Restore Oldtube" })).toBeEnabled();
    expect(screen.getByTitle("Monthly — auto-detected")).toBeEnabled();
  });

  // Re-audit F2b: unlocking before the refetch lands would let the rows move under a tap.
  it("keeps the row actions locked until the fresh list is on screen", async () => {
    let finishCheck!: () => void;
    invoke.mockImplementation(
      () => new Promise((res) => (finishCheck = () => res({ data: { streams: 2 }, error: null }))),
    );
    renderPage();
    await screen.findByText("Streamflix");
    let openRead!: () => void;
    db.gate = new Promise<void>((r) => (openRead = r));
    db.rows = db.rows.map((r) => (r["id"] === "s1" ? { ...r, display_name: "iCloud" } : r));
    finishCheck();
    await new Promise((r) => setTimeout(r, 50));
    expect(await screen.findByText("Checking your transactions…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "More actions for Streamflix" })).toBeDisabled();

    openRead();
    expect(await screen.findByText("iCloud")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "More actions for iCloud" })).toBeEnabled(),
    );
    expect(screen.queryByText("Checking your transactions…")).not.toBeInTheDocument();
  });

  it("unlocks the row actions when the re-check fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    invoke.mockResolvedValue({ data: null, error: new Error("FunctionsFetchError") });
    renderPage();
    await screen.findByText("Streamflix");
    await waitFor(() =>
      expect(screen.queryByText("Checking your transactions…")).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "More actions for Streamflix" })).toBeEnabled();
    warn.mockRestore();
  });

  it("a rate-limited re-check (429) keeps the list and unlocks without a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    invoke.mockResolvedValue({ data: null, error: { context: { status: 429 } } });
    renderPage();
    await screen.findByText("Streamflix");
    await waitFor(() =>
      expect(screen.queryByText("Checking your transactions…")).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "More actions for Streamflix" })).toBeEnabled();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  // polish-3 F3: wait for the list itself, or the check runs before any row is drawn.
  it("a stream no longer found (gone) is not listed", async () => {
    db.rows = [
      stream({ detected_status: "gone", user_status: "confirmed" }),
      stream({ id: "s2", display_name: "Cloudbox", user_status: "confirmed" }),
    ];
    renderPage();
    expect(await screen.findByText("Cloudbox")).toBeInTheDocument();
    expect(screen.queryByText("Streamflix")).not.toBeInTheDocument();
  });

  // iOS view board: page titles read like Net Worth's (white semibold), not a grey label.
  it("titles the page like Net Worth", async () => {
    renderPage();
    const h1 = await screen.findByRole("heading", { level: 1, name: "Subscriptions" });
    expect(h1).toHaveClass("font-semibold", "text-foreground");
  });

  it("lists a review queue and totals only active streams", async () => {
    renderPage();
    const queue = await screen.findByRole("region", { name: "To review" });
    expect(within(queue).getByText("To review (1)")).toBeInTheDocument();
    expect(within(queue).getByText("Cloudbox")).toBeInTheDocument();
    expect(within(queue).getByText("Monthly · 3 charges")).toBeInTheDocument();
    expect(screen.getByLabelText("Estimated monthly cost")).toHaveTextContent("€10.00");
  });

  // iOS view (fonts): one way to write a monthly amount, "€10.00/mo" (as in the found dialog).
  it("writes a monthly amount with no space before /mo", async () => {
    renderPage();
    const queue = await screen.findByRole("region", { name: "To review" });
    expect(within(queue).getByText(/\/mo$/).parentElement).toHaveTextContent(/€[\d.,]+\/mo$/);
  });

  it("hides the queue when nothing needs review and shows the empty state without streams", async () => {
    db.rows = [];
    renderPage();
    expect(await screen.findByText("No subscription charges found yet.")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "To review" })).toBeNull();
    // e2e #13: no lone dash (a white bar in the big font) above the empty state.
    expect(screen.queryByLabelText("Estimated monthly cost")).toBeNull();
  });

  it("Confirm calls the rpc and moves the stream to the active total", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Confirm Cloudbox" }));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith("stream_action", {
        p_stream: "s2",
        p_action: "confirm",
        p_args: {},
      }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Estimated monthly cost")).toHaveTextContent("€15.00"),
    );
    expect(screen.queryByRole("region", { name: "To review" })).toBeNull();
  });

  it("Not a subscription dismisses, and the Undo toast restores the stream", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Cloudbox is not a subscription" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "To review" })).toBeNull());
    expect(screen.getByText("Dismissed (1)")).toBeInTheDocument();
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith("stream_action", {
        p_stream: "s2",
        p_action: "dismiss",
        p_args: {},
      }),
    );
    await waitFor(() => expect(toast.success).toHaveBeenCalled());

    toast.success.mock.calls[0]![1].action.onClick();
    await waitFor(() => expect(screen.getByText("Cloudbox")).toBeInTheDocument());
    expect(rpc).toHaveBeenLastCalledWith("stream_action", {
      p_stream: "s2",
      p_action: "undismiss",
      p_args: {},
    });
  });

  // H127: Undo used to drop a confirmed suggestion back to To review (or hide it when stale).
  // The page shows the status it had before (prev_user_status) at once, before the server answers.
  it("Undo after removing a confirmed suggestion brings it back to the active total", async () => {
    db.rows = [
      stream({
        id: "c1",
        display_name: "Gym",
        detected_status: "suggested",
        user_status: "confirmed",
      }),
    ];
    rpc.mockImplementation((_fn: string, p: { p_action: string }) => {
      if (p.p_action === "undismiss") return new Promise(() => {}); // only the optimistic state shows
      db.rows = db.rows.map((r) => ({
        ...r,
        user_status: "dismissed",
        prev_user_status: "confirmed",
      }));
      return Promise.resolve({ error: null });
    });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "More actions for Gym" }));
    fireEvent.click(await screen.findByRole("button", { name: "Not a subscription" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText("Dismissed (1)")).toBeInTheDocument());
    toast.success.mock.calls[0]![1].action.onClick();
    await waitFor(() => expect(screen.queryByText(/Dismissed \(/)).not.toBeInTheDocument());
    expect(screen.queryByRole("region", { name: "To review" })).toBeNull();
    expect(screen.getByLabelText("Estimated monthly cost")).toHaveTextContent("€10.00");
  });

  it("the trash button dismisses an active stream with an Undo toast", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "More actions for Streamflix" }));
    fireEvent.click(await screen.findByRole("button", { name: "Not a subscription" }));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Removed Streamflix", expect.anything()),
    );
    expect(screen.queryByLabelText("Estimated monthly cost")).toBeNull();
  });

  // Swipe actions (Marco 2026-11-28): the trash icon became "Not a subscription" behind the row,
  // next to "I cancelled it", which moves a subscription to Stopped now, with Undo.
  // fails_when=the trash is back, I cancelled it sends nothing or doesn't move the row, or Undo is missing
  it("has no trash button on a row any more", async () => {
    renderPage();
    await screen.findByRole("button", { name: "More actions for Streamflix" });
    expect(screen.queryByRole("button", { name: /^Remove / })).toBeNull();
  });

  it("I cancelled it moves the row to Stopped, and Undo puts it back", async () => {
    serverApplies((action) => ({
      cancelled_on: action === "cancel" ? "2100-01-01" : null,
    }));
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "More actions for Streamflix" }));
    fireEvent.click(await screen.findByRole("button", { name: "I cancelled it" }));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith("stream_action", {
        p_stream: "s1",
        p_action: "cancel",
        p_args: {},
      }),
    );
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Streamflix moved to Stopped", expect.anything()),
    );
    expect(await screen.findByText("Stopped (1)")).toBeInTheDocument();
    expect(screen.queryByLabelText("Estimated monthly cost")).toBeNull();
    const undo = (toast.success.mock.calls[0]![1] as { action: { onClick: () => void } }).action;
    act(() => undo.onClick());
    await waitFor(() =>
      expect(rpc).toHaveBeenLastCalledWith("stream_action", {
        p_stream: "s1",
        p_action: "uncancel",
        p_args: {},
      }),
    );
    await waitFor(() => expect(screen.queryByText("Stopped (1)")).toBeNull());
  });

  it("a cancelled row in Stopped offers Still active; one that stopped by itself has no cancel", async () => {
    db.rows = [
      stream({
        id: "c",
        display_name: "Gym",
        user_status: "confirmed",
        cancelled_on: "2100-01-01",
      }),
      stream({ id: "o", display_name: "Oldfix", last_charged: "2020-01-01" }),
    ];
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "More actions for Gym" }));
    fireEvent.click(await screen.findByRole("button", { name: "Still active" }));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith("stream_action", {
        p_stream: "c",
        p_action: "uncancel",
        p_args: {},
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "More actions for Oldfix" }));
    expect(await screen.findByRole("button", { name: "Not a subscription" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "I cancelled it" })).toBeNull();
  });

  it("on a phone a row swipes left to show its actions", async () => {
    renderPage();
    const trigger = await screen.findByRole("button", { name: "More actions for Streamflix" });
    await waitFor(() => expect(trigger).toBeEnabled());
    expect(screen.queryByRole("button", { name: "I cancelled it" })).toBeNull();
    const row = trigger.closest("li")!;
    const pt = (x: number) => ({ touches: [{ clientX: x, clientY: 100 }] });
    fireEvent.touchStart(row, pt(300));
    fireEvent.touchMove(row, pt(220));
    fireEvent.touchMove(row, pt(100));
    fireEvent.touchEnd(row, { touches: [], changedTouches: [{ clientX: 100, clientY: 100 }] });
    // The click the browser sends after the swipe is the gesture's, not a tap.
    fireEvent.click(row);
    expect(within(row).getByRole("button", { name: "Not a subscription" })).toBeInTheDocument();
    fireEvent.click(within(row).getByRole("button", { name: "I cancelled it" }));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith("stream_action", {
        p_stream: "s1",
        p_action: "cancel",
        p_args: {},
      }),
    );
  });

  it("a long press opens the same actions as a menu", async () => {
    renderPage();
    const trigger = await screen.findByRole("button", { name: "More actions for Streamflix" });
    await waitFor(() => expect(trigger).toBeEnabled());
    vi.useFakeTimers();
    fireEvent.touchStart(trigger.closest("li")!, { touches: [{ clientX: 200, clientY: 100 }] });
    act(() => vi.advanceTimersByTime(500));
    vi.useRealTimers();
    const menu = screen.getByRole("menu", { name: "Actions for Streamflix" });
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((b) => b.textContent),
    ).toEqual(["Not a subscription", "I cancelled it"]);
  });

  it("a preset frequency sends the lowercase cadence", async () => {
    renderPage();
    fireEvent.click(await screen.findByTitle("Monthly — auto-detected"));
    fireEvent.click(await screen.findByRole("button", { name: "Yearly" }));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith("stream_action", {
        p_stream: "s1",
        p_action: "set_cadence",
        p_args: { cadence: "yearly" },
      }),
    );
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Billing frequency saved"));
  });

  it("a custom frequency sends custom_value and custom_unit", async () => {
    renderPage();
    fireEvent.click(await screen.findByTitle("Monthly — auto-detected"));
    fireEvent.click(await screen.findByRole("button", { name: /Custom/ }));
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "2" } });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "weeks" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith("stream_action", {
        p_stream: "s1",
        p_action: "set_cadence",
        p_args: { custom_value: 2, custom_unit: "weeks" },
      }),
    );
  });

  it("rolls back and reports when the rpc fails", async () => {
    rpc.mockResolvedValue({ error: new Error("nope") });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Confirm Cloudbox" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(await screen.findByRole("region", { name: "To review" })).toBeInTheDocument();
  });

  it("shows stopped streams outside the total", async () => {
    db.rows = [stream({ last_charged: "2020-01-01", next_expected: "2020-02-01" })];
    renderPage();
    expect(await screen.findByText("Stopped (1)")).toBeInTheDocument();
    expect(screen.queryByLabelText("Estimated monthly cost")).toBeNull();
  });

  // polish-4 #7: charges marked One-time move a stream to Stopped, where "No recent charge." was
  // untrue. fails_when=the hint claims there was no recent charge at all
  it("explains Stopped as no recent subscription charge", async () => {
    db.rows = [stream({ last_charged: "2020-01-01", next_expected: "2020-02-01" })];
    renderPage();
    expect(
      await screen.findByText("No recent subscription charge. Not counted."),
    ).toBeInTheDocument();
    expect(screen.queryByText("No recent charge. Not counted.")).toBeNull();
  });

  it("shows the native amount for a non-EUR stream and a dash without a monthly amount", async () => {
    db.rows = [
      stream({ currency: "USD", typical_amount: 12, typical_amount_eur: 11 }),
      stream({ id: "s3", display_name: "Mystery", cadence: null }),
    ];
    renderPage();
    expect(await screen.findByText(/\$12\.00/)).toBeInTheDocument();
    expect(screen.getByText("Mystery")).toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("shows an error when the streams can't be loaded", async () => {
    db.error = new Error("boom");
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
    // H128: the failed load also said "No subscription charges found yet." as if there were none.
    expect(screen.queryByText(/No subscription charges found yet/)).toBeNull();
    expect(screen.queryByText(/No active subscriptions/)).toBeNull();
  });

  it("shows the pencil only for a manual cadence, not after plain Confirm", async () => {
    db.rows = [
      stream({ user_status: "confirmed" }),
      stream({ id: "s4", display_name: "Manualbox", user_cadence: "monthly" }),
    ];
    renderPage();
    expect(await screen.findByTitle("Monthly — auto-detected")).toBeInTheDocument();
    expect(screen.getByTitle("Monthly — manually set")).toBeInTheDocument();
  });

  it("rejects an out-of-range custom interval", async () => {
    renderPage();
    fireEvent.click(await screen.findByTitle("Monthly — auto-detected"));
    fireEvent.click(await screen.findByRole("button", { name: /Custom/ }));
    fireEvent.change(screen.getByLabelText("Interval"), { target: { value: "1000" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.change(screen.getByLabelText("Interval"), { target: { value: "1.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(rpc).not.toHaveBeenCalled();
  });

  it("refetches only after the last of several in-flight actions settles", async () => {
    const resolvers: Array<() => void> = [];
    rpc.mockImplementation(() => new Promise((res) => resolvers.push(() => res({ error: null }))));
    db.rows = [stream({ id: "a", display_name: "Aaa" }), stream({ id: "b", display_name: "Bbb" })];
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const spy = vi.spyOn(client, "invalidateQueries");
    render(
      <QueryClientProvider client={client}>
        <Page />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1)); // the re-check on open
    spy.mockClear();
    fireEvent.click(await screen.findByRole("button", { name: "More actions for Aaa" }));
    fireEvent.click(await screen.findByRole("button", { name: "Not a subscription" }));
    fireEvent.click(await screen.findByRole("button", { name: "More actions for Bbb" }));
    fireEvent.click(await screen.findByRole("button", { name: "Not a subscription" }));
    await waitFor(() => expect(resolvers).toHaveLength(2));
    resolvers[0]!();
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    expect(spy).not.toHaveBeenCalled();
    resolvers[1]!();
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
  });

  describe("Dismissed section", () => {
    it("is hidden when nothing is dismissed", async () => {
      renderPage();
      await screen.findByText("Streamflix");
      expect(screen.queryByText(/Dismissed \(/)).not.toBeInTheDocument();
    });

    it("lists dismissed streams by the name shown, not the bank's raw text", async () => {
      db.rows = [
        stream({ id: "d1", display_name: "PAYPAL *ALPHA", user_status: "dismissed" }),
        stream({ id: "d2", display_name: "Mango", user_status: "dismissed" }),
      ];
      renderPage();
      expect(await screen.findByText("Dismissed (2)")).toBeInTheDocument();
      const restores = screen.getAllByRole("button", { name: /^Restore / });
      expect(restores.map((b) => b.getAttribute("aria-label"))).toEqual([
        "Restore ALPHA",
        "Restore Mango",
      ]);
    });

    it("Restore returns a detected stream to Active", async () => {
      db.rows = [stream({ id: "d1", display_name: "Oldplan", user_status: "dismissed" })];
      renderPage();
      expect(await screen.findByText("Dismissed (1)")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Restore Oldplan" }));
      await waitFor(() =>
        expect(rpc).toHaveBeenCalledWith("stream_action", {
          p_stream: "d1",
          p_action: "undismiss",
          p_args: {},
        }),
      );
      await waitFor(() => expect(screen.queryByText(/Dismissed \(/)).not.toBeInTheDocument());
      expect(screen.getByText("Oldplan")).toBeInTheDocument();
      expect(screen.getByLabelText("Estimated monthly cost")).toHaveTextContent("€10.00");
    });

    it("Restore returns a suggested stream to To review", async () => {
      db.rows = [
        stream({
          id: "d4",
          display_name: "Maybe",
          detected_status: "suggested",
          user_status: "dismissed",
        }),
      ];
      renderPage();
      fireEvent.click(await screen.findByRole("button", { name: "Restore Maybe" }));
      const queue = await screen.findByRole("region", { name: "To review" });
      expect(within(queue).getByText("Maybe")).toBeInTheDocument();
    });

    it("Restore of a row with no detected status confirms it into Active", async () => {
      db.rows = [
        stream({
          id: "d5",
          display_name: "Manual",
          detected_status: null,
          user_status: "dismissed",
        }),
      ];
      renderPage();
      fireEvent.click(await screen.findByRole("button", { name: "Restore Manual" }));
      await waitFor(() => expect(screen.queryByText(/Dismissed \(/)).not.toBeInTheDocument());
      expect(screen.getByText("Manual")).toBeInTheDocument();
      expect(screen.queryByRole("region", { name: "To review" })).toBeNull();
      expect(screen.getByLabelText("Estimated monthly cost")).toHaveTextContent("€10.00");
    });

    it("null cadence shows no cost and no picker", async () => {
      db.rows = [
        stream({
          id: "d2",
          display_name: "Mystery",
          user_status: "dismissed",
          cadence: null,
          typical_amount_eur: 0,
        }),
      ];
      renderPage();
      const row = (await screen.findByText("Mystery")).closest("li")!;
      expect(row).not.toHaveTextContent("€");
      expect(within(row).queryByText("Set frequency")).not.toBeInTheDocument();
      expect(within(row).getByRole("button", { name: "Restore Mystery" })).toBeInTheDocument();
    });

    it("known cadence shows the monthly cost", async () => {
      db.rows = [stream({ id: "d3", display_name: "Oldplan", user_status: "dismissed" })];
      renderPage();
      const row = (await screen.findByText("Oldplan")).closest("li")!;
      expect(row).toHaveTextContent("€10.00");
    });
  });

  it("monthly total shows a dash when no active stream has a frequency", async () => {
    db.rows = [stream({ cadence: null })];
    renderPage();
    await screen.findByText("Streamflix");
    const total = screen.getByLabelText("Estimated monthly cost");
    expect(total).toHaveTextContent("—");
    expect(total).not.toHaveTextContent("€0.00");
  });

  it("monthly total adds a note for streams without a frequency", async () => {
    db.rows = [stream({}), stream({ id: "s9", display_name: "Nofreq", cadence: null })];
    renderPage();
    await screen.findByText("Nofreq");
    const total = screen.getByLabelText("Estimated monthly cost");
    expect(total).toHaveTextContent("€10.00");
    expect(total).toHaveTextContent("+ 1 without a frequency");
  });
});

// protects=the calendar is one tap from the list; fails_when=the view switch is gone or the list stays
describe("List / Calendar", () => {
  beforeEach(() => {
    db.rows = [stream({})];
    db.error = null;
  });

  it("switches to the calendar and back", async () => {
    renderPage();
    await screen.findByText("Streamflix");
    fireEvent.click(screen.getByRole("radio", { name: "Calendar" }));
    expect(await screen.findByRole("region", { name: "Recurring calendar" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "More actions for Streamflix" })).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "List" }));
    expect(await screen.findByRole("button", { name: "More actions for Streamflix" })).toBeTruthy();
  });

  // Polish 4 #10: the view and month live in the URL, so Back returns to the list, a reload or a
  // shared link opens the same month, and switching away and back keeps the month.
  it("keeps the view and month in the URL", async () => {
    url.search = { view: "calendar", month: "2026-12" };
    renderPage();
    expect(await screen.findByRole("table", { name: "December 2026" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next month" }));
    expect(navigate).toHaveBeenLastCalledWith(expect.objectContaining({ replace: true }));
    expect(url.search).toEqual({ view: "calendar", month: "2027-01" });
    fireEvent.click(screen.getByRole("radio", { name: "List" }));
    expect(navigate.mock.lastCall![0].replace).toBeFalsy(); // a new history entry: Back undoes it
    expect(url.search).toEqual({ month: "2027-01" });
    fireEvent.click(screen.getByRole("radio", { name: "Calendar" }));
    expect(await screen.findByRole("table", { name: "January 2027" })).toBeTruthy();
  });

  it("ignores a view or month it doesn't know", () => {
    const validate = Route.options.validateSearch as (s: Record<string, unknown>) => unknown;
    expect(validate({ view: "calendar", month: "2026-12" })).toEqual({
      view: "calendar",
      month: "2026-12",
    });
    expect(validate({ view: "grid", month: "2026-13" })).toEqual({});
    expect(validate({ month: "1969-12" })).toEqual({});
  });

  // Polish 5 A: the router hands the page the raw URL search, so a month validateSearch dropped
  // still arrives here; the page must fall back to this month, not "Invalid Date" or month 13.
  it("opens this month when the URL's month is invalid", async () => {
    url.search = { view: "calendar" };
    const { unmount } = renderPage();
    const thisMonth = (await screen.findByRole("table")).getAttribute("aria-label");
    unmount();
    for (const month of ["abc", "2026-13", "1969-12", "2026-1"]) {
      url.search = { view: "calendar", month };
      const { unmount: done } = renderPage();
      expect((await screen.findByRole("table")).getAttribute("aria-label")).toBe(thisMonth);
      expect(screen.queryByText(/Invalid Date/)).toBeNull();
      done();
    }
  });

  // Polish 3 #12: only active subscriptions are bills; to-review and dismissed ones are not.
  it("puts only active subscriptions on the calendar", async () => {
    const now = new Date();
    const due = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-15`;
    db.rows = [
      stream({ next_expected: due }),
      stream({
        id: "s2",
        display_name: "Cloudbox",
        detected_status: "suggested",
        next_expected: due,
      }),
      stream({ id: "s3", display_name: "Gonebox", user_status: "dismissed", next_expected: due }),
    ];
    renderPage();
    await screen.findByText("Streamflix");
    fireEvent.click(screen.getByRole("radio", { name: "Calendar" }));
    const cell = await screen.findByRole("cell", { name: /Streamflix/ });
    expect(cell.getAttribute("aria-label")).not.toMatch(/Cloudbox|Gonebox/);
    const grid = screen.getByRole("table");
    expect(grid.innerHTML).not.toMatch(/Cloudbox|Gonebox/);
  });
});

// polish-4 #1: the status line flashed on every open (~125 ms) and dimmed every action. Now the
// lock starts at once but the text and the dim wait ~300 ms. fails_when=the text shows (or the
// actions unlock) before 300 ms, or the text stays after the check settles
describe("Checking status", () => {
  afterEach(() => vi.useRealTimers());
  const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
  const CHECKING = "Checking your transactions…";
  const holdCheck = () => {
    let finish!: () => void;
    invoke.mockImplementation(
      () => new Promise((res) => (finish = () => res({ data: { streams: 2 }, error: null }))),
    );
    return () => finish();
  };

  it("under 300 ms: no text, no dim, but the actions are already locked", async () => {
    vi.useFakeTimers();
    holdCheck();
    renderPage();
    await advance(0);
    const content = screen.getByTestId("subscriptions-content");
    expect(screen.getByRole("button", { name: "More actions for Streamflix" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Confirm Cloudbox" })).toBeDisabled();
    expect(content).toHaveAttribute("aria-busy", "true");
    await advance(290);
    expect(screen.queryByText(CHECKING)).not.toBeInTheDocument();
    expect(content).toHaveClass("[&_:disabled]:!opacity-100");
  });

  it("from 300 ms: says it's checking your transactions and dims the locked actions", async () => {
    vi.useFakeTimers();
    holdCheck();
    renderPage();
    await advance(300);
    const line = screen.getByText(CHECKING);
    expect(line).not.toHaveAttribute("aria-live");
    expect(screen.getByTestId("subscriptions-content")).not.toHaveClass(
      "[&_:disabled]:!opacity-100",
    );
    expect(screen.getByRole("button", { name: "More actions for Streamflix" })).toBeDisabled();
  });

  it("sits under the List/Calendar switch, next to what it blocks", async () => {
    vi.useFakeTimers();
    holdCheck();
    renderPage();
    await advance(300);
    const view = screen.getByRole("radiogroup", { name: "View" });
    const line = screen.getByText(CHECKING);
    expect(view.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("banner")).not.toContainElement(line);
  });

  it("is gone, and the actions unlock, once the check settles", async () => {
    vi.useFakeTimers();
    const finish = holdCheck();
    renderPage();
    await advance(400);
    expect(screen.getByText(CHECKING)).toBeInTheDocument();
    finish();
    await advance(50);
    expect(screen.queryByText(CHECKING)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "More actions for Streamflix" })).toBeEnabled();
    expect(screen.getByTestId("subscriptions-content")).toHaveAttribute("aria-busy", "false");
    // #1b: outside a check, controls a later action disables dim as usual (no override).
    expect(screen.getByTestId("subscriptions-content")).not.toHaveClass(
      "[&_:disabled]:!opacity-100",
    );
  });

  it("a check that settles under 300 ms never shows the text", async () => {
    vi.useFakeTimers();
    const finish = holdCheck();
    renderPage();
    await advance(100);
    finish();
    await advance(500);
    expect(screen.queryByText(CHECKING)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "More actions for Streamflix" })).toBeEnabled();
    expect(screen.getByTestId("subscriptions-content")).not.toHaveClass(
      "[&_:disabled]:!opacity-100",
    );
  });

  it("marks the calendar busy too while checking, and not once settled", async () => {
    vi.useFakeTimers();
    url.search = { view: "calendar" };
    const finish = holdCheck();
    renderPage();
    await advance(0);
    const cal = screen.getByTestId("subscriptions-calendar");
    expect(cal).toHaveAttribute("aria-busy", "true");
    finish();
    await advance(50);
    expect(cal).toHaveAttribute("aria-busy", "false");
  });
});

// polish-4 #2: a locked frequency picker still lit up on hover and showed its tooltip, so it looked
// clickable. fails_when=the locked picker still takes the pointer, like the shared Button doesn't
describe("Locked frequency picker", () => {
  it("takes no pointer while disabled, like the shared Button", async () => {
    invoke.mockImplementation(() => new Promise(() => {}));
    renderPage();
    const picker = await screen.findByTitle("Monthly — auto-detected");
    expect(picker).toBeDisabled();
    expect(picker).toHaveClass("disabled:pointer-events-none");
  });
});

// polish-4 #8: inside the server's 5 s window (429) the list kept the saved data while the
// calendar already showed the change. fails_when=a 429 isn't retried once after the window, or the
// retry still goes out after the page has closed
describe("Re-check after a rate limit", () => {
  // Drop any once-answers a test left unused (clearAllMocks keeps them).
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue({ data: { streams: 2 }, error: null });
  });
  afterEach(() => vi.useRealTimers());
  const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
  const limitedThenRenamed = () =>
    invoke
      .mockResolvedValueOnce({ data: null, error: { context: { status: 429 } } })
      .mockImplementationOnce(async () => {
        db.rows = db.rows.map((r) => (r["id"] === "s1" ? { ...r, display_name: "iCloud" } : r));
        return { data: { streams: 2 }, error: null };
      });

  it("retries once after the window and shows the fresh list", async () => {
    vi.useFakeTimers();
    limitedThenRenamed();
    renderPage();
    await advance(100);
    expect(screen.getByText("Streamflix")).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledTimes(1);
    await advance(5_000);
    await advance(100);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(screen.getByText("iCloud")).toBeInTheDocument();
    await advance(10_000);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("sends no retry once the page has closed", async () => {
    vi.useFakeTimers();
    limitedThenRenamed();
    const { unmount } = renderPage();
    await advance(100);
    unmount();
    await advance(10_000);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("sends no retry when the page closes before the 429 comes back", async () => {
    vi.useFakeTimers();
    let answer!: () => void;
    invoke.mockImplementationOnce(
      () =>
        new Promise((res) => {
          answer = () => res({ data: null, error: { context: { status: 429 } } });
        }),
    );
    const { unmount } = renderPage();
    await advance(10);
    unmount();
    answer();
    await advance(10_000);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("doesn't retry a check that ran, or one that failed for another reason", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    invoke.mockResolvedValueOnce({ data: null, error: new Error("FunctionsFetchError") });
    renderPage();
    await advance(10_000);
    expect(invoke).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

// polish-4 #9: when the re-check removed a row it vanished with no word, and removing the last
// active stream also dropped the total block (~125 px jump). fails_when=a changed list gets no
// "Updated" note (or an unchanged one does), the note never goes, or the total block disappears
// mid-visit
describe("After a re-check that changed the list", () => {
  afterEach(() => vi.useRealTimers());
  const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
  const checkRemoves = (id: string) =>
    invoke.mockImplementation(async () => {
      db.rows = db.rows.filter((r) => r["id"] !== id);
      return { data: { streams: 1 }, error: null };
    });

  it("says Updated for about 3 s", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    invoke.mockImplementation(
      () =>
        new Promise((res) => {
          finish = () => {
            db.rows = db.rows.filter((r) => r["id"] !== "s2");
            res({ data: { streams: 1 }, error: null });
          };
        }),
    );
    renderPage();
    await advance(50);
    expect(screen.getByText("Cloudbox")).toBeInTheDocument();
    finish();
    await advance(50);
    expect(screen.queryByText("Cloudbox")).not.toBeInTheDocument();
    expect(screen.getByText("Updated")).toBeInTheDocument();
    await advance(2_900);
    expect(screen.getByText("Updated")).toBeInTheDocument();
    await advance(200);
    expect(screen.queryByText("Updated")).not.toBeInTheDocument();
  });

  it("says nothing when the check changed nothing", async () => {
    vi.useFakeTimers();
    renderPage();
    await advance(100);
    expect(screen.getByRole("button", { name: "More actions for Streamflix" })).toBeEnabled();
    expect(screen.queryByText("Updated")).not.toBeInTheDocument();
  });

  it("keeps the total block, at €0, when the last active stream goes", async () => {
    db.rows = [stream({ user_status: "confirmed" })];
    db.rows.push(stream({ id: "s3", display_name: "Oldtube", user_status: "dismissed" }));
    let finish!: () => void;
    invoke.mockImplementation(
      () =>
        new Promise((res) => {
          finish = () => {
            db.rows = db.rows.filter((r) => r["id"] !== "s1");
            res({ data: { streams: 1 }, error: null });
          };
        }),
    );
    renderPage();
    expect(await screen.findByText("~€10.00")).toBeInTheDocument();
    finish();
    await waitFor(() => expect(screen.queryByText("Streamflix")).not.toBeInTheDocument());
    const total = screen.getByLabelText("Estimated monthly cost");
    expect(total).toHaveTextContent("€0.00");
    expect(total).not.toHaveTextContent("—");
  });

  it("still leaves the total out on a visit that never had an active stream", async () => {
    db.rows = [stream({ id: "s3", display_name: "Oldtube", user_status: "dismissed" })];
    checkRemoves("none");
    renderPage();
    await screen.findByText("Dismissed (1)");
    expect(screen.queryByLabelText("Estimated monthly cost")).toBeNull();
  });
});

// polish-4 #10: "No subscription charges found yet." showed while To review or Dismissed still
// had rows. fails_when=the first-run empty state shows beside other groups, or an empty active
// list says nothing
describe("Empty active list", () => {
  it("says no active subscriptions when other groups still have rows", async () => {
    db.rows = [
      stream({ id: "s2", display_name: "Cloudbox", detected_status: "suggested" }),
      stream({ id: "s3", display_name: "Oldtube", user_status: "dismissed" }),
    ];
    renderPage();
    expect(await screen.findByText("No active subscriptions right now.")).toBeInTheDocument();
    expect(screen.queryByText("No subscription charges found yet.")).toBeNull();
  });

  it("keeps the first-run empty state when every group is empty", async () => {
    db.rows = [];
    renderPage();
    expect(await screen.findByText("No subscription charges found yet.")).toBeInTheDocument();
    expect(screen.queryByText("No active subscriptions right now.")).toBeNull();
  });
});
