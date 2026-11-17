import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const invoke = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { functions: { invoke: (...args: unknown[]) => invoke(...args) } },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { AddHoldingPanel } from "./add-holding-panel";

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
});
