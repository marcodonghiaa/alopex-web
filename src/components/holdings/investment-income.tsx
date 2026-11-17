import { GroupedList, SectionTitle } from "@/components/ui/grouped-list";
import { summarizeIncome } from "@/lib/investment-events";
import type { IncomeSummary, InvestmentEvent } from "@/lib/investment-events";
import { formatEur } from "@/lib/transactions";

const ROWS: Array<{ label: string; field: keyof IncomeSummary; cost?: boolean }> = [
  { label: "Dividends", field: "dividends" },
  { label: "Interest", field: "interest" },
  { label: "Rewards", field: "rewards" },
  { label: "Taxes", field: "taxes", cost: true },
  { label: "Fees", field: "fees", cost: true },
];

/** Events for this page: coins' on Crypto, everything else (shares and cash) on Portfolio. */
export function eventsForPage(events: Array<InvestmentEvent>, page: "stock" | "crypto") {
  return events.filter((e) => (e.asset_kind === "crypto") === (page === "crypto"));
}

/**
 * What your investments paid you and what they cost, this year and in all: from imported broker
 * files (dividends, interest, rewards, taxes, fees). Hidden until there's something to show.
 */
export function InvestmentIncome({
  events,
  page,
  today = new Date().toISOString().slice(0, 10),
}: {
  events: Array<InvestmentEvent>;
  page: "stock" | "crypto";
  today?: string;
}) {
  const mine = eventsForPage(events, page);
  const all = summarizeIncome(mine);
  const year = summarizeIncome(mine, `${today.slice(0, 4)}-01-01`);
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
