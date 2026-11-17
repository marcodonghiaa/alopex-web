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
  const byCurrency = new Map<string, Array<FxRow>>();
  for (const r of [...rows].sort((a, b) => a.date.localeCompare(b.date))) {
    const list = byCurrency.get(r.currency);
    if (list) list.push(r);
    else byCurrency.set(r.currency, [r]);
  }
  return (currency, date) => {
    if (currency === "EUR") return 1;
    const list = byCurrency.get(currency) ?? [];
    const found = list.filter((r) => r.date <= date).at(-1);
    if (!found || (maxGapDays < Infinity && found.date < addDays(date, -maxGapDays))) return null;
    return found.rate_to_eur;
  };
}
