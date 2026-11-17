import { dateLocale } from "@/lib/locale";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronLeft, ChevronRight, FileUp, Info, Lock, Loader2, X } from "lucide-react";
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
import { fieldClass } from "@/components/ui/field";
import { cn } from "@/lib/utils";
import { plural } from "@/lib/plural";
import { GroupedList } from "@/components/ui/grouped-list";
import { localToday } from "@/lib/trades";
import type { Trade } from "@/lib/trades";
import { BROKERS, NEW_BROKER_URL } from "@/lib/brokers";
import { saveQuantity } from "@/lib/holding-quantity";
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
  let list: Array<{ key: string; shares: number; name: string; source?: string; symbol?: string }>;
  if (kind === "stock") {
    const { data, error } = await supabase.from("portfolio_holdings").select("isin,shares,name");
    if (error) throw error;
    list = data.map((r) => ({ key: r.isin.toUpperCase(), shares: r.shares, name: r.name }));
  } else {
    const { data, error } = await supabase
      .from("crypto_holdings")
      .select("asset_symbol,amount,name,source");
    if (error) throw error;
    list = data.map((r) => ({
      key: r.asset_symbol.toUpperCase(),
      shares: r.amount,
      name: r.name,
      source: r.source,
      symbol: r.asset_symbol,
    }));
  }
  const bySource = new Map<string, Map<string, Held>>();
  for (const r of list) {
    if (!r.source || !r.symbol) continue;
    if (!bySource.has(r.source)) bySource.set(r.source, new Map());
    bySource.get(r.source)!.set(r.key, { shares: r.shares, symbol: r.symbol });
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
  const brokers = BROKERS.filter((b) => b.kind === kind || b.kind === "both");
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
  const fileBroker = broker ?? (text.trim() ? detectBroker(text) : undefined);
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

  const save = useMutation({
    mutationFn: async () => {
      // Only new rows carry your id; share counts alone don't need it.
      let userId = "";
      if (fresh.length > 0 || freshEvents.length > 0) {
        const { data } = await supabase.auth.getUser();
        if (!data.user) throw new Error("You're signed out. Sign in and try again.");
        userId = data.user.id;
      }
      // One insert is one statement: all the rows land, or none do.
      if (fresh.length > 0) {
        const { error } = await supabase
          .from("holding_trades")
          .insert(fresh.map((t) => ({ ...t, user_id: userId })));
        if (error) throw error;
      }
      // If this fails the trades are safe: importing again skips them and retries the counts.
      // set_holding_quantity also writes today's value, so net worth moves at once.
      for (const { key, shares } of updates)
        await saveQuantity(
          kind === "stock"
            ? { kind: "stock", isin: key }
            : {
                kind: "crypto",
                symbol: wallet!.get(key)!.symbol,
                source: wallet!.get(key)!.source,
              },
          shares,
        );
      // A re-import is skipped by the database too: the same broker id is saved once.
      if (freshEvents.length > 0) {
        // Only rows the database saved come back: one already there (another tab) isn't counted.
        const { data: savedRows, error } = await supabase
          .from("investment_events")
          .upsert(
            freshEvents.map((e) => ({ ...e, user_id: userId })),
            { onConflict: "user_id,source,external_id", ignoreDuplicates: true },
          )
          .select("id");
        // The trades and counts are saved by now: say so, or a retry looks like it starts over.
        if (error && fresh.length > 0)
          throw new Error(
            `${plural(fresh.length, "trade")} saved, but the income, fee and cash rows weren't (${error.message}). Import the file again to save them.`,
          );
        if (error) throw error;
        return { trades: fresh.length, events: savedRows?.length ?? 0, counts: updates.length };
      }
      return { trades: fresh.length, events: 0, counts: updates.length };
    },
    // Counts come from the save itself: the dialog may have been cleared while it ran.
    onSuccess: ({ trades, events, counts }) => {
      const imported = [
        trades > 0 && plural(trades, "trade"),
        events > 0 && plural(events, "income and cash row"),
      ]
        .filter(Boolean)
        .join(" and ");
      toast.success(
        imported
          ? `${imported} imported`
          : counts > 0
            ? `${plural(counts, "share count")} corrected`
            : "Nothing new imported",
      );
      reset();
      setOpen(false);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["holding-trades"] });
      void queryClient.invalidateQueries({ queryKey: ["investment-events"] });
      void queryClient.invalidateQueries({ queryKey: ["holding-keys", kind] });
      void queryClient.invalidateQueries({ queryKey: ["holding-performance"] });
      void queryClient.invalidateQueries({ queryKey: ["portfolio-latest"] });
      void queryClient.invalidateQueries({ queryKey: ["net-worth-daily"] });
    },
  });

  function reset() {
    setText("");
    setFileName(null);
    setReading(false);
    setFrom(null);
    save.reset();
  }
  function onFile(file: File | undefined) {
    // A save in flight ends by clearing the dialog: a file picked or dropped now would be lost.
    if (!file || save.isPending) return;
    setFileName(file.name);
    setReading(true);
    void file.text().then((t) => {
      setText(t);
      setReading(false);
    });
  }

  const row = "flex min-h-12 items-center gap-3 px-4 py-2.5 text-[0.9375rem]";
  const fileInput = (
    <input
      type="file"
      accept=".csv,.tsv,.txt,text/csv"
      aria-label={fileName ? "Choose another file" : "CSV file"}
      className="sr-only"
      disabled={save.isPending}
      onChange={(e) => {
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
    updates.length === 0;
  // Holdings or rates failed: the file can't be read until they load, so stop showing Reading….
  const unreadable = !parsed && (keys.isError || rates.isError);
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
        // A save in flight finishes in this session: closing now would let it close the next one.
        if (!next && save.isPending) return;
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger className="-my-2.5 inline-flex min-h-11 items-center text-xs text-primary underline-offset-2 hover:underline">
        Import trades from CSV
      </DialogTrigger>
      <DialogContent>
        {from !== null && (
          <button
            type="button"
            onClick={reset}
            disabled={save.isPending}
            className="-my-2 inline-flex min-h-11 items-center gap-1 self-start text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            <ChevronLeft className="size-3.5" /> All sources
          </button>
        )}
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {from === null
              ? "Where are these trades from?"
              : broker
                ? "Upload the export as it comes. Alopex reads it on your device and shows you what it found first."
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
                onClick={() => setFrom(o.id)}
                className={cn(row, "w-full text-left hover:bg-muted")}
              >
                <span className="flex-1 font-medium">{o.label}</span>
                <span className="text-xs text-muted-foreground">{o.hint}</span>
                <ChevronRight aria-hidden className="size-4 text-muted-foreground" />
              </button>
            ))}
          </GroupedList>
        )}

        {from === "other" && (
          <div className="flex flex-col gap-3 text-sm">
            <p>
              <a
                href={NEW_BROKER_URL}
                target="_blank"
                rel="noreferrer"
                className="text-primary underline-offset-2 hover:underline"
              >
                Ask for your broker
              </a>{" "}
              with a sample of its export, personal details removed. Until then, put your trades in
              a spreadsheet with our columns.
            </p>
            <Button variant="quiet" onClick={() => setFrom("spreadsheet")}>
              Use a spreadsheet
            </Button>
          </div>
        )}

        {from !== null && from !== "other" && (
          <>
            {fileName ? (
              <div className="flex items-center gap-3 rounded-lg border border-hairline bg-card px-4 py-3">
                <span
                  aria-hidden
                  className={cn(
                    "inline-flex size-9 shrink-0 items-center justify-center rounded-full",
                    (parsed && !ok) || unreadable
                      ? "bg-negative/15 text-negative"
                      : nothing
                        ? "bg-foreground/[0.07] text-muted-foreground"
                        : "bg-positive/15 text-positive",
                  )}
                >
                  {unreadable ? (
                    <X className="size-4" strokeWidth={2.5} />
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
                  <span className="block text-xs text-muted-foreground">
                    {unreadable
                      ? "Can't be read"
                      : !parsed
                        ? "Reading…"
                        : nothing
                          ? "Nothing new to import"
                          : ok
                            ? "Read, check what it found below"
                            : "Can't be imported"}
                  </span>
                </span>
                <label className="-my-2 inline-flex min-h-11 cursor-pointer items-center rounded-sm px-1 text-xs text-primary underline-offset-2 hover:underline has-[:disabled]:pointer-events-none has-[:disabled]:opacity-50 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring">
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
        {rates.isError && (
          <p role="alert" className="text-sm text-negative">
            {rates.error.message}
          </p>
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
                      {fresh.length > 0 ? fresh.length : freshEvents.length}
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
            </div>

            {/* Shown once the saved rows are known: until then the file's could all be saved already. */}
            {savedEvents.data && (freshEvents.length > 0 || incomeList.length > 0) && (
              <div>
                <p className="px-1 pb-1.5 text-xs font-medium text-muted-foreground">
                  Also saved: income, fees and cash
                </p>
                <GroupedList className="border border-hairline">
                  {incomeList.map((r) => (
                    <div key={r.label} className={row}>
                      <span className="flex-1">{r.label}</span>
                      <span className="tabular-nums">{formatIncome(r.value)}</span>
                    </div>
                  ))}
                  {freshEvents.length > 0 && (
                    <div className={row}>
                      <span className="flex-1">
                        Rows saved in all (deposits and withdrawals too)
                      </span>
                      <span className="tabular-nums">{freshEvents.length}</span>
                    </div>
                  )}
                </GroupedList>
                {(income.dividends !== 0 || income.interest !== 0) && (
                  <p className="px-1 pt-1.5 text-xs text-muted-foreground">
                    Dividends and interest are after tax.
                  </p>
                )}
              </div>
            )}

            {(skippedTrades > 0 || skippedEvents > 0 || updates.length > 0) && (
              <GroupedList className="border border-hairline">
                {(skippedTrades > 0 || skippedEvents > 0) && (
                  <div className={row}>
                    <span className="flex-1">Already saved, skipped</span>
                    <span className="tabular-nums">
                      {[
                        skippedTrades > 0 && plural(skippedTrades, "trade"),
                        skippedEvents > 0 && plural(skippedEvents, "row"),
                      ]
                        .filter(Boolean)
                        .join(", ")}
                    </span>
                  </div>
                )}
                {updates.length > 0 && (
                  <div className={row}>
                    <span className="flex-1">Share counts corrected</span>
                    <span className="tabular-nums">{updates.length}</span>
                  </div>
                )}
              </GroupedList>
            )}

            {summary && (
              <div>
                <p className="px-1 pb-1.5 text-xs font-medium text-muted-foreground">By holding</p>
                <GroupedList className="max-h-56 overflow-y-auto border border-hairline">
                  {summary.byKey.map((h) => (
                    <div key={h.key} className={row}>
                      <span className="min-w-0 flex-1 truncate">
                        {keys.data?.names.get(h.key) ?? parsed.names?.get(h.key) ?? h.key}
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
        {parsed && !nothing && (
          <Button
            disabled={
              parsed.errors.length > 0 ||
              (fresh.length === 0 && updates.length === 0 && freshEvents.length === 0) ||
              (parsed.events != null && !savedEvents.data) ||
              save.isPending
            }
            onClick={() => save.mutate()}
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
                ? "Save share counts"
                : "Save trades"}
          </Button>
        )}
      </DialogContent>
    </Dialog>
  );
}
