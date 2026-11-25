import { createFileRoute, Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { dateLocale } from "@/lib/locale";
import {
  buildFlow,
  fetchImportedSpend,
  firstMonth,
  formatRate,
  importedOnlyMonths,
  incomeBySource,
  periodLabel,
  savedPhrase,
  periodRange,
  periodStart,
  shiftPeriod,
  shortPeriodLabel,
  switchPeriod,
  spendByCategory,
  summarize,
  trend,
  trimLeadingEmpty,
  trendEnd,
  type IncomeTxRow,
  type MonthlyCategoryRow,
  type MonthlyFlowRow,
  type Period,
} from "@/lib/cash-flow";
import { formatEur, monthFromParam, monthParam, parseTransactionsSearch } from "@/lib/transactions";
import { TONE_TEXT, toneOf } from "@/lib/tone";
import { FlowSankey } from "@/components/cash-flow/flow-sankey";
import { TrendBars } from "@/components/cash-flow/trend-bars";
import { EmptyState } from "@/components/empty-state";
import { HeadlineFigure } from "@/components/headline-figure";
import { Button } from "@/components/ui/button";
import { MonthSwitcher } from "@/components/month-switcher";
import { SegmentedControl } from "@/components/segmented-control";
import { Alert } from "@/components/ui/alert";
import { GroupedList, SectionTitle } from "@/components/ui/grouped-list";
import { Skeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/_authenticated/cash-flow")({
  head: () => ({
    meta: [
      { title: "Cash flow — Alopex" },
      {
        name: "description",
        content:
          "Where your money came from and went, by month, quarter or year, with your savings rate.",
      },
      { property: "og:title", content: "Cash flow — Alopex" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  // ?month=YYYY-MM: the month to open on (Reports links here with the month it shows).
  // ?period=quarter|year: the period shown (month when left out).
  validateSearch: (s: Record<string, unknown>): { month?: string; period?: Period } => {
    const { month } = parseTransactionsSearch(s);
    const period = s["period"] === "quarter" || s["period"] === "year" ? s["period"] : undefined;
    return { ...(month ? { month } : {}), ...(period ? { period } : {}) };
  },
  component: CashFlowPage,
});

const PERIODS: Array<{ value: Period; label: string }> = [
  { value: "month", label: "Month" },
  { value: "quarter", label: "Quarter" },
  { value: "year", label: "Year" },
];

/** Below 0.05% the rate shows as 0.0% (0.05% already rounds to 0.1%). */
const ZERO_RATE = 0.0005 - 1e-9;

/** Bars in the trend: a year of months, two years of quarters, five years. */
const TREND_COUNT: Record<Period, number> = { month: 12, quarter: 8, year: 5 };

async function fetchMonthlyFlow(): Promise<Array<MonthlyFlowRow>> {
  // One row per month with any activity, so the whole history is small.
  const { data, error } = await supabase
    .from("v_income_vs_expenses_monthly")
    .select("month,income_eur,expenses_eur")
    .order("month", { ascending: true });
  if (error) throw error;
  return (data ?? []) as Array<MonthlyFlowRow>;
}

async function fetchCategorySpend(from: string, to: string): Promise<Array<MonthlyCategoryRow>> {
  const { data, error } = await supabase
    .from("v_spend_by_category_monthly")
    .select("month,category,spend_eur")
    .gte("month", from)
    .lt("month", to);
  if (error) throw error;
  return (data ?? []) as Array<MonthlyCategoryRow>;
}

async function fetchIncomeRows(from: string, to: string): Promise<Array<IncomeTxRow>> {
  // Past the server's row cap the payers fall short of the total; the diagram shows the gap as
  // "Other income", so the figures never disagree.
  const { data, error } = await supabase
    .from("v_transactions_eur")
    .select("payer_name,creditor_name,category,personal_signed_amount_eur")
    .eq("flow_type", "income")
    .gt("personal_signed_amount_eur", 0)
    .gte("booking_date", from)
    .lt("booking_date", to)
    // Biggest first, so a cut-off list keeps the payers that matter.
    .order("personal_signed_amount_eur", { ascending: false });
  if (error) throw error;
  return (data ?? []) as Array<IncomeTxRow>;
}

function CashFlowPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  // The period and month live in the URL, so reload, Back and a link keep them.
  const urlPeriod = search.period ?? "month";
  const urlStart = periodStart(monthFromParam(search.month), urlPeriod);
  const urlKey = `${urlPeriod} ${monthParam(urlStart)}`;
  const [view, setView] = useState({ period: urlPeriod, start: urlStart });
  // Back, Forward or the sidebar link changed the URL: follow it.
  const [seen, setSeen] = useState(urlKey);
  if (seen !== urlKey) {
    setSeen(urlKey);
    setView({ period: urlPeriod, start: urlStart });
  }
  const { period, start } = view;
  const show = (nextStart: Date, nextPeriod: Period = period) => {
    setView({ period: nextPeriod, start: nextStart });
    void navigate({
      search: {
        month: monthParam(nextStart),
        ...(nextPeriod === "month" ? {} : { period: nextPeriod }),
      },
    });
  };
  const setStart = (next: Date) => show(next);
  const locale = dateLocale();

  const { from, to } = periodRange(start, period);
  const current = periodStart(new Date(), period);

  // One "cash-flow" prefix, so edits and imports refresh the page with one key.
  const monthlyQuery = useQuery({ queryKey: ["cash-flow", "monthly"], queryFn: fetchMonthlyFlow });
  const spendQuery = useQuery({
    queryKey: ["cash-flow", "spend", from, to],
    queryFn: () => fetchCategorySpend(from, to),
  });
  const incomeQuery = useQuery({
    queryKey: ["cash-flow", "income", from, to],
    queryFn: () => fetchIncomeRows(from, to),
  });
  const importedQuery = useQuery({
    queryKey: ["cash-flow", "imported"],
    queryFn: () => fetchImportedSpend(supabase),
  });
  const loadError = [monthlyQuery, spendQuery, incomeQuery, importedQuery].find(
    (q) => q.isError,
  )?.error;

  // A few months and categories: cheap enough to work out on every render.
  const monthly = monthlyQuery.data ?? [];
  // Months with only imported spending have no income on record: left out of what was saved.
  const importedOnly = importedOnlyMonths(
    monthly,
    importedQuery.data?.history ?? [],
    importedQuery.data?.bankSpend ?? [],
  );
  const summary = summarize(monthly, from, to, importedOnly);
  // Nothing but imported spending in the period: shown as spending, not as a loss.
  const onlyImported = summary.months === 0 && summary.imported > 0;
  const earliest = firstMonth(monthly);
  const canGoPrev = earliest != null && from > earliest;
  const canGoNext = start < current;

  const graph = buildFlow({
    income: summary.income,
    spending: onlyImported ? summary.importedSpending : summary.spending,
    sources: incomeBySource(incomeQuery.data ?? []),
    categories: spendByCategory(
      (spendQuery.data ?? []).filter((r) => onlyImported || !importedOnly.has(r.month ?? "")),
    ),
    imported: onlyImported,
  });

  const count = TREND_COUNT[period];
  const bars = trimLeadingEmpty(
    trend(monthly, period, trendEnd(start, current, period, count), count, importedOnly),
    from,
  );

  const label = periodLabel(start, period, locale);
  const pending = monthlyQuery.isPending;
  const rowLink = period === "month" ? monthParam(start) : undefined;
  // Without the totals every figure would read as a real €0 month: show dashes instead. A failed
  // refresh keeps what already loaded (the alert still says it failed).
  const failed = (q: { isError: boolean; data?: unknown }) => q.isError && q.data === undefined;
  const noTotals = failed(monthlyQuery);
  // Nothing recorded is not €0 either: dashes, as in the headline.
  const money = (value: number) => (noTotals || summary.months === 0 ? "—" : formatEur(value));
  const flowPending = pending || spendQuery.isPending || incomeQuery.isPending;

  function changePeriod(next: Period) {
    show(switchPeriod(start, period, next, new Date()), next);
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-8 md:py-12">
      <h1 className="sr-only">Cash flow for {label}</h1>

      {loadError && <Alert className="mb-6">Some figures didn't load: {loadError.message}</Alert>}

      {/* The title leads, as on every list screen; the period control sits beside it on desktop
          and under it on a phone, sized to its options. */}
      <div className="mb-6 flex flex-col gap-3 md:flex-row md:items-center md:gap-4">
        <MonthSwitcher
          className="md:flex-1"
          label={label}
          unit={period}
          onPrev={() => setStart(shiftPeriod(start, period, -1))}
          onNext={() => setStart(shiftPeriod(start, period, 1))}
          canGoPrev={canGoPrev}
          canGoNext={canGoNext}
        />
        <div className="md:w-64 md:shrink-0">
          <SegmentedControl
            label="Period"
            options={PERIODS}
            value={period}
            onChange={changePeriod}
          />
        </div>
      </div>

      <section aria-label={`Saved in ${label}`} className="mb-8">
        <p className="text-[0.9375rem] text-muted-foreground">
          {onlyImported ? "Spent" : summary.net < 0 ? "Spent more than came in" : "Saved"}
          {/* The period still running isn't a full month, quarter or year yet. */}
          {!canGoNext && " so far"}
        </p>
        <div className="mt-1">
          {pending ? (
            <Skeleton className="h-12 w-48" />
          ) : noTotals ? (
            <p className="figure-display text-muted-foreground">—</p>
          ) : onlyImported ? (
            <HeadlineFigure value={summary.importedSpending} currency="EUR" />
          ) : summary.months === 0 ? (
            // Nothing recorded is not a net of zero (as on Reports).
            <p className="figure-display text-muted-foreground">—</p>
          ) : (
            <HeadlineFigure value={summary.net} currency="EUR" />
          )}
        </div>
        {!pending && !noTotals && summary.imported > 0 && (
          <p className="mt-1.5 text-sm text-muted-foreground">
            {onlyImported
              ? "Imported spending only, no income recorded."
              : `Leaves out ${summary.imported} ${
                  summary.imported === 1 ? "month" : "months"
                } with only imported spending.`}
          </p>
        )}
        <p className="mt-1 text-xs text-muted-foreground">Excludes transfers.</p>
      </section>

      <GroupedList>
        <ul className="divide-y divide-hairline">
          {/* Income and Spending are month pages: only a month has one to open (on that month). */}
          <SummaryRow
            label="Income"
            to={rowLink ? "/income" : undefined}
            month={rowLink}
            pending={pending}
            value={money(summary.income)}
          />
          <SummaryRow
            label="Spending"
            to={rowLink ? "/spending" : undefined}
            month={rowLink}
            pending={pending}
            value={
              onlyImported && !noTotals
                ? formatEur(summary.importedSpending)
                : money(summary.spending)
            }
          />
          <SummaryRow
            label="Savings rate"
            hint={
              pending
                ? undefined
                : noTotals
                  ? "Didn't load"
                  : onlyImported
                    ? "No income recorded"
                    : summary.savingsRate == null
                      ? "No income this period"
                      : summary.savingsRate < 0
                        ? "Taken from savings"
                        : "Share of income kept"
            }
            pending={pending}
            value={formatRate(summary.savingsRate)}
            toneClass={
              summary.savingsRate == null
                ? "text-foreground"
                : // Same dead band as formatRate: a rate shown as 0% is neither gain nor loss.
                  TONE_TEXT[toneOf(summary.savingsRate, ZERO_RATE)]
            }
          />
        </ul>
      </GroupedList>

      <section className="mt-8">
        <SectionTitle>Money in and out</SectionTitle>
        <GroupedList className="px-2 py-4 sm:px-4">
          {flowPending ? (
            <Skeleton className="h-60 w-full" />
          ) : noTotals ? (
            <p className="px-2 py-8 text-center text-sm text-muted-foreground">
              The totals didn't load.
            </p>
          ) : failed(spendQuery) || failed(incomeQuery) ? (
            // Drawing without the breakdown would lump everything into one "Other" band.
            <p className="px-2 py-8 text-center text-sm text-muted-foreground">
              The breakdown didn't load.
            </p>
          ) : graph.nodes.length === 0 ? (
            // The app's empty state, with a way back to a period that has data.
            <EmptyState
              title={`Nothing came in or went out in ${label}.`}
              action={
                canGoPrev ? (
                  <Button
                    variant="quiet"
                    onClick={() => setStart(shiftPeriod(start, period, -1))}
                    className="bg-muted"
                  >
                    Previous {period}
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <FlowSankey
              graph={graph}
              label={
                onlyImported
                  ? `Imported spending for ${label}: ${formatEur(summary.importedSpending)} by category.`
                  : `Cash flow for ${label}: ${formatEur(summary.income)} in, ${formatEur(
                      summary.spending,
                    )} out, ${savedPhrase(summary.net)}.`
              }
            />
          )}
        </GroupedList>
      </section>

      <section className="mt-8">
        <SectionTitle>Saved per {period}</SectionTitle>
        <GroupedList className="px-2 py-4 sm:px-4">
          {pending ? (
            <Skeleton className="h-40 w-full" />
          ) : noTotals ? (
            <p className="px-2 py-8 text-center text-sm text-muted-foreground">
              The totals didn't load.
            </p>
          ) : bars.length < 2 ? (
            // One bar compares nothing.
            <p className="px-2 py-8 text-center text-sm text-muted-foreground">
              Not enough history for a trend yet.
            </p>
          ) : (
            <TrendBars
              bars={bars}
              selected={from}
              label={`Saved per ${period}, last ${bars.length}`}
              tickLabel={(b) => shortPeriodLabel(b.start, period, locale)}
              onSelect={(b) => setStart(b.start)}
            />
          )}
        </GroupedList>
      </section>
    </div>
  );
}

// A row that opens the page behind its figure, as on Reports.
const ROW_LINK =
  "flex min-h-11 items-center gap-3 px-4 py-3 text-sm transition-colors hover:bg-accent/40 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring sm:px-5";

function SummaryRow({
  label,
  hint,
  value,
  pending,
  to,
  month,
  toneClass = "text-foreground",
}: {
  label: string;
  hint?: string | undefined;
  value: string;
  pending: boolean;
  to?: "/income" | "/spending" | undefined;
  /** ?month= for the linked page. */
  month?: string | undefined;
  toneClass?: string;
}) {
  const body = (
    <>
      <div className="min-w-0 flex-1">
        <p className="text-foreground">{label}</p>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      {pending ? (
        <Skeleton className="h-5 w-20" />
      ) : (
        <span className={`font-figure ${toneClass}`}>{value}</span>
      )}
      {to && <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />}
    </>
  );
  return (
    <li>
      {to ? (
        <Link to={to} search={month ? { month } : {}} className={ROW_LINK}>
          {body}
        </Link>
      ) : (
        <div className="flex min-h-11 items-center gap-3 px-4 py-3 text-sm sm:px-5">{body}</div>
      )}
    </li>
  );
}
