import { bankOf } from "@/components/bank-badge";

// Why a bank stopped updating, from accounts.sync_error (what the last sync-bank run hit: Enable
// Banking's error name, or HTTP_<status> / TIMEOUT / NETWORK / SAVE_FAILED). Cleared by the next
// good run. An ended consent is left to the Renew banner, which already says it.

export interface SyncErrorAccount {
  label: string | null;
  bank_name?: string | null;
  currency?: string;
  iban?: string | null;
  // Absent on a database without the bank-sync-health migration.
  sync_error?: string | null;
  consent_valid_until?: string | null;
}

const CONSENT_ENDED = new Set(["EXPIRED_SESSION", "REVOKED_SESSION", "CLOSED_SESSION"]);
const RETRY = "Nothing to do: Alopex tries again at the next sync, within 6 hours.";

// `account` names the account when the bank stopped sharing one of several.
export function syncErrorMessage(
  code: string,
  bank: string,
  account = "this account",
): string | null {
  if (CONSENT_ENDED.has(code)) return null;
  if (code === "ASPSP_RATE_LIMIT_EXCEEDED") {
    return `${bank} limits automatic updates and refused the last one. ${RETRY}`;
  }
  if (
    code === "ASPSP_ACCOUNT_NOT_ACCESSIBLE" ||
    code === "ACCOUNT_DOES_NOT_EXIST" ||
    code === "HTTP_404"
  ) {
    return `${bank} no longer shares ${account}. Connect ${bank} again and include it when the bank asks which accounts to share.`;
  }
  if (
    code === "UNAUTHORIZED_IP" ||
    code === "UNAUTHORIZED_ACCESS" ||
    code === "AUTHORIZATION_NOT_PROVIDED" ||
    code === "HTTP_401" ||
    code === "HTTP_403"
  ) {
    return `Enable Banking refused to sync ${bank}: check that your Enable Banking app is active and that its key in your setup is the right one.`;
  }
  if (code === "SAVE_FAILED")
    return `${bank} synced, but the transactions couldn't be saved. ${RETRY} If it keeps happening, check the sync-bank function's logs in Supabase.`;
  if (
    code === "ASPSP_ERROR" ||
    code === "ASPSP_TIMEOUT" ||
    code === "TIMEOUT" ||
    code === "NETWORK" ||
    /^HTTP_5\d\d$/.test(code)
  ) {
    return `${bank} didn't answer the last sync. ${RETRY}`;
  }
  return `The last sync of ${bank} failed (${code}). ${RETRY}`;
}

// One alert per bank and message, in the order the accounts come. No date: the account row
// already shows its last real update.
// A consent that has run out is skipped: the cron no longer syncs it, so its last error never
// clears, and the Renew banner already says what to do.
export function syncAlerts(accounts: Array<SyncErrorAccount>, now = Date.now()): string[] {
  const messages = new Set<string>(); // each message names its bank
  for (const a of accounts) {
    if (!a.sync_error) continue;
    if (a.consent_valid_until && Date.parse(a.consent_valid_until) <= now) continue;
    const account = a.currency ? accountLabel(a.currency, a.iban) : undefined;
    const text = syncErrorMessage(a.sync_error, bankOf(a), account);
    if (text) messages.add(text);
  }
  return [...messages];
}

// "your EUR account •••• 0002": a bank can hold several accounts in one currency.
function accountLabel(currency: string, iban?: string | null): string {
  return `your ${currency} account${iban ? ` •••• ${iban.slice(-4)}` : ""}`;
}
