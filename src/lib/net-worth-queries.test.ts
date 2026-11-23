import { describe, expect, it, vi } from "vitest";
import { cappedClient } from "@/test/capped-client";

// 1500 days of snapshots, more than PostgREST's default 1000-row cap. Stored newest first, so
// only a query that orders and pages gets them all back in date order.
const days = Array.from({ length: 1500 }, (_, i) => ({
  snapshot_date: new Date(Date.UTC(2022, 0, 1 + 1499 - i)).toISOString().slice(0, 10),
  total_eur: 1499 - i,
}));
const newest = days[0]!.snapshot_date;

const fake = vi.hoisted(() => ({ current: null as unknown as { from: unknown } }));
vi.mock("@/integrations/supabase/client", () => ({
  get supabase() {
    return fake.current;
  },
}));

import { fetchHistory, fetchNetWorth, fetchReconstructed } from "./net-worth-queries";

describe("net worth queries past the 1000-row cap", () => {
  // protects=the headline shows today's net worth; fails_when=a long history is cut at the
  // server's row cap and the newest days are dropped
  it.each([
    ["v_net_worth_daily", fetchNetWorth],
    ["net_worth_history", fetchHistory],
    ["net_worth_reconstructed", fetchReconstructed],
  ] as const)("reads every row of %s up to the newest day", async (table, fetch) => {
    fake.current = cappedClient({ [table]: days }).client;
    const rows = await fetch();
    expect(rows).toHaveLength(1500);
    expect(rows.at(-1)?.snapshot_date).toBe(newest);
    expect(rows[0]?.snapshot_date).toBe("2022-01-01");
  });
});
