import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { FindInBank } from "@/components/import/find-in-bank";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { GroupedList, SectionTitle } from "@/components/ui/grouped-list";
import { Skeleton } from "@/components/ui/skeleton";
import { isDemoMode } from "@/lib/demo/mode";
import { moneyAmount, money, shortDate } from "@/lib/import/splitwise-format";
import type { BankTx } from "@/lib/import/splitwise-match";
import { makeRate, toBankTx, type FxRow } from "@/lib/import/splitwise-review";
import {
  canCount,
  directionOf,
  fetchReview,
  formatCount,
  KIND_LABEL,
  REVIEW_KEY,
  reviewRow,
  runReviewAction,
  suggestMatches,
  syncRefreshKeys,
  type ReviewAction,
  type ReviewItem,
  type Suggestion,
} from "@/lib/splitwise-sync";

// Bank rows from 30 days before the oldest item (the matcher's early window) to a week after the
// newest. The database returns at most 1000 rows per call; past that, suggestions are left out.
const DAYS_BEFORE = 30;
const DAYS_AFTER = 7;
const PAGE_LIMIT = 1000;

const addDays = (iso: string, days: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

interface Bank {
  bank: Array<BankTx>;
  fx: Array<FxRow>;
}

async function fetchBank(items: Array<ReviewItem>): Promise<Bank> {
  const dates = items.map((i) => i.booking_date).sort();
  const from = addDays(dates[0]!, -DAYS_BEFORE);
  const to = addDays(dates[dates.length - 1]!, DAYS_AFTER);
  const bank = await supabase
    .from("transactions")
    .select(
      "account_uid, entry_reference, booking_date, amount, currency, credit_debit_indicator, personal_amount, flow_type, deleted_at, creditor_name",
    )
    .gte("booking_date", from)
    .lte("booking_date", to)
    .limit(PAGE_LIMIT);
  if (bank.error) throw new Error(bank.error.message);
  const currencies = [
    ...new Set([...items.map((i) => i.currency), ...(bank.data ?? []).map((t) => t.currency)]),
  ].filter((c) => c !== "EUR");
  const fx =
    currencies.length === 0
      ? { data: [] as Array<FxRow>, error: null }
      : await supabase
          .from("fx_rates")
          .select("currency, date, rate_to_eur")
          .in("currency", currencies)
          .gte("date", addDays(from, -14))
          .lte("date", to)
          .limit(PAGE_LIMIT);
  if (fx.error) throw new Error(fx.error.message);
  return { bank: (bank.data ?? []).flatMap((r) => toBankTx(r) ?? []), fx: fx.data ?? [] };
}

const DONE: Record<ReviewAction["action"], string> = {
  link: "Linked to the bank payment",
  reject: "Won't suggest that payment again",
  count: "Your share counts as spending",
  dismiss: "Ignored",
};

/**
 * Splitwise expenses the sync can't settle alone (you paid, several payers, settle-ups): link each
 * to its bank payment, count your share without one, or ignore it. Shown once Splitwise is
 * connected, or while items are still waiting after a disconnect.
 */
export function ToLink({ connected }: { connected: boolean }) {
  const queryClient = useQueryClient();
  const review = useQuery({ queryKey: REVIEW_KEY, queryFn: fetchReview });
  const items = useMemo(() => review.data ?? [], [review.data]);
  const dates = items.map((i) => i.booking_date).sort();
  // Under "transactions" so the import's refresh keys refetch it after a link.
  const bank = useQuery({
    queryKey: ["transactions", "splitwise-to-link", dates[0], dates[dates.length - 1]],
    queryFn: () => fetchBank(items),
    enabled: items.length > 0,
  });
  const rate = useMemo(() => makeRate(bank.data?.fx ?? []), [bank.data]);
  const suggestions = useMemo(
    () => suggestMatches(items, bank.data?.bank ?? [], rate),
    [items, bank.data, rate],
  );
  const [finding, setFinding] = useState<ReviewItem | null>(null);
  // Stable between renders: Find in bank clears the picked payment when its row changes.
  const findRow = useMemo(() => (finding ? reviewRow(finding, 0) : null), [finding]);
  const demo = isDemoMode();

  const act = useMutation({
    mutationFn: runReviewAction,
    onSuccess: (_d, a) => toast.success(DONE[a.action]),
    onError: (err) => toast.error(err.message),
    // Awaited: the action stays pending (rows off) until the list shows its result.
    onSettled: () =>
      Promise.all(syncRefreshKeys().map((queryKey) => queryClient.invalidateQueries({ queryKey }))),
  });
  // One action at a time: each one changes what the others would act on.
  const busy = demo || act.isPending;

  const count = items.length;
  // Disconnected but kept: what's still waiting can be linked. A database without the sync
  // (an older backend) has no list at all, and nothing shows.
  if (!connected && count === 0) return null;
  return (
    <section aria-label="To link" className="mt-8">
      <SectionTitle
        action={
          count > 0 ? (
            <span className="pb-px font-figure text-xs text-ember">
              {formatCount(count)}
              <span className="sr-only"> to link</span>
            </span>
          ) : null
        }
      >
        To link · from Splitwise
      </SectionTitle>
      {review.isError ? (
        <Alert>Couldn't load the Splitwise expenses to link: {review.error.message}</Alert>
      ) : review.isPending ? (
        <Skeleton
          role="status"
          aria-label="Loading expenses to link"
          aria-hidden={false}
          className="h-24"
        />
      ) : count === 0 ? (
        <p className="rounded-lg bg-card px-4 py-6 text-center text-sm text-muted-foreground">
          Nothing to link. Expenses you pay and settle-ups show up here after a sync.
        </p>
      ) : (
        <>
          {demo && (
            <p role="note" className="mb-2 px-1 text-sm text-muted-foreground">
              Linking is off in the demo.
            </p>
          )}
          {bank.isError && (
            <p className="mb-2 px-1 text-xs text-muted-foreground">
              No bank suggestions: {bank.error.message}
            </p>
          )}
          <GroupedList>
            <ul className="divide-y divide-hairline">
              {items.map((item) => (
                <ReviewRow
                  key={item.id}
                  item={item}
                  suggestion={suggestions.get(item.id) ?? null}
                  busy={busy}
                  onAct={(a) => act.mutate(a)}
                  onFind={() => setFinding(item)}
                />
              ))}
            </ul>
          </GroupedList>
        </>
      )}
      <FindInBank
        row={findRow}
        bank={(bank.data?.bank ?? []).filter(
          (t) => !finding?.rejected_entry_references.includes(t.entryReference),
        )}
        taken={new Set()}
        rate={rate}
        direction={finding ? directionOf(finding.kind) : "DBIT"}
        showSplit={false}
        otherwise={
          finding && canCount(finding.kind)
            ? "If you paid it some other way, count your share without linking."
            : "If it never went through your bank, ignore it."
        }
        onPick={(tx) => {
          if (finding) act.mutate({ action: "link", id: finding.id, tx });
          setFinding(null);
        }}
        onClose={() => setFinding(null)}
      />
    </section>
  );
}

function ReviewRow({
  item,
  suggestion,
  busy,
  onAct,
  onFind,
}: {
  item: ReviewItem;
  suggestion: Suggestion | null;
  busy: boolean;
  onAct: (a: ReviewAction) => void;
  onFind: () => void;
}) {
  const tx = suggestion?.tx;
  const out = directionOf(item.kind) === "DBIT";
  return (
    <li className="px-4 py-3 sm:px-5" aria-label={item.description}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[0.9375rem] font-medium">{item.description || "Expense"}</p>
          <p className="text-[0.8125rem] text-muted-foreground">
            <span className="font-figure">{shortDate(item.booking_date)}</span> · {item.group_name}{" "}
            · {KIND_LABEL[item.kind]}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="font-figure text-[0.9375rem]">{moneyAmount(item.cost, item.currency)}</p>
          {canCount(item.kind) && (
            <p className="text-xs text-muted-foreground">
              your share{" "}
              <span className="font-figure">{moneyAmount(item.my_share, item.currency)}</span>
            </p>
          )}
        </div>
      </div>
      {tx && (
        <div className="mt-2 flex items-center gap-3 rounded-sm bg-background px-3 py-2 text-sm">
          <span className="min-w-0 flex-1">
            <span className="block text-xs text-muted-foreground">
              {suggestion.confidence === "likely" ? "Bank payment" : "Maybe this payment"}
            </span>
            <span className="block truncate">{tx.name?.trim() || "Bank transaction"}</span>
          </span>
          <span className="shrink-0 text-right">
            <span className="block font-figure">
              {out ? "−" : "+"}
              {money(tx.amountCents, tx.currency)}
            </span>
            <span className="block font-figure text-xs text-muted-foreground">
              {shortDate(tx.bookingDate)}
            </span>
          </span>
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        {tx ? (
          <>
            <Button
              size="sm"
              disabled={busy}
              onClick={() => onAct({ action: "link", id: item.id, tx })}
            >
              Link
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() =>
                onAct({ action: "reject", id: item.id, entryReference: tx.entryReference })
              }
            >
              Not this one
            </Button>
          </>
        ) : null}
        <Button size="sm" variant="secondary" disabled={busy} onClick={onFind}>
          Find in bank
        </Button>
        {canCount(item.kind) && (
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => onAct({ action: "count", id: item.id })}
          >
            Count my share without linking
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => onAct({ action: "dismiss", id: item.id })}
        >
          Ignore
        </Button>
      </div>
    </li>
  );
}
