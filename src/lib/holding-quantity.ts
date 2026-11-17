import { supabase } from "@/integrations/supabase/client";

export type HoldingTarget =
  { kind: "stock"; isin: string } | { kind: "crypto"; symbol: string; source: string };

// set_holding_quantity also writes today's value from the latest price, so net worth moves at
// once (it is built from each holding's latest price snapshot). Before that backend migration
// (PGRST202) only the quantity changes, and net worth follows at the next price sync.
export async function saveQuantity(target: HoldingTarget, quantity: number): Promise<void> {
  const { error } = await supabase.rpc("set_holding_quantity", {
    p_kind: target.kind,
    p_key: target.kind === "stock" ? target.isin : target.symbol,
    p_quantity: quantity,
    p_source: target.kind === "crypto" ? target.source : null,
  });
  if (!error) return;
  if ((error as { code?: string }).code !== "PGRST202") throw error;
  const { error: fallback } =
    target.kind === "stock"
      ? await supabase
          .from("portfolio_holdings")
          .update({ shares: quantity })
          .eq("isin", target.isin)
      : await supabase
          .from("crypto_holdings")
          .update({ amount: quantity })
          .eq("asset_symbol", target.symbol)
          .eq("source", target.source);
  if (fallback) throw fallback;
}
