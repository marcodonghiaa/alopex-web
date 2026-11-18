import { addDays } from "@/lib/date";

// Exchange-rate lookups shared by the Splitwise review and the broker imports.

export interface FxRow {
  currency: string;
  date: string;
  rate_to_eur: number;
}

/** Rate for a currency on a date: the latest one on or before it. Euros are 1. */
/** `maxGapDays`: never use a rate older than this many days before the date asked for. */
export function makeRate(
  rows: Array<FxRow>,
  maxGapDays = Infinity,
): (currency: string, date: string) => number | null {
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
    const found = list[lo - 1];
    if (!found || (maxGapDays < Infinity && found.date < addDays(date, -maxGapDays))) return null;
    return found.rate_to_eur;
  };
}
