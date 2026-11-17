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
const PAGE_LIMIT = 1000;

const addDays = (iso: string, days: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

export interface BankWindow {
  bank: Array<BankTx>;
  fx: Array<FxRow>;
  /** The database's row limit was hit: some payments or rates may be missing. */
  capped: boolean;
}

/** `currencies`: the Splitwise side's; the bank's own are added. */
export async function fetchBankWindow(
  dates: Array<string>,
  currencies: Array<string>,
): Promise<BankWindow> {
  if (dates.length === 0) return { bank: [], fx: [], capped: false };
  const sorted = [...dates].sort();
  const from = addDays(sorted[0]!, -DAYS_BEFORE);
  const to = addDays(sorted[sorted.length - 1]!, DAYS_AFTER);
  const bank = await supabase
    .from("transactions")
    .select(
      "account_uid, entry_reference, booking_date, amount, currency, credit_debit_indicator, personal_amount, flow_type, deleted_at, creditor_name",
    )
    .gte("booking_date", from)
    .lte("booking_date", to)
    .limit(PAGE_LIMIT);
  if (bank.error) throw new Error(bank.error.message);
  // Rates for the Splitwise currencies and the bank's: a payment picked by hand may be in another.
  const wanted = [...new Set([...currencies, ...(bank.data ?? []).map((t) => t.currency)])].filter(
    (c) => c !== "EUR",
  );
  const fx =
    wanted.length === 0
      ? { data: [] as Array<FxRow>, error: null }
      : await supabase
          .from("fx_rates")
          .select("currency, date, rate_to_eur")
          .in("currency", wanted)
          .gte("date", addDays(from, -FX_DAYS_BEFORE))
          .lte("date", to)
          .limit(PAGE_LIMIT);
  if (fx.error) throw new Error(fx.error.message);
  return {
    bank: (bank.data ?? []).flatMap((r) => toBankTx(r) ?? []),
    fx: fx.data ?? [],
    capped: (bank.data ?? []).length >= PAGE_LIMIT || (fx.data ?? []).length >= PAGE_LIMIT,
  };
}
