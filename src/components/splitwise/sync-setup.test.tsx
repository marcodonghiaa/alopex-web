import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const rpc = vi.hoisted(() => vi.fn());
const invoke = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
const demo = vi.hoisted(() => ({ on: false }));
vi.mock("@/lib/demo/mode", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo/mode")>()),
  isDemoMode: () => demo.on,
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc, functions: { invoke } },
}));

import { setLocaleOverride } from "@/lib/locale";
import { SyncSetup } from "./sync-setup";

const httpError = (status: number, body: unknown) => ({
  data: null,
  error: { message: "non-2xx", context: new Response(JSON.stringify(body), { status }) },
});
const ok = (data: unknown) => ({ data, error: null });

const connection = (over: Record<string, unknown> = {}) =>
  ok([
    {
      connected: true,
      status: "ok",
      display_name: "Sam",
      last_synced_at: new Date(Date.now() - 5 * 60_000).toISOString(),
      last_error: null,
      ...over,
    },
  ]);
const notConnected = (synced_data = false) =>
  ok([
    {
      connected: false,
      status: null,
      display_name: null,
      last_synced_at: null,
      last_error: null,
      synced_data,
    },
  ]);

/** Answers each Edge Function call in turn: splitwise-connect, then sync-splitwise. */
function functions(answers: Record<string, Array<unknown>>) {
  invoke.mockImplementation(async (name: string) => answers[name]!.shift());
}

let client: QueryClient;
const onImportFile = vi.fn();
const renderSetup = () => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SyncSetup onImportFile={onImportFile} />
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  rpc.mockReset();
  invoke.mockReset();
  toast.mockClear();
  toast.success.mockClear();
  toast.error.mockClear();
});
afterEach(() => {
  demo.on = false;
});

describe("SyncSetup when not connected", () => {
  it("offers Connect Splitwise and the file import", async () => {
    rpc.mockResolvedValue(notConnected());
    renderSetup();
    expect(await screen.findByRole("button", { name: "Connect Splitwise" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Import a Splitwise file" }));
    expect(onImportFile).toHaveBeenCalled();
  });

  it("adds no note to the file import before connecting", async () => {
    rpc.mockResolvedValue(notConnected());
    renderSetup();
    await screen.findByRole("button", { name: "Connect Splitwise" });
    expect(
      screen.getByRole("button", { name: "Import a Splitwise file" }),
    ).not.toHaveAccessibleDescription();
  });

  // protects=an older backend without the sync still shows the page; fails_when=it crashes
  it("reads a backend without the sync as not connected", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "Could not find the function" } });
    renderSetup();
    expect(await screen.findByRole("button", { name: "Connect Splitwise" })).toBeTruthy();
  });
});

// polish-3 #11: an outage must not offer a connected user "Connect Splitwise"
describe("SyncSetup when the connection can't be read", () => {
  it("shows the error with Retry instead of Connect", async () => {
    rpc.mockResolvedValueOnce({
      data: null,
      error: { message: "upstream timeout", code: "57014" },
    });
    rpc.mockResolvedValue(connection());
    renderSetup();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't load the Splitwise connection: upstream timeout",
    );
    expect(screen.queryByRole("button", { name: "Connect Splitwise" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Splitwise · Sam")).toBeTruthy();
  });

  it("still reads a backend without the sync (PGRST202) as not connected", async () => {
    rpc.mockResolvedValue({
      data: null,
      error: {
        message: "Could not find the function public.get_splitwise_connection",
        code: "PGRST202",
      },
    });
    renderSetup();
    expect(await screen.findByRole("button", { name: "Connect Splitwise" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("Connect dialog", () => {
  const open = async () => {
    rpc.mockResolvedValue(notConnected());
    renderSetup();
    await userEvent.click(await screen.findByRole("button", { name: "Connect Splitwise" }));
    return screen.getByRole("dialog", { name: "Connect Splitwise" });
  };

  it("shows the three steps, a hidden key field and the consent", async () => {
    const dialog = await open();
    expect(
      within(dialog).getByRole("link", { name: /secure\.splitwise\.com\/apps/ }),
    ).toHaveAttribute("href", "https://secure.splitwise.com/apps");
    expect(dialog).toHaveTextContent("Register your application");
    expect(dialog).toHaveTextContent("Copy the API key");
    expect(within(dialog).getByLabelText("API key")).toHaveAttribute("type", "password");
    expect(
      within(dialog).getByRole("checkbox", {
        name: /stores the key encrypted on your own server; disconnect anytime/,
      }),
    ).not.toBeChecked();
  });

  // polish-2 #5: browsers ignore "off" on a password field, so a password manager could save the key
  it("asks password managers not to save the key", async () => {
    const dialog = await open();
    expect(within(dialog).getByLabelText("API key")).toHaveAttribute(
      "autocomplete",
      "new-password",
    );
  });

  // protects=consent is asked before any key leaves the page; fails_when=it is sent without
  it("asks for the key, then consent, before sending anything", async () => {
    const dialog = await open();
    await userEvent.click(within(dialog).getByRole("button", { name: "Connect" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Paste your Splitwise API key");
    await userEvent.type(within(dialog).getByLabelText("API key"), "abcdefghijkl");
    await userEvent.click(within(dialog).getByRole("button", { name: "Connect" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Tick the box");
    expect(invoke).not.toHaveBeenCalled();
  });

  // protects=the user learns the key is wrong; fails_when=the server's reason is replaced
  it("shows Splitwise's refusal of a bad key", async () => {
    functions({
      "splitwise-connect": [httpError(400, { error: "Splitwise did not accept this API key." })],
    });
    const dialog = await open();
    await userEvent.type(within(dialog).getByLabelText("API key"), "wrongwrongwrong");
    await userEvent.click(within(dialog).getByRole("checkbox"));
    await userEvent.click(within(dialog).getByRole("button", { name: "Connect" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Splitwise did not accept this API key.",
    );
  });

  it("shows the error when Splitwise asks to slow down", async () => {
    functions({
      "splitwise-connect": [
        httpError(429, { error: "Splitwise asked to slow down. Try again later." }),
      ],
    });
    const dialog = await open();
    await userEvent.type(within(dialog).getByLabelText("API key"), "abcdefghijkl");
    await userEvent.click(within(dialog).getByRole("checkbox"));
    await userEvent.click(within(dialog).getByRole("button", { name: "Connect" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("slow down");
  });

  // protects=the first sync says what it brings before it runs; fails_when=counts are mixed up
  // or Start sync doesn't call Sync now
  it("connects, previews the counts, then starts the sync", async () => {
    functions({
      "splitwise-connect": [ok({ displayName: "Sam" })],
      "sync-splitwise": [
        ok({ new: 12, adopted: 3, review: 2, deleted: 1 }),
        ok({ new: 12, adopted: 3, review: 2, deleted: 1 }),
      ],
    });
    const dialog = await open();
    await userEvent.type(within(dialog).getByLabelText("API key"), "  abcdefghijkl ");
    await userEvent.click(within(dialog).getByRole("checkbox"));
    await userEvent.click(within(dialog).getByRole("button", { name: "Connect" }));
    expect(await within(dialog).findByText("Connected as Sam")).toBeTruthy();
    expect(invoke).toHaveBeenNthCalledWith(1, "splitwise-connect", {
      body: { apiKey: "abcdefghijkl", consent: true },
    });
    const row = (label: string) => within(dialog).getByText(label).nextElementSibling?.textContent;
    await within(dialog).findByText("New expenses");
    expect(row("New expenses")).toBe("12");
    expect(row("Already imported (kept, not doubled)")).toBe("3");
    expect(row("To link with a bank payment")).toBe("2");
    expect(row("Removed in Splitwise")).toBe("1");
    // polish-4 #9: the labels explain themselves, no glossary footnote
    expect(within(dialog).queryByText(/Already imported: shares/)).toBeNull();
    expect(invoke).toHaveBeenNthCalledWith(2, "sync-splitwise", { body: { preview: true } });

    await userEvent.click(within(dialog).getByRole("button", { name: "Start sync" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(invoke).toHaveBeenNthCalledWith(3, "sync-splitwise", { body: {} });
    expect(toast.success).toHaveBeenCalledWith(
      "Splitwise synced: 12 new expenses, 3 expenses already imported, 2 to link, 1 removed",
    );
  });

  // protects=the dialog doesn't turn into Reconnect once the connect lands; fails_when=its title
  // follows the refetched status
  it("keeps its title after connecting", async () => {
    functions({
      "splitwise-connect": [ok({ displayName: "Sam" })],
      "sync-splitwise": [ok({ new: 0, adopted: 0, review: 0, deleted: 0 })],
    });
    rpc.mockResolvedValueOnce(notConnected());
    rpc.mockResolvedValue(connection());
    renderSetup();
    await userEvent.click(await screen.findByRole("button", { name: "Connect Splitwise" }));
    const dialog = screen.getByRole("dialog", { name: "Connect Splitwise" });
    await userEvent.type(within(dialog).getByLabelText("API key"), "abcdefghijkl");
    await userEvent.click(within(dialog).getByRole("checkbox"));
    await userEvent.click(within(dialog).getByRole("button", { name: "Connect" }));
    await screen.findByText("Splitwise · Sam");
    expect(screen.getByRole("dialog", { name: "Connect Splitwise" })).toBeTruthy();
  });

  // polish-3 #7
  it("groups the preview's counts in the chosen locale", async () => {
    setLocaleOverride("de-DE");
    try {
      functions({
        "splitwise-connect": [ok({ displayName: "Sam" })],
        "sync-splitwise": [ok({ new: 1234, adopted: 0, review: 2500, deleted: 0 })],
      });
      const dialog = await open();
      await userEvent.type(within(dialog).getByLabelText("API key"), "abcdefghijkl");
      await userEvent.click(within(dialog).getByRole("checkbox"));
      await userEvent.click(within(dialog).getByRole("button", { name: "Connect" }));
      await within(dialog).findByText("New expenses");
      const row = (label: string) =>
        within(dialog).getByText(label).nextElementSibling?.textContent;
      expect(row("New expenses")).toBe("1.234");
      expect(row("To link with a bank payment")).toBe("2.500");
    } finally {
      setLocaleOverride("");
    }
  });

  // polish-3 #8: one sync at a time, whichever button started it
  it("keeps Sync now off while the dialog's first sync still runs", async () => {
    let finish: (v: unknown) => void = () => {};
    functions({
      "splitwise-connect": [ok({ displayName: "Sam" })],
      "sync-splitwise": [
        ok({ new: 0, adopted: 0, review: 0, deleted: 0 }),
        new Promise((resolve) => (finish = resolve)),
      ],
    });
    rpc.mockResolvedValueOnce(notConnected());
    rpc.mockResolvedValue(connection());
    renderSetup();
    await userEvent.click(await screen.findByRole("button", { name: "Connect Splitwise" }));
    const dialog = screen.getByRole("dialog", { name: "Connect Splitwise" });
    await userEvent.type(within(dialog).getByLabelText("API key"), "abcdefghijkl");
    await userEvent.click(within(dialog).getByRole("checkbox"));
    await userEvent.click(within(dialog).getByRole("button", { name: "Connect" }));
    await within(dialog).findByText("Nothing new to bring in.");
    await userEvent.click(within(dialog).getByRole("button", { name: "Start sync" }));
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("button", { name: /Sync now|Syncing/ })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    finish(ok({ new: 1, adopted: 0, review: 0, deleted: 0 }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Sync now" })).toBeEnabled());
  });

  it("shows a preview failure and still lets the sync start", async () => {
    functions({
      "splitwise-connect": [ok({ displayName: "Sam" })],
      "sync-splitwise": [
        httpError(502, { error: "Couldn't sync with Splitwise. Try again later." }),
      ],
    });
    const dialog = await open();
    await userEvent.type(within(dialog).getByLabelText("API key"), "abcdefghijkl");
    await userEvent.click(within(dialog).getByRole("checkbox"));
    await userEvent.click(within(dialog).getByRole("button", { name: "Connect" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Couldn't sync with Splitwise",
    );
    expect(within(dialog).getByRole("button", { name: "Start sync" })).toBeEnabled();
  });

  // polish-2 #4: the key leaves the page as soon as it is no longer needed
  it("clears the key when the dialog closes with Esc", async () => {
    const dialog = await open();
    await userEvent.type(within(dialog).getByLabelText("API key"), "abcdefghijkl");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await userEvent.click(screen.getByRole("button", { name: "Connect Splitwise" }));
    const again = screen.getByRole("dialog", { name: "Connect Splitwise" });
    expect(within(again).getByLabelText("API key")).toHaveValue("");
  });

  it("clears the key after connecting", async () => {
    functions({
      "splitwise-connect": [ok({ displayName: "Sam" })],
      "sync-splitwise": [ok({ new: 0, adopted: 0, review: 0, deleted: 0 })],
    });
    const dialog = await open();
    await userEvent.type(within(dialog).getByLabelText("API key"), "abcdefghijkl");
    await userEvent.click(within(dialog).getByRole("checkbox"));
    await userEvent.click(within(dialog).getByRole("button", { name: "Connect" }));
    await within(dialog).findByText("Connected as Sam");
    expect(document.body.innerHTML).not.toContain("abcdefghijkl");
    expect([...document.querySelectorAll("input")].some((i) => i.value === "abcdefghijkl")).toBe(
      false,
    );
  });

  // polish-2 #4: a session without its second step gets the server's own words
  it("shows the two-step sign-in refusal (403)", async () => {
    functions({
      "splitwise-connect": [
        httpError(403, { error: "Enter your authenticator code first", code: "mfa_required" }),
      ],
    });
    const dialog = await open();
    await userEvent.type(within(dialog).getByLabelText("API key"), "abcdefghijkl");
    await userEvent.click(within(dialog).getByRole("checkbox"));
    await userEvent.click(within(dialog).getByRole("button", { name: "Connect" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Enter your authenticator code first",
    );
    expect(within(dialog).queryByText(/Connected as/)).toBeNull();
  });

  it("says up front that it is off in the demo, and Connect stays off", async () => {
    demo.on = true;
    const dialog = await open();
    expect(within(dialog).getByRole("note")).toHaveTextContent("Splitwise sync is off in the demo");
    expect(within(dialog).getByRole("button", { name: "Connect" })).toBeDisabled();
  });
});

describe("SyncSetup when connected", () => {
  it("shows who is connected and when it last synced", async () => {
    rpc.mockResolvedValue(connection());
    renderSetup();
    expect(await screen.findByText("Splitwise · Sam")).toBeTruthy();
    expect(screen.getByText("Synced 5 min ago")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect Splitwise" })).toBeNull();
    expect(screen.getByRole("button", { name: "Import a Splitwise file" })).toBeTruthy();
  });

  // polish-1 #2: a file imported while connected must not double what the sync brought in
  it("says the file import skips what the sync already brought in", async () => {
    rpc.mockResolvedValue(connection());
    renderSetup();
    await screen.findByText("Splitwise · Sam");
    const button = screen.getByRole("button", { name: "Import a Splitwise file" });
    expect(button).toHaveAccessibleDescription(
      "Expenses the sync already brought in are skipped, so only what it can't see is added.",
    );
  });

  it("syncs now and says what came in", async () => {
    rpc.mockResolvedValue(connection());
    functions({ "sync-splitwise": [ok({ new: 1, adopted: 0, review: 0, deleted: 0 })] });
    renderSetup();
    await userEvent.click(await screen.findByRole("button", { name: "Sync now" }));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Splitwise synced: 1 new expense"),
    );
  });

  // protects=Sync now twice in a minute is not an error; fails_when=it shows as a red error
  it("says politely when it synced a moment ago", async () => {
    rpc.mockResolvedValue(connection());
    functions({
      "sync-splitwise": [httpError(429, { error: "Synced a moment ago. Try again in a minute." })],
    });
    renderSetup();
    await userEvent.click(await screen.findByRole("button", { name: "Sync now" }));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith("Synced a moment ago. Try again in a minute."),
    );
    expect(toast.error).not.toHaveBeenCalled();
  });

  // protects=a revoked key leads to Reconnect; fails_when=the status isn't refetched after a 409
  it("shows Reconnect after Splitwise refuses the key", async () => {
    rpc.mockResolvedValueOnce(connection());
    rpc.mockResolvedValue(connection({ status: "needs_reconnect" }));
    functions({
      "sync-splitwise": [
        httpError(409, {
          error: "Splitwise refused the API key. Connect again with a new key.",
          code: "needs_reconnect",
        }),
      ],
    });
    renderSetup();
    await userEvent.click(await screen.findByRole("button", { name: "Sync now" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Splitwise refused the API key. Connect again with a new key.",
      ),
    );
    await userEvent.click(await screen.findByRole("button", { name: "Reconnect" }));
    expect(screen.getByRole("dialog", { name: "Reconnect Splitwise" })).toBeTruthy();
    expect(screen.getByText(/no longer accepts the key/)).toBeTruthy();
  });

  it("shows the last error of a failed sync", async () => {
    rpc.mockResolvedValue(connection({ status: "error", last_error: "Splitwise is down" }));
    renderSetup();
    expect(await screen.findByText("Last sync failed: Splitwise is down")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sync now" })).toBeEnabled();
  });

  it("turns sync and disconnect off in the demo", async () => {
    demo.on = true;
    rpc.mockResolvedValue(connection());
    renderSetup();
    expect(await screen.findByRole("button", { name: "Sync now" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeDisabled();
    expect(screen.getByRole("note")).toHaveTextContent("off in the demo");
  });
});

describe("Disconnect", () => {
  const openDisconnect = async () => {
    rpc.mockResolvedValue(connection());
    renderSetup();
    await userEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    return screen.getByRole("dialog", { name: "Disconnect Splitwise?" });
  };

  // protects=keeping is the default; fails_when=synced data is deleted without choosing it
  it("keeps synced data unless asked", async () => {
    functions({ "splitwise-connect": [ok({ disconnected: true, deleted: 0 })] });
    const dialog = await openDisconnect();
    expect(within(dialog).getByRole("radio", { name: /Keep synced data/ })).toBeChecked();
    await userEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(invoke).toHaveBeenCalledWith("splitwise-connect", {
      body: { disconnect: true, deleteData: false },
    });
    expect(toast.success).toHaveBeenCalledWith("Splitwise disconnected. What was synced stays.");
  });

  it("deletes synced data when chosen", async () => {
    functions({ "splitwise-connect": [ok({ disconnected: true, deleted: 7 })] });
    const dialog = await openDisconnect();
    expect(within(dialog).getByRole("radio", { name: /Delete synced data/ })).toHaveAccessibleName(
      /Your CSV imports stay\./,
    );
    fireEvent.click(within(dialog).getByRole("radio", { name: /Delete synced data/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(invoke).toHaveBeenCalledWith("splitwise-connect", {
      body: { disconnect: true, deleteData: true },
    });
    expect(toast.success).toHaveBeenCalledWith("Splitwise disconnected, 7 synced expenses removed");
  });

  // polish-3 #6: Cancel can't pretend to stop a disconnect already sent
  it("turns Cancel off while the disconnect runs, and reports the choice sent", async () => {
    let finish: (v: unknown) => void = () => {};
    invoke.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    const dialog = await openDisconnect();
    fireEvent.click(within(dialog).getByRole("radio", { name: /Delete synced data/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("dialog", { name: "Disconnect Splitwise?" })).toBeTruthy();
    finish(ok({ disconnected: true, deleted: 2 }));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "Splitwise disconnected, 2 synced expenses removed",
      ),
    );
  });

  it("cancels without calling anything, and shows a failure", async () => {
    const dialog = await openDisconnect();
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(invoke).not.toHaveBeenCalled();

    functions({
      "splitwise-connect": [
        httpError(500, { error: "Couldn't disconnect Splitwise. Try again later." }),
      ],
    });
    await userEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Disconnect" }),
    );
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Couldn't disconnect Splitwise. Try again later."),
    );
  });
});

// polish-2 #6: after "Disconnect, keep data" the user can still have what was synced deleted
describe("Delete synced data after a disconnect", () => {
  const DELETE = "Delete synced Splitwise data";
  const openDelete = async () => {
    rpc.mockResolvedValue(notConnected(true));
    renderSetup();
    await userEvent.click(await screen.findByRole("button", { name: DELETE }));
    return screen.getByRole("dialog", { name: "Delete synced Splitwise data?" });
  };

  it("is offered only when disconnected with synced data left", async () => {
    rpc.mockResolvedValue(notConnected(false));
    renderSetup();
    await screen.findByRole("button", { name: "Connect Splitwise" });
    expect(screen.queryByRole("button", { name: DELETE })).toBeNull();
  });

  it("is not offered while connected (Disconnect has it)", async () => {
    rpc.mockResolvedValue(connection({ synced_data: true }));
    renderSetup();
    await screen.findByText("Splitwise · Sam");
    expect(screen.queryByRole("button", { name: DELETE })).toBeNull();
  });

  // protects=nothing is deleted without confirming; fails_when=the row deletes on click
  it("asks first, then deletes through splitwise-connect", async () => {
    functions({ "splitwise-connect": [ok({ disconnected: true, deleted: 4 })] });
    const dialog = await openDelete();
    expect(invoke).not.toHaveBeenCalled();
    expect(dialog).toHaveTextContent("frees the bank payments they changed");
    // polish-5 #1: CSV imports the sync adopted are kept, and the copy says so
    expect(dialog).toHaveTextContent("Removes the expenses the sync added");
    expect(dialog).toHaveTextContent("Your CSV imports stay.");
    rpc.mockResolvedValue(notConnected(false));
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(invoke).toHaveBeenCalledWith("splitwise-connect", {
      body: { disconnect: true, deleteData: true },
    });
    expect(toast.success).toHaveBeenCalledWith("Synced Splitwise data deleted: 4 expenses");
    await waitFor(() => expect(screen.queryByRole("button", { name: DELETE })).toBeNull());
  });

  it("cancels without calling anything, and shows a failure", async () => {
    const dialog = await openDelete();
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(invoke).not.toHaveBeenCalled();
    functions({
      "splitwise-connect": [
        httpError(500, { error: "Couldn't disconnect Splitwise. Try again later." }),
      ],
    });
    await userEvent.click(screen.getByRole("button", { name: DELETE }));
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }),
    );
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Couldn't disconnect Splitwise. Try again later."),
    );
  });

  // polish-3 #6
  it("turns Cancel off while the delete runs", async () => {
    let finish: (v: unknown) => void = () => {};
    invoke.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    const dialog = await openDelete();
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
    finish(ok({ disconnected: true, deleted: 1 }));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Synced Splitwise data deleted: 1 expense"),
    );
  });

  it("stays off in the demo", async () => {
    demo.on = true;
    rpc.mockResolvedValue(notConnected(true));
    renderSetup();
    expect(await screen.findByRole("button", { name: DELETE })).toBeDisabled();
  });
});

// polish-3 #9: every action shows that it runs, and refreshes what it changed
describe("Pending states and refreshes", () => {
  const held = () => {
    let finish: (v: unknown) => void = () => {};
    const promise = new Promise((resolve) => (finish = resolve));
    return { promise, finish: (v: unknown) => finish(v) };
  };
  const refreshed = (spy: { mock: { calls: Array<Array<unknown>> } }) =>
    spy.mock.calls.map((c) => JSON.stringify((c[0] as { queryKey: unknown }).queryKey));
  const everything = ['["splitwise-connection"]', '["splitwise-review"]', '["transactions"]'];

  it("Connect says it checks the key, then refreshes the connection", async () => {
    const call = held();
    invoke.mockReturnValueOnce(call.promise);
    invoke.mockResolvedValue(ok({ new: 0, adopted: 0, review: 0, deleted: 0 }));
    rpc.mockResolvedValue(notConnected());
    renderSetup();
    const spy = vi.spyOn(client, "invalidateQueries");
    await userEvent.click(await screen.findByRole("button", { name: "Connect Splitwise" }));
    const dialog = screen.getByRole("dialog", { name: "Connect Splitwise" });
    await userEvent.type(within(dialog).getByLabelText("API key"), "abcdefghijkl");
    await userEvent.click(within(dialog).getByRole("checkbox"));
    await userEvent.click(within(dialog).getByRole("button", { name: "Connect" }));
    expect(within(dialog).getByRole("button", { name: "Checking the key…" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    call.finish(ok({ displayName: "Sam" }));
    await within(dialog).findByText("Connected as Sam");
    expect(refreshed(spy)).toContain('["splitwise-connection"]');
  });

  it("Sync now says it syncs, then refreshes everything", async () => {
    const call = held();
    invoke.mockReturnValueOnce(call.promise);
    rpc.mockResolvedValue(connection());
    renderSetup();
    const spy = vi.spyOn(client, "invalidateQueries");
    await userEvent.click(await screen.findByRole("button", { name: "Sync now" }));
    expect(screen.getByRole("button", { name: "Syncing…" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    call.finish(ok({ new: 0, adopted: 0, review: 0, deleted: 0 }));
    await waitFor(() => expect(refreshed(spy)).toEqual(expect.arrayContaining(everything)));
  });

  it("Disconnect says it disconnects, then refreshes everything", async () => {
    const call = held();
    invoke.mockReturnValueOnce(call.promise);
    rpc.mockResolvedValue(connection());
    renderSetup();
    const spy = vi.spyOn(client, "invalidateQueries");
    await userEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    const dialog = screen.getByRole("dialog", { name: "Disconnect Splitwise?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));
    expect(within(dialog).getByRole("button", { name: "Disconnecting…" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    call.finish(ok({ disconnected: true, deleted: 0 }));
    await waitFor(() => expect(refreshed(spy)).toEqual(expect.arrayContaining(everything)));
  });

  it("Delete synced data says it deletes, then refreshes everything", async () => {
    const call = held();
    invoke.mockReturnValueOnce(call.promise);
    rpc.mockResolvedValue(notConnected(true));
    renderSetup();
    const spy = vi.spyOn(client, "invalidateQueries");
    await userEvent.click(
      await screen.findByRole("button", { name: "Delete synced Splitwise data" }),
    );
    const dialog = screen.getByRole("dialog", { name: "Delete synced Splitwise data?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(within(dialog).getByRole("button", { name: "Deleting…" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    call.finish(ok({ disconnected: true, deleted: 0 }));
    await waitFor(() => expect(refreshed(spy)).toEqual(expect.arrayContaining(everything)));
  });
});

// polish-4 #1: dialogs are bg-background, so what sits in them needs the card fill to show
describe("Surfaces inside the dialogs", () => {
  it("gives Later, the preview list, Cancel and the keep/delete choice a card fill", async () => {
    functions({
      "splitwise-connect": [ok({ displayName: "Sam" })],
      "sync-splitwise": [ok({ new: 1, adopted: 0, review: 0, deleted: 0 })],
    });
    rpc.mockResolvedValue(notConnected());
    renderSetup();
    await userEvent.click(await screen.findByRole("button", { name: "Connect Splitwise" }));
    const dialog = screen.getByRole("dialog", { name: "Connect Splitwise" });
    await userEvent.type(within(dialog).getByLabelText("API key"), "abcdefghijkl");
    await userEvent.click(within(dialog).getByRole("checkbox"));
    await userEvent.click(within(dialog).getByRole("button", { name: "Connect" }));
    const list = (await within(dialog).findByText("New expenses")).closest("dl")!.parentElement!;
    expect(list.className).toContain("bg-card");
    expect(list.className).not.toContain("bg-background");
    const later = within(dialog).getByRole("button", { name: /^(Later|Not now)$/ });
    expect(later.className).toContain("bg-card");
  });

  it("fills the disconnect choice and Cancel", async () => {
    rpc.mockResolvedValue(connection());
    renderSetup();
    await userEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    const dialog = screen.getByRole("dialog", { name: "Disconnect Splitwise?" });
    expect(within(dialog).getByRole("group").className).toContain("bg-card");
    expect(within(dialog).getByRole("button", { name: "Cancel" }).className).toContain("bg-card");
  });
});

// polish-4 #3: when the control that opened a dialog is replaced, focus goes to the new one
describe("Focus after the setup changes", () => {
  it("lands on Connect Splitwise after a disconnect", async () => {
    functions({ "splitwise-connect": [ok({ disconnected: true, deleted: 0 })] });
    rpc.mockResolvedValueOnce(connection());
    rpc.mockResolvedValue(notConnected(true));
    renderSetup();
    await userEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    const dialog = screen.getByRole("dialog", { name: "Disconnect Splitwise?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));
    const connect = await screen.findByRole("button", { name: "Connect Splitwise" });
    await waitFor(() => expect(document.activeElement).toBe(connect));
  });

  it("lands on Connect Splitwise after deleting synced data", async () => {
    functions({ "splitwise-connect": [ok({ disconnected: true, deleted: 2 })] });
    rpc.mockResolvedValueOnce(notConnected(true));
    rpc.mockResolvedValue(notConnected(false));
    renderSetup();
    await userEvent.click(
      await screen.findByRole("button", { name: "Delete synced Splitwise data" }),
    );
    const dialog = screen.getByRole("dialog", { name: "Delete synced Splitwise data?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Delete synced Splitwise data" })).toBeNull(),
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Connect Splitwise" }),
      ),
    );
  });

  it("lands on Sync now when the connect dialog closes after connecting", async () => {
    functions({
      "splitwise-connect": [ok({ displayName: "Sam" })],
      "sync-splitwise": [ok({ new: 0, adopted: 0, review: 0, deleted: 0 })],
    });
    rpc.mockResolvedValueOnce(notConnected());
    rpc.mockResolvedValue(connection());
    renderSetup();
    await userEvent.click(await screen.findByRole("button", { name: "Connect Splitwise" }));
    const dialog = screen.getByRole("dialog", { name: "Connect Splitwise" });
    await userEvent.type(within(dialog).getByLabelText("API key"), "abcdefghijkl");
    await userEvent.click(within(dialog).getByRole("checkbox"));
    await userEvent.click(within(dialog).getByRole("button", { name: "Connect" }));
    await screen.findByText("Splitwise · Sam");
    await userEvent.keyboard("{Escape}");
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Sync now" })),
    );
  });

  it("lands on Sync now after a successful Retry", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: "timeout", code: "57014" } });
    rpc.mockResolvedValue(connection());
    renderSetup();
    await userEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Sync now" })),
    );
  });

  // The opposite state: loading the page moves no focus.
  it("leaves focus alone when the page loads", async () => {
    rpc.mockResolvedValue(connection());
    renderSetup();
    await screen.findByRole("button", { name: "Sync now" });
    await new Promise((r) => setTimeout(r, 50));
    expect(document.activeElement).toBe(document.body);
  });
});

// polish-4 #7: light-theme contrast (WCAG 1.4.3 text, 1.4.11 field edge)
describe("Contrast in the dialogs", () => {
  it("keeps the destructive confirm on its plain fill", async () => {
    rpc.mockResolvedValue(connection());
    renderSetup();
    await userEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    const dialog = screen.getByRole("dialog", { name: "Disconnect Splitwise?" });
    const confirm = within(dialog).getByRole("button", { name: "Disconnect" });
    // Its hover tint stays; the resting tint dropped the label to 4.4:1.
    expect(confirm.className.split(" ")).not.toContain("bg-negative/10");
  });

  it("gives the API key field a card fill inside the dialog", async () => {
    rpc.mockResolvedValue(notConnected());
    renderSetup();
    await userEvent.click(await screen.findByRole("button", { name: "Connect Splitwise" }));
    const dialog = screen.getByRole("dialog", { name: "Connect Splitwise" });
    expect(within(dialog).getByLabelText("API key").className).toContain("bg-card");
  });
});

// polish-4 #8: DESIGN.md's 44 px minimum for every action in the setup row
describe("Setup tap targets", () => {
  const tall = (b: HTMLElement) => expect(b.className.split(" ")).toContain("min-h-11");

  it("makes Sync now and Disconnect 44 px tall", async () => {
    rpc.mockResolvedValue(connection());
    renderSetup();
    tall(await screen.findByRole("button", { name: "Sync now" }));
    tall(screen.getByRole("button", { name: "Disconnect" }));
  });

  it("makes Reconnect 44 px tall", async () => {
    rpc.mockResolvedValue(connection({ status: "needs_reconnect" }));
    renderSetup();
    tall(await screen.findByRole("button", { name: "Reconnect" }));
  });

  it("makes Retry 44 px tall", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "timeout", code: "57014" } });
    renderSetup();
    tall(await screen.findByRole("button", { name: "Retry" }));
  });
});

// polish-4 #9: the preview says only what is true for this sync
describe("Sync preview copy", () => {
  const connectWith = async (counts: Record<string, number>, reconnect = false) => {
    functions({
      "splitwise-connect": [ok({ displayName: "Sam" })],
      "sync-splitwise": [ok(counts)],
    });
    rpc.mockResolvedValue(reconnect ? connection({ status: "needs_reconnect" }) : notConnected());
    renderSetup();
    const title = reconnect ? "Reconnect Splitwise" : "Connect Splitwise";
    await userEvent.click(
      await screen.findByRole("button", { name: reconnect ? "Reconnect" : "Connect Splitwise" }),
    );
    const dialog = screen.getByRole("dialog", { name: title });
    await userEvent.type(within(dialog).getByLabelText("API key"), "abcdefghijkl");
    await userEvent.click(within(dialog).getByRole("checkbox"));
    await userEvent.click(within(dialog).getByRole("button", { name: "Connect" }));
    await within(dialog).findByText("Connected as Sam");
    return dialog;
  };

  it("hides the rows with nothing in them", async () => {
    const dialog = await connectWith({ new: 2, adopted: 0, review: 1, deleted: 0 });
    await within(dialog).findByText("New expenses");
    expect(within(dialog).getByText("To link with a bank payment")).toBeTruthy();
    expect(within(dialog).queryByText(/^Removed/)).toBeNull();
    expect(within(dialog).queryByText(/^Already imported/)).toBeNull();
    expect(within(dialog).getByText(/New expenses add your share to your spending/)).toBeTruthy();
  });

  it("says nothing new comes in when every count is zero", async () => {
    const dialog = await connectWith({ new: 0, adopted: 0, review: 0, deleted: 0 });
    expect(await within(dialog).findByText("Nothing new to bring in.")).toBeTruthy();
    expect(within(dialog).queryByRole("term")).toBeNull();
    expect(within(dialog).queryByText(/New expenses add your share/)).toBeNull();
  });

  it("calls it the first sync on Connect and the next sync on Reconnect", async () => {
    const first = await connectWith({ new: 1, adopted: 0, review: 0, deleted: 0 });
    expect(within(first).getByText("The first sync brings in:")).toBeTruthy();
    cleanup();
    const next = await connectWith({ new: 1, adopted: 0, review: 0, deleted: 0 }, true);
    expect(within(next).getByText("The next sync brings in:")).toBeTruthy();
    expect(within(next).queryByText(/first sync/)).toBeNull();
  });

  it("offers Not now and says it syncs anyway", async () => {
    const dialog = await connectWith({ new: 1, adopted: 0, review: 0, deleted: 0 });
    expect(within(dialog).getByRole("button", { name: "Not now" })).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "Later" })).toBeNull();
    expect(within(dialog).getByText("Syncs automatically within 6 hours.")).toBeTruthy();
  });
});

// polish-4 #11: a pending button is aria-disabled, not disabled, so it keeps keyboard focus
describe("Pending buttons keep focus", () => {
  const pending = (b: HTMLElement) => {
    expect(b).not.toBeDisabled();
    expect(b).toHaveAttribute("aria-disabled", "true");
  };
  const hold = () => new Promise(() => {});

  it("Sync now", async () => {
    invoke.mockReturnValueOnce(hold());
    rpc.mockResolvedValue(connection());
    renderSetup();
    await userEvent.click(await screen.findByRole("button", { name: "Sync now" }));
    const b = screen.getByRole("button", { name: "Syncing…" });
    pending(b);
    expect(document.activeElement).toBe(b);
    await userEvent.click(b);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("Connect while the key is checked", async () => {
    invoke.mockReturnValueOnce(hold());
    rpc.mockResolvedValue(notConnected());
    renderSetup();
    await userEvent.click(await screen.findByRole("button", { name: "Connect Splitwise" }));
    const dialog = screen.getByRole("dialog", { name: "Connect Splitwise" });
    await userEvent.type(within(dialog).getByLabelText("API key"), "abcdefghijkl");
    await userEvent.click(within(dialog).getByRole("checkbox"));
    await userEvent.click(within(dialog).getByRole("button", { name: "Connect" }));
    const b = within(dialog).getByRole("button", { name: "Checking the key…" });
    pending(b);
    await userEvent.click(b);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("Disconnect while it runs", async () => {
    invoke.mockReturnValueOnce(hold());
    rpc.mockResolvedValue(connection());
    renderSetup();
    await userEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    const dialog = screen.getByRole("dialog", { name: "Disconnect Splitwise?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));
    const b = within(dialog).getByRole("button", { name: "Disconnecting…" });
    pending(b);
    await userEvent.click(b);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("is a plain, enabled button again once nothing runs", async () => {
    rpc.mockResolvedValue(connection());
    renderSetup();
    const b = await screen.findByRole("button", { name: "Sync now" });
    expect(b).not.toHaveAttribute("aria-disabled");
    expect(b).toBeEnabled();
  });
});

// polish-4 #12: two clicks in the same tick (key repeat, switch devices) send one request
describe("Double trigger", () => {
  const twice = (b: HTMLElement) =>
    act(() => {
      fireEvent.click(b);
      fireEvent.click(b);
    });

  it("Sync now", async () => {
    invoke.mockResolvedValue(ok({ new: 0, adopted: 0, review: 0, deleted: 0 }));
    rpc.mockResolvedValue(connection());
    renderSetup();
    twice(await screen.findByRole("button", { name: "Sync now" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("Start sync", async () => {
    functions({
      "splitwise-connect": [ok({ displayName: "Sam" })],
      "sync-splitwise": [
        ok({ new: 1, adopted: 0, review: 0, deleted: 0 }),
        ok({ new: 1, adopted: 0, review: 0, deleted: 0 }),
        ok({ new: 1, adopted: 0, review: 0, deleted: 0 }),
      ],
    });
    rpc.mockResolvedValue(notConnected());
    renderSetup();
    await userEvent.click(await screen.findByRole("button", { name: "Connect Splitwise" }));
    const dialog = screen.getByRole("dialog", { name: "Connect Splitwise" });
    await userEvent.type(within(dialog).getByLabelText("API key"), "abcdefghijkl");
    await userEvent.click(within(dialog).getByRole("checkbox"));
    await userEvent.click(within(dialog).getByRole("button", { name: "Connect" }));
    await within(dialog).findByText("New expenses");
    twice(within(dialog).getByRole("button", { name: "Start sync" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // connect, preview, one sync
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it("Disconnect", async () => {
    functions({ "splitwise-connect": [ok({ disconnected: true, deleted: 0 })] });
    rpc.mockResolvedValue(connection());
    renderSetup();
    await userEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    const dialog = screen.getByRole("dialog", { name: "Disconnect Splitwise?" });
    twice(within(dialog).getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it("still lets a second Disconnect through after the first one failed", async () => {
    functions({
      "splitwise-connect": [
        httpError(502, { error: "Couldn't reach the server." }),
        ok({ disconnected: true, deleted: 0 }),
      ],
    });
    rpc.mockResolvedValue(connection());
    renderSetup();
    await userEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    const dialog = screen.getByRole("dialog", { name: "Disconnect Splitwise?" });
    const confirm = within(dialog).getByRole("button", { name: "Disconnect" });
    await userEvent.click(confirm);
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    await waitFor(() => expect(confirm).not.toHaveAttribute("aria-disabled"));
    await userEvent.click(confirm);
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});

// polish-4 #13: the form's error belongs to its field and goes when the field is fixed
describe("Connect form errors", () => {
  const openForm = async () => {
    rpc.mockResolvedValue(notConnected());
    renderSetup();
    await userEvent.click(await screen.findByRole("button", { name: "Connect Splitwise" }));
    return screen.getByRole("dialog", { name: "Connect Splitwise" });
  };

  it("ties a missing key to the key field, focuses it, and clears once typed", async () => {
    const dialog = await openForm();
    const key = within(dialog).getByLabelText("API key");
    expect(key).not.toHaveAttribute("aria-invalid");
    await userEvent.click(within(dialog).getByRole("button", { name: "Connect" }));
    const alert = within(dialog).getByRole("alert");
    expect(alert).toHaveTextContent("Paste your Splitwise API key first.");
    expect(key).toHaveAttribute("aria-invalid", "true");
    expect(key.getAttribute("aria-describedby")).toBe(alert.id);
    expect(document.activeElement).toBe(key);
    await userEvent.type(key, "a");
    expect(within(dialog).queryByRole("alert")).toBeNull();
    expect(key).not.toHaveAttribute("aria-invalid");
  });

  it("ties a missing consent to the checkbox and clears once ticked", async () => {
    const dialog = await openForm();
    const key = within(dialog).getByLabelText("API key");
    const box = within(dialog).getByRole("checkbox");
    await userEvent.type(key, "abcdefghijkl");
    await userEvent.click(within(dialog).getByRole("button", { name: "Connect" }));
    const alert = within(dialog).getByRole("alert");
    expect(box).toHaveAttribute("aria-invalid", "true");
    expect(box.getAttribute("aria-describedby")).toBe(alert.id);
    expect(key).not.toHaveAttribute("aria-invalid");
    expect(document.activeElement).toBe(box);
    await userEvent.click(box);
    expect(within(dialog).queryByRole("alert")).toBeNull();
    expect(box).not.toHaveAttribute("aria-invalid");
  });

  it("ties a key Splitwise refused to the key field", async () => {
    functions({
      "splitwise-connect": [httpError(400, { error: "Splitwise did not accept this API key." })],
    });
    const dialog = await openForm();
    const key = within(dialog).getByLabelText("API key");
    await userEvent.type(key, "abcdefghijkl");
    await userEvent.click(within(dialog).getByRole("checkbox"));
    await userEvent.click(within(dialog).getByRole("button", { name: "Connect" }));
    const alert = await within(dialog).findByRole("alert");
    expect(key).toHaveAttribute("aria-invalid", "true");
    expect(key.getAttribute("aria-describedby")).toBe(alert.id);
  });
});

// polish-4 #14: after "Disconnect, keep data" the page says the sync is off
describe("Disconnected with data kept", () => {
  const NOTE = "Disconnected. What was synced stays; nothing new comes in.";

  it("says nothing new comes in", async () => {
    rpc.mockResolvedValue(notConnected(true));
    renderSetup();
    expect(await screen.findByText(NOTE)).toBeTruthy();
  });

  it.each([
    ["never connected", notConnected(false)],
    ["connected", connection()],
  ])("says nothing of the kind when %s", async (_name, answer) => {
    rpc.mockResolvedValue(answer);
    renderSetup();
    await screen.findByRole("button", { name: /^(Connect Splitwise|Sync now)$/ });
    expect(screen.queryByText(NOTE)).toBeNull();
  });
});

// polish-4 #15: the setup row isn't blank while the connection loads
describe("Setup while the connection loads", () => {
  it("holds the row's place with a loading placeholder", async () => {
    rpc.mockReturnValue(new Promise(() => {}));
    renderSetup();
    const ph = await screen.findByRole("status", { name: "Loading the Splitwise connection" });
    expect(ph.className.split(" ")).toContain("h-11");
  });

  it("drops it once the connection is known", async () => {
    rpc.mockResolvedValue(notConnected());
    renderSetup();
    await screen.findByRole("button", { name: "Connect Splitwise" });
    expect(screen.queryByRole("status", { name: "Loading the Splitwise connection" })).toBeNull();
  });
});

// polish-4 #21: the X can't close a dialog whose request runs, so it is off too
describe("Dialog X while a request runs", () => {
  it("is off while the key is checked, on again after", async () => {
    let finish: (v: unknown) => void = () => {};
    invoke.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    rpc.mockResolvedValue(notConnected());
    renderSetup();
    await userEvent.click(await screen.findByRole("button", { name: "Connect Splitwise" }));
    const dialog = screen.getByRole("dialog", { name: "Connect Splitwise" });
    expect(within(dialog).getByRole("button", { name: "Close" })).toBeEnabled();
    await userEvent.type(within(dialog).getByLabelText("API key"), "abcdefghijkl");
    await userEvent.click(within(dialog).getByRole("checkbox"));
    await userEvent.click(within(dialog).getByRole("button", { name: "Connect" }));
    expect(within(dialog).getByRole("button", { name: "Close" })).toBeDisabled();
    finish(httpError(400, { error: "Splitwise did not accept this API key." }));
    await within(dialog).findByRole("alert");
    expect(within(dialog).getByRole("button", { name: "Close" })).toBeEnabled();
  });

  it("is off while it disconnects", async () => {
    invoke.mockReturnValueOnce(new Promise(() => {}));
    rpc.mockResolvedValue(connection());
    renderSetup();
    await userEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    const dialog = screen.getByRole("dialog", { name: "Disconnect Splitwise?" });
    expect(within(dialog).getByRole("button", { name: "Close" })).toBeEnabled();
    await userEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));
    expect(within(dialog).getByRole("button", { name: "Close" })).toBeDisabled();
  });
});

// polish-4 #23: DESIGN.md's 40 px avatars are round, like the group cards above
it("draws the status row's avatar round", async () => {
  rpc.mockResolvedValue(connection());
  renderSetup();
  const name = await screen.findByText("Splitwise · Sam");
  const avatar = name.closest("div.flex")!.querySelector("span[aria-hidden]")!;
  expect(avatar.className.split(" ")).toContain("rounded-full");
  expect(avatar.className.split(" ")).not.toContain("rounded-sm");
});

// polish-4 #24: once connected a file adds to the sync, it isn't an alternative to it
it.each([
  ["connected", () => connection()],
  ["not connected", () => notConnected()],
])("names the file import the same way when %s", async (_n, answer) => {
  rpc.mockResolvedValue(answer());
  renderSetup();
  expect(await screen.findByRole("button", { name: "Import a Splitwise file" })).toBeTruthy();
  expect(screen.queryByText(/instead/)).toBeNull();
});

// polish-4 #27: a full sentence, and the steps numbered like Connect a bank (list-decimal)
it("ends the consent with a period and numbers the steps as a list", async () => {
  rpc.mockResolvedValue(notConnected());
  renderSetup();
  await userEvent.click(await screen.findByRole("button", { name: "Connect Splitwise" }));
  const dialog = screen.getByRole("dialog", { name: "Connect Splitwise" });
  expect(within(dialog).getByRole("checkbox", { name: /disconnect anytime\.$/ })).toBeTruthy();
  const list = within(dialog).getByRole("list");
  expect(list.className.split(" ")).toContain("list-decimal");
  const steps = within(list).getAllByRole("listitem");
  expect(steps).toHaveLength(3);
  expect(steps[0]!.textContent).toMatch(/^Open /);
});

// re-audit N3: only the user's own action moves focus; a background change must not (it scrolled
// the page to Retry or Connect for a mouse user whose focus was on <body>)
describe("Focus on a background change", () => {
  it("stays put when a background refetch fails", async () => {
    rpc.mockResolvedValue(connection());
    renderSetup();
    await screen.findByRole("button", { name: "Sync now" });
    expect(document.activeElement).toBe(document.body);
    rpc.mockResolvedValue({ data: null, error: { message: "timeout", code: "57014" } });
    await client.refetchQueries({ queryKey: ["splitwise-connection"] });
    await screen.findByRole("button", { name: "Retry" });
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(document.activeElement).toBe(document.body);
  });

  it("stays put when another tab disconnects", async () => {
    rpc.mockResolvedValue(connection());
    renderSetup();
    await screen.findByRole("button", { name: "Sync now" });
    rpc.mockResolvedValue(notConnected(true));
    await client.refetchQueries({ queryKey: ["splitwise-connection"] });
    await screen.findByRole("button", { name: "Connect Splitwise" });
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(document.activeElement).toBe(document.body);
  });
});
