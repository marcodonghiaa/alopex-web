import { supabase } from "@/integrations/supabase/client";
import { readPages } from "./read-pages";
import type { HistoryRow, NetWorthRow, ReconstructedRow } from "./net-worth";

// The three sources behind every net worth view: live daily snapshots, months imported from the
// sheet, and months rebuilt from statements. Merged by withHistory. Each has one row per date for
// the signed-in user, so snapshot_date is a total order and the reads can page past the row cap.
export function fetchNetWorth(): Promise<Array<NetWorthRow>> {
  return readPages<NetWorthRow>((from, to) =>
    supabase
      .from("v_net_worth_daily")
      .select(
        "snapshot_date,total_eur,bank_total_eur,portfolio_total_eur,crypto_total_eur,portfolio_bonds_eur,liabilities_eur",
      )
      .order("snapshot_date", { ascending: true })
      .range(from, to),
  );
}

export function fetchHistory(): Promise<Array<HistoryRow>> {
  return readPages<HistoryRow>((from, to) =>
    supabase
      .from("net_worth_history")
      .select(
        "snapshot_date,stocks_eur,bonds_eur,crypto_eur,cash_eur,other_eur,liabilities_eur,total_eur",
      )
      .order("snapshot_date", { ascending: true })
      .range(from, to),
  );
}

export function fetchReconstructed(): Promise<Array<ReconstructedRow>> {
  return readPages<ReconstructedRow>((from, to) =>
    supabase
      .from("net_worth_reconstructed")
      .select("snapshot_date,stocks_eur,bonds_eur,cash_eur,crypto_eur")
      .order("snapshot_date", { ascending: true })
      .range(from, to),
  );
}
