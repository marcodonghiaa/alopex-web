import { describe, expect, it } from "vitest";
import { cleanMerchantName } from "./merchant-name";

// iOS view board: card statements read "Tst*zuckers Bagels & S"; show the merchant instead.
describe("cleanMerchantName", () => {
  it.each([
    ["Tst*zuckers Bagels & S", "Zuckers Bagels"],
    ["Sq *veniero's", "Veniero's"],
    ["SQ *BLUE BOTTLE", "BLUE BOTTLE"],
    ["PAYPAL *SPOTIFY", "SPOTIFY"],
    ["SumUp  *Bar Roma", "Bar Roma"],
    ["Amazon Mark* Tg3ql5f23", "Amazon"],
    ["Amazon Reta* J802s1k23", "Amazon"],
    ["AMZN Mktp DE*2K4", "Amazon"],
    ["Mbta-550057141438", "Mbta"],
    ["Mta*nyct Paygo", "Mta"],
    ["UBER *TRIP HELP.UBER.COM", "UBER"],
  ])("%s -> %s", (raw, clean) => {
    expect(cleanMerchantName(raw)).toBe(clean);
  });

  // A name a person typed, or a plain one, comes back as it was.
  it.each(["Esselunga", "IKEA", "Boston Sail Loft", "Hotel 31", "Bar 2000", "7-Eleven", "Café"])(
    "leaves %s alone",
    (name) => expect(cleanMerchantName(name)).toBe(name),
  );

  it("never returns an empty name", () => {
    expect(cleanMerchantName("SQ *")).toBe("SQ *");
    expect(cleanMerchantName(null)).toBeNull();
  });
});
