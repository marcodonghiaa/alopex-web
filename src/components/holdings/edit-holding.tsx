import { ambiguousNumberHint, inputNumber } from "@/lib/locale";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Pencil } from "lucide-react";
import { toast } from "sonner";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { supabase } from "@/integrations/supabase/client";
import { parseQuantity } from "@/lib/holdings";
import { saveQuantity, type HoldingTarget } from "@/lib/holding-quantity";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { formatISODate } from "@/lib/date";
import { changeTrade, latestPriceEur, recordTrade } from "@/lib/manual-trades";
import { isMissingFunction } from "@/lib/pg-errors";

export type { HoldingTarget } from "@/lib/holding-quantity";

// Deletes the holding for good, with its price history, trades and income rows (database function
// delete_holding): for one added by mistake. Its value also leaves past net worth.
async function deleteHolding(target: HoldingTarget): Promise<void> {
  const { error } = await supabase.rpc("delete_holding", {
    p_kind: target.kind,
    p_key: target.kind === "stock" ? target.isin : target.symbol,
    p_source: target.kind === "crypto" ? target.source : null,
  });
  if (error) {
    throw new Error(
      isMissingFunction(error)
        ? "Deleting needs a database update first: run supabase db push in the backend."
        : error.message,
    );
  }
}

// The change as a buy or sale at today's price, so trades keep matching what you hold. False when
// it couldn't be saved; nothing to save (no change, no price yet) counts as saved.
async function saveChange(target: HoldingTarget, from: number, to: number): Promise<boolean> {
  const key = target.kind === "stock" ? target.isin : target.symbol;
  try {
    const priceEur = await latestPriceEur(supabase, target.kind, key);
    if (priceEur == null) return true;
    const t = changeTrade({
      kind: target.kind,
      key,
      from,
      to,
      date: formatISODate(new Date()),
      priceEur,
    });
    if (t) await recordTrade(supabase, t);
    return true;
  } catch {
    return false;
  }
}

// Change how many you hold, or mark it sold. Sold sets the quantity to 0 instead of deleting the
// row, so the holding's price history (and past net worth) stays.
export function EditHolding({
  target,
  name,
  quantity,
  label,
  tradesMatch = false,
}: {
  target: HoldingTarget;
  name: string;
  quantity: number;
  /** Its trades add up to what you hold: offer to record a change as a trade, to keep it so. */
  tradesMatch?: boolean;
  /** A text button (e.g. "Edit shares") instead of the pencil, for the phone details. */
  label?: string;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(() => inputNumber(quantity));
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [asTrade, setAsTrade] = useState(true);

  const refresh = () => {
    void queryClient.invalidateQueries({
      queryKey: [target.kind === "stock" ? "portfolio-latest" : "crypto-latest"],
    });
    void queryClient.invalidateQueries({ queryKey: ["net-worth-daily"] });
    // Returns compare trades with the quantity held; delete also removes the trades.
    void queryClient.invalidateQueries({ queryKey: ["holding-performance"] });
    void queryClient.invalidateQueries({ queryKey: ["holding-trades"] });
  };

  const remove = useMutation({
    mutationFn: () => deleteHolding(target),
    onSuccess: () => {
      toast.success(`${name} deleted`);
      refresh();
      // Delete also removes its dividends and other events.
      void queryClient.invalidateQueries({ queryKey: ["investment-events"] });
      setOpen(false);
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Couldn't delete"),
  });

  const save = useMutation({
    mutationFn: async (next: number) => {
      await saveQuantity(target, next);
      return tradesMatch && asTrade ? saveChange(target, quantity, next) : true;
    },
    onSuccess: (traded, next) => {
      if (!traded) {
        toast.error(
          `${name}: the ${next < quantity ? "sale" : "buy"} wasn't saved as a trade. Tap its return to add it.`,
        );
      }
      toast.success(next === 0 ? `${name} marked as sold` : `${name} updated`);
      refresh();
      setOpen(false);
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Couldn't save"),
  });

  function handleSave(e: React.FormEvent) {
    e.preventDefault();
    const next = parseQuantity(value);
    if (next == null) {
      setError(ambiguousNumberHint(value) ?? "Enter a number above zero, or use Mark as sold.");
      return;
    }
    setError(null);
    save.mutate(next);
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setValue(inputNumber(quantity));
          setError(null);
          setConfirmDelete(false);
          setAsTrade(true);
        }
      }}
    >
      <PopoverTrigger asChild>
        {label ? (
          <Button variant="ghost" aria-label={`${label} of ${name}`} className="-ml-3 self-start">
            <Pencil />
            {label}
          </Button>
        ) : (
          <Button variant="ghost" size="icon" aria-label={`Edit ${name}`}>
            <Pencil />
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent align="end" className="space-y-3">
        <form onSubmit={handleSave} className="space-y-3">
          <label className="block text-xs text-muted-foreground" htmlFor={`qty-${name}`}>
            How many you hold now
          </label>
          <div className="flex gap-2">
            <Input
              id={`qty-${name}`}
              inputMode="decimal"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="flex-1"
            />
            <Button type="submit" disabled={save.isPending}>
              {save.isPending && <Loader2 className="size-4 animate-spin" />}
              Save
            </Button>
          </div>
          {tradesMatch && (
            <label className="flex items-start gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={asTrade}
                onChange={(e) => setAsTrade(e.target.checked)}
                className="mt-0.5 accent-primary"
              />
              Record the change as a buy or sale at today's price
            </label>
          )}
        </form>
        <Button
          variant="destructive"
          onClick={() => save.mutate(0)}
          disabled={save.isPending}
          className="w-full"
        >
          Mark as sold
        </Button>
        {confirmDelete ? (
          <div className="space-y-2 rounded-lg bg-negative/10 p-3">
            <p className="text-xs text-foreground">
              Deletes {name}, its price history, trades, and its dividends, interest, fees and taxes
              in Income and costs. It also leaves your past net worth. Sold it? Use Mark as sold
              instead.
            </p>
            <div className="flex gap-2">
              <Button variant="quiet" onClick={() => setConfirmDelete(false)} className="flex-1">
                Cancel
              </Button>
              <Button
                onClick={() => remove.mutate()}
                disabled={remove.isPending}
                className="flex-1 bg-negative text-white"
              >
                {remove.isPending && <Loader2 className="size-4 animate-spin" />}
                Delete for good
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="ghost" onClick={() => setConfirmDelete(true)} className="w-full">
            Delete
          </Button>
        )}
        {error && (
          <p role="alert" className="text-sm text-negative">
            {error}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
