import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toast } from "sonner";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const { rows, review, reviewCalls, reviewError, path, search } = vi.hoisted(() => ({
  rows: { current: [] as Array<unknown> },
  // Splitwise expenses waiting on the To link list.
  review: { current: [] as Array<unknown> },
  // What the splitwise_review reads were asked for, and an error to answer with.
  reviewCalls: { current: [] as Array<unknown> },
  reviewError: { current: null as unknown },
  path: { current: "/" },
  search: { current: {} as Record<string, unknown> },
}));
// H018: what sign-out did, in order. H135: what signOut was asked, what it answers, and whether a
// session is still stored afterwards.
// The layout's navigate and the router's history Back, for the phone Back button.
const nav = vi.hoisted(() => ({ navigate: vi.fn(), back: vi.fn() }));
const signOutSteps = vi.hoisted(() => [] as string[]);
const auth = vi.hoisted(() => ({
  args: [] as Array<unknown>,
  error: null as null | { message: string },
  sessionLeft: false,
}));
vi.mock("@/components/push-subscribe", () => ({
  PushSubscribeButton: () => null,
  pushSupport: () => "unsupported",
  forgetThisBrowserPush: async () => {
    signOutSteps.push("forget push");
  },
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    options,
    useRouteContext: () => ({ user: { email: "a@example.com" } }),
  }),
  Link: ({
    children,
    to,
    search: query,
    replace,
    onClick,
    "aria-current": current,
  }: {
    children: React.ReactNode;
    to: string;
    search?: Record<string, string>;
    replace?: boolean;
    onClick?: React.MouseEventHandler;
    "aria-current"?: "page";
  }) => (
    <a
      href={query && Object.keys(query).length ? `${to}?${new URLSearchParams(query)}` : to}
      onClick={onClick}
      aria-current={current}
      data-replace={replace ? "true" : undefined}
    >
      {children}
    </a>
  ),
  Outlet: () => null,
  redirect: vi.fn(),
  useNavigate: () => nav.navigate,
  useRouter: () => ({ history: { back: nav.back } }),
  useRouterState: ({
    select,
  }: {
    select: (s: { location: { pathname: string; search: Record<string, unknown> } }) => unknown;
  }) => select({ location: { pathname: path.current, search: search.current } }),
}));
vi.mock("@/integrations/supabase/client", () => ({
  loadDemoClient: vi.fn(),
  supabase: {
    auth: {
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: vi.fn() } } }),
      signOut: async (opts?: unknown) => {
        signOutSteps.push("sign out");
        auth.args.push(opts);
        return { error: auth.error };
      },
      getSession: async () => ({
        data: { session: auth.sessionLeft ? { access_token: "t" } : null },
        error: null,
      }),
    },
    rpc: () => Promise.resolve({ error: null }),
    from: (table: string) =>
      table === "splitwise_review"
        ? {
            select: (...args: Array<unknown>) => {
              reviewCalls.current.push(args);
              const q: Record<string, unknown> = {};
              for (const m of ["eq", "order", "limit"]) q[m] = () => q;
              q["then"] = (resolve: (v: unknown) => void) =>
                resolve(
                  reviewError.current
                    ? { data: null, error: reviewError.current, count: null }
                    : { data: review.current, error: null, count: review.current.length },
                );
              return q;
            },
          }
        : { select: () => Promise.resolve({ data: rows.current, error: null }) },
  },
}));

import { Route, MORE_GROUPS, TAB_BAR_ITEMS, isTabPath, phoneParent, phoneTitle } from "./route";

const Layout = Route.options.component as () => React.JSX.Element;
const suggested = (id: string) => ({
  id,
  detected_status: "suggested",
  user_status: null,
  cadence: "monthly",
  next_expected: "2099-01-01",
  last_charged: "2098-12-01",
});

const renderLayout = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Layout />
    </QueryClientProvider>,
  );

describe("nav badge", () => {
  it("shows the to-review count on Subscriptions (sidebar and menu)", async () => {
    rows.current = [
      suggested("a"),
      suggested("b"),
      { ...suggested("c"), user_status: "confirmed" },
    ];
    renderLayout();
    const pills = await screen.findAllByText("to review");
    // sidebar, mobile More tab, and menu sheet
    expect(pills.length).toBeGreaterThanOrEqual(2);
    pills.forEach((p) => expect(p.parentElement).toHaveTextContent("2 to review"));
    expect(screen.getByRole("button", { name: "More, 2 to review" })).toBeTruthy();
  });

  it("shows no badge when nothing is to review", async () => {
    rows.current = [{ ...suggested("a"), user_status: "confirmed" }];
    renderLayout();
    await screen.findAllByText("Subscriptions");
    await new Promise((r) => setTimeout(r, 20)); // let the query settle
    expect(screen.queryByText("to review")).toBeNull();
    expect(screen.getByRole("button", { name: "More" })).toBeTruthy();
  });
});

// polish-4 #22: To link needs action, so its count shows outside the page too
describe("Who owes you badge", () => {
  it("shows the To link count on Who owes you and adds it to More", async () => {
    rows.current = [suggested("a"), suggested("b")];
    review.current = [{ id: "r1" }, { id: "r2" }, { id: "r3" }];
    try {
      renderLayout();
      const links = await screen.findAllByRole("link", { name: /^Who owes you/ });
      await waitFor(() => expect(links[0]).toHaveTextContent("Who owes you3 to review"));
      expect(await screen.findByRole("button", { name: "More, 5 to review" })).toBeTruthy();
    } finally {
      review.current = [];
    }
  });

  it("shows none when nothing waits", async () => {
    rows.current = [];
    renderLayout();
    const links = await screen.findAllByRole("link", { name: /^Who owes you/ });
    await new Promise((r) => setTimeout(r, 20)); // let the queries settle
    expect(links[0]).toHaveTextContent(/^Who owes you$/);
    expect(screen.getByRole("button", { name: "More" })).toBeTruthy();
  });
});

// re-audit N4: the badge reads a head-only count, and an older backend without the table is quiet
describe("Who owes you badge query", () => {
  it("asks for the count only, never the rows", async () => {
    reviewCalls.current = [];
    review.current = [{ id: "r1" }];
    try {
      renderLayout();
      const links = await screen.findAllByRole("link", { name: /^Who owes you/ });
      await waitFor(() => expect(links[0]).toHaveTextContent("Who owes you1 to review"));
      expect(reviewCalls.current).toEqual([["id", { count: "exact", head: true }]]);
    } finally {
      review.current = [];
    }
  });

  it("shows no badge and asks once when the backend has no such table", async () => {
    reviewCalls.current = [];
    reviewError.current = { code: "PGRST205", message: "Could not find the table" };
    try {
      renderLayout();
      const links = await screen.findAllByRole("link", { name: /^Who owes you/ });
      await new Promise((r) => setTimeout(r, 50));
      expect(links[0]).toHaveTextContent(/^Who owes you$/);
      expect(reviewCalls.current).toHaveLength(1);
    } finally {
      reviewError.current = null;
    }
  });
});

describe("sidebar icons", () => {
  it("puts a line icon beside every sidebar entry, Settings and Sign out included", () => {
    rows.current = [];
    renderLayout();
    const aside = document.querySelector("aside")!;
    for (const label of ["Net Worth", "Accounts", "Crypto", "Settings"]) {
      const link = [...aside.querySelectorAll("a")].find((a) => a.textContent?.includes(label))!;
      expect(link.querySelector("svg")).not.toBeNull();
    }
    const signOut = [...aside.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Sign out"),
    )!;
    expect(signOut.querySelector("svg")).not.toBeNull();
  });
});

describe("sign out", () => {
  it("H018 removes this browser's notifications before signing out", async () => {
    rows.current = [];
    renderLayout();
    const aside = document.querySelector("aside")!;
    fireEvent.click(within(aside).getByRole("button", { name: /Sign out/ }));
    await waitFor(() => expect(signOutSteps).toEqual(["forget push", "sign out"]));
  });

  // H135: sign-out used the default global scope (every device signed out, and an offline
  // sign-out kept the session) and ignored the error, so the user was bounced back in.
  it("signs out this device only", async () => {
    auth.args.length = 0;
    rows.current = [];
    renderLayout();
    fireEvent.click(
      within(document.querySelector("aside")!).getByRole("button", { name: /Sign out/ }),
    );
    await waitFor(() => expect(auth.args).toEqual([{ scope: "local" }]));
  });

  it("says so and lets the user try again when the session could not be removed", async () => {
    auth.error = { message: "Network down" };
    auth.sessionLeft = true;
    try {
      rows.current = [];
      renderLayout();
      const aside = document.querySelector("aside")!;
      fireEvent.click(within(aside).getByRole("button", { name: /Sign out/ }));
      await waitFor(() =>
        expect(within(aside).getByRole("button", { name: /Sign out/ })).not.toBeDisabled(),
      );
      expect(toast.error).toHaveBeenCalledWith("Couldn't sign out", {
        description: "Network down",
      });
    } finally {
      auth.error = null;
      auth.sessionLeft = false;
    }
  });
});

describe("nav links", () => {
  // protects=a lighter first start: Rules lives in Settings, Cash flow opens from Reports;
  // fails_when=either comes back into the sidebar
  it("keeps Rules and Cash flow out of the sidebar", () => {
    rows.current = [];
    renderLayout();
    const aside = document.querySelector("aside")!;
    const hrefs = [...aside.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).not.toContain("/rules");
    expect(hrefs).not.toContain("/cash-flow");
    expect(hrefs).toContain("/budgets");
  });
});

describe("phone tabs and More", () => {
  const tabBar = () => screen.getByRole("navigation", { name: "Primary" });

  it("has Net Worth, Activity, Spending, Investing and More", () => {
    rows.current = [];
    path.current = "/";
    renderLayout();
    const labels = [...tabBar().querySelectorAll("a, button")].map((el) => el.textContent);
    expect(labels).toEqual(["Net Worth", "Activity", "Spending", "Investing", "More"]);
  });

  // Marco (native feel): the tab bar floats as a pill above the home indicator, and the current
  // tab sits in a soft fill. fails_when=the bar is full width again or the page ends under it
  it("floats as a pill clear of the screen edges, with room left under the page", () => {
    rows.current = [];
    path.current = "/";
    renderLayout();
    expect(tabBar()).toHaveClass("rounded-full", "inset-x-3.5");
    expect(tabBar().className).toContain("bottom-[calc(0.625rem+env(safe-area-inset-bottom))]");
    expect(document.querySelector("main")?.className).toContain(
      "pb-[calc(5.25rem+env(safe-area-inset-bottom))]",
    );
  });

  it("lights Investing on both Portfolio and Crypto", () => {
    rows.current = [];
    for (const p of ["/portfolio", "/crypto"]) {
      path.current = p;
      const { unmount } = renderLayout();
      const current = tabBar().querySelector('[aria-current="page"]');
      expect(current?.textContent).toBe("Investing");
      unmount();
    }
  });

  it("marks no tab as current on a page that lives in More", () => {
    rows.current = [];
    path.current = "/accounts";
    renderLayout();
    expect(tabBar().querySelector('[aria-current="page"]')).toBeNull();
  });

  it("lists in More every page without a tab, Import included, and none twice", () => {
    const tabbed = new Set(TAB_BAR_ITEMS.flatMap((t) => t.owns));
    const more = MORE_GROUPS.flatMap((g) => g.items.map((i) => i.to));
    expect(more).toEqual(
      expect.arrayContaining([
        "/reports",
        "/accounts",
        "/income",
        "/subscriptions",
        "/splitwise",
        "/import",
      ]),
    );
    expect(more).not.toContain("/rules");
    expect(more).not.toContain("/cash-flow");
    expect(more.some((to) => tabbed.has(to))).toBe(false);
    expect(new Set(more).size).toBe(more.length);
  });

  it("drops a group from More when all its pages have a tab", () => {
    expect(MORE_GROUPS.map((g) => g.label)).not.toContain("Investing");
  });

  // protects=the most-used More pages sit under the thumb first; fails_when=sidebar order leaks in
  it("leads More with Accounts, Subscriptions and Who owes you, then Tools apart", () => {
    const [pages, ...rest] = MORE_GROUPS;
    expect(pages!.label).toBe("");
    expect(pages!.items.map((i) => i.label)).toEqual([
      "Accounts",
      "Subscriptions",
      "Who owes you",
      "Reports",
      "Income",
      // Budgets (#139) has no phone tab, so More is where phones reach it.
      "Budgets",
    ]);
    expect(rest.map((g) => g.label)).toEqual(["Tools"]);
  });

  it("titles only the Tools group in the sheet, and ends with Settings and Sign out", () => {
    rows.current = [];
    path.current = "/";
    renderLayout();
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    const sheet = screen.getByRole("navigation", { name: "More" });
    expect([...sheet.querySelectorAll(".ios-section-title")].map((t) => t.textContent)).toEqual([
      "Tools",
    ]);
    const entries = [...sheet.querySelectorAll("a, button")].map((el) => el.textContent);
    expect(entries.slice(-2)).toEqual(["Settings", "Sign out"]);
    expect(sheet).toHaveTextContent("Signed in as a@example.com");
  });

  // polish-4 #E: fails_when=opening More leaves focus on the tab bar behind the overlay
  it("moves focus into the More sheet when it opens", async () => {
    rows.current = [];
    path.current = "/";
    renderLayout();
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    await waitFor(() =>
      expect(screen.getByRole("dialog")).toContainElement(document.activeElement as HTMLElement),
    );
  });
});

// polish-1 #1 (#164): the More sheet adds a history entry; a link that pushed on top of it left a
// Back press that did nothing. fails_when=a More link pushes instead of replacing the sheet's entry
describe("More sheet links", () => {
  it("replace the sheet's history entry, so one Back returns to the page", async () => {
    rows.current = [];
    renderLayout();
    fireEvent.click(screen.getByRole("button", { name: /^More/ }));
    const links = within(await screen.findByRole("dialog")).getAllByRole("link");
    expect(links.length).toBeGreaterThan(2);
    links.forEach((a) => expect(a).toHaveAttribute("data-replace", "true"));
  });
});

// polish-3 #2 (#164): a More link to the page you're on replaced the sheet's entry with the same
// address, so closing the sheet couldn't take its entry out and one Back did nothing.
// fails_when=tapping the current page's link in More still navigates
describe("More sheet link to the current page", () => {
  it("only closes the sheet", async () => {
    rows.current = [];
    path.current = "/settings";
    try {
      renderLayout();
      fireEvent.click(screen.getByRole("button", { name: /^More/ }));
      const sheet = await screen.findByRole("dialog");
      const here = within(sheet).getByRole("link", { name: /Settings/ });
      const other = within(sheet)
        .getAllByRole("link")
        .find((a) => a !== here)!;
      expect(fireEvent.click(here)).toBe(false); // default prevented: no navigation
      fireEvent.click(screen.getByRole("button", { name: /^More/ }));
      const again = await screen.findByRole("dialog");
      expect(fireEvent.click(within(again).getByRole("link", { name: other.textContent! }))).toBe(
        true,
      );
    } finally {
      path.current = "/";
    }
  });
});

// protects=Settings opens as its own screen: its menu replaces the app sidebar, with a way back
// (whiteboard note); fails_when=the app sidebar stays, or Back to app forgets where you were
describe("Settings sidebar", () => {
  it("swaps the app sidebar for the settings menu and goes back to the last app page", async () => {
    rows.current = [];
    path.current = "/budgets";
    try {
      const { rerender } = renderLayout();
      expect(screen.queryByRole("navigation", { name: "Settings" })).toBeNull();
      path.current = "/settings/app";
      rerender(
        <QueryClientProvider client={new QueryClient()}>
          <Layout />
        </QueryClientProvider>,
      );
      const nav = screen.getByRole("navigation", { name: "Settings" });
      expect(within(nav).getByRole("link", { name: "Back to app" })).toHaveAttribute(
        "href",
        "/budgets",
      );
      expect(within(nav).getByRole("link", { name: "Security" })).toBeTruthy();
      expect(within(nav).queryByRole("link", { name: "Net Worth" })).toBeNull();
    } finally {
      path.current = "/";
    }
  });

  // polish-4 C2: a reload inside Settings remounts the layout; Back to app still returns to the
  // filtered page. fails_when=it falls back to "/"
  it("remembers the last app page across a reload inside Settings", () => {
    rows.current = [];
    path.current = "/transactions";
    search.current = { category: "Dine Out" };
    try {
      renderLayout().unmount();
      path.current = "/settings/app";
      search.current = {};
      renderLayout();
      const nav = screen.getByRole("navigation", { name: "Settings" });
      expect(within(nav).getByRole("link", { name: "Back to app" })).toHaveAttribute(
        "href",
        "/transactions?category=Dine+Out",
      );
    } finally {
      path.current = "/";
      search.current = {};
      sessionStorage.clear();
    }
  });

  it.each([
    ["another site", JSON.stringify({ to: "//evil.example", search: {} })],
    ["a backslash path", JSON.stringify({ to: "/\\evil.example", search: {} })],
    ["a control character", JSON.stringify({ to: "/\t/evil.example", search: {} })],
    ["a settings page", JSON.stringify({ to: "/settings/app", search: {} })],
    ["junk", "{"],
  ])("ignores a saved last page that is %s", (_, saved) => {
    rows.current = [];
    sessionStorage.setItem("alopex.lastAppPage", saved);
    path.current = "/settings/app";
    try {
      renderLayout();
      const nav = screen.getByRole("navigation", { name: "Settings" });
      expect(within(nav).getByRole("link", { name: "Back to app" })).toHaveAttribute("href", "/");
    } finally {
      path.current = "/";
      sessionStorage.clear();
    }
  });

  it("still works when the browser blocks session storage", () => {
    rows.current = [];
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    path.current = "/settings/app";
    try {
      renderLayout();
      const nav = screen.getByRole("navigation", { name: "Settings" });
      expect(within(nav).getByRole("link", { name: "Back to app" })).toHaveAttribute("href", "/");
    } finally {
      get.mockRestore();
      set.mockRestore();
      path.current = "/";
    }
  });

  // polish-5 F2: the desktop link goes straight to Overview, so focus lands on the current
  // settings link instead of the redirect's leftover. fails_when=it points at /settings again
  it("sends the desktop Settings link straight to Overview", () => {
    rows.current = [];
    path.current = "/budgets";
    try {
      renderLayout();
      const aside = document.querySelector("aside")!;
      expect(within(aside).getByRole("link", { name: "Settings" })).toHaveAttribute(
        "href",
        "/settings/overview",
      );
    } finally {
      path.current = "/";
    }
  });

  // polish-4 A1: the link you pressed unmounts with the sidebar swap; focus must land in the new
  // menu, not on <body> (WCAG 2.4.3). fails_when=the next Tab skips the settings menu
  it("moves keyboard focus into the menu that replaced the one you used", () => {
    rows.current = [];
    path.current = "/budgets";
    const again = () =>
      rerender(
        <QueryClientProvider client={new QueryClient()}>
          <Layout />
        </QueryClientProvider>,
      );
    const { rerender } = renderLayout();
    try {
      const app = screen.getAllByRole("navigation").find((n) => within(n).queryByText("Budgets"))!;
      within(app).getAllByRole("link")[0]!.focus();
      path.current = "/settings/app";
      again();
      const nav = screen.getByRole("navigation", { name: "Settings" });
      expect(nav).toContainElement(document.activeElement as HTMLElement);
      within(nav).getByRole("link", { name: "Back to app" }).focus();
      path.current = "/budgets";
      again();
      expect(document.activeElement).not.toBe(document.body);
      expect(screen.queryByRole("navigation", { name: "Settings" })).toBeNull();
    } finally {
      path.current = "/";
    }
  });
});

// protects=pages switched off in Settings › App leave the sidebar and More; fails_when=they stay
describe("hidden pages", () => {
  it("drops a hidden page from the sidebar and the More sheet", async () => {
    rows.current = [];
    const { setPageHidden } = await import("@/lib/hidden-pages");
    setPageHidden("/budgets", true);
    try {
      renderLayout();
      await screen.findAllByRole("link", { name: /^Who owes you/ });
      expect(screen.queryByRole("link", { name: "Budgets" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: /^More/ }));
      const sheet = await screen.findByRole("dialog");
      expect(within(sheet).queryByRole("link", { name: "Budgets" })).toBeNull();
      expect(within(sheet).getByRole("link", { name: /Subscriptions/ })).toBeTruthy();
    } finally {
      setPageHidden("/budgets", false);
    }
  });
});

// polish-1 #1: the More tab summed Subscriptions and Who owes you even when hidden, so it showed
// a count no row in the sheet carried. fails_when=a hidden page's badge still reaches More
describe("More badge with hidden pages", () => {
  it("leaves out the count of a page hidden from the menu", async () => {
    rows.current = [suggested("a"), suggested("b")];
    review.current = [{ id: "r1" }, { id: "r2" }, { id: "r3" }];
    const { setPageHidden } = await import("@/lib/hidden-pages");
    setPageHidden("/subscriptions", true);
    try {
      renderLayout();
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "More, 3 to review" })).toBeTruthy(),
      );
      setPageHidden("/splitwise", true);
      await waitFor(() => expect(screen.getByRole("button", { name: "More" })).toBeTruthy());
    } finally {
      setPageHidden("/subscriptions", false);
      setPageHidden("/splitwise", false);
      review.current = [];
    }
  });
});

// polish-1 #4: Back to app dropped the search, so a filtered list came back unfiltered.
// fails_when=the link leaves out the last page's search
describe("Back to app keeps the page's filters", () => {
  it("returns to the last app page with its search", () => {
    rows.current = [];
    path.current = "/transactions";
    search.current = { category: "Groceries" };
    const ui = () => (
      <QueryClientProvider client={new QueryClient()}>
        <Layout />
      </QueryClientProvider>
    );
    try {
      const { rerender } = render(ui());
      path.current = "/settings/app";
      search.current = {};
      rerender(ui());
      const nav = screen.getByRole("navigation", { name: "Settings" });
      expect(within(nav).getByRole("link", { name: "Back to app" })).toHaveAttribute(
        "href",
        "/transactions?category=Groceries",
      );
    } finally {
      path.current = "/";
      search.current = {};
    }
  });
});

// polish-3 #7: Rules is part of Settings (the desktop menu says so), but the More sheet's Settings
// row didn't light up on /rules. fails_when=the row isn't marked current on /rules or /settings/*
describe("More sheet Settings row", () => {
  it.each(["/rules", "/settings/app"])("is marked current on %s", async (where) => {
    rows.current = [];
    path.current = where;
    try {
      renderLayout();
      fireEvent.click(screen.getByRole("button", { name: /^More/ }));
      const sheet = await screen.findByRole("dialog");
      expect(within(sheet).getByRole("link", { name: /Settings/ })).toHaveAttribute(
        "aria-current",
        "page",
      );
    } finally {
      path.current = "/";
    }
  });
});

// Native feel batch 4: the phone top bar is an iOS navigation bar.
describe("phone top bar", () => {
  const bar = () => within(document.querySelector<HTMLElement>('[data-phone-bar="top"]')!);
  const historyLength = (n: number) => vi.spyOn(window.history, "length", "get").mockReturnValue(n);

  it("names the page: a tab by its tab name, a More page by its menu name", () => {
    expect(phoneTitle("/")).toBe("Net Worth");
    expect(phoneTitle("/transactions")).toBe("Activity");
    expect(phoneTitle("/crypto")).toBe("Investing");
    expect(phoneTitle("/accounts")).toBe("Accounts");
    expect(phoneTitle("/rules")).toBe("Rules");
    expect(phoneTitle("/settings/security")).toBe("Security");
    expect(phoneTitle("/somewhere")).toBe("Alopex");
  });

  it("treats only the tabs' own pages as tabs", () => {
    expect(isTabPath("/portfolio")).toBe(true);
    expect(isTabPath("/accounts")).toBe(false);
  });

  it("has no Back on a tab", () => {
    path.current = "/";
    renderLayout();
    expect(bar().queryByRole("button", { name: "Back" })).toBeNull();
    expect(bar().getByText("Net Worth")).toBeTruthy();
  });

  it("goes Back through history on a page opened inside the app", () => {
    path.current = "/accounts";
    const spy = historyLength(3);
    nav.back.mockClear();
    renderLayout();
    fireEvent.click(bar().getByRole("button", { name: "Back" }));
    expect(nav.back).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    path.current = "/";
  });

  it("goes to the page's parent when the app opened straight on it", () => {
    const spy = historyLength(1);
    expect(phoneParent("/rules")).toBe("/settings/personalization");
    expect(phoneParent("/settings/app")).toBe("/settings");
    expect(phoneParent("/accounts")).toBe("/");
    path.current = "/rules";
    nav.navigate.mockClear();
    renderLayout();
    fireEvent.click(bar().getByRole("button", { name: "Back" }));
    expect(nav.navigate).toHaveBeenCalledWith({ to: "/settings/personalization", replace: true });
    spy.mockRestore();
    path.current = "/";
  });

  it("brings Settings back to the last app page", () => {
    const spy = historyLength(1);
    path.current = "/accounts";
    const { unmount } = renderLayout();
    unmount();
    path.current = "/settings";
    nav.navigate.mockClear();
    renderLayout();
    fireEvent.click(bar().getByRole("button", { name: "Back" }));
    expect(nav.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ to: "/accounts", replace: true }),
    );
    spy.mockRestore();
    path.current = "/";
  });
});
