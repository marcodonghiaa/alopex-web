import { supabase } from "@/integrations/supabase/client";
import { fetchAllRows } from "@/lib/export/fetch-all";
import { FX_HISTORY } from "@/lib/csp";
import { addDays, isDay } from "@/lib/date";
import { makeRate } from "@/lib/fx";

export interface RateRow {
  date: string;
  rate_to_eur: number;
}

// A missing day (weekend, holiday, a sync that didn't run) takes the last rate before it, but
// not one older than this: then the price would be a guess.
const MAX_GAP_DAYS = 10;

/** Euro per one `currency` on a day (or the last day before it); null when there's no recent rate. */
export const rateLookup = (currency: string, rows: Array<RateRow>) =>
  makeRate(
    rows.map((r) => ({ ...r, currency })),
    MAX_GAP_DAYS,
  );

type Db = Pick<typeof supabase, "from">;
type Get = (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

/**
 * The daily rates for `currency` between two days. The ones the sync stored, and for the days
 * they leave bare (before them, as a fresh install keeps about 100 days, or a gap where the sync
 * didn't run) the same source the sync uses, Frankfurter, asked from your browser: it learns only
 * the currency and the dates.
 */
export async function loadRates(
  currency: string,
  from: string,
  to: string,
  db: Db = supabase,
  get: Get = (url) => fetch(url),
): Promise<Array<RateRow>> {
  const fail = () => new Error(`Couldn't load ${currency} exchange rates. Try again in a moment.`);
  const start = addDays(from, -MAX_GAP_DAYS);
  // In pages: the server returns at most 1000 rows a request, and years of daily rates are more.
  let stored: Array<RateRow>;
  try {
    stored = (await fetchAllRows("fx_rates", (a, b) =>
      db
        .from("fx_rates")
        .select("date, rate_to_eur", { count: "exact" })
        .eq("currency", currency)
        .gte("date", start)
        .lte("date", to)
        .order("date", { ascending: true })
        .range(a, b),
    )) as unknown as Array<RateRow>;
  } catch {
    throw fail();
  }
  // The days with no rate at most MAX_GAP_DAYS old: before the first stored day, in a gap the
  // sync left, or after the last stored day. One request covers them all.
  const days = [...stored.map((r) => r.date), addDays(to, 1)];
  let since = days[0]! > from ? start : null;
  let until = days[0]!;
  for (let i = 1; i < days.length; i++) {
    const firstBare = addDays(days[i - 1]!, MAX_GAP_DAYS + 1);
    const lastBare = addDays(days[i]!, -1);
    if ((firstBare > from ? firstBare : from) <= (lastBare < to ? lastBare : to)) {
      since ??= days[i - 1]!;
      until = days[i]!;
    }
  }
  if (since === null) return stored;
  if (until > to) until = to;

  const res = await get(
    `${FX_HISTORY}/v1/${since}..${until}?base=EUR&symbols=${encodeURIComponent(currency)}`,
  ).catch(() => null);
  if (!res?.ok) throw fail();
  // Only real days with a finite rate above zero: a bad answer must never become a price.
  let body: { rates?: Record<string, Record<string, unknown> | null> };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    throw fail();
  }
  const storedDays = new Set(stored.map((r) => r.date));
  const fetched = Object.entries(body?.rates ?? {})
    .flatMap(([date, r]) => {
      const units = r?.[currency];
      if (!isDay(date) || typeof units !== "number") return [];
      const rate = 1 / units;
      return units > 0 && Number.isFinite(units) && Number.isFinite(rate)
        ? [{ date, rate_to_eur: rate }]
        : [];
    })
    // A day the sync stored keeps its stored rate.
    .filter(({ date }) => !storedDays.has(date));
  return [...fetched, ...stored].sort((a, b) => a.date.localeCompare(b.date));
}
