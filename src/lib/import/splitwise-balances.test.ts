import { describe, expect, it, vi } from "vitest";
import type { SplitwiseFile } from "./splitwise-parse";
import type { SplitwiseRow } from "./splitwise-parse";
import {
  balancesFromFile,
  pairwiseCents,
  saveBalances,
  summarizeBalances,
  type BalanceRow,
} from "./splitwise-balances";

const file = (total: SplitwiseFile["total"], members = ["Marco", "Pietro", "Giulia"]) =>
  ({ members, rows: [], total }) as SplitwiseFile;

const r = (netCents: Array<number>, currency = "USD", category = "General"): SplitwiseRow => ({
  row: 1,
  date: "2026-10-01",
  description: "x",
  category,
  costCents: 0,
  currency,
  netCents,
});

describe("pairwiseCents", () => {
  // protects=who owes me, not the group; fails_when=a payer's debtors are not split in proportion
  it("works out what each person owes me or I owe them, row by row", () => {
    const f = {
      members: ["Marco", "Pietro", "Giulia"],
      rows: [
        r([2000, -1000, -1000]), // I paid 30, split 3 ways: each owes me 10
        r([-500, 1000, -500]), // Pietro paid 15: I owe him 5
        r([1000, -1000, 0], "USD", "Payment"), // I paid Pietro 10: I owe him 10 less
        r([-700, 1400, -700], "EUR"), // other currency: left out
        r([0, 300, -300]), // between the others: not mine
      ],
      total: null,
    } as SplitwiseFile;
    expect(pairwiseCents(f, 0, "USD")).toEqual({ cents: [0, -1500, -1000], skippedRows: 1 });
  });

  // protects=no made-up debts with "simplify debts"; fails_when=a settle-up made on someone else's
  // behalf shows as a debt both ways
  it("passes a settle-up made on someone else's behalf on to them", () => {
    const f = {
      members: ["Me", "A", "B"],
      rows: [
        r([2000, -2000, 0]), // I paid 20 for A
        r([0, 2000, -2000]), // A paid 20 for B
        r([-2000, 0, 2000], "USD", "Payment"), // Splitwise had B pay me instead of A
      ],
      total: null,
    } as SplitwiseFile;
    expect(pairwiseCents(f, 0, "USD").cents).toEqual([0, 0, 0]);
  });

  it("keeps a settle-up between the two of us as it is", () => {
    const f = {
      members: ["Me", "A", "B"],
      rows: [r([2000, -1000, -1000]), r([-1000, 1000, 0], "USD", "Payment")],
      total: null,
    } as SplitwiseFile;
    expect(pairwiseCents(f, 0, "USD").cents).toEqual([0, 0, -1000]);
  });

  it("passes on what I overpaid someone to whoever I really owed", () => {
    const f = {
      members: ["Me", "A", "B"],
      rows: [r([-1000, 0, 1000]), r([1000, -1000, 0], "USD", "Payment")],
      total: null,
    } as SplitwiseFile;
    expect(pairwiseCents(f, 0, "USD").cents).toEqual([0, 0, 0]);
  });

  // protects=amounts add up to my total; fails_when=per-person rounding drifts by a cent
  it("rounds so the amounts add up to what I'm owed overall", () => {
    const f = {
      members: ["Me", "A", "B", "C"],
      rows: [r([100, -33, -33, -34])],
      total: null,
    } as SplitwiseFile;
    const { cents } = pairwiseCents(f, 0, "USD");
    expect(cents.reduce((a, b) => a + b, 0)).toBe(-100);
  });

  it("shares my debt among several payers in proportion", () => {
    const f = {
      members: ["Me", "A", "B"],
      rows: [r([-900, 600, 300])],
      total: null,
    } as SplitwiseFile;
    expect(pairwiseCents(f, 0, "USD").cents).toEqual([0, 600, 300]);
  });
});

describe("balancesFromFile", () => {
  it("keeps my group total from the totals row and what I owe each other member", () => {
    const f = {
      members: ["Marco", "Pietro", "Giulia"],
      rows: [r([2000, -1000, -1000])],
      total: { currency: "USD", netCents: [2000, -1000, -1000] },
    } as SplitwiseFile;
    expect(balancesFromFile(f, 0)).toEqual({
      currency: "USD",
      skippedRows: 0,
      entries: [
        { person: "Marco", cents: 2000, isMe: true },
        { person: "Pietro", cents: -1000, isMe: false },
        { person: "Giulia", cents: -1000, isMe: false },
      ],
    });
  });

  it("returns null when the file has no totals row", () => {
    expect(balancesFromFile(file(null), 0)).toBeNull();
  });

  it("keeps same-named members apart", () => {
    const out = balancesFromFile(
      file({ currency: "USD", netCents: [1, 2, 3] }, ["A", "B", "B"]),
      0,
    );
    expect(out?.entries.map((e) => e.person)).toEqual(["A", "B (column 2)", "B (column 3)"]);
  });
});

describe("saveBalances", () => {
  it("sends the group and balances in whole currency units", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    await saveBalances({ rpc }, "berkeley", {
      currency: "USD",
      skippedRows: 0,
      entries: [{ person: "Marco", cents: 39145, isMe: true }],
    });
    expect(rpc).toHaveBeenCalledWith("save_splitwise_balances", {
      p_group: "berkeley",
      p_balances: [
        { person: "Marco", balance: 391.45, currency: "USD", is_me: true, basis: "pairwise" },
      ],
    });
  });

  it("throws the database message on failure", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "nope" } });
    await expect(
      saveBalances({ rpc }, "g", { currency: "USD", entries: [], skippedRows: 0 }),
    ).rejects.toThrow("nope");
  });
});

const rows: Array<BalanceRow> = [
  {
    group_name: "berkeley",
    person: "Marco",
    balance: 400,
    currency: "USD",
    is_me: true,
    updated_at: "2026-10-18T10:00:00Z",
    basis: "pairwise",
  },
  {
    group_name: "berkeley",
    person: "Pietro",
    balance: -100,
    currency: "USD",
    is_me: false,
    updated_at: "2026-10-18T10:00:00Z",
    basis: "pairwise",
  },
  {
    group_name: "berkeley",
    person: "Giulia",
    balance: 20,
    currency: "USD",
    is_me: false,
    updated_at: "2026-10-18T10:00:00Z",
    basis: "pairwise",
  },
  {
    group_name: "trip",
    person: "Me",
    balance: -50,
    currency: "EUR",
    is_me: true,
    updated_at: "2026-10-01T10:00:00Z",
    basis: "pairwise",
  },
];
const rate = (c: string) => (c === "EUR" ? 1 : c === "USD" ? 0.5 : null);

describe("summarizeBalances", () => {
  it("groups people per group, owes first, with my balance and the euro value", () => {
    const [g] = summarizeBalances(rows, rate).filter((s) => s.group === "berkeley");
    expect(g?.myBalance).toBe(400);
    expect(g?.myBalanceEur).toBe(200);
    expect(g?.people.map((p) => p.person)).toEqual(["Pietro", "Giulia"]);
    expect(g?.people[0]).toMatchObject({ person: "Pietro", balance: -100, owesYou: true });
    expect(g?.people[1]).toMatchObject({ person: "Giulia", balance: 20, owesYou: false });
    expect(g?.updatedAt).toBe("2026-10-18T10:00:00Z");
  });

  // protects=old group-basis rows are never read as per-person debts; fails_when=the basis is ignored
  it("keeps only my total for a group saved before per-person amounts", () => {
    const old = rows.map((x) =>
      x.group_name === "berkeley" ? { ...x, basis: "group" as const } : x,
    );
    const [g] = summarizeBalances(old, rate).filter((s) => s.group === "berkeley");
    expect(g).toMatchObject({ stale: true, myBalance: 400, people: [] });
    expect(summarizeBalances(old, rate).find((s) => s.group === "trip")?.stale).toBe(false);
  });

  it("leaves out people I'm square with", () => {
    const square = rows.map((x) => (x.person === "Giulia" ? { ...x, balance: 0 } : x));
    const [g] = summarizeBalances(square, rate).filter((s) => s.group === "berkeley");
    expect(g?.people.map((p) => p.person)).toEqual(["Pietro"]);
  });
});

// The Splitwise sync stores balances with basis 'api', one row per person and currency.
describe("summarizeBalances with synced balances", () => {
  const api = (over: Partial<BalanceRow>): BalanceRow => ({
    group_name: "flat",
    person: "Me",
    balance: 0,
    currency: "EUR",
    is_me: true,
    updated_at: "2026-11-10T10:00:00Z",
    basis: "api",
    ...over,
  });

  // protects=synced balances list who owes you; fails_when=basis 'api' is treated as stale
  it("reads basis 'api' as per-person amounts, not stale", () => {
    const [g] = summarizeBalances(
      [api({ balance: 30 }), api({ person: "Ana", balance: -30, is_me: false })],
      rate,
    );
    expect(g).toMatchObject({ stale: false, myBalance: 30, currency: "EUR" });
    expect(g?.people).toEqual([{ person: "Ana", balance: -30, owesYou: true }]);
  });

  // protects=a group with debts in two currencies; fails_when=one currency hides the other or
  // amounts in different currencies are mixed
  it("gives one summary per group and currency", () => {
    const out = summarizeBalances(
      [
        api({ balance: 30 }),
        api({ person: "Ana", balance: -30, is_me: false }),
        api({ balance: -8, currency: "USD" }),
        api({ person: "Ben", balance: 8, currency: "USD", is_me: false }),
      ],
      rate,
    );
    expect(out.map((g) => [g.group, g.currency, g.myBalance, g.myBalanceEur])).toEqual([
      ["flat", "EUR", 30, 30],
      ["flat", "USD", -8, -4],
    ]);
    expect(out[1]?.people).toEqual([{ person: "Ben", balance: 8, owesYou: false }]);
  });

  // protects=Splitwise leaves out my zero balance; fails_when=a currency where I'm even overall
  // but owe one friend and am owed by another disappears
  it("keeps a currency without my row, my total worked out from the others", () => {
    const [g] = summarizeBalances(
      [
        api({ person: "Ana", balance: -5, is_me: false }),
        api({ person: "Ben", balance: 5, is_me: false, updated_at: "2026-11-12T10:00:00Z" }),
      ],
      rate,
    );
    expect(g).toMatchObject({ myBalance: 0, updatedAt: "2026-11-12T10:00:00Z", stale: false });
    expect(g?.people.map((p) => p.person)).toEqual(["Ana", "Ben"]);
  });

  it("still skips a CSV group without my row", () => {
    expect(
      summarizeBalances([api({ basis: "pairwise", is_me: false, person: "Ana" })], rate),
    ).toEqual([]);
  });
});
