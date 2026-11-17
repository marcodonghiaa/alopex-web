import { describe, expect, it } from "vitest";
import type { Database } from "@/integrations/supabase/types";
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

  it("shows one alert per bank and message", () => {
    const alerts = syncAlerts([
      acc("Fineco", "ASPSP_TIMEOUT", "2026-11-15T06:17:00Z"),
      acc("Fineco", "ASPSP_TIMEOUT", "2026-11-15T06:17:00Z"),
      acc("N26", "ASPSP_RATE_LIMIT_EXCEEDED"),
    ]);
    expect(alerts).toEqual([
      "Fineco didn't answer the last sync. Alopex tries again at the next sync, every 6 hours.",
      "N26 limits automatic updates (often 4 a day) and refused the last one. Alopex tries again at the next sync, every 6 hours.",
    ]);
  });

  // The error's time is not the last good update (it moves when the code changes, and a failed
  // save still updated the balance); the account row already shows the real one.
  it("never adds a date, so no time zone can show the wrong day", () => {
    expect(syncAlerts([acc("Fineco", "ASPSP_TIMEOUT", "2026-11-15T00:17:00Z")])).toEqual([
      "Fineco didn't answer the last sync. Alopex tries again at the next sync, every 6 hours.",
    ]);
  });

  it("skips ended consents", () => {
    expect(syncAlerts([acc("Fineco", "REVOKED_SESSION")])).toEqual([]);
  });

  // The cron stops syncing an ended consent, so its last error never clears: the Renew banner
  // already covers it, and "tries again" would not be true.
  it("hides the error of a consent that has run out, keeps one still valid", () => {
    const now = Date.parse("2026-11-17T12:00:00Z");
    const ended = {
      ...acc("Fineco", "ASPSP_TIMEOUT"),
      consent_valid_until: "2026-11-17T00:00:00+00:00",
    };
    const valid = {
      ...acc("N26", "ASPSP_TIMEOUT"),
      consent_valid_until: "2026-11-18T00:00:00+00:00",
    };
    expect(syncAlerts([ended, valid], now)).toEqual([syncErrorMessage("ASPSP_TIMEOUT", "N26")]);
  });

  it("names which account a bank stopped sharing", () => {
    const eur = { ...acc("N26", "ASPSP_ACCOUNT_NOT_ACCESSIBLE"), currency: "EUR" };
    const usd = { ...acc("N26", "HTTP_404"), currency: "USD" };
    expect(syncAlerts([eur, usd])).toEqual([
      "N26 no longer shares N26 EUR. Connect N26 again and pick it.",
      "N26 no longer shares N26 USD. Connect N26 again and pick it.",
    ]);
  });

  it("keeps two different problems of the same bank", () => {
    expect(syncAlerts([acc("N26", "ASPSP_TIMEOUT"), acc("N26", "SAVE_FAILED")])).toHaveLength(2);
  });

  it("names a 4xx it does not know instead of calling it a bank outage", () => {
    expect(syncErrorMessage("HTTP_400", "N26")).toMatch(/failed \(HTTP_400\)/);
  });
});

// Checked by tsc: the hand-kept DB types carry the columns the bank-sync-health migration adds.
type Pub = Database["public"];
describe("database types", () => {
  it("list the sync columns on accounts and its Accounts view", () => {
    const cols = { sync_error: "TIMEOUT", sync_error_at: "2026-11-15T06:17:00Z" };
    const row: Pick<Pub["Tables"]["accounts"]["Row"], "sync_error" | "sync_error_at"> = cols;
    const update: Pick<Pub["Tables"]["accounts"]["Update"], "sync_error" | "sync_error_at"> = cols;
    const view: Pick<
      Pub["Views"]["v_bank_accounts_latest"]["Row"],
      "sync_error" | "sync_error_at"
    > = cols;
    expect([row, update, view]).toEqual([cols, cols, cols]);
  });
});
