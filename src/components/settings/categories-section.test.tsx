import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const upsert = vi.fn(async (_row: unknown, _opts?: unknown) => ({ error: null }));
const insert = vi.fn(async (_row: unknown) => ({ error: null as unknown }));
const del = vi.fn((_col: string, _val: unknown) => Promise.resolve({ error: null }));
const rpc = vi.fn(async (_fn: string, _args: unknown) => ({
  data: 3 as unknown,
  error: null as unknown,
}));
// Rows as the database has them; `oldBackend` = before the icon/colour migration.
let rows: Array<Record<string, unknown>> = [];
let oldBackend = false;
let broken = false;
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: () => ({
      select: async (cols: string) => {
        if (broken) return { data: null, error: { code: "PGRST205", message: "missing" } };
        if (oldBackend && cols.includes("icon"))
          return { data: null, error: { code: "42703", message: "column icon does not exist" } };
        return { data: rows, error: null };
      },
      upsert: (row: unknown, opts?: unknown) => upsert(row, opts),
      insert: (row: unknown) => insert(row),
      delete: () => ({ eq: (c: string, v: unknown) => del(c, v) }),
    }),
    rpc: (fn: string, args: unknown) => rpc(fn, args),
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { CategoriesSection } from "./categories-section";

function renderSection() {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <CategoriesSection />
    </QueryClientProvider>,
  );
}
const row = async (name: string) =>
  (await screen.findByText(name, { selector: "li span" })).closest("li")!;

beforeEach(() => {
  for (const m of [upsert, insert, del, rpc]) m.mockClear();
  oldBackend = false;
  broken = false;
  rows = [
    { name: "Gym", hidden: false, icon: "fitness", color: "teal" },
    { name: "Holiday", hidden: false, icon: null, color: null },
    { name: "Taxes", hidden: true, icon: null, color: null },
  ];
});

// A self-hoster wanted their own categories instead of the built-in ones; then a user wanted to pick
// each one's icon and colour, see them in this list, and delete one without leaving transactions behind.
describe("CategoriesSection", () => {
  it("titles the section like the rest of the app", () => {
    renderSection();
    expect(screen.getByRole("heading", { level: 2 })).toHaveClass(
      "font-semibold",
      "text-foreground",
    );
  });

  it("shows each category's icon, not a colour dot", async () => {
    renderSection();
    expect((await row("Gym")).querySelector("[data-icon='fitness']")).not.toBeNull();
    expect((await row("Groceries")).querySelector("[data-icon='groceries']")).not.toBeNull();
    // No icon picked: its first letter.
    expect((await row("Holiday")).querySelector("svg")).toBeNull();
    expect(within(await row("Holiday")).getByText("H")).toBeInTheDocument();
  });

  it("adds a category with the icon and colour you pick", async () => {
    renderSection();
    fireEvent.change(await screen.findByLabelText("New category"), {
      target: { value: "  Pets " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText("Name")).toHaveValue("Pets");
    fireEvent.click(within(dialog).getByRole("radio", { name: "Pets" }));
    fireEvent.click(within(dialog).getByRole("radio", { name: "orange" }));
    expect(within(dialog).getByRole("radio", { name: "Pets" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    await waitFor(() =>
      expect(insert).toHaveBeenCalledWith({ name: "Pets", icon: "pets", color: "orange" }),
    );
  });

  it("changes the icon and colour of a built-in category", async () => {
    renderSection();
    fireEvent.click(
      await within(await row("Groceries")).findByRole("button", { name: "Edit Groceries" }),
    );
    const dialog = await screen.findByRole("dialog");
    // Starts on its current icon.
    expect(within(dialog).getByRole("radio", { name: "Groceries" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    fireEvent.click(within(dialog).getByRole("radio", { name: "Coffee" }));
    fireEvent.click(within(dialog).getByRole("radio", { name: "green" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(upsert).toHaveBeenCalledWith(
        { name: "Groceries", hidden: false, icon: "coffee", color: "green" },
        { onConflict: "user_id,name" },
      ),
    );
    expect(rpc).not.toHaveBeenCalled();
  });

  it("renames a category: the look is saved first, then everything moves to the new name", async () => {
    renderSection();
    fireEvent.click(await within(await row("Gym")).findByRole("button", { name: "Edit Gym" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Fitness club" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith("move_category", { p_from: "Gym", p_to: "Fitness club" }),
    );
    expect(upsert).toHaveBeenCalledWith(
      { name: "Gym", hidden: false, icon: "fitness", color: "teal" },
      { onConflict: "user_id,name" },
    );
    expect(upsert.mock.invocationCallOrder[0]).toBeLessThan(rpc.mock.invocationCallOrder[0]!);
  });

  it("refuses to rename onto a name already in the list", async () => {
    renderSection();
    fireEvent.click(await within(await row("Gym")).findByRole("button", { name: "Edit Gym" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "holiday" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/already/i);
    expect(upsert).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("deletes a category of yours by moving its transactions to the one you pick", async () => {
    renderSection();
    fireEvent.click(
      await within(await row("Holiday")).findByRole("button", { name: "Edit Holiday" }),
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete…" }));
    const target = within(dialog).getByLabelText("Move them to");
    // Starts on Others; the hidden Taxes and Holiday itself aren't offered.
    expect(target).toHaveValue("Others");
    const options = within(target)
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(options).not.toContain("Holiday");
    expect(options).not.toContain("Taxes");
    fireEvent.change(target, { target: { value: "Experiences" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Move and delete" }));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith("move_category", { p_from: "Holiday", p_to: "Experiences" }),
    );
    expect(del).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("keeps the dialog open with the reason when the move is refused", async () => {
    rpc.mockResolvedValueOnce({
      data: null,
      error: { message: '"Taxes" is hidden: show it first' },
    });
    renderSection();
    fireEvent.click(
      await within(await row("Holiday")).findByRole("button", { name: "Edit Holiday" }),
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete…" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Move and delete" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/hidden/);
    // Back returns to the editor.
    fireEvent.click(within(dialog).getByRole("button", { name: "Back" }));
    expect(within(dialog).getByLabelText("Name")).toBeInTheDocument();
  });

  it("built-in categories can't be deleted, Transfer and Income can't be renamed or hidden", async () => {
    renderSection();
    const transfer = await row("Transfer");
    expect(within(transfer).queryByRole("button", { name: "Hide" })).toBeNull();
    fireEvent.click(await within(transfer).findByRole("button", { name: "Edit Transfer" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText("Name")).toBeDisabled();
    expect(within(dialog).queryByRole("button", { name: "Delete…" })).toBeNull();
  });

  it("hides a built-in category, and shows a hidden one again", async () => {
    renderSection();
    fireEvent.click(within(await row("Shopping")).getByRole("button", { name: "Hide" }));
    await waitFor(() =>
      expect(upsert).toHaveBeenCalledWith({ name: "Shopping", hidden: true }, undefined),
    );
    // H136: Show deleted the row, wiping a custom icon and colour; it only unhides it now.
    fireEvent.click(within(await row("Taxes")).getByRole("button", { name: "Show" }));
    await waitFor(() =>
      expect(upsert).toHaveBeenCalledWith({ name: "Taxes", hidden: false }, undefined),
    );
    expect(del).not.toHaveBeenCalled();
  });

  it("refuses a name already in the list", async () => {
    renderSection();
    fireEvent.change(await screen.findByLabelText("New category"), {
      target: { value: "groceries" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/already/i);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("before the icon migration: adds and deletes as before, and says what to run", async () => {
    oldBackend = true;
    renderSection();
    expect(await screen.findByText(/Icons, colours and moving transactions/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Edit/ })).toBeNull();
    fireEvent.change(screen.getByLabelText("New category"), { target: { value: "Pets" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() =>
      expect(upsert).toHaveBeenCalledWith({ name: "Pets", hidden: false }, undefined),
    );
    fireEvent.click(within(await row("Gym")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(del).toHaveBeenCalledWith("name", "Gym"));
  });

  it("says a database update is needed before the categories migration", async () => {
    broken = true;
    renderSection();
    expect(await screen.findByText(/database update/i)).toBeInTheDocument();
  });
});
