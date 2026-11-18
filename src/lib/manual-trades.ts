import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

type Kind = "stock" | "crypto";
export type ManualTrade = {
  kind: Kind;
  key: string;
  side: "buy" | "sell";
  trade_date: string;
  shares: number;
  price_eur: number;
  fee_eur: number;
  source: "Manual";
};

const trade = (
  kind: Kind,
  key: string,
  side: "buy" | "sell",
  date: string,
  shares: number,
  priceEur: number,
): ManualTrade => ({
  kind,
  key,
  side,
  trade_date: date,
  shares,
  price_eur: priceEur,
  fee_eur: 0,
  source: "Manual",
});

/**
 * A holding added by hand, as one buy: the return is measured from the day and price given.
 * Without it there are no trades behind the holding, so no return at all.
 */
export function addedTrade(input: {
  kind: Kind;
  key: string;
  quantity: number;
  boughtOn: string;
  priceEur: number;
}): ManualTrade {
  return trade(input.kind, input.key, "buy", input.boughtOn, input.quantity, input.priceEur);
}

/** An amount changed by hand, as a buy or a sale of the difference. Null when it didn't change. */
export function changeTrade(input: {
  kind: Kind;
  key: string;
  from: number;
  to: number;
  date: string;
  priceEur: number;
}): ManualTrade | null {
  const diff = input.to - input.from;
  if (Math.abs(diff) < 1e-12) return null;
  return trade(
    input.kind,
    input.key,
    diff > 0 ? "buy" : "sell",
    input.date,
    Math.abs(diff),
    input.priceEur,
  );
}

/** Today's price in euros: the latest snapshot's value per share or coin. Null when unpriced. */
export async function latestPriceEur(
  client: SupabaseClient<Database>,
  kind: Kind,
  key: string,
): Promise<number | null> {
  const { data } =
    kind === "stock"
      ? await client
          .from("portfolio_snapshots")
          .select("value_eur,value_native,price")
          .eq("isin", key)
          .order("snapshot_date", { ascending: false })
          .limit(1)
      : await client
          .from("crypto_snapshots")
          .select("value_eur,amount")
          .eq("asset_symbol", key)
          .order("snapshot_date", { ascending: false })
          .limit(1);
  const row = data?.[0] as
    | { value_eur: number | null; value_native?: number; price?: number; amount?: number }
    | undefined;
  if (row?.value_eur == null) return null;
  // Shares held = native value / price; per coin = the snapshot's amount.
  const units = kind === "stock" ? (row.value_native ?? 0) / (row.price ?? 0) : (row.amount ?? 0);
  return units > 0 ? row.value_eur / units : null;
}

/** Saves the trade as the signed-in user's. */
export async function recordTrade(client: SupabaseClient<Database>, t: ManualTrade): Promise<void> {
  const { data } = await client.auth.getUser();
  if (!data.user) throw new Error("You're signed out. Sign in and try again.");
  const { error } = await client.from("holding_trades").insert({ ...t, user_id: data.user.id });
  if (error) throw error;
}
