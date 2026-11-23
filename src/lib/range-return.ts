import type { EventRow } from "@/lib/investment-events";
import type { Trade } from "@/lib/trades";

type Point = { date: string; value: number };

const DAY_MS = 86_400_000;
const days = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / DAY_MS;

type CostedTrade = Pick<
  Trade,
  "side" | "trade_date" | "shares" | "price_eur" | "fee_eur" | "tax_eur"
>;

/**
 * The gain over a range with the money you put in or took out removed (modified Dietz): a buy
 * adds cash (price plus fee and tax), a sale takes it out (net of fee and tax), as the all-time
 * return counts them. What your holdings paid you inside the range (`income`: dividends,
 * interest, after tax) is gained. Trades and income on the first day are already in the start.
 * `percent` is null when nothing was invested.
 */
export function rangeReturn(
  start: Point,
  end: Point,
  trades: Array<CostedTrade>,
  income: Array<Pick<EventRow, "event_date" | "amount_eur">> = [],
) {
  const span = days(start.date, end.date);
  let flow = 0;
  let weighted = 0;
  for (const t of trades) {
    if (t.trade_date <= start.date || t.trade_date > end.date) continue;
    const costs = t.fee_eur + (t.tax_eur ?? 0);
    const cash =
      t.side === "buy" ? t.shares * t.price_eur + costs : -(t.shares * t.price_eur - costs);
    flow += cash;
    weighted += span > 0 ? (cash * days(t.trade_date, end.date)) / span : 0;
  }
  const paid = income
    .filter((e) => e.event_date > start.date && e.event_date <= end.date)
    .reduce((sum, e) => sum + e.amount_eur, 0);
  const gain = end.value - start.value - flow + paid;
  const base = start.value + weighted;
  return { gain, percent: base > 0 ? gain / base : null };
}

type PricedTrade = Pick<Trade, "key" | "side" | "trade_date" | "shares" | "price_eur">;

/**
 * What your trades held on `date`, valued at that day's price per holding. A holding with no
 * price that day (sold since, so no longer priced) takes its nearest trade's price: the last one
 * on or before the day, else the first after. Holdings without trades are left out on purpose:
 * their money moving in or out can't be told apart from a gain or a loss.
 */
export function tradedValue(
  trades: Array<PricedTrade>,
  date: string,
  prices: Map<string, number>,
): number {
  const byKey = new Map<string, Array<PricedTrade>>();
  for (const t of trades) byKey.set(t.key, [...(byKey.get(t.key) ?? []), t]);
  let total = 0;
  for (const [key, list] of byKey) {
    const upTo = list.filter((t) => t.trade_date <= date);
    const shares = upTo.reduce((s, t) => s + (t.side === "buy" ? t.shares : -t.shares), 0);
    if (Math.abs(shares) < 1e-9) continue;
    const sorted = [...list].sort((a, b) => a.trade_date.localeCompare(b.trade_date));
    const nearest = upTo.length ? sorted[upTo.length - 1]! : sorted[0]!;
    total += shares * (prices.get(key) ?? nearest.price_eur);
  }
  return total;
}

/** Up to `n` evenly spaced indices into a list of `length`, always its first and last. */
export function sampleIndices(length: number, n: number): Array<number> {
  if (length <= n) return Array.from({ length }, (_, i) => i);
  return Array.from({ length: n }, (_, i) => Math.round((i * (length - 1)) / (n - 1)));
}

/**
 * The Return line: the gain from the first day to each day, of what your trades held, valued at
 * that day's prices, with buys and sales in between taken out. The same sum as the range chip.
 */
export function returnLine(
  trades: Array<PricedTrade & CostedTrade>,
  days: Array<{ date: string; prices: Map<string, number> }>,
  income: Array<Pick<EventRow, "event_date" | "amount_eur">> = [],
): Array<number> {
  const first = days[0];
  if (first == null) return [];
  const start = { date: first.date, value: tradedValue(trades, first.date, first.prices) };
  return days.map(
    (d) =>
      rangeReturn(
        start,
        { date: d.date, value: tradedValue(trades, d.date, d.prices) },
        trades,
        income,
      ).gain,
  );
}
