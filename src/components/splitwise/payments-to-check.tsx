import { useEffect, useRef, useState } from "react";
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
  /** The payment being saved, if any: while it saves, every row waits. */
  busy: string | null;
  onConfirm: (payment: PaybackCandidate, debtor: Debtor) => void;
  onDismiss: (payment: PaybackCandidate, suggestion: PaybackSuggestion) => void;
}) {
  const [choosing, setChoosing] = useState<string | null>(null);
  // Who you picked under "Someone else", by name: if they leave the list while the form is open,
  // the select shows no one rather than whoever is now first.
  const [pick, setPick] = useState("");
  // Where focus goes next: back to a row's "Someone else" when its form closes, or to the next
  // row once an answered one leaves the list.
  const [focusAfter, setFocusAfter] = useState<{ to: "other" | "next"; id: string } | null>(null);
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (!focusAfter || !list.current) return;
    const rows = [...list.current.querySelectorAll<HTMLElement>("li[data-row]")];
    if (focusAfter.to === "other") {
      rows
        .find((r) => r.dataset["row"] === focusAfter.id)
        ?.querySelector<HTMLElement>("[data-someone-else]")
        ?.focus();
      setFocusAfter(null);
    } else if (!rows.some((r) => r.dataset["row"] === focusAfter.id)) {
      rows[0]?.querySelector<HTMLElement>("button")?.focus();
      setFocusAfter(null);
    }
  }, [focusAfter, suggestions, choosing]);
  if (suggestions.length === 0) return null;
  const closeForm = (id: string) => {
    setChoosing(null);
    setFocusAfter({ to: "other", id });
  };

  return (
    <section aria-label="Payments to check" className="mt-8">
      <SectionTitle>Did someone pay you back?</SectionTitle>
      <GroupedList>
        <ul ref={list} className="divide-y divide-hairline">
          {suggestions.map((s) => {
            const p = s.payment;
            const id = txId(p);
            const amount = money(p.amount, p.currency);
            const from = p.payer ?? "an unnamed payer";
            // One answer at a time (the server takes them one by one too): every row waits.
            const saving = busy !== null;
            const others = debtors.filter((d) => d.name !== s.debtor.name);
            return (
              <li key={id} data-row={id} className="px-4 py-3 sm:px-5">
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
                    onKeyDown={(e) => {
                      if (e.key === "Escape") closeForm(id);
                    }}
                    onSubmit={(e) => {
                      e.preventDefault();
                      const d = others.find((x) => x.name === pick);
                      if (d) {
                        setChoosing(null);
                        setFocusAfter({ to: "next", id });
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
                      value={others.some((d) => d.name === pick) ? pick : ""}
                      onChange={(e) => setPick(e.target.value)}
                      autoFocus
                    >
                      {!others.some((d) => d.name === pick) && (
                        <option value="" disabled>
                          Choose who paid you
                        </option>
                      )}
                      {others.map((d) => (
                        <option key={d.name} value={d.name}>
                          {d.name} · owes {money(d.open, "EUR")}
                        </option>
                      ))}
                    </Select>
                    <Button type="submit" disabled={saving || others.length === 0}>
                      Confirm
                    </Button>
                    <Button variant="ghost" onClick={() => closeForm(id)}>
                      Cancel
                    </Button>
                  </form>
                ) : (
                  <div className="mt-3 flex flex-wrap gap-2 sm:pl-[3.25rem]">
                    <Button
                      disabled={saving}
                      onClick={() => {
                        setFocusAfter({ to: "next", id });
                        onConfirm(p, s.debtor);
                      }}
                    >
                      Yes, it's {s.debtor.name}
                    </Button>
                    {others.length > 0 && (
                      <Button
                        variant="secondary"
                        data-someone-else
                        disabled={saving}
                        onClick={() => {
                          setPick(others[0]?.name ?? "");
                          setChoosing(id);
                        }}
                      >
                        Someone else
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      disabled={saving}
                      onClick={() => {
                        setFocusAfter({ to: "next", id });
                        onDismiss(p, s);
                      }}
                    >
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
