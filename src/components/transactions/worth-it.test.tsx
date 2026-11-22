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
  });
});
