import { describe, expect, it } from "vitest";
import { capitaliseName, cleanMerchantName } from "./merchant-name";
import cases from "./merchant-name.cases.json";

// Card statements read "Amazon Mark* E46na7fw3" or "Tst*zuckers Bagels & S": show the merchant instead.
describe("cleanMerchantName", () => {
  it.each(cases.clean)("%s -> %s", (raw, clean) => {
    expect(cleanMerchantName(raw)).toBe(clean);
  });

  // A name a person typed, or a plain one, comes back as it was.
  it.each(cases.keep)("leaves %s alone", (name) => expect(cleanMerchantName(name)).toBe(name));

  it("is stable: a cleaned name stays the same when cleaned again", () => {
    for (const [, clean] of cases.clean) expect(cleanMerchantName(clean)).toBe(clean);
  });

  it("never returns an empty name", () => {
    expect(cleanMerchantName("SQ *")).toBe("SQ");
    expect(cleanMerchantName("   ")).toBe("   ");
    expect(cleanMerchantName(null)).toBeNull();
    expect(cleanMerchantName(undefined)).toBeNull();
  });
});

// Bank text has no length limit: a long run of dashes must not stall the page.
it("cleans a 50k-character name in well under a second", () => {
  const start = performance.now();
  cleanMerchantName("-".repeat(50_000) + "x");
  cleanMerchantName(" -".repeat(25_000) + "x");
  cleanMerchantName("a".repeat(50_000));
  cleanMerchantName("PAYPAL *" + "A".repeat(50_000) + "1");
  cleanMerchantName("AMAZON" + " EUROPE".repeat(30) + "!");
  cleanMerchantName("AMAZON" + " MARKETPLACE".repeat(30) + "!");
  expect(performance.now() - start).toBeLessThan(100);
});

// Every name shown starts with a capital, from any source: bank sync, a file import, Splitwise, typed.
describe("capitaliseName", () => {
  it.each([
    ["netflix", "Netflix"],
    ["über eats", "Über eats"],
    ["(netflix)", "(Netflix)"],
    ["Netflix", "Netflix"],
    ["eBay", "eBay"],
    ["easyJet", "easyJet"],
    ["7eleven", "7eleven"],
    ["ßtudio", "ßtudio"],
    ["", ""],
    ["  ", "  "],
  ])("%s -> %s", (name, shown) => expect(capitaliseName(name)).toBe(shown));
});
