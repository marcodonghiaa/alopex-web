import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/integrations/supabase/client", async () => {
  const { createFakeClient } = await import("@/lib/demo/fake-client");
  return { supabase: createFakeClient(new Date("2026-11-08T12:00:00Z")) };
});
// The Splitwise balances are in, but their euro rates are still loading (or not).
const ratesLoaded = vi.hoisted(() => ({ value: false }));
vi.mock("@/lib/use-splitwise-balances", () => ({
  useSplitwiseBalances: () => ({
    balances: { isSuccess: true, isPending: false, isError: false, data: [] },
    rates: { isSuccess: ratesLoaded.value, isPending: !ratesLoaded.value, isError: false },
    rate: (c: string) => (c === "EUR" ? 1 : null),
    rows: [],
  }),
}));

import { Route } from "./splitwise";

const Page = Route.options.component as () => React.JSX.Element;
const show = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Page />
    </QueryClientProvider>,
  );

// protects=guesses made on the full list of who owes you; fails_when=suggestions are computed
// while Splitwise amounts in other currencies are still missing (an "exact amount" looks unique)
describe("Who owes you: payment questions wait for the Splitwise rates", () => {
  it("asks nothing while the rates load", async () => {
    ratesLoaded.value = false;
    show();
    await screen.findByText("Net owed to you");
    expect(screen.queryByRole("region", { name: "Payments to check" })).toBeNull();
  });

  it("asks once they are in", async () => {
    ratesLoaded.value = true;
    show();
    expect(await screen.findByRole("region", { name: "Payments to check" })).toBeTruthy();
  });
});
