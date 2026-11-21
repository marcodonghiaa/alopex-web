import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MenuPagesSection } from "./menu-pages-section";
import { hiddenPages, setPageHidden } from "@/lib/hidden-pages";

beforeEach(() => {
  vi.restoreAllMocks();
  for (const p of hiddenPages()) setPageHidden(p, false);
});

// protects=Settings › App switches unused pages out of the menu (whiteboard: hide Budgets);
// fails_when=the switch doesn't save, or a blocked storage fails silently
describe("MenuPagesSection", () => {
  it("lists the pages as switches, on by default, and turns one off", () => {
    render(<MenuPagesSection />);
    const budgets = screen.getByRole("switch", { name: "Budgets" });
    expect(screen.getAllByRole("switch")).toHaveLength(7);
    expect(budgets).toBeChecked();
    fireEvent.click(budgets);
    expect(budgets).not.toBeChecked();
    expect(hiddenPages()).toEqual(["/budgets"]);
    fireEvent.click(budgets);
    expect(hiddenPages()).toEqual([]);
  });

  it("says so when the browser blocks storage", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    render(<MenuPagesSection />);
    fireEvent.click(screen.getByRole("switch", { name: "Income" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/blocks site storage/);
    expect(screen.getByRole("switch", { name: "Income" })).toBeChecked();
  });

  // polish-3 audit: fail, then retry once storage works again: the alert goes and the switch moves.
  it("clears the error when a retry saves", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    render(<MenuPagesSection />);
    const income = screen.getByRole("switch", { name: "Income" });
    fireEvent.click(income);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    spy.mockRestore();
    fireEvent.click(income);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(income).not.toBeChecked();
    setPageHidden("/income", false);
  });
});
