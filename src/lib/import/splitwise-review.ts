import type { BankMatch, BankTx } from "./splitwise-match";

// The review screen still imports these from here.
export { makeRate, type FxRow } from "@/lib/fx";

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

/** Matches that start ticked: only the sure ones. Doubtful ones wait for the user. */
export function defaultSelection(
  matches: Array<Pick<BankMatch, "row" | "confidence">>,
): Set<number> {
  return new Set(matches.filter((m) => m.confidence === "likely").map((m) => m.row));
}
