import { supabase } from "@/integrations/supabase/client";
import type { BankTx } from "./splitwise-match";
import { toBankTx, type FxRow } from "./splitwise-review";

// The bank payments and exchange rates around some Splitwise dates, for the matcher: shared by
// the CSV import's review and the To link list.

// From 30 days before the first date (the matcher's early window) to a week after the last; rates
// from two weeks before that, so the first bank days have one.
const DAYS_BEFORE = 30;
const DAYS_AFTER = 7;
const FX_DAYS_BEFORE = 14;
// PostgREST returns at most 1000 rows per call: read page by page, up to 10 000 rows each.
const PAGE = 1000;
const MAX_PAGES = 10;

const addDays = (iso: string, days: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

export interface BankWindow {
  bank: Array<BankTx>;
  fx: Array<FxRow>;
  /** Too many rows to read them all: the bank payments are complete from `completeFrom` on. */
  capped: boolean;
  completeFrom: string | null;
}

/** Every row of a query, page by page in a stable order, or the first MAX_PAGES pages (capped). */
async function allPages<T>(
  page: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: Array<T> | null; error: { message: string } | null }>,
): Promise<{ rows: Array<T>; capped: boolean }> {
  const rows: Array<T> = [];
  for (let i = 0; i < MAX_PAGES; i++) {
    const { data, error } = await page(i * PAGE, (i + 1) * PAGE - 1);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if ((data ?? []).length < PAGE) return { rows, capped: false };
  }
  // Exactly MAX_PAGES full pages may be all there is: one more row says whether anything was cut.
  const more = await page(MAX_PAGES * PAGE, MAX_PAGES * PAGE);
  if (more.error) throw new Error(more.error.message);
  return { rows, capped: (more.data ?? []).length > 0 };
}

/** `currencies`: the Splitwise side's; the bank's own are added. */
export async function fetchBankWindow(
  dates: Array<string>,
  currencies: Array<string>,
): Promise<BankWindow> {
  if (dates.length === 0) return { bank: [], fx: [], capped: false, completeFrom: null };
  const sorted = [...dates].sort();
  const from = addDays(sorted[0]!, -DAYS_BEFORE);
  const to = addDays(sorted[sorted.length - 1]!, DAYS_AFTER);
  // Newest first: when there are too many, the oldest are the ones left out.
  const bank = await allPages((a, b) =>
    supabase
      .from("transactions")
      .select(
        "account_uid, entry_reference, booking_date, amount, currency, credit_debit_indicator, personal_amount, flow_type, deleted_at, creditor_name",
      )
      .gte("booking_date", from)
      .lte("booking_date", to)
      .is("deleted_at", null)
      .order("booking_date", { ascending: false })
      .order("account_uid")
      .order("entry_reference")
      .range(a, b),
  );
  // Rates for the Splitwise currencies and the bank's: a payment picked by hand may be in another.
  const wanted = [...new Set([...currencies, ...bank.rows.map((t) => t.currency)])].filter(
    (c) => c !== "EUR",
  );
  const fx =
    wanted.length === 0
      ? { rows: [] as Array<FxRow>, capped: false }
      : await allPages((a, b) =>
          supabase
            .from("fx_rates")
            .select("currency, date, rate_to_eur")
            .in("currency", wanted)
            .gte("date", addDays(from, -FX_DAYS_BEFORE))
            .lte("date", to)
            .order("date", { ascending: true })
            .order("currency")
            .range(a, b),
        );
  const capped = bank.capped || fx.capped;
  return {
    bank: bank.rows.flatMap((r) => toBankTx(r) ?? []),
    fx: fx.rows,
    capped,
    // The last date read may have more rows that were cut: complete only from the day after.
    completeFrom: capped ? addDays(bank.rows[bank.rows.length - 1]?.booking_date ?? from, 1) : null,
  };
}
