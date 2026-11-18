import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// polish-4 N8: on a phone the holdings list (the everyday task) dropped below Income and costs.
// fails_when=Income and costs renders before the holdings list on Portfolio or Crypto
describe("Income and costs placement", () => {
  it.each(["portfolio", "crypto"])(
    "on %s it sits under the holdings, after Import trades",
    (page) => {
      const src = readFileSync(join(import.meta.dirname, `${page}.tsx`), "utf8");
      const income = src.indexOf("<InvestmentIncome");
      expect(income).toBeGreaterThan(src.indexOf("<TradesImport"));
      expect(income).toBeLessThan(src.indexOf("<SoldHoldings"));
    },
  );
});
