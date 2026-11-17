import { describe, expect, it } from "vitest";
import { syncAlerts, syncErrorMessage } from "./sync-error";

const acc = (
  bank_name: string,
  sync_error: string | null,
  sync_error_at: string | null = null,
) => ({
  label: `${bank_name} EUR`,
  bank_name,
  sync_error,
  sync_error_at,
});

describe("syncErrorMessage", () => {
  it("leaves an ended consent to the Renew banner", () => {
    for (const code of ["EXPIRED_SESSION", "REVOKED_SESSION", "CLOSED_SESSION"]) {
      expect(syncErrorMessage(code, "Fineco")).toBeNull();
    }
  });

  it("explains the bank's daily limit", () => {
    expect(syncErrorMessage("ASPSP_RATE_LIMIT_EXCEEDED", "Fineco")).toMatch(
      /Fineco limits automatic updates/,
    );
  });

  it("says the bank didn't answer for bank, timeout, network and 5xx failures", () => {
    for (const code of [
      "ASPSP_ERROR",
      "ASPSP_TIMEOUT",
      "TIMEOUT",
      "NETWORK",
      "HTTP_500",
      "HTTP_503",
    ]) {
      expect(syncErrorMessage(code, "N26")).toMatch(/^N26 didn't answer the last sync/);
    }
  });

  it("asks to connect again when the bank stops sharing the account", () => {
    for (const code of ["ASPSP_ACCOUNT_NOT_ACCESSIBLE", "ACCOUNT_DOES_NOT_EXIST", "HTTP_404"]) {
      expect(syncErrorMessage(code, "N26")).toMatch(/no longer shares this account/);
    }
  });

  it("points a refused app at the Enable Banking setup", () => {
    for (const code of [
      "UNAUTHORIZED_IP",
      "UNAUTHORIZED_ACCESS",
      "AUTHORIZATION_NOT_PROVIDED",
      "HTTP_401",
      "HTTP_403",
    ]) {
      expect(syncErrorMessage(code, "N26")).toMatch(/Enable Banking refused to sync N26/);
    }
  });

  it("says a failed save apart from a bank failure", () => {
    expect(syncErrorMessage("SAVE_FAILED", "N26")).toMatch(/couldn't be saved/);
  });

  it("names an unknown code instead of hiding it", () => {
    expect(syncErrorMessage("WRONG_CONTINUATION_KEY", "N26")).toMatch(
      /failed \(WRONG_CONTINUATION_KEY\)/,
    );
  });
});

describe("syncAlerts", () => {
  it("lists nothing when every sync went through, or on an older database", () => {
    expect(syncAlerts([acc("Fineco", null), { label: "Cash" }])).toEqual([]);
  });

  it("shows one alert per bank and message, with the day it began", () => {
    const alerts = syncAlerts([
      acc("Fineco", "ASPSP_TIMEOUT", "2026-11-15T06:17:00Z"),
      acc("Fineco", "ASPSP_TIMEOUT", "2026-11-15T06:17:00Z"),
      acc("N26", "ASPSP_RATE_LIMIT_EXCEEDED"),
    ]);
    expect(alerts.map((a) => a.bank)).toEqual(["Fineco", "N26"]);
    expect(alerts[0]?.message).toMatch(/Not updated since .*2026/);
    expect(alerts[1]?.message).not.toMatch(/Not updated since/);
  });

  it("skips ended consents", () => {
    expect(syncAlerts([acc("Fineco", "REVOKED_SESSION")])).toEqual([]);
  });
});
