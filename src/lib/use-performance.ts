import { keepPreviousData, useQueries, useQuery } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";
import { useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { ofKind } from "@/lib/performance";
import type { PerformanceRow } from "@/lib/performance";
import { fetchAllRows } from "@/lib/export/fetch-all";
import type { ExportRow } from "@/lib/export/tables";
import { measure, summarizeTrades } from "@/lib/trades";
import type { Measured, Trade } from "@/lib/trades";
import { incomeByKey } from "@/lib/investment-events";
import type { EventRow, InvestmentEvent } from "@/lib/investment-events";

export type PerformanceResult = { rows: Array<PerformanceRow> } | { unavailable: true };
export type SavedTrade = Trade & { id: string };
export type TradesResult = { trades: Array<SavedTrade> } | { unavailable: true };

// PostgREST answers these when the function or table is not in the database: the dashboard was
// deployed before the owner applied the migration. That is "not available yet", not a failure.
const isMissingFunction = (error: { code?: string }) => error.code === "PGRST202";
const isMissingTable = (error: { code?: string }) =>
  error.code === "PGRST205" || error.code === "42P01";

/**
 * The per-holding prices behind a range. One row per stock, fund or coin (about 25), so there is
 * no paging: nothing here can hit the 1000-row limit that silently cuts a long table.
 */
export async function fetchPerformance(
  client: SupabaseClient<Database>,
  from: string,
  lastMove: boolean,
): Promise<PerformanceResult> {
  const { data, error } = await client.rpc("holding_performance", {
    p_from: from,
    p_last_move: lastMove,
  });
  if (error) {
    if (isMissingFunction(error)) return { unavailable: true };
    throw error;
  }
  return { rows: data ?? [] };
}

/** Every trade, paged: savings plans over 25 holdings can pass the 1000-row limit. */
export async function fetchTrades(client: SupabaseClient<Database>): Promise<TradesResult> {
  let missing = false;
  const rows = await fetchAllRows("holding_trades", async (from, to) => {
    const { data, error, count } = await client
      .from("holding_trades")
      .select(
        "id,kind,key,side,trade_date,shares,price_eur,fee_eur,tax_eur,traded_at,source,external_id,note",
        {
          count: "exact",
        },
      )
      .order("id")
      .range(from, to);
    if (error && isMissingTable(error)) {
      missing = true;
      return { data: [], error: null, count: 0 };
    }
    return { data: data as Array<ExportRow> | null, error, count };
  });
  return missing ? { unavailable: true } : { trades: rows as unknown as Array<SavedTrade> };
}

export type SavedEvent = EventRow & Pick<InvestmentEvent, "source" | "external_id">;

/** Every dividend, fee, tax and transfer, paged. */
export async function fetchEvents(client: SupabaseClient<Database>): Promise<Array<SavedEvent>> {
  const rows = await fetchAllRows("investment_events", async (from, to) => {
    const { data, error, count } = await client
      .from("investment_events")
      .select("kind,asset_kind,key,event_date,amount_eur,tax_eur,fee_eur,source,external_id", {
        count: "exact",
      })
      .order("id")
      .range(from, to);
    return { data: data as Array<ExportRow> | null, error, count };
  });
  return rows as unknown as Array<SavedEvent>;
}

// Every holding's latest price: total return has no range, so any early date will do.
const EARLIEST = "1970-01-01";

/**
 * Total return from your trades. `lastIso` is the latest data day; refetches when it moves.
 * Undefined (no value history yet, or it failed) still loads, so returns never wait forever.
 */
export function usePerformance(lastIso: string | undefined, kind: "stock" | "crypto") {
  const prices = useQuery({
    queryKey: ["holding-performance", lastIso ?? null],
    queryFn: () => fetchPerformance(supabase, EARLIEST, false),
    // The latest prices stay on screen while the next day's load, so returns never flash to "…".
    placeholderData: keepPreviousData,
  });
  const saved = useQuery({ queryKey: ["holding-trades"], queryFn: () => fetchTrades(supabase) });
  const events = useQuery({
    queryKey: ["investment-events"],
    queryFn: () => fetchEvents(supabase),
  });
  const income = useMemo(() => incomeByKey(events.data ?? []), [events.data]);

  const tradesByKey = useMemo(() => {
    const out = new Map<string, Array<SavedTrade>>();
    if (saved.data && "trades" in saved.data) {
      for (const t of saved.data.trades) {
        if (t.kind === kind) out.set(t.key, [...(out.get(t.key) ?? []), t]);
      }
    }
    return out;
  }, [saved.data, kind]);

  const measured = useMemo(() => {
    const rows = ofKind(prices.data && "rows" in prices.data ? prices.data.rows : [], kind);
    // Trades of something no longer in your holdings: sold, so their profit still counts.
    const known = new Set(rows.map((r) => r.key));
    const sold: Array<PerformanceRow> = [...tradesByKey.keys()]
      .filter((key) => !known.has(key))
      .map((key) => ({
        kind,
        key,
        name: null,
        quantity: 0,
        start_date: null,
        start_price_eur: null,
        end_date: null,
        end_price_eur: null,
        status: "no_price",
      }));
    return [...rows, ...sold].map((row) => ({
      row,
      measured: measure(row, tradesByKey.get(row.key) ?? [], income.get(`${kind}|${row.key}`) ?? 0),
    }));
  }, [prices.data, tradesByKey, kind, income]);

  const summary = useMemo(() => summarizeTrades(measured, 1), [measured]);
  const measuredByKey = useMemo(
    () => new Map<string, Measured>(measured.map((m) => [m.row.key, m.measured])),
    [measured],
  );

  // Today's price per holding, for valuing what your trades hold now (the range chip).
  const endPrices = useMemo(() => {
    const rows = ofKind(prices.data && "rows" in prices.data ? prices.data.rows : [], kind);
    return new Map(
      rows.flatMap((r) => (r.end_price_eur != null ? [[r.key, r.end_price_eur] as const] : [])),
    );
  }, [prices.data, kind]);

  return {
    kind,
    summary,
    measuredByKey,
    endPrices,
    tradesByKey,
    events: events.data ?? [],
    isPending: prices.isPending || saved.isPending || events.isPending,
    unavailable:
      (prices.data != null && "unavailable" in prices.data) ||
      (saved.data != null && "unavailable" in saved.data),
    error: prices.error ?? saved.error ?? events.error ?? null,
  };
}

/**
 * Each holding's price on `from` (the range's first day), for valuing what your trades held then.
 * Undefined while loading; empty when the database can't answer yet.
 */
export function useStartPrices(from: string | undefined, kind: "stock" | "crypto") {
  const query = useQuery({
    queryKey: ["holding-performance-from", from],
    queryFn: () => fetchPerformance(supabase, from!, false),
    enabled: from != null,
  });
  return useMemo(
    () => (query.data ? startPricesOf(query.data, kind) : undefined),
    [query.data, kind],
  );
}

/**
 * Each holding's price on each of `dates` (the Return line's days), one request a day, shared
 * with the range chip's start prices. A holding first priced after the day is left out of it.
 * An entry is undefined while its day loads.
 */
export function useDayPrices(
  dates: Array<string>,
  kind: "stock" | "crypto",
): Array<Map<string, number> | undefined> {
  return useQueries({
    queries: dates.map((from) => ({
      queryKey: ["holding-performance-from", from],
      queryFn: () => fetchPerformance(supabase, from, false),
    })),
    combine: (results) =>
      results.map(({ data }) => (data ? startPricesOf(data, kind, true) : undefined)),
  });
}

/** Each holding's start price; `onTheDay` leaves out holdings first priced after the day. */
export function startPricesOf(data: PerformanceResult, kind: "stock" | "crypto", onTheDay = false) {
  const rows = ("rows" in data ? ofKind(data.rows, kind) : []).filter(
    (r) => !onTheDay || r.status !== "since",
  );
  return new Map(
    rows.flatMap((r) => (r.start_price_eur != null ? [[r.key, r.start_price_eur] as const] : [])),
  );
}
