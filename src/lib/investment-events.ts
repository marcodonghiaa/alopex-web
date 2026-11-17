// What a broker reports that isn't a buy or a sell (table investment_events): dividends, interest,
// rewards, fees, taxes, deposits, withdrawals, transfers, corporate actions. amount_eur is the cash
// effect, signed: money in is positive. tax_eur and fee_eur were held back from it.

export type EventKind =
  | "dividend"
  | "interest"
  | "reward"
  | "fee"
  | "tax"
  | "tax_refund"
  | "deposit"
  | "withdrawal"
  | "transfer_in"
  | "transfer_out"
  | "corporate_action"
  | "other";

export interface InvestmentEvent {
  kind: EventKind;
  asset_kind: "stock" | "crypto" | null;
  key: string | null;
  event_date: string;
  occurred_at?: string | null;
  amount_eur: number;
  tax_eur: number;
  fee_eur: number;
  shares?: number | null;
  orig_amount?: number | null;
  orig_currency?: string | null;
  fx_rate?: number | null;
  raw_type: string;
  source: string;
  external_id: string | null;
}

/** Events not saved yet: an event with the broker's id is saved once, whatever the file. */
export function newEvents(
  incoming: Array<InvestmentEvent>,
  saved: Array<Pick<InvestmentEvent, "source" | "external_id">>,
): Array<InvestmentEvent> {
  const id = (e: Pick<InvestmentEvent, "source" | "external_id">) =>
    e.external_id ? `${e.source}|${e.external_id}` : null;
  const seen = new Set(saved.map(id).filter((k) => k != null));
  return incoming.filter((e) => {
    const k = id(e);
    if (k == null) return true;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** What income and returns read from an event. */
export type EventRow = Pick<
  InvestmentEvent,
  "kind" | "asset_kind" | "key" | "event_date" | "amount_eur" | "tax_eur" | "fee_eur"
>;

export interface IncomeSummary {
  /** Dividends, interest and rewards, after tax. */
  income: number;
  dividends: number;
  interest: number;
  rewards: number;
  /** Tax held back or charged, minus refunds. */
  taxes: number;
  /** Fees on their own and fees held back from income. */
  fees: number;
}

const INCOME: Record<string, "dividends" | "interest" | "rewards"> = {
  dividend: "dividends",
  interest: "interest",
  reward: "rewards",
};

/** What your investments paid you and what they cost, from `from` (inclusive) on. */
export function summarizeIncome(events: Array<EventRow>, from = ""): IncomeSummary {
  const out: IncomeSummary = {
    income: 0,
    dividends: 0,
    interest: 0,
    rewards: 0,
    taxes: 0,
    fees: 0,
  };
  for (const e of events) {
    if (e.event_date < from) continue;
    const bucket = INCOME[e.kind];
    if (bucket) {
      out[bucket] += e.amount_eur;
      out.income += e.amount_eur;
    }
    if (e.kind === "fee") out.fees -= e.amount_eur;
    if (e.kind === "tax" || e.kind === "tax_refund") out.taxes -= e.amount_eur;
    out.taxes += e.tax_eur;
    out.fees += e.fee_eur;
  }
  return out;
}

/**
 * What one holding paid you, after tax: added to its return. Tax given back on its trades too,
 * since the tax charged on them lowers it.
 */
export function incomeByKey(events: Array<EventRow>): Map<string, number> {
  const by = new Map<string, number>();
  for (const e of events) {
    if (!e.key || !e.asset_kind || !(INCOME[e.kind] || e.kind === "tax_refund")) continue;
    const k = `${e.asset_kind}|${e.key}`;
    by.set(k, (by.get(k) ?? 0) + e.amount_eur);
  }
  return by;
}
