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
