import { useId, useState, type ReactNode } from "react";
import { ChevronRight, MoreHorizontal, ThumbsDown, ThumbsUp, Users } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { categoryColor } from "@/lib/categories";
import { cleanMerchantName } from "@/lib/merchant-name";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { GroupedList } from "@/components/ui/grouped-list";
import { useIsMobile } from "@/lib/use-is-mobile";
import { AccountBadge } from "@/components/bank-badge";
import { RefundedBadge } from "@/components/refunded-badge";
import { CategoryAvatar } from "@/components/category-avatar";
import {
  formatBookingDate,
  formatBookingDateShort,
  formatMoney,
  formatSignedMoney,
  isSplitwiseShare,
  isPaidForOthers,
  isSplit,
  isWorthItEligible,
  myShare,
  nativeSignedAmount,
  type TransactionRow,
} from "@/lib/transactions";
import { NameEditor } from "./name-editor";
import { CategoryPicker, TypePicker } from "./pickers";
import { SplitEditor } from "./split-editor";
import { WorthItPrompt } from "./worth-it";
import { AmountEditor } from "./amount-editor";
import { NoteEditor, TagEditor } from "./note-tags-editor";

export interface TransactionViewProps {
  tx: TransactionRow;
  accountLabel: string;
  // inSheet: picked in the edit sheet, whose overlay covers toasts.
  onSelectCategory: (category: string, opts?: { inSheet?: boolean }) => void;
  savingCategory: boolean;
  onSelectType: (type: string) => void;
  savingType: boolean;
  selected: boolean;
  onToggleSelect: () => void;
  onAnswerWorthIt: (worthIt: "yes" | "no") => void;
  savingSplit: boolean;
  onSaveSplit: (personalAmount: number | null, owedBy: string | null) => void;
  /** Names used on past splits, offered as pills in the split editor. */
  splitContacts?: Array<string>;
  onRename: (name: string | null) => void;
  savingRename: boolean;
  /** Only for transactions added by hand: bank amounts can't change. */
  onSaveAmount?: (amount: number) => void;
  savingAmount?: boolean;
  highlighted?: boolean;
  /** "Make a rule" from this name and category, shown under Category in the sheet. */
  makeRule?: { label: string; onClick: () => void } | undefined;
  /** Table rows: show which account a row came from; pointless with a single account. */
  showAccount?: boolean;
  /** Note and tags: only bank and manual rows (a Splitwise share has neither). */
  onSaveNote?: (note: string | null) => void | Promise<boolean>;
  savingNote?: boolean;
  onSaveTags?: (tags: Array<string>) => void | Promise<boolean>;
  savingTags?: boolean;
  /** Tags used before, offered while typing one. */
  tagSuggestions?: Array<string>;
  /** The row's sheet opened or closed. */
  onOpenChange?: (open: boolean) => void;
}

/** "#trip #work", or "" without tags. */
const tagLine = (tx: TransactionRow): string => (tx.tags ?? []).map((t) => `#${t}`).join(" ");

/** An open "worth it?" question: a hint on the row, answered in the row's sheet. */
function WorthItHint({ tx }: { tx: TransactionRow }) {
  if (isSplitwiseShare(tx) || !isWorthItEligible(tx)) return null;
  return <span className="shrink-0 font-medium text-primary">Worth it?</span>;
}

/** Signed amount in the transaction's own currency, with the euro value under it if foreign.
 *  A split charge shows my share large and the whole charge under it; one paid entirely for
 *  others (or money in with a 0 share) shows the whole amount. */
function AmountText({ tx, large = false }: { tx: TransactionRow; large?: boolean }) {
  const native = nativeSignedAmount(tx);
  if (native == null) return <span className="text-sm text-muted-foreground">—</span>;
  const currency = tx.currency ?? "EUR";
  // A 0 share shows the whole amount: owed by others for money out, and money in isn't split.
  const split = isSplit(tx) && myShare(tx) > 0;
  const shown = split ? Math.sign(native) * myShare(tx) : native;
  const positive = shown > 0;
  // The euro value of what is shown: the share's part of the charge's euro value.
  const total = Math.abs(tx.amount ?? 0);
  const eur =
    tx.signed_amount_eur == null || total === 0
      ? null
      : (tx.signed_amount_eur * Math.abs(shown)) / total;
  return (
    <div className={large ? "text-center" : "shrink-0 text-right"}>
      <div
        className={`font-figure whitespace-nowrap ${large ? "text-3xl" : "text-[0.9375rem]"} ${
          positive ? "text-positive" : "text-foreground"
        }`}
      >
        {formatSignedMoney(shown, currency)}
      </div>
      {split && (
        <div className="font-figure text-xs whitespace-nowrap text-muted-foreground">
          of {formatMoney(total, currency)}
        </div>
      )}
      {currency !== "EUR" && eur != null && (
        <div className="font-figure text-xs whitespace-nowrap text-muted-foreground">
          ≈ {formatMoney(Math.abs(eur), "EUR")}
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-12 items-center justify-between gap-4 px-4 py-1">
      <span className="shrink-0 text-sm text-muted-foreground">{label}</span>
      <div className="flex min-w-0 justify-end text-sm">{children}</div>
    </div>
  );
}

/** Every editor for one bank transaction: a bottom sheet on a phone, a side panel on desktop. */
function TransactionEditSheet({
  open,
  onOpenChange,
  ...p
}: TransactionViewProps & { open: boolean; onOpenChange: (open: boolean) => void }) {
  const isMobile = useIsMobile();
  const { tx } = p;
  const name = cleanMerchantName(tx.creditor_name) ?? "—";
  const share = isSplitwiseShare(tx);
  const fieldId = useId();
  // An open worth-it question leads the sheet (iOS view board); answered, it sits further down.
  const askWorthIt = !share && isWorthItEligible(tx);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={isMobile ? "bottom" : "right"}
        aria-describedby={undefined}
        className="max-h-[88dvh] gap-0 overflow-y-auto rounded-t-xl border-0 bg-background p-0 pb-[env(safe-area-inset-bottom)] md:max-h-none md:rounded-none md:border-l [&>button]:size-11"
      >
        <div
          aria-hidden
          className="mx-auto mt-2 h-1 w-9 rounded-full bg-muted-foreground/40 md:hidden"
        />
        {/* Revolut-style header (iOS view board): initial, name, the amount large, then the day. */}
        <SheetHeader className="relative items-center px-12 pt-4 pb-5 text-center md:pt-8">
          {!share && <SheetMoreMenu selected={p.selected} onToggleSelect={p.onToggleSelect} />}
          <span
            data-testid="merchant-initial"
            aria-hidden
            className="flex size-14 items-center justify-center rounded-full text-xl font-semibold text-foreground"
            style={{
              backgroundColor: `color-mix(in oklab, ${categoryColor(tx.category)} 22%, var(--color-card))`,
            }}
          >
            {name === "—" ? "?" : name.charAt(0).toUpperCase()}
          </span>
          <SheetTitle className="mt-2 max-w-full truncate text-base font-medium">{name}</SheetTitle>
          <div className="mt-1">
            <AmountText tx={tx} large />
          </div>
          {isPaidForOthers(tx) && (
            <p className="mt-1 text-xs text-muted-foreground">Paid for others · not counted</p>
          )}
          <p className="mt-1 text-sm text-muted-foreground">
            {formatBookingDate(tx.booking_date)} · {p.accountLabel}
          </p>
        </SheetHeader>
        <div className="space-y-4 px-4 pb-4">
          {askWorthIt && (
            <div
              role="group"
              aria-label="Worth it?"
              className="flex items-center justify-between gap-3 rounded-lg bg-card px-4 py-3"
            >
              <span className="text-[0.9375rem] font-medium text-foreground">Worth it?</span>
              <span className="flex gap-2">
                <Button variant="secondary" onClick={() => p.onAnswerWorthIt("yes")}>
                  <ThumbsUp /> Yes
                </Button>
                <Button variant="secondary" onClick={() => p.onAnswerWorthIt("no")}>
                  <ThumbsDown /> No
                </Button>
              </span>
            </div>
          )}
          <GroupedList>
            <Field label="Name">
              <NameEditor
                name={name === "—" ? null : name}
                onSave={p.onRename}
                saving={p.savingRename}
              />
            </Field>
            {p.onSaveAmount && (
              <Field label="Amount">
                <AmountEditor
                  amount={Math.abs(tx.amount ?? 0)}
                  currency={tx.currency ?? "EUR"}
                  onSave={p.onSaveAmount}
                  saving={p.savingAmount ?? false}
                />
              </Field>
            )}
            <Field label="Category">
              <CategoryPicker
                tx={tx}
                onSelect={(c) => p.onSelectCategory(c, { inSheet: true })}
                saving={p.savingCategory}
              />
            </Field>
            {p.makeRule && (
              <button
                type="button"
                onClick={p.makeRule.onClick}
                className="flex min-h-12 w-full items-center px-4 text-left text-sm font-medium hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                {p.makeRule.label}
              </button>
            )}
            {!share && (
              <>
                <Field label="Type">
                  <TypePicker tx={tx} onSelect={p.onSelectType} saving={p.savingType} />
                </Field>
                <Field label="Split">
                  <SplitEditor
                    tx={tx}
                    onSave={p.onSaveSplit}
                    saving={p.savingSplit}
                    contacts={p.splitContacts}
                  />
                </Field>
              </>
            )}
          </GroupedList>
          {!share && (p.onSaveNote || p.onSaveTags) && (
            <GroupedList>
              {p.onSaveNote && (
                <div className="space-y-1.5 px-4 py-3">
                  <label
                    htmlFor={`${fieldId}-note`}
                    className="block text-sm text-muted-foreground"
                  >
                    Note
                  </label>
                  <NoteEditor
                    id={`${fieldId}-note`}
                    note={tx.note}
                    onSave={p.onSaveNote}
                    saving={p.savingNote ?? false}
                  />
                </div>
              )}
              {p.onSaveTags && (
                <div className="space-y-1.5 px-4 py-3">
                  <label
                    htmlFor={`${fieldId}-tags`}
                    className="block text-sm text-muted-foreground"
                  >
                    Tags
                  </label>
                  <TagEditor
                    id={`${fieldId}-tags`}
                    tags={tx.tags}
                    onSave={p.onSaveTags}
                    saving={p.savingTags ?? false}
                    suggestions={p.tagSuggestions}
                  />
                </div>
              )}
            </GroupedList>
          )}
          {!share && tx.worth_it != null && (
            <GroupedList>
              <Field label="Worth it">
                <WorthItPrompt tx={tx} onAnswer={p.onAnswerWorthIt} />
              </Field>
            </GroupedList>
          )}
          <RefundedBadge flowType={tx.flow_type} />
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** The sheet's ⋯ menu: actions you rarely need while reading one transaction. */
function SheetMoreMenu({
  selected,
  onToggleSelect,
}: {
  selected: boolean;
  onToggleSelect: () => void;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="More actions"
          className="absolute top-2 left-2 size-11"
        >
          <MoreHorizontal />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-1">
        <label className="flex min-h-11 cursor-pointer items-center justify-between gap-4 rounded-sm px-3 text-sm hover:bg-accent">
          <span>Select</span>
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggleSelect}
            className="size-5 rounded border-border accent-primary"
          />
        </label>
      </PopoverContent>
    </Popover>
  );
}

/** Desktop row: date, merchant (its category icon opens the category picker), amount with its account. Type, split and the rest sit behind ›. */
export function TransactionRowView(props: TransactionViewProps) {
  const { tx, accountLabel, selected, onToggleSelect, highlighted, showAccount = true } = props;
  const [open, setOpen] = useState(false);
  const show = (o: boolean) => {
    setOpen(o);
    props.onOpenChange?.(o);
  };
  // A Splitwise share lives in its own table: nothing here can edit, select or delete it.
  const share = isSplitwiseShare(tx);
  const notes = [
    tx.category ?? "Uncategorized",
    tx.transaction_type,
    isSplit(tx)
      ? `split, ${tx.credit_debit_indicator === "CRDT" ? "not mine" : "owed"} ${formatMoney(Math.abs(tx.amount ?? 0) - myShare(tx), tx.currency ?? "EUR")}`
      : null,
    tagLine(tx) || null,
  ].filter(Boolean);

  return (
    <tr
      data-entry-ref={tx.entry_reference}
      className={`border-b transition-colors last:border-0 hover:bg-accent ${selected ? "bg-primary/10" : ""} ${highlighted ? "ring-2 ring-inset ring-primary" : ""}`}
    >
      <td className="px-4 py-3">
        {!share && (
          <label className="-m-3.5 inline-flex size-11 cursor-pointer items-center justify-center p-3.5">
            <input
              type="checkbox"
              aria-label={`Select ${cleanMerchantName(tx.creditor_name) ?? "transaction"}`}
              checked={selected}
              onChange={onToggleSelect}
              className="size-4 rounded border-border accent-primary"
            />
          </label>
        )}
      </td>
      <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">
        {formatBookingDateShort(tx.booking_date)}
      </td>
      <td className="w-full max-w-0 px-4 py-3">
        <div className="flex items-center gap-3">
          <CategoryPicker
            tx={tx}
            onSelect={props.onSelectCategory}
            saving={props.savingCategory}
            variant="icon"
          />
          <div className="min-w-0">
            <div className="truncate font-medium text-foreground">
              <NameEditor
                name={cleanMerchantName(tx.creditor_name)}
                onSave={props.onRename}
                saving={props.savingRename}
              />
            </div>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="truncate">{(share ? notes.slice(0, 1) : notes).join(" · ")}</span>
              <WorthItHint tx={tx} />
            </div>
            {tx.note && (
              <div className="truncate text-xs text-muted-foreground italic" title={tx.note}>
                {tx.note}
              </div>
            )}
            <RefundedBadge flowType={tx.flow_type} />
          </div>
        </div>
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center justify-end gap-3">
          <AmountText tx={tx} />
          {(share || showAccount) && <AccountBadge label={share ? "Splitwise" : accountLabel} />}
        </div>
      </td>
      <td className="w-12 px-2 py-3 text-right">
        {!share && (
          <>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => show(true)}
              aria-label={`Edit ${cleanMerchantName(tx.creditor_name) ?? "transaction"}`}
            >
              <ChevronRight className="size-4" />
            </Button>
            <TransactionEditSheet {...props} open={open} onOpenChange={show} />
          </>
        )}
      </td>
    </tr>
  );
}

/** Phone row: a clean read-only line under its day heading; every editor lives in the sheet that a tap opens. */
export function TransactionCardView(props: TransactionViewProps) {
  const { tx, selected, highlighted } = props;
  const [open, setOpen] = useState(false);
  const show = (o: boolean) => {
    setOpen(o);
    props.onOpenChange?.(o);
  };
  const share = isSplitwiseShare(tx);

  const summary = (
    <>
      <CategoryAvatar category={tx.category} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[0.9375rem] font-medium text-foreground">
          {cleanMerchantName(tx.creditor_name) ?? "—"}
        </p>
        <p className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-muted-foreground">
          {share && (
            <span title="Splitwise" className="inline-flex shrink-0">
              <Users className="size-3" aria-hidden />
            </span>
          )}
          <span className="truncate">
            {[
              tx.category ?? "Uncategorized",
              tx.flow_type === "refunded" ? "Refunded" : null,
              tagLine(tx) || null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
          <WorthItHint tx={tx} />
        </p>
        {tx.note && (
          <p className="mt-0.5 truncate text-xs text-muted-foreground italic" title={tx.note}>
            {tx.note}
          </p>
        )}
      </div>
      <AmountText tx={tx} />
    </>
  );

  const rowClass = `${selected ? "bg-primary/10" : ""} ${highlighted ? "ring-2 ring-inset ring-primary" : ""}`;

  return (
    <li data-entry-ref={tx.entry_reference} className={rowClass}>
      <button
        type="button"
        onClick={() => show(true)}
        className="flex min-h-16 w-full items-center gap-3 px-4 py-3 text-left active:bg-accent"
      >
        {summary}
      </button>
      <TransactionEditSheet {...props} open={open} onOpenChange={show} />
    </li>
  );
}
