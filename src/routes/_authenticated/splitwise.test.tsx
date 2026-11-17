import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// The demo client mirrors the real tables: split bills plus Splitwise groups on both sides.
vi.mock("@/integrations/supabase/client", async () => {
  const { createFakeClient } = await import("@/lib/demo/fake-client");
  return { supabase: createFakeClient(new Date("2026-11-08T12:00:00Z")) };
});

// The page runs on the demo's own client, so it is in demo mode too.
vi.mock("@/lib/demo/mode", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo/mode")>()),
  isDemoMode: () => true,
}));

import { Route } from "./splitwise";

const Page = Route.options.component as () => React.JSX.Element;

// protects=Who owes you answers with one net figure first, the two totals below it (#10);
// fails_when=the net is missing, or shows €0.00 while the balances are still loading
describe("Who owes you", () => {
  it("shows a loading state, then the net owed above the two totals", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Page />
      </QueryClientProvider>,
    );
    expect(screen.getByRole("status", { name: "Loading balances" })).toBeTruthy();
    expect(screen.queryByText("Net owed to you")).toBeNull();

    const label = await screen.findByText("Net owed to you");
    const hero = label.closest("section")!;
    const owed = screen.getByText("Owed to you");
    const euros = (el: Element | null | undefined) =>
      Number(el!.textContent!.replace(/[^\d.]/g, ""));
    const net =
      euros(owed.nextElementSibling) - euros(screen.getByText("You owe").nextElementSibling);
    expect(net).toBeGreaterThan(0);
    expect(euros(hero.querySelector(".figure-display"))).toBeCloseTo(net, 2);
    expect(hero.compareDocumentPosition(owed) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("offers the Splitwise import after the balances, not above them", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Page />
      </QueryClientProvider>,
    );
    const importButton = await screen.findByRole("button", { name: "Import a file instead" });
    const groups = screen.getByText(/Splitwise groups/);
    expect(
      groups.compareDocumentPosition(importButton) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

// protects=the demo shows the sync as it looks connected, under a made-up name, with its To link
// list, and nothing can be sent; fails_when=a real name shows or an action is enabled in the demo
describe("Splitwise sync in the demo", () => {
  it("shows the demo connection, the To link list with its count and disabled actions", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Page />
      </QueryClientProvider>,
    );
    expect(await screen.findByText("Splitwise · Alex")).toBeTruthy();
    expect(screen.getByText(/^Synced \d+ (h|days?) ago$/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sync now" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Connect Splitwise" })).toBeNull();

    const list = await screen.findByRole("region", { name: "To link" });
    expect(list).toHaveTextContent("2 to link");
    const dinner = await screen.findByRole("listitem", { name: "Dinner out" });
    expect(dinner).toHaveTextContent("You paid");
    expect(dinner).toHaveTextContent("your share €28.00");
    expect(screen.getByRole("listitem", { name: "Settle up" })).toHaveTextContent(
      "Settle-up you received",
    );
    for (const b of screen.getAllByRole("button", { name: "Ignore" })) expect(b).toBeDisabled();
    expect(screen.getByText("Linking is off in the demo.")).toBeTruthy();
    expect(screen.getByText(/synced from Splitwise/)).toBeTruthy();
  });
});
