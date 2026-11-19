import { describe, expect, it } from "vitest";
import { cleanMerchantName } from "./merchant-name";
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
