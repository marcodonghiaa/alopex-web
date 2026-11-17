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
// Enable Banking refused the app itself (its key), so every bank fails the same way.
const APP_REFUSED = new Set([
  "UNAUTHORIZED_IP",
  "UNAUTHORIZED_ACCESS",
  "AUTHORIZATION_NOT_PROVIDED",
  "HTTP_401",
  "HTTP_403",
]);
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
  if (APP_REFUSED.has(code)) return refusedMessage([bank]);
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
  const live = accounts.filter(
    (a) => a.sync_error && !(a.consent_valid_until && Date.parse(a.consent_valid_until) <= now),
  );
  const refused = [...new Set(live.filter((a) => APP_REFUSED.has(a.sync_error!)).map(bankOf))];
  const messages = new Set<string>(); // each message names its bank
  for (const a of live) {
    // One banner for the app key, where the first refused bank would be.
    if (APP_REFUSED.has(a.sync_error!)) {
      messages.add(refusedMessage(refused));
      continue;
    }
    const account = a.currency ? accountLabel(a.currency, a.iban) : undefined;
    const text = syncErrorMessage(a.sync_error!, bankOf(a), account);
    if (text) messages.add(text);
  }
  return [...messages];
}

function refusedMessage(banks: string[]): string {
  const names =
    banks.length > 1 ? `${banks.slice(0, -1).join(", ")} and ${banks[banks.length - 1]}` : banks[0];
  return `Enable Banking refused to sync ${names}: check in the Enable Banking control panel that your app is active, and that your Edge Function secrets ENABLE_BANKING_APP_ID and ENABLE_BANKING_PRIVATE_KEY belong to it.`;
}

// "your EUR account •••• 0002": a bank can hold several accounts in one currency.
function accountLabel(currency: string, iban?: string | null): string {
  return `your ${currency} account${iban ? ` •••• ${iban.slice(-4)}` : ""}`;
}
