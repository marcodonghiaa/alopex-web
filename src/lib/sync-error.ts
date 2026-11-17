import { bankOf } from "@/components/bank-badge";
import { formatDay } from "@/lib/date";

// Why a bank stopped updating, from accounts.sync_error (what the last sync-bank run hit: Enable
// Banking's error name, or HTTP_<status> / TIMEOUT / NETWORK / SAVE_FAILED). Cleared by the next
// good run. An ended consent is left to the Renew banner, which already says it.

export interface SyncErrorAccount {
  label: string | null;
  bank_name?: string | null;
  // Absent on a database without the bank-sync-health migration.
  sync_error?: string | null;
  sync_error_at?: string | null;
}

export interface SyncAlert {
  bank: string;
  message: string;
}

const CONSENT_ENDED = new Set(["EXPIRED_SESSION", "REVOKED_SESSION", "CLOSED_SESSION"]);
const RETRY = "Alopex tries again at the next sync, every 6 hours.";

export function syncErrorMessage(code: string, bank: string): string | null {
  if (CONSENT_ENDED.has(code)) return null;
  if (code === "ASPSP_RATE_LIMIT_EXCEEDED") {
    return `${bank} limits automatic updates (often 4 a day) and refused the last one. ${RETRY}`;
  }
  if (
    code === "ASPSP_ACCOUNT_NOT_ACCESSIBLE" ||
    code === "ACCOUNT_DOES_NOT_EXIST" ||
    code === "HTTP_404"
  ) {
    return `${bank} no longer shares this account. Connect ${bank} again and pick it.`;
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
    return `${bank} synced, but the transactions couldn't be saved. ${RETRY}`;
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

// One alert per bank and message, in the order the accounts come; the date is when it began.
export function syncAlerts(accounts: Array<SyncErrorAccount>): Array<SyncAlert> {
  const seen = new Map<string, SyncAlert>();
  for (const a of accounts) {
    if (!a.sync_error) continue;
    const bank = bankOf(a);
    const text = syncErrorMessage(a.sync_error, bank);
    if (!text) continue;
    const key = `${bank}\n${text}`;
    if (seen.has(key)) continue;
    const since = a.sync_error_at
      ? ` Not updated since ${formatDay(a.sync_error_at.slice(0, 10))}.`
      : "";
    seen.set(key, { bank, message: `${text}${since}` });
  }
  return [...seen.values()];
}
