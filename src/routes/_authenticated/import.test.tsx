import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/integrations/supabase/client", async () => {
  const { createFakeClient } = await import("@/lib/demo/fake-client");
  return { supabase: createFakeClient(new Date("2026-11-08T12:00:00Z")) };
});

import { Route } from "./import";

const Page = Route.options.component as () => React.JSX.Element;

// protects=a bank statement PDF can be imported from the Import page, the only import entry on a
// phone; fails_when=the page offers only the CSV history wizard
describe("Import page", () => {
  it("opens the statement import, which takes CSV and PDF", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Page />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Import a statement" }));
    const input = screen.getByLabelText("Statement file") as HTMLInputElement;
    expect(input.accept).toContain(".pdf");
    expect(input.accept).toContain(".csv");
  });
});
