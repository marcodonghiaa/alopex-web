import { describe, expect, it } from "vitest";
import type { Database } from "@/integrations/supabase/types";
import { syncAlerts, syncErrorMessage } from "./sync-error";

const texts = (...args: Parameters<typeof syncAlerts>) => syncAlerts(...args).map((a) => a.text);

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
    // A save that keeps failing is on the self-hoster's side: say where to look.
    expect(syncErrorMessage("SAVE_FAILED", "N26")).toMatch(
      /If it keeps happening, check the sync-bank function's logs in Supabase\.$/,
    );
  });

  it("names an unknown code instead of hiding it", () => {
    expect(syncErrorMessage("WRONG_CONTINUATION_KEY", "N26")).toMatch(
      /failed \(WRONG_CONTINUATION_KEY\)/,
    );
  });
});

describe("syncAlerts", () => {
  it("lists nothing when every sync went through, or on an older database", () => {
    expect(texts([acc("Fineco", null), { label: "Cash" }])).toEqual([]);
  });

  it("shows one alert per bank and message", () => {
    const alerts = texts([
      acc("Fineco", "ASPSP_TIMEOUT", "2026-11-15T06:17:00Z"),
      acc("Fineco", "ASPSP_TIMEOUT", "2026-11-15T06:17:00Z"),
      acc("N26", "ASPSP_RATE_LIMIT_EXCEEDED"),
    ]);
    expect(alerts).toEqual([
      "Fineco didn't answer the last sync. Nothing to do: Alopex tries again at the next sync, within 6 hours.",
      "N26 limits automatic updates and refused the last one. Nothing to do: Alopex tries again at the next sync, within 6 hours.",
    ]);
  });

  // The error's time is not the last good update (it moves when the code changes, and a failed
  // save still updated the balance); the account row already shows the real one.
  it("never adds a date, so no time zone can show the wrong day", () => {
    expect(texts([acc("Fineco", "ASPSP_TIMEOUT", "2026-11-15T00:17:00Z")])).toEqual([
      "Fineco didn't answer the last sync. Nothing to do: Alopex tries again at the next sync, within 6 hours.",
    ]);
  });

  it("skips ended consents", () => {
    expect(texts([acc("Fineco", "REVOKED_SESSION")])).toEqual([]);
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
    expect(texts([ended, valid], now)).toEqual([syncErrorMessage("ASPSP_TIMEOUT", "N26")]);
  });

  it("names which account a bank stopped sharing, by currency and IBAN end", () => {
    const main = {
      ...acc("N26", "ASPSP_ACCOUNT_NOT_ACCESSIBLE"),
      currency: "EUR",
      iban: "DE89370400440532010001",
    };
    const savings = { ...acc("N26", "HTTP_404"), currency: "EUR", iban: "DE89370400440532010002" };
    const usd = { ...acc("N26", "HTTP_404"), currency: "USD", iban: null };
    const then = "Connect N26 again and include it when the bank asks which accounts to share.";
    expect(texts([main, savings, usd])).toEqual([
      `N26 no longer shares your EUR account •••• 0001. ${then}`,
      `N26 no longer shares your EUR account •••• 0002. ${then}`,
      `N26 no longer shares your USD account. ${then}`,
    ]);
  });

  it("keeps two different problems of the same bank", () => {
    expect(texts([acc("N26", "ASPSP_TIMEOUT"), acc("N26", "SAVE_FAILED")])).toHaveLength(2);
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
    const insert: Pick<Pub["Tables"]["accounts"]["Insert"], "sync_error" | "sync_error_at"> = cols;
    expect([row, update, insert, view]).toEqual([cols, cols, cols, cols]);
  });
});

describe("syncAlerts: Enable Banking refusing the app", () => {
  // The app key is shared by every bank: one banner naming them all, not one per bank.
  it("shows one banner for all banks and says where the key lives", () => {
    expect(
      texts([
        acc("Fineco", "HTTP_401"),
        acc("Revolut", "ASPSP_TIMEOUT"),
        acc("N26", "UNAUTHORIZED_IP"),
        acc("Bunq", "AUTHORIZATION_NOT_PROVIDED"),
      ]),
    ).toEqual([
      "Enable Banking refused to sync Fineco, N26 and Bunq: check in the Enable Banking control panel that your app is active, and that your Edge Function secrets ENABLE_BANKING_APP_ID and ENABLE_BANKING_PRIVATE_KEY belong to it.",
      "Revolut didn't answer the last sync. Nothing to do: Alopex tries again at the next sync, within 6 hours.",
    ]);
  });
});

describe("syncAlerts: what the user can do", () => {
  it("offers to connect again only when the bank stopped sharing an account", () => {
    const alerts = syncAlerts([
      { ...acc("N26", "ASPSP_ACCOUNT_NOT_ACCESSIBLE"), currency: "EUR" },
      acc("Fineco", "ASPSP_TIMEOUT"),
      acc("Bunq", "HTTP_401"),
    ]);
    expect(alerts.map((a) => [a.bank, a.reconnect])).toEqual([
      ["N26", true],
      ["Fineco", false],
      [null, false],
    ]);
  });
});
