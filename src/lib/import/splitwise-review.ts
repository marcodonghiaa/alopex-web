import type { BankMatch, BankTx, RateToEur } from "./splitwise-match";

// Small pure helpers for the Splitwise review screen: they turn database rows into what the
// matcher and the planner expect.

export interface BankRowFromDb {
  account_uid: string | null;
  entry_reference: string;
  booking_date: string | null;
  amount: number;
  currency: string;
  credit_debit_indicator: string | null;
  personal_amount: number | null;
  flow_type: string | null;
  deleted_at: string | null;
  creditor_name?: string | null;
}

export interface FxRow {
  currency: string;
  date: string;
  rate_to_eur: number;
}

const cents = (euros: number) => Math.round(euros * 100);

/** A bank row as the matcher wants it, or null when it cannot be placed (deleted, no date...). */
export function toBankTx(r: BankRowFromDb): BankTx | null {
  const direction = r.credit_debit_indicator;
  if (r.deleted_at || !r.booking_date || !r.account_uid) return null;
  if (direction !== "DBIT" && direction !== "CRDT") return null;
  return {
    entryReference: r.entry_reference,
    accountUid: r.account_uid,
    bookingDate: r.booking_date,
    amountCents: cents(r.amount),
    currency: r.currency,
    direction,
    personalAmountCents: r.personal_amount === null ? null : cents(r.personal_amount),
    flowType: r.flow_type,
    name: r.creditor_name ?? null,
  };
}

/** Rate for a currency on a date: the latest one on or before it. Euros are 1. */
export function makeRate(rows: Array<FxRow>): RateToEur {
  // Sorted by date per currency, then a binary search per lookup (the To link page asks a lot).
  const byCurrency = new Map<string, Array<FxRow>>();
  for (const r of rows) {
    const list = byCurrency.get(r.currency);
    if (list) list.push(r);
    else byCurrency.set(r.currency, [r]);
  }
  for (const list of byCurrency.values()) list.sort((a, b) => a.date.localeCompare(b.date));
  return (currency, date) => {
    if (currency === "EUR") return 1;
    const list = byCurrency.get(currency) ?? [];
    let lo = 0;
    let hi = list.length; // first index with a date after `date`
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid]!.date <= date) lo = mid + 1;
      else hi = mid;
    }
    return list[lo - 1]?.rate_to_eur ?? null;
  };
}

/** Matches that start ticked: only the sure ones. Doubtful ones wait for the user. */
export function defaultSelection(
  matches: Array<Pick<BankMatch, "row" | "confidence">>,
): Set<number> {
  return new Set(matches.filter((m) => m.confidence === "likely").map((m) => m.row));
}
