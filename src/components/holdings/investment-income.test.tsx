import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { InvestmentEvent } from "@/lib/investment-events";
import { InvestmentIncome, eventsForPage, incomeAndCosts } from "./investment-income";

// Your own clock: just past midnight on 1 January where you are, still 31 December in UTC.
vi.mock("@/lib/trades", async (load) => ({
  ...(await load<typeof import("@/lib/trades")>()),
  localToday: () => "2027-01-01",
}));
afterEach(() => vi.useRealTimers());

const ev = (e: Partial<InvestmentEvent>): InvestmentEvent => ({
  kind: "dividend",
  asset_kind: "stock",
  key: "XX0000000001",
  event_date: "2026-03-02",
  amount_eur: 10,
  tax_eur: 0,
  fee_eur: 0,
  raw_type: "CASH|DIVIDEND",
  source: "trade_republic",
  external_id: null,
  ...e,
});

describe("InvestmentIncome", () => {
  it("shows nothing until there's income or a cost", () => {
    const { container } = render(<InvestmentIncome events={[]} page="stock" today="2026-11-17" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows this year's and all-time income, taxes and fees; a cost reads as money out", () => {
    render(
      <InvestmentIncome
        page="stock"
        today="2026-11-17"
        events={[
          ev({ amount_eur: 8, tax_eur: 2 }),
          ev({ event_date: "2025-06-01", amount_eur: 5 }),
          ev({ kind: "fee", asset_kind: null, key: null, amount_eur: -1 }),
        ]}
      />,
    );
    const row = (label: string) => screen.getByText(label).parentElement?.textContent;
    expect(row("Dividends")).toMatch(/8\.00.*13\.00/);
    expect(row("Taxes")).toBe("Taxes-€2.00-€2.00");
    expect(row("Fees")).toBe("Fees-€1.00-€1.00");
    expect(screen.queryByText("Interest")).toBeNull();
  });

  it("says account taxes and fees count here but not in any holding's return", () => {
    render(
      <InvestmentIncome
        page="stock"
        today="2026-11-17"
        events={[ev({ kind: "tax", asset_kind: null, key: null, amount_eur: -1 })]}
      />,
    );
    expect(
      screen.getByText(
        "Taxes and fees not tied to a holding, like stamp duty, count here but not in any holding's return.",
      ),
    ).toBeInTheDocument();
  });

  it("this year is your own calendar's, not UTC's", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-12-31T23:30:00Z"));
    render(<InvestmentIncome page="stock" events={[ev({ amount_eur: 8 })]} />);
    expect(screen.getByText("Dividends").parentElement?.textContent).toBe("Dividends€0.00€8.00");
  });

  it("a total that's only rounding dust (fees charged and given back) shows no row", () => {
    const fee = (amount_eur: number) =>
      ev({ kind: "fee", asset_kind: null, key: null, amount_eur });
    render(
      <InvestmentIncome
        page="stock"
        today="2026-11-17"
        events={[ev({ amount_eur: 8 }), fee(-0.1), fee(-0.2), fee(0.3)]}
      />,
    );
    expect(screen.getByText("Dividends")).toBeInTheDocument();
    expect(screen.queryByText("Fees")).toBeNull();
  });

  it("coins' events go to Crypto, shares' and cash to Portfolio", () => {
    const coin = ev({ asset_kind: "crypto", key: "BTC" });
    const cash = ev({ kind: "interest", asset_kind: null, key: null });
    const share = ev({});
    expect(eventsForPage([coin, cash, share], "crypto")).toEqual([coin]);
    expect(eventsForPage([coin, cash, share], "stock")).toEqual([cash, share]);
  });
});

describe("incomeAndCosts", () => {
  it("adds the fees and taxes paid on trades, from the date on", () => {
    const trades = [
      { trade_date: "2026-02-01", fee_eur: 1, tax_eur: 0.5 },
      { trade_date: "2025-02-01", fee_eur: 1, tax_eur: 0 },
    ];
    expect(incomeAndCosts([], trades)).toMatchObject({ fees: 2, taxes: 0.5 });
    expect(incomeAndCosts([], trades, "2026-01-01")).toMatchObject({ fees: 1, taxes: 0.5 });
  });

  it("shows trade fees even with no income", () => {
    render(
      <InvestmentIncome
        events={[]}
        trades={[{ trade_date: "2026-02-01", fee_eur: 1, tax_eur: 0 }]}
        page="stock"
        today="2026-11-17"
      />,
    );
    expect(screen.getByText("Fees")).toBeInTheDocument();
  });
});
