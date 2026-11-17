import { ambiguousNumberHint, formatQuantity, inputNumber } from "@/lib/locale";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Pencil, Trash2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/field";
import { formatDay } from "@/lib/date";
import { inOrder, localToday, netShares, parseTypedAmount } from "@/lib/trades";
import { parseQuantity } from "@/lib/holdings";
import { formatEur } from "@/lib/transactions";
import { cn } from "@/lib/utils";
import type { SavedTrade } from "@/lib/use-performance";

interface Form {
  side: string;
  date: string;
  shares: string;
  price: string;
  fee: string;
}

const blank = (): Form => ({ side: "buy", date: localToday(), shares: "", price: "", fee: "" });

function validate(form: Form) {
  const shares = parseQuantity(form.shares);
  const price = parseTypedAmount(form.price);
  const fee = form.fee.trim() === "" ? 0 : parseTypedAmount(form.fee);
  if (!form.date) return { error: "Pick the date of the trade." };
  if (form.date > localToday()) return { error: "The date can't be in the future." };
  if (shares == null)
    return { error: ambiguousNumberHint(form.shares) ?? "Shares must be a number above zero." };
  if (price == null) return { error: ambiguousNumberHint(form.price) ?? "Price must be a number." };
  if (fee == null) return { error: ambiguousNumberHint(form.fee) ?? "Fee must be a number." };
  return {
    values: {
      side: form.side,
      trade_date: form.date,
      shares,
      price_eur: price,
      fee_eur: fee,
    },
  };
}

/** "bought 2 on 1 Mar 2026": names a trade for a screen reader. */
const tradeName = (t: SavedTrade) =>
  `${t.side === "buy" ? "bought" : "sold"} ${formatQuantity(t.shares, 8)} on ${formatDay(t.trade_date)}`;

/** A buy saved at €0.00: shares moved in from another broker, whose price the file didn't give. */
export const hasMissingPrice = (trades: Array<Pick<SavedTrade, "side" | "price_eur">>) =>
  trades.some((t) => t.side === "buy" && t.price_eur === 0);

/** Every buy and sell of one holding: add, correct or remove them. */
export function TradesDialog({
  kind,
  holdingKey,
  name,
  quantity,
  trades,
  label,
}: {
  kind: "stock" | "crypto";
  holdingKey: string;
  name: string;
  quantity: number;
  trades: Array<SavedTrade>;
  label: React.ReactNode;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<Form>(blank);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const done = (message: string, clearForm = true) => {
    toast.success(message);
    void queryClient.invalidateQueries({ queryKey: ["holding-trades"] });
    void queryClient.invalidateQueries({ queryKey: ["holding-performance"] });
    if (clearForm) {
      setForm(blank());
      setEditing(null);
    }
    setError(null);
  };
  const failed = (err: Error) => setError(err.message);

  const save = useMutation({
    mutationFn: async (values: NonNullable<ReturnType<typeof validate>["values"]>) => {
      if (editing) {
        // A broker's time is of the old day: kept, it would order the trade among the new day's.
        const was = trades.find((t) => t.id === editing);
        const patch =
          was && was.trade_date !== values.trade_date ? { ...values, traded_at: null } : values;
        const { error: e } = await supabase.from("holding_trades").update(patch).eq("id", editing);
        if (e) throw e;
        return;
      }
      const { data } = await supabase.auth.getUser();
      if (!data.user) throw new Error("You're signed out. Sign in and try again.");
      const { error: e } = await supabase
        .from("holding_trades")
        .insert({ ...values, kind, key: holdingKey, user_id: data.user.id });
      if (e) throw e;
    },
    onSuccess: () => done(editing ? "Trade updated" : "Trade added"),
    onError: failed,
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error: e } = await supabase.from("holding_trades").delete().eq("id", id);
      if (e) throw e;
    },
    // Only the trade you were editing leaves the form: a half-typed new trade stays.
    onSuccess: (_, id) => done("Trade removed", id === editing),
    onError: failed,
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const result = validate(form);
    if (result.values) save.mutate(result.values);
    else setError(result.error);
  }

  function startEdit(t: SavedTrade) {
    setEditing(t.id);
    setError(null);
    setForm({
      side: t.side,
      date: t.trade_date,
      shares: inputNumber(t.shares),
      price: inputNumber(t.price_eur),
      fee: t.fee_eur ? inputNumber(t.fee_eur) : "",
    });
  }
  function cancelEdit() {
    setForm(blank());
    setEditing(null);
    setError(null);
  }

  const set = (field: keyof Form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [field]: e.target.value }));
  // Newest first: the order returns are worked out in, backwards (same day by the broker's time).
  const sorted = inOrder(trades).reverse();
  const net = netShares(trades);

  return (
    <Dialog
      onOpenChange={(open) => {
        // Closing mid-edit must not leave "Save trade" overwriting that trade next time.
        if (!open) {
          setForm(blank());
          setEditing(null);
        }
      }}
    >
      <DialogTrigger
        title={`Trades for ${name}`}
        className="-my-2.5 inline-flex min-h-11 items-center underline-offset-2 hover:underline"
      >
        {label}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{name}</DialogTitle>
          <DialogDescription>
            Trades add up to {formatQuantity(net, 8)}; you hold {formatQuantity(quantity, 8)}.
            Prices are per share, in EUR.
          </DialogDescription>
        </DialogHeader>
        {hasMissingPrice(trades) && (
          <p className="flex items-start gap-2 text-sm">
            <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
            <span>
              A buy has no price, so the return is too high.{" "}
              <button
                type="button"
                className="text-primary underline-offset-2 hover:underline"
                onClick={() =>
                  startEdit(trades.find((t) => t.side === "buy" && t.price_eur === 0)!)
                }
              >
                Edit that trade
              </button>{" "}
              and enter what you paid per share.
            </span>
          </p>
        )}

        <form onSubmit={handleSubmit} className="grid grid-cols-2 gap-3 text-left">
          <div>
            <label className="mb-1 block text-xs text-muted-foreground" htmlFor="trade-side">
              Type
            </label>
            <Select id="trade-side" value={form.side} onChange={set("side")}>
              <option value="buy">Buy</option>
              <option value="sell">Sell</option>
            </Select>
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground" htmlFor="trade-date">
              Date
            </label>
            <Input
              id="trade-date"
              type="date"
              max={localToday()}
              value={form.date}
              onChange={set("date")}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground" htmlFor="trade-shares">
              Shares
            </label>
            <Input
              id="trade-shares"
              inputMode="decimal"
              value={form.shares}
              onChange={set("shares")}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground" htmlFor="trade-price">
              Price per share (EUR)
            </label>
            <Input
              id="trade-price"
              inputMode="decimal"
              value={form.price}
              onChange={set("price")}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground" htmlFor="trade-fee">
              Fee (EUR, optional)
            </label>
            <Input id="trade-fee" inputMode="decimal" value={form.fee} onChange={set("fee")} />
          </div>
          {/* On a phone Cancel sits above Save trade: side by side they don't fit the column. */}
          <div className="flex flex-wrap items-end justify-end gap-2">
            {editing && (
              <Button variant="ghost" onClick={cancelEdit} disabled={save.isPending}>
                Cancel
              </Button>
            )}
            <Button type="submit" disabled={save.isPending} className="flex-1 basis-28">
              {save.isPending && <Loader2 className="size-4 animate-spin" />}
              {editing ? "Save trade" : "Add trade"}
            </Button>
          </div>
          {error && (
            <p role="alert" className="col-span-2 text-sm text-negative">
              {error}
            </p>
          )}
        </form>

        {sorted.length > 0 && (
          <ul className="max-h-64 divide-y divide-hairline overflow-y-auto rounded-lg bg-background text-sm">
            {sorted.map((t) => (
              <li
                key={t.id}
                aria-current={editing === t.id ? "true" : undefined}
                className={cn("flex items-center gap-2 px-3 py-1", editing === t.id && "bg-accent")}
              >
                <span className="min-w-0 flex-1">
                  <span className="font-medium text-foreground">
                    {t.side === "buy" ? "Bought" : "Sold"} {formatQuantity(t.shares, 8)}
                  </span>{" "}
                  at {formatEur(t.price_eur)}
                  <span className="block text-xs text-muted-foreground">
                    {formatDay(t.trade_date)}
                    {t.note && ` · ${t.note}`}
                    {/* Each part stays on one line: "tax" never wraps away from its amount. */}
                    {t.fee_eur > 0 && (
                      <>
                        {" "}
                        <span className="whitespace-nowrap">· fee {formatEur(t.fee_eur)}</span>
                      </>
                    )}
                    {(t.tax_eur ?? 0) > 0 && (
                      <>
                        {" "}
                        <span className="whitespace-nowrap">· tax {formatEur(t.tax_eur!)}</span>
                      </>
                    )}
                  </span>
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Edit: ${tradeName(t)}`}
                  onClick={() => startEdit(t)}
                >
                  <Pencil />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove: ${tradeName(t)}`}
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(t.id)}
                >
                  <Trash2 />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
