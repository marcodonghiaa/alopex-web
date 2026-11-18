import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const invoke = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { functions: { invoke: (...args: unknown[]) => invoke(...args) } },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const latestPriceEur = vi.fn();
const recordTrade = vi.fn();
vi.mock("@/lib/manual-trades", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/manual-trades")>()),
  latestPriceEur: (...args: unknown[]) => latestPriceEur(...args),
  recordTrade: (...args: unknown[]) => recordTrade(...args),
}));

import { AddHoldingPanel } from "./add-holding-panel";
import { formatISODate } from "@/lib/date";

describe("AddHoldingPanel", () => {
  // iOS view board: the long example was cut off on a phone.
  it("keeps the stock search hint short enough for a phone", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <AddHoldingPanel kind="stock" defaultOpen />
      </QueryClientProvider>,
    );
    expect(screen.getByLabelText("Search")).toHaveAttribute("placeholder", "Name, ticker or ISIN");
  });

  it("left-open #1 says why an unclear amount like 1,250 is refused", async () => {
    invoke.mockResolvedValue({
      data: { results: [{ id: "btc", symbol: "BTC", name: "Bitcoin", detail: "" }] },
      error: null,
    });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <AddHoldingPanel kind="crypto" defaultOpen />
      </QueryClientProvider>,
    );
    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "bitcoin" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    fireEvent.change(await screen.findByLabelText("Amount"), { target: { value: "1,250" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByRole("alert")).toHaveTextContent('"1,250" could mean 1250 or 1.25');
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  // iOS view board: on a phone nothing seemed to happen. Suggestions now come while you type.
  describe("live suggestions", () => {
    const found = {
      data: { results: [{ id: "btc", symbol: "BTC", name: "Bitcoin", detail: "" }] },
      error: null,
    };
    const open = () =>
      render(
        <QueryClientProvider client={new QueryClient()}>
          <AddHoldingPanel kind="crypto" defaultOpen />
        </QueryClientProvider>,
      );

    it("searches after a short pause once two letters are typed", async () => {
      invoke.mockReset().mockResolvedValue(found);
      open();
      fireEvent.change(screen.getByLabelText("Search"), { target: { value: "b" } });
      await new Promise((r) => setTimeout(r, 450));
      expect(invoke).not.toHaveBeenCalled();
      fireEvent.change(screen.getByLabelText("Search"), { target: { value: "bi" } });
      fireEvent.change(screen.getByLabelText("Search"), { target: { value: "bit" } });
      expect(await screen.findByText("Bitcoin")).toBeInTheDocument();
      // One search for the pause, not one per letter.
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke.mock.calls[0]![1]).toMatchObject({ body: { action: "search", query: "bit" } });
    });

    it("does not search the same words twice when Search is pressed after the pause", async () => {
      invoke.mockReset().mockResolvedValue(found);
      open();
      fireEvent.change(screen.getByLabelText("Search"), { target: { value: "bitcoin" } });
      await screen.findByText("Bitcoin");
      fireEvent.click(screen.getByRole("button", { name: "Search" }));
      await new Promise((r) => setTimeout(r, 50));
      expect(invoke).toHaveBeenCalledTimes(1);
    });

    it("closes the phone keyboard when Search is pressed", async () => {
      invoke.mockReset().mockResolvedValue(found);
      open();
      const input = screen.getByLabelText("Search");
      input.focus();
      fireEvent.change(input, { target: { value: "eth" } });
      fireEvent.click(screen.getByRole("button", { name: "Search" }));
      expect(document.activeElement).not.toBe(input);
      await screen.findByText("Bitcoin");
    });

    it("clears old suggestions when the words get too short", async () => {
      invoke.mockReset().mockResolvedValue(found);
      open();
      fireEvent.change(screen.getByLabelText("Search"), { target: { value: "bit" } });
      await screen.findByText("Bitcoin");
      fireEvent.change(screen.getByLabelText("Search"), { target: { value: "" } });
      expect(screen.queryByText("Bitcoin")).toBeNull();
    });

    it("lets Search retry the same words after a failed search", async () => {
      invoke
        .mockReset()
        .mockResolvedValueOnce({ data: null, error: new Error("down") })
        .mockResolvedValue(found);
      open();
      fireEvent.change(screen.getByLabelText("Search"), { target: { value: "bitcoin" } });
      await screen.findByRole("alert");
      fireEvent.click(screen.getByRole("button", { name: "Search" }));
      expect(await screen.findByText("Bitcoin")).toBeInTheDocument();
      expect(invoke).toHaveBeenCalledTimes(2);
    });
  });

  // protects=a holding added by hand has a return (Marco); fails_when=it never shows a %
  describe("what you paid", () => {
    const today = formatISODate(new Date());
    const pickIsin = async () => {
      invoke
        .mockReset()
        .mockImplementation(async (_fn: string, { body }: { body: { action: string } }) =>
          body.action === "search"
            ? {
                data: {
                  results: [{ id: "VWCE.DE", symbol: "VWCE", name: "All-World", detail: "" }],
                },
                error: null,
              }
            : { data: { added: true, priced: true }, error: null },
        );
      latestPriceEur.mockReset().mockResolvedValue(110);
      recordTrade.mockReset().mockResolvedValue(undefined);
      render(
        <QueryClientProvider client={new QueryClient()}>
          <AddHoldingPanel kind="stock" defaultOpen />
        </QueryClientProvider>,
      );
      fireEvent.change(screen.getByLabelText("Search"), { target: { value: "IE00BK5BQT80" } });
      fireEvent.change(await screen.findByLabelText("Shares"), { target: { value: "10" } });
    };

    it("saves one buy on the day and at the price given", async () => {
      await pickIsin();
      fireEvent.change(screen.getByLabelText("Bought on"), { target: { value: "2025-03-03" } });
      fireEvent.change(screen.getByLabelText("Average price, €"), { target: { value: "95.5" } });
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
      await vi.waitFor(() => expect(recordTrade).toHaveBeenCalled());
      expect(recordTrade.mock.calls[0]![1]).toMatchObject({
        kind: "stock",
        key: "IE00BK5BQT80",
        side: "buy",
        trade_date: "2025-03-03",
        shares: 10,
        price_eur: 95.5,
        source: "Manual",
      });
      expect(latestPriceEur).not.toHaveBeenCalled();
    });

    it("left empty, is a buy today at today's price", async () => {
      await pickIsin();
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
      await vi.waitFor(() => expect(recordTrade).toHaveBeenCalled());
      expect(recordTrade.mock.calls[0]![1]).toMatchObject({ trade_date: today, price_eur: 110 });
      expect(latestPriceEur.mock.calls[0]!.slice(1)).toEqual(["stock", "IE00BK5BQT80"]);
    });

    it("saves no buy when there is no price yet", async () => {
      await pickIsin();
      latestPriceEur.mockResolvedValue(null);
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
      await vi.waitFor(() => expect(latestPriceEur).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 20));
      expect(recordTrade).not.toHaveBeenCalled();
    });

    it("says so when the buy can't be saved, and still adds the holding", async () => {
      const { toast } = await import("sonner");
      await pickIsin();
      recordTrade.mockRejectedValue(new Error("down"));
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
      await vi.waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith(
          "All-World: what you paid wasn't saved. Tap its return to add it.",
        ),
      );
      expect(toast.success).toHaveBeenCalledWith("All-World added");
    });

    it("asks for the price when the day is in the past", async () => {
      await pickIsin();
      fireEvent.change(screen.getByLabelText("Bought on"), { target: { value: "2025-03-03" } });
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
      expect(screen.getByRole("alert")).toHaveTextContent("Enter the average price you paid");
      expect(invoke).toHaveBeenCalledTimes(1);
    });

    it("refuses a day in the future", async () => {
      await pickIsin();
      fireEvent.change(screen.getByLabelText("Bought on"), { target: { value: "2999-01-01" } });
      fireEvent.change(screen.getByLabelText("Average price, €"), { target: { value: "95" } });
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
      expect(screen.getByRole("alert")).toHaveTextContent("can't be in the future");
    });
  });
});
