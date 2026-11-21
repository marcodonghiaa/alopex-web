import { dateLocale, numberFormat } from "@/lib/locale";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ChevronLeft,
  CircleAlert,
  ChevronRight,
  FileUp,
  Info,
  Lock,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";
import { Link } from "@tanstack/react-router";
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
import { fieldClass } from "@/components/ui/field";
import { cn } from "@/lib/utils";
import { plural } from "@/lib/plural";
import { GroupedList } from "@/components/ui/grouped-list";
import { localToday } from "@/lib/trades";
import type { Trade } from "@/lib/trades";
import { BROKERS, NEW_BROKER_URL } from "@/lib/brokers";
import { saveQuantity } from "@/lib/holding-quantity";
import { callAddHolding } from "@/lib/add-holding";
import { cutChars } from "@/lib/transactions";
import { loadRates, rateLookup } from "@/lib/brokers/rates";
import {
  detectBroker,
  newTrades,
  parseTradesCsv,
  shareUpdates,
  summarizeImport,
} from "@/lib/trades-csv";
import { newEvents } from "@/lib/investment-events";
import { fetchEvents } from "@/lib/use-performance";
import { formatIncome, incomeAndCosts, incomeRows } from "@/components/holdings/investment-income";

/** A coin holding as stored: its count and its symbol written as saved (the key is in capitals). */
interface Held {
  shares: number;
  symbol: string;
}

interface Holdings {
  shares: Map<string, number>;
  names: Map<string, string>;
  /** Coins only: each source's own amounts (a coin can sit on Ledger and on Coinbase). */
  bySource: Map<string, Map<string, Held>>;
}

// Every holding, its count and name, sold ones too: the old trades of something you sold are still yours.
async function fetchHoldings(kind: "stock" | "crypto"): Promise<Holdings> {
  let list: Array<{ key: string; shares: number; name: string }>;
  const bySource = new Map<string, Map<string, Held>>();
  if (kind === "stock") {
    const { data, error } = await supabase.from("portfolio_holdings").select("isin,shares,name");
    if (error) throw error;
    list = data.map((r) => ({ key: r.isin.toUpperCase(), shares: r.shares, name: r.name }));
  } else {
    const { data, error } = await supabase
      .from("crypto_holdings")
      .select("asset_symbol,amount,name,source");
    if (error) throw error;
    list = data.map((r) => ({ key: r.asset_symbol.toUpperCase(), shares: r.amount, name: r.name }));
    for (const r of data) {
      if (!r.source || !r.asset_symbol) continue;
      if (!bySource.has(r.source)) bySource.set(r.source, new Map());
      bySource.get(r.source)!.set(r.asset_symbol.toUpperCase(), {
        shares: r.amount,
        symbol: r.asset_symbol,
      });
    }
  }
  return {
    shares: new Map(list.map((r) => [r.key, r.shares])),
    names: new Map(list.map((r) => [r.key, r.name || r.key])),
    bySource,
  };
}

/** Per coin, the holding a wallet export sets: the wallet's own row, else the one added by hand. */
function walletHoldings(
  bySource: Map<string, Map<string, Held>>,
  source: string,
): Map<string, Held & { source: string }> {
  const out = new Map<string, Held & { source: string }>();
  for (const from of ["Manual", source])
    for (const [key, held] of bySource.get(from) ?? []) out.set(key, { ...held, source: from });
  return out;
}

const dateFormat = new Intl.DateTimeFormat(dateLocale(), {
  day: "numeric",
  month: "short",
  year: "numeric",
});
const shortDate = (iso: string) => dateFormat.format(new Date(`${iso}T12:00:00`));

/** Pick where the trades come from, upload the file; shows what it found and saves only on your say-so. */
export function ImportTrades({ kind, saved }: { kind: "stock" | "crypto"; saved: Array<Trade> }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  // A chosen file's text is on its way: until then the card says Reading….
  const [reading, setReading] = useState(false);
  const [dragging, setDragging] = useState(false);
  // Where the file comes from: a broker's id, "spreadsheet" for your own columns, or "other".
  const [from, setFrom] = useState<string | null>(null);
  // A step you change takes focus to its title, not the dialog: the old control is gone.
  const titleRef = useRef<HTMLHeadingElement>(null);
  const stepChanged = useRef(false);
  function go(next: string | null) {
    stepChanged.current = true;
    setFrom(next);
  }
  // Brokers whose files this page reads (Trade Republic's on both pages).
  const belongsHere = (b: { kind: string }) => b.kind === kind || b.kind === "both";
  const brokers = BROKERS.filter(belongsHere);
  const broker = brokers.find((b) => b.id === from);
  const keyColumn = kind === "stock" ? "isin" : "symbol";

  const keys = useQuery({
    queryKey: ["holding-keys", kind],
    queryFn: () => fetchHoldings(kind),
    enabled: open,
  });

  // A wallet's export (Ledger) is the record of that wallet: it sets the coin's Ledger holding, or
  // the one you added by hand, never one an exchange sync keeps (Coinbase). Coins with neither are
  // left out by the parser, with a note.
  // Read once per file, not on every render: detecting splits the whole file.
  const detected = useMemo(() => (text.trim() ? detectBroker(text) : undefined), [text]);
  const fileBroker = broker ?? detected;
  const holdingSource = kind === "crypto" ? fileBroker?.holdingSource : undefined;
  const wallet = useMemo(
    () => (holdingSource && keys.data ? walletHoldings(keys.data.bySource, holdingSource) : null),
    [holdingSource, keys.data],
  );
  const ctx = useMemo(
    () =>
      keys.data
        ? {
            kind,
            knownKeys: new Set(wallet ? wallet.keys() : keys.data.shares.keys()),
            today: localToday(),
          }
        : null,
    [keys.data, kind, wallet],
  );
  // Prices in dollars (a Ledger file): load that currency's daily rates, then read it again.
  const firstPass = useMemo(
    // A chosen file that turns out blank is read too: the parser says it's empty.
    () =>
      (text.trim() || (fileName && !reading)) && ctx ? parseTradesCsv(text, ctx, broker) : null,
    [text, ctx, broker, fileName, reading],
  );
  const need = firstPass?.needsRates;
  const rates = useQuery({
    queryKey: ["fx-history", need],
    queryFn: () => loadRates(need!.currency, need!.from, need!.to),
    enabled: need != null,
    staleTime: Infinity,
    retry: 1,
  });
  // A retry with no rates yet clears the error while it runs: keep the button there, as Trying….
  const [retrying, setRetrying] = useState(false);
  const parsed = useMemo(() => {
    if (!firstPass || !ctx || !need) return firstPass;
    if (!rates.data) return null;
    return parseTradesCsv(
      text,
      { ...ctx, rateToEur: rateLookup(need.currency, rates.data) },
      broker,
    );
  }, [firstPass, ctx, need, rates.data, text, broker]);
  const fresh = useMemo(() => (parsed ? newTrades(parsed.trades, saved) : []), [parsed, saved]);
  // Dividends, interest, fees, taxes and transfers in the file that aren't saved yet.
  const savedEvents = useQuery({
    queryKey: ["investment-events"],
    queryFn: () => fetchEvents(supabase),
    enabled: open,
  });
  const freshEvents = useMemo(
    () => (parsed?.events && savedEvents.data ? newEvents(parsed.events, savedEvents.data) : []),
    [parsed, savedEvents.data],
  );
  // With the new trades' fees and taxes, the same sum as the Income and costs section.
  const income = useMemo(() => incomeAndCosts(freshEvents, fresh), [freshEvents, fresh]);
  const incomeList = incomeRows(income);
  const summary = useMemo(() => summarizeImport(fresh), [fresh]);
  // Count only the wallet's own trades for its holding.
  const updates = useMemo(() => {
    if (!parsed?.setsShares || !keys.data) return [];
    if (kind === "stock") return shareUpdates(parsed.trades, saved, keys.data.shares);
    if (!wallet || !fileBroker) return [];
    return shareUpdates(
      parsed.trades,
      saved.filter((t) => t.source === fileBroker.id),
      new Map([...wallet].map(([key, h]) => [key, h.shares])),
    );
  }, [parsed, saved, keys.data, kind, wallet, fileBroker]);
  // Per coin the file sets, your saved trades from elsewhere: the holding is set to the file's
  // amount, so its return won't match them, whether or not the amount changes.
  const otherTrades = useMemo(() => {
    const out = new Map<string, number>();
    if (!parsed?.setsShares || !wallet || !fileBroker) return out;
    const set = new Set(parsed.trades.map((t) => t.key));
    for (const t of saved) {
      const key = t.key.toUpperCase();
      if (t.source !== fileBroker.id && set.has(key) && wallet.has(key))
        out.set(key, (out.get(key) ?? 0) + 1);
    }
    return out;
  }, [parsed, saved, wallet, fileBroker]);
  // Shares the file says you hold but that aren't in your holdings yet (a fresh install): Save
  // adds each one first, with what's left of it. One sold to zero needs no holding.
  const toAdd = useMemo(() => {
    if (kind !== "stock" || !parsed?.setsShares || !keys.data) return [];
    const held = keys.data.shares;
    const missing = new Map(parsed.trades.filter((t) => !held.has(t.key)).map((t) => [t.key, 0]));
    return shareUpdates(parsed.trades, saved, missing).map((u) => ({
      ...u,
      name: parsed.names?.get(u.key) || u.key,
    }));
  }, [parsed, saved, keys.data, kind]);
  const adding = new Set(toAdd.map((h) => h.key));
  const otherWarning = (n: number) =>
    `Has ${plural(n, "trade")} not from ${fileBroker?.name}: its return will show as not matching until you remove ${n === 1 ? "it" : "them"}`;
  const toCheck = [...otherTrades.keys()].filter((key) => !updates.some((u) => u.key === key));

  // Two clicks before a re-render would both start a save: only the first one counts.
  const saving = useRef(false);
  const save = useMutation({
    mutationFn: async () => {
      // Only new rows carry your id; share counts alone don't need it.
      let userId = "";
      if (fresh.length > 0 || freshEvents.length > 0 || toAdd.length > 0) {
        const { data } = await supabase.auth.getUser();
        if (!data.user) throw new Error("You're signed out. Sign in and try again.");
        userId = data.user.id;
      }
      // The holdings first, as you'd add them by hand: found by ISIN, priced today. One that
      // can't be found keeps its trades and dividends out, so it never shows without a value.
      const added: Array<string> = [];
      const missed: Array<string> = [];
      for (const h of toAdd) {
        try {
          const { results } = await callAddHolding<{
            results: Array<{ id: string; symbol: string }>;
          }>({ action: "search", kind, query: h.key }, "Search is unavailable");
          const found = results[0];
          if (!found) throw new Error("Not found");
          await callAddHolding(
            {
              action: "add",
              kind,
              id: found.id,
              symbol: found.symbol,
              name: cutChars(h.name, 120),
              quantity: h.shares,
              isin: h.key,
              broker: fileBroker?.name,
            },
            "Couldn't add it",
          );
          added.push(h.key);
        } catch {
          missed.push(h.key);
        }
      }
      const trades = fresh.filter((t) => !missed.includes(t.key));
      const rows = freshEvents.filter((e) => !(e.key && missed.includes(e.key)));
      const missedNames = missed.map((key) => toAdd.find((h) => h.key === key)!.name);
      const done = (events: number) => ({
        trades: trades.length,
        events,
        counts: updates.length,
        added: added.length,
        missedNames,
      });
      // One insert is one statement: all the rows land, or none do.
      if (trades.length > 0) {
        const { error } = await supabase
          .from("holding_trades")
          .insert(trades.map((t) => ({ ...t, user_id: userId })));
        if (error) throw error;
      }
      // If this fails the trades are safe: importing again skips them and retries the counts.
      // set_holding_quantity also writes today's value, so net worth moves at once.
      try {
        for (const { key, shares } of updates) {
          const held = wallet?.get(key);
          await saveQuantity(
            kind === "stock"
              ? { kind: "stock", isin: key }
              : { kind: "crypto", symbol: held!.symbol, source: held!.source },
            shares,
          );
        }
      } catch (e) {
        // The trades are saved by now: say so, as for the income rows below.
        if (trades.length === 0) throw e;
        const unsaved =
          rows.length > 0
            ? "the share counts and the income, fee and cash rows weren't"
            : "the share counts weren't";
        throw new Error(
          `${plural(trades.length, "trade")} saved, but ${unsaved} (${(e as Error).message}). Import the file again to save them.`,
        );
      }
      // A re-import is skipped by the database too: the same broker id is saved once.
      if (rows.length > 0) {
        // Only rows the database saved come back: one already there (another tab) isn't counted.
        const { data: savedRows, error } = await supabase
          .from("investment_events")
          .upsert(
            rows.map((e) => ({ ...e, user_id: userId })),
            { onConflict: "user_id,source,external_id", ignoreDuplicates: true },
          )
          .select("id");
        // The trades and counts are saved by now: say so, or a retry looks like it starts over.
        if (error && trades.length > 0)
          throw new Error(
            `${plural(trades.length, "trade")} saved, but the income, fee and cash rows weren't (${error.message}). Import the file again to save them.`,
          );
        if (error) throw error;
        return done(savedRows?.length ?? 0);
      }
      return done(0);
    },
    // Counts come from the save itself: the dialog may have been cleared while it ran.
    // Worded as the sibling CSV import's "Imported 3 rows".
    onSuccess: ({ trades, events, counts, added, missedNames }) => {
      const imported = [
        trades > 0 && plural(trades, "trade"),
        events > 0 && plural(events, "income and cash row"),
      ]
        .filter(Boolean)
        .join(" and ");
      const changed = [
        added > 0 && `added ${plural(added, "holding")}`,
        counts > 0 && `updated ${plural(counts, kind === "crypto" ? "holding" : "share count")}`,
      ]
        .filter(Boolean)
        .join(", ");
      toast.success(
        imported && changed
          ? `Imported ${imported}, ${changed}`
          : imported
            ? `Imported ${imported}`
            : changed
              ? changed[0]!.toUpperCase() + changed.slice(1)
              : "Nothing new imported",
      );
      // One line for all of them, however many.
      if (missedNames.length > 0)
        toast.error(
          missedNames.length === 1
            ? `${missedNames[0]} couldn't be added, so its trades weren't saved. Add it, then import again.`
            : `${plural(missedNames.length, "holding")} couldn't be added, so their trades weren't saved: ${missedNames.join(", ")}. Add them, then import again.`,
        );
      reset();
      setOpen(false);
    },
    onSettled: () => {
      saving.current = false;
      void queryClient.invalidateQueries({ queryKey: ["holding-trades"] });
      void queryClient.invalidateQueries({ queryKey: ["investment-events"] });
      void queryClient.invalidateQueries({ queryKey: ["holding-keys", kind] });
      void queryClient.invalidateQueries({ queryKey: ["holding-performance"] });
      void queryClient.invalidateQueries({
        queryKey: [kind === "stock" ? "portfolio-latest" : "crypto-latest"],
      });
      void queryClient.invalidateQueries({ queryKey: ["net-worth-daily"] });
    },
  });

  // Choosing a source or a file removes the control you used: focus goes on to the next step.
  // A new step focuses its title; Another broker focuses the way to ask for it.
  const fileInputRef = useRef<HTMLInputElement>(null);
  const askRef = useRef<HTMLAnchorElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!stepChanged.current) return;
    stepChanged.current = false;
    if (from === "other") askRef.current?.focus();
    else titleRef.current?.focus();
  }, [from]);
  // The drop zone becomes the file's row with Change: a picker that had focus keeps it there;
  // otherwise focus goes to the file's row and its status.
  const refocusFile = useRef(false);
  useEffect(() => {
    if (!fileName) return;
    if (refocusFile.current) fileInputRef.current?.focus();
    else cardRef.current?.focus();
    refocusFile.current = false;
  }, [fileName]);

  // Each file read gets a number: one that ends after another file, or after a reset, is dropped.
  const readId = useRef(0);
  // Closing the tab mid-save leaves holdings half-updated: the browser asks first.
  useEffect(() => {
    if (!save.isPending) return;
    const ask = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Older browsers ask only when this is set too.
      e.returnValue = true;
    };
    window.addEventListener("beforeunload", ask);
    return () => window.removeEventListener("beforeunload", ask);
  }, [save.isPending]);

  function reset() {
    readId.current++;
    setText("");
    setFileName(null);
    setReading(false);
    setFrom(null);
    save.reset();
  }
  function onFile(file: File | undefined) {
    // Dropped or picked, a file can't replace the one being saved: the save ends by clearing the dialog.
    if (!file || save.isPending) return;
    setFileName(file.name);
    setReading(true);
    const id = ++readId.current;
    void file.text().then((t) => {
      if (id !== readId.current) return;
      setText(t);
      setReading(false);
    });
  }

  const correctedId = useId();
  const toCheckId = useId();
  // Coin amounts keep their decimals (0.4988), share counts too.
  const amount = numberFormat({ maximumFractionDigits: 8 });
  const row = "flex min-h-12 items-center gap-3 px-4 py-2.5 text-[0.9375rem]";
  const fileInput = (
    <input
      ref={fileInputRef}
      type="file"
      accept=".csv,.tsv,.txt,text/csv"
      aria-label={fileName ? "Change file" : "CSV file"}
      className="sr-only"
      // A file can't be swapped while the last one saves.
      disabled={save.isPending}
      onChange={(e) => {
        refocusFile.current = !fileName && document.activeElement === e.target;
        onFile(e.target.files?.[0]);
        // The same file can be chosen again after Change.
        e.target.value = "";
      }}
    />
  );
  const ok = parsed != null && parsed.errors.length === 0;
  // Rows of the file saved before; known once your saved rows have loaded.
  const skippedTrades = parsed ? parsed.trades.length - fresh.length : 0;
  const skippedEvents =
    parsed?.events && savedEvents.data ? parsed.events.length - freshEvents.length : 0;
  // A read file with nothing to save: no check mark, no Save, and a line saying why.
  const nothing =
    ok &&
    (parsed.events == null || savedEvents.data != null) &&
    fresh.length === 0 &&
    freshEvents.length === 0 &&
    updates.length === 0 &&
    toAdd.length === 0;
  // Without the holdings or the rates the file can't be read: no spinner next to the error.
  const stuck = !parsed && (keys.isError || (rates.isError && !retrying));
  // Counts in the reader's locale (1,234).
  const counted = (n: number, word: string) =>
    `${numberFormat().format(n)} ${word}${n === 1 ? "" : "s"}`;
  const title =
    from === null
      ? "Import trades"
      : broker
        ? `Import from ${broker.name}`
        : from === "spreadsheet"
          ? "Import a spreadsheet"
          : "Another broker";
  const sources = [
    ...brokers.map((b) => ({ id: b.id, label: b.name, hint: b.country })),
    { id: "spreadsheet", label: "My own spreadsheet", hint: "Any CSV with our columns" },
    { id: "other", label: "Another broker", hint: "Not listed here" },
  ];

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // A save finishing later would close and clear whatever is open then: wait for it.
        if (!next && (saving.current || save.isPending)) return;
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger className="-my-2.5 inline-flex min-h-11 items-center text-xs text-primary underline-offset-2 hover:underline">
        Import trades from CSV
      </DialogTrigger>
      <DialogContent closeDisabled={save.isPending}>
        {from !== null && (
          <button
            type="button"
            onClick={() => {
              reset();
              go(null);
            }}
            disabled={save.isPending}
            className="-my-2 inline-flex min-h-11 items-center gap-1 self-start text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            <ChevronLeft className="size-3.5" /> All sources
          </button>
        )}
        <DialogHeader>
          <DialogTitle ref={titleRef} tabIndex={-1} className="outline-none">
            {title}
          </DialogTitle>
          <DialogDescription>
            {from === null
              ? "Where are these trades from?"
              : broker
                ? "Upload the export as it comes. Alopex reads it on your device and shows you what it found first."
                : from === "spreadsheet" && detected && belongsHere(detected)
                  ? // A broker's own file pasted here is read as that broker's, not by our columns.
                    `This file comes from ${detected.name}: read as it comes${need ? `, its ${need.currency} values turned into euro with each day's rate` : ""}.`
                  : from === "spreadsheet"
                    ? `A header row with date, side, ${keyColumn}, shares, price and optionally fee. Side is buy or sell; price is per share in EUR.`
                    : "Alopex doesn't read this broker's export yet."}
          </DialogDescription>
        </DialogHeader>

        {from === null && (
          <GroupedList className="border border-hairline">
            {sources.map((o) => (
              <button
                key={o.id}
                type="button"
                onClick={() => go(o.id)}
                className={cn(row, "w-full text-left hover:bg-muted")}
              >
                {/* The name is the choice: it keeps its line, the hint gives way. */}
                <span className="shrink-0 font-medium">{o.label}</span>
                <span className="min-w-0 flex-1 truncate text-right text-xs text-muted-foreground">
                  {o.hint}
                </span>
                <ChevronRight aria-hidden className="size-4 text-muted-foreground" />
              </button>
            ))}
          </GroupedList>
        )}

        {from === "other" && (
          <div className="flex flex-col gap-3 text-sm">
            <p>
              <a
                ref={askRef}
                href={NEW_BROKER_URL}
                target="_blank"
                rel="noreferrer"
                className="text-primary underline underline-offset-2"
              >
                Ask for your broker
              </a>{" "}
              with a sample of its export, personal details removed. Until then, put your trades in
              a spreadsheet with our columns.
            </p>
            <Button
              variant="quiet"
              className="border border-rule"
              onClick={() => go("spreadsheet")}
            >
              Use a spreadsheet
            </Button>
          </div>
        )}

        {from !== null && from !== "other" && (
          <>
            {fileName ? (
              <div
                ref={cardRef}
                tabIndex={-1}
                className="flex items-center gap-3 rounded-lg border border-hairline bg-card px-4 py-3 outline-none"
              >
                <span
                  aria-hidden
                  className={cn(
                    "inline-flex size-9 shrink-0 items-center justify-center rounded-full",
                    (parsed && !ok) || stuck
                      ? "bg-negative/15 text-negative"
                      : nothing
                        ? "bg-foreground/[0.07] text-muted-foreground"
                        : "bg-positive/15 text-positive",
                  )}
                >
                  {(parsed && !ok) || stuck ? (
                    <CircleAlert className="size-4" strokeWidth={2.5} />
                  ) : nothing ? (
                    <Info className="size-4" strokeWidth={2.5} />
                  ) : parsed ? (
                    <Check className="size-4" strokeWidth={2.5} />
                  ) : (
                    <Loader2 className="size-4 animate-spin" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">{fileName}</span>
                  <span role="status" className="block text-xs text-muted-foreground">
                    {!parsed && keys.isError
                      ? "Can't be read"
                      : stuck
                        ? "Couldn't load exchange rates"
                        : !parsed
                          ? need
                            ? "Loading exchange rates…"
                            : "Reading…"
                          : nothing
                            ? "Nothing new to import"
                            : ok
                              ? "Read, check what it found below"
                              : "Can't be imported"}
                  </span>
                </span>
                <label className="-my-2 inline-flex min-h-11 cursor-pointer items-center rounded-sm px-2 text-xs text-primary underline underline-offset-2 has-[:disabled]:pointer-events-none has-[:disabled]:opacity-50 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring">
                  Change
                  {fileInput}
                </label>
              </div>
            ) : (
              <label
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragging(false);
                  onFile(e.dataTransfer.files[0]);
                }}
                className={cn(
                  "flex cursor-pointer flex-col items-center rounded-lg border border-dashed border-hairline bg-card px-6 py-8 text-center transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring hover:bg-muted",
                  dragging && "ring-2 ring-primary",
                )}
              >
                <span
                  aria-hidden
                  className="mb-3 inline-flex size-12 items-center justify-center rounded-full bg-foreground/[0.07]"
                >
                  <FileUp className="size-5" strokeWidth={1.8} />
                </span>
                <span className="text-[0.9375rem] font-semibold">Choose CSV file</span>
                <span className="mt-0.5 text-xs text-muted-foreground">or drop it here</span>
                {fileInput}
              </label>
            )}

            {broker && !fileName && (
              <div>
                <p className="px-1 pb-1.5 text-xs font-medium text-muted-foreground">
                  How to get the file
                </p>
                <GroupedList className="border border-hairline">
                  <ol>
                    {broker.howToExport.map((step, i) => (
                      <li key={step} className={cn(row, "border-hairline not-first:border-t")}>
                        <span
                          aria-hidden
                          className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-foreground/10 text-xs font-semibold"
                        >
                          {i + 1}
                        </span>
                        {step}
                      </li>
                    ))}
                  </ol>
                </GroupedList>
                <p className="flex items-center gap-1.5 px-1 pt-1.5 text-xs text-muted-foreground">
                  <Lock aria-hidden className="size-3" />
                  Read on your device. Nothing is saved until you press Save.
                </p>
              </div>
            )}

            {from === "spreadsheet" && (
              <textarea
                aria-label="CSV text"
                value={text}
                disabled={save.isPending}
                onChange={(e) => {
                  setText(e.target.value);
                  setFileName(null);
                }}
                rows={5}
                placeholder={`Or paste it:\ndate,side,${keyColumn},shares,price,fee`}
                className={cn(fieldClass(), "h-auto py-2 font-mono md:text-sm")}
              />
            )}
          </>
        )}
        {(rates.isError || retrying) && (
          <div className="flex flex-wrap items-center gap-3">
            {rates.error && (
              <p role="alert" className="text-sm text-negative">
                {rates.error.message}
              </p>
            )}
            <Button
              variant="quiet"
              // aria-disabled, not disabled: a disabled button drops keyboard focus to the page body.
              aria-disabled={retrying || undefined}
              className="border border-rule aria-disabled:pointer-events-none aria-disabled:opacity-50"
              onClick={() => {
                setRetrying(true);
                void rates.refetch().finally(() => setRetrying(false));
              }}
            >
              {retrying ? (
                <>
                  <Loader2 className="size-4 animate-spin" /> Trying…
                </>
              ) : (
                "Try again"
              )}
            </Button>
          </div>
        )}
        {savedEvents.isError && (
          <p role="alert" className="text-sm text-negative">
            Couldn't load your saved dividends and fees: {savedEvents.error.message}
          </p>
        )}
        {keys.isError && (
          <p role="alert" className="text-sm text-negative">
            Couldn't load your holdings: {keys.error.message}
          </p>
        )}
        {parsed && parsed.errors.length > 0 && (
          <div role="alert" className="max-h-40 overflow-y-auto text-sm text-negative">
            <p className="font-medium">Nothing saved. Fix these first:</p>
            <ul>
              {parsed.errors.slice(0, 20).map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
            {parsed.errors.length > 20 && <p>…and {parsed.errors.length - 20} more.</p>}
            {/* A file for the other page (a Ledger export on Portfolio): take you there. */}
            {detected && !belongsHere(detected) && (
              <p className="mt-1">
                <Link
                  to={detected.kind === "crypto" ? "/crypto" : "/portfolio"}
                  className="text-primary underline underline-offset-2"
                >
                  Open the {detected.kind === "crypto" ? "Crypto" : "Portfolio"} page
                </Link>
              </p>
            )}
            {parsed.unknownFormat && (
              <p className="mt-1 text-muted-foreground">
                Want your broker supported?{" "}
                <a
                  href={NEW_BROKER_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary underline-offset-2 hover:underline"
                >
                  Ask for it
                </a>{" "}
                with a sample of its export, personal details removed.
              </p>
            )}
          </div>
        )}
        {ok && (
          <div className="flex flex-col gap-4">
            <div className="px-1">
              {nothing ? (
                <p className="text-[0.9375rem] font-medium">
                  {skippedTrades > 0 || skippedEvents > 0
                    ? "Everything in this file is already saved."
                    : "Nothing in this file to import here."}
                </p>
              ) : (
                (fresh.length > 0 || freshEvents.length > 0) && (
                  <p className="flex items-baseline gap-2">
                    <span className="text-3xl leading-none font-semibold tabular-nums">
                      {numberFormat().format(fresh.length > 0 ? fresh.length : freshEvents.length)}
                    </span>
                    <span className="text-[0.9375rem] font-medium">
                      {fresh.length > 0
                        ? `new trade${fresh.length === 1 ? "" : "s"} to save`
                        : `new income and cash row${freshEvents.length === 1 ? "" : "s"} to save`}
                    </span>
                  </p>
                )
              )}
              {summary && (
                <p className="mt-0.5 text-sm text-muted-foreground">
                  {[
                    summary.buys > 0 && plural(summary.buys, "buy"),
                    summary.sells > 0 && plural(summary.sells, "sell"),
                    summary.from === summary.to
                      ? shortDate(summary.from)
                      : `${shortDate(summary.from)} – ${shortDate(summary.to)}`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              )}
              {toAdd.length > 0 && (
                <p className="mt-0.5 text-sm text-muted-foreground">
                  Adds {plural(toAdd.length, "holding")}
                </p>
              )}
            </div>

            {/* Shown once the saved rows are known: until then the file's could all be saved already. */}
            {savedEvents.data && (freshEvents.length > 0 || incomeList.length > 0) && (
              <div>
                <p className="px-1 pb-1.5 text-xs font-medium text-muted-foreground">
                  {/* Fees and taxes on the trades alone are no extra rows: don't say "Also saved". */}
                  {freshEvents.length > 0
                    ? "Also saved: income, fees and cash"
                    : "Costs on these trades"}
                </p>
                <GroupedList className="border border-hairline">
                  {incomeList.map((r) => (
                    <div key={r.label}>
                      <div className={row}>
                        <span className="flex-1">{r.label}</span>
                        <span className="font-figure">{formatIncome(r.value)}</span>
                      </div>
                      {/* The amounts above are after tax: these aren't more to pay. */}
                      {r.label === "Taxes" && (
                        <p className="-mt-1 px-4 pb-2 text-xs text-muted-foreground">
                          Already taken off what you were paid, not extra.
                        </p>
                      )}
                    </div>
                  ))}
                  {freshEvents.length > 0 && (
                    <div className={row}>
                      <span className="flex-1">
                        Rows saved in all (deposits and withdrawals too)
                      </span>
                      <span className="font-figure">
                        {numberFormat().format(freshEvents.length)}
                      </span>
                    </div>
                  )}
                </GroupedList>
              </div>
            )}

            {(skippedTrades > 0 || skippedEvents > 0) && (
              <GroupedList className="border border-hairline">
                <div className={row}>
                  <span className="flex-1">Already saved, skipped</span>
                  <span className="font-figure">
                    {[
                      skippedTrades > 0 && counted(skippedTrades, "trade"),
                      skippedEvents > 0 && counted(skippedEvents, "row"),
                    ]
                      .filter(Boolean)
                      .join(", ")}
                  </span>
                </div>
              </GroupedList>
            )}

            {updates.length > 0 && (
              <section aria-labelledby={correctedId}>
                <p
                  id={correctedId}
                  className="px-1 pb-1.5 text-xs font-medium text-muted-foreground"
                >
                  {/* Before Save, a share count is still to correct. */}
                  {kind === "crypto" ? "Holdings to correct" : "Share counts to correct"}
                </p>
                <GroupedList className="border border-hairline">
                  <ul>
                    {updates.map(({ key, shares }) => {
                      const held = wallet?.get(key);
                      const old = held ? held.shares : keys.data?.shares.get(key);
                      const byHand = otherTrades.get(key) ?? 0;
                      return (
                        <li key={key} className={cn(row, "border-hairline not-first:border-t")}>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate">
                              {keys.data?.names.get(key) ?? key}
                            </span>
                            {held && (
                              <span className="block text-xs text-muted-foreground">
                                {held.source}
                                {byHand > 0 && ` · ${otherWarning(byHand)}`}
                              </span>
                            )}
                          </span>
                          <span className="shrink-0 text-sm font-figure">
                            {old !== undefined && `${amount.format(old)} → `}
                            {amount.format(shares)}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </GroupedList>
              </section>
            )}

            {toCheck.length > 0 && (
              <section aria-labelledby={toCheckId}>
                <p id={toCheckId} className="px-1 pb-1.5 text-xs font-medium text-muted-foreground">
                  Trades to check
                </p>
                <GroupedList className="border border-hairline">
                  <ul>
                    {toCheck.map((key) => (
                      <li key={key} className={cn(row, "border-hairline not-first:border-t")}>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">{keys.data?.names.get(key) ?? key}</span>
                          <span className="block text-xs text-muted-foreground">
                            {wallet?.get(key)?.source} · {otherWarning(otherTrades.get(key)!)}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </GroupedList>
              </section>
            )}

            {summary && (
              <div>
                <p className="px-1 pb-1.5 text-xs font-medium text-muted-foreground">By holding</p>
                <GroupedList className="max-h-56 overflow-y-auto border border-hairline">
                  {summary.byKey.map((h) => (
                    <div key={h.key} className={row}>
                      <span className="min-w-0 flex-1 truncate">
                        {keys.data?.names.get(h.key) ?? parsed.names?.get(h.key) ?? h.key}
                        {/* A stock with no holding: added on Save, or kept because it nets to zero (a coin is left out, with a note). */}
                        {ctx &&
                          !ctx.knownKeys.has(h.key) &&
                          (adding.has(h.key) ? " · new" : " · fully sold")}
                      </span>
                      <span className="shrink-0 text-sm text-muted-foreground tabular-nums">
                        {[
                          h.buys > 0 && plural(h.buys, "buy"),
                          h.sells > 0 && plural(h.sells, "sell"),
                        ]
                          .filter(Boolean)
                          .join(", ")}
                      </span>
                    </div>
                  ))}
                </GroupedList>
              </div>
            )}

            {parsed.notes.length > 0 && (
              <div>
                <p className="px-1 pb-1.5 text-xs font-medium text-muted-foreground">Notes</p>
                <GroupedList className="border border-hairline">
                  {parsed.notes.map((note) => (
                    <div key={note} className={cn(row, "items-start text-sm")}>
                      <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                      <span>{note}</span>
                    </div>
                  ))}
                </GroupedList>
              </div>
            )}
          </div>
        )}
        {save.isError && (
          <p role="alert" className="text-sm text-negative">
            {save.error.message}
          </p>
        )}
        {/* A file with errors saves nothing: no Save next to "Can't be imported". */}
        {ok && !nothing && (
          // Pinned to the dialog's bottom: a long result (a phone, a pasted file) can't push it out of view.
          <div className="sticky -bottom-6 -mx-6 -mb-6 bg-background px-6 pt-2 pb-6">
            <Button
              className="w-full"
              disabled={
                (fresh.length === 0 &&
                  updates.length === 0 &&
                  freshEvents.length === 0 &&
                  toAdd.length === 0) ||
                (parsed.events != null && !savedEvents.data) ||
                save.isPending
              }
              onClick={() => {
                // Two clicks before a re-render would both start a save: only the first one counts.
                if (saving.current) return;
                saving.current = true;
                save.mutate();
              }}
            >
              {save.isPending && <Loader2 className="size-4 animate-spin" />}
              {fresh.length > 0 || freshEvents.length > 0
                ? `Save ${[
                    fresh.length > 0 && plural(fresh.length, "trade"),
                    freshEvents.length > 0 && plural(freshEvents.length, "row"),
                  ]
                    .filter(Boolean)
                    .join(" and ")}`
                : updates.length > 0
                  ? kind === "crypto"
                    ? "Save holdings"
                    : "Save share counts"
                  : "Save trades"}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
