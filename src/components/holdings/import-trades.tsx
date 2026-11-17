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
import { loadRates, rateLookup } from "@/lib/brokers/rates";
import {
  detectBroker,
  newTrades,
  parseTradesCsv,
  shareUpdates,
  summarizeImport,
} from "@/lib/trades-csv";

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
  useEffect(() => {
    if (!stepChanged.current) return;
    stepChanged.current = false;
    titleRef.current?.focus();
  }, [from]);
  // The drop zone becomes the file's row with Change: a picker that had focus keeps it there.
  const fileRef = useRef<HTMLInputElement>(null);
  const refocusFile = useRef(false);
  useEffect(() => {
    if (!refocusFile.current) return;
    refocusFile.current = false;
    fileRef.current?.focus();
  }, [fileName]);
  const brokers = BROKERS.filter((b) => b.kind === kind);
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
    () => (text.trim() && ctx ? parseTradesCsv(text, ctx, broker) : null),
    [text, ctx, broker],
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

  // Two clicks before a re-render would both start a save: only the first one counts.
  const saving = useRef(false);
  const save = useMutation({
    mutationFn: async () => {
      // One insert is one statement: all the rows land, or none do.
      if (fresh.length > 0) {
        const { data } = await supabase.auth.getUser();
        if (!data.user) throw new Error("You're signed out. Sign in and try again.");
        const userId = data.user.id;
        const { error } = await supabase
          .from("holding_trades")
          .insert(fresh.map((t) => ({ ...t, user_id: userId })));
        if (error) throw error;
      }
      // If this fails the trades are safe: importing again skips them and retries the counts.
      // set_holding_quantity also writes today's value, so net worth moves at once.
      for (const { key, shares } of updates) {
        const held = wallet?.get(key);
        await saveQuantity(
          kind === "stock"
            ? { kind: "stock", isin: key }
            : { kind: "crypto", symbol: held!.symbol, source: held!.source },
          shares,
        );
      }
    },
    onSuccess: () => {
      // Worded as the sibling CSV import's "Imported 3 rows".
      const imported = `Imported ${plural(fresh.length, "trade")}`;
      const updated = plural(updates.length, "holding");
      toast.success(
        updates.length === 0
          ? imported
          : fresh.length === 0
            ? `Updated ${updated}`
            : `${imported}, updated ${updated}`,
      );
      reset();
      setOpen(false);
    },
    onSettled: () => {
      saving.current = false;
      void queryClient.invalidateQueries({ queryKey: ["holding-trades"] });
      void queryClient.invalidateQueries({ queryKey: ["holding-keys", kind] });
      void queryClient.invalidateQueries({ queryKey: ["holding-performance"] });
      void queryClient.invalidateQueries({
        queryKey: [kind === "stock" ? "portfolio-latest" : "crypto-latest"],
      });
      void queryClient.invalidateQueries({ queryKey: ["net-worth-daily"] });
    },
  });

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
    setText("");
    setFileName(null);
    setFrom(null);
    save.reset();
  }
  function onFile(file: File | undefined) {
    // Dropped or picked, a file can't replace the one being saved.
    if (!file || save.isPending) return;
    setFileName(file.name);
    void file.text().then(setText);
  }

  const correctedId = useId();
  // Coin amounts keep their decimals (0.4988), share counts too.
  const amount = numberFormat({ maximumFractionDigits: 8 });
  const row = "flex min-h-12 items-center gap-3 px-4 py-2.5 text-[0.9375rem]";
  const fileInput = (
    <input
      type="file"
      accept=".csv,.tsv,.txt,text/csv"
      aria-label="CSV file"
      className="sr-only"
      // A file can't be swapped while the last one saves.
      disabled={save.isPending}
      ref={fileRef}
      onChange={(e) => {
        refocusFile.current = !fileName && document.activeElement === e.target;
        onFile(e.target.files?.[0]);
        // The same file can be chosen again after Change.
        e.target.value = "";
      }}
    />
  );
  const ok = parsed != null && parsed.errors.length === 0;
  // Without the holdings or the rates the file can't be read: no spinner next to the error.
  const stuck = !parsed && (keys.isError || (rates.isError && !retrying));
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
        if (!next && saving.current) return;
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
            onClick={() => {
              reset();
              go(null);
            }}
            disabled={save.isPending}
            className="-my-2 inline-flex min-h-11 items-center gap-1 self-start text-xs text-muted-foreground hover:text-foreground"
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
                : from === "spreadsheet" && detected && detected.kind === kind
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
              <div className="flex items-center gap-3 rounded-lg border border-hairline bg-card px-4 py-3">
                <span
                  aria-hidden
                  className={cn(
                    "inline-flex size-9 shrink-0 items-center justify-center rounded-full",
                    (parsed && !ok) || stuck
                      ? "bg-negative/15 text-negative"
                      : "bg-positive/15 text-positive",
                  )}
                >
                  {(parsed && !ok) || stuck ? (
                    <CircleAlert className="size-4" strokeWidth={2.5} />
                  ) : parsed ? (
                    <Check className="size-4" strokeWidth={2.5} />
                  ) : (
                    <Loader2 className="size-4 animate-spin" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">{fileName}</span>
                  <span role="status" className="block text-xs text-muted-foreground">
                    {!parsed && !stuck
                      ? "Reading…"
                      : ok
                        ? "Read, check what it found below"
                        : !parsed && !keys.isError
                          ? "Waiting for exchange rates"
                          : "Can't be imported"}
                  </span>
                </span>
                <label className="-my-2 inline-flex min-h-11 cursor-pointer items-center rounded-sm px-2 text-xs text-primary underline underline-offset-2 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring">
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
            {detected && detected.kind !== kind && (
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
              <p className="flex items-baseline gap-2">
                <span className="text-3xl leading-none font-semibold tabular-nums">
                  {numberFormat().format(fresh.length)}
                </span>
                <span className="text-[0.9375rem] font-medium">
                  new trade{fresh.length === 1 ? "" : "s"} to save
                </span>
              </p>
              {summary && (
                <p className="mt-0.5 text-sm text-muted-foreground">
                  {plural(summary.buys, "buy")} · {plural(summary.sells, "sell")} ·{" "}
                  {summary.from === summary.to
                    ? shortDate(summary.from)
                    : `${shortDate(summary.from)} – ${shortDate(summary.to)}`}
                </p>
              )}
            </div>

            {parsed.trades.length > fresh.length && (
              <GroupedList className="border border-hairline">
                <div className={row}>
                  <span className="flex-1">Already saved, skipped</span>
                  <span className="tabular-nums">
                    {numberFormat().format(parsed.trades.length - fresh.length)}
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
                  {kind === "crypto" ? "Holdings corrected" : "Share counts corrected"}
                </p>
                <GroupedList className="border border-hairline">
                  <ul>
                    {updates.map(({ key, shares }) => {
                      const held = wallet?.get(key);
                      const old = held ? held.shares : keys.data?.shares.get(key);
                      // Trades you typed in count on the coin too: a hand-added holding set to the
                      // file's amount no longer matches them.
                      const byHand =
                        held?.source === "Manual"
                          ? saved.filter((t) => !t.source && t.key.toUpperCase() === key).length
                          : 0;
                      return (
                        <li key={key} className={cn(row, "border-hairline not-first:border-t")}>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate">
                              {keys.data?.names.get(key) ?? key}
                            </span>
                            {held && (
                              <span className="block text-xs text-muted-foreground">
                                {held.source}
                                {byHand > 0 &&
                                  ` · Has ${plural(byHand, "trade")} you added by hand: its return will show as not matching until you remove ${byHand === 1 ? "it" : "them"}`}
                              </span>
                            )}
                          </span>
                          <span className="shrink-0 text-sm tabular-nums">
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

            {summary && (
              <div>
                <p className="px-1 pb-1.5 text-xs font-medium text-muted-foreground">By holding</p>
                <GroupedList className="max-h-56 overflow-y-auto border border-hairline">
                  {summary.byKey.map((h) => (
                    <div key={h.key} className={row}>
                      <span className="min-w-0 flex-1 truncate">
                        {keys.data?.names.get(h.key) ?? parsed.names?.get(h.key) ?? h.key}
                        {/* A stock with no holding, kept because it nets to zero (a coin is left out, with a note). */}
                        {ctx && !ctx.knownKeys.has(h.key) && " · fully sold"}
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
        {ok && (
          // Pinned to the dialog's bottom: a long result (a phone, a pasted file) can't push it out of view.
          <div className="sticky -bottom-6 -mx-6 -mb-6 bg-background px-6 pt-2 pb-6">
            <Button
              className="w-full"
              disabled={(fresh.length === 0 && updates.length === 0) || save.isPending}
              onClick={() => {
                if (saving.current) return;
                saving.current = true;
                save.mutate();
              }}
            >
              {save.isPending && <Loader2 className="size-4 animate-spin" />}
              {fresh.length > 0 ? `Save ${plural(fresh.length, "trade")}` : "Save trades"}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
