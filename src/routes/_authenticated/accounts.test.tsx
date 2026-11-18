import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const rows = vi.hoisted(() => ({
  v_bank_accounts_latest: [] as Array<Record<string, unknown>>,
}));
const invoke = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  loading: vi.fn(() => "t1"),
  dismiss: vi.fn(),
}));
vi.mock("sonner", () => ({ toast }));
const demo = vi.hoisted(() => ({ on: false }));
vi.mock("@/lib/demo/mode", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo/mode")>()),
  isDemoMode: () => demo.on,
}));
vi.mock("@/integrations/supabase/client", () => {
  const query = (table: string) => {
    const q: Record<string, unknown> = {};
    for (const m of ["select", "order", "eq"]) q[m] = () => q;
    q["then"] = (resolve: (v: unknown) => void) =>
      resolve({ data: rows[table as keyof typeof rows] ?? [], error: null });
    return q;
  };
  return { supabase: { from: query, functions: { invoke } } };
});
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ children, ...props }: { children: React.ReactNode; "aria-label"?: string }) => (
    <a href="/import" aria-label={props["aria-label"]}>
      {children}
    </a>
  ),
}));

import { Route } from "./accounts";

const Page = Route.options.component as () => React.JSX.Element;

describe("debts", () => {
  afterEach(() => {
    rows.v_bank_accounts_latest = [];
  });
  const account = (over: Record<string, unknown>) => ({
    uid: "a1",
    label: "Demo Bank Current",
    iban: null,
    currency: "EUR",
    snapshot_date: "2026-10-19",
    amount: 1000,
    amount_eur: 1000,
    consent_valid_until: null,
    bank_name: "Demo Bank",
    account_type: null,
    manual: false,
    ...over,
  });
  const renderPage = () =>
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Page />
      </QueryClientProvider>,
    );

  // protects=the page stays light: no Debts group (and no type picker) until a debt exists
  it("shows no Debts group without debts, only an Add a debt button", async () => {
    rows.v_bank_accounts_latest = [account({})];
    renderPage();
    expect(await screen.findByRole("button", { name: "Add a debt" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Debts" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  // protects=a card counts as money owed, whatever sign the bank uses; fails_when=it adds to cash
  it("groups cards and loans under Debts, negative, and takes them off the total", async () => {
    rows.v_bank_accounts_latest = [
      account({}),
      account({
        uid: "c1",
        label: "Card",
        account_type: "credit_card",
        amount: 200,
        amount_eur: 200,
      }),
      account({
        uid: "l1",
        label: "Car loan",
        bank_name: "Car loan",
        account_type: "loan",
        manual: true,
        amount: 300,
        amount_eur: 300,
      }),
    ];
    renderPage();
    expect(await screen.findByRole("heading", { name: "Debts" })).toBeInTheDocument();
    expect(screen.getByText("Car loan")).toBeInTheDocument();
    expect(screen.getAllByText("-€500.00").length).toBeGreaterThan(0);
    // Bank accounts keep only the cash account.
    expect(screen.getAllByText("€1,000.00").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Add a debt" })).toBeInTheDocument();
  });

  // protects=balances come first; setup is a quiet last row (#13);
  // fails_when=Connect a bank or Add a debt sits above the accounts again
  const follows = (a: Element, b: Element) =>
    !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

  it("puts Connect a bank and Add a debt after the bank accounts", async () => {
    rows.v_bank_accounts_latest = [account({})];
    renderPage();
    const add = await screen.findByRole("button", { name: "Add a debt" });
    const row = screen.getByText("Demo Bank");
    const connect = screen.getByRole("button", { name: "Connect a bank" });
    expect(follows(row, connect)).toBe(true);
    expect(follows(connect, add)).toBe(true);
  });

  it("puts Add a debt after the debts once there are some", async () => {
    rows.v_bank_accounts_latest = [
      account({
        uid: "c1",
        label: "Card",
        account_type: "credit_card",
        amount: 200,
        amount_eur: 200,
      }),
    ];
    renderPage();
    const heading = await screen.findByRole("heading", { name: "Debts" });
    const add = screen.getByRole("button", { name: "Add a debt" });
    expect(follows(heading, add)).toBe(true);
    expect(follows(screen.getAllByText("-€200.00").at(-1)!, add)).toBe(true);
  });
});

describe("sync errors", () => {
  afterEach(() => {
    rows.v_bank_accounts_latest = [];
  });
  const account = (over: Record<string, unknown>) => ({
    uid: "a1",
    label: "Demo Bank Current",
    iban: null,
    currency: "EUR",
    snapshot_date: "2026-10-19",
    amount: 1000,
    amount_eur: 1000,
    consent_valid_until: null,
    bank_name: "Demo Bank",
    account_type: null,
    manual: false,
    ...over,
  });
  const renderPage = () =>
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Page />
      </QueryClientProvider>,
    );

  // protects=a bank that stopped updating says why; fails_when=the last sync error is not shown
  it("says why a bank stopped updating", async () => {
    rows.v_bank_accounts_latest = [
      account({ sync_error: "ASPSP_TIMEOUT", sync_error_at: "2026-11-15T06:17:00Z" }),
    ];
    renderPage();
    expect(await screen.findByText(/Demo Bank didn't answer the last sync/)).toBeInTheDocument();
  });

  // protects=a long unknown error code wraps on a phone; fails_when=the banner can grow wider than the screen
  it("wraps a long error code instead of widening the page", async () => {
    rows.v_bank_accounts_latest = [
      account({ sync_error: "A".repeat(64), sync_error_at: "2026-11-15T06:17:00Z" }),
    ];
    renderPage();
    expect(await screen.findByRole("status")).toHaveClass("break-words");
  });

  // protects=an ended consent shows only Renew; fails_when=a stale sync error promises a retry that never comes
  it("shows no sync error for a consent that has run out", async () => {
    rows.v_bank_accounts_latest = [
      account({ sync_error: "ASPSP_TIMEOUT", consent_valid_until: "2020-01-01T00:00:00+00:00" }),
    ];
    renderPage();
    await screen.findByRole("button", { name: "Add a debt" });
    expect(screen.queryByText(/didn't answer the last sync/)).not.toBeInTheDocument();
  });

  // protects=a bank that stopped sharing an account can be reconnected in one tap, like Renew;
  // fails_when=the banner asks to connect again with no button
  it("connects the bank again from a 'no longer shares' banner", async () => {
    rows.v_bank_accounts_latest = [
      account({
        sync_error: "ASPSP_ACCOUNT_NOT_ACCESSIBLE",
        bank_name: "Gone Bank",
        bank_country: "LT",
      }),
    ];
    invoke.mockResolvedValue({
      data: { banks: [{ name: "Other Bank", logo: null }] },
      error: null,
    });
    renderPage();
    Element.prototype.scrollIntoView = vi.fn();
    // A long text shrinks beside the button on a wide screen, instead of pushing it to a new line.
    const button = await screen.findByRole("button", { name: "Connect again" });
    expect(button.previousElementSibling).toHaveClass("flex-1", "basis-64");
    fireEvent.click(button);
    expect(
      await screen.findByText(
        "Gone Bank isn't listed for this country anymore. Pick your bank again.",
      ),
    ).toBeInTheDocument();
  });

  // protects=each bank's banners sit together, Renew first, the shared app problem last;
  // fails_when=one bank's Renew and its sync error are split by another bank's banner
  it("groups the banners by bank, Renew first, the refused app last", async () => {
    const soon = new Date(Date.now() + 3 * 86_400_000).toISOString();
    rows.v_bank_accounts_latest = [
      account({ uid: "b", bank_name: "Beta Bank", sync_error: "ASPSP_TIMEOUT" }),
      account({ uid: "c", bank_name: "Gamma Bank", sync_error: "HTTP_401" }),
      account({
        uid: "a",
        bank_name: "Alpha Bank",
        sync_error: "ASPSP_TIMEOUT",
        consent_valid_until: soon,
      }),
    ];
    renderPage();
    await screen.findByText(/Beta Bank didn't answer/);
    const order = screen.getAllByRole("status").map((s) => s.textContent ?? "");
    expect(order.map((t) => t.match(/Alpha|Beta|Enable Banking refused/)?.[0])).toEqual([
      "Alpha",
      "Alpha",
      "Beta",
      "Enable Banking refused",
    ]);
    expect(order[0]).toMatch(/Renew access/);
  });

  // protects=a long unknown code breaks at its underscores on a phone; fails_when=it splits mid-word
  it("lets a long error code break after its underscores", async () => {
    rows.v_bank_accounts_latest = [account({ sync_error: "WRONG_CONTINUATION_KEY" })];
    renderPage();
    const banner = (await screen.findByText(/WRONG_/)).closest("[role=status]")!;
    expect(banner.textContent).toMatch(/\(WRONG_CONTINUATION_KEY\)/);
    expect(banner.querySelectorAll("wbr")).toHaveLength(2);
  });

  it("shows nothing when the last sync went through", async () => {
    rows.v_bank_accounts_latest = [account({ sync_error: null })];
    renderPage();
    await screen.findByRole("button", { name: "Add a debt" });
    expect(screen.queryByText(/last sync/)).not.toBeInTheDocument();
  });
});

describe("connect a bank", () => {
  beforeEach(() => {
    vi.spyOn(navigator, "languages", "get").mockReturnValue(["pl-PL"]);
  });
  afterEach(() => vi.restoreAllMocks());

  // protects=a browser language outside the list asks for a country; fails_when=en-US browsers
  // start on Austria, the first country A-Z, and load its banks (polish 4, P2-3)
  it("asks for a country when the browser language names none in the list", async () => {
    vi.spyOn(navigator, "languages", "get").mockReturnValue(["en-US"]);
    invoke.mockClear();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Page />
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Connect a bank" }));
    expect(screen.getByLabelText("Country")).toHaveValue("");
    expect(screen.getByRole("option", { name: "Choose a country…" })).toBeInTheDocument();
    expect(screen.getByLabelText("Bank")).toBeDisabled();
    expect(screen.getByRole("option", { name: "Choose a country first" })).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith("list-banks", expect.anything());
  });

  // protects=the country picker opens on the browser's country; fails_when=the form ignores
  // navigator.languages and always starts on the first country
  it("starts on the country of the browser language", async () => {
    vi.spyOn(navigator, "languages", "get").mockReturnValue(["pl-PL", "en"]);
    invoke.mockResolvedValue({ data: { banks: [] }, error: null });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Page />
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Connect a bank" }));
    expect(screen.getByLabelText("Country")).toHaveValue("PL");
  });

  // protects=a failed bank list says so, is announced and can be retried; fails_when=the disabled
  // select still reads "Select a bank…" and only changing country tries again (polish 5, item 4)
  it("says the bank list failed and retries it", async () => {
    invoke.mockResolvedValue({ data: { error: "Bank list unavailable" }, error: null });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Page />
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Connect a bank" }));
    expect(await screen.findByRole("alert", {}, { timeout: 4000 })).toHaveTextContent(
      "Bank list unavailable",
    );
    expect(screen.getByRole("option", { name: "Couldn't load banks" })).toBeInTheDocument();
    invoke.mockResolvedValue({
      data: { banks: [{ name: "Sample Bank", logo: null }] },
      error: null,
    });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("option", { name: "Sample Bank" })).toBeInTheDocument();
  });

  // protects=Renew says when the saved bank is gone from the list; fails_when=the bank select
  // silently falls back to "Select a bank…" with Approve disabled (polish 5, item 5)
  it("says when the bank to renew is no longer listed", async () => {
    const soon = new Date(Date.now() + 3 * 86_400_000).toISOString();
    rows.v_bank_accounts_latest = [
      {
        uid: "a1",
        label: "Gone Bank Current",
        iban: null,
        currency: "EUR",
        snapshot_date: "2026-10-19",
        amount: 1000,
        amount_eur: 1000,
        consent_valid_until: soon,
        bank_name: "Gone Bank",
        bank_country: "LT",
        account_type: null,
        manual: false,
      },
    ];
    invoke.mockResolvedValue({
      data: { banks: [{ name: "Other Bank", logo: null }] },
      error: null,
    });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Page />
      </QueryClientProvider>,
    );
    Element.prototype.scrollIntoView = vi.fn(); // jsdom has none; Renew scrolls to the form
    fireEvent.click(await screen.findByRole("button", { name: "Renew access" }));
    expect(
      await screen.findByText(
        "Gone Bank isn't listed for this country anymore. Pick your bank again.",
      ),
    ).toBeInTheDocument();
    rows.v_bank_accounts_latest = [];
  });

  // Polish 5 F3. protects=Connect again for a bank with no country on file starts from an empty
  // bank; fails_when=the bank an earlier Renew prefilled stays selected
  it("clears an earlier Renew's bank when the next bank has nothing to prefill", async () => {
    const soon = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const base = {
      iban: null,
      currency: "EUR",
      snapshot_date: "2026-10-19",
      amount: 1000,
      amount_eur: 1000,
      account_type: null,
      manual: false,
    };
    rows.v_bank_accounts_latest = [
      {
        ...base,
        uid: "a1",
        label: "Gone Bank Current",
        consent_valid_until: soon,
        bank_name: "Gone Bank",
        bank_country: "LT",
      },
      {
        ...base,
        uid: "a2",
        label: "Old Bank Current",
        consent_valid_until: null,
        bank_name: "Old Bank",
        bank_country: null,
        sync_error: "ASPSP_ACCOUNT_NOT_ACCESSIBLE",
      },
    ];
    invoke.mockResolvedValue({
      data: { banks: [{ name: "Other Bank", logo: null }] },
      error: null,
    });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Page />
      </QueryClientProvider>,
    );
    Element.prototype.scrollIntoView = vi.fn();
    fireEvent.click(await screen.findByRole("button", { name: "Renew access" }));
    const gone = "Gone Bank isn't listed for this country anymore. Pick your bank again.";
    expect(await screen.findByText(gone)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Connect again" }));
    await waitFor(() => expect(screen.queryByText(gone)).not.toBeInTheDocument());
    rows.v_bank_accounts_latest = [];
  });

  // protects=long country names ("United Kingdom") stay readable; fails_when=the country select
  // gets a fixed width again, which clipped "United Kingdom" at 640-767px (polish 4, P1-1)
  it("sizes the country select to its longest name, not a fixed width", async () => {
    invoke.mockResolvedValue({ data: { banks: [] }, error: null });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Page />
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Connect a bank" }));
    expect(screen.getByLabelText("Country").className).not.toMatch(/(^|\s)(sm:)?w-\d/);
  });

  // protects=a country with no supported banks says so; fails_when=the bank list sits empty on
  // "Select a bank…" with submit disabled and no reason
  it("says when a country has no banks", async () => {
    invoke.mockResolvedValue({ data: { banks: [] }, error: null });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Page />
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Connect a bank" }));
    expect(
      await screen.findByRole("option", { name: "No banks for this country" }),
    ).toBeInTheDocument();
  });

  // protects=the empty bank list is announced and says what to do; fails_when=the only sign is
  // the placeholder of a closed, still-enabled select (polish 4, P2-2)
  it("announces an empty bank list with a next step and disables the bank select", async () => {
    invoke.mockResolvedValue({ data: { banks: [] }, error: null });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Page />
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Connect a bank" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "No banks listed for this country yet. Try another country.",
    );
    expect(screen.getByLabelText("Bank")).toBeDisabled();
  });
});

// polish-4 U4: the demo said "Disabled in the demo." only after a country, a bank and Approve.
// fails_when=the form doesn't say up front that bank connection is off in the demo
describe("connect a bank in the demo", () => {
  afterEach(() => {
    demo.on = false;
  });
  const open = async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Page />
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Connect a bank" }));
  };

  it("says up front that bank connection is off", async () => {
    demo.on = true;
    await open();
    expect(screen.getByText(/Bank connection is off in the demo/)).toBeInTheDocument();
  });

  it("says nothing about the demo on a real dashboard", async () => {
    await open();
    expect(screen.queryByText(/off in the demo/)).not.toBeInTheDocument();
  });
});

describe("bank redirect with a one-time code", () => {
  const state = "6f1c2a7e-0b5d-4c3e-9a8f-1d2e3f4a5b6c";
  beforeEach(() => {
    invoke.mockReset();
    toast.success.mockClear();
    toast.error.mockClear();
    window.history.replaceState(null, "", `/accounts?bank_code=c&bank_state=${state}`);
  });
  afterEach(() => window.history.replaceState(null, "", "/"));

  const renderPage = () =>
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Page />
      </QueryClientProvider>,
    );

  it("finishes the link, clears the code from the address bar and says which bank linked", async () => {
    invoke.mockResolvedValue({
      data: { bank_linked: "2", bank: "Revolut", currencies: "EUR,GBP" },
      error: null,
    });
    renderPage();
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Revolut: EUR, GBP"));
    expect(invoke).toHaveBeenCalledWith("complete-bank-consent", { body: { code: "c", state } });
    expect(window.location.search).toBe("");
  });

  it("reads the code from the fragment, where the bank redirect now puts it", async () => {
    window.history.replaceState(null, "", `/accounts#bank_code=f&bank_state=${state}`);
    invoke.mockResolvedValue({
      data: { bank_linked: "1", bank: "N26", currencies: "EUR" },
      error: null,
    });
    renderPage();
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(invoke).toHaveBeenCalledWith("complete-bank-consent", { body: { code: "f", state } });
    expect(window.location.hash).toBe("");
  });

  it("shows the error when the link can't be finished", async () => {
    invoke.mockResolvedValue({ data: null, error: new Error("boom") });
    renderPage();
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Couldn't connect bank", {
        description: "Couldn't link the bank, please try again",
      }),
    );
    expect(toast.success).not.toHaveBeenCalled();
  });
});

// protects=the iOS view board fixes: a tight header, row-tap editing and plain bank-link steps;
// fails_when=the subtitle or text link returns, rows go back to a pencil, or the steps lose "once"
describe("phone layout", () => {
  afterEach(() => {
    rows.v_bank_accounts_latest = [];
  });
  const renderPage = () =>
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Page />
      </QueryClientProvider>,
    );

  it("titles the page like Net Worth", async () => {
    renderPage();
    const h1 = await screen.findByRole("heading", { level: 1, name: "Accounts" });
    expect(h1).toHaveClass("font-semibold", "text-foreground");
  });

  it("has Import data as an icon button in the header and no subtitle", async () => {
    renderPage();
    const link = await screen.findByRole("link", { name: "Import data" });
    expect(link.textContent).toBe("");
    expect(screen.queryByText(/Your bank accounts/)).toBeNull();
  });

  it("opens an account's menu from the whole row, marked with a chevron", async () => {
    rows.v_bank_accounts_latest = [
      {
        uid: "a1",
        label: "Demo Bank Current",
        iban: null,
        currency: "EUR",
        snapshot_date: "2026-10-19",
        amount: 1000,
        amount_eur: 1000,
        consent_valid_until: null,
        bank_name: "Demo Bank",
        account_type: null,
        manual: false,
      },
    ];
    renderPage();
    const edit = await screen.findByRole("button", { name: "Edit Demo Bank" });
    expect(edit.className).toContain("after:inset-0"); // stretched over the row
    expect(edit.querySelector(".lucide-chevron-right")).not.toBeNull();
    expect(edit.querySelector(".lucide-pencil")).toBeNull();
  });

  it("says linking in Enable Banking is needed once per bank", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Connect a bank" }));
    expect(
      screen.getByText(
        "First time with this bank? In Enable Banking, open your app, choose Link accounts and pick this bank. Only needed once.",
      ),
    ).toBeInTheDocument();
  });
});
