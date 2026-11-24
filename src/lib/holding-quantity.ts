import { supabase } from "@/integrations/supabase/client";

export type HoldingTarget =
  { kind: "stock"; isin: string } | { kind: "crypto"; symbol: string; source: string };

// set_holding_quantity also writes today's value from the latest price, so net worth moves at
// once (it is built from each holding's latest price snapshot).
export async function saveQuantity(target: HoldingTarget, quantity: number): Promise<void> {
  const { error } = await supabase.rpc("set_holding_quantity", {
    p_kind: target.kind,
    p_key: target.kind === "stock" ? target.isin : target.symbol,
    p_quantity: quantity,
    p_source: target.kind === "crypto" ? target.source : null,
  });
  if (error) throw error;
}
