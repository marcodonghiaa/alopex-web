import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { InvestmentEvent } from "@/lib/investment-events";
import { InvestmentIncome, eventsForPage } from "./investment-income";

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
    expect(row("Taxes")).toMatch(/−?-?€?2\.00/);
    expect(row("Fees")).toContain("1.00");
    expect(screen.queryByText("Interest")).toBeNull();
  });

  it("coins' events go to Crypto, shares' and cash to Portfolio", () => {
    const coin = ev({ asset_kind: "crypto", key: "BTC" });
    const cash = ev({ kind: "interest", asset_kind: null, key: null });
    const share = ev({});
    expect(eventsForPage([coin, cash, share], "crypto")).toEqual([coin]);
    expect(eventsForPage([coin, cash, share], "stock")).toEqual([cash, share]);
  });
});
