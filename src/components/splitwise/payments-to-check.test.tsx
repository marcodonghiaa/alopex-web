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
  payer: "MARIO VERDI",
  linked_contact: null,
};
const mario: Debtor = { name: "Marverdi", open: 320, onSplitwise: 0, splitwiseOnly: false };
const anna: Debtor = { name: "Anna", open: 60, onSplitwise: 0, splitwiseOnly: false };
const suggestion = (over: Partial<PaybackSuggestion> = {}): PaybackSuggestion => ({
  payment,
  debtor: mario,
  reason: "name",
  ...over,
});

function view(
  s: Array<PaybackSuggestion>,
  debtors: Array<Debtor> = [mario, anna],
  busy: string | null = null,
) {
  const onConfirm = vi.fn();
  const onDismiss = vi.fn();
  // The props as they are now: each setter changes one and keeps the others.
  const now = { d: debtors, sg: s, b: busy };
  const ui = () => (
    <PaymentsToCheck
      suggestions={now.sg}
      debtors={now.d}
      busy={now.b}
      onConfirm={onConfirm}
      onDismiss={onDismiss}
    />
  );
  const { rerender } = render(ui());
  return {
    onConfirm,
    onDismiss,
    setDebtors: (d: Array<Debtor>) => rerender(((now.d = d), ui())),
    setSuggestions: (sg: Array<PaybackSuggestion>) => rerender(((now.sg = sg), ui())),
    setBusy: (b: string | null) => rerender(((now.b = b), ui())),
  };
}

describe("PaymentsToCheck", () => {
  it("shows nothing when there is nothing to ask", () => {
    view([]);
    expect(screen.queryByRole("region", { name: "Payments to check" })).toBeNull();
  });

  // protects=the "Is this X?" question; fails_when=it hides the amount, payer, date or the reason
  it("asks about the payment with its amount, payer, date and why", () => {
    view([suggestion()]);
    expect(screen.getByText("Is this Marverdi?")).toBeTruthy();
    expect(screen.getByText(/from MARIO VERDI/)).toBeTruthy();
    expect(screen.getByText("€320.00")).toBeTruthy();
    expect(screen.getByText(/The names look alike · owes you €320.00/)).toBeTruthy();
    expect(screen.getByText(/15 Nov/)).toBeTruthy();
  });

  it("says why for a linked payer and an exact amount", () => {
    view([suggestion({ reason: "linked" })]);
    expect(
      screen.getByText(/You linked this payer to Marverdi before · owes you €320.00/),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Not Marverdi" })).toBeTruthy();
  });

  it("an exact amount names the person it matches", () => {
    view([suggestion({ reason: "amount" })]);
    // The payment's amount is right above: no second "owes you €…" (U5).
    expect(screen.getByText("Exactly what Marverdi owes you")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Not a payback" })).toBeTruthy();
  });

  it("Yes confirms the suggested person; Not a payback dismisses", async () => {
    const { onConfirm, onDismiss } = view([suggestion()]);
    await userEvent.click(screen.getByRole("button", { name: "Yes, it's Marverdi" }));
    expect(onConfirm).toHaveBeenCalledWith(payment, mario);
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
    expect(screen.getByRole("button", { name: "Yes, it's Marverdi" })).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Someone else" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(onConfirm).toHaveBeenCalledWith(payment, anna);
    expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
  });

  // protects=recording the person you picked; fails_when=the list changes under the open form and
  // Confirm silently records whoever is now first
  it("Someone else never records a person you didn't pick", async () => {
    const bob: Debtor = { name: "Bob", open: 30, onSplitwise: 0, splitwiseOnly: false };
    const { onConfirm, setDebtors } = view([suggestion()], [mario, anna, bob]);
    await userEvent.click(screen.getByRole("button", { name: "Someone else" }));
    await userEvent.selectOptions(screen.getByLabelText(/Who paid you/), "Bob");
    setDebtors([mario, anna]); // Bob settled up elsewhere while the form was open
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

  // protects=keyboard and screen-reader users keep their place; fails_when=focus drops to the
  // page after closing the form or answering a payment
  it("focus stays in the list: back on Someone else after Cancel or Esc, next row after an answer", async () => {
    const other = suggestion({
      payment: { ...payment, entry_reference: "p2", payer: "ANNA ROSSI" },
      debtor: anna,
    });
    const { setSuggestions } = view([suggestion(), other]);
    const [someoneElse] = screen.getAllByRole("button", { name: "Someone else" });
    await userEvent.click(someoneElse!);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(document.activeElement).toBe(screen.getAllByRole("button", { name: "Someone else" })[0]);
    await userEvent.click(screen.getAllByRole("button", { name: "Someone else" })[0]!);
    await userEvent.keyboard("{Escape}");
    expect(document.activeElement).toBe(screen.getAllByRole("button", { name: "Someone else" })[0]);

    await userEvent.click(screen.getByRole("button", { name: "Yes, it's Marverdi" }));
    setSuggestions([other]); // answered: its row leaves
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Yes, it's Anna" }));
  });

  it("Confirm waits too while a payment saves", async () => {
    const { onConfirm, setBusy } = view([suggestion()]);
    await userEvent.click(screen.getByRole("button", { name: "Someone else" }));
    setBusy("acc|p2"); // another answer started saving
    const confirm = screen.getByRole("button", { name: "Confirm" });
    expect(confirm).toBeDisabled();
    await userEvent.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  // protects=focus never jumps later; fails_when=a failed save or the last answer leaves a pending
  // "move focus" that fires on some later list change
  it("a failed save or the last answer never moves focus later", async () => {
    const other = suggestion({
      payment: { ...payment, entry_reference: "p2", payer: "ANNA ROSSI" },
      debtor: anna,
    });
    const third = suggestion({
      payment: { ...payment, entry_reference: "p3", payer: "ANNA ROSSI" },
      debtor: anna,
    });
    const outside = document.createElement("input");
    document.body.append(outside);
    const { setSuggestions, setBusy } = view([suggestion(), other]);
    // A Yes that fails: it saves, then the row stays.
    await userEvent.click(screen.getByRole("button", { name: "Yes, it's Marverdi" }));
    setBusy("acc|p1");
    setBusy(null);
    outside.focus();
    setSuggestions([other, third]); // later, the list changes for another reason
    expect(document.activeElement).toBe(outside);
    // The last row answered: nothing left to focus, and nothing pending for later.
    setSuggestions([other]);
    await userEvent.click(screen.getByRole("button", { name: "Yes, it's Anna" }));
    setSuggestions([]);
    outside.focus();
    setSuggestions([third]);
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it("an answered row leaving while the save still shows lands focus once it ends", async () => {
    const other = suggestion({
      payment: { ...payment, entry_reference: "p2", payer: "ANNA ROSSI" },
      debtor: anna,
    });
    const { setSuggestions, setBusy } = view([suggestion(), other]);
    await userEvent.click(screen.getByRole("button", { name: "Yes, it's Marverdi" }));
    setBusy("acc|p1");
    setSuggestions([other]); // removed from the list while the buttons still wait
    setBusy(null);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Yes, it's Anna" }));
  });

  // protects=the Yes button on a phone; fails_when=a long name pushes it out of the card
  it("a long name shortens inside the Yes button instead of overflowing", () => {
    const long: Debtor = {
      name: "Maria Alessandra Bianchi-Ferraris di Montebello",
      open: 320,
      onSplitwise: 0,
      splitwiseOnly: false,
    };
    view([suggestion({ debtor: long })], [long, anna]);
    const yes = screen.getByRole("button", { name: `Yes, it's ${long.name}` });
    expect(yes.className).toMatch(/\bmax-w-full\b/);
    expect(yes.className.split(" ")).not.toContain("shrink-0");
    expect(yes.querySelector(".truncate")?.textContent).toBe(`Yes, it's ${long.name}`);
  });

  // protects=a tidy row on a phone; fails_when=a wrapped "Not a payback" sits inset from the
  // button edge above it (U4)
  it("Not a payback has no side inset, so when it wraps it lines up with Yes", () => {
    view([suggestion()]);
    const not = screen.getByRole("button", { name: "Not a payback" });
    expect(not.className.split(" ")).toContain("px-0");
    expect(not.className.split(" ")).not.toContain("px-4");
  });

  it("no Someone else when nobody else owes you", () => {
    view([suggestion()], [mario]);
    expect(screen.queryByRole("button", { name: "Someone else" })).toBeNull();
  });

  // protects=answers never silently dropped; fails_when=another row looks clickable while one saves
  // (the page answers one payment at a time and ignores clicks meanwhile)
  it("while any payment saves, every row waits", () => {
    const other = suggestion({
      payment: { ...payment, entry_reference: "p2", payer: "ANNA ROSSI" },
      debtor: anna,
    });
    view([suggestion(), other], [mario, anna], "acc|p1");
    for (const name of ["Yes, it's Anna", "Not a payback"])
      for (const b of screen.getAllByRole("button", { name })) expect(b).toBeDisabled();
  });

  it("while a payment saves, its buttons wait", () => {
    view([suggestion()], [mario, anna], "acc|p1");
    for (const name of ["Yes, it's Marverdi", "Someone else", "Not a payback"])
      expect(screen.getByRole("button", { name })).toBeDisabled();
  });
});
