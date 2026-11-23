import { describe, expect, it, vi } from "vitest";
import { createFakeClient, demoTagCounts } from "./fake-client";
import { DEMO_USER_ID } from "./generate";
import { functionErrorMessage } from "@/lib/function-error";
import { groupStreams } from "@/lib/recurring";
import type { Tables } from "@/integrations/supabase/types";
import { billEntries, monthBounds, type ChargeTx } from "@/lib/recurring-calendar";
import { addDays } from "@/lib/date";

const NOW = new Date(2026, 9, 19, 12);
const fresh = () => createFakeClient(NOW);

describe("fake client: reading", () => {
  it("filters, sorts and limits like the real query builder", async () => {
    const { data } = await fresh()
      .from("v_transactions_eur")
      .select("entry_reference,booking_date,flow_type,amount")
      .gte("booking_date", "2026-10-01")
      .lt("booking_date", "2026-10-15")
      .in("flow_type", ["spend", "refunded"])
      .neq("amount", 0)
      .order("booking_date", { ascending: false })
      .order("entry_reference", { ascending: false })
      .limit(5);
    expect(data).toHaveLength(5);
    for (const r of data!) {
      expect(r.booking_date! >= "2026-10-01" && r.booking_date! < "2026-10-15").toBe(true);
      expect(["spend", "refunded"]).toContain(r.flow_type);
    }
    const dates = data!.map((r) => r.booking_date!);
    expect([...dates].sort().reverse()).toEqual(dates);
  });

  it("handles is-null, not-is-null, lte and eq", async () => {
    const c = fresh();
    const { data: answered } = await c
      .from("transactions")
      .select("worth_it")
      .not("worth_it", "is", null)
      .is("deleted_at", null)
      .lte("booking_date", "2026-10-19")
      .eq("worth_it", "no");
    expect(answered!.length).toBeGreaterThan(0);
    expect(answered!.every((r) => r.worth_it === "no")).toBe(true);
  });

  it("supports or() with eq and is.null", async () => {
    const { data } = await fresh()
      .from("transactions")
      .select("flow_type,custom_name")
      .or("flow_type.eq.transfer,custom_name.is.null");
    expect(data!.length).toBeGreaterThan(0);
    for (const r of data!) expect(r.flow_type === "transfer" || r.custom_name == null).toBe(true);
    const { data: none } = await fresh()
      .from("transactions")
      .select("flow_type")
      .or("flow_type.eq.nope");
    expect(none).toEqual([]);
    // A dot inside the value survives the split (Polish 3 #12).
    const c = fresh();
    await c.from("category_rules").insert({
      user_id: "u",
      match_field: "creditor_name",
      match_text: "acme.co",
      set_category: "Income",
    });
    const { data: dotted } = await c
      .from("category_rules")
      .select("match_text")
      .or("match_text.eq.acme.co");
    expect(dotted!.map((r) => r.match_text)).toEqual(["acme.co"]);
  });

  it("supports head+count and maybeSingle", async () => {
    const c = fresh();
    const counted = await c.from("accounts").select("uid", { count: "exact", head: true });
    expect(counted.count).toBe(3);
    expect(counted.data).toBeNull();
    const one = await c.from("accounts").select("*").eq("uid", "demo-acc-main").maybeSingle();
    expect(one.data?.uid).toBe("demo-acc-main");
    const none = await c.from("accounts").select("*").eq("uid", "nope").maybeSingle();
    expect(none.data).toBeNull();
    expect(none.error).toBeNull();
  });

  it("returns an error, not a crash, for an unknown table", async () => {
    // @ts-expect-error not a real table
    const { error } = await fresh().from("nope").select("*");
    expect(error?.message).toMatch(/nope/);
  });

  it("hands out copies, so callers cannot corrupt the store", async () => {
    const c = fresh();
    const { data } = await c.from("accounts").select("*");
    data![0]!.label = "hacked";
    const again = await c.from("accounts").select("*");
    expect(again.data![0]!.label).not.toBe("hacked");
  });
});

describe("fake client: writes live in memory only", () => {
  it("an edited transaction shows up in the view and in the monthly totals", async () => {
    const c = fresh();
    const { data: before } = await c
      .from("v_transactions_eur")
      .select("entry_reference,category,amount")
      .eq("flow_type", "spend")
      .eq("category", "Groceries")
      .limit(1);
    const ref = before![0]!.entry_reference!;
    await c
      .from("transactions")
      .update({ category: "Others", worth_it: "no" })
      .eq("entry_reference", ref);
    const { data: after } = await c
      .from("v_transactions_eur")
      .select("category,worth_it")
      .eq("entry_reference", ref);
    expect(after![0]).toMatchObject({ category: "Others", worth_it: "no" });
    const { data: groceries } = await c
      .from("v_spend_by_category_monthly")
      .select("*")
      .eq("category", "Groceries");
    const { data: all } = await c
      .from("v_transactions_eur")
      .select("*")
      .eq("flow_type", "spend")
      .eq("category", "Groceries");
    const total = all!.reduce((s, t) => s + Math.abs(t.signed_amount_eur!), 0);
    // The monthly view also holds Splitwise shares and, for months with no spend, imported history.
    const { data: shares } = await c
      .from("v_splitwise_eur")
      .select("*")
      .eq("category", "Groceries");
    const shareTotal = shares!.reduce((s, e) => s + e.amount_eur!, 0);
    const { data: spendAll } = await c
      .from("v_transactions_eur")
      .select("*")
      .eq("flow_type", "spend");
    const spendMonths = new Set(spendAll!.map((t) => t.booking_date!.slice(0, 7)));
    const { data: hist } = await c.from("spend_history").select("*").eq("category", "Groceries");
    const histTotal = hist!
      .filter((h) => !spendMonths.has(h.month.slice(0, 7)))
      .reduce((s, h) => s + h.spend_eur, 0);
    expect(groceries!.reduce((s, r) => s + r.spend_eur!, 0)).toBeCloseTo(
      total + shareTotal + histTotal,
      1,
    );
  });

  it("inserts, deletes and upserts rows", async () => {
    const c = fresh();
    const { count: n } = await c
      .from("category_rules")
      .select("id", { count: "exact", head: true });
    await c.from("category_rules").insert({
      user_id: DEMO_USER_ID,
      match_field: "creditor_name",
      match_text: "X",
      set_category: "Others",
    });
    const { count: n1 } = await c
      .from("category_rules")
      .select("id", { count: "exact", head: true });
    expect(n1).toBe(n! + 1);
    await c.from("category_rules").delete().eq("match_text", "X");
    const { count: n2 } = await c
      .from("category_rules")
      .select("id", { count: "exact", head: true });
    expect(n2).toBe(n);
  });

  it("upserts like Postgres: ignoreDuplicates keeps the saved row, a null key never matches", async () => {
    const c = fresh();
    const event = (external_id: string | null, amount_eur: number) => ({
      user_id: DEMO_USER_ID,
      kind: "dividend",
      event_date: "2026-03-01",
      amount_eur,
      raw_type: "CASH|DIVIDEND",
      source: "test",
      external_id,
    });
    const opts = { onConflict: "user_id,source,external_id", ignoreDuplicates: true };
    const up = (rows: Array<ReturnType<typeof event>>, o: object = opts) =>
      c
        .from("investment_events")
        .upsert(rows as never, o)
        .select("external_id");
    expect((await up([event("a", 1), event(null, 2)])).data).toHaveLength(2);
    // The same id again is skipped and not returned; a second null id is a new row.
    const again = await up([event("a", 9), event(null, 3)]);
    expect(again.data!.map((r) => r.external_id)).toEqual([null]);
    // Without ignoreDuplicates the saved row takes the new values.
    await up([event("a", 5)], { onConflict: "user_id,source,external_id" });
    const { data } = await c
      .from("investment_events")
      .select("external_id,amount_eur")
      .eq("source", "test")
      .order("amount_eur");
    expect(data!.map((r) => [r.external_id, r.amount_eur])).toEqual([
      [null, 2],
      [null, 3],
      ["a", 5],
    ]);
  });

  // Regression: once a table was emptied, new rows got no id, so deleting one
  // (`.eq("id", undefined)`) matched and removed every new row.
  it("gives new rows ids even after the table was emptied", async () => {
    const c = fresh();
    await c.from("category_rules").delete().neq("match_text", "");
    const rule = (match_text: string) => ({
      user_id: DEMO_USER_ID,
      match_field: "creditor_name",
      match_text,
      set_category: "Others",
    });
    await c.from("category_rules").insert(rule("alpha"));
    await c.from("category_rules").insert(rule("beta"));
    const { data } = await c.from("category_rules").select("id, match_text");
    const alpha = data!.find((r) => r.match_text === "alpha")!;

    await c.from("category_rules").delete().eq("id", alpha.id);

    const { data: left } = await c.from("category_rules").select("match_text");
    expect(left!.map((r) => r.match_text)).toEqual(["beta"]);
  });

  it("dismissing a subscription hides it; a manual frequency marks it manual", async () => {
    const c = fresh();
    const { data: subs } = await c.from("v_subscriptions").select("creditor_name");
    const [first, second] = subs!.map((s) => s.creditor_name!);
    await c
      .from("subscription_billing_overrides")
      .upsert(
        { user_id: DEMO_USER_ID, creditor_name: first!, dismissed: true },
        { onConflict: "user_id,creditor_name" },
      );
    await c
      .from("subscription_billing_overrides")
      .upsert(
        { user_id: DEMO_USER_ID, creditor_name: second!, billing_frequency: "Yearly" },
        { onConflict: "user_id,creditor_name" },
      );
    const { data } = await c.from("v_subscriptions").select("*");
    expect(data!.find((s) => s.creditor_name === first)).toBeUndefined();
    expect(data!.find((s) => s.creditor_name === second)).toMatchObject({
      billing_frequency: "Yearly",
      billing_frequency_is_manual: true,
    });
  });
});

describe("fake client: auth, functions and rpc", () => {
  it("is always signed in as the demo user, and sign-out notifies listeners", async () => {
    const c = fresh();
    expect((await c.auth.getSession()).data.session?.user.id).toBeTruthy();
    expect((await c.auth.getUser()).data.user?.id).toBeTruthy();
    const cb = vi.fn();
    const { data } = c.auth.onAuthStateChange(cb);
    await c.auth.signOut();
    expect(cb).toHaveBeenCalledWith("SIGNED_OUT", null);
    data.subscription.unsubscribe();
    expect((await c.auth.updateUser({ data: { welcome_dismissed: true } })).error).toBeNull();
  });

  it("lists demo banks but refuses to connect a real one", async () => {
    const c = fresh();
    const banks = await c.functions.invoke("list-banks", { body: { country: "IT" } });
    expect(banks.error).toBeNull();
    expect((banks.data as { banks: Array<unknown> }).banks.length).toBeGreaterThan(0);
    const consent = await c.functions.invoke("start-bank-consent", { body: {} });
    expect(consent.error?.message).toMatch(/demo/i);
    // Issue #148: Connect a bank's toast said "Couldn't start bank connection" in the demo.
    // fails_when=the error has no body for functionErrorMessage to read
    expect(await functionErrorMessage(consent.error, "Couldn't start bank connection")).toBe(
      "Disabled in the demo.",
    );
  });

  // protects=the demo shows the Splitwise sync as connected, under a made-up name, and refuses
  // every write; fails_when=a real name shows, or a review action or a sync runs in the demo
  it("looks connected to Splitwise as Alex, with two pending items, and refuses sync and actions", async () => {
    const c = fresh();
    const { data } = await c.rpc("get_splitwise_connection");
    expect(data).toEqual([
      {
        connected: true,
        status: "ok",
        display_name: "Alex",
        last_synced_at: new Date(NOW.getTime() - 2 * 3_600_000).toISOString(),
        last_error: null,
        synced_data: true,
      },
    ]);
    const review = await c
      .from("splitwise_review")
      .select("id,kind,status")
      .eq("status", "pending");
    expect(review.data?.map((r) => r.kind)).toEqual(["paid_by_me", "settle_in"]);
    for (const fn of [
      "link_splitwise_review",
      "count_splitwise_review",
      "dismiss_splitwise_review",
    ])
      expect(
        (await (c.rpc as unknown as (f: string) => Promise<{ error: unknown }>)(fn)).error,
      ).toEqual({ message: "Disabled in the demo." });
    const sync = await c.functions.invoke("sync-splitwise", { body: {} });
    expect(await functionErrorMessage(sync.error, "x")).toBe("Disabled in the demo.");
  });

  it("renaming a merchant renames every transaction from it, and clearing undoes that", async () => {
    const c = fresh();
    const rename = (name: string | null, ref: string) =>
      (c.rpc as unknown as (f: string, a: object) => PromiseLike<{ data: number; error: unknown }>)(
        "rename_merchant",
        { p_entry_reference: ref, p_account_uid: "demo-acc-main", p_name: name },
      );
    const { data: rows } = await c
      .from("v_transactions_eur")
      .select("entry_reference,creditor_name")
      .eq("creditor_name", "Supermercato Verde");
    expect(rows!.length).toBeGreaterThan(1);
    const renamed = await rename("My grocer", rows![0]!.entry_reference!);
    expect(renamed.data).toBe(rows!.length);
    const { data: after } = await c
      .from("v_transactions_eur")
      .select("creditor_name")
      .eq("creditor_name", "My grocer");
    expect(after).toHaveLength(rows!.length);
    await rename(null, rows![0]!.entry_reference!);
    const { data: back } = await c
      .from("v_transactions_eur")
      .select("creditor_name")
      .eq("creditor_name", "Supermercato Verde");
    expect(back).toHaveLength(rows!.length);
  });

  describe("rename_merchant by merchant_key", () => {
    const renameAcross = async (key: string) => {
      const c = fresh();
      const base = {
        account_uid: "demo-acc-main",
        amount: 5,
        currency: "EUR",
        booking_date: "2026-10-10",
      };
      await c.from("transactions").insert([
        { ...base, entry_reference: "mk-1", creditor_name: "Cafe Uno Roma", merchant_key: key },
        { ...base, entry_reference: "mk-2", creditor_name: "Cafe Uno Milano", merchant_key: key },
      ] as never);
      const res = await (
        c.rpc as unknown as (f: string, a: object) => PromiseLike<{ data: number; error: unknown }>
      )("rename_merchant", {
        p_entry_reference: "mk-1",
        p_account_uid: "demo-acc-main",
        p_name: "Cafe Uno",
      });
      const { data } = await c
        .from("transactions")
        .select("entry_reference,custom_name")
        .in("entry_reference", ["mk-1", "mk-2"]);
      return { res, names: data!.map((r) => r.custom_name) };
    };

    it("renames every row sharing the merchant_key", async () => {
      const { res, names } = await renameAcross("cafe uno");
      expect(res.data).toBe(2);
      expect(names).toEqual(["Cafe Uno", "Cafe Uno"]);
    });

    it("does not spread a rename across an aggregator key", async () => {
      const { res, names } = await renameAcross("paypal");
      expect(res.data).toBe(1);
      expect(names).toEqual(["Cafe Uno", undefined]);
    });
  });

  it("refuses database functions that would import data", async () => {
    const { error } = await fresh().rpc("import_splitwise", {} as never);
    expect(error?.message).toMatch(/demo/i);
  });
});

describe("fake client: adding and editing holdings", () => {
  it("searches, adds a holding with today's price, then edits and sells it", async () => {
    const c = fresh();
    const search = await c.functions.invoke<{ results: Array<{ id: string }> }>("add-holding", {
      body: { action: "search", kind: "stock", query: "apple" },
    });
    expect(search.data!.results.map((r) => r.id)).toContain("AAPL");

    const add = await c.functions.invoke("add-holding", {
      body: {
        action: "add",
        kind: "stock",
        id: "AAPL",
        symbol: "AAPL",
        name: "Apple Inc.",
        quantity: 2,
      },
    });
    expect(add.error).toBeNull();
    const latest = async () =>
      (await c.from("v_portfolio_latest").select("isin,shares,value_eur").eq("isin", "AAPL")).data!;
    expect((await latest())[0]).toMatchObject({ isin: "AAPL", shares: 2 });
    expect((await latest())[0]!.value_eur).toBeGreaterThan(0);

    const again = await c.functions.invoke("add-holding", {
      body: {
        action: "add",
        kind: "stock",
        id: "AAPL",
        symbol: "AAPL",
        name: "Apple Inc.",
        quantity: 1,
      },
    });
    expect(again.error).not.toBeNull();

    await c.from("portfolio_holdings").update({ shares: 0 }).eq("isin", "AAPL");
    expect((await latest())[0]!.shares).toBe(0);
  });

  it("adds a coin to the crypto view", async () => {
    const c = fresh();
    await c.functions.invoke("add-holding", {
      body: {
        action: "add",
        kind: "crypto",
        id: "solana",
        symbol: "SOL",
        name: "Solana",
        quantity: 3,
      },
    });
    const { data } = await c
      .from("v_crypto_latest")
      .select("asset_symbol,source,amount")
      .eq("asset_symbol", "SOL");
    expect(data!.filter((r) => r.source === "Manual")).toMatchObject([
      { asset_symbol: "SOL", source: "Manual", amount: 3 },
    ]);
  });

  describe("net worth follows an added holding", () => {
    type Rpc = (f: string, a: object) => PromiseLike<{ data: number; error: unknown }>;
    const today = async (c: ReturnType<typeof fresh>) => {
      const { data } = await c
        .from("v_net_worth_daily")
        .select("*")
        .order("snapshot_date", { ascending: false })
        .limit(1);
      return data![0]!;
    };
    const coinValue = async (c: ReturnType<typeof fresh>) =>
      (
        await c
          .from("v_crypto_latest")
          .select("value_eur")
          .eq("asset_symbol", "SOL")
          .eq("source", "Manual")
      ).data![0]!.value_eur!;
    const addSol = (c: ReturnType<typeof fresh>, quantity: number) =>
      c.functions.invoke("add-holding", {
        body: {
          action: "add",
          kind: "crypto",
          id: "solana",
          symbol: "SOL",
          name: "Solana",
          quantity,
        },
      });

    // protects=adding a coin raises today's net worth and crypto total by its value
    it("adding a coin adds its value to today's net worth", async () => {
      const c = fresh();
      const before = await today(c);
      await addSol(c, 3);
      const value = await coinValue(c);
      expect(value).toBeGreaterThan(0);
      const after = await today(c);
      expect(after.total_eur).toBeCloseTo(before.total_eur! + value, 1);
      expect(after.crypto_total_eur).toBeCloseTo(before.crypto_total_eur! + value, 1);
    });

    // protects=editing an added coin never drives net worth below where it started (demo P1)
    it("adding a coin then setting its quantity leaves net worth at before + the new value", async () => {
      const c = fresh();
      const before = await today(c);
      await addSol(c, 1);
      const res = await (c.rpc as unknown as Rpc)("set_holding_quantity", {
        p_kind: "crypto",
        p_key: "SOL",
        p_source: "Manual",
        p_quantity: 0.008,
      });
      expect(res).toEqual({ data: 1, error: null });
      const value = await coinValue(c);
      const after = await today(c);
      expect(after.total_eur).toBeCloseTo(before.total_eur! + value, 1);
      expect(after.crypto_total_eur).toBeCloseTo(before.crypto_total_eur! + value, 1);
    });

    // protects=adding a stock raises today's net worth and stock total by its value
    it("adding a stock adds its value to today's net worth", async () => {
      const c = fresh();
      const before = await today(c);
      await c.functions.invoke("add-holding", {
        body: {
          action: "add",
          kind: "stock",
          id: "AAPL",
          symbol: "AAPL",
          name: "Apple Inc.",
          quantity: 2,
        },
      });
      const value = (await c.from("v_portfolio_latest").select("value_eur").eq("isin", "AAPL"))
        .data![0]!.value_eur!;
      const after = await today(c);
      expect(after.total_eur).toBeCloseTo(before.total_eur! + value, 1);
      expect(after.portfolio_total_eur).toBeCloseTo(before.portfolio_total_eur! + value, 1);
    });
  });
});

describe("fake client: delete_holding", () => {
  type Rpc = (f: string, a: object) => PromiseLike<{ data: number; error: unknown }>;
  const latestTotal = async (c: ReturnType<typeof fresh>) => {
    const { data } = await c.from("v_net_worth_daily").select("snapshot_date,total_eur");
    return data!.reduce((a, r) => (r.snapshot_date! > a.snapshot_date! ? r : a)).total_eur!;
  };

  it("removes a stock with its snapshots and trades, and its value leaves net worth", async () => {
    const c = fresh();
    const { data: holdings } = await c.from("portfolio_holdings").select("isin");
    const isin = holdings![0]!.isin!;
    const { data: snaps } = await c
      .from("portfolio_snapshots")
      .select("snapshot_date,value_eur")
      .eq("isin", isin);
    const lastValue = snaps!.reduce((a, s) =>
      s.snapshot_date! > a.snapshot_date! ? s : a,
    ).value_eur!;
    const before = await latestTotal(c);

    const res = await (c.rpc as unknown as Rpc)("delete_holding", { p_kind: "stock", p_key: isin });
    expect(res).toEqual({ data: 1, error: null });
    expect((await c.from("portfolio_holdings").select("isin").eq("isin", isin)).data).toEqual([]);
    expect((await c.from("portfolio_snapshots").select("isin").eq("isin", isin)).data).toEqual([]);
    expect((await c.from("holding_trades").select("key").eq("key", isin)).data).toEqual([]);
    expect(await latestTotal(c)).toBeCloseTo(before - lastValue, 1);
  });

  it("removes the deleted holding's dividends and other events, and no one else's", async () => {
    const c = fresh();
    const { data: holdings } = await c.from("portfolio_holdings").select("isin");
    const [isin, other] = [holdings![0]!.isin!, holdings![1]!.isin!];
    const event = (key: string) => ({
      kind: "dividend",
      asset_kind: "stock",
      key,
      event_date: "2026-03-01",
      amount_eur: 1,
      raw_type: "CASH|DIVIDEND",
    });
    await c.from("investment_events").insert([event(isin), event(other)] as never);
    await (c.rpc as unknown as Rpc)("delete_holding", { p_kind: "stock", p_key: isin });
    const { data } = await c.from("investment_events").select("key").in("key", [isin, other]);
    expect([...new Set(data!.map((e) => e.key))]).toEqual([other]);
  });

  // protects=add then delete leaves every net-worth day as it was, even just after local
  // midnight, when the UTC date is still yesterday (Berlin is UTC+2 on 20 Oct)
  it("adding then deleting a coin just after local midnight leaves net worth unchanged", async () => {
    const tz = process.env["TZ"];
    process.env["TZ"] = "Europe/Berlin";
    try {
      const c = createFakeClient(new Date(2026, 9, 20, 0, 30)); // made in Berlin time
      const days = async () =>
        (await c.from("v_net_worth_daily").select("snapshot_date,total_eur")).data!.map(
          (r) => `${r.snapshot_date} ${r.total_eur!.toFixed(2)}`,
        );
      const before = await days();
      await c.functions.invoke("add-holding", {
        body: {
          action: "add",
          kind: "crypto",
          id: "solana",
          symbol: "SOL",
          name: "Solana",
          quantity: 3,
        },
      });
      await (c.rpc as unknown as Rpc)("delete_holding", {
        p_kind: "crypto",
        p_key: "SOL",
        p_source: "Manual",
      });
      expect(await days()).toEqual(before);
    } finally {
      if (tz === undefined) delete process.env["TZ"];
      else process.env["TZ"] = tz;
    }
  });

  it("removes one crypto source and returns 0 when there is nothing to delete", async () => {
    const c = fresh();
    const { data: coins } = await c.from("crypto_holdings").select("asset_symbol,source");
    const { asset_symbol, source } = coins![0]!;
    const del = () =>
      (c.rpc as unknown as Rpc)("delete_holding", {
        p_kind: "crypto",
        p_key: asset_symbol,
        p_source: source,
      });
    expect((await del()).data).toBe(1);
    expect(
      (
        await c
          .from("crypto_snapshots")
          .select("asset_symbol")
          .eq("asset_symbol", asset_symbol!)
          .eq("source", source!)
      ).data,
    ).toEqual([]);
    expect((await del()).data).toBe(0);
  });
});

describe("fake client: account types and debts", () => {
  const rpc = (c: ReturnType<typeof fresh>, f: string, a: object) =>
    (
      c.rpc as unknown as (
        f: string,
        a: object,
      ) => PromiseLike<{ data: unknown; error: { message: string } | null }>
    )(f, a);
  const today = async (c: ReturnType<typeof fresh>) => {
    const { data } = await c
      .from("v_net_worth_daily")
      .select("*")
      .order("snapshot_date", { ascending: false })
      .limit(1);
    return data![0]!;
  };

  // protects=the demo card is a debt: out of bank, subtracted from the total
  it("counts the demo credit card as a liability", async () => {
    const day = await today(fresh());
    expect(day.liabilities_eur).toBe(320);
    expect(day.total_eur).toBeCloseTo(
      day.bank_total_eur! + day.portfolio_total_eur! + day.crypto_total_eur! - 320,
      1,
    );
  });

  // protects=correcting a type moves the balance between bank and debts in net worth
  it("set_account_type moves the account between bank and liabilities", async () => {
    const c = fresh();
    const before = await today(c);
    expect(
      (await rpc(c, "set_account_type", { p_account: "demo-acc-card", p_type: "checking" })).error,
    ).toBeNull();
    const after = await today(c);
    expect(after.liabilities_eur).toBe(0);
    expect(after.bank_total_eur).toBeCloseTo(before.bank_total_eur! - 320, 1);
    expect(after.total_eur).toBeCloseTo(before.total_eur!, 1);
    const { data } = await c.from("v_bank_accounts_latest").select("*").eq("uid", "demo-acc-card");
    expect(data![0]!.account_type).toBe("checking");
    // Same debt-ness: net worth stays.
    await rpc(c, "set_account_type", { p_account: "demo-acc-main", p_type: "savings" });
    expect((await today(c)).total_eur).toBeCloseTo(after.total_eur!, 1);
  });

  it("set_account_type refuses an unknown type or account", async () => {
    const c = fresh();
    expect(
      (await rpc(c, "set_account_type", { p_account: "demo-acc-main", p_type: "boat" })).error
        ?.message,
    ).toBe("unknown account type");
    expect(
      (await rpc(c, "set_account_type", { p_account: "nope", p_type: "loan" })).error?.message,
    ).toBe("account not found");
  });

  // protects=a debt typed by hand shows in Accounts and lowers net worth; editing it follows
  it("add_manual_debt adds a loan, set_manual_balance changes what is owed", async () => {
    const c = fresh();
    const before = await today(c);
    const { data: uid, error } = await rpc(c, "add_manual_debt", {
      p_name: "Car loan",
      p_amount: 1000,
      p_currency: "EUR",
    });
    expect(error).toBeNull();
    const { data: rows } = await c
      .from("v_bank_accounts_latest")
      .select("*")
      .eq("uid", uid as string);
    expect(rows).toMatchObject([
      { label: "Car loan", account_type: "loan", manual: true, amount: 1000 },
    ]);
    expect((await today(c)).total_eur).toBeCloseTo(before.total_eur! - 1000, 1);
    expect(
      (await rpc(c, "set_manual_balance", { p_account: uid, p_amount: 400 })).error,
    ).toBeNull();
    const after = await today(c);
    expect(after.liabilities_eur).toBeCloseTo(before.liabilities_eur! + 400, 1);
    expect(after.total_eur).toBeCloseTo(before.total_eur! - 400, 1);
  });

  // protects=a deleted debt leaves the list and net worth
  it("delete_manual_debt removes the debt and its effect on net worth", async () => {
    const c = fresh();
    const before = await today(c);
    const { data: uid } = await rpc(c, "add_manual_debt", { p_name: "Loan", p_amount: 500 });
    expect((await rpc(c, "delete_manual_debt", { p_account: uid })).error).toBeNull();
    const { data } = await c
      .from("v_bank_accounts_latest")
      .select("*")
      .eq("uid", uid as string);
    expect(data).toHaveLength(0);
    expect((await today(c)).total_eur).toBeCloseTo(before.total_eur!, 1);
    expect((await rpc(c, "delete_manual_debt", { p_account: uid })).error?.message).toBe(
      "account not found",
    );
    expect(
      (await rpc(c, "delete_manual_debt", { p_account: "demo-acc-card" })).error?.message,
    ).toBe("not a manual debt");
  });

  it("add_manual_debt converts another currency at the demo rate", async () => {
    const c = fresh();
    const { data: uid } = await rpc(c, "add_manual_debt", {
      p_name: "US card",
      p_amount: 100,
      p_currency: "usd",
    });
    const { data: rows } = await c
      .from("v_bank_accounts_latest")
      .select("*")
      .eq("uid", uid as string);
    expect(rows![0]!.currency).toBe("USD");
    expect(rows![0]!.amount_eur).toBeGreaterThan(80);
    expect(rows![0]!.amount_eur).toBeLessThan(100);
  });

  it("refuses a debt with no name or amount, and a balance on a bank account", async () => {
    const c = fresh();
    expect((await rpc(c, "add_manual_debt", { p_name: " ", p_amount: 5 })).error?.message).toBe(
      "name is required",
    );
    expect((await rpc(c, "add_manual_debt", { p_name: "X" })).error?.message).toBe(
      "amount is required",
    );
    expect(
      (await rpc(c, "set_manual_balance", { p_account: "demo-acc-main", p_amount: 5 })).error
        ?.message,
    ).toBe("not a manual account");
    expect(
      (await rpc(c, "set_manual_balance", { p_account: "nope", p_amount: 5 })).error?.message,
    ).toBe("account not found");
  });
});

describe("fake client: add_manual_transaction", () => {
  type Rpc = (
    f: string,
    a: object,
  ) => PromiseLike<{
    data: Array<{ account_uid: string; entry_reference: string }>;
    error: unknown;
  }>;
  const add = (c: ReturnType<typeof fresh>, args: object) =>
    (c.rpc as unknown as Rpc)("add_manual_transaction", {
      p_booking_date: "2026-10-18",
      p_description: "Cena",
      p_amount: 45.5,
      p_direction: "DBIT",
      ...args,
    });

  it("adds a spend row that shows in the transactions view, on a manual account per source", async () => {
    const c = fresh();
    const { data, error } = await add(c, { p_source: "Fineco" });
    expect(error).toBeNull();
    const ref = data[0]!.entry_reference;
    const { data: rows } = await c
      .from("v_transactions_eur")
      .select("creditor_name,signed_amount_eur,flow_type,category")
      .eq("entry_reference", ref);
    expect(rows).toMatchObject([
      { creditor_name: "Cena", signed_amount_eur: -45.5, flow_type: "spend", category: null },
    ]);
    const { data: again } = await add(c, { p_source: "Fineco", p_description: "Pizza" });
    expect(again[0]!.account_uid).toBe(data[0]!.account_uid);
    const { data: accounts } = await c
      .from("accounts")
      .select("uid,bank_name,manual")
      .eq("uid", data[0]!.account_uid);
    expect(accounts).toMatchObject([
      { uid: data[0]!.account_uid, bank_name: "Fineco", manual: true },
    ]);
  });

  it("files a Transfer as a transfer and refuses an amount of zero", async () => {
    const c = fresh();
    const { data } = await add(c, { p_direction: "CRDT", p_category: "Transfer" });
    const { data: rows } = await c
      .from("v_transactions_eur")
      .select("flow_type")
      .eq("entry_reference", data[0]!.entry_reference);
    expect(rows).toMatchObject([{ flow_type: "transfer" }]);
    const { data: raw } = await c
      .from("transactions")
      .select("flow_source")
      .eq("entry_reference", data[0]!.entry_reference);
    expect(raw).toMatchObject([{ flow_source: "user" }]);
    const bad = await add(c, { p_amount: 0 });
    expect(bad.error).toBeTruthy();
  });
});

describe("fake client: parse-statement", () => {
  it("returns made-up statement rows in the shape the import expects", async () => {
    const c = fresh();
    const { data, error } = await (
      c.functions.invoke as unknown as (
        n: string,
        o: object,
      ) => Promise<{ data: { rows: Array<Record<string, unknown>> }; error: unknown }>
    )("parse-statement", { body: { pdf: "JVBERi0=" } });
    expect(error).toBeNull();
    expect(data.rows).toHaveLength(3);
    for (const r of data.rows) {
      expect(r["date"]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(["DBIT", "CRDT"]).toContain(r["direction"]);
    }
  });
});

describe("fake client: reapply-rules", () => {
  it("answers the Rules page with nothing to change instead of an error", async () => {
    const { data, error } = await (
      fresh().functions.invoke as unknown as (
        n: string,
        o: object,
      ) => Promise<{ data: unknown; error: unknown }>
    )("reapply-rules", { body: { apply: false } });
    expect(error).toBeNull();
    expect(data).toEqual({ changes: 0, sample: [] });
  });
});

// Polish 1 #7: every Subscriptions visit in the demo logged a refresh-recurring 403.
describe("fake client: refresh-recurring", () => {
  it("answers the Subscriptions page's re-check without an error", async () => {
    const { data, error } = await (
      fresh().functions.invoke as unknown as (
        n: string,
        o: object,
      ) => Promise<{ data: unknown; error: unknown }>
    )("refresh-recurring", { body: {} });
    expect(error).toBeNull();
    expect(data).toEqual({ streams: expect.any(Number) }); // the streams it found
  });

  // polish-3 F7: like the detector, a stream whose charges you all marked One-time is gone.
  type Invoke = (n: string, o: object) => Promise<unknown>;
  const recheck = (c: ReturnType<typeof fresh>) =>
    (c.functions.invoke as unknown as Invoke)("refresh-recurring", { body: {} });
  const listed = async (c: ReturnType<typeof fresh>) => {
    const g = groupStreams(
      ((await c.from("recurring_streams").select("*")).data ?? []) as Array<
        Tables<"recurring_streams">
      >,
      NOW,
    );
    return [...g.toReview, ...g.active, ...g.stopped, ...g.dismissed].map((s) => s.id);
  };
  const setup = async () => {
    const c = fresh();
    const { data } = await c.from("recurring_streams").select("*");
    const s = groupStreams(data as Array<Tables<"recurring_streams">>, NOW).active[0]!;
    const charges = () =>
      c
        .from("transactions")
        .update({ transaction_type: "One-time", transaction_type_source: "manual" })
        .eq("merchant_key", s.merchant_key!)
        .eq("account_uid", s.account_uid!);
    const { data: rows } = await c
      .from("transactions")
      .select("entry_reference")
      .eq("merchant_key", s.merchant_key!)
      .eq("account_uid", s.account_uid!);
    expect(rows!.length).toBeGreaterThan(1);
    return { c, s, charges, refs: rows!.map((r) => r.entry_reference) };
  };

  it("drops a stream once you mark all its charges One-time, and brings it back after", async () => {
    const { c, s, charges } = await setup();
    const others = (await listed(c)).filter((id) => id !== s.id);
    await charges();
    await recheck(c);
    expect(await listed(c)).toEqual(others);

    await c
      .from("transactions")
      .update({ transaction_type: "Subscription", transaction_type_source: "manual" })
      .eq("merchant_key", s.merchant_key!);
    await recheck(c);
    expect(await listed(c)).toContain(s.id);
  });

  it("keeps a stream while one charge is still not your One-time", async () => {
    const { c, s, charges, refs } = await setup();
    await charges();
    await c
      .from("transactions")
      .update({ transaction_type_source: null })
      .eq("entry_reference", refs[0]!);
    await recheck(c);
    expect(await listed(c)).toContain(s.id);
  });

  // polish-5 E4: one bill charge set One-time vanished from the demo calendar (5 of 5 -> 4 of 4),
  // while the server re-dates the stream from the charges left, so the bill reads "not seen yet".
  // fails_when=the stream keeps the One-time charge's dates, or the calendar loses the bill
  it("re-dates a stream from the charges left, so the calendar shows its bill not seen yet", async () => {
    const c = fresh();
    const month = new Date(NOW.getFullYear(), NOW.getMonth(), 1);
    const { start, end } = monthBounds(month);
    const streams = async () =>
      ((await c.from("recurring_streams").select("*")).data ?? []) as Array<
        Tables<"recurring_streams">
      >;
    const bills = async () => {
      const active = groupStreams(await streams(), NOW).active;
      const { data } = await c
        .from("transactions")
        .select("*")
        .gte("booking_date", start)
        .lt("booking_date", end);
      return billEntries(active, (data ?? []) as Array<ChargeTx>, month, NOW);
    };
    // An active monthly bill already paid this month, with earlier charges.
    const s = groupStreams(await streams(), NOW).active.find(
      (r) => r.cadence === "monthly" && r.last_charged! >= start && r.charge_count! >= 2,
    )!;
    const before = await bills();
    expect(before.filter((e) => e.name === s.display_name).map((e) => e.status)).toEqual(["done"]);
    const { data: own } = await c
      .from("transactions")
      .select("booking_date")
      .eq("merchant_key", s.merchant_key!)
      .eq("account_uid", s.account_uid!);
    const dates = [...new Set(own!.map((t) => t.booking_date!))].sort();
    const prev = dates[dates.length - 2]!;

    await c
      .from("transactions")
      .update({ transaction_type: "One-time", transaction_type_source: "manual" })
      .eq("merchant_key", s.merchant_key!)
      .eq("booking_date", s.last_charged!);
    await recheck(c);

    const row = (await streams()).find((r) => r.id === s.id)!;
    expect(row.last_charged).toBe(prev);
    expect(row.next_expected).toBe(addDays(prev, 30)); // as the demo seeds a monthly stream
    const after = await bills();
    expect(after.length).toBe(before.length);
    expect(after.filter((e) => e.name === s.display_name).map((e) => e.status)).toEqual(["late"]);
  });

  it("leaves every stream's dates as generated when no charge changed", async () => {
    const c = fresh();
    const dates = async () =>
      (await c.from("recurring_streams").select("id,last_charged,next_expected")).data ?? [];
    const before = await dates();
    await recheck(c);
    expect(await dates()).toEqual(before);
  });
});

describe("fake client: set_holding_quantity", () => {
  type Rpc = (f: string, a: object) => PromiseLike<{ data: number; error: unknown }>;
  it("selling a stock takes its value out of today's net worth at once", async () => {
    const c = fresh();
    const latest = async () => {
      const { data } = await c.from("v_net_worth_daily").select("snapshot_date,total_eur");
      return data!.reduce((a, r) => (r.snapshot_date! > a.snapshot_date! ? r : a)).total_eur!;
    };
    const { data: holdings } = await c.from("portfolio_holdings").select("isin");
    const isin = holdings![0]!.isin!;
    const { data: snaps } = await c
      .from("portfolio_snapshots")
      .select("snapshot_date,value_eur")
      .eq("isin", isin);
    const value = snaps!.reduce((a, s) => (s.snapshot_date! > a.snapshot_date! ? s : a)).value_eur!;
    const before = await latest();
    const res = await (c.rpc as unknown as Rpc)("set_holding_quantity", {
      p_kind: "stock",
      p_key: isin,
      p_quantity: 0,
    });
    expect(res).toEqual({ data: 1, error: null });
    expect(await latest()).toBeCloseTo(before - value, 1);
  });
});

describe("fake client: stream_action", () => {
  const setup = async () => {
    const c = fresh();
    const { data } = await c.from("recurring_streams").select("*");
    const rows = data as Array<Tables<"recurring_streams">>;
    const toReview = groupStreams(rows, NOW).toReview[0]!;
    return { c, toReview };
  };
  const act = (c: ReturnType<typeof fresh>, id: string, action: string, args = {}) =>
    c.rpc("stream_action", { p_stream: id, p_action: action, p_args: args });
  const grouped = async (c: ReturnType<typeof fresh>) =>
    groupStreams(
      ((await c.from("recurring_streams").select("*")).data ?? []) as Array<
        Tables<"recurring_streams">
      >,
      NOW,
    );

  it("confirm moves a suggestion to active; dismiss and undismiss round-trip", async () => {
    const { c, toReview } = await setup();
    expect((await act(c, toReview.id, "confirm")).error).toBeNull();
    expect((await grouped(c)).active.some((s) => s.id === toReview.id)).toBe(true);
    await act(c, toReview.id, "dismiss");
    expect((await grouped(c)).dismissed.some((s) => s.id === toReview.id)).toBe(true);
    await act(c, toReview.id, "undismiss");
    expect((await grouped(c)).toReview.some((s) => s.id === toReview.id)).toBe(true);
  });

  it("undismiss confirms a row that has no detected status", async () => {
    const { c, toReview } = await setup();
    await c.from("recurring_streams").update({ detected_status: null }).eq("id", toReview.id);
    await act(c, toReview.id, "dismiss");
    await act(c, toReview.id, "undismiss");
    expect((await grouped(c)).active.some((s) => s.id === toReview.id)).toBe(true);
  });

  it("set_cadence sets a cadence or a custom interval and confirms", async () => {
    const { c, toReview } = await setup();
    await act(c, toReview.id, "set_cadence", { cadence: "yearly" });
    await act(c, toReview.id, "set_cadence", { custom_value: 6, custom_unit: "weeks" });
    const row = (await grouped(c)).active.find((s) => s.id === toReview.id)!;
    expect([row.user_cadence, row.custom_interval_value, row.custom_interval_unit]).toEqual([
      "custom",
      6,
      "weeks",
    ]);
  });

  it("errors like the SQL raise on bad input", async () => {
    const { c, toReview } = await setup();
    for (const [action, args] of [
      ["set_cadence", { cadence: "daily" }],
      ["set_cadence", { custom_value: 0, custom_unit: "days" }],
      ["set_cadence", { custom_value: 2, custom_unit: "decades" }],
      ["explode", {}],
    ] as const)
      expect((await act(c, toReview.id, action, args)).error).not.toBeNull();
    expect((await act(c, "nope", "confirm")).error).not.toBeNull();
  });
});

describe("fake client: resolve_transfer_pair", () => {
  const sides = async (c: ReturnType<typeof fresh>) => {
    const { data: pairs } = await c.from("transfer_pairs").select("*").eq("status", "suggested");
    const pair = pairs![0]!;
    const { data: rows } = await c
      .from("transactions")
      .select("*")
      .in("entry_reference", [pair.out_ref, pair.in_ref]);
    return { pair, rows: rows! };
  };

  it("the demo has one suggested pair whose sides are transfers in two accounts", async () => {
    const { pair, rows } = await sides(fresh());
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.account_uid))).toEqual(
      new Set([pair.out_account_uid, pair.in_account_uid]),
    );
    expect(rows.every((r) => r.flow_type === "transfer" && r.flow_source === "pair")).toBe(true);
  });

  it("keep confirms the pair and locks both rows as the user's transfer", async () => {
    const c = fresh();
    const { pair } = await sides(c);
    expect(
      (await c.rpc("resolve_transfer_pair", { p_pair: pair.id, p_keep: true })).error,
    ).toBeNull();
    const { data } = await c.from("transfer_pairs").select("status").eq("id", pair.id);
    expect(data).toMatchObject([{ status: "confirmed" }]);
    const { data: rows } = await c
      .from("transactions")
      .select("*")
      .in("entry_reference", [pair.out_ref, pair.in_ref]);
    expect(rows!.map((r) => [r.flow_type, r.flow_source])).toEqual([
      ["transfer", "user"],
      ["transfer", "user"],
    ]);
  });

  it("not keeping puts each side back by direction; a settled pair can't be answered again", async () => {
    const c = fresh();
    const { pair } = await sides(c);
    await c.rpc("resolve_transfer_pair", { p_pair: pair.id, p_keep: false });
    const { data: rows } = await c
      .from("transactions")
      .select("*")
      .in("entry_reference", [pair.out_ref, pair.in_ref]);
    expect(rows!.map((r) => [r.credit_debit_indicator, r.flow_type, r.flow_source]).sort()).toEqual(
      [
        ["CRDT", "income", "user"],
        ["DBIT", "spend", "user"],
      ],
    );
    const again = await c.rpc("resolve_transfer_pair", { p_pair: pair.id, p_keep: true });
    expect(again.error).toBeTruthy();
  });

  it("refuses Keep once a side changed since the pairing", async () => {
    const c = fresh();
    const { pair } = await sides(c);
    await c.from("transactions").update({ flow_source: "user" }).eq("entry_reference", pair.in_ref);
    const res = await c.rpc("resolve_transfer_pair", { p_pair: pair.id, p_keep: true });
    expect(res.error).toBeTruthy();
    const { data } = await c.from("transfer_pairs").select("status").eq("id", pair.id);
    expect(data).toMatchObject([{ status: "suggested" }]);
  });
});

// protects=the demo offers tag suggestions like the real my_transaction_tags; fails_when=deleted
// rows count, or the order is not most used first
describe("demo tag suggestions", () => {
  it("counts live rows' tags, most used first", () => {
    expect(
      demoTagCounts([
        { tags: ["work", "trip"] },
        { tags: ["work"] },
        { tags: ["gone"], deleted_at: "2026-11-01" },
        { tags: [] },
        {},
      ]),
    ).toEqual([
      { tag: "work", uses: 2 },
      { tag: "trip", uses: 1 },
    ]);
  });

  // polish-3 #6: fails_when=the demo lists "Trip" and "trip" apart while the database merges them
  it("counts tags that differ only in case as one, in the spelling used most", () => {
    expect(demoTagCounts([{ tags: ["Trip"] }, { tags: ["trip"] }, { tags: ["trip"] }])).toEqual([
      { tag: "trip", uses: 3 },
    ]);
  });
});

// protects=the demo shows notes and tags on some rows; fails_when=no demo row has a tag
describe("demo notes and tags", () => {
  // polish-5 #6: fails_when=the demo view drops note or tags, so the demo shows no notes and no
  // tag filter while the suite stays green
  it("shows notes and tags in the transactions view, and a saved note reaches it", async () => {
    const client = fresh();
    const { data } = await client.from("v_transactions_eur").select("*");
    const rows = data as Array<{
      entry_reference: string;
      note: string | null;
      tags: Array<string>;
    }>;
    expect(rows.some((r) => r.tags?.length > 0)).toBe(true);
    expect(rows.some((r) => r.note)).toBe(true);
    const ref = rows[0]!.entry_reference;
    await client
      .from("transactions")
      .update({ note: "qa note", tags: ["qa"] })
      .eq("entry_reference", ref);
    const after = await client.from("v_transactions_eur").select("*").eq("entry_reference", ref);
    expect(after.data).toEqual([expect.objectContaining({ note: "qa note", tags: ["qa"] })]);
  });

  it("has tagged rows the rpc lists", async () => {
    const client = fresh();
    const { data } = await client.rpc("my_transaction_tags");
    expect((data as Array<{ tag: string }>).map((r) => r.tag)).toEqual(
      expect.arrayContaining(["work"]),
    );
  });
});

describe("fake client: payback matching mirrors the database", () => {
  const ACC = "demo-pb-acc";
  const row = (ref: string, over: Record<string, unknown>) => ({
    entry_reference: ref,
    account_uid: ACC,
    user_id: DEMO_USER_ID,
    currency: "EUR",
    booking_date: "2026-10-10",
    credit_debit_indicator: "DBIT",
    owed_settled: false,
    ...over,
  });
  const seed = async (rows: Array<Record<string, unknown>>) => {
    const c = fresh();
    await c.from("transactions").insert(rows as never);
    return c;
  };
  const record = (c: ReturnType<typeof fresh>, ref: string, contact: string | null) =>
    c.rpc("record_payback", {
      p_account: ACC,
      p_ref: ref,
      p_contact: contact as string,
      p_remember: false,
    });

  it("a split refund counts against the bill and settles with it; alone it stays open", async () => {
    const c = await seed([
      row("sr-bill", {
        amount: 100,
        personal_amount: 40,
        owed_by: "Bea",
        booking_date: "2026-10-01",
      }),
      row("sr-ref", {
        amount: 30,
        personal_amount: 10,
        owed_by: "Bea",
        credit_debit_indicator: "CRDT",
        booking_date: "2026-10-02",
      }),
      row("sr-pay", {
        amount: 40,
        credit_debit_indicator: "CRDT",
        debtor_name: "Bea Verdi",
        flow_type: "income",
      }),
      row("sr-pay2", {
        amount: 30,
        credit_debit_indicator: "CRDT",
        debtor_name: "Bea Verdi",
        flow_type: "income",
      }),
    ]);
    const { data } = await record(c, "sr-pay", "Bea");
    expect(data).toMatchObject({ settled: ["sr-bill"], settled_eur: 40, left_eur: 0 });
    const { data: rows } = await c
      .from("transactions")
      .select("entry_reference, owed_settled")
      .in("entry_reference", ["sr-bill", "sr-ref"]);
    expect(rows!.every((r) => r.owed_settled)).toBe(true);
    await c.rpc("undo_payback", { p_account: ACC, p_ref: "sr-pay", p_forget: false });
    const { data: short } = await record(c, "sr-pay2", "Bea");
    expect(short).toMatchObject({ settled: [], left_eur: 30 });
  });

  it("refund credit is never half used: bills settle only when they use it all", async () => {
    const c = await seed([
      row("pr-ref", {
        amount: 60,
        personal_amount: 10,
        owed_by: "Fede",
        credit_debit_indicator: "CRDT",
        booking_date: "2026-10-01",
      }),
      row("pr-b1", {
        amount: 20,
        personal_amount: 10,
        owed_by: "Fede",
        booking_date: "2026-10-02",
      }),
      row("pr-b2", {
        amount: 200,
        personal_amount: 100,
        owed_by: "Fede",
        booking_date: "2026-10-03",
      }),
      row("pr-pay", {
        amount: 5,
        credit_debit_indicator: "CRDT",
        debtor_name: "Fede Rosa",
        flow_type: "income",
      }),
      row("pr-pay2", {
        amount: 70,
        credit_debit_indicator: "CRDT",
        debtor_name: "Fede Rosa",
        flow_type: "income",
      }),
    ]);
    expect((await record(c, "pr-pay", "Fede")).data).toMatchObject({ settled: [], left_eur: 5 });
    const { data: open } = await c
      .from("transactions")
      .select("entry_reference, owed_settled")
      .in("entry_reference", ["pr-ref", "pr-b1", "pr-b2"]);
    expect(open!.filter((r) => r.owed_settled)).toEqual([]);
    expect((await record(c, "pr-pay2", "Fede")).data).toMatchObject({
      settled: ["pr-b1", "pr-b2"],
      settled_eur: 60,
      left_eur: 10,
    });
  });

  it("asks for a contact before anything else, like the database", async () => {
    const c = await seed([
      row("ck-pay", {
        amount: 20,
        credit_debit_indicator: "CRDT",
        debtor_name: "Ugo",
        flow_type: "income",
        payback_contact: "",
      }),
    ]);
    expect((await record(c, "ck-pay", null)).error?.message).toBe("Contact required");
  });

  it("a yes links the payer: the next payment comes back linked; undo with forget unlinks", async () => {
    const c = await seed([
      row("lk-bill", { amount: 40, personal_amount: 20, owed_by: "Ida" }),
      row("lk-pay", {
        amount: 20,
        credit_debit_indicator: "CRDT",
        debtor_name: "IDA NERI",
        flow_type: "income",
      }),
      row("lk-next", {
        amount: 5,
        credit_debit_indicator: "CRDT",
        debtor_name: "Ida  Neri.",
        flow_type: "income",
      }),
    ]);
    const { data } = await c.rpc("record_payback", {
      p_account: ACC,
      p_ref: "lk-pay",
      p_contact: "Ida",
      p_remember: true,
    });
    expect(data).toMatchObject({ settled: ["lk-bill"], linked: true });
    expect((await record(c, "lk-pay", "Ida")).error?.message).toBe("Payment already checked");
    const linked = async () =>
      (
        (await c.rpc("payback_candidates", { p_days: 60 })).data as Array<{
          entry_reference: string;
          linked_contact: string | null;
        }>
      ).find((r) => r.entry_reference === "lk-next")?.linked_contact;
    expect(await linked()).toBe("Ida");
    await c.rpc("undo_payback", { p_account: ACC, p_ref: "lk-pay", p_forget: true });
    expect(await linked()).toBeNull();
  });

  it("names are read like the page: 'Carla,' is Carla alone", async () => {
    const c = await seed([
      row("cm-1", { amount: 20, personal_amount: 10, owed_by: "Carla," }),
      row("cm-2", { amount: 20, personal_amount: 10, owed_by: "Carla, Dino" }),
      row("cm-pay", {
        amount: 20,
        credit_debit_indicator: "CRDT",
        debtor_name: "Carla Blu",
        flow_type: "income",
      }),
    ]);
    const { data } = await record(c, "cm-pay", "Carla");
    expect(data).toMatchObject({ settled: ["cm-1"], left_eur: 10 });
  });

  it("refuses a missing contact and a payment that is not plain income", async () => {
    const c = await seed([
      row("x-pay", {
        amount: 20,
        credit_debit_indicator: "CRDT",
        debtor_name: "Ugo",
        flow_type: "income",
      }),
      row("x-transfer", {
        amount: 20,
        credit_debit_indicator: "CRDT",
        debtor_name: "Ugo",
        flow_type: "transfer",
      }),
      row("x-split", {
        amount: 20,
        personal_amount: 5,
        credit_debit_indicator: "CRDT",
        debtor_name: "Ugo",
        flow_type: "income",
      }),
      row("x-sw", {
        amount: 20,
        import_batch_id: "b1",
        credit_debit_indicator: "CRDT",
        debtor_name: "Ugo",
        flow_type: "income",
      }),
    ]);
    expect((await record(c, "x-pay", null)).error?.message).toBe("Contact required");
    for (const ref of ["x-transfer", "x-split", "x-sw"])
      expect((await record(c, ref, "Ugo")).error?.message).toBe("Payment not found");
    const { data } = await c.rpc("payback_candidates", { p_days: 60 });
    const refs = (data as Array<{ entry_reference: string }>).map((r) => r.entry_reference);
    expect(refs).toContain("x-pay");
    expect(refs).not.toEqual(expect.arrayContaining(["x-transfer"]));
    expect(refs.filter((r) => r.startsWith("x-") && r !== "x-pay")).toEqual([]);
  });
});

describe("demo payerKey matches the database's payer_key", () => {
  it("folds the same letters and cuts at 200", async () => {
    const { payerKey } = await import("./fake-client");
    expect(
      payerKey(
        "Řehoř ŁUKASZ Øster Šťastný Dvořák Ćwik Węgrzyn Nagy Ödön Győző Žanić Ålund Ærø Straße",
      ),
    ).toBe(
      "rehor lukasz oster stastny dvorak cwik wegrzyn nagy odon gyozo zanic alund aero strasse",
    );
    expect(payerKey("ab ".repeat(150))?.length).toBe(200);
    // Characters, like the database's left(): a letter outside the BMP is one, not two units.
    expect([...(payerKey("𠀀".repeat(250)) ?? "")].length).toBe(200);
  });
});
