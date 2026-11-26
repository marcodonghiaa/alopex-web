import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import { invalidateHoldings } from "./holding-quantity";

const keysAfter = (run: (qc: QueryClient) => void) => {
  const qc = new QueryClient();
  const spy = vi.spyOn(qc, "invalidateQueries");
  run(qc);
  return spy.mock.calls.map(([f]) => f?.queryKey);
};

describe("invalidateHoldings", () => {
  it("refreshes a stock's list, net worth, returns and trades", () => {
    expect(keysAfter((qc) => invalidateHoldings(qc, "stock"))).toEqual([
      ["portfolio-latest"],
      ["net-worth-daily"],
      ["holding-performance"],
      ["holding-trades"],
    ]);
  });

  it("uses the crypto list for coins, and adds events when asked", () => {
    expect(keysAfter((qc) => invalidateHoldings(qc, "crypto", { events: true }))).toEqual([
      ["crypto-latest"],
      ["net-worth-daily"],
      ["holding-performance"],
      ["holding-trades"],
      ["investment-events"],
    ]);
  });
});
