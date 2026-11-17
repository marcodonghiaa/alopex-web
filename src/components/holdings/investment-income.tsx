import { GroupedList, SectionTitle } from "@/components/ui/grouped-list";
import { summarizeIncome } from "@/lib/investment-events";
import type { EventRow, IncomeSummary } from "@/lib/investment-events";
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

const ROWS: Array<{ label: string; field: keyof IncomeSummary; cost?: boolean }> = [
  { label: "Dividends", field: "dividends" },
  { label: "Interest", field: "interest" },
  { label: "Rewards", field: "rewards" },
  { label: "Taxes", field: "taxes", cost: true },
  { label: "Fees", field: "fees", cost: true },
];

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
  today = new Date().toISOString().slice(0, 10),
}: {
  events: Array<EventRow>;
  trades?: Array<TradeCost>;
  page: "stock" | "crypto";
  today?: string;
}) {
  const mine = eventsForPage(events, page);
  const all = incomeAndCosts(mine, trades);
  const year = incomeAndCosts(mine, trades, `${today.slice(0, 4)}-01-01`);
  const rows = ROWS.filter((r) => all[r.field] !== 0);
  if (rows.length === 0) return null;
  const shown = (n: number, cost?: boolean) => formatEur(cost ? -n : n);
  return (
    <section aria-label="Income and costs" className="mb-6">
      <SectionTitle>Income and costs</SectionTitle>
      <GroupedList>
        <div className="grid grid-cols-[1fr_auto_auto] gap-x-6 px-4 py-2 text-xs text-muted-foreground">
          <span />
          <span className="text-right">This year</span>
          <span className="text-right">All time</span>
        </div>
        {rows.map((r) => (
          <div
            key={r.field}
            className="grid min-h-11 grid-cols-[1fr_auto_auto] items-center gap-x-6 px-4 text-[0.9375rem]"
          >
            <span className="text-foreground">{r.label}</span>
            <span className="text-right font-figure">{shown(year[r.field], r.cost)}</span>
            <span className="text-right font-figure">{shown(all[r.field], r.cost)}</span>
          </div>
        ))}
      </GroupedList>
    </section>
  );
}
