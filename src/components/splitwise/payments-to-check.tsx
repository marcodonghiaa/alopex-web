import { useEffect, useId, useRef, useState } from "react";
import { dateLocale } from "@/lib/locale";
import { money } from "@/lib/splits";
import { txId } from "@/lib/transactions";
import {
  owesLine,
  type Debtor,
  type PaybackCandidate,
  type PaybackSuggestion,
} from "@/lib/payback";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/field";
import { GroupedList, SectionTitle } from "@/components/ui/grouped-list";
import { Initial } from "@/components/splitwise/owed-view";

const day = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString(dateLocale(), { day: "numeric", month: "short" });

// Why we ask, and what they owe (left out when the payment is exactly that: it's right above).
const why = (s: PaybackSuggestion, owes: string) => {
  if (s.reason === "amount") return `Exactly what ${s.debtor.name} owes you`;
  const because =
    s.reason === "linked"
      ? `You linked this payer to ${s.debtor.name} before`
      : "The names look alike";
  return `${because} · ${owes}`;
};

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
  const title = useId();
  // Whether the answer we're waiting on has started saving: once it has and ends with its row
  // still here, the save failed and focus stays where it is.
  const started = useRef(false);
  useEffect(() => {
    if (!focusAfter) return;
    const rows = [...(list.current?.querySelectorAll<HTMLElement>("li[data-row]") ?? [])];
    const done = () => {
      started.current = false;
      setFocusAfter(null);
    };
    if (focusAfter.to === "other") {
      rows
        .find((r) => r.dataset["row"] === focusAfter.id)
        ?.querySelector<HTMLElement>("[data-someone-else]")
        ?.focus();
      return done();
    }
    if (busy !== null) {
      started.current = true;
      return; // buttons wait while it saves: focus once it ends
    }
    if (rows.length === 0) return done(); // the last one: nothing left to focus
    if (!rows.some((r) => r.dataset["row"] === focusAfter.id)) {
      rows[0]?.querySelector<HTMLElement>("button")?.focus();
      return done();
    }
    if (started.current) done(); // saved and still here: it failed
  }, [focusAfter, suggestions, choosing, busy]);
  if (suggestions.length === 0) return null;
  const closeForm = (id: string) => {
    setChoosing(null);
    setFocusAfter({ to: "other", id });
  };

  return (
    <section aria-labelledby={title} className="mt-8">
      <SectionTitle id={title}>Did someone pay you back?</SectionTitle>
      <GroupedList>
        <ul ref={list} className="divide-y divide-hairline">
          {suggestions.map((s, i) => {
            const p = s.payment;
            // Each row's buttons are described by its payment line, so they differ out of context.
            const line = `${title}-${i}`;
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
                    <p id={line} className="truncate text-[0.8125rem] text-muted-foreground">
                      <span className="font-figure text-foreground">{amount}</span> from {from} ·{" "}
                      {day(p.booking_date)}
                    </p>
                    <p className="text-[0.8125rem] text-muted-foreground">
                      {why(
                        s,
                        owesLine(s.debtor, (v) => money(v, "EUR")),
                      )}
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
                      // A long name shortens with "…" rather than leaving the card on a phone.
                      className="max-w-full shrink"
                      aria-describedby={line}
                      disabled={saving}
                      onClick={() => {
                        setFocusAfter({ to: "next", id });
                        onConfirm(p, s.debtor);
                      }}
                    >
                      <span className="truncate">Yes, it's {s.debtor.name}</span>
                    </Button>
                    {others.length > 0 && (
                      <Button
                        variant="secondary"
                        data-someone-else
                        aria-describedby={line}
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
                      // A text button: no side inset, so on its own line it lines up with Yes.
                      className="px-0 hover:bg-transparent hover:underline"
                      aria-describedby={line}
                      disabled={saving}
                      onClick={() => {
                        setFocusAfter({ to: "next", id });
                        onDismiss(p, s);
                      }}
                    >
                      Not a payback
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
