import { describe, expect, it } from "vitest";
import {
  accessRows,
  aiRow,
  attentionCount,
  bySeverity,
  groupByBank,
  originRow,
  pushRow,
  supabaseSecretsUrl,
  syncAgeHours,
  syncRows,
  syncState,
  syncStatus,
  type HealthAccount,
} from "./health";

const NOW = new Date("2026-10-28T12:00:00Z");
const acct = (over: Partial<HealthAccount>): HealthAccount => ({
  uid: "u1",
  label: "Revolut EUR",
  currency: "EUR",
  bank_name: "Revolut",
  consent_valid_until: "2027-03-01",
  snapshot_date: "2026-10-28",
  ...over,
});

describe("syncState", () => {
  it.each([
    [0, "ok"],
    [24.1, "ok"],
    [48, "ok"],
    [48.1, "warn"],
    [72, "warn"],
    [72.1, "bad"],
  ] as const)("%s h is %s", (h, state) => expect(syncState(h)).toBe(state));

  it("reads a snapshot from today or yesterday as fresh, two days back as amber, three as red", () => {
    const state = (d: string) => syncState(syncAgeHours(d, NOW));
    expect(state("2026-10-28")).toBe("ok");
    expect(state("2026-10-27")).toBe("ok");
    expect(state("2026-10-26")).toBe("warn");
    expect(state("2026-10-25")).toBe("bad");
  });

  // Syncs run 4 times a day, the first at 05:17 UTC: from midnight UTC until then the latest
  // balance is dated yesterday. That is on schedule, not an account that needs attention.
  it("keeps the last evening's sync fresh until the next morning's run", () => {
    const justAfterMidnight = new Date("2026-10-29T00:08:00Z");
    expect(syncState(syncAgeHours("2026-10-28", justAfterMidnight))).toBe("ok");
    expect(syncState(syncAgeHours("2026-10-28", new Date("2026-10-29T05:16:00Z")))).toBe("ok");
  });
});

describe("syncRows", () => {
  // polish-5 audit #3: with no IBAN and no label there is nothing to name the account by;
  // groupByBank then falls back to the end of its id.
  it("leaves the account name out when there is neither IBAN nor label", () => {
    const [row] = syncRows([acct({ iban: null, label: null })], new Date("2026-10-28T12:00:00Z"));
    expect(row).not.toHaveProperty("account");
  });

  it("skips accounts without a bank consent", () => {
    expect(syncRows([acct({ consent_valid_until: null })], NOW)).toEqual([]);
  });
  it("warns when an account never synced", () => {
    expect(syncRows([acct({ snapshot_date: null })], NOW)[0]?.state).toBe("warn");
  });
  it("offers a fix only when stale", () => {
    const [fresh, stale] = syncRows(
      [acct({}), acct({ uid: "u2", snapshot_date: "2026-10-20" })],
      NOW,
    );
    expect(fresh?.fix).toBeUndefined();
    expect(stale).toMatchObject({ state: "bad" });
    expect(stale?.detail).toMatch(/^Last synced 8 days ago\. /);
  });

  // Marco 2026-11-24: "Check access" only opened Accounts, which said nothing about what was wrong.
  // Each stale or failing account now names its cause and the one fix for it.
  const URL = "https://abcref.supabase.co";
  const one = (over: Partial<HealthAccount>, url: string | undefined = URL) =>
    syncRows([acct(over)], NOW, url)[0]!;

  it("stale with no error: says no sync reached it and links the sync logs", () => {
    const row = one({ snapshot_date: "2026-10-25" });
    expect(row.detail).toMatch(/no error/i);
    expect(row.fix).toEqual({
      label: "Open sync logs",
      href: "https://supabase.com/dashboard/project/abcref/functions/sync-bank/logs",
    });
  });

  it("ended access: says so and offers Renew access", () => {
    const row = one({ consent_valid_until: "2026-10-01", snapshot_date: "2026-09-30" });
    expect(row).toMatchObject({ state: "bad", fix: { label: "Renew access", to: "/accounts" } });
    expect(row.detail).toMatch(/access ended/i);
  });

  it("bank stopped sharing the account: names it and offers Connect again, even when fresh", () => {
    const row = one({ sync_error: "ASPSP_ACCOUNT_NOT_ACCESSIBLE" });
    expect(row.state).toBe("warn");
    expect(row.detail).toMatch(/no longer shares/);
    expect(row.fix).toEqual({ label: "Connect again", to: "/accounts" });
  });

  it("bad key: explains it and links the Supabase secrets", () => {
    const row = one({ sync_error: "KEY_INVALID" });
    expect(row.state).toBe("warn");
    expect(row.detail).toMatch(/ENABLE_BANKING_PRIVATE_KEY/);
    expect(row.fix).toEqual({
      label: "Open Supabase secrets",
      href: "https://supabase.com/dashboard/project/abcref/functions/secrets",
    });
  });

  it("a bank hiccup on fresh data is fine; on stale data it says it retries", () => {
    expect(one({ sync_error: "ASPSP_RATE_LIMIT_EXCEEDED" }).state).toBe("ok");
    const row = one({ sync_error: "HTTP_503", snapshot_date: "2026-10-25" });
    expect(row.detail).toMatch(/^Last synced 3 days ago\. Revolut didn't answer/);
    expect(row.fix).toMatchObject({ label: "Open sync logs" });
  });

  it("leaves a link out when the project address isn't a supabase.co one", () => {
    expect(one({ snapshot_date: "2026-10-25" }, "http://localhost:54321").fix).toBeUndefined();
  });
});

describe("accessRows", () => {
  it("makes one row per bank, worst state for the bank's soonest consent", () => {
    const rows = accessRows(
      [
        acct({}),
        acct({ uid: "u2", currency: "USD", consent_valid_until: "2026-11-02" }),
        acct({
          uid: "u3",
          bank_name: "Wise",
          label: "Wise EUR",
          consent_valid_until: "2026-10-01",
        }),
        acct({
          uid: "u4",
          bank_name: "Fineco",
          label: "Fineco EUR",
          consent_valid_until: "2027-04-01",
        }),
        acct({ uid: "u5", bank_name: "Manual", consent_valid_until: null }),
      ],
      NOW,
    );
    expect(rows.map((r) => [r.title, r.state])).toEqual([
      ["Revolut access", "warn"],
      ["Wise access", "bad"],
      ["Fineco access", "ok"],
    ]);
    expect(rows[0]?.detail).toBe("Bank access ends in 5 days.");
    expect(rows[1]?.fix).toEqual({ label: "Renew access", to: "/accounts" });
    expect(rows[2]?.fix).toBeUndefined();
  });
  it("treats the last day as red", () => {
    expect(accessRows([acct({ consent_valid_until: "2026-10-28" })], NOW)[0]).toMatchObject({
      state: "bad",
      detail: "Bank access ends today.",
    });
  });
});

describe("pushRow", () => {
  it("is absent where push can't work", () => expect(pushRow("unsupported", false)).toBeNull());
  it("tells a browser tab to install the app", () => {
    expect(pushRow("install", false)).toMatchObject({ state: "warn" });
    expect(pushRow("install", false)?.detail).toContain("Install the app first");
  });
  it("offers the enable control until subscribed", () => {
    expect(pushRow("ok", false)).toMatchObject({ state: "warn", fix: { push: true } });
    expect(pushRow("ok", true)).toMatchObject({ state: "ok" });
  });
});

describe("originRow", () => {
  it("is absent when the table isn't readable", () => expect(originRow(null)).toBeNull());
  it("warns on none, passes on some", () => {
    expect(originRow(0)?.state).toBe("warn");
    expect(originRow(1)?.state).toBe("ok");
  });
});

describe("severity", () => {
  it("sorts worst first and counts what needs attention", () => {
    const rows = [
      { id: "a", title: "a", state: "ok", detail: "" },
      { id: "b", title: "b", state: "bad", detail: "" },
      { id: "c", title: "c", state: "warn", detail: "" },
    ] as const;
    expect([...rows].sort(bySeverity).map((r) => r.id)).toEqual(["b", "c", "a"]);
    expect(attentionCount([...rows])).toBe(2);
  });
});

describe("supabaseSecretsUrl", () => {
  it("links to the project's Edge Function secrets", () => {
    expect(supabaseSecretsUrl("https://abcdefghijklmnopqrst.supabase.co")).toBe(
      "https://supabase.com/dashboard/project/abcdefghijklmnopqrst/functions/secrets",
    );
  });
  it.each([undefined, "", "https://not-configured.invalid", "https://evil.com/x.supabase.co"])(
    "is null for %s",
    (url) => expect(supabaseSecretsUrl(url)).toBeNull(),
  );
});

describe("aiRow", () => {
  const url = "https://supabase.com/dashboard/project/x/functions/secrets";

  it("is skipped when there is nothing to judge or the counts are unknown", () => {
    expect(aiRow(null, url)).toBeNull();
    expect(aiRow({ ai: 0, stuck: 0 }, url)).toBeNull();
  });

  it("is healthy while Gemini sorts and nothing is left behind", () => {
    const row = aiRow({ ai: 1, stuck: 0 }, url)!;
    expect(row.state).toBe("ok");
    expect(row.detail).toBe("Gemini sorted 1 transaction in the last 30 days.");
    expect(row.fix).toBeUndefined();
  });

  it("warns when rows stay uncategorized, even if Gemini worked earlier (revoked key, quota)", () => {
    const row = aiRow({ ai: 40, stuck: 12 }, url)!;
    expect(row.state).toBe("warn");
    expect(row.detail).toMatch(/^12 transactions still have no category a day after syncing\./);
    expect(row.detail).toMatch(/GEMINI_API_KEY/);
    expect(row.detail).not.toMatch(/setup\.sh|GitHub secrets/);
    expect(row.detail).toMatch(/free tier may train on them/);
    expect(row.fix).toEqual({ label: "Open Supabase secrets", href: url });
  });

  it("uses the singular for one row and has no link when the project address is unknown", () => {
    const row = aiRow({ ai: 0, stuck: 1 }, null)!;
    expect(row.detail).toMatch(/^1 transaction still has no category/);
    expect(row.fix).toBeUndefined();
  });
});

describe("syncStatus", () => {
  // protects=the Net Worth freshness line; fails_when=it claims a sync for manual-only data
  it("is null without a connected bank", () => {
    expect(syncStatus([acct({ consent_valid_until: null })], NOW)).toBeNull();
  });
  it("reads fresh with nothing to fix", () => {
    expect(syncStatus([acct({})], NOW)).toEqual({ text: "Synced today", attention: 0 });
  });
  it("reports the stalest bank and counts the checks that need attention", () => {
    expect(syncStatus([acct({}), acct({ uid: "u2", snapshot_date: "2026-10-25" })], NOW)).toEqual({
      text: "Synced 3 days ago",
      attention: 1,
    });
  });
  it("says when no bank has synced yet", () => {
    expect(syncStatus([acct({ snapshot_date: null })], NOW)).toEqual({
      text: "Not synced yet",
      attention: 1,
    });
  });
});

// protects=a long list of linked accounts reads as one item per bank (whiteboard note);
// fails_when=per-account rows show flat again, or a broken bank hides behind a healthy one
describe("groupByBank", () => {
  const accounts = [
    acct({ uid: "r1" }),
    acct({ uid: "r2", currency: "USD" }),
    acct({ uid: "f1", label: "Fineco EUR", bank_name: "Fineco", snapshot_date: "2026-10-20" }),
  ];
  const rows = [...accessRows(accounts, NOW), ...syncRows(accounts, NOW)];

  it("folds each bank's checks into one item, worst bank and worst row first", () => {
    const items = groupByBank(rows);
    expect(items.map((i) => ("rows" in i ? i.bank : i.id))).toEqual(["Fineco", "Revolut"]);
    const [fineco, revolut] = items as Array<{ state: string; rows: Array<{ id: string }> }>;
    expect(fineco!.state).toBe("bad");
    expect(fineco!.rows.map((r) => r.id)).toEqual(["sync:f1", "access:Fineco"]);
    expect(revolut!.state).toBe("ok");
    expect(revolut!.rows).toHaveLength(3);
  });

  it("keeps checks without a bank as single rows, after banks of the same state", () => {
    const origin = originRow(1)!;
    const items = groupByBank([origin, ...rows]);
    expect(items.map((i) => ("rows" in i ? i.bank : i.id))).toEqual([
      "Fineco",
      "Revolut",
      "origin",
    ]);
  });

  it("names two accounts of one bank in the same currency by IBAN end, else label", () => {
    const twins = [
      acct({ uid: "a", iban: "IT60X0542811101000000123456" }),
      acct({ uid: "b", label: "Savings" }),
      acct({ uid: "c", currency: "USD" }),
    ];
    const [group] = groupByBank(syncRows(twins, NOW)) as Array<{ rows: Array<{ title: string }> }>;
    expect(group!.rows.map((r) => r.title)).toEqual([
      "Revolut EUR sync · •••• 3456",
      "Revolut EUR sync · Savings",
      "Revolut USD sync",
    ]);
  });

  // polish-1 #2: real labels are the holder name, so two IBAN-less cards share it.
  // fails_when=both rows still read "Revolut EUR sync · Jane Doe"
  it("falls back to the account id's end when the label doesn't tell twins apart", () => {
    const cards = [
      acct({ uid: "card-1111", label: "Jane Doe" }),
      acct({ uid: "card-2222", label: "Jane Doe" }),
    ];
    const [group] = groupByBank(syncRows(cards, NOW)) as Array<{ rows: Array<{ title: string }> }>;
    expect(group!.rows.map((r) => r.title)).toEqual([
      "Revolut EUR sync · …1111",
      "Revolut EUR sync · …2222",
    ]);
  });
});
