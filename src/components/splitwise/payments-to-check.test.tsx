import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Debtor, PaybackCandidate, PaybackSuggestion } from "@/lib/payback";
import { PaymentsToCheck } from "./payments-to-check";

const payment: PaybackCandidate = {
  account_uid: "acc",
  entry_reference: "p1",
  booking_date: "2026-11-15",
  amount: 320,
  currency: "EUR",
  amount_eur: 320,
  payer: "CRISTIAN FIORE",
  linked_contact: null,
};
const cri: Debtor = { name: "Crifiore", open: 320, splitwiseOnly: false };
const anna: Debtor = { name: "Anna", open: 60, splitwiseOnly: false };
const suggestion = (over: Partial<PaybackSuggestion> = {}): PaybackSuggestion => ({
  payment,
  debtor: cri,
  reason: "name",
  ...over,
});

function view(
  s: Array<PaybackSuggestion>,
  debtors: Array<Debtor> = [cri, anna],
  busy: string | null = null,
) {
  const onConfirm = vi.fn();
  const onDismiss = vi.fn();
  const ui = (d: Array<Debtor>) => (
    <PaymentsToCheck
      suggestions={s}
      debtors={d}
      busy={busy}
      onConfirm={onConfirm}
      onDismiss={onDismiss}
    />
  );
  const { rerender } = render(ui(debtors));
  return { onConfirm, onDismiss, setDebtors: (d: Array<Debtor>) => rerender(ui(d)) };
}

describe("PaymentsToCheck", () => {
  it("shows nothing when there is nothing to ask", () => {
    view([]);
    expect(screen.queryByRole("region", { name: "Payments to check" })).toBeNull();
  });

  // protects=the "Is this X?" question; fails_when=it hides the amount, payer, date or the reason
  it("asks about the payment with its amount, payer, date and why", () => {
    view([suggestion()]);
    expect(screen.getByText("Is this Crifiore?")).toBeTruthy();
    expect(screen.getByText(/from CRISTIAN FIORE/)).toBeTruthy();
    expect(screen.getByText("€320.00")).toBeTruthy();
    expect(screen.getByText(/The name looks alike · owes you €320.00/)).toBeTruthy();
    expect(screen.getByText(/15 Nov/)).toBeTruthy();
  });

  it("says why for a linked payer and an exact amount", () => {
    view([suggestion({ reason: "linked" })]);
    expect(screen.getByText(/Crifiore paid you from this name before/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Not Crifiore" })).toBeTruthy();
  });

  it("an exact amount names the person it matches", () => {
    view([suggestion({ reason: "amount" })]);
    expect(screen.getByText(/Same as what Crifiore owes you/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Not a payback" })).toBeTruthy();
  });

  it("Yes confirms the suggested person; Not a payback dismisses", async () => {
    const { onConfirm, onDismiss } = view([suggestion()]);
    await userEvent.click(screen.getByRole("button", { name: "Yes, it's Crifiore" }));
    expect(onConfirm).toHaveBeenCalledWith(payment, cri);
    await userEvent.click(screen.getByRole("button", { name: "Not a payback" }));
    expect(onDismiss).toHaveBeenCalledWith(payment, suggestion());
  });

  // protects=correcting a wrong guess; fails_when=Someone else offers the guessed person or saves on Cancel
  it("Someone else picks another person who owes you; Cancel goes back without saving", async () => {
    const { onConfirm } = view([suggestion()]);
    await userEvent.click(screen.getByRole("button", { name: "Someone else" }));
    const select = screen.getByLabelText("Who paid you €320.00?");
    expect([...(select as HTMLSelectElement).options].map((o) => o.value)).toEqual(["Anna"]);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Yes, it's Crifiore" })).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Someone else" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(onConfirm).toHaveBeenCalledWith(payment, anna);
    expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
  });

  // protects=recording the person you picked; fails_when=the list changes under the open form and
  // Confirm silently records whoever is now first
  it("Someone else never records a person you didn't pick", async () => {
    const bob: Debtor = { name: "Bob", open: 30, splitwiseOnly: false };
    const { onConfirm, setDebtors } = view([suggestion()], [cri, anna, bob]);
    await userEvent.click(screen.getByRole("button", { name: "Someone else" }));
    await userEvent.selectOptions(screen.getByLabelText(/Who paid you/), "Bob");
    setDebtors([cri, anna]); // Bob settled up elsewhere while the form was open
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(onConfirm).not.toHaveBeenCalled();
    // The form says so instead of showing Anna as if picked.
    expect((screen.getByLabelText(/Who paid you/) as HTMLSelectElement).value).toBe("");
    await userEvent.selectOptions(screen.getByLabelText(/Who paid you/), "Anna");
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(onConfirm).toHaveBeenCalledWith(payment, anna);
  });

  // protects=a keyboard way out of the form; fails_when=Esc leaves it open
  it("Esc closes the Someone else form without saving", async () => {
    const { onConfirm } = view([suggestion()]);
    await userEvent.click(screen.getByRole("button", { name: "Someone else" }));
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("no Someone else when nobody else owes you", () => {
    view([suggestion()], [cri]);
    expect(screen.queryByRole("button", { name: "Someone else" })).toBeNull();
  });

  // protects=answers never silently dropped; fails_when=another row looks clickable while one saves
  // (the page answers one payment at a time and ignores clicks meanwhile)
  it("while any payment saves, every row waits", () => {
    const other = suggestion({
      payment: { ...payment, entry_reference: "p2", payer: "ANNA ROSSI" },
      debtor: anna,
    });
    view([suggestion(), other], [cri, anna], "acc|p1");
    for (const name of ["Yes, it's Anna", "Not a payback"])
      for (const b of screen.getAllByRole("button", { name })) expect(b).toBeDisabled();
  });

  it("while a payment saves, its buttons wait", () => {
    view([suggestion()], [cri, anna], "acc|p1");
    for (const name of ["Yes, it's Crifiore", "Someone else", "Not a payback"])
      expect(screen.getByRole("button", { name })).toBeDisabled();
  });
});
