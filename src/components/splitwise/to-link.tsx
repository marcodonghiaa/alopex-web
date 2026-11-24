import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { FindInBank } from "@/components/import/find-in-bank";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { GroupedList, SectionTitle } from "@/components/ui/grouped-list";
import { Skeleton } from "@/components/ui/skeleton";
import { isDemoMode } from "@/lib/demo/mode";
import { cn } from "@/lib/utils";
import { txId, type TxKey } from "@/lib/transactions";
import { PENDING } from "./pending";
import { moneyAmount, moneyFromCents, shortDate } from "@/lib/import/splitwise-format";
import {
  canCount,
  directionOf,
  formatCount,
  KIND_LABEL,
  reviewRow,
  runReviewAction,
  syncRefreshKeys,
  type ReviewAction,
  type ReviewItem,
  type Suggestion,
} from "@/lib/splitwise-sync";
import type { ToLinkMatches } from "@/lib/use-splitwise-sync";

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
export function ToLink({
  connected,
  matches,
}: {
  connected: boolean;
  /** From the page's useToLinkMatches: read once there, shared with the payback questions. */
  matches: ToLinkMatches;
}) {
  const queryClient = useQueryClient();
  const { review, items, bank, rate, suggestions } = matches;
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
    onSuccess: (_d, a) => {
      // The linked payment leaves the payback questions now, not when their refetch lands: else
      // it shows there once the item leaves this list (no longer suggested, so no longer hidden).
      if (a.action === "link")
        queryClient.setQueryData<Array<TxKey>>(["payback-candidates"], (list) =>
          list?.filter(
            (c) =>
              txId(c) !==
              txId({ account_uid: a.tx.accountUid, entry_reference: a.tx.entryReference }),
          ),
        );
      toast.success(DONE[a.action]);
    },
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
        <>
          <Alert>Couldn't load the Splitwise expenses to link: {review.error.message}</Alert>
          <Button variant="quiet" className="mt-2" onClick={() => void review.refetch()}>
            Retry
          </Button>
        </>
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
            // A gap, not a range: rows from the partly read day before it can still be suggested.
            <p className="mb-2 px-1 text-xs text-muted-foreground">
              Bank payments before {shortDate(bank.data.completeFrom)} may be missing from
              suggestions and Find in bank.
            </p>
          )}
          {count > items.length && (
            <p className="mb-2 px-1 text-xs text-muted-foreground">
              Showing the newest {formatCount(items.length)} of {formatCount(count)}. Link or ignore
              these and older ones appear.
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
        {...(demo ? { disabledNote: "Linking is off in the demo." } : {})}
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
  const off = {
    disabled: demo,
    "aria-disabled": busy || undefined,
    className: cn("px-3", PENDING),
  };
  return (
    <li
      id={rowId(item.id)}
      tabIndex={-1}
      className="px-4 py-3 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset sm:px-5"
      aria-label={item.description}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 text-[0.9375rem] font-medium break-words">
            {item.description || "Expense"}
          </p>
          <p className="text-[0.8125rem] text-muted-foreground">
            <span className="font-figure">{shortDate(item.booking_date)}</span> · {item.group_name}{" "}
            · {KIND_LABEL[item.kind]}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="font-figure text-[0.9375rem]">{moneyAmount(item.cost, item.currency)}</p>
          {/* Several payers: the suggestion is for what you paid, so it can be checked. */}
          {item.kind === "multi_payer" && (
            <p className="text-xs text-muted-foreground">
              you paid{" "}
              <span className="font-figure">{moneyAmount(item.my_paid, item.currency)}</span>
            </p>
          )}
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
              {moneyFromCents(tx.amountCents, tx.currency)}
            </span>
            <span className="block font-figure text-xs text-muted-foreground">
              {shortDate(tx.bookingDate)}
            </span>
          </span>
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-x-1.5 gap-y-2">
        {tx ? (
          // The suggestion's own actions: a line of their own on phones, so the rest fit one line.
          <div className="flex basis-full gap-x-1.5 sm:basis-auto">
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
          </div>
        ) : null}
        <Button
          id={`${rowId(item.id)}-find`}
          variant="secondary"
          {...off}
          // It only reads: the demo can show it (its Link payment stays off there, with the note).
          disabled={false}
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
          // No fill, so tighter padding: Find in bank, Count my share and Ignore fit 375 px.
          className={cn(off.className, "px-2")}
          onClick={() => busy || onAct({ action: "dismiss", id: item.id })}
        >
          Ignore
        </Button>
      </div>
    </li>
  );
}
