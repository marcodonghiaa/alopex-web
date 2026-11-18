import { bankOf } from "@/components/bank-badge";
import { formatISODate } from "@/lib/date";

// Bank access (PSD2 consent) lasts 180 days. After that the bank stops syncing without any
// error the user can see, so the Accounts page warns from two weeks before.
const WARN_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ConsentAccount {
  label: string | null;
  bank_name?: string | null;
  consent_valid_until: string | null;
}

export interface ConsentAlert {
  bank: string;
  daysLeft: number; // 0: ends today; below 0: already expired
}

// One alert per bank (all of a bank's accounts share one consent), soonest first.
export function consentAlerts(accounts: Array<ConsentAccount>, today: Date): Array<ConsentAlert> {
  const todayUtc = Date.parse(formatISODate(today));
  const soonest = new Map<string, number>();
  for (const a of accounts) {
    if (!a.consent_valid_until) continue;
    let daysLeft = Math.round((Date.parse(a.consent_valid_until.slice(0, 10)) - todayUtc) / DAY_MS);
    // An end time already past (a revoked or closed consent ends at today 00:00): expired, not
    // "ends today". A bare date has no time, so it still runs to the end of that day.
    const hasTime = a.consent_valid_until.length > 10;
    if (hasTime && Date.parse(a.consent_valid_until) <= today.getTime()) {
      daysLeft = Math.min(daysLeft, -1);
    }
    if (daysLeft > WARN_DAYS) continue;
    const bank = bankOf(a);
    soonest.set(bank, Math.min(daysLeft, soonest.get(bank) ?? Infinity));
  }
  return [...soonest]
    .map(([bank, daysLeft]) => ({ bank, daysLeft }))
    .sort((x, y) => x.daysLeft - y.daysLeft);
}
