import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/integrations/supabase/client", async () => {
  const { createFakeClient } = await import("@/lib/demo/fake-client");
  return { supabase: createFakeClient(new Date("2026-11-08T12:00:00Z")) };
});
const hash = vi.hoisted(() => ({ current: "" }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
  useRouterState: ({ select }: { select: (s: { location: { hash: string } }) => string }) =>
    select({ location: { hash: hash.current } }),
}));

import { ImportSettingsPage } from "./settings-page";

const renderPage = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ImportSettingsPage />
    </QueryClientProvider>,
  );

describe("Settings › Import", () => {
  // protects=a bank statement PDF can be imported here; fails_when=the page offers only the CSV
  // history wizard
  it("opens the statement import, which takes CSV and PDF", () => {
    hash.current = "";
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Import a statement" }));
    const input = screen.getByLabelText("Statement file") as HTMLInputElement;
    expect(input.accept).toContain(".pdf");
    expect(input.accept).toContain(".csv");
  });

  it("opens the history wizard on net worth by default", () => {
    hash.current = "";
    renderPage();
    expect(screen.getByRole("radio", { name: "Net worth by month" })).toBeChecked();
  });

  // protects=Spending's "Import past months" link lands on spending; fails_when=it opens on net worth
  it("opens on spending when linked with #spending", () => {
    hash.current = "spending";
    renderPage();
    expect(screen.getByRole("radio", { name: "Spending by month" })).toBeChecked();
  });

  it("points to the trades imports on Portfolio and Crypto", () => {
    hash.current = "";
    renderPage();
    expect(screen.getByRole("link", { name: "Portfolio" }).getAttribute("href")).toBe("/portfolio");
    expect(screen.getByRole("link", { name: "Crypto" }).getAttribute("href")).toBe("/crypto");
  });
});
