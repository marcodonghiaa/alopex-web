import { useState } from "react";
import { dateLocale } from "@/lib/locale";
import { money } from "@/lib/splits";
import { txId } from "@/lib/transactions";
import type { Debtor, PaybackCandidate, PaybackSuggestion } from "@/lib/payback";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/field";
import { GroupedList, SectionTitle } from "@/components/ui/grouped-list";
import { Initial } from "@/components/splitwise/owed-view";

const day = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString(dateLocale(), { day: "numeric", month: "short" });

const why = (s: PaybackSuggestion) =>
  s.reason === "linked"
    ? `${s.debtor.name} paid you from this name before`
    : s.reason === "name"
      ? "The name looks alike"
      : `Same as what ${s.debtor.name} owes you`;

/**
 * Incoming payments that look like someone paying you back: "Is this Anna?". Yes settles their
 * bills and remembers the payer's name; "Someone else" picks another person who owes you; "Not a
 * payback" stops asking about this payment.
 */
export function PaymentsToCheck({
  suggestions,
  debtors,
  busy,
  onConfirm,
  onDismiss,
}: {
  suggestions: Array<PaybackSuggestion>;
  debtors: Array<Debtor>;
  /** The payment being saved, if any: its buttons wait. */
  busy: string | null;
  onConfirm: (payment: PaybackCandidate, debtor: Debtor) => void;
  onDismiss: (payment: PaybackCandidate, suggestion: PaybackSuggestion) => void;
}) {
  const [choosing, setChoosing] = useState<string | null>(null);
  if (suggestions.length === 0) return null;

  return (
    <section aria-label="Payments to check" className="mt-8">
      <SectionTitle>Did someone pay you back?</SectionTitle>
      <GroupedList>
        <ul className="divide-y divide-hairline">
          {suggestions.map((s) => {
            const p = s.payment;
            const id = txId(p);
            const amount = money(p.amount, p.currency);
            const from = p.payer ?? "an unnamed payer";
            const saving = busy === id;
            const others = debtors.filter((d) => d.name !== s.debtor.name);
            return (
              <li key={id} className="px-4 py-3 sm:px-5">
                <div className="flex items-start gap-3">
                  <Initial name={s.debtor.name} />
                  <div className="min-w-0 flex-1">
                    <p className="text-[0.9375rem] font-medium">Is this {s.debtor.name}?</p>
                    <p className="truncate text-[0.8125rem] text-muted-foreground">
                      <span className="font-figure text-foreground">{amount}</span> from {from} ·{" "}
                      {day(p.booking_date)}
                    </p>
                    <p className="text-[0.8125rem] text-muted-foreground">
                      {why(s)} · owes you {money(s.debtor.open, "EUR")}
                    </p>
                  </div>
                </div>
                {choosing === id ? (
                  <form
                    className="mt-3 flex flex-wrap items-center gap-2 sm:pl-[3.25rem]"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const name = new FormData(e.currentTarget).get("who");
                      const d = debtors.find((x) => x.name === name);
                      if (d) {
                        setChoosing(null);
                        onConfirm(p, d);
                      }
                    }}
                  >
                    <label className="sr-only" htmlFor={`who-${id}`}>
                      Who paid you {amount}?
                    </label>
                    <Select
                      id={`who-${id}`}
                      name="who"
                      className="w-full sm:w-56"
                      defaultValue={others[0]?.name}
                      autoFocus
                    >
                      {others.map((d) => (
                        <option key={d.name} value={d.name}>
                          {d.name} · owes {money(d.open, "EUR")}
                        </option>
                      ))}
                    </Select>
                    <Button type="submit" disabled={saving || others.length === 0}>
                      Confirm
                    </Button>
                    <Button variant="ghost" onClick={() => setChoosing(null)}>
                      Cancel
                    </Button>
                  </form>
                ) : (
                  <div className="mt-3 flex flex-wrap gap-2 sm:pl-[3.25rem]">
                    <Button disabled={saving} onClick={() => onConfirm(p, s.debtor)}>
                      Yes, it's {s.debtor.name}
                    </Button>
                    {others.length > 0 && (
                      <Button variant="secondary" disabled={saving} onClick={() => setChoosing(id)}>
                        Someone else
                      </Button>
                    )}
                    <Button variant="ghost" disabled={saving} onClick={() => onDismiss(p, s)}>
                      {s.reason === "linked" ? `Not ${s.debtor.name}` : "Not a payback"}
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </GroupedList>
    </section>
  );
}
