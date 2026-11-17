import type { Trade } from "@/lib/trades";

type Point = { date: string; value: number };

const DAY_MS = 86_400_000;
const days = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / DAY_MS;

/**
 * The gain over a range with the money you put in or took out removed (modified Dietz): a buy
 * adds cash (price plus fee), a sale takes it out (net of fee). Trades on the first day are
 * already in the start value. `percent` is null when nothing was invested.
 */
export function rangeReturn(
  start: Point,
  end: Point,
  trades: Array<Pick<Trade, "side" | "trade_date" | "shares" | "price_eur" | "fee_eur">>,
) {
  const span = days(start.date, end.date);
  let flow = 0;
  let weighted = 0;
  for (const t of trades) {
    if (t.trade_date <= start.date || t.trade_date > end.date) continue;
    const cash =
      t.side === "buy" ? t.shares * t.price_eur + t.fee_eur : -(t.shares * t.price_eur - t.fee_eur);
    flow += cash;
    weighted += span > 0 ? (cash * days(t.trade_date, end.date)) / span : 0;
  }
  const gain = end.value - start.value - flow;
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
