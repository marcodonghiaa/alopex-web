import { useEffect, useState } from "react";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { CTA, Group } from "@/components/import/splitwise-ui";
import { money, shortDate } from "@/lib/import/splitwise-format";
import type { ClassifiedRow } from "@/lib/import/splitwise-classify";
import {
  manualSplit,
  nearbyPayments,
  type BankTx,
  type RateToEur,
} from "@/lib/import/splitwise-match";

const key = (t: BankTx) => `${t.accountUid}|${t.entryReference}`;

/**
 * A sheet listing the payments around an expense I paid, so the user can say which one it was
 * when the amounts differ too much for the matcher (a tip, a split entered differently).
 */
export function FindInBank({
  row,
  bank,
  taken,
  rate,
  onPick,
  onClose,
  direction = "DBIT",
  showSplit = true,
  otherwise = "If you paid it some other way, choose Paid in cash.",
  title,
  detail,
}: {
  /** The expense being linked; null keeps the sheet closed. */
  row: ClassifiedRow | null;
  bank: Array<BankTx>;
  taken: Set<string>;
  rate: RateToEur;
  onPick: (tx: BankTx) => void;
  onClose: () => void;
  /** CRDT lists money in (a settle-up received) instead of payments out. */
  direction?: BankTx["direction"];
  /** Show what counts as spending for the picked payment (the CSV import works it out here). */
  showSplit?: boolean;
  /** What to do when no payment fits, after "No payments … around that date." */
  otherwise?: string;
  /** Replaces "Which payment was <description>?" (a settle-up's description is just "Settle up"). */
  title?: string;
  /** Goes before "Payments around <date>, any amount.", e.g. the amount to look for. */
  detail?: string;
}) {
  const [chosen, setChosen] = useState<string | null>(null);
  useEffect(() => setChosen(null), [row]);

  const options = row ? nearbyPayments(row, bank, taken, direction) : [];
  const tx = options.find((t) => key(t) === chosen) ?? null;
  const split = showSplit && row && tx ? manualSplit(row, tx, rate) : null;
  const out = direction === "DBIT";

  return (
    <Sheet open={row !== null} onOpenChange={(open) => open || onClose()}>
      <SheetContent
        side="bottom"
        // Focus is handed back to the expense by the review, which knows which one it was.
        onCloseAutoFocus={(e) => e.preventDefault()}
        className="mx-auto max-h-[90dvh] max-w-lg overflow-y-auto rounded-t-3xl border-0 bg-background px-5 pt-3 pb-8"
      >
        <div aria-hidden className="mx-auto mb-4 h-1.5 w-9 rounded-full bg-foreground/20" />
        <SheetTitle className="text-xl font-semibold">
          {title ?? `Which payment was ${row?.description.trim() ?? "it"}?`}
        </SheetTitle>
        <SheetDescription className="mt-1 text-sm text-muted-foreground">
          {row
            ? `${detail ? `${detail} ` : ""}Payments around ${shortDate(row.date)}, any amount.`
            : ""}
        </SheetDescription>

        <div className="mt-5 space-y-4">
          {options.length === 0 ? (
            <p role="status" className="rounded-2xl bg-background/60 px-4 py-6 text-center text-sm">
              No payments {out ? "out of" : "into"} your accounts around that date. {otherwise}
            </p>
          ) : (
            <Group>
              <fieldset className="divide-y divide-border">
                <legend className="sr-only">Bank payments</legend>
                {options.map((t) => {
                  const selected = key(t) === chosen;
                  return (
                    <label
                      key={key(t)}
                      className={`flex min-h-14 w-full cursor-pointer items-center gap-3 px-4 py-2.5 transition-colors hover:bg-foreground/5 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-inset ${
                        selected ? "bg-primary/10" : ""
                      }`}
                    >
                      <input
                        type="radio"
                        name="bank-payment"
                        className="sr-only"
                        checked={selected}
                        onChange={() => setChosen(key(t))}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[0.9375rem] font-medium">
                          {t.name?.trim() || "Card payment"}
                        </span>
                        <span className="block text-[0.8125rem] text-muted-foreground">
                          {shortDate(t.bookingDate)}
                        </span>
                      </span>
                      <span className="shrink-0 font-figure text-[0.9375rem]">
                        {out ? "−" : "+"}
                        {money(t.amountCents, t.currency)}
                      </span>
                      <span
                        aria-hidden
                        className={`size-5 shrink-0 rounded-full border-2 transition-all ${
                          selected ? "border-[6px] border-primary" : "border-foreground/25"
                        }`}
                      />
                    </label>
                  );
                })}
              </fieldset>
            </Group>
          )}
        </div>
        {/* Kept in view while the list scrolls: the choice and its result sit next to the button. */}
        <div className="sticky -bottom-8 -mx-5 mt-4 space-y-3 bg-background px-5 pt-3 pb-8">
          {showSplit && tx && !split && (
            <p role="alert" className="px-4 text-sm text-negative">
              No exchange rate for this payment yet, so your part cannot be worked out.
            </p>
          )}
          {tx && split && (
            <Group>
              <dl className="divide-y divide-border font-figure text-[0.9375rem]">
                <div className="flex min-h-11 items-center justify-between px-4">
                  <dt className="text-muted-foreground">Paid from your bank</dt>
                  <dd>{money(tx.amountCents, tx.currency)}</dd>
                </div>
                <div className="flex min-h-11 items-center justify-between px-4">
                  <dt className="text-muted-foreground">Others owe you (Splitwise)</dt>
                  <dd>−{money(split.othersOweCents, tx.currency)}</dd>
                </div>
                <div className="flex min-h-11 items-center justify-between px-4 font-semibold">
                  <dt>Counts as your spending</dt>
                  <dd>{money(split.personalAmountCents, tx.currency)}</dd>
                </div>
              </dl>
            </Group>
          )}

          <button
            type="button"
            className={CTA}
            disabled={!tx || (showSplit && !split)}
            onClick={() => tx && onPick(tx)}
          >
            Link payment
          </button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
