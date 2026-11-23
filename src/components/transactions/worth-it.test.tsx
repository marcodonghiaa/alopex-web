import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { WorthItSpotlight } from "./worth-it";
import type { TransactionRow } from "@/lib/transactions";

// protects=the Worth it? question shows only my share; fails_when=it shows the whole split charge
describe("Worth it? spotlight", () => {
  it("asks about my share of a split charge", () => {
    const tx = {
      entry_reference: "r1",
      account_uid: "a1",
      booking_date: "2026-10-05",
      category: "Dine Out",
      creditor_name: "Pizza",
      currency: "EUR",
      amount: 60,
      personal_amount: 20,
    } as TransactionRow;
    render(<WorthItSpotlight tx={tx} onAnswer={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText("€20.00")).toBeInTheDocument();
    expect(screen.queryByText("€60.00")).toBeNull();
    // Polish 4 #7: €20.00 alone may not match what was paid at the till.
    // fails_when=the spotlight doesn't say it's a share of the whole charge
    expect(screen.getByText("your share of €60.00")).toBeInTheDocument();
  });

  it("adds no share line to a charge that is all mine", () => {
    const tx = {
      entry_reference: "r2",
      account_uid: "a1",
      category: "Dine Out",
      creditor_name: "Pizza",
      currency: "EUR",
      amount: 60,
      personal_amount: null,
    } as TransactionRow;
    render(<WorthItSpotlight tx={tx} onAnswer={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText("€60.00")).toBeInTheDocument();
    expect(screen.queryByText(/your share/)).toBeNull();
  });
});
