import { describe, expect, it } from "vitest";
import {
  debtorsFrom,
  namesLookAlike,
  paybackMessage,
  suggestPaybacks,
  type Debtor,
  type PaybackCandidate,
} from "@/lib/payback";
import type { GroupSummary } from "@/lib/import/splitwise-balances";
import type { SplitPerson } from "@/lib/splits";

const person = (name: string, open: number): SplitPerson => ({ name, open, rows: [] });
const group = (currency: string, people: GroupSummary["people"]): GroupSummary => ({
  group: "Flat",
  myBalance: 0,
  myBalanceEur: 0,
  currency,
  updatedAt: "2026-11-01",
  people,
  stale: false,
});
const pay = (over: Partial<PaybackCandidate> = {}): PaybackCandidate => ({
  account_uid: "acc",
  entry_reference: "p1",
  booking_date: "2026-11-15",
  amount: 320,
  currency: "EUR",
  amount_eur: 320,
  payer: "CRISTIAN FIORE",
  linked_contact: null,
  ...over,
});
const debtor = (name: string, open: number): Debtor => ({ name, open, splitwiseOnly: false });

describe("namesLookAlike", () => {
  it.each([
    ["CRISTIAN FIORE", "Crifiore"],
    ["Fiore Cristian", "Crifiore"],
    ["Cristian Fiore", "cristianfiore"],
    ["Anna Rossi", "Anna"],
    ["ANNA  ROSSÌ.", "anna rossi"],
    ["Cristian Fiore", "Cri Fiore"],
    ["Maria José García", "Jose Garcia"],
  ])("%s could be %s", (payer, contact) => expect(namesLookAlike(payer, contact)).toBe(true));

  it.each([
    ["Cristian Fiore", "Anna"],
    ["Cristian Fiore", "Cr"],
    ["Cristian Fiore", "Fiorella"],
    ["Cristian Fiore", "Cristian Fiore Rossi"],
    ["Anna", "Annabella"],
    ["Anna Rossi", "Aross"],
    [null, "Anna"],
    ["...", "Anna"],
    ["Anna", " - "],
  ])("%s is not %s", (payer, contact) => expect(namesLookAlike(payer, contact)).toBe(false));

  it("uses each payer word once", () => {
    expect(namesLookAlike("Anna", "Anna Anna")).toBe(false);
    expect(namesLookAlike("Anna Anna", "Anna Anna")).toBe(true);
  });
});

describe("debtorsFrom", () => {
  const rate = (c: string) => (c === "EUR" ? 1 : c === "GBP" ? 1.2 : null);

  it("adds split bills and Splitwise per name, case-insensitive, in euros", () => {
    const out = debtorsFrom(
      [person("Anna", 60), person("Luca", -20), person("Bea", 0)],
      [
        group("GBP", [
          { person: "anna", balance: -50, owesYou: true },
          { person: "Max", balance: 10, owesYou: false },
        ]),
      ],
      rate,
    );
    expect(out).toEqual([{ name: "Anna", open: 120, splitwiseOnly: false }]);
  });

  it("marks Splitwise-only debtors and drops groups without a rate", () => {
    const out = debtorsFrom(
      [],
      [
        group("EUR", [{ person: "Crifiore", balance: -320, owesYou: true }]),
        group("XYZ", [{ person: "Zed", balance: -5, owesYou: true }]),
      ],
      rate,
    );
    expect(out).toEqual([{ name: "Crifiore", open: 320, splitwiseOnly: true }]);
  });

  it("rounds to the cent and drops what is under a cent", () => {
    expect(debtorsFrom([person("A", 10.004), person("B", 0.004)], [], rate)).toEqual([
      { name: "A", open: 10, splitwiseOnly: false },
    ]);
  });
});

describe("suggestPaybacks", () => {
  it("a linked payer is asked about while that person still owes you", () => {
    const debtors = [debtor("Crifiore", 320)];
    expect(suggestPaybacks([pay({ payer: "X Y", linked_contact: "crifiore" })], debtors)).toEqual([
      {
        payment: expect.objectContaining({ entry_reference: "p1" }),
        debtor: debtors[0],
        reason: "linked",
      },
    ]);
    expect(suggestPaybacks([pay({ linked_contact: "Someone Else" })], debtors)).toEqual([]);
  });

  it("a name that looks alike is asked about, whatever the amount", () => {
    const out = suggestPaybacks(
      [pay({ amount_eur: 50 })],
      [debtor("Anna", 10), debtor("Crifiore", 320)],
    );
    expect(out.map((s) => [s.debtor.name, s.reason])).toEqual([["Crifiore", "name"]]);
  });

  it("of several look-alikes, the one owing closest to the amount", () => {
    const out = suggestPaybacks(
      [pay({ payer: "Anna Rossi", amount_eur: 95 })],
      [debtor("Anna", 20), debtor("Rossi", 100)],
    );
    expect(out[0]?.debtor.name).toBe("Rossi");
  });

  it("an exact amount is asked about only when one person owes it", () => {
    const one = suggestPaybacks(
      [pay({ payer: "ACME SRL", amount_eur: 42.5 })],
      [debtor("Bea", 42.5), debtor("Ugo", 10)],
    );
    expect(one.map((s) => [s.debtor.name, s.reason])).toEqual([["Bea", "amount"]]);
    expect(
      suggestPaybacks(
        [pay({ payer: "ACME SRL", amount_eur: 42.5 })],
        [debtor("Bea", 42.5), debtor("Ugo", 42.5)],
      ),
    ).toEqual([]);
    expect(
      suggestPaybacks([pay({ payer: "ACME SRL", amount_eur: null })], [debtor("Bea", 42.5)]),
    ).toEqual([]);
  });

  it("payments with no guess are left out", () => {
    expect(
      suggestPaybacks([pay({ payer: "Employer Srl", amount_eur: 2000 })], [debtor("Anna", 60)]),
    ).toEqual([]);
    expect(suggestPaybacks([pay()], [])).toEqual([]);
  });
});

describe("paybackMessage", () => {
  const money = (n: number) => `€${n.toFixed(2)}`;
  it("names the bills settled and what is left over", () => {
    expect(
      paybackMessage(
        "Anna",
        { settled: ["a", "b"], settled_eur: 260, left_eur: 240, linked: true },
        false,
        money,
      ),
    ).toBe("Anna paid you back: 2 bills settled, €240.00 left over.");
    expect(
      paybackMessage(
        "Anna",
        { settled: ["a"], settled_eur: 60, left_eur: 0, linked: false },
        false,
        money,
      ),
    ).toBe("Anna paid you back: 1 bill settled.");
  });
  it("with nothing settled, says why", () => {
    expect(
      paybackMessage(
        "Cri",
        { settled: [], settled_eur: 0, left_eur: 320, linked: true },
        true,
        money,
      ),
    ).toBe("Marked as Cri paying you back. Record it in Splitwise too.");
    expect(
      paybackMessage(
        "Cri",
        { settled: [], settled_eur: 0, left_eur: 10, linked: true },
        false,
        money,
      ),
    ).toMatch(/No bill was fully covered/);
  });
});
