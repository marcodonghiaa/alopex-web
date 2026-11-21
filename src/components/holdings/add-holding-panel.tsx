import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Loader2, Plus, Search } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { parseQuantity } from "@/lib/holdings";
import { formatISODate } from "@/lib/date";
import { addedTrade, latestPriceEur, recordTrade } from "@/lib/manual-trades";
import { ambiguousNumberHint } from "@/lib/locale";
import { callAddHolding } from "@/lib/add-holding";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";

export type HoldingKind = "stock" | "crypto";

interface Candidate {
  id: string;
  symbol: string;
  name: string;
  detail: string;
}

const ISIN = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;

const COPY: Record<
  HoldingKind,
  { title: string; placeholder: string; nothingFound: string; quantity: string; queryKey: string }
> = {
  stock: {
    title: "Add an investment",
    placeholder: "Name, ticker or ISIN",
    nothingFound: "Nothing found. Try the ISIN or a shorter name.",
    quantity: "Shares",
    queryKey: "portfolio-latest",
  },
  crypto: {
    title: "Add a coin",
    placeholder: "Name or symbol, e.g. Bitcoin or ETH",
    nothingFound: "Nothing found. Try the full name or the ticker.",
    quantity: "Amount",
    queryKey: "crypto-latest",
  },
};

export function AddHoldingPanel({
  kind,
  defaultOpen = false,
}: {
  kind: HoldingKind;
  defaultOpen?: boolean;
}) {
  const copy = COPY[kind];
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(defaultOpen);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Array<Candidate> | null>(null);
  const [picked, setPicked] = useState<Candidate | null>(null);
  const [quantity, setQuantity] = useState("");
  const [broker, setBroker] = useState("");
  const [boughtOn, setBoughtOn] = useState("");
  const [paid, setPaid] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  // The words last sent, so Search after a live suggestion doesn't ask again.
  const lastSearched = useRef("");
  const resultsRef = useRef<HTMLDivElement>(null);

  const search = useMutation({
    mutationFn: (q: string) =>
      callAddHolding<{ results: Array<Candidate> }>(
        { action: "search", kind, query: q },
        "Search is unavailable right now, try again",
      ),
    onSuccess: (data, q) => {
      // A slow answer for words already changed is dropped.
      if (q !== lastSearched.current) return;
      setResults(data.results);
      setPicked(data.results.length === 1 ? data.results[0]! : null);
    },
    onError: (err) => {
      // Let Search try the same words again.
      lastSearched.current = "";
      setFormError(err.message);
    },
  });

  // The holding's key, as add-holding saves it: the ISIN typed, else the pick's id; a coin's symbol.
  const keyOf = (candidate: Candidate) =>
    kind === "crypto"
      ? candidate.symbol.toUpperCase()
      : ISIN.test(query.trim().toUpperCase())
        ? query.trim().toUpperCase()
        : candidate.id;

  // What you paid, as one buy: the return is measured from it. Without a price yet (none given
  // and none synced) there is no buy, so no return until trades are added.
  async function saveBuy(input: {
    candidate: Candidate;
    quantity: number;
    boughtOn: string;
    paid: number | null;
  }) {
    const key = keyOf(input.candidate);
    const priceEur = input.paid ?? (await latestPriceEur(supabase, kind, key));
    if (priceEur == null) return;
    await recordTrade(
      supabase,
      addedTrade({ kind, key, quantity: input.quantity, boughtOn: input.boughtOn, priceEur }),
    );
  }

  const add = useMutation({
    mutationFn: async (input: {
      candidate: Candidate;
      quantity: number;
      boughtOn: string;
      paid: number | null;
    }) => {
      const added = await callAddHolding<{ added: boolean; priced: boolean }>(
        {
          action: "add",
          kind,
          id: input.candidate.id,
          symbol: input.candidate.symbol,
          name: input.candidate.name,
          quantity: input.quantity,
          // The search term is the ISIN when the user typed one: keep it as the holding's key.
          ...(kind === "stock" && ISIN.test(query.trim().toUpperCase())
            ? { isin: query.trim().toUpperCase() }
            : {}),
          ...(kind === "stock" && broker.trim() ? { broker: broker.trim() } : {}),
        },
        "Couldn't add it right now, try again",
      );
      const bought = await saveBuy(input).then(
        () => true,
        () => false,
      );
      return { ...added, bought };
    },
    onSuccess: (data, input) => {
      if (!data.bought)
        toast.error(
          `${input.candidate.name}: what you paid wasn't saved. Tap its return to add it.`,
        );
      toast.success(
        data.priced
          ? `${input.candidate.name} added`
          : `${input.candidate.name} added; its value shows after the next price sync`,
      );
      void queryClient.invalidateQueries({ queryKey: [copy.queryKey] });
      void queryClient.invalidateQueries({ queryKey: ["net-worth-daily"] });
      // Returns compare trades with the quantity held, so they need the new holding too.
      void queryClient.invalidateQueries({ queryKey: ["holding-performance"] });
      void queryClient.invalidateQueries({ queryKey: ["holding-trades"] });
      setQuery("");
      setResults(null);
      setPicked(null);
      setQuantity("");
      setBroker("");
      setBoughtOn("");
      setPaid("");
    },
    onError: (err) => setFormError(err.message),
  });

  function runSearch(q: string) {
    if (q === lastSearched.current) return;
    lastSearched.current = q;
    setFormError(null);
    search.mutate(q);
  }

  // Live suggestions (iOS view board): one search per pause in typing, from two letters.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      lastSearched.current = "";
      setResults(null);
      setPicked(null);
      return;
    }
    const timer = setTimeout(() => runSearch(q), 350);
    return () => clearTimeout(timer);
    // runSearch only reads refs and stable setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  // On a phone the list opens under the keyboard: bring it into view.
  useEffect(() => {
    if (results) resultsRef.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, [results]);

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    // Closes the phone keyboard so the results below are visible.
    (document.activeElement as HTMLElement | null)?.blur();
    runSearch(q);
  }

  function handleAdd() {
    if (!picked) {
      setFormError("Pick one of the results first.");
      return;
    }
    const value = parseQuantity(quantity);
    if (value == null) {
      setFormError(
        ambiguousNumberHint(quantity) ?? `${copy.quantity} must be a number above zero.`,
      );
      return;
    }
    const today = formatISODate(new Date());
    if (boughtOn > today) {
      setFormError("The day you bought it can't be in the future.");
      return;
    }
    const price = paid.trim() ? parseQuantity(paid) : null;
    if (paid.trim() && price == null) {
      setFormError(ambiguousNumberHint(paid) ?? "The average price must be a number above zero.");
      return;
    }
    if (boughtOn && boughtOn < today && price == null) {
      setFormError("Enter the average price you paid, or leave the day empty for today.");
      return;
    }
    setFormError(null);
    add.mutate({ candidate: picked, quantity: value, boughtOn: boughtOn || today, paid: price });
  }

  return (
    <div className="mb-6 rounded-lg bg-card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-11 w-full items-center justify-between gap-3 p-5 text-left"
        aria-expanded={open}
      >
        <h2 className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Plus className="size-4 text-primary" />
          {copy.title}
        </h2>
        <ChevronDown
          className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div className="space-y-4 px-5 pb-5">
          <form onSubmit={handleSearch} className="flex gap-2">
            <label className="sr-only" htmlFor={`${kind}-search`}>
              Search
            </label>
            <Input
              id={`${kind}-search`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={copy.placeholder}
              maxLength={50}
              autoComplete="off"
              className="flex-1"
            />
            <Button type="submit" disabled={search.isPending || !query.trim()}>
              {search.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Search className="size-4" />
              )}
              Search
            </Button>
          </form>

          <div ref={resultsRef} />
          {results && results.length === 0 && (
            <p className="text-sm text-muted-foreground">{copy.nothingFound}</p>
          )}

          {results && results.length > 0 && (
            <fieldset>
              <legend className="mb-2 text-xs text-muted-foreground">
                {picked && results.length > 1 ? "Your pick" : "Pick the right one"}
              </legend>
              <div className="divide-y divide-hairline overflow-hidden rounded-lg bg-background">
                {(picked ? [picked] : results).map((r) => (
                  <label
                    key={r.id}
                    className="flex min-h-11 cursor-pointer items-center gap-3 px-3 py-2 text-sm has-[:checked]:bg-primary/10"
                  >
                    <input
                      type="radio"
                      name={`${kind}-pick`}
                      checked={picked?.id === r.id}
                      onChange={() => setPicked(r)}
                      className="accent-primary"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-foreground">{r.name}</span>
                      <span className="block text-xs text-muted-foreground">
                        {r.symbol}
                        {r.detail ? ` · ${r.detail}` : ""}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
              {/* e2e #14: once you pick, the other matches step aside until you ask for them. */}
              {picked && results.length > 1 && (
                <button
                  type="button"
                  onClick={() => setPicked(null)}
                  className="mt-1 min-h-11 text-xs font-medium text-foreground underline underline-offset-4"
                >
                  Change
                </button>
              )}
            </fieldset>
          )}

          {picked && (
            <div className="grid gap-3 sm:grid-cols-2 sm:items-end">
              <div>
                <label
                  className="mb-1 block text-xs text-muted-foreground"
                  htmlFor={`${kind}-quantity`}
                >
                  {copy.quantity}
                </label>
                <Input
                  id={`${kind}-quantity`}
                  inputMode="decimal"
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                  placeholder="0"
                />
              </div>
              {kind === "stock" && (
                <div>
                  <label
                    className="mb-1 block text-xs text-muted-foreground"
                    htmlFor="stock-broker"
                  >
                    Broker (optional)
                  </label>
                  <Input
                    id="stock-broker"
                    value={broker}
                    onChange={(e) => setBroker(e.target.value)}
                    maxLength={40}
                    placeholder="e.g. Degiro"
                  />
                </div>
              )}
              <div>
                <label
                  className="mb-1 block text-xs text-muted-foreground"
                  htmlFor={`${kind}-bought-on`}
                >
                  Bought on
                </label>
                <Input
                  id={`${kind}-bought-on`}
                  type="date"
                  value={boughtOn}
                  max={formatISODate(new Date())}
                  onChange={(e) => setBoughtOn(e.target.value)}
                />
              </div>
              <div>
                <label
                  className="mb-1 block text-xs text-muted-foreground"
                  htmlFor={`${kind}-paid`}
                >
                  Average price, €
                </label>
                <Input
                  id={`${kind}-paid`}
                  inputMode="decimal"
                  value={paid}
                  onChange={(e) => setPaid(e.target.value)}
                  placeholder="Today's price"
                />
              </div>
              <p className="text-xs text-muted-foreground sm:col-span-2">
                Optional. What you paid gives this holding a return; empty means bought today.
              </p>
              <Button
                onClick={handleAdd}
                disabled={add.isPending}
                className="sm:col-span-2 sm:justify-self-start"
              >
                {add.isPending && <Loader2 className="size-4 animate-spin" />}
                Add
              </Button>
            </div>
          )}

          {formError && (
            <p role="alert" className="text-sm text-negative">
              {formError}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
