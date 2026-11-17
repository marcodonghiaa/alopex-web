import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const updates = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: () => ({
      update: (patch: Record<string, unknown>) => {
        updates.push(patch);
        return { eq: () => Promise.resolve({ error: null }) };
      },
    }),
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { setLocaleOverride } from "@/lib/locale";
import { TradesDialog } from "./trades-dialog";

afterEach(() => setLocaleOverride(""));

describe("TradesDialog", () => {
  it("polish-3 #6 writes each trade's shares in the chosen format", async () => {
    setLocaleOverride("de-DE");
    render(
      <QueryClientProvider client={new QueryClient()}>
        <TradesDialog
          kind="stock"
          holdingKey="K"
          name="Example ETF"
          quantity={1.5}
          label="Trades"
          trades={[
            {
              id: "t1",
              kind: "stock",
              key: "K",
              side: "buy",
              trade_date: "2026-03-01",
              shares: 1.5,
              price_eur: 10,
              fee_eur: 0,
            },
          ]}
        />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Trades" }));
    expect(await screen.findByText("Bought 1,5")).toBeInTheDocument();
  });

  it("shows an imported trade's tax next to its fee; none when there is no tax", async () => {
    const trade = {
      kind: "stock",
      key: "K",
      side: "buy",
      shares: 1,
      price_eur: 10,
      fee_eur: 1,
    };
    render(
      <QueryClientProvider client={new QueryClient()}>
        <TradesDialog
          kind="stock"
          holdingKey="K"
          name="Example ETF"
          quantity={2}
          label="Trades"
          trades={[
            { ...trade, id: "t1", trade_date: "2026-03-01", tax_eur: 0.12 },
            { ...trade, id: "t2", trade_date: "2026-03-02", tax_eur: 0 },
          ]}
        />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Trades" }));
    const detail = (date: string) =>
      screen.getByRole("button", { name: new RegExp(`^Edit: .* on ${date}$`) }).closest("li")
        ?.textContent;
    expect(await screen.findAllByText(/fee/)).toHaveLength(2);
    expect(detail("1 Mar 2026")).toMatch(/fee €1\.00 · tax €0\.12$/);
    expect(detail("2 Mar 2026")).not.toMatch(/tax/);
  });

  it("polish-4 F3 says when a buy has no price and how to fix it; not when every buy has one", async () => {
    const buy = { kind: "stock", key: "K", side: "buy", shares: 1, fee_eur: 0 };
    const show = (price: number) =>
      render(
        <QueryClientProvider client={new QueryClient()}>
          <TradesDialog
            kind="stock"
            holdingKey="K"
            name="Example ETF"
            quantity={2}
            label="Trades"
            trades={[
              { ...buy, id: "t1", trade_date: "2026-03-01", price_eur: 10 },
              { ...buy, id: "t2", trade_date: "2026-03-02", price_eur: price },
            ]}
          />
        </QueryClientProvider>,
      );
    const view = show(0);
    fireEvent.click(screen.getByRole("button", { name: "Trades" }));
    expect(await screen.findByText(/A buy has no price/)).toBeInTheDocument();
    view.unmount();
    show(12);
    fireEvent.click(screen.getByRole("button", { name: "Trades" }));
    await screen.findByText("Example ETF");
    expect(screen.queryByText(/A buy has no price/)).not.toBeInTheDocument();
  });

  it("polish-5 #5 fills the edit form in the chosen format", async () => {
    setLocaleOverride("it-IT");
    render(
      <QueryClientProvider client={new QueryClient()}>
        <TradesDialog
          kind="stock"
          holdingKey="K"
          name="Example ETF"
          quantity={0.5}
          label="Trades"
          trades={[
            {
              id: "t1",
              kind: "stock",
              key: "K",
              side: "buy",
              trade_date: "2026-03-01",
              shares: 0.5,
              price_eur: 1234.56,
              fee_eur: 1.5,
            },
          ]}
        />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Trades" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Edit: bought 0,5 on/ }));
    expect(screen.getByLabelText(/Shares/)).toHaveValue("0,5");
    expect(screen.getByLabelText(/Price/)).toHaveValue("1234,56");
    expect(screen.getByLabelText(/Fee/)).toHaveValue("1,5");
  });

  it("left-open #1 says why an unclear shares, price or fee like 1,250 is refused", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <TradesDialog
          kind="stock"
          holdingKey="K"
          name="Example ETF"
          quantity={0}
          label="Trades"
          trades={[]}
        />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Trades" }));
    const fill = (shares: string, price: string, fee: string) => {
      fireEvent.change(screen.getByLabelText(/Shares/), { target: { value: shares } });
      fireEvent.change(screen.getByLabelText(/Price/), { target: { value: price } });
      fireEvent.change(screen.getByLabelText(/Fee/), { target: { value: fee } });
      fireEvent.click(screen.getByRole("button", { name: "Add trade" }));
    };
    fill("1,250", "10", "");
    expect(await screen.findByRole("alert")).toHaveTextContent('"1,250" could mean 1250 or 1.25');
    fill("1", "2,500", "");
    expect(screen.getByRole("alert")).toHaveTextContent('"2,500" could mean 2500 or 2.5');
    fill("1", "10", "3,000");
    expect(screen.getByRole("alert")).toHaveTextContent('"3,000" could mean 3000 or 3');
  });

  it("moving an imported trade to another day drops its broker time; keeping the day keeps it", async () => {
    updates.length = 0;
    render(
      <QueryClientProvider client={new QueryClient()}>
        <TradesDialog
          kind="stock"
          holdingKey="K"
          name="Example ETF"
          quantity={1}
          label="Trades"
          trades={[
            {
              id: "t1",
              kind: "stock",
              key: "K",
              side: "buy",
              trade_date: "2026-03-01",
              traded_at: "2026-03-01T09:30:00Z",
              shares: 1,
              price_eur: 10,
              fee_eur: 0,
            },
          ]}
        />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Trades" }));
    const edit = async (date?: string) => {
      fireEvent.click(await screen.findByRole("button", { name: "Edit: bought 1 on 1 Mar 2026" }));
      if (date) fireEvent.change(screen.getByLabelText(/Date/), { target: { value: date } });
      fireEvent.click(screen.getByRole("button", { name: "Save trade" }));
      await waitFor(() => expect(screen.getByRole("button", { name: "Add trade" })).toBeTruthy());
    };
    await edit();
    await edit("2026-03-05");
    expect(updates).toHaveLength(2);
    expect(updates[0]).not.toHaveProperty("traded_at");
    expect(updates[1]).toMatchObject({ trade_date: "2026-03-05", traded_at: null });
  });

  it("polish-4 N4 marks the trade being edited, and Cancel leaves edit mode", async () => {
    const buy = { kind: "stock", key: "K", side: "buy", shares: 1, fee_eur: 0 };
    render(
      <QueryClientProvider client={new QueryClient()}>
        <TradesDialog
          kind="stock"
          holdingKey="K"
          name="Example ETF"
          quantity={2}
          label="Trades"
          trades={[
            { ...buy, id: "t1", trade_date: "2026-03-01", price_eur: 10 },
            { ...buy, id: "t2", trade_date: "2026-03-02", price_eur: 0 },
          ]}
        />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Trades" }));
    await screen.findByText("Example ETF");
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
    expect(document.querySelector("li[aria-current]")).toBeNull();
    // The missing-price note opens the €0 buy for editing.
    fireEvent.click(screen.getByRole("button", { name: "Edit that trade" }));
    const current = document.querySelector("li[aria-current='true']");
    expect(current?.textContent).toMatch(/at €0\.00/);
    expect(screen.getByLabelText(/Date/)).toHaveValue("2026-03-02");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Add trade" })).toBeInTheDocument();
    expect(screen.getByLabelText(/Price/)).toHaveValue("");
    expect(document.querySelector("li[aria-current]")).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
  });

  it("polish-4 F4 shows an imported trade's note on its line; nothing when there is none", async () => {
    const buy = { kind: "stock", key: "K", side: "buy", shares: 1, fee_eur: 0, price_eur: 10 };
    render(
      <QueryClientProvider client={new QueryClient()}>
        <TradesDialog
          kind="stock"
          holdingKey="K"
          name="Example ETF"
          quantity={2}
          label="Trades"
          trades={[
            { ...buy, id: "t1", trade_date: "2026-03-01", note: "Moved in or out" },
            { ...buy, id: "t2", trade_date: "2026-03-02", note: null },
          ]}
        />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Trades" }));
    const line = await screen.findByText(/Moved in or out/);
    expect(line.textContent).toMatch(/2026 · Moved in or out$/);
    expect(screen.getAllByText(/Moved in or out/)).toHaveLength(1);
  });

  it("polish-4 F11 lists same-day trades newest first by their imported time", async () => {
    const buy = { kind: "stock", key: "K", side: "buy", fee_eur: 0, price_eur: 10 };
    render(
      <QueryClientProvider client={new QueryClient()}>
        <TradesDialog
          kind="stock"
          holdingKey="K"
          name="Example ETF"
          quantity={3}
          label="Trades"
          trades={[
            {
              ...buy,
              id: "t1",
              shares: 1,
              trade_date: "2026-03-01",
              traded_at: "2026-03-01T09:00:00Z",
            },
            {
              ...buy,
              id: "t2",
              shares: 2,
              trade_date: "2026-03-01",
              traded_at: "2026-03-01T15:00:00Z",
            },
          ]}
        />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Trades" }));
    await screen.findByText("Bought 2");
    const lines = [...document.querySelectorAll("li")].map((li) => li.textContent);
    expect(lines[0]).toMatch(/^Bought 2/);
    expect(lines[1]).toMatch(/^Bought 1/);
  });

  it("polish-4 N14 names Edit and Remove by the trade, so same-day trades differ", async () => {
    const day = { kind: "stock", key: "K", fee_eur: 0, price_eur: 10, trade_date: "2026-03-01" };
    render(
      <QueryClientProvider client={new QueryClient()}>
        <TradesDialog
          kind="stock"
          holdingKey="K"
          name="Example ETF"
          quantity={1}
          label="Trades"
          trades={[
            { ...day, id: "t1", side: "buy", shares: 2 },
            { ...day, id: "t2", side: "sell", shares: 1 },
          ]}
        />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Trades" }));
    expect(
      await screen.findByRole("button", { name: "Edit: bought 2 on 1 Mar 2026" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove: bought 2 on 1 Mar 2026" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit: sold 1 on 1 Mar 2026" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove: sold 1 on 1 Mar 2026" })).toBeTruthy();
  });
});
