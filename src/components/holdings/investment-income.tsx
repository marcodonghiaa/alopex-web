import { GroupedList, SectionTitle } from "@/components/ui/grouped-list";
import { summarizeIncome } from "@/lib/investment-events";
import type { EventRow, IncomeSummary } from "@/lib/investment-events";
import { localToday } from "@/lib/trades";
import type { Trade } from "@/lib/trades";
import { formatEur } from "@/lib/transactions";

type TradeCost = Pick<Trade, "trade_date" | "fee_eur" | "tax_eur">;

/** Income and costs from `from` on: the events', plus the fees and taxes paid on trades. */
export function incomeAndCosts(
  events: Array<EventRow>,
  trades: Array<TradeCost>,
  from = "",
): IncomeSummary {
  const out = summarizeIncome(events, from);
  for (const t of trades) {
    if (t.trade_date < from) continue;
    out.fees += t.fee_eur ?? 0;
    out.taxes += t.tax_eur ?? 0;
  }
  return out;
}

/** The rows of income and costs, here and in the import preview. A cost is shown as money out. */
const INCOME_ROWS: Array<{ label: string; field: keyof IncomeSummary; cost?: boolean }> = [
  { label: "Dividends", field: "dividends" },
  { label: "Interest", field: "interest" },
  { label: "Rewards", field: "rewards" },
  { label: "Taxes", field: "taxes", cost: true },
  { label: "Fees", field: "fees", cost: true },
];

/** A row's amount as shown: a cost as money out, and under half a cent (rounding dust) as 0, not "−€0.00". */
function incomeValue(summary: IncomeSummary, r: (typeof INCOME_ROWS)[number]) {
  const v = r.cost ? -summary[r.field] : summary[r.field];
  return Math.abs(v) < 0.005 ? 0 : v;
}

/** An amount as income and costs show it: money out with a true minus, like formatSignedEur. */
export const formatIncome = (v: number) => (v < 0 ? `−${formatEur(-v)}` : formatEur(v));

/** The rows with something to show, each with its amount. */
export function incomeRows(summary: IncomeSummary) {
  return INCOME_ROWS.map((r) => ({ ...r, value: incomeValue(summary, r) })).filter(
    (r) => r.value !== 0,
  );
}

/** Events for this page: coins' on Crypto, everything else (shares and cash) on Portfolio. */
export function eventsForPage(events: Array<EventRow>, page: "stock" | "crypto") {
  return events.filter((e) => (e.asset_kind === "crypto") === (page === "crypto"));
}

/**
 * What your investments paid you and what they cost, this year and in all: dividends, interest
 * and rewards from imported broker files, and taxes and fees on their own or on trades. Hidden
 * until there's something to show.
 */
export function InvestmentIncome({
  events,
  trades = [],
  page,
  today = localToday(),
}: {
  events: Array<EventRow>;
  trades?: Array<TradeCost>;
  page: "stock" | "crypto";
  today?: string;
}) {
  const mine = eventsForPage(events, page);
  const all = incomeAndCosts(mine, trades);
  const year = incomeAndCosts(mine, trades, `${today.slice(0, 4)}-01-01`);
  const rows = incomeRows(all);
  if (rows.length === 0) return null;
  return (
    <section aria-label="Income and costs" className="mb-6">
      <SectionTitle>Income and costs</SectionTitle>
      <GroupedList>
        {/* One table: the columns line up row to row, and a screen reader names each amount's column. */}
        <table aria-label="Income and costs" className="w-full border-collapse text-[0.9375rem]">
          <thead className="text-xs text-muted-foreground">
            <tr>
              <td className="py-2 pl-4" />
              <th scope="col" className="py-2 pl-6 text-right font-normal">
                This year
              </th>
              <th scope="col" className="py-2 pr-4 pl-6 text-right font-normal">
                All time
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.field} className="h-11 border-t border-hairline">
                <th scope="row" className="pl-4 text-left font-normal text-foreground">
                  {r.label}
                </th>
                <td className="pl-6 text-right font-figure whitespace-nowrap">
                  {formatIncome(incomeValue(year, r))}
                </td>
                <td className="pr-4 pl-6 text-right font-figure whitespace-nowrap">
                  {formatIncome(r.value)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </GroupedList>
      <p className="mt-2 px-4 text-xs text-muted-foreground">
        Taxes and fees not tied to a holding, like stamp duty, count here but not in any holding's
        return.
      </p>
    </section>
  );
}
