import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BankTx } from "@/lib/import/splitwise-match";
import { setLocaleOverride } from "@/lib/locale";

const rpc = vi.hoisted(() => vi.fn());
const invoke = vi.hoisted(() => vi.fn());
const query = vi.hoisted(() => ({ result: { data: [] as unknown, error: null as unknown } }));
const calls = vi.hoisted(() => [] as Array<[string, Array<unknown>]>);
vi.mock("@/integrations/supabase/client", () => {
  const from = (table: string) => {
    calls.push(["from", [table]]);
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "order", "limit"])
      q[m] = (...args: Array<unknown>) => {
        calls.push([m, args]);
        return q;
      };
    q["then"] = (resolve: (v: unknown) => void) => resolve(query.result);
    return q;
  };
  return { supabase: { rpc, from, functions: { invoke } } };
});

import {
  connectSplitwise,
  disconnectSplitwise,
  fetchConnection,
  fetchReview,
  previewSync,
  reviewRow,
  runReviewAction,
  suggestMatches,
  syncedAgo,
  syncNow,
  syncRefreshKeys,
  syncSummary,
  balancesSource,
  formatCount,
  SyncError,
  type ReviewItem,
  type SplitwiseConnection,
} from "./splitwise-sync";

/** What supabase.functions.invoke returns for a non-2xx reply. */
const httpError = (status: number, body: unknown) => ({
  data: null,
  error: {
    message: "Edge Function returned a non-2xx status code",
    context: new Response(JSON.stringify(body), { status }),
  },
});

const item = (over: Partial<ReviewItem> = {}): ReviewItem => ({
  id: "r1",
  kind: "paid_by_me",
  group_name: "Flat",
  booking_date: "2026-11-10",
  description: "Groceries",
  cost: 60,
  my_share: 20,
  my_paid: 60,
  currency: "EUR",
  rejected_entry_references: [],
  ...over,
});

const tx = (over: Partial<BankTx> = {}): BankTx => ({
  entryReference: "e1",
  accountUid: "a1",
  bookingDate: "2026-11-11",
  amountCents: 6000,
  currency: "EUR",
  direction: "DBIT",
  personalAmountCents: null,
  flowType: null,
  ...over,
});
const eur = () => 1;

beforeEach(() => {
  rpc.mockReset();
  invoke.mockReset();
  calls.length = 0;
});

describe("fetchConnection", () => {
  it("reads the connection row", async () => {
    rpc.mockResolvedValue({
      data: [
        {
          connected: true,
          status: "ok",
          display_name: "Sam",
          last_synced_at: "2026-11-17T10:00:00Z",
          last_error: null,
        },
      ],
      error: null,
    });
    expect(await fetchConnection()).toEqual({
      connected: true,
      status: "ok",
      displayName: "Sam",
      lastSyncedAt: "2026-11-17T10:00:00Z",
      lastError: null,
      syncedData: false,
    });
    expect(rpc).toHaveBeenCalledWith("get_splitwise_connection");
  });

  // polish-2 #6
  it("reads whether synced data is left", async () => {
    rpc.mockResolvedValue({
      data: [
        {
          connected: false,
          status: null,
          display_name: null,
          last_synced_at: null,
          last_error: null,
          synced_data: true,
        },
      ],
      error: null,
    });
    expect((await fetchConnection()).syncedData).toBe(true);
  });

  it("reads no connection as not connected", async () => {
    rpc.mockResolvedValue({
      data: [
        {
          connected: false,
          status: null,
          display_name: null,
          last_synced_at: null,
          last_error: null,
        },
      ],
      error: null,
    });
    expect((await fetchConnection()).connected).toBe(false);
    rpc.mockResolvedValue({ data: [], error: null });
    expect(await fetchConnection()).toMatchObject({ connected: false, status: null });
  });

  it("throws the database message", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(fetchConnection()).rejects.toThrow("boom");
  });
});

describe("Edge Function calls", () => {
  // protects=the request shapes the backend reads; fails_when=a field is renamed or consent is dropped
  it("sends the key with consent, a preview, a sync and a disconnect", async () => {
    invoke.mockResolvedValue({ data: { displayName: "Sam" }, error: null });
    expect(await connectSplitwise("  abcdefghijkl  ")).toEqual({ displayName: "Sam" });
    expect(invoke).toHaveBeenLastCalledWith("splitwise-connect", {
      body: { apiKey: "abcdefghijkl", consent: true },
    });
    invoke.mockResolvedValue({ data: { new: 1, adopted: 0, review: 2, deleted: 0 }, error: null });
    await previewSync();
    expect(invoke).toHaveBeenLastCalledWith("sync-splitwise", { body: { preview: true } });
    await syncNow();
    expect(invoke).toHaveBeenLastCalledWith("sync-splitwise", { body: {} });
    invoke.mockResolvedValue({ data: { disconnected: true, deleted: 3 }, error: null });
    expect(await disconnectSplitwise(true)).toEqual({ disconnected: true, deleted: 3 });
    expect(invoke).toHaveBeenLastCalledWith("splitwise-connect", {
      body: { disconnect: true, deleteData: true },
    });
  });

  // protects=the user reads why it failed; fails_when=the server's message or code is lost
  it("throws the function's message, status and code", async () => {
    invoke.mockResolvedValue(
      httpError(409, { error: "Connect again with a new key.", code: "needs_reconnect" }),
    );
    const err = await syncNow().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SyncError);
    expect(err).toMatchObject({
      message: "Connect again with a new key.",
      status: 409,
      code: "needs_reconnect",
    });
    expect((err as SyncError).rateLimited).toBe(false);

    invoke.mockResolvedValue(
      httpError(429, { error: "Synced a moment ago. Try again in a minute." }),
    );
    const slow = (await syncNow().catch((e: unknown) => e)) as SyncError;
    expect(slow.rateLimited).toBe(true);
    expect(slow.code).toBeNull();
  });

  it("falls back to its own message when the reply has none", async () => {
    invoke.mockResolvedValue({ data: null, error: { message: "Failed to fetch" } });
    const err = (await connectSplitwise("abcdefghijkl").catch((e: unknown) => e)) as SyncError;
    expect(err.message).toBe("Couldn't connect Splitwise. Try again later.");
    expect(err.status).toBeNull();
  });

  // polish-3 #10: one copy style for every fallback
  it("words every fallback the same way", async () => {
    invoke.mockResolvedValue({ data: null, error: { message: "Failed to fetch" } });
    const messages = await Promise.all(
      [connectSplitwise("abcdefghijkl"), disconnectSplitwise(true), previewSync(), syncNow()].map(
        (p) => p.catch((e: unknown) => (e as Error).message),
      ),
    );
    expect(messages).toEqual([
      "Couldn't connect Splitwise. Try again later.",
      "Couldn't disconnect Splitwise. Try again later.",
      "Couldn't check Splitwise. Try again later.",
      "Couldn't sync with Splitwise. Try again later.",
    ]);
  });
});

describe("syncSummary", () => {
  it("names what changed", () => {
    expect(syncSummary({ new: 2, adopted: 1, review: 3, deleted: 1 })).toBe(
      "2 new expenses, 1 expense already imported, 3 to link, 1 removed",
    );
    expect(syncSummary({ new: 1, adopted: 2, review: 0, deleted: 0 })).toBe(
      "1 new expense, 2 expenses already imported",
    );
  });
  it("says so when nothing changed", () => {
    expect(syncSummary({ new: 0, adopted: 0, review: 0, deleted: 0 })).toBe("Nothing new");
  });
  // polish-3 #7: counts group thousands as every other figure in the app does
  it("groups thousands in the chosen locale", () => {
    setLocaleOverride("it-IT");
    try {
      expect(syncSummary({ new: 1234, adopted: 2000, review: 1500, deleted: 1001 })).toBe(
        "1.234 new expenses, 2.000 expenses already imported, 1.500 to link, 1.001 removed",
      );
      expect(formatCount(1234)).toBe("1.234");
    } finally {
      setLocaleOverride("");
    }
  });
});

describe("syncedAgo", () => {
  const now = new Date("2026-11-17T12:00:00Z");
  it.each([
    [null, "Not synced yet"],
    ["garbage", "Not synced yet"],
    ["2026-11-17T11:59:40Z", "Synced just now"],
    ["2026-11-17T11:55:00Z", "Synced 5 min ago"],
    ["2026-11-17T09:00:00Z", "Synced 3 h ago"],
    ["2026-11-16T11:00:00Z", "Synced 1 day ago"],
    ["2026-11-10T12:00:00Z", "Synced 7 days ago"],
  ])("%s → %s", (iso, text) => {
    expect(syncedAgo(iso, now)).toBe(text);
  });
});

describe("fetchReview", () => {
  it("reads the pending items, newest first", async () => {
    query.result = { data: [item()], error: null, count: 1 } as typeof query.result;
    expect(await fetchReview()).toEqual({ items: [item()], total: 1 });
    expect(calls).toContainEqual(["from", ["splitwise_review"]]);
    expect(calls).toContainEqual(["eq", ["status", "pending"]]);
    expect(calls).toContainEqual(["order", ["booking_date", { ascending: false }]]);
  });
  it("throws the database message", async () => {
    query.result = { data: null, error: { message: "nope" } };
    await expect(fetchReview()).rejects.toThrow("nope");
  });
  // polish-3 #2: the list stops at 500; the total says how many really wait
  it("counts every pending item, beyond the 500 it reads", async () => {
    query.result = { data: [item()], error: null, count: 1200 } as typeof query.result;
    expect((await fetchReview()).total).toBe(1200);
    expect(calls).toContainEqual(["select", [expect.any(String), { count: "exact" }]]);
  });
});

describe("reviewRow", () => {
  it("matches an expense I paid on what I paid", () => {
    expect(
      reviewRow(item({ kind: "multi_payer", cost: 90, my_paid: 30, my_share: 30 }), 0),
    ).toMatchObject({
      row: 1,
      kind: "paid_by_me",
      costCents: 3000,
      shareCents: 3000,
    });
  });
  it("matches a settle-up on its amount, in the right direction", () => {
    expect(
      reviewRow(item({ kind: "settle_in", cost: 22, my_paid: 0, my_share: 0 }), 1),
    ).toMatchObject({
      row: 2,
      kind: "settle_in",
      costCents: 2200,
      shareCents: null,
    });
    expect(reviewRow(item({ kind: "settle_out", cost: 22, my_paid: 22 }), 0).kind).toBe(
      "settle_out",
    );
  });
});

describe("suggestMatches", () => {
  // protects=DBIT for what I paid, CRDT for a settle-up received; fails_when=money in is
  // suggested for an expense I paid, or the other way round
  it("suggests payments out for what I paid and money in for a settle-up received", () => {
    const items = [
      item(),
      item({ id: "r2", kind: "settle_in", cost: 22, my_paid: 0, my_share: 0 }),
    ];
    const bank = [
      tx(),
      tx({ entryReference: "in-wrong", direction: "DBIT", amountCents: 2200 }),
      tx({ entryReference: "in", direction: "CRDT", amountCents: 2200 }),
    ];
    const s = suggestMatches(items, bank, eur);
    expect(s.get("r1")).toMatchObject({ tx: { entryReference: "e1" }, confidence: "likely" });
    expect(s.get("r2")?.tx.entryReference).toBe("in");
  });

  // protects=Not this one sticks; fails_when=a rejected transaction is suggested again
  it("never suggests a transaction rejected for that item", () => {
    const s = suggestMatches([item({ rejected_entry_references: ["e1"] })], [tx()], eur);
    expect(s.size).toBe(0);
  });

  it("suggests nothing without a close payment", () => {
    expect(suggestMatches([item()], [tx({ amountCents: 100 })], eur).size).toBe(0);
  });
});

describe("runReviewAction", () => {
  it("calls the RPC for each action", async () => {
    rpc.mockResolvedValue({ data: {}, error: null });
    await runReviewAction({
      action: "link",
      id: "r1",
      tx: { accountUid: "a1", entryReference: "e1" },
    });
    expect(rpc).toHaveBeenLastCalledWith("link_splitwise_review", {
      p_id: "r1",
      p_account_uid: "a1",
      p_entry_reference: "e1",
    });
    await runReviewAction({ action: "reject", id: "r1", entryReference: "e1" });
    expect(rpc).toHaveBeenLastCalledWith("reject_splitwise_match", {
      p_id: "r1",
      p_entry_reference: "e1",
    });
    await runReviewAction({ action: "count", id: "r1" });
    expect(rpc).toHaveBeenLastCalledWith("count_splitwise_review", { p_id: "r1" });
    await runReviewAction({ action: "dismiss", id: "r1" });
    expect(rpc).toHaveBeenLastCalledWith("dismiss_splitwise_review", { p_id: "r1" });
  });

  it("throws the database message", async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { message: "This Splitwise expense is already settled." },
    });
    await expect(runReviewAction({ action: "count", id: "r1" })).rejects.toThrow("already settled");
  });
});

describe("syncRefreshKeys", () => {
  // protects=a link or a sync shows at once in spending and the bank list; fails_when=a key is dropped
  it("refreshes the import's keys plus the connection and the To link list", () => {
    const keys = syncRefreshKeys().map((k) => k[0]);
    for (const k of [
      "transactions",
      "spend-by-category",
      "splitwise-balances",
      "splitwise-connection",
      "splitwise-review",
    ])
      expect(keys).toContain(k);
  });
});

// polish-3 #17: the balances' title follows where they came from, not just "connected"
describe("balancesSource", () => {
  const c = (over: Partial<SplitwiseConnection>): SplitwiseConnection => ({
    connected: false,
    status: null,
    displayName: null,
    lastSyncedAt: null,
    lastError: null,
    syncedData: false,
    ...over,
  });
  it("names the source only when it is sure", () => {
    expect(balancesSource(c({ connected: true, status: "ok", syncedData: true }))).toBe(
      "synced from Splitwise",
    );
    expect(
      balancesSource(c({ connected: true, status: "needs_reconnect", syncedData: true })),
    ).toBe("from your last sync");
    expect(balancesSource(c({ connected: true, status: "error", syncedData: true }))).toBe(
      "from your last sync",
    );
    expect(balancesSource(c({}))).toBe("from your last import");
    // Disconnected with synced data kept: a later file may have replaced a group. Unknown: no claim.
    expect(balancesSource(c({ syncedData: true }))).toBeNull();
    expect(balancesSource(undefined)).toBeNull(); // loading or failed
  });
});
