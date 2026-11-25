import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { BalanceRow } from "@/lib/import/splitwise-balances";

async function fetchBalances(): Promise<Array<BalanceRow>> {
  const { data, error } = await supabase
    .from("splitwise_balances")
    .select("group_name,person,balance,currency,is_me,updated_at,basis");
  if (error) throw error;
  return (data ?? []) as Array<BalanceRow>;
}

// Latest rate per currency, read one currency at a time: in one newest-first window a currency
// whose rates stopped updating would fall behind the others' newer rows and get no rate.
async function fetchLatestRates(currencies: Array<string>): Promise<Record<string, number>> {
  const latest: Record<string, number> = {};
  await Promise.all(
    currencies.map(async (currency) => {
      const { data, error } = await supabase
        .from("fx_rates")
        .select("rate_to_eur")
        .eq("currency", currency)
        .order("date", { ascending: false })
        .limit(1);
      if (error) throw error;
      const row = data?.[0];
      if (row) latest[currency] = row.rate_to_eur;
    }),
  );
  return latest;
}

/** Stored Splitwise balances plus a euro rate lookup for their currencies. */
export function useSplitwiseBalances() {
  const balances = useQuery({ queryKey: ["splitwise-balances"], queryFn: fetchBalances });
  const currencies = useMemo(
    () => [...new Set((balances.data ?? []).map((b) => b.currency))].filter((c) => c !== "EUR"),
    [balances.data],
  );
  const rates = useQuery({
    queryKey: ["splitwise-balance-rates", currencies],
    queryFn: () => fetchLatestRates(currencies),
    enabled: balances.isSuccess,
    staleTime: 5 * 60_000,
  });
  const rate = useMemo(
    () => (currency: string) => (currency === "EUR" ? 1 : (rates.data?.[currency] ?? null)),
    [rates.data],
  );
  return { balances, rates, rate, rows: balances.data ?? [] };
}
