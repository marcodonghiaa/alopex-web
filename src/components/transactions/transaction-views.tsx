import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  ChevronRight,
  MoreHorizontal,
  PanelBottomOpen,
  Tag,
  ThumbsDown,
  ThumbsUp,
  Users,
} from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { categoryColor, UNCATEGORIZED_LABEL } from "@/lib/categories";
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
  formatDayHeading,
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
import { RowMenu, type RowMenuItem } from "./row-menu";
import { useRowGestures } from "@/components/ui/row-gestures";

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
  /** onlyThis: rename just this row, not every one from its merchant. */
  onRename: (name: string | null, onlyThis: boolean) => void;
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
          tx.pending ? "text-muted-foreground" : positive ? "text-positive" : "text-foreground"
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
// A row's quick action opens the sheet straight on that editor.
type QuickAction = "split" | "category";

function TransactionEditSheet({
  open,
  onOpenChange,
  quick,
  ...p
}: TransactionViewProps & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  quick?: QuickAction | null;
}) {
  const isMobile = useIsMobile();
  const fields = useRef<HTMLDivElement>(null);
  // Once the sheet has slid in (350ms), open the asked-for editor as if its button were tapped.
  useEffect(() => {
    if (!open || !quick) return;
    const t = setTimeout(
      () => fields.current?.querySelector<HTMLElement>(`[data-quick="${quick}"]`)?.click(),
      380,
    );
    return () => clearTimeout(t);
  }, [open, quick]);
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
          {!share && !tx.pending && (
            <SheetMoreMenu selected={p.selected} onToggleSelect={p.onToggleSelect} />
          )}
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
        {tx.pending ? (
          <p className="px-6 pb-6 text-center text-sm text-muted-foreground">
            Pending: the bank hasn't confirmed this payment yet. You can edit it once it does,
            usually within a few days.
          </p>
        ) : (
          <div ref={fields} className="space-y-4 px-4 pb-4">
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
                  scoped={!share}
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
                  <WorthItPrompt tx={tx} />
                </Field>
              </GroupedList>
            )}
            <RefundedBadge flowType={tx.flow_type} />
          </div>
        )}
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

/** What others owe (money in: the part that isn't mine), or null when the row isn't split. */
function splitNote(tx: TransactionRow): string | null {
  if (!isSplit(tx)) return null;
  const rest = formatMoney(Math.abs(tx.amount ?? 0) - myShare(tx), tx.currency ?? "EUR");
  return `split, ${tx.credit_debit_indicator === "CRDT" ? "not mine" : "owed"} ${rest}`;
}

/** Desktop day heading: a full-width row in the table, so rows under it keep the table's columns. */
export function DayHeaderRow({ day, colSpan }: { day: string | null; colSpan: number }) {
  return (
    <tr className="border-b bg-background/40">
      <th
        scope="colgroup"
        colSpan={colSpan}
        className="px-4 pt-4 pb-2 text-left text-[0.8125rem] leading-tight font-medium text-muted-foreground"
      >
        {formatDayHeading(day)}
      </th>
    </tr>
  );
}

/** Desktop row (under its day heading): merchant (its category icon opens the category picker), amount with its account. Type, split and the rest sit behind ›. */
export function TransactionRowView(props: TransactionViewProps) {
  const { tx, accountLabel, selected, onToggleSelect, highlighted, showAccount = true } = props;
  const [open, setOpen] = useState(false);
  const show = (o: boolean) => {
    setOpen(o);
    props.onOpenChange?.(o);
  };
  // A Splitwise share lives in its own table: nothing here can edit, select or delete it.
  const share = isSplitwiseShare(tx);
  // Pending: the next sync swaps it for the booked row, so nothing on it can change.
  const pending = !!tx.pending;
  const notes = [
    pending ? "Pending" : null,
    tx.category ?? UNCATEGORIZED_LABEL,
    tx.transaction_type,
    splitNote(tx),
    tagLine(tx) || null,
  ].filter(Boolean);

  return (
    <tr
      data-entry-ref={tx.entry_reference}
      className={`border-b transition-colors last:border-0 hover:bg-accent ${selected ? "bg-primary/10" : ""} ${highlighted ? "ring-2 ring-inset ring-primary" : ""}`}
    >
      <td className="px-4 py-3">
        {!share && !pending && (
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
      <td className="w-full max-w-0 px-2 py-3 lg:px-4">
        <div className="flex items-center gap-3">
          {pending ? (
            <CategoryAvatar category={tx.category} />
          ) : (
            <CategoryPicker
              tx={tx}
              onSelect={props.onSelectCategory}
              saving={props.savingCategory}
              variant="icon"
            />
          )}
          <div className="min-w-0">
            <div className="truncate font-medium text-foreground">
              {pending ? (
                (cleanMerchantName(tx.creditor_name) ?? "—")
              ) : (
                <NameEditor
                  name={cleanMerchantName(tx.creditor_name)}
                  onSave={props.onRename}
                  saving={props.savingRename}
                  scoped={!share}
                />
              )}
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
      <td className="px-2 py-3 lg:px-4">
        <div className="flex items-center justify-end gap-3">
          <AmountText tx={tx} />
          {(share || showAccount) && <AccountBadge label={share ? "Splitwise" : accountLabel} />}
        </div>
      </td>
      <td className="w-12 px-2 py-3 text-right">
        {!share && !pending && (
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

/** Phone row: a clean read-only line under its day heading; every editor lives in the sheet that a tap opens.
 * Like an iOS list row it also swipes left to reveal quick actions, and a long press opens them as a menu.
 * A pending row has neither: the next sync swaps it for the booked row, so nothing on it can change. */
export function TransactionCardView(props: TransactionViewProps) {
  return props.tx.pending ? <PendingCardView {...props} /> : <BookedCardView {...props} />;
}

function PendingCardView(props: TransactionViewProps) {
  const { tx, highlighted } = props;
  const [open, setOpen] = useState(false);
  const show = (o: boolean) => {
    setOpen(o);
    props.onOpenChange?.(o);
  };
  return (
    <li
      data-entry-ref={tx.entry_reference}
      className={highlighted ? "ring-2 ring-inset ring-primary" : ""}
    >
      <button
        type="button"
        onClick={() => show(true)}
        className="flex min-h-16 w-full items-center gap-3 bg-card px-4 py-3 text-left active:bg-accent"
      >
        <CategoryAvatar category={tx.category} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[0.9375rem] font-medium text-foreground">
            {cleanMerchantName(tx.creditor_name) ?? "—"}
          </p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            Pending · {tx.category ?? UNCATEGORIZED_LABEL}
          </p>
        </div>
        <AmountText tx={tx} />
      </button>
      <TransactionEditSheet {...props} open={open} onOpenChange={show} />
    </li>
  );
}

function BookedCardView(props: TransactionViewProps) {
  const { tx, selected, highlighted } = props;
  const [open, setOpen] = useState(false);
  const [quick, setQuick] = useState<QuickAction | null>(null);
  const [menuAt, setMenuAt] = useState<DOMRect | null>(null);
  const surface = useRef<HTMLLIElement>(null);
  const face = useRef<HTMLButtonElement>(null);
  const show = (o: boolean, action: QuickAction | null = null) => {
    setQuick(o ? action : null);
    setOpen(o);
    props.onOpenChange?.(o);
  };
  const share = isSplitwiseShare(tx);
  const name = cleanMerchantName(tx.creditor_name) ?? "transaction";

  // A Splitwise share is already split there: only its category can change here.
  const quickActions: Array<{ action: QuickAction; label: string; icon: typeof Tag }> = [
    ...(share ? [] : [{ action: "split" as const, label: "Split", icon: Users }]),
    { action: "category", label: "Category", icon: Tag },
  ];
  const actions: Array<RowMenuItem & { action: QuickAction }> = quickActions.map((a) => ({
    ...a,
    onSelect: () => run(a.action),
  }));
  const ACTION_W = 72;
  const swipe = useRowGestures({
    surface,
    content: face,
    width: actions.length * ACTION_W,
    onLongPress: () => face.current && setMenuAt(face.current.getBoundingClientRect()),
  });
  function run(action: QuickAction) {
    swipe.close();
    setMenuAt(null);
    show(true, action);
  }

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
              tx.category ?? UNCATEGORIZED_LABEL,
              tx.flow_type === "refunded" ? "Refunded" : null,
              splitNote(tx),
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

  // The face is opaque so the actions behind it only show where it slides away.
  const faceBg = selected
    ? "bg-[color-mix(in_oklab,var(--color-primary)_10%,var(--color-card))]"
    : "bg-card";

  return (
    <li
      ref={surface}
      data-entry-ref={tx.entry_reference}
      className={`relative overflow-hidden ${highlighted ? "ring-2 ring-inset ring-primary" : ""}`}
    >
      <div
        aria-hidden={!swipe.open}
        className="absolute inset-y-0 right-0 flex items-center justify-end"
      >
        {actions.map((a, i) => (
          <button
            key={a.action}
            type="button"
            tabIndex={swipe.open ? 0 : -1}
            onClick={a.onSelect}
            className="flex w-[72px] flex-col items-center gap-1 text-[0.6875rem] font-medium text-muted-foreground"
          >
            <span
              className={`flex size-11 items-center justify-center rounded-full ${i === 0 ? "bg-foreground text-background" : "bg-accent text-foreground"}`}
            >
              <a.icon className="size-5" aria-hidden />
            </span>
            {a.label}
          </button>
        ))}
      </div>
      <button
        ref={face}
        type="button"
        onClick={() => show(true)}
        style={{ touchAction: "pan-y" }}
        className={`relative flex min-h-16 w-full items-center gap-3 px-4 py-3 text-left active:bg-accent ${faceBg}`}
      >
        {summary}
      </button>
      {menuAt && (
        <RowMenu
          title={`Actions for ${name}`}
          rect={menuAt}
          preview={summary}
          items={[
            ...actions,
            {
              label: "Details",
              icon: PanelBottomOpen,
              onSelect: () => (setMenuAt(null), show(true)),
            },
          ]}
          onClose={() => setMenuAt(null)}
        />
      )}
      <TransactionEditSheet {...props} open={open} onOpenChange={(o) => show(o)} quick={quick} />
    </li>
  );
}
