import { dateLocale } from "@/lib/locale";
import { Link, createFileRoute } from "@tanstack/react-router";
import { ChevronDown, ThumbsDown } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { CategoryAvatar } from "@/components/category-avatar";
import { CategoryRow } from "@/components/spending/category-row";
import { supabase } from "@/integrations/supabase/client";
import { formatDay, formatISODate, monthBounds } from "@/lib/date";
import { cleanMerchantName } from "@/lib/merchant-name";
import { categoryColor, UNCATEGORIZED_LABEL } from "@/lib/categories";
import { shareSummary } from "@/lib/chart-summary";
import { categorySpend, sharePercent, spendChange, type MonthlySpendRow } from "@/lib/spending";
import { TONE_TEXT } from "@/lib/tone";
import {
  formatEur,
  monthFromParam,
  monthParam,
  monthSearch,
  personalAmountEur,
  startOfMonth,
} from "@/lib/transactions";
import { MonthSwitcher } from "@/components/month-switcher";
import { HeadlineFigure } from "@/components/headline-figure";
import { Stripes } from "@/components/share-bar";
import { EmptyState } from "@/components/empty-state";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { GroupedList } from "@/components/ui/grouped-list";
import { Skeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/_authenticated/spending")({
  head: () => ({
    meta: [
      { title: "Spend by Category — Alopex" },
      {
        name: "description",
        content: "See how much you spent per category, month by month.",
      },
      { property: "og:title", content: "Spend by Category — Alopex" },
      {
        property: "og:description",
        content: "See how much you spent per category, month by month.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  // ?month=YYYY-MM: the month to open on (Cash flow's rows link here with the month they show).
  validateSearch: monthSearch,
  component: SpendingPage,
});

interface RegretRow {
  category: string | null;
  personal_signed_amount_eur: number | null;
  signed_amount_eur: number | null;
  entry_reference: string | null;
  creditor_name: string | null;
  booking_date: string | null;
}

interface RegretPurchase {
  ref: string | null;
  name: string | null;
  date: string | null;
  amount: number;
}

interface RegretGroup {
  category: string;
  total: number;
  count: number;
  /** Newest first. */
  purchases: Array<RegretPurchase>;
}

async function fetchSpendForMonth(month: Date): Promise<Array<MonthlySpendRow>> {
  const { data, error } = await supabase
    .from("v_spend_by_category_monthly")
    .select("month,category,spend_eur")
    .eq("month", formatISODate(startOfMonth(month)));
  if (error) throw error;
  return (data ?? []) as Array<MonthlySpendRow>;
}

// Scoped to the selected month, like the rest of the page.
async function fetchRegretSpend(month: Date): Promise<Array<RegretGroup>> {
  const { start, end } = monthBounds(month);
  const { data, error } = await supabase
    .from("v_transactions_eur")
    .select(
      "category,personal_signed_amount_eur,signed_amount_eur,entry_reference,creditor_name,booking_date",
    )
    .eq("worth_it", "no")
    .eq("flow_type", "spend") // a refunded charge was money back, not a regret
    .gte("booking_date", start)
    .lt("booking_date", end);
  if (error) throw error;
  const byCategory = new Map<string, RegretGroup>();
  for (const row of (data ?? []) as Array<RegretRow>) {
    const category = row.category ?? UNCATEGORIZED_LABEL;
    const amount = personalAmountEur(row);
    const purchase = {
      ref: row.entry_reference,
      name: cleanMerchantName(row.creditor_name),
      date: row.booking_date,
      amount,
    };
    const existing = byCategory.get(category);
    if (existing) {
      existing.total += amount;
      existing.count += 1;
      existing.purchases.push(purchase);
    } else {
      byCategory.set(category, { category, total: amount, count: 1, purchases: [purchase] });
    }
  }
  const groups = Array.from(byCategory.values()).sort((a, b) => b.total - a.total);
  for (const g of groups) g.purchases.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
  return groups;
}

function SpendingPage() {
  const search = Route.useSearch();
  const [month, setMonth] = useState<Date>(() => monthFromParam(search.month));

  const spendQuery = useQuery({
    queryKey: ["spend-by-category", formatISODate(month)],
    queryFn: () => fetchSpendForMonth(month),
  });

  // Last month, for "is that normal?": same view and cache key as when you step back to it.
  const prevMonth = new Date(month.getFullYear(), month.getMonth() - 1, 1);
  const prevSpendQuery = useQuery({
    queryKey: ["spend-by-category", formatISODate(prevMonth)],
    queryFn: () => fetchSpendForMonth(prevMonth),
  });

  const regretQuery = useQuery({
    queryKey: ["worth-it-regret", formatISODate(month)],
    queryFn: () => fetchRegretSpend(month),
  });
  const regretRows = regretQuery.data ?? [];

  const rows = useMemo(() => categorySpend(spendQuery.data ?? []), [spendQuery.data]);
  const total = rows.reduce((sum, r) => sum + r.spend_eur, 0);
  const prevTotal = categorySpend(prevSpendQuery.data ?? []).reduce((s, r) => s + r.spend_eur, 0);
  const change = prevSpendQuery.data ? spendChange(total, prevTotal) : null;

  const monthLabel = month.toLocaleDateString(dateLocale(), {
    month: "long",
    year: "numeric",
  });

  const prevMonthName = prevMonth.toLocaleDateString("en-GB", { month: "long" });
  const goToPrevMonth = () => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1));

  const canGoNext = month < startOfMonth(new Date());

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-8 md:py-12">
      {/* One header: the month and its arrows; the figure below is the page's answer */}
      <h1 className="sr-only">Spending by category</h1>

      {spendQuery.isError && (
        <Alert className="mb-6">Couldn't load spending data: {spendQuery.error.message}</Alert>
      )}

      {regretQuery.isError && (
        <Alert className="mb-6">
          Couldn't load your "worth it?" answers: {regretQuery.error.message}
        </Alert>
      )}

      <MonthSwitcher
        className="mb-6"
        label={monthLabel}
        onPrev={goToPrevMonth}
        onNext={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}
        canGoNext={canGoNext}
      />

      {/* A failed load shows only the alert above: no spending is not the same as no data. */}
      {spendQuery.isPending ? (
        <Skeleton className="h-80" />
      ) : spendQuery.data === undefined ? null : rows.length === 0 ? (
        <EmptyState
          title={`No spending recorded for ${monthLabel}.`}
          action={
            <Button variant="quiet" onClick={goToPrevMonth} className="bg-muted">
              Previous month
            </Button>
          }
        />
      ) : (
        <>
          {/* Headline: the month's spend, then how it splits by category */}
          <section aria-label={`Spent in ${monthLabel}`} className="mb-8">
            <p className="text-[0.9375rem] text-muted-foreground">Spent</p>
            {/* The change chip as on Net Worth: less spent reads green */}
            <div className="mt-1">
              <HeadlineFigure
                value={total}
                currency="EUR"
                change={
                  change
                    ? {
                        value: change.delta,
                        percent: change.delta / prevTotal,
                        className: TONE_TEXT[change.tone],
                      }
                    : undefined
                }
              />
            </div>
            {change && (
              <p className="mt-1 text-[0.8125rem] text-muted-foreground">vs {prevMonthName}</p>
            )}
            {/* The stripes show the split at a glance; each row below names its own share */}
            <div className="mt-5 max-w-2xl">
              <Stripes
                label={shareSummary(
                  "Spend by category",
                  rows.map((r) => ({ label: r.category, value: r.spend_eur })),
                )}
                shares={rows.map((r) => ({
                  label: r.category,
                  value: r.spend_eur,
                  color: categoryColor(r.category),
                }))}
              />
            </div>
          </section>

          {/* Breakdown list */}
          <GroupedList>
            <ul className="divide-y divide-hairline">
              {rows.map((row) => (
                <CategoryRow
                  key={row.category}
                  category={row.category}
                  total={row.spend_eur}
                  share={sharePercent(row.spend_eur, total)}
                  month={month}
                />
              ))}
            </ul>
          </GroupedList>
        </>
      )}

      <RegretCard groups={regretRows} month={month} />
    </div>
  );
}

// Purchases answered "not worth it", as their own card: a category opens to its purchases,
// and each one opens in Activity on its row.
function RegretCard({ groups, month }: { groups: Array<RegretGroup>; month: Date }) {
  const [open, setOpen] = useState<string | null>(null);
  if (groups.length === 0) return null;
  const total = groups.reduce((sum, g) => sum + g.total, 0);
  return (
    <section aria-label="Not worth it" className="mt-6">
      <GroupedList>
        <h2 className="flex items-center gap-2 px-4 py-3 text-lg font-semibold text-foreground sm:px-5">
          <ThumbsDown aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <span className="flex-1">Not worth it</span>
          <span className="font-figure">{formatEur(total)}</span>
        </h2>
        <ul className="divide-y divide-hairline">
          {groups.map((g) => {
            const isOpen = open === g.category;
            return (
              <li key={g.category}>
                <button
                  type="button"
                  aria-expanded={isOpen}
                  onClick={() => setOpen(isOpen ? null : g.category)}
                  className="flex min-h-11 w-full items-center gap-3 px-4 py-2.5 text-left text-sm transition-colors hover:bg-accent/40 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring sm:px-5"
                >
                  <CategoryAvatar
                    category={g.category === UNCATEGORIZED_LABEL ? null : g.category}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-foreground">{g.category}</span>
                    <span className="block text-xs text-muted-foreground">
                      {g.count} purchase{g.count === 1 ? "" : "s"}
                    </span>
                  </span>
                  <span className="font-figure shrink-0 text-foreground">{formatEur(g.total)}</span>
                  <ChevronDown
                    aria-hidden
                    className={`size-4 shrink-0 text-muted-foreground transition-transform ${isOpen ? "rotate-180" : ""}`}
                  />
                </button>
                {isOpen && (
                  <ul className="divide-y divide-hairline bg-muted/40">
                    {g.purchases.map((p, i) => (
                      <li key={p.ref ?? i}>
                        <Link
                          to="/transactions"
                          // Activity scrolls to the purchase itself; a reset to the top would undo it.
                          resetScroll={false}
                          search={{
                            month: monthParam(month),
                            ...(p.ref ? { highlight: p.ref } : {}),
                          }}
                          className="flex min-h-11 items-center gap-3 py-2 pr-4 pl-15 text-sm transition-colors hover:bg-accent/40 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring sm:pr-5"
                        >
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-foreground">{p.name ?? "—"}</span>
                            {p.date && (
                              <span className="block text-xs text-muted-foreground">
                                {formatDay(p.date)}
                              </span>
                            )}
                          </span>
                          <span className="font-figure shrink-0 text-foreground">
                            {formatEur(p.amount)}
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </GroupedList>
    </section>
  );
}
