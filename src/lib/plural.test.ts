import { afterEach, describe, expect, it } from "vitest";
import { setLocaleOverride } from "@/lib/locale";
import { plural } from "./plural";

describe("plural", () => {
  it("counts transactions by default, singular only for exactly one", () => {
    expect([0, 1, 2].map((n) => plural(n))).toEqual([
      "0 transactions",
      "1 transaction",
      "2 transactions",
    ]);
  });

  it("takes another word", () => {
    expect([plural(1, "rule"), plural(3, "sell")]).toEqual(["1 rule", "3 sells"]);
  });

  describe("writes the count in the app's locale", () => {
    afterEach(() => setLocaleOverride(""));

    it("English groups thousands with a comma", () => {
      setLocaleOverride("en-GB");
      expect([plural(1334, "buy"), plural(2000, "trade"), plural(1, "trade")]).toEqual([
        "1,334 buys",
        "2,000 trades",
        "1 trade",
      ]);
    });

    it("Italian groups thousands with a dot, 4-digit counts too", () => {
      setLocaleOverride("it-IT");
      expect([plural(2000, "trade"), plural(666, "sell")]).toEqual(["2.000 trades", "666 sells"]);
    });
  });
});
