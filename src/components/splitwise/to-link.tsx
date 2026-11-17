import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { FindInBank } from "@/components/import/find-in-bank";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { GroupedList, SectionTitle } from "@/components/ui/grouped-list";
import { Skeleton } from "@/components/ui/skeleton";
import { isDemoMode } from "@/lib/demo/mode";
import { PENDING } from "./pending";
import { moneyAmount, money, shortDate } from "@/lib/import/splitwise-format";
import { fetchBankWindow } from "@/lib/import/splitwise-bank";
import { makeRate } from "@/lib/import/splitwise-review";
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

// The sheet hands focus back to the expense it was opened from, not to <body> (as the CSV review).
const rowId = (id: string) => `to-link-${id}`;
const focusLater = (id: string) =>
  requestAnimationFrame(() => document.getElementById(id)?.focus());
const rowIds = () =>
  [...document.querySelectorAll<HTMLElement>("li[id^='to-link-']")].map((li) => li.id);

// The page's answer is who owes you: a long queue would push the groups far down.
const FIRST = 5;

// Splitwise names every settle-up "Settle up": the sheet says which kind and how much instead.
const SETTLE_TITLE: Partial<Record<ReviewItem["kind"], string>> = {
  settle_out: "Which payment was this settle-up?",
  settle_in: "Which payment came in for this settle-up?",
};

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
  const items = useMemo(() => review.data?.items ?? [], [review.data]);
  const dates = items.map((i) => i.booking_date).sort();
  // Every input of the fetch: the window's ends and the currencies it reads rates for.
  const currencies = [...new Set(items.map((i) => i.currency))].sort().join(",");
  // Under "transactions" so the import's refresh keys refetch it after a link.
  const bank = useQuery({
    queryKey: ["transactions", "splitwise-to-link", dates[0], dates[dates.length - 1], currencies],
    queryFn: () =>
      fetchBankWindow(
        items.map((i) => i.booking_date),
        items.map((i) => i.currency),
      ),
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
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? items : items.slice(0, FIRST);

  const act = useMutation({
    mutationFn: runReviewAction,
    // Where the row sits, so focus can go to the one that takes its place once it's gone.
    onMutate: (a) => rowIds().indexOf(rowId(a.id)),
    onSuccess: (_d, a) => toast.success(DONE[a.action]),
    onError: (err) => toast.error(err.message),
    // Awaited: the action stays pending (rows off) until the list shows its result.
    onSettled: async (_d, _e, a, at) => {
      await Promise.all(
        syncRefreshKeys().map((queryKey) => queryClient.invalidateQueries({ queryKey })),
      );
      requestAnimationFrame(() => {
        if (document.activeElement && document.activeElement !== document.body) return;
        const ids = rowIds();
        const next = ids.includes(rowId(a.id))
          ? rowId(a.id)
          : ids[Math.min(at ?? 0, ids.length - 1)];
        if (next) document.getElementById(next)?.focus();
      });
    },
  });
  // One action at a time: each one changes what the others would act on. Busy, not disabled, so
  // the clicked button keeps keyboard focus.
  const busy = act.isPending;

  const count = review.data?.total ?? 0;
  // Disconnected but kept: what's still waiting can be linked. A database without the sync
  // (an older backend) has no list at all, and nothing shows.
  if (!connected && count === 0) return null;
  return (
    <section aria-label="To link" className="mt-8">
      <SectionTitle
        action={
          count > 0 ? (
            <span className="pb-px font-figure text-xs text-muted-foreground">
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
          {bank.data?.completeFrom && (
            <p className="mb-2 px-1 text-xs text-muted-foreground">
              Suggestions and Find in bank only cover bank payments from{" "}
              {shortDate(bank.data.completeFrom)} on.
            </p>
          )}
          {count > items.length && (
            <p className="mb-2 px-1 text-xs text-muted-foreground">
              Showing the newest {formatCount(items.length)} of {formatCount(count)}. Settle these
              and the rest follow.
            </p>
          )}
          <GroupedList>
            <ul className="divide-y divide-hairline">
              {shown.map((item) => (
                <ReviewRow
                  key={item.id}
                  item={item}
                  suggestion={suggestions.get(item.id) ?? null}
                  busy={busy}
                  demo={demo}
                  onAct={(a) => act.mutate(a)}
                  onFind={() => setFinding(item)}
                />
              ))}
            </ul>
          </GroupedList>
          {shown.length < items.length && (
            <Button
              variant="quiet"
              className="mt-2 w-full"
              onClick={() => {
                setShowAll(true);
                // The button goes away: focus the first row it revealed, not <body>.
                focusLater(rowId(items[FIRST]!.id));
              }}
            >
              Show all {formatCount(items.length)}
            </Button>
          )}
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
        {...(finding && SETTLE_TITLE[finding.kind]
          ? {
              title: SETTLE_TITLE[finding.kind],
              detail: `Settle-up of ${moneyAmount(finding.cost, finding.currency)}.`,
            }
          : {})}
        otherwise={
          finding && canCount(finding.kind)
            ? "If you paid it some other way, count your share without linking."
            : "If it never went through your bank, ignore it."
        }
        onPick={(tx) => {
          if (finding) {
            act.mutate({ action: "link", id: finding.id, tx });
            focusLater(rowId(finding.id));
          }
          setFinding(null);
        }}
        onClose={() => {
          if (finding) focusLater(`${rowId(finding.id)}-find`);
          setFinding(null);
        }}
      />
    </section>
  );
}

function ReviewRow({
  item,
  suggestion,
  busy,
  demo,
  onAct,
  onFind,
}: {
  item: ReviewItem;
  suggestion: Suggestion | null;
  busy: boolean;
  /** Linking is off in the demo: real disabled, for good. */
  demo: boolean;
  onAct: (a: ReviewAction) => void;
  onFind: () => void;
}) {
  const tx = suggestion?.tx;
  const out = directionOf(item.kind) === "DBIT";
  const off = { disabled: demo, "aria-disabled": busy || undefined, className: PENDING };
  return (
    <li
      id={rowId(item.id)}
      tabIndex={-1}
      className="px-4 py-3 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset sm:px-5"
      aria-label={item.description}
    >
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
            <Button {...off} onClick={() => busy || onAct({ action: "link", id: item.id, tx })}>
              Link
            </Button>
            <Button
              variant="secondary"
              {...off}
              onClick={() =>
                busy || onAct({ action: "reject", id: item.id, entryReference: tx.entryReference })
              }
            >
              Not this one
            </Button>
          </>
        ) : null}
        <Button
          id={`${rowId(item.id)}-find`}
          variant="secondary"
          {...off}
          onClick={() => busy || onFind()}
        >
          Find in bank
        </Button>
        {canCount(item.kind) && (
          <Button
            variant="secondary"
            {...off}
            onClick={() => busy || onAct({ action: "count", id: item.id })}
          >
            Count my share
          </Button>
        )}
        <Button
          variant="ghost"
          {...off}
          onClick={() => busy || onAct({ action: "dismiss", id: item.id })}
        >
          Ignore
        </Button>
      </div>
    </li>
  );
}
