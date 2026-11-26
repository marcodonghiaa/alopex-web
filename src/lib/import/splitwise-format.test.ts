import { describe, expect, it } from "vitest";
import { importedMessage, moneyFromCents, moneyAmount, shortDate } from "./splitwise-format";

// issue #12: the button said 61, the toast 70; the toast now says what the 70 are
describe("importedMessage", () => {
  it("says how many were paid by others and how many by you", () => {
    expect(importedMessage({ shares: 70, paidByYou: 9, group: "Trip" })).toBe(
      "70 expenses imported into Trip: 61 paid by others, 9 paid by you",
    );
    expect(importedMessage({ shares: 2, paidByYou: 1, group: "Trip" })).toBe(
      "2 expenses imported into Trip: 1 paid by others, 1 paid by you",
    );
  });

  it("names no split when all were paid by others, or it does not add up", () => {
    expect(importedMessage({ shares: 1, paidByYou: 0, group: "Trip" })).toBe(
      "1 expense imported into Trip",
    );
    expect(importedMessage({ shares: 3, paidByYou: 3, group: "Trip" })).toBe(
      "3 expenses imported into Trip, all paid by you",
    );
    expect(importedMessage({ shares: 2, paidByYou: 5, group: "Trip" })).toBe(
      "2 expenses imported into Trip",
    );
  });
});

describe("shortDate", () => {
  const today = new Date("2026-11-09T12:00:00Z");
  it("drops the year when it is this year", () => {
    expect(shortDate("2026-11-03", today)).toBe("3 Nov");
  });
  it("keeps the year for another year", () => {
    expect(shortDate("2025-12-31", today)).toBe("31 Dec 2025");
  });
  it("gives back text it cannot read as a date", () => {
    expect(shortDate("soon", today)).toBe("soon");
  });
});

describe("moneyFromCents", () => {
  it("shows cents with two decimals and the currency", () => {
    expect(moneyFromCents(2730, "USD")).toBe("US$27.30");
  });
});

describe("moneyAmount", () => {
  it("keeps a code Intl rejects as plain text instead of crashing", () => {
    expect(moneyAmount(1.5, "EURO")).toBe("1.50 EURO");
  });
});
