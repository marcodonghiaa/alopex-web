import { supabase } from "@/integrations/supabase/client";
import { plural } from "@/lib/plural";

/**
 * Brokers whose bank rows the database matches to their imported CSV rows (the backend's
 * public.broker_sources()): Trade Republic's bank sync sends a date and an amount, nothing else.
 */
export const BANK_MATCHED_BROKERS: ReadonlySet<string> = new Set(["trade_republic"]);

export interface BrokerMatch {
  matched: number;
  cleared: number;
  unmatched: number;
}

/** Matches the broker's bank rows to what's imported. null when it couldn't run (say, an older backend). */
export async function matchBrokerRows(): Promise<BrokerMatch | null> {
  const { data, error } = await supabase.rpc("match_broker_rows");
  if (error || !data) return null;
  return data;
}

/** "Matched 12 bank rows, 3 not matched yet"; nothing when there's no bank account to match. */
export function matchSummary(m: BrokerMatch | null): string | undefined {
  if (!m || (m.matched === 0 && m.unmatched === 0)) return undefined;
  if (m.matched === 0) return `${plural(m.unmatched, "bank row")} not matched yet`;
  return m.unmatched > 0
    ? `Matched ${plural(m.matched, "bank row")}, ${m.unmatched} not matched yet`
    : `Matched ${plural(m.matched, "bank row")}`;
}
