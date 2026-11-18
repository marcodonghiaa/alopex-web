import { describe, expect, it } from "vitest";
import { consentAlerts } from "./consent-expiry";

const TODAY = new Date("2026-10-23T09:00:00");
const acc = (label: string, consent_valid_until: string | null) => ({ label, consent_valid_until });

describe("consentAlerts", () => {
  it("lists a bank whose consent ends within 14 days, with the days left", () => {
    expect(consentAlerts([acc("Revolut EUR", "2026-10-28T00:00:00Z")], TODAY)).toEqual([
      { bank: "Revolut", daysLeft: 5 },
    ]);
  });

  it("ignores consents further out, and accounts with no consent date", () => {
    expect(
      consentAlerts([acc("Revolut EUR", "2027-01-01T00:00:00Z"), acc("Cash", null)], TODAY),
    ).toEqual([]);
  });

  it("reports an expired consent with zero or negative days", () => {
    expect(consentAlerts([acc("Fineco", "2026-10-20T00:00:00Z")], TODAY)).toEqual([
      { bank: "Fineco", daysLeft: -3 },
    ]);
  });

  // Polish 5 A2: a revoked or closed consent is ended by the sync at today 00:00 UTC; the bank
  // already refuses it, so it must read "expired", not "ends today".
  it("treats a consent whose end time has passed today as expired", () => {
    const now = new Date("2026-10-23T09:00:00Z");
    expect(consentAlerts([acc("Revolut EUR", "2026-10-23T00:00:00+00:00")], now)).toEqual([
      { bank: "Revolut", daysLeft: -1 },
    ]);
  });

  it("keeps a bare date running to the end of that day", () => {
    const now = new Date("2026-10-23T09:00:00Z");
    expect(consentAlerts([acc("Revolut EUR", "2026-10-23")], now)).toEqual([
      { bank: "Revolut", daysLeft: 0 },
    ]);
  });

  it("still says today when the consent ends later today", () => {
    const now = new Date("2026-10-23T09:00:00Z");
    expect(consentAlerts([acc("Revolut EUR", "2026-10-23T18:00:00Z")], now)).toEqual([
      { bank: "Revolut", daysLeft: 0 },
    ]);
  });

  it("shows one alert per bank, using its soonest expiry, soonest bank first", () => {
    const alerts = consentAlerts(
      [
        acc("Revolut EUR", "2026-11-01T00:00:00Z"),
        acc("Revolut GBP", "2026-10-30T00:00:00Z"),
        acc("Fineco", "2026-10-25T00:00:00Z"),
      ],
      TODAY,
    );
    expect(alerts).toEqual([
      { bank: "Fineco", daysLeft: 2 },
      { bank: "Revolut", daysLeft: 7 },
    ]);
  });

  it("groups accounts of one bank under its stored name, whatever their holder labels", () => {
    const alerts = consentAlerts(
      [
        { ...acc("Marco D'Onghia", "2026-10-30T00:00:00Z"), bank_name: "Revolut" },
        { ...acc("D'ONGHIA MARCO", "2026-10-24T00:00:00Z"), bank_name: "Revolut" },
      ],
      TODAY,
    );
    expect(alerts).toEqual([{ bank: "Revolut", daysLeft: 1 }]);
  });
});
