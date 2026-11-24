import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { pushSupport } from "@/components/push-subscribe";
import { isDemoMode } from "@/lib/demo/mode";
import { supabase } from "@/integrations/supabase/client";
import { originStatusQuery } from "@/lib/register-origin";
import {
  accessRows,
  aiRow,
  bySeverity,
  originRow,
  pushRow,
  supabaseSecretsUrl,
  syncRows,
  syncStatus,
  type HealthAccount,
  type HealthRow,
} from "@/lib/health";

/** Every bank account's latest balance, largest first: the one queryFn of ["bank-accounts-latest"]. */
export async function fetchBankAccounts<T = HealthAccount>(): Promise<Array<T>> {
  const { data, error } = await supabase
    .from("v_bank_accounts_latest")
    // "*" rather than a column list, so the page still loads on a database without bank_name/bank_logo.
    .select("*")
    .order("amount_eur", { ascending: false });
  if (error) throw error;
  return (data ?? []) as Array<T>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Last 30 days: transactions sorted by AI, and ones still without a category a day after they
// arrived. Null in the demo (its rows say nothing about a real key) or when a count can't be read.
async function fetchAiCounts(): Promise<{ ai: number; stuck: number } | null> {
  if (isDemoMode()) return null;
  const since = new Date(Date.now() - 30 * DAY_MS).toISOString().slice(0, 10);
  const dayAgo = new Date(Date.now() - DAY_MS).toISOString();
  const count = (filter: "ai" | "none") => {
    const q = supabase
      .from("transactions")
      .select("entry_reference", { count: "exact", head: true })
      .gte("booking_date", since)
      .is("deleted_at", null);
    return filter === "ai"
      ? q.eq("category_source", "ai")
      : q.is("category", null).lt("created_at", dayAgo);
  };
  const [ai, none] = await Promise.all([count("ai"), count("none")]);
  if (ai.error || none.error || ai.count === null || none.count === null) return null;
  return { ai: ai.count, stuck: none.count };
}

// Whether this browser holds a push subscription. Null until known, or where push can't work.
async function fetchPushSubscribed(): Promise<boolean> {
  const reg = await navigator.serviceWorker.getRegistration();
  return !!(await reg?.pushManager.getSubscription());
}

/** Everything Settings needs from the health checks: the rows, split so push shows under Notifications. */
export function useHealth() {
  const accounts = useQuery({
    queryKey: ["bank-accounts-latest"],
    queryFn: () => fetchBankAccounts(),
  });
  const origin = useQuery(originStatusQuery(() => supabase.rpc("register_dashboard_origin")));
  const ai = useQuery({ queryKey: ["ai-categorized"], queryFn: fetchAiCounts });
  // Client-only: pushSupport() reads window, and SSR must render the same first pass.
  const [support, setSupport] = useState<ReturnType<typeof pushSupport> | null>(null);
  useEffect(() => setSupport(pushSupport()), []);
  const subscribed = useQuery({
    queryKey: ["push-subscribed"],
    queryFn: fetchPushSubscribed,
    enabled: support === "ok",
  });

  const rows = useMemo(() => {
    const now = new Date();
    const list = accounts.data ?? [];
    const projectUrl = import.meta.env["VITE_SUPABASE_URL"];
    return [
      ...accessRows(list, now),
      ...syncRows(list, now, projectUrl),
      // The demo's answer says nothing about a real backend.
      isDemoMode() ? null : originRow(origin.data ?? null),
      ai.data === undefined ? null : aiRow(ai.data, supabaseSecretsUrl(projectUrl)),
    ]
      .filter((r): r is HealthRow => r !== null)
      .sort(bySeverity);
  }, [accounts.data, origin.data, ai.data]);

  const push: HealthRow | null =
    support && (support !== "ok" || subscribed.data !== undefined)
      ? pushRow(support, subscribed.data ?? false)
      : null;

  return { accounts, rows, push };
}

/** Just the freshness line for Net Worth: shares the accounts query with Settings › Health. */
export function useSyncStatus() {
  const accounts = useQuery({
    queryKey: ["bank-accounts-latest"],
    queryFn: () => fetchBankAccounts(),
  });
  return useMemo(
    () => (accounts.data ? syncStatus(accounts.data, new Date()) : null),
    [accounts.data],
  );
}
