import { describe, expect, it } from "vitest";
import { createFakeClient } from "./fake-client";

const NOW = new Date("2026-10-20T12:00:00Z");

describe("demo v_transactions_eur", () => {
  // Polish 3 #4: split purchases count as mine too (my share, still money out); only one paid
  // entirely for others has nothing of mine.
  it("counts an unsplit or split purchase as mine, like the real view", async () => {
    const client = createFakeClient(NOW);
    const { data: all } = await client
      .from("v_transactions_eur")
      .select("*")
      .eq("flow_type", "spend");
    const { data: mine } = await client
      .from("v_transactions_eur")
      .select("*")
      .eq("flow_type", "spend")
      .lt("personal_signed_amount_eur", 0);
    const withShare = (all ?? []).filter((r) => r.personal_amount !== 0);
    expect(withShare.some((r) => r.personal_amount != null)).toBe(true); // a split row is checked
    expect(mine?.length).toBe(withShare.length);
  });

  // Polish 1 #2: like the real view's payer_name (custom name, else the bank's debtor name).
  it("names the payer of incoming payments", async () => {
    const client = createFakeClient(NOW);
    const { data } = await client
      .from("v_transactions_eur")
      .select("payer_name")
      .eq("flow_type", "income");
    const payers = new Set(
      (data ?? []).map((r) => (r as { payer_name: string | null }).payer_name),
    );
    expect(payers).toContain("Acme Demo Srl");
  });

  it("splits only what is split", async () => {
    const client = createFakeClient(NOW);
    const { data } = await client
      .from("v_transactions_eur")
      .select("*")
      .not("personal_amount", "is", null);
    expect(data?.length).toBeGreaterThan(0);
    for (const t of data ?? [])
      expect(t.personal_signed_amount_eur).toBe(-(t.personal_amount ?? 0));
  });
});

// Polish 5 #7: a split money-in row got -share, while the real view signs it by direction (+).
// fails_when=split money in counts as money out in the demo totals
describe("demo split money in", () => {
  it("keeps my share of money in positive, like the real view", async () => {
    const client = createFakeClient(NOW);
    const { data: credits } = await client
      .from("v_transactions_eur")
      .select("*")
      .eq("credit_debit_indicator", "CRDT");
    const t = (credits ?? []).find((r) => (r.amount ?? 0) > 10);
    expect(t).toBeDefined();
    await client
      .from("transactions")
      .update({ personal_amount: 10 })
      .eq("account_uid", t!.account_uid ?? "")
      .eq("entry_reference", t!.entry_reference ?? "");
    const { data } = await client
      .from("v_transactions_eur")
      .select("*")
      .eq("entry_reference", t!.entry_reference ?? "");
    expect(data?.[0]?.personal_signed_amount_eur).toBeCloseTo(10);
  });
});

describe("demo views match the real ones", () => {
  // protects=the demo shows subscriptions as costs (negative), like the real view;
  // fails_when=the monthly equivalent is stored as a positive number
  it("subscription monthly amounts are negative", async () => {
    const { data } = await createFakeClient(NOW).from("v_subscriptions").select("*");
    expect(data?.length).toBeGreaterThan(0);
    for (const s of data ?? []) expect(s.monthly_equivalent_eur).toBeLessThan(0);
  });

  // protects=monthly totals include Splitwise shares, and imported history only for months with no
  // live bank spend, as in the real views; fails_when=either is left out
  it("monthly spend includes Splitwise and fills history-only months", async () => {
    const client = createFakeClient(NOW);
    const month = (d: string) => `${d.slice(0, 7)}-01`;
    const { data: tx } = await client
      .from("v_transactions_eur")
      .select("*")
      .eq("flow_type", "spend");
    const { data: sw } = await client.from("v_splitwise_eur").select("*");
    const { data: hist } = await client.from("spend_history").select("*");
    const { data: cat } = await client.from("v_spend_by_category_monthly").select("*");
    const { data: ie } = await client.from("v_income_vs_expenses_monthly").select("*");

    const bank = new Map<string, number>();
    for (const t of tx ?? []) {
      const m = month(t.booking_date!);
      bank.set(m, (bank.get(m) ?? 0) - t.personal_signed_amount_eur!);
    }
    const shares = new Map<string, number>();
    for (const s of sw ?? [])
      shares.set(month(s.booking_date!), (shares.get(month(s.booking_date!)) ?? 0) + s.amount_eur!);
    const history = new Map<string, number>();
    for (const h of hist ?? [])
      if (!bank.has(h.month)) history.set(h.month, (history.get(h.month) ?? 0) + h.spend_eur);

    expect(shares.size).toBeGreaterThan(0);
    expect(history.size).toBeGreaterThan(0);

    const months = new Set([...bank.keys(), ...shares.keys(), ...history.keys()]);
    for (const m of months) {
      const catTotal = (cat ?? [])
        .filter((r) => r.month === m)
        .reduce((a, r) => a + r.spend_eur!, 0);
      expect(catTotal).toBeCloseTo(
        (bank.get(m) ?? 0) + (shares.get(m) ?? 0) + (history.get(m) ?? 0),
        1,
      );
    }
    for (const m of [...bank.keys(), ...shares.keys()]) {
      const row = (ie ?? []).find((r) => r.month === m);
      expect(row?.expenses_eur).toBeCloseTo((bank.get(m) ?? 0) + (shares.get(m) ?? 0), 1);
    }
  });
});
