import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
    await userEvent.click(screen.getByRole("button", { name: "Import a file instead" }));
    expect(onImportFile).toHaveBeenCalled();
  });

  it("adds no note to the file import before connecting", async () => {
    rpc.mockResolvedValue(notConnected());
    renderSetup();
    await screen.findByRole("button", { name: "Connect Splitwise" });
    expect(
      screen.getByRole("button", { name: "Import a file instead" }),
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
    expect(row("Already imported")).toBe("3");
    expect(row("To link")).toBe("2");
    expect(row("Removed")).toBe("1");
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
      expect(row("To link")).toBe("2.500");
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
    await within(dialog).findByText("New expenses");
    await userEvent.click(within(dialog).getByRole("button", { name: "Start sync" }));
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("button", { name: /Sync now|Syncing/ })).toBeDisabled();
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
    expect(screen.getByRole("button", { name: "Import a file instead" })).toBeTruthy();
  });

  // polish-1 #2: a file imported while connected must not double what the sync brought in
  it("says the file import skips what the sync already brought in", async () => {
    rpc.mockResolvedValue(connection());
    renderSetup();
    await screen.findByText("Splitwise · Sam");
    const button = screen.getByRole("button", { name: "Import a file instead" });
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
        httpError(500, { error: "Couldn't disconnect Splitwise, please try again" }),
      ],
    });
    await userEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Disconnect" }),
    );
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Couldn't disconnect Splitwise, please try again"),
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
        httpError(500, { error: "Couldn't disconnect Splitwise, please try again" }),
      ],
    });
    await userEvent.click(screen.getByRole("button", { name: DELETE }));
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }),
    );
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Couldn't disconnect Splitwise, please try again"),
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
