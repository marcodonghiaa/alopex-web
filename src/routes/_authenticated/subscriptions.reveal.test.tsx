import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Own file: the reveal's seen-this-session flag is module state, and the main Subscriptions
// tests burn it.
type Row = Record<string, unknown>;
const { db, invoke } = vi.hoisted(() => ({ db: { rows: [] as Array<Row> }, invoke: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: vi.fn(),
    functions: { invoke },
    from: () => ({ select: async () => ({ data: db.rows, error: null }) }),
  },
}));

import { Route } from "./subscriptions";

vi.spyOn(Route, "useSearch").mockImplementation((() => ({})) as never);
vi.spyOn(Route, "useNavigate").mockImplementation((() => vi.fn()) as never);
const Page = Route.options.component as () => React.JSX.Element;

const stream = (id: string, name: string, amount: number): Row => ({
  id,
  display_name: name,
  category: "Entertainment",
  detected_at: "2026-11-01T00:00:00Z",
  currency: "EUR",
  cadence: "monthly",
  typical_amount: amount,
  typical_amount_eur: amount,
  charge_count: 4,
  last_charged: "2099-12-01",
  next_expected: "2099-12-31",
  detected_status: "active",
  user_status: "confirmed",
  user_cadence: null,
  custom_interval_value: null,
  custom_interval_unit: null,
});

// polish-4 #6: the one-time reveal opened on the saved list and rewrote itself when the re-check
// landed ("We found 2 … ~€15.79" → "We found 1 … ~€12.99"). fails_when=it opens before the check
// settles, or doesn't open once it has
describe("First-time reveal on the Subscriptions page", () => {
  it("waits for the re-check, then opens on the fresh list", async () => {
    localStorage.removeItem("mf.subscriptionsReveal.seen");
    db.rows = [stream("s1", "Netflix", 12.99), stream("s2", "Cloudbox", 2.8)];
    let finish!: () => void;
    invoke.mockImplementation(
      () =>
        new Promise((res) => {
          finish = () => {
            db.rows = [db.rows[0]!];
            res({ data: { streams: 1 }, error: null });
          };
        }),
    );
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <Page />
      </QueryClientProvider>,
    );
    expect((await screen.findAllByText("Cloudbox")).length).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(localStorage.getItem("mf.subscriptionsReveal.seen")).toBeNull();

    finish();
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("We found 1 subscription");
    expect(dialog).not.toHaveTextContent("Cloudbox");
    await waitFor(() => expect(localStorage.getItem("mf.subscriptionsReveal.seen")).toBe("1"));
  });
});
