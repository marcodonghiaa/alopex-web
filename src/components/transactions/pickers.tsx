import { useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { TRANSACTION_TYPES, categoryColor } from "@/lib/categories";
import { useCategories } from "@/lib/use-categories";
import type { TransactionRow } from "@/lib/transactions";
import { CategoryAvatar } from "@/components/category-avatar";
import { cleanMerchantName } from "@/lib/merchant-name";

// A save in flight: a small spinner inside the chip, so a dimmed chip reads as "saving".
const SavingSpinner = () => (
  <Loader2 data-testid="picker-spinner" aria-hidden className="size-3 shrink-0 animate-spin" />
);

export function CategoryPicker({
  tx,
  onSelect,
  saving,
  variant = "pill",
}: {
  tx: Pick<TransactionRow, "category" | "creditor_name">;
  onSelect: (category: string) => void;
  saving: boolean;
  // "icon": the row's round category icon is the trigger (desktop table rows).
  variant?: "pill" | "icon";
}) {
  const [open, setOpen] = useState(false);
  const categories = useCategories().list;

  return (
    // Locked while saving like TypePicker: aria-disabled and this guard keep the trigger focusable.
    <Popover modal open={open} onOpenChange={(next) => setOpen(next && saving ? false : next)}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Change category for ${cleanMerchantName(tx.creditor_name) ?? "transaction"}`}
          aria-disabled={saving || undefined}
          aria-busy={saving || undefined}
          className="-m-2 inline-flex min-h-11 cursor-pointer items-center p-2 aria-disabled:cursor-default aria-disabled:opacity-60"
        >
          {variant === "icon" ? (
            <span className="rounded-sm transition-opacity hover:opacity-80">
              <CategoryAvatar category={tx.category} />
            </span>
          ) : tx.category ? (
            <span
              className="inline-flex min-w-24 items-center justify-center gap-1.5 rounded-sm border px-2.5 py-0.5 text-xs font-medium text-foreground transition-colors"
              style={{
                backgroundColor: `color-mix(in srgb, ${categoryColor(tx.category)} 16%, transparent)`,
                borderColor: `color-mix(in srgb, ${categoryColor(tx.category)} 45%, transparent)`,
              }}
            >
              <span
                aria-hidden
                className="inline-block size-1.5 rounded-full"
                style={{ backgroundColor: categoryColor(tx.category) }}
              />
              {tx.category}
              {saving && <SavingSpinner />}
            </span>
          ) : (
            <span className="inline-flex min-w-24 items-center justify-center gap-1.5 rounded-sm border border-dashed px-2.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent">
              Uncategorized
              {saving && <SavingSpinner />}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-48 p-1">
        <div className="max-h-72 overflow-y-auto">
          {categories.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => {
                setOpen(false);
                if (c !== tx.category) onSelect(c);
              }}
              className={`block min-h-11 w-full rounded-sm px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-accent ${
                c === tx.category ? "font-medium text-primary" : "text-foreground"
              }`}
            >
              {c}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function BulkCategoryPicker({
  onSelect,
  disabled,
}: {
  onSelect: (category: string) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const categories = useCategories().list;

  return (
    <Popover modal open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className="inline-flex h-9 items-center rounded-sm border bg-background px-3 text-sm font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-60"
        >
          {disabled ? "Saving…" : "Set category…"}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-48 p-1">
        <div className="max-h-72 overflow-y-auto">
          {categories.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => {
                setOpen(false);
                onSelect(c);
              }}
              className="block min-h-11 w-full rounded-sm px-2.5 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-accent"
            >
              {c}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function TypePicker({
  tx,
  onSelect,
  saving,
}: {
  tx: TransactionRow;
  onSelect: (type: string) => void;
  saving: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    // Locked while a save is pending (polish-3 F8), but with aria-disabled and this guard instead
    // of native disabled: a disabled trigger can't take focus back, so it fell to <body>.
    <Popover modal open={open} onOpenChange={(next) => setOpen(next && saving ? false : next)}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Change type for ${cleanMerchantName(tx.creditor_name) ?? "transaction"}`}
          aria-disabled={saving || undefined}
          aria-busy={saving || undefined}
          className="-m-2 inline-flex min-h-11 cursor-pointer items-center p-2 aria-disabled:cursor-default aria-disabled:opacity-60"
        >
          {tx.transaction_type ? (
            <span className="inline-flex min-w-24 items-center justify-center gap-1.5 rounded-sm border border-border bg-card px-2.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent">
              {tx.transaction_type}
              {saving && <SavingSpinner />}
            </span>
          ) : (
            <span className="inline-flex min-w-24 items-center justify-center gap-1.5 rounded-sm border border-dashed px-2.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent">
              —{saving && <SavingSpinner />}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-48 p-1">
        <div className="max-h-72 overflow-y-auto">
          {TRANSACTION_TYPES.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => {
                setOpen(false);
                // Every pick saves, the same type too: that is how you claim a type the AI set.
                onSelect(t);
              }}
              // The current type: a check like the frequency picker's, and a state screen readers hear.
              aria-pressed={t === tx.transaction_type}
              className={`flex min-h-11 w-full items-center justify-between rounded-sm px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-accent ${
                t === tx.transaction_type ? "font-medium text-primary" : "text-foreground"
              }`}
            >
              {t}
              {t === tx.transaction_type && <Check className="size-4 text-primary" />}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
